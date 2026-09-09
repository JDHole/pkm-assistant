import test from 'ava';
import { runAgentLoop } from './AgentLoop.js';
import { ArrayMessageStore } from './MessageStore.js';
import type { ModelResponse, ParsedToolCall, ProviderUsage } from './toolCallParser.js';
import type { LoopMessage } from './MessageStore.js';
import type { ToolResultEntry } from './AgentLoop.js';

// ─── Helpery: mock model + budowniczy odpowiedzi ───

/** Payload wysyłany do `model.stream` (pętla składa go dynamicznie). */
type Payload = Record<string, unknown>;
/** Trójka callbacków, którą pętla podaje do `stream` (mocki destrukturyzują podzbiór). */
type StreamHandlers = {
    chunk: (resp: unknown) => void;
    done: (resp: ModelResponse) => void;
    error: (err: unknown) => void;
};

/** Model odgrywający scenariusz: tablica odpowiedzi LUB funkcja (payload, idx) → resp. */
function makeModel(scenario: ModelResponse[] | ((payload: Payload, i: number) => ModelResponse)) {
    let idx = 0;
    return {
        calls: [] as Payload[],
        stream(payload: Payload, { done, error }: StreamHandlers) {
            this.calls.push(payload);
            const i = idx++;
            let resp: ModelResponse;
            try {
                resp = typeof scenario === 'function' ? scenario(payload, i) : scenario[i];
            } catch (e) {
                error(e);
                return;
            }
            if (resp && resp.__stall) return; // nigdy nie woła done() - test timeoutu
            Promise.resolve().then(() => done(resp));
        }
    };
}

function assistantText(text: string, usage?: ProviderUsage): ModelResponse {
    return { choices: [{ message: { role: 'assistant', content: text } }], ...(usage ? { usage } : {}) };
}

function assistantToolCall(
    name: string,
    args: string | Record<string, unknown>,
    id?: string,
    usage?: ProviderUsage,
): ModelResponse {
    return {
        choices: [{ message: { role: 'assistant', content: '', tool_calls: [
            { id, function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }
        ] } }],
        ...(usage ? { usage } : {})
    };
}

const toolDef = (name: string) => ({ type: 'function', function: { name, description: '', parameters: {} } });

/** Widok wpisu `assistant.tool_calls[]` w kształcie OpenAI - store trzyma je jako `unknown[]`. */
type StoredToolCall = { id?: string; function?: { name?: string; arguments?: string } };
/** Skrót do asercji „ten wpis na pewno jest" (indeks/`find` w strict zwraca `| undefined`). */
type Msg = LoopMessage;
/** Jedno zdarzenie zebrane przez atrapę `trace` (pętla zawsze podaje `fields`). */
type TraceEvent = { type: string; fields: Record<string, unknown> };

// ─── Testy ───

test('natural end: model bez tool_calls za 1. razem', async (t) => {
    const model = makeModel([assistantText('done', { prompt_tokens: 5, completion_tokens: 2 })]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'hi' }]);
    let execCount = 0;

    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [],
        executeToolCall: async () => { execCount++; return 'x'; },
        limits: { maxIterations: 5 }
    });

    t.is(res.finalText, 'done');
    t.is(res.stoppedBy, 'natural');
    t.is(res.iterations, 1);
    t.is(execCount, 0);
    t.is(model.calls.length, 1);
    t.is(res.usage.prompt_tokens, 5);
    t.is(res.usage.completion_tokens, 2);
});

test('2 iteracje z tool calls → natural end; wyniki w store w kolejności; executeToolCall dla każdego', async (t) => {
    const model = makeModel([
        assistantToolCall('vault_read', { path: 'a.md' }, 'call_1'),
        assistantToolCall('vault_search', { query: 'x' }, 'call_2'),
        assistantText('final answer')
    ]);
    const store = new ArrayMessageStore([{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }]);
    const executed: (string | undefined)[] = [];
    const resultsSeen: (string | undefined)[][] = [];

    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('vault_read'), toolDef('vault_search')],
        executeToolCall: async (tc: ParsedToolCall) => { executed.push(tc.name); return `result of ${tc.name}`; },
        limits: { maxIterations: 5 },
        hooks: { onToolResults: (results: ToolResultEntry[]) => resultsSeen.push(results.map((r) => r.toolCall.name)) }
    });

    t.is(res.finalText, 'final answer');
    t.is(res.stoppedBy, 'natural');
    t.is(res.iterations, 3);
    t.deepEqual(executed, ['vault_read', 'vault_search']);
    t.deepEqual(res.toolsUsed, ['vault_read', 'vault_search']);
    t.deepEqual(resultsSeen, [['vault_read'], ['vault_search']]);

    const toolMsgs = store.messages.filter((m) => m.role === 'tool');
    t.is(toolMsgs.length, 2);
    t.is(toolMsgs[0].content, 'result of vault_read');
    t.is(toolMsgs[0].tool_call_id, 'call_1');
    t.is(toolMsgs[1].content, 'result of vault_search');
    t.is(toolMsgs[1].tool_call_id, 'call_2');

    const asstToolMsgs = store.messages.filter((m) => m.role === 'assistant' && m.tool_calls);
    t.is(asstToolMsgs.length, 2);
    // `tool_calls` w store jest `unknown[]` (dostawcy różnią się kształtem) - w tym teście wiemy,
    // że pętla zapisała kanoniczny kształt OpenAI, więc patrzymy przez `StoredToolCall`.
    const firstCall = (asstToolMsgs[0] as Msg).tool_calls?.[0] as StoredToolCall;
    t.is(firstCall.function?.name, 'vault_read');
    t.is(firstCall.id, 'call_1');
});

