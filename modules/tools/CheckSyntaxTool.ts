import { t } from '../../core/i18n/index.js';
import { createReadTool } from './ReadTool.js';
import type { ReadToolApp, ReadToolPlugin } from './ReadTool.js';
import type { BuiltinToolExecutionContext } from './ToolRegistry.js';
import { checkSyntax } from './syntaxValidator.js';
import type { SyntaxKind } from './syntaxValidator.js';

export function createCheckSyntaxTool() {
    return {
        name: 'check_syntax',
        description: t('mcp.check_syntax.desc'),
        inputSchema: { type: 'object', properties: {
            path: { type: 'string', description: t('mcp.check_syntax.path') },
            kind: { type: 'string', enum: ['js', 'json', 'yaml', 'markdown'], description: t('mcp.check_syntax.kind') },
        }, required: ['path'] },
        contextExtractor: (args: { path?: unknown }) => ({ targetPath: args.path || '' }),
        execute: async (args: { path?: unknown; kind?: unknown; [key: string]: unknown }, app: ReadToolApp, plugin: ReadToolPlugin, context?: BuiltinToolExecutionContext) => {
            const kinds: Record<string, SyntaxKind> = { js: 'js', mjs: 'js', cjs: 'js', json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown' };
            const extension = typeof args.path === 'string' ? args.path.split('.').pop()?.toLowerCase() ?? '' : '';
            const kind = args.kind === undefined ? kinds[extension] : typeof args.kind === 'string' && ['js', 'json', 'yaml', 'markdown'].includes(args.kind) ? args.kind as SyntaxKind : undefined;
            if (!kind) return { ok: false, error: t('mcp.check_syntax.unsupported') };
            const read = createReadTool();
            const readArgs = { path: args.path, _invocationAgentName: args._invocationAgentName, scope: 'vault' };
            const first = await read.execute(readArgs, app, plugin, context);
            if (!first || typeof first !== 'object' || !('success' in first) || first.success !== true || !('content' in first) || typeof first.content !== 'string') return { ok: false, kind, error: first };
            let result: Record<string, unknown> = first;
            let content = first.content;
            while ('next_offset' in result && typeof result.next_offset === 'number' && 'source_version' in result && typeof result.source_version === 'string') {
                const next = await read.execute({ ...readArgs, offset: result.next_offset, source_version: result.source_version }, app, plugin, context);
                if (!next || typeof next !== 'object' || !('success' in next) || next.success !== true || !('content' in next) || typeof next.content !== 'string') return { ok: false, kind, error: next };
                content += next.content;
                result = next;
            }
            return checkSyntax(content, kind);
        },
    };
}
