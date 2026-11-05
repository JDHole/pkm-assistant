import test from 'ava';
import type { ExecutionContext } from 'ava';
import { getEventListeners } from 'node:events';
import { createSubAgentTool } from './DelegateTool.js';
import { MCPClient } from './MCPClient.js';
import { ToolRegistry } from './ToolRegistry.js';
import { createAskUserChannels } from './AskUserChannels.js';
import { createAskUserTool } from './AskUserTool.js';
import { SubTaskRegistry } from '../sub-agents/index.js';
import type { SubRunContext } from '../sub-agents/index.js';
import { QuestionTestClock } from '../sub-agents/test-support/questionTestClock.js';

const owner = { agentName: 'Mira', sessionPath: 's.md', sessionEpoch: 'epoch-1' };
function fixture(t: ExecutionContext, disabledControls = false) {
    const clock = new QuestionTestClock();
    const registry = new SubTaskRegistry({ questionClock: clock });
    t.teardown(() => registry.dispose());
    const create = (id: string, parentId?: string, origin = owner) => {
        const level = parentId ? 2 : 1;
        registry.createThread({ threadId: `${id}-thread`, name: id, owner: origin, origin, config: {}, parentId, level });
        return registry.create({ id, threadId: `${id}-thread`, name: id, agentName: origin.agentName, origin, parentId, level });
    };
    const open = (id: string, text = 'Jaki folder?') => {
        const q = registry.openParentQuestion(id, text);
        if (q.kind !== 'opened') throw new Error('question unavailable');
        return q;
    };
    const tool = createSubAgentTool({});
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(tool as never);
    const plugin = { subTaskRegistry: registry, toolRegistry,
        agentManager: { getAgent: () => ({ name: 'Mira', disabled_tools: disabledControls ? ['sub_agent'] : [] }) },
        permissionSystem: { checkPermission: () => ({ allowed: true, requiresApproval: false }), requiresApproval: () => false },
    };
    const client = new MCPClient(null as never, plugin as never, toolRegistry as never);
    const call = (args: Record<string, unknown>, runId?: string) => client.executeToolCall({ name: 'sub_agent', arguments: args }, 'Mira', {
        origin: owner, ...(runId ? { subRunContext: { runId, level: 1, origin: owner } satisfies SubRunContext } : {}),
    });
    return { clock, registry, create, open, call, tool, plugin };
}

test('MCP: adresat pochodzi z runtime; obcy sub i prowadzący nie odpowiadają na Qg', async t => {
    const f = fixture(t);
    f.create('p1'); f.create('p2'); f.create('g', 'p1');
    const q = f.open('g');
    const args = { action: 'message', sub_id: 'g-thread', question_id: q.question.id, text: 'Projekty/',
        _invocationSubRunContext: { runId: 'p1', level: 1, origin: owner }, recipient: { kind: 'sub', runId: 'p1' } };
    t.deepEqual(await f.call(args, 'p2'), { success: false, isError: true, error: 'This sub-agent belongs to another agent or conversation. Use delegate to create your own sub-agent.' });
    t.deepEqual(await f.call(args), { success: false, isError: true, error: 'This question is no longer active. If the thread can be continued, use sub_agent task; otherwise delegate a new task.', code: 'question_expired', activeQuestionId: q.question.id });
    t.is(f.registry.getQuestionState('g').kind, 'waiting');
    t.deepEqual(await f.call({ ...args, _invocationSubRunContext: { runId: 'p2', level: 1, origin: owner } }, 'p1'), {
        success: true, message: 'Answer delivered to sub-agent g-thread.',
    });
    t.deepEqual(await q.resolution, { kind: 'answered', text: 'Projekty/' });
    t.deepEqual([f.registry.takeMessages('g'), f.registry.takeChildNotices('p1'), f.clock.pending], [[], [], 0]);
});

test('sub_agent list i sterowanie istniejącym biegiem obejmuje wyłącznie dzieci rodzica', async t => {
    const f = fixture(t);
    f.create('p1'); f.create('p2'); f.create('g1', 'p1'); f.create('g2', 'p2');
    t.deepEqual(await f.call({ action: 'list' }, 'p1'), { success: true, threads: [
        { sub_id: 'g1-thread', name: 'g1', phase: 'running', runs: 1, outcome: null, questionState: { kind: 'none' } },
    ] });
    for (const action of ['message', 'stop', 'close']) {
        t.deepEqual(await f.call({ action, sub_id: 'g2-thread', text: 'obce' }, 'p1'), { success: false, isError: true, error: 'This sub-agent belongs to another agent or conversation. Use delegate to create your own sub-agent.' });
    }
    const q = f.open('g1');
    t.deepEqual(await f.call({ action: 'message', sub_id: 'g1-thread', text: 'doprecyzowanie' }, 'p1'), {
        success: true, message: 'Message sent to sub-agent g1-thread.',
    });
    t.deepEqual([f.registry.takeMessages('g1'), f.registry.getQuestionState('g1').kind], [['doprecyzowanie'], 'waiting']);
    f.registry.answerParentQuestion('g1', q.question.id, owner, { kind: 'sub', runId: 'p1' }, 'odpowiedź');
    t.deepEqual(await q.resolution, { kind: 'answered', text: 'odpowiedź' });
});

