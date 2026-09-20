/**
 * @module commands
 * Cztery komendy CLI Obsidiana fali 1 - WYŁĄCZNIE odczyt (`status`/`selftest`/`agent-prompt`/
 * `memory-status`). Czyste: `buildCliCommands(deps)` nie dotyka Obsidiana - zależności
 * (agent manager, indeks, self-test, status konsolidacji) wchodzą przez `CliDeps` (DI), a
 * `agents`/`memory` wchodzą WYŁĄCZNIE jako `import type` (patrz nagłówek `index.ts`).
 *
 * `log.debug('CLI', ...)` na KAŻDE wywołanie (Logger - oficjalny wyjątek deep-importu, jedyny
 * runtime'owy import spoza modułu) - jedyny ślad w logu, że ktoś w ogóle zawołał komendę.
 */

import { log } from '../../core/utils/Logger.js';
import { okResponse, errorResponse, serializeCliResponse } from './response.js';

import type { CliData, CliFlag, CliFlags } from 'obsidian';
import type { AgentManager } from '../agents/index.js';
import type { AgentMemory, ConsolidationStatus } from '../memory/index.js';
import type { CliErrorCode, CliResponse } from './response.js';

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Kontrakty
// ═══════════════════════════════════════════════════════════════════════════════════════

/**
 * Jedna komenda gotowa do rejestracji na hoście Obsidiana (`register.ts`) albo do wołania w
 * testach. `run` jest WŁAŚCIWOŚCIĄ funkcyjną, nie skrótem metody (`run(params): ...`) - skrót
 * metody każe `@typescript-eslint/unbound-method` traktować `spec.run` jako coś, co mogłoby
 * polegać na `this` przy wyciągnięciu z obiektu (dokładnie to robi `register.ts`, przekazując
 * `spec.run` dalej jako goły handler) - jako właściwość jest to zwykła, bezpieczna funkcja.
 */
export interface CliCommandSpec {
    /** Pełne id z prefiksem pluginu, np. `pkm-assistant:status`. */
    id: string;
    description: string;
    flags: CliFlags | null;
    run: (params: CliData) => Promise<string>;
}

/**
 * Fragment `AgentManager`, na którym stoją komendy `agent-prompt`/`memory-status`. Wąski wycinek
 * strukturalny (`Pick`) zamiast pełnej klasy - `modules/cli/` nie może deep-importować bebechów
 * `modules/agents/`, a i tak potrzebuje tylko tych pięciu metod.
 */
export type CliAgentManager = Pick<
    AgentManager,
    'getAllAgents' | 'getAgent' | 'getActiveAgent' | 'getPromptInspectorDataForAgent' | 'getAgentMemory'
>;

/** Status jednego wpisu indeksu wektorowego, tak jak go widzi CLI (bez importu z `modules/embedding/`). */
export interface CliIndexStatus {
    status: string;
    progress?: { indexed?: number; total?: number };
    modelKey?: string | null;
    lastError?: unknown;
}

/**
 * Zależności wstrzykiwane z `src/main.ts`. Gettery (nie gołe pola) - `agentManager`/
 * `indexStatus` bywają `undefined` PRZED końcem `initialize()`, a komenda `status` musi
 * działać właśnie wtedy (odpytywanie "czy plugin już wstał" po `plugin:reload`).
 */
export interface CliDeps {
    pluginId: string;
    version: () => string;
    isReady: () => boolean;
    agentManager: () => CliAgentManager | undefined;
    indexStatus: () => CliIndexStatus | undefined;
    /** Raport jest dla CLI nieprzezroczystym ładunkiem - przechodzi do `data` bez kształtowania. */
    selfTest: () => Promise<object>;
    consolidationStatus: (memory: AgentMemory) => Promise<ConsolidationStatus>;
    /** Wstrzykiwalny zegar (testy) - domyślnie `new Date()`. */
    now?: () => Date;
}

