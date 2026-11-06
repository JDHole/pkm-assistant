import test from 'ava';
import { SubTaskPlan, SubTaskRegistry, SubTaskNotifier, limitPlanResult } from '../../sub-agents/index.js';
import { sanitizeToolTranscript } from '../../agent-loop/index.js';
import { buildSubTaskPlanDelivery, deliverSubTaskPlan, consumeSubTaskPlans } from './subTaskPlanDelivery.js';
import { send_message } from './chat_streaming.js';
import type { PlanResultNotice } from '../../sub-agents/index.js';

const owner = { agentName: 'Mira', sessionPath: 'chat.md', sessionEpoch: 'a'.repeat(32) };
async function fixture() {
    const registry = new SubTaskRegistry({ appendHistory: async () => {} }), notifier = new SubTaskNotifier({ registry });
    const valid = SubTaskPlan.create([{ id: 'A' }, { id: 'B' }, { id: 'C', depends_on: ['A', 'B'] }], 5);
    if (valid.kind !== 'valid') throw new Error('invalid fixture');
    const plan = await registry.createPlan(valid.plan, owner);
    const tab = { ...owner, sessionId: 'tab', isActive: true };
    const window = { messages: [] as Array<{ role: 'user'; content: string; subTaskPlanId?: string }> };
    const view = { chatTabs: [tab], rollingWindow: window, env: {},
        plugin: { subTaskRegistry: registry, subTaskNotifier: notifier,
            agentManager: { getActiveAgent: () => ({ name: 'Mira' }), getAgentMemory: () => ({ activeSessionPath: 'chat.md', sessionEpoch: 'a'.repeat(32) }) } },
        _autoTurnChainCounts: new Map(), _subTaskTurnPending: false, is_generating: false, _drainSuppressed: false,
        send_message: async ({ injectedText, meta }: { injectedText: string; meta: { subTaskPlanId: string } }) => {
            window.messages.push({ role: 'user', content: injectedText, ...meta });
        },
    };
    notifier.setNoticeDeliverer(notice => notice.kind === 'plan-result' ? deliverSubTaskPlan(view as never, notice) : false);
    const notice = () => {
        const value = notifier.pendingNotices()[0];
        if (value?.kind !== 'plan-result') throw new Error('missing plan notice');
        return value;
    };
    return { registry, notifier, plan, tab, window, view, notice, dispose: () => { notifier.dispose(); registry.dispose(); } };
}

