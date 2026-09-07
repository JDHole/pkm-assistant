/**
 * MCP tool for forgetting a Memory v3 note.
 *
 * brain.md is a generated index, so this tool never edits it directly. It searches active
 * brain/*.md notes, deletes exactly one matching non-project note, then refreshes the index.
 */
import { t } from '../../core/i18n/index.js';
import { log } from '../../core/utils/Logger.js';

/** Argumenty `memory_delete` wg `inputSchema`. */
interface MemoryDeleteArgs {
    fact?: unknown;
    _invocationAgentName?: unknown;
    [extra: string]: unknown;
}

/** Notatka `brain/` w zakresie, po którym szukamy dopasowania. */
interface BrainNoteLike {
    filename: string;
    name?: string;
    description?: string;
    type?: string;
}

/** Kandydat do skasowania: notatka + jej ścieżka na dysku. */
interface BrainNoteMatch {
    note: BrainNoteLike;
    path: string;
}

/**
 * Pamięć agenta w zakresie, jaki kasuje to narzędzie (pełny typ żyje w `modules/memory`).
 * Metody opcjonalne = wołane defensywnie (`?.`), jak w JS.
 */
interface AgentMemoryLike {
    agentName?: string;
    paths: { brainNotes: string };
    vault: { adapter: { remove?: (path: string) => Promise<void> } };
    listBrainNotes(): Promise<BrainNoteLike[]>;
    ensureMemoryStructure?(): Promise<unknown>;
    _enqueuePathWrite?<T>(path: string, fn: () => Promise<T>): Promise<T>;
    rebuildBrainIndex?(): Promise<unknown>;
    _appendAuditLog?(entries: Array<{ category: string; content: string }>): Promise<unknown>;
}

/** Minimalny widok AgentManagera. */
interface MemoryDeleteAgentManager {
    getActiveAgent?(): { name?: string } | null | undefined;
    getAgentMemory?(name: string): AgentMemoryLike | null | undefined;
    getActiveMemory?(): AgentMemoryLike | null | undefined;
}

/** Minimalny widok pluginu: tylko `agentManager`. */
export interface MemoryDeletePlugin {
    agentManager?: MemoryDeleteAgentManager | null;
}

function getInvocationMemory(
    args: MemoryDeleteArgs | undefined,
    agentManager: MemoryDeleteAgentManager | null | undefined,
): AgentMemoryLike | null | undefined {
    const agentName = (args?._invocationAgentName as string) || agentManager?.getActiveAgent?.()?.name || null;
    // K4 (AUD-security-036): FAIL-CLOSED. Nazwana tożsamość bez wpisu w `agentMemories`
    // (pad inicjalizacji pamięci, agent skasowany w trakcie biegu w tle) kończy się ODMOWĄ.
    // Do K4 stał tu `|| getActiveMemory()`, więc narzędzie po cichu pisało i czytało katalog
    // `brain/` agenta AKURAT wybranego w UI — a `_invocationAgentName` rozjeżdża się
    // z aktywnym przy każdym biegu suba w tle i w drugiej zakładce czatu.
    // Brak JAKIEJKOLWIEK tożsamości (ani znacznika, ani aktywnego agenta) = ścieżka jak dotąd.
    return agentName ? agentManager?.getAgentMemory?.(agentName) : agentManager?.getActiveMemory?.();
}