test('maxIterations wyczerpane → backstop: ostatnie wywołanie BEZ tools, stoppedBy backstop, tagi wyczyszczone', async (t) => {
    let callCount = 0;
    const model = {
        calls: [] as Payload[],
        stream(payload: Payload, { done }: StreamHandlers) {
            this.calls.push(payload);
            callCount++;
            if (payload.tools) {
                Promise.resolve().then(() => done(assistantToolCall('loop_tool', {}, `call_${callCount}`)));
            } else {
                // backstop: model halucynuje tag <function_calls> - musi zostać wyczyszczony
                Promise.resolve().then(() => done(assistantText('FINAL <function_calls>garbage</function_calls> clean')));
            }
        }
    };
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);
    let backstopHit = false;

    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('loop_tool')],
        executeToolCall: async () => 'r',
        limits: { maxIterations: 2 },
        hooks: { onBackstop: () => { backstopHit = true; } }
    });

    t.is(res.stoppedBy, 'backstop');
    t.true(backstopHit);
    t.is(res.iterations, 2);
    t.falsy((model.calls[model.calls.length - 1] as Payload).tools); // finalny call bez narzędzi
    t.false(res.finalText.includes('function_calls'));
    t.false(res.finalText.includes('garbage'));
    t.true(res.finalText.includes('FINAL'));
});

/**
 * Gałąź `invoke` w `_stripHallucinatedToolTags` (test wyżej dotyka wyłącznie `function_calls`).
 * Regex musi dopasowywać otwarcie i zamknięcie w tym samym wariancie przestrzeni nazw - model
 * emituje ALBO oba tagi bez namespace'u, ALBO oba z nim, nigdy mieszankę. Częściowe dopasowanie
 * (np. otwarcie bez namespace'u, zamknięcie na sztywno z nim) zostawia surowy XML w odpowiedzi.
 */
test('backstop: halucynowany <invoke>...</invoke> BEZ przestrzeni nazw jest wyczyszczony', async (t) => {
    let callCount = 0;
    const model = {
        stream(payload: Payload, { done }: StreamHandlers) {
            callCount++;
            if (payload.tools) {
                Promise.resolve().then(() => done(assistantToolCall('loop_tool', {}, `call_${callCount}`)));
            } else {
                Promise.resolve().then(() => done(assistantText('FINAL <invoke name="loop_tool">garbage</invoke> clean')));
            }
        }
    };
    const res = await runAgentLoop({
        model,
        store: new ArrayMessageStore([{ role: 'user', content: 'go' }]),
        resolveTools: () => [toolDef('loop_tool')],
        executeToolCall: async () => 'r',
        limits: { maxIterations: 2 },
    });

    t.is(res.stoppedBy, 'backstop');
    t.false(res.finalText.includes('invoke'), `tag przeżył czyszczenie: ${res.finalText}`);
    t.false(res.finalText.includes('garbage'));
    t.true(res.finalText.includes('FINAL'));
});

test('backstop: halucynowany <invoke> Z PRZESTRZENIĄ NAZW na obu tagach jest wyczyszczony', async (t) => {
    // Namespace budowany przez konkatenację (nie jako literał ciągły w źródle) - to WŁAŚNIE
    // ten kształt taga (otwarcie i zamknięcie oba z prefiksem) regex musi dopasować; nie
    // wystarczy wariant z prefiksem zaszytym na sztywno wyłącznie w zamknięciu.
    const ns = 'ant' + 'ml:';
    const hallucinated = `FINAL <${ns}invoke name="loop_tool">garbage</${ns}invoke> clean`;
    let callCount = 0;
    const model = {
        stream(payload: Payload, { done }: StreamHandlers) {
            callCount++;
            if (payload.tools) {
                Promise.resolve().then(() => done(assistantToolCall('loop_tool', {}, `call_${callCount}`)));
            } else {
                Promise.resolve().then(() => done(assistantText(hallucinated)));
            }
        }
    };
    const res = await runAgentLoop({
        model,
        store: new ArrayMessageStore([{ role: 'user', content: 'go' }]),
        resolveTools: () => [toolDef('loop_tool')],
        executeToolCall: async () => 'r',
        limits: { maxIterations: 2 },
    });

    t.is(res.stoppedBy, 'backstop');
    t.false(res.finalText.includes('invoke'), `tag przeżył czyszczenie: ${res.finalText}`);
    t.false(res.finalText.includes('garbage'));
    t.true(res.finalText.includes('FINAL'));
});

