/**
 * MemoryOpsCenter.test.ts — S29 Z2: rejestr jednego aktywnego przebiegu + rozgłaszanie.
 */
import test from 'ava';
import { MemoryOpsCenter, OPS_EVENT } from './MemoryOpsCenter.js';
import { ConsolidationRun } from './ConsolidationRun.js';
import type { MemoryOpsCenter as MemoryOpsCenterType, OpsEvent, OpsEventType } from './MemoryOpsCenter.js';

const makeRun = () => new ConsolidationRun({ counts: { archiveCount: 10, batchSize: 5 } });

function recorder(center: MemoryOpsCenterType) {
    const events: OpsEventType[] = [];
    const off = center.subscribe((e) => events.push(e.type));
    return { events, off };
}

test('startRun rejestruje przebieg i rozgłasza run_started', t => {
    const center = new MemoryOpsCenter();
    const { events } = recorder(center);
    const run = makeRun();

    t.false(center.isBusy());
    t.is(center.startRun(run), run);
    t.true(center.isBusy());
    t.is(center.getActiveRun(), run);
    t.deepEqual(events, [OPS_EVENT.RUN_STARTED]);
});

test('drugi startRun przy aktywnym NIE startuje drugiego przebiegu — zwraca aktywny i prosi o modal', t => {
    const center = new MemoryOpsCenter();
    const first = makeRun();
    const second = makeRun();
    center.startRun(first);
    const { events } = recorder(center);

    const returned = center.startRun(second);
    t.is(returned, first, 'dostajesz przebieg, który już leci');
    t.not(returned, second);
    t.is(center.getActiveRun(), first);
    t.deepEqual(events, [OPS_EVENT.OPEN_MODAL_REQUESTED]);
});

test('powtórny startRun tego samego przebiegu jest no-opem (bez drugiego run_started)', t => {
    const center = new MemoryOpsCenter();
    const run = makeRun();
    center.startRun(run);
    const { events } = recorder(center);
    t.is(center.startRun(run), run);
    t.deepEqual(events, []);
});

test('zmiana w przebiegu rozgłasza run_changed do subskrybentów', t => {
    const center = new MemoryOpsCenter();
    const run = makeRun();
    center.startRun(run);
    const { events } = recorder(center);

    run.startStep('l1_batch_1');
    run.stepProposalReady('l1_batch_1', { body: 'x' });
    t.deepEqual(events, [OPS_EVENT.RUN_CHANGED, OPS_EVENT.RUN_CHANGED]);
});

test('finishRun zwalnia centrum, rozgłasza run_finished z zakończonym przebiegiem i odpina go', t => {
    const center = new MemoryOpsCenter();
    const run = makeRun();
    center.startRun(run);

    const seen: OpsEvent[] = [];
    center.subscribe((e) => seen.push(e));
    const finished = center.finishRun();

    t.is(finished, run);
    t.false(center.isBusy());
    t.is(center.getActiveRun(), null);
    t.is(seen.length, 1);
    t.is(seen[0].type, OPS_EVENT.RUN_FINISHED);
    t.is(seen[0].run, run, 'zdarzenie końca niesie przebieg, nie null');

    // Po finishRun zmiany w starym przebiegu nie hałasują już w centrum.
    run.startStep('l1_batch_1');
    t.is(seen.length, 1);
});

test('finishRun bez aktywnego przebiegu jest bezpieczne', t => {
    const center = new MemoryOpsCenter();
    const { events } = recorder(center);
    t.is(center.finishRun(), null);
    t.deepEqual(events, []);
});

test('po finishRun można wystartować kolejny przebieg', t => {
    const center = new MemoryOpsCenter();
    const first = makeRun();
    const second = makeRun();
    center.startRun(first);
    center.finishRun();
    t.is(center.startRun(second), second);
});

test('requestOpenModal rozgłasza prośbę o modal z bieżącym przebiegiem', t => {
    const center = new MemoryOpsCenter();
    const run = makeRun();
    center.startRun(run);
    const seen: OpsEvent[] = [];
    center.subscribe((e) => seen.push(e));

    center.requestOpenModal();
    t.is(seen.length, 1);
    t.is(seen[0].type, OPS_EVENT.OPEN_MODAL_REQUESTED);
    t.is(seen[0].run, run);
});

test('unsubscribe (i zwrócony odpinacz) przestaje dostawać zdarzenia', t => {
    const center = new MemoryOpsCenter();
    const a: OpsEventType[] = [];
    const b: OpsEventType[] = [];
    const offA = center.subscribe((e) => a.push(e.type));
    const cbB = (e: OpsEvent) => b.push(e.type);
    center.subscribe(cbB);

    center.startRun(makeRun());
    offA();
    center.unsubscribe(cbB);
    center.requestOpenModal();

    t.deepEqual(a, [OPS_EVENT.RUN_STARTED]);
    t.deepEqual(b, [OPS_EVENT.RUN_STARTED]);
});

test('padnięty subskrybent nie blokuje pozostałych', t => {
    const center = new MemoryOpsCenter();
    const seen: OpsEventType[] = [];
    center.subscribe(() => { throw new Error('widok padł'); });
    center.subscribe((e) => seen.push(e.type));

    center.startRun(makeRun());
    t.deepEqual(seen, [OPS_EVENT.RUN_STARTED]);
});

test('startRun bez przebiegu rzuca', t => {
    const center = new MemoryOpsCenter();
    t.throws(() => center.startRun(null as unknown as Parameters<typeof center.startRun>[0]), { message: /brak przebiegu/ });
});
