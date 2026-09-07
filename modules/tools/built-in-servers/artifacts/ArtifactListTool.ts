/**
 * artifact_list — wylistuj artefakty żywe (domyślnie bieżącego agenta) (E2.9 A4).
 * Śledzenie po frontmatterze (`pkm-artefakt`), nie po ścieżce — działa też po przeniesieniu notatki.
 */
import { t } from '../../../../core/i18n/index.js';
import { artifactStoreFromCtx } from './ArtifactReadTool.js';
import type { ArtifactToolPlugin } from './ArtifactReadTool.js';

/** Argumenty `artifact_list` wg `inputSchema`. */
interface ArtifactListArgs {
    typ?: string;
    status?: string;
    _invocationAgentName?: unknown;
    [extra: string]: unknown;
}

export function createArtifactListTool() {
    return {
        name: 'artifact_list',
        serverName: 'artifacts',
        description: t('mcp.artifact_list.desc'),
        inputSchema: {
            type: 'object',
            properties: {
                typ: { type: 'string', description: t('mcp.artifact_list.param.typ') },
                status: { type: 'string', description: t('mcp.artifact_list.param.status') },
            },
        },
        // K2 (AUD-security-075): listowanie nie dotyczy JEDNEGO pliku, więc celem jest folder
        // artefaktów — agent, który nie ma prawa go czytać, nie dostaje też spisu. Same WYNIKI
        // tnie dodatkowo `AccessGuard.filterResults` w kroku 7 `MCPClient` (wzór `list`/`search`).
        contextExtractor: (_args: ArtifactListArgs, ctx: { plugin?: unknown }) => ({
            targetPath: artifactStoreFromCtx(ctx?.plugin)?.artifactsRoot?.() || '',
        }),
        execute: async (args: ArtifactListArgs, _app: unknown, plugin: ArtifactToolPlugin | null | undefined) => {
            const store = plugin?.artifactStore;
            if (!store) return { isError: true, error: t('mcp.artifact.no_store') };
            const agent = (args?._invocationAgentName as string) || plugin.agentManager?.getActiveAgent?.()?.name || null;
            const artifacts = store.list({ agent, typ: args?.typ, status: args?.status });
            return { type: 'artifact_list', count: artifacts.length, artifacts };
        },
    };
}
