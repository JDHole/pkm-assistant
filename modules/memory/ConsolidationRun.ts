/**
 * @module ConsolidationRun
 * Stan JEDNEGO przebiegu konsolidacji pamięci.
 *
 * Problem, który to rozwiązuje: cykl zapisu sesji + konsolidacji potrafi strzelić 5× do LLM,
 * z czego 4 strzały leciały bez ŻADNEGO UI (modal review pojawiał się dopiero z gotowym
 * wynikiem). Nikt nie wiedział, ile jeszcze zostało, co się udało, a co padło. Ta klasa jest
 * jedynym źródłem prawdy o przebiegu: plan kroków, ich statusy, wyniki, decyzje usera, koszt.
 *
 * ZERO UI, ZERO Obsidiana, ZERO I/O - czysty node, w pełni testowalny (`ConsolidationRun.test.js`).
 * Etykiety kroków (i18n) składa UI z pól `kind` / `index` / `total` - tu nie ma stringów usera.
 *
 * Cykl życia kroku:
 *
 *   pending ──startStep──> running ──stepProposalReady──> awaiting_review
 *                             │                                  │
 *                             │                             beginApply
 *                        markStalled (1×)                        ↓
 *                             │                              applying ──completeStep──> done
 *                             ↓
 *                          failed  <──failStep── (running | applying)
 *
 *   gated ──ungate──> pending          (L2/L3 czekają na rozstrzygnięcie niższego poziomu)
 *   dowolny nierozstrzygnięty ──skipStep──> skipped
 *   failed ──startStep──> running       (ręczne „Ponów" z UI; kasuje licznik retry)
 *
 * Nielegalne przejście rzuca - to celowe. Lepiej wywalić się na ławce testowej niż wpuścić
 * modal w stan, którego nikt nie przewidział.
 */

/** Statusy kroku. */
export const STEP_STATUS = {
    PENDING: 'pending',
    RUNNING: 'running',
    AWAITING_REVIEW: 'awaiting_review',
    APPLYING: 'applying',
    DONE: 'done',
    FAILED: 'failed',
    SKIPPED: 'skipped',
    GATED: 'gated',
} as const;

export type StepStatus = (typeof STEP_STATUS)[keyof typeof STEP_STATUS];

/**
 * Rodzaje kroków. `save_proposals` (rezerwacja dla `/save session`) nie istnieje - droga
 * zapisu sesji przez konsolidację została odrzucona na rzecz poczekalni rescue (patrz
 * `brain/pending_rescue/` w CLAUDE.md), więc ta rezerwacja nigdy nie dostała producenta.
 */
export const STEP_KIND = {
    DEDUP: 'dedup',
    L1: 'l1',
    L2: 'l2',
    L3: 'l3',
} as const;

export type StepKind = (typeof STEP_KIND)[keyof typeof STEP_KIND];

/** Błąd widziany przez maszynę stanów - bierzemy z niego tylko te dwa pola. */
type ErrLike = { message?: string; code?: string };

/** Znormalizowany licznik zużycia tokenów jednego kroku / całego przebiegu. */
export interface StepUsage {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    calls: number;
}

/** To samo bez `calls` - wynik `normalizeUsage` z JEDNEGO strzału. */
export type NormalizedUsage = Omit<StepUsage, 'calls'>;

/**
 * Metadane kroku. Nazwane pola to te, które realnie czyta silnik / UI; index signature
 * odwzorowuje fakt, że `meta` jest wolnym workiem (`skipReason` dokłada `skipStep`,
 * `sessions` zamraża generator paczki L1).
 */
export interface ConsolidationStepMeta {
    batchSize?: number;
    offset?: number;
    /** zamrożone okno paczki L1 (nazwy plików sesji) */
    sessions?: string[];
    skipReason?: string;
    brainNotesCount?: number;
    dedupThreshold?: number;
    gatedBy?: string;
    [key: string]: unknown;
}

