/**
 * @module consolidationStatus
 * Jedno liczydło progów konsolidacji: `resolveConsolidationThresholds` + `shouldTriggerConsolidation`,
 * plus (od auto-konsolidacji opcjonalnej) polityka wyłączników i plan auto-triggera.
 *
 * Kto tego używa DZIŚ:
 *  1. `SaveSessionWorkflow.applyDecision` (`modules/memory/SaveSessionWorkflow.ts`) — woła
 *     `planAutoConsolidation` (poniżej), które samo deleguje do `resolveConsolidationThresholds`
 *     zamiast trzymać własną kopię tej samej logiki progów.
 *  2. `modules/chat/consolidationRunner.ts` (przez barrel) — liczy próg dedupu/batchSize
 *     `resolveConsolidationThresholds`, a `include` obronnie w głąb przez `planAutoConsolidation`.
 *  3. Prywatna wtyczka deweloperska właściciela w repo `pkm-assistant-harness`
 *     (katalog `companion/`, plik `memoryStatus.ts`) — importuje
 *     `resolveConsolidationThresholds`/`shouldTriggerConsolidation` PRZY BUILDZIE wprost z
 *     `@plugin/modules/memory/consolidationStatus.js`. To repo pluginu nie widzi tego konsumenta
 *     w swoich testach ani typecheku.
 *
 * NAZWA TEGO PLIKU i sygnatury `resolveConsolidationThresholds`/`shouldTriggerConsolidation`
 * zostają BEZ ZMIAN bez poprawki w harnessie — zmiana = czerwony build harnessu i jego CI.
 *
 * ⚠️ **Harness NIE JEST na bieżąco z auto-konsolidacją opcjonalną — jego diagnostyka dziś KŁAMIE.**
 * `companion/memoryStatus.ts` liczy `wouldTrigger` przez `shouldTriggerConsolidation`, która z
 * DEFINICJI ignoruje oba wyłączniki auto-konsolidacji (`memoryV3AutoConsolidateSessions`/`Brain`)
 * — CLI hosta pokaże „konsolidacja by się odpaliła" nawet wtedy, gdy oba wyłączniki są WYŁĄCZONE
 * (czyli w produkcji nic by się nie odpaliło). Do tego `companion`'s `resolvePlanDedupThreshold`
 * to CELOWO osobna, starsza formuła (bez podłogi z tego pliku) — po tej naprawie rozjeżdża się
 * jeszcze bardziej z tym, co realnie liczy plugin. Naprawa (przejście `memoryStatus.ts` na
 * `planAutoConsolidation` + `resolveConsolidationThresholds` z tego pliku) należy do repo
 * harnessu, PO zmergowaniu tej gałęzi do `main` — nie jest zrobiona tutaj, bo to repo nie ma
 * prawa dotykać harnessu. Nowe eksporty tego pliku (`CONSOLIDATION_DEFAULTS`,
 * `resolveAutoConsolidationPolicy`, `planAutoConsolidation`) są addytywne (nie psują istniejącego
 * builda harnessu), ale dopóki `memoryStatus.ts` po nie nie sięgnie, jego `wouldTrigger` i
 * `dedupThreshold` zostają nieaktualne.
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
 * `ArchiveWorkflow.ts`) i UI (`SettingsContent.ts`) czytają STĄD zamiast trzymać osobne kopie
 * tych samych literałów — `10`/`20`/`5` rozsiane po kodzie rozjeżdżały się przy pierwszej
 * zmianie jednego miejsca. `modules/chat/consolidationRunner.ts` NIE importuje tej stałej
 * bezpośrednio (poza modułem, żadnego powodu) — dostaje te same domyślne przez
 * `resolveConsolidationThresholds`/`planAutoConsolidation`, które ją czytają za niego.
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
 *    (do 2.2.8 włącznie `state.brain_notes_limit` miał BEZWARUNKOWE pierwszeństwo nad ustawieniami — patrz
 *    `modules/memory/CLAUDE.md`, gotcha „Jedno liczydło progów konsolidacji"): odkąd limit ma
 *    suwak w Ustawieniach, podniesienie GLOBALNEGO limitu nie może być po cichu przykryte starą,
 *    niższą wartością zapisaną per agent (auto-bump po odrzuceniu przez usera). Auto-bump per agent
 *    nadal tylko PODNOSI `state.brain_notes_limit` — nigdy nie obniża efektywnego limitu poniżej
 *    tego, co user właśnie ustawił globalnie.
 *
 * `firstPositive(...)` traktuje `0`, `NaN` I liczby UJEMNE identycznie jak brak wartości -
 * "nieustawione", nie "wyłączone" (świadoma zgodność z oryginalnym `||` łańcuchem na `0`/`NaN`,
 * plus naprawa recenzji #9: `Number(-5) || fallback` zwracało dosłownie `-5`, bo `-5` jest
 * truthy w JS - próg `-5` z ręcznie edytowanego `data.json` znaczył „ZAWSZE due", zamiast
 * spaść na domyślną wartość jak każde inne nieprawidłowe wejście).
 */
