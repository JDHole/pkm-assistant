import test from 'ava';
import { SubAgentRunner } from './SubAgentRunner.js';
import { SubTaskRegistry } from './SubTaskRegistry.js';
import type { SubAgentData } from './types.js';
import type { ChatModel } from '../models/index.js';

const config: SubAgentData = { name: 'worker', description: 'worker', role: 'researcher', model: null, tools: ['read'], scope: null, max_iterations: null, min_iterations: null, max_tool_result_length: null, enabled: true, prompt: '' };
const owner = { agentName: 'Lead' };

test('runTask przejmuje queued na tym samym id i zamraża konfigurację przy starcie', async t => {
    const registry = new SubTaskRegistry();
    const threadId = 'sub/worker#reserved';
    registry.createThread({ threadId, name: 'worker', owner, origin: owner, config: {}, phase: 'queued' });
    const taskIds: string[] = [];
    registry.events.on('task:created', (value: unknown) => {
        const task = value as { id: string };
        taskIds.push(task.id);
    });
    let payloadTools: string[] = [];
    const model = { stream(payload: { tools?: Array<{ function: { name: string } }> }, cb: { done(value: unknown): void }) {
        payloadTools = (payload.tools ?? []).map(tool => tool.function.name);
        cb.done({ choices: [{ message: { role: 'assistant', content: 'GOTOWE' } }] });
    } } as unknown as ChatModel;
    const tool = { name: 'read', description: 'read', inputSchema: {}, execute: async () => ({}) };
    const runner = new SubAgentRunner({ toolRegistry: { getTool: (name: string) => name === 'read' ? tool : null, filterByAgent: () => [tool] }, app: {}, plugin: { subTaskRegistry: registry } });
    await runner.runTask('zadanie', { name: owner.agentName }, config, model, { origin: owner, queuedThreadId: threadId });
    t.is(taskIds[0], threadId);
    t.is(registry.getThread(threadId)?.runIds[0], threadId);
    t.is(registry.getThread(threadId)?.phase, 'closed');
    t.deepEqual(payloadTools, ['read']);
    t.deepEqual(registry.getThread(threadId)?.config.toolNames, ['read']);
});

test('runTask zamkniętego queued emituje jeden stopped empty bez zapytania modelu', async t => {
    const registry = new SubTaskRegistry();
    const threadId = 'sub/worker#stopped';
    registry.createThread({ threadId, name: 'worker', owner, origin: owner, config: {}, phase: 'queued' });
    registry.closeThread(threadId, 'lead');
    let modelCalls = 0;
    let created = 0;
    registry.events.on('task:created', () => created++);
    const model = { stream() { modelCalls++; } } as unknown as ChatModel;
    const runner = new SubAgentRunner({ toolRegistry: { getTool: () => null }, app: {}, plugin: { subTaskRegistry: registry } });
    await runner.runTask('zadanie', { name: owner.agentName }, config, model, { origin: owner, queuedThreadId: threadId, background: true });
    await runner.runTask('zadanie ponownie', { name: owner.agentName }, config, model, { origin: owner, queuedThreadId: threadId, background: true });
    const task = registry.getTask(threadId);
    t.is(modelCalls, 0);
    t.is(created, 1);
    t.deepEqual(task?.outcome, { end: { kind: 'stopped', by: 'lead' }, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] });
});

test('narzędzia suba na limicie głębokości ukrywają sub_agent', async t => {
    const registry = new SubTaskRegistry();
    const names = ['read', 'delegate', 'agent_delegate', 'sub_agent'];
    const tools = names.map(name => ({ name, description: name, inputSchema: {}, execute: async () => ({}) }));
    let visible: string[] = [];
    const model = { stream(payload: { tools?: Array<{ function: { name: string } }> }, cb: { done(value: unknown): void }) {
        visible = (payload.tools ?? []).map(tool => tool.function.name);
        cb.done({ choices: [{ message: { role: 'assistant', content: 'GOTOWE' } }] });
    } } as unknown as ChatModel;
    const runner = new SubAgentRunner({ toolRegistry: { getTool: (name: string) => tools.find(tool => tool.name === name) ?? null, filterByAgent: () => tools }, app: {}, plugin: { subTaskRegistry: registry } });
    await runner.runTask('zadanie', { name: owner.agentName }, { ...config, tools: names }, model, { origin: owner, delegationDepth: 1 });
    t.deepEqual(visible, ['read']);
});
