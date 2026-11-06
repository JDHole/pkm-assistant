import { redactParentConversationSnapshot } from '../sub-agents/index.js';
import { Validator } from '@cfworker/json-schema';
import type { Schema } from '@cfworker/json-schema';
import type { ReasoningEffort } from '../models/index.js';
/**
 * DelegateTool — v3.0 (Dispatcher Model)
 *
 * Single "delegate" tool for all sub-agent execution.
 * Supports single-task and multi-task (parallel) modes.
 *
 * Flow:
 * 1. Get available sub-agents (always all active, no per-mode filtering)
 * 2. Resolve aspect (explicit name, auto-pick if 1, error if ambiguous)
 * 3. Route to SubAgentRunner with role-appropriate config
 * 4. Return results
 */
import { SubAgentRunner, DEFAULT_SUB_AGENT_TOOLS, PKM_SUB_NAME, allocateSubTaskId, canContinueAfterUserStop, isRuntimeSequence } from '../../modules/sub-agents/index.js';
import type { RunAdmission, AdmissionGroup, SubTaskRegistry, SubThread, Lease, RuntimeSequence, SubRunContext, SubTask, SubTaskOrigin, QuestionId, QuestionState, RunActivity, ParentQuestion } from '../../modules/sub-agents/index.js';
import type { RunOutcome, SubRunResult, ParentConversationContext, ParentConversationMetadata, ParentConversationPreparation } from '../../modules/sub-agents/index.js';
import type { ApprovalManager } from '../../core/index.js';
import type { BuiltinToolExecutionContext } from './ToolRegistry.js';
import { prepareParentConversationDelegation, isPreparedParentDelegationCurrent } from './parentConversationConsent.js';
import type { PreparedParentDelegation } from './parentConversationConsent.js';
import { createModelForRole } from '../../modules/models/index.js';
import type { ModelRole, ResolverPluginLike } from '../../modules/models/index.js';
import { t } from '../../core/i18n/index.js';
// Reguła przecięcia zakresów mieszka tam, gdzie reszta reguł ścieżek.
// `maskSensitiveData` to ta sama granica maskowania, co w `SubAgentRunner`.
import type { AgentLoopPartialSnapshot, AgentLoopStopReason, RunAgentLoopOptions } from '../agent-loop/index.js';
import { AccessGuard, maskSensitiveData, configuredChatSecrets } from '../../core/index.js';
import type { ScopeFolders, PermissionedAgent } from '../../core/index.js';
import { getLimits, DEFAULT_LIMITS } from '../../config/limits.js';
import { log } from '../../core/utils/Logger.js';
import type { PlanReadyDriver } from '../sub-agents/index.js';
import type { DependencyContext } from './delegateDependencyContext.js';

/** Pojedyncze zadanie w trybie wielozadaniowym (`args.tasks[]`). */
export interface DelegateTaskDef {
    task?: string;
    context_mode?: unknown;
    aspect?: string;
    context?: string;
    aspect_explicit?: boolean;
    timeout_ms?: number;
}

/** Argumenty `delegate` wg `inputSchema` (+ znaczniki wstrzykiwane przez `MCPClient`). */
interface DelegateToolArgs extends DelegateTaskDef {
    tasks?: DelegateTaskDef[];
    /** `false` = stara ścieżka blokująca. Brak = TŁO (default, wzór Claude Code). */
    background?: boolean;
    _invocationAgentName?: unknown;
    _invocationDelegationDepth?: unknown;
    /** Adres zwrotny zlecenia - wstrzykiwany przez `MCPClient` (model go nie poda). */
    _invocationOrigin?: unknown;
    _invocationSubRunContext?: SubRunContext;
    /** Tryb autonomii TURY zlecającej - zaufany znacznik od `MCPClient`, zawsze nadpisywany. */
    _invocationAutonomy?: unknown;
    /** `scope.folders` suba ZLECAJĄCEGO - zaufany znacznik od `MCPClient`. */
    _invocationScopeFolders?: unknown;
    /** Whitelista narzędzi suba ZLECAJĄCEGO - zaufany znacznik. */
    _invocationToolNames?: unknown;
    _invocationTurnKind?: unknown;
    _invocationTurnStartedSeq?: unknown;
    _invocationThreadId?: unknown;
    _invocationThreadAccepted?: unknown;
    [extra: string]: unknown;
}

// Continuation is an in-process capability passed only by sub_agent.
const _continuations = new WeakMap<object, { threadId: string; background?: boolean; turnKind?: 'user' | 'machine'; turnStartedSeq?: RuntimeSequence }>();

/**
 * Config sub-agenta widziany przez to narzędzie: część z YAML usera
 * (`resolveSubAgentConfig`), część syntetyczna (`pkm-sub`).
 */
export interface SubAgentConfigLike {
    name: string;
    description: string;
    tools: string[];
    model?: string;
    effort?: ReasoningEffort;
    prompt?: string;
    scope?: { folders?: unknown };
    role?: string;
    max_iterations?: number;
    min_iterations?: number;
    max_tool_result_length?: number;
}

/** Szablon suba z `SubAgentTemplateStore` - kształt zbieżny z configiem. */
interface SubAgentTemplateLike extends Partial<SubAgentConfigLike> {
    name?: string;
    description?: string;
    tools?: string[];
}

/** Custom sub przypięty do agenta (`activeSubAgents`) — rozpoznawany PO NAZWIE. */
interface DelegateEntry {
    name: string;
}

/** Agent wołający w zakresie, jaki czyta to narzędzie. */
interface DelegatingAgent {
    name?: string;
    activeSubAgents?: DelegateEntry[];
}

/** Wbudowane aspekty pary „zwiadowca / robotnik" (rozpoznawane po dokładnej nazwie). */
export type BuiltinAspect = 'explorer' | 'worker';

/**
 * Wynik `_resolveDelegate`: worker generyczny, wbudowany aspekt, custom sub po nazwie
 * albo odmowa. Pola nieobecne w danej gałęzi są jawnie `undefined`, żeby wołacze (i testy)
 * mogły pytać o `.error`/`.delegate` bez zawężania — dokładnie jak w JS.
 */
type ResolvedDelegate =
    | { generic: true; builtin?: undefined; delegate?: undefined; success?: undefined; error?: undefined }
    | { generic?: undefined; builtin: BuiltinAspect; delegate?: undefined; success?: undefined; error?: undefined }
    | { generic?: undefined; builtin?: undefined; delegate: DelegateEntry; success?: undefined; error?: undefined }
    | { generic?: undefined; builtin?: undefined; delegate?: undefined; success: false; error: string };

/** Minimalny widok AgentManagera. */
interface DelegateAgentManager {
    getAgent?(name: string): DelegatingAgent | null | undefined;
    getActiveAgent(): DelegatingAgent | null | undefined;
    resolveSubAgentConfig(name: string, parentAgent: DelegatingAgent): SubAgentConfigLike | null | undefined;
    subAgentTemplateStore?: { get?(slug: string): SubAgentTemplateLike | null | undefined } | null;
}

/** Model czatu w zakresie, jaki sprawdza to narzędzie (obecność `.stream` +
 *  opcjonalnie limit bramki platformy — patrz `_resolveTaskConcurrency`). */
interface StreamingModelLike {
    stream?: unknown;
    modelId?: string;
    providerId?: string;
    /** ChatModel: pojemność bramki równoległości platformy (0 = bez bramki, chmura). */
    _streamGateLimit?: () => number;
}

/**
 * Wynik biegu sub-agenta (`SubAgentRunner.runTask`).
 *
 * `stoppedBy` mówi, JAK sub zszedł z biegu (`natural` = domknął sam, `backstop` = skończyły
 * mu się iteracje, `abort` = ubity z zewnątrz, `error` = wyjątek), a `failed` pojawia się
 * WYŁĄCZNIE, gdy bieg realnie padł - bez tego rozróżnienia błąd suba wracałby do modelu
 * jako `success:true` z komunikatem błędu w polu `result`.
 */
/**
 * `SubAgentRunResult.result` jest `unknown` (kontrakt DI - patrz interfejs niżej), choć w
 * praktyce runner zawsze zwraca string. Guard `null`/`undefined` MUSI zostać w tej funkcji,
 * a właściwy `String()` w OSOBNEJ - dopiero jej granica wywołania resetuje zawężenie TS z
 * powrotem do gołego `unknown` (ten sam wzorzec co `_safeStringify` w `core/utils/errorUtils.ts`).
 */
function _rawResultToString(value: unknown): string {
    return value === null || value === undefined ? '' : _rawToString(value);
}

function _rawToString(value: unknown): string {
    return String(value);
}

interface SubAgentRunResult {
    parentConversation?: ParentConversationPreparation;
    question?: SubRunResult['question'];
    result?: unknown;
    toolsUsed?: unknown;
    toolCallDetails?: unknown[];
    duration?: number;
    usage?: unknown;
    stoppedBy?: string;
    failed?: true;
    partial?: AgentLoopPartialSnapshot;
    stopReason?: AgentLoopStopReason;
    outcome?: RunOutcome;
    handoff?: string;
}

/** Runner sub-agentów w zakresie, jakiego używa to narzędzie. */
interface SubAgentRunnerLike {
    runTask(
        taskPrompt: string,
        parentAgent: DelegatingAgent,
        subAgentConfig: SubAgentConfigLike,
        model: unknown,
        opts: {
            parentConversation?: ParentConversationContext;
            onParentConversationPrepared?: (metadata: ParentConversationPreparation) => void;
            delegationDepth: number;
            scopeFolders: unknown;
            /** Budżet pojedynczego wywołania modelu suba = budżet zadania delegacji. */
            modelTimeout?: number;
            /** Flaga abortu z kontrolki `_withTimeout` — pętla suba staje między iteracjami. */
            shouldAbort?: () => boolean;
            abortSignal?: AbortSignal;
            abortReason?: () => 'manual-stop' | 'task-timeout' | 'superseded';
            /** „Sub wszedł na slot bramki" - tym uzbraja się budzik zadania. */
            onGateAdmitted?: () => void;
            admission?: RunAdmission;
            onActivity?: (activity: RunActivity) => void;
            onQuestion?: (question: ParentQuestion) => void;
            /** Adres zwrotny zlecenia (1:1 do rejestru biegów). */
            origin?: SubTaskOrigin;
            parentId?: string;
            /** Bieg w tle (1:1 do rejestru biegów). */
            background?: boolean;
            /** „Byt już istnieje" - stąd bierzemy `task_id` dla zwrotki w trybie tła. */
            onTaskCreated?: (task: SubTask) => void;
            threadId?: string;
            turnKind?: 'user' | 'machine';
            turnStartedSeq?: RuntimeSequence;
            queuedThreadId?: string;
            reservedRunId?: string;
            /** Tryb pytań tury zlecającej, zamrożony na cały bieg. */
            autonomy?: string | null;
            /** Whitelista narzędzi wołającego suba (trzeci składnik przecięcia). */
            callerToolNames?: string[];
        },
    ): Promise<SubAgentRunResult>;
}

/**
 * Minimalny widok pluginu. `toolRegistry` jest tu tylko warunkiem („runner ma z czego żyć"),
 * więc `unknown` wystarczy — sam rejestr wędruje do `SubAgentRunner`.
 *
 * Przecięcie z `ResolverPluginLike`: TEN SAM obiekt idzie do `createModelForRole`
 * (`modules/models`), więc kontrakt resolvera bierzemy z jego barrela zamiast go przepisywać.
 */
export type DelegatePlugin = NonNullable<ResolverPluginLike> & {
    approvalManager?: Pick<ApprovalManager, 'requestApproval'> | null;
    permissionSystem?: { checkPermission(agent: PermissionedAgent, action: string, target?: string | null, options?: { autonomy?: string | null; scopeFolders?: ScopeFolders | null }): { allowed: boolean } } | null;
    agentManager?: DelegateAgentManager | null;
    /**
     * Rejestr narzędzi. Jego OBECNOŚĆ jest warunkiem odpalenia runnera (rejestr wędruje dalej
     * do `SubAgentRunner`). Dodatkowo dostarcza `filterByAgent` - pełną listę narzędzi
     * rodzica dla wbudowanego aspektu `worker`.
     */
    toolRegistry?: { filterByAgent?(agent: unknown): Array<{ name?: string }>; checkToolAxis?(agent: unknown, name: string): { allowed: boolean } } | null;
    /**
     * Księga biegów subów. Jej OBECNOŚĆ jest warunkiem delegacji w tle.
     * Przyjmuje też uchwyt „zatrzymaj ten bieg" (`attachAbort`) - patrz `_attachStop`.
     * Czytamy z niej kartę biegu (`getTask`) przy strzale budzika i dopisujemy ślad
     * odroczenia (`step`) - patrz `_isInFinalSummary` / grace-okno w `_withTimeout`.
     */
    subTaskRegistry?: {
        acquire?: SubTaskRegistry['acquire'];
        setParentConversation?: SubTaskRegistry['setParentConversation'];
        getRunActivity?: SubTaskRegistry['getRunActivity'];
        reserveContinuation?: SubTaskRegistry['reserveContinuation'];
        events?: SubTaskRegistry['events'];
        attachAbort?: (id: string, fn: () => void) => void;
        getDelegationAncestors?: (context: SubRunContext, agentName: string) => SubTask[] | undefined;
        getTask?: (id: string) => SubTask | undefined;
        step?: (task: SubTask, type: string, fields?: Record<string, unknown>) => void;
        getThread?: (id: string) => import('../sub-agents/index.js').SubThread | undefined;
        listThreads?: (owner: import('../sub-agents/index.js').SubThreadOwner) => import('../sub-agents/index.js').SubThread[];
        postMessage?: (id: string, message: string) => boolean;
        answerParentQuestion?: SubTaskRegistry['answerParentQuestion'];
        getQuestionState?: (id: string) => QuestionState;
        isQuestionOpen?: (id: string, questionId: QuestionId) => boolean;
        promoteToBackground?: (id: string) => boolean;
        requestStop?: (id: string, by: 'lead') => boolean;
        closeThread?: (id: string, by?: 'user' | 'lead' | 'system') => boolean;
        createThread?: (input: { threadId: string; name: string; owner: import('../sub-agents/index.js').SubThreadOwner; origin: SubTaskOrigin; config: Record<string, unknown>; phase: 'queued'; parentId?: string; level?: number; parentConversation?: ParentConversationMetadata }) => import('../sub-agents/index.js').SubThread;
        finishQueuedStop?: (id: string, input: { background?: boolean; taskPreview?: string }) => SubTask | undefined;
        finishQueuedFailure?: (id: string, input: { error: string; background?: boolean; taskPreview?: string }) => SubTask | undefined;
    } | null;
    env?: {
        settings?: {
            pkmAssistant?: { globalSubTemplate?: string; limits?: Record<string, unknown> };
        };
        chatModel?: StreamingModelLike | null;
    } | null;
};

/** DI dla testów: podmiana fabryki runnera (`__test__` + `DelegateTool.test.ts`). */
interface DelegateToolDeps {
    makeRunner?: (plugin: DelegatePlugin) => SubAgentRunnerLike;
}

/**
 * Syntetyczny config fabrycznego workera `pkm-sub`: delegate BEZ aspect.
 * Brak roli, brak config.prompt (żadnej wbudowanej "encyklopedii"), tools = domyślny
 * zestaw workera. Przecięcie z uprawnieniami rodzica (default∩rodzic) robi
 * SubAgentRunner._getTools; limity iteracji/wyniku bierze runner z config/limits.js.
 */
function buildGenericWorkerConfig(): SubAgentConfigLike {
    return {
        name: PKM_SUB_NAME,
        description: t('mcp.delegate.worker_desc'),
        tools: [...DEFAULT_SUB_AGENT_TOOLS],
    };
}

/**
 * Config workera zbudowany z SZABLONU wskazanego jako globalny
 * (`settings.pkmAssistant.globalSubTemplate`). Bierzemy z szablonu to, co realnie steruje biegiem:
 * nazwę, opis, narzędzia, model, instrukcję (KNOWLEDGE.md) i limity iteracji.
 * @param tpl - szablon z SubAgentTemplateStore
 */
function buildWorkerConfigFromTemplate(tpl: SubAgentTemplateLike): SubAgentConfigLike {
    const config: SubAgentConfigLike = {
        name: tpl.name as string,
        description: tpl.description as string,
        tools: (tpl.tools?.length as number) > 0 ? [...(tpl.tools as string[])] : [...DEFAULT_SUB_AGENT_TOOLS],
    };
    if (tpl.model) config.model = tpl.model;
    if (tpl.effort) config.effort = tpl.effort;
    if (tpl.prompt) config.prompt = tpl.prompt;
    if (tpl.scope) config.scope = tpl.scope;
    if (tpl.max_iterations) config.max_iterations = tpl.max_iterations;
    if (tpl.min_iterations) config.min_iterations = tpl.min_iterations;
    if (tpl.max_tool_result_length != null) config.max_tool_result_length = tpl.max_tool_result_length;
    return config;
}

