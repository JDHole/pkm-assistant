/**
 * SubAgentRunner
 * Unified runner for sub-agent tasks (replaces MinionRunner + MasterRunner).
 * Role determines behavior: researcher (search/prep) vs strategist (analyze/plan).
 * Pętla tool-callingu jest wyciągnięta do modules/agent-loop (runAgentLoop) - wspólna
 * z czatem. SubAgentRunner buduje store/tools/limity/egzekutor i mapuje wynik.
 */
import { runAgentLoop, ArrayMessageStore } from '../agent-loop/index.js';
import type { RunAgentLoopOptions, ToolExecutionContext, AgentLoopPartialSnapshot, AgentLoopStopReason } from '../agent-loop/index.js';
import { log } from '../../core/utils/Logger.js';
import { t } from '../../core/i18n/index.js';
import { getLimits, sanitizeLimit } from '../../config/limits.js';
import { countTokens } from '../../core/index.js';
// „Co jest porażką narzędzia" liczy ta sama funkcja, co status chipa w czacie.
import { resolveWorkPrompt, maskSensitiveData, sanitizePath, toolResultStatus } from '../../core/index.js';
import type { PluginApi, AppLike, WorkPromptSettings } from '../../core/index.js';
import { defaultSubAgentFramePrompt } from './framePrompt.js';
// Rozpoznaje stare nazwy retrieval przy budowie whitelisty (fail-safe, gdyby
// config nie przeszedł migracji przez loader) - np. vault_grep → search.
// Jednolity domyślny zestaw narzędzi workera (brak podziału research/strateg).
import { DEPRECATED_TOOL_RENAMES, DEFAULT_SUB_AGENT_TOOLS } from './SubAgentLoader.js';
import type { SubAgentData } from './types.js';
import { describeToolEffect, checkEffectTargets } from '../tools/index.js';
import type { BuiltinToolExecutionContext, ToolEffect, EffectTargetIo } from '../tools/index.js';
// Bieg suba jest BYTEM w rejestrze (`plugin.subTaskRegistry`).
// Sam rejestr przychodzi z pluginu (DI), stąd tylko typ - runner go nie tworzy.
import type { SubTask, SubTaskOrigin, SubTaskRegistry, SubTaskTrace } from './SubTaskRegistry.js';
import type { ActiveSessionEventInput } from '../memory/index.js';
import type { ChatModel } from '../models/index.js';
import { classifyRunEnd } from './runOutcome.js';
import type { RunEffect, RunOutcome } from './runOutcome.js';

type AgentLike = { name: string };

const SUB_AGENT_MAX_OUTPUT_TOKENS = 16384;

/** Narzędzie tak, jak oddaje je `ToolRegistry.getTool`/`filterByAgent` — pełny kształt
 * (execute/inputSchema itd.) mieszka w `modules/tools`, poza zakresem tej fali; runner
 * czyta z niego wyłącznie te pola. */
interface RunnerToolDefinition {
    name: string;
    description: string;
    inputSchema: unknown;
    execute: (args: unknown, app: AppLike, plugin: RunnerPlugin, context?: BuiltinToolExecutionContext) => Promise<unknown>;
}

/** Rejestr narzędzi w zakresie, jakiego używa runner (`modules/tools/ToolRegistry.ts`,
 * poza zakresem — lokalny duck-type, ten sam wzorzec co `DelegateAgentManager`
 * w `modules/tools/DelegateTool.ts`). */
interface RunnerToolRegistry {
    filterByAgent(agent: unknown): RunnerToolDefinition[];
    getTool(name: string): RunnerToolDefinition | null;
}

/** `MCPClient` w zakresie, jakiego używa runner — trasuje wywołanie narzędzia przez
 * uprawnienia/whitelistę (`modules/tools/MCPClient.ts`, poza zakresem). */
interface RunnerMcpClient {
    executeToolCall(
        toolCall: ToolCall,
        agentName: string,
        opts: {
            autonomy?: string | null;
            delegationDepth?: number;
            scopeFolders?: string[] | null;
            callerToolNames?: string[];
            resultBudgetChars?: number;
            shouldAbort?: () => boolean;
            onExecutionStart?: () => void;
        },
    ): Promise<unknown>;
}

/** Pamięć agenta w zakresie, jakiego dotyka runner (`modules/memory`, poza zakresem) —
 * dziennik biegu dopisuje się do aktywnej sesji WŁAŚCICIELA biegu. */
interface RunnerAgentMemory {
    paths?: { brainNotes?: string };
    appendSessionEvent?(path: string, event: ActiveSessionEventInput): Promise<string>;
    appendToActiveSession?(event: Record<string, unknown>): Promise<void>;
}

/** Kształt pluginu widziany przez runnera. */
interface RunnerPlugin extends PluginApi {
    mcpClient?: RunnerMcpClient | null;
    subTaskRegistry?: SubTaskRegistry | null;
    traceLog?: { scope?(label: string): SubTaskTrace } | null;
    agentManager?: { getAgentMemory?(agentName: string): RunnerAgentMemory | null | undefined } | null;
    /** Zwierciadło trybu pytań — WYŁĄCZNIE fallback, gdy `execOptions.autonomy` go nie niesie. */
    currentAutonomy?: string | null;
}

type RunOptions = {
    delegationDepth?: number;
    scopeFolders?: string[];
    /**
     * Whitelista narzędzi WOŁAJĄCEGO (suba, który zlecił ten bieg).
     * Trzeci składnik przecięcia w `_getTools` obok configu dziecka i widoczności agenta -
     * bez niego wnuk odpalony przez read-only suba dostawał pełną whitelistę agenta głównego.
     * Brak = piętro 1 (zlecenie z czatu), czyli przecięcie jak dotąd.
     */
    callerToolNames?: string[];
    /**
     * Tryb autonomii TURY, która zleciła ten bieg - zamrożony w chwili
     * zlecenia, dokładnie jak `scopeFolders`. Delegacja z czatu jest zawsze
     * w tle, więc lustro `plugin.currentAutonomy` zmienia się pod biegiem przy każdym
     * przełączeniu zakładki. Brak wartości = stare zachowanie (lustro jako fallback).
     */
    autonomy?: string | null;
    modelTimeout?: number;
    shouldAbort?: () => boolean;
    abortSignal?: AbortSignal;
    abortReason?: () => 'manual-stop' | 'task-timeout' | 'superseded';
    /**
     * Sygnał „sub dostał slot bramki" - runner przekazuje go pętli 1:1
     * (`RunAgentLoopOptions.onGateAdmitted`) i sam go nie interpretuje. Czyta go
     * `DelegateTool`, żeby budżet zadania liczył czas ROBOTY, a nie stania w kolejce.
     */
    onGateAdmitted?: () => void;
    /** Adres zwrotny zlecenia - leci 1:1 do `registry.create`. */
    origin?: SubTaskOrigin;
    /** Bieg w tle (wołający nie czeka na wynik) - leci 1:1 do `registry.create`. */
    background?: boolean;
    /**
     * Hak „byt już istnieje". Wołany ZARAZ po `registry.create`, zanim runner zrobi
     * cokolwiek awaitowalnego - dzięki temu `DelegateTool` może oddać modelowi `task_id`
     * biegu, który dopiero się zaczyna. Bez rejestru NIE jest wołany.
     */
    onTaskCreated?: (task: SubTask) => void;
    threadId?: string;
};
/**
 * Jak sub ZSZEDŁ z biegu. Trzy pierwsze wartości przychodzą wprost z `runAgentLoop`
 * (`RunAgentLoopResult.stoppedBy`), czwarta - `'error'` - powstaje TUTAJ, w gałęzi `catch`
 * runnera: pętla nigdy nie oddaje `'error'`, bo przy wyjątku po prostu rzuca dalej.
 */
export type SubRunStoppedBy = 'natural' | 'backstop' | 'abort' | 'error';

/**
 * Zwrotka `runTask`. Bez pól `stoppedBy`/`failed` gałąź `catch` oddawałaby NORMALNY wynik
 * z tekstem błędu w polu `result` i bez żadnej flagi - `DelegateTool` owijałby to
 * w `{success:true}`, więc dla agenta zlecającego padnięty sub wyglądałby identycznie
 * jak sub, który zadanie domknął. Stąd dwa pola: `stoppedBy` (sposób zejścia) i `failed`
 * (obecne WYŁĄCZNIE w gałęzi catch).
 */
export type SubRunResult = {
    result: string;
    toolsUsed: string[];
    toolCallDetails: unknown[];
    duration: number;
    usage: unknown;
    stoppedBy: SubRunStoppedBy;
    /** Tylko przy realnym niepowodzeniu biegu (wyjątek). Brak pola = bieg doszedł do końca. */
    failed?: true;
    partial?: AgentLoopPartialSnapshot;
    stopReason?: AgentLoopStopReason;
    outcome: RunOutcome;
    handoff?: string;
};

type ToolCall = { name: string; arguments: unknown };
type ErrLike = { message?: unknown; error?: unknown; details?: { message?: unknown }; cause?: { message?: unknown } };

/**
 * Licznik WYWOŁAŃ suba w tym procesie - daje krótki, unikalny sufiks etykiety trace
 * (`sub/pkm-sub#3`). Bez niego `delegate` z listą `tasks` odpalał N równoległych
 * workerów piszących w trace pod TĄ SAMĄ etykietą i przebiegów nie dało się rozdzielić.
 *
 * Dlaczego licznik, a nie czas jak w pętli głównej (`harness/Tester#15-41-51`): równoległe suby
 * startują w tej samej sekundzie, więc stempel czasu by ich nie rozróżnił.
 */