/**
 * Propozycja kroku. Kształt zależy od `kind` (dedup → `merges`/`deletions`,
 * L1/L2/L3 → `body` + listy pokrytych plików), stąd jedna unia pól opcjonalnych.
 */
export interface ConsolidationStepResult {
    level?: string;
    name?: string;
    body?: string;
    sessions?: string[];
    l1_files?: string[];
    l2_files?: string[];
    merges?: unknown[];
    deletions?: unknown[];
    /** `false` = propozycja sklejona deterministycznie, bez modelu (spec H) */
    llmDriven?: boolean;
    [key: string]: unknown;
}

/** Co powstało po zapisie kroku (wynik `ArchiveWorkflow._applyStep`). */
export interface ConsolidationStepApplied {
    created?: number;
    name?: string;
    merged?: number;
    deleted?: number;
    autoBumpedBrainNoteLimit?: boolean;
    [key: string]: unknown;
}

/** Specyfikacja kroku (bez stanu runtime) - wynik `buildPlan` albo wejście z testu/UI. */
export interface ConsolidationStepSpec {
    id: string;
    kind: string;
    status?: StepStatus;
    index?: number;
    total?: number;
    meta?: ConsolidationStepMeta;
}

/** Krok przebiegu ze stanem runtime. */
export interface ConsolidationStep {
    id: string;
    kind: string;
    status: StepStatus;
    index: number | null;
    total: number | null;
    meta: ConsolidationStepMeta;
    result: ConsolidationStepResult | null;
    decision: unknown;
    usage: StepUsage;
    startedAt: number | null;
    endedAt: number | null;
    retryCount: number;
    error: { message: string; code: string | null } | null;
    /** ustawiane dopiero przez `completeStep` */
    applied?: ConsolidationStepApplied | null;
}

/** Krok jest „rozstrzygnięty", gdy nikt już nic z nim nie zrobi w tym przebiegu. */
const SETTLED = new Set<string>([STEP_STATUS.DONE, STEP_STATUS.SKIPPED, STEP_STATUS.FAILED]);
/** Krok „rozstrzygnięty pomyślnie lub świadomie odpuszczony" - do gatingu hierarchii. */
const RESOLVED = new Set<string>([STEP_STATUS.DONE, STEP_STATUS.SKIPPED]);

/** Ile razy krok próbuje ponownie po zwisie streamu, zanim poleci jako failed (1×). */
const MAX_STALL_RETRIES = 1;

/** Pusty licznik zużycia tokenów. */
function emptyUsage(): StepUsage {
    return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, calls: 0 };
}

/**
 * Normalizuje `usage` z modelu do jednego kształtu. Adaptery oddają OpenAI
 * (`prompt_tokens`/`completion_tokens`), Anthropic (`input_tokens`/`output_tokens`) albo już
 * znormalizowane pola - bierzemy pierwsze, które jest liczbą.
 */
export function normalizeUsage(usage: unknown): NormalizedUsage | null {
    if (!usage || typeof usage !== 'object') return null;
    const pick = (...keys: string[]): number => {
        for (const key of keys) {
            const value = Number((usage as Record<string, unknown>)[key]);
            if (Number.isFinite(value) && value >= 0) return value;
        }
        return 0;
    };
    return {
        inputTokens: pick('inputTokens', 'input_tokens', 'prompt_tokens'),
        outputTokens: pick('outputTokens', 'output_tokens', 'completion_tokens'),
        cachedTokens: pick('cachedTokens', 'cached_tokens', 'cache_read_input_tokens'),
    };
}

/** Liczniki, z których powstaje plan przebiegu. */
export interface BuildPlanCounts {
    archiveCount?: number;
    batchSize?: number;
    brainNotesCount?: number;
    dedupThreshold?: number;
    l1Count?: number;
    l2Count?: number;
}

