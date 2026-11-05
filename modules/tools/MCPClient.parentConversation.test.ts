import test from 'ava';
import { MCPClient } from './MCPClient.js';
import type { BuiltinToolExecutionContext } from './ToolRegistry.js';
import { ParentConversationProjection, freezeParentConversation } from '../sub-agents/index.js';

for (const [name, source, expected] of [['delegate', 'built-in', true], ['read', 'built-in', false], ['delegate', 'external', false]] as const) {
    test(`P1: prywatny snapshot tylko do built-in delegate: ${source}/${name}`, async t => {
        const projection = new ParentConversationProjection();
        projection.append({ role: 'user', content: 'PRYWATNA ROZMOWA' });
        const parentConversation = freezeParentConversation('lead', { agentName: 'Mira', sessionPath: 'a.md', sessionEpoch: 'a' }, 7, 'ollama', projection.snapshot());
        let received: unknown;
        const client = new MCPClient(null as never, {
            agentManager: { getAgent: () => ({ name: 'Mira' }), getActiveAgent: () => ({ name: 'Mira' }) },
            permissionSystem: { checkPermission: () => ({ allowed: true, requiresApproval: false }), requiresApproval: () => false },
        } as never, { getTool: () => ({ name, source, description: name,
            execute: async (args: unknown, _app: unknown, _plugin: unknown, context?: BuiltinToolExecutionContext) => {
                received = { args, conversation: context?.parentConversation };
                return { success: true, text: 'Przyjęto' };
            },
        }) } as never);
        const result = await client.executeToolCall({ name, arguments: { task: 'Zadanie' } }, 'Mira', { parentConversation });
        t.deepEqual(result, { success: true, text: 'Przyjęto' });
        t.deepEqual(received, { args: { task: 'Zadanie', _invocationAgentName: 'Mira', _invocationAutonomy: 'edge' }, conversation: expected ? {
            source: 'lead', owner: { agentName: 'Mira', sessionPath: 'a.md', sessionEpoch: 'a' }, turnId: 7, providerId: 'ollama',
            snapshot: { messages: [{ sequence: 1, role: 'user', text: 'PRYWATNA ROZMOWA' }], summary: '',
                keptMessages: 1, summarizedMessages: 0, omittedMessages: 0, truncated: false },
        } : undefined });
    });
}
