/**
 * artifact_read — odczytaj instancję artefaktu żywego jako chudy JSON (E2.9 A4).
 * Teksty sekcji przycięte do ARTIFACT_CONTEXT_MAX_CHARS (przycinanie w store).
 */
import { t } from '../../../../core/i18n/index.js';

/**
 * `ArtifactStore` (`modules/artifacts`) w zakresie, jakiego używa rodzina `artifact_*`.
 * Moduł jest jeszcze w JS, więc kontrakt spisany tu, u konsumenta, i tylko w używanym zakresie.
 */
interface ArtifactStoreLike {
    // K10 (AUD-security-061): `created:false` = store odmówił PRZED zapisem (wartość pola nie
    // przeszła bramki treści) — wtedy `id`/`path` są puste, a `errors` niesie kod odmowy.
    create(typ: string, input: { tytul: string; pola: Record<string, unknown>; sekcje: unknown[]; agent: string }):
        Promise<{ created: boolean; id: string; path: string; applied: number; errors: Array<{ op?: unknown; code: string; message: string }>; artifact: Record<string, unknown> | null }>;
    read(id: string): Promise<Record<string, unknown> | null | undefined>;
    update(id: string, ops: unknown[]):
        Promise<{ applied: unknown; errors: unknown; artifact: unknown }>;
    list(filter: { agent: string | null; typ?: string; status?: string }): unknown[];
    /** K2: SYNCHRONICZNA ścieżka artefaktu po id (tylko folder artefaktów) — dla bramki uprawnień. */
    pathById?(id: string): string | null;
    /** K2: ścieżka, pod którą powstanie nowa instancja — dla bramki uprawnień przy `create`. */
    instancePathFor?(agent: string, tytul: string): string | null;
    /** K2: folder artefaktów — cel akcji, która nie dotyczy jednego pliku (`artifact_list`). */
    artifactsRoot?(): string;
}

/**
 * K2 (AUD-security-075): wspólny wyciąg celu dla rodziny `artifact_*`.
 *
 * Narzędzia artefaktów nie przyjmują ścieżek od modelu (buduje je silnik), więc do bramki
 * uprawnień szedł PUSTY `targetPath` — a pusty cel przeskakiwał No-Go, pliki chronione,
 * whitelistę `focusFolders` i `scope.folders` suba. Tu liczymy ścieżkę PRAWDZIWĄ, tym samym
 * silnikiem, który zaraz wykona operację. Nie da się jej policzyć = pusty cel = odmowa
 * fail-closed po stronie `PermissionSystem` (`TARGET_REQUIRED_ACTIONS`).
 */
export function artifactTargetPath(
    store: ArtifactStoreLike | null | undefined,
    id: unknown,
): string {
    if (!store || typeof store.pathById !== 'function') return '';
    if (!id || typeof id !== 'string') return '';
    return store.pathById(id) || '';
}

/** Plugin widziany przez `contextExtractor` — ten sam obiekt, tylko inne drzwi niż `execute`. */
export function artifactStoreFromCtx(plugin: unknown): ArtifactStoreLike | null {
    // Rzutowanie świadome: `contextExtractor` dostaje `MCPClientPlugin` (minimalny widok klienta),
    // a w runtime to ten sam plugin, który niesie `artifactStore`.
    return (plugin as ArtifactToolPlugin | null | undefined)?.artifactStore || null;
}

/** Agent w zakresie, jaki czyta rodzina `artifact_*` (S32 Z5: biblioteka dozwolonych typów). */
export interface ArtifactToolAgent {
    name?: string;
    artifact_types?: unknown;
}

/** Minimalny widok pluginu dla rodziny `artifact_*`. */
export interface ArtifactToolPlugin {
    artifactStore?: ArtifactStoreLike | null;
    agentManager?: {
        getActiveAgent?(): ArtifactToolAgent | null | undefined;
        getAgent?(name: string): ArtifactToolAgent | null | undefined;
    } | null;
}

/** Argumenty `artifact_read` wg `inputSchema`. */
interface ArtifactReadArgs {
    id?: string;
    [extra: string]: unknown;
}

export function createArtifactReadTool() {
    return {
        name: 'artifact_read',
        serverName: 'artifacts',
        description: t('mcp.artifact_read.desc'),
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: t('mcp.artifact_read.param.id') },
            },
            required: ['id'],
        },
        // K2 (AUD-security-075/076): bramka dostaje ścieżkę CZYTANEJ notatki, nie pusty string.
        contextExtractor: (args: ArtifactReadArgs, ctx: { plugin?: unknown }) => ({
            targetPath: artifactTargetPath(artifactStoreFromCtx(ctx?.plugin), args?.id),
        }),
        execute: async (args: ArtifactReadArgs, _app: unknown, plugin: ArtifactToolPlugin | null | undefined) => {
            const store = plugin?.artifactStore;
            if (!store) return { isError: true, error: t('mcp.artifact.no_store') };
            const id = args?.id;
            if (!id) return { isError: true, error: t('mcp.artifact.missing_args') };

            const thin = await store.read(id);
            if (!thin) return { isError: true, error: t('mcp.artifact.not_found', { id }) };
            return { type: 'artifact', ...thin };
        },
    };
}
