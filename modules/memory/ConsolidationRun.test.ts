/**
 * ConsolidationRun.test.js — S29 Z2: plan przebiegu, maszyna stanów, retry-polityka, koszt.
 * Czysty node — zero Obsidiana, zero I/O.
 */
import test from 'ava';
import {
    ConsolidationRun,
    buildPlan,
    normalizeUsage,
    STEP_STATUS,
    STEP_KIND,
} from './ConsolidationRun.js';
import type { ConsolidationRun as Run } from './ConsolidationRun.js';

const ids = (run: Run): string[] => run.getSteps().map(s => s.id);

// ── buildPlan: paczki z liczników ──────────────────────────────────────────────

test('60 sesji przy batchSize 5 → 12 paczek L1', t => {
    const plan = buildPlan({ archiveCount: 60, batchSize: 5 });
    const l1 = plan.filter(s => s.kind === STEP_KIND.L1);
    t.is(l1.length, 12);
    t.is(l1[0].id, 'l1_batch_1');
    t.is(l1[11].id, 'l1_batch_12');
    t.is(l1[11].total, 12);
    // Okna są deterministyczne i nie zachodzą na siebie.
    t.deepEqual(l1.map(s => s.meta!.offset), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
});

test('3 sesje przy batchSize 5 → 0 paczek L1 (reszta nie robi paczki)', t => {
    const plan = buildPlan({ archiveCount: 3, batchSize: 5 });
    t.is(plan.filter(s => s.kind === STEP_KIND.L1).length, 0);
});

test('reszta z dzielenia jest odcinana — 12 sesji / 5 = 2 paczki', t => {
    t.is(buildPlan({ archiveCount: 12, batchSize: 5 }).filter(s => s.kind === STEP_KIND.L1).length, 2);
});

test('dedup planowany od 2 notatek w brain/, poniżej wcale', t => {
    t.true(buildPlan({ brainNotesCount: 2 }).some(s => s.kind === STEP_KIND.DEDUP));
    t.false(buildPlan({ brainNotesCount: 1 }).some(s => s.kind === STEP_KIND.DEDUP));
    t.false(buildPlan({ brainNotesCount: 0 }).some(s => s.kind === STEP_KIND.DEDUP));
    const [dedup] = buildPlan({ brainNotesCount: 30, dedupThreshold: 25 });
    t.is(dedup.meta!.dedupThreshold, 25);
});

test('L2 planowany tylko gdy osiągalny (istniejące L1 + nowe paczki ≥ batchSize)', t => {
    // 12 paczek → L2 na pewno
    t.true(buildPlan({ archiveCount: 60, batchSize: 5 }).some(s => s.kind === STEP_KIND.L2));
    // 2 paczki + 0 istniejących L1 → za mało
    t.false(buildPlan({ archiveCount: 12, batchSize: 5 }).some(s => s.kind === STEP_KIND.L2));
    // 2 paczki + 3 istniejące L1 = 5 → wystarczy
    t.true(buildPlan({ archiveCount: 12, batchSize: 5, l1Count: 3 }).some(s => s.kind === STEP_KIND.L2));
});

test('L3 planowany tylko gdy osiągalny (istniejące L2 + ewentualne nowe ≥ batchSize)', t => {
    // 12 paczek L1 daje 1 nowy L2; bez zapasu L2 to za mało na L3
    t.false(buildPlan({ archiveCount: 60, batchSize: 5 }).some(s => s.kind === STEP_KIND.L3));
    // 4 istniejące L2 + 1 nowy = 5 → L3 wchodzi
    t.true(buildPlan({ archiveCount: 60, batchSize: 5, l2Count: 4 }).some(s => s.kind === STEP_KIND.L3));
    // 5 istniejących L2 wystarczy nawet bez nowego L2
    t.true(buildPlan({ archiveCount: 0, batchSize: 5, l2Count: 5 }).some(s => s.kind === STEP_KIND.L3));
});

test('L2/L3 rodzą się z kłódką, L1 i dedup jako pending', t => {
    const run = new ConsolidationRun({ counts: { archiveCount: 60, batchSize: 5, brainNotesCount: 5, l2Count: 4 } });
    t.is(run.getStep('dedup')!.status, STEP_STATUS.PENDING);
    t.is(run.getStep('l1_batch_1')!.status, STEP_STATUS.PENDING);
    t.is(run.getStep('l2')!.status, STEP_STATUS.GATED);
    t.is(run.getStep('l3')!.status, STEP_STATUS.GATED);
    t.deepEqual(ids(run).slice(0, 2), ['dedup', 'l1_batch_1']);
    t.deepEqual(ids(run).slice(-2), ['l2', 'l3']);
});

test('pusty przebieg (nic nie przekracza progów) ma zero kroków', t => {
    const run = new ConsolidationRun({ counts: { archiveCount: 2, brainNotesCount: 1 } });
    t.is(run.getSteps().length, 0);
});

// ── maszyna stanów ─────────────────────────────────────────────────────────────

test('legalna ścieżka kroku: pending → running → awaiting_review → applying → done', t => {
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });
    const id = 'l1_batch_1';
    run.startStep(id);
    t.is(run.getStep(id)!.status, STEP_STATUS.RUNNING);
    run.stepProposalReady(id, { body: 'streszczenie' });
    t.is(run.getStep(id)!.status, STEP_STATUS.AWAITING_REVIEW);
    t.deepEqual(run.getStep(id)!.result, { body: 'streszczenie' });
    run.beginApply(id, { accepted: true });
    t.is(run.getStep(id)!.status, STEP_STATUS.APPLYING);
    run.completeStep(id, { created: 1 });
    t.is(run.getStep(id)!.status, STEP_STATUS.DONE);
    t.deepEqual(run.getStep(id)!.applied, { created: 1 });
    t.true(run.isSettled());
});