let _subCallSeq = 0;

/**
 * Bezpiecznik księgowości: wołanie rejestru SubTask NIE MOŻE zmienić wyniku `runTask`
 * ani wywrócić biegu suba. Sam rejestr jest fail-soft w środku - to drugi pas, na wypadek
 * gdyby `plugin.subTaskRegistry` okazał się czymś innym niż rejestrem.
 */
function _safeRegistry<T>(fn: () => T): T | undefined {
    try {
        return fn();
    } catch (e) {
        log.warn('SubAgent', 'rejestr SubTask (ignorowane):', e);
        return undefined;
    }
}

/**
 * Sufit deliverable dla `delegate`/`agent_delegate` NIE MOŻE wyjść niższy niż ogólny sufit
 * TEGO suba (`config.max_tool_result_length` - per-sub override edytowalny
 * w SubAgentEditorModal, patrz `runTask` linia z `maxResultLen`). Bez tej funkcji sub
 * skonfigurowany np. na 100k dostawałby wynik zagnieżdżonej delegacji ścięty do 60k -
 * taki sufit OBNIŻAŁBY mu limit zamiast go podnosić. Czat (`chat_streaming.ts`) tego
 * problemu nie ma, bo tam nie istnieje per-agent override (jeden wspólny sufit dla
 * wszystkich agentów) - tu bierzemy WIĘKSZY z dwóch. `deliverableDefault === 0` (świadome
 * „bez limitu" na poziomie globalnego `subagent_result_max_chars`) zostaje zerem: zwykły
 * `Math.max` by je zepsuł (0 przegrywa z każdą dodatnią liczbą), a `AgentLoop._truncateResult`
 * przy cap<=0 w ogóle nie tnie - więc zero musi zostać zerem, nie zamienić się w 60000.
 *
 * JEDNA funkcja dla obu miejsc, które o tym mówią (`loopLimits` w `runTask` i blok BUDŻET
 * w `_buildTaskPrompt`) - te dwa miejsca łatwo się rozjeżdżają (prompt obiecuje inny
 * sufit niż runtime realnie egzekwuje), więc licząc to niezależnie w dwóch miejscach
 * ryzykujemy powtórkę tego samego błędu.
 *
 * `subCommonCap` TEŻ może wyjść zerem - `config.max_tool_result_length` to pole edytowalne
 * per sub w SubAgentEditorModal, puste pole zapisuje się jako 0. Zero po KTÓREJKOLWIEK
 * stronie znaczy „bez limitu" i musi wygrać: semantycznie 0 to NAJWIĘKSZY możliwy sufit
 * (nieskończoność), ale liczbowo jest najmniejszy, więc goły `Math.max` by go przegrał.
 */
function _deliverableResultCap(subCommonCap: number, deliverableDefault: number): number {
    return (subCommonCap === 0 || deliverableDefault === 0) ? 0 : Math.max(subCommonCap, deliverableDefault);
}

function _canDelegateAtDepth(depth: number, maximum: number): boolean { return depth < maximum; }

function _effectiveSubLimits(config: SubAgentData, limits: Record<string, number>) {
    return {
        maxIterations: sanitizeLimit('subagent_max_iterations_worker', config.max_iterations, limits.subagent_max_iterations_worker),
        maxToolResultLength: sanitizeLimit('max_tool_result_length', config.max_tool_result_length, limits.max_tool_result_length),
    };
}

function _maskHandoffText(value: string, knownSecrets: readonly string[]): string {
    const withoutKnownSecrets = knownSecrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
    return maskSensitiveData(withoutKnownSecrets);
}

function _buildHandoff(outcome: RunOutcome, partial: AgentLoopPartialSnapshot | undefined, details: readonly unknown[], cap: number, knownSecrets: readonly string[]): string {
    const sections: string[] = [];
    const append = (label: string, value: string) => {
        const used = sections.join('\n\n').length;
        const remaining = cap - used - (sections.length ? 2 : 0);
        if (remaining <= 0 || cap <= 0) return;
        sections.push(`${t(label)}\n${_maskHandoffText(value, knownSecrets)}`.slice(0, remaining));
    };
    const effectsText = outcome.effects.map(effect => {
        const targets = effect.targets.map(target => `${target.kind}${target.path ? `: ${target.path}` : ''}`).join(', ');
        return `${effect.tool} | ${targets || effect.action} | ${effect.outcome} | ${effect.check}`;
    }).join('\n');
    if (effectsText) append('subagent.handoff.effects', effectsText);
    if (partial?.lastText?.trim()) append('subagent.handoff.last_text', partial.lastText.trim());
    const resultsText = [...details].reverse().map(item => {
        const row = item as { name?: unknown; args?: unknown; resultPreview?: unknown };
        let target = '';
        if (row.args && typeof row.args === 'object' && !Array.isArray(row.args)) {
            const args = row.args as Record<string, unknown>;
            target = typeof args.path === 'string' ? args.path : JSON.stringify(args);
        } else if (typeof row.args === 'string') target = row.args;
        const name = typeof row.name === 'string' ? row.name : 'tool';
        const preview = typeof row.resultPreview === 'string' ? row.resultPreview : '';
        const maskedTarget = _maskHandoffText(target, knownSecrets);
        const targetPreview = maskedTarget.length > 200 ? `${maskedTarget.slice(0, 197)}...` : maskedTarget;
        return `${name} | ${targetPreview} | ${preview}`;
    }).join('\n');
    if (resultsText) append('subagent.handoff.results', resultsText);
    return sections.join('\n\n').slice(0, Math.max(0, cap));
}

export class SubAgentRunner {
    declare toolRegistry: RunnerToolRegistry;
    declare app: AppLike;
    declare plugin: RunnerPlugin;
    declare mcpClient: RunnerMcpClient | null;
    declare effectTargetIo: EffectTargetIo;
    /**
     * @param {Object} options
     * @param {Object} options.toolRegistry - ToolRegistry instance
     * @param {Object} options.app - Obsidian App instance
     * @param {Object} options.plugin - Plugin instance (for tool execution context)
     */
    // TS-boundary: jedyny wołacz konstruktora (`DelegateTool.ts`, poza zakresem) DI-uje przez
    // WŁASNE, węższe lokalne typy (`DelegatePlugin`, `toolRegistry: {filterByAgent?}`, `app: object`)
    // i od razu rzutuje wynik `new SubAgentRunner(...)` na SWÓJ `SubAgentRunnerLike` — runner tu
    // dostaje więc parametry `unknown` i zawęża je do tego, czego SAM realnie potrzebuje
    // (`getTool` na registry, pełny `PluginApi` na plugin). W praktyce to zawsze te same,
    // realne obiekty `ToolRegistry`/`App`/plugin.
    constructor({ toolRegistry, app, plugin, effectTargetIo }: { toolRegistry: unknown; app: unknown; plugin: unknown; effectTargetIo?: EffectTargetIo }) {
        this.toolRegistry = toolRegistry as RunnerToolRegistry;
        this.app = app as AppLike;
        this.plugin = plugin as RunnerPlugin;
        this.mcpClient = (plugin as RunnerPlugin)?.mcpClient || null;
        const adapter = (app as { vault?: { adapter?: { exists?: (path: string) => Promise<boolean> } } })?.vault?.adapter;
        this.effectTargetIo = effectTargetIo ?? { exists: async (path) => {
            if (!adapter?.exists) throw new Error('Vault adapter unavailable');
            return adapter.exists(path);
        } };
    }

    private async _checkEffect(described: ToolEffect, agentName: string): Promise<RunEffect['check']> {
        if (described.check === 'none') return 'not-checked';
        const targets = described.targets.map(target => ({ ...target }));
        for (const target of targets) {
            // Bez zwróconej ścieżki nie sprawdzamy surowego celu, który
            // narzędzie vaulta mogło znormalizować przed wykonaniem.
            if ((target.kind === 'vault-file' || target.kind === 'vault-folder')
                && target.path && sanitizePath(target.path) !== target.path) return 'not-checked';
            if (target.kind !== 'memory-file' || !target.path) continue;
            if (target.path.startsWith('.pkm-assistant/')) continue;
            let brainNotes: string | undefined;
            try { brainNotes = this.plugin?.agentManager?.getAgentMemory?.(agentName)?.paths?.brainNotes; }
            catch { /* Niepewna ścieżka pamięci nie blokuje biegu. */ }
            if (brainNotes && !target.path.includes('/')) target.path = `${brainNotes}/${target.path}`;
            else if (!target.path.includes('/')) return 'not-checked';
        }
        return checkEffectTargets({ ...described, targets }, this.effectTargetIo);
    }

