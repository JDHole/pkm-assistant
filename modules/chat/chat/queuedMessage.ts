/**
 * @module queuedMessage
 * Kolejka wiadomości czatu - JEDEN slot na wiadomość odłożoną na czas trwającej tury,
 * razem z jej PROWENIENCJĄ.
 *
 * DLACZEGO PROWENIENCJA JEDZIE RAZEM Z TEKSTEM: ścieżki, które WYPEŁNIAJĄ pole wpisywania
 * z kodu (guzik artefaktu → `artifactSummon`, propozycja delegacji → `chat_artifacts`,
 * komentarz inline → `src/main.ts`) też trafiają do tej kolejki, gdy akurat trwa tura -
 * kolejka nie bierze się wyłącznie z pola wpisywania. Gdyby dren opróżniający kolejkę nadawał
 * jej twardo `HUMAN_MESSAGE_META`, tekst maszynowy - treść artefaktu, w której materiał bywa
 * z sieci - wracałby z przywilejami człowieka: rejestrowałby adresy w whiteliście `web_read`,
 * jego `@@skill:` udawałby polecenie usera, a `/` uruchamiałoby komendę.
 *
 * Zasada slotu: **jedna wiadomość na raz, nowsza zastępuje starszą W CAŁOŚCI**. Dzięki temu
 * pieczątki nigdy się nie sklejają - nie ma sytuacji „tekst maszynowy + ludzki w jednym
 * wpisie", bo nie ma doklejania. Gdyby kiedyś kolejka miała rosnąć do listy, regułą musi być
 * fail-closed: paczka z choćby jednym tekstem maszynowym jedzie jako `machine`.
 *
 * Plik jest CELOWO wolny od `obsidian` i DOM-u - dzięki temu ma testy jednostkowe
 * (`queuedMessage.test.ts`), a `chat_streaming.ts` tylko go wywołuje.
 */
import { resolveMessageOrigin } from '../../../core/index.js';
import type { MessageOriginMeta } from '../../../core/index.js';

/**
 * Kto był na wierzchu, gdy wiadomość wpadła do slotu.
 *
 * `tabKey` liczy `chat_tabs._tabKey` - jedno źródło prawdy o tożsamości zakładki (to samo,
 * którym adresuje się wynik suba). `agentName` jest pasem zapasowym na wypadek, gdy zakładka
 * dostanie po drodze inny klucz (np. sesja zapisana pod nową ścieżką).
 */
export interface QueueOwner {
    agentName?: string;
    tabKey?: string;
}

/** Wiadomość czekająca na koniec tury: treść + jej pieczątka pochodzenia + właściciel. */
// Nie eksportowany - brak referencji spoza tego pliku (tu i na czterech typach niżej).
interface QueuedChatMessage {
    text: string;
    meta: MessageOriginMeta;
    owner?: QueueOwner;
}

/**
 * Zapakuj wiadomość do slotu kolejki razem z proweniencją i właścicielem.
 *
 * Pieczątkę liczy `resolveMessageOrigin` (fail-closed: cokolwiek innego niż jawne
 * `origin: 'human'` jest maszyną), a `origin` dokładamy JAKO OSTATNI — wołający nie
 * podmieni go sobie polem w `meta`. Pozostałe pola meta (`_subTaskNotification`,
 * `subTaskId`, …) jadą dalej nietknięte.
 */
export function queueChatMessage(text: string, meta?: unknown, owner?: QueueOwner | null): QueuedChatMessage {
    const extra = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
    const entry: QueuedChatMessage = { text, meta: { ...extra, origin: resolveMessageOrigin(meta) } };
    if (owner && (owner.agentName || owner.tabKey)) {
        entry.owner = { ...(owner.agentName ? { agentName: owner.agentName } : {}), ...(owner.tabKey ? { tabKey: owner.tabKey } : {}) };
    }
    return entry;
}

/**
 * Czy slot wolno opróżnić DO TEGO widoku.
 *
 * Dren kolejki jedzie na `setTimeout(…, 100)`, a `set_generating(false)` woła też
 * `_switchTab` przy każdym przejściu na niegenerującą zakładkę. Bez tego pytania wybudzony
 * timer mógłby wkleić tekst pisany do Jaskra w pole Borysa i wystartować turę JEGO modelem,
 * promptem, pamięcią i zestawem narzędzi - a `freezeTurnOwner` zamraża już cudzego
 * właściciela.
 *
 * Slot bez właściciela (goły string) drenuje się jak dotąd - brak adresu to nie jest
 * dowód rozjazdu.
 */
export function queuedOwnerMatches(entry: QueuedChatMessage | null | undefined, current: QueueOwner | null | undefined): boolean {
    const owner = entry?.owner;
    if (!owner || (!owner.agentName && !owner.tabKey)) return true;
    if (!current) return false;
    if (owner.tabKey) return owner.tabKey === current.tabKey;
    return owner.agentName === current.agentName;
}