/**
 * Buduje plan kroków z samych liczników - czysta funkcja, zero I/O.
 *
 * Reguły:
 * - `dedup` planowany, gdy w `brain/` są ≥ 2 notatki (poniżej `proposeDedup` i tak nic nie zwróci).
 *   `dedupThreshold` jest metadanymi kroku - o tym, CZY w ogóle startować przebieg, decyduje caller.
 * - `l1_batch_k` - po jednej paczce na każde pełne `batchSize` sesji w `sessions/archive`
 *   (60 sesji / 5 = 12 paczek; 3 sesje = 0 paczek).
 * - `l2` / `l3` planowane TYLKO wtedy, gdy hierarchia MOŻE się wydarzyć: L2 gdy istniejące L1
 *   plus nowe paczki dają ≥ batchSize, L3 analogicznie względem L2. Inaczej nie ma ich w planie
 *   w ogóle - user nie ma oglądać kroków, które i tak by się nie odpaliły.
 * - `l2`/`l3` startują jako `gated` (kłódka) - odblokowuje je dopiero rozstrzygnięcie L1.
 *
 * @param counts.archiveCount - plików w `sessions/archive`
 * @param counts.batchSize - ile sesji wchodzi w jedną paczkę L1 (i ile L1 w L2 itd.)
 * @param counts.brainNotesCount - notatek w `brain/`
 * @param counts.dedupThreshold - próg dedupu (metadane kroku)
 * @param counts.l1Count - istniejących plików L1
 * @param counts.l2Count - istniejących plików L2
 * @returns specyfikacje kroków (bez stanu runtime)
 */
export function buildPlan({
    archiveCount = 0,
    batchSize = 5,
    brainNotesCount = 0,
    dedupThreshold = 20,
    l1Count = 0,
    l2Count = 0,
}: BuildPlanCounts = {}): ConsolidationStepSpec[] {
    const size = Math.max(1, Number(batchSize) || 5);
    const steps: ConsolidationStepSpec[] = [];

    if (Number(brainNotesCount) >= 2) {
        steps.push({
            id: STEP_KIND.DEDUP,
            kind: STEP_KIND.DEDUP,
            status: STEP_STATUS.PENDING,
            meta: { brainNotesCount: Number(brainNotesCount), dedupThreshold: Number(dedupThreshold) },
        });
    }

    const l1Batches = Math.max(0, Math.floor(Math.max(0, Number(archiveCount) || 0) / size));
    for (let index = 1; index <= l1Batches; index++) {
        steps.push({
            id: `l1_batch_${index}`,
            kind: STEP_KIND.L1,
            index,
            total: l1Batches,
            status: STEP_STATUS.PENDING,
            meta: {
                batchSize: size,
                // Okno w posortowanej liście `sessions/archive` - deterministyczne, bez zgadywania.
                offset: (index - 1) * size,
            },
        });
    }

    const l2Possible = (Math.max(0, Number(l1Count) || 0) + l1Batches) >= size;
    if (l2Possible) {
        steps.push({
            id: STEP_KIND.L2,
            kind: STEP_KIND.L2,
            status: STEP_STATUS.GATED,
            meta: { batchSize: size, gatedBy: STEP_KIND.L1 },
        });
    }

    const l3Possible = (Math.max(0, Number(l2Count) || 0) + (l2Possible ? 1 : 0)) >= size;
    if (l3Possible) {
        steps.push({
            id: STEP_KIND.L3,
            kind: STEP_KIND.L3,
            status: STEP_STATUS.GATED,
            meta: { batchSize: size, gatedBy: l2Possible ? STEP_KIND.L2 : STEP_KIND.L1 },
        });
    }

    return steps;
}

/** Wejście konstruktora przebiegu. */
export interface ConsolidationRunOptions {
    /** liczniki dla `buildPlan` (alternatywa dla `steps`) */
    counts?: BuildPlanCounts;
    /** gotowa lista kroków (test / plan zbudowany na zewnątrz) */
    steps?: ConsolidationStepSpec[];
    /** wołany po KAŻDEJ mutacji */
    onChange?: (run: ConsolidationRun) => void;
    /** wstrzykiwany zegar (testy) */
    now?: () => number;
    /** kogo dotyczy przebieg (dla UI/notice) */
    agentName?: string;
}