    /**
     * Run a sub-agent task.
     * @param {string} taskPrompt - Task description from the agent
     * @param {Object} agent - Agent instance
     * @param {Object} config - Sub-agent config from SubAgentLoader
     * @param {Object} model - ChatModel instance
     * @param {Object} [options]
     * @param {number} [options.delegationDepth=0] - piętro delegacji, na którym stoi ten
     *   sub (1 = odpalony z głównego czatu). Wędruje do `MCPClient.executeToolCall`, żeby
     *   `delegate` wołany z wnętrza suba wiedział, jak głęboko już jesteśmy.
     * @param {string[]} [options.scopeFolders] - foldery ze `scope.folders` custom suba.
     *   Dodatkowe (koniunkcyjne) zawężenie ścieżek vaultowych - patrz AccessGuard.
     * @returns {Promise<SubRunResult>} - zwrotka niesie też `stoppedBy` (sposób zejścia)
     *   i `failed: true` w gałęzi błędu. Patrz `SubRunResult`.
     */
    async runTask(taskPrompt: string, agent: AgentLike, config: SubAgentData, model: ChatModel, options: RunOptions = {}): Promise<SubRunResult> {
        const startTime = Date.now();
        const registry: SubTaskRegistry | null = this.plugin?.subTaskRegistry || null;
        let thread = options.threadId ? registry?.getThread?.(options.threadId) : undefined;
        if (options.threadId) {
            const owner = options.origin;
            if (!thread || !owner || !registry?.beginRun?.(options.threadId, { agentName: owner.agentName, sessionPath: owner.sessionPath, sessionEpoch: owner.sessionEpoch })) {
                const outcome = classifyRunEnd({ stoppedBy: 'error', failed: true, finalText: '' });
                return { result: t('subagent.thread_refused'), toolsUsed: [], toolCallDetails: [], duration: Date.now() - startTime, usage: null, stoppedBy: 'error', failed: true, outcome };
            }
            const frozen = thread.config;
            if (frozen.modelId !== model.modelId || frozen.providerId !== model.providerId) {
                registry?.endRun?.(thread.threadId, { successful: false });
                const outcome = classifyRunEnd({ stoppedBy: 'error', failed: true, finalText: '' });
                return { result: t('subagent.thread_refused'), toolsUsed: [], toolCallDetails: [], duration: Date.now() - startTime, usage: null, stoppedBy: 'error', failed: true, outcome };
            }
            try {
                config = structuredClone(frozen.subConfig as SubAgentData);
                options = { ...options, ...(frozen.options as Partial<RunOptions>), threadId: options.threadId };
            } catch (error) {
                log.warn('SubAgent', `Wątek ${thread.threadId} ma nieprawidłową konfigurację: ${String(error)}`);
                registry?.endRun?.(thread.threadId, { successful: false });
                const outcome = classifyRunEnd({ stoppedBy: 'error', failed: true, finalText: '' });
                return { result: t('subagent.thread_refused'), toolsUsed: [], toolCallDetails: [], duration: Date.now() - startTime, usage: null, stoppedBy: 'error', failed: true, outcome };
            }
        }
        // Kaganiec delegacji + bariera scope - przenoszone przez cały bieg suba.
        const delegationDepth = Number(options.delegationDepth) || 0;
        const scopeFolders = Array.isArray(options.scopeFolders) && options.scopeFolders.length > 0
            ? options.scopeFolders
            : null;
        // Tryb pytań zamrożony na CAŁY bieg - jedna wartość dla wszystkich
        // wywołań narzędzi, nawet gdy user w międzyczasie przeskoczy na zakładkę z `yolo`.
        const autonomy = typeof options.autonomy === 'string' && options.autonomy
            ? options.autonomy
            : null;
        // Jeden generyczny worker - brak rozgałęzień po roli. Rola w config to etykieta.
        const logTag = 'SubAgent';

        log.group(logTag, `Task: ${config.name} dla ${agent.name}`);
        log.debug(logTag, `Zadanie: "${taskPrompt.slice(0, 200)}..."`);

        // Deklaracja PRZED `try`, bo domknięcie biegu robi też gałąź `catch` (fail).
        let subTask: SubTask | undefined;
        let conversationStore: ArrayMessageStore | undefined;
        let lastPartial: AgentLoopPartialSnapshot | undefined;
        let partialPersistence: Promise<void> = Promise.resolve();
        const effects: RunEffect[] = [];
        const descriptions = new Map<RunEffect, ToolEffect>();
        const callEffects = new Map<number, RunEffect>();
        let effectsClosed = false;
        let successfulToolResults = 0;
        const observedToolDetails: Array<{ name: string; args: unknown; resultPreview: string }> = [];
        const beginEffect = (seq: number, name: string, args: unknown) => {
            if (effectsClosed) return;
            const described = describeToolEffect(name, args);
            if (!described) return;
            const entry: RunEffect = { tool: described.tool, action: described.action,
                targets: described.targets.map(target => ({ ...target })), outcome: 'pending', check: 'not-checked' };
            effects.push(entry);
            descriptions.set(entry, described);
            callEffects.set(seq, entry);
        };
        const completeEffect = (seq: number, name: string, args: unknown, result: unknown, failed: boolean) => {
            if (effectsClosed) return;
            if (!failed) successfulToolResults++;
            const entry = callEffects.get(seq);
            if (!entry) return;
            // Narzędzia vaulta zwracają ścieżkę po normalizacji. Jest to cel wykonania,
            // podczas gdy argument modelu może nadal zawierać np. kodowanie %XX.
            const actualPath = !failed && result !== null && typeof result === 'object' && !Array.isArray(result)
                ? (result as { path?: unknown }).path : undefined;
            const describedArgs = typeof actualPath === 'string' && actualPath.length > 0
                && (name === 'write' || name === 'delete' || name === 'create_folder')
                && args !== null && typeof args === 'object' && !Array.isArray(args)
                ? { ...args, path: actualPath } : args;
            const described = describeToolEffect(name, describedArgs, result);
            if (described) {
                entry.tool = described.tool;
                entry.action = described.action;
                entry.targets = described.targets.map(target => ({ ...target }));
                descriptions.set(entry, described);
            }
            entry.outcome = failed ? 'error' : 'returned';
        };
        const failEffect = (seq: number) => {
            if (effectsClosed) return;
            const entry = callEffects.get(seq);
            if (entry) entry.outcome = 'error';
        };
        const closeEffects = (reason?: AgentLoopStopReason) => {
            effectsClosed = true;
            for (const entry of effects) {
                if (entry.outcome === 'pending') {
                    entry.outcome = 'unknown';
                    if (reason) entry.cause = reason.kind;
                }
            }
        };
        const finalizeEffects = async () => {
            const counts = { matches: 0, mismatch: 0, 'not-checked': 0, unknown: 0 };
            for (const entry of effects) {
                if (entry.outcome === 'unknown') counts.unknown++;
                if (entry.outcome === 'returned' || entry.outcome === 'unknown') {
                    const described = descriptions.get(entry);
                    if (described) entry.check = await this._checkEffect(described, agent.name);
                }
                counts[entry.check]++;
            }
            if (subTask) _safeRegistry(() => registry?.step?.(subTask as SubTask, 'effects.checked', counts));
            return effects.map(entry => ({ ...entry, targets: entry.targets.map(target => ({ ...target })) }));
        };
        const origin = options.origin ? { ...options.origin } : undefined;
        const memory = origin?.agentName ? this.plugin?.agentManager?.getAgentMemory?.(origin.agentName) : null;
        const chat = this.plugin?.env?.settings?.pkmAssistant?.chat as { apiKeys?: Record<string, unknown> } | undefined;
        const knownSecrets = Object.values(chat?.apiKeys || {}).filter((v): v is string => typeof v === 'string' && v.length > 0);

        try {
            // Limity z config/limits.js - JEDNO źródło prawdy. Per sub-agent config
            // nadal wygrywa; getLimits() daje aktualne kanoniczne defaulty (patrz limits.ts).
            const limits = thread
                ? thread.config.limits as ReturnType<typeof getLimits>
                : getLimits(this.plugin?.env?.settings);
            const effectiveLimits = _effectiveSubLimits(config, limits);
            const maxResultLen = effectiveLimits.maxToolResultLength;
            // Sufit delegate/agent_delegate nie może być NIŻSZY niż
            // sufit tego suba (patrz komentarz przy `_deliverableResultCap`).
            const deliverableResultCap = _deliverableResultCap(maxResultLen, limits.subagent_result_max_chars);
            // Trace pętli sub-agenta → .pkm-assistant/logs/trace.log.
            // traceLog przychodzi z plugin (DI z DelegateTool); suby dostają trace za darmo, bez hooków.
            // Etykieta `sub/<nazwa|rola>#<nr wywołania>` - konwencja pętli głównej
            // (`chat/<agent>#<id sesji>`, `harness/<agent>#<runId>`). Bez numeru N równoległych
            // workerów z jednego `delegate` pisało pod wspólną etykietą i nie dało się ich rozdzielić.
            // Czytelnicy trace dopasowują etykietę PREFIKSOWO (patrz `scenarios/_asserts.ts` w repo harnessu).
            const label = `sub/${config.name || config.role || 'sub'}#${(++_subCallSeq).toString(36)}`;
            const loopLimits = {
                maxIterations: effectiveLimits.maxIterations,
                minIterations: config.min_iterations || 1,
                perCallTimeoutMs: options.modelTimeout || config.model_timeout || limits.delegation_timeout_ms,
                maxToolResultLength: maxResultLen,
                // Watchdog ciszy (chunk przezbraja budzik) + skrót dorobku przy padzie
                // finalnej syntezy. Zegar ścienny wyżej zostaje awaryjnym sufitem.
                stallTimeoutMs: limits.subagent_stall_timeout_ms,
                salvageMaxChars: limits.subagent_salvage_max_chars,
                synthesisTimeoutMs: limits.model_synthesis_timeout_ms,
                // Ten sam sufit obowiązuje też W PĘTLI SUBA: wynik zagnieżdżonej delegacji
                // (sub deleguje głębiej, max_delegation_depth > 1) to DELIVERABLE, nie zrzut
                // narzędzia - dokładnie ten sam wyjątek co w turze czatu (chat_streaming.ts),
                // z tego samego źródła configu. Bez tego wracałby przycięty wspólnym 15k.
                // NIE przelot wprost jak w czacie - czat nie ma per-agent
                // override, sub ma (`config.max_tool_result_length`), więc mapa nie może nikomu
                // obniżyć sufitu; `_deliverableResultCap` bierze większy z dwóch (zero = bez limitu).
                maxToolResultLengthPerTool: {
                    delegate: deliverableResultCap,
                    agent_delegate: deliverableResultCap,
                },
            };
            // Bieg suba zakładany w rejestrze POD TĄ SAMĄ etykietą co w trace -
            // id taska = etykieta trace. Rejestr rozsyła kroki do konsumentów, a pierwszym
            // konsumentem jest trace.log (subskrypcja w SubTaskRegistry), więc format linii
            // nie zmienia się o bajt. Bez rejestru (stary plugin / test bez DI) lecimy
            // ścieżką dotychczasową: trace prosto z `traceLog.scope`.
            //
            // Byt zakładamy NA SAMYM POCZĄTKU - przed budową promptu i przed pierwszym
            // `await`. Delegacja w tle oddaje modelowi `task_id`, więc identyfikator musi
            // istnieć, zanim cokolwiek długiego się zacznie (budowa promptu sięga do dysku).
            const threadId = thread?.threadId ?? (registry ? label : undefined);
            if (registry && !thread) {
                const owner = { agentName: origin?.agentName || agent.name, sessionPath: origin?.sessionPath, sessionEpoch: origin?.sessionEpoch };
                const frozenConfig = { subConfig: structuredClone(config), options: { delegationDepth, scopeFolders: scopeFolders ? [...scopeFolders] : undefined, callerToolNames: options.callerToolNames ? [...options.callerToolNames] : undefined, modelTimeout: options.modelTimeout, autonomy }, toolNames: this._resolveToolNames(config), limits: { ...limits }, model: config.model || null, modelId: model.modelId, providerId: model.providerId };
                thread = _safeRegistry(() => registry.createThread?.({ threadId: label, name: config.name || config.role || 'sub', owner, origin: origin ?? { agentName: owner.agentName }, config: frozenConfig }));
            }
            subTask = registry
                ? _safeRegistry(() => registry.create?.({
                    id: label,
                    name: config.name || config.role || 'sub',
                    agentName: agent.name,
                    budget: {
                        maxIterations: loopLimits.maxIterations,
                        perCallTimeoutMs: loopLimits.perCallTimeoutMs,
                        maxToolResultLength: loopLimits.maxToolResultLength,
                    },
                    ...(options.background !== undefined ? { background: options.background } : {}),
                    ...(options.origin ? { origin: options.origin } : {}),
                    // Panel pokazuje, PO CO bieg wystartował. Skrót zadania,
                    // nie pełny prompt — sufit i maska siedzą w rejestrze.
                    taskPreview: taskPrompt,
                    ...(threadId ? { threadId } : {}),
                }))
                : undefined;
            // „Byt istnieje" - hak dla wołacza (DelegateTool), pod tym samym bezpiecznikiem
            // co reszta księgowości. Bez rejestru nie ma czego zgłaszać, więc hak milczy.
            if (subTask && typeof options.onTaskCreated === 'function') {
                _safeRegistry(() => options.onTaskCreated!(subTask as SubTask));
            }
            // Tee też pod bezpiecznikiem (kontrakt: KAŻDE wołanie rejestru przez _safeRegistry) —
            // rejestr bez `traceFor` nie może wywrócić suba; wtedy spadamy na trace wprost.
            // `subTask as SubTask`: narrowing z `(registry && subTask)` nie przeżywa domknięcia
            // przekazanego do `_safeRegistry` (TS gubi zawężenie zmiennej `let` w zagnieżdżonej
            // strzałce) - ten sam wzorzec co `onTaskCreated!(subTask as SubTask)` wyżej.
            const traceTee = (registry && subTask)
                ? _safeRegistry(() => registry.traceFor?.(subTask as SubTask))
                : undefined;
            const trace = traceTee || this.plugin?.traceLog?.scope?.(label);

            // Pętla stawia `status:'error'` na kroku `tool.post` WYŁĄCZNIE po
            // wyjątku egzekutora, a egzekutor suba z kontraktu nie rzuca - bez osobnego
            // znacznika bieg, w którym padło każde narzędzie, wyglądałby w trace.log
            // i w pasku biegów jak bieg udany (`detailFromPost` w subTaskPanelModel potrzebuje
            // realnej gałęzi błędu, nie martwej). Znacznik liczy
            // `_executeTool` (ta sama funkcja, co status chipa w czacie), a doklejamy go do
            // KROKU PĘTLI, żeby nie mnożyć wpisów `tool.post` i nie zawyżać licznika wywołań.
            // Parowanie po KOLEJNOŚCI: pętla startuje wywołania w kolejności tablicy i emituje
            // dokładnie jeden `tool.post` na wywołanie, w tej samej kolejności.
            let toolCallSeq = 0;
            let toolPostSeq = 0;
            const failedToolCalls = new Set<number>();
            const loopTrace = trace
                ? (type: string, fields: Record<string, unknown> = {}) => {
                    if (type !== 'tool.post') return trace(type, fields);
                    const failed = failedToolCalls.delete(toolPostSeq++);
                    return trace(type, failed ? { ...fields, status: 'error' } : fields);
                }
                : trace;

            // Resolve tools: config.tools → role defaults
            const frozenTools = thread?.config.toolNames;
            const toolNames = Array.isArray(frozenTools) ? frozenTools as string[] : this._resolveToolNames(config);
            const visibleToolNames = _canDelegateAtDepth(delegationDepth, limits.max_delegation_depth)
                ? toolNames
                : toolNames.filter((name) => name !== 'delegate' && name !== 'agent_delegate');
            const tools = this._getTools(visibleToolNames, agent, options.callerToolNames);
            // Fail-closed whitelist: the sub-agent may ONLY execute tools that
            // survived the parent∩sub intersection in _getTools. _executeTool enforces this
            // so the direct-execution fallback cannot run a tool outside the whitelist.
            const allowedToolNames = new Set<string>(tools.map((td) => td.function.name));

            const systemPrompt = await this._buildTaskPrompt(agent, config, delegationDepth, limits);

            const nextTask = options.threadId ? t('subagent.thread_next_task', { task: taskPrompt }) : taskPrompt;
            if (options.threadId && thread) {
                for (const effect of thread.effects) {
                    if (effect.outcome === 'returned' || effect.outcome === 'unknown') {
                        if (effect.expectedCheck) effect.check = await this._checkEffect({ ...effect, check: effect.expectedCheck }, agent.name);
                    }
                }
            }
            const effectsNote = thread?.effects.map(effect => {
                const target = effect.targets.map(x => x.path || x.kind).join(', ');
                if (effect.outcome === 'unknown') return t('subagent.thread_effect_unknown', { tool: effect.tool });
                if (effect.check === 'matches') return t(effect.action === 'delete' ? 'subagent.thread_effect_deleted' : 'subagent.thread_effect_saved', { target });
                if (effect.check === 'mismatch') return t(effect.action === 'delete' ? 'subagent.thread_effect_present' : 'subagent.thread_effect_missing', { target });
                return t('subagent.thread_effect_unchecked', { target });
            }).join('\n') ?? '';
            const transcript = thread?.transcript.map(m => structuredClone(m)) ?? [];
            const messages = [{ role: 'system' as const, content: systemPrompt }, ...transcript, { role: 'user' as const, content: `${nextTask}${options.threadId && effectsNote ? `\n${effectsNote}` : ''}` }];

            if (thread && !options.threadId) thread.config.toolNames = tools.map(tool => tool.function.name);
            if (thread && options.threadId) {
                const budget = Number((thread.config.limits as Record<string, unknown> | undefined)?.subagent_thread_context_tokens) || getLimits(this.plugin?.env?.settings).subagent_thread_context_tokens;
                const serialized = JSON.stringify(messages);
                const answerMargin = SUB_AGENT_MAX_OUTPUT_TOKENS;
                if (countTokens(serialized) + answerMargin > budget) {
                    const refusal = t('subagent.thread_refused');
                    const refusedOutcome = classifyRunEnd({ stoppedBy: 'error', failed: true });
                    _safeRegistry(() => registry?.endRun?.(thread!.threadId, { successful: false }));
                    if (subTask) _safeRegistry(() => registry?.fail?.(subTask as SubTask, refusal, refusedOutcome));
                    return { result: refusal, toolsUsed: [], toolCallDetails: [], duration: Date.now() - startTime, usage: null, stoppedBy: 'error', failed: true, outcome: refusedOutcome };
                }
            }

            // Wspólna pętla (runAgentLoop). Store = ArrayMessageStore (system+user).
            // resolveTools = zamrożona lista jak dotąd. Obcinanie wyniku narzędzia przejmuje
            // pętla (limits.maxToolResultLength) - _executeTool już nie truncuje.
            const store = new ArrayMessageStore(messages);
            conversationStore = store;
            // JEDYNY hak, jaki suby podpinają do pętli. `beforeContinue` leci przed KAŻDYM
            // kolejnym wywołaniem modelu, więc wiadomość wrzucona przez agenta zlecającego do rejestru
            // (panel biegów → `postMessage`) wchodzi do transkryptu suba dokładnie tam, gdzie
            // model ją przeczyta - jak nudge, a nie jak przerwanie w połowie zdania.
            // Bez rejestru (testy jednostkowe, stary bootstrap) hak NIE JEST podpinany.
            const steerHooks = (registry && subTask)
                ? {
                    beforeContinue: () => {
                        const pending = _safeRegistry(() => registry.takeMessages?.(subTask!.id) as string[] | undefined);
                        if (!Array.isArray(pending) || pending.length === 0) return;
                        store.appendUser(`${t('subagent.steer_prefix')}\n${pending.join('\n')}`);
                    },
                }
                : null;
            const response = await runAgentLoop({
                // TS-boundary: `runAgentLoop` przyjmuje własny, WĄSKI strukturalny kontrakt
                // (`LoopModelLike`, nieeksportowany — `modules/agent-loop` świadomie NIE zależy od
                // `modules/models`, patrz komentarz przy `LoopModelLike` w AgentLoop.ts), którego
                // handlery i kształt odpowiedzi nie unifikują się nominalnie z `ChatModel.stream`
                // (handlery opcjonalne vs wymagane, `NormalizedError` nie jest `Error`,
                // `OpenAiCompletion` vs `ModelResponse` — dwie niezależnie zadeklarowane, ale
                // operacyjnie zgodne odpowiedzi API). Cast na typie eksportowanym z barrela
                // (`RunAgentLoopOptions['model']`), nie `as never` — zawęzi się sam, gdy
                // `LoopModelLike` dostanie kiedyś realną unifikację (poza tą falą). Runtime bez
                // zmian — to zawsze ten sam obiekt `ChatModel`.
                model: model as RunAgentLoopOptions['model'],
                store,
                resolveTools: () => tools,
                // Numer wywołania łapiemy PRZY STARCIE (kolejność tablicy pętli),
                // a nie przy zakończeniu - wywołania jednego batcha rozstrzygają się równolegle.
                executeToolCall: async (toolCall, runtimeContext) => {
                    const seq = toolCallSeq++;
                    let args: unknown = toolCall.arguments;
                    if (typeof args === 'string') {
                        try { args = JSON.parse(args); } catch { /* Zachowaj skrót surowych argumentów. */ }
                    }
                    const detail = { name: toolCall.name ?? '', args, resultPreview: '' };
                    observedToolDetails[seq] = detail;
                    const result = await this._executeTool(toolCall as ToolCall, agent.name, allowedToolNames,
                        { delegationDepth, scopeFolders: scopeFolders as string[], autonomy },
                        () => { failedToolCalls.add(seq); }, runtimeContext,
                        { start: (args) => beginEffect(seq, toolCall.name ?? '', args),
                            complete: (args, result, failed) => completeEffect(seq, toolCall.name ?? '', args, result, failed),
                            fail: () => failEffect(seq) });
                    detail.resultPreview = _maskHandoffText(result, knownSecrets).slice(0, 500);
                    return result;
                },
                ...(steerHooks ? { hooks: steerHooks } : {}),
                // Delegate po SWOIM timeoucie ubija bieg suba, żeby sub nie wisiał w tle bez końca
                // (abort streamu robi stopStream z kontrolki; flaga zatrzymuje pętlę między
                // iteracjami, żeby porzucony sub nie mielił dalej na narzędziach).
                ...(options.shouldAbort ? { shouldAbort: options.shouldAbort } : {}),
                // Przelot sygnału bramki do wołacza (DelegateTool uzbraja nim budzik zadania).
                ...(options.onGateAdmitted ? { onGateAdmitted: options.onGateAdmitted } : {}),
                ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
                ...(options.abortReason ? { abortReason: options.abortReason } : {}),
                knownSecrets,
                callbacks: { partial: (snapshot) => {
                    // AgentLoop publikuje partial po zakończeniu wywołań narzędzi.
                    // Odbiorca zdarzenia może rozstrzygnąć wiszące narzędzie synchronicznie.
                    closeEffects(snapshot.stopReason);
                    snapshot = JSON.parse(maskSensitiveData(JSON.stringify(snapshot)).replace(/\b(https?:\/\/)[^\s/@"\\]+@/gi, '$1[REDACTED]@')) as AgentLoopPartialSnapshot;
                    lastPartial = snapshot;
                    if (subTask) _safeRegistry(() => registry?.publishPartial?.(subTask as SubTask, snapshot));
                    if (origin) {
                        partialPersistence = partialPersistence.then(async () => {
                            if (!memory?.appendSessionEvent || !origin.sessionPath) throw new Error('missing frozen owner');
                            await memory.appendSessionEvent(origin.sessionPath, {
                                type: 'agent_loop_partial', role: 'system', agentName: origin.agentName,
                                content: t('subagent.partial_header', { name: config.name }) + '\n\n' + snapshot.text,
                                result: { owner: origin, run: subTask?.id || label, revision: snapshot.revision, snapshot },
                            });
                        }).catch(() => {
                            if (subTask) {
                                subTask.partialStorageError = true;
                                _safeRegistry(() => registry?.events.emit('task:partial', subTask));
                            }
                        });
                    }
                } },
                trace: loopTrace,
                limits: loopLimits,
                modelOptions: { maxTokens: SUB_AGENT_MAX_OUTPUT_TOKENS, agentName: agent.name },
            });

            closeEffects(response.stopReason);
            await partialPersistence;
            const finalEffects = await finalizeEffects();
            const outcome = classifyRunEnd({ stoppedBy: response.stoppedBy, stopReason: response.stopReason, finalText: response.finalText, partial: lastPartial, stoppedByActor: subTask?.stopRequestedBy, effects: finalEffects, successfulToolResults });
            if (outcome.hasAnswer) store.appendAssistant(response.finalText);
            const handoff = outcome.completeness !== 'unconfirmed'
                ? _buildHandoff(outcome, lastPartial, response.toolCallDetails || [], limits.subagent_salvage_max_chars, knownSecrets)
                : undefined;
            log.info(logTag, `Task DONE: ${response.toolsUsed?.length || 0} tools, ${(response.finalText || '').length} znaków (stop: ${response.stoppedBy})`);
            log.timing(logTag, 'Task', startTime);
            log.groupEnd();
            await this._appendMemoryEvent(agent.name, {
                type: 'subagent_call',
                role: config.role || 'researcher',
                prompt: taskPrompt,
                result: response.finalText || '',
                duration_ms: Date.now() - startTime
            }, origin, memory);
            // Domknięcie bytu wynikiem (status z `stoppedBy`: abort → aborted, reszta → done).
            if (thread) _safeRegistry(() => registry?.endRun?.(thread!.threadId, { successful: true, transcript: store.messages, answer: outcome.hasAnswer ? response.finalText : undefined, effects: finalEffects.map((effect, index) => ({ ...effect, expectedCheck: descriptions.get(effects[index])?.check })), userStop: subTask?.stopRequestedBy === 'user' }));
            if (subTask) {
                _safeRegistry(() => registry?.finish?.(subTask as SubTask, {
                    text: response.finalText || '',
                    toolsUsed: response.toolsUsed || [],
                    durationMs: Date.now() - startTime,
                    usage: response.usage || null,
                    stoppedBy: response.stoppedBy,
                    stopReason: response.stopReason,
                    outcome,
                    ...(handoff ? { handoff } : {}),
                }));
            }
            return {
                result: response.finalText || '',
                toolsUsed: response.toolsUsed || [],
                toolCallDetails: response.toolCallDetails || [],
                duration: Date.now() - startTime,
                usage: response.usage || null,
                // Sposób zejścia nie ginie na granicy runnera: bez tego pola wołacz
                // (`DelegateTool` → agent zlecający) nie miałby JAK odróżnić suba, który
                // zadanie domknął, od suba, któremu skończyły się iteracje i oddał
                // zaślepkę backstopu.
                stoppedBy: response.stoppedBy,
                partial: lastPartial,
                stopReason: response.stopReason,
                outcome,
                ...(handoff ? { handoff } : {}),
            };
        } catch (error) {
            closeEffects(lastPartial?.stopReason);
            const safeErrorMsg = knownSecrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), _extractSafeErrorMessage(error));
            log.error(logTag, 'Task FAIL:', safeErrorMsg);
            await partialPersistence;
            const finalEffects = await finalizeEffects();
            const outcome = classifyRunEnd({ stoppedBy: 'error', failed: true, stopReason: lastPartial?.stopReason, finalText: '', partial: lastPartial, stoppedByActor: subTask?.stopRequestedBy, effects: finalEffects, successfulToolResults });
            const handoff = outcome.completeness !== 'unconfirmed'
                ? _buildHandoff(outcome, lastPartial, observedToolDetails, getLimits(this.plugin?.env?.settings).subagent_salvage_max_chars, knownSecrets)
                : undefined;
            log.groupEnd();
            // TEN SAM kształt bloku co przy udanym biegu (`subagent_call`) - te same pola
            // nagłówka, status niesie treść `result`. Bez typu `subagent_error` znanego
            // `roleFromEvent` parser pliku sesji pomijałby cały blok: padnięty bieg
            // znikałby z odtworzonej rozmowy i z pamięci długoterminowej. Zdanie jest to samo,
            // które dostaje agent zlecający - plik sesji i wołacz mówią jedno.
            await this._appendMemoryEvent(agent.name, {
                type: 'subagent_error',
                role: config.role || 'researcher',
                prompt: taskPrompt,
                result: t('subagent.error', { name: config.name, error: safeErrorMsg }),
                duration_ms: Date.now() - startTime
            }, origin, memory);
            // Bieg mógł się nie założyć (błąd przed `create`) - wtedy nie ma czego domykać.
            if (thread) _safeRegistry(() => registry?.endRun?.(thread!.threadId, { successful: false, transcript: conversationStore?.messages, userStop: subTask?.stopRequestedBy === 'user' }));
            if (subTask) {
                const failedTask = subTask;
                _safeRegistry(() => registry?.fail?.(failedTask, safeErrorMsg, outcome, {
                    text: '', toolsUsed: [...(lastPartial?.toolsUsed || [])], durationMs: Date.now() - startTime,
                    usage: lastPartial?.usage || null, outcome, ...(handoff ? { handoff } : {}),
                }));
            }
            return {
                result: t('subagent.error', { name: config.name, error: safeErrorMsg }),
                toolsUsed: [...(lastPartial?.toolsUsed || [])],
                toolCallDetails: [...(lastPartial?.toolCallDetails || [])],
                duration: Date.now() - startTime,
                usage: lastPartial?.usage || null,
                // JEDYNE miejsce, w którym `failed` się pojawia. `DelegateTool` czyta tę
                // flagę i oddaje modelowi uczciwe `success:false` zamiast sukcesu z tekstem
                // błędu w środku - bez flagi agent zlecający referowałby błąd jako wynik.
                stoppedBy: 'error',
                failed: true,
                partial: lastPartial,
                stopReason: lastPartial?.stopReason,
                outcome,
                ...(handoff ? { handoff } : {}),
            };
        }
    }

    /**
     * Dziennik biegu → plik aktywnej sesji WŁAŚCICIELA biegu.
     *
     * `agentName` to agent, dla którego bieg wystartował - zamrożony
     * w chwili zlecenia (argument `runTask(…, agent, …)`, ten sam, który ląduje w `SubTask.agentName`).
     * Gdyby adresatem był `getActiveMemory()` (agent AKURAT wybrany w UI), delegacja z czatu
     * leci zawsze w tle, więc jedno przełączenie zakładki wsypywałoby treść zlecenia
     * i cały wynik suba do `sessions/active/` obcego agenta.
     *
     * Fail-closed: agent bez wpisu w `agentMemories` (pad inicjalizacji, skasowany w trakcie biegu)
     * NIE dostaje podstawionej cudzej pamięci - po prostu nie zapisujemy dziennika.
     */
    async _appendMemoryEvent(agentName: string, event: Record<string, unknown>, origin?: SubTaskOrigin, frozenMemory?: RunnerAgentMemory | null): Promise<void> {
        try {
            if (origin) {
                if (!frozenMemory?.appendSessionEvent || !origin.sessionPath) return;
                await frozenMemory.appendSessionEvent(origin.sessionPath, { ...event, agentName: origin.agentName, timestamp: new Date().toISOString() });
                return;
            }
            const memory = agentName
                ? this.plugin?.agentManager?.getAgentMemory?.(agentName)
                : null;
            if (!memory?.appendToActiveSession) return;
            await memory.appendToActiveSession({
                ...event,
                agentName,
                timestamp: new Date().toISOString()
            });
        } catch { /* memory journaling must not break sub-agent execution */ }
    }

    /**
     * Resolve which tool names this sub-agent should use.
     * Uses config.tools or role defaults.
     */
    _resolveToolNames(config: Pick<SubAgentData, 'tools'>): string[] {
        // Jeden generyczny worker - jednolity domyślny zestaw narzędzi dla wszystkich subów.
        // config.tools (z YAML custom suba) nadal wygrywa. Przecięcie z uprawnieniami rodzica
        // (parent∩sub) robi _getTools. read/list mają scope vault|memory.
        // Martwy kanał extraTools/allowExtraTools WYCIĘTY (flaga nigdy nie była podawana).
        const toolNames = [...(config.tools || DEFAULT_SUB_AGENT_TOOLS)];

        // Przemapowuje deprecated nazwy na kanoniczne (vault_grep → search itd.) + dedup,
        // żeby whitelist nie wypadła pusta gdy config trzyma starą nazwę.
        const seen = new Set<string>();
        return toolNames
            .map((name) => DEPRECATED_TOOL_RENAMES[name as keyof typeof DEPRECATED_TOOL_RENAMES] || name)
            .filter(name => (seen.has(name) ? false : (seen.add(name), true)));
    }

    /**
     * Build the sub-agent system prompt - THIN template (jeden szablon dla wszystkich).
     * „Piecz metodę, pulluj dane": sub NIE dostaje pamięci rodzica pushem (brak brain
     * injection). Jeśli potrzebuje pamięci - czyta ją sam (search/read/list scope=memory,
     * pamięć własnego agenta) albo dostaje istotny fragment od rodzica w `context`.
     * `config.prompt` (metoda custom suba z KNOWLEDGE.md) ma miękki cap z `config/limits.js`
     * (`subagent_prompt_max_chars`, default 24000) - obrona przed encyklopediami, ale
     * konfigurowalna: instrukcja jest karmą dla modelu, nie wynikiem narzędzia.
     * Rola nie steruje treścią promptu.
     */
    async _buildTaskPrompt(agent: AgentLike, config: SubAgentData, delegationDepth = 0, frozenLimits?: ReturnType<typeof getLimits>): Promise<string> {
        // Limity czytamy RAZ - ten sam obiekt karmi cap instrukcji i blok BUDŻET niżej,
        // więc prompt nie może obiecać modelowi czegoś innego, niż realnie dostał.
        const limits = frozenLimits ?? getLimits(this.plugin?.env?.settings);
        // Cap instrukcji custom suba to budżet
        // `subagent_prompt_max_chars` (default 24000), zmienialny w Ustawieniach → Limity.
        const configPromptCap = limits.subagent_prompt_max_chars;

        // The fixed frame (header/pull/ZASADY) lives in framePrompt.js and is overridable
        // (agent>global>factory). The mechanical sections below are still composed here and injected.
        // TS-boundary: `resolveWorkPrompt` czyta WYŁĄCZNIE `settings.pkmAssistant.promptDefaults`
        // (`WorkPromptSettings`, core/utils/workPromptResolver.ts) - węższy kontrakt niż realny
        // `SettingsBag` (którego `pkmAssistant.promptDefaults` schodzi przez otwarty indeks
        // `[key: string]: unknown` w `PkmAssistantSettings`, więc nominalnie się nie unifikuje).
        // Rama idzie za JĘZYKIEM INTERFEJSU i liczy się RAZ NA BIEG (tu), nie przy imporcie -
        // `setLocale()` leci z `src/main.ts` dopiero po załadowaniu modułów.
        const frame = resolveWorkPrompt(agent, 'subagent_frame_prompt', this.plugin?.env?.settings as WorkPromptSettings | undefined, defaultSubAgentFramePrompt());

        // METHOD — custom sub method (KNOWLEDGE.md), soft cap z limits.
        let methodBlock = '';
        if (config.prompt) {
            const method = config.prompt.length > configPromptCap
                ? config.prompt.slice(0, configPromptCap) + `\n${t('subagent.frame.method_truncated', { count: configPromptCap })}`
                : config.prompt;
            methodBlock = `${method}\n`;
        }

        // SCOPE — only when the custom sub defines it. Nagłówek `SCOPE:` zostaje dosłowny
        // w obu językach (i tak jest angielski); tłumaczą się etykiety i wartości puste.
        let scopeBlock = '';
        if (config.scope) {
            const folders = config.scope.folders?.length ? config.scope.folders.join(', ') : t('subagent.frame.scope_no_folders');
            const sections = config.scope.sections?.length ? config.scope.sections.join(', ') : t('subagent.frame.scope_no_sections');
            const pinned = config.scope.pinned_notes?.length ? config.scope.pinned_notes.join(', ') : t('subagent.frame.scope_no_pinned');
            const frontmatter = config.scope.frontmatter && Object.keys(config.scope.frontmatter).length
                ? JSON.stringify(config.scope.frontmatter)
                : t('subagent.frame.scope_no_frontmatter');
            // Foldery są egzekwowane technicznie (bariera w łańcuchu uprawnień), reszta
            // pól scope to nadal wskazówki. Model ma to wiedzieć, żeby nie próbował ich obchodzić.
            const foldersNote = config.scope.folders?.length
                ? ` ${t('subagent.frame.scope_folders_enforced')}`
                : '';
            scopeBlock = `SCOPE:\n- ${t('subagent.frame.scope_folders_label')}: ${folders}${foldersNote}\n- ${t('subagent.frame.scope_frontmatter_label')}: ${frontmatter}\n- ${t('subagent.frame.scope_sections_label')}: ${sections}\n- ${t('subagent.frame.scope_pinned_label')}: ${pinned}\n\n`;
        }

        // BUDŻET - spójny z runtime (runTask limits): iteracje + obcięcie wyniku narzędzia +
        // wyjątek delegate/agent_delegate. To zdanie i `loopLimits` w
        // `runTask` MUSZĄ liczyć tą samą funkcją (`_deliverableResultCap`) - inaczej prompt
        // zacznie obiecywać subowi inny sufit niż ten, który realnie egzekwuje pętla.
        const effectiveLimits = _effectiveSubLimits(config, limits);
        const maxIter = effectiveLimits.maxIterations;
        const maxLen = effectiveLimits.maxToolResultLength;
        const delegateCap = _deliverableResultCap(maxLen, limits.subagent_result_max_chars);
        const mayDelegate = _canDelegateAtDepth(delegationDepth, limits.max_delegation_depth);
        const budgetValue = (chars: number | null | undefined) => chars
            ? t('subagent.frame.budget_chars', { count: chars })
            : t('subagent.frame.budget_unlimited');
        const budgetBlock = `${t('subagent.frame.budget_header')}\n${t('subagent.frame.budget_iterations', { count: maxIter })}\n${t('subagent.frame.budget_tool_result', { value: budgetValue(maxLen) })}\n${mayDelegate ? t('subagent.frame.budget_delegate', { value: budgetValue(delegateCap) }) : t('subagent.frame.no_further_delegation')}\n`;

        // Function replacers avoid `$`-sequence interpretation from injected content.
        return frame
            .replace('{{SUB_NAME}}', () => config.name)
            .replace('{{AGENT_NAME}}', () => agent.name)
            .replace('{{DESCRIPTION}}', () => config.description || t('subagent.frame.default_description'))
            .replace('{{METHOD}}', () => methodBlock)
            .replace('{{SCOPE}}', () => scopeBlock)
            .replace('{{BUDGET}}', () => budgetBlock)
            .replace(/\n{3,}/g, '\n\n')
            .trimEnd();
    }

    /**
     * Get tool definitions from registry (filtered by allowed names).
     * sub-agent inherits parent agent's `mcp_servers[]` whitelist
     * (intersection - sub-agent never sees a server the parent agent cannot see).
     * Na piętrze >1 dochodzi TRZECI składnik przecięcia - whitelista
     * suba, który ten bieg zlecił. `parentAgent` jest wtedy nadal agentem GŁÓWNYM, więc samo
     * `filterByAgent` nie chroni: bez tego trzeciego składnika wnuk dostawałby narzędzia,
     * których jego rodzic w ogóle nie ma.
     * @param {string[]} toolNames - Tool names declared by sub-agent config
     * @param {Object} [parentAgent] - Parent agent (for mcp_servers whitelist intersection)
     * @param {string[]} [callerToolNames] - whitelista wołającego suba (koniunkcja).
     * @returns {Array} Tool definitions in OpenAI format
     */
    _getTools(
        toolNames: string[],
        parentAgent: AgentLike | null | undefined,
        callerToolNames?: string[] | null,
    ): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
        if (!toolNames || toolNames.length === 0) return [];

        const parentVisible = parentAgent && typeof this.toolRegistry.filterByAgent === 'function'
            ? new Set<string>(this.toolRegistry.filterByAgent(parentAgent).map((t) => t.name))
            : null;
        const callerVisible = Array.isArray(callerToolNames) && callerToolNames.length > 0
            ? new Set<string>(callerToolNames)
            : null;

        // `as RunnerToolDefinition[]`: TS 5.4 nie zwęża `.filter(Boolean)` (brak predykatu typu w
        // lib.es5.d.ts w tej wersji) - cast na WYNIKU (nie nowy statement, nie zmieniony warunek)
        // trzyma resztę łańcucha bez zmian w emitowanym JS.
        return (toolNames
            .map(name => this.toolRegistry.getTool(name))
            .filter(Boolean) as RunnerToolDefinition[])
            .filter((tool) => !parentVisible || parentVisible.has(tool.name))
            .filter((tool) => !callerVisible || callerVisible.has(tool.name))
            .map(tool => ({
                type: "function",
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema
                }
            }));
    }

    /**
     * Execute a tool call from the sub-agent.
     * Routes through MCPClient for permission/whitelist checks when available.
     * @param {Object} toolCall - { id, name, arguments }
     * @param {string} [agentName] - Agent name for permission context
     * @param {Set<string>} [allowedToolNames] - Fail-closed whitelist (parent∩sub intersection).
     *   When provided, a tool call outside this set is refused BEFORE execution — this closes
     *   the direct-execution fallback that would otherwise run any registered tool when MCPClient
     *   is unavailable.
     * @param {Object} [execOptions] - kaganiec delegacji przenoszony do MCPClient.
     * @param {number} [execOptions.delegationDepth] - piętro delegacji tego suba.
     * @param {string[]|null} [execOptions.scopeFolders] - foldery scope suba (koniunkcja z rodzicem).
     * @param {string|null} [execOptions.autonomy] - tryb pytań ZAMROŻONY przy zleceniu biegu.
     * @param {Function} [onFailure] - sygnał „to wywołanie padło" dla telemetrii
     *   biegu (`runTask` znaczy nim krok `tool.post`). Kontrakt „egzekutor NIE rzuca" zostaje
     *   bez zmian - porażka wraca tekstem do transkryptu suba, a osobno znacznikiem do rejestru.
     * @returns {Promise<string>} Tool result as string.
     *   Obcinanie do max_tool_result_length przejęła pętla (runAgentLoop limits.maxToolResultLength);
     *   ten egzekutor już NIE truncuje — zwraca surowy string.
     */
    async _executeTool(
        toolCall: ToolCall,
        agentName: string,
        allowedToolNames: Set<string> | null = null,
        execOptions: Pick<RunOptions, 'delegationDepth' | 'scopeFolders' | 'autonomy'> = {},
        onFailure?: () => void,
        runtimeContext: ToolExecutionContext = { resultBudgetChars: 0, shouldAbort: () => false },
        effectHooks?: { start(args: unknown): void; complete(args: unknown, result: unknown, failed: boolean): void; fail(): void },
    ) {
        log.debug('SubAgent', `_executeTool: ${toolCall.name} (agent: ${agentName || 'brak'})`);

        // Fail-closed: never execute a tool outside the sub-agent's intersection whitelist,
        // regardless of which execution path (MCPClient or fallback) handles it.
        if (allowedToolNames && !allowedToolNames.has(toolCall.name)) {
            log.warn('SubAgent', `_executeTool ODMOWA (spoza whitelisty rodzic∩sub): ${toolCall.name}`);
            onFailure?.();
            return t('subagent.tool_not_allowed', { name: toolCall.name });
        }

        // Obie ścieżki wykonania mierzą wynik JEDNĄ regułą (`toolResultStatus`).
        // Porażka wraca do transkryptu suba tą samą linią co wyjątek (`subagent.tool_error` -
        // po polsku dosłownie „Błąd narzędzia …"), więc model nie czyta awarii jako zwykłego
        // wyniku; pełny payload zostaje w komunikacie, nic nie ginie. Równolegle zapala się
        // znacznik dla telemetrii biegu (krok `tool.post` w `runTask`).
        const asTranscript = (result: unknown): string => {
            // `generate_image` niesie w SUKCESIE pełny base64 (obraz jest
            // już zapisany w vaulcie i wskazany przez `path`/`note_path`) - czat go wycina przed
            // wstawieniem do transkryptu (`chat_streaming.ts` - `delete copy.base64`), tu ta sama
            // normalizacja jest potrzebna osobno. Sama normalizacja co w czacie, tylko bez gałęzi
            // vision (sub nie renderuje obrazów inline - base64 nie ma tu żadnego konsumenta).
            const sanitized = stripImageBase64ForTranscript(toolCall.name, result);
            const text = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
            const boundedError = _isBoundedReadTextError(toolCall, sanitized);
            if (toolResultStatus(sanitized) !== 'error' && !(boundedError && sanitized === 'B')) return text;
            onFailure?.();
            if (boundedError) return _maskedBoundedError(sanitized, text, runtimeContext.resultBudgetChars);
            // Komunikat błędu jadący do transkryptu suba idzie przez maskę - tak samo,
            // jak ten z `catch` niżej.
            return t('subagent.tool_error', { name: toolCall.name, error: maskSensitiveData(text) });
        };

        try {
            let describedArgs: unknown = toolCall.arguments;
            if (typeof describedArgs === 'string') {
                try { describedArgs = JSON.parse(describedArgs); } catch { /* MCPClient validates arguments. */ }
            }
            // Route through MCPClient for permission + whitelist enforcement.
            // sub-agent dziedziczy tryb PYTAŃ po turze, która go zleciła.
            // Wartość jest ZAMROŻONA w `execOptions.autonomy` (podaje ją
            // `runTask` z opcji zlecenia). Globalne lustro `plugin.currentAutonomy` zostaje
            // wyłącznie jako fallback dla starych wołaczy, którzy autonomii nie przekazują -
            // czytane w trakcie biegu dawałoby subowi tryb zakładki, na którą user właśnie przeskoczył.
            if (this.mcpClient && agentName) {
                const result = await this.mcpClient.executeToolCall(toolCall, agentName, {
                    autonomy: execOptions.autonomy ?? this.plugin?.currentAutonomy,
                    // Głębokość delegacji + bariera scope suba jadą z biegu suba do
                    // klienta narzędzi (MCPClient wstrzykuje je dalej: do args / checkPermission).
                    delegationDepth: execOptions.delegationDepth,
                    scopeFolders: execOptions.scopeFolders,
                    resultBudgetChars: runtimeContext.resultBudgetChars,
                    shouldAbort: runtimeContext.shouldAbort,
                    onExecutionStart: () => effectHooks?.start(describedArgs),
                    // Whitelista TEGO suba jedzie dalej jako znacznik,
                    // żeby `delegate` policzył narzędzia wnuka względem niego, nie względem
                    // agenta głównego. Lista jest już przecięciem rodzic∩sub (patrz `runTask`).
                    ...(allowedToolNames ? { callerToolNames: [...allowedToolNames] } : {}),
                });
                const sanitized = stripImageBase64ForTranscript(toolCall.name, result);
                effectHooks?.complete(describedArgs, result,
                    toolResultStatus(sanitized) === 'error' || (_isBoundedReadTextError(toolCall, sanitized) && sanitized === 'B'));
                return asTranscript(result);
            }

            // Fallback: direct execution (when MCPClient unavailable). Ta ścieżka wywołuje
            // `tool.execute()` wprost - omija `PermissionSystem.checkPermission`
            // w całości (foldery, No-Go, admin_access, oś akcji), nie tylko `scopeFolders`. Jedyną
            // ochroną tutaj jest whitelista NAZW narzędzi wyżej. Gdy wołacz podał `scopeFolders`
            // (zamierzał ograniczyć suba do konkretnych folderów), fail-open by cicho podmieniło
            // "zakres suba" na "cały vault" - fail-closed jest bezpieczniejsze niż milczące
            // rozszerzenie dostępu. Brak `scopeFolders` w execOptions (dawne zachowanie, testy
            // whitelisty) przechodzi bez zmian.
            if (Array.isArray(execOptions.scopeFolders) && execOptions.scopeFolders.length > 0) {
                log.warn('SubAgent', `_executeTool ODMOWA (fallback bez MCPClient nie umie wyegzekwować scopeFolders): ${toolCall.name}`);
                onFailure?.();
                return t('subagent.tool_scope_unenforceable', { name: toolCall.name });
            }

            log.warn('SubAgent', `_executeTool fallback (brak MCPClient): ${toolCall.name}`);
            const tool: RunnerToolDefinition | null = this.toolRegistry.getTool(toolCall.name);
            if (!tool) {
                onFailure?.();
                return t('subagent.tool_not_found', { name: toolCall.name });
            }

            let args = toolCall.arguments;
            if (typeof args === 'string') {
                args = JSON.parse(args);
            }
            // Ta ścieżka omija MCPClient, więc sama musi dołożyć znacznik głębokości -
            // inaczej `delegate` wołany tędy startowałby zawsze od zera (rekurencja bez kagańca).
            if (args && typeof args === 'object' && !Array.isArray(args)) {
                const trustedArgs: Record<string, unknown> = { ...(args as Record<string, unknown>), _invocationAgentName: agentName };
                // The fallback has no MCP identity/scope context. Remove every runtime marker
                // the model could have forged, then re-add only values owned by this runner.
                delete trustedArgs._invocationOrigin;
                delete trustedArgs._invocationAutonomy;
                delete trustedArgs._invocationScopeFolders;
                delete trustedArgs._invocationToolNames;
                delete trustedArgs._invocationDelegationDepth;
                if ((execOptions.delegationDepth as number) > 0) {
                    trustedArgs._invocationDelegationDepth = execOptions.delegationDepth;
                }
                if (execOptions.autonomy) trustedArgs._invocationAutonomy = execOptions.autonomy;
                if (allowedToolNames) trustedArgs._invocationToolNames = [...allowedToolNames];
                args = trustedArgs;
            }
            const requestedBudget = runtimeContext.resultBudgetChars > 0 ? runtimeContext.resultBudgetChars : 0;
            effectHooks?.start(args);
            const result = await tool.execute(args, this.app, this.plugin, {
                resultBudgetChars: requestedBudget,
                effectiveResultBudgetChars: requestedBudget > 0 ? Math.min(requestedBudget, 12000) : 12000,
                shouldAbort: runtimeContext.shouldAbort,
                // Direct fallback has no full PermissionSystem invocation context. New file reads
                // must fail closed here instead of treating this runner path as an authorization.
                authorizeFileRead: () => ({ allowed: false, reason: 'Permission context unavailable' }),
                serializeFinalResult: (candidate) => JSON.stringify(candidate) ?? '',
            });
            const sanitized = stripImageBase64ForTranscript(toolCall.name, result);
            effectHooks?.complete(args, result,
                toolResultStatus(sanitized) === 'error' || (_isBoundedReadTextError(toolCall, sanitized) && sanitized === 'B'));
            return asTranscript(result);
        } catch (error) {
            effectHooks?.fail();
            onFailure?.();
            // Błąd narzędzia wraca do transkryptu suba - też przez maskę.
            return t('subagent.tool_error', {
                name: toolCall.name,
                error: maskSensitiveData(String((error as { message?: string }).message ?? error)),
            });
        }
    }
}

