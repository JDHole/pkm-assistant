/**
 * AgentMemory - Hierarchical memory management per agent
 *
 * Structure:
 * .pkm-assistant/agents/{agent_name}/memory/
 * ├── brain.md              <- Memory v3 index + short-term notes
 * ├── brain/                <- Memory v3 note files (Claude Code-style)
 * ├── audit.log             <- Memory change log
 * ├── sessions/             <- Legacy individual sessions with summaries
 * │   ├── active/           <- Memory v3 active live sessions
 * │   └── archive/          <- Memory v3 archived sessions
 * └── summaries/
 *     ├── L1/              <- Every 5 sessions → 1 L1 summary
 *     ├── L2/              <- Every 5 L1 → 1 L2 summary
 *     └── L3/              <- Every 10 L2 → 1 L3 summary
 */

import { formatToMarkdown, parseSessionFile } from './sessionParser.js';
import {
    formatSessionEvent,
    parseActiveSession,
    parseFrontmatter,
    maxSeq,
    KNOWN_ROLES,
} from './activeSessionFormat.js';
import { StateManager } from './StateManager.js';
import type { ParsedActiveSession, SessionFrontmatter, SessionRole } from './activeSessionFormat.js';
import type { TranscriptMetadata, ParsedSessionFile } from './sessionParser.js';
import type { MemoryNoteType } from './MemoryAccessGuard.js';
import type { NaTerazOp, NaTerazSections } from './BrainIndex.js';
import {
    INDEX_SECTIONS,
    buildBrainIndex,
    parseNaTerazSections,
    parseForeignSections,
    parseManualIndexLines,
    applyNaTerazOps,
    isNaTerazHeading,
    NA_TERAZ_MAX_ENTRIES,
    oneLineDescription,
} from './BrainIndex.js';
import { makeMemoryNoteFilename, isValidNoteType, getSafeAgentName } from './MemoryAccessGuard.js';
import { findFreeCollisionPath } from './collisionSuffix.js';
import { t } from '../../core/i18n/index.js';
import { getTokenCount, maskSensitiveData, probeFile, readIfExists } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';

/**
 * Brain hard limit: 600 tokenów (z buforem). Brain ładuje się do KAŻDEGO requestu, więc
 * każdy token tu to stały koszt per chat round-trip. Liczony w tokenach, nie znakach —
 * limit znakowy zaniża koszt dla polskiego (jeden token EN ≠ jeden token PL).
 *
 * Nowe fakty trafiają do brain/*.md, a brain.md jest przebudowywanym indeksem; legacy
 * `updateBrain` obsługuje tylko starsze ścieżki kompatybilności i nie jest normalną drogą zapisu.
 *
 * brain.md niesie oprócz indeksu także sekcje „Na teraz" (pamięć krótkotrwała), więc budżet
 * musi pomieścić indeks + do 2×10 wpisów stanu bieżącego.
 */
const BRAIN_MAX_TOKENS = 600;

/**
 * Char-based safety net dla brain. Jeśli getTokenCount() padnie/throw,
 * lecimy na fallback char limit. 1750 chars ≈ 350 tok dla EN, ~250 tok dla PL.
 * Lepiej za mało niż za dużo — brain ma być chudy.
 */
const BRAIN_MAX_CHARS_FALLBACK = 1750;

// ℹ️ Kontrakt pliku `sessions/active/*.md` żyje w JEDNYM miejscu:
// `activeSessionFormat.js`. Tam są `formatSessionEvent`, `parseActiveSession`, para
// escape/unescape `## `, escape etykiet pól i zbiór ról granicznych (`KNOWN_ROLES`).
// Metoda `_parseActiveSessionFile` niżej to już tylko delegacja.
//
// ⚠️ Plik active ma JEDNEGO pisarza — event-log (`appendToActiveSession`).
// `saveSession` DOPISUJE brakujący ogon jako eventy (nigdy nie nadpisuje), a transkrypt
// (`formatToMarkdown`) powstaje dopiero przy archiwizacji. Czytnik zostaje trójformatowy,
// bo pliki starszego formatu leżą u userów na dysku.

/**
 * Rola wiadomości → typ zdarzenia event-logu (ogon `saveSession`).
 * Lustro `roleFromEvent` z `activeSessionFormat.js`; `system_message` nie ma tam mapowania,
 * więc dla roli `system` dopisujemy jeszcze jawne pole `**role:**`.
 */
const ROLE_TO_EVENT_TYPE: Record<SessionRole, string> = {
    user: 'user_message',
    assistant: 'agent_message',
    tool: 'tool_result',
    system: 'system_message',
};

/**
 * Krótki, czytelny opis `cause` z `readIfExists` — do wklejenia
 * w komunikat throw/warn zamiast suchego „nie mogę odczytać X" bez powodu.
 * `Error` → jego `.message`; cokolwiek innego → `String(...)`; `undefined` (adapter bez `read`,
 * próba w ogóle się nie odbyła) dostaje własny, opisowy tekst zamiast dosłownego „undefined".
 */
function causeText(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    if (cause === undefined) return 'brak szczegółów — adapter bez metody read()';
    return String(cause);
}

/**
 * Sygnał „plik sesji, do którego dopisuję, nie istnieje".
 * Odróżnia „ścieżka jest martwa, zacznij sesję od nowa" od realnego błędu I/O (dysk pełny,
 * uprawnienia), który MA prawa wywrócić turę. Rzucany WYŁĄCZNIE przez `_appendSessionFile`
 * (fallback bez natywnego `append`) — natywny `append` na brakującym pliku jest łapany osobno
 * (patrz `APPEND_VERIFY_EVERY_N` w `appendToActiveSession`), bo nie każdy adapter rzuca.
 */
class SessionFileMissingError extends Error {}

/**
 * Ile appendów na CIEPŁYM cache mija między jednym tanim `exists()`. Natywny `adapter.append`
 * na brakującym pliku zwykle NIE rzuca — po prostu tworzy plik od nowa (jak `fs` z flagą `a`),
 * więc zewnętrzne skasowanie sesji między zdarzeniami zostałoby wykryte tylko przez ten
 * periodyczny, metadanowy `exists()` (bez odczytu treści — O(1) względem rozmiaru pliku,
 * nie O(n) jak pełny `read()`).
 * Kompromis: nie każde zdarzenie płaci za pełny `exists()`, ale okno
 * „plik odtworzony bez frontmattera" jest ograniczone do N zdarzeń, nie nieskończone.
 * Eksportowana (nie tylko module-private), żeby test liczący operacje adaptera nie duplikował
 * tej liczby jako magicznej stałej.
 */
export const APPEND_VERIFY_EVERY_N = 20;

// ═════════════════════════ Kontrakty (typowane strukturalnie) ═════════════════════════

/** Adapter FS vaulta w zakresie, którego dotyka pamięć agenta. */
export interface MemoryVaultAdapterLike {
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    list(path: string): Promise<{ files?: string[]; folders?: string[] } | null>;
    mkdir(path: string): Promise<void>;
    /** opcjonalne — atrapy testów bywają bez nich, kod to sprawdza (`stat?.`, `if (remove)`) */
    stat?(path: string): Promise<{ mtime?: number; size?: number } | null>;
    remove?(path: string): Promise<void>;
    /**
     * Dopisanie ogona pliku bez pełnego read+write. Obsidian ma tę metodę
     * na `DataAdapter` (ten sam kontrakt, którego już używa `core/utils/LogFileSink.ts`);
     * atrapa testowa/adapter bez niej dostaje fallback w `_appendSessionFile`.
     */
    append?(path: string, data: string): Promise<void>;
}

export interface MemoryVaultLike {
    adapter: MemoryVaultAdapterLike;
}

/** Wszystkie ścieżki struktury Memory v3 dla jednego agenta. */
export interface MemoryPaths {
    sessions: string;
    sessionsActive: string;
    sessionsArchive: string;
    l1: string;
    l2: string;
    l3: string;
    brainNotes: string;
    brainArchive: string;
    pendingRescue: string;
    activeContext: string;
    brain: string;
    state: string;
    activeSessionMeta: string;
}

/**
 * Sesja, która po zapisie L1 NIE dostała stempla `covered_by_l1`.
 * `not_found` = nie ma jej ani w `sessions/archive/`, ani w płaskim `sessions/`;
 * `write_failed` = read-modify-write pliku sesji rzucił (blokada / prawa / brak miejsca).
 */
export interface L1StampSkip {
    session: string;
    reason: 'not_found' | 'write_failed';
    detail?: string;
}

/** Wynik stemplowania sesji po zapisie paczki L1. */
export interface L1StampOutcome {
    marked: number;
    skipped: L1StampSkip[];
}

/** Pozycja listy `sessions/archive`. */
export interface ArchiveSessionInfo {
    path: string;
    name: string;
    agent: string;
    created: string;
    covered_by_l1: string;
    /** data POWSTANIA sesji (ms) — z frontmattera, mtime tylko jako fallback */
    sessionTime: number;
    mtime: number;
    size: number;
}

/** Pozycja listy `sessions/active`. */
export interface ActiveSessionInfo {
    path: string;
    name: string;
    agent: string;
    created: string;
    mtime: number;
    size: number;
    label: string;
}

/** Notatka `brain/*.md` w widoku listy. */
export interface BrainNoteInfo {
    path: string;
    filename: string;
    name: string;
    description: string;
    type: string;
    created: string;
    status: string;
    mtime: number;
}

/** Wejście `writeBrainNote` / `_buildBrainNoteContent`. */
export interface BrainNoteInput {
    name?: string;
    description?: string;
    type?: string;
    content?: string;
    why?: string;
    how_to_apply?: string;
    howToApply?: string;
}

/**
 * Kandydat w poczekalni `brain/pending_rescue/` — pełny kształt, nie tylko
 * metadane indeksu jak `BrainNoteInfo`. Konsument (`SaveSessionWorkflow`) potrzebuje `content`
 * do wyświetlenia w tym samym modalu co zwykłe propozycje `/save session`.
 */
export interface PendingRescueNote {
    path: string;
    filename: string;
    name: string;
    description: string;
    type: string;
    content: string;
    why: string;
    how_to_apply: string;
    /** skąd przyszedł kandydat (`auto_compaction` — jedyne dziś źródło) */
    source: string;
    created: string;
}

/** Zdarzenie dopisywane do pliku aktywnej sesji. */
export interface ActiveSessionEventInput {
    type?: string;
    agentName?: string;
    timestamp?: string;
    [key: string]: unknown;
}

/** Wiadomość okna czatu, którą `saveSession` dopisuje jako ogon. */
export interface ChatMessageLike {
    role?: string;
    content?: unknown;
}

/**
 * `brain.md` rozłożony na nagłówek + sekcje (`## …` → lista bulletów). Kształt legacy:
 * używają go już tylko `updateBrain` i `_archiveOverflow` — v3 buduje indeks przez
 * `BrainIndex.buildBrainIndex`.
 */
export interface BrainSections {
    header: string;
    sections: Map<string, string[]>;
}

/**
 * Legacy wpis `brain_update` przekazywany do `memoryWrite`. Trafia WYŁĄCZNIE do `audit.log`
 * jako zignorowany (v3 nie mutuje `brain.md`) — dlatego pola opisują to, co przysyłali
 * dawni wołacze, a nie to, czego kod używa (`category` + `content`).
 */
export interface LegacyMemoryUpdate {
    category?: string;
    content?: string;
    section?: string;
    oldContent?: string;
}

/** Jeden wpis kroniki `brain.log`. */
export interface BrainLogEntry {
    ts: string;
    op: string;
    target: string;
    detail: string;
}

export class AgentMemory {
    // `declare` = sama deklaracja typu, zero emitu.
    declare vault: MemoryVaultLike;
    declare agentName: string;
    declare settings: Record<string, unknown>;
    declare safeName: string;
    declare basePath: string;
    /**
     * Zewnętrzni pisarze tego pola (podstawiają ścieżkę WPROST, z pominięciem
     * `startActiveSession`/`saveSession`):
     *  - `modules/chat/chat/chat_tabs.ts:126` — `memory.activeSessionPath = targetTab.sessionPath;`
     *    (przełączenie zakładki czatu),
     *  - `modules/chat/chat/chat_session.ts:237` — `memory.activeSessionPath = item.session.path;`
     *    (restore wielu zakładek przy starcie),
     *  - `modules/chat/chat/chat_session.ts:244` — `activeMemory.activeSessionPath = active.session.path;`
     *    (restore — pierwsza/aktywna zakładka).
     * Żaden z nich nie sprawdza, czy plik pod tą ścieżką WCIĄŻ istnieje (np. bo w międzyczasie
     * `archiveActiveSession` go przeniósł i wyzerował pole u SIEBIE) — dlatego `startActiveSession`
     * NIE MOŻE ufać samemu faktowi „pole niepuste", tylko ciepłemu cache pisarza tej instancji.
     */
    declare activeSessionPath: string | null;
    declare _writeQueues: Map<string, Promise<void>>;
    declare _sessionSeqCache: Map<string, number>;
    declare _sessionSavedCounts: Map<string, number>;
    /** `ensureMemoryStructure()` zrobiła już swoje dla tej instancji — dalsze
     * wywołania są no-opem. Bezpieczne, bo `basePath`/`paths` są ustawiane raz w konstruktorze
     * i nigdy nie zmieniają się pod nogami tej instancji. */
    declare _structureEnsured: boolean;
    /** Czy plik pod ścieżką kończy się `\n` — cache, żeby append nie musiał
     * czytać całego pliku na każde zdarzenie tylko po to, żeby dobrać separator. */
    declare _sessionEndsWithNewline: Map<string, boolean>;
    /** Licznik appendów od ostatniego periodycznego `exists()`
     * na ciepłym cache — patrz `APPEND_VERIFY_EVERY_N`. */
    declare _appendsSinceVerify: Map<string, number>;
    declare paths: MemoryPaths;
    declare stateManager: StateManager;

    /**
     * @param vault - Obsidian Vault object
     * @param agentName - Name of the agent
     * @param settings - Plugin settings
     */
    constructor(vault: MemoryVaultLike, agentName: string, settings: Record<string, unknown> = {}) {
        this.vault = vault;
        this.agentName = agentName;
        this.settings = settings;

        // Normalize agent name for filesystem
        this.safeName = getSafeAgentName(agentName);
        this.basePath = `.pkm-assistant/agents/${this.safeName}/memory`;

        // Track active session to prevent duplicate files
        this.activeSessionPath = null;

        // Per-path write serialization. Parallel sub-agents (DelegateTool
        // Promise.all + SubAgentRunner) append to the SAME parent session file. Without
        // a lock the read-modify-write races and one write silently overwrites the other
        // → memory lines disappear. Map<path, Promise> chains writes to each path.
        this._writeQueues = new Map();

        // Numeracja zdarzeń w pliku aktywnej sesji. Map<path, ostatni użyty seq>.
        // Pierwszy zapis do danej ścieżki (albo pierwszy PO restarcie Obsidiana) inicjalizuje
        // licznik skanem pliku (`maxSeq`), dalej idzie z pamięci — bez ponownego skanowania.
        this._sessionSeqCache = new Map();

        // Ile wiadomości z listy podanej przez `saveSession` już pokryliśmy w pliku.
        // Potrzebne, bo event-log jest tylko CZĘŚCIOWO wyrównany z okienkiem czatu: blok bez
        // treści (np. odpowiedź modelu, która była samym wywołaniem narzędzia) nie jest dla
        // czytnika wiadomością, więc licznik z pliku byłby niższy niż faktycznie zapisany ogon
        // i następny autozapis dopisałby te same zdania po raz drugi. Licznik przesuwa się tylko
        // w górę — woli POMINĄĆ dopisek (pisarz A i tak zapisuje wszystko) niż zdublować.
        this._sessionSavedCounts = new Map();

        // Bootstrap struktury jeszcze nie zrobiony dla tej instancji.
        this._structureEnsured = false;

        // Stan „plik kończy się \n" per ścieżka — patrz deklaracja pola.
        this._sessionEndsWithNewline = new Map();

        // Licznik do periodycznego exists() na ciepłym cache.
        this._appendsSinceVerify = new Map();

        // Paths
        this.paths = {
            sessions: `${this.basePath}/sessions`,
            sessionsActive: `${this.basePath}/sessions/active`,
            sessionsArchive: `${this.basePath}/sessions/archive`,
            l1: `${this.basePath}/summaries/L1`,
            l2: `${this.basePath}/summaries/L2`,
            l3: `${this.basePath}/summaries/L3`,
            brainNotes: `${this.basePath}/brain`,
            brainArchive: `${this.basePath}/brain/archive`,
            // Poczekalnia kandydatów memory_rescue — wzorem
            // `brain/archive/`, siostrzany podfolder wykluczony z `listBrainNotes()`/indeksu
            // dokładnie tym samym filtrem ("relative && !relative.includes('/')").
            pendingRescue: `${this.basePath}/brain/pending_rescue`,
            activeContext: `${this.basePath}/active_context.md`,
            brain: `${this.basePath}/brain.md`,
            state: `${this.basePath}/.state.json`,
            activeSessionMeta: `${this.basePath}/.active_session.json`
            // Ścieżka `draft` (`.draft/`) nie jest już częścią tego kontraktu — nikt jej nie
            // czyta ani nie pisze. Pliki, które user ma na dysku, zostają nietknięte; po prostu
            // nie powstają nowe.
        };
        this.stateManager = new StateManager(this.vault, this.paths.state);
    }

