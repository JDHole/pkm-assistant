/**
 * @module consolidationStatus
 * Status konsolidacji pamięci JEDNEGO agenta — czysty odczyt, zero zapisu, zero UI.
 *
 * Powód istnienia: diagnostyka (CLI `memory-status`) potrzebuje dokładnie tej samej decyzji
 * "czy konsolidacja by wystartowała", jaką liczy produkcyjny trigger
 * (`modules/chat/consolidationRunner.ts:startConsolidationRun` przez
 * `SaveSessionWorkflow._shouldTriggerArchive`), ale bez odpalania modelu, modalu ani zapisu.
 * `resolveConsolidationThresholds`/`shouldTriggerConsolidation` są tym JEDNYM liczydłem —
 * `SaveSessionWorkflow._shouldTriggerArchive` deleguje do `shouldTriggerConsolidation` zamiast
 * trzymać własną kopię tej samej logiki (patrz `SaveSessionWorkflow.ts`).
 */

import { buildPlan as buildConsolidationPlan } from './ConsolidationRun.js';

import type { AgentMemory } from './AgentMemory.js';

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
        activeFiles: number;
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
 * Status konsolidacji jednego agenta — czyta przez ISTNIEJĄCE metody instancji (żadnego
 * bebechowego dostępu do plików). `stateManager.peek()` zamiast `stateManager.read()` — status
 * nie ma prawa zbootstrapować `.state.json` agenta, którego jeszcze nikt nie użył.
 *
 * Pad pojedynczego odczytu (np. `listBrainNotes` na uszkodzonym pliku) leci w górę jako wyjątek
 * — wołacz (CLI `memory-status`, agent-po-agencie) łapie go per agent, żeby jeden zepsuty agent
 * nie zgasił statusu reszty.
 */
export async function getConsolidationStatus(agentMemory: AgentMemory): Promise<ConsolidationStatus> {
    const { state, source } = await agentMemory.stateManager.peek();
    const [brainNotes, uncoveredArchive, activeSessions, uncoveredL1, uncoveredL2] = await Promise.all([
        agentMemory.listBrainNotes(),
        agentMemory.listUncoveredArchiveSessions(),
        agentMemory.listActiveSessions(),
        agentMemory.listUncoveredL1s(),
        agentMemory.listUncoveredL2s(),
    ]);

    const thresholds = resolveConsolidationThresholds(state, agentMemory.settings);
    const brainNotesCount = brainNotes.length;
    const archivedSinceLastConsolidation = Number(state.archived_since_last_consolidation || 0);

    const plan = buildConsolidationPlan({
        archiveCount: uncoveredArchive.length,
        batchSize: thresholds.batchSize,
        brainNotesCount,
        dedupThreshold: thresholds.brainNotesLimit,
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
            activeFiles: activeSessions.length,
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