/**
 * Rozwiąż config delegacji BEZ `aspect` (fail-soft).
 * Brak ustawienia / brak szablonu / szablon nie do sparsowania → fabryczny `pkm-sub` + warn.
 * Zła decyzja usera NIGDY nie wywala delegacji — to jest cała idea „odwrotu do pkm-sub".
 * @returns config workera
 */
function resolveGenericWorkerConfig(plugin: DelegatePlugin | null | undefined): SubAgentConfigLike {
    const slug = plugin?.env?.settings?.pkmAssistant?.globalSubTemplate;
    if (!slug) return buildGenericWorkerConfig();
    try {
        const template = plugin?.agentManager?.subAgentTemplateStore?.get?.(slug);
        if (!template?.name || !template?.description) {
            log.warn('DelegateTool', `Globalny szablon suba "${slug}" nie istnieje albo jest niekompletny — używam ${PKM_SUB_NAME}`);
            return buildGenericWorkerConfig();
        }
        return buildWorkerConfigFromTemplate(template);
    } catch (e) {
        log.warn('DelegateTool', `Globalny szablon suba "${slug}" nie do odczytania (${(e as { message?: string })?.message || (e as string)}) — używam ${PKM_SUB_NAME}`);
        return buildGenericWorkerConfig();
    }
}

// ── Wbudowana para „zwiadowca / robotnik" ──────────────
//
// Nazwy syntetycznych configów. Świadomie stałe LOKALNE (a nie w `modules/sub-agents`, jak
// `PKM_SUB_NAME`): te byty istnieją wyłącznie na czas jednego wywołania `delegate`, nie mają
// pliku na dysku, nie przechodzą przez loader i nikt poza tym plikiem ich nie zakłada.
const PKM_EXPLORER_NAME = 'pkm-explorer';
const PKM_WORKER_NAME = 'pkm-worker';

/** Wbudowane aspekty rozpoznawane po DOKŁADNEJ nazwie (bez wielkości liter). */
const BUILTIN_ASPECTS: readonly BuiltinAspect[] = ['explorer', 'worker'];

/**
 * Czy `aspect` to jeden z wbudowanych? Sprawdzane DOPIERO po custom subach usera:
 * własny sub o nazwie „explorer" ma wygrywać z wbudowanym (patrz `_resolveDelegate`).
 */
function _resolveBuiltinAspect(aspect: string): BuiltinAspect | null {
    const key = aspect.trim().toLowerCase();
    return BUILTIN_ASPECTS.find(a => a === key) || null;
}

/**
 * `aspect:"explorer"` - TANI ZWIADOWCA. Read-only zestaw narzędzi (`DEFAULT_SUB_AGENT_TOOLS`)
 * + slot modelu sub-agentów (`researcher`→minion). To dokładnie profil dzisiejszego `pkm-sub`,
 * tyle że wołany świadomie po nazwie: model ma móc powiedzieć „to jest zwiad, nie rób nic więcej".
 */
function buildBuiltinExplorerConfig(): SubAgentConfigLike {
    return {
        name: PKM_EXPLORER_NAME,
        description: t('mcp.delegate.explorer_desc'),
        tools: [...DEFAULT_SUB_AGENT_TOOLS],
        role: 'explorer',
    };
}

/**
 * `aspect:"worker"` - ROBOTNIK KLASY RODZICA. Model rodzica (rola `sub_worker`, patrz
 * `_resolveModelRole`) + PEŁNY zestaw narzędzi rodzica.
 *
 * ⚠️ Listę narzędzi podajemy JAWNIE. Pusty/brakujący `config.tools` NIE znaczy w runnerze
 * „wszystkie" — `SubAgentRunner._resolveToolNames` spada wtedy na `DEFAULT_SUB_AGENT_TOOLS`
 * (czyli read-only), więc robotnik po cichu straciłby zapis. Przecięcie rodzic∩sub w
 * `_getTools` i tak zostaje — tu tylko deklarujemy „chcę tyle, ile ma rodzic".
 *
 * Fail-soft: brak `filterByAgent` / pusta lista / wyjątek → zestaw domyślny. Robotnik bez
 * zapisu jest gorszy, ale delegacja nie ma prawa się wywalić na sondowaniu rejestru.
 */
function buildBuiltinWorkerConfig(
    plugin: DelegatePlugin | null | undefined,
    parentAgent: DelegatingAgent,
    callerToolNames?: string[] | null,
): SubAgentConfigLike {
    // Gdy zleca SUB (piętro ≥1), „klasa rodzica" to jego whitelista,
    // NIE lista agenta głównego. Read-only sub prosił tędy o pełne 23 narzędzia agenta.
    if (Array.isArray(callerToolNames) && callerToolNames.length > 0) {
        return {
            name: PKM_WORKER_NAME,
            description: t('mcp.delegate.builtin_worker_desc'),
            tools: [...callerToolNames],
            role: 'worker',
        };
    }
    let tools: string[] = [...DEFAULT_SUB_AGENT_TOOLS];
    try {
        const visible = plugin?.toolRegistry?.filterByAgent?.(parentAgent);
        const names = Array.isArray(visible)
            ? visible.map(td => td?.name).filter((n): n is string => typeof n === 'string' && n.length > 0)
            : [];
        if (names.length > 0) tools = names;
        else log.warn('DelegateTool', `Nie udało się odczytać narzędzi rodzica dla aspektu "worker" — ${PKM_WORKER_NAME} dostaje zestaw domyślny`);
    } catch (e) {
        log.warn('DelegateTool', `Odczyt narzędzi rodzica dla aspektu "worker" padł (${(e as { message?: string })?.message || (e as string)}) — zestaw domyślny`);
    }
    return {
        name: PKM_WORKER_NAME,
        description: t('mcp.delegate.builtin_worker_desc'),
        tools,
        role: 'worker',
    };
}

/**
 * Która rola modelu obsłuży ten config. `role:'worker'` (wbudowany aspekt ALBO custom sub
 * z takim polem w YAML) = model rodzica; wszystko inne = dotychczasowy slot sub-agentów.
 * `config.model` z YAML wygrywa w obu przypadkach — rozstrzyga `createModelForRole`.
 */
function _resolveModelRole(config: SubAgentConfigLike): ModelRole {
    return config.role === 'worker' ? 'sub_worker' : 'researcher';
}

// Hard fallback when no settings/override is available. Source of truth: config/limits.js.
const DEFAULT_TASK_TIMEOUT_MS = DEFAULT_LIMITS.delegation_timeout_ms;

// Ile ms po strzale budzika czekamy, aż UBITY bieg odda częściowy wynik
// (abort → stream reject → pętla finalize → runner). Ta ścieżka trwa milisekundy -
// 1,5 s to zapas na wolny event loop. Sub złapany w środku długiego NARZĘDZIA i tak
// nie zdąży w żadnym rozsądnym oknie (manifesty deklarują timeout_ms 60-180 s, ale
// dla wbudowanych narzędzi to pole dziś NIE JEST egzekwowane, patrz modules/tools/CLAUDE.md,
// więc zawiśnięcie może trwać znacznie dłużej), więc wtedy uczciwie wraca goła zwrotka
// bez ratowania częściowego dorobku.
const SALVAGE_SETTLE_MS = 1500;