export class ConsolidationRun {
    // `declare` = sama deklaracja typu, zero emitu.
    declare agentName: string;
    declare steps: ConsolidationStep[];
    declare startedAt: number;
    declare endedAt: number | null;
    /** Wolne pole na dane przebiegu spoza maszyny stanów (np. ścieżka snapshotu). */
    declare meta: Record<string, unknown>;
    declare private _now: () => number;
    declare private _listeners: Array<(run: ConsolidationRun) => void>;

    constructor({ counts, steps, onChange, now, agentName = '' }: ConsolidationRunOptions = {}) {
        this.agentName = agentName;
        this._now = now || (() => Date.now());
        this._listeners = [];
        if (typeof onChange === 'function') this._listeners.push(onChange);

        const specs = Array.isArray(steps) ? steps : buildPlan(counts || {});
        this.steps = specs.map((spec): ConsolidationStep => ({
            index: null,
            total: null,
            meta: {},
            ...spec,
            status: spec.status || STEP_STATUS.PENDING,
            result: null,
            decision: null,
            usage: emptyUsage(),
            startedAt: null,
            endedAt: null,
            retryCount: 0,
            error: null,
        }));
        this.startedAt = this._now();
        this.endedAt = null;
        this.meta = {};
    }

    // ── obserwacja ─────────────────────────────────────────────────────────────

    /** Dokłada listenera; zwraca funkcję odpinającą. */
    addChangeListener(fn: (run: ConsolidationRun) => void): () => void {
        if (typeof fn !== 'function') return () => {};
        this._listeners.push(fn);
        return () => {
            const i = this._listeners.indexOf(fn);
            if (i >= 0) this._listeners.splice(i, 1);
        };
    }

    private _emitChange(): void {
        for (const fn of [...this._listeners]) {
            // Padnięty listener UI nie może wywalić przebiegu.
            try { fn(this); } catch { /* best-effort */ }
        }
    }

    // ── odczyt ─────────────────────────────────────────────────────────────────

    getSteps(): ConsolidationStep[] { return this.steps; }

    getStep(stepId: string): ConsolidationStep | null { return this.steps.find(s => s.id === stepId) || null; }

    getStepsByKind(kind: string): ConsolidationStep[] { return this.steps.filter(s => s.kind === kind); }

    /** Krok, który AKTUALNIE coś robi (do paska statusu). Null, gdy nic nie mieli. */
    getActiveStep(): ConsolidationStep | null {
        return this.steps.find(s => s.status === STEP_STATUS.RUNNING || s.status === STEP_STATUS.APPLYING) || null;
    }

    /** Kroki czekające na decyzję usera. */
    getStepsAwaitingReview(): ConsolidationStep[] {
        return this.steps.filter(s => s.status === STEP_STATUS.AWAITING_REVIEW);
    }

    /** Czy z przebiegiem nie ma już nic do zrobienia (wszystko done/skipped/failed). */
    isSettled(): boolean {
        return this.steps.every(s => SETTLED.has(s.status));
    }

    /**
     * Czy krok jest rozstrzygnięty W SENSIE GATINGU (done albo świadomie pominięty).
     * `failed` NIE jest rozstrzygnięciem - czeka na „Ponów" albo „Pomiń" od usera.
     */
    isResolved(stepId: string): boolean {
        const step = this.getStep(stepId);
        return !!step && RESOLVED.has(step.status);
    }

    /**
     * Czy WSZYSTKIE paczki L1 są rozstrzygnięte (done/skipped). `failed` NIE liczy się jako
     * rozstrzygnięte - L2 czeka, aż user kliknie „Ponów" albo „Pomiń" (L2 syntetyzuje TREŚĆ L1,
     * nie może powstać z połowy materiału).
     */
    allL1Resolved(): boolean {
        return this.getStepsByKind(STEP_KIND.L1).every(s => RESOLVED.has(s.status));
    }