test('minIterations wymusza kontynuację', async (t) => {
    const model = makeModel([assistantText('too early'), assistantText('now done')]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);

    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [],
        executeToolCall: async () => 'x',
        limits: { maxIterations: 5, minIterations: 2 }
    });

    t.is(res.finalText, 'now done');
    t.is(res.iterations, 2);
    t.is(model.calls.length, 2);
    // oryginalny user + nudge kontynuacji
    const userMsgs = store.messages.filter((m) => m.role === 'user');
    t.is(userMsgs.length, 2);
    t.not(userMsgs[1].content, 'go');
    t.true((userMsgs[1].content as string).length > 0);
    // assistant 'too early' dopisany przed nudge
    t.true(store.messages.some((m) => m.role === 'assistant' && m.content === 'too early'));
});

test('orphan guard (hook filtruje do []): koniec tury czysto, brak egzekucji, brak malformed store', async (t) => {
    const model = makeModel([assistantToolCall('vault_read', {}, 'call_1'), assistantText('unreached')]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);
    let execCount = 0;

    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('vault_read')],
        executeToolCall: async () => { execCount++; return 'r'; },
        limits: { maxIterations: 5 },
        hooks: { onToolCallsParsed: () => [] }
    });

    t.is(res.stoppedBy, 'natural');
    t.is(res.iterations, 1);
    t.is(execCount, 0); // odfiltrowane PRZED egzekucją
    t.false(store.messages.some((m) => m.role === 'assistant' && m.tool_calls));
    t.false(store.messages.some((m) => m.role === 'tool'));
});

test('orphan guard PO egzekucji: wywołanie bez id wykonane, ale wynik osierocony → koniec czysto', async (t) => {
    // root tool_calls bez id → parsed.id undefined → egzekucja tak, ale apiToolCalls puste
    const model = makeModel([
        { tool_calls: [{ function: { name: 'vault_read', arguments: '{}' } }] },
        assistantText('unreached')
    ]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);
    let execCount = 0;

    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('vault_read')],
        executeToolCall: async () => { execCount++; return 'r'; },
        limits: { maxIterations: 5 }
    });

    t.is(res.stoppedBy, 'natural');
    t.is(execCount, 1); // egzekutor ODPALONY
    t.false(store.messages.some((m) => m.role === 'assistant' && m.tool_calls));
    t.false(store.messages.some((m) => m.role === 'tool'));
});

test('apiToolCalls (AgentLoop.ts:555): wpis z id ale BEZ obu nazw jest odsiany; wpis z SAMĄ function.name zostaje', async (t) => {
    // Filtr rekonstrukcji `tc.id && (tc.name || tc.function?.name)` ma DWIE strony AND.
    // „orphan guard PO egzekucji" wyżej pokrywa TYLKO stronę „id brak" (name jest, obecny
    // w root tool_calls). Ten test pokrywa stronę przeciwną: id JEST, a name brakuje w OBU
    // miejscach (`tc.name` i `tc.function?.name`) → odrzucone; oraz - żeby dowieść, że OR po
    // prawej stronie realnie coś robi, nie tylko zawsze `false` - wpis z name TYLKO w
    // `tc.function.name` (kształt niespłaszczony, jak z hooka `onToolCallsParsed`, bo
    // `parseToolCalls` ZAWSZE spłaszcza do top-level `name`) → PRZYJĘTY.
    const model = makeModel([
        { tool_calls: [{ id: 'no_name_at_all' }] }, // shape 2: id jest, function/name brak
        assistantText('unreached')
    ]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);
    let execCount = 0;

    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('vault_read')],
        executeToolCall: async () => { execCount++; return 'r'; },
        limits: { maxIterations: 5 },
        hooks: {
            // Dokładamy DRUGIE wywołanie w kształcie niespłaszczonym - jedyna realna droga,
            // którą taki kształt dociera do filtra na linii 555 (parser go nigdy nie produkuje).
            onToolCallsParsed: (calls) => [
                ...calls,
                { id: 'only_function_name', function: { name: 'vault_read', arguments: '{}' } }
            ]
        }
    });

    t.is(res.stoppedBy, 'natural');
    t.is(execCount, 2, 'oba wywołania egzekwowane — filtr działa PO egzekucji, nie przed nią');

    const asstToolMsgs = store.messages.filter((m) => m.role === 'assistant' && m.tool_calls);
    t.is(asstToolMsgs.length, 1, 'tylko JEDNA tura assistant z tool_calls trafiła do store (druga jest orphan)');
    const calls = (asstToolMsgs[0] as Msg).tool_calls as { id?: string }[];
    t.is(calls.length, 1, 'z DWÓCH egzekwowanych wywołań tylko JEDNO ma poprawny apiToolCall');
    t.is(calls[0].id, 'only_function_name', 'wpis z SAMĄ function.name przeżywa filtr');

    const toolMsgs = store.messages.filter((m) => m.role === 'tool');
    t.is(toolMsgs.length, 1, 'tylko wynik wpisu z poprawną nazwą trafia do store; drugi jest sierotą');
    t.is(toolMsgs[0].tool_call_id, 'only_function_name');
});

test('shouldAbort na starcie → stoppedBy abort, model nie jest wołany', async (t) => {
    const model = makeModel([assistantText('never')]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);

    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [],
        executeToolCall: async () => 'x',
        limits: { maxIterations: 5 },
        shouldAbort: () => true
    });

    t.is(res.stoppedBy, 'abort');
    t.is(model.calls.length, 0);
});