// obsidianmd/prefer-window-timers: ten plik wstaje w gołym Node (testy AVA), gdzie `window`
// nie istnieje — `window.setTimeout` byłby ReferenceError. Inline `eslint-disable` jest
// zablokowany dla `obsidianmd/*` (`eslint-comments/no-restricted-disable` w configu pluginu
// recenzenta katalogu). Owijamy globalny timer FUNKCJĄ zamiast zamrażać referencję raz przy
// imporcie — `fn` czyta `setTimeout`/`clearTimeout` DYNAMICZNIE przy każdym wywołaniu, więc
// zachowanie (w tym testowe podmiany `globalThis.clearTimeout` w DelegateTool.test.ts)
// jest 1:1 jak bezpośrednie wywołanie globala. Reguła pomija wywołanie,
// bo `fn` jest lokalną zmienną, nie globalną referencją.
function _nodeSafeSetTimeout(...args: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> {
    const fn = setTimeout;
    return fn(...args);
}
function _nodeSafeClearTimeout(...args: Parameters<typeof clearTimeout>): void {
    const fn = clearTimeout;
    fn(...args);
}

/**
 * Mapper dorobku dla `_withTimeout`. Dostaje wartość, którą wyścig oddał PO strzale
 * budzika, i decyduje, czym delegacja wraca do modelu. Zwrot `null` = zostaw wartość bez zmian.
 */
type SalvageMapper = (value: unknown, waitedMs: number) => Record<string, unknown> | null;

/**
 * Buduje mapper ratowania dorobku. Bez niego bieg ubity budzikiem (np. długi research
 * wielu explorerów) traci częściowy wynik i wraca do modelu jako goły
 * „Sub-agent timeout after 165000ms", mimo że sub zdążył wykonać większość roboty.
 *
 * Ubity bieg z wynikiem jest mapowany na timeout (`success:false`) z polem
 * `partial_result` (tekst biegu albo skrót z `tool_call_details`). Prawdziwy błąd biegu
 * (`stopped_by:'error'`) zostaje nietknięty, żeby timeout nie przykrył diagnozy.
 */
function _makeSalvageMapper(salvageCap: number): SalvageMapper {
    return (value, waitedMs) => {
        if (!value || typeof value !== 'object') return null;
        const r = value as Record<string, unknown>;
        if (r.success === false && (!r.outcome || r.stopped_by === 'error')) return null;
        const text = typeof r.result === 'string' ? r.result.trim() : '';
        const priorPartial = typeof r.partial_result === 'string' ? r.partial_result.trim() : '';
        const handoff = typeof r.handoff === 'string' ? r.handoff.trim() : '';
        const partial = (handoff || priorPartial || text || _digestFromToolDetails(r.tool_call_details, salvageCap)).slice(0, salvageCap);
        return {
            success: false,
            error: `Sub-agent timeout after ${waitedMs}ms`,
            stopped_by: 'timeout',
            ...(typeof r.aspect === 'string' ? { aspect: r.aspect } : {}),
            ...(partial ? { partial_result: partial } : {}),
            ...(r.outcome ? {
                outcome: _outcomeFields(r.outcome as RunOutcome),
                effects: Array.isArray(r.effects) ? r.effects : (r.outcome as RunOutcome).effects,
                note: typeof r.note === 'string' ? r.note : (typeof r.sub_id === 'string' ? t('mcp.sub_agent.task_note') : t('mcp.delegate.outcome_note')),
            } : {}),
            ...(typeof r.sub_id === 'string' ? { sub_id: r.sub_id } : {}),
            ...(Array.isArray(r.tools_used) && (r.tools_used as unknown[]).length > 0 ? { tools_used: r.tools_used } : {}),
            ...(typeof r.duration_ms === 'number' ? { duration_ms: r.duration_ms } : {}),
            ...(r.stop_reason ? { stop_reason: r.stop_reason } : {}),
            ...(r.partial ? { partial: r.partial } : {}),
            ...(r.question ? { question: r.question } : {}),
            ...(Array.isArray(r.tool_call_details) ? { tool_call_details: r.tool_call_details } : {}),
            ...(r.usage ? { usage: r.usage } : {}),
        };
    };
}

/**
 * Skrót dorobku z `tool_call_details` pętli (`[{name, args, resultPreview}]`, podgląd po
 * 500 znaków na wpis). Używany, gdy ubity bieg nie zdążył oddać żadnego tekstu — lepszy
 * podgląd 500 znaków na narzędzie niż nic. Pełny salvage z transkryptu robi pętla
 * w backstopie (`_fallbackWithSalvage` w agent-loop).
 */
function _digestFromToolDetails(details: unknown, cap: number): string {
    if (!Array.isArray(details) || details.length === 0 || !cap || cap <= 0) return '';
    const entries: string[] = [];
    for (const raw of details) {
        const det = raw as { name?: string; args?: unknown; resultPreview?: string } | null;
        if (!det || typeof det.resultPreview !== 'string' || !det.resultPreview) continue;
        let argsStr = '';
        try { argsStr = typeof det.args === 'string' ? det.args : JSON.stringify(det.args ?? ''); }
        catch { argsStr = ''; }
        entries.push(`${`### ${det.name || '?'} ${String(argsStr).slice(0, 200)}`.trimEnd()}\n${det.resultPreview}`);
    }
    if (entries.length === 0) return '';
    const digest = entries.join('\n\n');
    return digest.length > cap ? `${digest.slice(0, cap)}…` : digest;
}

/**
 * Biegi odpalone W TLE, których jeszcze nikt nie rozliczył. Klucz = obietnica biegu
 * (single-task) albo całej puli (multi-task), wartość = ILE ZADAŃ ona niesie.
 *
 * To księgowość obietnic, nie pojemność: przyjęciem steruje scheduler rozmowy.
 * Licznik obejmuje także zadania czekające na przydział.
 */
const _backgroundRuns = new Map<Promise<unknown>, number>();

/** Ile ZADAŃ biegnie teraz w tle (suma wag, nie liczba obietnic). */
function _backgroundCount(): number {
    let sum = 0;
    for (const weight of _backgroundRuns.values()) sum += weight;
    return sum;
}

/** Weź bieg pod licznik i zdejmij go, cokolwiek się z nim stanie. */
function _trackBackground(run: Promise<unknown>, weight: number): void {
    _backgroundRuns.set(run, Math.max(1, weight));
    const forget = () => { _backgroundRuns.delete(run); };
    void run.then(forget, forget);
}

/**
 * Kontrolki abortu WSZYSTKICH biegów delegacji w tym procesie.
 *
 * Po co osobno od rejestru: uchwyt trafia do `SubTaskRegistry` dopiero w `onTaskCreated`,
 * czyli PO rozwiązaniu configu, stworzeniu modelu i zbudowaniu promptu (a to sięga do dysku).
 * Bieg złapany przez `onunload` w tym oknie nie miałby w rejestrze czego zatrzymywać i po
 * wyładowaniu pluginu wystartowałby pętlę na żywym `mcpClient`. Ten zbiór jest właścicielem
 * biegu od pierwszej linijki `execute`, więc `stopAllDelegations` sięga też tam.
 */
const _liveAborts = new Set<SubAbortControl>();
// Invocation latches also cover pre-consent work; they are not additional child runs.
const _liveInvocations = new Set<SubAbortControl>();

/** Weź kontrolkę pod opiekę; zwrócona funkcja zdejmuje ją (wołana, cokolwiek się z biegiem stanie). */
function _trackAbort(ctl: SubAbortControl): () => void {
    _liveAborts.add(ctl);
    return () => { _liveAborts.delete(ctl); };
}

/**
 * Zatrzask unload sprawdzany przed admisją i ponownie po niej. W produkcji wszystkie
 * przyjęte zadania mają już kontrolki abortu, także queued. Legacy fallback bez
 * schedulera używa puli z odroczonymi thunkami, więc nadal potrzebuje guardu na wejściu.
 * Zerowany przy createDelegateTool (onload), zanim przyjmiemy nowe zlecenia.
 */
let _moduleUnloaded = false;

/**
 * Przerwij KAŻDY bieg delegacji tego procesu - demontaż pluginu (`PKMPlugin.onunload`).
 *
 * Wołane PO `subTaskRegistry.stopAll()` (rejestr zna id i agenta, więc daje ślad w trace)
 * jako druga siatka: łapie biegi bez bytu w rejestrze. Jak reszta ścieżki stopu jest to
 * PROŚBA — flaga zatrzyma pętlę między iteracjami, `stop()` przerwie trwający stream.
 * Nie czekamy na zejście biegów (onunload nie czeka na obietnice).
 *
 * Flaga `_moduleUnloaded` idzie w górę PIERWSZA, przed pętlą po `_liveAborts` — od tej
 * chwili KAŻDY KOLEJNY thunk multi-task (`taskThunks` w `execute`) odmawia startu na wejściu,
 * nawet taki, który jeszcze nie zdążył zarejestrować swojej własnej kontrolki abortu.
 *
 * @returns ile kontrolek dostało sygnał bez wyjątku
 */
export function stopAllDelegations(reason = 'unload'): number {
    _moduleUnloaded = true;
    for (const ctl of [..._liveInvocations]) abortSub(ctl, 'manual-stop');
    let stopped = 0;
    for (const ctl of [..._liveAborts]) {
        try {
            abortSub(ctl, 'manual-stop');
            stopped++;
        } catch (e) {
            log.warn('DelegateTool', `stopAllDelegations(${reason}): kontrolka rzuciła — lecę dalej:`, e);
        }
    }
    if (stopped > 0) log.info('DelegateTool', `stopAllDelegations(${reason}): sygnał stopu do ${stopped} biegu/ów delegacji`);
    return stopped;
}

/** Ostrzeżenie o braku rejestru leci RAZ na proces — inaczej zasypałoby log przy każdej turze. */
let _warnedNoRegistry = false;

/**
 * Adres zwrotny zlecenia z zaufanego znacznika `_invocationOrigin` (wstrzyka go `MCPClient`
 * z `options.origin`, model nie ma jak go podrobić). Kształt walidujemy defensywnie — do
 * rejestru ma trafić czysty `SubTaskOrigin`, a nie cokolwiek, co przyszło w args.
 *
 * ⚠️ Znacznik NIE dociera do promptu suba: `_executeSubAgent` czyta z args wyłącznie
 * `task`/`context`/`aspect_explicit` — dokładnie jak pozostałe `_invocation*`.
 */
function _resolveOrigin(args: DelegateToolArgs): SubTaskOrigin | undefined {
    const raw = args?._invocationOrigin as Partial<SubTaskOrigin> | undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    if (typeof raw.agentName !== 'string' || !raw.agentName) return undefined;
    const origin: SubTaskOrigin = { agentName: raw.agentName };
    if (typeof raw.sessionPath === 'string') origin.sessionPath = raw.sessionPath;
    if (typeof raw.sessionEpoch === 'string') origin.sessionEpoch = raw.sessionEpoch;
    if (typeof raw.tabKey === 'string') origin.tabKey = raw.tabKey;
    return origin;
}

export function createDelegateTool(app: object, deps: DelegateToolDeps = {}) {
    // `_moduleUnloaded` jest stanem MODUŁU (jak `_liveAborts`), więc musi mieć jakiś moment
    // "od nowa" - inaczej jeden `onunload` zatruwa WSZYSTKIE kolejne starty pluginu w tym
    // samym procesie (np. harness odpalający onload/onunload w pętli po scenariuszach).
    // `createDelegateTool` jest wołane DOKŁADNIE RAZ na start pluginu (`src/main.ts`, rejestracja
    // narzędzi w `initialize()`) - najmniejszy diff, który wiąże reset z realnymi narodzinami
    // narzędzia, bez dokładania osobnego eksportu i osobnego wołania w `main.ts`.
    _moduleUnloaded = false;
    const makeRunner = deps.makeRunner || ((plugin: DelegatePlugin) => new SubAgentRunner({
        toolRegistry: plugin.toolRegistry!,
        app,
        plugin
    }) as SubAgentRunnerLike);
    const inputSchema = {
        type: 'object',
        properties: {
            task: {
                type: 'string',
                description: t('mcp.delegate.param.task')
            },
            aspect: {
                type: 'string',
                description: t('mcp.delegate.param.aspect')
            },
            context: {
                type: 'string',
                description: t('mcp.delegate.param.context')
            },
            context_mode: { type: 'string', enum: ['clean', 'parent_conversation'], description: t('mcp.delegate.param.context_mode') },
            // `extra_tools` świadomie NIE JEST w schemacie: rozszerzanie narzędzi suba
            // ponad config to decyzja usera w YAML, nie modelu w locie.
            aspect_explicit: {
                type: 'boolean',
                description: 'Exact sub-agent match. Used by inline trigger chips and force-delegate UI.'
            },
            timeout_ms: {
                type: 'number',
                description: 'Per sub-agent hard budget in milliseconds. Leave UNSET to use the configured default (Settings → Limits) — do not guess tight values; a silence watchdog already kills dead runs.'
            },
            // Parametr `background` świadomie NIE JEST w schemacie: delegacja z głównego
            // czatu idzie w tło zawsze, model nie ma tu wyboru (jawnie podany argument jest
            // ignorowany w execute; patrz komentarz przy `const background`).
            tasks: {
                type: 'array',
                // Informacyjny sufit dla modelu. Twarda bramka i tak siedzi w execute()
                // (getLimits().max_parallel_delegations) - schemat tylko podpowiada, nie chroni.
                maxItems: DEFAULT_LIMITS.max_parallel_delegations,
                items: {
                    type: 'object',
                    properties: {
                        task: { type: 'string', description: t('mcp.delegate.param.task') },
                        aspect: { type: 'string', description: t('mcp.delegate.param.aspect') },
                        context: { type: 'string', description: t('mcp.delegate.param.context') },
                        context_mode: { type: 'string', enum: ['clean', 'parent_conversation'], description: t('mcp.delegate.param.context_mode') },
                        aspect_explicit: { type: 'boolean' },
                        timeout_ms: { type: 'number' },
                    },
                    required: ['task']
                },
                description: t('mcp.delegate.param.tasks')
            }
        },
        required: [],
        not: { required: ['tasks', 'context_mode'] },
    } satisfies Schema;
    // Width has its configurable limit and dedicated error below; validate every other
    // model argument together, before any preparation, consent or reservation.
    const validator = new Validator({ ...inputSchema, properties: { ...inputSchema.properties,
        tasks: { ...inputSchema.properties.tasks, maxItems: undefined },
    } });
    return {
        name: 'delegate',
        description: t('mcp.delegate.desc'),
        inputSchema,
        execute: async (args: DelegateToolArgs, _app: unknown, plugin: DelegatePlugin | null | undefined, runtime?: BuiltinToolExecutionContext) => {
            const invocation = createSubAbortControl();
            _liveInvocations.add(invocation);
            const cancel = () => abortSub(invocation, 'manual-stop');
            const signal = invocation.controller!.signal;
            const cancelled = () => {
                if (_moduleUnloaded || runtime?.shouldAbort?.() || runtime?.abortSignal?.aborted) cancel();
                return invocation.aborted;
            };
            const refusal = () => ({ success: false as const, error: t('mcp.delegate.share.cancelled') });
            let offOwner: (() => void) | undefined;
            let offThread: (() => void) | undefined;
            runtime?.abortSignal?.addEventListener('abort', cancel, { once: true });
            const trackChild = (ctl: SubAbortControl) => {
                const stop = () => abortSub(ctl, 'manual-stop');
                signal.addEventListener('abort', stop, { once: true });
                if (cancelled()) stop();
                const forget = _trackAbort(ctl);
                return () => { signal.removeEventListener('abort', stop); forget(); };
            };
            try {
                // In-process callers can supply absent optional properties as undefined.
                // Validate their JSON-equivalent shape without changing capability identity.
                const defined = (value: unknown): unknown => value && typeof value === 'object' && !Array.isArray(value)
                    ? Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) : value;
                const validationArgs = defined(args);
                if (validationArgs && typeof validationArgs === 'object' && 'tasks' in validationArgs && Array.isArray(validationArgs.tasks)) {
                    validationArgs.tasks = validationArgs.tasks.map(defined);
                }
                if (!validator.validate(validationArgs).valid) return { success: false, error: 'Invalid delegation context mode.' };
                cancelled();
                const continuation = _continuations.get(args);
                const wantsConversation = args.context_mode === 'parent_conversation'
                    || args.tasks?.some(task => task.context_mode === 'parent_conversation');
                const conversation = wantsConversation && runtime?.parentConversation
                    ? structuredClone({ ...runtime.parentConversation, snapshot: redactParentConversationSnapshot(runtime.parentConversation.snapshot, configuredChatSecrets(plugin?.env?.settings?.pkmAssistant?.chat)) }) : undefined;
                const agentManager = plugin?.agentManager;
                if (!agentManager) {
                    return { success: false, error: t('mcp.delegate.no_agent_manager') };
                }

                const activeAgent = (args?._invocationAgentName
                    ? agentManager.getAgent?.(args._invocationAgentName as string)
                    : null) || agentManager.getActiveAgent();
                if (!activeAgent) {
                    return { success: false, error: t('mcp.delegate.no_active_agent') };
                }

                // Custom suby usera (do wyboru po nazwie). Brak subów NIE blokuje delegacji -
                // delegate bez aspect uruchamia generycznego workera (buildGenericWorkerConfig).
                const delegates = activeAgent.activeSubAgents || [];

                // Default per-task timeout from config/limits.js (120s), user-overridable
                // via settings.pkmAssistant.limits.delegation_timeout_ms; per-call timeout_ms still wins.
                const limits = getLimits(plugin?.env?.settings);
                const defaultTimeoutMs = limits.delegation_timeout_ms;

                // ── Strażnik GŁĘBOKOŚCI (fail-closed) ──
                // `_invocationDelegationDepth` wstrzykuje MCPClient (jak `_invocationAgentName`) -
                // model nie poda go sam z palca, bo pole i tak jest nadpisywane przy wykonaniu.
                // 0 = wywołanie z głównego czatu; 1 = wywołanie z wnętrza sub-agenta itd.
                const subRunContext = args._invocationSubRunContext;
                const ancestors = subRunContext
                    ? plugin?.subTaskRegistry?.getDelegationAncestors?.(subRunContext, activeAgent.name || '') : undefined;
                const origin = _resolveOrigin(args);
                if (subRunContext && (!ancestors || origin?.agentName !== subRunContext.origin.agentName
                    || origin?.sessionPath !== subRunContext.origin.sessionPath || origin?.sessionEpoch !== subRunContext.origin.sessionEpoch)) {
                    return { success: false, error: 'Invalid sub-agent parent context.' };
                }
                const forbidden = new Set(ancestors?.map(task => task.name.toLowerCase()));
                const canonicalName = (resolved: ResolvedDelegate): string | undefined => {
                    if (continuation) return plugin?.subTaskRegistry?.getThread?.(continuation.threadId)?.name;
                    if (resolved.delegate) return agentManager.resolveSubAgentConfig(resolved.delegate.name, activeAgent)?.name;
                    return _queuedThreadName(resolved, plugin);
                };
                const resolveForRun = (aspect: string | undefined, explicit: boolean): ResolvedDelegate => {
                    const resolved = _resolveDelegate(aspect, delegates, explicit);
                    if (!subRunContext) return resolved;
                    // Check after exact/fuzzy resolution too: an alias may point at an ancestor config.
                    if (!resolved.error && forbidden.has(canonicalName(resolved)?.toLowerCase() || '')) {
                        return { success: false, error: 'Cannot delegate to self or ancestor configuration.' };
                    }
                    const eligible = delegates.filter(delegate => !forbidden.has(
                        agentManager.resolveSubAgentConfig(delegate.name, activeAgent)?.name.toLowerCase() || ''));
                    return resolved.error ? _resolveDelegate(aspect, eligible, explicit) : resolved;
                };
                const currentDepth = subRunContext?.level ?? Math.max(0, Number(args?._invocationDelegationDepth) || 0);
                if (currentDepth >= limits.max_delegation_depth) {
                    log.warn('DelegateTool', `Delegacja ODRZUCONA: głębokość ${currentDepth} >= limit ${limits.max_delegation_depth}`);
                    return { success: false, error: t('mcp.delegate.depth_limit', { limit: limits.max_delegation_depth }) };
                }
                const childDepth = currentDepth + 1;

                // Runtime-addressed descendants return a reservation receipt; their runner
                // consumes child notices. Legacy calls without context retain blocking mode.
                if (!plugin?.subTaskRegistry && !_warnedNoRegistry) {
                    _warnedNoRegistry = true;
                    log.warn('DelegateTool', 'Brak plugin.subTaskRegistry — delegacja leci ścieżką BLOKUJĄCĄ (tło niedostępne)');
                }
                if (args.background === false && plugin?.subTaskRegistry && currentDepth === 0) {
                    log.debug('DelegateTool', 'background:false zignorowane — delegacja z czatu zawsze w tle (runda 3)');
                }
                const background = subRunContext ? true : typeof continuation?.background === 'boolean'
                    ? continuation.background
                    : !!plugin?.subTaskRegistry && currentDepth === 0;
                const attachReusableThread = (value: unknown, taskId: string | null): unknown => {
                    const threadId = taskId ? plugin?.subTaskRegistry?.getTask?.(taskId)?.threadId : undefined;
                    if (!threadId || !plugin?.subTaskRegistry?.getThread?.(threadId)?.reusable || !value || typeof value !== 'object') return value;
                    const response = value as Record<string, unknown>;
                    return { ...response, sub_id: threadId,
                        ...(response.success === false ? { note: t('mcp.sub_agent.task_note') } : {}) };
                };
                // Tryb pytań ZAMRAŻAMY tu, w chwili zlecenia - dokładnie jak `scopeFolders` niżej.
                // Bieg suba przeżywa turę (idzie w tło), więc odczyt `plugin.currentAutonomy`
                // w trakcie biegu dawał tryb zakładki, na którą user właśnie przeskoczył.
                // Brak znacznika (stary wołacz) = runner spada na lustro.
                const turnAutonomy = typeof args?._invocationAutonomy === 'string' && args._invocationAutonomy
                    ? args._invocationAutonomy
                    : null;
                // Kim jest WOŁAJĄCY. Na piętrze 0 (czat) obu znaczników nie ma i dziecko liczy
                // się jak dotąd; na piętrze ≥1 to zakres i whitelista suba, który zleca -
                // dziecko dostanie z nimi PRZECIĘCIE.
                const callerScopeFolders = _readStringList(args?._invocationScopeFolders);
                const callerToolNames = _readStringList(args?._invocationToolNames);
                // Wspólne dla wszystkich trzech ścieżek - ile ms doliczamy, gdy budzik
                // zadania złapie suba w finalnym podsumowaniu (patrz `_makeFinalGrace`).
                const graceMs = limits.subagent_final_grace_ms;
                // Ratowanie dorobku - gdy budzik zadania ubije bieg, ale ubity bieg
                // zdąży się domknąć (abort → pętla oddaje częściowy wynik), timeout wraca
                // z `partial_result` zamiast gołego błędu. 0 = wyłączone (stare zachowanie).
                const salvageMapper = limits.subagent_salvage_max_chars > 0
                    ? _makeSalvageMapper(limits.subagent_salvage_max_chars)
                    : null;

                const registry = plugin.subTaskRegistry;
                const runOrigin: SubTaskOrigin = origin ?? { agentName: activeAgent.name || '' };
                const ownerMatches = (value: SubTaskOrigin | undefined) => !!value && !!runOrigin.sessionPath && !!runOrigin.sessionEpoch
                    && value.agentName === runOrigin.agentName && value.sessionPath === runOrigin.sessionPath && value.sessionEpoch === runOrigin.sessionEpoch;
                offOwner = registry?.events?.on('owner:stopping', value => { if (ownerMatches(value as SubTaskOrigin)) cancel(); });
                offThread = registry?.events?.on('thread:closed', value => {
                    if (subRunContext && (value as SubThread).runIds.includes(subRunContext.runId)) cancel();
                });
                const reserve = (resolved: ResolvedDelegate, prepared?: PreparedParentDelegation): SubThread | null => {
                    if (cancelled()) throw new Error(refusal().error);
                    if (!registry?.createThread) return null;
                    const name = (subRunContext ? canonicalName(resolved) : undefined) ?? _queuedThreadName(resolved, plugin);
                    const runId = allocateSubTaskId(name);
                    if (continuation && registry.reserveContinuation) {
                        const thread = registry.reserveContinuation(continuation.threadId, runOrigin, runId, continuation,
                            { parentId: subRunContext?.runId, level: childDepth });
                        if (!thread) throw new Error(t('subagent.thread_refused'));
                        return thread;
                    }
                    try {
                        return registry.createThread({ threadId: runId, name, owner: runOrigin, origin: runOrigin,
                            config: {}, phase: 'queued', parentId: subRunContext?.runId, level: childDepth,
                            ...(prepared ? { parentConversation: pendingMetadata(prepared) } : {}) });
                    } catch (error) {
                        registry.finishQueuedFailure?.(runId, { error: maskSensitiveData(String((error as Error)?.message ?? error)), background });
                        throw error;
                    }
                };

                // The trusted runtime source is never read from model arguments. Consent and
                // every clean sibling share the invocation cancellation latch.
                const prepare = async (task: DelegateTaskDef, resolved: ResolvedDelegate) => {
                    if (cancelled()) return refusal();
                    const mode = task.context_mode;
                    if (mode === undefined || mode === 'clean') return { success: true as const, prepared: undefined };
                    if (mode !== 'parent_conversation' || continuation) return { success: false as const, error: 'Invalid delegation context mode.' };
                    const validate = () => !cancelled()
                        && ownerMatches(conversation?.owner)
                        && (subRunContext ? conversation?.source === 'sub'
                            && conversation.turnId === subRunContext.runId
                            && !!registry?.getDelegationAncestors?.(subRunContext, activeAgent.name || '')
                            : conversation?.source === 'lead')
                        && (() => {
                            const currentAgent = agentManager.getAgent ? agentManager.getAgent(activeAgent.name || '') : activeAgent;
                            return !!currentAgent
                                && (plugin.toolRegistry?.checkToolAxis?.(currentAgent, 'delegate').allowed ?? true)
                                && (plugin.permissionSystem?.checkPermission(currentAgent, 'delegate', '',
                                    { autonomy: turnAutonomy, scopeFolders: callerScopeFolders }).allowed ?? true);
                        })();
                    const answer = await prepareParentConversationDelegation({ mode: 'parent_conversation',
                        parentConversation: conversation, parentName: subRunContext ? registry?.getTask?.(subRunContext.runId)?.name || activeAgent.name || '' : activeAgent.name || '',
                        signal, approvalManager: plugin.approvalManager, validate,
                        knownSecrets: configuredChatSecrets(plugin.env?.settings?.pkmAssistant?.chat),
                        prepare: () => prepareDelegateExecution(task, resolved, activeAgent, agentManager, plugin,
                            { subRunContext, callerToolNames }) });
                    if (cancelled()) return refusal();
                    if (!answer.success) return answer;
                    if (answer.mode !== 'parent_conversation') return { success: false as const, error: 'Invalid delegation context mode.' };
                    return { success: true as const, prepared: answer.prepared, validate };
                };

                // ── Multi-task mode ──
                if (args.tasks && Array.isArray(args.tasks) && args.tasks.length > 0) {
                    // Strażnik SZEROKOŚCI. Odrzucamy CAŁE wywołanie - świadomie nie tniemy
                    // listy po cichu, bo model musiałby zgadywać, które zadania poszły.
                    // Limit listy jest niezależny od bieżących dzierżaw rozmowy.
                    if (args.tasks.length > limits.max_parallel_delegations) {
                        log.warn('DelegateTool', `Delegacja ODRZUCONA: ${args.tasks.length} zadań > limit ${limits.max_parallel_delegations}`);
                        return {
                            success: false,
                            error: t('mcp.delegate.parallel_limit', {
                                limit: limits.max_parallel_delegations,
                                count: args.tasks.length,
                            }),
                        };
                    }
                    // Górny `timeout_ms` jest DEFAULTEM dla zadań, które nie mają
                    // własnego - inaczej model prosiłby o krótszy limit dla całej paczki
                    // i dostawał pełne 120 s zamiast tego, o co prosił.
                    const topTimeout = Number(args.timeout_ms);
                    const tasksDefaultTimeoutMs = Number.isFinite(topTimeout) && topTimeout > 0
                        ? topTimeout
                        : defaultTimeoutMs;
                    // Platforma lokalna z bramką limit 1 i tak przerabia requesty PO KOLEI -
                    // odpalanie subów równolegle nic nie przyspiesza, tylko budziki (task +
                    // per-call) tykają w kolejce bramki i taski umierają seryjnie. Szerokość
                    // dopasowujemy do przepustowości: lokalna bramka N → N subów naraz (default
                    // 1 = sekwencyjnie, budzik każdego taska startuje dopiero z jego biegiem),
                    // chmura → pełna paczka.
                    const taskConcurrency = _resolveTaskConcurrency(plugin, activeAgent, args.tasks.length);
                    const admissionGroup = { limit: taskConcurrency };
                    if (taskConcurrency < args.tasks.length) {
                        log.debug('DelegateTool', `Delegacja ${args.tasks.length} zadań ograniczona do ${taskConcurrency} naraz (bramka platformy lokalnej)`);
                    }
                    // Bramka „zadanie i wystartowało, i ma już swój byt - ALBO się skończyło".
                    // Zwrotka w trybie tła czeka wyłącznie na bramki PIERWSZEJ FALI, czyli na tyle
                    // zadań, ile pula wpuszcza od razu. Bez tego przy bramce lokalnej o szerokości 1
                    // „tło" czekałoby na przerobienie całej paczki po kolei — czyli na nic by nie było.
                    const gates = args.tasks.map(() => {
                        let open!: () => void;
                        const opened = new Promise<void>((res) => { open = res; });
                        return { opened, open };
                    });
                    const startedTasks: Array<{ task_id: string; name: string; sub_id?: string }> = [];
                    const completedTaskIds: Array<string | null> = args.tasks.map(() => null);

                    // Zadanie odbite OD RĘKI (puste `task`, nietrafiony `aspect`)
                    // nigdy nie wejdzie do rejestru, więc powiadomienie o nim NIE przyjdzie.
                    // Rozstrzygamy je RAZ, przed pulą - inaczej zwrotka nie umie odróżnić
                    // "odrzucone" od "czeka w kolejce", a przy wąskiej bramce część odmów
                    // zapadałaby dopiero po turze, w porzuconej puli.
                    type TaskPrecheck =
                        | { ok: true; resolved: ResolvedDelegate; prepared?: PreparedParentDelegation; validate?: () => boolean }
                        | { ok: false; result: unknown };
                    const rejectedTasks: Array<{ task: string; aspect?: string; error: string; instruction?: string }> = [];
                    const precheck: TaskPrecheck[] = args.tasks.map((taskDef) => {
                        if (!taskDef.task?.trim()) {
                            const error = t('mcp.delegate.empty_task');
                            rejectedTasks.push({ task: taskDef.task || '', aspect: taskDef.aspect, error });
                            return { ok: false, result: { success: false, error } };
                        }
                        const resolved = resolveForRun(taskDef.aspect, taskDef.aspect_explicit === true);
                        if (resolved.error) {
                            rejectedTasks.push({ task: taskDef.task, aspect: taskDef.aspect, error: resolved.error });
                            return { ok: false, result: resolved };
                        }
                        return { ok: true, resolved };
                    });
                    const queuedThreads: Array<SubThread | null> = args.tasks.map(() => null);
                    for (let i = 0; i < args.tasks.length; i++) {
                        const checked = precheck[i];
                        if (!checked.ok) continue;
                        const prepared = await prepare(args.tasks[i], checked.resolved);
                        const decision = cancelled() ? refusal() : prepared;
                        if (!decision.success) {
                            precheck[i] = { ok: false, result: decision };
                            rejectedTasks.push({ task: args.tasks[i].task!, aspect: args.tasks[i].aspect, error: decision.error,
                                ...('instruction' in decision && typeof decision.instruction === 'string' ? { instruction: decision.instruction } : {}) });
                            continue;
                        }
                        checked.prepared = decision.prepared; checked.validate = decision.validate;
                        try { queuedThreads[i] = reserve(checked.resolved, checked.prepared); }
                        catch (error) {
                            log.warn('DelegateTool', `Nie udało się zarezerwować zadania ${i + 1}:`, error);
                            const message = maskSensitiveData(String((error as Error)?.message ?? error));
                            precheck[i] = { ok: false, result: { success: false, error: message } };
                            rejectedTasks.push({ task: args.tasks[i].task!, aspect: args.tasks[i].aspect, error: message });
                        }
                    }
                    const acceptedCount = args.tasks.length - rejectedTasks.length;

                    const taskThunks = args.tasks.map((taskDef, i) => (): Promise<unknown> => {
                        const gate = gates[i];
                        const checked = precheck[i];
                        if (!checked.ok) {
                            gate.open();
                            return Promise.resolve(checked.result);
                        }
                        // Guard musi otworzyć bramkę pokwitowania także przy unload.
                        // W produkcji wszystkie thunki enqueue synchronicznie; tylko fallback
                        // bez schedulera uruchamia je przez pulę o ograniczonej szerokości.
                        const reservation = queuedThreads[i];
                        const finishClosedReservation = (): Record<string, unknown> | null => {
                            if (!reservation) return null;
                            const current = registry?.getThread?.(reservation.threadId);
                            if (current?.phase !== 'closed') return null;
                            const task = registry?.finishQueuedStop?.(reservation.threadId, {
                                background,
                                taskPreview: taskDef.task,
                            });
                            const by = task?.outcome?.end.kind === 'stopped'
                                ? task.outcome.end.by
                                : current.closedBy ?? 'user';
                            const outcome: RunOutcome = {
                                end: { kind: 'stopped', by }, completeness: 'empty',
                                hasAnswer: false, hasMaterial: false, effects: [],
                            };
                            return {
                                success: false,
                                error: t('mcp.delegate.outcome_error', { reason: _outcomeReason(outcome) }),
                                stopped_by: 'abort',
                                aspect: reservation.name,
                                tools_used: [], tool_call_details: [], usage: null,
                                outcome: _outcomeFields(outcome), effects: [],
                                note: t('mcp.delegate.outcome_note'),
                            };
                        };
                        if (cancelled()) {
                            if (reservation && registry?.getThread?.(reservation.threadId)?.phase !== 'closed') {
                                registry?.closeThread?.(reservation.threadId, 'system');
                            }
                            const stopped = finishClosedReservation();
                            gate.open();
                            return Promise.resolve(stopped ?? refusal());
                        }
                        const closedAtEntry = finishClosedReservation();
                        if (closedAtEntry) {
                            gate.open();
                            return Promise.resolve(closedAtEntry);
                        }
                        const resolvedDef = checked.resolved;
                        // Kontrolka abortu: timeout zadania ubija bieg suba (stream + pętla),
                        // a budżet modelu suba = budżet zadania (nie globalny delegation_timeout_ms,
                        // który user może mieć podkręcony na 600 s).
                        const taskTimeout = Number(taskDef.timeout_ms);
                        const effectiveTaskTimeout = Number.isFinite(taskTimeout) && taskTimeout > 0
                            ? taskTimeout
                            : tasksDefaultTimeoutMs;
                        const abortCtl = createSubAbortControl();
                        // Bieg ma właściciela OD RAZU - rejestr pozna go dopiero w `onTaskCreated`.
                        const forgetAbort = trackChild(abortCtl);
                        // Budżet TEGO zadania rusza dopiero, gdy sub wjedzie na slot bramki.
                        const gateArm = _makeGateArm();
                        // Id biegu poznajemy dopiero w `onTaskCreated` - grace-okno domyka
                        // tę zmienną, żeby przy strzale budzika móc zapytać rejestr o stan.
                        let taskId: string | null = null;
                        return _withAdmission(plugin, reservation, abortCtl, background, taskDef.task, (release, admission) => _withTimeout(_executeSubAgent(
                            { task: taskDef.task, context: taskDef.context, aspect_explicit: taskDef.aspect_explicit },
                            resolvedDef,
                            activeAgent, agentManager, plugin, makeRunner, childDepth,
                            {
                                abortCtl, invocationCancelled: cancelled, prepared: checked.prepared, validatePrepared: checked.validate,
                                onGateAdmitted: gateArm.signal,
                                onActivity: gateArm.activity, admission,
                                modelTimeout: effectiveTaskTimeout,
                                origin: reservation ? runOrigin : origin,
                                subRunContext,
                                autonomy: turnAutonomy,
                                callerScopeFolders,
                                callerToolNames,
                                salvageCap: limits.subagent_salvage_max_chars,
                                background,
                                ...(reservation ? { queuedThreadId: reservation.threadId } : {}),
                                onTaskCreated: (task: SubTask) => {
                                    taskId = task.id;
                                    completedTaskIds[i] = task.id;
                                    _attachStop(plugin, task, abortCtl);
                                    startedTasks.push({ task_id: task.id, name: task.name, ...(task.threadId ? { sub_id: task.threadId } : {}) });
                                    gate.open();
                                },
                            },
                        ).finally(release), taskDef.timeout_ms, tasksDefaultTimeoutMs, () => {
                            abortSub(abortCtl, 'task-timeout');
                        }, _makeFinalGrace(plugin, graceMs, () => taskId), gateArm, salvageMapper), gate.open, admissionGroup)
                            .then(result => {
                                if (reservation && registry?.getThread?.(reservation.threadId)?.phase === 'queued') {
                                    if (result.success === false) {
                                        const error = typeof result.error === 'string' && result.error.trim()
                                            ? result.error
                                            : t('mcp.delegate.runner_init_failed');
                                        registry.finishQueuedFailure?.(reservation.threadId, { error, background, taskPreview: taskDef.task });
                                    } else {
                                        registry.closeThread?.(reservation.threadId, 'system');
                                        registry.finishQueuedStop?.(reservation.threadId, { background, taskPreview: taskDef.task });
                                    }
                                }
                                return result;
                            }, error => {
                                if (reservation && registry?.getThread?.(reservation.threadId)?.phase === 'queued') {
                                    const message = maskSensitiveData(String((error as Error)?.message ?? error));
                                    registry.finishQueuedFailure?.(reservation.threadId, { error: message, background, taskPreview: taskDef.task });
                                    return { success: false, error: message };
                                }
                                throw error;
                            })
                            .finally(() => {
                                forgetAbort();
                                gate.open();
                            });
                    });

                    if (background) {
                        // Pula leci BEZ await — całość zadań toczy się po zakończeniu tury.
                        const pool = _runWithConcurrency(taskThunks, registry?.acquire ? taskThunks.length : taskConcurrency);
                        _trackBackground(pool, acceptedCount);
                        // `runTask` nie rzuca, ale pula to obietnica bez właściciela — pas bezpieczeństwa.
                        void pool.catch(() => { /* wynik i tak wraca rejestrem */ });
                        // Pierwsza fala liczy się z zadań PRZYJĘTYCH - bramka odmowy
                        // otwiera się od razu i bez tego "tło" wracałoby, zanim ruszy cokolwiek realnego.
                        const acceptedGates = gates.filter((_, i) => precheck[i].ok);
                        const wave = Math.max(1, Math.min(taskConcurrency, acceptedGates.length));
                        if (!subRunContext) {
                            await Promise.all(acceptedGates.slice(0, wave).map((g) => g.opened));
                            cancelled();
                        }
                        // Pozwól runnerom pierwszej fali dokończyć synchroniczną admisję
                        // modelu po nowej granicy await schedulera, jak przed P2.
                        await Promise.resolve();
                        if (cancelled() || (startedTasks.length === 0 && !queuedThreads.some(thread => thread?.phase === 'queued'))) {
                            // Żaden byt nie powstał (wysypany rejestr / same odmowy) — nie ma czego
                            // meldować modelowi, więc uczciwiej dokończyć po staremu.
                            return {
                                ..._aggregateResults((await pool).map((value, i) => attachReusableThread(value, completedTaskIds[i]))),
                                ...(rejectedTasks.length > 0 ? { rejected: rejectedTasks } : {}),
                            };
                        }
                        const registeredTasks = queuedThreads.flatMap((thread, i) => thread && precheck[i].ok
                            ? [{ task_id: thread.threadId, name: thread.name, sub_id: thread.threadId,
                                queued: registry?.getThread?.(thread.threadId)?.phase === 'queued',
                                ...(registry?.getTask?.(thread.threadId)?.parentConversation || thread.parentConversation
                                    ? { parentConversation: registry?.getTask?.(thread.threadId)?.parentConversation ?? thread.parentConversation } : {}) }]
                            : []);
                        const runnerUsedReservations = registeredTasks.length === acceptedCount
                            && startedTasks.every(started => queuedThreads.some(thread => thread?.threadId === started.sub_id));
                        const receiptTasks = runnerUsedReservations ? registeredTasks : startedTasks;
                        const queued = runnerUsedReservations
                            ? registeredTasks.filter(task => task.queued).length
                            : Math.max(0, acceptedCount - startedTasks.length);
                        return {
                            success: true,
                            started: true,
                            tasks: [...receiptTasks],
                            ...(queued > 0 ? { queued } : {}),
                            ...(rejectedTasks.length > 0 ? { rejected: rejectedTasks } : {}),
                            note: t('subagent.background_started_many', { count: acceptedCount }),
                        };
                    }

                    const results = await _runWithConcurrency(taskThunks, registry?.acquire ? taskThunks.length : taskConcurrency);
                    cancelled();
                    return _aggregateResults(results.map((value, i) => attachReusableThread(value, completedTaskIds[i])));
                }

                // ── Single-task mode ──
                if (!args.task || !args.task.trim()) {
                    return { success: false, error: t('mcp.delegate.empty_task') };
                }

                const resolved = resolveForRun(args.aspect, args.aspect_explicit === true);
                if (resolved.error) return resolved;

                const decision = await prepare(args, resolved);
                if (cancelled()) return refusal();
                if (!decision.success) return decision;
                const reservation = reserve(resolved, decision.prepared);
                const reservedRunId = reservation?.queuedRunId ?? reservation?.threadId;
                const reservedOptions = reservation ? continuation
                    ? { reservedRunId } : { queuedThreadId: reservation.threadId } : {};
                const singleTimeout = Number(args.timeout_ms);
                const effectiveSingleTimeout = Number.isFinite(singleTimeout) && singleTimeout > 0
                    ? singleTimeout
                    : defaultTimeoutMs;
                const abortCtl = createSubAbortControl();
                // Bieg ma właściciela OD RAZU - rejestr pozna go dopiero w `onTaskCreated`.
                const forgetAbort = trackChild(abortCtl);
                // Jak w trybie wielozadaniowym - zegar budżetu startuje od pierwszej admisji.
                const gateArm = _makeGateArm();
                const onTimeout = () => {
                    abortSub(abortCtl, 'task-timeout');
                };

                if (background) {
                    let announce!: (task: { id: string; name: string; threadId?: string; queued?: boolean } | null) => void;
                    const taskCreated = new Promise<{ id: string; name: string; threadId?: string; queued?: boolean } | null>((res) => { announce = res; });
                    let bgTaskId: string | null = null;
                    const run = _withAdmission(plugin, reservation, abortCtl, true, args.task, (release, admission) => _withTimeout(
                        _executeSubAgent(args, resolved, activeAgent, agentManager, plugin, makeRunner, childDepth,
                            {
                                abortCtl, invocationCancelled: cancelled, prepared: decision.prepared, validatePrepared: decision.validate, salvageCap: limits.subagent_salvage_max_chars, onGateAdmitted: gateArm.signal,
                                onActivity: gateArm.activity, admission,
                                modelTimeout: effectiveSingleTimeout, origin, subRunContext, ...reservedOptions, autonomy: turnAutonomy,
                                callerScopeFolders, callerToolNames, background: true,
                                ...(continuation ? { threadId: continuation.threadId, turnKind: continuation.turnKind, turnStartedSeq: continuation.turnStartedSeq } : {}),
                                onTaskCreated: (task: SubTask) => {
                                    bgTaskId = task.id;
                                    _attachStop(plugin, task, abortCtl);
                                    announce(task);
                                },
                            }).finally(release),
                        args.timeout_ms, defaultTimeoutMs, onTimeout,
                        _makeFinalGrace(plugin, graceMs, () => bgTaskId),
                        gateArm,
                        salvageMapper,
                    ), () => {
                        if (reservation && reservedRunId) announce({ id: reservedRunId, name: reservation.name,
                            threadId: reservation.threadId, queued: true });
                    });
                    _trackBackground(run, 1);
                    // Kontrolka schodzi z listy żywych biegów, cokolwiek się z biegiem stanie
                    // (wzór `_trackBackground` - `then` z dwiema gałęziami nie robi sieroty).
                    void run.then(forgetAbort, forgetAbort);
                    void run.catch(() => { /* pas bezpieczeństwa — nikt tej obietnicy nie trzyma */ });
                    // Kto pierwszy: powstanie bytu czy koniec biegu. Koniec przed bytem = błąd
                    // wczesny (brak modelu, nieznany aspect, wysypany rejestr) - wtedy oddajemy
                    // modelowi jego prawdziwy wynik zamiast zwrotki „bieg wystartował w tle".
                    if (subRunContext && reservation && reservedRunId) announce({ id: reservedRunId,
                        name: reservation.name, threadId: reservation.threadId, queued: reservation.phase === 'queued' });
                    const created = await Promise.race([taskCreated, run.then(() => null, () => null)]);
                    if (cancelled()) return refusal();
                    if (!created) return await run;
                    await Promise.resolve();
                    if (cancelled()) return refusal();
                    return {
                        success: true,
                        started: true,
                        task_id: created.id,
                        name: created.name,
                        ...(created.queued ? { queued: true } : {}),
                        ...(decision.prepared ? { parentConversation: registry?.getTask?.(created.id)?.parentConversation ?? pendingMetadata(decision.prepared) } : {}),
                        ...(created.threadId ? { sub_id: created.threadId } : {}),
                        note: t('subagent.background_started', { name: created.name, task_id: created.id }),
                    };
                }

                // `background` jest tu z definicji `false` — podajemy je jawnie, żeby byt
                // w rejestrze wiedział, że to był bieg BLOKUJĄCY (a nie „brak informacji").
                // Hak `onTaskCreated` istnieje na tej ścieżce WYŁĄCZNIE po to, żeby Stop
                // z panelu działał także dla biegów blokujących (nikt tu na byt nie czeka).
                // Przy okazji zbieramy z niego `task.id` dla grace-okna.
                let blockingTaskId: string | null = null;
                const questions: ParentQuestion[] = [];
                let wakeQuestion: (() => void) | null = null;
                const blockingRun = _withAdmission(plugin, reservation, abortCtl, false, args.task, (release, admission) => _withTimeout(
                    _executeSubAgent(args, resolved, activeAgent, agentManager, plugin, makeRunner, childDepth,
                        {
                            abortCtl, invocationCancelled: cancelled, prepared: decision.prepared, validatePrepared: decision.validate, salvageCap: limits.subagent_salvage_max_chars, onGateAdmitted: gateArm.signal,
                            onActivity: gateArm.activity, admission,
                            onQuestion: question => {
                                if (plugin.subTaskRegistry?.isQuestionOpen?.(question.taskId, question.id)) {
                                    questions.push(question);
                                    wakeQuestion?.();
                                }
                            },
                            modelTimeout: effectiveSingleTimeout, origin, subRunContext, ...reservedOptions, autonomy: turnAutonomy,
                            callerScopeFolders, callerToolNames, background,
                            ...(continuation ? { threadId: continuation.threadId, turnKind: continuation.turnKind, turnStartedSeq: continuation.turnStartedSeq } : {}),
                            onTaskCreated: (task: SubTask) => {
                                blockingTaskId = task.id;
                                _attachStop(plugin, task, abortCtl);
                            },
                        }).finally(release),
                    args.timeout_ms, defaultTimeoutMs, onTimeout,
                    _makeFinalGrace(plugin, graceMs, () => blockingTaskId),
                    gateArm,
                    salvageMapper,
                )).finally(forgetAbort);
                type BlockingDelivery = { kind: 'result'; value: Awaited<typeof blockingRun> } | { kind: 'question'; question: ParentQuestion };
                while (true) {
                    const nextQuestion = new Promise<ParentQuestion>(resolve => {
                        const take = () => { const question = questions.shift(); if (question) resolve(question); };
                        wakeQuestion = take;
                        take();
                    });
                    const delivery: BlockingDelivery = await Promise.race([
                        blockingRun.then(value => ({ kind: 'result' as const, value })),
                        nextQuestion.then(question => ({ kind: 'question' as const, question })),
                    ]);
                    cancelled();
                    wakeQuestion = null;
                    if (delivery.kind === 'result') return attachReusableThread(delivery.value, blockingTaskId);
                    const question = delivery.question;
                    const registry = plugin.subTaskRegistry;
                    if (registry?.isQuestionOpen?.(question.taskId, question.id) && registry.promoteToBackground?.(question.taskId)) {
                        _trackBackground(blockingRun, 1);
                        void blockingRun.catch(() => { /* wynik pozostaje w rejestrze */ });
                        return { success: true, started: true, kind: 'question', task_id: question.taskId,
                            sub_id: question.subId, name: question.name, question_id: question.id, question: question.text,
                            note: t('mcp.sub_agent.question_reply_instruction') };
                    }
                    if (registry?.isQuestionOpen?.(question.taskId, question.id)) return attachReusableThread(await blockingRun, blockingTaskId);
                }

            } catch (e) {
                log.error('DelegateTool', 'Error:', e);
                // Ten komunikat widzi MODEL i transkrypt tury, więc maskujemy go tu osobno:
                // `SubAgentRunner.runTask` ma własną maskę na tę samą klasę wycieku, ale nasz
                // WŁASNY, zewnętrzny catch jej nie dziedziczy, a wyjątek z `createModelForRole` /
                // z rejestru / z odczytu ustawień potrafi nieść zrzut zdarzenia strumienia
                // z nagłówkiem Authorization.
                return { success: false, error: maskSensitiveData(String((e as Error)?.message ?? e)) };
            } finally {
                offOwner?.(); offThread?.();
                runtime?.abortSignal?.removeEventListener('abort', cancel);
                _liveInvocations.delete(invocation);
            }
        }
    };
}

/** Narzędzie prowadzącego do sterowania wątkami sub-agentów. */
export function createSubAgentTool(app: object, deps: DelegateToolDeps = {}) {
    const delegate = createDelegateTool(app, deps);
    return {
        name: 'sub_agent',
        description: t('mcp.sub_agent.desc'),
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['message', 'task', 'stop', 'close', 'list'], description: t('mcp.sub_agent.param.action') },
                sub_id: { type: 'string', description: t('mcp.sub_agent.param.sub_id') },
                text: { type: 'string', description: t('mcp.sub_agent.param.text') },
                question_id: { type: 'string', description: t('mcp.sub_agent.param.question_id') },
                task: { type: 'string', description: t('mcp.sub_agent.param.task') },
                background: { type: 'boolean', description: t('mcp.sub_agent.param.background') },
            }, required: ['action'],
        },
        contextExtractor: (args: { action?: string; sub_id?: string; text?: string; task?: string }) => ({
            targetPath: '', approvalContext: {
                subAgentId: args.sub_id || '', subAgentAction: args.action || '',
                subAgentText: args.action === 'task' ? args.task || '' : args.action === 'message' ? args.text || '' : '',
            },
        }),
        execute: async (raw: Record<string, unknown>, _app: unknown, plugin: DelegatePlugin | null | undefined) => {
            const registry = plugin?.subTaskRegistry;
            const originRaw = raw._invocationOrigin;
            const origin = originRaw && typeof originRaw === 'object' ? originRaw as Partial<SubTaskOrigin> : undefined;
            if (!origin?.agentName || !origin.sessionPath || !origin.sessionEpoch) return { success: false, error: t('mcp.sub_agent.owner_missing') };
            const owner = { agentName: origin.agentName, sessionPath: origin.sessionPath, sessionEpoch: origin.sessionEpoch };
            const context = raw._invocationSubRunContext as SubRunContext | undefined;
            if (context && (!registry?.getDelegationAncestors?.(context, owner.agentName)
                || context.origin.agentName !== owner.agentName || context.origin.sessionPath !== owner.sessionPath || context.origin.sessionEpoch !== owner.sessionEpoch)) {
                return { success: false, error: t('mcp.sub_agent.owner_mismatch') };
            }
            const action = raw.action;
            // task establishes a new run relation, validated by delegate (including continuations).
            const canControl = (thread: SubThread): boolean => !context || action === 'task' || thread.parentId === context.runId;
            if (action === 'list') {
                const threads = (registry?.listThreads?.(owner) || []).filter(canControl);
                return { success: true, threads: threads.map(thread => {
                    const last = thread.runIds.length ? registry?.getTask?.(thread.runIds[thread.runIds.length - 1]) : undefined;
                    return { sub_id: thread.threadId, name: thread.name, phase: thread.phase, runs: thread.runIds.length,
                        outcome: last?.outcome ? { end: last.outcome.end, completeness: last.outcome.completeness } : null,
                        questionState: last ? registry?.getQuestionState?.(last.id) ?? { kind: 'none' } : { kind: 'none' } };
                }) };
            }
            const id = typeof raw.sub_id === 'string' ? raw.sub_id : '';
            const thread = id ? registry?.getThread?.(id) : undefined;
            if (!thread) return { success: false, error: t('mcp.sub_agent.not_found') };
            if (thread.owner.agentName !== owner.agentName || thread.owner.sessionPath !== owner.sessionPath || thread.owner.sessionEpoch !== owner.sessionEpoch || !canControl(thread)) {
                return { success: false, error: t('mcp.sub_agent.owner_mismatch') };
            }
            if (action === 'message') {
                if (raw.question_id !== undefined) {
                    const runId = thread.runIds[thread.runIds.length - 1];
                    const text = typeof raw.text === 'string' ? raw.text : '';
                    if (!text.trim()) return { success: false, error: t('mcp.sub_agent.empty_message') };
                    const answer = typeof raw.question_id === 'string' && raw.question_id && runId
                        ? context
                            ? registry?.answerParentQuestion?.(runId, raw.question_id as QuestionId, owner, { kind: 'sub', runId: context.runId }, text)
                            : registry?.answerParentQuestion?.(runId, raw.question_id as QuestionId, owner, text)
                        : undefined;
                    if (answer?.kind !== 'accepted') {
                        const state = runId ? registry?.getQuestionState?.(runId) : undefined;
                        return { success: false, error: t('mcp.sub_agent.question_expired'), code: 'question_expired',
                            ...(state?.kind === 'waiting' ? { activeQuestionId: state.question.id } : {}) };
                    }
                    return { success: true, message: t('mcp.sub_agent.question_answered', { sub_id: id }) };
                }
                if (thread.phase !== 'running') return { success: false, error: t('mcp.sub_agent.message_state') };
                const runId = thread.runIds[thread.runIds.length - 1];
                const text = typeof raw.text === 'string' ? raw.text : '';
                if (!text.trim()) return { success: false, error: t('mcp.sub_agent.empty_message') };
                if (!runId || !registry?.postMessage?.(runId, text)) return { success: false, error: t('mcp.sub_agent.message_rejected') };
                return { success: true, message: t('mcp.sub_agent.message_sent', { sub_id: id }) };
            }
            if (action === 'stop') {
                if (thread.phase !== 'running') return { success: false, error: t('mcp.sub_agent.stop_state') };
                const runId = thread.runIds[thread.runIds.length - 1];
                if (!runId || !registry?.requestStop?.(runId, 'lead')) return { success: false, error: t('mcp.sub_agent.stop_unavailable') };
                return { success: true, message: t('mcp.sub_agent.stopped', { sub_id: id }) };
            }
            if (action === 'close') {
                if (thread.phase !== 'idle' && thread.phase !== 'queued') return { success: false, error: t('mcp.sub_agent.close_state') };
                if (!registry?.closeThread?.(id, 'lead')) return { success: false, error: t('mcp.sub_agent.close_failed') };
                return { success: true, message: t('mcp.sub_agent.closed', { sub_id: id }) };
            }
            if (action === 'task') {
                if (thread.phase === 'running' || thread.phase === 'queued') return { success: false, error: t('mcp.sub_agent.task_state') };
                if (!thread.reusable) return { success: false, error: t('mcp.sub_agent.task_not_reusable') };
                if (thread.phase !== 'idle') return { success: false, error: t('mcp.sub_agent.task_state') };
                if (!canContinueAfterUserStop(thread, raw._invocationTurnKind, raw._invocationTurnStartedSeq)) return { success: false, error: t('mcp.sub_agent.user_stopped') };
                if (typeof raw.task !== 'string' || !raw.task.trim()) return { success: false, error: t('mcp.sub_agent.empty_task') };
                const args: Record<string, unknown> = {
                    task: raw.task,
                    _invocationOrigin: origin,
                    _invocationAgentName: owner.agentName,
                    _invocationDelegationDepth: raw._invocationDelegationDepth,
                    _invocationSubRunContext: raw._invocationSubRunContext,
                    _invocationAutonomy: raw._invocationAutonomy,
                    _invocationScopeFolders: raw._invocationScopeFolders,
                    _invocationToolNames: raw._invocationToolNames,
                };
                _continuations.set(args, { threadId: id,
                    background: typeof raw.background === 'boolean' ? raw.background : undefined,
                    turnKind: raw._invocationTurnKind === 'user' || raw._invocationTurnKind === 'machine' ? raw._invocationTurnKind : undefined,
                    turnStartedSeq: isRuntimeSequence(raw._invocationTurnStartedSeq) ? raw._invocationTurnStartedSeq : undefined });
                const result = await delegate.execute(args, _app, plugin);
                if (result && typeof result === 'object' && (result as Record<string, unknown>).error === t('mcp.sub_agent.model_unavailable')) return result;
                if (result && typeof result === 'object' && thread.reusable) {
                    const response = result as Record<string, unknown>;
                    return { ...response, sub_id: id,
                        ...(response.started === true && response.kind !== 'question' ? { note: t('mcp.sub_agent.task_started', { sub_id: id }) } : {}),
                        ...(response.success === false ? { note: t('mcp.sub_agent.task_note') } : {}) };
                }
                if (result && typeof result === 'object' && (result as Record<string, unknown>).success === false && !thread.reusable) {
                    return { ...(result as Record<string, unknown>), note: t('mcp.sub_agent.task_not_reusable') };
                }
                return result;
            }
            return { success: false, error: t('mcp.sub_agent.unknown_action') };
        },
    };
}

