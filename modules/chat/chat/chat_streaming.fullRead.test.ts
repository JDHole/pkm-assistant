import test from 'ava';
import { ArrayMessageStore, runAgentLoop } from '../../agent-loop/index.js';
import { MCPClient, createReadTool } from '../../tools/index.js';
import { _chatExecuteToolCall } from './chat_streaming.js';

type ReadPage = {
    success: boolean; content: string; path: string; source_version: string;
    source_length: number; offset: number; effective_limit: number;
    next_offset: number | null; has_more: boolean; truncated: boolean; code?: string;
};
type Message = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string }> };
const TERMINAL_FIELD = 'END-OF-CHAT-FIXTURE-7f3c2a';
const SOURCE = `${'line "quoted" \\ 😀 é\r\n'.repeat(2800)}${TERMINAL_FIELD}`;

function makeReadRuntime(source: string) {
    const file = { path: 'Fixtures/full-read.md', name: 'full-read.md' };
    const app = { vault: {
        getAbstractFileByPath: (path: string) => path === file.path ? file : null,
        cachedRead: async () => source, adapter: { read: async () => source },
    } };
    const agent = { name: 'Reader', permissions: { read_notes: true, guidance_mode: false, mcp: true } };
    const plugin = { agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: { checkPermission: () => ({ allowed: true, requiresApproval: false }),
            requiresApproval: () => false } };
    // MCPClient passes its trusted page budget only to registered built-ins.
    const readTool = { ...createReadTool(), source: 'built-in' };
    const mcpClient = new MCPClient(app as never, plugin as never, {
        getTool: (name: string) => name === 'read' ? readTool as never : null,
        getToolDefinitions: () => [],
    } as never);
    const view = { plugin: { mcpClient } } as never;
    const turn = { agentName: 'Reader', autonomy: 'edge', origin: null, rawResults: new Map() };
    return { view, turn, file };
}

for (const cap of [15000, 600]) {
    test(`chat executor and AgentLoop reconstruct every page at cap ${cap}`, async t => {
        t.true(SOURCE.length >= 55000);
        const { view, turn, file } = makeReadRuntime(SOURCE);
        const pages: ReadPage[] = [];
        const resultLengths: number[] = [];
        const linkedIds: string[] = [];
        const failures: string[] = [];
        const store = new ArrayMessageStore([{ role: 'user', content: 'Read every page.' }]);
        const model = {
            stream(payload: { messages?: Message[] }, callbacks: { done(response: unknown): void }) {
                const messages = payload.messages || [];
                const latest = [...messages].reverse().find(message => message.role === 'tool');
                if (!latest) {
                    callbacks.done({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
                        { id: 'chat-read-0', type: 'function', function: {
                            name: 'read', arguments: JSON.stringify({ path: file.path }),
                        } },
                    ] } }] });
                    return;
                }
                const id = latest.tool_call_id || '';
                const parent = messages.find(message => message.role === 'assistant'
                    && message.tool_calls?.some(call => call.id === id));
                if (!parent) failures.push(`orphan tool result: ${id}`);
                linkedIds.push(id);
                const text = String(latest.content);
                resultLengths.push(text.length);
                let page: ReadPage;
                try { page = JSON.parse(text) as ReadPage; }
                catch {
                    failures.push(`invalid JSON in page ${pages.length}`);
                    callbacks.done({ choices: [{ message: { role: 'assistant', content: 'READ_FAILED' } }] });
                    return;
                }
                if (!page.success) {
                    failures.push(`page ${pages.length}: ${page.code || 'unknown error'}`);
                    callbacks.done({ choices: [{ message: { role: 'assistant', content: 'READ_FAILED' } }] });
                    return;
                }
                pages.push(page);
                if (page.has_more) {
                    callbacks.done({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
                        { id: `chat-read-${pages.length}`, type: 'function', function: {
                            name: 'read', arguments: JSON.stringify({
                                path: page.path, offset: page.next_offset, source_version: page.source_version,
                            }),
                        } },
                    ] } }] });
                    return;
                }
                callbacks.done({ choices: [{ message: {
                    role: 'assistant',
                    content: pages.map(item => item.content).join('') === SOURCE
                        ? `READ_COMPLETE ${TERMINAL_FIELD}` : 'READ_FAILED',
                } }] });
            },
        };
        const outcome = await runAgentLoop({
            model: model as never, store,
            executeToolCall: (call, context) => _chatExecuteToolCall.call(view, turn as never, call, context),
            limits: { maxIterations: 500, maxToolResultLength: cap },
        });
        t.deepEqual(failures, []);
        t.is(outcome.stoppedBy, 'natural');
        t.is(outcome.finalText, `READ_COMPLETE ${TERMINAL_FIELD}`);
        t.true(pages.length > 1 && pages.length < 500);
        t.is(pages.map(page => page.content).join(''), SOURCE);
        t.true(resultLengths.every(length => length <= Math.min(cap, 12000)));
        t.deepEqual(linkedIds, pages.map((_, index) => `chat-read-${index}`));
        t.is(turn.rawResults.size, pages.length);
        let offset = 0;
        const version = pages[0].source_version;
        for (const [index, page] of pages.entries()) {
            t.is(page.path, file.path);
            t.is(page.source_version, version);
            t.is(page.source_length, SOURCE.length);
            t.is(page.offset, offset);
            t.is(page.next_offset, index === pages.length - 1 ? null : offset + page.content.length);
            t.is(page.has_more, index !== pages.length - 1);
            t.is(page.truncated, index !== pages.length - 1);
            t.true(page.effective_limit >= page.content.length);
            offset += page.content.length;
        }
        t.is(offset, SOURCE.length);
    });
}
