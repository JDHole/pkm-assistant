import test from 'ava';
import { SubAgentRunner } from './SubAgentRunner.js';
import { SubTaskRegistry } from './SubTaskRegistry.js';
import { t as tr } from '../../core/i18n/index.js';
import type { SubAgentData } from './types.js';
import type { ChatModel } from '../models/index.js';
import { countTokens } from '../../core/index.js';

const config: SubAgentData = { name: 'worker', description: 'worker', role: 'researcher', model: null, tools: [], scope: null, max_iterations: null, min_iterations: null, max_tool_result_length: null, enabled: true, prompt: '' };
const owner = { agentName: 'Tester', sessionPath: 'active.md', sessionEpoch: 'epoch-tests' };

function done(text: string) {
    return { stream(_payload: unknown, cb: { done(value: unknown): void }) {
        cb.done({ choices: [{ message: { role: 'assistant', content: text } }] });
    } } as unknown as ChatModel;
}

function tool(name: string) {
    return { name, description: name, inputSchema: {}, execute: async () => ({ success: true }) };
}

function toolThenAnswer(name: string, args: string, answer: string, reasoningContent?: unknown, callContent: string | null = null) {
    let calls = 0;
    return { stream(_payload: unknown, cb: { done(value: unknown): void }) {
        calls++;
        cb.done({ choices: [{ message: calls === 1
            ? { role: 'assistant', content: callContent, reasoning_content: reasoningContent,
                tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: args } }] }
            : { role: 'assistant', content: answer } }] });
    } } as unknown as ChatModel;
}

test('runTask kontynuuje wątek z dokładnie jedną odpowiedzią poprzedniego biegu', async t => {
    const owner = { agentName: 'Tester', sessionPath: 'active.md', sessionEpoch: 'epoch-1' };
    const registry = new SubTaskRegistry();
    const runner = new SubAgentRunner({ toolRegistry: { getTool: () => null }, app: {}, plugin: { subTaskRegistry: registry } });
    const firstModel = { stream(_payload: unknown, cb: { done(value: unknown): void }) { cb.done({ choices: [{ message: { role: 'assistant', content: 'ODPOWIEDŹ_POPRZEDNIEGO' } }] }); } };
    await runner.runTask('pierwsze zadanie', { name: owner.agentName }, config, firstModel as unknown as ChatModel, { modelTimeout: 5, origin: owner });
    const thread = registry.listThreads(owner)[0];
    t.is(thread.phase, 'idle');

    let seen: Array<{ role: string; content?: unknown }> = [];
    const nextModel = { stream(payload: { messages?: Array<{ role: string; content?: unknown }> }, cb: { done(value: unknown): void }) {
        seen = payload.messages ?? [];
        cb.done({ choices: [{ message: { role: 'assistant', content: 'ODPOWIEDŹ_DRUGIEGO' } }] });
    } };
    await runner.runTask('drugie zadanie', { name: owner.agentName }, { ...config, tools: ['write'] }, nextModel as unknown as ChatModel, {
        modelTimeout: 5, origin: owner, threadId: thread.threadId, callerToolNames: ['read', 'write'], scopeFolders: ['private'],
    });
    t.is(seen.filter(message => message.role === 'assistant' && message.content === 'ODPOWIEDŹ_POPRZEDNIEGO').length, 1);
    t.true(String(seen.at(-1)?.content).includes(tr('subagent.thread_next_task', { task: 'drugie zadanie' })));
    t.true(String(seen[0]?.content).includes('worker'));
    t.deepEqual(registry.getThread(thread.threadId)?.config.toolNames, []);
});