test('stare Q i nowy bieg tego samego wątku rodzica nie przejmują adresata', async t => {
    const f = fixture(t);
    const old = f.create('p'); f.create('g', 'p');
    const q1 = f.open('g');
    await f.call({ action: 'message', sub_id: 'g-thread', question_id: q1.question.id, text: 'pierwsza' }, 'p');
    const q2 = f.open('g', 'drugie');
    t.deepEqual(await f.call({ action: 'message', sub_id: 'g-thread', question_id: q1.question.id, text: 'stara' }, 'p'), {
        success: false, isError: true, error: 'This question is no longer active. If the thread can be continued, use sub_agent task; otherwise delegate a new task.', code: 'question_expired', activeQuestionId: q2.question.id,
    });
    f.registry.finish(old, { text: 'koniec rodzica', toolsUsed: [], durationMs: 0, usage: null });
    f.registry.endRun('p-thread', { successful: true });
    f.registry.beginRun('p-thread', owner);
    f.registry.create({ id: 'p-next', threadId: 'p-thread', name: 'p', agentName: owner.agentName, origin: owner, level: 1 });
    t.deepEqual(await f.call({ action: 'message', sub_id: 'g-thread', question_id: q2.question.id, text: 'nowy rodzic' }, 'p-next'), {
        success: false, isError: true, error: 'This sub-agent belongs to another agent or conversation. Use delegate to create your own sub-agent.',
    });
    t.deepEqual(await f.call({ action: 'list' }, 'p-next'), { success: true, threads: [] });
    t.deepEqual(await q1.resolution, { kind: 'answered', text: 'pierwsza' });
    t.deepEqual(f.registry.getQuestionState('g').kind, 'waiting');
});

test('kontekst zatrzymanego rodzica i obcej epoki odmawia, prowadzący bez kontekstu nadal działa', async t => {
    const f = fixture(t);
    f.create('p'); f.create('g', 'p'); f.create('root');
    f.registry.requestStop('p', 'user');
    t.deepEqual(await f.call({ action: 'list' }, 'p'), { success: false, isError: true, error: 'This sub-agent belongs to another agent or conversation. Use delegate to create your own sub-agent.' });
    f.create('other', undefined, { ...owner, sessionEpoch: 'other-epoch' });
    t.deepEqual(await f.call({ action: 'list' }, 'other'), { success: false, isError: true, error: 'This sub-agent belongs to another agent or conversation. Use delegate to create your own sub-agent.' });
    const q = f.open('root');
    t.deepEqual(await f.call({ action: 'message', sub_id: 'root-thread', question_id: q.question.id, text: 'od prowadzącego' }), {
        success: true, message: 'Answer delivered to sub-agent root-thread.',
    });
    t.deepEqual(await q.resolution, { kind: 'answered', text: 'od prowadzącego' });
});

test('kanały człowieka pauzują Qg i Qp do ostatniego zwolnienia, obca epoka tyka dalej', async t => {
    const f = fixture(t);
    f.create('p'); f.create('g', 'p'); f.create('other', undefined, { ...owner, sessionEpoch: 'other-epoch' });
    const qg = f.open('g');
    f.clock.advance(100000);
    const qp = f.open('p'); const other = f.open('other');
    const channels = createAskUserChannels(f.registry);
    const first = channels.open(owner); const last = channels.open(owner);
    const ask = createAskUserTool().execute({ question: 'Kuba, jaki folder?', question_id: qp.question.id, _invocationAskUserChannelId: last.id }, {}, { _askUserChannels: channels });
    f.clock.advance(600000);
    t.deepEqual(await other.resolution, { kind: 'no-answer' });
    const clocks = () => ['g', 'p'].map(id => {
        const state = f.registry.getQuestionState(id);
        return state.kind === 'waiting' ? state.clock : state;
    });
    t.deepEqual(clocks(), [{ kind: 'paused', remainingMs: 200000 }, { kind: 'paused', remainingMs: 300000 }]);
    first.cancel(); first.cancel();
    f.clock.advance(600000);
    t.deepEqual(clocks(), [{ kind: 'paused', remainingMs: 200000 }, { kind: 'paused', remainingMs: 300000 }]);
    last.answer('Projekty/');
    t.deepEqual(clocks(), [
        { kind: 'ticking', remainingMs: 200000, since: 1300000 }, { kind: 'ticking', remainingMs: 300000, since: 1300000 },
    ]);
    const human = await ask;
    t.is('answer' in human ? human.answer : undefined, 'Projekty/');
    f.clock.advance(199999);
    t.deepEqual(clocks(), [
        { kind: 'ticking', remainingMs: 1, since: 1499999 }, { kind: 'ticking', remainingMs: 100001, since: 1499999 },
    ]);
    await f.call({ action: 'message', sub_id: 'p-thread', question_id: qp.question.id, text: 'Projekty/' });
    await f.call({ action: 'message', sub_id: 'g-thread', question_id: qg.question.id, text: 'Projekty/' }, 'p');
    t.deepEqual(await Promise.all([qp.resolution, qg.resolution]), [
        { kind: 'answered', text: 'Projekty/' }, { kind: 'answered', text: 'Projekty/' },
    ]);
    t.is(f.clock.pending, 0);
});

