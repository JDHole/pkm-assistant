/**
 * KomunikatorManager - Komunikator v3 „prosta poczta".
 *
 * MODEL DANYCH: folder per agent, PLIK PER WIADOMOŚĆ.
 *
 *   .pkm-assistant/komunikator/inbox/<safeName>/msg-<timestamp>.md
 *
 *   ---
 *   type: kom-message
 *   od: Tola
 *   do: Sonny
 *   temat: "Brief tygodniowy"
 *   data: 2026-07-29 14:30
 *   user_read: false
 *   ai_read: false
 *   ---
 *   <treść wiadomości>
 *
 * DLACZEGO TAK: skrzynka-jeden-plik z blokami HTML-komentarzy
 * wymagała regexów na CAŁEJ zawartości przy każdej zmianie statusu, miała twardy limit
 * 500 KB z resetem-archiwizacją i psuła się, gdy ktoś zacytował `**Status:**` w treści.
 * Plik-per-wiadomość: „ile nowych?" = policz pliki z `ai_read: false`, zmiana statusu =
 * edycja JEDNEGO małego pliku, zero limitu, zero archiwizacji-resetu.
 *
 * DUAL-TRACK: `user_read` (czy user widział) × `ai_read` (czy agent przeczytał).
 * ALL_READ = `user_read && ai_read` - LICZONE, nigdy zapisywane (jedno źródło prawdy).
 *
 * CREATE-ONLY DLA AGENTA: `deleteMessage` woła WYŁĄCZNIE UI (modal sprzątania / guzik
 * hurtowy). Żadne narzędzie agenta nie kasuje poczty.
 */

import { log } from '../../core/utils/Logger.js';
import { t, getDateLocale } from '../../core/i18n/index.js';
import { sanitizePath, parseFrontmatter, probeFile, getAgentSafeName } from '../../core/index.js';
import type { FileProbe } from '../../core/index.js';
import { DEFAULT_LIMITS } from '../../config/limits.js';
import type { AgentManagerLike, Message, MessageFrontmatter, MessageHeader, VaultEventFile, VaultEventRef, VaultLike } from './types.js';

/** Kształt frontmattera wiadomości, jaki `parseMessage` realnie czyta z pliku `.md` skrzynki.
 *  Plik bywa edytowany ręcznie albo zsynchronizowany z innego urządzenia, więc `user_read`/
 *  `ai_read`/`hop` dopuszczają zarówno formę YAML-owego booleana/liczby, jak i string —
 *  kod niżej akceptuje obie (`=== true || === 'true'`, `Number(...)`). */
interface ParsedMessageFrontmatter {
    user_read?: boolean | string;
    ai_read?: boolean | string;
    od?: string;
    do?: string;
    temat?: string;
    data?: string;
    hop?: number | string;
}

/** Maksymalny rozmiar pojedynczej wiadomości. */
// Nieeksportowana: zero konsumentów spoza tego pliku (test importuje tylko
// buildMessageMarkdown/parseMessage/setFrontmatterFlag, nie tę stałą).
const MAX_MESSAGE_BYTES = 50 * 1024;

/** Okno, w którym liczymy wysyłki na parę nadawca→adresat. */
export const KOM_RATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Po ilu minutach ciszy odczyt przestaje liczyć się do łańcucha odbić.
 * To jest zastępnik granicy „sesji": z poziomu narzędzia nie da się tanio i uczciwie
 * dowiedzieć, czy user zaczął nową rozmowę (patrz komentarz przy `noteRead`).
 */
export const KOM_HOP_TTL_MS = 30 * 60 * 1000;

/**
 * Na którym odbiciu przerywamy łańcuch. Wychodząca wiadomość dostaje
 * `maxHopPrzeczytanych + 1`; przy 3 mówimy dość i odsyłamy sprawę do usera.
 * A→B(0) → B→C(1) → C→A(2) → A chce odpisać(3) = STOP.
 */
export const KOM_HOP_LIMIT = 3;

/** Dozwolony kształt identyfikatora wiadomości - id przychodzi od LLM (`kom_read`). */
const MESSAGE_ID_RE = /^msg-[0-9]+(-[0-9]+)?$/;

/**
 * Siatka bezpieczeństwa keszu nagłówków. Jawna inwalidacja (mutacje przez ten manager) +
 * nasłuch zdarzeń vaulta (patrz `attachVaultEvents`) łapią WIĘKSZOŚĆ zmian, ale NIE WSZYSTKIE -
 * sesje Claude Code piszą do skrzynek WPROST na dysk (kontrakt `/agent`), vault bywa
 * synchronizowany Google Drive między urządzeniami, `obsidian-git pull` też potrafi podmienić
 * pliki bez odpalenia zdarzeń `Vault` (zależnie od tego, jak dany plugin/klient pisze). Bez
 * tego TTL kesz mógłby zamrozić licznik do najbliższej mutacji PRZEZ TEN MANAGER - realna
 * regresja funkcjonalna, nie tylko wydajnościowa. 5 s to górna granica opóźnienia - poniżej
 * progu percepcji „to się jeszcze nie odświeżyło" przy renderach co kilkaset ms (debounce
 * sidebara).
 */
const HEADER_CACHE_TTL_MS = 5000;

