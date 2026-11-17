import { scanMarkdownFences } from './syntaxValidator.js';
import { t } from '../../core/i18n/index.js';
import { createAppExecutor } from '../obsidian-app/index.js';
import type { AppExecutorOptions, AppResult, CapturePort, WorkspacePort } from '../obsidian-app/index.js';
import type { BuiltinToolExecutionContext } from './ToolRegistry.js';

// Preserve line numbers and fence bodies; comment markers inside a fenced block are code.
function stripSourceComments(source: string): string {
    let comment: '-->' | '%%' | null = null;
    let fence: { char: string; length: number } | null = null;
    return source.split('\n').map(line => {
        if (fence) {
            const close = /^(?: {0,3}> ?)*(?: {0,3}(?:[-+*]|\d+[.)]) +| *)(?:> ?)* *(`{3,}|~{3,})\s*$/.exec(line);
            if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
            return line;
        }
        const rawOpening = !comment && /^( {0,3}(?:> ?)*(?: {0,3}(?:[-+*]|\d+[.)]) +| *)(?:> ?)* *)(`{3,}|~{3,})/.exec(line);
        if (rawOpening) { fence = { char: rawOpening[2][0], length: rawOpening[2].length }; return line; }
        let output = '';
        for (let i = 0; i < line.length;) {
            if (comment) {
                if (line.startsWith(comment, i)) { output += ' '.repeat(comment.length); i += comment.length; comment = null; }
                else { output += ' '; i++; }
            } else if (line.startsWith('<!--', i) || line.startsWith('%%', i)) {
                const marker = line.startsWith('<!--', i) ? '<!--' : '%%';
                comment = marker === '<!--' ? '-->' : '%%'; output += ' '.repeat(marker.length); i += marker.length;
            } else { output += line[i]; i++; }
        }
        const opening = /^( {0,3}(?:> ?)*(?: {0,3}(?:[-+*]|\d+[.)]) +| *)(?:> ?)* *)(`{3,}|~{3,})/.exec(output);
        if (opening) fence = { char: opening[2][0], length: opening[2].length };
        return output;
    }).join('\n');
}

export function createObsidianAppTool(port: WorkspacePort, capture: CapturePort | null = null, options: AppExecutorOptions & { isMobile?: boolean } = {}) {
    const screenshotEnabled = options.screenshot === 'enabled';
    const renderCheckEnabled = options.renderCheck === 'enabled';
    const execute = createAppExecutor(port, undefined, capture, { screenshot: screenshotEnabled ? 'enabled' : 'disabled', renderCheck: options.renderCheck, countSourceBlocks: source => {
        const result: { dataview: number[]; dataviewjs: number[] } = { dataview: [], dataviewjs: [] };
        const uncommented = stripSourceComments(source);
        for (const block of scanMarkdownFences(uncommented)) if (block.language === 'dataview' || block.language === 'dataviewjs') result[block.language].push(block.line);
        return result;
    } });
    return {
        name: 'obsidian_app', source: 'built-in', serverName: 'app',
        description: t('mcp.obsidian_app.desc') + (screenshotEnabled ? ' ' + t('mcp.obsidian_app.screenshot_desc') : '') + (renderCheckEnabled ? ' ' + t('mcp.obsidian_app.render_check_desc') : ''),
        screenshotEnabled: screenshotEnabled,
        renderCheckEnabled,
        isMobile: options.isMobile === true,
        inputSchema: { type: 'object', properties: { action: { type: 'string', description: t('mcp.obsidian_app.action_desc') + (renderCheckEnabled ? ' ' + t('mcp.obsidian_app.render_check_desc') : ''), enum: ['state', 'open', ...(renderCheckEnabled ? ['render_check'] : []), ...(screenshotEnabled ? ['screenshot'] : [])] }, path: { type: 'string', description: t('mcp.obsidian_app.path_desc') }, new_tab: { type: 'boolean' }, ...(renderCheckEnabled ? { wait_ms: { type: 'integer', description: t('mcp.obsidian_app.wait_desc'), minimum: 1, maximum: 15000, default: 4000 } } : {}) }, required: ['action'] },
        contextExtractor: (args: Record<string, unknown>) => ({ targetPath: args.action === 'screenshot' ? 'app:screenshot' : (args.action === 'open' || args.action === 'render_check') && typeof args.path === 'string' ? args.path : '' }),
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
