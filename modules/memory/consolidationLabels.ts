/**
 * @module consolidationLabels
 * WARSTWA OPISOWA przebiegu konsolidacji: etykiety, ikony statusu,
 * czasy, koszt, podsumowanie. Czyste funkcje, zero DOM, zero Obsidiana.
 *
 * Dlaczego tu, a nie w UI: ten sam przebieg opisują DWA różne miejsca -
 *  1. pasek statusu Obsidiana (`core/PKMEnv.js`),
 *  2. modal przebiegu (`modules/chat/ConsolidationProgressModal.js`).
 * Gdyby każde składało etykiety samo, po pierwszej zmianie nazewnictwa rozjechałyby się
 * („L1 paczka 2/4" na pasku vs „Paczka 2 z 4" w modalu). Pasek statusu siedzi w `core/`,
 * które nie może importować z modułu z widokami (cykl przez barrele) - więc wspólnym
 * mianownikiem jest `modules/memory` (oba i tak stąd biorą `memoryOpsCenter`).
 *
 * SILNIK ZOSTAJE i18n-FREE: `ConsolidationRun` / `ArchiveWorkflow` nadal nie znają ani jednego
 * stringa usera. To jest osobny, opcjonalny plik prezentacyjny - kroki opisuje z ich `kind` /
 * `index` / `total` / `meta`.
 */
import { t, getDateLocale } from '../../core/i18n/index.js';
import { STEP_KIND, STEP_STATUS } from './ConsolidationRun.js';
import { estimateCostUsd } from './CostLog.js';

/**
 * Kontrakty przebiegu typowane STRUKTURALNIE - `ConsolidationRun.js` jest jeszcze
 * w JavaScripcie (nie czekamy na konwersję właściciela).
 * Kształty odwzorowują to, co ten plik REALNIE czyta, i nic ponadto.
 */

/** Licznik zużycia tokenów jednego kroku / całego przebiegu. */
export interface ConsolidationUsage {
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    calls?: number;
}

/** Propozycja kroku (kształt zależny od `kind`) - czytamy z niej tylko te pola. */
export interface ConsolidationStepResult {
    sessions?: unknown[];
    merges?: unknown[];
    deletions?: unknown[];
    /** `false` = propozycja sklejona deterministycznie, bez modelu (spec H) */
    llmDriven?: boolean;
    [key: string]: unknown;
}

/** Jeden krok przebiegu - widok tylko do opisu (zero mutacji). */
export interface ConsolidationStepLike {
    kind?: string;
    status?: string;
    index?: number;
    total?: number;
    startedAt?: number | null;
    endedAt?: number | null;
    meta?: { batchSize?: number; offset?: number; skipReason?: string } | null;
    result?: ConsolidationStepResult | null;
    applied?: { merged?: number; deleted?: number } | null;
    error?: { code?: string; message?: string } | null;
}

/** Przebieg widziany przez warstwę opisową (metody bywają nieobecne w atrapach). */
export interface ConsolidationRunLike {
    startedAt?: number | null;
    endedAt?: number | null;
    getSteps?: () => ConsolidationStepLike[];
    getStep?: (id: string) => ConsolidationStepLike | undefined;
    getActiveStep?: () => ConsolidationStepLike | null | undefined;
    getStepsAwaitingReview?: () => ConsolidationStepLike[];
    progress?: () => { settled: number; total: number };
    isSettled?: () => boolean;
    totalUsage?: () => ConsolidationUsage;
}

/** Co z przebiegu wynikło - liczone z `step.applied`, nie z propozycji. */
export interface RunSummary {
    merged: number;
    deleted: number;
    l1: number;
    l2: number;
    l3: number;
    failed: number;
    skipped: number;
    fallback: number;
    usage: ConsolidationUsage;
    durationMs: number;
}

/** Ikona statusu kroku na checkliście (✅/🔄/⬜/🔒/⏸️/❌). */
const STATUS_ICONS: Record<string, string> = {
    [STEP_STATUS.PENDING]: '⬜',
    [STEP_STATUS.RUNNING]: '🔄',
    [STEP_STATUS.AWAITING_REVIEW]: '⏸️',
    [STEP_STATUS.APPLYING]: '💾',
    [STEP_STATUS.DONE]: '✅',
    [STEP_STATUS.FAILED]: '❌',
    [STEP_STATUS.SKIPPED]: '⏭️',
    [STEP_STATUS.GATED]: '🔒',
};

export function stepStatusIcon(status: string | undefined): string {
    return STATUS_ICONS[status as string] || '⬜';
}

/** Krótka nazwa statusu (tooltip / wiersz „failed"). */
export function stepStatusLabel(status: string | undefined): string {
    return t(`memory.consolidation.status.${status}`);
}

/**
 * Etykieta kroku składana z `kind` + `index` + `total`.
 * `l1_batch_3` z total 12 → „L1 - paczka 3/12".
 */
