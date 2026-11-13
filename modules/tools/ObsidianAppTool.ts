import { t } from '../../core/i18n/index.js';
import { createAppExecutor } from '../obsidian-app/index.js';
import type { AppExecutorOptions, AppResult, CapturePort, WorkspacePort } from '../obsidian-app/index.js';
import type { BuiltinToolExecutionContext } from './ToolRegistry.js';

export function createObsidianAppTool(port: WorkspacePort, capture: CapturePort | null = null, options: AppExecutorOptions & { isMobile?: boolean } = {}) {
    const screenshotEnabled = options.screenshot === 'enabled';
    const execute = createAppExecutor(port, undefined, capture, { screenshot: screenshotEnabled ? 'enabled' : 'disabled' });
    return {
        name: 'obsidian_app', source: 'built-in', serverName: 'app',
        description: t('mcp.obsidian_app.desc') + (screenshotEnabled ? ' ' + t('mcp.obsidian_app.screenshot_desc') : ''),
        screenshotEnabled: screenshotEnabled,
        isMobile: options.isMobile === true,
        inputSchema: { type: 'object', properties: { action: { type: 'string', enum: screenshotEnabled ? ['state', 'open', 'screenshot'] : ['state', 'open'] }, path: { type: 'string' }, new_tab: { type: 'boolean' } }, required: ['action'] },
        contextExtractor: (args: Record<string, unknown>) => ({ targetPath: args.action === 'screenshot' ? 'app:screenshot' : args.action === 'open' && typeof args.path === 'string' ? args.path : '' }),
        execute: (args: Record<string, unknown>, _app?: unknown, _plugin?: unknown, context?: BuiltinToolExecutionContext) => {
            const result = execute(args, context);
            return options.isMobile ? result.then(value => !value.ok && value.error.code === 'screenshot_disabled'
                ? disabledScreenshotResult(true) : value) : result;
        },
    };
}

/** Shared refusal before approvals or host access; desktop keeps its existing result. */
export function disabledScreenshotResult(isMobile: boolean): AppResult {
    return { ok: false, success: false, error: { code: 'screenshot_disabled',
        message: isMobile ? t('mcp.obsidian_app.screenshot_mobile') : 'screenshot_disabled' } };
}