test('nielegalne przejścia rzucają', t => {
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });
    const id = 'l1_batch_1';
    t.throws(() => run.stepProposalReady(id, {}), { message: /nielegalne przejście/ });
    t.throws(() => run.beginApply(id), { message: /nielegalne przejście/ });
    t.throws(() => run.completeStep(id), { message: /nielegalne przejście/ });
    run.startStep(id);
    t.throws(() => run.startStep(id), { message: /nielegalne przejście/ });
    t.throws(() => run.completeStep(id), { message: /nielegalne przejście/ });
});

test('nieznany krok rzuca', t => {
    const run = new ConsolidationRun({ counts: {} });
    t.throws(() => run.startStep('nie_ma'), { message: /nieznany krok/ });
});

test('ungate zdejmuje kłódkę tylko z kroku gated', t => {
    const run = new ConsolidationRun({ counts: { archiveCount: 60, batchSize: 5 } });
    run.ungate('l2');
    t.is(run.getStep('l2')!.status, STEP_STATUS.PENDING);
    t.throws(() => run.ungate('l2'), { message: /nielegalne przejście/ });
});

test('skipStep działa z pending, gated, awaiting_review i failed', t => {
    const run = new ConsolidationRun({ counts: { archiveCount: 60, batchSize: 5, brainNotesCount: 3 } });
    run.skipStep('l1_batch_1', 'user odrzucił');
    t.is(run.getStep('l1_batch_1')!.status, STEP_STATUS.SKIPPED);
    t.is(run.getStep('l1_batch_1')!.meta.skipReason, 'user odrzucił');
    run.skipStep('l2');
    t.is(run.getStep('l2')!.status, STEP_STATUS.SKIPPED);
    run.startStep('dedup');
    run.stepProposalReady('dedup', {});
    run.skipStep('dedup');
    t.is(run.getStep('dedup')!.status, STEP_STATUS.SKIPPED);
    run.startStep('l1_batch_2');
    run.failStep('l1_batch_2', new Error('boom'));
    run.skipStep('l1_batch_2');
    t.is(run.getStep('l1_batch_2')!.status, STEP_STATUS.SKIPPED);
});