test('shouldAbort po powrocie modelu → stop przed egzekucją narzędzi', async (t) => {
    let modelReturned = 0;
    const model = {
        calls: [] as Payload[],
        stream(payload: Payload, { done }: StreamHandlers) {
            this.calls.push(payload);
            Promise.resolve().then(() => { modelReturned++; done(assistantToolCall('t', {}, `c${modelReturned}`)); });
        }
    };
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);
    let execCount = 0;

    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('t')],
        executeToolCall: async () => { execCount++; return 'r'; },
        limits: { maxIterations: 5 },
        shouldAbort: () => modelReturned >= 1
    });

    t.is(res.stoppedBy, 'abort');
    t.is(model.calls.length, 1); // model wołany raz, potem abort
    t.is(execCount, 0); // narzędzia nie wykonane
});

test('perCallTimeoutMs → timeout error obsłużony (propaguje)', async (t) => {
    const model = {
        calls: [] as Payload[],
        stream(payload: Payload) { this.calls.push(payload); /* stall - nigdy done() */ }
    };
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);

    await t.throwsAsync(
        () => runAgentLoop({
            model,
            store,
            resolveTools: () => [],
            executeToolCall: async () => 'x',
            limits: { maxIterations: 3, perCallTimeoutMs: 30 }
        }),
        { message: /timeout/i }
    );
});

// Timeout musi ubijać request (stopStream → xhr.abort), nie tylko porzucać promisę - inaczej
// lokalny most mieli zombie-joby dalej i zapycha kolejkę dla wszystkich następnych wywołań.
test('perCallTimeoutMs → stopStream wołany przy timeout (zombie-request ubity)', async (t) => {
    let stopped = 0;
    const model = {
        calls: [] as Payload[],
        stream(payload: Payload) { this.calls.push(payload); /* stall - nigdy done() */ },
        stopStream() { stopped++; }
    };
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);
    const traced: string[] = [];

    await t.throwsAsync(
        () => runAgentLoop({
            model,
            store,
            resolveTools: () => [],
            executeToolCall: async () => 'x',
            limits: { maxIterations: 3, perCallTimeoutMs: 30 },
            trace: (event: string) => { traced.push(event); }
        }),
        { message: /timeout/i }
    );

    t.is(stopped, 1);
    t.true(traced.includes('model.timeout'));
    t.true(traced.includes('loop.end')); // pętla domyka ślad także przy błędzie
});

// Budzik per-call liczony od wysłania requestu karałby suby za czekanie w kolejce bramki
// platform lokalnych (limit 1) - kolejka rosłaby ponad budżet, taski umierałyby seryjnie.
// Model sygnalizuje gate_admitted przy wejściu na slot, pętla przezbraja budzik: faza
// kolejki i faza streamu dostają PO pełnym budżecie.
test('perCallTimeoutMs → gate_admitted przezbraja budzik: kolejka+stream > budżet, sam stream < budżet — bez timeoutu', async (t) => {
    const model = {
        calls: [] as Payload[],
        stream(payload: Payload, handlers: StreamHandlers & { gate_admitted?: () => void }) {
            this.calls.push(payload);
            // 100ms "w kolejce bramki", admit, 100ms "streamu" - łącznie 200ms > 150ms budżetu,
            // ale żadna faza z osobna budżetu nie przekracza.
            setTimeout(() => {
                handlers.gate_admitted?.();
                setTimeout(() => handlers.done(assistantText('po kolejce')), 100);
            }, 100);
        }
    };
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);

    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [],
        executeToolCall: async () => 'x',
        limits: { maxIterations: 3, perCallTimeoutMs: 150 }
    });

    t.is(res.finalText, 'po kolejce');
    t.is(res.stoppedBy, 'natural');
});

test('perCallTimeoutMs → spóźniony gate_admitted po rozstrzygnięciu NIE uzbraja martwego budzika', async (t) => {
    let stopped = 0;
    let admittedCb: (() => void) | null = null;
    const model = {
        calls: [] as Payload[],
        stream(payload: Payload, handlers: StreamHandlers & { gate_admitted?: () => void }) {
            this.calls.push(payload);
            admittedCb = handlers.gate_admitted || null;
            Promise.resolve().then(() => handlers.done(assistantText('ok')));
        },
        stopStream() { stopped++; }
    };
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);

    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [],
        executeToolCall: async () => 'x',
        limits: { maxIterations: 3, perCallTimeoutMs: 30 }
    });
    t.is(res.finalText, 'ok');

    // Spóźniony sygnał bramki (np. cooldown/wyścig) - martwy budzik nie może odpalić
    // stopStream, bo ubiłby CUDZY, kolejny request na tym samym modelu.
    admittedCb!();
    await new Promise((r) => setTimeout(r, 60));
    t.is(stopped, 0, 'stopStream nie zawołany po rozstrzygniętym wyścigu');
});

test('usage: agregacja z 2 iteracji', async (t) => {
    const model = makeModel([
        assistantToolCall('t', {}, 'c1', { prompt_tokens: 10, completion_tokens: 4 }),
        assistantText('done', { prompt_tokens: 20, completion_tokens: 6 })
    ]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);

    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('t')],
        executeToolCall: async () => 'r',
        limits: { maxIterations: 5 }
    });

    t.is(res.usage.prompt_tokens, 30);
    t.is(res.usage.completion_tokens, 10);
    t.falsy(res.usage._estimated);
});