export function stepLabel(step: ConsolidationStepLike | null | undefined): string {
    if (!step) return '';
    if (step.kind === STEP_KIND.L1 && (step.total as number) > 1) {
        return t('memory.consolidation.step.l1_batch', { index: step.index, total: step.total });
    }
    return t(`memory.consolidation.step.${step.kind}`);
}

/**
 * Doprecyzowanie kroku pod etykietą: zakres sesji w paczce, powód pominięcia, przyczyna błędu.
 * Zwraca pusty string, gdy nie ma nic sensownego do dodania.
 */
export function stepDetail(step: ConsolidationStepLike | null | undefined): string {
    if (!step) return '';

    if (step.status === STEP_STATUS.SKIPPED) {
        const reason = step.meta?.skipReason;
        return reason ? t(`memory.consolidation.skip.${reason}`) : t('memory.consolidation.skip.generic');
    }
    if (step.status === STEP_STATUS.FAILED) return stepErrorText(step);

    const sessions = step.result?.sessions;
    if (step.kind === STEP_KIND.L1) {
        const range = l1SessionRange(step);
        if (range) return range;
    }
    if (Array.isArray(sessions) && sessions.length > 0) {
        return t('memory.consolidation.detail.sessions', { count: sessions.length });
    }
    if (step.kind === STEP_KIND.DEDUP && step.result) {
        return t('memory.consolidation.detail.dedup_proposal', {
            merges: step.result.merges?.length || 0,
            deletions: step.result.deletions?.length || 0,
        });
    }
    return '';
}

/** „sesje 6-10" - okno paczki L1 w posortowanym archiwum (1-indeksowane dla człowieka). */
function l1SessionRange(step: ConsolidationStepLike | null | undefined): string {
    const size = Number(step?.meta?.batchSize) || (Array.isArray(step?.result?.sessions) ? step.result.sessions.length : 0);
    const offset = Number(step?.meta?.offset);
    if (!Number.isFinite(offset) || size <= 0) return '';
    return t('memory.consolidation.detail.session_range', { from: offset + 1, to: offset + size });
}

/** Czytelna przyczyna padu kroku - zwis streamu ma własny, ludzki tekst. */
export function stepErrorText(step: ConsolidationStepLike | null | undefined): string {
    const code = step?.error?.code;
    if (code === 'stream_stalled') return t('memory.consolidation.error.stalled');
    if (code === 'aborted') return t('memory.consolidation.error.aborted');
    return step?.error?.message || t('memory.consolidation.error.unknown');
}

/** Czy krok poszedł awaryjnym sklejaniem treści zamiast modelem (spec H: ma być GŁOŚNO). */
export function isFallbackStep(step: ConsolidationStepLike | null | undefined): boolean {
    return Boolean(step?.result) && step!.result!.llmDriven === false;
}

/** „38s" / „2 min 05 s" - czas jednego kroku albo całego przebiegu. */
export function formatDuration(ms: number | null | undefined): string {
    const totalSeconds = Math.max(0, Math.round(Number(ms) || 0) / 1000);
    if (totalSeconds < 60) return t('memory.consolidation.duration_s', { seconds: Math.round(totalSeconds) });
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.round(totalSeconds % 60);
    return t('memory.consolidation.duration_ms', { minutes, seconds: String(seconds).padStart(2, '0') });
}

/** Ile trwa (albo trwał) krok. Krok w biegu liczy się do `now`. */
export function stepDurationMs(step: ConsolidationStepLike | null | undefined, now: number = Date.now()): number {
    if (!step?.startedAt) return 0;
    return (step.endedAt || now) - step.startedAt;
}

/** Ile trwa (albo trwał) cały przebieg. */
function runDurationMs(run: ConsolidationRunLike | null | undefined, now: number = Date.now()): number {
    if (!run?.startedAt) return 0;
    return (run.endedAt || now) - run.startedAt;
}

function formatNumber(value: number, maximumFractionDigits = 1): string {
    try {
        return new Intl.NumberFormat(getDateLocale(), { maximumFractionDigits }).format(value);
    } catch {
        return String(Math.round(value * 10) / 10);
    }
}

/** „12,4k tok." - suma tokenów wejścia i wyjścia. */
export function formatTokens(usage: ConsolidationUsage | null | undefined): string {
    const total = (Number(usage?.inputTokens) || 0) + (Number(usage?.outputTokens) || 0);
    if (total < 1000) return t('memory.consolidation.tokens', { value: String(total) });
    return t('memory.consolidation.tokens_k', { value: formatNumber(total / 1000, 1) });
}

/** „$0.0182" - szacunek albo pusty string, gdy cennik nie zna modelu (wtedy pokazujemy same tokeny). */
function formatCostUsd(usage: ConsolidationUsage | null | undefined, modelName: string | null | undefined): string {
    if (!modelName) return '';
    const usd = estimateCostUsd({
        model: modelName,
        inputTokens: Number(usage?.inputTokens) || 0,
        outputTokens: Number(usage?.outputTokens) || 0,
    });
    if (!(usd > 0)) return '';
    return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}

