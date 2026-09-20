/**
 * @module consolidationStatus
 * Status konsolidacji pamięci JEDNEGO agenta.
 *
 * Powód istnienia: diagnostyka (CLI `memory-status`) potrzebuje dokładnie tej samej decyzji
 * "czy konsolidacja by wystartowała", jaką liczy produkcyjny trigger
 * (`modules/chat/consolidationRunner.ts:startConsolidationRun` przez
 * `SaveSessionWorkflow._shouldTriggerArchive`), ale bez odpalania modelu, modalu ani zapisu.
 * `resolveConsolidationThresholds`/`shouldTriggerConsolidation` są tym JEDNYM liczydłem —
 * `SaveSessionWorkflow._shouldTriggerArchive` deleguje do `shouldTriggerConsolidation` zamiast
 * trzymać własną kopię tej samej logiki (patrz `SaveSessionWorkflow.ts`).
 *
 * **Kontrakt zapisu, PRAWDZIWIE (nie "zero zapisu" bez zastrzeżeń):** na ROZGRZANEJ instancji
 * (taką trzyma `AgentManager.agentMemories` dla każdego agenta, którego ktoś już użył)
 * `getConsolidationStatus` jest czystym odczytem — zero write/mkdir, nawet gdy `.state.json`
 * albo `brain/` zniknęły spod instancji PO starcie (`peek()` zamiast `read()`, pominięty
 * `listActiveSessions()`, warunkowy `listBrainNotes()` — patrz niżej). Na ZIMNEJ instancji
 * (agent, którego jeszcze nikt nie użył) `listUncoveredArchiveSessions()` i tak woła
 * `ensureMemoryStructure()` i materializuje strukturę na dysku — to jest ZNANE i AKCEPTOWANE,
 * nie naprawiane w tym pliku (naprawą byłaby zmiana `AgentMemory.listArchiveSessions`, poza
 * zakresem tej diagnostyki).
 */

import { buildPlan as buildConsolidationPlan } from './ConsolidationRun.js';

import type { AgentMemory, BrainNoteInfo } from './AgentMemory.js';

/**
 * Skąd pochodzi wynik czystego odczytu `.state.json` (`StateManager.peek()`).
 * `'missing'` — plik nie istnieje (potwierdzone `probeFile`), zwrócone defaulty NIC nie zapisały
 * na dysk. `'unreadable'` — plik jest, ale odczyt albo parsowanie JSON padły (uszkodzony plik,
 * błąd I/O) — też defaulty, też bez zapisu. `'file'` — realna zawartość z dysku.
 */
export type MemoryStateSource = 'file' | 'missing' | 'unreadable';

/** Skąd wzięty jest limit notatek `brain/` — ten sam łańcuch pierwszeństwa co `_shouldTriggerArchive`. */
export type BrainNotesLimitSource = 'agent_state' | 'settings' | 'default';

/**
 * `.state.json` w zakresie, który czytają progi konsolidacji. Pola nazwane jako `unknown`
 * (nie `number`) celowo — wołacz podaje zarówno `MemoryState` (pola już typowane liczbowo), jak
 * i surowy worek ustawień pluginu; walidacja liczbowa (`Number(...)`) dzieje się WEWNĄTRZ tego
 * modułu, na granicy, nie u każdego wołacza z osobna.
 */
export interface ConsolidationStateLike {
    archived_since_last_consolidation?: unknown;
    brain_notes_limit?: unknown;
    last_archive_at?: unknown;
    [key: string]: unknown;
}

/** Ustawienia pluginu w zakresie, który czytają progi konsolidacji — patrz `ConsolidationStateLike`. */
export interface ConsolidationSettingsLike {
    memoryV3SessionThreshold?: unknown;
    archiveSessionThreshold?: unknown;
    memoryV3BrainNotesThreshold?: unknown;
    archiveBrainNotesThreshold?: unknown;
    memoryV3ArchiveBatchSize?: unknown;
    [key: string]: unknown;
}

/** Wynik `resolveConsolidationThresholds` — progi gotowe do porównania, plus skąd wzięty jest limit notatek. */
export interface ConsolidationThresholds {
    sessionThreshold: number;
    brainNotesLimit: number;
    brainNotesLimitSource: BrainNotesLimitSource;
    batchSize: number;
}

