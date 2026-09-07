/**
 * artifact_create — utwórz instancję artefaktu żywego (gatunek 1) jako notatkę vaulta (E2.9 A4).
 *
 * Silnik (ArtifactStore) buduje frontmatter z deklaracji pól typu + body z szablonu. Model NIE
 * podaje ścieżki (buduje ją silnik) i NIE pisze bloków kodu (walidator patchy odrzuca `sekcje`
 * z code-fence). Wynik = chudy JSON instancji.
 */
import { t } from '../../../../core/i18n/index.js';
import { artifactStoreFromCtx } from './ArtifactReadTool.js';
import type { ArtifactToolPlugin } from './ArtifactReadTool.js';

/** Argumenty `artifact_create` wg `inputSchema`. */
interface ArtifactCreateArgs {
    typ?: string;
    tytul?: string;
    pola?: unknown;
    sekcje?: unknown;
    _invocationAgentName?: unknown;
    [extra: string]: unknown;
}

export function createArtifactCreateTool() {
    return {
        name: 'artifact_create',
        serverName: 'artifacts',
        description: t('mcp.artifact_create.desc'),
        inputSchema: {
            type: 'object',
            properties: {
                typ: { type: 'string', description: t('mcp.artifact_create.param.typ') },
                tytul: { type: 'string', description: t('mcp.artifact_create.param.tytul') },
                pola: { type: 'object', description: t('mcp.artifact_create.param.pola') },
                sekcje: {
                    type: 'array',
                    items: { type: 'object' },
                    description: t('mcp.artifact_create.param.sekcje'),
                },
            },
            required: ['typ', 'tytul'],
        },
        // K2 (AUD-security-075): bramka dostaje ścieżkę, pod którą notatka POWSTANIE — policzoną
        // tym samym silnikiem, który zaraz ją utworzy. Wcześniej szedł tu pusty string, więc
        // `artifact_create` pisał do vaulta z pominięciem whitelisty, No-Go i zakresu suba.
        // K21 (AUD-security-121): tożsamość WYŁĄCZNIE z runtime'u (`ctx.agentName`). Od niej
        // zależy folder, który ocenia AccessGuard, a `args._invocationAgentName` bramka widziała
        // w kształcie podanym przez MODEL (worek szedł tu sprzed nadpisania — patrz K21 w
        // `MCPClient.executeToolCall`). Po naprawie oba źródła niosą tę samą wartość, więc worek
        // przestaje być tu potrzebny — i nie ma jak wrócić jako źródło prawdy.
        contextExtractor: (args: ArtifactCreateArgs, ctx: { agentName?: string | null; plugin?: unknown }) => {
            const store = artifactStoreFromCtx(ctx?.plugin);
            const agentName = ctx?.agentName || 'agent';
            const tytul = typeof args?.tytul === 'string' ? args.tytul : '';
            return { targetPath: store?.instancePathFor?.(agentName, tytul) || '' };
        },
        execute: async (args: ArtifactCreateArgs, _app: unknown, plugin: ArtifactToolPlugin | null | undefined) => {
            const store = plugin?.artifactStore;
            if (!store) return { isError: true, error: t('mcp.artifact.no_store') };
            const { typ, tytul, pola, sekcje } = args || {};
            if (!typ || !tytul) return { isError: true, error: t('mcp.artifact.missing_args') };

            // `execute` dostaje worek JUŻ nadpisany przez `MCPClient`, więc znacznik jest tu
            // zaufany (inaczej niż w `contextExtractor` przed K21 — patrz komentarz wyżej).
            const agentName = (args?._invocationAgentName as string) || plugin.agentManager?.getActiveAgent?.()?.name || 'agent';

            // S32 Z5 — egzekwowanie typów per agent. `artifact_types` sterowało dotąd TYLKO
            // widocznością w indeksie promptu; model mógł podać dowolny typ z biblioteki.
            // Lista jest OPT-IN: pusta/nieustawiona = wszystkie typy (zero zmian dla obecnych
            // profili). Agent nieznaleziony w managerze = przepuszczamy (nie ma czego egzekwować).
            const agentObj = plugin.agentManager?.getAgent?.(agentName);
            const allowedTypes = agentObj?.artifact_types;
            if (Array.isArray(allowedTypes) && allowedTypes.length > 0 && !allowedTypes.includes(typ)) {
                return {
                    isError: true,
                    error: t('mcp.artifact.type_not_allowed', { typ, allowed: allowedTypes.join(', ') }),
                };
            }

            try {
                const res = await store.create(typ, {
                    tytul,
                    pola: pola && typeof pola === 'object' ? pola as Record<string, unknown> : {},
                    sekcje: Array.isArray(sekcje) ? sekcje : [],
                    agent: agentName,
                });
                // K10 (AUD-security-061): store odmówił JESZCZE PRZED zapisem (wartość pola nie
                // przeszła bramki treści) — nie ma id, nie ma pliku. Model dostaje ten sam kod
                // błędu co przy patchu, żeby mógł poprawić treść, a nie zgadywać.
                if (!res.created) {
                    return { isError: true, error: res.errors[0]?.message || t('mcp.artifact.missing_args'), errors: res.errors };
                }
                // `applied`/`errors` z początkowych `sekcje` MUSZĄ dojść do modelu (wzór
                // artifact_update) — inaczej nietrafiony `heading` znika bez śladu, a model
                // jest przekonany, że artefakt ma treść.
                return { type: 'artifact', ok: true, id: res.id, path: res.path, applied: res.applied, errors: res.errors, ...res.artifact };
            } catch (e) {
                return { isError: true, error: (e as Error).message };
            }
        },
    };
}
