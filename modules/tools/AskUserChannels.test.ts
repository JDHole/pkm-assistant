import test from 'ava';
import { SubTaskRegistry } from '../sub-agents/index.js';
import { QuestionTestClock } from '../sub-agents/test-support/questionTestClock.js';
import { createAskUserChannels } from './AskUserChannels.js';
import { createAskUserTool } from './AskUserTool.js';

const owner = { agentName: 'Jaskier', sessionPath: 's.md', sessionEpoch: 'e1' };
function fixture() {
    const clock = new QuestionTestClock();
    const registry = new SubTaskRegistry({ questionClock: clock });
    registry.create({ id: 'r1', threadId: 's1', name: 'Klara', origin: owner, background: true });
    const question = registry.openParentQuestion('r1', 'Jaki zakres?');
    if (question.kind !== 'opened') throw new Error('question did not open');
    return { clock, registry, question, channels: createAskUserChannels(registry) };
}

test('ask_user innej sesji nie zatrzymuje suba', async t => {
    const { clock, registry, question, channels } = fixture();
    const channel = channels.open({ ...owner, sessionEpoch: 'e2' });
    clock.advance(300000);
    t.deepEqual({ aQuestion: (await question.resolution).kind, bChannel: channel.state.kind }, { aQuestion: 'no-answer', bChannel: 'open' });
    registry.dispose();
});

test('stary kanał nie zamyka nowego', t => {
    const { registry, channels } = fixture();
    const u1 = channels.open(owner);
    const u2 = channels.open(owner);
    u1.cancel();
    u1.cancel();
    const state = registry.getQuestionState('r1');
    t.deepEqual({ u1: u1.state.kind, u2: u2.state.kind, questionClock: state.kind === 'waiting' ? state.clock.kind : state.kind }, { u1: 'closed', u2: 'open', questionClock: 'paused' });
    registry.dispose();
});

test('odpowiedź użytkownika wznawia pozostały czas', async t => {
    const { clock, registry, channels } = fixture();
    clock.advance(100000);
    const channel = channels.open(owner);
    const result = createAskUserTool().execute({ question: 'Co?', _invocationAskUserChannelId: channel.id }, {}, { _askUserChannels: channels });
    clock.advance(600000);
    channel.answer('A/');
    const answer = await result;
    const state = registry.getQuestionState('r1');
    t.deepEqual({ askUserAnswer: 'answer' in answer ? answer.answer : undefined, questionRemainingMs: state.kind === 'waiting' ? state.clock.remainingMs : null }, { askUserAnswer: 'A/', questionRemainingMs: 200000 });
    registry.dispose();
});

test('brak UI nie tworzy pauzy', async t => {
    const { registry, channels } = fixture();
    const result = await createAskUserTool().execute({ question: 'Co?', _invocationAskUserChannelId: 'missing' }, {}, { _askUserChannels: channels });
    const state = registry.getQuestionState('r1');
    t.deepEqual({ error: 'error' in result ? result.error : null, questionClock: state.kind === 'waiting' ? state.clock.kind : state.kind }, { error: 'ask_user.no_ui', questionClock: 'ticking' });
    registry.dispose();
});

test('odpowiedź przed wykonaniem narzędzia jest zachowana', async t => {
    const { registry, channels } = fixture();
    const channel = channels.open(owner);
    channel.answer('A/');
    const result = await createAskUserTool().execute({ question: 'Co?', _invocationAskUserChannelId: channel.id }, {}, { _askUserChannels: channels });
    t.is('answer' in result ? result.answer : undefined, 'A/');
    t.is(channels.get(channel.id), undefined);
    registry.dispose();
});