/** Preserve secret masking without breaking the bounded JSON error protocol. */
function _maskedBoundedError(result: unknown, text: string, requestedBudget: number): string {
    if (result === 'B') return 'B';
    const budget = requestedBudget > 0 ? Math.min(requestedBudget, 12000) : 12000;
    let masked = maskSensitiveData(text);
    try {
        JSON.parse(masked);
    } catch {
        // The caller already checked the error code against the read/text allowlist.
        // Redaction can cut a JSON escape; do not copy arbitrary error fields back in.
        const error = result as Record<string, unknown>;
        masked = JSON.stringify({
            success: false,
            code: error.code,
            ...(Number.isSafeInteger(error.restart_offset) && (error.restart_offset as number) >= 0
                ? { restart_offset: error.restart_offset } : {}),
            isError: true,
        });
    }
    if (masked.length <= budget) return masked;
    const compact = JSON.stringify({ success: false, code: 'budget_too_small', isError: true });
    return compact.length <= budget ? compact : 'B';
}

function _isBoundedReadTextError(toolCall: ToolCall, result: unknown): boolean {
    const name = toolCall.name;
    let args: unknown = toolCall.arguments;
    if (typeof args === 'string') {
        try { args = JSON.parse(args) as unknown; } catch { args = null; }
    }
    const record = result && typeof result === 'object' && !Array.isArray(result)
        ? result as Record<string, unknown>
        : null;
    const isRead = ['read', 'vault_read', 'memory_read', 'memory_read_summary'].includes(name);
    const isTextSearch = (name === 'search' || name === 'vault_grep')
        && !!args && typeof args === 'object' && !Array.isArray(args)
        && (args as Record<string, unknown>).mode === 'text'
        && (args as Record<string, unknown>).scope === 'vault';
    if (!isRead && !isTextSearch) return false;
    if (result === 'B') return true;
    if (record?.success !== false || typeof record.code !== 'string') return false;
    const readCodes = new Set(['read_error', 'budget_too_small', 'file_changed', 'file_missing', 'access_denied', 'invalid_offset', 'invalid_version', 'invalid_args']);
    const textCodes = new Set(['budget_too_small', 'file_missing', 'access_denied', 'read_error', 'unsupported_type', 'invalid_args']);
    return isRead ? readCodes.has(record.code) : textCodes.has(record.code);
}