test('runTask odmawia kontynuacji, gdy rozmowa przekracza limit kontekstu', async t => {
    const owner = { agentName: 'Tester', sessionPath: 'active.md', sessionEpoch: 'epoch-context' };
    const registry = new SubTaskRegistry();
    const runner = new SubAgentRunner({ toolRegistry: { getTool: () => null }, app: {}, plugin: { subTaskRegistry: registry, env: { settings: { pkmAssistant: { limits: { subagent_thread_context_tokens: 4096 } } } } } });
    const longModel = { stream(_payload: unknown, cb: { done(value: unknown): void }) { cb.done({ choices: [{ message: { role: 'assistant', content: 'x'.repeat(18000) } }] }); } };
    await runner.runTask('zadanie', { name: owner.agentName }, config, longModel as unknown as ChatModel, { modelTimeout: 5, origin: owner });
    const thread = registry.listThreads(owner)[0];
    const result = await runner.runTask('kontynuuj', { name: owner.agentName }, config, longModel as unknown as ChatModel, { modelTimeout: 5, origin: owner, threadId: thread.threadId });
    t.is(result.result, tr('subagent.thread_refused'));
    t.is(registry.getThread(thread.threadId)?.phase, 'closed');
    t.deepEqual(registry.getThread(thread.threadId)?.transcript, []);
});

test('runTask liczy reasoning_content i tool_calls w budżecie kontekstu', async t => {
    const registry = new SubTaskRegistry();
    const read = tool('read');
    const runner = new SubAgentRunner({ toolRegistry: { getTool: () => read, filterByAgent: () => [read] }, app: {},
        plugin: { subTaskRegistry: registry, env: { settings: { pkmAssistant: { limits: { subagent_thread_context_tokens: 12000 } } } } } });
    await runner.runTask('pierwsze', { name: owner.agentName }, { ...config, tools: ['read'] },
        toolThenAnswer('read', JSON.stringify({ path: 'x'.repeat(30000) }), 'GOTOWE', 'r'.repeat(30000), 'Czytam plik.'),
        { origin: owner, modelTimeout: 5 });
    const thread = registry.listThreads(owner)[0];
    const fullEstimate = countTokens(JSON.stringify(thread.transcript)) + 4096;
    t.is(thread.phase, 'idle');
    t.true(fullEstimate > 12000);
    let modelCalls = 0;
    const model = { stream() { modelCalls++; } } as unknown as ChatModel;
    const result = await runner.runTask('drugie', { name: owner.agentName }, config, model,
        { origin: owner, threadId: thread.threadId, modelTimeout: 5 });
    t.is(result.result, tr('subagent.thread_refused'));
    t.is(modelCalls, 0);
    t.is(registry.getThread(thread.threadId)?.phase, 'closed');
});

test('runTask zachowuje zamrożony budżet promptu mimo zmiany ustawień', async t => {
    const registry = new SubTaskRegistry();
    const settings = { pkmAssistant: { limits: { subagent_max_iterations_worker: 2 } } };
    const runner = new SubAgentRunner({ toolRegistry: { getTool: () => null }, app: {}, plugin: { subTaskRegistry: registry, env: { settings } } });
    await runner.runTask('pierwsze', { name: owner.agentName }, config, done('PIERWSZA'), { origin: owner, modelTimeout: 5 });
    const thread = registry.listThreads(owner)[0];
    settings.pkmAssistant.limits.subagent_max_iterations_worker = 100;
    let prompt = '';
    const model = { stream(payload: { messages: Array<{ content?: unknown }> }, cb: { done(value: unknown): void }) {
        prompt = String(payload.messages[0].content);
        cb.done({ choices: [{ message: { role: 'assistant', content: 'DRUGA' } }] });
    } } as unknown as ChatModel;
    await runner.runTask('drugie', { name: owner.agentName }, config, model, { origin: owner, threadId: thread.threadId, modelTimeout: 5 });
    t.true(prompt.includes(tr('subagent.frame.budget_iterations', { count: 2 })));
    t.false(prompt.includes(tr('subagent.frame.budget_iterations', { count: 100 })));
});