    /** Suma zużycia tokenów całego przebiegu. */
    totalUsage(): StepUsage {
        return this.steps.reduce((acc, step) => ({
            inputTokens: acc.inputTokens + step.usage.inputTokens,
            outputTokens: acc.outputTokens + step.usage.outputTokens,
            cachedTokens: acc.cachedTokens + step.usage.cachedTokens,
            calls: acc.calls + step.usage.calls,
        }), emptyUsage());
    }

    /** Skrót dla paska statusu: ile kroków rozstrzygniętych z ilu. */
    progress(): { settled: number; total: number } {
        const total = this.steps.length;
        const settled = this.steps.filter(s => SETTLED.has(s.status)).length;
        return { settled, total };
    }

    // ── mutacje (maszyna stanów) ───────────────────────────────────────────────

    private _require(stepId: string): ConsolidationStep {
        const step = this.getStep(stepId);
        if (!step) throw new Error(`ConsolidationRun: nieznany krok "${stepId}"`);
        return step;
    }

    private _transition(step: ConsolidationStep, from: StepStatus | StepStatus[], to: StepStatus): void {
        const allowed = Array.isArray(from) ? from : [from];
        if (!allowed.includes(step.status)) {
            throw new Error(
                `ConsolidationRun: nielegalne przejście kroku "${step.id}" ${step.status} → ${to} ` +
                `(dozwolone z: ${allowed.join(', ')})`
            );
        }
        step.status = to;
    }

    /** Krok rusza (generacja propozycji). Legalne z `pending` oraz z `failed` (ręczne „Ponów"). */
    startStep(stepId: string): ConsolidationStep {
        const step = this._require(stepId);
        const wasFailed = step.status === STEP_STATUS.FAILED;
        this._transition(step, [STEP_STATUS.PENDING, STEP_STATUS.FAILED], STEP_STATUS.RUNNING);
        step.startedAt = this._now();
        step.endedAt = null;
        step.error = null;
        if (wasFailed) step.retryCount = 0; // ręczny retry dostaje świeży budżet auto-ponowień
        this._reopen();
        this._emitChange();
        return step;
    }

    /** Propozycja gotowa - czeka na usera. NIC nie zostało zaaplikowane. */
    stepProposalReady(stepId: string, result?: ConsolidationStepResult | null): ConsolidationStep {
        const step = this._require(stepId);
        this._transition(step, STEP_STATUS.RUNNING, STEP_STATUS.AWAITING_REVIEW);
        step.result = result ?? null;
        step.endedAt = this._now();
        this._emitChange();
        return step;
    }

    /**
     * User zdecydował - zaczynamy zapisywać na dysk.
     *
     * Legalne także z `failed` - gdy padł SAM ZAPIS (np. chwilowy błąd dysku), „Ponów"
     * w modalu powtarza ten sam zapis z tą samą decyzją usera. Bez tego jedyną drogą byłaby
     * ponowna GENERACJA propozycji: kolejny strzał do LLM i edycje usera do kosza.
     */
    beginApply(stepId: string, decision: unknown = null): ConsolidationStep {
        const step = this._require(stepId);
        this._transition(step, [STEP_STATUS.AWAITING_REVIEW, STEP_STATUS.FAILED], STEP_STATUS.APPLYING);
        step.decision = decision;
        this._reopen();
        this._emitChange();
        return step;
    }

    /** Zapis się udał. */
    completeStep(stepId: string, applied: ConsolidationStepApplied | null = null): ConsolidationStep {
        const step = this._require(stepId);
        this._transition(step, STEP_STATUS.APPLYING, STEP_STATUS.DONE);
        step.applied = applied;
        step.endedAt = this._now();
        this._maybeFinish();
        this._emitChange();
        return step;
    }