test('usage: fallback estymacji gdy brak usage', async (t) => {
    const model = makeModel([assistantText('done with no usage')]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'hello world' }]);

    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [],
        executeToolCall: async () => 'x',
        limits: { maxIterations: 3 }
    });

    t.is(res.usage._estimated, true);
    t.true(res.usage.prompt_tokens > 0);
    t.true(res.usage.completion_tokens > 0);
});

test('maxToolResultLength obcina wynik narzędzia', async (t) => {
    const bigResult = 'A'.repeat(500);
    const model = makeModel([assistantToolCall('t', {}, 'c1'), assistantText('done')]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);

    await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('t')],
        executeToolCall: async () => bigResult,
        limits: { maxIterations: 5, maxToolResultLength: 100 }
    });

    const toolMsg = store.messages.find((m) => m.role === 'tool') as Msg;
    // Ten scenariusz zwraca string (obcinanie dotyczy tylko tekstu) - `content` jest szerszy.
    const toolContent = toolMsg.content as string;
    t.true(toolContent.length < 500);
    t.true(toolContent.startsWith('A'.repeat(100)));
    t.true(toolContent.includes('truncated') || toolContent.includes('skrócono'));
});

test('onToolCallsParsed zwraca podzbiór → wykonany tylko podzbiór', async (t) => {
    const model = makeModel([
        { choices: [{ message: { content: '', tool_calls: [
            { id: 'c1', function: { name: 'keep', arguments: '{}' } },
            { id: 'c2', function: { name: 'drop', arguments: '{}' } }
        ] } }] },
        assistantText('done')
    ]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);
    const executed: (string | undefined)[] = [];

    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('keep'), toolDef('drop')],
        executeToolCall: async (tc: ParsedToolCall) => { executed.push(tc.name); return 'r'; },
        limits: { maxIterations: 5 },
        hooks: { onToolCallsParsed: (calls: ParsedToolCall[]) => calls.filter((c) => c.name === 'keep') }
    });

    t.deepEqual(executed, ['keep']);
    t.is(res.finalText, 'done');
    const toolMsgs = store.messages.filter((m) => m.role === 'tool');
    t.is(toolMsgs.length, 1);
    t.is((toolMsgs[0] as Msg).tool_call_id, 'c1');
});

test('resolveTools wołane na start KAŻDEJ iteracji (świeża whitelista)', async (t) => {
    const model = makeModel([assistantToolCall('t', {}, 'c1'), assistantText('done')]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);
    let resolveCount = 0;

    await runAgentLoop({
        model,
        store,
        resolveTools: () => { resolveCount++; return [toolDef('t')]; },
        executeToolCall: async () => 'r',
        limits: { maxIterations: 5 }
    });

    t.is(resolveCount, 2); // 2 iteracje (tool call + natural end)
});

test('sanitizeToolTranscript: osierocony tool message usunięty przed wysyłką do modelu', async (t) => {
    // Port scenariusza ze streamHelper.test.js (streamToCompleteWithTools) - pętla sanityzuje
    // transkrypt przed KAŻDYM wywołaniem modelu, więc osierocony tool message nie leci do API.
    let capturedPayload: Payload | null = null;
    const model = {
        calls: [] as Payload[],
        stream(payload: Payload, { done }: StreamHandlers) {
            capturedPayload = payload;
            Promise.resolve().then(() => done(assistantText('clean')));
        }
    };
    const store = new ArrayMessageStore([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
        { role: 'tool', tool_call_id: 'ghost', content: 'orphan' }
    ]);

    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [],
        executeToolCall: async () => 'unused',
        limits: { maxIterations: 1 }
    });

    t.is(res.finalText, 'clean');
    const sentMessages = (capturedPayload as Payload | null)?.messages as LoopMessage[];
    t.false(sentMessages.some((m) => m.role === 'tool' && m.tool_call_id === 'ghost'));
    t.true(sentMessages.some((m) => m.role === 'user' && m.content === 'hello'));
});

test('beforeContinue async jest AWAITOWANY: mutacja z await widoczna w następnej iteracji', async (t) => {
    // Hook robi await delay i mutuje flagę; jeśli pętla NIE awaituje hooka, druga iteracja
    // odczyta flagę zanim delay się skończy (false). Awaitowanie → flaga=true w iteracji 2.
    const flagSeen: boolean[] = [];
    const model = makeModel([
        assistantToolCall('t', {}, 'c1'),
        assistantText('done')
    ]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);
    let flag = false;

    await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('t')],
        executeToolCall: async () => 'r',
        limits: { maxIterations: 5 },
        hooks: {
            onIterationStart: () => { flagSeen.push(flag); },
            beforeContinue: async () => {
                await new Promise((r) => setTimeout(r, 20));
                flag = true;
            }
        }
    });

    // iteracja 0: flag=false (hook jeszcze nie mutował); iteracja 1: flag=true (await dokończony)
    t.deepEqual(flagSeen, [false, true]);
});

