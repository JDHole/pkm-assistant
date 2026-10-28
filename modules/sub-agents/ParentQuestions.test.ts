import test from 'ava';
import { SubTaskRegistry } from './SubTaskRegistry.js';
import { QuestionTestClock } from './test-support/questionTestClock.js';

const owner = { agentName: 'Jaskier', sessionPath: 's.md', sessionEpoch: 'e1' };
function fixture() {
    const clock = new QuestionTestClock(); const registry = new SubTaskRegistry({ questionClock: clock });
    const create = (id = 'r1', subId = 's1') => registry.create({ id, threadId: subId, name: 'Klara', origin: owner, background: true });
    return { clock, registry, create };
}
function open(registry: SubTaskRegistry, id = 'r1') {
    const result = registry.openParentQuestion(id, 'Jaki zakres?');
    if (result.kind !== 'opened') throw new Error('question did not open');
    return result;
}
test('otwarcie i odpowiedź dotyczą jednego pytania', async t => {
    const { registry, create } = fixture(); create(); const q = open(registry);
    const state = registry.getQuestionState('r1');
    const projection = state.kind === 'waiting' ? { kind: state.kind, id: state.question.id === q.question.id ? 'q1' : 'other' } : state;
    registry.answerParentQuestion('r1', q.question.id, owner, 'A/');
    t.deepEqual([projection, await q.resolution], [{ kind: 'waiting', id: 'q1' }, { kind: 'answered', text: 'A/' }]);
});
test('granica pięciu minut', async t => {
    const { clock, registry, create } = fixture(); create(); const q = open(registry);
    clock.advance(299999); const state = registry.getQuestionState('r1').kind; clock.advance(1);
    t.deepEqual([state, (await q.resolution).kind], ['waiting', 'no-answer']);
});
test('odpowiedź po terminie jest odrzucona', t => {
    const { clock, registry, create } = fixture(); create(); const q = open(registry); clock.advance(300000, false);
    t.deepEqual(registry.answerParentQuestion('r1', q.question.id, owner, 'A/'), { kind: 'rejected', reason: 'expired' });
    t.is(clock.pending, 0);
});
test('ask_user właściciela zachowuje resztę czasu', t => {
    const { clock, registry, create } = fixture(); create(); open(registry); clock.advance(100000);
    const release = registry.registerUserWait(owner, () => {}); clock.advance(600000); release();
    const state = registry.getQuestionState('r1');
    t.deepEqual(state.kind === 'waiting' ? { kind: state.clock.kind, remainingMs: state.clock.remainingMs } : state, { kind: 'ticking', remainingMs: 200000 }); registry.dispose();
});
test('inna sesja nie zatrzymuje zegara', async t => {
    const results: string[] = [];
    for (const other of [{ ...owner, agentName: 'Inny' }, { ...owner, sessionPath: 'inne.md' }, { ...owner, sessionEpoch: 'e2' }]) {
        const { clock, registry, create } = fixture(); create(); const q = open(registry); registry.registerUserWait(other, () => {}); clock.advance(300000); results.push((await q.resolution).kind); registry.dispose();
    }
    t.deepEqual(results, ['no-answer', 'no-answer', 'no-answer']);
});
test('nowe pytanie dziedziczy otwartą pauzę sesji', t => {
    const { registry, create } = fixture(); create(); registry.registerUserWait(owner, () => {}); open(registry);
    const state = registry.getQuestionState('r1'); t.deepEqual(state.kind === 'waiting' ? state.clock : state, { kind: 'paused', remainingMs: 300000 }); registry.dispose();
});
test('anulowanie rozwiązuje oczekiwanie raz', async t => {
    const { registry, create } = fixture(); create(); const q = open(registry); registry.attachAbort('r1', () => {});
    registry.requestStop('r1', 'user'); const answer = registry.answerParentQuestion('r1', q.question.id, owner, 'A/'); registry.requestStop('r1', 'user');
    t.deepEqual([await q.resolution, answer.kind === 'rejected' ? answer.reason : answer.kind], [{ kind: 'cancelled', by: 'user', reason: 'stop' }, 'expired']);
});
test('dwa suby mają osobne odpowiedzi', async t => {
    const { registry, create } = fixture(); create(); create('r2', 's2'); const a = open(registry); const b = open(registry, 'r2');
    registry.answerParentQuestion('r2', b.question.id, owner, 'B/'); registry.answerParentQuestion('r1', a.question.id, owner, 'A/');
    const ar = await a.resolution; const br = await b.resolution;
    t.deepEqual([['r1', ar.kind === 'answered' ? ar.text : ''], ['r2', br.kind === 'answered' ? br.text : '']], [['r1', 'A/'], ['r2', 'B/']]);
});
test('wiele kanałów pauzuje do zwolnienia ostatniego i dispose anuluje kanały', t => {
    const { clock, registry, create } = fixture(); create(); open(registry); let cancelled = 0;
    const first = registry.registerUserWait(owner, () => { cancelled++; });
    registry.registerUserWait(owner, () => { cancelled++; }); first(); first(); clock.advance(600000);
    const state = registry.getQuestionState('r1');
    t.deepEqual(state.kind === 'waiting' ? state.clock : state, { kind: 'paused', remainingMs: 300000 });
    registry.dispose(); t.is(cancelled, 1); t.is(clock.pending, 0);
});
test('koniec i timeout nie pozwalają otworzyć nowego oczekiwania', t => {
    const { clock, registry, create } = fixture(); const task = create(); open(registry);
    let reentrant = '';
    registry.events.on('question:closed', () => { reentrant = registry.openParentQuestion('r1', 'drugie').kind; });
    registry.finish(task, { text: '', toolsUsed: [], durationMs: 0, usage: null });
    t.is(reentrant, 'rejected');
    create('r2', 's2'); open(registry, 'r2'); clock.advance(300000);
    t.deepEqual(registry.openParentQuestion('r2', 'drugie'), { kind: 'rejected', reason: 'unavailable' }); registry.dispose();
});
test('obcy właściciel i inne pytanie nie rozwiązują oczekiwania', async t => {
    const { registry, create } = fixture(); create(); create('r2', 's2'); const first = open(registry); const second = open(registry, 'r2');
    t.deepEqual(registry.answerParentQuestion('r1', second.question.id, owner, 'B/'), { kind: 'rejected', reason: 'wrong-question' });
    t.deepEqual(registry.answerParentQuestion('r1', first.question.id, { ...owner, sessionEpoch: 'e2' }, 'B/'), { kind: 'rejected', reason: 'wrong-owner' });
    t.is(registry.getQuestionState('r1').kind, 'waiting'); registry.dispose();
    t.deepEqual(await first.resolution, { kind: 'cancelled', by: 'system', reason: 'unload' });
});