test('Stop parks one whole result; the next human turn consumes it once, preserving one delegate response through sanitizer', async t => {
    const f = await fixture(); t.teardown(f.dispose);
    f.registry.requestStopPlan(f.plan.planId, 'user'); await f.plan.completion;
    f.notifier.drain();
    const notice = f.notice();
    t.deepEqual([f.window.messages.length, notice.userStopped, notice.result.nodes.map(node => [node.id, node.state.kind])],
        [0, true, [['A', 'stopped'], ['B', 'stopped'], ['C', 'stopped']]]);
    const consume = (epoch: string) => consumeSubTaskPlans(f.notifier, { ...owner, sessionEpoch: epoch }, f.registry.issueTurnStartSequence(),
        id => f.window.messages.some(message => message.subTaskPlanId === id), async ({ text, meta }) => {
            f.window.messages.push({ role: 'user', content: text, subTaskPlanId: String(meta.subTaskPlanId) });
        }, 60000);
    await consume('b'.repeat(32)); await consume('a'.repeat(32)); await consume('a'.repeat(32));
    const transcript = sanitizeToolTranscript([
        { role: 'assistant', content: '', tool_calls: [{ id: 'delegate-call', type: 'function', function: { name: 'delegate', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'delegate-call', content: JSON.stringify({ started: true, plan_id: f.plan.planId }) },
        ...f.window.messages,
    ]);
    t.deepEqual([f.window.messages.length, f.notifier.pendingNotices().length, transcript.droppedOrphanTools,
        transcript.messages.map(message => [message.role, message.tool_call_id ?? null])],
    [1, 0, 0, [['assistant', null], ['tool', 'delegate-call'], ['user', null]]]);
});

test('plan auto delivery uses active-tab, Stop and chain gates and retains all node states under a material cap', async t => {
    const f = await fixture(); t.teardown(f.dispose);
    f.view.is_generating = true;
    for (const node of f.plan.nodes.slice(0, 2)) {
        f.registry.createThread({ threadId: node.id, name: 'worker', owner, origin: owner, config: {},
            plan: { planId: f.plan.planId, nodeId: node.id } });
        f.registry.create({ id: node.id, threadId: node.id, origin: owner });
        f.plan.settle(node.id, { kind: 'done', material: 'long result '.repeat(300) });
    }
    f.plan.settle(f.plan.nodes[2].id, { kind: 'error', error: 'C failed' }); await f.plan.completion;
    const result = limitPlanResult(f.notice().result, 1500);
    t.deepEqual(result.nodes.map(node => [node.id, node.state.kind, node.state.truncated ?? false]),
        [['A', 'done', true], ['B', 'done', true], ['C', 'error', false]]);
    t.is(JSON.stringify(result).length <= 1500, true);
    f.view.is_generating = false; f.tab.isActive = false; f.notifier.drain();
    f.tab.isActive = true; f.view._drainSuppressed = true; f.notifier.drain();
    f.view._drainSuppressed = false; f.view._autoTurnChainCounts.set('Mira', 1000); f.notifier.drain();
    t.deepEqual([f.window.messages.length, f.notifier.pendingNotices().map(notice => notice.kind)], [0, ['plan-result']]);
    f.view._autoTurnChainCounts.clear(); f.notifier.drain();
    // Wait on actual acceptance, not a wall-clock delay.
    await Promise.resolve(); await Promise.resolve();
    t.deepEqual([f.window.messages.length, f.notifier.pendingNotices().length], [1, 0]);
});

for (const change of ['stop', 'epoch']) test(`late ${change} during send preparation leaves the plan result pending`, async t => {
    const f = await fixture(); t.teardown(f.dispose);
    let resume!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    let sent!: Promise<unknown>;
    Object.assign(f.view, { lastMessageTimestamp: 1, handleSaveSession: () => waiting,
        send_message: (opts: unknown) => { sent = send_message.call(f.view as never, opts as never); return sent; } });
    f.window.messages.push({ role: 'user', content: 'previous' });
    for (const node of f.plan.nodes.slice(0, 2)) f.plan.settle(node.id, { kind: 'error', error: 'failed' });
    await f.plan.completion; await Promise.resolve();
    if (change === 'stop') f.view._drainSuppressed = true; else f.tab.sessionEpoch = 'b'.repeat(32);
    resume(); await sent;
    t.deepEqual([f.window.messages.map(message => message.content), f.notifier.pendingNotices().map(notice => notice.kind)],
        [['previous'], ['plan-result']]);
});

test('plan child questions keep the real parent run; completion only enters that inbox', async t => {
    const registry = new SubTaskRegistry({ appendHistory: async () => {} }), notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); });
    registry.create({ id: 'parent', name: 'parent', origin: owner, level: 1 });
    const graph = SubTaskPlan.create([{ id: 'A' }], 5);
    if (graph.kind !== 'valid') throw new Error('invalid fixture');
    const plan = await registry.createPlan(graph.plan, owner, 'parent'), node = plan.nodes[0];
    registry.createThread({ threadId: 'child', name: 'worker', owner, origin: owner, config: {}, parentId: 'parent', level: 2,
        plan: { planId: plan.planId, nodeId: node.id } });
    const task = registry.create({ id: 'child', threadId: 'child', origin: owner, parentId: 'parent', level: 2 });
    const opened = registry.openParentQuestion('child', 'Which source?');
    if (opened.kind !== 'opened') throw new Error('question refused');
    t.deepEqual(registry.takeChildNotices('parent').map(notice => notice.kind === 'question'
        ? [notice.kind, notice.question.text, notice.question.recipient] : [notice.kind]),
    [['question', 'Which source?', { kind: 'sub', runId: 'parent' }]]);
    registry.answerParentQuestion('child', opened.question.id, owner, { kind: 'sub', runId: 'parent' }, 'Use notes');
    t.deepEqual(await opened.resolution, { kind: 'answered', text: 'Use notes' });
    registry.finish(task, { text: 'result A', toolsUsed: [], durationMs: 0, usage: null });
    plan.settle(node.id, { kind: 'done', material: 'result A' }); await plan.completion;
    const notices = registry.takeChildNotices('parent');
    t.deepEqual([notices.map(notice => notice.kind), notifier.pendingNotices().length], [['plan-result'], 0]);
    const notice = notices[0] as PlanResultNotice;
    t.is(buildSubTaskPlanDelivery(notice, 60000).meta.origin, 'machine');
    t.deepEqual(notice.result.nodes.map(entry => [entry.id, entry.state.kind, entry.state.material]), [['A', 'done', 'result A']]);
});