test('waitChildNotice zwalnia subskrypcję abortu po wyniku, Stopie i dispose', async t => {
    const f = fixture(t);
    f.create('p'); const child = f.create('g', 'p');
    const signal = new AbortController().signal;
    const pending = f.registry.waitChildNotice('p', signal);
    t.is(getEventListeners(signal, 'abort').length, 1);
    f.registry.finish(child, { text: 'wynik', toolsUsed: [], durationMs: 0, usage: null });
    const result = await pending;
    t.deepEqual([result?.kind, result?.kind === 'result' ? result.task.result?.text : '', getEventListeners(signal, 'abort').length], ['result', 'wynik', 0]);
    const stopped = f.registry.waitChildNotice('p', signal);
    f.registry.requestStop('p');
    t.deepEqual([await stopped, getEventListeners(signal, 'abort').length], [undefined, 0]);
    f.create('other');
    const disposed = f.registry.waitChildNotice('other', signal);
    f.registry.dispose();
    t.deepEqual([await disposed, getEventListeners(signal, 'abort').length, f.registry.events.listenerCount('task:finished'), f.clock.pending], [undefined, 0, 0, 0]);
});

test('F3 disabled sub_agent permits only a live own-child answer; lead keeps 2.4.1 gate', async t => {
    const f = fixture(t, true);
    f.create('p1'); f.create('p2'); f.create('g1', 'p1'); f.create('g2', 'p2');
    const own = f.open('g1'), other = f.open('g2'), lead = f.open('p1');
    const reply = { action: 'message', sub_id: 'g1-thread', question_id: own.question.id, text: 'niebieski' };
    const denied = { isError: true, error: 'Permission denied: Tool "sub_agent" is disabled for this agent (Permissions)' };
    for (const args of [
        ...['task', 'start', 'list', 'stop', 'close'].map(action => ({ ...reply, action, task: 'new task' })),
        { action: 'message', sub_id: 'g1-thread', text: 'ordinary message' },
        { ...reply, sub_id: 'g2-thread', question_id: other.question.id },
        { ...reply, question_id: 'stale-question' },
        { ...reply, text: '' },
    ]) t.deepEqual(await f.call(args, 'p1'), denied);
    t.deepEqual(await f.call({ ...reply, _invocationSubRunContext: { runId: 'p1', level: 1, origin: owner } }, 'p2'), denied);
    t.deepEqual(await f.call({ action: 'message', sub_id: 'p1-thread', question_id: lead.question.id, text: 'lead answer' }), denied);
    t.deepEqual(await f.call({ ...reply, _invocationSubRunContext: { runId: 'p1', level: 1, origin: owner } }), denied);
    t.deepEqual(await f.call(reply, 'p1'), { success: true, message: 'Answer delivered to sub-agent g1-thread.' });
    t.deepEqual(await own.resolution, { kind: 'answered', text: 'niebieski' });
    t.deepEqual(await f.call(reply, 'p1'), denied);
    f.registry.finish(f.registry.getTask('g1')!, { text: 'done', toolsUsed: [], durationMs: 0, usage: null });
    f.registry.endRun('g1-thread', { successful: true });
    t.is(f.registry.getThread('g1-thread')?.phase, 'idle');
    t.deepEqual(await f.call({ action: 'task', sub_id: 'g1-thread', task: 'continue' }, 'p1'), denied);
    t.deepEqual(f.registry.getThread('g1-thread')?.runIds, ['g1']);
    f.clock.advance(299999);
    t.deepEqual([f.registry.getQuestionState('g2').kind, f.registry.getQuestionState('p1').kind], ['waiting', 'waiting']);
    f.clock.advance(1);
    t.deepEqual(await Promise.all([other.resolution, lead.resolution]), [{ kind: 'no-answer' }, { kind: 'no-answer' }]);
    t.deepEqual(await f.call({ ...reply, sub_id: 'g2-thread', question_id: other.question.id }, 'p2'), denied);
});

test('F3 disabled sub_agent rejects stopped parents, ended children and foreign epochs', async t => {
    const f = fixture(t, true);
    f.create('p'); f.create('g', 'p');
    const q = f.open('g');
    const args = { action: 'message', sub_id: 'g-thread', question_id: q.question.id, text: 'answer' };
    const denied = { isError: true, error: 'Permission denied: Tool "sub_agent" is disabled for this agent (Permissions)' };
    t.deepEqual(await f.call(args, 'missing-parent'), denied);
    f.create('foreign', undefined, { ...owner, sessionEpoch: 'other' });
    t.deepEqual(await f.call(args, 'foreign'), denied);
    f.registry.requestStop('p', 'user');
    t.deepEqual(await f.call(args, 'p'), denied);
    t.deepEqual(await q.resolution, { kind: 'cancelled', by: 'user', reason: 'stop' });
});
