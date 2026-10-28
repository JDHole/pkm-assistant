import test from 'ava';
import { SubTaskRegistry, SubTaskNotifier } from '../../sub-agents/index.js';
import { QuestionTestClock } from '../../sub-agents/test-support/questionTestClock.js';
import { createAskUserChannels, createAskUserTool, stopAllDelegations } from '../../tools/index.js';
import { _cleanupAskUser } from './chat_model.js';
import { _chatExecuteToolCall, _chatOnToolCallsParsed } from './chat_streaming.js';

const owner = { agentName: 'Jaskier', sessionPath: 's.md', sessionEpoch: 'e1' };

test('tylko przyjęta odpowiedź dostaje dane kafelka do historii', async t => {
    const registry = new SubTaskRegistry({ questionClock: new QuestionTestClock() });
    registry.create({ id: 'r1', threadId: 's1', name: 'Klara', origin: owner });
    const q = registry.openParentQuestion('r1', 'Jaki zakres?');
    if (q.kind !== 'opened') throw new Error('question did not open');
    let accepted = false;
    const view = { plugin: { subTaskRegistry: registry, mcpClient: { executeToolCall: async () => ({ success: accepted }) } } };
    const turn = { origin: owner, agentName: owner.agentName, rawResults: new Map() };
    const call = { id: 'x', name: 'sub_agent', arguments: { action: 'message', sub_id: 's1', question_id: q.question.id, text: 'Cały.' } };
    const rejected = JSON.parse(await _chatExecuteToolCall.call(view as never, turn as never, call) as string);
    accepted = true;
    const result = JSON.parse(await _chatExecuteToolCall.call(view as never, turn as never, call) as string);
    t.deepEqual(rejected, { success: false });
    t.deepEqual(result, { success: true, sub_question_view: { name: 'Klara', question: 'Jaki zakres?', answer: 'Cały.' } });
    registry.dispose();
});
function fixture() {
    const clock = new QuestionTestClock();
    const registry = new SubTaskRegistry({ questionClock: clock });
    const channels = createAskUserChannels(registry);
    registry.create({ id: 'r1', threadId: 's1', name: 'Klara', origin: owner, background: true });
    const question = registry.openParentQuestion('r1', 'Jaki zakres?');
    if (question.kind !== 'opened') throw new Error('question did not open');
    const container = { appendChild() {} };
    const plugin = { _askUserChannels: channels, mcpClient: { executeToolCall: (_call: unknown, _name: unknown, options: { askUserChannelId?: string }) =>
        createAskUserTool().execute({ question: 'Co?', _invocationAskUserChannelId: options.askUserChannelId }, {}, plugin) } };
    let captured: import('../../tools/index.js').AskUserChannel | undefined;
    const view = { plugin, _askUserTurnChannels: new Map(), _isTurnActiveTab: () => true,
        current_message_container: container, current_message_bubble: container, hideTypingIndicator() {},
        _renderAskUserBlock: (_call: unknown, _container: unknown, channel: typeof captured) => { captured = channel; return { scrollIntoView() {} }; },
        _scheduleConnectorRedraw() {}, _cleanupAskUser };
    const turn = { origin: owner, agentName: owner.agentName, turnId: 7, pendingEntries: [], rawResults: new Map() };
    const call = { id: 'call-1', name: 'ask_user', arguments: { question: 'Co?' } };
    return { clock, registry, channels, question, view, turn, call,
        render: () => _chatOnToolCallsParsed.call(view as never, turn as never, [call]), channel: () => captured! };
}

test('czat przekazuje kanał właściciela i odpowiedź wznawia zegar', async t => {
    const f = fixture(); f.clock.advance(100000); f.render();
    const channel = f.channel(); const state = f.registry.getQuestionState('r1');
    const result = _chatExecuteToolCall.call(f.view as never, f.turn as never, { ...f.call });
    f.clock.advance(600000); channel.answer('A/');
    const answer = JSON.parse(await result as string); const resumed = f.registry.getQuestionState('r1');
    t.deepEqual({ owner: channel.state.owner, paused: state.kind === 'waiting' ? state.clock.kind : state.kind,
        answer: answer.answer, remaining: resumed.kind === 'waiting' ? resumed.clock.remainingMs : null },
    { owner, paused: 'paused', answer: 'A/', remaining: 200000 });
    f.registry.dispose();
});

test('kanał nieprzekazany narzędziu jest zwalniany', t => {
    const f = fixture(); f.render(); const channel = f.channel();
    _cleanupAskUser.call(f.view as never, 7); const state = f.registry.getQuestionState('r1');
    t.deepEqual({ channel: channel.state.kind, retained: !!f.channels.get(channel.id), clock: state.kind === 'waiting' ? state.clock.kind : state.kind },
        { channel: 'closed', retained: false, clock: 'ticking' });
    f.registry.dispose();
});

test('odmowa wykonania narzędzia zwalnia kanał', async t => {
    const f = fixture(); f.render(); const channel = f.channel();
    f.view.plugin.mcpClient.executeToolCall = async () => ({ success: false, error: 'denied' }) as never;
    await _chatExecuteToolCall.call(f.view as never, f.turn as never, { ...f.call });
    const state = f.registry.getQuestionState('r1');
    t.deepEqual({ channel: channel.state.kind, retained: !!f.channels.get(channel.id), clock: state.kind === 'waiting' ? state.clock.kind : state.kind },
        { channel: 'closed', retained: false, clock: 'ticking' });
    f.registry.dispose();
});

test('zamknięcie widoku anuluje tylko jego kanały', t => {
    const f = fixture(); f.render(); const other = f.channels.open(owner);
    const otherView = { plugin: f.view.plugin, _askUserTurnChannels: new Map([[8, new Set([other])]]) };
    _cleanupAskUser.call(f.view as never);
    t.deepEqual({ first: f.channel().state.kind, other: other.state.kind }, { first: 'closed', other: 'open' });
    _cleanupAskUser.call(otherView as never); f.registry.dispose();
});

test('zamknięcie pluginu sprząta oba oczekiwania', async t => {
    const f = fixture(); const notifier = new SubTaskNotifier({ registry: f.registry }); let autoTurns = 0;
    notifier.setNoticeDeliverer(() => { autoTurns++; return false; });
    f.render(); const channel = f.channel();
    f.registry.stopAll('unload'); f.registry.closeAll(); stopAllDelegations('unload'); f.registry.dispose(); notifier.dispose();
    const resolution = await f.question.resolution; await channel.promise;
    t.deepEqual({ question: resolution.kind, askUser: channel.state.kind === 'closed' ? channel.state.reason : 'open',
        pendingTimers: f.clock.pending, autoTurnsAfterUnload: autoTurns },
    { question: 'cancelled', askUser: 'cancelled', pendingTimers: 0, autoTurnsAfterUnload: 0 });
});
