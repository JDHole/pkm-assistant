import test from 'ava';
import { ChatTurnPartialState } from './turnPartial.js';
import { RollingWindow } from './RollingWindow.js';
import { classifyMachineMessage, buildMachineView } from './machineMessage.js';
import { t as tr } from '../../../core/i18n/index.js';
import { ArrayMessageStore, runAgentLoop } from '../../agent-loop/index.js';
import type { AgentLoopPartialSnapshot } from '../../agent-loop/index.js';
import type { ActiveSessionEventInput } from '../../memory/index.js';

function snapshot(revision = 1): AgentLoopPartialSnapshot {
    return { kind: 'agent-loop-partial', revision, stopReason: { kind: 'iteration-limit' }, synthesis: 'pending',
        toolsUsed: ['create_folder'], toolOutcomes: [{ invocation: 0, name: 'create_folder', outcome: 'returned', effect: 'unverified', resultPreview: 'created Notes/U3' }],
        toolCallDetails: [{ name: 'create_folder', resultPreview: 'created Notes/U3' }], usage: { prompt_tokens: 7, completion_tokens: 3 }, iterations: 1, lastText: '', text: 'created Notes/U3; effects unverified' };
}

test('owner receipt is synchronous, revisions update one system message and queue exactly once', async t => {
    const rw = new RollingWindow();
    const events: Array<{ path: string; event: ActiveSessionEventInput }> = [];
    const owner = { agentName: 'Owner A', ownerTabKey: 'tab-a', sessionPath: 'a.md', turnId: 7, rw,
        memory: { async appendSessionEvent(path: string, event: ActiveSessionEventInput) { events.push({ path, event }); return path; } } };
    const state = new ChatTurnPartialState(owner);
    owner.sessionPath = 'b.md'; owner.agentName = 'Owner B';
    state.publish(snapshot());
    t.is(rw.messages.length, 1);
    t.is(rw.messages[0].role, 'system');
    t.is(events.length, 0);
    state.publish(snapshot());
    state.publish({ ...snapshot(2), synthesis: 'budget-expired' });
    await state.persisted();
    t.is(rw.messages.length, 1);
    t.deepEqual(events.map(e => e.path), ['a.md', 'a.md']);
    t.deepEqual(events.map(e => (e.event.result as { revision: number }).revision), [1, 2]);
    t.true(events.every(e => e.event.agentName === 'Owner A' && e.event.role === 'system'));
    t.is(classifyMachineMessage(rw.messages[0]), 'loop_partial');
    t.is(classifyMachineMessage({ role: 'user', origin: 'human', content: rw.messages[0].content }), null);
    t.is(classifyMachineMessage({ role: 'system', content: rw.messages[0].content }), 'loop_partial');
});

test('storage rejection is observed and retains a visible owner receipt', async t => {
    const rw = new RollingWindow(); let changed = 0;
    const state = new ChatTurnPartialState({ agentName: 'Owner A', ownerTabKey: 'tab-a', sessionPath: 'a.md', turnId: 1, rw,
        memory: { async appendSessionEvent() { throw new Error('test storage denied'); } }, onChange: () => { changed++; } });
    state.publish(snapshot()); await state.persisted();
    t.true(state.storageError);
    t.true(String(rw.messages[0].content).includes('created Notes/U3'));
    t.true(String(rw.messages[0].content).includes(tr('chat.streaming.partial_storage_error')));
    t.is(buildMachineView(rw.messages[0], { t: tr })?.status, 'error');
    t.is(changed, 2);
});

test('Stop without tools leaves the live and restored partial tile without a tool summary', async t => {
    const controller = new AbortController();
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const running = runAgentLoop({
        model: { stream() { started(); } },
        store: new ArrayMessageStore([{ role: 'user', content: 'go' }]),
        executeToolCall: () => 'unused', abortSignal: controller.signal,
    });
    await entered;
    controller.abort();
    const result = await running;
    if (!result.partial) return t.fail('missing partial receipt');
    const rw = new RollingWindow();
    const state = new ChatTurnPartialState({ agentName: 'Owner', ownerTabKey: 'tab-a', sessionPath: 'a.md', turnId: 1, rw,
        memory: { async appendSessionEvent() { return 'a.md'; } } });
    state.publish(result.partial);
    await state.persisted();
    t.is(buildMachineView(rw.messages[0], { t: tr })?.summary, '');
    t.is(buildMachineView({ role: 'system', content: rw.messages[0].content }, { t: tr })?.summary, '');
    t.is(buildMachineView({ role: 'system', content: String(rw.messages[0].content)
        + '\nPoniżej zapisano odpowiedzi narzędzi. Ich skutki nie zostały zweryfikowane.\n### Notes\ntext' }, { t: tr })?.summary, '');
});

test('retained tool result keeps the live and restored partial tile summary', async t => {
    const result = await runAgentLoop({
        model: { stream(_payload, handlers) { handlers.done({ choices: [{ message: { content: '', tool_calls: [{
            id: 'call_1', function: { name: 'read', arguments: '{}' },
        }] } }] }); } },
        store: new ArrayMessageStore([{ role: 'user', content: 'go' }]),
        executeToolCall: () => 'found Notes/one.md', limits: { maxIterations: 1, synthesisTimeoutMs: 0 },
    });
    if (!result.partial) return t.fail('missing partial receipt');
    const rw = new RollingWindow();
    const state = new ChatTurnPartialState({ agentName: 'Owner', ownerTabKey: 'tab-a', sessionPath: 'a.md', turnId: 2, rw,
        memory: { async appendSessionEvent() { return 'a.md'; } } });
    state.publish(result.partial);
    await state.persisted();
    t.is(buildMachineView(rw.messages[0], { t: tr })?.summary, tr('agentLoop.partial_unverified'));
    t.is(buildMachineView({ role: 'system', content: rw.messages[0].content }, { t: tr })?.summary,
        tr('agentLoop.partial_unverified'));
});
