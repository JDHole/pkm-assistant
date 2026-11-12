import { t } from '../../core/i18n/index.js';
import { createAppExecutor } from '../obsidian-app/index.js';
import type { AppExecutorOptions, CapturePort, WorkspacePort } from '../obsidian-app/index.js';
import type { BuiltinToolExecutionContext } from './ToolRegistry.js';

export function createObsidianAppTool(port: WorkspacePort, capture: CapturePort | null = null, options: AppExecutorOptions = {}) {
    const screenshotEnabled = options.screenshot === 'enabled';
    const execute = createAppExecutor(port, undefined, capture, { screenshot: screenshotEnabled ? 'enabled' : 'disabled' });
    return {
        name: 'obsidian_app', source: 'built-in', serverName: 'app',
        description: t('mcp.obsidian_app.desc') + (screenshotEnabled ? ' ' + t('mcp.obsidian_app.screenshot_desc') : ''),
        screenshotEnabled: screenshotEnabled,
        inputSchema: { type: 'object', properties: { action: { type: 'string', enum: screenshotEnabled ? ['state', 'open', 'screenshot'] : ['state', 'open'] }, path: { type: 'string' }, new_tab: { type: 'boolean' } }, required: ['action'] },
        contextExtractor: (args: Record<string, unknown>) => ({ targetPath: args.action === 'screenshot' ? 'app:screenshot' : args.action === 'open' && typeof args.path === 'string' ? args.path : '' }),
        execute: (args: Record<string, unknown>, _app?: unknown, _plugin?: unknown, context?: BuiltinToolExecutionContext) => execute(args, context),
    };
}
