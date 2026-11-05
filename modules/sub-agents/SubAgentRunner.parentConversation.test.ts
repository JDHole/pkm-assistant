import test from 'ava';
import { SubAgentRunner } from './SubAgentRunner.js';
import { SubTaskRegistry } from './SubTaskRegistry.js';
import { QuestionTestClock } from './test-support/questionTestClock.js';
import { MCPClient } from '../tools/index.js';
import type { BuiltinToolExecutionContext } from '../tools/index.js';
import type { ParentConversationContext } from './ParentConversation.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

for (const fallback of [false, true]) {
    test(`P1: runner wysyła żywy snapshot przed endRun, MCP/fallback=${fallback}`, async t => {
        const registry = new SubTaskRegistry({ questionClock: new QuestionTestClock() });
        t.teardown(() => registry.dispose());
        const captured = deferred<ParentConversationContext | undefined>();
        const held = deferred<{ success: boolean }>();
        const owner = { agentName: 'Mira', sessionPath: 'a.md', sessionEpoch: 'epoch-a' };
        const delegate = { name: 'delegate', description: 'delegate', source: 'built-in', inputSchema: {},
            execute: (_args: unknown, _app: unknown, _plugin: unknown, runtime?: BuiltinToolExecutionContext) => {
                captured.resolve(runtime?.parentConversation);
                return held.promise;
            } };
        const toolRegistry = { getTool: (name: string) => name === 'delegate' ? delegate : null, filterByAgent: () => [delegate] };
        const plugin = { subTaskRegistry: registry, agentManager: { getAgent: () => ({ name: 'Mira' }) },
            permissionSystem: { checkPermission: () => ({ allowed: true, requiresApproval: false }), requiresApproval: () => false } };
        const mcp = new MCPClient(null as never, plugin as never, toolRegistry as never);
        const runner = new SubAgentRunner({ app: {}, plugin: { ...plugin, mcpClient: fallback ? undefined : mcp } as never, toolRegistry });
        let calls = 0;
        const model = { providerId: 'ollama', modelId: 'worker-model', stream(_payload: unknown, handlers: { done(response: unknown): void }) {
            handlers.done({ choices: [{ message: calls++ === 0 ? { role: 'assistant', content: 'Własny tekst rodzica.', reasoning_content: 'MYŚLENIE',
                tool_calls: [{ id: 'delegate', function: { name: 'delegate', arguments: '{"task":"Wnuk"}' } }] }
                : { role: 'assistant', content: 'Gotowe' } }] });
        } };
        const run = runner.runTask('Zadanie rodzica', { name: 'Mira' }, { name: 'worker', tools: ['delegate'] } as never, model as never, { origin: owner, delegationDepth: 1 });
        const snapshot = await captured.promise;
        const task = registry.list()[0];
        t.deepEqual({ source: snapshot?.source, owner: snapshot?.owner, providerId: snapshot?.providerId, snapshot: snapshot?.snapshot }, {
            source: 'sub', owner, providerId: 'ollama', snapshot: { messages: [
                { sequence: 1, role: 'user', text: 'Zadanie rodzica' },
                { sequence: 2, role: 'assistant', text: 'Własny tekst rodzica.' },
            ], summary: '', keptMessages: 2, summarizedMessages: 0, omittedMessages: 0, truncated: false },
        });
        t.is(snapshot?.turnId, task.id);
        t.deepEqual(registry.getThread(task.threadId!)?.transcript, []);
        held.resolve({ success: true });
        t.is((await run).result, 'Gotowe');
        t.deepEqual(snapshot?.snapshot.messages, [
            { sequence: 1, role: 'user', text: 'Zadanie rodzica' },
            { sequence: 2, role: 'assistant', text: 'Własny tekst rodzica.' },
        ]);
    });
}