/**
 * Czy bieg jest teraz w FINALNEJ ITERACJI (pisze podsumowanie backstopu)?
 *
 * Czytamy kroki karty biegu: `backstop` otwiera finalną iterację, `loop.end` ją zamyka.
 * „Ostatni krok to backstop" jest tylko szczególnym przypadkiem tego samego warunku —
 * między `backstop` a `loop.end` pętla potrafi jeszcze zapisać `model.done`.
 *
 * ⚠️ Sufit `maxStepsPerTask` (500) sprawia, że w BARDZO długim biegu krok `backstop`
 * może nie trafić do tablicy w RAM (leci wtedy tylko do trace.log). Wynik: fail-safe —
 * brak dowodu = brak odroczenia, czyli abort natychmiastowy.
 */
function _isInFinalSummary(task: SubTask | null | undefined): boolean {
    const steps = task?.steps;
    if (!Array.isArray(steps) || steps.length === 0) return false;
    let inFinal = false;
    for (const step of steps) {
        if (step?.type === 'backstop') inFinal = true;
        else if (inFinal && step?.type === 'loop.end') inFinal = false;
    }
    return inFinal;
}

/**
 * Buduje grace-okno dla JEDNEGO zadania delegacji.
 *
 * `getTaskId` jest funkcją, a nie wartością, bo w chwili składania budzika bytu jeszcze
 * NIE MA — `task.id` nadaje runner i melduje go dopiero hakiem `onTaskCreated`. Wołacz
 * trzyma więc `let taskId` i domyka go tutaj.
 *
 * Fail-soft na całej długości: brak rejestru / brak `getTask` / wyjątek = `shouldDefer`
 * oddaje `false`, czyli bez grace-okna, jak zwykły timeout.
 */
