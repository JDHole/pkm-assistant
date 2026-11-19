import type { ArtifactStore } from '../artifacts/index.js';
import { DraftError, parseVaultPath } from '../vault-drafts/index.js';
import type { DraftView } from '../vault-drafts/index.js';
import { createDraftToolHost, bindDraftSearchPlugin } from './draftToolHost.js';
import { resolveSearchScope } from './SearchTool.js';
import type { SearchToolPlugin } from './SearchTool.js';
import { isDraftToolAllowed } from './ToolRegistry.js';

export type VaultExecution =
    | { kind: 'live' }
    | { kind: 'overlay-read'; view: DraftView }
    | { kind: 'overlay-write'; workspace: DraftView };
export type HostPlugin = SearchToolPlugin & { artifactStore?: ArtifactStore; permissionSystem?: unknown };
function property<P, K extends keyof P>(object: P, key: K): P[K] { return object[key]; }
const contentTools = new Set(['read', 'view_image', 'check_syntax', 'list', 'search', 'write', 'delete', 'create_folder', 'artifact_create', 'artifact_update', 'artifact_read', 'artifact_list', 'generate_image', 'add_text_to_image']);
const liveTools = new Set(['memory_save', 'memory_delete', 'todo', 'kom_send', 'kom_read', 'kom_list', 'ask_user', 'delegate', 'sub_agent', 'agent_delegate', 'web_search', 'web_read']);
const writers = new Set(['move', 'write', 'delete', 'create_folder', 'artifact_create', 'artifact_update', 'generate_image', 'add_text_to_image']);
export function isVaultContentWriter(name: string): boolean { return writers.has(name); }
/** Called AFTER canonical registry identity/whitelist, BEFORE contextExtractor and permissions.
 * Return the SAME host to extractor and execute. Used by MCP/runner when drafts are injected; production activation belongs to P5.
 * The execution mode and source must come from trusted runtime, never model arguments.
 */
export async function prepareSubToolExecution<A, P extends HostPlugin>(input: {
    execution: VaultExecution; tool: { name: string; source: 'built-in' | 'user' };
    args: Record<string, unknown>; callId: string; app: A; plugin: P;
}) {
    const { execution, tool, args, app, plugin } = input;
    if (execution.kind === 'live') return { kind: 'live' as const, app, plugin };
    if (!isDraftToolAllowed(tool)) throw new DraftError('mutation-denied', 'External tools are unavailable in a draft');
    const memory = tool.name === 'search' ? resolveSearchScope(args, plugin).scope === 'memory'
        : (tool.name === 'read' || tool.name === 'list') && args.scope === 'memory';
    if (memory || liveTools.has(tool.name)) return { kind: 'live' as const, app, plugin };
    if (!contentTools.has(tool.name)) throw new DraftError('mutation-denied', 'Unsupported draft tool');
    const view = execution.kind === 'overlay-read' ? execution.view : execution.workspace;
    const metadataFolder = tool.name.startsWith('artifact_') ? plugin.artifactStore?.artifactsRoot() : undefined;
    const host = await createDraftToolHost(view, {
        requestedPaths: [args.path, args.folder, args.image_path, args.output_path].filter((path): path is string => typeof path === 'string'),
        metadataFolder,
        writable: execution.kind === 'overlay-write', source: { tool: tool.name, callId: input.callId },
        ...(tool.name === 'create_folder' ? { explicitFolderPath: parseVaultPath(args.path) } : {}),
    });
    // Only the services used by content tools are exposed; no original app or write methods.
    // ArtifactStore asks for all Markdown files before filtering its own root. Supply that
    // subtree directly, while the tool host keeps the full synchronous Vault API contract.
    const artifactHost = metadataFolder && view.index ? { ...host, vault: { ...host.vault, getMarkdownFiles: () => {
        type Entry = NonNullable<ReturnType<typeof host.vault.getAbstractFileByPath>>;
        const walk = (entry: Entry): Entry[] => 'children' in entry ? (entry.children ?? []).flatMap(walk)
            : entry.extension === 'md' ? [entry] : [];
        const root = host.vault.getAbstractFileByPath(metadataFolder);
        return root ? walk(root) : [];
    } } } : host;
    const localPlugin = Object.freeze({ app: host, artifactStore: plugin.artifactStore?.forHost(artifactHost),
        env: property(plugin, 'env'), oramaDb: property(plugin, 'oramaDb'), agentManager: property(plugin, 'agentManager'),
        permissionSystem: property(plugin, 'permissionSystem'),
    });
    bindDraftSearchPlugin(localPlugin, plugin);
    return { kind: 'overlay' as const, app: host, plugin: localPlugin };
}
