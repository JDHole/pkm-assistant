/**
 * consolidationLabels.test.js — S29 Z4/Z5: warstwa opisowa przebiegu konsolidacji.
 *
 * To jest jedyna część UI „Pulsu pamięci", którą da się przetestować node'em (modale importują
 * `obsidian`). Sprawdzamy dokładnie te rzeczy, na których stoi widok: etykieta paczki składana
 * z kind+index+total, zakres sesji z `meta.offset`, powód pominięcia, tekst zwisu, podsumowanie
 * liczone z tego, co NAPRAWDĘ zapisane (`step.applied`), oraz linia paska statusu.
 */
import test from 'ava';
import { setLocale } from '../../core/i18n/index.js';
import { ConsolidationRun, STEP_KIND, STEP_STATUS } from './ConsolidationRun.js';
import {
    stepLabel,
    stepDetail,
    stepStatusIcon,
    stepErrorText,
    isFallbackStep,
    formatDuration,
    formatTokens,
    formatUsageLine,
    statusBarLine,
    buildRunSummary,
    summaryToText,
    planToText,
} from './consolidationLabels.js';

import type { ConsolidationStepLike, ConsolidationRunLike } from './consolidationLabels.js';
import type { ConsolidationStepSpec } from './ConsolidationRun.js';

setLocale('pl');

/**
 * Kontrakt przebiegu w zakresie, którego ten test używa. Rzutowanie zostaje po TS-2
 * (konwersja `ConsolidationRun` na TypeScript) już tylko z jednego powodu: prawdziwy
 * `getStep` zwraca `ConsolidationStep | null`, a ten test operuje wyłącznie na krokach,
 * które sam przed chwilą zbudował — więc czyta je bez każdorazowego `!`.
 */
interface RunUnderTest extends ConsolidationRunLike {
    getStep(id: string): ConsolidationStepLike;
    startStep(id: string): void;
    stepProposalReady(id: string, result: Record<string, unknown>): void;
    beginApply(id: string, decision: Record<string, unknown>): void;
    completeStep(id: string, applied: Record<string, unknown>): void;
    skipStep(id: string, reason?: string): void;
    markStalled(id: string): void;
    addUsage(id: string, usage: Record<string, unknown>): void;
}

function makeRun(steps: ConsolidationStepSpec[]): RunUnderTest {
    return new ConsolidationRun({ steps, agentName: 'Jaskier' }) as unknown as RunUnderTest;
}

const L1_STEPS = [
    { id: 'dedup', kind: STEP_KIND.DEDUP, status: STEP_STATUS.PENDING, meta: {} },
    { id: 'l1_batch_1', kind: STEP_KIND.L1, index: 1, total: 2, status: STEP_STATUS.PENDING, meta: { batchSize: 5, offset: 0 } },
    { id: 'l1_batch_2', kind: STEP_KIND.L1, index: 2, total: 2, status: STEP_STATUS.PENDING, meta: { batchSize: 5, offset: 5 } },
    { id: 'l2', kind: STEP_KIND.L2, status: STEP_STATUS.GATED, meta: {} },
];

test('stepLabel składa etykietę paczki z kind + index + total', t => {
    const run = makeRun(L1_STEPS);
    t.is(stepLabel(run.getStep('l1_batch_2')), 'L1 — paczka 2/2');
    t.is(stepLabel(run.getStep('dedup')), 'Sprzątanie notatek brain/');
    t.is(stepLabel(run.getStep('l2')), 'L2 — podsumowanie podsumowań');
});

test('stepDetail pokazuje okno paczki L1 z meta.offset (1-indeksowane dla człowieka)', t => {
    const run = makeRun(L1_STEPS);
    t.is(stepDetail(run.getStep('l1_batch_1')), 'sesje 1-5');
    t.is(stepDetail(run.getStep('l1_batch_2')), 'sesje 6-10');
});

test('stepDetail tłumaczy stabilne skipReason z silnika', t => {
    const run = makeRun(L1_STEPS);
    run.skipStep('l1_batch_2', 'not_enough_sessions');
    t.is(stepDetail(run.getStep('l1_batch_2')), 'za mało sesji w archiwum na pełną paczkę');
    run.skipStep('dedup', 'nothing_to_merge');
    t.is(stepDetail(run.getStep('dedup')), 'nie ma czego scalać — brain/ wygląda na czysty');
});

test('zwis streamu ma własny, ludzki tekst zamiast surowego message', t => {
    const run = makeRun(L1_STEPS);
    run.startStep('l1_batch_1');
    run.markStalled('l1_batch_1'); // 1× auto-retry
    run.markStalled('l1_batch_1'); // 2× → failed
    const step = run.getStep('l1_batch_1');
    t.is(step.status, STEP_STATUS.FAILED);
    t.is(stepErrorText(step), 'model zamilkł (stream zwisł) — spróbuj ponownie');
    t.is(stepStatusIcon(step.status), '❌');
});

