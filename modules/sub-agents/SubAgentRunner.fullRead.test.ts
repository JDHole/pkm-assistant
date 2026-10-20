import test from 'ava';
import { SubAgentRunner } from './SubAgentRunner.js';
import { MCPClient, createReadTool } from '../tools/index.js';

type ReadPage = {
    success: boolean; content: string; path: string; source_version: string;
    source_length: number; offset: number; effective_limit: number;
    next_offset: number | null; has_more: boolean; truncated: boolean; code?: string;
};
type Message = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string }> };
const TERMINAL_FIELD = 'END-OF-SUB-FIXTURE-7f3c2a';
const SOURCE = `${'content-0123456789abcdef\r\n'.repeat(2400)}${TERMINAL_FIELD}`;

function makeFixtureRuntime(source: string) {
    const file = { path: 'Fixtures/sub-full-read.md', name: 'sub-full-read.md' };
    const app = { vault: {
        getAbstractFileByPath: (path: string) => path === file.path ? file : null,
        cachedRead: async () => source, adapter: { read: async () => source },
    } };
    const agent = { name: 'Reader', permissions: { read_notes: true, guidance_mode: false, mcp: true } };
    const plugin: Record<string, unknown> = {
        agentManager: { getAgent: () => agent, getActiveAgent: () => agent },
        permissionSystem: {
            checkPermission: () => ({ allowed: true, requiresApproval: false }),
            requiresApproval: () => false,
        },
    };
    const readTool = { ...createReadTool(), source: 'built-in' };
    const registry = {
        getTool: (name: string) => name === 'read' ? readTool : null,
        filterByAgent: () => [readTool], getToolDefinitions: () => [],
    };
    plugin.mcpClient = new MCPClient(app as never, plugin as never, registry as never);
    return { runner: new SubAgentRunner({ toolRegistry: registry, app, plugin }), file };
}

for (const cap of [15000, 600]) {
    test(`SubAgentRunner.runTask reconstructs every page at cap ${cap}`, async t => {
        // At cap 600 the shared iteration ceiling is 100, so keep this
        // fixture long enough to page but short enough to finish within it.
        const source = cap === 600 ? `${'content-0123456789abcdef\r\n'.repeat(600)}${TERMINAL_FIELD}` : SOURCE;
        const { runner, file } = makeFixtureRuntime(source);
        const pages: ReadPage[] = [];
        const resultLengths: number[] = [];
        const linkedIds: string[] = [];
        const failures: string[] = [];
        const model = {
            stream(payload: { messages?: Message[] }, callbacks: { done(response: unknown): void }) {
                const messages = payload.messages || [];
                const latest = [...messages].reverse().find(message => message.role === 'tool');
                if (!latest) {
                    callbacks.done({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
                        { id: 'sub-read-0', type: 'function', function: {
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
                        { id: `sub-read-${pages.length}`, type: 'function', function: {
                            name: 'read', arguments: JSON.stringify({
                                path: page.path, offset: page.next_offset, source_version: page.source_version,
                            }),
                        } },
                    ] } }] });
                    return;
                }
                callbacks.done({ choices: [{ message: {
                    role: 'assistant',
                    content: pages.map(item => item.content).join('') === source
                        ? `READ_COMPLETE ${TERMINAL_FIELD}` : 'READ_FAILED',
                } }] });
            },
        };
        const outcome = await runner.runTask(
            'Read every page and report the terminal field.', { name: 'Reader' },
            { name: 'full-reader', tools: ['read'], max_iterations: 500, max_tool_result_length: cap } as never,
            model as never, { modelTimeout: 500 },
        );
        t.deepEqual(failures, []);
        t.is(outcome.stoppedBy, 'natural');
        t.is(outcome.result, `READ_COMPLETE ${TERMINAL_FIELD}`);
        t.true(pages.length > 1 && pages.length < 100);
        t.is(pages.map(page => page.content).join(''), source);
        t.true(resultLengths.every(length => length <= Math.min(cap, 12000)));
        t.deepEqual(linkedIds, pages.map((_, index) => `sub-read-${index}`));
        let offset = 0;
        const version = pages[0].source_version;
        for (const [index, page] of pages.entries()) {
            t.is(page.path, file.path);
            t.is(page.source_version, version);
            t.is(page.source_length, source.length);
            t.is(page.offset, offset);
            t.is(page.next_offset, index === pages.length - 1 ? null : offset + page.content.length);
            t.is(page.has_more, index !== pages.length - 1);
            t.is(page.truncated, index !== pages.length - 1);
            t.true(page.effective_limit >= page.content.length);
            offset += page.content.length;
        }
        t.is(offset, source.length);
    });
}