export function createMemoryDeleteTool() {
    return {
        name: 'memory_delete',
        description: t('mcp.memory_delete.desc'),
        inputSchema: {
            type: 'object',
            properties: {
                fact: {
                    type: 'string',
                    description: t('mcp.memory_delete.param.fact')
                }
            },
            required: ['fact']
        },
        execute: async (args: MemoryDeleteArgs, _app: unknown, plugin: MemoryDeletePlugin | null | undefined) => {
            try {
                const agentManager = plugin?.agentManager;
                const agentMemory = getInvocationMemory(args, agentManager);
                if (!agentMemory) {
                    return { success: false, error: t('mcp.memory_delete.no_agent') };
                }

                // Validate
                let fact = args.fact as string;
                if (typeof fact !== 'string') {
                    try { fact = String(fact); } catch { return { success: false, error: 'fact must be a string' }; }
                }
                fact = fact.trim();
                if (!fact) {
                    return { success: false, error: t('mcp.memory_delete.empty_fact') };
                }

                await agentMemory.ensureMemoryStructure?.();
                const matches = await findMatchingNotes(agentMemory, fact);
                if (matches.length === 0) {
                    return {
                        success: false,
                        code: 'note_not_found',
                        error: t('mcp.memory_delete.not_found', { fact }) || `No matching memory note found for: ${fact}`
                    };
                }
                if (matches.length > 1) {
                    return {
                        success: false,
                        code: 'ambiguous_match',
                        matches: matches.map(m => m.note.filename),
                        error: t('mcp.memory_delete.ambiguous') || 'More than one memory note matches. Read the note first and delete a more specific fact.'
                    };
                }

                const match = matches[0];
                if (match.note.type === 'project_context') {
                    return {
                        success: false,
                        code: 'project_archive_required',
                        filename: match.note.filename,
                        error: t('mcp.memory_delete.project_archive_required') || 'Project context notes must go through archive review so lessons can be extracted first.'
                    };
                }

                if (!agentMemory.vault.adapter.remove) {
                    return { success: false, code: 'delete_unavailable', error: 'Vault adapter cannot delete files.' };
                }

                // E2.7 K1: serialize the delete against the note path (consistent with the
                // create/rebuild queue) so a concurrent writer can't race the removal.
                const enqueue: <T>(path: string, fn: () => Promise<T>) => Promise<T> = agentMemory._enqueuePathWrite
                    ? agentMemory._enqueuePathWrite.bind(agentMemory)
                    : (_p, fn) => fn();
                await enqueue(match.path, async () => {
                    await agentMemory.vault.adapter.remove!(match.path);
                });
                // AUD-bledy-029: PLIKU JUŻ NIE MA. Przebudowa indeksu to osobny krok i osobny
                // `try` — od K4 (gotcha 9 w `modules/memory/CLAUDE.md`) `rebuildBrainIndex` jest
                // fail-closed i RZUCA przy niepewnym odczycie brain.md. Dopóki siedziała w tym
                // samym `try` co kasacja, jej pad meldował `{success:false}` o notatce, której
                // już nie ma: model ponawiał `memory_delete` i dostawał `note_not_found`.
                // Meldunek ma opisywać STAN: skasowane naprawdę, indeks jeszcze o tym nie wie.
                let indexStale = false;
                try {
                    await agentMemory.rebuildBrainIndex?.();
                } catch (indexError) {
                    indexStale = true;
                    log.error('MemoryDeleteTool', `Notatka ${match.note.filename} skasowana, ale przebudowa brain.md padła:`, indexError);
                }
                await agentMemory._appendAuditLog?.([{
                    category: 'MEMORY_DELETE_NOTE',
                    content: `${match.note.filename}: ${fact}`
                }]);

                return {
                    success: true,
                    fact,
                    filename: match.note.filename,
                    path: match.path,
                    agent: agentMemory.agentName,
                    ...(indexStale ? { index_stale: true, warning: t('mcp.memory_delete.index_stale') } : {}),
                    message: t('mcp.memory_delete.deleted', { fact })
                };

            } catch (error) {
                log.error('MemoryDeleteTool', 'Error:', error);
                return { success: false, error: (error as Error).message };
            }
        }
    };
}

async function findMatchingNotes(agentMemory: AgentMemoryLike, fact: string): Promise<BrainNoteMatch[]> {
    const needle = fact.toLowerCase();
    const notes = await agentMemory.listBrainNotes();
    const matches: BrainNoteMatch[] = [];

    // E1.1 (ryzyko B): match only on note identity — filename, name, description — never the full
    // body. Substring-matching the whole body risked deleting the wrong note when the phrase
    // happened to appear inside an unrelated note's text.
    for (const note of notes) {
        const path = `${agentMemory.paths.brainNotes}/${note.filename}`;
        const haystack = [
            note.filename,
            note.name,
            note.description
        ].join('\n').toLowerCase();
        if (haystack.includes(needle)) {
            matches.push({ note, path });
        }
    }

    return matches;
}
