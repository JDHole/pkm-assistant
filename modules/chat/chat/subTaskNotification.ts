/**
 * subTaskNotification — treść powiadomienia o wyniku suba z TŁA + dopasowanie zakładki (F2 faza B).
 *
 * PO CO: od F2 `delegate` domyślnie nie blokuje tury — model dostaje pokwitowanie `started`,
 * a bieg suba kończy się długo po tym, jak tura się zamknęła. Wynik musi więc wrócić WŁASNĄ
 * turą: czat wstrzykuje go jako wiadomość i od razu odpala agenta ponownie. Ten plik składa
 * tekst tej wiadomości i wskazuje zakładkę, do której należy.
 *
 * ZASADY:
 *   - CZYSTY: zero `obsidian`, zero `this`, zero I/O — cała reszta czatu wisi na `obsidian`
 *     i nie da się jej testować w AVA. Ta logika daje się, więc mieszka osobno.
 *   - Tekst idzie do MODELU (ląduje w kontekście jako wiadomość usera), ale jest też widoczny
 *     dla usera w oknie rozmowy — dlatego cały przez `t()`, pl+en.
 *   - Nie zgadujemy limitów: sufit długości wyniku podaje wołacz (czat zna `getLimits`).
 */
import { t } from '../../../core/i18n/index.js';
import { DEFAULT_LIMITS } from '../../../config/limits.js';
import type { SubTask, SubTaskOrigin } from '../../sub-agents/index.js';

/** Minimalny kształt zakładki, jakiego potrzebuje dopasowanie (czat ma na niej więcej pól). */
// AUD-dead-code-231 (2026-09-02): `export` zdjęty na obu typach niżej — zero referencji spoza
// tego pliku.
interface TabLike {
    agentName?: string;
    [extra: string]: unknown;
}

interface SubTaskNotificationOptions {
    /** Sufit długości treści wyniku. `0` = bez limitu (runda 2). Default:
     *  `subagent_result_max_chars` z config/limits (wynik suba to deliverable, nie zrzut). */
    maxResultChars?: number;
}

/** Ludzka nazwa stanu biegu — `t()` wołane leniwie, żeby respektować bieżący język. */
function statusLabel(status: string | undefined): string {
    switch (status) {
        case 'done': return t('chat.subagent_notification.status_done');
        case 'error': return t('chat.subagent_notification.status_error');
        case 'aborted': return t('chat.subagent_notification.status_aborted');
        default: return String(status || '?');
    }
}

/**
 * Ile trwał bieg (sekundy, jedno miejsce po przecinku). Źródło pierwsze: `result.durationMs`
 * (mierzy je pętla). Gdy wyniku nie ma (błąd/abort) — liczymy z ram czasowych bytu.
 */
function durationSeconds(task: SubTask): string | null {
    const ms = typeof task?.result?.durationMs === 'number'
        ? task.result.durationMs
        : (typeof task?.endedAt === 'number' && typeof task?.createdAt === 'number'
            ? task.endedAt - task.createdAt
            : null);
    if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
    return (ms / 1000).toFixed(1);
}

/**
 * Treść wiadomości, którą czat wstrzykuje w rozmowę po powrocie suba z tła.
 *
 * Układ: nagłówek (kto/co/id) → linia stanu (status + czas) → treść (wynik ALBO błąd)
 * → stopka-instrukcja dla modelu („podejmij wątek"). Bez stopki model potrafi potraktować
 * powiadomienie jak zwykłą wypowiedź usera i tylko ją skwitować.
 */
export function buildSubTaskNotificationText(task: SubTask, options: SubTaskNotificationOptions = {}): string {
    // Runda 2 (2026-08-17): 0 jest ŚWIADOMĄ wartością („bez limitu"), więc nie może spadać
    // na default — przyjmujemy każdą skończoną liczbę >= 0, śmieć dopiero idzie na default.
    const rawCap = Number(options.maxResultChars);
    const maxResultChars = Number.isFinite(rawCap) && rawCap >= 0
        ? rawCap
        : DEFAULT_LIMITS.subagent_result_max_chars;

    const parts: string[] = [];
    parts.push(t('chat.subagent_notification.header', {
        name: task?.name || '?',
        task_id: task?.id || '?',
    }));

    const seconds = durationSeconds(task);
    parts.push(seconds !== null
        ? t('chat.subagent_notification.meta_with_time', { status: statusLabel(task?.status), seconds })
        : t('chat.subagent_notification.meta', { status: statusLabel(task?.status) }));

    if (task?.status === 'done') {
        const raw = typeof task?.result?.text === 'string' ? task.result.text.trim() : '';
        if (!raw) {
            parts.push(t('chat.subagent_notification.empty_result'));
        } else if (maxResultChars > 0 && raw.length > maxResultChars) {
            // Ucinamy TU, a nie w rejestrze: rejestr ma trzymać prawdę o biegu, przycięcie
            // jest decyzją kontekstu rozmowy (i limit bierze się z ustawień usera).
            parts.push(`${raw.slice(0, maxResultChars)}\n${t('chat.subagent_notification.truncated', { chars: maxResultChars })}`);
        } else {
            parts.push(raw);
        }
    } else {
        const err = typeof task?.error === 'string' && task.error.trim()
            ? task.error.trim()
            : t('chat.subagent_notification.unknown_error');
        parts.push(t('chat.subagent_notification.failed', { error: err }));
    }

    parts.push(t('chat.subagent_notification.footer'));
    return parts.join('\n\n');
}

/**
 * Do której zakładki należy wracający wynik.
 *
 * 1. `origin.tabKey` — dokładny adres zwrotny zapisany przy zleceniu (najpewniejszy).
 * 2. Fallback po agencie: pierwsza zakładka tego agenta. Ratuje sytuację, w której zakładka
 *    dostała po drodze inny klucz (np. sesja zapisana pod nową ścieżką) albo zlecenie przyszło
 *    bez `tabKey` (delegacja spoza czatu).
 * 3. Nic nie pasuje → `null`; wołacz zostawia wynik w kolejce notifiera na później.
 *
 * `tabKeyFn` jest wstrzykiwane (a nie importowane), żeby ten plik został czysty — liczy ją
 * `chat_tabs._tabKey`, jedno źródło prawdy o tożsamości zakładki.
 */
export function matchTabForOrigin<T extends TabLike>(
    tabs: T[] | null | undefined,
    origin: SubTaskOrigin | null | undefined,
    tabKeyFn: (tab: T) => string,
): T | null {
    if (!Array.isArray(tabs) || tabs.length === 0) return null;

    const tabKey = origin?.tabKey;
    if (tabKey) {
        const byKey = tabs.find((tab) => tabKeyFn(tab) === tabKey);
        if (byKey) return byKey;
    }

    const agentName = origin?.agentName;
    if (agentName) {
        const byAgent = tabs.find((tab) => tab?.agentName === agentName);
        if (byAgent) return byAgent;
    }

    return null;
}
