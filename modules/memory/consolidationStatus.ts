/**
 * @module consolidationStatus
 * Jedno liczydło progów konsolidacji: `resolveConsolidationThresholds` + `shouldTriggerConsolidation`,
 * plus (od auto-konsolidacji opcjonalnej) polityka wyłączników i plan auto-triggera.
 *
 * Kto tego używa DZIŚ:
 *  1. `SaveSessionWorkflow.applyDecision` (`modules/memory/SaveSessionWorkflow.ts`) — woła
 *     `planAutoConsolidation` (poniżej), które samo deleguje do `resolveConsolidationThresholds`
 *     zamiast trzymać własną kopię tej samej logiki progów.
 *  2. Prywatna wtyczka deweloperska właściciela w repo `pkm-assistant-harness`
 *     (katalog `companion/`) — importuje `resolveConsolidationThresholds`/`shouldTriggerConsolidation`
 *     PRZY BUILDZIE wprost z `@plugin/modules/memory/consolidationStatus.js`. To repo pluginu nie
 *     widzi tego konsumenta w swoich testach ani typecheku.
 *
 * NAZWA TEGO PLIKU i sygnatury `resolveConsolidationThresholds`/`shouldTriggerConsolidation`
 * zostają BEZ ZMIAN bez poprawki w harnessie — zmiana = czerwony build harnessu i jego CI. Nowe
 * eksporty (`CONSOLIDATION_DEFAULTS`, `resolveAutoConsolidationPolicy`, `planAutoConsolidation`)
 * są ADDYTYWNE — harness ich nie zna i nie musi.
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
    /** Wyłącznik auto-konsolidacji gałęzi sesje/L1-L3 — domyślnie WYŁĄCZONY (`CONSOLIDATION_DEFAULTS.autoSessions`). */
    memoryV3AutoConsolidateSessions?: unknown;
    /** Wyłącznik auto-konsolidacji gałęzi notatek brain/ (dedup) — domyślnie WYŁĄCZONY (`CONSOLIDATION_DEFAULTS.autoBrain`). */
    memoryV3AutoConsolidateBrain?: unknown;
    [key: string]: unknown;
}

/**
 * Jedno źródło domyślnych progów/wyłączników konsolidacji. Silnik (ten plik, `ConsolidationRun.ts`,
 * `ArchiveWorkflow.ts`, `consolidationRunner.ts`) i UI (`SettingsContent.ts`) czytają STĄD zamiast
 * trzymać osobne kopie tych samych literałów — `10`/`20`/`5` rozsiane po kodzie rozjeżdżały się przy
 * pierwszej zmianie jednego miejsca.
 *
 * `autoSessions`/`autoBrain` domyślnie `false`: auto-konsolidacja (obie gałęzie) jest OPCJONALNA —
 * werdykt właściciela. Ręczna konsolidacja (guzik „Podsumuj rozmowy" w profilu agenta) działa
 * zawsze, niezależnie od tych dwóch wyłączników — patrz `resolveAutoConsolidationPolicy`.
 */
export const CONSOLIDATION_DEFAULTS = {
    sessionThreshold: 10,
    brainNotesLimit: 20,
    batchSize: 5,
    autoSessions: false,
    autoBrain: false,
} as const;

/** Skąd wzięty jest efektywny limit notatek `brain/` — patrz `resolveConsolidationThresholds`. */
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
 *  - próg sesji: `memoryV3SessionThreshold || archiveSessionThreshold || CONSOLIDATION_DEFAULTS.sessionThreshold`,
 *  - `batchSize` jak w `ArchiveWorkflow.ts` (`options.batchSize || settings.memoryV3ArchiveBatchSize ||
 *    CONSOLIDATION_DEFAULTS.batchSize`, tu bez `options.batchSize`, bo ten tor nie odpala żadnego przebiegu),
 *  - limit notatek `brain/`: **PODŁOGA, nie pierwszeństwo** — `Math.max(state.brain_notes_limit,
 *    ustawienie globalne || CONSOLIDATION_DEFAULTS.brainNotesLimit)`. ⚠️ ŚWIADOMA ZMIANA ZACHOWANIA
 *    (do 2.2.6 `state.brain_notes_limit` miał BEZWARUNKOWE pierwszeństwo nad ustawieniami — patrz
 *    `modules/memory/CLAUDE.md`, gotcha „Jedno liczydło progów konsolidacji"): odkąd limit ma
 *    suwak w Ustawieniach, podniesienie GLOBALNEGO limitu nie może być po cichu przykryte starą,
 *    niższą wartością zapisaną per agent (auto-bump po odrzuceniu przez usera). Auto-bump per agent
 *    nadal tylko PODNOSI `state.brain_notes_limit` — nigdy nie obniża efektywnego limitu poniżej
 *    tego, co user właśnie ustawił globalnie.
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

    const sessionThreshold = Number(s.memoryV3SessionThreshold) || Number(s.archiveSessionThreshold) || CONSOLIDATION_DEFAULTS.sessionThreshold;

    const stateLimit = Number(state?.brain_notes_limit) || 0;
    const settingsLimit = Number(s.memoryV3BrainNotesThreshold) || Number(s.archiveBrainNotesThreshold) || 0;
    const globalLimit = settingsLimit || CONSOLIDATION_DEFAULTS.brainNotesLimit;

    let brainNotesLimit: number;
    let brainNotesLimitSource: BrainNotesLimitSource;
    if (stateLimit > 0 && stateLimit >= globalLimit) {
        brainNotesLimit = stateLimit;
        brainNotesLimitSource = 'agent_state';
    } else {
        brainNotesLimit = globalLimit;
        brainNotesLimitSource = settingsLimit ? 'settings' : 'default';
    }

    const batchSize = Number(s.memoryV3ArchiveBatchSize) || CONSOLIDATION_DEFAULTS.batchSize;

    return { sessionThreshold, brainNotesLimit, brainNotesLimitSource, batchSize };
}

