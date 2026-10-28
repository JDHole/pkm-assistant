/**
 * subTaskNotification — treść powiadomienia o wyniku suba z TŁA + dopasowanie zakładki.
 *
 * PO CO: `delegate` domyślnie nie blokuje tury - model dostaje pokwitowanie `started`,
 * a bieg suba kończy się długo po tym, jak tura się zamknęła. Wynik musi więc wrócić WŁASNĄ
 * turą: czat wstrzykuje go jako wiadomość i od razu odpala agenta ponownie. Ten plik składa
 * tekst tej wiadomości i wskazuje zakładkę, do której należy.
 *
 * ZASADY:
 *   - CZYSTY: zero `obsidian`, zero `this`, zero I/O - cała reszta czatu wisi na `obsidian`
 *     i nie da się jej testować w AVA. Ta logika daje się, więc mieszka osobno.
 *   - Tekst idzie do MODELU (ląduje w kontekście jako wiadomość usera), ale jest też widoczny
 *     dla usera w oknie rozmowy - dlatego cały przez `t()`, pl+en.
 *   - Nie zgadujemy limitów: sufit długości wyniku podaje wołacz (czat zna `getLimits`).
 */
import { t } from '../../../core/i18n/index.js';
import { DEFAULT_LIMITS } from '../../../config/limits.js';
import type { SubTask, SubTaskOrigin } from '../../sub-agents/index.js';


/** Minimalny kształt zakładki, jakiego potrzebuje dopasowanie (czat ma na niej więcej pól). */
// Nie eksportowany - brak referencji spoza tego pliku (tu i na obu typach niżej).
/** Zakladka w zakresie, jakiego dotyka dopasowanie adresu zwrotnego. */
interface TabLike {
    agentName?: string;
    sessionPath?: string;
    sessionEpoch?: string | null;
}