function _makeFinalGrace(
    plugin: DelegatePlugin | null | undefined,
    graceMs: number,
    getTaskId: () => string | null,
): FinalGrace | null {
    if (!(graceMs > 0)) return null;
    const readTask = (): SubTask | undefined => {
        const id = getTaskId();
        if (!id) return undefined;
        return plugin?.subTaskRegistry?.getTask?.(id);
    };
    return {
        ms: graceMs,
        shouldDefer: () => _isInFinalSummary(readTask()),
        onDefer: () => {
            const task = readTask();
            if (!task) return;
            // Ślad idzie tą samą drogą co reszta kroków (a więc i do trace.log) — to NOWY TYP
            // zdarzenia, a nie zmiana formatu linii, więc czytelnicy trace są odporni.
            plugin?.subTaskRegistry?.step?.(task, 'timeout.grace', { ms: graceMs });
            log.warn('DelegateTool', `Timeout zadania złapał ${task.id} w finalnym podsumowaniu — odraczam abort o ${graceMs} ms`);
        },
    };
}

/**
 * Podepnij pod świeżo założony byt uchwyt „zatrzymaj ten bieg".
 *
 * `onTaskCreated` to JEDYNE miejsce, w którym istnieje naraz `task.id` (nadaje go runner)
 * i domknięta kontrolka abortu tego konkretnego zadania — dlatego rejestracja siedzi tu,
 * a nie w runnerze. Ubijamy dokładnie tą samą drogą co timeout delegacji: `aborted` zatrzyma
 * pętlę między iteracjami, `stop()` przerwie trwający stream modelu.
 *
 * Fail-soft: brak rejestru / stara wersja bez `attachAbort` / wyjątek = bieg leci dalej,
 * tylko bez guzika Stop. Księgowość nie ma prawa ubić delegacji.
 */