/**
 * Odczytaj slot kolejki. Pusty slot → `null`.
 *
 * Goły string (ktoś przypisał do `_queuedMessage` po staremu) jest przyjmowany, ale
 * dostaje pieczątkę MASZYNY — brak jawnej proweniencji nigdy nie może awansować do
 * przywilejów człowieka.
 */
export function readQueuedMessage(slot: unknown): QueuedChatMessage | null {
    if (!slot) return null;
    if (typeof slot === 'string') return queueChatMessage(slot);
    const entry = slot as Partial<QueuedChatMessage>;
    if (typeof entry.text !== 'string' || !entry.text) return null;
    return queueChatMessage(entry.text, entry.meta, entry.owner);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * DECYZJE DRENU I STOPU - wyprowadzone z `chat_streaming.ts`.
 *
 * `chat_streaming.ts` wisi na `obsidian`, więc jedynym strażnikiem jego mixinu byłby regex
 * po tekście źródła: mutacja kasująca skutek (np. `if (false && !queuedOwnerMatches(…))`
 * albo `if (false && cancelled)`) zostawiałaby napis na miejscu i cały pakiet zielony.
 * Tutaj są jako czyste funkcje z testami OBU stron każdej gałęzi; monolit tylko wykonuje
 * werdykt (efekty uboczne - wskaźnik ⏳, log, podmiana pola wpisywania - zostają u niego).
 * ────────────────────────────────────────────────────────────────────────────── */

/** Co timer drenu ma zrobić po przebudzeniu. */
type QueuedDrainAction =
    /** slot jest pusty - Stop albo zamknięcie widoku zdążyły anulować */
    | 'empty'
    /** wiadomość należy do innej zakładki - ZOSTAJE w slocie, wraca wskaźnik ⏳ */
    | 'wait_owner'
    /** w oknie 100 ms ruszyła inna tura — kolejka czeka dalej */
    | 'wait_generating'
    /** wolno wysłać */
    | 'send';

interface QueuedDrainDecision {
    action: QueuedDrainAction;
    /** wiadomość, której decyzja dotyczy (`null` tylko przy `empty`) */
    queued: QueuedChatMessage | null;
}

/**
 * Czy zakolejkowaną wiadomość wolno TERAZ wysłać.
 *
 * Kolejność pytań jest częścią kontraktu: najpierw czy w ogóle jest co wysyłać, potem
 * czy adresat się zgadza (bo wiadomość obcej zakładki ma czekać, a nie ustępować turze),
 * na końcu czy nie ruszyła w międzyczasie inna tura.
 *
 * @param slot - surowa zawartość `_queuedMessage` (string albo wpis; czyta ją `readQueuedMessage`)
 * @param current - właściciel widoku W CHWILI PRZEBUDZENIA timera (`_queueOwner()`)
 */
export function evaluateQueuedDrain(
    slot: unknown,
    current: QueueOwner | null | undefined,
    state?: { isGenerating?: boolean },
): QueuedDrainDecision {
    const queued = readQueuedMessage(slot);
    if (!queued) return { action: 'empty', queued: null };
    if (!queuedOwnerMatches(queued, current)) return { action: 'wait_owner', queued };
    if (state?.isGenerating) return { action: 'wait_generating', queued };
    return { action: 'send', queued };
}

interface StopQueueCancelDecision {
    /** czy Stop ma opróżnić slot kolejki */
    clearSlot: boolean;
    /** tekst do oddania userowi w polu wpisywania; `null` = nie dotykaj pola */
    restoreText: string | null;
    /** wiadomość, którą Stop anulował (`null` = kolejka była pusta) */
    cancelled: QueuedChatMessage | null;
}

/**
 * Co Stop robi z kolejką.
 *
 * Stop kasuje slot; tekst nie ginie: wraca do pola wpisywania, ale **tylko gdy pole
 * jest puste** - szkic usera jest ważniejszy niż odzyskana kopia. Bez tego kasowania
 * `set_generating(false)` planowałby wysyłkę zakolejkowanej wiadomości na 100 ms PO
 * kliknięciu Stop - user przerywałby wszystko, a chwilę później ruszałaby pełna tura.
 *
 * @param slot - surowa zawartość `_queuedMessage`
 * @param draft - bieżąca wartość pola wpisywania (`undefined` = pola nie ma)
 */
export function evaluateStopQueueCancel(slot: unknown, draft?: string | null): StopQueueCancelDecision {
    const cancelled = readQueuedMessage(slot);
    if (!cancelled) return { clearSlot: false, restoreText: null, cancelled: null };
    const hasDraft = !!draft?.trim();
    return { clearSlot: true, restoreText: hasDraft ? null : cancelled.text, cancelled };
}