export class KomunikatorManager {
    declare vault: VaultLike;
    declare agentManager: AgentManagerLike;
    declare BASE_PATH: string;
    declare INBOX_PATH: string;
    declare _now: () => number;
    declare _sendLog: Map<string, number[]>;
    declare _senderLog: Map<string, number[]>;
    declare _readHops: Map<string, { hop: number; at: number }>;
    declare _locks: Map<string, Promise<void>>;
    declare _headerCache: Map<string, { headers: MessageHeader[]; at: number }>;
    declare _vaultEventRefs: VaultEventRef[];
    declare _vaultEventsAttached: boolean;
    /**
     * @param {Object} vault - Obsidian Vault. `adapter` jest wymagany; `on`/`offref`
     *   (realny event API Vaulta) są OPCJONALNE — bez nich `attachVaultEvents` no-opuje
     *   i kesz opiera się WYŁĄCZNIE na jawnej inwalidacji + TTL.
     * @param {Object|null} agentManager - do emitowania eventów UI (opcjonalny)
     * @param {Object} [options]
     * @param {Function} [options.now] - źródło czasu (DI dla testów zegara)
     */
    constructor(vault: VaultLike, agentManager: AgentManagerLike = null, options: { now?: () => number } = {}) {
        this.vault = vault;
        this.agentManager = agentManager;
        this.BASE_PATH = '.pkm-assistant/komunikator';
        this.INBOX_PATH = `${this.BASE_PATH}/inbox`;
        // Zegar wstrzykiwalny — testy rate-limitu i TTL nie mogą czekać 10 realnych minut.
        this._now = typeof options.now === 'function' ? options.now : () => Date.now();
        /** @type {Map<string, number[]>} znaczniki czasu wysyłek per para nadawca→adresat */
        this._sendLog = new Map();
        /** @type {Map<string, number[]>} znaczniki czasu wysyłek per NADAWCA, bez względu na adresata */
        this._senderLog = new Map();
        /** @type {Map<string, {hop: number, at: number}>} najwyższy przeczytany hop per agent */
        this._readHops = new Map();
        /** @type {Map<string, Promise<void>>} łańcuchy serializujące operacje poczty */
        this._locks = new Map();
        /**
         * Nagłówki skrzynki (bez treści), keszowane per folder skrzynki, z pieczątką czasu
         * budowy. DLACZEGO: odświeżenie sidebara (i `getUnreadCount`/`kom_list`/`resolveHopFor`
         * pod spodem) czytałoby z dysku KAŻDY plik wiadomości przy KAŻDYM wywołaniu, choć wynik
         * to zwykle jedna liczba. Kesz buduje się raz (`Promise.all`, nie sekwencyjny `for`)
         * i żyje, dopóki:
         *   1. żadna mutacja PRZEZ TEN MANAGER nie zajdzie (jawna inwalidacja: `sendMessage`/
         *      `_setFlag` przez `readMessage`/`markUserRead`/`markAiRead`/`deleteMessage`),
         *   2. żadne zdarzenie vaulta pod tym folderem nie przyjdzie (`attachVaultEvents`),
         *   3. `HEADER_CACHE_TTL_MS` nie minie (siatka bezpieczeństwa dla zapisów Z ZEWNĄTRZ -
         *      patrz komentarz przy stałej: agent CC piszący wprost na dysk, sync Google Drive,
         *      `obsidian-git pull`).
         * @type {Map<string, {headers: MessageHeader[], at: number}>}
         */
        this._headerCache = new Map();
        /** @type {unknown[]} referencje zdarzeń vaulta — sprzątane WYŁĄCZNIE jeśli `attachVaultEvents` dostał brak `registerEvent` (patrz `detachVaultEvents`). */
        this._vaultEventRefs = [];
        this._vaultEventsAttached = false;
    }

    /** @private Zdejmij kesz nagłówków skrzynki agenta — wołane po KAŻDEJ udanej mutacji. */
    _invalidateInboxCache(agentName: string): void {
        const dir = this._getInboxDir(agentName);
        if (dir) this._headerCache.delete(dir);
    }

    /**
     * Zdejmij kesz nagłówków dla folderu wskazanego ŚCIEŻKĄ PLIKU/FOLDERU (a nie nazwą
     * agenta) - używane przez handler zdarzeń vaulta, który dostaje surową ścieżkę
     * z Obsidiana, nie wie nic o `safeName`.
     * @private
     */
    _invalidateInboxCacheByPath(path: string | undefined): void {
        if (!path || !path.startsWith(`${this.INBOX_PATH}/`)) return;
        // '.../inbox/<safeName>/msg-....md' -> dir = '.../inbox/<safeName>'
        // '.../inbox/<safeName>' (sam folder, rename/delete na katalogu) -> ten sam dir.
        const rest = path.slice(this.INBOX_PATH.length + 1);
        const safeName = rest.split('/')[0];
        if (!safeName) return;
        this._headerCache.delete(`${this.INBOX_PATH}/${safeName}`);
    }

    /**
     * DLACZEGO: jawna inwalidacja przy mutacji PRZEZ TEN MANAGER nie łapie zapisów
     * Z ZEWNĄTRZ - sesje Claude Code piszą do skrzynek WPROST na dysk (kontrakt `/agent`),
     * vault bywa synchronizowany Google Drive między urządzeniami, `obsidian-git pull` też
     * potrafi podmienić pliki. Bez nasłuchu kesz zamrażałby liczniki do najbliższej mutacji
     * przez plugin (do `HEADER_CACHE_TTL_MS`, patrz stała) - realna regresja funkcjonalna,
     * nie tylko wydajnościowa.
     *
     * Nasłuchuje `create`/`modify`/`delete`/`rename` na `this.vault` (realny Obsidian `Vault`
     * ma `.on`/`.offref` — atrapy testowe bez nich po prostu nie dostają nasłuchu, TTL i tak
     * chroni). Wołane z `AgentManager` (jedyne miejsce, które ma `plugin.registerEvent` do
     * właściwego sprzątania przy unload) — wzór `VaultIndexer._registerHooks`.
     *
     * @param registerEvent - `plugin.registerEvent` (Obsidian `Component`), auto-cleanup przy
     *   unload. Gdy pominięty, referencje trzyma manager sam (`_vaultEventRefs`) — odepnij
     *   ręcznie przez `detachVaultEvents()` (harness/testy poza cyklem życia pluginu).
     * @returns {boolean} czy nasłuch faktycznie ruszył (`false` = atrapa vaulta bez `.on`).
     */
    attachVaultEvents(registerEvent?: (ref: VaultEventRef) => void): boolean {
        if (this._vaultEventsAttached) return true;
        const on = this.vault.on;
        if (typeof on !== 'function') return false;
        const bind = on.bind(this.vault);

        const asPath = (file: VaultEventFile | undefined): string | undefined =>
            typeof file === 'string' ? file : file?.path;
        const onChange = (file: VaultEventFile) => this._invalidateInboxCacheByPath(asPath(file));
        const onRename = (file: VaultEventFile, oldPath?: VaultEventFile) => {
            onChange(file);
            this._invalidateInboxCacheByPath(asPath(oldPath));
        };

        const refs = [
            bind('create', onChange),
            bind('modify', onChange),
            bind('delete', onChange),
            bind('rename', onRename),
        ].filter((ref): ref is VaultEventRef => ref != null);

        for (const ref of refs) {
            if (registerEvent) registerEvent(ref);
            else this._vaultEventRefs.push(ref);
        }
        this._vaultEventsAttached = true;
        return true;
    }

    /** Ręczne odpięcie nasłuchu — TYLKO gdy `attachVaultEvents` wołano BEZ `registerEvent` (harness/testy). */
    detachVaultEvents(): void {
        const offref = this.vault.offref;
        if (typeof offref === 'function') {
            for (const ref of this._vaultEventRefs) offref.call(this.vault, ref);
        }
        this._vaultEventRefs = [];
        this._vaultEventsAttached = false;
    }

    // ────────────────── serializacja operacji ──────────────────

