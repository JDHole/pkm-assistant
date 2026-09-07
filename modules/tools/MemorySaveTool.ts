/**
 * Memory v3 create-only save tool.
 *
 * The tool never overwrites an existing brain/ note. After writing, it refreshes brain.md as
 * a categorized index of brain/ note pointers.
 */
import { t } from '../../core/i18n/index.js';
import {
    MEMORY_V3_ERROR_CODES,
    isValidNoteType,
    makeMemoryNoteFilename,
    naTerazSectionKey
} from '../memory/index.js';
import { log } from '../../core/utils/Logger.js';

/** Argumenty `memory_save` wg `inputSchema` (`fact` = legacy jednopolowe wywołanie). */
interface MemorySaveArgs {
    name?: unknown;
    description?: unknown;
    type?: unknown;
    content?: unknown;
    why?: unknown;
    how_to_apply?: unknown;
    howToApply?: unknown;
    fact?: unknown;
    ephemeral?: unknown;
    section?: string;
    remove?: unknown;
    _invocationAgentName?: unknown;
    [extra: string]: unknown;
}

/** Notatka `brain/` po normalizacji argumentów — wszystkie pola już stringami. */
interface NormalizedNote {
    name: string;
    description: string;
    type: string;
    content: string;
    why: string;
    how_to_apply: string;
}

/**
 * Pamięć agenta w zakresie, jaki zapisuje to narzędzie (pełny typ żyje w `modules/memory`).
 * Metody opcjonalne = wołane defensywnie (`?.`), jak w JS.
 */
interface AgentMemoryLike {
    agentName?: string;
    paths: { brainNotes: string };
    vault: { adapter: { exists(path: string): Promise<boolean>; write(path: string, data: string): Promise<void> } };
    ensureMemoryStructure?(): Promise<unknown>;
    writeNaTeraz?(entries: Array<{ section: string; add: string; remove: string }>): Promise<{ trimmed?: number } | undefined>;
    _enqueuePathWrite?<T>(path: string, fn: () => Promise<T>): Promise<T>;
    appendBrainLog?(action: string, filename: string, source: string): Promise<unknown>;
    rebuildBrainIndex?(): Promise<unknown>;
}

/** Minimalny widok AgentManagera. */
interface MemorySaveAgentManager {
    getActiveAgent?(): { name?: string } | null | undefined;
    getAgentMemory?(name: string): AgentMemoryLike | null | undefined;
    getActiveMemory?(): AgentMemoryLike | null | undefined;
}

/** Minimalny widok pluginu: tylko `agentManager`. */
export interface MemorySavePlugin {
    agentManager?: MemorySaveAgentManager | null;
}

function cleanString(value: unknown, max = 4000): string {
    if (value === null || value === undefined) return '';
    return String(value).trim().slice(0, max);
}

function quoteYaml(value: unknown): string {
    return JSON.stringify(cleanString(value, 1000));
}

function normalizeArgs(args: MemorySaveArgs = {}): NormalizedNote {
    const legacyFact = cleanString(args.fact, 1000);
    const type = cleanString(args.type || (legacyFact ? 'user' : ''), 80);
    const name = cleanString(args.name || legacyFact.split(/\s+/).slice(0, 8).join(' '), 160);
    const description = cleanString(args.description || legacyFact, 300);
    const content = cleanString(args.content || legacyFact, 4000);

    return {
        name,
        description,
        type,
        content,
        why: cleanString(args.why || (legacyFact ? 'Legacy memory_save(fact) call.' : ''), 1000),
        how_to_apply: cleanString(args.how_to_apply || args.howToApply || '', 1000),
    };
}

function buildNoteContent(note: NormalizedNote): string {
    const date = new Date().toISOString().slice(0, 10);
    const why = note.why || t('memory.note.why_unspecified');
    const how = note.how_to_apply || t('memory.note.how_default');
    return `---
name: ${quoteYaml(note.name)}
description: ${quoteYaml(note.description)}
type: ${note.type}
created: ${date}
---
${note.content}

${t('memory.note.why_label')} ${why}

${t('memory.note.how_label')} ${how}
`;
}