function _attachStop(plugin: DelegatePlugin, task: SubTask, abortCtl: SubAbortControl): void {
    try {
        plugin?.subTaskRegistry?.attachAbort?.(task.id, () => {
            abortSub(abortCtl, 'manual-stop');
        });
    } catch (e) {
        log.warn('DelegateTool', `attachAbort padł dla ${task?.id} (Stop z panelu niedostępny):`, e);
    }
}

/**
 * Resolve which delegate to use from available list.
 */
function _resolveDelegate(aspect: string | undefined, delegates: DelegateEntry[], explicit = false): ResolvedDelegate {
    // Brak aspect = GENERYCZNY WORKER (syntetyczny). Działa nawet gdy agent nie ma
    // żadnych własnych subów — worker to domyślny sposób delegacji, custom suby są po nazwie.
    if (!aspect) {
        return { generic: true };
    }

    const aspectLower = aspect.toLowerCase();
    // Exact match first
    let selected = delegates.find(d =>
        d.name === aspect || d.name.toLowerCase() === aspectLower
    );
    // Fuzzy fallback PO NAZWIE: "prep" matches "nika-prep".
    // Fallback po ROLI (researcher/minion/prep, strategist/master/strateg) świadomie NIE
    // ISTNIEJE: rola nie steruje, custom suby rozpoznajemy wyłącznie po nazwie.
    // W trybie ścisłym (`explicit`, np. chip z popupu) fuzzy jest wyłączone jak dotąd.
    if (!selected && !explicit) {
        selected = delegates.find(d =>
            d.name.toLowerCase().endsWith('-' + aspectLower) ||
            d.name.toLowerCase().includes(aspectLower)
        );
    }
    if (!selected) {
        // Wbudowane aspekty DOPIERO tutaj — po wszystkich custom subach usera i PRZED
        // odmową. Kolejność jest kontraktem: user, który nazwał własnego suba „explorer",
        // dostaje SWOJEGO, nie naszego.
        const builtin = _resolveBuiltinAspect(aspect);
        if (builtin) return { builtin };
        // Lista dla modelu niesie też wbudowane — inaczej po pomyłce nie wie, co w ogóle istnieje.
        const available = [...delegates.map(d => d.name), ...BUILTIN_ASPECTS].join(', ');
        return { success: false, error: t('mcp.delegate.aspect_not_found', { aspect, mode: 'all', available }) };
    }
    return { delegate: selected };
}

/** Nazwa widoczna w rejestrze przed zbudowaniem pełnej konfiguracji biegu. */
function _queuedThreadName(resolved: ResolvedDelegate, plugin: DelegatePlugin | null | undefined): string {
    if (resolved.generic) return resolveGenericWorkerConfig(plugin).name;
    if (resolved.builtin) return resolved.builtin === 'worker' ? PKM_WORKER_NAME : PKM_EXPLORER_NAME;
    if (resolved.delegate) return resolved.delegate.name;
    return PKM_SUB_NAME;
}

/**
 * Execute task via SubAgentRunner (unified path).
 * @param resolved - { delegate } (custom sub po nazwie) lub { generic: true } (worker).
 * @param delegationDepth - piętro, na którym stanie odpalany sub. Runner
 *   niesie je dalej do MCPClient, żeby delegacja z wnętrza suba znała swoją głębokość. Default 1.
 */
/** Kontrolka abortu biegu suba: `_withTimeout` ustawia `aborted` i woła `stop` (abort
 *  streamu modelu), runner czyta `aborted` jako shouldAbort pętli. Bez tego timeout
 *  delegacji porzucałby suba żywcem — sub mieliłby dalej, trzymając slot bramki
 *  platform lokalnych i blokując główny czat. */
export type SubAbortControl = {
    aborted: boolean; stop: (() => void) | null;
    controller?: AbortController;
    reason?: 'manual-stop' | 'task-timeout' | 'superseded';
};

function createSubAbortControl(): SubAbortControl {
    return { aborted: false, stop: null, controller: new AbortController() };
}

function abortSub(ctl: SubAbortControl, reason: 'manual-stop' | 'task-timeout' | 'superseded'): void {
    if (ctl.aborted) return;
    ctl.aborted = true;
    ctl.reason = reason;
    ctl.controller?.abort(reason);
    ctl.stop?.();
}

function pendingMetadata(prepared: PreparedParentDelegation): ParentConversationMetadata {
    return { mode: 'parent_conversation', status: 'pending', source: prepared.parentConversation.source,
        sourceId: prepared.parentConversation.turnId };
}

type SubRunControl = {
    /** Built at dispatch with the plan's frozen cap; independent of args.context's cap. */
    dependencyContext?: DependencyContext;
    invocationCancelled?: () => boolean;
    admission?: RunAdmission;
    prepared?: PreparedParentDelegation;
    validatePrepared?: () => boolean;
    salvageCap?: number;
    abortCtl?: SubAbortControl;
    /** Sygnał pierwszego wjazdu na slot bramki — przelot do `runTask`, bez interpretacji. */
    onGateAdmitted?: () => void;
    onActivity?: (activity: RunActivity) => void;
    onQuestion?: (question: ParentQuestion) => void;
    modelTimeout?: number;
    /** Adres zwrotny + tryb tła + hak „byt istnieje" — przelot do `runTask`, bez interpretacji. */
    origin?: SubTaskOrigin;
    subRunContext?: SubRunContext;
    background?: boolean;
    onTaskCreated?: (task: SubTask) => void;
    /** Tryb autonomii tury zlecającej, zamrożony na cały bieg suba. */
    autonomy?: string | null;
    /** `scope.folders` suba zlecającego — dziecko dostanie z nim przecięcie. */
    callerScopeFolders?: string[] | null;
    /** Whitelista narzędzi suba zlecającego — dziecko dostanie z nią przecięcie. */
    callerToolNames?: string[] | null;
    threadId?: string;
    turnKind?: 'user' | 'machine';
    turnStartedSeq?: RuntimeSequence;
    queuedThreadId?: string;
    reservedRunId?: string;
};

/**
 * Odczyt zaufanego znacznika-listy z args (`_invocationScopeFolders` /
 * `_invocationToolNames`). Wszystko, co nie jest niepustą tablicą stringów, znaczy
 * „wołający nie zawęża".
 */
function _readStringList(raw: unknown): string[] | null {
    if (!Array.isArray(raw)) return null;
    const out = raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return out.length > 0 ? out : null;
}

/** One admission owns both preparation and the timed run. Waiting has no task timer. */
async function _withAdmission(
    plugin: DelegatePlugin, reservation: SubThread | null, ctl: SubAbortControl,
    background: boolean, taskPreview: string | undefined,
    run: (release: () => void, admission?: RunAdmission) => Promise<Record<string, unknown>>, onQueued?: () => void, group?: AdmissionGroup,
): Promise<Record<string, unknown>> {
    const registry = plugin.subTaskRegistry;
    if (!reservation || !registry?.acquire || !ctl.controller) return run(() => {});
    const runId = reservation.queuedRunId ?? reservation.threadId;
    // Cover admission and async preparation, before the runner creates its SubTask.
    registry.attachAbort?.(runId, () => abortSub(ctl, 'manual-stop'));
    let lease: Lease | undefined;
    let running = false;
    const off = registry.events?.on('thread:closed', value => {
        if (value === reservation) abortSub(ctl, 'manual-stop');
    });
    const stopped = () => {
        registry.closeThread?.(reservation.threadId, 'system');
        const task = registry.finishQueuedStop?.(reservation.threadId, { background, taskPreview });
        const outcome: RunOutcome = task?.outcome ?? {
            end: { kind: 'stopped', by: reservation.closedBy ?? 'system' },
            completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [],
        };
        return { success: false, ...(reservation.parentConversation ? { parentConversation: reservation.parentConversation } : {}),
            error: t('mcp.delegate.outcome_error', { reason: _outcomeReason(outcome) }),
            stopped_by: 'abort', aspect: reservation.name, tools_used: [], tool_call_details: [], usage: null,
            outcome: _outcomeFields(outcome), effects: [], note: t('mcp.delegate.outcome_note') };
    };
    try {
        const admission = registry.acquire(reservation.owner, runId, ctl.controller.signal, group);
        if (registry.getRunActivity?.(runId) === 'queued') onQueued?.();
        lease = await admission;
        if (ctl.aborted || reservation.phase === 'closed' || _moduleUnloaded) return stopped();
        // The closed-thread listener belongs only to admission, never to runner finalization.
        off?.();
        running = true;
        // The actual runner owns the lease, even if its timeout returns before it settles.
        let executors = 0;
        let releaseRequested = false;
        const releaseIfSettled = () => {
            if (!releaseRequested || executors > 0) return;
            lease?.release(); lease = undefined;
        };
        const admissionControl: RunAdmission = {
            release: () => { releaseRequested = true; releaseIfSettled(); },
            retainExecutor: () => {
                executors++;
                let settled = false;
                return () => {
                    if (settled) return;
                    settled = true; executors--; releaseIfSettled();
                };
            },
            resume: async () => {
                releaseRequested = false;
                if (!lease) lease = await registry.acquire!(reservation.owner, runId, ctl.controller!.signal, group);
            },
        };
        const result = await run(() => admissionControl.release(), admissionControl);
        if (registry.getThread?.(reservation.threadId)?.phase === 'closed' && reservation.queuedRunId === runId
            && !registry.getTask?.(runId)) return stopped();
        if (reservation.phase === 'queued') {
            if (result.success === false) registry.finishQueuedFailure?.(reservation.threadId,
                { error: typeof result.error === 'string' && result.error.trim()
                    ? result.error : t('mcp.delegate.runner_init_failed'), background, taskPreview });
            else stopped();
        }
        const metadata = registry.getTask?.(runId)?.parentConversation ?? reservation.parentConversation;
        return metadata && !result.parentConversation ? { ...result, parentConversation: metadata } : result;
    } catch (error) {
        if (ctl.aborted || !lease || reservation.phase === 'closed') return stopped();
        const message = maskSensitiveData(String((error as Error)?.message ?? error));
        registry.finishQueuedFailure?.(reservation.threadId, { error: message, background, taskPreview });
        return { success: false, error: message, ...(reservation.parentConversation ? { parentConversation: reservation.parentConversation } : {}) };
    } finally {
        off?.();
        if (!running) lease?.release();
    }
}

/** Configuration and actual model selection only: no reservation, lease, runner or stream.
 * P3 exposes the same ladder to the pre-admission consent step; P4 connects that step.
 */
export function prepareDelegateExecution(
    args: DelegateTaskDef,
    resolved: ResolvedDelegate,
    activeAgent: DelegatingAgent,
    agentManager: DelegateAgentManager,
    plugin: DelegatePlugin,
    runControl: SubRunControl = {},
): { success: false; error: string } | { success: true; subAgentConfig: SubAgentConfigLike; finalModel: StreamingModelLike } {
    // Generyczny worker (syntetyczny config) albo custom sub usera po nazwie.
    // Gdy user wyznaczył globalny szablon suba — worker bierze jego config (fail-soft).
    let subAgentConfig: SubAgentConfigLike | null | undefined;
    const existingThread = runControl.threadId ? plugin.subTaskRegistry?.getThread?.(runControl.threadId) : undefined;
    if (existingThread) {
        subAgentConfig = existingThread.config.subConfig as SubAgentConfigLike;
    } else if (resolved.generic) {
        subAgentConfig = resolveGenericWorkerConfig(plugin);
    } else if (resolved.builtin) {
        // Wbudowana para. Explorer = tani zwiad read-only, worker = klasa rodzica.
        subAgentConfig = resolved.builtin === 'worker'
            ? buildBuiltinWorkerConfig(plugin, activeAgent, runControl.callerToolNames)
            : buildBuiltinExplorerConfig();
    } else {
        subAgentConfig = agentManager.resolveSubAgentConfig((resolved.delegate as DelegateEntry).name, activeAgent);
        if (!subAgentConfig) {
            return { success: false, error: t('mcp.delegate.config_not_found', { name: (resolved.delegate as DelegateEntry).name }) };
        }
    }

    // Recheck at actual start, after queueing/config resolution. Lead calls retain the old path.
    if (runControl.subRunContext) {
        const ancestors = plugin.subTaskRegistry?.getDelegationAncestors?.(runControl.subRunContext, activeAgent.name || '');
        if (!ancestors) return { success: false, error: 'Invalid sub-agent parent context.' };
        if (ancestors.some(task => task.name.toLowerCase() === subAgentConfig.name.toLowerCase())) {
            return { success: false, error: 'Cannot delegate to self or ancestor configuration.' };
        }
    }

    // Kolejny bieg bierze wyłącznie model zamrożony w wątku. Nie może spaść na aktualny
    // default ani model głównego czatu, bo runner odrzuciłby zmianę już po beginRun.
    const frozen = existingThread?.config;
    const frozenProviderId = typeof frozen?.providerId === 'string' ? frozen.providerId : '';
    const frozenModelId = typeof frozen?.modelId === 'string' ? frozen.modelId : '';
    const role = _resolveModelRole(subAgentConfig);
    let pinnedAgentModel: StreamingModelLike | null = null;
    if (frozen) {
        const providers = plugin.env?.config?.chat?.providers;
        const library = plugin.env?.settings?.pkmAssistant?.modelLibrary;
        const pinnedModel = subAgentConfig.model === frozenModelId
            || subAgentConfig.model === `${frozenProviderId}/${frozenModelId}`;
        const listedOrPinned = !library || pinnedModel || Object.values(library).some(entries => entries?.some(entry =>
            entry.platform === frozenProviderId && entry.model === frozenModelId));
        // Nadpisanie agenta może wskazywać model spoza biblioteki. Sprawdzamy je przez tę
        // samą drabinkę co przy pierwszym biegu, zanim uznamy zamrożony model za usunięty.
        if (!listedOrPinned) {
            const selected = createModelForRole(plugin, role, activeAgent, subAgentConfig);
            if (selected?.stream && selected.modelId === frozenModelId && selected.providerId === frozenProviderId) {
                pinnedAgentModel = selected;
            }
        }
        const modelAvailable = listedOrPinned || Boolean(pinnedAgentModel);
        if (!frozenProviderId || !frozenModelId || !providers || !Object.hasOwn(providers, frozenProviderId) || !modelAvailable) {
            if (existingThread?.phase === 'queued') plugin.subTaskRegistry?.finishQueuedFailure?.(existingThread.threadId,
                { error: t('mcp.sub_agent.model_unavailable'), background: runControl.background, taskPreview: args.task });
            else if (existingThread) plugin.subTaskRegistry?.closeThread?.(existingThread.threadId);
            return { success: false, error: t('mcp.sub_agent.model_unavailable') };
        }
    }
    // Nowy sub używa dotychczasowej drabinki roli. Kontynuacja używa modelu agenta
    // tylko przy dokładnej zgodności z wątkiem, a w pozostałych przypadkach podaje
    // zamrożoną parę jako jawny wybór.
    const model: StreamingModelLike | null = frozen
        ? pinnedAgentModel ?? createModelForRole(plugin, role, { name: activeAgent.name,
            models: { [role]: { platform: frozenProviderId, model: frozenModelId } } }, null)
        : createModelForRole(plugin, role, activeAgent, subAgentConfig);
    // Brak modelu roli nowego suba: użyj konfiguracji main, ale z osobną instancją dla biegu.
    // Wspólny env.chatModel należy do czatu, więc Stop suba nie może do niego trafić.
    const finalModel = frozen ? model : model?.stream ? model : createModelForRole(plugin, 'main', activeAgent, null, true);

    if (frozen && (!finalModel?.stream || finalModel.modelId !== frozenModelId || finalModel.providerId !== frozenProviderId)) {
        if (existingThread?.phase === 'queued') plugin.subTaskRegistry?.finishQueuedFailure?.(existingThread.threadId,
                { error: t('mcp.sub_agent.model_unavailable'), background: runControl.background, taskPreview: args.task });
            else if (existingThread) plugin.subTaskRegistry?.closeThread?.(existingThread.threadId);
        return { success: false, error: t('mcp.sub_agent.model_unavailable') };
    }

    if (!finalModel?.stream) {
        return { success: false, error: t('mcp.delegate.no_model') };
    }

    return { success: true, subAgentConfig, finalModel };
}

