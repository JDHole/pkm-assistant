import { t } from '../../core/i18n/index.js';
import { createAppExecutor } from '../obsidian-app/index.js';
import type { CapturePort, WorkspacePort } from '../obsidian-app/index.js';
import type { BuiltinToolExecutionContext } from './ToolRegistry.js';

export function createObsidianAppTool(port: WorkspacePort, capture: CapturePort | null = null) {
    const execute = createAppExecutor(port, undefined, capture);
    return {
        name: 'obsidian_app', source: 'built-in', serverName: 'app',
        description: t('mcp.obsidian_app.desc'),
        inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['state', 'open', 'screenshot'] }, path: { type: 'string' }, new_tab: { type: 'boolean' } }, required: ['action'] },
        contextExtractor: (args: Record<string, unknown>) => ({ targetPath: args.action === 'screenshot' ? 'app:screenshot' : args.action === 'open' && typeof args.path === 'string' ? args.path : '' }),
        execute: (args: Record<string, unknown>, _app?: unknown, _plugin?: unknown, context?: BuiltinToolExecutionContext) => execute(args, context),
    };
}
