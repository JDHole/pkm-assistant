import test from 'ava';
import { SubAgentRunner } from './SubAgentRunner.js';
import { SubTaskRegistry } from './SubTaskRegistry.js';
import { QuestionTestClock } from './test-support/questionTestClock.js';

const owner = { agentName: 'Jaskier', sessionPath: 's.md', sessionEpoch: 'e1' };
const questionCall = { id: 'q', type: 'function', function: { name: 'ask_parent', arguments: '{"text":"Jaki zakres?"}' } };
const response = (message: unknown) => ({ choices: [{ message }] });

function fixture(withRead = false) {
    const clock = new QuestionTestClock();
    const registry = new SubTaskRegistry({ questionClock: clock });
    let executions = 0;
    const read = { name: 'read', description: 'read', inputSchema: {}, execute: async () => { executions++; return 'DOROBEK'; } };
    const askUser = { name: 'ask_user', description: 'ask', inputSchema: {}, execute: async () => { executions++; return 'bad'; } };
    const available = withRead ? [read, askUser] : [askUser];
    const tools = { filterByAgent: () => available, getTool: (name: string) => available.find(tool => tool.name === name) ?? null };
    const runner = new SubAgentRunner({ app: {}, plugin: { subTaskRegistry: registry }, toolRegistry: tools });
    return { clock, registry, runner, tools, executions: () => executions };
}

test('ask_parent jest mechaniką każdego suba', t => {
    const f = fixture();
    t.deepEqual({ subTools: f.runner._getTools([], { name: 'Jaskier' }).map(x => x.function.name), rootHasAskParent: f.tools.getTool('ask_parent') !== null },
        { subTools: ['ask_parent'], rootHasAskParent: false });
    f.registry.dispose();
});

test('konfiguracja nie przyznaje ask_user', async t => {
    const f = fixture();
    const names = f.runner._resolveToolNames({ tools: ['ask_user'] });
    const subTools = f.runner._getTools(names, { name: 'Jaskier' }).map(x => x.function.name);
    const error = await f.runner._executeTool({ name: 'ask_user', arguments: {} }, 'Jaskier', new Set(['ask_user']));
    t.deepEqual({ subTools, error, executions: f.executions() }, { subTools: ['ask_parent'], error: 'Refused: tool "ask_user" is outside this sub-agent\'s allowed set (parent∩sub whitelist). Use only the tools provided to you.', executions: 0 });
    f.registry.dispose();
});

test('odpowiedź wraca do tego samego transkryptu', async t => {
    const f = fixture();
    const payloads: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    let ready!: () => void;
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    const model = { stream(payload: typeof payloads[number], cb: { done(value: unknown): void }) {
        payloads.push(structuredClone(payload));
        cb.done(response(payloads.length === 1 ? { role: 'assistant', content: '', tool_calls: [questionCall] } : { role: 'assistant', content: 'Gotowe' }));
    } };
    const run = f.runner.runTask('zadanie', { name: 'Jaskier' }, { name: 'Klara', tools: [] } as never, model as never,
        { origin: owner, onActivity: activity => { if (activity.kind === 'waiting') ready(); } });
    await waiting;
    const task = f.registry.list()[0];
    const state = f.registry.getQuestionState(task.id);
    if (state.kind !== 'waiting') throw new Error('missing question');
    f.registry.answerParentQuestion(task.id, state.question.id, owner, 'A/');
    await run;
    const toolResult = payloads[1].messages.find(message => message.role === 'tool')?.content;
    t.deepEqual({ toolResult, modelCalls: payloads.length, sameThread: state.question.subId === task.threadId }, { toolResult: 'A/', modelCalls: 2, sameThread: true });
    f.registry.dispose();
});