    /**
     * Restore persisted activeSessionPath from disk (call on plugin init).
     * Returns the path if restored, null otherwise.
     */
    async restoreActiveSession(): Promise<string | null> {
        try {
            const state = await this.stateManager.read();
            const candidates = [
                state?.last_used,
                ...(state?.active_sessions || [])
            ].filter(Boolean) as string[];

            for (const name of candidates) {
                const path = name.includes('/') ? name : `${this.paths.sessionsActive}/${name}`;
                if (await this.vault.adapter.exists(path)) {
                    this.activeSessionPath = path;
                    await this._persistActiveSession();
                    return path;
                }
            }
        } catch { /* fall through to legacy pointer */ }

        try {
            const exists = await this.vault.adapter.exists(this.paths.activeSessionMeta);
            if (!exists) return null;
            const raw = await this.vault.adapter.read(this.paths.activeSessionMeta);
            const data = JSON.parse(raw) as { path?: string } | null;
            if (data?.path) {
                const fileExists = await this.vault.adapter.exists(data.path);
                if (fileExists) {
                    this.activeSessionPath = data.path;
                    return data.path;
                }
            }
        } catch { /* corrupted or missing — start fresh */ }
        return null;
    }

    /**
     * List sessions/archive/*.md (Memory v3 archive folder).
     * Used by UI Sessions tab (split active/archive) and by save-session workflow.
     */
    async listArchiveSessions(): Promise<ArchiveSessionInfo[]> {
        await this.ensureMemoryStructure();
        const sessions: ArchiveSessionInfo[] = [];
        try {
            const listed = await this.vault.adapter.list(this.paths.sessionsArchive);
            const files = (listed?.files || []).filter(p => p.endsWith('.md'));
            for (const path of files) {
                try {
                    const stat = await this.vault.adapter.stat!(path);
                    const filename = path.split('/').pop() as string;
                    let created = '';
                    let agent = this.agentName;
                    let coveredByL1 = '';
                    let createdMs: number | null = null;
                    try {
                        const content = await this.vault.adapter.read(path);
                        const fm = this._parseFrontmatter(content);
                        created = (fm.created || '') as string;
                        agent = (fm.agent || this.agentName) as string;
                        // Pusty klucz YAML (`covered_by_l1:` bez wartości) parsuje się do `[]`,
                        // a `[] || ''` jest truthy — badge „✓ w L1" zapalałby się na pustce.
                        coveredByL1 = String(fm.covered_by_l1 ?? '').trim();
                        createdMs = this._sessionCreatedMs(fm);
                    } catch { /* unreadable — keep defaults */ }
                    sessions.push({
                        path,
                        name: filename,
                        agent,
                        created,
                        covered_by_l1: coveredByL1,
                        // mtime przestawia każda edycja pliku (np. stempel covered_by_l1
                        // przy konsolidacji L1), więc data sesji idzie z frontmattera,
                        // a mtime zostaje tylko jako fallback.
                        sessionTime: Number.isFinite(createdMs) ? createdMs as number : (stat?.mtime || 0),
                        mtime: stat?.mtime || 0,
                        size: stat?.size || 0,
                    });
                } catch (e) {
                    log.warn(`AgentMemory:${this.agentName}`, `Could not stat archive session ${path}:`, e);
                }
            }
            sessions.sort((a, b) => (b.sessionTime || 0) - (a.sessionTime || 0));
        } catch (e) {
            log.warn(`AgentMemory:${this.agentName}`, `Could not list archive sessions:`, e);
        }
        return sessions;
    }

    async listActiveSessions(): Promise<ActiveSessionInfo[]> {
        await this.ensureMemoryStructure();
        const state = await this.stateManager.read();
        const names = new Set<string>(state.active_sessions || []);

        try {
            const listed = await this.vault.adapter.list(this.paths.sessionsActive);
            const prefix = `${this.paths.sessionsActive}/`;
            for (const filePath of listed?.files || []) {
                if (!filePath.endsWith('.md')) continue;
                // Tylko bezpośrednie dzieci `active/`. Sesje odłożone przy draft/discard żyją
                // w podfolderze `.discarded/` i NIE są już aktywne. Adapter Obsidiana listuje
                // płasko (podfoldery lądują w `folders`), ale filtr trzyma kontrakt niezależnie
                // od implementacji adaptera.
                const rest = (filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath.split('/').pop()) as string;
                if (rest.includes('/')) continue;
                names.add(rest);
            }
        } catch { /* no active folder yet */ }

        const sessions: ActiveSessionInfo[] = [];
        for (const name of names) {
            const path = name.includes('/') ? name : `${this.paths.sessionsActive}/${name}`;
            try {
                if (!(await this.vault.adapter.exists(path))) continue;
                const content = await this.vault.adapter.read(path);
                const metadata = this._parseFrontmatter(content);
                const stat = await this.vault.adapter.stat!(path);
                const created = (metadata.created || this._createdFromActiveSessionName(name) || '') as string;
                const agent = (metadata.agent || this.agentName) as string;
                sessions.push({
                    path,
                    name: path.split('/').pop() as string,
                    agent,
                    created,
                    mtime: stat?.mtime || 0,
                    size: stat?.size || 0,
                    label: this._formatActiveSessionLabel(agent, created, path.split('/').pop() as string)
                });
            } catch (e) {
                log.warn(`AgentMemory:${this.agentName}`, `Could not list active session ${name}:`, e);
            }
        }

        sessions.sort((a, b) => {
            if ((b.mtime || 0) !== (a.mtime || 0)) return (b.mtime || 0) - (a.mtime || 0);
            return b.name.localeCompare(a.name);
        });
        return sessions;
    }

    async loadActiveSession(fileOrName: string | { path?: string } | null | undefined): Promise<ParsedActiveSession> {
        let path: string;
        if (typeof fileOrName === 'string') {
            path = fileOrName.includes('/') ? fileOrName : `${this.paths.sessionsActive}/${fileOrName}`;
        } else if (fileOrName?.path) {
            path = fileOrName.path;
        } else {
            throw new Error(`Invalid active session reference: ${JSON.stringify(fileOrName)}`);
        }

        const content = await this.vault.adapter.read(path);
        return this._parseActiveSessionFile(content);
    }

    /**
     * Persist activeSessionPath to disk (survives Obsidian restart).
     * @private
     */
    async _persistActiveSession(): Promise<void> {
        try {
            const payload = this.activeSessionPath
                ? JSON.stringify({ path: this.activeSessionPath, updated: Date.now() })
                : '{}';
            await this.vault.adapter.write(this.paths.activeSessionMeta, payload);
        } catch { /* best-effort */ }
    }

    /**
     * Memory v3 structure bootstrap. Idempotent and per-folder: partially migrated
     * agents get only the missing pieces created.
     */
    async ensureMemoryStructure(): Promise<void> {
        // To jest operacja STARTOWA (11× exists + list + 2× read), nie
        // per-zdarzeniowa. `appendToActiveSession` (przez `startActiveSession`) i cała reszta
        // wołaczy (`listArchiveSessions`, `listActiveSessions`, `saveSession`, `ListTool`,
        // `MemorySaveTool`, `MemoryDeleteTool`, `ReadTool`, `ArchiveWorkflow`, `MigrationV3`...)
        // wołają to bezwarunkowo na wejściu. Memoizacja per instancja jest bezpieczna: `basePath`
        // i `paths` są ustawiane RAZ w konstruktorze i nigdy się nie zmieniają pod tą samą
        // instancją (nowy agent = nowa instancja `AgentMemory`, nie zmiana ścieżek na żywca).
        if (this._structureEnsured) return;
        const folders = [
            this.basePath,
            this.paths.brainNotes,
            this.paths.brainArchive,
            this.paths.pendingRescue,
            this.paths.sessions,
            this.paths.sessionsActive,
            this.paths.sessionsArchive,
            `${this.basePath}/summaries`,
            this.paths.l1,
            this.paths.l2,
            this.paths.l3
        ];

        for (const folder of folders) {
            if (!(await this.vault.adapter.exists(folder))) {
                await this.vault.adapter.mkdir(folder);
            }
        }

        await this._migrateLegacyRootSessionsToArchive();
        // `getBrain` rzuca, gdy brain.md jest nie do odczytu. Bootstrap
        // struktury NIE może z tego powodu blokować zapisu sesji — rozmowa usera jest ważniejsza
        // niż indeks pamięci, a awaria i tak zamelduje się głośno przy budowie promptu.
        try {
            await this.getBrain();
        } catch (e) {
            log.warn(`AgentMemory:${this.agentName}`, `ensureMemoryStructure: brain.md nie do odczytu, idę dalej:`, e);
        }
        await this._ensureStateFile();
        // Dopiero na końcu — jeśli którykolwiek krok wyżej rzucił (np. `mkdir`), wywołanie
        // NIE jest oznaczone jako zrobione i następna próba zrobi pełny bootstrap od nowa.
        this._structureEnsured = true;
    }

    async _migrateLegacyRootSessionsToArchive(): Promise<void> {
        try {
            const listed = await this.vault.adapter.list(this.paths.sessions);
            const prefix = `${this.paths.sessions}/`;
            const rootSessionFiles = (listed?.files || [])
                .filter(path => path.endsWith('.md'))
                .filter(path => {
                    const relative = path.slice(prefix.length);
                    return relative && !relative.includes('/');
                });

            for (const path of rootSessionFiles) {
                const name = path.split('/').pop() as string;
                const target = `${this.paths.sessionsArchive}/${name}`;
                // Ten sam mechanizm co pętle sufiksów — „nie wiem" liczy się
                // jako ZAJĘTĄ, żeby kłamiący exists() nie kazał nam nadpisać realnej zarchiwizowanej
                // sesji treścią jej płaskiego, przedmigracyjnego odpowiednika.
                if ((await probeFile(this.vault.adapter, target)) !== 'missing') continue;
                const content = await this.vault.adapter.read(path);
                await this._writeSessionFile(target, content);
                if (this.vault.adapter.remove) {
                    await this.vault.adapter.remove(path);
                }
            }
        } catch (e) {
            log.warn(`AgentMemory:${this.agentName}`, `Could not migrate legacy root sessions to archive:`, e);
        }
    }

    /**
     * Initialize memory structure - create folders if needed
     */
    async initialize(): Promise<void> {
        await this.ensureMemoryStructure();

        // Migrate old weekly/ files to summaries/L1/ (one-time)
        await this._migrateOldFolders();
    }

    async _ensureStateFile(): Promise<void> {
        await this.stateManager.read();
    }

    async startActiveSession(agentName: string = this.agentName): Promise<string> {
        // „Ufam ścieżce"
        // znaczy „ta INSTANCJA ma CIEPŁY stan pisarza dla tej ścieżki" (`_sessionSeqCache`), NIE
        // „ścieżka jest niepusta". `this.activeSessionPath` bywa wskrzeszony Z ZEWNĄTRZ (patrz
        // komentarz przy deklaracji pola `activeSessionPath` wyżej — chat_tabs.ts/chat_session.ts
        // podstawiają go wprost przy przełączeniu zakładki i restore) długo po tym, jak
        // `archiveActiveSession` skasował plik i wyzerował wskaźnik U SIEBIE. Przełączenie
        // zakładki tam i z powrotem po archiwizacji podstawia z powrotem ścieżkę już nieżywej
        // sesji — bez tego sprawdzenia pierwszy append leciałby `read()`/`append()` na plik,
        // którego nie ma, i wywracał turę (tura padała, wiadomość usera ginęła — to był realny,
        // odtworzony scenariusz).
        if (this.activeSessionPath) {
            if (this._sessionSeqCache.has(this.activeSessionPath)) {
                // Ciepły cache = TA instancja dopisywała do tego pliku i wie, że żyje —
                // zero I/O.
                return this.activeSessionPath;
            }
            // Zimny cache (pierwsze użycie tej ścieżki przez TĘ instancję — może być świeżo
            // stworzona, może być wskrzeszona z zewnątrz) — jeden tani `probeFile` zamiast
            // zgadywania. Płaci się raz na ścieżkę, nie na każde zdarzenie.
            if ((await probeFile(this.vault.adapter, this.activeSessionPath)) !== 'missing') {
                return this.activeSessionPath;
            }
            // Potwierdzone „nie ma" — wskaźnik jest martwy. Main w tej sytuacji zakłada nową
            // sesję zamiast wywrócić turę; robimy to samo (gałąź tworzenia niżej).
            this._forgetSessionWriterState(this.activeSessionPath);
            this.activeSessionPath = null;
        }

        await this.ensureMemoryStructure();

        const filename = this._generateActiveSessionFilename(agentName);
        // „Nie wiem, czy ta nazwa jest wolna" traktujemy jak ZAJĘTĄ.
        // `_writeSessionFile` nadpisuje bez pytania, a po drugiej stronie może leżeć żywa
        // rozmowa: nazwa ma rozdzielczość minutową, więc świeża instancja (restart Obsidiana,
        // `activeSessionPath` jeszcze puste) generuje DOKŁADNIE tę samą — po to jest ta pętla.
        // Wspólna z pięcioma siostrzanymi wywołaniami w tym pliku (`collisionSuffix.ts`).
        const { path } = await findFreeCollisionPath(
            this.vault.adapter,
            this.paths.sessionsActive,
            filename,
            'startActiveSession: brak wolnej nazwy pliku sesji',
        );

        const created = new Date().toISOString();
        await this._writeSessionFile(path, this._activeSessionHeader(agentName, created));
        this.activeSessionPath = path;
        await this.stateManager.addActiveSession(path.split('/').pop() as string);
        await this._persistActiveSession();
        return path;
    }

    /**
     * Frontmatter + nagłówek NOWEJ (pustej, zero zdarzeń) sesji aktywnej. WSPÓLNY z gałęzią
     * samo-naprawy w `appendToActiveSession` — plik odtworzony po zewnętrznym
     * skasowaniu dostaje TĘ SAMĄ postać co świeży, więc `archiveActiveSession`/restore go
     * rozpoznają tak samo, zamiast dostać goły blok zdarzenia bez `type: active_session`.
     */
    _activeSessionHeader(agentName: string, created: string): string {
        return `---
type: active_session
agent: ${agentName}
created: ${created}
---

# ${agentName} session ${created}

`;
    }

    /**
     * JEDYNY pisarz plików sesji. Każdy bajt idący na dysk przechodzi
     * przez `maskSensitiveData`.
     *
     * DLACZEGO: transkrypt potrafi nieść sekret wpleciony w treść błędu (padnięty strumień
     * wypisuje nagłówki żądania). Sesje są pamięcią agentów wożoną między urządzeniami (żyją
     * w gicie) — więc ryzyko zdejmujemy u ŹRÓDŁA, przy zapisie.
     *
     * Maskujemy WYŁĄCZNIE string idący na dysk. Obiekty wiadomości w pamięci zostają
     * nietknięte: model w tej samej turze ma dalej widzieć to, co naprawdę wróciło
     * z narzędzia, inaczej maska zmieniłaby przebieg rozmowy, a nie tylko jej zapis.
     *
     * ⚠️ Ta metoda obsługuje `sessions/active`, `sessions/archive` i `.discarded/`.
     * Pliki `brain*`, `summaries/L*` i `.state.json` mają własnych pisarzy i tu NIE wchodzą.
     * @private
     */
    async _writeSessionFile(path: string, content: string): Promise<void> {
        await this.vault.adapter.write(path, maskSensitiveData(content));
    }