/**
 * `GenerateImageTool` zwraca w sukcesie pełny base64 zapisanego obrazu
 * (obok `path`/`note_path` - obraz JEST już w vaulcie, base64 jest tu wyłącznie dla ścieżki
 * czatu z vision). Bez tej normalizacji medianowy obraz (~594 000 znaków base64, dane realne
 * z `Attachments/generated`) zjadałby 99% sufitu `max_tool_result_length` transkryptu suba
 * (domyślnie 15000 - `config/limits.ts`), wypychając poza limit `format`/`revised_prompt`/
 * `message`, i byłby budowany od nowa przy KAŻDEJ kolejnej iteracji pętli suba. Tylko
 * `generate_image` - inne narzędzia nie niosą base64 w wyniku. Wejście bez `base64`
 * (błąd, inne narzędzie) wraca bez zmian.
 */
function stripImageBase64ForTranscript(toolName: string, result: unknown): unknown {
    if (toolName !== 'generate_image' || !result || typeof result !== 'object') return result;
    const raw = result as { base64?: unknown };
    if (typeof raw.base64 !== 'string' || raw.base64.length === 0) return result;
    // Rozmiar liczony z długości base64 (4 znaki = 3 bajty) - bez dekodowania. Wzór:
    // `normalizeMcpResult` w `modules/tools/ExternalMcpManager.ts` (adnotacja obrazka z serwerów
    // zewnętrznych MCP).
    const kb = Math.round((raw.base64.length * 3) / 4 / 1024);
    const copy: Record<string, unknown> = { ...(result as Record<string, unknown>) };
    delete copy.base64;
    copy.image = `[image ~${kb} kB - zapisany w vaultcie, patrz path/note_path]`;
    return copy;
}

