import test from 'ava';
import { _chatResolveTools } from './chat_streaming.js';
import { ToolRegistry } from '../../tools/index.js';

test('lead sees only the reply schema when sub_agent is disabled', t => {
    const registry = new ToolRegistry();
    for (const name of ['delegate', 'sub_agent']) registry.registerTool({
        name, description: name, inputSchema: { type: 'object' }, execute: async () => ({}),
    });
    const context = { plugin: { toolRegistry: registry }, };
    const resolve = (disabled_tools: string[]) => _chatResolveTools.call(context as never,
        { agent: { name: 'Mira', disabled_tools }, rw: { setContextTokenSources() {} } } as never, true);
    const reply = resolve(['sub_agent']).find(tool => tool.function?.name === 'sub_agent');
    t.deepEqual(reply?.function.parameters, { type: 'object', properties: {
        action: { type: 'string', enum: ['message'] }, sub_id: { type: 'string' },
        question_id: { type: 'string' }, text: { type: 'string' },
    }, required: ['action', 'sub_id', 'question_id', 'text'] });
    t.is(resolve(['sub_agent', 'delegate']).some(tool => tool.function?.name === 'sub_agent'), false);
    t.deepEqual(resolve([]).find(tool => tool.function?.name === 'sub_agent')?.function.parameters, { type: 'object' });
});
