import test from 'ava';
import type { ExecutionContext } from 'ava';
import { SubTaskRegistry } from './SubTaskRegistry.js';
import { SubTaskNotifier } from './SubTaskNotifier.js';
import type { SubTaskNotice } from './SubTaskNotifier.js';
import { QuestionTestClock } from './test-support/questionTestClock.js';

const owner = { agentName: 'Mira', sessionPath: 's.md', sessionEpoch: 'epoch-1' };
const parent = (runId: string) => ({ kind: 'sub', runId } as const);
const lead = { kind: 'lead' } as const;
function fixture(t: ExecutionContext, maxDone = 50) {
    const clock = new QuestionTestClock();
    const registry = new SubTaskRegistry({ questionClock: clock, maxDone });
    const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); });
    const create = (id: string, parentId?: string, origin = owner, background = true) => registry.create({
        id, name: id, agentName: origin.agentName, threadId: `${id}-thread`, origin, parentId, background,
    });
    const finish = (id: string, text: string) => {
        const task = registry.getTask(id);
        if (!task) throw new Error(`missing task ${id}`);
        registry.finish(task, { text, toolsUsed: [], durationMs: 0, usage: null });
    };
    const open = (id: string, text: string) => {
        const opened = registry.openParentQuestion(id, text);
        if (opened.kind !== 'opened') throw new Error(`missing question ${id}`);
        return opened;
    };
    return { registry, notifier, clock, create, finish, open };
}
function view(notice: SubTaskNotice | undefined): unknown {
    if (!notice) return 'closed';
    return notice.kind === 'question'
        ? { kind: 'question', run: notice.question.taskId, text: notice.question.text, recipient: notice.question.recipient }
        : { kind: 'result', run: notice.task.id, text: notice.task.result?.text, error: notice.task.error };
}
const views = (notices: SubTaskNotice[]) => notices.map(view);

test('Qg -> Qp -> odpowiedź Qp -> odpowiedź Qg, odrębni adresaci i identyfikatory', async t => {
    const f = fixture(t);
    f.create('p'); f.create('g', 'p');
    const qg = f.open('g', 'Jaki folder?');
    t.deepEqual(views(f.registry.takeChildNotices('p')), [
        { kind: 'question', run: 'g', text: 'Jaki folder?', recipient: { kind: 'sub', runId: 'p' } },
    ]);
    f.clock.advance(100000);
    const qp = f.open('p', 'Kuba, jaki folder?');
    t.false(qg.question.id === qp.question.id);
    t.deepEqual(views(f.notifier.pendingNotices()), [
        { kind: 'question', run: 'p', text: 'Kuba, jaki folder?', recipient: { kind: 'lead' } },
    ]);
    const state = f.registry.getQuestionState('g');
    t.deepEqual(state.kind === 'waiting' ? state.clock : state, { kind: 'ticking', remainingMs: 200000, since: 100000 });
    t.deepEqual(f.registry.answerParentQuestion('p', qp.question.id, owner, lead, 'Projekty/'), { kind: 'accepted' });
    const answer = await qp.resolution;
    t.deepEqual(answer, { kind: 'answered', text: 'Projekty/' });
    if (answer.kind !== 'answered') throw new Error('missing lead answer');
    t.deepEqual(f.registry.answerParentQuestion('g', qg.question.id, owner, parent('p'), answer.text), { kind: 'accepted' });
    t.deepEqual(await qg.resolution, { kind: 'answered', text: 'Projekty/' });
    t.deepEqual([f.registry.takeChildNotices('p'), f.notifier.pendingNotices(), f.clock.pending], [[], [], 0]);
});

test('dwaj rodzice w jednej sesji nie odpowiadają za siebie ani za prowadzącego', async t => {
    const f = fixture(t);
    f.create('p1'); f.create('p2'); f.create('g1', 'p1'); f.create('g2', 'p2');
    const a = f.open('g1', 'A?'); const b = f.open('g2', 'B?'); const up = f.open('p1', 'Do prowadzącego?');
    t.deepEqual([
        f.registry.answerParentQuestion('g1', a.question.id, owner, parent('p2'), 'obce'),
        f.registry.answerParentQuestion('g1', a.question.id, owner, 'od prowadzącego'),
        f.registry.answerParentQuestion('p1', up.question.id, owner, parent('p2'), 'obce'),
        f.registry.answerParentQuestion('g1', b.question.id, owner, parent('p1'), 'inne Q'),
        f.registry.answerParentQuestion('g1', a.question.id, { ...owner, sessionEpoch: 'epoch-2' }, parent('p1'), 'inna sesja'),
    ], [
        { kind: 'rejected', reason: 'wrong-recipient' }, { kind: 'rejected', reason: 'wrong-recipient' },
        { kind: 'rejected', reason: 'wrong-recipient' }, { kind: 'rejected', reason: 'wrong-question' },
        { kind: 'rejected', reason: 'wrong-owner' },
    ]);
    t.deepEqual(views(f.registry.takeChildNotices('p2')), [
        { kind: 'question', run: 'g2', text: 'B?', recipient: { kind: 'sub', runId: 'p2' } },
    ]);
    f.registry.answerParentQuestion('g1', a.question.id, owner, parent('p1'), 'A/');
    const next = f.open('g1', 'Jeszcze?');
    t.deepEqual(f.registry.answerParentQuestion('g1', a.question.id, owner, parent('p1'), 'stare'), { kind: 'rejected', reason: 'wrong-question' });
    f.registry.answerParentQuestion('g1', next.question.id, owner, parent('p1'), 'dalej');
    f.registry.answerParentQuestion('g2', b.question.id, owner, parent('p2'), 'B/');
    t.deepEqual(await Promise.all([a.resolution, b.resolution, next.resolution]), [
        { kind: 'answered', text: 'A/' }, { kind: 'answered', text: 'B/' }, { kind: 'answered', text: 'dalej' },
    ]);
});