test('wynik narzędzia jako tablica (multimodal) trafia do store BEZ stringifikacji ani obcinania', async (t) => {
    const multimodal = [
        { type: 'text', text: 'meta' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
    ];
    const model = makeModel([assistantToolCall('generate_image', {}, 'c1'), assistantText('done')]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);

    await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('generate_image')],
        executeToolCall: async () => multimodal,
        // niski limit obcinania - tablica ma go zignorować (obcinamy tylko tekst)
        limits: { maxIterations: 5, maxToolResultLength: 5 }
    });

    const toolMsg = store.messages.find((m) => m.role === 'tool') as Msg;
    t.true(Array.isArray(toolMsg.content));
    t.deepEqual(toolMsg.content, multimodal);
    t.is(toolMsg.tool_call_id, 'c1');
});

// ─── Trace ───

test('trace: 1 narzędzie → sekwencja loop.start, model.done, tool.pre, tool.post, model.done, loop.end (natural)', async (t) => {
    const traced: TraceEvent[] = [];
    const trace = (type: string, fields: Record<string, unknown>) => traced.push({ type, fields });
    const model = makeModel([
        assistantToolCall('vault_read', { path: 'a.md' }, 'c1', { prompt_tokens: 10, completion_tokens: 4 }),
        assistantText('done', { prompt_tokens: 20, completion_tokens: 6 })
    ]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);

    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('vault_read')],
        executeToolCall: async () => 'result',
        limits: { maxIterations: 5 },
        trace
    });

    t.is(res.stoppedBy, 'natural');
    t.deepEqual(traced.map((e) => e.type), ['loop.start', 'model.done', 'tool.pre', 'tool.post', 'model.done', 'loop.end']);
    t.is(traced[0].fields.max_iter, 5);
    t.is(traced[1].fields.i, 0);
    t.is(traced[1].fields.in, 10);
    t.is(traced[1].fields.out, 4);
    t.is(traced[2].fields.tool, 'vault_read');
    t.is(traced[3].fields.tool, 'vault_read');
    t.is(traced[3].fields.status, 'ok');
    t.is(traced[3].fields.chars, 'result'.length);
    t.is(typeof traced[3].fields.batch_ms, 'number');
    const end = traced.find((e) => e.type === 'loop.end') as TraceEvent;
    t.is(end.fields.stop, 'natural');
    t.is(end.fields.iters, 2);
});

test('trace: model bez usage → model.done {usage:none}', async (t) => {
    const traced: TraceEvent[] = [];
    const model = makeModel([assistantText('done')]); // brak usage
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);

    await runAgentLoop({
        model,
        store,
        resolveTools: () => [],
        executeToolCall: async () => 'x',
        limits: { maxIterations: 3 },
        trace: (type: string, fields: Record<string, unknown>) => traced.push({ type, fields })
    });

    const md = traced.find((e) => e.type === 'model.done') as TraceEvent;
    t.is(md.fields.usage, 'none');
});

test('trace: hook odfiltrował narzędzie → tool.blocked z nazwą; tool.pre tylko dla pozostałego', async (t) => {
    const traced: TraceEvent[] = [];
    const model = makeModel([
        { choices: [{ message: { content: '', tool_calls: [
            { id: 'c1', function: { name: 'keep', arguments: '{}' } },
            { id: 'c2', function: { name: 'drop', arguments: '{}' } }
        ] } }] },
        assistantText('done')
    ]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);

    await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('keep'), toolDef('drop')],
        executeToolCall: async () => 'r',
        limits: { maxIterations: 5 },
        hooks: { onToolCallsParsed: (calls) => calls.filter((c) => c.name === 'keep') },
        trace: (type: string, fields: Record<string, unknown>) => traced.push({ type, fields })
    });

    const blocked = traced.find((e) => e.type === 'tool.blocked') as TraceEvent;
    t.truthy(blocked);
    t.is(blocked.fields.dropped, 'drop');
    const pres = traced.filter((e) => e.type === 'tool.pre');
    t.is(pres.length, 1);
    t.is(pres[0].fields.tool, 'keep');
});

test('trace: backstop → zdarzenie backstop + loop.end stop=backstop', async (t) => {
    const traced: TraceEvent[] = [];
    let callCount = 0;
    const model = {
        calls: [] as Payload[],
        stream(payload: Payload, { done }: StreamHandlers) {
            this.calls.push(payload);
            callCount++;
            if (payload.tools) Promise.resolve().then(() => done(assistantToolCall('loop_tool', {}, `c${callCount}`)));
            else Promise.resolve().then(() => done(assistantText('final')));
        }
    };
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);

    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('loop_tool')],
        executeToolCall: async () => 'r',
        limits: { maxIterations: 2 },
        trace: (type: string, fields: Record<string, unknown>) => traced.push({ type, fields })
    });

    t.is(res.stoppedBy, 'backstop');
    t.truthy(traced.find((e) => e.type === 'backstop'));
    const end = traced.find((e) => e.type === 'loop.end') as TraceEvent;
    t.is(end.fields.stop, 'backstop');
    t.is(end.fields.after ?? (traced.find((e) => e.type === 'backstop') as TraceEvent).fields.after, 2);
});