    /**
     * Dopisz FRAGMENT do pliku aktywnej sesji bez czytania/przepisywania reszty.
     * Wołany WYŁĄCZNIE przez `appendToActiveSession` — ten sam kontrakt maskowania co
     * `_writeSessionFile`, tylko na nowy kawałek zamiast na cały plik. Bezpieczne: maski
     * `maskSensitiveData` działają w granicach linii/tokenu WEWNĄTRZ jednego, kompletnego bloku
     * zdarzenia (`formatSessionEvent`) — nigdy w poprzek dwóch osobnych zapisów.
     *
     * Adapter Obsidiana ma natywny `append` na `DataAdapter` (ten sam, którego już używa
     * `core/utils/LogFileSink.ts:268-269`). Atrapa/adapter bez tej metody dostaje fallback —
     * ale przez `readIfExists`, NIE goły `exists()`+`read()` jak w `LogFileSink`:
     * dyski sieciowe potrafią zwrócić nieaktualny stan z `exists()`, więc fallback append nie
     * ma prawa cofnąć tej ochrony.
     *
     * Jeśli natywny `append` SAM rzuci (nie każda implementacja
     * cicho zakłada plik od nowa jak `fs` z flagą `a` — część wymaga istniejącego pliku), błąd
     * jest odróżniany przez `probeFile`: potwierdzone `'missing'` → `SessionFileMissingError`
     * (ten sam sygnał co fallback niżej — wołacz odtwarza sesję), cokolwiek innego (uprawnienia,
     * pełny dysk) → oryginalny błąd leci dalej NIEZMIENIONY. Gdy adapter po cichu tworzy plik od
     * nowa (bez rzutu), tego się tu nie wykryje — łapie to periodyczny `exists()` w
     * `appendToActiveSession` (`APPEND_VERIFY_EVERY_N`), z tym samym ograniczeniem okna, jakie
     * ta stała opisuje.
     * @private
     */
    async _appendSessionFile(path: string, chunk: string): Promise<void> {
        const masked = maskSensitiveData(chunk);
        if (typeof this.vault.adapter.append === 'function') {
            try {
                await this.vault.adapter.append(path, masked);
            } catch (e) {
                if ((await probeFile(this.vault.adapter, path)) === 'missing') {
                    throw new SessionFileMissingError(
                        `_appendSessionFile: adapter.append rzucił, a pliku faktycznie nie ma: ${path}`
                    );
                }
                throw e;
            }
            return;
        }
        const probe = await readIfExists(this.vault.adapter, path);
        if (probe.state === 'missing') {
            // Adapter BEZ natywnego append i plik naprawdę nie
            // istnieje (zewnętrzne skasowanie między zdarzeniami, ciepły cache). Rzucamy sygnał
            // ROZPOZNAWALNY (nie goły `Error`) — `appendToActiveSession` łapie GO i odtwarza
            // sesję z frontmatterem zamiast cicho zapisać sam fragment bez nagłówka.
            throw new SessionFileMissingError(`_appendSessionFile: plik nie istnieje: ${path}`);
        }
        if (probe.state === 'unreadable') {
            throw new Error(
                `_appendSessionFile: adapter bez append() i nie mogę odczytać istniejącego pliku — nie nadpisuję: ${path} (${causeText(probe.cause)})`
            );
        }
        await this.vault.adapter.write(path, probe.content + masked);
    }

    /**
     * Serialize a read-modify-write against a single file path.
     * Each call for a given path runs only after the previous one settles, so
     * concurrent writers never clobber each other's edits. The map entry is
     * cleared once the last queued task for a path finishes, so the map does not
     * grow unbounded. Failures are isolated: one throwing task does not poison the
     * chain, and the caller still receives the real error.
     * @param path
     * @param fn - the read-modify-write to run under the lock
     * @returns resolves/rejects with fn's own result
     */
    _enqueuePathWrite<T>(path: string, fn: () => Promise<T>): Promise<T> {
        const prev = this._writeQueues.get(path) || Promise.resolve();
        const run = prev.then(() => fn(), () => fn());
        // Tail never rejects, so the next writer in line always proceeds.
        const tail = run.then(() => {}, () => {});
        this._writeQueues.set(path, tail);
        void tail.then(() => {
            if (this._writeQueues.get(path) === tail) {
                this._writeQueues.delete(path);
            }
        });
        return run;
    }

    /**
     * Dopisz jedno zdarzenie do pliku aktywnej sesji (JEDYNY pisarz tego pliku).
     *
     * Numer `seq` nadawany jest WEWNĄTRZ kolejki per-ścieżka, na podstawie treści, którą
     * właśnie odczytaliśmy — inaczej dwa równoległe appendy (sub-agenci przez `Promise.all`)
     * dostałyby ten sam numer.
     *
     * Brak pliku pod `path` (stały wskaźnik wskrzeszony z
     * zewnątrz — patrz komentarz przy `startActiveSession` — albo zewnętrzne skasowanie MIĘDZY
     * zdarzeniami) NIE MA PRAWA wywrócić tury. Zamiast rzucać dalej, metoda zapomina stan
     * pisarza dla martwej ścieżki i zaczyna sesję OD NOWA (jak main), z bounded retry (jeden
     * dodatkowy strzał — żeby trwale zepsuty adapter, pełny dysk czy brak uprawnień, i tak
     * doszedł do wołacza jako błąd, zamiast wisieć w nieskończonej pętli).
     *
     * ⚠️ Retry jest PĘTLĄ LOKALNĄ pod TYM SAMYM `_enqueuePathWrite`, NIE rekurencją przez
     * `appendToActiveSession` (samego siebie). Rekurencja wracałaby przez `_enqueuePathWrite`
     * DLA TEJ SAMEJ ścieżki, gdy odtworzona sesja dostanie IDENTYCZNĄ nazwę — a to normalne
     * przy rozdzielczości minutowej `_generateActiveSessionFilename`, nie egzotyczny przypadek:
     * ścieżka staje się wolna zaraz po tym, jak ją tu porzucamy. Rekurencyjne wejście czekałoby
     * na `tail` kolejki TEJ SAMEJ ścieżki, którego rozwiązanie zależy od zakończenia WŁAŚNIE
     * WYKONYWANEGO callbacka — samo-zakleszczenie (złapane testem podczas pisania tej naprawy).
     *
     * @param event - `{type, content|result|prompt, tool, args, ...}`
     * @returns ścieżka pliku (kształt zwrotki bez zmian)
     */
    async appendToActiveSession(event: ActiveSessionEventInput = {}): Promise<string> {
        let path = await this.startActiveSession(event.agentName || this.agentName);
        const timestamp: string = event.timestamp || new Date().toISOString();
        const type = event.type || 'event';
        return this._enqueuePathWrite(path, async () => {
            let attemptsLeft = 1;
            for (;;) {
                // Pełny odczyt + pełny zapis na KAŻDE zdarzenie robił zapis
                // kwadratowym względem długości sesji (200 zdarzeń = 110 MB zapisu na plik
                // 1,1 MB). Odczyt CAŁOŚCI jest potrzebny WYŁĄCZNIE, żeby zainicjować cache
                // numeracji (`_sessionSeqCache`, `_nextSeq`) i stan „czy plik kończy się nowym
                // wierszem" — raz na ścieżkę (pierwsze zdarzenie sesji, albo pierwsze po
                // restarcie Obsidiana, gdy cache jest zimny). Każdy kolejny append dokleja
                // TYLKO nowy blok.
                let endsWithNewline = this._sessionEndsWithNewline.get(path);
                let existingForSeq = '';
                const cacheWasCold = !this._sessionSeqCache.has(path) || endsWithNewline === undefined;
                let pathIsDead = false;

                if (cacheWasCold) {
                    // `readIfExists`, NIE goły `read()` — brak pliku jest
                    // sygnałem „ścieżka martwa, zacznij od nowa", nie błędem, który ma wywrócić turę.
                    const probe = await readIfExists(this.vault.adapter, path);
                    if (probe.state === 'missing') {
                        pathIsDead = true;
                    } else if (probe.state === 'unreadable') {
                        throw new Error(
                            `appendToActiveSession: nie mogę odczytać pliku sesji — nie nadpisuję: ${path} (${causeText(probe.cause)})`
                        );
                    } else {
                        existingForSeq = probe.content;
                        endsWithNewline = existingForSeq.endsWith('\n');
                    }
                } else {
                    // Ciepły cache ufa, że plik żyje, bez czytania go na każde
                    // zdarzenie — ale natywny `adapter.append` na brakującym pliku zwykle NIE
                    // rzuca (po prostu go zakłada od nowa, jak `fs` z flagą `a`), więc zewnętrzne
                    // skasowanie sesji MIĘDZY zdarzeniami byłoby inaczej niewidoczne. Co
                    // `APPEND_VERIFY_EVERY_N` zdarzeń płacimy JEDEN tani `exists()` (metadane,
                    // bez odczytu treści — O(1) względem rozmiaru pliku, nie O(n) jak `read()`).
                    const seen = (this._appendsSinceVerify.get(path) || 0) + 1;
                    if (seen >= APPEND_VERIFY_EVERY_N) {
                        this._appendsSinceVerify.set(path, 0);
                        if (!(await this.vault.adapter.exists(path))) pathIsDead = true;
                    } else {
                        this._appendsSinceVerify.set(path, seen);
                    }
                }

                if (!pathIsDead) {
                    const seq = this._nextSeq(path, existingForSeq);
                    const body = formatSessionEvent(type, { ...event, seq }, timestamp);
                    try {
                        await this._appendSessionFile(path, endsWithNewline ? body : `\n${body}`);
                        // `formatSessionEvent` KOŃCZY SIĘ `\n` (kontrakt funkcji) — po tym
                        // zapisie plik zawsze kończy się nowym wierszem, więc kolejny append
                        // tego już nie sprawdza.
                        this._sessionEndsWithNewline.set(path, true);
                        return path;
                    } catch (e) {
                        // Fallback bez natywnego `append` (`_appendSessionFile`)
                        // rzuca `SessionFileMissingError`, gdy plik naprawdę zniknął — ten sam
                        // sygnał „martwa ścieżka" co wyżej, nie błąd do przerwania tury.
                        if (!(e instanceof SessionFileMissingError)) throw e;
                        pathIsDead = true;
                    }
                }

                // Ścieżka martwa: zapomnij stan pisarza, zwolnij wskaźnik jeśli to WCIĄŻ on
                // (mógł już wskazywać gdzie indziej, jeśli coś innego zdążyło go przestawić),
                // i spróbuj OD NOWA — `startActiveSession` z wyzerowanym `activeSessionPath`
                // zawsze idzie gałęzią tworzenia (bezpieczne, bez rekurencji do tej metody).
                this._forgetSessionWriterState(path);
                if (this.activeSessionPath === path) this.activeSessionPath = null;
                if (attemptsLeft <= 0) {
                    throw new Error(
                        `appendToActiveSession: plik sesji zniknął, a odtworzenie też nie pomogło: ${path}`
                    );
                }
                attemptsLeft--;
                path = await this.startActiveSession(event.agentName || this.agentName);
            }
        });
    }

    /**
     * Następny numer zdarzenia dla ścieżki. Cache-miss (pierwszy zapis / po restarcie)
     * inicjalizuje licznik skanem podanej treści pliku.
     * ⚠️ Wołać tylko WEWNĄTRZ `_enqueuePathWrite` — inaczej numery się zdublują.
     */
    _nextSeq(path: string, existingContent: string): number {
        let last = this._sessionSeqCache.get(path);
        if (typeof last !== 'number') last = maxSeq(existingContent);
        const next = last + 1;
        this._sessionSeqCache.set(path, next);
        return next;
    }

    /** Zapomnij stan numeracji/pokrycia dla ścieżki (sesja zeszła z active). */
    _forgetSessionWriterState(path: string): void {
        this._sessionSeqCache.delete(path);
        this._sessionSavedCounts.delete(path);
        this._sessionEndsWithNewline.delete(path);
        this._appendsSinceVerify.delete(path);
    }

    /**
     * Dopisz JEDNĄ wiadomość okna czatu do treści pliku jako blok event-logu.
     * Czysta składanka stringów — bez I/O, bez kolejki (woła ją `saveSession` pod lockiem).
     * @param content - dotychczasowa treść pliku
     * @param path - ścieżka (klucz numeracji)
     * @returns treść z doklejonym blokiem
     */
    _appendMessageAsEvent(content: string, path: string, msg: ChatMessageLike, timestamp: string): string {
        const rawRole = typeof msg?.role === 'string' ? msg.role.toLowerCase() : '';
        // Nieznana rola → `system`, dokładnie jak w `formatToMarkdown`: API odrzuca
        // nieznane role, a wiadomość nie ma prawa zginąć.
        const role = (KNOWN_ROLES.has(rawRole) ? rawRole : 'system') as SessionRole;
        const text = Array.isArray(msg?.content)
            ? (msg.content as Array<{ text?: string; content?: string }>).map(c => c?.text || c?.content || '').filter(Boolean).join('\n')
            : String(msg?.content ?? '');
        const event: { content: string; seq: number; role?: string } = { content: text, seq: this._nextSeq(path, content) };
        if (role === 'system') event.role = 'system';
        const block = formatSessionEvent(ROLE_TO_EVENT_TYPE[role], event, timestamp);
        return content.endsWith('\n') ? content + block : `${content}\n${block}`;
    }

    /**
     * Przenieś aktywną sesję do `sessions/archive/`, KONWERTUJĄC event-log na transkrypt.
     *
     * Plik active jest event-logiem (append-only, z telemetrią narzędzi), a
     * archiwum trzyma widok pochodny — transkrypt `## User`/`## Assistant` (format B), ten
     * sam co dotąd. Dzięki temu konsolidacja L1/L2/L3, `parseSessionFile` i `loadSession`
     * pozostają nietknięte.
     *
     * Plik, z którego czytnik nie wyciągnął ANI JEDNEJ wiadomości (pusty, sam frontmatter,
     * nieznany kształt), kopiujemy surowo 1:1 — nie tracimy bajtów, których nie rozumiemy.
     */
    async archiveActiveSession(path: string | null = this.activeSessionPath): Promise<string | null> {
        if (!path) return null;
        const filename = path.split('/').pop() as string;
        const archivePath = `${this.paths.sessionsArchive}/${filename}`;
        const now = new Date().toISOString();
        // Serialize against any pending appends to the same active session file so a
        // late append cannot resurrect a half-removed file (or be lost after copy).
        await this._enqueuePathWrite(path, async () => {
            const content = await this.vault.adapter.read(path);
            const parsed = parseActiveSession(content);
            let output = content;
            if (parsed.messages.length > 0) {
                // Frontmatter przenosimy 1:1 (agent/created/type/sessionType/...), pomijając
                // wartości nie-skalarne: `formatToMarkdown` serializuje przez `${value}`, więc
                // tablica rozjechałaby YAML.
                const meta: TranscriptMetadata = {};
                for (const [key, value] of Object.entries(parsed.metadata || {})) {
                    if (value === null || typeof value === 'object') continue;
                    meta[key] = value;
                }
                meta.updated = now;
                meta.messageCount = parsed.messages.length;
                // `seq` z wiadomości nie idzie do transkryptu — `formatToMarkdown` czyta
                // wyłącznie `role` + `content`.
                output = formatToMarkdown(parsed.messages, meta, parsed.summary);
            }
            await this._writeSessionFile(archivePath, output);
            // Kasacja ŹRÓDŁA nie ma prawa wyprzedzać
            // POTWIERDZONEGO zapisu archiwum. `write()` adaptera potrafi zameldować sukces,
            // mimo że bajty faktycznie nie doszły na dysk (torn write — ten sam typ awarii
            // co w `writePendingRescue` niżej, dyski sieciowe / Dysk Google) — bez
            // tej weryfikacji jedna taka awaria kasowała jedyną kopię rozmowy i zostawiała
            // pusty/okrojony plik archiwum. Porównanie idzie PO `maskSensitiveData` (tej samej
            // funkcji, którą `_writeSessionFile` stosuje przed zapisem), bo maskowanie sekretów
            // zmienia bajty lądujące na dysku.
            const expected = maskSensitiveData(output);
            const verify = await readIfExists(this.vault.adapter, archivePath);
            if (verify.state !== 'content' || verify.content !== expected) {
                throw new Error(
                    `archiveActiveSession: zapis archiwum nie zweryfikował się odczytem — nie kasuję źródła: ${archivePath}` +
                    (verify.state === 'unreadable' ? ` (${causeText(verify.cause)})` : '')
                );
            }
            if (this.vault.adapter.remove) await this.vault.adapter.remove(path);
        });
        this._forgetSessionWriterState(path);
        await this.stateManager.markArchived(filename);
        if (this.activeSessionPath === path) {
            this.activeSessionPath = null;
            await this._persistActiveSession();
        }
        return archivePath;
    }