/** Status konsolidacji jednego agenta — kontrakt danych CLI `memory-status`. */
export interface ConsolidationStatus {
    agent: string;
    state: { source: MemoryStateSource; lastArchiveAt: string | null };
    brainNotes: { count: number; limit: number; limitSource: BrainNotesLimitSource; overLimit: boolean };
    sessions: {
        archivedSinceLastConsolidation: number;
        threshold: number;
        overThreshold: boolean;
        uncoveredArchive: number;
        /** Pliki `.md` liczone z DYSKU (listowanie `sessions/active/`, bez `.discarded/`). */
        activeFiles: number;
        /**
         * `.state.json`.`active_sessions.length` — liczone ze STANU, niezależnie od `activeFiles`.
         * Diagnostyka rozjazdu: agent może mieć w stanie sesję, której pliku już nie ma na dysku
         * (zombie), albo na odwrót. Rozjazd sam w sobie nie jest błędem tej funkcji — jest
         * dokładnie tym, co ta para pól ma pokazać.
         */
        stateActive: number;
    };
    summaries: { uncoveredL1: number; uncoveredL2: number; batchSize: number };
    /** Ta sama decyzja co `SaveSessionWorkflow._shouldTriggerArchive` / `shouldTriggerConsolidation`. */
    wouldTrigger: boolean;
    /** Kroki z `buildConsolidationPlan`, w kolejności, tylko `kind` (bez metadanych/propozycji). */
    plan: Array<{ kind: string }>;
}

/**
 * Progi konsolidacji z liczników `.state.json` + ustawień pluginu.
 *
 * DOKŁADNIE ta sama logika i kolejność fallbacków co dotychczasowe
 * `SaveSessionWorkflow._shouldTriggerArchive`:
 *  - próg sesji: `memoryV3SessionThreshold || archiveSessionThreshold || 10`,
 *  - limit notatek `brain/`: `state.brain_notes_limit` (per-agent, auto-bump po odrzuceniu przez
 *    usera) ma PIERWSZEŃSTWO nad ustawieniami globalnymi; dopiero potem
 *    `memoryV3BrainNotesThreshold || archiveBrainNotesThreshold || 20`,
 *  - `batchSize` jak w `ArchiveWorkflow.ts` (`options.batchSize || settings.memoryV3ArchiveBatchSize || 5`,
 *    tu bez `options.batchSize`, bo ten tor nie odpala żadnego przebiegu).
 *
 * `Number(x) || fallback` traktuje `0`, `NaN` i brak wartości identycznie jak oryginalne `||`
 * łańcuchy na surowych ustawieniach (zero progu = "nieustawione", nie "wyłączone") — świadoma
 * zgodność 1:1, nie nowa reguła.
 */
export function resolveConsolidationThresholds(
    state: ConsolidationStateLike | null | undefined,
    settings: ConsolidationSettingsLike | null | undefined,
): ConsolidationThresholds {
    const s = settings || {};

    const sessionThreshold = Number(s.memoryV3SessionThreshold) || Number(s.archiveSessionThreshold) || 10;

    const stateLimit = Number(state?.brain_notes_limit) || 0;
    let brainNotesLimit: number;
    let brainNotesLimitSource: BrainNotesLimitSource;
    if (stateLimit) {
        brainNotesLimit = stateLimit;
        brainNotesLimitSource = 'agent_state';
    } else {
        const settingsLimit = Number(s.memoryV3BrainNotesThreshold) || Number(s.archiveBrainNotesThreshold) || 0;
        if (settingsLimit) {
            brainNotesLimit = settingsLimit;
            brainNotesLimitSource = 'settings';
        } else {
            brainNotesLimit = 20;
            brainNotesLimitSource = 'default';
        }
    }

    const batchSize = Number(s.memoryV3ArchiveBatchSize) || 5;

    return { sessionThreshold, brainNotesLimit, brainNotesLimitSource, batchSize };
}