test('failStep zapisuje przyczynę i kod', t => {
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });
    run.startStep('l1_batch_1');
    const err: Error & { code?: string } = new Error('HTTP 500');
    err.code = 'server_error';
    run.failStep('l1_batch_1', err);
    t.is(run.getStep('l1_batch_1')!.status, STEP_STATUS.FAILED);
    t.deepEqual(run.getStep('l1_batch_1')!.error, { message: 'HTTP 500', code: 'server_error' });
});

test('ręczne „Ponów": startStep z failed wraca do running i zeruje licznik retry', t => {
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });
    run.startStep('l1_batch_1');
    run.markStalled('l1_batch_1');       // retry 1
    run.markStalled('l1_batch_1');       // → failed
    t.is(run.getStep('l1_batch_1')!.status, STEP_STATUS.FAILED);
    run.startStep('l1_batch_1');
    t.is(run.getStep('l1_batch_1')!.status, STEP_STATUS.RUNNING);
    t.is(run.getStep('l1_batch_1')!.retryCount, 0);
    t.is(run.getStep('l1_batch_1')!.error, null);
});

// ── retry-polityka zwisu ───────────────────────────────────────────────────────

test('markStalled: pierwszy raz retry, drugi raz failed', t => {
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });
    run.startStep('l1_batch_1');

    const first = run.markStalled('l1_batch_1');
    t.deepEqual(first, { retry: true, retryCount: 1 });
    t.is(run.getStep('l1_batch_1')!.status, STEP_STATUS.RUNNING, 'krok zostaje w running na ponowienie');

    const second = run.markStalled('l1_batch_1');
    t.deepEqual(second, { retry: false, retryCount: 1 });
    t.is(run.getStep('l1_batch_1')!.status, STEP_STATUS.FAILED);
    t.is(run.getStep('l1_batch_1')!.error!.code, 'stream_stalled');
});

test('markStalled poza stanem running rzuca', t => {
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });
    t.throws(() => run.markStalled('l1_batch_1'), { message: /markStalled/ });
});

// ── gating L1 → L2 ─────────────────────────────────────────────────────────────

test('allL1Resolved: done i skipped liczą się, failed NIE', t => {
    const run = new ConsolidationRun({ counts: { archiveCount: 15, batchSize: 5 } });
    t.false(run.allL1Resolved());

    run.startStep('l1_batch_1');
    run.stepProposalReady('l1_batch_1', {});
    run.beginApply('l1_batch_1');
    run.completeStep('l1_batch_1');
    run.skipStep('l1_batch_2');
    t.false(run.allL1Resolved(), 'trzecia paczka wciąż pending');

    run.startStep('l1_batch_3');
    run.failStep('l1_batch_3', new Error('padło'));
    t.false(run.allL1Resolved(), 'failed blokuje L2 do decyzji usera');

    run.skipStep('l1_batch_3');
    t.true(run.allL1Resolved());
});

test('przebieg bez kroków L1 uznaje L1 za rozstrzygnięte', t => {
    const run = new ConsolidationRun({ counts: { brainNotesCount: 5 } });
    t.true(run.allL1Resolved());
});

// ── usage / koszt ──────────────────────────────────────────────────────────────

test('addUsage akumuluje po strzałach i sumuje się w totalUsage', t => {
    const run = new ConsolidationRun({ counts: { archiveCount: 10, batchSize: 5, brainNotesCount: 3 } });
    run.addUsage('l1_batch_1', { prompt_tokens: 1000, completion_tokens: 200 });
    run.addUsage('l1_batch_1', { prompt_tokens: 500, completion_tokens: 100 });   // retry
    run.addUsage('dedup', { input_tokens: 300, output_tokens: 50 });              // kształt Anthropic

    t.deepEqual(run.getStep('l1_batch_1')!.usage, {
        inputTokens: 1500, outputTokens: 300, cachedTokens: 0, calls: 2
    });
    t.deepEqual(run.totalUsage(), {
        inputTokens: 1800, outputTokens: 350, cachedTokens: 0, calls: 3
    });
});