    /**
     * Odłóż aktywną sesję do `sessions/active/.discarded/` i wypisz ją z `.state.json`.
     *
     * Używane przez gałąź „odrzuć" przy starcie nowej rozmowy (modules/chat): user świadomie
     * porzucił rozmowę, więc nie ma czego trzymać w ewidencji żywych sesji — inaczej zostaje
     * zombie-wpis wiszący do najbliższego restore.
     *
     * NIE kasuje twardo (filozofia Memory v3: user authority — pliki się nie niszczą). Plik ląduje
     * w podfolderze, którego `listActiveSessions` nie widzi; kolizja nazwy → suffix `_2`, `_3`...
     * W przeciwieństwie do `archiveActiveSession` NIE podbija licznika konsolidacji — odłożona sesja
     * nie jest materiałem na L1.
     *
     * @param path - domyślnie bieżąca aktywna sesja
     * @returns ścieżka w `.discarded/` albo null, gdy nie było czego odkładać
     */
    async discardActiveSession(path: string | null = this.activeSessionPath): Promise<string | null> {
        if (!path) return null;
        const filename = path.split('/').pop() as string;
        const prefix = `${this.paths.sessionsActive}/`;
        const clearPointer = async () => {
            if (this.activeSessionPath === path) {
                this.activeSessionPath = null;
                await this._persistActiveSession();
            }
        };

        // Plik spoza `sessions/active/` (legacy flat `sessions/`) tylko wypisujemy z ewidencji —
        // nie przenosimy go w miejsce, którego nikt się tam nie spodziewa.
        if (!path.startsWith(prefix)) {
            this._forgetSessionWriterState(path);
            await this.stateManager.removeActiveSession(filename);
            await clearPointer();
            return null;
        }

        const discardedDir = `${prefix}.discarded`;
        let target: string | null = null;
        try {
            // Serialize against pending appends — jak w archiveActiveSession.
            await this._enqueuePathWrite(path, async () => {
                if (!(await this.vault.adapter.exists(path))) return;
                try {
                    if (!(await this.vault.adapter.exists(discardedDir))) {
                        await this.vault.adapter.mkdir(discardedDir);
                    }
                } catch { /* mkdir might race — ignore */ }

                // Jak w startActiveSession — „nie wiem, czy ta nazwa jest wolna"
                // liczymy jako ZAJĘTĄ, żeby kłamiący exists() nie pozwolił wejść w cudzy odłożony plik.
                // Wspólna pętla z pięcioma siostrzanymi wywołaniami (`collisionSuffix.ts`).
                target = (await findFreeCollisionPath(
                    this.vault.adapter,
                    discardedDir,
                    filename,
                    'discardActiveSession: brak wolnej nazwy pliku',
                )).path;

                const content = await this.vault.adapter.read(path);
                await this._writeSessionFile(target, content);
                if (this.vault.adapter.remove) await this.vault.adapter.remove(path);
            });
        } catch (e) {
            log.warn(`AgentMemory:${this.agentName}`, `Could not discard active session ${filename}:`, e);
            return null;
        }

        this._forgetSessionWriterState(path);
        await this.stateManager.removeActiveSession(filename);
        await clearPointer();
        return target;
    }

    /**
     * One-time migration: move files from old weekly/ to summaries/L1/
     */
    async _migrateOldFolders(): Promise<void> {
        const oldWeekly = `${this.basePath}/weekly`;
        try {
            if (!(await this.vault.adapter.exists(oldWeekly))) return;

            const listed = await this.vault.adapter.list(oldWeekly);
            if (!listed?.files || listed.files.length === 0) return;

            for (const filePath of listed.files) {
                const fileName = filePath.split('/').pop() as string;
                const newPath = `${this.paths.l1}/${fileName}`;
                const content = await this.vault.adapter.read(filePath);
                await this.vault.adapter.write(newPath, content);
                await this.vault.adapter.remove!(filePath);
            }
        } catch (e) {
            log.warn(`AgentMemory:${this.agentName}`, `Migration failed (non-fatal):`, e);
        }
    }

    /**
     * Zapisz stan rozmowy do pliku sesji — DOPISUJĄC to, czego w pliku brakuje.
     *
     * ⚠️ **Ta metoda NIE NADPISUJE pliku transkryptem.** Do tej pory autozapis
     * (co N minut, po bezczynności, 💾, zamknięcie zakładki) pisał cały plik od nowa z
     * `rollingWindow.messages` — ścinał telemetrię narzędzi dopisaną przez
     * `appendToActiveSession`, a po kompresji okna czatu (która ZMNIEJSZA `messages`) niszczył
     * pełną historię rozmowy. Teraz plik jest append-only event-logiem, a autozapis jest tylko
     * SIATKĄ BEZPIECZEŃSTWA: dopisuje ogon `messages`, którego czytnik w pliku nie widzi.
     *
     * Reguły:
     *  - `messages.length <= K` (K = wiadomości widziane w pliku) → treści NIE ruszamy w ogóle;
     *    plik jest nadzbiorem okna i ma nim zostać,
     *  - ogon dopisujemy jako EVENTY (format A), nie transkrypt, i logujemy `warn` — niepusty
     *    ogon znaczy, że pisarz zdarzeń coś przegapił, a to ma być widoczne,
     *  - frontmatter: ruszamy WYŁĄCZNIE `updated` i `messageCount` (`_setFrontmatterField`,
     *    CRLF/BOM-safe). `created` to data POWSTANIA sesji i zostaje nietknięta.
     *
     * Cały read-modify-write idzie przez kolejkę per-ścieżka — ten sam plik dopisuje
     * równolegle `appendToActiveSession`.
     *
     * @param messages - Conversation messages
     * @param metadata - Session metadata
     * @returns Path to saved session
     */
    async saveSession(messages: ChatMessageLike[] | null | undefined, metadata: TranscriptMetadata = {}): Promise<string> {
        const list: ChatMessageLike[] = Array.isArray(messages) ? messages : [];
        // Reuse existing session file if already saved (prevents duplicates)
        let path: string;
        const isNewFile = !this.activeSessionPath;
        if (this.activeSessionPath) {
            path = this.activeSessionPath;
        } else {
            // Ta gałąź NIE zakłada plik wprost pod `paths.sessions` (płaski, legacy folder) —
            // `_migrateLegacyRootSessionsToArchive` (wołany bezwarunkowo z `ensureMemoryStructure`,
            // m.in. przez `listArchiveSessions`) traktuje KAŻDY `.md` leżący tam jako relikt do
            // przeniesienia i natychmiast kasuje oryginał, więc żywa, dopiero co rozpoczęta
            // rozmowa lądowałaby w `sessions/archive/` jako sesja ZAMKNIĘTA (materiał na L1)
            // zanim zdążyłaby urosnąć. Kontrakt v3: nowy plik aktywnej
            // sesji ląduje w `sessions/active/`, z tym samym odkolizjonowaniem nazwy co
            // `startActiveSession()`. Nie wołamy tu wprost
            // `startActiveSession()`, żeby nie stracić budowy frontmattera z `metadata`
            // (`created` wołacza, ewentualny `sessionType`) niżej w tej samej metodzie —
            // rezerwujemy tylko ścieżkę i miejsce w `.state.json`, zapis robi kod poniżej,
            // dokładnie jak dotąd dla „nowego pliku".
            await this.ensureMemoryStructure();
            const filename = this._generateActiveSessionFilename();
            // Wspólna pętla z pięcioma siostrzanymi wywołaniami (`collisionSuffix.ts`).
            path = (await findFreeCollisionPath(
                this.vault.adapter,
                this.paths.sessionsActive,
                filename,
                'saveSession: brak wolnej nazwy pliku sesji',
            )).path;
            this.activeSessionPath = path;
        }

        const now = new Date().toISOString();
        await this._enqueuePathWrite(path, async () => {
            // Self-append (siostrzana wada „wolnej nazwy" z probeFile): stary wzorzec
            // `if (await exists()) { read() }` na dyskach sieciowych potrafi dostać `exists()===false`
            // dla PLIKU, KTÓRY JEST — kod nigdy nie próbuje `read()` i traktuje aktywną sesję
            // jako świeżą, więc zapis NADPISUJE całą rozmowę jednym nowym wpisem.
            // `readIfExists` czyta NAJPIERW, więc `exists()` nie ma szans skłamać.
            const probe = await readIfExists(this.vault.adapter, path);
            if (probe.state === 'unreadable') {
                // Sprzeczne sygnały na WŁASNYM pliku sesji — nadpisanie skasowałoby rozmowę,
                // której nie widzimy. Wołający ma dostać błąd zamiast cichej utraty transkryptu:
                // `handleSaveSession` (modules/chat) łapie ten throw, loguje, pokazuje „Save
                // failed" i NIE czyści okno rozmowy — wiadomości zostają do następnej próby.
                throw new Error(`saveSession: nie mogę odczytać istniejącego pliku sesji — nie nadpisuję: ${path} (${causeText(probe.cause)})`);
            }
            const existing = probe.state === 'content' ? probe.content : '';

            const known = parseActiveSession(existing).messages.length;
            // Baza ogona: większa z „ile widać w pliku" i „ile już dopisaliśmy w tym biegu"
            // (patrz `_sessionSavedCounts` w konstruktorze — chroni przed dublowaniem).
            const base = Math.max(known, this._sessionSavedCounts.get(path) || 0);
            const tail = list.length > base ? list.slice(base) : [];

            let content = existing;
            if (!existing) {
                // Nowy plik: frontmatter + nagłówek jak w `startActiveSession`, a wiadomości
                // od razu jako EVENTY.
                const created = (metadata.created || now) as string;
                const header = formatToMarkdown([], {
                    // sessionType ∈ { 'active' | 'archived' }.
                    // 'active' = sesja w pracy (default), 'archived' = zamknięta przez modal.
                    sessionType: 'active',
                    ...metadata,
                    agent: this.agentName,
                    // `metadata.created` po `...metadata` przepadało — data POWSTANIA sesji
                    // podana przez wołacza musi wygrać z „teraz".
                    created,
                    updated: now,
                    messageCount: tail.length,
                });
                content = `${header}\n\n# ${this.agentName} session ${created}\n\n`;
            }

            for (const msg of tail) {
                content = this._appendMessageAsEvent(content, path, msg, now);
            }
            if (tail.length > 0) {
                this._sessionSavedCounts.set(path, base + tail.length);
                log.warn(
                    `AgentMemory:${this.agentName}`,
                    `saveSession dopisał ${tail.length} wiadomość(ci) spoza event-logu (pisarz zdarzeń je przegapił): ${path}`
                );
            }

            content = this._setFrontmatterField(content, 'updated', now);
            // `messageCount` = ile wiadomości widzi czytnik W PLIKU (K + ogon), nie ile
            // pozycji listy pokryliśmy (`base` może być wyżej po niewidocznych blokach).
            content = this._setFrontmatterField(content, 'messageCount', known + tail.length);
            if (content !== existing) await this._writeSessionFile(path, content);
        });

        // Persist active session path so it survives Obsidian restart.
        // Rejestracja w `.state.json` idzie tu, PO udanym zapisie w kolejce wyżej — ten sam
        // krok, który `startActiveSession()` robi zaraz po swoim zapisie.
        if (isNewFile) {
            await this.stateManager.addActiveSession(path.split('/').pop() as string);
            await this._persistActiveSession();
        }

        return path;
    }

    /**
     * Reset active session tracker (call ONLY when user explicitly starts new chat).
     */
    async startNewSession(): Promise<void> {
        this.activeSessionPath = null;
        await this._persistActiveSession();
    }

    // Sesje „ulotne" (draft, `.draft/`) nie są obsługiwane. Pliki draftów leżące u userów
    // na dysku ZOSTAJĄ nietknięte (dane usera); po prostu nie powstają nowe. Odzyskiwanie
    // sesji stoi na `sessions/active` + `.state.json`.

    /**
     * Load a session from this agent's memory
     * @param fileOrName - Filename string, full path, or {path, name} object
     * @returns { messages, metadata, summary }
     */
    async loadSession(fileOrName: string | { path?: string } | null | undefined): Promise<ParsedSessionFile> {
        let path: string;
        if (typeof fileOrName === 'string') {
            // If it looks like a full path (contains /), use it directly; otherwise prepend sessions dir
            path = fileOrName.includes('/') ? fileOrName : `${this.paths.sessions}/${fileOrName}`;
        } else if (fileOrName && fileOrName.path) {
            path = fileOrName.path;
        } else {
            throw new Error(`Invalid session reference: ${JSON.stringify(fileOrName)}`);
        }
        const content = await this.vault.adapter.read(path);
        return parseSessionFile(content);
    }

    /**
     * List all sessions for this agent
     * @returns Array of { path, name, mtime }
     */
    async listSessions(): Promise<Array<{ path: string; name: string; mtime: number }>> {
        try {
            const listed = await this.vault.adapter.list(this.paths.sessions);
            if (!listed?.files) return [];

            const sessions: Array<{ path: string; name: string; mtime: number }> = [];
            for (const filePath of listed.files) {
                if (filePath.endsWith('.md')) {
                    const stat = await this.vault.adapter.stat!(filePath);
                    if (stat) {
                        sessions.push({
                            path: filePath,
                            name: filePath.split('/').pop() as string,
                            mtime: stat.mtime as number
                        });
                    }
                }
            }

            // Sort by filename descending (newest first) — filenames are YYYY-MM-DD_HH-MM-SS.md
            // mtime is unreliable for externally-created or batch-imported sessions
            sessions.sort((a, b) => b.name.localeCompare(a.name));
            return sessions;
        } catch (error) {
            log.error(`AgentMemory:${this.agentName}`, `Error listing sessions:`, error);
            return [];
        }
    }

    // Pamięć średnioterminowa żyje dziś jako sekcje „Na teraz" w brain.md.
    // Plików active_context.md na dysku NIE kasujemy (martwe dane usera zostają).

    /**
     * Get or create the agent's brain index. In Memory v3 the durable facts live in
     * brain/*.md; brain.md is a categorized table of contents plus the short current dashboard.
     * @returns Brain index content
     */
    async getBrain(): Promise<string> {
        // TRZY stany, nie dwa. Świeży, pusty indeks wolno założyć
        // wyłącznie na POTWIERDZONYM „nie ma" — gołe `exists() === false` kłamie na dyskach
        // sieciowych, co kasowałoby pamięć agenta bez kopii `.bak`.
        if (await probeFile(this.vault.adapter, this.paths.brain) === 'missing') {
            const initialContent = buildBrainIndex({
                agentName: this.agentName,
                header: `# ${t('memory.brain_header', { name: this.agentName })}`,
                notes: []
            });
            await this.vault.adapter.write(this.paths.brain, initialContent);
            return initialContent;
        }

        // `exists` albo `unknown` — plik MOŻE nieść pamięć usera, więc musimy ją zobaczyć.
        // Odczyt, który padł, jest BŁĘDEM, nie pustką: pusty string kazał modelowi wierzyć,
        // że agent nie ma pamięci, i „naprawiać" to zapisem faktów, które już są w brain/.
        let content: string;
        try {
            content = await this.vault.adapter.read(this.paths.brain);
        } catch (error) {
            log.error(`AgentMemory:${this.agentName}`, `Error getting brain (nie zakładam pliku od nowa):`, error);
            throw error;
        }

        // Gracefully add any missing index sections without overwriting existing content.
        let changed = false;
        for (const section of INDEX_SECTIONS) {
            if (!content.includes(section)) {
                content += `\n${section}\n\n`;
                changed = true;
            }
        }
        if (changed) {
            // Dosztukowanie sekcji to wygoda, nie warunek zwrotki — treść już mamy w ręku.
            try {
                await this.vault.adapter.write(this.paths.brain, content);
            } catch (error) {
                log.warn(`AgentMemory:${this.agentName}`, `Could not add missing index sections to brain.md:`, error);
            }
        }
        return content;
    }

    /**
     * List active Memory v3 brain/ notes with their relevance metadata.
     * Archived notes under brain/archive/ are intentionally excluded from the default index.
     */
    async listBrainNotes(): Promise<BrainNoteInfo[]> {
        try {
            if (!(await this.vault.adapter.exists(this.paths.brainNotes))) {
                await this.vault.adapter.mkdir(this.paths.brainNotes);
            }

            const listed = await this.vault.adapter.list(this.paths.brainNotes);
            const prefix = `${this.paths.brainNotes}/`;
            const files = (listed?.files || [])
                .filter(path => path.endsWith('.md'))
                .filter(path => {
                    const relative = path.startsWith(prefix) ? path.slice(prefix.length) : path;
                    return relative && !relative.includes('/');
                });
            const notes: BrainNoteInfo[] = [];

            for (const path of files) {
                try {
                    const content = await this.vault.adapter.read(path);
                    const fm = this._parseFrontmatter(content);
                    const filename = path.split('/').pop() as string;
                    const stat = await this.vault.adapter.stat?.(path);
                    if (String(fm.status || '').toLowerCase() === 'archived') continue;
                    notes.push({
                        path,
                        filename,
                        name: (fm.name || filename.replace(/\.md$/, '')) as string,
                        description: (fm.description || '') as string,
                        type: (fm.type || 'reference') as string,
                        created: (fm.created || '') as string,
                        status: (fm.status || '') as string,
                        mtime: stat?.mtime || 0
                    });
                } catch (e) {
                    log.warn(`AgentMemory:${this.agentName}`, `Could not read brain note:`, path, e);
                }
            }

            notes.sort((a, b) => a.filename.localeCompare(b.filename));
            return notes;
        } catch (error) {
            // Nieudane LISTOWANIE katalogu ≠ „agent nie ma notatek".
            // Pusta tablica szłaby prosto do `rebuildBrainIndex`, który przebudowywałby brain.md
            // BEZ ani jednego linku — czyli kasowałby indeks pamięci przy jednej czkawce dysku.
            // Pojedyncza nieczytelna notatka nadal tylko warnuje (catch wyżej) i leci dalej.
            log.error(`AgentMemory:${this.agentName}`, `Error listing brain notes:`, error);
            throw error;
        }
    }