/**
 * Próg dedupu podawany do `buildConsolidationPlan` — DOKŁADNIE ta sama formuła co produkcyjny
 * `modules/chat/consolidationRunner.ts:startConsolidationRun` (plik tylko do odczytu): baza
 * `settings.memoryV3BrainNotesThreshold || 20`, nadpisana przez `state.brain_notes_limit`, gdy
 * ten jest ustawiony.
 *
 * CELOWO bez fallbacku na `archiveBrainNotesThreshold` — w odróżnieniu od
 * `resolveConsolidationThresholds` (który ten fallback ma, bo liczy próg dla `wouldTrigger`/
 * `brainNotes.limit`, gdzie "jedno liczydło" już obowiązuje). Te dwie funkcje CELOWO liczą różne
 * rzeczy: `resolveConsolidationThresholds` to decyzja „czy odpalić konsolidację",
 * `resolvePlanDedupThreshold` to metadana JEDNEGO kroku planu (`buildConsolidationPlan` jej dziś
 * i tak nie używa do gatingu — krok `dedup` pojawia się od `brainNotesCount >= 2`, niezależnie od
 * progu, patrz komentarz w `ConsolidationRun.ts`). Kopiowanie formuły 1:1 z produkcji zamiast
 * delegacji do "jednego liczydła" jest tu świadome — inaczej diagnostyka pokazywałaby inny próg
 * dedupu niż realnie policzyłby produkcyjny trigger.
 */
export function resolvePlanDedupThreshold(
    state: ConsolidationStateLike | null | undefined,
    settings: ConsolidationSettingsLike | null | undefined,
): number {
    const base = Number(settings?.memoryV3BrainNotesThreshold) || 20;
    return Number(state?.brain_notes_limit) || base;
}

/**
 * Czy próg konsolidacji jest przebity — sesje `>=`, notatki `>` (dokładnie jak dotychczasowe
 * `_shouldTriggerArchive`). Jedno liczydło dla produkcyjnego triggera i diagnostyki CLI.
 */
export function shouldTriggerConsolidation(
    state: ConsolidationStateLike | null | undefined,
    brainNotesCount: number,
    settings: ConsolidationSettingsLike | null | undefined,
): boolean {
    const { sessionThreshold, brainNotesLimit } = resolveConsolidationThresholds(state, settings);
    return Number(state?.archived_since_last_consolidation || 0) >= sessionThreshold
        || (Number(brainNotesCount) || 0) > brainNotesLimit;
}

/**
 * Wycinek `AgentMemory`, jakiego potrzebuje czyste liczenie sesji aktywnych i notatek `brain/`
 * — `Pick`, nie cała klasa, bo to jedyne dwa pola, które te dwie funkcje czytają.
 */
type MemoryFsView = Pick<AgentMemory, 'vault' | 'paths'>;

/**
 * Liczba plików sesji aktywnych — CZYSTY odczyt katalogu (`agentMemory.paths.sessionsActive`),
 * BEZ wołania `AgentMemory.listActiveSessions()`. Ta metoda idzie przez `stateManager.read()`,
 * który BOOTSTRAPUJE `.state.json` (zapisuje domyślny plik), gdy ten zniknął — niedopuszczalne
 * dla czystej diagnostyki na rozgrzanej instancji (P3).
 *
 * Filtr odzwierciedla `AgentMemory.listActiveSessions()`: tylko `.md` BEZPOŚREDNIO w folderze —
 * sesje odłożone przy draft/discard żyją w podfolderze `.discarded/` i nie są już aktywne. Brak
 * folderu albo pad listowania → `0`, bez tworzenia czegokolwiek.
 */
async function countActiveSessionFiles(agentMemory: MemoryFsView): Promise<number> {
    try {
        const listed = await agentMemory.vault.adapter.list(agentMemory.paths.sessionsActive);
        const prefix = `${agentMemory.paths.sessionsActive}/`;
        let count = 0;
        for (const filePath of listed?.files || []) {
            if (!filePath.endsWith('.md')) continue;
            const rest = filePath.startsWith(prefix) ? filePath.slice(prefix.length) : (filePath.split('/').pop() as string);
            if (rest.includes('/')) continue;
            count++;
        }
        return count;
    } catch {
        return 0;
    }
}

/**
 * Notatki `brain/` — TYLKO gdy folder już istnieje. `AgentMemory.listBrainNotes()` sam zakłada
 * folder (`mkdir`), gdy go nie ma — normalne dla użycia produkcyjnego (agent, który dopiero
 * zaczyna pisać notatki), niedopuszczalne dla diagnostyki na rozgrzanej instancji, która nie ma
 * prawa materializować struktury agenta spod którego zniknęła (P3).
 */