test('trace: brak opta trace → pętla działa jak dotąd (bez wyjątku)', async (t) => {
    const model = makeModel([assistantToolCall('t', {}, 'c1'), assistantText('done')]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);

    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('t')],
        executeToolCall: async () => 'r',
        limits: { maxIterations: 5 }
        // trace nie podany
    });

    t.is(res.stoppedBy, 'natural');
    t.is(res.finalText, 'done');
});

test('reasoning_content przekazany do store', async (t) => {
    const model = makeModel([
        { choices: [{ message: { content: '', reasoning_content: 'because', tool_calls: [
            { id: 'c1', function: { name: 't', arguments: '{}' } }
        ] } }] },
        assistantText('done')
    ]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);

    await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('t')],
        executeToolCall: async () => 'r',
        limits: { maxIterations: 5 }
    });

    const asst = store.messages.find((m) => m.role === 'assistant' && m.tool_calls) as Msg;
    t.is(asst.reasoning_content, 'because');
});

// ─── Backstop: trace rozróżnia wynik od zaślepki ───
// Backstop ma DWA różne zejścia: finalny strzał się udał (model oddał podsumowanie)
// albo padł (timeout / błąd modelu) i pętla oddaje 36-znakową zaślepkę
// `agentLoop.backstop_fallback`. Dla czytelnika trace oba wyglądają IDENTYCZNIE
// (`loop.end stop=backstop`), więc bez dodatkowego pola nie da się policzyć z trace,
// ile backstopów oddaje zaślepkę zamiast wyniku. Pole `fallback=1` odróżnia je
// (obecne tylko przy zaślepce).
test('trace odróżnia backstop z wynikiem od backstopu z zaślepką', async (t) => {
    const runUntilBackstop = async (finalCallFails: boolean) => {
        const traced: TraceEvent[] = [];
        const model = {
            stream(payload: Payload, { done, error }: StreamHandlers) {
                if (payload.tools) {
                    Promise.resolve().then(() => done(assistantToolCall('loop_tool', {}, 'c1')));
                    return;
                }
                // payload bez `tools` = finalny strzał backstopu
                if (finalCallFails) Promise.resolve().then(() => error(new Error('Model timeout')));
                else Promise.resolve().then(() => done(assistantText('PODSUMOWANIE')));
            }
        };
        const res = await runAgentLoop({
            model,
            store: new ArrayMessageStore([{ role: 'user', content: 'go' }]),
            resolveTools: () => [toolDef('loop_tool')],
            executeToolCall: async () => 'r',
            limits: { maxIterations: 1 },
            trace: (type: string, fields: Record<string, unknown>) => traced.push({ type, fields })
        });
        const end = traced.find((e) => e.type === 'loop.end') as TraceEvent;
        // total_ms jest z natury różne - porównujemy ślad bez niego.
        const { total_ms: _drop, ...stable } = end.fields;
        return { stable, finalText: res.finalText, stoppedBy: res.stoppedBy };
    };

    const ok = await runUntilBackstop(false);
    const failed = await runUntilBackstop(true);

    // Kontrola założenia: oba biegi naprawdę zeszły backstopem, a treść wyników się różni.
    t.is(ok.stoppedBy, 'backstop');
    t.is(failed.stoppedBy, 'backstop');
    t.true(ok.finalText.includes('PODSUMOWANIE'));
    t.not(failed.finalText, ok.finalText);

    // Sedno pinu: ślad w trace MUSI je rozróżniać.
    t.notDeepEqual(failed.stable, ok.stable,
        'loop.end dla backstopu z zaślepką jest nie do odróżnienia od backstopu z wynikiem');
    // I konkretnie: zaślepka niesie `fallback=1`, udany backstop NIE ma tego pola w ogóle.
    t.deepEqual(failed.stable, { stop: 'backstop', iters: 1, fallback: 1 });
    t.deepEqual(ok.stable, { stop: 'backstop', iters: 1 });
});

// ─── Watchdog ciszy + ratowanie dorobku ───

// Zegar ścienny ubijałby suby piszące finalną syntezę na wolnym moście, gdyby liczył od
// startu wywołania. Watchdog ciszy strzela wyłącznie po PEŁNEJ ciszy modelu - chunk streamu
// przezbraja budzik.
test('watchdog ciszy — pełna cisza ubija wywołanie (stopStream + trace model.stall)', async (t) => {
    let stopped = 0;
    const model = {
        calls: [] as Payload[],
        stream(payload: Payload) { this.calls.push(payload); /* cisza - zero chunków, zero done */ },
        stopStream() { stopped++; }
    };
    const store = new ArrayMessageStore([{ role: 'user', content: 'hi' }]);
    const traced: string[] = [];
    await t.throwsAsync(
        () => runAgentLoop({
            model,
            store,
            resolveTools: () => [],
            executeToolCall: async () => 'x',
            limits: { maxIterations: 3, stallTimeoutMs: 30 },
            trace: (type: string) => { traced.push(type); }
        }),
        { message: /watchdog/i }
    );
    t.is(stopped, 1);
    t.true(traced.includes('model.stall'));
    t.true(traced.includes('loop.end')); // pętla domyka ślad także przy błędzie
});