    /**
     * Rebuild brain.md from the active brain/*.md catalogue.
     * @param options.mutateNaTeraz
     *   Optional transform applied to the parsed „Na teraz" sections before the file is rebuilt
     *   (used by writeNaTeraz). Without it the sections are preserved verbatim.
     */
    async rebuildBrainIndex(
        options: { mutateNaTeraz?: (naTeraz: NaTerazSections) => NaTerazSections } = {},
    ): Promise<{ changed: boolean; content: string }> {
        await this.ensureMemoryStructure();
        // Serialize the whole read→list→build→write against brain.md so a
        // memory_save/rebuild running in parallel cannot
        // read a stale index and clobber a concurrent writer's update (lost-update race).
        return this._enqueuePathWrite(this.paths.brain, async () => {
            // Pusty `before` z AWARII odczytu ≠ pusty plik. Ta różnica
            // omijałaby bezpiecznik `.bak` niżej (`before && …`), więc ręczne sekcje ginęłyby
            // bez śladu przy odczycie, który padł.
            const probe = await probeFile(this.vault.adapter, this.paths.brain);
            let before = '';
            if (probe !== 'missing') {
                try {
                    before = await this.vault.adapter.read(this.paths.brain);
                } catch (e) {
                    log.warn(`AgentMemory:${this.agentName}`, `rebuildBrainIndex: nie mogę przeczytać ${this.paths.brain}, zostawiam plik w spokoju:`, e);
                    throw e;
                }
            }
            // brain.md carries „Na teraz" short-term sections at the top. Parse
            // them out of the current file and re-emit them so a rebuild NEVER drops them —
            // otherwise these plain bullets would look like manual content and get shoved into
            // brain.md.bak.
            let naTeraz = parseNaTerazSections(before);
            if (typeof options.mutateNaTeraz === 'function') naTeraz = options.mutateNaTeraz(naTeraz);
            // Sekcje H2 spoza katalogu zarządzanych (ręczne, np. „## AKTYWNY
            // TEST") wracają do nowego pliku verbatim, na koniec — rebuild nie może ich wycinać.
            const foreign = parseForeignSections(before);
            // Ręcznie dopisane linie w sekcjach ZARZĄDZANYCH (np. kilka bulletów sesji Claude
            // Code w `## Bieżące`) - bez tego rebuild je bezpowrotnie kasuje (patrz gotcha
            // w modules/memory/CLAUDE.md). Index-like linki są tu odsiane - te regeneruje
            // `buildBrainIndex` z realnych notatek.
            const manual = parseManualIndexLines(before);
            const notes = await this.listBrainNotes();
            const content = buildBrainIndex({
                agentName: this.agentName,
                header: this._brainHeaderFromContent(before),
                notes,
                naTeraz,
                foreign,
                manual
            });
            if (content !== before) {
                // Safety net: the rebuild still drops manual lines inside MANAGED sections
                // (foreign sections and „Na teraz" survive). Back those up first.
                // Przy niepewnym stanie pliku (`unknown` — `exists()` skłamało) backup idzie
                // ZAWSZE, bo nie wiemy, czy przed chwilą widzieliśmy całą prawdę o pliku.
                // `before` puste = nie ma czego backupować (i nie kasujemy starszego `.bak`).
                if (before && (probe === 'unknown' || this._brainHasManualContent(before))) {
                    try {
                        await this.vault.adapter.write(`${this.paths.brain}.bak`, before);
                    } catch (e) {
                        log.warn(`AgentMemory:${this.agentName}`, `brain.md.bak backup failed:`, e);
                    }
                }
                await this.vault.adapter.write(this.paths.brain, content);
            }
            return { changed: content !== before, content };
        });
    }

    /**
     * Detect user-authored lines in brain.md that the rebuild would DROP (anything other than the
     * header, a v3 section heading, a generated `- [[brain/...]]` link, a „Na teraz" bullet, or a
     * foreign section — those are preserved verbatim).
     * Triggers a one-file `brain.md.bak` backup before rebuildBrainIndex overwrites brain.md.
     */
    _brainHasManualContent(text: string | null | undefined): boolean {
        // Track which zone a line lives in. „Na teraz" bullets are
        // OURS (regenerated by buildBrainIndex) and foreign sections are PRESERVED verbatim by the
        // rebuild — neither may force a .bak. Manual lines inside MANAGED index sections are still
        // dropped by the rebuild, so they still do.
        let zone: 'managed' | 'na_teraz' | 'foreign' = 'managed';
        return String(text || '').split(/\r?\n/).some(line => {
            const trimmed = line.trim();
            if (!trimmed) return false;
            if (trimmed.startsWith('## ')) {
                zone = isNaTerazHeading(trimmed) ? 'na_teraz'
                    : INDEX_SECTIONS.includes(trimmed) ? 'managed' : 'foreign';
                return false;                                     // every H2 heading survives the rebuild
            }
            if (trimmed.startsWith('# ')) return false;           // brain header
            if (zone === 'foreign') return false;                 // preserved verbatim by the rebuild
            if (zone === 'na_teraz' && trimmed.startsWith('- ')) return false; // „Na teraz" bullet = ours
            if (trimmed.startsWith('- [[brain/')) return false;   // generated index link
            return true;                                          // user-added content the rebuild drops
        });
    }

    /**
     * Mutate the „Na teraz" short-term sections of brain.md through the write
     * queue. `ops` = one or more `{ section: 'user'|'environment', add?, remove? }`.
     *
     * These ephemeral sections are the ONE conscious exception to the create-only rule that governs
     * brain/*.md notes: they are updated and DELETED in place (add new state, purge outdated). The
     * exception is scoped strictly to brain.md's „Na teraz" sections — brain/ notes stay create-only.
     * Oldest entries beyond NA_TERAZ_MAX_ENTRIES are trimmed (+ debug log). Rebuilds the index.
     */
    async writeNaTeraz(
        ops: NaTerazOp[] | NaTerazOp | null | undefined = [],
    ): Promise<{ changed: boolean; content: string; trimmed: number }> {
        const list: NaTerazOp[] = Array.isArray(ops) ? ops.filter(Boolean) : (ops ? [ops] : []);
        if (list.length === 0) return { changed: false, content: '', trimmed: 0 };
        let trimmedTotal = 0;
        const result = await this.rebuildBrainIndex({
            mutateNaTeraz: (current) => {
                const { naTeraz, trimmed } = applyNaTerazOps(current, list);
                trimmedTotal += trimmed;
                return naTeraz;
            }
        });
        if (trimmedTotal > 0) {
            log.debug(`AgentMemory:${this.agentName}`, `„Na teraz" trim: usunięto ${trimmedTotal} najstarszych wpisów (limit ${NA_TERAZ_MAX_ENTRIES}/sekcja).`);
        }
        // Kronika `brain.log` — po jednym wpisie na sekcję, którą operacja realnie ruszyła.
        // Tylko gdy plik się zmienił: „usuń wpis, którego nie ma" nie jest zdarzeniem do zapisania.
        if (result?.changed) {
            const sections = [...new Set(list.map(op => op?.section).filter(Boolean))] as string[];
            for (const section of sections) {
                await this.appendBrainLog('na-teraz', section);
            }
        }
        return { ...result, trimmed: trimmedTotal };
    }

    /**
     * Create a brain/ note (create-with-suffix on name collision) through the
     * write queue. Unlike memory_save (create-only refusal), this appends `_2`, `_3`… so background
     * memory-candidate saves never fail on a duplicate name. Does NOT rebuild brain.md — the caller
     * rebuilds once after a batch. Reused by chat_session._saveMemoryCandidates.
     *
     * `ensureMemoryStructure()` jest memoizowana — koniec z samonaprawą struktury W TRAKCIE
     * sesji. Jeśli user ręcznie skasuje `brain/` (albo
     * cokolwiek innego z bootstrapu) w trakcie działania pluginu, flaga `_structureEnsured` nadal
     * mówi „zrobione" i sam zapis notatki rzucałby na zawsze, mimo że jedno odtworzenie folderów
     * by go uzdrowiło. Furtka: pad zapisu resetuje flagę i próbuje DOKŁADNIE RAZ — nie w kółko,
     * żeby realny, trwały błąd (uprawnienia, pełny dysk) doszedł do wołacza zamiast zawisnąć
     * w retry-loopie.
     */
    async writeBrainNote(
        note: BrainNoteInput,
        options: { source?: string } = {},
    ): Promise<{ path: string; filename: string; name: string }> {
        await this.ensureMemoryStructure();
        const type: MemoryNoteType = isValidNoteType(note?.type) ? note.type : 'reference';
        const baseFilename = makeMemoryNoteFilename(type, note?.name || note?.content);
        const basePath = `${this.paths.brainNotes}/${baseFilename}`;
        const doWrite = () => this._enqueuePathWrite(basePath, async () => {
            // Jak w startActiveSession — „nie wiem, czy ta nazwa jest wolna"
            // liczymy jako ZAJĘTĄ, żeby kłamiący exists() nie pozwolił nadpisać cudzej notatki.
            // Sufiks dokleja się do GOTOWEJ NAZWY PLIKU (jak `archiveBrainNote`,
            // `clean.replace(/\.md$/, ...)`), NIE do tekstu wchodzącego do slugifikacji — inaczej
            // dla slugu ≥80 znaków `makeMemoryNoteFilename` obcina ogon ZANIM sufiks miał szansę
            // się doliczyć, więc każda iteracja daje identyczną nazwę i pętla po 50 próbach rzuca
            // zamiast dobrać wolną nazwę.
            // Wspólna pętla z pięcioma siostrzanymi wywołaniami (`collisionSuffix.ts`).
            const { path, filename } = await findFreeCollisionPath(
                this.vault.adapter,
                this.paths.brainNotes,
                baseFilename,
                'writeBrainNote: brak wolnej nazwy notatki',
            );
            await this.vault.adapter.write(path, this._buildBrainNoteContent({ ...note, type }, options.source));
            return { path, filename, name: note?.name || filename.replace(/\.md$/, '') };
        });
        let created: { path: string; filename: string; name: string };
        try {
            created = await doWrite();
        } catch (e) {
            log.warn(
                `AgentMemory:${this.agentName}`,
                `writeBrainNote: pad zapisu, resetuję bootstrap struktury i próbuję raz jeszcze:`, e
            );
            this._structureEnsured = false;
            await this.ensureMemoryStructure();
            created = await doWrite();
        }
        // Kronika PO udanym zapisie (poza kolejką tej ścieżki — brain.log ma własną).
        await this.appendBrainLog('create', created.filename, options.source || 'auto');
        return created;
    }

    /**
     * Frontmatter + Why/How body for a brain/ note (matches memory_save format + a `source` field).
     * Etykiety i domyślne zdania idą z i18n (`memory.note.*`) — treść lądowała u usera w vaulcie
     * po angielsku niezależnie od języka UI. Bliźniak: `MemorySaveTool.buildNoteContent`.
     */
    _buildBrainNoteContent(note: BrainNoteInput, source?: string): string {
        const quote = (v: unknown) => JSON.stringify(String(v || '').slice(0, 1000));
        const date = new Date().toISOString().slice(0, 10);
        const why = note.why || t('memory.note.why_unspecified');
        const how = note.how_to_apply || note.howToApply || t('memory.note.how_default');
        return `---
name: ${quote(note.name)}
description: ${quote(note.description)}
type: ${note.type || 'reference'}
created: ${date}
source: ${source || 'auto'}
---
${String(note.content || '')}

${t('memory.note.why_label')} ${why}

${t('memory.note.how_label')} ${how}
`;
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    //  Poczekalnia `brain/pending_rescue/`
    //
    //  `memory_rescue` (ratunek kandydatów przed kompresją okna) nie może pisać wprost do
    //  `brain/` przez `writeBrainNote` — kandydat musi przejść review usera zanim trafi do
    //  pamięci trwałej („agent proponuje, user zatwierdza"). Nie da się tego wpiąć w poczekalnię
    //  `ArchiveWorkflow`/`ConsolidationRun` bez przebudowy: `MemoryOpsCenter` to globalny
    //  singleton — jeden przebieg na CAŁY plugin, nie per agent — a jego propozycje żyją
    //  wyłącznie w RAM, co jest bezpieczne dla konsolidacji, ale nie dla rescue, którego całym
    //  sensem jest nie gubić danych przed przeglądem.
    //
    //  Rozwiązanie: trwała poczekalnia PLIKOWA (ten silnik, wzorem `brain/archive/`) + review
    //  przez ISTNIEJĄCY modal `/save session` (`SaveSessionWorkflow`/`SaveSessionModal`, bo
    //  kształt kandydata jest bit-identyczny z `NoteProposal`). `ConsolidationRun`/
    //  `MemoryOpsCenter` NIETKNIĘTE.
    //
    //  Kontrakt folderu: `brain/pending_rescue/*.md` jest wykluczony z `listBrainNotes()`/indeksu
    //  DOKŁADNIE tym samym filtrem co `brain/archive/` (podfolder → `relative.includes('/')`).
    //  Notatka NIE istnieje dla agenta/promptu, dopóki user jej nie zaakceptuje.
    // ═══════════════════════════════════════════════════════════════════════════════════════

    /**
     * Zapisz kandydata rescue do POCZEKALNI zamiast wprost do `brain/`. Ten sam kształt zapisu co
     * `writeBrainNote` (create-with-suffix przez kolejkę zapisu, `probeFile` w pętli kolizji) — różni
     * się WYŁĄCZNIE folderem docelowym i tym, że `why`/`how_to_apply`/`source` zostają w
     * ODZYSKIWALNEJ formie (frontmatter), bo `acceptPendingRescue` dopiero przy accept woła
     * `writeBrainNote`, który sam dokłada stopkę Why/How — dwa doklejenia zdublowałyby ją.
     *
     * ⚠️ Świadomie BEZ `appendBrainLog`: kandydat w poczekalni NIE jest jeszcze pamięcią trwałą
     * (może zostać odrzucony), a `brain.log` odpowiada na „co WPADŁO mi do pamięci". Wpis
     * powstaje dopiero przy `acceptPendingRescue` — przez `writeBrainNote`, jak każda inna droga
     * tworzenia notatki.
     */
    async writePendingRescue(
        note: BrainNoteInput,
        options: { source?: string } = {},
    ): Promise<{ path: string; filename: string; name: string }> {
        await this.ensureMemoryStructure();
        const type: MemoryNoteType = isValidNoteType(note?.type) ? note.type : 'reference';
        const baseFilename = makeMemoryNoteFilename(type, note?.name || note?.content);
        const basePath = `${this.paths.pendingRescue}/${baseFilename}`;
        return this._enqueuePathWrite(basePath, async () => {
            // Jak w `writeBrainNote` — „nie wiem, czy ta nazwa jest wolna"
            // liczymy jako ZAJĘTĄ, żeby kłamiący exists() nie pozwolił nadpisać cudzego kandydata.
            // Sufiks dokleja się do NAZWY PLIKU, nie do tekstu wchodzącego
            // do slugifikacji — patrz komentarz w `writeBrainNote` (ten sam mechanizm, ta sama pętla).
            // Wspólna pętla z pięcioma siostrzanymi wywołaniami (`collisionSuffix.ts`).
            const { path, filename } = await findFreeCollisionPath(
                this.vault.adapter,
                this.paths.pendingRescue,
                baseFilename,
                'writePendingRescue: brak wolnej nazwy',
            );
            try {
                await this.vault.adapter.write(path, this._buildPendingRescueContent({ ...note, type }, options.source));
            } catch (writeError) {
                // Torn write (utrata zapisu na dysku sieciowym):
                // adapter potrafi odrzucić Promise MIMO że bajty faktycznie wylądowały na
                // dysku (dyski sieciowe / Dysk Google). Bez tej weryfikacji wołacz
                // (`turnOwner.saveMemoryCandidatesFor`) widziałby fałszywy fail i fail-softem
                // dopisywałby DUPLIKAT wprost do brain/, podczas gdy kandydat i tak zostałby
                // w poczekalni — user zobaczyłby ten sam fakt dwa razy przy najbliższym
                // przeglądzie. `probeFile` (nie goły `exists()`) potwierdza fakt ODCZYTEM.
                if ((await probeFile(this.vault.adapter, path)) === 'exists') {
                    log.warn(`AgentMemory:${this.agentName}`, `writePendingRescue: write() rzucił, ale plik istnieje — traktuję jako sukces (torn write): ${path}`);
                } else {
                    throw writeError;
                }
            }
            return { path, filename, name: note?.name || filename.replace(/\.md$/, '') };
        });
    }

    /**
     * Frontmatter + RAW body (bez stopki Why/How — ta dokleja się dopiero przy `writeBrainNote`
     * w `acceptPendingRescue`, inaczej user zobaczyłby ją PODWÓJNIE po zaakceptowaniu). `why` i
     * `how_to_apply` muszą przeżyć do accept, więc idą do frontmattera jak `description`
     * (`JSON.stringify` na zapisie, `parseFrontmatterScalar`→`JSON.parse` na odczycie).
     */
    _buildPendingRescueContent(note: BrainNoteInput, source?: string): string {
        const quote = (v: unknown) => JSON.stringify(String(v || '').slice(0, 1000));
        const date = new Date().toISOString();
        return `---
name: ${quote(note.name)}
description: ${quote(note.description)}
type: ${note.type || 'reference'}
created: ${date}
source: ${source || 'auto_compaction'}
why: ${quote(note.why || '')}
how_to_apply: ${quote(note.how_to_apply || note.howToApply || '')}
---
${String(note.content || '')}
`;
    }

    /** Rozbiera plik poczekalni z powrotem na pola kandydata — czytnik `listPendingRescue`/`acceptPendingRescue`. */
    _parsePendingRescueContent(content: string, filename: string): Omit<PendingRescueNote, 'path'> {
        const fm = this._parseFrontmatter(content);
        const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^\n+/, '');
        return {
            filename,
            name: (fm.name || filename.replace(/\.md$/, '')) as string,
            description: (fm.description || '') as string,
            type: (fm.type || 'reference') as string,
            content: body.trimEnd(),
            why: (fm.why || '') as string,
            how_to_apply: (fm.how_to_apply || '') as string,
            source: (fm.source || 'auto_compaction') as string,
            created: (fm.created || '') as string,
        };
    }