async function listBrainNotesIfPresent(agentMemory: MemoryFsView & Pick<AgentMemory, 'listBrainNotes'>): Promise<BrainNoteInfo[]> {
    const exists = await agentMemory.vault.adapter.exists(agentMemory.paths.brainNotes);
    if (!exists) return [];
    return agentMemory.listBrainNotes();
}

/**
 * Status konsolidacji jednego agenta — czyta przez ISTNIEJĄCE metody instancji (żadnego
 * bebechowego dostępu do plików), poza dwoma czystymi wyjątkami wyżej (`countActiveSessionFiles`/
 * `listBrainNotesIfPresent`), które świadomie OMIJAJĄ metody instancji, żeby ominąć ich efekty
 * uboczne. `stateManager.peek()` zamiast `stateManager.read()` — status nie ma prawa
 * zbootstrapować `.state.json` agenta, którego jeszcze nikt nie użył.
 *
 * SEKWENCYJNIE, nie `Promise.all`: `listUncoveredArchiveSessions()` woła `ensureMemoryStructure()`
 * (memoizowane per instancja, ale flaga `_structureEnsured` zapala się dopiero PO całym
 * bootstrapie) — na zimnej instancji dwa wywołania, które obie trafiają w `ensureMemoryStructure`
 * zanim któreś zdąży ustawić flagę, odpalają bootstrap DWA RAZY równolegle (zmierzone: podwójny
 * `mkdir` na każdym z jedenastu folderów). Dziś tylko jedno z pięciu wywołań niżej dotyka
 * `ensureMemoryStructure` (dlatego usunięcie `listActiveSessions()` już samo w sobie likwiduje
 * wyścig), ale kolejność sekwencyjna zostaje jako świadoma ochrona na przyszłość, nie na
 * dzisiejszy przypadek.
 *
 * Pad pojedynczego odczytu (np. `listBrainNotes` na uszkodzonym pliku) leci w górę jako wyjątek
 * — wołacz (CLI `memory-status`, agent-po-agencie) łapie go per agent, żeby jeden zepsuty agent
 * nie zgasił statusu reszty.
 */
export async function getConsolidationStatus(agentMemory: AgentMemory): Promise<ConsolidationStatus> {
    const { state, source } = await agentMemory.stateManager.peek();

    const brainNotes = await listBrainNotesIfPresent(agentMemory);
    const uncoveredArchive = await agentMemory.listUncoveredArchiveSessions();
    const activeFiles = await countActiveSessionFiles(agentMemory);
    const uncoveredL1 = await agentMemory.listUncoveredL1s();
    const uncoveredL2 = await agentMemory.listUncoveredL2s();

    const thresholds = resolveConsolidationThresholds(state, agentMemory.settings);
    const brainNotesCount = brainNotes.length;
    const archivedSinceLastConsolidation = Number(state.archived_since_last_consolidation || 0);

    const plan = buildConsolidationPlan({
        archiveCount: uncoveredArchive.length,
        batchSize: thresholds.batchSize,
        brainNotesCount,
        dedupThreshold: resolvePlanDedupThreshold(state, agentMemory.settings),
        l1Count: uncoveredL1.length,
        l2Count: uncoveredL2.length,
    });

    return {
        agent: agentMemory.agentName,
        state: { source, lastArchiveAt: state.last_archive_at ?? null },
        brainNotes: {
            count: brainNotesCount,
            limit: thresholds.brainNotesLimit,
            limitSource: thresholds.brainNotesLimitSource,
            overLimit: brainNotesCount > thresholds.brainNotesLimit,
        },
        sessions: {
            archivedSinceLastConsolidation,
            threshold: thresholds.sessionThreshold,
            overThreshold: archivedSinceLastConsolidation >= thresholds.sessionThreshold,
            uncoveredArchive: uncoveredArchive.length,
            activeFiles,
            stateActive: state.active_sessions.length,
        },
        summaries: {
            uncoveredL1: uncoveredL1.length,
            uncoveredL2: uncoveredL2.length,
            batchSize: thresholds.batchSize,
        },
        wouldTrigger: shouldTriggerConsolidation(state, brainNotesCount, agentMemory.settings),
        plan: plan.map(step => ({ kind: step.kind })),
    };
}