function firstPositive(...values: unknown[]): number | null {
    for (const value of values) {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
}

export function resolveConsolidationThresholds(
    state: ConsolidationStateLike | null | undefined,
    settings: ConsolidationSettingsLike | null | undefined,
): ConsolidationThresholds {
    const s = settings || {};

    const sessionThreshold = firstPositive(s.memoryV3SessionThreshold, s.archiveSessionThreshold) ?? CONSOLIDATION_DEFAULTS.sessionThreshold;

    const stateLimit = firstPositive(state?.brain_notes_limit) ?? 0;
    const settingsLimit = firstPositive(s.memoryV3BrainNotesThreshold, s.archiveBrainNotesThreshold) ?? 0;
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

    const batchSize = firstPositive(s.memoryV3ArchiveBatchSize) ?? CONSOLIDATION_DEFAULTS.batchSize;

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
    // `?? CONSOLIDATION_DEFAULTS.autoX` (nie goły `=== true`) - te dwa pola stałej były martwe
    // (recenzja #8): nikt ich nie czytał, mimo że CLAUDE.md obiecuje "JEDNO źródło" dla
    // WSZYSTKICH pięciu pól. Wynik jest dziś identyczny (`autoSessions`/`autoBrain` = `false`),
    // ale odkąd Kuba zmieni default w JEDNYM miejscu, ta funkcja go realnie usłyszy.
    return {
        sessions: (s.memoryV3AutoConsolidateSessions ?? CONSOLIDATION_DEFAULTS.autoSessions) === true,
        brain: (s.memoryV3AutoConsolidateBrain ?? CONSOLIDATION_DEFAULTS.autoBrain) === true,
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
 * ⚠️ **`include.sessions`/`include.dedup` wymagają OBU warunków: wyłącznik WŁĄCZONY *I* próg
 * PRZEBITY** (`policy.sessions && sessionsDue`, `policy.brain && brainDue`) — DECYZJA recenzji
 * z 2026-09-22, zmiana względem pierwszej wersji tej funkcji (tam `include` odzwierciedlało samą
 * politykę, niezależnie od „due"). Powód: przy OBU wyłącznikach włączonych i triggerze z gałęzi
 * sesji, stara wersja i tak wpuszczała `dedup:true` do planu, choćby próg notatek brain/ wcale
 * nie był przebity — user, który WŁAŚNIE odrzucił propozycję dedup (licznik/limit wyciszony),
 * dostawał ją z powrotem przy najbliższym zapisie, gdy tylko próg SESJI się przebił. To łamało
 * obietnicę UI „odrzucona propozycja nie wraca przy następnym zapisie". Teraz każda gałąź wchodzi
 * do planu WYŁĄCZNIE wtedy, gdy sama jest i włączona, i due — `trigger` wynika z tych samych
 * dwóch flag (`includeSessions || includeDedup`), więc nie ma już osobnej, rozjeżdżającej się
 * definicji.
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
    const includeSessions = policy.sessions && sessionsDue;
    const includeDedup = policy.brain && brainDue;
    return {
        trigger: includeSessions || includeDedup,
        include: { sessions: includeSessions, dedup: includeDedup },
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