test('watchdog ciszy — chunki przezbrajają budzik (wolny, ale żywy stream przeżywa)', async (t) => {
    const model = {
        calls: [] as Payload[],
        stream(payload: Payload, { chunk, done }: StreamHandlers) {
            this.calls.push(payload);
            // 6 chunków co 20 ms (~120 ms łącznie) przy watchdogu 50 ms - każdy chunk
            // zeruje licznik ciszy, więc bieg NIE MA PRAWA zostać ubity.
            let n = 0;
            const iv = setInterval(() => {
                n++;
                chunk({ delta: n });
                if (n === 6) {
                    clearInterval(iv);
                    done(assistantText('slow but alive'));
                }
            }, 20);
        }
    };
    const store = new ArrayMessageStore([{ role: 'user', content: 'hi' }]);
    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [],
        executeToolCall: async () => 'x',
        limits: { maxIterations: 3, stallTimeoutMs: 50 }
    });
    t.is(res.finalText, 'slow but alive');
    t.is(res.stoppedBy, 'natural');
});

test('stallTimeoutMs=0 (wyłączony) — cichy model NIE jest ubijany przez watchdog', async (t) => {
    // Kontrola negatywna: bez watchdoga cichy stream wisi - pilnuje go per-call timeout.
    const model = {
        calls: [] as Payload[],
        stream(payload: Payload) { this.calls.push(payload); /* cisza */ }
    };
    const store = new ArrayMessageStore([{ role: 'user', content: 'hi' }]);
    await t.throwsAsync(
        () => runAgentLoop({
            model,
            store,
            resolveTools: () => [],
            executeToolCall: async () => 'x',
            limits: { maxIterations: 3, stallTimeoutMs: 0, perCallTimeoutMs: 40 }
        }),
        { message: /timeout/i } // per-call, nie watchdog
    );
    t.pass();
});

test('salvage — zaślepka backstopu niesie skrót dorobku narzędzi (pusty finalny tekst)', async (t) => {
    const model = makeModel([
        assistantToolCall('search', { query: 'smoke tandemowy' }, 'c1'),
        assistantText('') // backstop: model nie oddał syntezy
    ]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);
    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('search')],
        executeToolCall: async () => 'WYNIK: 26 notatek o smoke testach',
        limits: { maxIterations: 1, salvageMaxChars: 5000 }
    });
    t.is(res.stoppedBy, 'backstop');
    // Zaślepka zostaje (marker dla trace/telemetrii)…
    t.true(res.finalText.length > 40);
    // …ale niesie dorobek: nagłówek wywołania + surowy wynik narzędzia.
    t.true(res.finalText.includes('### search'), res.finalText);
    t.true(res.finalText.includes('WYNIK: 26 notatek o smoke testach'));
});

test('salvage — backstop PADŁ (błąd modelu) → catch też oddaje skrót dorobku', async (t) => {
    const model = makeModel((_payload: Payload, i: number) => {
        if (i === 0) return assistantToolCall('read', { path: 'a.md' }, 'c1');
        throw new Error('most zwisł'); // finalny strzał backstopu pada
    });
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);
    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('read')],
        executeToolCall: async () => 'TREŚĆ NOTATKI A',
        limits: { maxIterations: 1, salvageMaxChars: 5000 }
    });
    t.is(res.stoppedBy, 'backstop');
    t.true(res.finalText.includes('TREŚĆ NOTATKI A'), res.finalText);
});

test('salvage wyłączony (0/brak) — zaślepka zostaje gołą zaślepką', async (t) => {
    const model = makeModel([
        assistantToolCall('search', { query: 'x' }, 'c1'),
        assistantText('')
    ]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);
    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('search')],
        executeToolCall: async () => 'ten wynik ma zostać wyrzucony',
        limits: { maxIterations: 1 }
    });
    t.is(res.stoppedBy, 'backstop');
    t.false(res.finalText.includes('ten wynik ma zostać wyrzucony'));
});

// ─── Per-tool sufit wyniku narzędzia ───

test('maxToolResultLengthPerTool — delegate dostaje większy sufit, reszta wspólny', async (t) => {
    const model = makeModel([
        assistantToolCall('delegate', { task: 'x' }, 'c1'),
        assistantToolCall('search', { query: 'y' }, 'c2'),
        assistantText('done')
    ]);
    const store = new ArrayMessageStore([{ role: 'user', content: 'go' }]);
    const bigResult = 'D'.repeat(500);
    const res = await runAgentLoop({
        model,
        store,
        resolveTools: () => [toolDef('delegate'), toolDef('search')],
        executeToolCall: async (_tc: ParsedToolCall) => bigResult,
        limits: { maxIterations: 5, maxToolResultLength: 100, maxToolResultLengthPerTool: { delegate: 0 } }
    });
    t.is(res.stoppedBy, 'natural');
    const toolMsgs = store.messages.filter((m) => m.role === 'tool');
    // delegate: 0 = bez limitu - pełne 500 znaków; search: wspólny sufit 100 + nota o przycięciu.
    t.is(toolMsgs[0].content, bigResult);
    t.true(String(toolMsgs[1].content).startsWith('D'.repeat(100)));
    t.true(String(toolMsgs[1].content).length < 500);
});