/** `pkm-assistant:status` - działa ZAWSZE, nawet przed końcem inicjalizacji. */
export interface StatusData {
    plugin: { id: string; version: string; loadedAt: string };
    ready: boolean;
    agents: { count: number; active: string | null; names: string[] } | null;
    index: { status: string; indexed: number; total: number; modelKey: string | null; lastError: string | null } | null;
    commands: string[];
}

/** `pkm-assistant:agent-prompt`. */
export interface AgentPromptData {
    /** Rozwiązane, kanoniczne imię (może różnić się wielkością liter od `agent=` w żądaniu). */
    agent: string;
    totalTokens: number;
    sections: Array<{ key: string; label: string; category: string; tokens: number; enabled: boolean; required: boolean }>;
    /** Obecne TYLKO gdy w żądaniu podano `section=<key>`. */
    section?: { key: string; label: string; tokens: number; content: string };
}

/** `pkm-assistant:memory-status`. */
export interface MemoryStatusData {
    /** Zawsze tablica, także dla jednego agenta (`agent=<name>`, nie `all`). */
    agents: ConsolidationStatus[];
    /** Pad odczytu JEDNEGO agenta nie wywraca reszty - ląduje tu, agent wypada z `agents`. */
    errors: Array<{ agent: string; message: string }>;
}

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Opisy (stale po angielsku - interfejs maszynowy, niezależny od języka UI)
// ═══════════════════════════════════════════════════════════════════════════════════════

const FORMAT_FLAG: CliFlag = { value: 'json', description: 'Output format. Only "json" (default) is supported.' };

const STATUS_DESCRIPTION = 'Report plugin liveness: version, readiness, loaded agents, vault index status. Works even before the plugin finished initializing.';
const SELFTEST_DESCRIPTION = 'Run the built-in self-test and return its report as JSON, without writing a log file or showing a Notice.';
const AGENT_PROMPT_DESCRIPTION = 'Inspect one agent\'s system prompt: section breakdown with token counts, or the full content of one section.';
const MEMORY_STATUS_DESCRIPTION = 'Report memory consolidation status for one agent or all agents (thresholds, counters, whether consolidation would trigger).';

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Rozwiązywanie imienia agenta - (1) dokładne dopasowanie, (2) bez wielkości liter jeśli JEDNOZNACZNE
// ═══════════════════════════════════════════════════════════════════════════════════════

type AgentNameResolution =
    | { ok: true; name: string }
    | { ok: false; code: 'agent_not_found' | 'agent_ambiguous'; message: string };

/**
 * `AgentManager.getAgent(name)` jest case-sensitive, a `getPromptInspectorDataForAgent` dla
 * nieznanego imienia oddaje CICHO pusty wynik (`AgentManager.ts:736-740`) - dlatego istnienie
 * agenta sprawdzamy TUTAJ, zanim cokolwiek wołamy. Obie gałęzie błędu wymieniają dostępne imiona.
 */
