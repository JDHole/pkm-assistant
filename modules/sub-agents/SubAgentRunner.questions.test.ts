import test from 'ava';
import { SubAgentRunner } from './SubAgentRunner.js';
import { SubTaskRegistry } from './SubTaskRegistry.js';
import { QuestionTestClock } from './test-support/questionTestClock.js';
import { setLocale } from '../../core/i18n/index.js';

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

test('ask_parent jest mechaniką suba pierwszego piętra', t => {
    const f = fixture();
    t.deepEqual({ subTools: f.runner._getTools([], { name: 'Jaskier' }).map(x => x.function.name), rootHasAskParent: f.tools.getTool('ask_parent') !== null },
        { subTools: ['ask_parent'], rootHasAskParent: false });
    f.registry.dispose();
});

test('głębszy sub nie widzi ani nie wykonuje ask_parent', async t => {
    const f = fixture();
    const payloads: Array<{ tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: string }> }> = [];
    const model = { stream(payload: typeof payloads[number], cb: { done(value: unknown): void }) {
        payloads.push(structuredClone(payload));
        cb.done(response(payloads.length === 1 ? { role: 'assistant', content: '', tool_calls: [questionCall] } : { role: 'assistant', content: 'Gotowe' }));
    } };
    await f.runner.runTask('zadanie', { name: 'Jaskier' }, { name: 'Klara', tools: [] } as never, model as never, { origin: owner, delegationDepth: 2 });
    t.deepEqual((payloads[0].tools ?? []).map(tool => tool.function.name), []);
    t.false(payloads[0].messages[0].content.includes('ask_parent'));
    t.is(payloads[1].messages.find(message => message.role === 'tool')?.content, 'Cannot ask the lead: no channel is available.');
    t.deepEqual(f.registry.getQuestionState(f.registry.list()[0].id), { kind: 'none' });
    f.registry.dispose();
});

test('sub pierwszego piętra widzi ask_parent', async t => {
    const f = fixture();
    let names: string[] = [];
    const model = { stream(payload: { tools?: Array<{ function: { name: string } }> }, cb: { done(value: unknown): void }) {
        names = (payload.tools ?? []).map(tool => tool.function.name);
        cb.done(response({ role: 'assistant', content: 'Gotowe' }));
    } };
    await f.runner.runTask('zadanie', { name: 'Jaskier' }, { name: 'Klara', tools: [] } as never, model as never, { origin: owner, delegationDepth: 1 });
    t.deepEqual(names, ['ask_parent']);
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

test.serial('pytanie mieści się w budżetach i komunikat używa języka interfejsu', async t => {
    const secret = 'tajny-klucz-unikalny';
    const question = `Zakres ${secret} ${'pytanie '.repeat(1500)}`;
    for (const locale of ['pl', 'en'] as const) {
        for (const mode of ['timeout', 'stop'] as const) {
            setLocale(locale);
            const clock = new QuestionTestClock();
            const registry = new SubTaskRegistry({ questionClock: clock });
            const read = { name: 'read', description: 'read', inputSchema: {}, execute: async () => 'dorobek '.repeat(3000) };
            const runner = new SubAgentRunner({ app: {}, plugin: { subTaskRegistry: registry, env: { settings: { pkmAssistant: {
                limits: { subagent_salvage_max_chars: 240 }, chat: { apiKeys: { test: secret } },
            } } } }, toolRegistry: { filterByAgent: () => [read], getTool: () => read } });
            let ready!: () => void;
            const waiting = new Promise<void>(resolve => { ready = resolve; });
            let calls = 0;
            const model = { stream(_payload: unknown, cb: { done(value: unknown): void }) {
                const call = calls++ === 0
                    ? { id: 'r', type: 'function', function: { name: 'read', arguments: '{}' } }
                    : { id: 'q', type: 'function', function: { name: 'ask_parent', arguments: JSON.stringify({ text: question }) } };
                cb.done(response({ role: 'assistant', content: '', tool_calls: [call] }));
            } };
            const run = runner.runTask('zadanie', { name: 'Jaskier' }, { name: 'Klara', tools: ['read'] } as never, model as never,
                { origin: owner, onTaskCreated: task => registry.attachAbort(task.id, () => {}), onActivity: activity => { if (activity.kind === 'waiting') ready(); } });
            await Promise.race([waiting, run.then(value => { throw new Error(`Bieg zakończył się przed pytaniem: ${value.result}`); })]);
            if (mode === 'stop') registry.requestStop(registry.list()[0].id, 'lead');
            else clock.advance(300000);
            const result = await run;
            const partial = result.partial!;
            const snapshotQuestion = (partial as typeof partial & { question: { text: string } }).question.text;
            const displayed = partial.text.length + partial.lastText.length + snapshotQuestion.length
                + partial.toolOutcomes.reduce((sum, item) => sum + item.resultPreview.length, 0)
                + partial.toolCallDetails.reduce((sum, item) => sum + item.resultPreview.length, 0);
            const sentence = locale === 'pl'
                ? (mode === 'timeout' ? 'Sub nie dostał odpowiedzi na pytanie: Zakres [REDACTED]' : 'Bieg zatrzymany, otwarte pytanie: Zakres [REDACTED]')
                : (mode === 'timeout' ? 'The sub-agent received no answer to the question: Zakres [REDACTED]' : 'Run stopped, open question: Zakres [REDACTED]');
            t.true(displayed <= 12000);
            t.true((result.handoff?.length ?? 0) <= 240);
            t.true(partial.text.includes(sentence));
            t.true(result.handoff?.includes(sentence));
            t.true(result.question?.text.startsWith('Zakres [REDACTED]'));
            t.false(JSON.stringify({ partial, handoff: result.handoff, question: result.question }).includes(secret));
            t.false(/no-answer|cancelled/.test(partial.text + result.handoff));
            registry.dispose();
        }
    }
    setLocale('en');
});