/** Linia kosztu pod checklistą: „12,4k tok. (~$0.02)" albo same tokeny. */
export function formatUsageLine(usage: ConsolidationUsage | null | undefined, modelName: string | null | undefined): string {
    const tokens = formatTokens(usage);
    const cost = formatCostUsd(usage, modelName);
    return cost ? t('memory.consolidation.cost_line', { tokens, cost }) : tokens;
}

/**
 * Jedna linijka do paska statusu Obsidiana: „🧠 L1 - paczka 2/4 (3/7) · 38s".
 * Zwraca null, gdy przebieg nie istnieje albo nic nie mieli (pasek ma wtedy milczeć).
 */
export function statusBarLine(run: ConsolidationRunLike | null | undefined, now: number = Date.now()): string | null {
    if (!run) return null;
    const active = run.getActiveStep?.();
    const { settled, total } = run.progress?.() || { settled: 0, total: 0 };

    if (!active) {
        const awaiting = run.getStepsAwaitingReview?.() || [];
        if (awaiting.length > 0) {
            return t('memory.consolidation.status_bar_review', { count: awaiting.length, settled, total });
        }
        if (run.isSettled?.()) return null;
        return t('memory.consolidation.status_bar_idle', { settled, total });
    }

    return t('memory.consolidation.status_bar', {
        step: stepLabel(active),
        settled,
        total,
        duration: formatDuration(stepDurationMs(active, now)),
    });
}

/**
 * Co z przebiegu wynikło - do sekcji podsumowania w modalu i do notice'a na koniec.
 * Liczy z `step.applied` (wynik zapisu), nie z propozycji - czyli z tego, co NAPRAWDĘ powstało.
 */
export function buildRunSummary(run: ConsolidationRunLike | null | undefined, now: number = Date.now()): RunSummary {
    const steps = run?.getSteps?.() || [];
    const summary: RunSummary = {
        merged: 0,
        deleted: 0,
        l1: 0,
        l2: 0,
        l3: 0,
        failed: 0,
        skipped: 0,
        fallback: 0,
        usage: run?.totalUsage?.() || { inputTokens: 0, outputTokens: 0, cachedTokens: 0, calls: 0 },
        durationMs: runDurationMs(run, now),
    };

    for (const step of steps) {
        if (step.status === STEP_STATUS.FAILED) summary.failed++;
        if (step.status === STEP_STATUS.SKIPPED) summary.skipped++;
        if (isFallbackStep(step)) summary.fallback++;
        if (step.status !== STEP_STATUS.DONE) continue;
        if (step.kind === STEP_KIND.DEDUP) {
            summary.merged += Number(step.applied?.merged) || 0;
            summary.deleted += Number(step.applied?.deleted) || 0;
        } else if (step.kind === STEP_KIND.L1) summary.l1++;
        else if (step.kind === STEP_KIND.L2) summary.l2++;
        else if (step.kind === STEP_KIND.L3) summary.l3++;
    }

    return summary;
}

/** Zdanie „scalono 2 notatki, 12× L1, 1× L2" - puste, gdy nic nie powstało. */
export function summaryToText(summary: RunSummary): string {
    const parts: string[] = [];
    if (summary.merged > 0) parts.push(t('memory.consolidation.summary.merged', { count: summary.merged }));
    if (summary.deleted > 0) parts.push(t('memory.consolidation.summary.deleted', { count: summary.deleted }));
    if (summary.l1 > 0) parts.push(t('memory.consolidation.summary.l1', { count: summary.l1 }));
    if (summary.l2 > 0) parts.push(t('memory.consolidation.summary.l2', { count: summary.l2 }));
    if (summary.l3 > 0) parts.push(t('memory.consolidation.summary.l3', { count: summary.l3 }));
    if (parts.length === 0) return t('memory.consolidation.summary.nothing');
    return parts.join(', ');
}

/** Plan przebiegu jednym zdaniem - do notice'a startowego („12 paczek L1 + sprzątanie brain/"). */
export function planToText(run: ConsolidationRunLike | null | undefined): string {
    const steps = run?.getSteps?.() || [];
    const parts: string[] = [];
    const l1 = steps.filter(s => s.kind === STEP_KIND.L1).length;
    if (steps.some(s => s.kind === STEP_KIND.DEDUP)) parts.push(t('memory.consolidation.plan.dedup'));
    if (l1 > 0) parts.push(t('memory.consolidation.plan.l1', { count: l1 }));
    if (steps.some(s => s.kind === STEP_KIND.L2)) parts.push(t('memory.consolidation.plan.l2'));
    if (steps.some(s => s.kind === STEP_KIND.L3)) parts.push(t('memory.consolidation.plan.l3'));
    if (parts.length === 0) return t('memory.consolidation.plan.empty');
    return parts.join(' + ');
}