for (const mode of ['no-answer', 'stop'] as const) {
    test(mode === 'stop' ? 'Stop w oczekiwaniu kończy bieg z pytaniem' : 'brak odpowiedzi zachowuje dorobek bez syntezy', async t => {
        const f = fixture(true);
        let ready!: () => void;
        const waiting = new Promise<void>(resolve => { ready = resolve; });
        let calls = 0;
        const model = { stream(_payload: unknown, cb: { done(value: unknown): void }) {
            calls++;
            const call = calls === 1 ? { id: 'read', type: 'function', function: { name: 'read', arguments: '{}' } } : questionCall;
            cb.done(response({ role: 'assistant', content: '', tool_calls: [call] }));
        } };
        const run = f.runner.runTask('zadanie', { name: 'Jaskier' }, { name: 'Klara', tools: ['read'] } as never, model as never,
            { origin: owner, onTaskCreated: task => f.registry.attachAbort(task.id, () => {}), onActivity: activity => { if (activity.kind === 'waiting') ready(); } });
        await waiting;
        const task = f.registry.list()[0];
        if (mode === 'stop') f.registry.requestStop(task.id, 'lead');
        else f.clock.advance(300000);
        const result = await run;
        t.is(result.question?.text, 'Jaki zakres?');
        t.is(result.question?.resolution.kind, mode === 'stop' ? 'cancelled' : 'no-answer');
        t.is(calls, 2);
        t.true(result.result.includes('DOROBEK'));
        t.true(result.result.includes('Jaki zakres?'));
        t.true(result.handoff?.includes('Jaki zakres?'));
        t.deepEqual(task.result?.question, result.question);
        t.deepEqual((task.partial as typeof task.partial & { question?: typeof result.question })?.question, result.question);
        t.is(result.partial?.synthesis, 'skipped');
        if (mode === 'stop') t.deepEqual(result.outcome.end, { kind: 'stopped', by: 'lead' });
        f.registry.dispose();
    });
}

test('odmowa otwarcia zwraca błąd bez czekania', async t => {
    const f = fixture();
    const payloads: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const model = { stream(payload: typeof payloads[number], cb: { done(value: unknown): void }) {
        payloads.push(structuredClone(payload));
        cb.done(response(payloads.length === 1 ? { role: 'assistant', content: '', tool_calls: [questionCall] } : { role: 'assistant', content: 'Gotowe' }));
    } };
    await f.runner.runTask('zadanie', { name: 'Jaskier' }, { name: 'Klara', tools: [] } as never, model as never);
    t.is(payloads[1].messages.find(message => message.role === 'tool')?.content, 'Cannot ask the lead: no channel is available.');
    t.is(f.clock.pending, 0);
    f.registry.dispose();
});

test('późne narzędzie równoległe nie wznawia modelu po wygaśnięciu', async t => {
    const clock = new QuestionTestClock();
    const registry = new SubTaskRegistry({ questionClock: clock });
    let release!: (value: string) => void;
    const held = new Promise<string>(resolve => { release = resolve; });
    const read = { name: 'read', description: 'read', inputSchema: {}, execute: () => held };
    const runner = new SubAgentRunner({ app: {}, plugin: { subTaskRegistry: registry }, toolRegistry: { filterByAgent: () => [read], getTool: () => read } });
    let ready!: () => void;
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    let calls = 0;
    const model = { stream(_payload: unknown, cb: { done(value: unknown): void }) {
        calls++;
        cb.done(response({ role: 'assistant', content: '', tool_calls: [questionCall, { id: 'r', type: 'function', function: { name: 'read', arguments: '{}' } }] }));
    } };
    const run = runner.runTask('zadanie', { name: 'Jaskier' }, { name: 'Klara', tools: ['read'] } as never, model as never,
        { origin: owner, onActivity: value => { if (value.kind === 'waiting') ready(); } });
    await waiting;
    clock.advance(300000);
    const result = await run;
    const snapshot = JSON.stringify(result.partial);
    release('PÓŹNY WYNIK');
    await Promise.resolve();
    t.is(calls, 1);
    t.is(JSON.stringify(result.partial), snapshot);
    t.false(snapshot.includes('PÓŹNY WYNIK'));
    registry.dispose();
});