async function _executeSubAgent(
    args: DelegateTaskDef,
    resolved: ResolvedDelegate,
    activeAgent: DelegatingAgent,
    agentManager: DelegateAgentManager,
    plugin: DelegatePlugin,
    makeRunner: (plugin: DelegatePlugin) => SubAgentRunnerLike,
    delegationDepth = 1,
    runControl: SubRunControl = {},
): Promise<Record<string, unknown>> {
    // Zamknięcie mogło nadejść po wejściu do thunka, ale przed przygotowaniem modelu.
    // Zapisujemy zwykły zakończony bieg i wracamy tą samą ścieżką outcome co runner.
    if (runControl.queuedThreadId) {
        const queued = plugin.subTaskRegistry?.getThread?.(runControl.queuedThreadId);
        if (queued?.phase === 'closed') {
            const task = plugin.subTaskRegistry?.finishQueuedStop?.(runControl.queuedThreadId, {
                background: runControl.background,
                taskPreview: args.task,
            });
            const outcome: RunOutcome = {
                end: { kind: 'stopped', by: task?.outcome?.end.kind === 'stopped' ? task.outcome.end.by : queued.closedBy ?? 'user' },
                completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [],
            };
            const name = _queuedThreadName(resolved, plugin);
            return {
                success: false,
                error: t('mcp.delegate.outcome_error', { reason: _outcomeReason(outcome) }),
                stopped_by: 'abort', aspect: name, tools_used: [], tool_call_details: [], usage: null,
                outcome: _outcomeFields(outcome), effects: [], note: t('mcp.delegate.outcome_note'),
            };
        }
    }
    if (runControl.invocationCancelled?.() || runControl.abortCtl?.aborted) {
        return { success: false, error: t('mcp.delegate.share.cancelled') };
    }
    if (runControl.prepared && !isPreparedParentDelegationCurrent(runControl.prepared,
        runControl.abortCtl?.controller?.signal ?? new AbortController().signal, runControl.validatePrepared ?? (() => false))) {
        return { success: false, error: t('mcp.delegate.share.cancelled') };
    }
    const preparation = runControl.prepared ?? prepareDelegateExecution(args, resolved, activeAgent, agentManager, plugin, runControl);
    if (!preparation.success) return preparation;
    const { subAgentConfig, finalModel } = preparation;

    // Sub NIGDY nie wyprzedza głównego czatu w kolejce bramki platformy lokalnej
    // (`ChatModel.stream` czyta `_gatePriority`, brak = 1 = main). Delegacja
    // domyślnie leci w tle, więc sub i czat realnie biją się o jeden slot mostu.
    (finalModel as { _gatePriority?: number })._gatePriority = 0;

    const subAgentRunner = plugin.toolRegistry ? makeRunner(plugin) : null;
    if (!subAgentRunner) {
        return { success: false, error: t('mcp.delegate.runner_init_failed') };
    }

    // Uzbrojenie kontrolki abortu: od tej chwili timeout delegacji umie ubić stream modelu
    // tego suba (twardy xhr.abort + zwolnienie biletu bramki przez stopStream).
    const ownedModel = Object.create(finalModel) as RunAgentLoopOptions['model'];
    const sourceModel = finalModel as RunAgentLoopOptions['model'];
    let requestStopped = false;
    ownedModel.stream = (...streamArgs: Parameters<RunAgentLoopOptions['model']['stream']>) => {
        requestStopped = false;
        return sourceModel.stream(...streamArgs);
    };
    ownedModel.stopStream = () => {
        if (requestStopped) return;
        requestStopped = true;
        try { sourceModel.stopStream?.(); }
        catch { /* cancelling one request must not break task timeout */ }
    };
    if (runControl.abortCtl) runControl.abortCtl.stop = () => ownedModel.stopStream?.();

    // Build task prompt with context — jednolity cap dla WSZYSTKICH subów (bez tego researcher
    // biegłby bez capu — dziura tokenowa).
    // Wartość to budżet `delegation_context_max_chars` z `config/limits.js` (default 48000),
    // który user może zmienić w Ustawieniach → Limity, nie hardcode.
    let taskPrompt = args.task as string;
    if (args.context) {
        const maxContextLen = getLimits(plugin?.env?.settings).delegation_context_max_chars;
        const ctx = args.context.length > maxContextLen
            ? args.context.slice(0, maxContextLen) + '\n' + t('mcp.delegate.truncated')
            : args.context;
        taskPrompt = `${t('mcp.delegate.context_header')}\n${ctx}\n${t('mcp.delegate.context_footer')}\n\n${t('mcp.delegate.task_header')}\n${args.task}\n${t('mcp.delegate.task_footer')}`;
    }
    if (runControl.dependencyContext?.text) taskPrompt += `\n\n${runControl.dependencyContext.text}`;

    // `scope.folders` custom suba nie jest samą wskazówką w prompcie — jedzie do
    // łańcucha uprawnień jako DODATKOWE zawężenie (przecięcie rodzic∩sub). Puste/brak = zero
    // nowych ograniczeń. Pozostałe pola scope (frontmatter/sections/pinned_notes) zostają
    // wskazówkami promptowymi — nie da się ich egzekwować na ścieżce.
    const childScopeFolders = Array.isArray(subAgentConfig.scope?.folders) && subAgentConfig.scope.folders.length > 0
        ? subAgentConfig.scope.folders
        : null;
    // Zakres dziecka = PRZECIĘCIE z zakresem WOŁAJĄCEGO, nie tylko konfig dziecka — inaczej
    // wnuk odpalony przez wąskiego suba startowałby z `null`, czyli z pełnym zasięgiem
    // agenta-rodzica. Rozłączne zakresy (dziecko deklaruje folder, do którego wołający nie
    // ma wstępu) = odmowa fail-closed.
    const scopeFolders = AccessGuard.intersectScopeFolders(
        runControl.callerScopeFolders,
        childScopeFolders as ScopeFolders | null,
    );
    if (Array.isArray(scopeFolders) && scopeFolders.length === 0) {
        log.warn('DelegateTool', `Delegacja ODRZUCONA: zakres "${subAgentConfig.name}" rozłączny z zakresem wołającego`);
        return { success: false, error: t('mcp.delegate.scope_disjoint', { name: subAgentConfig.name }) };
    }

    let actualTaskId: string | undefined;
    let result: SubAgentRunResult;
    try { result = await subAgentRunner.runTask(
        taskPrompt,
        activeAgent,
        subAgentConfig,
        ownedModel,
        {
            delegationDepth,
            ...(runControl.prepared ? { parentConversation: runControl.prepared.parentConversation,
                onParentConversationPrepared: (metadata: ParentConversationPreparation) => {
                    const id = actualTaskId ?? runControl.reservedRunId ?? runControl.queuedThreadId;
                    if (id) plugin.subTaskRegistry?.setParentConversation?.(id, metadata);
                } } : {}),
            admission: runControl.admission,
            scopeFolders,
            // Trzeci składnik przecięcia narzędzi — whitelista wołającego.
            ...(runControl.callerToolNames ? { callerToolNames: runControl.callerToolNames } : {}),
            // Budżet modelu suba = budżet ZADANIA (spójne budziki). Bez tego per-call timer
            // brał globalny delegation_timeout_ms, który bywa dużo dłuższy niż timeout taska.
            ...(runControl.modelTimeout ? { modelTimeout: runControl.modelTimeout } : {}),
            ...(runControl.abortCtl ? {
                shouldAbort: () => runControl.abortCtl!.aborted,
                abortSignal: runControl.abortCtl.controller?.signal,
                abortReason: () => runControl.abortCtl!.reason || 'manual-stop',
            } : {}),
            // Budżet zadania ma liczyć czas ROBOTY, nie czekania w kolejce bramki.
            ...(runControl.onGateAdmitted ? { onGateAdmitted: runControl.onGateAdmitted } : {}),
            ...(runControl.onActivity ? { onActivity: runControl.onActivity } : {}),
            ...(runControl.onQuestion ? { onQuestion: runControl.onQuestion } : {}),
            // Przelot do rejestru biegów — runner ich nie interpretuje, my też nie.
            ...(runControl.origin ? { origin: runControl.origin } : {}),
            ...(runControl.subRunContext ? { parentId: runControl.subRunContext.runId } : {}),
            // Tryb pytań tury zlecającej — zamrożony, jak `scopeFolders`.
            ...(runControl.autonomy ? { autonomy: runControl.autonomy } : {}),
            ...(runControl.background !== undefined ? { background: runControl.background } : {}),
            onTaskCreated: (task: SubTask) => { actualTaskId = task.id; runControl.onTaskCreated?.(task); },
            ...(runControl.threadId ? { threadId: runControl.threadId } : {}),
            turnKind: runControl.turnKind,
            turnStartedSeq: runControl.turnStartedSeq,
            ...(runControl.reservedRunId ? { reservedRunId: runControl.reservedRunId } : {}),
            ...(runControl.queuedThreadId ? { queuedThreadId: runControl.queuedThreadId } : {}),
        }
    ); } finally { if (runControl.abortCtl) runControl.abortCtl.stop = null; }

    // ── Uczciwość niepowodzenia ──
    // Runner oznacza flagą `failed` wyłącznie bieg, który padł na wyjątku — bez tego rozróżnienia
    // taki bieg wracałby tą samą drogą co sukces (`success:true` + tekst błędu w `result`),
    // więc model referowałby go użytkownikowi jako wykonane zadanie. Zamiast tego mówimy wprost: nie wyszło.
    if (result.failed) {
        return {
            success: false,
            ...(result.parentConversation ? { parentConversation: result.parentConversation } : {}),
            error: typeof result.result === 'string' ? result.result : _rawResultToString(result.result),
            aspect: subAgentConfig.name,
            stopped_by: 'error',
            ...(result.stopReason ? { stop_reason: result.stopReason } : {}),
            ...(result.partial ? { partial: result.partial } : {}),
            ...(result.question ? { question: result.question } : {}),
            ...(result.handoff ? { partial_result: result.handoff } : {}),
            tools_used: result.toolsUsed || [],
            tool_call_details: result.toolCallDetails || [],
            usage: result.usage || null,
            duration_ms: result.duration,
            ...(result.outcome ? { outcome: _outcomeFields(result.outcome), effects: result.outcome.effects } : {}),
        };
    }

    // Starszy kształt bez outcome zachowuje odpowiedź historyczną.
    if (result.outcome) {
        const outcome = result.outcome;
        const details = result.toolCallDetails || [];
        const resultText = _rawResultToString(result.result);
        const cap = runControl.salvageCap ?? DEFAULT_LIMITS.subagent_salvage_max_chars;
        const partialText = (result.handoff?.trim() || resultText.trim() || _digestFromToolDetails(details, cap)).slice(0, cap);
        const common = {
            ...(result.parentConversation ? { parentConversation: result.parentConversation } : {}),
            aspect: subAgentConfig.name,
            ...(result.stoppedBy ? { stopped_by: result.stoppedBy } : {}),
            ...(result.stopReason ? { stop_reason: result.stopReason } : {}),
            ...(result.partial ? { partial: result.partial } : {}),
            ...(result.question ? { question: result.question } : {}),
            tools_used: result.toolsUsed || [], tool_call_details: details,
            usage: result.usage || null, duration_ms: result.duration,
            outcome: _outcomeFields(outcome), effects: outcome.effects,
        };
        if (outcome.completeness !== 'unconfirmed') {
            return {
                success: false,
                error: t('mcp.delegate.outcome_error', { reason: _outcomeReason(outcome, result.stopReason) }),
                ...(partialText ? { partial_result: partialText } : {}),
                note: t('mcp.delegate.outcome_note'), ...common,
            };
        }
        return {
            success: true, result: result.result, ...common,
            aspect_type: subAgentConfig.role || 'researcher', aspect_explicit: args.aspect_explicit === true,
        };
    }

    return {
        success: true,
        ...(result.parentConversation ? { parentConversation: result.parentConversation } : {}),
        result: result.result,
        aspect: subAgentConfig.name,
        // Etykieta z YAML suba — przekazywana do UI/token-trackera; fallback 'researcher'.
        aspect_type: subAgentConfig.role || 'researcher',
        aspect_explicit: args.aspect_explicit === true,
        // Sposób zejścia leci do modelu razem z wynikiem. `backstop` = subowi skończyły
        // się iteracje (wynik może być niepełny albo być zaślepką), `abort` = ubity w locie.
        // Stary runner bez tego pola → `undefined` (fail-soft).
        ...(result.stoppedBy ? { stopped_by: result.stoppedBy } : {}),
        ...(result.stopReason ? { stop_reason: result.stopReason } : {}),
        ...(result.partial ? { partial: result.partial } : {}),
        ...(result.question ? { question: result.question } : {}),
        tools_used: result.toolsUsed,
        tool_call_details: result.toolCallDetails || [],
        duration_ms: result.duration,
        usage: result.usage || null,
    };
}

// Powód końca po ludzku: te same teksty, którymi pętla opisuje stopReason (klucze dosłowne,
// żeby strażnik parytetu i18n je widział). `natural` bez odpowiedzi ma własny tekst.
const STOP_REASON_TEXT_KEY = {
    natural: 'mcp.delegate.reason_no_answer',
    'iteration-limit': 'agentLoop.reason_iteration-limit',
    'tool-uncertain': 'agentLoop.reason_tool-uncertain',
    'synthesis-budget': 'agentLoop.reason_iteration-then-synthesis-budget',
    'manual-stop': 'agentLoop.reason_manual-stop',
    'task-timeout': 'agentLoop.reason_task-timeout',
    superseded: 'agentLoop.reason_superseded',
    silence: 'agentLoop.reason_silence',
    'model-timeout': 'agentLoop.reason_model-timeout',
    'transport-error': 'agentLoop.reason_transport-error',
    'model-error': 'agentLoop.reason_model-error',
    'hook-error': 'agentLoop.reason_hook-error',
} satisfies Record<AgentLoopStopReason['kind'], string>;