test('wnuk i rodzic mają osobne granice 299999/300000, eskalacja nie resetuje zegara', async t => {
    const f = fixture(t);
    f.create('p'); f.create('g', 'p'); const qg = f.open('g', 'Qg');
    f.clock.advance(100000); const qp = f.open('p', 'Qp');
    f.clock.advance(199999);
    t.deepEqual(['g', 'p'].map(id => {
        const state = f.registry.getQuestionState(id);
        return state.kind === 'waiting' ? [state.kind, state.clock.remainingMs] : state.kind;
    }), [['waiting', 1], ['waiting', 100001]]);
    f.clock.advance(1);
    t.deepEqual(await qg.resolution, { kind: 'no-answer' });
    t.deepEqual(f.registry.answerParentQuestion('g', qg.question.id, owner, parent('p'), 'za późno'), { kind: 'rejected', reason: 'expired' });
    f.clock.advance(99999); t.is(f.registry.getQuestionState('p').kind, 'waiting');
    f.clock.advance(1); t.deepEqual(await qp.resolution, { kind: 'no-answer' });
    t.deepEqual([f.registry.takeChildNotices('p'), f.notifier.pendingNotices(), f.clock.pending], [[], [], 0]);
});

test('zamknięte i przeterminowane przed odbiorem pytania znikają, wynik pozostaje', async t => {
    const f = fixture(t);
    f.create('p'); f.create('g', 'p'); f.create('g2', 'p');
    const q = f.open('g', 'anulowane'); const expired = f.open('g2', 'przeterminowane');
    f.registry.cancelParentQuestion('g');
    f.clock.advance(300000, false);
    f.finish('g', 'dorobek');
    t.deepEqual(views(f.registry.takeChildNotices('p')), [{ kind: 'result', run: 'g', text: 'dorobek', error: undefined }]);
    t.deepEqual(await Promise.all([q.resolution, expired.resolution]), [
        { kind: 'cancelled', by: 'system', reason: 'run-ended' }, { kind: 'no-answer' },
    ]);
    t.deepEqual([f.registry.takeChildNotices('p'), f.clock.pending], [[], 0]);
});

test('wynik pomiędzy sprawdzeniem a wait oraz po subskrypcji dociera dokładnie raz', async t => {
    const f = fixture(t);
    f.create('p'); f.create('g1', 'p'); f.create('g2', 'p'); f.create('g3', 'p');
    t.deepEqual(f.registry.takeChildNotices('p'), []);
    f.finish('g1', 'przed wait');
    const signal = new AbortController().signal;
    t.deepEqual(view(await f.registry.waitChildNotice('p', signal)), { kind: 'result', run: 'g1', text: 'przed wait', error: undefined });
    const second = f.registry.waitChildNotice('p', signal);
    const third = f.registry.waitChildNotice('p', signal);
    f.finish('g2', 'po wait'); f.finish('g2', 'duplikat'); f.finish('g3', 'trzeci');
    t.deepEqual((await Promise.all([second, third])).map(view), [
        { kind: 'result', run: 'g2', text: 'po wait', error: undefined }, { kind: 'result', run: 'g3', text: 'trzeci', error: undefined },
    ]);
    t.deepEqual(f.registry.takeChildNotices('p'), []);
});

test('pytanie zamknięte w tej samej emisji nie jest odbierane przez obudzonego rodzica', async t => {
    const f = fixture(t);
    f.create('p'); f.create('g', 'p');
    f.registry.events.on('question:opened', () => f.registry.cancelParentQuestion('g'));
    const pending = f.registry.waitChildNotice('p', new AbortController().signal);
    const q = f.open('g', 'znikające');
    f.finish('g', 'po zamknięciu');
    t.deepEqual(view(await pending), { kind: 'result', run: 'g', text: 'po zamknięciu', error: undefined });
    t.deepEqual(await q.resolution, { kind: 'cancelled', by: 'system', reason: 'run-ended' });
    t.is(f.clock.pending, 0);
});