    /**
     * Wykonaj `fn` jako OGNIWO łańcucha przypiętego do klucza — nic innego z tym samym
     * kluczem nie wejdzie w środek.
     *
     * DLACZEGO: wszystkie bramki poczty były „sprawdź, potem zapisz" z `await` w środku,
     * a jedna odpowiedź modelu leci przez `Promise.all` (`AgentLoop`). Dziesięć równoległych
     * `kom_send` widziało licznik na zerze, tę samą wolną nazwę pliku i ten sam (nieaktualny)
     * stan licznika odbić. Node jest jednowątkowy, więc wystarczy nie oddać sterowania między
     * sprawdzeniem a zapisem — łańcuch promise per klucz robi dokładnie to.
     *
     * Kolejność jest FIFO: `prev.then()` rejestruje się SYNCHRONICZNIE, więc ogniwa ustawiają
     * się w takiej kolejności, w jakiej model wypisał wywołania narzędzi.
     *
     * @param {string} key - `agent:<safeName>` (poczta jednego agenta) albo `inbox:<dir>` (jedna skrzynka)
     * @param {Function} fn
     */
    withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const prev = this._locks.get(key) ?? Promise.resolve();
        // `then(fn, fn)` — wywrotka poprzednika nie może zatkać kolejki.
        const run = prev.then(fn, fn);
        const settled: Promise<void> = run.then(() => {}, () => {});
        this._locks.set(key, settled);
        // Sprzątanie mapy: kasujemy TYLKO gdy nikt nie dopiął się w międzyczasie.
        void settled.then(() => { if (this._locks.get(key) === settled) this._locks.delete(key); });
        return run;
    }

    /** Łańcuch poczty JEDNEGO agenta — `kom_send` i `kom_read` tej samej tury idą po kolei. */
    withAgentLock<T>(agentName: string, fn: () => Promise<T>): Promise<T> {
        return this.withLock(`agent:${this._getSafeName(agentName)}`, fn);
    }

    // ────────────────── strażnicy poczty — stan w pamięci ──────────────────

    /**
     * Klucz pary nadawca→adresat. Ta sama normalizacja co nazwy folderu skrzynki, więc
     * „Tola" i „tola" to jeden nadawca — inaczej limit dałoby się obejść wielkością liter.
     * @private
     */
    _pairKey(from: string, to: string): string {
        return `${this._getSafeName(from)}>${this._getSafeName(to)}`;
    }

    /**
     * Klucz sufitu NADAWCY. Ta sama normalizacja co w {@link _pairKey}, więc
     * „Tola" i „tola" to jeden nadawca także tutaj.
     * @private
     */
    _senderKey(from: string): string {
        return this._getSafeName(from);
    }

    /**
     * @private Sprowadź podany limit do dodatniej liczby całkowitej albo weź default.
     */
    _effectiveLimit(limit: unknown, fallback: number): number {
        return Number.isFinite(Number(limit)) && Number(limit) > 0
            ? Math.floor(Number(limit))
            : fallback;
    }

    /**
     * Czy wolno wysłać kolejną wiadomość.
     * Stan żyje wyłącznie w pamięci: restart pluginu = czyste konto. Świadomie -
     * to bezpiecznik przed rozpędzoną pętlą w jednej sesji, nie kwota dzienna.
     *
     * DWA sufity na to samo okno, koniunkcyjnie:
     *  - `limit` — per PARA nadawca→adresat,
     *  - `senderLimit` — per NADAWCA, bez względu na adresata. Bez niego
     *    zepsuty agent rozsyłałby `limit` × liczba adresatów, mieszcząc się w każdej parze.
     * `reason` mówi, KTÓRY sufit odmówił — komunikat dla modelu ma być prawdziwy.
     *
     * @param {string} from
     * @param {string} to
     * @param {number} [limit] - efektywny limit pary (z `config/limits.js`)
     * @param {number} [senderLimit] - efektywny sufit nadawcy (z `config/limits.js`)
     */
    checkSendAllowed(
        from: string,
        to: string,
        limit: number = DEFAULT_LIMITS.kom_send_rate_max,
        senderLimit: number = DEFAULT_LIMITS.kom_send_rate_max_sender,
    ): { allowed: boolean; count: number; limit: number; senderCount: number; senderLimit: number; reason?: 'pair' | 'sender' } {
        const max = this._effectiveLimit(limit, DEFAULT_LIMITS.kom_send_rate_max);
        const senderMax = this._effectiveLimit(senderLimit, DEFAULT_LIMITS.kom_send_rate_max_sender);
        const recent = this._pruneSendLog(this._pairKey(from, to));
        const sender = this._pruneSenderLog(this._senderKey(from));
        const base = { count: recent.length, limit: max, senderCount: sender.length, senderLimit: senderMax };

        // Kolejność sprawdzeń = kolejność opowiadania userowi: najpierw wąska para,
        // potem szeroki sufit nadawcy.
        if (recent.length >= max) return { allowed: false, ...base, reason: 'pair' as const };
        if (sender.length >= senderMax) return { allowed: false, ...base, reason: 'sender' as const };
        return { allowed: true, ...base };
    }

    /**
     * ATOMOWA rezerwacja slotu: sprawdzenie i inkrement w JEDNYM kroku synchronicznym,
     * bez ani jednego `await` w środku. To jest metoda, której ma używać narzędzie
     * `kom_send`; `checkSendAllowed` + `noteSend` zostają jako podgląd i zapis dla
     * UI/testów, ale rozjeżdżają się przy równoległości.
     *
     * Licznik rośnie PRZED zapisem pliku (rezerwacja), a nie po nim - nieudany zapis
     * oddaje slot przez {@link releaseSend}. Sufit wsadu w jednej turze to ten sam
     * `kom_send_rate_max` z `config/limits.js`: dziesięć równoległych wywołań przy limicie
     * 5 dostaje 5 przepustek i 5 odmów.
     *
     * Rezerwacja dopisuje do OBU liczników (para + nadawca) - inaczej sufit nadawcy
     * byłby dekoracją, bo produkcyjna droga `kom_send` nie woła `noteSend`.
     */
    reserveSend(
        from: string,
        to: string,
        limit: number = DEFAULT_LIMITS.kom_send_rate_max,
        senderLimit: number = DEFAULT_LIMITS.kom_send_rate_max_sender,
    ) {
        const check = this.checkSendAllowed(from, to, limit, senderLimit);
        if (!check.allowed) return check;
        // `checkSendAllowed` przeszło przez oba `_prune*`, więc w mapach leżą żywe tablice.
        const now = this._now();
        const pairKey = this._pairKey(from, to);
        const recent = this._sendLog.get(pairKey) || [];
        recent.push(now);
        this._sendLog.set(pairKey, recent);

        const senderKey = this._senderKey(from);
        const sender = this._senderLog.get(senderKey) || [];
        sender.push(now);
        this._senderLog.set(senderKey, sender);

        return {
            allowed: true,
            count: recent.length,
            limit: check.limit,
            senderCount: sender.length,
            senderLimit: check.senderLimit,
        };
    }

    /**
     * Oddaj slot zarezerwowany przez {@link reserveSend}, gdy zapis pliku padł.
     * Oddajemy w OBU licznikach, inaczej błąd dysku zjadałby sufit nadawcy.
     */
    releaseSend(from: string, to: string): void {
        const recent = this._sendLog.get(this._pairKey(from, to));
        if (recent?.length) recent.pop();
        const sender = this._senderLog.get(this._senderKey(from));
        if (sender?.length) sender.pop();
    }

    /** Odnotuj wysyłkę w obu licznikach (wołane PO udanym zapisie pliku). */
    noteSend(from: string, to: string): void {
        const now = this._now();
        const pairKey = this._pairKey(from, to);
        const recent = this._pruneSendLog(pairKey);
        recent.push(now);
        this._sendLog.set(pairKey, recent);

        const senderKey = this._senderKey(from);
        const sender = this._pruneSenderLog(senderKey);
        sender.push(now);
        this._senderLog.set(senderKey, sender);
    }

    /** @private Wytnij znaczniki starsze niż okno i zwróć żywą tablicę (licznik pary). */
    _pruneSendLog(key: string): number[] {
        return KomunikatorManager._prune(this._sendLog, key, this._now() - KOM_RATE_WINDOW_MS);
    }

    /** @private To samo dla licznika nadawcy. To samo okno, inny klucz. */
    _pruneSenderLog(key: string): number[] {
        return KomunikatorManager._prune(this._senderLog, key, this._now() - KOM_RATE_WINDOW_MS);
    }

    /** @private Wspólne czyszczenie okna dla obu liczników. */
    static _prune(store: Map<string, number[]>, key: string, cutoff: number): number[] {
        const recent = (store.get(key) || []).filter(ts => ts > cutoff);
        store.set(key, recent);
        return recent;
    }

    /**
     * Odnotuj, że agent przeczytał wiadomość o danym `hop`.
     *
     * DLACZEGO TTL, A NIE „SESJA": z warstwy narzędzia nie ma czym uczciwie zmierzyć granicy
     * rozmowy — `kom_read` bywa wołane też przez sub-agenta i przez harness, a chat nie emituje
     * żadnego zdarzenia „nowa rozmowa" (`chat_session.handleNewSession` woła tylko
     * `AgentMemory.startNewSession`). Zamiast wiązać pocztę z pamięcią i chatem, liczymy
     * odczyty świeże — starsze niż {@link KOM_HOP_TTL_MS} nie budują już łańcucha.
     *
     * @param {string} agentName
     * @param {number} hop
     */
    noteRead(agentName: string, hop: number): void {
        const key = this._getSafeName(agentName);
        if (!key) return;
        const value = Number(hop) || 0;
        const now = this._now();
        const prev = this._readHops.get(key);
        const fresh = prev && (now - prev.at) <= KOM_HOP_TTL_MS ? prev.hop : -1;
        this._readHops.set(key, { hop: Math.max(fresh, value), at: now });
    }

    /**
     * Jaki `hop` ma dostać wiadomość wychodząca od tego agenta.
     * Brak świeżych odczytów = zwykła rozmowa z userem → 0.
     * @param {string} agentName
     * @returns {number}
     */
    nextHopFor(agentName: string): number {
        const entry = this._readHops.get(this._getSafeName(agentName));
        if (!entry) return 0;
        if ((this._now() - entry.at) > KOM_HOP_TTL_MS) {
            this._readHops.delete(this._getSafeName(agentName));
            return 0;
        }
        return entry.hop + 1;
    }

    /**
     * Jaki `hop` ma dostać wiadomość wychodząca, liczony ze stanu ODCZYTANEGO W CHWILI
     * WYSYŁKI.
     *
     * DLACZEGO NIE SAM `nextHopFor`: rejestr w pamięci zapisuje dopiero `noteRead`, czyli
     * dwa `await` w głąb `readMessage`. Gdy model w jednej turze woła `kom_read` i `kom_send`
     * (naturalne „sprawdź pocztę i odpisz"), wysyłka mogłaby wygrać wyścig, pójść z hopem 0
     * i SKASOWAĆ cały dotychczasowy łańcuch. Tu bierzemy MAKSIMUM z dwóch źródeł:
     *   1. rejestr w pamięci (`nextHopFor`) — świeży, bo `kom_send` i `kom_read` jednego
     *      agenta chodzą po tym samym łańcuchu {@link withAgentLock},
     *   2. ŚWIEŻY odczyt własnej skrzynki z dysku — listy już odhaczone `ai_read`, które
     *      przyszły w oknie {@link KOM_HOP_TTL_MS}. To przeżywa restart pluginu i nie zależy
     *      od tego, czy odczyt zdążył trafić do pamięci.
     *
     * FAIL-CLOSED: gdy stanu nie da się ustalić (zła nazwa agenta, padnięty odczyt skrzynki)
     * zwracamy {@link KOM_HOP_LIMIT}, czyli wysyłka odpada. Lepiej odbić list niż puścić
     * łańcuch z wyzerowanym licznikiem.
     *
     * @param {string} agentName
     * @returns {Promise<number>}
     */
    async resolveHopFor(agentName: string): Promise<number> {
        if (!this._getInboxDir(agentName)) return KOM_HOP_LIMIT;
        const fromMemory = this.nextHopFor(agentName);
        let fromDisk = 0;
        try {
            const cutoff = this._now() - KOM_HOP_TTL_MS;
            // DLACZEGO `_listMessagesStrict`, NIE `listMessages()`: publiczny `listMessages()`
            // łyka błędy I/O i oddaje `[]` — ten sam kształt jak „skrzynka pusta", więc catch
            // niżej by nie zadziałał. `_listMessagesStrict` PROPAGUJE awarię, żeby fail-closed
            // z komentarza wyżej realnie odpalał się na padniętym odczycie, nie tylko na
            // złej nazwie agenta.
            for (const m of await this._listMessagesStrict(agentName)) {
                if (!m.aiRead) continue;
                // Świeżość mierzymy znacznikiem z id (`msg-<epoch>[-n]`) — to moment doręczenia.
                const stamp = Number(String(m.id).split('-')[1]);
                if (!Number.isFinite(stamp) || stamp <= cutoff) continue;
                fromDisk = Math.max(fromDisk, (Number(m.hop) || 0) + 1);
            }
        } catch (e) {
            log.warn('KomunikatorManager', 'Failed to resolve hop:', e);
            return KOM_HOP_LIMIT;
        }
        return Math.max(fromMemory, fromDisk);
    }

    // ───────────────────────────── ścieżki ─────────────────────────────

    /**
     * Nazwa agenta → bezpieczna nazwa folderu (ten sam wzór co reszta pluginu).
     * @param {string} name
     * @returns {string}
     */
    _getSafeName(name: string): string {
        return getAgentSafeName(name);
    }

    /**
     * Folder skrzynki agenta. `sanitizePath` PIERWSZY (core/CLAUDE.md gotcha #4) — nazwa agenta
     * bywa podana przez model (`kom_send`), więc traktujemy ją jak wejście niezaufane.
     * @param {string} agentName
     * @returns {string|null} null = nazwa nie do użycia
     */
    _getInboxDir(agentName: string): string | null {
        const safe = this._getSafeName(agentName);
        if (!safe) return null;
        const clean = sanitizePath(`${this.INBOX_PATH}/${safe}`);
        if (!clean || !clean.startsWith(`${this.INBOX_PATH}/`)) return null;
        return clean;
    }

    /**
     * Ścieżka pliku wiadomości. Odrzuca id spoza wzorca `msg-<ts>[-n]` (traversal, dowolny `.md`).
     * @param {string} agentName
     * @param {string} id
     * @returns {string|null}
     */
    _getMessagePath(agentName: string, id: string): string | null {
        const dir = this._getInboxDir(agentName);
        if (!dir) return null;
        const rawId = String(id || '').replace(/\.md$/, '');
        if (!MESSAGE_ID_RE.test(rawId)) return null;
        const clean = sanitizePath(`${dir}/${rawId}.md`);
        if (!clean || !clean.startsWith(`${dir}/`)) return null;
        return clean;
    }

    /** Emituj event odświeżenia UI po każdej mutacji. */
    _notifyUpdated(agentName: string, extra: Record<string, unknown> = {}): void {
        this.agentManager?._emit?.('communicator:message_updated', { agent: agentName, ...extra });
    }

    /**
     * Po zmianie ptaszka sprawdź, czy wiadomość ma OBA - wtedy dochodzi drugi event,
     * na którym siedzi modal sprzątania. Jedno miejsce dla wszystkich mutacji:
     * i tych z UI, i tych z narzędzia agenta.
     * @param {string} agentName
     * @param {string} id
     */
    async _notifyIfAllRead(agentName: string, id: string): Promise<void> {
        try {
            const message = await this.getMessage(agentName, id);
            if (message?.allRead) {
                this.agentManager?._emit?.('communicator:message_all_read', { agent: agentName, id });
            }
        } catch { /* sygnał do UI — nigdy nie może wywalić mutacji */ }
    }

    // ───────────────────────────── foldery ─────────────────────────────

    /** Utwórz bazowe foldery komunikatora (leniwie, idempotentnie). */
    async ensureFolder() {
        try {
            for (const dir of [this.BASE_PATH, this.INBOX_PATH]) {
                if (!(await this.vault.adapter.exists(dir))) {
                    await this.vault.adapter.mkdir(dir);
                }
            }
        } catch (e) {
            log.warn('KomunikatorManager', 'Failed to create folder:', e);
        }
    }

    /**
     * Folder skrzynki adresata, gotowy do zapisu.
     *
     * ⚠️ **Dwie różne porażki, dwie różne diagnozy.** DLACZEGO: mapowanie obu przypadków na
     * jeden komunikat „nieznany adresat" byłoby nieprawdą, gdy w drodze przez `sendAgentMail`
     * adresat jest już ROZWIĄZANY jako istniejący i widoczny - model wnioskowałby, że agenta
     * nie ma, a jedyna prawdziwa informacja (awaria dysku) zostawałaby tylko w konsoli.
     *
     * @returns `{dir}` przy sukcesie, `{dir: null, reason}` przy porażce:
     *   `'invalid_recipient'` = nazwa nie do użycia (walidacja), `'inbox_unavailable'` = I/O.
     */
    async _ensureInboxDir(agentName: string): Promise<
        { dir: string; reason?: undefined } | { dir: null; reason: 'invalid_recipient' | 'inbox_unavailable' }
    > {
        const dir = this._getInboxDir(agentName);
        if (!dir) return { dir: null, reason: 'invalid_recipient' };
        await this.ensureFolder();
        try {
            if (!(await this.vault.adapter.exists(dir))) {
                await this.vault.adapter.mkdir(dir);
            }
        } catch (e) {
            log.warn('KomunikatorManager', 'Failed to create inbox dir:', dir, e);
            return { dir: null, reason: 'inbox_unavailable' };
        }
        return { dir };
    }

    // ───────────────────────────── zapis ─────────────────────────────

    /**
     * Wyślij wiadomość do skrzynki adresata (CREATE-ONLY — nigdy nie nadpisuje).
     * @param {string} from - nadawca (agent albo 'User')
     * @param {string} to - adresat
     * @param {string} subject
     * @param {string} content
     * @param {Object} [options]
     * @param {number} [options.hop=0] - numer odbicia w łańcuchu. Ścieżka UI (user pisze
     *   z panelu) zawsze zostawia 0 - łańcuch liczymy tylko dla poczty agent→agent.
     * @returns {Promise<{success: boolean, id?: string, path?: string, error?: string}>}
     */
    async sendMessage(from: string, to: string, subject: string, content: string, options: { hop?: number } = {}): Promise<{ success: boolean; id?: string; path?: string; error?: string }> {
        const inbox = await this._ensureInboxDir(to);
        if (inbox.dir === null) {
            // DLACZEGO: „nie umiem założyć skrzynki" to awaria zapisu, nie błąd adresata.
            return {
                success: false,
                error: inbox.reason === 'inbox_unavailable'
                    ? t('komunikator.inbox_unavailable')
                    : t('komunikator.invalid_recipient'),
            };
        }
        const dir = inbox.dir;

        const body = String(content ?? '');
        if (body.length > MAX_MESSAGE_BYTES) {
            return { success: false, error: t('komunikator.message_too_large', { max: MAX_MESSAGE_BYTES / 1024 }) };
        }

        // DLACZEGO: dobór nazwy i zapis idą pod JEDNYM łańcuchem na skrzynkę - bez tego dwie
        // równoległe wysyłki w tej samej milisekundzie dostałyby to samo id, a druga
        // KASOWAŁABY treść pierwszej, obie z `success: true`. Serializacja per skrzynka
        // sprawia, że sufiks widzi już zapisany plik poprzednika, także gdy nadawcy są różni.
        return this.withLock(`inbox:${dir}`, async () => {
            // Kolizja timestampu (dwie wiadomości w tej samej milisekundzie) → sufiks -1, -2, ...
            const stamp = this._now();
            let id = `msg-${stamp}`;
            let path = `${dir}/${id}.md`;
            for (let suffix = 1; ; suffix++) {
                const probe = await this._probe(path);
                if (probe === 'missing') break;
                // DLACZEGO: nieudane SPRAWDZENIE nie jest wolną nazwą. Nie wiemy, czy pod
                // spodem leży cudzy list, więc nadawca dostaje błąd (może ponowić - stempel
                // się zmieni) zamiast cichego nadpisania z `success: true`.
                if (probe === 'unknown') return { success: false, error: t('komunikator.send_failed') };
                id = `msg-${stamp}-${suffix}`;
                path = `${dir}/${id}.md`;
                if (suffix > 50) return { success: false, error: t('komunikator.send_failed') };
            }

            const markdown = buildMessageMarkdown({
                od: from,
                do: to,
                temat: subject,
                data: formatMessageDate(new Date(this._now())),
                user_read: false,
                ai_read: false,
                hop: Number(options.hop) || 0,
            }, body);

            // CREATE-ONLY na ostatnim metrze: adapter.write nadpisuje bez pytania, więc
            // tuż przed zapisem jeszcze raz upewniamy się, że pod tą nazwą nic nie leży.
            // Zapis przepuszcza WYŁĄCZNIE potwierdzone „nie ma" — `unknown` odmawia tak samo
            // jak `exists`.
            if (await this._probe(path) !== 'missing') {
                log.warn('KomunikatorManager', 'Refusing to overwrite existing message:', path);
                return { success: false, error: t('komunikator.send_failed') };
            }

            try {
                await this.vault.adapter.write(path, markdown);
            } catch (e) {
                log.warn('KomunikatorManager', 'Failed to write message:', e);
                return { success: false, error: t('komunikator.send_failed') };
            }

            // Nowy plik w skrzynce adresata - kesz nagłówków jest nieaktualny.
            this._invalidateInboxCache(to);
            this._notifyUpdated(to, { action: 'sent', id, from });
            return { success: true, id, path };
        });
    }

    // ───────────────────────────── odczyt ─────────────────────────────

    /**
     * Nagłówki wszystkich wiadomości w skrzynce agenta (najnowsze pierwsze).
     * @param {string} agentName
     * @returns {Promise<Array<{id, from, to, subject, date, userRead, aiRead, allRead}>>}
     */
    async listMessages(agentName: string): Promise<MessageHeader[]> {
        try {
            return await this._listMessagesStrict(agentName);
        } catch (e) {
            log.warn('KomunikatorManager', 'Failed to list inbox:', e);
            return [];
        }
    }

    /**
     * Jak {@link listMessages}, ale PROPAGUJE awarię I/O (`exists`/`list` na folderze
     * skrzynki rzuca) zamiast cichego `[]`. Publiczny `listMessages()` zostaje
     * swallow-to-`[]` dla wołaczy, dla których „pusto" i „nie wiem" to bezpiecznie ten sam
     * wynik (ping sesji, UI listujące skrzynkę, narzędzia agenta). Ale `resolveHopFor` i
     * `getUnreadCount` MUSZĄ odróżnić te dwa stany - pierwszy ma fail-closed wracać do
     * `KOM_HOP_LIMIT`, drugi ma pozwolić wołaczowi (chip w `CommunicatorView`) pokazać „?"
     * zamiast udawać potwierdzone zero. `listMessages` nigdy nie oddaje wyjątku, więc catch
     * u tych wołaczy nie miałby czego złapać.
     * @private
     */
    async _listMessagesStrict(agentName: string): Promise<MessageHeader[]> {
        const dir = this._getInboxDir(agentName);
        if (!dir) return [];

        // Trafienie w kesz = ZERO operacji na dysku.
        // Kopia (`.slice()`), żeby wołacz mogący posortować/zmutować tablicę we własnym
        // zakresie nie popsuł wpisu w keszu. TTL: trafienie starsze niż `HEADER_CACHE_TTL_MS`
        // liczy się jako PUDŁO, nie hit (siatka bezpieczeństwa dla zapisów spoza tego
        // managera, patrz komentarz przy stałej).
        const cached = this._headerCache.get(dir);
        if (cached && (this._now() - cached.at) <= HEADER_CACHE_TTL_MS) return cached.headers.slice();

        if (!(await this.vault.adapter.exists(dir))) return [];
        const listing = await this.vault.adapter.list(dir);
        const files = (listing?.files || []).filter((p) => p.endsWith('.md'));

        // Kesz zimny (albo świeżo zainwalidowany): czytamy WSZYSTKIE pliki naraz
        // (`Promise.all`), nie sekwencyjnym `for`+`await` — to sam w sobie był drugi grzech
        // ze znaleziska, niezależnie od keszowania.
        const parsedFiles = await Promise.all(files.map(async (filePath) => {
            const id = filePath.split('/').pop()!.replace(/\.md$/, '');
            if (!MESSAGE_ID_RE.test(id)) return null;
            return this._readMessageFile(filePath, id);
        }));

        const messages: MessageHeader[] = [];
        for (const parsed of parsedFiles) {
            if (parsed) messages.push(parsed.header);
        }
        // Najnowsze pierwsze — id niesie timestamp, więc sortowanie po nim jest stabilne.
        messages.sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }));
        this._headerCache.set(dir, { headers: messages, at: this._now() });
        return messages.slice();
    }

    /**
     * Podejrzyj JEDNĄ wiadomość BEZ zmiany statusów — ścieżka UI (rozwinięcie karty,
     * podgląd w modalu sprzątania). `ai_read` odhacza wyłącznie agent przez `readMessage`.
     * @param {string} agentName
     * @param {string} id
     * @returns {Promise<Object|null>} nagłówek + `body`
     */
    async getMessage(agentName: string, id: string): Promise<Message | null> {
        const path = this._getMessagePath(agentName, id);
        if (!path) return null;
        const parsed = await this._readMessageFile(path, String(id).replace(/\.md$/, ''));
        return parsed ? { ...parsed.header, body: parsed.body } : null;
    }

    /**
     * Przeczytaj JEDNĄ wiadomość + automatycznie odhacz `ai_read` (auto-ptaszek AI).
     * @param {string} agentName
     * @param {string} id
     * @returns {Promise<{success: boolean, message?: Object, error?: string}>}
     */
    async readMessage(agentName: string, id: string): Promise<{ success: boolean; message?: Message; error?: string }> {
        const path = this._getMessagePath(agentName, id);
        if (!path) return { success: false, error: t('komunikator.message_not_found') };
        const parsed = await this._readMessageFile(path, String(id).replace(/\.md$/, ''));
        if (!parsed) return { success: false, error: t('komunikator.message_not_found') };

        // TU (nie w `getMessage`) rośnie licznik odbić - to jest ścieżka AGENTA.
        // Podgląd w UI nie może dokładać agentowi łańcucha, którego sam nie przeczytał.
        this.noteRead(agentName, parsed.header.hop);

        if (!parsed.header.aiRead) {
            // DLACZEGO: pad zapisu ptaszka NIE MOŻE zniknąć w zwrotce. Ignorowanie zwrotki
            // `_setFlag` dałoby modelowi `success: true` i treść listu, a na dysku zostałoby
            // `ai_read: false` - więc `getAiUnreadCount` dalej liczyłby 1, ping wracałby w KAŻDEJ
            // następnej turze i agent czytałby ten sam list w kółko. Meldujemy ze STANU dysku:
            // nieoznaczona wiadomość to nie jest wiadomość odebrana.
            const marked = await this._setFlag(path, 'ai_read', true);
            if (!marked) {
                log.warn('KomunikatorManager', 'Nie udało się odhaczyć ai_read — wiadomość zostaje nieprzeczytana:', path);
                return { success: false, error: t('komunikator.mark_read_failed') };
            }
            parsed.header.aiRead = true;
            parsed.header.allRead = parsed.header.userRead === true;
            this._invalidateInboxCache(agentName);
            this._notifyUpdated(agentName, { action: 'ai_read', id: parsed.header.id });
            await this._notifyIfAllRead(agentName, parsed.header.id);
        }

        return { success: true, message: { ...parsed.header, body: parsed.body } };
    }

    /**
     * Odhacz „user przeczytał" (woła UI).
     * @returns {Promise<boolean>} true = plik faktycznie zmieniony
     */
    async markUserRead(agentName: string, id: string): Promise<boolean> {
        const path = this._getMessagePath(agentName, id);
        if (!path) return false;
        const changed = await this._setFlag(path, 'user_read', true);
        if (changed) {
            this._invalidateInboxCache(agentName);
            this._notifyUpdated(agentName, { action: 'user_read', id });
            await this._notifyIfAllRead(agentName, id);
        }
        return changed;
    }

    /**
     * Odhacz „AI przeczytał" bez zwracania treści (używane np. przy hurtowym oznaczaniu).
     * @returns {Promise<boolean>}
     */
    async markAiRead(agentName: string, id: string): Promise<boolean> {
        const path = this._getMessagePath(agentName, id);
        if (!path) return false;
        const changed = await this._setFlag(path, 'ai_read', true);
        if (changed) {
            this._invalidateInboxCache(agentName);
            this._notifyUpdated(agentName, { action: 'ai_read', id });
            await this._notifyIfAllRead(agentName, id);
        }
        return changed;
    }

    /**
     * TWARDE usunięcie wiadomości (bez kosza). Woła WYŁĄCZNIE UI.
     * @returns {Promise<boolean>}
     */
    async deleteMessage(agentName: string, id: string): Promise<boolean> {
        const path = this._getMessagePath(agentName, id);
        if (!path) return false;
        try {
            if (!(await this.vault.adapter.exists(path))) return false;
            await this.vault.adapter.remove(path);
        } catch (e) {
            log.warn('KomunikatorManager', 'Failed to delete message:', e);
            return false;
        }
        this._invalidateInboxCache(agentName);
        this._notifyUpdated(agentName, { action: 'deleted', id });
        return true;
    }

    // ───────────────────────────── liczniki ─────────────────────────────

    /**
     * Ile wiadomości user jeszcze nie widział (badge w UI).
     * @param {string} agentName
     * @returns {Promise<number>}
     */
    async getUnreadCount(agentName: string): Promise<number> {
        // DLACZEGO strict wariant: `CommunicatorView.renderAgentStrip` i
        // `HomeView.updateCommunicatorChips` mają catch zbudowany DOKŁADNIE pod odrzucenie tej
        // obietnicy (badge „?" / pominięty chip + log) - przez `listMessages()` ten catch by się
        // nie odpalił, bo błąd I/O wygląda identycznie jak potwierdzone zero.
        const messages = await this._listMessagesStrict(agentName);
        return messages.filter(m => !m.userRead).length;
    }

    /**
     * Ile wiadomości agent (AI) jeszcze nie przeczytał - źródło pingu sesji.
     * @param {string} agentName
     * @returns {Promise<number>}
     */
    async getAiUnreadCount(agentName: string): Promise<number> {
        const messages = await this.listMessages(agentName);
        return messages.filter(m => !m.aiRead).length;
    }

    /**
     * Batch liczników user-unread dla listy agentów (paski w UI).
     * @param {string[]} agentNames
     * @returns {Promise<Map<string, number>>}
     */
    async getUnreadCounts(agentNames: string[]): Promise<Map<string, number>> {
        const counts = new Map<string, number>();
        for (const name of agentNames || []) {
            counts.set(name, await this.getUnreadCount(name));
        }
        return counts;
    }

    /**
     * Dane pingu sesji: ile nieprzeczytanych przez AI + od kogo. BEZ treści.
     * @param {string} agentName
     * @returns {Promise<{count: number, senders: string[]}>}
     */
    async getInboxPing(agentName: string): Promise<{ count: number; senders: string[] }> {
        const unread = (await this.listMessages(agentName)).filter(m => !m.aiRead);
        const senders: string[] = [];
        for (const m of unread) {
            if (m.from && !senders.includes(m.from)) senders.push(m.from);
        }
        return { count: unread.length, senders };
    }

    /**
     * Wiadomości z OBOMA ptaszkami (kandydaci guzika „Usuń przeczytane").
     * @param {string} agentName
     * @returns {Promise<Array<Object>>}
     */
    async listAllRead(agentName: string): Promise<MessageHeader[]> {
        return (await this.listMessages(agentName)).filter(m => m.allRead);
    }

    // ───────────────────────────── bebechy ─────────────────────────────

    /**
     * Czy pod tą ścieżką coś leży - w TRZECH stanach.
     *
     * DLACZEGO NIE `try { exists() } catch { return false }`: to zamieniałoby KAŻDY wyjątek
     * w ciche „nazwa wolna", bez jednej linii w logu - i tą samą wartością karmiłoby pętlę
     * doboru nazwy ORAZ bramkę anty-nadpisaniową tuż przed zapisem. Jedno zacięcie I/O na
     * jednym pliku wystarczyłoby, żeby `adapter.write` skasował cudzą wiadomość, a obaj
     * nadawcy dostali `success: true`. `unknown` odczytujemy jako „zajęte / nie ruszam" -
     * fail-closed.
     */
    async _probe(path: string): Promise<FileProbe> {
        const probe = await probeFile(this.vault.adapter, path);
        if (probe === 'unknown') {
            log.warn('KomunikatorManager', 'Nie wiem, czy plik istnieje (sprawdzenie padło):', path);
        }
        return probe;
    }

    /**
     * Wczytaj i sparsuj jeden plik wiadomości.
     * @returns {Promise<{header: Object, body: string}|null>}
     */
    async _readMessageFile(path: string, id: string): Promise<{ header: MessageHeader; body: string } | null> {
        // Bez `exists()` przed `read()` — ten sam wzorzec co przy innych odczytach plików
        // w tym repo (`exists()` kłamie na dyskach sieciowych). Brakujący plik i padnięty
        // odczyt dają identyczny skutek (`null`), więc jedno `try/catch` na `read` wystarcza
        // i połowi liczbę operacji adaptera na plik.
        let raw: string | undefined;
        try {
            raw = await this.vault.adapter.read(path);
        } catch (e) {
            log.warn('KomunikatorManager', 'Failed to read message:', e);
            return null;
        }
        return parseMessage(raw as string, id);
    }

    /**
     * Ustaw flagę statusu w JEDNYM pliku (podmiana pojedynczej linii frontmattera).
     * @returns {Promise<boolean>} true = plik zmieniony
     */
    async _setFlag(path: string, flag: 'user_read' | 'ai_read', value: boolean): Promise<boolean> {
        let raw: string | undefined;
        try {
            if (!(await this.vault.adapter.exists(path))) return false;
            raw = await this.vault.adapter.read(path);
        } catch (e) {
            // DLACZEGO log.warn: gołe `catch { return false; }` nie zostawiałoby ani linii
            // w logu, a wołacz nie miałby JAK odróżnić „nic do zmiany" od „odczyt padł".
            log.warn('KomunikatorManager', 'Failed to read message before flag update:', path, e);
            return false;
        }

        const updated = setFrontmatterFlag(raw as string, flag, value);
        if (updated === raw) return false;
        try {
            await this.vault.adapter.write(path, updated);
        } catch (e) {
            log.warn('KomunikatorManager', 'Failed to update message flag:', e);
            return false;
        }
        return true;
    }
}

