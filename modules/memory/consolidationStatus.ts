/**
 * @module consolidationStatus
 * Jedno liczydło progów konsolidacji: `resolveConsolidationThresholds` + `shouldTriggerConsolidation`.
 *
 * Kto tego używa DZIŚ:
 *  1. `SaveSessionWorkflow._shouldTriggerArchive` (`modules/memory/SaveSessionWorkflow.ts`) —
 *     deleguje tutaj zamiast trzymać własną kopię tej samej logiki.
 *  2. Prywatna wtyczka deweloperska właściciela w repo `pkm-assistant-harness`
 *     (katalog `companion/`) — importuje obie funkcje PRZY BUILDZIE
 *     wprost z `@plugin/modules/memory/consolidationStatus.js`. To repo pluginu nie widzi tego
 *     konsumenta w swoich testach ani typecheku.
 *
 * NAZWA TEGO PLIKU i sygnatury tych dwóch funkcji zostają BEZ ZMIAN bez poprawki w harnessie —
 * zmiana = czerwony build harnessu i jego CI.
 *
 * Status konsolidacji dla CLI Obsidiana (dawne `getConsolidationStatus`, `resolvePlanDedupThreshold`,
 * `StateManager.peek()` i cała reszta diagnostyki) mieszka OD 2026-09-20 poza tym repo — werdykt
 * właściciela: wewnętrzne narzędzia do pracy nad pluginem nie wchodzą do jego repo.
 */

/**
 * Wycinek `.state.json`, jaki czytają progi konsolidacji. Pola nazwane jako `unknown`
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

/** Skąd wzięty jest limit notatek `brain/` — ten sam łańcuch pierwszeństwa co `_shouldTriggerArchive`. */
export type BrainNotesLimitSource = 'agent_state' | 'settings' | 'default';

/** Wynik `resolveConsolidationThresholds` — progi gotowe do porównania, plus skąd wzięty jest limit notatek. */
export interface ConsolidationThresholds {
    sessionThreshold: number;
    brainNotesLimit: number;
    brainNotesLimitSource: BrainNotesLimitSource;
    batchSize: number;
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
 * `_shouldTriggerArchive`). Jedno liczydło dla produkcyjnego triggera i dla konsumenta w
 * repo harnessu.
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
