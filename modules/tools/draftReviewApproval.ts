import { t } from '../../core/i18n/index.js';
import type { PermissionedAgent } from '../../core/index.js';
import { SessionWriteConsent, sanitizePath } from '../../core/index.js';
import type { Change, DraftPreview, DraftReviewContext } from '../vault-drafts/index.js';
import type { MCPClientPlugin, MCPToolRegistryLike, DiffApprovalOptions, ExecuteToolCallOptions } from './MCPClient.js';

/** Maps the actual vault effect, independently from the generator/artifact source tool. */
function effect(change: Change) {
    return change.proposed.kind === 'deleted' ? { action: 'vault.delete', tool: 'delete', mode: 'delete' }
        : change.proposed.kind === 'folder' ? { action: 'vault.create_folder', tool: 'create_folder', mode: 'create' }
        : { action: 'vault.write', tool: 'write', mode: change.base.kind === 'missing' ? 'create' : 'replace' };
}
export function draftReviewContext(input: {
    plugin: MCPClientPlugin; registry: MCPToolRegistryLike; agentName: string; autonomy: string;
    opts: ExecuteToolCallOptions; consent: SessionWriteConsent;
    requestDiff(options: DiffApprovalOptions): Promise<{ result: unknown; rememberForSession?: boolean }>;
    isDenied(tool: string, path: string): boolean;
    recordDenial(tool: string, path: string): void;
}): DraftReviewContext | undefined {
    const { plugin, registry, opts, agentName, autonomy, consent } = input;
    const origin = opts.origin;
    if (opts.subRunContext || Number(opts.delegationDepth) > 0 || opts.vaultExecution && opts.vaultExecution.kind !== 'live'
        || !origin || origin.agentName !== agentName || !origin.sessionPath || !origin.sessionEpoch
        || !/^[0-9a-f]{32}$/.test(origin.sessionEpoch)) return undefined;
    const currentAgent = (): PermissionedAgent | null | undefined => plugin.agentManager?.getAgent(agentName);
    const alive = () => !opts.shouldAbort?.() && !opts.abortSignal?.aborted;
    return {
        kind: 'main', owner: { agentName, sessionPath: origin.sessionPath, sessionEpoch: origin.sessionEpoch },
        authorize(path, operation, change) {
            const agent = currentAgent();
            if (!agent || !alive() || sanitizePath(path) !== path || !registry.checkToolAxis?.(agent, 'subagent_changes').allowed) return false;
            if (operation !== 'read' && (!registry.checkToolAxis(agent, change.source.tool).allowed
                || !registry.checkToolAxis(agent, effect(change).tool).allowed)) return false;
            if (operation === 'folder' && !registry.checkToolAxis(agent, 'create_folder').allowed) return false;
            const action = operation === 'read' ? 'vault.read' : operation === 'folder' ? 'vault.create_folder' : effect(change).action;
            return plugin.permissionSystem.checkPermission(agent, action, path, { autonomy, scopeFolders: opts.scopeFolders }).allowed;
        },
        async approve(change: Change, preview: DraftPreview) {
            const agent = currentAgent();
            if (!agent || !alive()) return false;
            const target = effect(change);
            const rememberAvailable = change.source.tool === 'write' && preview.kind === 'text';
            if (rememberAvailable && consent.has(origin.sessionPath, change.path)) return true;
            // Same policy as MCP's regular writer. The effect, not the review tool, controls risk.
            const required = plugin.permissionSystem.requiresApproval(target.action, change.path, target.tool, agent,
                autonomy, { operationMode: target.mode, isExternalTool: false });
            if (!required) return true;
            if (input.isDenied(target.tool, change.path)) return false;
            const approval = await plugin.approvalManager.requestApproval({ type: target.action,
                toolName: target.tool, targetPath: change.path, agentName, operationMode: target.mode,
                description: t('mcp.subagent_changes.desc'), rememberAvailable,
                contentPreview: preview.kind === 'text' ? preview.newContent : null,
                signal: opts.abortSignal,
            });
            if (!['approve', 'always'].includes(approval.result) || !alive()) {
                if (approval.result === 'deny' && alive()) input.recordDenial(target.tool, change.path);
                return false;
            }
            if (rememberAvailable && approval.rememberForSession) {
                consent.grant(origin.sessionPath, change.path);
                return true;
            }
            const result = await input.requestDiff({ path: change.path, agentName,
                oldContent: 'oldContent' in preview ? preview.oldContent : '',
                newContent: 'newContent' in preview ? preview.newContent : '',
                preview, rememberAvailable, signal: opts.abortSignal });
            if (result.result !== 'approve' || !alive()) {
                if (result.result === 'deny' && alive()) input.recordDenial(target.tool, change.path);
                return false;
            }
            if (rememberAvailable && result.rememberForSession) consent.grant(origin.sessionPath, change.path);
            return true;
        },
    };
}
