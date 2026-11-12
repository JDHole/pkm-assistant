import { t } from '../../core/i18n/index.js';
import { createAppExecutor } from '../obsidian-app/index.js';
import type { WorkspacePort } from '../obsidian-app/index.js';
import type { BuiltinToolExecutionContext } from './ToolRegistry.js';

export function createObsidianAppTool(port: WorkspacePort) {
    const execute = createAppExecutor(port);
    return {
        name: 'obsidian_app', source: 'built-in', serverName: 'app',
        description: t('mcp.obsidian_app.desc'),
        inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['state', 'open'] }, path: { type: 'string' }, new_tab: { type: 'boolean' } }, required: ['action'] },
        contextExtractor: (args: Record<string, unknown>) => ({ targetPath: args.action === 'open' && typeof args.path === 'string' ? args.path : '' }),
        execute: (args: Record<string, unknown>, _app?: unknown, _plugin?: unknown, context?: BuiltinToolExecutionContext) => execute(args, context),
    };
}