interface SubTaskNotificationOptions {
    /** Sufit długości treści wyniku. `0` = bez limitu. Default:
     *  `subagent_result_max_chars` z config/limits (wynik suba to deliverable, nie zrzut). */
    maxResultChars?: number;
    /** Id reusable thread, exposed to the model for the next sub_agent task call. */
    subId?: string;
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

// Klucze dosłowne (nie składane z szablonu), żeby strażnik parytetu i18n je widział.
const STOPPED_BY_KEY = {
    user: 'chat.subagent_notification.end_stopped_user',
    lead: 'chat.subagent_notification.end_stopped_lead',
    system: 'chat.subagent_notification.end_stopped_system',
} as const;
const COMPLETENESS_KEY = {
    unconfirmed: 'chat.subagent_notification.completeness_unconfirmed',
    partial: 'chat.subagent_notification.completeness_partial',
    empty: 'chat.subagent_notification.completeness_empty',
} as const;
const CHECK_KEY = {
    matches: 'chat.subagent_notification.check_matches',
    mismatch: 'chat.subagent_notification.check_mismatch',
    not_checked: 'chat.subagent_notification.check_not_checked',
    unknown: 'chat.subagent_notification.check_unknown',
} as const;

function outcomeEndLabel(outcome: NonNullable<SubTask['outcome']>): string {
    const end = outcome.end;
    switch (end.kind) {
        case 'finished': return t('chat.subagent_notification.end_finished');
        case 'limit': return t(end.reason === 'iteration-limit' ? 'chat.subagent_notification.end_iteration_limit' : 'chat.subagent_notification.end_synthesis_budget');
        case 'uncertain': return t('chat.subagent_notification.end_uncertain');
        case 'stopped': return t(STOPPED_BY_KEY[end.by]);
        case 'timeout': return t('chat.subagent_notification.end_timeout');
        case 'failed': return t(end.stage === 'work' ? 'chat.subagent_notification.end_failed_work' : 'chat.subagent_notification.end_failed_synthesis');
        default: {
            const exhaustive: never = end;
            void exhaustive;
            return '?';
        }
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
    // 0 jest ŚWIADOMĄ wartością („bez limitu"), więc nie może spadać na default -
    // przyjmujemy każdą skończoną liczbę >= 0, śmieć dopiero idzie na default.
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
    const outcome = task?.outcome;
    const lineStatus = outcome
        ? `${outcomeEndLabel(outcome)} · ${t(COMPLETENESS_KEY[outcome.completeness])}`
        : statusLabel(task?.status);
    parts.push(seconds !== null
        ? t('chat.subagent_notification.meta_with_time', { status: lineStatus, seconds })
        : t('chat.subagent_notification.meta', { status: lineStatus }));

    if (outcome?.completeness === 'unconfirmed') {
        const raw = typeof task?.result?.text === 'string' ? task.result.text.trim() : '';
        if (raw) parts.push(raw.length > maxResultChars && maxResultChars > 0 ? `${raw.slice(0, maxResultChars)}\n${t('chat.subagent_notification.truncated', { chars: maxResultChars })}` : raw);
        else parts.push(t('chat.subagent_notification.empty_result'));
        parts.push(t('chat.subagent_notification.unconfirmed'));
    } else if (outcome?.completeness === 'partial') {
        parts.push(t('chat.subagent_notification.partial'));
        const raw = (typeof task?.result?.handoff === 'string' && task.result.handoff.trim()) || (typeof task?.partial?.text === 'string' && task.partial.text.trim()) || (typeof task?.result?.text === 'string' ? task.result.text.trim() : '');
        parts.push(raw ? (maxResultChars > 0 && raw.length > maxResultChars ? `${raw.slice(0, maxResultChars)}\n${t('chat.subagent_notification.truncated', { chars: maxResultChars })}` : raw) : t('chat.subagent_notification.empty_result'));
    } else if (outcome?.completeness === 'empty') {
        parts.push(t('chat.subagent_notification.empty', { reason: outcomeEndLabel(outcome) }));
        if (outcome.end.kind === 'failed' && typeof task.error === 'string' && task.error.trim()) {
            parts.push(t('chat.subagent_notification.failed', { error: task.error.trim() }));
        }
    } else if (!outcome && task?.status === 'done') {
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
    } else if (!outcome) {
        const err = typeof task?.error === 'string' && task.error.trim()
            ? task.error.trim()
            : t('chat.subagent_notification.unknown_error');
        parts.push(t('chat.subagent_notification.failed', { error: err }));
    }

    const question = task.result?.question;
    if (question && question.resolution.kind !== 'answered') {
        const reason = question.resolution.kind === 'no-answer'
            ? t('chat.subagent_notification.question_no_answer')
            : t('chat.subagent_notification.question_cancelled');
        parts.push(t('chat.subagent_notification.question', { reason, question: question.text }));
    }

    if (outcome?.completeness === 'partial' || outcome?.completeness === 'empty') {
        for (const effect of outcome.effects) {
            const check = effect.outcome === 'unknown' || effect.outcome === 'pending' ? 'unknown' : effect.check === 'matches' ? 'matches' : effect.check === 'mismatch' ? 'mismatch' : 'not_checked';
            const targets = effect.targets?.map((target) => target.path || target.id || '').filter(Boolean).join(', ') || effect.action || '';
            parts.push(t('chat.subagent_notification.effect', { tool: effect.tool, target: targets, check: t(CHECK_KEY[check]) }));
        }
    }

    const body = parts.join('\n\n');
    const instruction = options.subId
        ? `\n\n${t('chat.subagent_notification.reusable_thread', { sub_id: options.subId })}`
        : '';
    const footerSeparator = options.subId ? '\n\n\n' : '\n\n';
    return `${body}${instruction}${footerSeparator}${t('chat.subagent_notification.footer')}`;
}

/**
 * Do której zakładki należy wracający wynik.
 *
 * 1. `origin.tabKey`: dokładny adres zwrotny zapisany przy zleceniu.
 * 2. `origin.sessionPath`: zakładka tej sesji i agenta.
 * 3. Bez `sessionPath`: pierwsza zakładka agenta.
 * 4. Nic nie pasuje: `null`; wynik zostaje w kolejce notifiera.
 *
 * `tabKeyFn` jest wstrzykiwane (a nie importowane), żeby ten plik został czysty — liczy ją
 * `chat_tabs._tabKey`, jedno źródło prawdy o tożsamości zakładki.
 */
export function matchTabForOrigin<T extends TabLike>(
    tabs: T[] | null | undefined,
    origin: SubTaskOrigin | null | undefined,
    tabKeyFn: (tab: T) => string,
    sessionPathFn: (tab: T) => string | undefined = (tab) => tab.sessionPath,
    sessionEpochFn: (tab: T) => string | null | undefined = (tab) => tab.sessionEpoch,
): T | null {
    if (!Array.isArray(tabs) || tabs.length === 0) return null;

    const tabKey = origin?.tabKey;
    const originEpoch = origin?.sessionEpoch;
    const hasOriginEpoch = originEpoch !== null && originEpoch !== undefined;
    const matchesSession = (tab: T) => tab?.agentName === origin?.agentName
        && sessionPathFn(tab) === origin?.sessionPath
        && (!hasOriginEpoch || sessionEpochFn(tab) === originEpoch);
    if (tabKey) {
        const byKey = tabs.find((tab) => tabKeyFn(tab) === tabKey);
        if (byKey && (!hasOriginEpoch || matchesSession(byKey))) return byKey;
    }

    // Epoka jest identyfikatorem sesji tylko razem ze ścieżką; brak drugiego składnika
    // oznacza nieznany adres zwrotny, więc wynik pozostaje w kolejce.
    if (hasOriginEpoch && !origin?.sessionPath) return null;
    if (origin?.sessionPath) {
        if (hasOriginEpoch) return tabs.find(matchesSession) || null;
        return tabs.find((tab) => tab?.agentName === origin.agentName && sessionPathFn(tab) === origin.sessionPath) || null;
    }
    const agentName = origin?.agentName;
    if (agentName) {
        const byAgent = tabs.find((tab) => tab?.agentName === agentName);
        if (byAgent) return byAgent;
    }

    return null;
}