/** Ustawienia widziane przez politykę auto-konsolidacji — patrz `resolveAutoConsolidationPolicy`. */
export interface AutoConsolidationPolicy {
    /** Auto-konsolidacja gałęzi sesje/L1-L3 (krok(i) L1 + kaskada L2/L3). */
    sessions: boolean;
    /** Auto-konsolidacja gałęzi notatek brain/ (dedup). */
    brain: boolean;
}

/**
 * Polityka DWÓCH niezależnych wyłączników auto-konsolidacji z ustawień pluginu. Domyślnie OBA
 * `false` (`CONSOLIDATION_DEFAULTS.autoSessions`/`autoBrain`) — auto-konsolidacja jest
 * OPCJONALNA, user włącza ją świadomie w Ustawieniach. Ręczna konsolidacja (guzik „Podsumuj
 * rozmowy" w profilu agenta) NIE czyta tej polityki — działa zawsze, niezależnie od tych dwóch
 * wyłączników (`startConsolidationRun({source:'manual'})` buduje pełny plan bez `include`).
 */
export function resolveAutoConsolidationPolicy(
    settings: ConsolidationSettingsLike | null | undefined,
): AutoConsolidationPolicy {
    const s = settings || {};
    return {
        sessions: s.memoryV3AutoConsolidateSessions === true,
        brain: s.memoryV3AutoConsolidateBrain === true,
    };
}

/** Które gałęzie planu konsolidacji budować — kształt konsumowany przez `buildConsolidationPlan`. */
export interface AutoConsolidationInclude {
    sessions: boolean;
    dedup: boolean;
}

/** Wynik `planAutoConsolidation` — czy w ogóle odpalać automat, i jakie gałęzie planu wpuścić. */
export interface AutoConsolidationPlan {
    trigger: boolean;
    include: AutoConsolidationInclude;
}

/**
 * Plan auto-triggera konsolidacji po zapisie sesji — łączy politykę wyłączników
 * (`resolveAutoConsolidationPolicy`) z progami (`resolveConsolidationThresholds`).
 *
 * `include.dedup`/`include.sessions` odzwierciedlają WPROST politykę (nie to, czy dana gałąź akurat
 * jest „due"): gdy trigger zapada przez próg sesji, a gałąź notatek brain/ jest włączona, ale jeszcze
 * nie przebiła własnego limitu, krok dedup i tak wchodzi do planu jako propozycja — tak jak dotychczas
 * (krok dedup to zawsze tylko PROPOZYCJA do przeglądu, wchodzi gdy gałąź jest w ogóle włączona).
 * Wyłączona gałąź (`policy.sessions`/`policy.brain === false`) nigdy nie trafia do `include`,
 * niezależnie od tego, czy jej próg jest przebity.
 */
export function planAutoConsolidation(
    state: ConsolidationStateLike | null | undefined,
    brainNotesCount: number,
    settings: ConsolidationSettingsLike | null | undefined,
): AutoConsolidationPlan {
    const policy = resolveAutoConsolidationPolicy(settings);
    const { sessionThreshold, brainNotesLimit } = resolveConsolidationThresholds(state, settings);
    const sessionsDue = Number(state?.archived_since_last_consolidation || 0) >= sessionThreshold;
    const brainDue = (Number(brainNotesCount) || 0) > brainNotesLimit;
    const trigger = (policy.sessions && sessionsDue) || (policy.brain && brainDue);
    return {
        trigger,
        include: { sessions: policy.sessions, dedup: policy.brain },
    };
}

/**
 * Czy próg konsolidacji jest przebity — sesje `>=`, notatki `>`, BEZ WZGLĘDU na wyłączniki
 * auto-konsolidacji (`resolveAutoConsolidationPolicy`) — to liczydło pyta wyłącznie o same progi.
 * Produkcyjny trigger po zapisie sesji (`SaveSessionWorkflow.applyDecision`) idzie przez
 * `planAutoConsolidation` (bo MUSI też sprawdzić wyłączniki); ta funkcja zostaje dla
 * konsumenta w repo harnessu (diagnostyka „czy próg jest przebity" niezależna od ustawień UI,
 * których harness nie zna) i dla sygnatury zamrożonej nagłówkiem tego pliku.
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
