import test from 'ava';
import { SubTaskPlan, SubTaskRegistry, SubTaskNotifier, limitPlanResult } from '../../sub-agents/index.js';
import { buildSubTaskPlanDelivery, deliverSubTaskPlan, consumeSubTaskPlans } from './subTaskPlanDelivery.js';
import { send_message, stop_generation, _releaseStreamCtx, _queueOwner, _deliverSubTaskResult, _finalizeTurn } from './chat_streaming.js';
import { RollingWindow } from './RollingWindow.js';
import type { PlanResultNotice } from '../../sub-agents/index.js';

const owner = { agentName: 'Mira', sessionPath: 'chat.md', sessionEpoch: 'a'.repeat(32) };
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
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

test('Stop parks one whole result; the next human turn consumes it once', async t => {
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
    t.deepEqual([f.window.messages.length, f.notifier.pendingNotices().length], [1, 0]);
});

test.serial('plan and ordinary result auto turns send readable material and persist the lead response through the same loop', async t => {
    const payloads: Array<Record<string, unknown>> = [];
    const delivered: string[] = [];
    for (const kind of ['plan', 'ordinary']) {
        const f = await fixture();
        const window = new RollingWindow(), finished = deferred<void>();
        const events: Array<{ type: string; content?: string }> = [];
        const memory = { activeSessionPath: owner.sessionPath, sessionEpoch: owner.sessionEpoch,
            async appendSessionEvent(_path: string, event: { type: string; content?: string }) { events.push(event); } };
        const model = { modelKey: 'lead', stream(payload: Record<string, unknown>, handlers: { done(response: unknown): void }) {
            payloads.push(payload);
            handlers.done({ choices: [{ message: { role: 'assistant', content: 'Lead continuation' } }] });
        } };
        const view = Object.assign(f.view, {
            leaf: { id: 'notification-parity' }, rollingWindow: window, input_area: { value: '' }, inputHistory: [],
            tokenTracker: { record() {} }, _preparingTurns: new Map(), _streamCtxMap: new Map(), _agentStates: new Map(),
            env: { settings: { pkmAssistant: { enableOczko: false, limits: { chat_stream_stall_timeout_ms: 0 } } } },
            set_generating(value: boolean) { f.view.is_generating = value; }, resetInputArea() {},
            showTypingIndicator() {}, hideTypingIndicator() {}, _hideQueuedIndicator() {}, _clearQueuedDrainTimer() {},
            async _resolveMentions(text: string) { return { displayText: text, contextText: '' }; },
            append_message: (role: 'user', text: string, _display: unknown, meta: Record<string, unknown>) => window.addMessage(role, text, meta),
            appendToActiveSession: async (event: { type: string; content?: string }) => { events.push(event); },
            get_chat_model: () => model, _chatResolveTools: () => [], _chatOnIterationStart() {}, _chatOnUsage() {},
            _isTurnActiveTab: () => false, _releaseStreamCtx, _finalizeTurn,
            handle_error(error: unknown) { throw error; },
            async send_message(opts: unknown) {
                try { await send_message.call(this as never, opts as never); } finally { finished.resolve(); }
            },
        });
        Object.assign(view.plugin, { showCrystalNotice() {} });
        Object.assign(view.plugin.agentManager, { getAgentMemory: () => memory, getActiveSystemPromptWithMemory: async () => 'Lead system' });
        t.teardown(f.dispose);
        f.notifier.setNoticeDeliverer(notice => notice.kind === 'plan-result' ? deliverSubTaskPlan(view as never, notice)
            : notice.kind === 'result' ? _deliverSubTaskResult.call(view as never, notice.task) : false);
        if (kind === 'plan') {
            f.plan.settle(f.plan.nodes[0].id, { kind: 'error', error: 'A failed', material: 'First A. Extra details.' });
            f.plan.settle(f.plan.nodes[1].id, { kind: 'error', error: 'B failed', material: 'First B. Extra details.' });
        } else {
            const task = f.registry.create({ id: 'ordinary', name: 'worker', background: true, origin: owner });
            f.registry.finish(task, { text: 'First A. Extra details.', toolsUsed: [], durationMs: 2000, usage: null });
        }
        await finished.promise;
        const content = String(window.messages[0].content);
        delivered.push(content.replaceAll(f.plan.planId, 'PLAN'));
        t.deepEqual(window.messages.map(message => [message.role, message.role === 'assistant' ? message.content : message.origin]),
            [['user', 'machine'], ['assistant', 'Lead continuation']]);
        t.deepEqual(events.map(event => [event.type, event.type === 'agent_message' ? event.content : null]),
            [['user_message', null], ['agent_message', 'Lead continuation']]);
        t.is(f.notifier.pendingNotices().length, 0);
    }
    t.is(delivered[0], '[SYSTEM NOTIFICATION] Plan result PLAN\n<vault_content source="plan_result:partial">\npartial result\n'
        + 'A: failed (A failed) | result A (summary): First A. | blocked_by: -\n'
        + 'B: failed (B failed) | result B (summary): First B. | blocked_by: -\n'
        + 'C: blocked | result C (summary): - | blocked_by: A\n</vault_content>\n'
        + 'Pick the thread back up - use this result to finish the job. If you started more tasks, their results will arrive separately; do not guess their content.');
    const requests = payloads.map(payload => ({ ...payload, messages: (payload.messages as Array<{ role: string; content: string }>).map(message => ({
        ...message, content: message.role === 'user' ? 'NOTIFICATION' : message.content,
    })) }));
    t.deepEqual(requests[0], requests[1]);
    t.is(delivered[1].endsWith('Pick the thread back up - use this result to finish the job. If you started more tasks, their results will arrive separately; do not guess their content.'), true);
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

for (const stopDuringSave of [false, true]) test.serial(`O1 human send during accepted plan persistence is serialized; Stop during save=${stopDuringSave}`, async t => {
    const f = await fixture();
    const saving = deferred<void>(), release = deferred<void>(), started = deferred<void>();
    const window = new RollingWindow();
    const requests: unknown[] = [];
    let active = 0, maximum = 0;
    const model = { modelKey: 'lead', stream(payload: { messages: Array<{ content: unknown }> }, handlers: { done(response: unknown): void }) {
        requests.push(payload); active++; maximum = Math.max(maximum, active); started.resolve();
        if (payload.messages.some(message => message.content === 'Human follow-up')) {
            active--; handlers.done({ choices: [{ message: { role: 'assistant', content: 'Human reply' } }] });
        }
    }, stopStream() { active--; } };
    const memory = { activeSessionPath: owner.sessionPath, sessionEpoch: owner.sessionEpoch,
        async appendSessionEvent() { saving.resolve(); await release.promise; } };
    let sent!: Promise<unknown>;
    const view = Object.assign(f.view, {
        leaf: { id: 'plan-race' }, rollingWindow: window, input_area: { value: '' }, inputHistory: [],
        tokenTracker: { record() {} }, _preparingTurns: new Map(), _streamCtxMap: new Map(), _agentStates: new Map(),
        _queuedMessage: null as null | { text: string }, _queueOwner, _releaseStreamCtx,
        env: { settings: { pkmAssistant: { enableOczko: false, limits: { chat_stream_stall_timeout_ms: 0 } } } },
        set_generating(value: boolean) { f.view.is_generating = value; },
        resetInputArea() { this.input_area.value = ''; }, handleInputResize() {},
        _showQueuedIndicator() {}, _hideQueuedIndicator() {}, _clearQueuedDrainTimer() {},
        showTypingIndicator() {}, hideTypingIndicator() {}, _resetPaintTargets() {},
        async _resolveMentions(text: string) { return { displayText: text, contextText: '' }; },
        append_message: (role: 'user', text: string, _display: unknown, meta: Record<string, unknown>) => window.addMessage(role, text, meta),
        appendToActiveSession: async () => {}, get_chat_model: () => model, _chatResolveTools: () => [],
        _chatOnIterationStart() {}, _isTurnActiveTab: () => false, _chatOnUsage() {}, _cleanupAskUser() {},
        _finalizeTurn() {}, handle_error(error: unknown) { throw error; }, stop_generation,
        send_message(opts: unknown) { sent = send_message.call(this as never, opts as never); return sent; },
    });
    Object.assign(view.plugin.agentManager, { getAgentMemory: () => memory, getActiveSystemPromptWithMemory: async () => 'Lead system' });
    t.teardown(async () => { release.resolve(); stop_generation.call(view as never); await sent; f.dispose(); });
    f.plan.settle(f.plan.nodes[0].id, { kind: 'error', error: 'A failed' });
    f.plan.settle(f.plan.nodes[1].id, { kind: 'error', error: 'B failed' });
    await saving.promise;
    view.input_area.value = 'Human follow-up';
    await send_message.call(view as never, { meta: { origin: 'human' } });
    t.deepEqual([view._queuedMessage?.text, requests.length, window.messages.map(message => message.role)],
        ['Human follow-up', 0, ['user']]);
    if (stopDuringSave) stop_generation.call(view as never);
    release.resolve();
    if (!stopDuringSave) { await started.promise; stop_generation.call(view as never); }
    await sent;
    t.deepEqual([maximum, active, view._streamCtxMap.size, view._preparingTurns.size, view.input_area.value],
        [stopDuringSave ? 0 : 1, 0, 0, 0, 'Human follow-up']);
});

for (const stopWhileResolving of [false, true]) test.serial(`O1 human mention resolution reserves the turn before a plan notification can start; Stop during mentions=${stopWhileResolving}`, async t => {
    const f = await fixture(), window = new RollingWindow();
    const resolving = deferred<void>(), release = deferred<void>();
    const planAttempt = deferred<void>(), planStarted = deferred<void>(), humanStarted = deferred<void>();
    const sent: Promise<unknown>[] = [], cleanup: Array<() => void> = [];
    let active = 0, maximum = 0;
    const started: string[] = [], stopped: string[] = [];
    let planSent!: Promise<unknown>;
    const view = Object.assign(f.view, {
        leaf: { id: 'human-first-plan-race' }, rollingWindow: window, input_area: { value: 'Human first' }, inputHistory: [],
        tokenTracker: { record() {} }, _preparingTurns: new Map(), _streamCtxMap: new Map(), _agentStates: new Map(),
        _queueOwner, _releaseStreamCtx, stop_generation,
        env: { settings: { pkmAssistant: { enableOczko: false, limits: { chat_stream_stall_timeout_ms: 0 } } } },
        set_generating(value: boolean) { f.view.is_generating = value; }, resetInputArea() { this.input_area.value = ''; },
        showTypingIndicator() {}, hideTypingIndicator() {}, _resetPaintTargets() {}, _cleanupAskUser() {},
        _showQueuedIndicator() {}, _hideQueuedIndicator() {}, _clearQueuedDrainTimer() {},
        async _resolveMentions(text: string) { resolving.resolve(); await release.promise; return { displayText: text, contextText: '' }; },
        append_message: (role: 'user', text: string, _display: unknown, meta: Record<string, unknown>) => window.addMessage(role, text, meta),
        appendToActiveSession: async () => {}, _chatResolveTools: () => [], _chatOnIterationStart() {}, _chatOnUsage() {},
        _isTurnActiveTab: () => false, _finalizeTurn() {}, handle_error(error: unknown) { throw error; },
        get_chat_model() {
            let stop = () => {};
            return { modelKey: 'lead', stream(payload: { messages: Array<{ content: unknown }> }, handlers: { done(value: unknown): void }) {
                const kind = payload.messages.some(message => message.content === 'Human first') ? 'human' : 'plan';
                started.push(kind); active++; maximum = Math.max(maximum, active);
                let ended = false;
                stop = () => {
                    if (ended) return;
                    ended = true; stopped.push(kind); active--;
                    handlers.done({ choices: [{ message: { role: 'assistant', content: '' } }] });
                };
                cleanup.push(stop);
                (kind === 'human' ? humanStarted : planStarted).resolve();
            }, stopStream() { stop(); } };
        },
        send_message(opts: unknown) {
            planSent = send_message.call(this as never, opts as never); sent.push(planSent); planAttempt.resolve();
            return planSent;
        },
    });
    Object.assign(view.plugin.agentManager, { getActiveSystemPromptWithMemory: async () => 'Lead system',
        getAgentMemory: () => ({ activeSessionPath: owner.sessionPath, sessionEpoch: owner.sessionEpoch, async appendSessionEvent() {} }) });
    t.teardown(async () => { release.resolve(); cleanup.forEach(stop => stop()); await Promise.all(sent); f.dispose(); });
    const humanSent = send_message.call(view as never, { meta: { origin: 'human' } }); sent.push(humanSent);
    await resolving.promise;
    f.plan.settle(f.plan.nodes[0].id, { kind: 'error', error: 'A failed' });
    f.plan.settle(f.plan.nodes[1].id, { kind: 'error', error: 'B failed' });
    await planAttempt.promise;
    await Promise.race([planSent, planStarted.promise]);
    if (stopWhileResolving) stop_generation.call(view as never);
    release.resolve();
    if (stopWhileResolving) await humanSent;
    else { await humanStarted.promise; stop_generation.call(view as never); }
    t.deepEqual([maximum, active, started, stopped, view._streamCtxMap.size, view._preparingTurns.size],
        stopWhileResolving ? [0, 0, [], [], 0, 0] : [1, 0, ['human'], ['human'], 0, 0]);
    t.deepEqual(f.notifier.pendingNotices().map(notice => notice.kind), ['plan-result']);
});