    /** Krok padł (błąd inny niż zwis - bez auto-retry, zgodnie z decyzją J w specu). */
    failStep(stepId: string, error?: unknown): ConsolidationStep {
        const step = this._require(stepId);
        this._transition(step, [STEP_STATUS.RUNNING, STEP_STATUS.APPLYING, STEP_STATUS.AWAITING_REVIEW], STEP_STATUS.FAILED);
        step.error = error
            ? { message: (error as ErrLike).message || String(error), code: (error as ErrLike).code || null }
            : { message: 'unknown', code: null };
        step.endedAt = this._now();
        this._maybeFinish();
        this._emitChange();
        return step;
    }

    /** User odrzucił propozycję albo krok stracił sens (za mało materiału). */
    skipStep(stepId: string, reason: string = ''): ConsolidationStep {
        const step = this._require(stepId);
        this._transition(
            step,
            [STEP_STATUS.PENDING, STEP_STATUS.GATED, STEP_STATUS.AWAITING_REVIEW, STEP_STATUS.RUNNING, STEP_STATUS.FAILED],
            STEP_STATUS.SKIPPED
        );
        step.endedAt = this._now();
        if (reason) step.meta = { ...step.meta, skipReason: reason };
        this._maybeFinish();
        this._emitChange();
        return step;
    }

    /** Zdejmuje kłódkę z L2/L3, gdy niższy poziom jest rozstrzygnięty. */
    ungate(stepId: string): ConsolidationStep {
        const step = this._require(stepId);
        this._transition(step, STEP_STATUS.GATED, STEP_STATUS.PENDING);
        this._reopen();
        this._emitChange();
        return step;
    }

    /**
     * Stream zwisł. Polityka: pierwszy raz ponawiamy automatycznie TEN SAM
     * strzał, drugi raz krok leci jako `failed` (z przyciskiem „Ponów" w UI).
     *
     */
    markStalled(stepId: string): { retry: boolean; retryCount: number } {
        const step = this._require(stepId);
        if (step.status !== STEP_STATUS.RUNNING) {
            throw new Error(`ConsolidationRun: markStalled na kroku "${step.id}" w stanie ${step.status} (wymagane: running)`);
        }
        if (step.retryCount < MAX_STALL_RETRIES) {
            step.retryCount += 1;
            step.startedAt = this._now(); // licznik czasu kroku startuje od nowa
            this._emitChange();
            return { retry: true, retryCount: step.retryCount };
        }
        step.status = STEP_STATUS.FAILED;
        step.error = { message: 'Stream stalled twice', code: 'stream_stalled' };
        step.endedAt = this._now();
        this._maybeFinish();
        this._emitChange();
        return { retry: false, retryCount: step.retryCount };
    }

    /** Dokłada zużycie tokenów z jednego strzału LLM do kroku. */
    addUsage(stepId: string, usage: unknown): StepUsage {
        const step = this._require(stepId);
        const normalized = normalizeUsage(usage);
        if (!normalized) return step.usage;
        step.usage = {
            inputTokens: step.usage.inputTokens + normalized.inputTokens,
            outputTokens: step.usage.outputTokens + normalized.outputTokens,
            cachedTokens: step.usage.cachedTokens + normalized.cachedTokens,
            calls: step.usage.calls + 1,
        };
        this._emitChange();
        return step.usage;
    }

    private _maybeFinish(): void {
        if (this.endedAt === null && this.steps.every(s => SETTLED.has(s.status))) {
            this.endedAt = this._now();
        }
    }

    /**
     * Przebieg znów coś robi → kasujemy znacznik domknięcia.
     *
     * Bez tego `endedAt` zamarzał na PIERWSZYM domknięciu: przebieg kończył się z krokiem `failed`,
     * user klikał „Ponów", a po ponownym domknięciu podsumowanie pokazywało czas z pierwszego
     * przejścia (`runDurationMs`/`buildRunSummary`). `_maybeFinish` ustawi go z powrotem, gdy
     * wszystkie kroki znów będą rozstrzygnięte.
     */
    private _reopen(): void {
        this.endedAt = null;
    }
}