    /**
     * Kandydaci czekający w poczekalni na decyzję usera. Padnięte LISTOWANIE zwraca `[]`
     * (pad-toleruje jak reszta list w tym pliku, NIE jak `listBrainNotes`): pusta lista tutaj
     * nie karmi żadnej operacji nadpisującej indeks — najwyżej TA runda `/save session` nie
     * pokaże kandydatów, którzy bezpiecznie zostają na dysku do następnej okazji.
     */
    async listPendingRescue(): Promise<PendingRescueNote[]> {
        try {
            if (!(await this.vault.adapter.exists(this.paths.pendingRescue))) {
                await this.vault.adapter.mkdir(this.paths.pendingRescue);
            }
            const listed = await this.vault.adapter.list(this.paths.pendingRescue);
            const prefix = `${this.paths.pendingRescue}/`;
            const files = (listed?.files || [])
                .filter(path => path.endsWith('.md'))
                .filter(path => {
                    const relative = path.startsWith(prefix) ? path.slice(prefix.length) : path;
                    return relative && !relative.includes('/');
                });
            const notes: PendingRescueNote[] = [];
            for (const path of files) {
                try {
                    const content = await this.vault.adapter.read(path);
                    const filename = path.split('/').pop() as string;
                    notes.push({ path, ...this._parsePendingRescueContent(content, filename) });
                } catch (e) {
                    log.warn(`AgentMemory:${this.agentName}`, `Could not read pending rescue candidate:`, path, e);
                }
            }
            notes.sort((a, b) => a.filename.localeCompare(b.filename));
            return notes;
        } catch (error) {
            log.error(`AgentMemory:${this.agentName}`, `Error listing pending rescue candidates:`, error);
            return [];
        }
    }