/**
 * JEDNA granica maskowania dla wszystkich trzech odbiorców błędu
 * (rejestr biegów, plik aktywnej sesji w vaultcie, wynik oddany narzędziu `delegate`).
 * Bez tej wspólnej granicy maskowałby tylko `SubTaskRegistry` - dwie pozostałe drogi
 * woziłyby surowy komunikat, a ten przy zdarzeniu strumienia bez `data` bywa całym
 * `JSON.stringify(event)` razem z nagłówkiem `Authorization`.
 */
function _extractSafeErrorMessage(error: unknown): string {
    return maskSensitiveData(_rawErrorMessage(error));
}

function _rawErrorMessage(error: unknown): string {
    const candidates = [
        (error as ErrLike | null)?.message,
        (error as ErrLike | null)?.error,
        (error as ErrLike | null)?.details?.message,
        (error as ErrLike | null)?.cause?.message,
        error,
    ];

    for (const candidate of candidates) {
        if (candidate === undefined || candidate === null) continue;
        if (typeof candidate === 'string' && candidate && candidate !== '[object Object]') return candidate;
        if (typeof candidate !== 'string') {
            if (typeof (candidate as ErrLike)?.details?.message === 'string' && (candidate as ErrLike).details!.message) {
                return (candidate as ErrLike).details!.message as string;
            }
            if (typeof (candidate as ErrLike)?.message === 'string'
                && (candidate as ErrLike).message
                && (candidate as ErrLike).message !== '[object Object]') {
                return (candidate as ErrLike).message as string;
            }
            try {
                return JSON.stringify(candidate);
            } catch {
                // Cykl w strukturze - JSON.stringify rzucił. Ostatnia deska ratunku: własny
                // toString wartości.
                return _rawToString(candidate);
            }
        }
    }

    return 'Unknown sub-agent error';
}

/**
 * Osobna funkcja graniczna: dopiero jej wywołanie resetuje zawężenie TS z powrotem do gołego
 * `unknown`, więc `String()` tutaj nie zgłasza no-base-to-string (ten sam wzorzec co
 * `_safeStringify` w `core/utils/errorUtils.ts`).
 */
function _rawToString(value: unknown): string {
    return String(value);
}