function _outcomeReason(outcome: RunOutcome, stopReason?: AgentLoopStopReason): string {
    if (stopReason) return t(STOP_REASON_TEXT_KEY[stopReason.kind]);
    // Starsze wyniki bez stopReason: powód z samego outcome.end.
    const end = outcome.end;
    switch (end.kind) {
        case 'finished': return t('mcp.delegate.reason_no_answer');
        case 'limit': return t(STOP_REASON_TEXT_KEY[end.reason]);
        case 'uncertain': return t('agentLoop.reason_tool-uncertain');
        case 'stopped': return t('agentLoop.reason_manual-stop');
        case 'timeout': return t('agentLoop.reason_task-timeout');
        case 'failed': return t('agentLoop.reason_hook-error');
        default: {
            const exhaustive: never = end;
            void exhaustive;
            return t('mcp.delegate.reason_no_answer');
        }
    }
}

function _outcomeFields(outcome: RunOutcome): Pick<RunOutcome, 'end' | 'completeness' | 'hasAnswer' | 'hasMaterial'> {
    return {
        end: outcome.end,
        completeness: outcome.completeness,
        hasAnswer: outcome.hasAnswer,
        hasMaterial: outcome.hasMaterial,
    };
}

function _aggregateResults(results: unknown[]) {
    const counts = { finished: 0, partial: 0, failed: 0 };
    for (const value of results) {
        const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        if (result.success === true) counts.finished++;
        else if (typeof result.partial_result === 'string' || (result.outcome as RunOutcome | undefined)?.completeness === 'partial') counts.partial++;
        else counts.failed++;
    }
    // Pusta lista (np. wszystkie zadania odrzucone) nie jest sukcesem.
    return { success: results.length > 0 && counts.finished === results.length, counts, results };
}

/**
 * Ile zadań delegacji wolno biec naraz.
 *
 * Sonda: model slotu researcher (ten sam, którego dostanie generyczny worker) pytany
 * o pojemność bramki swojej platformy (`ChatModel._streamGateLimit` — jedna
 * logika, zero duplikacji isLocalPlatform+limits). Bramka N > 0 (platforma lokalna)
 * → N zadań naraz; 0 / brak metody (chmura, atrapy testowe) → pełna równoległość.
 *
 * Świadomy skrót: custom sub może mieć w YAML własny model na INNEJ platformie niż
 * slot researchera — wtedy szerokość liczona jest z platformy domyślnej. Konserwatywnie:
 * najgorszy skutek to zbędna sekwencja, nigdy zarżnięta bramka.
 */
function _resolveTaskConcurrency(
    plugin: DelegatePlugin | null | undefined,
    activeAgent: DelegatingAgent,
    taskCount: number,
): number {
    try {
        const probe: StreamingModelLike | null = createModelForRole(plugin, 'researcher', activeAgent, null);
        const probeModel = probe?.stream ? probe : (plugin?.env?.chatModel?.stream ? plugin.env.chatModel : null);
        const gateLimit = typeof probeModel?._streamGateLimit === 'function' ? probeModel._streamGateLimit() : 0;
        if (Number.isFinite(gateLimit) && gateLimit > 0) return Math.max(1, Math.min(gateLimit, taskCount));
    } catch (e) {
        log.warn('DelegateTool', `Sonda przepustowości platformy padła (${(e as Error)?.message || String(e)}) — jadę pełną równoległością`);
    }
    return taskCount;
}

/**
 * Pula o stałej szerokości: `limit` robotników zjada thunki po kolei, wyniki wracają
 * w kolejności wejścia. Thunk startuje dopiero, gdy robotnik po niego sięgnie — dzięki
 * temu `_withTimeout` taska liczy od realnego startu, nie od złożenia paczki.
 *
 * `_moduleUnloaded` świadomie NIE jest sprawdzany tutaj, w robotniku puli. Bramkę `gates[i]`
 * otwiera WYŁĄCZNIE sam thunk (na starcie przy odrzuconym precheck, w `onTaskCreated`, albo
 * w `.finally()`) — gdyby robotnik pytał o flagę PRZED wywołaniem `thunks[i]()` i przy trafieniu
 * robił `continue`, pominięty thunk nigdy by tej bramki nie otworzył. Ścieżka tła (`execute`)
 * czeka na te bramki (`await Promise.all(acceptedGates...opened)`), więc wisiałaby
 * W NIESKOŃCZONOŚĆ zamiast wrócić z odmową. Guard mieszka dziś WEWNĄTRZ każdego
 * thunka (`taskThunks` w `execute`), gdzie `gate` jest w zasięgu i zdąży się otworzyć.
 */
type ReadyPoolDriver = PlanReadyDriver & {
    /** Settle this node's failure before returning its tool result; other branches continue. */
    onError(index: number, error: unknown): unknown;
};

async function _runWithConcurrency(thunks: Array<() => Promise<unknown>>, limit: number, driver?: ReadyPoolDriver): Promise<unknown[]> {
    if (driver) {
        // Unstarted terminal nodes leave undefined entries for the plan report adapter.
        const results = new Array<unknown>(thunks.length).fill(undefined);
        const workers = Array.from({ length: Math.max(1, Math.min(limit, thunks.length)) }, async () => {
            for (;;) {
                const i = await driver.nextReady();
                if (i === undefined) return;
                if (!driver.canDispatch(i)) continue;
                try { results[i] = await thunks[i](); }
                catch (error: unknown) { results[i] = driver.onError(i, error); }
            }
        });
        await Promise.all(workers);
        return results;
    }
    const results = new Array<unknown>(thunks.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, thunks.length)) }, async () => {
        while (next < thunks.length) {
            const i = next++;
            results[i] = await thunks[i]();
        }
    });
    await Promise.all(workers);
    return results;
}

/**
 * Grace-okno na finalne podsumowanie. Podawane do `_withTimeout` przez wołacza,
 * bo tylko on wie, którym `task.id` zapytać rejestr o stan biegu.
 */
type FinalGrace = {
    /** Ile ms doliczamy, gdy budzik złapał suba w finalnej iteracji. */
    ms: number;
    /** Czy odroczyć abort? Wołane DOKŁADNIE RAZ, w momencie strzału głównego budzika. */
    shouldDefer: () => boolean;
    /** Ślad odroczenia (`registry.step(task,'timeout.grace')`). Nigdy nie może rzucić na zewnątrz. */
    onDefer?: () => void;
};

/**
 * „Przezbrój budzik zadania przy PIERWSZYM wjeździe na slot bramki".
 *
 * Budżet zadania (`delegation_timeout_ms`, default 120 s) nie może liczyć się od złożenia
 * zlecenia, bo obejmowałby też CZEKANIE w kolejce bramki platformy lokalnej (limit 1).
 * Worker leci z priorytetem 0, czyli za rozmową główną — bez tego przezbrojenia sub mógłby
 * przeczekać większość budżetu w samej kolejce i zginąć z komunikatem „anulowany w kolejce
 * bramki", nie dowożąc zadania, mimo że realnie pracował tylko chwilę.
 *
 * Kontrakt: `signal()` woła pętla przy KAŻDYM admicie, ale liczy się TYLKO PIERWSZY —
 * kolejki w środku biegu świadomie wliczają się do budżetu, bo inaczej bieg nie miałby sufitu.
 * `attach()` podaje funkcję „licz budżet od teraz" i jest odporne na kolejność.
 *
 * ⚠️ Świadome odstępstwo od literalnego zlecenia („uzbrój dopiero przy pierwszym sygnale"):
 * budzik jest uzbrojony OD RAZU i przy pierwszej admisji liczony OD NOWA. Powód: sub, który
 * slotu nigdy nie dostanie (albo model, który sygnału nie emituje — atrapy w testach, obce
 * implementacje `LoopModelLike`), zostałby bez żadnego sufitu. Efekt dla realnego przypadku
 * jest identyczny: po wjeździe na slot zadanie ma PEŁNY budżet na robotę.
 */
type GateArm = { signal: () => void; activity: (activity: RunActivity) => void; attach: (rearm: () => void, activity: (activity: RunActivity) => void) => void };

function _makeGateArm(): GateArm {
    let rearm: (() => void) | null = null;
    let signalled = false;
    let done = false;
    let activityHandler: ((activity: RunActivity) => void) | null = null;
    let lastActivity: RunActivity | null = null;
    const fire = () => {
        if (done || !rearm || !signalled) return;
        done = true;
        rearm();
    };
    return {
        signal: () => { signalled = true; fire(); },
        activity: (value) => { lastActivity = value; activityHandler?.(value); },
        attach: (fn, handler) => { rearm = fn; activityHandler = handler; fire(); if (lastActivity) handler(lastActivity); },
    };
}

function _withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: unknown,
    defaultTimeoutMs = DEFAULT_TASK_TIMEOUT_MS,
    onTimeout: (() => void) | null = null,
    grace: FinalGrace | null = null,
    arm: GateArm | null = null,
    salvage: SalvageMapper | null = null,
): Promise<T | { success: false; error: string }> {
    const timeout = Number(timeoutMs);
    const effectiveTimeout = Number.isFinite(timeout) && timeout > 0 ? timeout : defaultTimeoutMs;
    // Budzik MUSI zostać rozbrojony po rozstrzygnięciu wyścigu. Bez `clearTimeout`
    // timer tykałby do końca (domyślnie 120 s) i trzymał proces przy życiu długo po tym, jak
    // sub-agent oddał wynik — widać to jako wiszące testy/harness i zbędny event loop.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let salvageTimer: ReturnType<typeof setTimeout> | null = null;
    // Po rozstrzygniętym wyścigu spóźniony sygnał bramki nie może uzbroić NOWEGO budzika —
    // `finally` już posprzątał, więc taki timer byłby wyciekiem (wzór `settled` z AgentLoop).
    let settled = false;
    // Znacznik „budzik strzelił" — po nim wynik wyścigu (skądkolwiek przyszedł)
    // jest mapowany na uczciwy timeout z dorobkiem (patrz `.then` na dole).
    let timeoutFiredMs: number | null = null;
    const timeoutPromise = new Promise<{ success: false; error: string }>(resolve => {
        // Timeout musi UBIĆ bieg suba, nie tylko go porzucić. Porzucony sub mieliłby dalej
        // do własnego timeoutu (nawet 600 s przy podkręconych limitach), trzymając slot
        // bramki platform lokalnych — główny czat stałby w kolejce za trupem.
        const kill = (waitedMs: number) => {
            timeoutFiredMs = waitedMs;
            try { onTimeout?.(); } catch { /* abort nie może przykryć timeoutu */ }
            const bare = {
                success: false as const,
                error: `Sub-agent timeout after ${waitedMs}ms`
            };
            // Ratowanie dorobku: abort właśnie poleciał, a ubity bieg zwykle domyka
            // się w milisekundach (stream reject `_aborted` → pętla `finalize('abort')` →
            // runner oddaje częściowy wynik). Dajemy mu krótkie okno, żeby wyścig wygrał
            // DOROBEK, nie goła zwrotka; brak rozstrzygnięcia w oknie = błąd jak dotąd.
            // Bez mappera (salvage wyłączony) resolve leci od ręki, bez czekania na dorobek.
            if (!salvage) { resolve(bare); return; }
            salvageTimer = _nodeSafeSetTimeout(() => resolve(bare), SALVAGE_SETTLE_MS);
        };
        let remaining = effectiveTimeout;
        let since = performance.now();
        let waiting = false;
        let expired = false;
        const armTimer = () => {
            if (settled) return;
            if (timer !== null) _nodeSafeClearTimeout(timer); // przezbrojenie liczy budżet od nowa
            since = performance.now();
            if (waiting || expired) return;
            timer = _nodeSafeSetTimeout(() => {
                expired = true;
                timer = null;
                // Budżet zadania obejmuje CAŁY bieg, więc budzik potrafi strzelić dokładnie
                // wtedy, gdy sub pisze już finalne podsumowanie — zadanie spaliłoby pełny czas na
                // narzędzia i oddało zaślepkę zamiast dorobku. Jeśli bieg jest w finalnej
                // iteracji, dokładamy JEDNORAZOWE okno; w zwykłej iteracji ubijamy jak dotąd.
                let defer = false;
                try { defer = grace ? grace.shouldDefer() === true : false; }
                catch { defer = false; /* sonda rejestru nie może przykryć timeoutu */ }
                if (!defer) return kill(effectiveTimeout);

                try { grace!.onDefer?.(); } catch { /* ślad jest miły, nie obowiązkowy */ }
                graceTimer = _nodeSafeSetTimeout(() => kill(effectiveTimeout + grace!.ms), grace!.ms);
            }, remaining);
        };
        // Budzik tyka od zlecenia (siatka bezpieczeństwa dla suba, który slotu nigdy nie
        // dostanie), a przezbraja się przy PIERWSZYM wjeździe na slot — od tej chwili
        // zadanie ma pełny budżet na samą robotę, bez czasu przestanego w kolejce.
        armTimer();
        arm?.attach(() => { remaining = effectiveTimeout; armTimer(); }, activity => {
            if (settled || expired) return;
            if ((activity.kind === 'waiting' || activity.kind === 'waiting-children' || activity.kind === 'queued') && !waiting) {
                remaining = Math.max(0, remaining - (performance.now() - since));
                waiting = true;
                if (timer !== null) _nodeSafeClearTimeout(timer);
                timer = null;
            } else if (activity.kind === 'working' && waiting) {
                waiting = false;
                armTimer();
            }
        });
    });
    // Przed strzałem budzika odrzucenie biegu leci jak dotąd (wołacz ma catch).
    // PO strzale okno salvage trzyma wyścig otwarty — odrzucenie ubitego biegu (abort
    // potrafi zejść wyjątkiem) nie może wtedy wywrócić delegacji, tylko wraca gołą zwrotką.
    const guarded = promise.catch((err) => {
        if (timeoutFiredMs !== null) {
            return { success: false as const, error: `Sub-agent timeout after ${timeoutFiredMs}ms` };
        }
        throw err;
    });
    return Promise.race([guarded, timeoutPromise]).then((value) => {
        // Budzik strzelił, ale wyścig mógł wygrać DOMKNIĘTY bieg (abort oddał
        // częściowy wynik jako success). Bez mapowania timeout wracałby wtedy jako pełny
        // sukces — mapper przemapowuje go na `{success:false, partial_result}`. Zwrot null
        // z mappera (prawdziwy błąd biegu / goła zwrotka budzika) = wartość bez zmian.
        if (timeoutFiredMs === null || !salvage) return value;
        try {
            const mapped = salvage(value, timeoutFiredMs);
            return (mapped ?? value) as T | { success: false; error: string };
        } catch { return value; /* salvage nie może przykryć wyniku */ }
    }).finally(() => {
        settled = true;
        if (timer !== null) _nodeSafeClearTimeout(timer);
        if (graceTimer !== null) _nodeSafeClearTimeout(graceTimer);
        if (salvageTimer !== null) _nodeSafeClearTimeout(salvageTimer);
    });
}

export const __test__ = {
    _executeSubAgent,
    _resolveDelegate,
    _withTimeout,
    // Uzbrojenie budzika zadania na pierwszym wjeździe na slot bramki.
    _makeGateArm,
    _resolveTaskConcurrency,
    _runWithConcurrency,
    resolveGenericWorkerConfig,
    buildWorkerConfigFromTemplate,
    // Wbudowana para explorer/worker — rozpoznanie aspektu, oba syntetyczne configi
    // i mapowanie configu na rolę modelu.
    _resolveBuiltinAspect,
    buildBuiltinExplorerConfig,
    buildBuiltinWorkerConfig,
    _resolveModelRole,
    // Rozpoznanie finalnej iteracji z kroków karty biegu + fabryka grace-okna.
    _isInFinalSummary,
    _makeFinalGrace,
    // Ratowanie dorobku po strzale budzika zadania.
    _makeSalvageMapper,
    _digestFromToolDetails,
    SALVAGE_SETTLE_MS,
    PKM_EXPLORER_NAME,
    PKM_WORKER_NAME,
    DEFAULT_TASK_TIMEOUT_MS,
    // Księgowość obietnic tła; synchronizacja testów bez pollingu.
    _backgroundCount,
    _settleBackground: async (includeDescendants = false) => {
        // Optional tree drain; the default retains the existing snapshot barrier.
        do { await Promise.allSettled([..._backgroundRuns.keys()]); }
        while (includeDescendants && _backgroundRuns.size);
    },
    _resetBackground: (): void => { _backgroundRuns.clear(); },
    // Ile biegów delegacji ma teraz właściciela (test pilnuje, że zbiór nie przecieka).
    _liveAbortCount: (): number => _liveAborts.size,
    // `_moduleUnloaded` to stan PROCESU (jak `_liveAborts`) — testy, które wołają
    // `stopAllDelegations`, muszą go zerować, żeby nie zatruć kolejnych testów
    // w tym samym procesie AVA.
    _resetModuleUnloaded: (): void => { _moduleUnloaded = false; },
};