    /**
     * User zaakceptował kandydata: tworzy PRAWDZIWĄ notatkę w `brain/` istniejącą ścieżką
     * `writeBrainNote` (kolizje nazw + `brain.log` załatwione tam), POTEM kasuje plik z
     * poczekalni — create-before-delete, jak `archiveBrainNote`. Pad między tymi krokami
     * zostawia kandydata w poczekalni (zamiast go zgubić), bo `remove` idzie jako ostatni.
     *
     * @param filename - nazwa pliku W POCZEKALNI (`brain/pending_rescue/<filename>`)
     * @param note - finalna treść (możliwe że EDYTOWANA przez usera w modalu `/save session`);
     *   pominięte pola wracają do oryginału z pliku poczekalni
     */
    async acceptPendingRescue(
        filename: string,
        note?: BrainNoteInput,
        options: { source?: string } = {},
    ): Promise<{ path: string; filename: string; name: string }> {
        const clean = String(filename || '').trim();
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(clean)) {
            throw new Error('acceptPendingRescue accepts a safe .md filename only');
        }
        await this.ensureMemoryStructure();
        const sourcePath = `${this.paths.pendingRescue}/${clean}`;
        return this._enqueuePathWrite(sourcePath, async () => {
            // `readIfExists`: sygnały sprzeczne NIE MOGĄ ani udawać sukcesu, ani kasować
            // pliku, którego treści nie widzieliśmy — fail-closed, jak reszta modułu.
            const probe = await readIfExists(this.vault.adapter, sourcePath);
            if (probe.state === 'missing') {
                throw new Error(`Pending rescue candidate not found: ${clean}`);
            }
            if (probe.state === 'unreadable') {
                throw new Error(`acceptPendingRescue: nie mogę odczytać kandydata — nie kasuję i nie tworzę notatki: ${sourcePath} (${causeText(probe.cause)})`);
            }
            const pending = this._parsePendingRescueContent(probe.content, clean);
            const finalNote: BrainNoteInput = {
                name: note?.name ?? pending.name,
                description: note?.description ?? pending.description,
                type: note?.type ?? pending.type,
                content: note?.content ?? pending.content,
                why: note?.why ?? pending.why,
                how_to_apply: note?.how_to_apply ?? note?.howToApply ?? pending.how_to_apply,
            };
            const created = await this.writeBrainNote(finalNote, { source: options.source || pending.source });
            // create-before-delete: notatka w brain/ już istnieje, zanim kandydat znika stąd.
            if (this.vault.adapter.remove) await this.vault.adapter.remove(sourcePath);
            return created;
        });
    }

    /**
     * User odrzucił kandydata: kasuje plik z poczekalni, nic nie trafia do `brain/`.
     * `probeFile` zamiast gołego `exists()` — 'unknown' fail-closed (NIE kasujemy pliku,
     * którego stanu nie jesteśmy pewni; user może odrzucić ponownie w kolejnej rundzie).
     */
    async rejectPendingRescue(filename: string): Promise<{ removed: boolean }> {
        const clean = String(filename || '').trim();
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(clean)) {
            throw new Error('rejectPendingRescue accepts a safe .md filename only');
        }
        const path = `${this.paths.pendingRescue}/${clean}`;
        return this._enqueuePathWrite(path, async () => {
            const state = await probeFile(this.vault.adapter, path);
            if (state === 'missing') return { removed: false };
            if (state === 'unknown') {
                log.warn(`AgentMemory:${this.agentName}`, `rejectPendingRescue: niepewny stan pliku, nie kasuję: ${path}`);
                return { removed: false };
            }
            if (!this.vault.adapter.remove) return { removed: false };
            await this.vault.adapter.remove(path);
            return { removed: true };
        });
    }

    async archiveBrainNote(
        filename: string,
        options: { lessonsReviewed?: boolean; archivedAt?: string; lessonsExtracted?: boolean; reason?: string } = {},
    ): Promise<{ sourcePath: string; targetPath: string; filename: string }> {
        const clean = String(filename || '').trim();
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(clean)) {
            throw new Error('archiveBrainNote accepts a safe .md filename only');
        }
        await this.ensureMemoryStructure();
        const sourcePath = `${this.paths.brainNotes}/${clean}`;
        if (!(await this.vault.adapter.exists(sourcePath))) {
            throw new Error(`Brain note not found: ${clean}`);
        }

        const content = await this.vault.adapter.read(sourcePath);
        const fm = this._parseFrontmatter(content);
        if (fm.type === 'project_context' && options.lessonsReviewed !== true) {
            throw new Error('Project notes require lessonsReviewed=true before archiving');
        }

        // Jak w startActiveSession — „nie wiem, czy ta nazwa jest wolna"
        // liczymy jako ZAJĘTĄ. Throw tutaj ląduje PRZED write/remove niżej — kłamiący exists()
        // nie dostaje szansy nadpisać cudzego archiwum ani skasować źródła; źródło zostaje
        // nietknięte (write/remove w ogóle się nie odpalają, gdy pętla rzuci).
        // Wspólna pętla z pięcioma siostrzanymi wywołaniami (`collisionSuffix.ts`).
        const { path: targetPath } = await findFreeCollisionPath(
            this.vault.adapter,
            this.paths.brainArchive,
            clean,
            'archiveBrainNote: brak wolnej nazwy',
        );

        let archivedContent = this._setFrontmatterField(content, 'status', 'archived');
        archivedContent = this._setFrontmatterField(archivedContent, 'archived_at', options.archivedAt || new Date().toISOString());
        archivedContent = this._setFrontmatterField(archivedContent, 'lessons_extracted', options.lessonsExtracted === false ? 'false' : 'true');
        if (options.reason) {
            archivedContent = this._setFrontmatterField(archivedContent, 'archive_reason', String(options.reason).replace(/\r?\n/g, ' '));
        }

        // Serialize the move (write archive copy + remove source) against the source
        // path so a parallel append/rebuild cannot resurrect or race the half-moved note.
        await this._enqueuePathWrite(sourcePath, async () => {
            await this.vault.adapter.write(targetPath, archivedContent);
            if (this.vault.adapter.remove) await this.vault.adapter.remove(sourcePath);
        });
        // Notatka zniknęła z czynnej pamięci — user musi mieć ślad kto ją odłożył.
        await this.appendBrainLog('archive', clean, options.reason || '');
        await this.rebuildBrainIndex();
        return { sourcePath, targetPath, filename: targetPath.split('/').pop() as string };
    }

    /**
     * Update the agent's brain with new information.
     * Hard limit BRAIN_MAX_TOKENS (token-based, nie char-based).
     * Overflow → przenoszone do brain_archive.md.
     * @param content - New brain content
     */
    async updateBrain(content: string): Promise<void> {
        if (this._brainOverLimit(content)) {
            const sections = this._parseBrainSections(content);
            content = await this._archiveOverflow(sections, this._brainOverLimitPredicate());
        }
        await this.vault.adapter.write(this.paths.brain, content);
    }

    /**
     * Check if content exceeds brain hard limit.
     * Token-first, char-fallback if tokenCounter throws.
     */
    _brainOverLimit(content: string): boolean {
        try {
            const tokens = getTokenCount(content);
            if (Number.isFinite(tokens) && tokens > 0) return tokens > BRAIN_MAX_TOKENS;
        } catch { /* fallback */ }
        return content.length > BRAIN_MAX_CHARS_FALLBACK;
    }

    /**
     * Predicate factory used by `_archiveOverflow` to decide when to stop trimming.
     * Returns a function that returns `true` while content STILL exceeds the limit.
     */
    _brainOverLimitPredicate(): (content: string) => boolean {
        return (content: string) => this._brainOverLimit(content);
    }

    /**
     * Get memory context to inject into system prompt.
     * Memory v3: brain.md index + brain/ note catalogue + L1/L2/L3 counters.
     * @returns Combined context string
     */
    async getMemoryContext(): Promise<string> {
        const parts: string[] = [];

        // Add brain (long-term memory)
        // Awaria odczytu MELDUJE SIĘ w prompcie — bez tego `getBrain()`
        // oddawałby '' i blok pamięci po prostu by zniknął — model odpowiadałby tak, jakby agent
        // nie znał ustaleń usera, a jedyny ślad awarii siedziałby w konsoli developerskiej.
        try {
            const brain = await this.getBrain();
            if (brain && brain.trim()) {
                parts.push(t('memory.long_term') + '\n' + brain);
            }
        } catch (e) {
            log.warn(`AgentMemory:${this.agentName}`, `getMemoryContext: brain.md nie do odczytu:`, e);
            parts.push(t('memory.long_term_unavailable'));
        }

        // Memory v3 brain/ catalogue. Full note bodies are loaded only on demand via memory_read.
        let notes: BrainNoteInfo[] = [];
        let notesUnavailable = false;
        try {
            notes = await this.listBrainNotes();
        } catch (e) {
            notesUnavailable = true;
            log.warn(`AgentMemory:${this.agentName}`, `getMemoryContext: katalog brain/ nie do odczytu:`, e);
        }
        const noteLines = [
            '**Notatki w brain/ (możesz wczytać przez memory_read):**'
        ];
        if (notesUnavailable) {
            noteLines.push(t('memory.notes_unavailable'));
        } else if (notes.length === 0) {
            noteLines.push('- brak notatek');
        } else {
            for (const note of notes) {
                // Opis MUSI być jednolinijkowy — z frontmattera wraca
                // przez JSON.parse z prawdziwymi znakami nowej linii, a wielolinijkowy wpis
                // wstawiłby do promptu własny nagłówek (np. `## INSTRUKCJE`) obok pozycji indeksu.
                const flat = oneLineDescription(note.description);
                const description = flat ? ` — ${flat}` : '';
                noteLines.push(`- ${note.filename}${description}`);
            }
        }
        parts.push(noteLines.join('\n'));

        // Summary statistics — pointer only (full text available via memory_summaries / delegate)
        try {
            let l1Count = 0, l2Count = 0, l3Count = 0;
            try {
                const l1Files = await this.vault.adapter.list(this.paths.l1);
                l1Count = l1Files?.files?.filter(f => f.endsWith('.md')).length || 0;
            } catch { /* no L1 */ }
            try {
                const l2Files = await this.vault.adapter.list(this.paths.l2);
                l2Count = l2Files?.files?.filter(f => f.endsWith('.md')).length || 0;
            } catch { /* no L2 */ }
            try {
                const l3Files = await this.vault.adapter.list(this.paths.l3);
                l3Count = l3Files?.files?.filter(f => f.endsWith('.md')).length || 0;
            } catch { /* no L3 */ }

            const total = l1Count + l2Count + l3Count;
            if (total > 0) {
                const counts: string[] = [];
                if (l1Count > 0) counts.push(`${l1Count}×L1`);
                if (l2Count > 0) counts.push(`${l2Count}×L2`);
                if (l3Count > 0) counts.push(`${l3Count}×L3`);
                parts.push(`${t('memory.session_history')}\n${t('memory.session_history_msg', { counts: counts.join(', ') })}`);
            }
        } catch {
            // No summaries yet
        }

        return parts.join('\n\n---\n\n');
    }

    // --- Phase 5: L1/L2 Consolidation ---

    /**
     * Parse YAML frontmatter from a markdown file.
     * Returns an object with frontmatter fields, or {} if none.
     *
     * Delegacja do `activeSessionFormat.parseFrontmatter` — implementacja
     * przeniosła się tam, bo blok frontmattera jest częścią kontraktu pliku sesji, a
     * `parseActiveSession` musi go czytać bez `this`. Metoda ZOSTAJE: wołają ją
     * `ArchiveWorkflow`, `modules/chat/chat_session` i `modules/tools/ReadTool`.
     * @param content - File content
     */
    _parseFrontmatter(content: string): SessionFrontmatter {
        return parseFrontmatter(content);
    }

    /**
     * Prawdziwa data sesji z frontmattera (ms) albo null gdy nie do ustalenia.
     * Sesje pluginowe mają `created:` (ISO); sesje pisane przez Claude Code
     * mają `date: YYYY-MM-DD` + `time: HH-mm[-ss]`.
     */
    _sessionCreatedMs(fm: SessionFrontmatter | null | undefined): number | null {
        const created = Date.parse((fm?.created || '') as string);
        if (Number.isFinite(created)) return created;
        if (fm?.date) {
            const time = String(fm.time || '').trim().replace(/-/g, ':');
            const parsed = Date.parse(`${fm.date as string}T${time || '00:00:00'}`);
            if (Number.isFinite(parsed)) return parsed;
        }
        return null;
    }

    /**
     * Set a single scalar field in YAML frontmatter (in-place, idempotent).
     * - Frontmatter exists & key exists → replace value
     * - Frontmatter exists & key missing → append before closing `---`
     * - No frontmatter → prepend new `---\n<key>: <value>\n---\n`
     * Used by cascade flagging (`covered_by_l1`).
     * @param content - File content
     * @param key - Frontmatter key (scalar only, no nested objects/arrays)
     * @param value - Value to set (will be stringified)
     * @returns Updated content (or original if value already matches)
     */
    _setFrontmatterField(content: string | null | undefined, key: string, value: unknown): string {
        const safeValue = String(value);
        // Pliki potrafią przyjść z dysku z CRLF i BOM (Windows, Dysk Google, edytory zewnętrzne).
        // Regex frontmattera stał na twardym `\n`, więc na takim pliku NIE trafiał i doklejał
        // DRUGI blok `---` na górze — uszkodzony plik usera. Normalizujemy raz, na wejściu;
        // wynik zapisujemy z `\n` (te pliki i tak pisze plugin).
        const text = String(content ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
        const fmMatch = text.match(/^(---\n)([\s\S]*?)(\n---\n?)/);
        if (!fmMatch) {
            return `---\n${key}: ${safeValue}\n---\n${text}`;
        }
        const [whole, open, body, close] = fmMatch;
        const rest = text.slice(whole.length);
        const keyRe = new RegExp(`^${key}:.*$`, 'm');
        // Podmiana funkcją, nie stringiem: wartość może nieść `$&`/`$'`, które w replace() są wzorcami.
        const newBody = keyRe.test(body)
            ? body.replace(keyRe, () => `${key}: ${safeValue}`)
            : `${body}\n${key}: ${safeValue}`;
        return `${open}${newBody}${close}${rest}`;
    }

    /**
     * Generic helper: get items from `itemsPath` not yet referenced in `refsPath` frontmatter `refKey`.
     * @param itemsPath - Folder containing items to check
     * @param refsPath - Folder containing files with frontmatter references
     * @param refKey - Frontmatter key containing referenced item names
     * @param itemsLoader - Custom loader for items (defaults to listing .md files)
     * @returns Unconsolidated items
     */
    async _getUnconsolidatedItems<T extends { name: string }>(
        itemsPath: string | null,
        refsPath: string,
        refKey: string,
        itemsLoader?: () => Promise<T[]>,
    ): Promise<T[]> {
        const allItems = itemsLoader
            ? await itemsLoader()
            : (await this._listMdItems(itemsPath as string)) as unknown as T[];
        if (allItems.length === 0) return [];

        const consolidatedNames = new Set<string>();
        try {
            const refsListed = await this.vault.adapter.list(refsPath);
            if (refsListed?.files) {
                for (const filePath of refsListed.files) {
                    if (!filePath.endsWith('.md')) continue;
                    try {
                        const content = await this.vault.adapter.read(filePath);
                        const fm = this._parseFrontmatter(content);
                        if (Array.isArray(fm[refKey])) {
                            for (const raw of fm[refKey] as unknown[]) {
                                const name = String(raw ?? '').trim();
                                if (name) consolidatedNames.add(name);
                            }
                        }
                    } catch (e) {
                        // Nieczytelny plik referencyjny = NIE WIEM, co pokrywa. Lecimy dalej (plik mógł
                        // właśnie zniknąć pod kaskadą), ale GŁOŚNO: jego pozycje wrócą do puli i dostaną
                        // drugie streszczenie. Cisza w tym miejscu była powodem, dla którego duplikaty
                        // przeżyły trzy miesiące.
                        log.warn(`AgentMemory:${this.agentName}`, `Pokrycie (${refKey}): nie odczytałem ${filePath}:`, e);
                    }
                }
            }
        } catch { /* folder doesn't exist yet */ }

        return allItems.filter(item => !consolidatedNames.has(item.name));
    }

    /** List .md files from a folder as { path, name } */
    async _listMdItems(folderPath: string): Promise<Array<{ path: string; name: string }>> {
        const items: Array<{ path: string; name: string }> = [];
        try {
            const listed = await this.vault.adapter.list(folderPath);
            if (listed?.files) {
                for (const fp of listed.files) {
                    if (fp.endsWith('.md')) items.push({ path: fp, name: fp.split('/').pop() as string });
                }
            }
        } catch { /* folder doesn't exist */ }
        return items;
    }

    /**
     * Get sessions not yet included in any L1 summary.
     * @returns Array of { path, name, mtime } for unconsolidated sessions
     */
    async getUnconsolidatedSessions(): Promise<Array<{ path: string; name: string; mtime: number }>> {
        return this._getUnconsolidatedItems(null, this.paths.l1, 'sessions', () => this.listSessions());
    }

    /**
     * Pliki L1, których NIE wchłonęło jeszcze żadne L2 — jedyny poprawny materiał na nową paczkę L2.
     *
     * Odpowiednik `listUncoveredArchiveSessions()` o szczebel wyżej, z jedną różnicą w mechanice:
     * **znacznikiem pokrycia jest sam plik L2**, nie stempel w pliku L1. Każde L2 od zawsze wypisuje
     * we frontmatterze `l1_files:` komplet L1, z których powstało (pisze to `_writeLevel2`), więc
     * kandydatów odsiewamy backlinkiem — bez dopisywania czegokolwiek do plików usera.
     *
     * Dlaczego nie stempel `covered_by_l2` w plikach L1 (symetria z `covered_by_l1`):
     *  - **crash-safety.** Stempel jest DRUGIM zapisem po zapisie L2; pad między nimi zostawiał
     *    L2 na dysku i nieostemplowane L1 → następny przebieg streścił je po raz drugi (dokładnie
     *    ta wtopa, tylko rzadziej). Przy backlinku „zapis L2" I „oznaczenie L1" to JEDNA operacja
     *    atomowa — jeden `adapter.write`. Albo L2 jest (i pokrycie widać), albo go nie ma
     *    (i L1 wracają do puli, co jest poprawne — nic nie powstało).
     *  - **stare dyski.** L2 sprzed tej naprawy też mają `l1_files`, więc pokrycie liczy się
     *    wstecz bez migracji i bez jednorazowego przeliczenia.
     *  - **pliki usera.** Zero nowych zapisów do plików pamięci.
     *
     * ⚠️ Granica: L2 z pustym/brakującym `l1_files` (plik ręczny albo z bardzo starej wersji)
     * nie pokrywa NICZEGO — jego L1 wrócą do puli i dostaną drugie streszczenie. Świadomie:
     * pojedyncze przeliczenie jest tańsze niż zgadywanie pokrycia po dacie.
     *
     * Sortowanie ROSNĄCO po nazwie — okna paczek (`slice(0, batchSize)`) muszą być deterministyczne.
     */
    async listUncoveredL1s(): Promise<Array<{ path: string; name: string }>> {
        const items = await this._getUnconsolidatedItems<{ path: string; name: string }>(
            this.paths.l1, this.paths.l2, 'l1_files',
        );
        return items.sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * Pliki L2, których NIE wchłonęło jeszcze żadne L3 — materiał na nową paczkę L3.
     * Ta sama mechanika co `listUncoveredL1s()`, tyle że backlinkiem jest `l2_files:` w L3.
     *
     * Tu backlink jest jedyną sensowną drogą także z drugiego powodu: L2 nie ubywają NIGDY
     * (kaskada `_cleanupAfterL3` kasuje L1, a L2 zostawia jako najwyższy poziom historii), więc
     * bez filtru gołe listowanie folderu proponowało w kółko pięć najstarszych L2.
     */
    async listUncoveredL2s(): Promise<Array<{ path: string; name: string }>> {
        const items = await this._getUnconsolidatedItems<{ path: string; name: string }>(
            this.paths.l2, this.paths.l3, 'l2_files',
        );
        return items.sort((a, b) => a.name.localeCompare(b.name));
    }

    // --- Phase 3: Memory Extraction support ---

    /**
     * Central legacy memory write function.
     * Memory Index Rework keeps this for active_context compatibility only: direct brain.md
     * updates are ignored because brain.md is a generated index of brain/*.md notes.
     * v3 brain.md sections are: ## Bieżące / ## User / ## Preferencje / ## Workflow /
     * ## Projekty i referencje (the legacy v2 ## Ustalenia section no longer exists).
     * Durable facts are created via memory_save (inline) or /save session (user-reviewed).
     *
     * @param updates - Legacy {category, content, section, oldContent?} entries — logged as ignored, never written to brain.md.
     * @param activeContextSummary - Summary of the session for active_context.md
     */
    async memoryWrite(
        updates: LegacyMemoryUpdate[] | null | undefined,
        activeContextSummary?: string,
    ): Promise<void> {
        const ignoredUpdates = Array.isArray(updates)
            ? updates.filter(Boolean).map(update => ({
                category: `LEGACY_${update.category || 'UPDATE'}_IGNORED`,
                content: update.content || ''
            }))
            : [];

        // Save active context summary
        if (activeContextSummary && activeContextSummary.trim()) {
            await this.vault.adapter.write(this.paths.activeContext, activeContextSummary);
        }

        // Audit log: make ignored legacy writes visible without mutating brain.md.
        await this._appendAuditLog(ignoredUpdates);
    }

    /**
     * Parse brain.md into sections map
     * @returns { header: string, sections: Map<string, string[]> }
     */
    _parseBrainSections(brainContent: string): BrainSections {
        const lines = brainContent.split('\n');
        let header = '';
        const sections = new Map<string, string[]>();
        let currentSection: string | null = null;

        for (const line of lines) {
            if (line.startsWith('# ') && !line.startsWith('## ')) {
                header = line;
            } else if (line.startsWith('## ')) {
                currentSection = line;
                if (!sections.has(currentSection)) {
                    sections.set(currentSection, []);
                }
            } else if (currentSection) {
                const trimmed = line.trim();
                if (trimmed) {
                    sections.get(currentSection)!.push(trimmed);
                }
            }
        }

        // Ensure all required sections exist
        for (const s of INDEX_SECTIONS) {
            if (!sections.has(s)) {
                sections.set(s, []);
            }
        }

        return { header: header || `# ${t('memory.brain_header', { name: this.agentName })}`, sections };
    }

    _brainHeaderFromContent(content: string | null | undefined): string {
        const header = String(content || '')
            .split(/\r?\n/)
            .find(line => line.startsWith('# ') && !line.startsWith('## '));
        return header || `# ${t('memory.brain_header', { name: this.agentName })}`;
    }

    /**
     * Rebuild brain.md from sections map
     * @param parsed - { header, sections }
     */
    _buildBrainFromSections(parsed: BrainSections): string {
        const parts = [parsed.header, ''];

        // Maintain consistent section order
        const sectionOrder = INDEX_SECTIONS;
        const orderedKeys = [
            ...sectionOrder.filter(s => parsed.sections.has(s)),
            ...[...parsed.sections.keys()].filter(s => !sectionOrder.includes(s))
        ];

        for (const key of orderedKeys) {
            parts.push(key);
            const items = parsed.sections.get(key) || [];
            for (const item of items) {
                parts.push(item.startsWith('- ') ? item : `- ${item}`);
            }
            parts.push('');
        }

        return parts.join('\n');
    }

    /**
     * Move oldest facts to brain_archive.md when brain exceeds size limit.
     * Accepts predicate function (token-based) lub legacy number (char-based).
     * @param parsed - { header, sections }
     * @param sizeGate - Predicate (content) => boolean (true = still too big),
     *                   or legacy maxChars number for backward-compat.
     * @returns New brain content within limit
     */
    async _archiveOverflow(parsed: BrainSections, sizeGate: ((content: string) => boolean) | number): Promise<string> {
        const archivePath = `${this.basePath}/brain_archive.md`;
        const archived: string[] = [];
        const stillOverLimit = typeof sizeGate === 'function'
            ? sizeGate
            : (content: string) => content.length > sizeGate;

        // Remove oldest facts from ## User and ## Bieżące (most likely to overflow)
        for (const section of ['## Bieżące', '## User']) {
            const items = parsed.sections.get(section);
            if (!items) continue;

            while (items.length > 1 && stillOverLimit(this._buildBrainFromSections(parsed))) {
                const removed = items.shift(); // Remove oldest (first) item
                archived.push(`[${new Date().toISOString().slice(0, 10)}] ${section}: ${removed}`);
            }
        }

        // Append archived facts to brain_archive.md
        if (archived.length > 0) {
            // Self-append: jak w `saveSession` — stary `if (exists) read()` na
            // kłamiącym `exists()` przechodziłby w gałąź „pierwsze archiwum" i NADPISYWAŁBY
            // dotychczasową treść `brain_archive.md` samym nowym urywkiem. `readIfExists`
            // czyta najpierw, więc kłamstwo `exists()` nie ma jak przeciąć drogi do treści.
            const probe = await readIfExists(this.vault.adapter, archivePath);
            if (probe.state === 'unreadable') {
                // Sprzeczne sygnały na WŁASNYM archiwum — nadpisanie skasowałoby historię
                // wcześniej przeniesionych faktów. Rzut przerywa CAŁĄ kompresję: jedyny wołacz,
                // `updateBrain`, nie dochodzi do zapisu przyciętej treści do brain.md (ten zapis
                // jest PO tym wywołaniu), więc oryginał zostaje nietknięty.
                throw new Error(`_archiveOverflow: nie mogę odczytać istniejącego brain_archive.md — przerywam kompresję: ${archivePath} (${causeText(probe.cause)})`);
            }
            const existingArchive = probe.state === 'content' ? probe.content : '';

            const archiveContent = existingArchive
                ? existingArchive + '\n' + archived.join('\n')
                : `# ${t('memory.brain_archive_header', { name: this.agentName })}\n\n` + archived.join('\n');

            await this.vault.adapter.write(archivePath, archiveContent);
        }

        return this._buildBrainFromSections(parsed);
    }

    /**
     * Append memory changes to audit.log
     * @param updates - Changes applied
     */
    async _appendAuditLog(updates: LegacyMemoryUpdate[] | null | undefined): Promise<void> {
        if (!updates || updates.length === 0) return;

        const logPath = `${this.basePath}/audit.log`;
        const timestamp = new Date().toISOString();

        const entries = updates.map(u =>
            `[${timestamp}] [${u.category}] ${u.content}`
        ).join('\n');

        try {
            await this._enqueuePathWrite(logPath, async () => {
                // Self-append: kronika, nie źródło prawdy — polityka jest SKIP,
                // nie throw. `readIfExists` broni tylko przed nadpisaniem: sygnały sprzeczne
                // pomijają TEN wpis zamiast ryzykować utratę wcześniejszych linii audytu.
                const probe = await readIfExists(this.vault.adapter, logPath);
                if (probe.state === 'unreadable') {
                    log.warn(`AgentMemory:${this.agentName}`, `_appendAuditLog: nie mogę odczytać ${logPath}, pomijam ten wpis (${causeText(probe.cause)})`);
                    return;
                }
                const existing = probe.state === 'content' ? probe.content : '';
                await this.vault.adapter.write(logPath, existing ? existing + '\n' + entries : entries);
            });
        } catch (e) {
            log.warn(`AgentMemory:${this.agentName}`, `Could not write audit log:`, e);
        }
    }

    /**
     * Dopisz jedną linię do `brain.log` — kroniki zapisów do pamięci TRWAŁEJ.
     *
     * ⚠️ To NIE jest `audit.log`. Tamten to osobny, żywy mechanizm legacy (`_appendAuditLog`
     * loguje IGNOROWANE stare `brain_update`) i nie wolno go tu mieszać — user widzi w profilu
     * obie karty i muszą znaczyć różne rzeczy. `brain.log` odpowiada na pytanie „co i kiedy
     * wpadło mi do pamięci", żeby zapis przez agenta przestał być niewidzialny.
     *
     * Format TSV (`ISO \t op \t target \t detail`) — jedna linia = jeden wpis, parsowalne
     * `split('\t')` bez cudzysłowów i bez JSON-a (log rośnie append-only, ma być tani).
     * Tabulatory i złamania linii w polach są zamieniane na spacje, żeby jeden wpis nie mógł
     * rozjechać się na dwa wiersze.
     *
     * BEST-EFFORT: NIGDY nie rzuca. Kronika jest dodatkiem — jej awaria nie ma prawa wywalić
     * zapisu notatki, który właśnie się udał.
     *
     * @param op - `create` | `na-teraz` | `merge` | `delete` | `archive`
     * @param target - nazwa pliku albo nazwa sekcji
     * @param detail - skąd/dlaczego (np. `memory_save`, `save_session`)
     * @returns czy wpis wylądował na dysku
     */
    async appendBrainLog(op: string, target: string, detail = ''): Promise<boolean> {
        const flat = (value: unknown) => String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
        const line = [new Date().toISOString(), flat(op), flat(target), flat(detail)].join('\t');
        const logPath = `${this.basePath}/brain.log`;
        try {
            return await this._enqueuePathWrite(logPath, async () => {
                // Self-append: jak `_appendAuditLog` — kronika ma kontrakt
                // BEST-EFFORT (dokstring wyżej: „NIGDY nie rzuca"), więc sygnały sprzeczne
                // pomijają TEN wpis (warn + `false`) zamiast nadpisywać albo rzucać w górę.
                const probe = await readIfExists(this.vault.adapter, logPath);
                if (probe.state === 'unreadable') {
                    log.warn(`AgentMemory:${this.agentName}`, `appendBrainLog: nie mogę odczytać ${logPath}, pomijam ten wpis (${causeText(probe.cause)})`);
                    return false;
                }
                const existing = probe.state === 'content' ? probe.content : '';
                const head = existing.replace(/\s+$/, '');
                await this.vault.adapter.write(logPath, head ? `${head}\n${line}\n` : `${line}\n`);
                return true;
            });
        } catch (e) {
            log.warn(`AgentMemory:${this.agentName}`, `Could not write brain log:`, e);
            return false;
        }
    }

    // --- Private helpers ---

    _generateActiveSessionFilename(agentName: string = this.agentName): string {
        const now = new Date();
        const date = now.toISOString().slice(0, 10);
        const time = now.toISOString().slice(11, 16).replace(/:/g, '-');
        const safeAgent = getSafeAgentName(agentName || this.agentName) || this.safeName;
        return `${safeAgent}_${date}_${time}.md`;
    }

    /**
     * Czytnik pliku aktywnej sesji (format A, format B i pliki MIESZANE) — delegacja
     * do jedynego źródła kontraktu. Pełny opis klasyfikacji bloków i powodów
     * (trwała utrata rozmowy przy poprzedniej wersji) siedzi w `activeSessionFormat.js`.
     * @see modules/memory/activeSessionFormat.js
     */
    _parseActiveSessionFile(content: string): ParsedActiveSession {
        return parseActiveSession(content);
    }

    _createdFromActiveSessionName(name: string | null | undefined): string {
        const match = String(name || '').match(/(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2})/);
        if (!match) return '';
        return `${match[1]}T${match[2].replace('-', ':')}:00.000Z`;
    }

    _formatActiveSessionLabel(agent: string, created: string, filename: string): string {
        const stamp = created
            ? String(created).replace('T', ' ').slice(0, 16)
            : String(filename || '').replace(/\.md$/, '');
        return `${agent} · ${stamp}`;
    }

    // --- Cleanup methods (kaskadowa konsolidacja) ---
    //
    // Kaskada:
    //   5 sesji → L1   → sesje ZOSTAJĄ (z flagą covered_by_l1)
    //   3×L1 → L2      → sesje pokryte przez te 3 L1 KASOWANE, L1 zostają
    //   3×L2 → L3      → L1 pokryte przez te 3 L2 KASOWANE, L2 zostają
    //
    // Usuwanie bezpośredniego źródła od razu (sesje po L1, L1 po L2, L2 po L3) dawałoby
    // wrażenie "rozmowy znikają" — user nie widziałby historii.

    /**
     * Mark sessions as covered_by_l1 (NIE usuwa).
     * Called only by ArchiveWorkflow._writeLevel1 (AgentMemory's own consolidation path was
     * removed). Covered sessions are deleted later by ArchiveWorkflow._deleteArchivedSessions when
     * their L1 is absorbed into an L2.
     *
     * Sprawdzamy najpierw `sessions/archive/`, dopiero potem starą płaską ścieżkę pod
     * `paths.sessions` (pozostałości v2, których migrator `_migrateLegacyRootSessionsToArchive`
     * mógł jeszcze nie przenieść) — w tej kolejności, bo zarchiwizowane sesje leżą w
     * `sessions/archive/`, a próba złej ścieżki jako pierwszej kończy się `continue` i
     * NIGDY nieustawionym stemplem, więc każdy kolejny przebieg konsolidacji brałby te same
     * sesje do nowej paczki L1 (duplikaty) i badge „✓ w L1" w profilu nie miałby się z czego
     * wyrenderować.
     *
     * ⚠️ **Nieostemplowana sesja jest WYNIKIEM, nie szumem w logu.** Bez tej zwrotki pad zapisu
     * stempla (blokada synchronizatora / plik tylko do odczytu) byłby liczony tylko do lokalnej
     * zmiennej i raportowany WYŁĄCZNIE w `log.debug`, a `ArchiveWorkflow._writeLevel1` i tak
     * oddawałby `{created: 1}` — krok konsolidacji szedłby jako `done`. Sesje bez stempla wracają
     * przez `listUncoveredArchiveSessions()` do NASTĘPNEJ paczki L1, czyli powstaje drugie
     * streszczenie tych samych rozmów za kolejny strzał do modelu (duplikaty L1).
     * Zwrotka niesie więc LISTĘ pominiętych z powodem — wołacz przenosi ją do wyniku kroku.
     * Sam L1 jest już zapisany, więc to jest „zapisane, nie ostemplowane", a nie porażka całości.
     *
     * @param sessionNames - Names of sessions included in the L1
     * @param l1Path - Path to the freshly created L1 file (used for the flag value).
     *                 Starsi callerzy przekazywali tu liczbę `keepRecent` —
     *                 numeric value jest ignorowany (backward-compat soft no-op).
     * @returns `{marked, skipped}` — `skipped` wymienia sesje, które NIE dostały stempla.
     *   Stemplowanie jest idempotentne (sprawdza `fm.covered_by_l1 === l1Name`), więc ponowienie
     *   jest bezpieczne.
     */
    async _cleanupAfterL1(
        sessionNames: string[] | null | undefined,
        l1Path: string | number | null = null,
    ): Promise<L1StampOutcome> {
        if (!sessionNames || sessionNames.length === 0) return { marked: 0, skipped: [] };
        // Backward-compat: pre-Z2 caller przekazywał `keepRecent` (number) jako 2-gi arg.
        // Nowa logika potrzebuje l1Path (string). Bez l1Path — nic nie flagujemy.
        if (typeof l1Path !== 'string' || !l1Path) return { marked: 0, skipped: [] };

        // Wołacz przekazuje GOŁĄ NAZWĘ pliku L1 — `.split('/').pop()` toleruje też pełną ścieżkę.
        const l1Name = l1Path.split('/').pop();
        let marked = 0;
        const skipped: L1StampSkip[] = [];
        for (const name of sessionNames) {
            try {
                const path = await this._resolveArchivedSessionPath(name);
                if (!path) { skipped.push({ session: name, reason: 'not_found' }); continue; }
                // Stempel to read-modify-write na pliku sesji — przez kolejkę per-ścieżka.
                await this._enqueuePathWrite(path, async () => {
                    const content = await this.vault.adapter.read(path);
                    const fm = this._parseFrontmatter(content);
                    if (fm.covered_by_l1 === l1Name) return; // idempotent
                    await this.vault.adapter.write(path, this._setFrontmatterField(content, 'covered_by_l1', l1Name));
                    marked++;
                });
            } catch (e) {
                skipped.push({ session: name, reason: 'write_failed', detail: String((e as { message?: string })?.message ?? e) });
                log.warn(`AgentMemory:${this.agentName}`, `Could not mark session ${name} covered_by_l1:`, e);
            }
        }
        // Log ZAWSZE: cisza przy zerze była powodem, dla którego ta wtopa przeżyła trzy miesiące.
        log.debug(
            `AgentMemory:${this.agentName}`,
            `Cascade L1: ostemplowano ${marked}/${sessionNames.length} sesji covered_by_l1=${l1Name}` +
            `${skipped.length > 0 ? `, pominięto ${skipped.length}` : ''} (sesje ZOSTAJĄ)`
        );
        if (skipped.length > 0) {
            // `warn`, nie `debug`: te sesje wrócą do NASTĘPNEJ paczki L1 i zrobią duplikat.
            log.warn(
                `AgentMemory:${this.agentName}`,
                `Cascade L1: ${skipped.length} sesji BEZ stempla covered_by_l1=${l1Name} ` +
                `(wrócą do kolejnej paczki): ${skipped.map(s => `${s.session} [${s.reason}]`).join(', ')}`
            );
        }
        return { marked, skipped };
    }

    /**
     * Gdzie naprawdę leży zarchiwizowana sesja o danej nazwie: najpierw `sessions/archive/`
     * (Memory v3), potem płaskie `sessions/` (pozostałości v2 sprzed migratora). `null`, gdy nigdzie.
     */
    async _resolveArchivedSessionPath(name: string): Promise<string | null> {
        for (const folder of [this.paths.sessionsArchive, this.paths.sessions]) {
            const path = `${folder}/${name}`;
            if (await this.vault.adapter.exists(path)) return path;
        }
        return null;
    }

    /**
     * Zarchiwizowane sesje, które NIE mają jeszcze stempla `covered_by_l1` — czyli jedyny
     * poprawny materiał na nową paczkę L1. Bez tego filtra każdy przebieg konsolidacji brał
     * najstarsze pliki z `sessions/archive` niezależnie od tego, ile razy już je podsumował.
     *
     * Sortowanie ROSNĄCO po nazwie pliku (nazwy zaczynają się od daty) — okna paczek
     * (`slice(offset, offset + batchSize)`) muszą być deterministyczne między przebiegami.
     *
     */
    async listUncoveredArchiveSessions(): Promise<ArchiveSessionInfo[]> {
        const sessions = await this.listArchiveSessions();
        return sessions
            .filter(session => !String(session.covered_by_l1 || '').trim())
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * Retencja archiwum sesji — sprząta WYŁĄCZNIE sesje już wchłonięte
     * do podsumowania L1 (niepusty `covered_by_l1`).
     *
     * ⚠️ **Sesja bez stempla jest ŚWIĘTA.** To jedyny materiał na przyszłe paczki L1
     * (`listUncoveredArchiveSessions`) i jedyna pełna kopia rozmowy — nie może zniknąć ani
     * przez limit dni, ani przez limit plików. Dlatego kandydatów wybieramy z pokrytych, a limit
     * `maxFiles` liczy WSZYSTKIE pliki archiwum: gdy samych niepokrytych jest więcej niż limit,
     * kasowanie po prostu się kończy (limit zostaje przekroczony — świadomie).
     *
     * Zasada create-before-delete: stempel `covered_by_l1` powstaje dopiero PO zapisaniu paczki L1
     * na dysku (`_cleanupAfterL1`), więc kasowanie ostemplowanej sesji nigdy nie wyprzedza streszczenia.
     *
     * Best-effort jak `ConsolidationSnapshot.prune`: pad listowania albo jednego `remove` nie
     * zatrzymuje reszty i NIE rzuca — sprzątanie nie ma prawa ubić konsolidacji.
     *
     * @param config - 0 / undefined = limit wyłączony
     */
    async pruneArchive(config: { days?: number; maxFiles?: number } = {}): Promise<{ removed: number }> {
        const maxAgeDays = Math.max(0, Number(config?.days) || 0);
        const keepMax = Math.max(0, Number(config?.maxFiles) || 0);
        if (maxAgeDays === 0 && keepMax === 0) return { removed: 0 };

        const adapter = this.vault?.adapter;
        if (!adapter?.remove) return { removed: 0 };

        let sessions: ArchiveSessionInfo[];
        try {
            sessions = await this.listArchiveSessions();
        } catch (e) {
            log.warn(`AgentMemory:${this.agentName}`, 'Retencja archiwum: listowanie padło:', e);
            return { removed: 0 };
        }
        if (!Array.isArray(sessions) || sessions.length === 0) return { removed: 0 };

        // Kandydaci: TYLKO ostemplowane, od najstarszej (data sesji z frontmattera, nie mtime).
        const candidates = sessions
            .filter(session => String(session.covered_by_l1 || '').trim())
            .sort((a, b) => (a.sessionTime || 0) - (b.sessionTime || 0));

        const doomed = new Set<string>();
        if (maxAgeDays > 0) {
            const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
            for (const session of candidates) {
                // Sesja o nieustalonej dacie (brak `created` i brak `stat`) NIE liczy się jako
                // stara — nie kasujemy na podstawie zera, które znaczy „nie wiem".
                const when = Number(session.sessionTime);
                if (Number.isFinite(when) && when > 0 && when < cutoff) doomed.add(session.path);
            }
        }
        if (keepMax > 0) {
            let total = sessions.length - doomed.size;
            for (const session of candidates) {
                if (total <= keepMax) break;
                if (doomed.has(session.path)) continue;
                // Sama reguła co osiem linii wyżej w gałęzi wieku — sesja
                // o NIEUSTALONEJ dacie (sessionTime===0, brak `created` i brak `stat`) nie liczy
                // się jako „najstarsza". `candidates` jest posortowane ROSNĄCO po `sessionTime`,
                // więc bez tego warunku sesja bez daty zawsze ląduje na początku listy i ginie
                // PIERWSZA jako rzekomo najstarsza, mimo że może być najnowszą sesją w archiwum.
                const when = Number(session.sessionTime);
                if (!(Number.isFinite(when) && when > 0)) continue;
                doomed.add(session.path);
                total--;
            }
        }

        let removed = 0;
        for (const path of doomed) {
            try {
                await adapter.remove(path);
                removed++;
            } catch (e) {
                log.warn(`AgentMemory:${this.agentName}`, `Retencja archiwum: nie skasowałem ${path}:`, e);
            }
        }
        log.debug(
            `AgentMemory:${this.agentName}`,
            `Retencja archiwum (dni=${maxAgeDays}, maxPlików=${keepMax}): skasowano ${removed} z ` +
            `${candidates.length} sesji pokrytych L1 (archiwum miało ${sessions.length} plików; ` +
            `${sessions.length - candidates.length} niepokrytych nietkniętych)`
        );
        return { removed };
    }

    /**
     * Cascade after L3: usuwa L1 pokryte przez L2 wchłonięte do L3.
     * **L2 zostają nietknięte** — najwyższy poziom historii, manualny cleanup tylko.
     *
     * @param l2Names - L2 files included in the L3 we just created
     */
    async _cleanupAfterL3(l2Names: string[] | null | undefined): Promise<void> {
        if (!l2Names || l2Names.length === 0) return;

        try {
            let deletedL1s = 0;
            for (const l2Name of l2Names) {
                const l2Path = `${this.paths.l2}/${l2Name}`;
                try {
                    if (!(await this.vault.adapter.exists(l2Path))) continue;
                    const content = await this.vault.adapter.read(l2Path);
                    const fm = this._parseFrontmatter(content);
                    const l1Files: string[] = Array.isArray(fm.l1_files) ? fm.l1_files : [];
                    for (const l1Name of l1Files) {
                        const l1Path = `${this.paths.l1}/${l1Name}`;
                        try {
                            if (await this.vault.adapter.exists(l1Path)) {
                                await this.vault.adapter.remove!(l1Path);
                                deletedL1s++;
                            }
                        } catch (e) {
                            log.warn(`AgentMemory:${this.agentName}`, `Could not delete L1 ${l1Name}:`, e);
                        }
                    }
                } catch (e) {
                    log.warn(`AgentMemory:${this.agentName}`, `Could not read L2 ${l2Name} for cascade:`, e);
                }
            }
            if (deletedL1s > 0) {
                log.debug(`AgentMemory:${this.agentName}`, `Cascade L3: deleted ${deletedL1s} L1 files covered by ${l2Names.length} L2 files (L2 files KEPT)`);
            }
        } catch (e) {
            log.warn(`AgentMemory:${this.agentName}`, `Cleanup after L3 failed:`, e);
        }
    }

    // Sprzątanie sierot L1/L2 (streszczenia bez sesji źródłowej) nie ma dziś dedykowanej metody.
    // Taki mechanizm musiałby liczyć istniejące sesje z `sessions/archive/` + stempli
    // `covered_by_l1`, NIE z płaskiego `sessions/` (w Memory v3 zawsze pustego) — inaczej uznałby
    // każde L1 z referencjami za sierotę i skasował świeże streszczenia.

}

/**
 * Czysty parser `brain.log` (TSV → obiekty), OD NAJNOWSZEGO.
 *
 * Bez klasy i bez adaptera, żeby dał się przetestować i żeby UI mogło go zawołać na treści
 * przeczytanej dowolną drogą. Linie w nieznanym kształcie NIE są wyrzucane — brakujące pola
 * wracają jako puste stringi (log jest dopisywany append-only przez różne wersje pluginu;
 * cicha utrata wpisu byłaby gorsza niż wpis z dziurą).
 *
 * @param text - zawartość pliku
 * @param limit - ile najnowszych wpisów zwrócić (≤0 = wszystkie)
 */
export function parseBrainLog(text: string | null | undefined, limit = 50): BrainLogEntry[] {
    const rows = String(text || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            const [ts = '', op = '', target = '', ...rest] = line.split('\t');
            return { ts: ts.trim(), op: op.trim(), target: target.trim(), detail: rest.join(' ').trim() };
        })
        .reverse();
    return (typeof limit === 'number' && limit > 0) ? rows.slice(0, limit) : rows;
}