test('take i wait współdzielą jedną konsumpcję; anulowanie oczekiwania nie zjada wyniku', async t => {
    const f = fixture(t);
    f.create('p'); f.create('g1', 'p'); f.create('g2', 'p');
    const abort = new AbortController();
    const pending = f.registry.waitChildNotice('p', abort.signal);
    f.finish('g1', 'synchroniczny odbiór');
    t.deepEqual(views(f.registry.takeChildNotices('p')), [{ kind: 'result', run: 'g1', text: 'synchroniczny odbiór', error: undefined }]);
    abort.abort();
    t.is(view(await pending), 'closed');
    f.finish('g2', 'po anulowaniu');
    t.is(view(await f.registry.waitChildNotice('p', abort.signal)), 'closed');
    t.deepEqual(views(f.registry.takeChildNotices('p')), [{ kind: 'result', run: 'g2', text: 'po anulowaniu', error: undefined }]);
});

test('pytania i wyniki wnuków są tylko w skrzynce rodzica, również bez background', t => {
    const f = fixture(t);
    f.create('p'); f.create('g', 'p', owner, false); f.create('bg', 'p'); f.create('root');
    f.open('g', 'do rodzica'); f.open('root', 'do prowadzącego');
    t.deepEqual(views(f.registry.takeChildNotices('p')), [
        { kind: 'question', run: 'g', text: 'do rodzica', recipient: { kind: 'sub', runId: 'p' } },
    ]);
    f.finish('g', 'wynik wnuka'); f.finish('bg', 'wynik tła'); f.finish('root', 'wynik suba');
    t.deepEqual(views(f.registry.takeChildNotices('p')), [
        { kind: 'result', run: 'g', text: 'wynik wnuka', error: undefined }, { kind: 'result', run: 'bg', text: 'wynik tła', error: undefined },
    ]);
    t.deepEqual(views(f.notifier.pendingNotices()), [{ kind: 'result', run: 'root', text: 'wynik suba', error: undefined }]);
});

for (const end of ['stop', 'finish', 'dispose'] as const) {
    test(`${end} rodzica zwalnia oczekiwanie i nie doręcza późnego wyniku`, async t => {
        const f = fixture(t);
        f.create('p'); const child = f.create('g', 'p');
        const q = f.open('g', 'pytanie');
        const before = f.registry.takeChildNotices('p');
        t.deepEqual(views(before), [{ kind: 'question', run: 'g', text: 'pytanie', recipient: { kind: 'sub', runId: 'p' } }]);
        const pending = f.registry.waitChildNotice('p', new AbortController().signal);
        if (end === 'stop') f.registry.requestStop('p', 'user');
        else if (end === 'finish') f.finish('p', 'koniec');
        else f.registry.dispose();
        f.registry.finish(child, { text: 'późny wynik', toolsUsed: [], durationMs: 0, usage: null });
        t.is(view(await pending), 'closed');
        t.deepEqual(f.registry.answerParentQuestion('g', q.question.id, owner, parent('p'), 'późna odpowiedź'), { kind: 'rejected', reason: 'expired' });
        t.deepEqual([f.registry.takeChildNotices('p'), f.clock.pending], [[], 0]);
        t.deepEqual(await q.resolution, { kind: 'cancelled', by: end === 'stop' ? 'user' : 'system', reason: end === 'stop' ? 'stop' : end === 'dispose' ? 'unload' : 'run-ended' });
    });
}

test('retencja zakończonych dzieci nie gubi dorobku czekającego w skrzynce', t => {
    const f = fixture(t, 1);
    f.create('p'); f.create('g1', 'p'); f.create('g2', 'p');
    f.finish('g1', 'pierwszy');
    f.registry.fail(f.registry.getTask('g2')!, 'awaria', undefined, { text: 'dorobek po błędzie', toolsUsed: [], durationMs: 0, usage: null });
    t.deepEqual(f.registry.list().map(task => task.id), ['p', 'g2']);
    t.is(f.registry.pruneSession(owner.sessionPath), 1);
    t.deepEqual(views(f.registry.takeChildNotices('p')), [
        { kind: 'result', run: 'g1', text: 'pierwszy', error: undefined },
        { kind: 'result', run: 'g2', text: 'dorobek po błędzie', error: 'awaria' },
    ]);
});

test('osierocony i obcy rodzic nie przyjmują pytania', t => {
    const f = fixture(t);
    f.create('p', undefined, { ...owner, sessionEpoch: 'other' }); f.create('g', 'p'); f.create('orphan', 'missing');
    t.deepEqual([f.registry.openParentQuestion('g', 'obce'), f.registry.openParentQuestion('orphan', 'osierocone')], [
        { kind: 'rejected', reason: 'unavailable' }, { kind: 'rejected', reason: 'unavailable' },
    ]);
    f.create('own'); f.create('valid', 'own');
    t.deepEqual(f.open('valid', 'własne').question.recipient, { kind: 'sub', runId: 'own' });
});