// ═══════════════════════ pure helpery (testowalne bez vaulta) ═══════════════════════

/**
 * Data wiadomości w formacie `YYYY-MM-DD HH:MM`.
 * @param {Date} now
 * @returns {string}
 */
// Nieeksportowana: zero konsumentów spoza tego pliku (test nie importuje
// formatMessageDate; wzmianka w modules/artifacts/artifactParser.ts:71 to tylko
// komentarz prozą, nie import).
function formatMessageDate(now: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = now.toLocaleTimeString(getDateLocale(), { hour: '2-digit', minute: '2-digit' });
    return `${local} ${time}`;
}

/**
 * Złóż markdown wiadomości. Wartości nagłówka idą przez JSON.stringify (cudzysłowy,
 * dwukropki i nowe linie w temacie nie mogą rozwalić frontmattera).
 * @param {Object} fm - {od, do, temat, data, user_read, ai_read, hop}
 * @param {string} body
 * @returns {string}
 */
export function buildMessageMarkdown(fm: MessageFrontmatter, body: string): string {
    const quote = (v: unknown) => JSON.stringify(String(v ?? '').replace(/[\r\n]+/g, ' ').trim());
    return [
        '---',
        'type: kom-message',
        `od: ${quote(fm.od)}`,
        `do: ${quote(fm.do)}`,
        `temat: ${quote(fm.temat)}`,
        `data: ${quote(fm.data)}`,
        `user_read: ${fm.user_read === true}`,
        `ai_read: ${fm.ai_read === true}`,
        // Numer odbicia w łańcuchu agent→agent. 0 = początek rozmowy.
        `hop: ${Number(fm.hop) || 0}`,
        '---',
        '',
        String(body ?? ''),
        '',
    ].join('\n');
}