test('isFallbackStep łapie propozycję sklejoną bez modelu (spec H)', t => {
    const run = makeRun(L1_STEPS);
    run.startStep('l1_batch_1');
    run.stepProposalReady('l1_batch_1', { level: 'L1', body: 'x', llmDriven: false });
    t.true(isFallbackStep(run.getStep('l1_batch_1')));
    run.startStep('l1_batch_2');
    run.stepProposalReady('l1_batch_2', { level: 'L1', body: 'x', llmDriven: true });
    t.false(isFallbackStep(run.getStep('l1_batch_2')));
});

test('formatDuration i formatTokens dają zwięzłe, ludzkie wartości', t => {
    t.is(formatDuration(38_000), '38 s');
    t.is(formatDuration(125_000), '2 min 05 s');
    t.is(formatTokens({ inputTokens: 300, outputTokens: 120 }), '420 tok.');
    t.true(formatTokens({ inputTokens: 12_000, outputTokens: 400 }).endsWith('k tok.'));
});

test('formatUsageLine dokłada koszt tylko dla modelu z cennika', t => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0 };
    t.true(formatUsageLine(usage, 'gpt-4o-mini').includes('$'));
    t.false(formatUsageLine(usage, 'jakis-lokalny-model').includes('$'));
    t.false(formatUsageLine(usage, null).includes('$'));
});

test('statusBarLine pokazuje aktywny krok, potem przechodzi na „do przejrzenia" i gaśnie', t => {
    const run = makeRun([L1_STEPS[1]]);
    t.is(statusBarLine(run), '🧠 Pamięć (0/1)');

    run.startStep('l1_batch_1');
    const running = statusBarLine(run, run.getStep('l1_batch_1').startedAt! + 38_000)!;
    t.true(running.startsWith('🧠 L1 — paczka 1/2'));
    t.true(running.includes('(0/1)'));
    t.true(running.includes('38 s'));

    run.stepProposalReady('l1_batch_1', { body: 'x' });
    t.is(statusBarLine(run), '🧠 Do przejrzenia: 1 (0/1)');

    run.beginApply('l1_batch_1', { accepted: true });
    run.completeStep('l1_batch_1', { created: 1, name: 'x_l1.md' });
    t.is(statusBarLine(run), null); // rozstrzygnięty przebieg = pasek milczy
});

test('buildRunSummary liczy to, co NAPRAWDĘ zapisane (step.applied), nie propozycje', t => {
    const run = makeRun([
        { id: 'dedup', kind: STEP_KIND.DEDUP, status: STEP_STATUS.PENDING, meta: {} },
        { id: 'l1_batch_1', kind: STEP_KIND.L1, index: 1, total: 2, status: STEP_STATUS.PENDING, meta: { batchSize: 5, offset: 0 } },
        { id: 'l1_batch_2', kind: STEP_KIND.L1, index: 2, total: 2, status: STEP_STATUS.PENDING, meta: { batchSize: 5, offset: 5 } },
    ]);

    run.startStep('dedup');
    run.addUsage('dedup', { prompt_tokens: 800, completion_tokens: 200 });
    run.stepProposalReady('dedup', { merges: [{}, {}], deletions: [], llmDriven: true });
    run.beginApply('dedup', { accepted: true });
    run.completeStep('dedup', { merged: 2, deleted: 1 });

    run.startStep('l1_batch_1');
    run.stepProposalReady('l1_batch_1', { body: 'x', llmDriven: true });
    run.beginApply('l1_batch_1', { accepted: true });
    run.completeStep('l1_batch_1', { created: 1, name: 'a_l1.md' });

    run.skipStep('l1_batch_2', 'rejected_by_user');

    const summary = buildRunSummary(run);
    t.is(summary.merged, 2);
    t.is(summary.deleted, 1);
    t.is(summary.l1, 1);
    t.is(summary.skipped, 1);
    t.is(summary.failed, 0);
    t.is(summary.usage.inputTokens, 800);
    t.is(summary.usage.calls, 1);
    t.is(summaryToText(summary), 'scalono 2 notatek, usunięto 1, 1× L1');
});

test('summaryToText nie udaje sukcesu, gdy nic nie powstało', t => {
    const run = makeRun([L1_STEPS[1]]);
    run.skipStep('l1_batch_1', 'not_enough_sessions');
    t.is(summaryToText(buildRunSummary(run)), 'nic nie zostało zapisane');
});

test('planToText opisuje plan przed pierwszym strzałem (notice startowy)', t => {
    t.is(planToText(makeRun(L1_STEPS)), 'sprzątanie notatek brain/ + 2 paczek L1 + podsumowanie L2');
    t.is(planToText(makeRun([])), 'nic do zrobienia');
});
