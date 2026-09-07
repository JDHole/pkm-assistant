/**
 * @module consolidationRunState
 * Kubełek 2 (2026-07-29) — CZYSTE decyzje stanu dla `ConsolidationProgressModal`.
 *
 * Sam modal jest nietestowalny w node (`obsidian` w imporcie), a akurat te dwie decyzje —
 * „czy przebieg utknął, gdy zamykam okno" i „z czego startuje panel review" — są tymi, na których
 * najłatwiej się pomylić i których pomyłkę user odczuwa najmocniej (wiecznie świecący pasek
 * statusu / skasowane edycje). Dlatego mieszkają tutaj: zero DOM, zero Obsidiana,
 * pokrycie w `consolidationRunState.test.js`.
 */
import { STEP_STATUS } from '../memory/index.js';
import {
    normalizeMerges,
    normalizeDeletions,
    type DeletionReview,
    type MergeReview,
} from './archiveReviewRenders.js';

type RunLike = {
    getSteps?: () => Array<{ status: string }> | null;
    isSettled?: () => boolean;
};

// AUD-dead-code-231 (2026-09-02): `export` zdjęty na obu typach niżej — zero referencji spoza
// tego pliku (`resolveStepDraft`, który je zwraca, zostaje publiczny).
type DedupStepDraft = {
    merges: Array<MergeReview & { accepted: boolean }>;
    deletions: Array<DeletionReview & { accepted: boolean }>;
};
type SummaryStepDraft = { body: string };
type StepDraft = DedupStepDraft | SummaryStepDraft;

type DraftSource = {
    merges?: MergeReview[];
    deletions?: DeletionReview[];
    body?: unknown;
};

type StepLike = {
    draft?: StepDraft;
    result?: unknown;
    decision?: unknown;
};

/** Krok, który sam z siebie coś jeszcze robi. */
const IN_FLIGHT: ReadonlySet<string> = new Set([STEP_STATUS.RUNNING, STEP_STATUS.APPLYING]);
/** Krok, z którym nikt już nic nie zrobi. */
const TERMINAL: ReadonlySet<string> = new Set([STEP_STATUS.DONE, STEP_STATUS.FAILED, STEP_STATUS.SKIPPED]);

/**
 * Czy przebieg UTKNĄŁ — czyli nie jest rozstrzygnięty, nic się nie mieli i nie ma czego kliknąć.
 *
 * Scenariusz-zabójca (do kubełka 2 kończył się restartem Obsidiana): paczka L1 leci `failed`,
 * L2 i L3 zostają pod kłódką `gated`, a user zamyka okno przebiegu. Nikt już nie kliknie
 * „Ponów"/„Pomiń", więc `isSettled()` nigdy nie będzie prawdą, `finishIfSettled()` nic nie zrobi,
 * `MemoryOpsCenter` zostaje na zawsze „zajęty" i 🧠 świeci na pasku statusu do restartu.
 *
 * Czego to NIE łapie (celowo):
 *  - kroku `awaiting_review` — zamknięcie okna to normalna przerwa („user idzie pomyśleć"),
 *    pasek ma dalej świecić i pozwalać wrócić klikiem w 🧠,
 *  - kroku w biegu — przebieg leci w tle, o to chodzi w nieblokującym modalu,
 *  - kroku `pending` — robota jest PRZED nami (świeży plan albo krok świeżo odgatowany:
 *    `generateGatedSteps` robi `ungate` przed pierwszym await, więc „pending" znaczy
 *    „generator zaraz po niego sięgnie"; review kubełka 2, P3-1),
 *  - przebiegu świeżo zbudowanego, w którym nic jeszcze nie ruszyło (`anyTerminal === false`) —
 *    generacja dopiero startuje; pad na starcie i tak zwalnia centrum w `startConsolidationRun`.
 *
 * @param {Object} run - ConsolidationRun
 * @returns {boolean}
 */
export function isRunStuck(run: RunLike | null | undefined): boolean {
    const steps = typeof run?.getSteps === 'function' ? (run.getSteps() || []) : [];
    if (steps.length === 0) return false;
    if ((run as RunLike).isSettled?.()) return false; // rozstrzygnięty przebieg domyka `finishIfSettled()`

    let anyTerminal = false;
    for (const step of steps) {
        if (IN_FLIGHT.has(step.status)) return false;
        if (step.status === STEP_STATUS.AWAITING_REVIEW) return false;
        if (step.status === STEP_STATUS.PENDING) return false;
        if (TERMINAL.has(step.status)) anyTerminal = true;
    }
    return anyTerminal;
}

/**
 * Szkic review kroku — TEN SAM obiekt między otwarciami panelu.
 *
 * Do kubełka 2 `_openReview` robił przy KAŻDYM otwarciu świeże kopie z `step.result`: user
 * poprawiał treść L1 albo odznaczał scalenia, zwijał panel (żeby zerknąć na checklistę), otwierał
 * ponownie — i wracała wersja modelu. Szkic trzymamy na kroku (wzorem `step.meta`), bo krok żyje
 * dokładnie tyle, co przebieg, a modal potrafi się w międzyczasie zamknąć i otworzyć od nowa.
 *
 * Pierwszeństwo: decyzja usera (gdy już zapadła) → istniejący szkic → świeże kopie z propozycji.
 * Zwracane obiekty są MUTOWALNE i to je mutują rendery z `archiveReviewRenders.js`.
 *
 * @param {Object} step - krok ConsolidationRun (mutowany: dostaje pole `draft`)
 * @param {Object} [opts]
 * @param {boolean} [opts.dedup=false] - krok jest fazą dedup (inny kształt szkicu)
 * @returns {Object|null} `{merges, deletions}` dla dedupu, `{body}` dla L1/L2/L3
 */
export function resolveStepDraft(step: null | undefined, opts?: { dedup?: boolean }): null;
export function resolveStepDraft(step: StepLike, opts: { dedup: true }): DedupStepDraft;
export function resolveStepDraft(step: StepLike, opts?: { dedup?: false }): SummaryStepDraft;
export function resolveStepDraft(step: StepLike | null | undefined, { dedup = false }: { dedup?: boolean } = {}): StepDraft | null {
    if (!step) return null;
    if (step.draft) return step.draft;

    const proposal = (step.result || {}) as DraftSource;
    const source = (step.decision || proposal) as DraftSource;
    step.draft = dedup
        ? {
            merges: normalizeMerges(source.merges ?? proposal.merges),
            deletions: normalizeDeletions(source.deletions ?? proposal.deletions),
        }
        : { body: String(source.body ?? proposal.body ?? '') };
    return step.draft;
}