/**
 * Sparsuj plik wiadomości do {header, body}. Brak frontmattera = plik nie jest wiadomością.
 * @param {string} raw
 * @param {string} id
 * @returns {{header: Object, body: string}|null}
 */
export function parseMessage(raw: string, id: string): { header: MessageHeader; body: string } | null {
    // TS-boundary: frontmatter YAML pliku wiadomości w skrzynce - dane na dysku, poza kontrolą
    // pluginu (user edytuje ręcznie, vault bywa synchronizowany między urządzeniami), bez
    // walidacji schematem (poza zakresem tej fali). `parseFrontmatter` zwraca `unknown`.
    const { frontmatter, content } = parseFrontmatter(String(raw || '')) as { frontmatter: ParsedMessageFrontmatter | null; content: string };
    if (!frontmatter) return null;

    const userRead = frontmatter.user_read === true || frontmatter.user_read === 'true';
    const aiRead = frontmatter.ai_read === true || frontmatter.ai_read === 'true';

    return {
        header: {
            id,
            from: frontmatter.od || t('communicator.default_from'),
            to: frontmatter.do || '',
            subject: frontmatter.temat || t('communicator.no_subject'),
            date: frontmatter.data || '',
            userRead,
            aiRead,
            allRead: userRead && aiRead,
            // Brak pola (starsze wiadomości) = hop 0.
            hop: Number(frontmatter.hop) || 0,
        },
        body: String(content || '').trim(),
    };
}

/**
 * Podmień JEDNĄ flagę statusu we frontmatterze. Działa tylko na bloku frontmattera —
 * identyczna linia w treści wiadomości nie zostanie ruszona.
 * @param {string} raw
 * @param {'user_read'|'ai_read'} flag
 * @param {boolean} value
 * @returns {string} niezmieniony wejściowy string, gdy nie było czego podmienić
 */
export function setFrontmatterFlag(raw: string, flag: 'user_read' | 'ai_read', value: boolean): string {
    const text = String(raw || '');
    const match = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
    if (!match) return text;

    const [, open, fmBody, close] = match;
    const re = new RegExp(`^(\\s*${flag}\\s*:).*$`, 'm');
    const replacement = `$1 ${value === true}`;
    const nextFm = re.test(fmBody)
        ? fmBody.replace(re, replacement)
        : `${fmBody}\n${flag}: ${value === true}`;
    if (nextFm === fmBody) return text;

    return open + nextFm + close + text.slice(match[0].length);
}