function resolveAgentName(names: string[], requested: string): AgentNameResolution {
    if (names.includes(requested)) return { ok: true, name: requested };

    const lower = requested.toLowerCase();
    const caseInsensitiveMatches = names.filter(name => name.toLowerCase() === lower);
    const available = names.length > 0 ? names.join(', ') : '(none)';

    if (caseInsensitiveMatches.length === 1) return { ok: true, name: caseInsensitiveMatches[0] };
    if (caseInsensitiveMatches.length > 1) {
        return {
            ok: false,
            code: 'agent_ambiguous',
            message: `Agent name "${requested}" matches ${caseInsensitiveMatches.length} agents case-insensitively (${caseInsensitiveMatches.join(', ')}). Available agents: ${available}`,
        };
    }
    return {
        ok: false,
        code: 'agent_not_found',
        message: `Agent "${requested}" not found. Available agents: ${available}`,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Wspólny szkielet uruchomienia - format, gotowość, log, nigdy nie rzuca
// ═══════════════════════════════════════════════════════════════════════════════════════

function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message;
    return String(e);
}

/** `format` jest jedyną flagą wspólną wszystkim czterem komendom - dozwolona wartość: `json` (domyślna). */
function validateFormat(params: CliData): CliErrorCode | null {
    if (params.format !== undefined && params.format !== 'json') return 'bad_flag';
    return null;
}

/**
 * `status` nie wymaga gotowości pluginu ani agent managera - buduje odpowiedź z tego, co akurat
 * jest dostępne (patrz `StatusData`). Jedyna wspólna bramka to `format`.
 */
async function runGuardedAlways(
    id: string,
    params: CliData,
    build: () => CliResponse<unknown>,
): Promise<string> {
    log.debug('CLI', `${id} params=${JSON.stringify(params)}`);
    try {
        const formatError = validateFormat(params);
        if (formatError) return serializeCliResponse(errorResponse(id, formatError, `Unsupported format "${String(params.format)}" - only "json" is supported.`));
        return serializeCliResponse(build());
    } catch (e) {
        return serializeCliResponse(errorResponse(id, 'internal', errorMessage(e)));
    }
}

/**
 * Reszta komend: `format` + gotowość pluginu + obecność agent managera (`not_ready` gdy
 * którekolwiek zawiedzie). `handler` dostaje już-obecny `CliAgentManager` - bez ponownego,
 * potencjalnie rozjeżdżającego się w typach wołania `deps.agentManager()`.
 */
async function runGuardedReady(
    id: string,
    params: CliData,
    deps: CliDeps,
    handler: (am: CliAgentManager) => Promise<CliResponse<unknown>>,
): Promise<string> {
    log.debug('CLI', `${id} params=${JSON.stringify(params)}`);
    try {
        const formatError = validateFormat(params);
        if (formatError) return serializeCliResponse(errorResponse(id, formatError, `Unsupported format "${String(params.format)}" - only "json" is supported.`));
        const am = deps.agentManager();
        if (!deps.isReady() || !am) {
            return serializeCliResponse(errorResponse(id, 'not_ready', 'Plugin is not ready yet (still initializing, or the agent manager is not available).'));
        }
        return serializeCliResponse(await handler(am));
    } catch (e) {
        return serializeCliResponse(errorResponse(id, 'internal', errorMessage(e)));
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Budowa danych per komenda
// ═══════════════════════════════════════════════════════════════════════════════════════

function buildStatusData(deps: CliDeps, loadedAt: string, commandIds: string[]): StatusData {
    const am = deps.agentManager();
    const agents = am
        ? { count: am.getAllAgents().length, active: am.getActiveAgent()?.name ?? null, names: am.getAllAgents().map(a => a.name) }
        : null;

    const idx = deps.indexStatus();
    const index = idx
        ? {
            status: idx.status,
            indexed: Number(idx.progress?.indexed) || 0,
            total: Number(idx.progress?.total) || 0,
            modelKey: idx.modelKey ?? null,
            lastError: idx.lastError == null ? null : String(idx.lastError),
        }
        : null;

    return {
        plugin: { id: deps.pluginId, version: deps.version(), loadedAt },
        ready: deps.isReady(),
        agents,
        index,
        commands: commandIds,
    };
}

async function runAgentPrompt(id: string, params: CliData, am: CliAgentManager): Promise<CliResponse<AgentPromptData>> {
    const names = am.getAllAgents().map(a => a.name);
    const requested = typeof params.agent === 'string' ? params.agent : '';
    const resolved = resolveAgentName(names, requested);
    if (!resolved.ok) return errorResponse(id, resolved.code, resolved.message);

    const inspected = await am.getPromptInspectorDataForAgent(resolved.name);
    const data: AgentPromptData = {
        agent: resolved.name,
        totalTokens: inspected.breakdown.total,
        sections: inspected.sections.map(s => ({
            key: s.key,
            label: s.label,
            category: s.category,
            tokens: s.tokens,
            enabled: s.enabled,
            required: s.required,
        })),
    };

    const sectionKey = typeof params.section === 'string' ? params.section : undefined;
    if (sectionKey !== undefined) {
        const found = inspected.sections.find(s => s.key === sectionKey);
        if (!found) {
            const keys = inspected.sections.map(s => s.key);
            const available = keys.length > 0 ? keys.join(', ') : '(none)';
            return errorResponse(id, 'section_not_found', `Section "${sectionKey}" not found. Available sections: ${available}`);
        }
        data.section = { key: found.key, label: found.label, tokens: found.tokens, content: found.content };
    }

    return okResponse(id, data);
}

async function runMemoryStatus(id: string, params: CliData, deps: CliDeps, am: CliAgentManager): Promise<CliResponse<MemoryStatusData>> {
    const agents: ConsolidationStatus[] = [];
    const errors: MemoryStatusData['errors'] = [];

    const collect = async (agentName: string, memory: AgentMemory | null): Promise<void> => {
        if (!memory) {
            errors.push({ agent: agentName, message: 'Agent has no memory instance yet.' });
            return;
        }
        try {
            agents.push(await deps.consolidationStatus(memory));
        } catch (e) {
            errors.push({ agent: agentName, message: errorMessage(e) });
        }
    };

    const requested = typeof params.agent === 'string' ? params.agent : '';
    if (requested === 'all') {
        for (const agent of am.getAllAgents()) {
            await collect(agent.name, am.getAgentMemory(agent.name));
        }
    } else {
        const names = am.getAllAgents().map(a => a.name);
        const resolved = resolveAgentName(names, requested);
        if (!resolved.ok) return errorResponse(id, resolved.code, resolved.message);
        await collect(resolved.name, am.getAgentMemory(resolved.name));
    }

    return okResponse(id, { agents, errors });
}

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Montaż
// ═══════════════════════════════════════════════════════════════════════════════════════

/** Kolejność MUSI się zgadzać z kolejnością komend budowanych niżej - `commands` w `StatusData` ją zwraca. */
const COMMAND_NAMES = ['status', 'selftest', 'agent-prompt', 'memory-status'] as const;

/**
 * Buduje cztery `CliCommandSpec` - czyste, zero Obsidiana (żaden argument, żadne pole tego
 * modułu nie dotyka `obsidian`; `register.ts` dopiero wiąże je z hostem).
 */
export function buildCliCommands(deps: CliDeps): CliCommandSpec[] {
    const loadedAt = (deps.now ? deps.now() : new Date()).toISOString();
    const ids = COMMAND_NAMES.map(name => `${deps.pluginId}:${name}`);
    const [statusId, selftestId, agentPromptId, memoryStatusId] = ids;

    return [
        {
            id: statusId,
            description: STATUS_DESCRIPTION,
            flags: { format: FORMAT_FLAG },
            run: params => runGuardedAlways(statusId, params, () => okResponse(statusId, buildStatusData(deps, loadedAt, ids))),
        },
        {
            id: selftestId,
            description: SELFTEST_DESCRIPTION,
            flags: { format: FORMAT_FLAG },
            run: params => runGuardedReady(selftestId, params, deps, async () => okResponse(selftestId, await deps.selfTest())),
        },
        {
            id: agentPromptId,
            description: AGENT_PROMPT_DESCRIPTION,
            flags: {
                agent: { value: '<name>', description: 'Exact or case-insensitive agent name.', required: true },
                section: { value: '<key>', description: 'Return only this prompt section, including its content.' },
                format: FORMAT_FLAG,
            },
            run: params => runGuardedReady(agentPromptId, params, deps, am => runAgentPrompt(agentPromptId, params, am)),
        },
        {
            id: memoryStatusId,
            description: MEMORY_STATUS_DESCRIPTION,
            flags: {
                agent: { value: '<name|all>', description: 'Agent name, or "all" for every agent.', required: true },
                format: FORMAT_FLAG,
            },
            run: params => runGuardedReady(memoryStatusId, params, deps, am => runMemoryStatus(memoryStatusId, params, deps, am)),
        },
    ];
}
