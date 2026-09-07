/**
 * artifact_update — nałóż strukturalny patch na instancję artefaktu (E2.9 A4).
 *
 * Ops przez ten sam walidator co silnik: set_field (frontmatter, klucze bazowe niezmienialne),
 * set_section / add_item (reject bloków kodu), check_item / uncheck_item / remove_item (po block-id).
 * Nieznaleziony block-id → `not_found` + świeży sparsowany stan artefaktu w odpowiedzi.
 */
import { t } from '../../../../core/i18n/index.js';
import { artifactStoreFromCtx, artifactTargetPath } from './ArtifactReadTool.js';
import type { ArtifactToolPlugin } from './ArtifactReadTool.js';

/** Argumenty `artifact_update` wg `inputSchema` (walidator opsów siedzi w silniku). */
interface ArtifactUpdateArgs {
    id?: string;
    ops?: unknown;
    [extra: string]: unknown;
}

export function createArtifactUpdateTool() {
    return {
        name: 'artifact_update',
        serverName: 'artifacts',
        description: t('mcp.artifact_update.desc'),
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: t('mcp.artifact_update.param.id') },
                ops: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            op: {
                                type: 'string',
                                enum: ['set_field', 'set_section', 'add_item', 'check_item', 'uncheck_item', 'remove_item'],
                            },
                            key: { type: 'string' },
                            value: {},
                            heading: { type: 'string' },
                            text: { type: 'string' },
                            blockId: { type: 'string' },
                        },
                        required: ['op'],
                    },
                    description: t('mcp.artifact_update.param.ops'),
                },
            },
            required: ['id', 'ops'],
        },
        // K2 (AUD-security-075/076): bramka dostaje ścieżkę NADPISYWANEJ notatki, nie pusty string.
        contextExtractor: (args: ArtifactUpdateArgs, ctx: { plugin?: unknown }) => ({
            targetPath: artifactTargetPath(artifactStoreFromCtx(ctx?.plugin), args?.id),
        }),
        execute: async (args: ArtifactUpdateArgs, _app: unknown, plugin: ArtifactToolPlugin | null | undefined) => {
            const store = plugin?.artifactStore;
            if (!store) return { isError: true, error: t('mcp.artifact.no_store') };
            const { id, ops } = args || {};
            if (!id || !Array.isArray(ops)) return { isError: true, error: t('mcp.artifact.missing_args') };

            const r = await store.update(id, ops);
            return { type: 'artifact_update', applied: r.applied, errors: r.errors, artifact: r.artifact };
        },
    };
}