test('runTask nie poszerza narzędzi ani zakresu po kontynuacji', async t => {
    const registry = new SubTaskRegistry();
    const read = tool('read'); const write = tool('write');
    const calls: Array<{ scopeFolders?: string[] | null; callerToolNames?: string[] }> = [];
    const runner = new SubAgentRunner({ toolRegistry: { getTool: (name: string) => name === 'read' ? read : write, filterByAgent: () => [read, write] },
        app: {}, plugin: { subTaskRegistry: registry, mcpClient: { executeToolCall: async (_call: unknown, _agent: string, options: { scopeFolders?: string[] | null; callerToolNames?: string[] }) => {
            calls.push(options); return { success: true };
        } } } });
    const cfg = { ...config, tools: ['read', 'write'] };
    await runner.runTask('pierwsze', { name: owner.agentName }, cfg, done('PIERWSZA'),
        { origin: owner, callerToolNames: ['read'], scopeFolders: ['Safe'], modelTimeout: 5 });
    const thread = registry.listThreads(owner)[0];
    let visible: string[] = [];
    const second = { stream(payload: { tools?: Array<{ function: { name: string } }> }, cb: { done(value: unknown): void }) {
        if (!visible.length) {
            visible = (payload.tools ?? []).map(x => x.function.name);
            cb.done({ choices: [{ message: { role: 'assistant', content: null,
                tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read', arguments: '{}' } }] } }] });
        } else cb.done({ choices: [{ message: { role: 'assistant', content: 'DRUGA' } }] });
    } } as unknown as ChatModel;
    await runner.runTask('drugie', { name: owner.agentName }, cfg, second,
        { origin: owner, threadId: thread.threadId, callerToolNames: ['read', 'write'], scopeFolders: ['Safe', 'Private'], modelTimeout: 5 });
    t.deepEqual(visible, ['read']);
    t.deepEqual(calls[0].scopeFolders, ['Safe']);
    t.deepEqual(calls[0].callerToolNames, ['read']);
});

test('runTask zachowuje pary narzędzi, reasoning_content i niezależną kopię rozmowy', async t => {
    const registry = new SubTaskRegistry();
    const read = tool('read');
    const runner = new SubAgentRunner({ toolRegistry: { getTool: () => read, filterByAgent: () => [read] }, app: {}, plugin: { subTaskRegistry: registry } });
    await runner.runTask('pierwsze', { name: owner.agentName }, { ...config, tools: ['read'] },
        toolThenAnswer('read', '{"path":"A.md"}', 'WYNIK', { token: 'oryginał' }), { origin: owner, modelTimeout: 5 });
    const thread = registry.listThreads(owner)[0];
    const savedCall = thread.transcript.find(m => m.role === 'assistant' && m.tool_calls);
    let seen: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string; function: { arguments: string } }>; tool_call_id?: string; reasoning_content?: unknown }> = [];
    const model = { stream(payload: { messages: typeof seen }, cb: { done(value: unknown): void }) {
        seen = payload.messages;
        const call = seen.find(m => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'call-1');
        if (call?.tool_calls?.[0]) call.tool_calls[0].function.arguments = 'ZMIENIONE';
        cb.done({ choices: [{ message: { role: 'assistant', content: 'DRUGI WYNIK' } }] });
    } } as unknown as ChatModel;
    await runner.runTask('drugie', { name: owner.agentName }, config, model, { origin: owner, threadId: thread.threadId, modelTimeout: 5 });
    const call = seen.find(m => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'call-1');
    t.deepEqual(call?.reasoning_content, { token: 'oryginał' });
    t.is(seen.filter(m => m.role === 'tool' && m.tool_call_id === 'call-1').length, 1);
    t.is(seen.filter(m => m.role === 'assistant' && m.content === 'WYNIK').length, 1);
    t.is((savedCall?.tool_calls?.[0] as { function: { arguments: string } }).function.arguments, '{"path":"A.md"}');
});

test('runTask zachowuje efekty starszych biegów i rozróżnia potwierdzone usunięcie', async t => {
    const registry = new SubTaskRegistry();
    const write = tool('write'); const del = tool('delete');
    const existing = new Set(['X.md']);
    const runner = new SubAgentRunner({ toolRegistry: { getTool: (name: string) => name === 'write' ? write : del, filterByAgent: () => [write, del] },
        app: {}, plugin: { subTaskRegistry: registry, mcpClient: { executeToolCall: async (call: { name: string }, _agent: string, options: { onExecutionStart(): void }) => {
            options.onExecutionStart();
            if (call.name === 'write') existing.add('X.md'); else existing.delete('X.md');
            return { success: true, path: 'X.md' };
        } } }, effectTargetIo: { exists: async path => existing.has(path) } });
    const cfg = { ...config, tools: ['write', 'delete'] };
    await runner.runTask('zapisz', { name: owner.agentName }, cfg, toolThenAnswer('write', '{"path":"X.md"}', 'ZAPISANE'), { origin: owner, modelTimeout: 5 });
    const thread = registry.listThreads(owner)[0];
    await runner.runTask('bez zmian', { name: owner.agentName }, cfg, done('BEZ ZMIAN'), { origin: owner, threadId: thread.threadId, modelTimeout: 5 });
    t.is(registry.getThread(thread.threadId)?.effects.length, 1);
    thread.effects.push({ tool: 'write', action: 'replace', targets: [{ kind: 'vault-file', path: 'Y.md' }], outcome: 'unknown', check: 'not-checked' });
    let thirdTask = '';
    const third = { stream(payload: { messages: Array<{ role: string; content?: unknown }> }, cb: { done(value: unknown): void }) {
        thirdTask = String(payload.messages.at(-1)?.content);
        cb.done({ choices: [{ message: { role: 'assistant', content: 'TRZECIA' } }] });
    } } as unknown as ChatModel;
    await runner.runTask('sprawdź', { name: owner.agentName }, cfg, third, { origin: owner, threadId: thread.threadId, modelTimeout: 5 });
    t.true(thirdTask.includes(tr('subagent.thread_effect_saved', { target: 'X.md' })));
    t.true(thirdTask.includes(tr('subagent.thread_effect_unknown', { tool: 'write' })));
    await runner.runTask('usuń', { name: owner.agentName }, cfg, toolThenAnswer('delete', '{"path":"X.md"}', 'USUNIĘTE'), { origin: owner, threadId: thread.threadId, modelTimeout: 5 });
    let fifthTask = '';
    const fifth = { stream(payload: { messages: Array<{ content?: unknown }> }, cb: { done(value: unknown): void }) {
        fifthTask = String(payload.messages.at(-1)?.content);
        cb.done({ choices: [{ message: { role: 'assistant', content: 'PIĄTA' } }] });
    } } as unknown as ChatModel;
    await runner.runTask('potwierdź', { name: owner.agentName }, cfg, fifth, { origin: owner, threadId: thread.threadId, modelTimeout: 5 });
    t.true(fifthTask.includes(tr('subagent.thread_effect_deleted', { target: 'X.md' })));
    t.false(fifthTask.includes(tr('subagent.thread_effect_saved', { target: 'X.md' })));
});

test('runTask nie sprawdza ephemeral memory_save przy kontynuacji', async t => {
    const registry = new SubTaskRegistry();
    const saved = tool('memory_save');
    const checked: string[] = [];
    const runner = new SubAgentRunner({
        toolRegistry: { getTool: () => saved, filterByAgent: () => [saved] },
        app: { vault: { adapter: { async exists(path: string) { checked.push(path); return true; } } } },
        plugin: { subTaskRegistry: registry },
    });
    const cfg = { ...config, tools: ['memory_save'] };
    const first = await runner.runTask('zapisz ulotnie', { name: owner.agentName }, cfg,
        toolThenAnswer('memory_save', '{"fact":"tekst","ephemeral":true}', 'ZAPISANE'), { origin: owner, modelTimeout: 5 });
    t.is(first.outcome.effects[0]?.check, 'not-checked');
    const thread = registry.listThreads(owner)[0];
    t.is(thread.effects[0]?.expectedCheck, 'none');
    let nextTask = '';
    const second = { stream(payload: { messages: Array<{ content?: unknown }> }, cb: { done(value: unknown): void }) {
        nextTask = String(payload.messages.at(-1)?.content);
        cb.done({ choices: [{ message: { role: 'assistant', content: 'DRUGA' } }] });
    } } as unknown as ChatModel;
    await runner.runTask('sprawdź', { name: owner.agentName }, cfg, second,
        { origin: owner, threadId: thread.threadId, modelTimeout: 5 });
    t.true(nextTask.includes(tr('subagent.thread_effect_unchecked', { target: 'brain.md' })));
    t.deepEqual(checked, []);
});

test('runTask sprawdza ścieżki zwrócone przez trwałe memory_save i memory_delete', async t => {
    const registry = new SubTaskRegistry();
    const paths = new Set<string>();
    const cfg = { ...config, tools: ['memory_save', 'memory_delete'] };
    const owner = { agentName: 'Tester', sessionPath: 'active.md', sessionEpoch: 'epoch-memory-effects' };
    const execute = async (name: string, resultPath: string, present: boolean, answer: string, threadId?: string) => {
        const runTool = { ...tool(name), execute: async () => {
            if (present) paths.add(resultPath); else paths.delete(resultPath);
            return { success: true, path: resultPath };
        } };
        const localRunner = new SubAgentRunner({
            toolRegistry: { getTool: (_name: string) => runTool, filterByAgent: () => [runTool] },
            app: {}, plugin: { subTaskRegistry: registry },
            effectTargetIo: { exists: async path => paths.has(path) },
        });
        return localRunner.runTask(answer, { name: owner.agentName }, cfg, toolThenAnswer(name, '{}', answer), {
            origin: owner, modelTimeout: 5, ...(threadId ? { threadId } : {}),
        });
    };

    const savedPath = 'brain/notes/persistent.md';
    const first = await execute('memory_save', savedPath, true, 'ZAPISANO');
    t.is(first.outcome.effects[0]?.check, 'matches');
    const thread = registry.listThreads(owner)[0];
    const deletedPath = 'brain/notes/deleted.md';
    const second = await execute('memory_delete', deletedPath, false, 'USUNIĘTO', thread.threadId);
    t.is(second.outcome.effects[0]?.check, 'matches');
});

test('runTask odmawia kontynuacji na innej platformie z tym samym modelId', async t => {
    const registry = new SubTaskRegistry();
    const runner = new SubAgentRunner({ toolRegistry: { getTool: () => null }, app: {}, plugin: { subTaskRegistry: registry } });
    const first = Object.assign(done('PIERWSZA'), { modelId: 'shared-model', modelKey: 'shared-model', providerId: 'openai' });
    await runner.runTask('pierwsze', { name: owner.agentName }, config, first, { origin: owner, modelTimeout: 5 });
    const thread = registry.listThreads(owner)[0];
    t.is(thread.phase, 'idle');
    let modelCalls = 0;
    const second = { modelId: 'shared-model', modelKey: 'shared-model', providerId: 'open_router', stream() { modelCalls++; } } as unknown as ChatModel;
    const result = await runner.runTask('drugie', { name: owner.agentName }, config, second,
        { origin: owner, threadId: thread.threadId, modelTimeout: 5 });
    t.is(result.result, tr('subagent.thread_refused'));
    t.is(modelCalls, 0);
    t.is(registry.getThread(thread.threadId)?.phase, 'closed');
});

test('runTask zapisuje końcową syntezę, ale pomija tekst ratunkowy', async t => {
    const read = tool('read');
    const makeRunner = (registry: SubTaskRegistry, synthesisTimeoutMs?: number) => new SubAgentRunner({
        toolRegistry: { getTool: () => read, filterByAgent: () => [read] }, app: {},
        plugin: { subTaskRegistry: registry, env: { settings: { pkmAssistant: { limits: { model_synthesis_timeout_ms: synthesisTimeoutMs } } } } },
    });
    const cfg = { ...config, tools: ['read'], max_iterations: 1 };
    const modelWithBackstop = (onSynthesis: () => void = () => {}) => ({ stream(payload: { tools?: unknown[] }, cb: { done(value: unknown): void }) {
        if (!payload.tools?.length) {
            onSynthesis();
            cb.done({ choices: [{ message: { role: 'assistant', content: 'SYNTEZA' } }] });
        } else cb.done({ choices: [{ message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read', arguments: '{}' } }] } }] });
    } }) as unknown as ChatModel;
    const goodRegistry = new SubTaskRegistry();
    const goodResult = await makeRunner(goodRegistry).runTask('zadanie', { name: owner.agentName }, cfg, modelWithBackstop(), { origin: owner, modelTimeout: 5 });
    t.is(goodResult.outcome.hasAnswer, true);
    t.is(goodRegistry.listThreads(owner)[0].transcript.filter(m => m.role === 'assistant' && m.content === 'SYNTEZA').length, 1);

    const fallbackRegistry = new SubTaskRegistry();
    const fallbackRunner = makeRunner(fallbackRegistry, 0);
    let synthesisCalls = 0;
    const fallbackResult = await fallbackRunner.runTask('zadanie', { name: owner.agentName }, cfg,
        modelWithBackstop(() => { synthesisCalls++; }), { origin: owner, modelTimeout: 5 });
    const thread = fallbackRegistry.listThreads(owner)[0];
    t.is(synthesisCalls, 0);
    t.is(fallbackResult.stoppedBy, 'backstop');
    t.is(fallbackResult.partial?.synthesis, 'skipped');
    t.true(fallbackResult.result.includes(tr('agentLoop.partial_header')));
    t.is(fallbackResult.outcome.hasAnswer, false);
    t.is(thread.phase, 'idle');
    t.is(thread.transcript.filter(m => m.role === 'assistant' && (m.tool_calls?.[0] as { id?: string } | undefined)?.id === 'read-1').length, 1);
    t.is(thread.transcript.filter(m => m.role === 'tool' && m.tool_call_id === 'read-1').length, 1);
    t.is(thread.transcript.filter(m => m.role === 'assistant' && m.content === fallbackResult.result).length, 0);

    let seen: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string }>; tool_call_id?: string }> = [];
    const nextModel = { stream(payload: { messages: typeof seen }, cb: { done(value: unknown): void }) {
        seen = payload.messages;
        cb.done({ choices: [{ message: { role: 'assistant', content: 'DRUGA ODPOWIEDŹ' } }] });
    } } as unknown as ChatModel;
    await fallbackRunner.runTask('kolejne zadanie', { name: owner.agentName }, cfg, nextModel,
        { origin: owner, threadId: thread.threadId, modelTimeout: 5 });
    t.is(seen.filter(m => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'read-1').length, 1);
    t.is(seen.filter(m => m.role === 'tool' && m.tool_call_id === 'read-1').length, 1);
    t.is(seen.filter(m => m.role === 'assistant' && m.content === fallbackResult.result).length, 0);
});

test('runTask przyjmuje piąty bieg i odmawia szóstego', async t => {
    const registry = new SubTaskRegistry();
    const runner = new SubAgentRunner({ toolRegistry: { getTool: () => null }, app: {}, plugin: { subTaskRegistry: registry } });
    const run = (threadId?: string) => runner.runTask('zadanie', { name: owner.agentName }, config, done('OK'),
        { origin: owner, ...(threadId ? { threadId } : {}), modelTimeout: 5 });
    await run();
    const thread = registry.listThreads(owner)[0];
    for (let i = 2; i <= 5; i++) {
        const result = await run(thread.threadId);
        t.is(result.result, 'OK');
        t.is(registry.getThread(thread.threadId)?.runIds.length, i);
    }
    t.is(registry.getThread(thread.threadId)?.phase, 'closed');
    const sixth = await run(thread.threadId);
    t.is(sixth.result, tr('subagent.thread_refused'));
    t.is(registry.getThread(thread.threadId)?.runIds.length, 5);
});

test('wyjątek runnera zamyka wątek i zwalnia rozmowę', async t => {
    const registry = new SubTaskRegistry();
    const runner = new SubAgentRunner({ toolRegistry: { getTool: () => null }, app: {}, plugin: { subTaskRegistry: registry } });
    const broken = { stream(_payload: unknown, cb: { error(error: Error): void }) { cb.error(new Error('model padł')); } } as unknown as ChatModel;
    const result = await runner.runTask('zadanie', { name: owner.agentName }, config, broken, { origin: owner, modelTimeout: 5 });
    const thread = registry.listThreads(owner)[0];
    t.is(result.failed, true);
    t.is(thread.phase, 'closed');
    t.is(thread.reusable, false);
    t.deepEqual(thread.transcript, []);
});