function getInvocationMemory(
    args: MemorySaveArgs | undefined,
    agentManager: MemorySaveAgentManager | null | undefined,
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

export function createMemorySaveTool() {
    return {
        name: 'memory_save',
        description: t('mcp.memory_save.desc'),
        inputSchema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: t('mcp.memory_save.param.name')
                },
                description: {
                    type: 'string',
                    description: t('mcp.memory_save.param.description')
                },
                type: {
                    type: 'string',
                    enum: ['user', 'agent_rule', 'skill_hint', 'project_context', 'reference'],
                    description: t('mcp.memory_save.param.type')
                },
                content: {
                    type: 'string',
                    description: t('mcp.memory_save.param.content')
                },
                why: {
                    type: 'string',
                    description: t('mcp.memory_save.param.why')
                },
                how_to_apply: {
                    type: 'string',
                    description: t('mcp.memory_save.param.how_to_apply')
                },
                fact: {
                    type: 'string',
                    description: t('mcp.memory_save.param.fact_legacy')
                },
                ephemeral: {
                    type: 'boolean',
                    description: t('mcp.memory_save.param.ephemeral')
                },
                section: {
                    type: 'string',
                    enum: ['user', 'environment'],
                    description: t('mcp.memory_save.param.section')
                },
                remove: {
                    type: 'string',
                    description: t('mcp.memory_save.param.remove')
                }
            },
            required: ['name', 'description', 'type', 'content']
        },
        execute: async (args: MemorySaveArgs, _app: unknown, plugin: MemorySavePlugin | null | undefined) => {
            try {
                const agentManager = plugin?.agentManager;
                const agentMemory = getInvocationMemory(args, agentManager);
                if (!agentMemory) {
                    return { success: false, error: t('mcp.memory_save.no_agent') };
                }

                // E2.8 D2 (S22): ephemeral „Na teraz" state lives IN brain.md, not in a brain/ note.
                // This is the ONE conscious exception to memory_save's create-only rule — the section
                // is updated and pruned in place (add current state / remove outdated). Persistent
                // facts still go to create-only brain/ notes below. Exception scoped to these sections.
                if (args?.ephemeral === true || String(args?.ephemeral).toLowerCase() === 'true') {
                    if (!agentMemory.writeNaTeraz) {
                        return { success: false, error: t('mcp.memory_save.no_agent') };
                    }
                    const sectionKey = naTerazSectionKey(args.section || 'user');
                    if (!sectionKey) {
                        return { success: false, error: t('mcp.memory_save.ephemeral_bad_section'), code: 'validation_error' };
                    }
                    const entry = cleanString(args.content || args.description || args.fact, 400);
                    const remove = cleanString(args.remove, 400);
                    if (!entry && !remove) {
                        return { success: false, error: t('mcp.memory_save.ephemeral_empty'), code: 'validation_error' };
                    }
                    await agentMemory.ensureMemoryStructure?.();
                    const res = await agentMemory.writeNaTeraz([{ section: sectionKey, add: entry, remove }]);
                    return {
                        success: true,
                        ephemeral: true,
                        section: sectionKey,
                        trimmed: res?.trimmed || 0,
                        agent: agentMemory.agentName,
                        message: t('mcp.memory_save.ephemeral_saved', { section: sectionKey })
                    };
                }

                const note = normalizeArgs(args);
                if (!note.name || !note.description || !note.content) {
                    return { success: false, error: t('mcp.memory_save.empty_note'), code: 'validation_error' };
                }
                if (!isValidNoteType(note.type)) {
                    return { success: false, error: t('mcp.memory_save.invalid_type'), code: 'validation_error' };
                }

                await agentMemory.ensureMemoryStructure?.();
                const filename = makeMemoryNoteFilename(note.type, note.name);
                const path = `${agentMemory.paths.brainNotes}/${filename}`;

                // E2.7 K1: serialize the create-only check + write against the note path so two
                // parallel memory_save calls for the same name can't both pass the exists() gate
                // and clobber each other. The second one now correctly sees NOTE_ALREADY_EXISTS.
                const enqueue: <T>(path: string, fn: () => Promise<T>) => Promise<T> = agentMemory._enqueuePathWrite
                    ? agentMemory._enqueuePathWrite.bind(agentMemory)
                    : (_p, fn) => fn();
                const alreadyExists = await enqueue(path, async () => {
                    if (await agentMemory.vault.adapter.exists(path)) return true;
                    await agentMemory.vault.adapter.write(path, buildNoteContent(note));
                    return false;
                });
                if (alreadyExists) {
                    return {
                        success: false,
                        code: MEMORY_V3_ERROR_CODES.NOTE_ALREADY_EXISTS,
                        error: t('mcp.memory_save.note_exists', { filename })
                    };
                }
                // S32 Z1b: kronika `brain.log` (karta „Log wpisów" w profilu → Pamięć). Ta ścieżka
                // pisze notatkę adapterem wprost, nie przez `AgentMemory.writeBrainNote`, więc wpis
                // musi powstać tutaj. Best-effort — `appendBrainLog` nigdy nie rzuca.
                await agentMemory.appendBrainLog?.('create', filename, 'memory_save');
                // AUD-bledy-029: NOTATKA JEST JUŻ NA DYSKU. Przebudowa indeksu to osobny krok
                // i osobny `try` — od K4 (gotcha 9 w `modules/memory/CLAUDE.md`) `rebuildBrainIndex`
                // jest fail-closed i RZUCA przy niepewnym odczycie brain.md, więc jej pad
                // zamieniał udany zapis w `{success:false}`. Model ponawiał wtedy `memory_save`
                // i odbijał się o create-only (`note_already_exists`), a user słyszał „nie zapisałem"
                // o pliku, który powstał. Meldunek ma opisywać STAN: fakt zapisany, indeks stary.
                let indexStale = false;
                try {
                    await agentMemory.rebuildBrainIndex?.();
                } catch (indexError) {
                    indexStale = true;
                    log.error('MemorySaveTool', `Notatka ${filename} zapisana, ale przebudowa brain.md padła:`, indexError);
                }

                return {
                    success: true,
                    filename,
                    path,
                    type: note.type,
                    agent: agentMemory.agentName,
                    ...(indexStale ? { index_stale: true, warning: t('mcp.memory_save.index_stale') } : {}),
                    message: t('mcp.memory_save.saved', { filename })
                };

            } catch (error) {
                log.error('MemorySaveTool', 'Error:', error);
                return { success: false, error: (error as Error).message };
            }
        }
    };
}