test('addUsage ignoruje śmieci (null/undefined) bez zwiększania liczby strzałów', t => {
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });
    run.addUsage('l1_batch_1', null);
    run.addUsage('l1_batch_1', undefined);
    t.deepEqual(run.getStep('l1_batch_1')!.usage, { inputTokens: 0, outputTokens: 0, cachedTokens: 0, calls: 0 });
});

test('normalizeUsage rozumie kształt OpenAI i Anthropic', t => {
    t.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 2 }), { inputTokens: 10, outputTokens: 2, cachedTokens: 0 });
    t.deepEqual(normalizeUsage({ input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 4 }), { inputTokens: 7, outputTokens: 3, cachedTokens: 4 });
    t.is(normalizeUsage(null), null);
});

// ── onChange / postęp ──────────────────────────────────────────────────────────

test('onChange leci po każdej mutacji', t => {
    const seen: string[] = [];
    const run = new ConsolidationRun({
        counts: { archiveCount: 5, batchSize: 5 },
        onChange: (r) => seen.push(r.getStep('l1_batch_1')!.status),
    });
    run.startStep('l1_batch_1');
    run.addUsage('l1_batch_1', { prompt_tokens: 1 });
    run.stepProposalReady('l1_batch_1', {});
    run.beginApply('l1_batch_1');
    run.completeStep('l1_batch_1');
    t.deepEqual(seen, ['running', 'running', 'awaiting_review', 'applying', 'done']);
});

test('padnięty listener nie wywala przebiegu; addChangeListener zwraca odpinacz', t => {
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 } });
    run.addChangeListener(() => { throw new Error('UI padło'); });
    let count = 0;
    const off = run.addChangeListener(() => { count++; });
    run.startStep('l1_batch_1');
    t.is(count, 1);
    off();
    run.stepProposalReady('l1_batch_1', {});
    t.is(count, 1);
});

test('getActiveStep pokazuje krok, który mieli; progress liczy rozstrzygnięte', t => {
    const run = new ConsolidationRun({ counts: { archiveCount: 10, batchSize: 5 } });
    t.is(run.getActiveStep(), null);
    t.deepEqual(run.progress(), { settled: 0, total: 2 });

    run.startStep('l1_batch_1');
    t.is(run.getActiveStep()!.id, 'l1_batch_1');
    run.stepProposalReady('l1_batch_1', {});
    t.is(run.getActiveStep(), null, 'awaiting_review to nie robota, to czekanie na usera');
    t.deepEqual(run.getStepsAwaitingReview().map(s => s.id), ['l1_batch_1']);

    run.beginApply('l1_batch_1');
    t.is(run.getActiveStep()!.id, 'l1_batch_1');
    run.completeStep('l1_batch_1');
    t.deepEqual(run.progress(), { settled: 1, total: 2 });
    t.false(run.isSettled());
    run.skipStep('l1_batch_2');
    t.true(run.isSettled());
});

test('endedAt ustawia się raz, gdy wszystkie kroki są rozstrzygnięte', t => {
    let clock = 100;
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 }, now: () => clock });
    t.is(run.endedAt, null);
    clock = 500;
    run.skipStep('l1_batch_1');
    t.is(run.endedAt, 500);
});

test('endedAt odmarza po „Ponów" — drugie domknięcie ma świeży czas', t => {
    let clock = 100;
    const run = new ConsolidationRun({ counts: { archiveCount: 5, batchSize: 5 }, now: () => clock });

    clock = 500;
    run.startStep('l1_batch_1');
    run.failStep('l1_batch_1', new Error('pad'));
    t.is(run.endedAt, 500, 'przebieg domknięty z krokiem failed');

    clock = 900;
    run.startStep('l1_batch_1'); // user klika „Ponów"
    t.is(run.endedAt, null, 'przebieg znów pracuje — stary czas zakończenia nie może zostać');

    run.stepProposalReady('l1_batch_1', {});
    run.beginApply('l1_batch_1', { accepted: true });
    clock = 1200;
    run.completeStep('l1_batch_1');

    t.is(run.endedAt, 1200, 'czas zakończenia z DRUGIEGO domknięcia');
});
