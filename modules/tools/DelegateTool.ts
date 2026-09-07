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
import { SubAgentRunner, DEFAULT_SUB_AGENT_TOOLS, PKM_SUB_NAME } from '../../modules/sub-agents/index.js';
import type { SubTask, SubTaskOrigin } from '../../modules/sub-agents/index.js';
import { createModelForRole } from '../../modules/models/index.js';
import type { ModelRole, ResolverPluginLike } from '../../modules/models/index.js';
import { t } from '../../core/i18n/index.js';
// K11 (AUD-security-008): reguła przecięcia zakresów mieszka tam, gdzie reszta reguł ścieżek.
// AUD-security-128: `maskSensitiveData` — ta sama granica maskowania, co w `SubAgentRunner` (K8).
import { AccessGuard, maskSensitiveData } from '../../core/index.js';
import type { ScopeFolders } from '../../core/index.js';
import { getLimits, DEFAULT_LIMITS } from '../../config/limits.js';
import { log } from '../../core/utils/Logger.js';

/** Pojedyncze zadanie w trybie wielozadaniowym (`args.tasks[]`). */
export interface DelegateTaskDef {
    task?: string;
    aspect?: string;
    context?: string;
    aspect_explicit?: boolean;
    timeout_ms?: number;
}

/** Argumenty `delegate` wg `inputSchema` (+ znaczniki wstrzykiwane przez `MCPClient`). */
interface DelegateToolArgs extends DelegateTaskDef {
    tasks?: DelegateTaskDef[];
    /** F2: `false` = stara ścieżka blokująca. Brak = TŁO (default, wzór Claude Code). */
    background?: boolean;
    _invocationAgentName?: unknown;
    _invocationDelegationDepth?: unknown;
    /** F2: adres zwrotny zlecenia — wstrzykiwany przez `MCPClient` (model go nie poda). */
    _invocationOrigin?: unknown;
    /** K4: tryb autonomii TURY zlecającej — zaufany znacznik od `MCPClient`, zawsze nadpisywany. */
    _invocationAutonomy?: unknown;
    /** K11 (AUD-security-008): `scope.folders` suba ZLECAJĄCEGO — zaufany znacznik od `MCPClient`. */
    _invocationScopeFolders?: unknown;
    /** K11 (AUD-security-072): whitelista narzędzi suba ZLECAJĄCEGO — zaufany znacznik. */
    _invocationToolNames?: unknown;
    [extra: string]: unknown;
}

/**
 * Config sub-agenta widziany przez to narzędzie: część z YAML usera
 * (`resolveSubAgentConfig`), część syntetyczna (`pkm-sub`).
 */
export interface SubAgentConfigLike {
    name: string;
    description: string;
    tools: string[];
    model?: string;
    prompt?: string;
    scope?: { folders?: unknown };
    role?: string;
    max_iterations?: number;
    min_iterations?: number;
    max_tool_result_length?: number;
}

/** Szablon suba z `SubAgentTemplateStore` (S27 Z4) — kształt zbieżny z configiem. */
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

/** F4: wbudowane aspekty pary „zwiadowca / robotnik" (rozpoznawane po dokładnej nazwie). */
export type BuiltinAspect = 'explorer' | 'worker';

/**
 * Wynik `_resolveDelegate`: worker generyczny, wbudowany aspekt (F4), custom sub po nazwie
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
    /** ChatModel: pojemność bramki równoległości platformy (0 = bez bramki, chmura). */
    _streamGateLimit?: () => number;
}

/**
 * Wynik biegu sub-agenta (`SubAgentRunner.runTask`).
 *
 * F5: dwa nowe pola. `stoppedBy` mówi, JAK sub zszedł z biegu (`natural` = domknął sam,
 * `backstop` = skończyły mu się iteracje, `abort` = ubity z zewnątrz, `error` = wyjątek),
 * a `failed` pojawia się WYŁĄCZNIE, gdy bieg realnie padł. Do F5 obu nie było i błąd suba
 * wracał do modelu jako `success:true` z komunikatem błędu w polu `result`.
 */
interface SubAgentRunResult {
    result?: unknown;
    toolsUsed?: unknown;
    toolCallDetails?: unknown[];
    duration?: number;
    usage?: unknown;
    stoppedBy?: string;
    failed?: true;
}

/** Runner sub-agentów w zakresie, jakiego używa to narzędzie. */
interface SubAgentRunnerLike {
    runTask(
        taskPrompt: string,
        parentAgent: DelegatingAgent,
        subAgentConfig: SubAgentConfigLike,
        model: unknown,
        opts: {
            delegationDepth: number;
            scopeFolders: unknown;
            /** Budżet pojedynczego wywołania modelu suba = budżet zadania delegacji. */
            modelTimeout?: number;
            /** Flaga abortu z kontrolki `_withTimeout` — pętla suba staje między iteracjami. */
            shouldAbort?: () => boolean;
            /** Z2: „sub wszedł na slot bramki" — tym uzbraja się budzik zadania. */
            onGateAdmitted?: () => void;
            /** F2: adres zwrotny zlecenia (1:1 do rejestru biegów). */
            origin?: SubTaskOrigin;
            /** F2: bieg w tle (1:1 do rejestru biegów). */
            background?: boolean;
            /** F2: „byt już istnieje" — stąd bierzemy `task_id` dla zwrotki w trybie tła. */
            onTaskCreated?: (task: SubTask) => void;
            /** K4: tryb pytań tury zlecającej, zamrożony na cały bieg. */
            autonomy?: string | null;
            /** K11: whitelista narzędzi wołającego suba (trzeci składnik przecięcia). */
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
    agentManager?: DelegateAgentManager | null;
    /**
     * Rejestr narzędzi. Jego OBECNOŚĆ jest warunkiem odpalenia runnera (rejestr wędruje dalej
     * do `SubAgentRunner`). F4 czyta z niego dodatkowo `filterByAgent` — pełną listę narzędzi
     * rodzica dla wbudowanego aspektu `worker`.
     */
    toolRegistry?: { filterByAgent?(agent: unknown): Array<{ name?: string }> } | null;
    /**
     * F1/F2: księga biegów subów. Jej OBECNOŚĆ jest warunkiem delegacji w tle.
     * F3: przyjmuje też uchwyt „zatrzymaj ten bieg" (`attachAbort`) — patrz `_attachStop`.
     * F5: czytamy z niej kartę biegu (`getTask`) przy strzale budzika i dopisujemy ślad
     * odroczenia (`step`) — patrz `_isInFinalSummary` / grace-okno w `_withTimeout`.
     */
    subTaskRegistry?: {
        attachAbort?: (id: string, fn: () => void) => void;
        getTask?: (id: string) => SubTask | undefined;
        step?: (task: SubTask, type: string, fields?: Record<string, unknown>) => void;
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
 * Syntetyczny config fabrycznego workera `pkm-sub` (D18): delegate BEZ aspect.
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
 * S27 Z4: config workera zbudowany z SZABLONU wskazanego jako globalny
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
    if (tpl.prompt) config.prompt = tpl.prompt;
    if (tpl.scope) config.scope = tpl.scope;
    if (tpl.max_iterations) config.max_iterations = tpl.max_iterations;
    if (tpl.min_iterations) config.min_iterations = tpl.min_iterations;
    if (tpl.max_tool_result_length != null) config.max_tool_result_length = tpl.max_tool_result_length;
    return config;
}

/**
 * S27 D2 (fail-soft): rozwiąż config delegacji BEZ `aspect`.
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

// ── F4 (model policy v2): wbudowana para „zwiadowca / robotnik" ──────────────
//
// Nazwy syntetycznych configów. Świadomie stałe LOKALNE (a nie w `modules/sub-agents`, jak
// `PKM_SUB_NAME`): te byty istnieją wyłącznie na czas jednego wywołania `delegate`, nie mają
// pliku na dysku, nie przechodzą przez loader i nikt poza tym plikiem ich nie zakłada.
const PKM_EXPLORER_NAME = 'pkm-explorer';
const PKM_WORKER_NAME = 'pkm-worker';

/** Wbudowane aspekty rozpoznawane po DOKŁADNEJ nazwie (bez wielkości liter). */
const BUILTIN_ASPECTS: readonly BuiltinAspect[] = ['explorer', 'worker'];

/**
 * F4: czy `aspect` to jeden z wbudowanych? Sprawdzane DOPIERO po custom subach usera —
 * własny sub o nazwie „explorer" ma wygrywać z wbudowanym (patrz `_resolveDelegate`).
 */
function _resolveBuiltinAspect(aspect: string): BuiltinAspect | null {
    const key = aspect.trim().toLowerCase();
    return BUILTIN_ASPECTS.find(a => a === key) || null;
}

/**
 * F4 `aspect:"explorer"` — TANI ZWIADOWCA. Read-only zestaw narzędzi (`DEFAULT_SUB_AGENT_TOOLS`)
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
 * F4 `aspect:"worker"` — ROBOTNIK KLASY RODZICA. Model rodzica (rola `sub_worker`, patrz
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
    // K11 (AUD-security-072): gdy zleca SUB (piętro ≥1), „klasa rodzica" to jego whitelista,
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
 * F4: która rola modelu obsłuży ten config. `role:'worker'` (wbudowany aspekt ALBO custom sub
 * z takim polem w YAML) = model rodzica; wszystko inne = dotychczasowy slot sub-agentów.
 * `config.model` z YAML wygrywa w obu przypadkach — rozstrzyga `createModelForRole`.
 */
function _resolveModelRole(config: SubAgentConfigLike): ModelRole {
    return config.role === 'worker' ? 'sub_worker' : 'researcher';
}

// Hard fallback when no settings/override is available. Source of truth: config/limits.js.
const DEFAULT_TASK_TIMEOUT_MS = DEFAULT_LIMITS.delegation_timeout_ms;

// Front A: ile ms po strzale budzika czekamy, aż UBITY bieg odda częściowy wynik
// (abort → stream reject → pętla finalize → runner). Ta ścieżka trwa milisekundy —
// 1,5 s to zapas na wolny event loop. Sub złapany w środku długiego NARZĘDZIA i tak
// nie zdąży w żadnym rozsądnym oknie (manifesty deklarują timeout_ms 60-180 s, ale
// dla wbudowanych narzędzi to pole dziś NIE JEST egzekwowane — AUD-code-review-003,
// patrz modules/tools/CLAUDE.md — więc zawiśnięcie może trwać znacznie dłużej), więc
// wtedy uczciwie wraca goła zwrotka, jak przed Frontem A.
const SALVAGE_SETTLE_MS = 1500;

// obsidianmd/prefer-window-timers: ten plik wstaje w gołym Node (testy AVA), gdzie `window`
// nie istnieje — `window.setTimeout` byłby ReferenceError. Inline `eslint-disable` jest
// zablokowany dla `obsidianmd/*` (`eslint-comments/no-restricted-disable` w configu pluginu
// recenzenta katalogu). Owijamy globalny timer FUNKCJĄ zamiast zamrażać referencję raz przy
// imporcie — `fn` czyta `setTimeout`/`clearTimeout` DYNAMICZNIE przy każdym wywołaniu, więc
// zachowanie (w tym testowe podmiany `globalThis.clearTimeout`, patrz „S33 A2" w
// DelegateTool.test.ts) jest 1:1 jak bezpośrednie wywołanie globala. Reguła pomija wywołanie,
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
 * Front A: mapper dorobku dla `_withTimeout`. Dostaje wartość, którą wyścig oddał PO strzale
 * budzika, i decyduje, czym delegacja wraca do modelu. Zwrot `null` = zostaw wartość bez zmian.
 */
type SalvageMapper = (value: unknown, waitedMs: number) => Record<string, unknown> | null;

/**
 * Buduje mapper ratowania dorobku (Front A, śledztwo 2026-08-17: trzy explorery × 12 iteracji
 * researchu wyrzucone do kosza przez goły „Sub-agent timeout after 165000ms").
 *
 * Ubity bieg wraca z `_executeSubAgent` jako `success:true, stopped_by:'abort'` z częściowym
 * wynikiem — mapper przemapowuje go na UCZCIWY timeout (`success:false`), ale z polem
 * `partial_result` (tekst biegu albo skrót z `tool_call_details`). Prawdziwy błąd biegu
 * (`success:false`) zostaje nietknięty — timeout nie przykrywa lepszej diagnozy.
 */
function _makeSalvageMapper(salvageCap: number): SalvageMapper {
    return (value, waitedMs) => {
        if (!value || typeof value !== 'object') return null;
        const r = value as Record<string, unknown>;
        if (r.success === false) return null; // goła zwrotka budzika albo realny błąd — bez zmian
        const text = typeof r.result === 'string' ? r.result.trim() : '';
        const partial = (text || _digestFromToolDetails(r.tool_call_details, salvageCap)).slice(0, salvageCap);
        return {
            success: false,
            error: `Sub-agent timeout after ${waitedMs}ms`,
            stopped_by: 'timeout',
            ...(typeof r.aspect === 'string' ? { aspect: r.aspect } : {}),
            ...(partial ? { partial_result: partial } : {}),
            ...(Array.isArray(r.tools_used) && (r.tools_used as unknown[]).length > 0 ? { tools_used: r.tools_used } : {}),
            ...(typeof r.duration_ms === 'number' ? { duration_ms: r.duration_ms } : {}),
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
 * F2: biegi odpalone W TLE, których jeszcze nikt nie rozliczył. Klucz = obietnica biegu
 * (single-task) albo całej puli (multi-task), wartość = ILE ZADAŃ ona niesie.
 *
 * Po co: bramka szerokości `max_parallel_delegations` liczyła dotąd tylko zadania z JEDNEGO
 * wywołania — bo tura i tak czekała na wynik. W tle tura nie czeka, więc model mógłby
 * wystrzelić 5 × 5 zadań w pięciu kolejnych wywołaniach i zarżnąć most lokalny.
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
 * Z7 (AUD-bledy-056): kontrolki abortu WSZYSTKICH biegów delegacji w tym procesie.
 *
 * Po co osobno od rejestru: uchwyt trafia do `SubTaskRegistry` dopiero w `onTaskCreated`,
 * czyli PO rozwiązaniu configu, stworzeniu modelu i zbudowaniu promptu (a to sięga do dysku).
 * Bieg złapany przez `onunload` w tym oknie nie miałby w rejestrze czego zatrzymywać i po
 * wyładowaniu pluginu wystartowałby pętlę na żywym `mcpClient`. Ten zbiór jest właścicielem
 * biegu od pierwszej linijki `execute`, więc `stopAllDelegations` sięga też tam.
 */
const _liveAborts = new Set<SubAbortControl>();

/** Weź kontrolkę pod opiekę; zwrócona funkcja zdejmuje ją (wołana, cokolwiek się z biegiem stanie). */
function _trackAbort(ctl: SubAbortControl): () => void {
    _liveAborts.add(ctl);
    return () => { _liveAborts.delete(ctl); };
}

/**
 * AUD-code-review-001: `_liveAborts` ma właściciela dopiero WEWNĄTRZ thunka (`_trackAbort`
 * w linii wyżej niż ten komentarz sugeruje — patrz `taskThunks` w `execute`), czyli dopiero
 * gdy robotnik puli (`_runWithConcurrency`) po niego sięgnie. Zadanie, które w chwili
 * `stopAllDelegations` jeszcze CZEKA w kolejce (bramka platformy lokalnej = 1, `queued > 0`),
 * jest dla `_liveAborts` niewidzialne — pula sama z siebie odpaliłaby dla niego PEŁNY bieg
 * suba na zdemontowanym pluginie. Ta flaga jest DRUGĄ, wcześniejszą bramką: stan MODUŁU
 * (jak `_liveAborts`/`_backgroundRuns`), sprawdzany na WEJŚCIU do każdego thunka (`taskThunks`
 * w `execute`, NIE w `_runWithConcurrency` — patrz jej docstring, tam guard żył pierwotnie
 * i tam wisiał deadlock: `continue` bez otwarcia `gate`). Zerowana przy każdym starcie
 * pluginu (`createDelegateTool` — tam trafia komentarz o powodzie), więc kolejny `onload`
 * w tym samym procesie (harness) nie dziedziczy odmowy po poprzednim `onunload`; testy mogą
 * też zerować ją ręcznie przez `__test__._resetModuleUnloaded()`.
 */
let _moduleUnloaded = false;

/**
 * Z7: przerwij KAŻDY bieg delegacji tego procesu — demontaż pluginu (`PKMPlugin.onunload`).
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
    let stopped = 0;
    for (const ctl of [..._liveAborts]) {
        try {
            ctl.aborted = true;
            ctl.stop?.();
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
    if (typeof raw.tabKey === 'string') origin.tabKey = raw.tabKey;
    return origin;
}

export function createDelegateTool(app: object, deps: DelegateToolDeps = {}) {
    // AUD-code-review-001: `_moduleUnloaded` jest stanem MODUŁU (jak `_liveAborts`), więc
    // musi mieć jakiś moment "od nowa" — inaczej jeden `onunload` zatruwa WSZYSTKIE kolejne
    // starty pluginu w tym samym procesie (harness: onload/onunload w pętli po scenariuszach).
    // `createDelegateTool` jest wołane DOKŁADNIE RAZ na start pluginu (`src/main.ts`, rejestracja
    // narzędzi w `initialize()`) — najmniejszy diff, który wiąże reset z realnymi narodzinami
    // narzędzia, bez dokładania osobnego eksportu i osobnego wołania w `main.ts`.
    _moduleUnloaded = false;
    const makeRunner = deps.makeRunner || ((plugin: DelegatePlugin) => new SubAgentRunner({
        toolRegistry: plugin.toolRegistry!,
        app,
        plugin
    }) as SubAgentRunnerLike);
    return {
        name: 'delegate',
        description: t('mcp.delegate.desc'),
        inputSchema: {
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
                // S33 (2026-07-30): `extra_tools` WYCIĘTE ze schematu — martwy kontrakt: model
                // ustawiał parametr, a runner wymagał flagi `allowExtraTools`, której nikt nigdy
                // nie podawał (fail-closed: kasacja, nie ożywianie — rozszerzanie narzędzi suba
                // ponad config to decyzja usera w YAML, nie modelu w locie).
                aspect_explicit: {
                    type: 'boolean',
                    description: 'Exact sub-agent match. Used by inline trigger chips and force-delegate UI.'
                },
                timeout_ms: {
                    type: 'number',
                    description: 'Per sub-agent hard budget in milliseconds. Leave UNSET to use the configured default (Settings → Limits) — do not guess tight values; a silence watchdog already kills dead runs.'
                },
                // Runda 3 (2026-08-17): parametr `background` WYCIĘTY ze schematu — delegacja
                // z głównego czatu idzie w tło zawsze, model nie ma tu wyboru (jawnie podany
                // argument jest ignorowany w execute; patrz komentarz przy `const background`).
                tasks: {
                    type: 'array',
                    // S33 Z1: informacyjny sufit dla modelu. Twarda bramka i tak siedzi w execute()
                    // (getLimits().max_parallel_delegations) — schemat tylko podpowiada, nie chroni.
                    maxItems: DEFAULT_LIMITS.max_parallel_delegations,
                    items: {
                        type: 'object',
                        properties: {
                            task: { type: 'string', description: t('mcp.delegate.param.task') },
                            aspect: { type: 'string', description: t('mcp.delegate.param.aspect') },
                            context: { type: 'string', description: t('mcp.delegate.param.context') },
                            aspect_explicit: { type: 'boolean' },
                            timeout_ms: { type: 'number' },
                        },
                        required: ['task']
                    },
                    description: t('mcp.delegate.param.tasks')
                }
            },
            required: []
        },
        execute: async (args: DelegateToolArgs, _app: unknown, plugin: DelegatePlugin | null | undefined) => {
            try {
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

                // D18: custom suby usera (do wyboru po nazwie). Brak subów NIE blokuje delegacji —
                // delegate bez aspect uruchamia generycznego workera (buildGenericWorkerConfig).
                const delegates = activeAgent.activeSubAgents || [];

                // E1.5 P3: default per-task timeout from config/limits.js (120s), user-overridable
                // via settings.pkmAssistant.limits.delegation_timeout_ms; per-call timeout_ms still wins.
                const limits = getLimits(plugin?.env?.settings);
                const defaultTimeoutMs = limits.delegation_timeout_ms;

                // ── S33 Z1: strażnik GŁĘBOKOŚCI (fail-closed) ──
                // `_invocationDelegationDepth` wstrzykuje MCPClient (jak `_invocationAgentName`) —
                // model nie poda go sam z palca, bo pole i tak jest nadpisywane przy wykonaniu.
                // 0 = wywołanie z głównego czatu; 1 = wywołanie z wnętrza sub-agenta itd.
                const currentDepth = Math.max(0, Number(args?._invocationDelegationDepth) || 0);
                if (currentDepth >= limits.max_delegation_depth) {
                    log.warn('DelegateTool', `Delegacja ODRZUCONA: głębokość ${currentDepth} >= limit ${limits.max_delegation_depth}`);
                    return { success: false, error: t('mcp.delegate.depth_limit', { limit: limits.max_delegation_depth }) };
                }
                const childDepth = currentDepth + 1;

                // ── F2 → runda 3 (2026-08-17): tło NIE JEST już wyborem modelu ──
                // Delegacja z GŁÓWNEGO CZATU idzie w tło ZAWSZE (decyzja Kuby: „mam móc gadać,
                // kiedy sub pracuje"). F2 dawało modelowi furtkę `background:false`, a model
                // wybierał ją z przyzwyczajenia i mroził userowi czat na cały bieg suba
                // (żywy smoke: kręciołek jak przy zwykłym myśleniu przez kilkanaście minut).
                // Parametr wyleciał ze schematu; jawnie podany — ignorowany, z logiem.
                // Ścieżka blokująca ZOSTAJE dla dwóch przypadków twardych:
                //   1. brak rejestru biegów (fail-soft — nie ma skąd wziąć `task_id` ani czym
                //      wrócić z wynikiem),
                //   2. delegacja z WNĘTRZA suba (`currentDepth >= 1`) — sub nie ma notifiera,
                //      czeka na wynik w swojej pętli.
                if (!plugin?.subTaskRegistry && !_warnedNoRegistry) {
                    _warnedNoRegistry = true;
                    log.warn('DelegateTool', 'Brak plugin.subTaskRegistry — delegacja leci ścieżką BLOKUJĄCĄ (tło niedostępne)');
                }
                if (args.background === false && plugin?.subTaskRegistry && currentDepth === 0) {
                    log.debug('DelegateTool', 'background:false zignorowane — delegacja z czatu zawsze w tle (runda 3)');
                }
                const background = !!plugin?.subTaskRegistry && currentDepth === 0;
                const origin = _resolveOrigin(args);
                // K4 (AUD-security-050): tryb pytań ZAMRAŻAMY tu, w chwili zlecenia — dokładnie
                // jak `scopeFolders` w S33. Bieg suba przeżywa turę (tło od rundy 3), więc
                // odczyt `plugin.currentAutonomy` w trakcie biegu dawał tryb zakładki, na którą
                // user właśnie przeskoczył. Brak znacznika (stary wołacz) = runner spada na lustro.
                const turnAutonomy = typeof args?._invocationAutonomy === 'string' && args._invocationAutonomy
                    ? args._invocationAutonomy
                    : null;
                // K11 (AUD-security-008/072): kim jest WOŁAJĄCY. Na piętrze 0 (czat) obu
                // znaczników nie ma i dziecko liczy się jak dotąd; na piętrze ≥1 to zakres
                // i whitelista suba, który zleca — dziecko dostanie z nimi PRZECIĘCIE.
                const callerScopeFolders = _readStringList(args?._invocationScopeFolders);
                const callerToolNames = _readStringList(args?._invocationToolNames);
                // F5: wspólne dla wszystkich trzech ścieżek — ile ms doliczamy, gdy budzik
                // zadania złapie suba w finalnym podsumowaniu (patrz `_makeFinalGrace`).
                const graceMs = limits.subagent_final_grace_ms;
                // Front A: ratowanie dorobku — gdy budzik zadania ubije bieg, ale ubity bieg
                // zdąży się domknąć (abort → pętla oddaje częściowy wynik), timeout wraca
                // z `partial_result` zamiast gołego błędu. 0 = wyłączone (stare zachowanie).
                const salvageMapper = limits.subagent_salvage_max_chars > 0
                    ? _makeSalvageMapper(limits.subagent_salvage_max_chars)
                    : null;

                // ── Multi-task mode ──
                if (args.tasks && Array.isArray(args.tasks) && args.tasks.length > 0) {
                    // S33 Z1: strażnik SZEROKOŚCI. Odrzucamy CAŁE wywołanie — świadomie nie tniemy
                    // listy po cichu, bo model musiałby zgadywać, które zadania poszły.
                    // F2: w tle do rachunku wchodzi też to, co JUŻ biegnie (poprzednie tury).
                    const inFlight = background ? _backgroundCount() : 0;
                    if (inFlight + args.tasks.length > limits.max_parallel_delegations) {
                        log.warn('DelegateTool', `Delegacja ODRZUCONA: ${args.tasks.length} zadań (+${inFlight} w tle) > limit ${limits.max_parallel_delegations}`);
                        return {
                            success: false,
                            error: t('mcp.delegate.parallel_limit', {
                                limit: limits.max_parallel_delegations,
                                count: inFlight + args.tasks.length,
                            }),
                        };
                    }
                    // S33 A3: górny `timeout_ms` jest DEFAULTEM dla zadań, które nie mają
                    // własnego. Wcześniej był po cichu ignorowany w trybie wielozadaniowym —
                    // model prosił o krótszy limit dla całej paczki i dostawał pełne 120 s.
                    const topTimeout = Number(args.timeout_ms);
                    const tasksDefaultTimeoutMs = Number.isFinite(topTimeout) && topTimeout > 0
                        ? topTimeout
                        : defaultTimeoutMs;
                    // Zwis delegacji 2026-08-14: platforma lokalna z bramką limit 1 i tak
                    // przerabia requesty PO KOLEI — odpalanie subów równolegle nic nie
                    // przyspieszało, a budziki (task + per-call) tykały w kolejce bramki
                    // i taski umierały seryjnie. Szerokość dopasowujemy do przepustowości:
                    // lokalna bramka N → N subów naraz (default 1 = sekwencyjnie, budzik
                    // każdego taska startuje dopiero z jego biegiem), chmura → pełna paczka.
                    const taskConcurrency = _resolveTaskConcurrency(plugin, activeAgent, args.tasks.length);
                    if (taskConcurrency < args.tasks.length) {
                        log.debug('DelegateTool', `Delegacja ${args.tasks.length} zadań ograniczona do ${taskConcurrency} naraz (bramka platformy lokalnej)`);
                    }
                    // F2: bramka „zadanie i wystartowało, i ma już swój byt — ALBO się skończyło".
                    // Zwrotka w trybie tła czeka wyłącznie na bramki PIERWSZEJ FALI, czyli na tyle
                    // zadań, ile pula wpuszcza od razu. Bez tego przy bramce lokalnej o szerokości 1
                    // „tło" czekałoby na przerobienie całej paczki po kolei — czyli na nic by nie było.
                    const gates = args.tasks.map(() => {
                        let open!: () => void;
                        const opened = new Promise<void>((res) => { open = res; });
                        return { opened, open };
                    });
                    const startedTasks: Array<{ task_id: string; name: string }> = [];

                    // AUD-bledy-020: zadanie odbite OD RĘKI (puste `task`, nietrafiony `aspect`)
                    // nigdy nie wejdzie do rejestru, więc powiadomienie o nim NIE przyjdzie.
                    // Rozstrzygamy je RAZ, przed pulą - inaczej zwrotka nie umie odróżnić
                    // "odrzucone" od "czeka w kolejce", a przy wąskiej bramce część odmów
                    // zapadałaby dopiero po turze, w porzuconej puli.
                    type TaskPrecheck =
                        | { ok: true; resolved: ResolvedDelegate }
                        | { ok: false; result: unknown };
                    const rejectedTasks: Array<{ task: string; aspect?: string; error: string }> = [];
                    const precheck: TaskPrecheck[] = args.tasks.map((taskDef) => {
                        if (!taskDef.task?.trim()) {
                            const error = t('mcp.delegate.empty_task');
                            rejectedTasks.push({ task: taskDef.task || '', aspect: taskDef.aspect, error });
                            return { ok: false, result: { success: false, error } };
                        }
                        const resolved = _resolveDelegate(taskDef.aspect, delegates, taskDef.aspect_explicit === true);
                        if (resolved.error) {
                            rejectedTasks.push({ task: taskDef.task, aspect: taskDef.aspect, error: resolved.error });
                            return { ok: false, result: resolved };
                        }
                        return { ok: true, resolved };
                    });
                    const acceptedCount = args.tasks.length - rejectedTasks.length;

                    const taskThunks = args.tasks.map((taskDef, i) => (): Promise<unknown> => {
                        const gate = gates[i];
                        const checked = precheck[i];
                        if (!checked.ok) {
                            gate.open();
                            return Promise.resolve(checked.result);
                        }
                        // AUD-code-review-001: guard NA WEJŚCIU do thunka, nie w robotniku puli.
                        // `gate` jest tu w zasięgu — bez tego zadanie, które demontaż złapał
                        // jeszcze w kolejce (bramka platformy lokalnej = 1), dostawało `continue`
                        // w `_runWithConcurrency` BEZ wywołania thunka, więc `gate.open()` (który
                        // woła wyłącznie sam thunk — tu, albo w `onTaskCreated`/`.finally()` niżej)
                        // nigdy nie odpalał. Ścieżka tła czeka na te bramki (`acceptedGates...
                        // .opened`), więc `execute()` wisiał w nieskończoność zamiast wrócić.
                        if (_moduleUnloaded) {
                            gate.open();
                            return Promise.resolve({ success: false, error: t('mcp.delegate.plugin_unloaded') });
                        }
                        const resolvedDef = checked.resolved;
                        // Kontrolka abortu: timeout zadania ubija bieg suba (stream + pętla),
                        // a budżet modelu suba = budżet zadania (nie globalny delegation_timeout_ms,
                        // który user może mieć podkręcony na 600 s).
                        const taskTimeout = Number(taskDef.timeout_ms);
                        const effectiveTaskTimeout = Number.isFinite(taskTimeout) && taskTimeout > 0
                            ? taskTimeout
                            : tasksDefaultTimeoutMs;
                        const abortCtl: SubAbortControl = { aborted: false, stop: null };
                        // Z7: bieg ma właściciela OD RAZU — rejestr pozna go dopiero w `onTaskCreated`.
                        const forgetAbort = _trackAbort(abortCtl);
                        // Z2: budżet TEGO zadania rusza dopiero, gdy sub wjedzie na slot bramki.
                        const gateArm = _makeGateArm();
                        // F5: id biegu poznajemy dopiero w `onTaskCreated` — grace-okno domyka
                        // tę zmienną, żeby przy strzale budzika móc zapytać rejestr o stan.
                        let taskId: string | null = null;
                        return _withTimeout(_executeSubAgent(
                            { task: taskDef.task, context: taskDef.context, aspect_explicit: taskDef.aspect_explicit },
                            resolvedDef,
                            activeAgent, agentManager, plugin, makeRunner, childDepth,
                            {
                                abortCtl,
                                onGateAdmitted: gateArm.signal,
                                modelTimeout: effectiveTaskTimeout,
                                origin,
                                autonomy: turnAutonomy,
                                callerScopeFolders,
                                callerToolNames,
                                background,
                                onTaskCreated: (task: SubTask) => {
                                    taskId = task.id;
                                    _attachStop(plugin, task, abortCtl);
                                    startedTasks.push({ task_id: task.id, name: task.name });
                                    gate.open();
                                },
                            },
                        ), taskDef.timeout_ms, tasksDefaultTimeoutMs, () => {
                            abortCtl.aborted = true;
                            abortCtl.stop?.();
                        }, _makeFinalGrace(plugin, graceMs, () => taskId), gateArm, salvageMapper)
                            .finally(() => { forgetAbort(); gate.open(); });
                    });

                    if (background) {
                        // Pula leci BEZ await — całość zadań toczy się po zakończeniu tury.
                        const pool = _runWithConcurrency(taskThunks, taskConcurrency);
                        _trackBackground(pool, acceptedCount);
                        // `runTask` nie rzuca, ale pula to obietnica bez właściciela — pas bezpieczeństwa.
                        void pool.catch(() => { /* wynik i tak wraca rejestrem */ });
                        // AUD-bledy-020: pierwsza fala liczy się z zadań PRZYJĘTYCH - bramka odmowy
                        // otwiera się od razu i bez tego "tło" wracałoby, zanim ruszy cokolwiek realnego.
                        const acceptedGates = gates.filter((_, i) => precheck[i].ok);
                        const wave = Math.max(1, Math.min(taskConcurrency, acceptedGates.length));
                        await Promise.all(acceptedGates.slice(0, wave).map((g) => g.opened));
                        if (startedTasks.length === 0) {
                            // Żaden byt nie powstał (wysypany rejestr / same odmowy) — nie ma czego
                            // meldować modelowi, więc uczciwiej dokończyć po staremu.
                            return {
                                success: acceptedCount > 0,
                                results: await pool,
                                ...(rejectedTasks.length > 0 ? { rejected: rejectedTasks } : {}),
                            };
                        }
                        const queued = acceptedCount - startedTasks.length;
                        return {
                            success: true,
                            started: true,
                            tasks: [...startedTasks],
                            ...(queued > 0 ? { queued } : {}),
                            ...(rejectedTasks.length > 0 ? { rejected: rejectedTasks } : {}),
                            note: t('subagent.background_started_many', { count: acceptedCount }),
                        };
                    }

                    const results = await _runWithConcurrency(taskThunks, taskConcurrency);
                    return { success: true, results };
                }

                // ── Single-task mode ──
                if (!args.task || !args.task.trim()) {
                    return { success: false, error: t('mcp.delegate.empty_task') };
                }

                const resolved = _resolveDelegate(args.aspect, delegates, args.aspect_explicit === true);
                if (resolved.error) return resolved;

                const singleTimeout = Number(args.timeout_ms);
                const effectiveSingleTimeout = Number.isFinite(singleTimeout) && singleTimeout > 0
                    ? singleTimeout
                    : defaultTimeoutMs;
                const abortCtl: SubAbortControl = { aborted: false, stop: null };
                // Z7: bieg ma właściciela OD RAZU — rejestr pozna go dopiero w `onTaskCreated`.
                const forgetAbort = _trackAbort(abortCtl);
                // Z2: jak w trybie wielozadaniowym — zegar budżetu startuje od pierwszej admisji.
                const gateArm = _makeGateArm();
                const onTimeout = () => {
                    abortCtl.aborted = true;
                    abortCtl.stop?.();
                };

                if (background) {
                    // Ta sama bramka szerokości co dla paczki — jedno zadanie też zajmuje slot.
                    const inFlight = _backgroundCount();
                    if (inFlight + 1 > limits.max_parallel_delegations) {
                        log.warn('DelegateTool', `Delegacja ODRZUCONA: ${inFlight} zadań już biegnie w tle (limit ${limits.max_parallel_delegations})`);
                        forgetAbort(); // odmowa = biegu nie ma, kontrolka nie ma czego pilnować
                        return {
                            success: false,
                            error: t('mcp.delegate.parallel_limit', {
                                limit: limits.max_parallel_delegations,
                                count: inFlight + 1,
                            }),
                        };
                    }
                    let announce!: (task: SubTask | null) => void;
                    const taskCreated = new Promise<SubTask | null>((res) => { announce = res; });
                    let bgTaskId: string | null = null;
                    const run = _withTimeout(
                        _executeSubAgent(args, resolved, activeAgent, agentManager, plugin, makeRunner, childDepth,
                            {
                                abortCtl, onGateAdmitted: gateArm.signal,
                                modelTimeout: effectiveSingleTimeout, origin, autonomy: turnAutonomy,
                                callerScopeFolders, callerToolNames, background: true,
                                onTaskCreated: (task: SubTask) => {
                                    bgTaskId = task.id;
                                    _attachStop(plugin, task, abortCtl);
                                    announce(task);
                                },
                            }),
                        args.timeout_ms, defaultTimeoutMs, onTimeout,
                        _makeFinalGrace(plugin, graceMs, () => bgTaskId),
                        gateArm,
                        salvageMapper,
                    );
                    _trackBackground(run, 1);
                    // Z7: kontrolka schodzi z listy żywych biegów, cokolwiek się z biegiem stanie
                    // (wzór `_trackBackground` — `then` z dwiema gałęziami nie robi sieroty).
                    void run.then(forgetAbort, forgetAbort);
                    void run.catch(() => { /* pas bezpieczeństwa — nikt tej obietnicy nie trzyma */ });
                    // Kto pierwszy: powstanie bytu czy koniec biegu. Koniec przed bytem = błąd
                    // wczesny (brak modelu, nieznany aspect, wysypany rejestr) — wtedy oddajemy
                    // modelowi jego prawdziwy wynik, dokładnie jak przed F2.
                    const created = await Promise.race([taskCreated, run.then(() => null, () => null)]);
                    if (!created) return await run;
                    return {
                        success: true,
                        started: true,
                        task_id: created.id,
                        name: created.name,
                        note: t('subagent.background_started', { name: created.name, task_id: created.id }),
                    };
                }

                // `background` jest tu z definicji `false` — podajemy je jawnie, żeby byt
                // w rejestrze wiedział, że to był bieg BLOKUJĄCY (a nie „brak informacji").
                // F3: hak `onTaskCreated` istnieje na tej ścieżce WYŁĄCZNIE po to, żeby Stop
                // z panelu działał także dla biegów blokujących (nikt tu na byt nie czeka).
                // F5: przy okazji zbieramy z niego `task.id` dla grace-okna.
                let blockingTaskId: string | null = null;
                return await _withTimeout(
                    _executeSubAgent(args, resolved, activeAgent, agentManager, plugin, makeRunner, childDepth,
                        {
                            abortCtl, onGateAdmitted: gateArm.signal,
                            modelTimeout: effectiveSingleTimeout, origin, autonomy: turnAutonomy,
                            callerScopeFolders, callerToolNames, background,
                            onTaskCreated: (task: SubTask) => {
                                blockingTaskId = task.id;
                                _attachStop(plugin, task, abortCtl);
                            },
                        }),
                    args.timeout_ms, defaultTimeoutMs, onTimeout,
                    _makeFinalGrace(plugin, graceMs, () => blockingTaskId),
                    gateArm,
                    salvageMapper,
                ).finally(forgetAbort);

            } catch (e) {
                log.error('DelegateTool', 'Error:', e);
                // AUD-security-128: ten komunikat widzi MODEL i transkrypt tury. K8
                // (AUD-security-055) postawił maskę na dokładnie tę klasę wycieku, ale tylko
                // wewnątrz `SubAgentRunner.runTask` — nasz WŁASNY, zewnętrzny catch jej nie
                // dziedziczył, a wyjątek z `createModelForRole` / z rejestru / z odczytu
                // ustawień potrafi nieść zrzut zdarzenia strumienia z nagłówkiem Authorization.
                return { success: false, error: maskSensitiveData(String((e as Error)?.message ?? e)) };
            }
        }
    };
}

/**
 * F5: czy bieg jest teraz w FINALNEJ ITERACJI (pisze podsumowanie backstopu)?
 *
 * Czytamy kroki karty biegu: `backstop` otwiera finalną iterację, `loop.end` ją zamyka.
 * „Ostatni krok to backstop" jest tylko szczególnym przypadkiem tego samego warunku —
 * między `backstop` a `loop.end` pętla potrafi jeszcze zapisać `model.done`.
 *
 * ⚠️ Sufit `maxStepsPerTask` (500) sprawia, że w BARDZO długim biegu krok `backstop`
 * może nie trafić do tablicy w RAM (leci wtedy tylko do trace.log). Wynik: fail-safe —
 * brak dowodu = brak odroczenia, czyli abort natychmiastowy jak przed F5.
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
 * F5: buduje grace-okno dla JEDNEGO zadania delegacji.
 *
 * `getTaskId` jest funkcją, a nie wartością, bo w chwili składania budzika bytu jeszcze
 * NIE MA — `task.id` nadaje runner i melduje go dopiero hakiem `onTaskCreated`. Wołacz
 * trzyma więc `let taskId` i domyka go tutaj.
 *
 * Fail-soft na całej długości: brak rejestru / brak `getTask` / wyjątek = `shouldDefer`
 * oddaje `false`, czyli dokładnie zachowanie sprzed F5.
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
 * F3: podepnij pod świeżo założony byt uchwyt „zatrzymaj ten bieg".
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
            abortCtl.aborted = true;
            abortCtl.stop?.();
        });
    } catch (e) {
        log.warn('DelegateTool', `attachAbort padł dla ${task?.id} (Stop z panelu niedostępny):`, e);
    }
}

/**
 * Resolve which delegate to use from available list.
 */
function _resolveDelegate(aspect: string | undefined, delegates: DelegateEntry[], explicit = false): ResolvedDelegate {
    // D18: brak aspect = GENERYCZNY WORKER (syntetyczny). Działa nawet gdy agent nie ma
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
    // D18: fallback po ROLI (researcher/minion/prep, strategist/master/strateg) USUNIĘTY —
    // rola nie steruje, custom suby rozpoznajemy wyłącznie po nazwie.
    // W trybie ścisłym (`explicit`, np. chip z popupu) fuzzy jest wyłączone jak dotąd.
    if (!selected && !explicit) {
        selected = delegates.find(d =>
            d.name.toLowerCase().endsWith('-' + aspectLower) ||
            d.name.toLowerCase().includes(aspectLower)
        );
    }
    if (!selected) {
        // F4: wbudowane aspekty DOPIERO tutaj — po wszystkich custom subach usera i PRZED
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

/**
 * Execute task via SubAgentRunner (unified path).
 * @param resolved - { delegate } (custom sub po nazwie) lub { generic: true } (worker).
 * @param delegationDepth - S33 Z1: piętro, na którym stanie odpalany sub. Runner
 *   niesie je dalej do MCPClient, żeby delegacja z wnętrza suba znała swoją głębokość. Default 1.
 */
/** Kontrolka abortu biegu suba (Zwis subagentow, lokalny most, 2026): `_withTimeout` ustawia
 *  `aborted` i woła `stop` (abort streamu modelu), runner czyta `aborted` jako shouldAbort
 *  pętli. Bez tego timeout delegacji porzucał suba żywcem — mielił dalej, trzymał slot
 *  bramki platform lokalnych i blokował główny czat. */
export type SubAbortControl = { aborted: boolean; stop: (() => void) | null };

type SubRunControl = {
    abortCtl?: SubAbortControl;
    /** Z2: sygnał pierwszego wjazdu na slot bramki — przelot do `runTask`, bez interpretacji. */
    onGateAdmitted?: () => void;
    modelTimeout?: number;
    /** F2: adres zwrotny + tryb tła + hak „byt istnieje" — przelot do `runTask`, bez interpretacji. */
    origin?: SubTaskOrigin;
    background?: boolean;
    onTaskCreated?: (task: SubTask) => void;
    /** K4: tryb autonomii tury zlecającej, zamrożony na cały bieg suba. */
    autonomy?: string | null;
    /** K11: `scope.folders` suba zlecającego — dziecko dostanie z nim przecięcie. */
    callerScopeFolders?: string[] | null;
    /** K11: whitelista narzędzi suba zlecającego — dziecko dostanie z nią przecięcie. */
    callerToolNames?: string[] | null;
};

/**
 * K11: odczyt zaufanego znacznika-listy z args (`_invocationScopeFolders` /
 * `_invocationToolNames`). Wszystko, co nie jest niepustą tablicą stringów, znaczy
 * „wołający nie zawęża" — czyli zachowanie sprzed K11.
 */
function _readStringList(raw: unknown): string[] | null {
    if (!Array.isArray(raw)) return null;
    const out = raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return out.length > 0 ? out : null;
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
    // D18: generyczny worker (syntetyczny config) albo custom sub usera po nazwie.
    // S27 D2: gdy user wyznaczył globalny szablon suba — worker bierze jego config (fail-soft).
    let subAgentConfig: SubAgentConfigLike | null | undefined;
    if (resolved.generic) {
        subAgentConfig = resolveGenericWorkerConfig(plugin);
    } else if (resolved.builtin) {
        // F4: wbudowana para. Explorer = tani zwiad read-only, worker = klasa rodzica.
        subAgentConfig = resolved.builtin === 'worker'
            ? buildBuiltinWorkerConfig(plugin, activeAgent, runControl.callerToolNames)
            : buildBuiltinExplorerConfig();
    } else {
        subAgentConfig = agentManager.resolveSubAgentConfig((resolved.delegate as DelegateEntry).name, activeAgent);
        if (!subAgentConfig) {
            return { success: false, error: t('mcp.delegate.config_not_found', { name: (resolved.delegate as DelegateEntry).name }) };
        }
    }

    // F4: slot modelu zależy od JEDNEGO pola — `config.role`. `worker` (wbudowany aspekt albo
    // custom sub z takim polem w YAML) jedzie modelem rodzica (`sub_worker`), reszta — dawnym
    // slotem sub-agentów (`researcher`→minion). config.model z YAML wygrywa w obu przypadkach.
    const model: StreamingModelLike | null = createModelForRole(plugin, _resolveModelRole(subAgentConfig), activeAgent, subAgentConfig);
    const fallbackModel = plugin.env?.chatModel?.stream ? plugin.env.chatModel : null;
    const finalModel = (model?.stream ? model : fallbackModel);

    if (!finalModel?.stream) {
        return { success: false, error: t('mcp.delegate.no_model') };
    }

    // F2: sub NIGDY nie wyprzedza głównego czatu w kolejce bramki platformy lokalnej
    // (`ChatModel.stream` czyta `_gatePriority`, brak = 1 = main). Od F2 delegacja
    // domyślnie leci w tle, więc sub i czat realnie biją się o jeden slot mostu.
    // ⚠️ Tylko na ŚWIEŻEJ instancji per rola. `fallbackModel` to WSPÓŁDZIELONY
    // `env.chatModel` — zbicie mu priorytetu zdegradowałoby główny czat na stałe.
    if (finalModel === model) {
        (finalModel as { _gatePriority?: number })._gatePriority = 0;
    }

    const subAgentRunner = plugin.toolRegistry ? makeRunner(plugin) : null;
    if (!subAgentRunner) {
        return { success: false, error: t('mcp.delegate.runner_init_failed') };
    }

    // Uzbrojenie kontrolki abortu: od tej chwili timeout delegacji umie ubić stream modelu
    // tego suba (twardy xhr.abort + zwolnienie biletu bramki przez stopStream).
    if (runControl.abortCtl) {
        runControl.abortCtl.stop = () => {
            try { (finalModel as { stopStream?: () => void }).stopStream?.(); }
            catch { /* abort nie może wywrócić timeoutu */ }
        };
    }

    // Build task prompt with context — jednolity cap dla WSZYSTKICH subów (D18; dawniej cap
    // tylko dla strategist, researcher bez capu = dziura tokenowa).
    // F4: wartość przestała być hardcodem 16000 — to budżet `delegation_context_max_chars`
    // z `config/limits.js` (default 48000), który user może zmienić w Ustawieniach → Limity.
    let taskPrompt = args.task as string;
    if (args.context) {
        const maxContextLen = getLimits(plugin?.env?.settings).delegation_context_max_chars;
        const ctx = args.context.length > maxContextLen
            ? args.context.slice(0, maxContextLen) + '\n' + t('mcp.delegate.truncated')
            : args.context;
        taskPrompt = `${t('mcp.delegate.context_header')}\n${ctx}\n${t('mcp.delegate.context_footer')}\n\n${t('mcp.delegate.task_header')}\n${args.task}\n${t('mcp.delegate.task_footer')}`;
    }

    // S33 Z1: `scope.folders` custom suba przestaje być samą wskazówką w prompcie — jedzie do
    // łańcucha uprawnień jako DODATKOWE zawężenie (przecięcie rodzic∩sub). Puste/brak = zero
    // nowych ograniczeń (dotychczasowe zachowanie). Pozostałe pola scope (frontmatter/sections/
    // pinned_notes) zostają wskazówkami promptowymi — nie da się ich egzekwować na ścieżce.
    const childScopeFolders = Array.isArray(subAgentConfig.scope?.folders) && subAgentConfig.scope.folders.length > 0
        ? subAgentConfig.scope.folders
        : null;
    // K11 (AUD-security-008): zakres dziecka = PRZECIĘCIE z zakresem WOŁAJĄCEGO. Do K11
    // liczyliśmy go wyłącznie z configu dziecka, więc wnuk odpalony przez wąskiego suba
    // startował z `null` — czyli z pełnym zasięgiem agenta-rodzica. Rozłączne zakresy
    // (dziecko deklaruje folder, do którego wołający nie ma wstępu) = odmowa fail-closed.
    const scopeFolders = AccessGuard.intersectScopeFolders(
        runControl.callerScopeFolders,
        childScopeFolders as ScopeFolders | null,
    );
    if (Array.isArray(scopeFolders) && scopeFolders.length === 0) {
        log.warn('DelegateTool', `Delegacja ODRZUCONA: zakres "${subAgentConfig.name}" rozłączny z zakresem wołającego`);
        return { success: false, error: t('mcp.delegate.scope_disjoint', { name: subAgentConfig.name }) };
    }

    const result = await subAgentRunner.runTask(
        taskPrompt,
        activeAgent,
        subAgentConfig,
        finalModel,
        {
            delegationDepth,
            scopeFolders,
            // K11 (AUD-security-072): trzeci składnik przecięcia narzędzi — whitelista wołającego.
            ...(runControl.callerToolNames ? { callerToolNames: runControl.callerToolNames } : {}),
            // Budżet modelu suba = budżet ZADANIA (spójne budziki). Bez tego per-call timer
            // brał globalny delegation_timeout_ms, który bywa dużo dłuższy niż timeout taska.
            ...(runControl.modelTimeout ? { modelTimeout: runControl.modelTimeout } : {}),
            ...(runControl.abortCtl ? { shouldAbort: () => runControl.abortCtl!.aborted } : {}),
            // Z2: budżet zadania ma liczyć czas ROBOTY, nie czekania w kolejce bramki.
            ...(runControl.onGateAdmitted ? { onGateAdmitted: runControl.onGateAdmitted } : {}),
            // F2: przelot do rejestru biegów — runner ich nie interpretuje, my też nie.
            ...(runControl.origin ? { origin: runControl.origin } : {}),
            // K4 (AUD-security-050): tryb pytań tury zlecającej — zamrożony, jak `scopeFolders`.
            ...(runControl.autonomy ? { autonomy: runControl.autonomy } : {}),
            ...(runControl.background !== undefined ? { background: runControl.background } : {}),
            ...(runControl.onTaskCreated ? { onTaskCreated: runControl.onTaskCreated } : {}),
        }
    );

    // ── F5: uczciwość niepowodzenia ──
    // Runner oznacza flagą `failed` wyłącznie bieg, który padł na wyjątku. Do F5 taki bieg
    // wracał tą samą drogą co sukces (`success:true` + tekst błędu w `result`), więc model
    // referował go użytkownikowi jako wykonane zadanie. Teraz mówimy wprost: nie wyszło.
    if (result.failed) {
        return {
            success: false,
            error: typeof result.result === 'string' ? result.result : String(result.result ?? ''),
            aspect: subAgentConfig.name,
            stopped_by: 'error',
            duration_ms: result.duration,
        };
    }

    return {
        success: true,
        result: result.result,
        aspect: subAgentConfig.name,
        // Etykieta z YAML suba (F6) — przekazywana do UI/token-trackera; fallback 'researcher'.
        aspect_type: subAgentConfig.role || 'researcher',
        aspect_explicit: args.aspect_explicit === true,
        // F5: sposób zejścia leci do modelu razem z wynikiem. `backstop` = subowi skończyły
        // się iteracje (wynik może być niepełny albo być zaślepką), `abort` = ubity w locie.
        // Stary runner bez tego pola → `undefined`, czyli kształt sprzed F5 (fail-soft).
        ...(result.stoppedBy ? { stopped_by: result.stoppedBy } : {}),
        tools_used: result.toolsUsed,
        tool_call_details: result.toolCallDetails || [],
        duration_ms: result.duration,
        usage: result.usage || null,
    };
}

/**
 * Ile zadań delegacji wolno biec naraz (zwis delegacji 2026-08-14).
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
 * AUD-code-review-001 (naprawa BLOKERA z adwersarialnego review): `_moduleUnloaded` NIE jest
 * sprawdzany tutaj. Pierwsza wersja pytała o flagę PRZED wywołaniem `thunks[i]()` i przy trafieniu
 * robiła `continue` — ale bramkę `gates[i]` otwiera WYŁĄCZNIE sam thunk (na starcie przy odrzuconym
 * precheck, w `onTaskCreated`, albo w `.finally()`), więc pominięty thunk nigdy jej nie otwierał.
 * Ścieżka tła (`execute`) czeka na te bramki (`await Promise.all(acceptedGates...opened)`) —
 * wisiała więc W NIESKOŃCZONOŚĆ zamiast wrócić z odmową. Guard mieszka dziś WEWNĄTRZ każdego
 * thunka (`taskThunks` w `execute`), gdzie `gate` jest w zasięgu i zdąży się otworzyć.
 */
async function _runWithConcurrency(thunks: Array<() => Promise<unknown>>, limit: number): Promise<unknown[]> {
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
 * F5: grace-okno na finalne podsumowanie. Podawane do `_withTimeout` przez wołacza,
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
 * Z2 (FAIL 4 smoke'a 2026-08-15): „przezbrój budzik zadania przy PIERWSZYM wjeździe na slot bramki".
 *
 * Budżet zadania (`delegation_timeout_ms`, default 120 s) liczył dotąd od złożenia zlecenia,
 * więc obejmował też CZEKANIE w kolejce bramki platformy lokalnej (limit 1). Worker leci
 * z priorytetem 0, czyli za rozmową główną — `sub/pkm-worker#3` przestał w niej 76 s, dostał
 * slot, zrobił 3 narzędzia i zginął w 120,0 s z komunikatem „anulowany w kolejce bramki",
 * nie dowożąc zadania.
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
type GateArm = { signal: () => void; attach: (rearm: () => void) => void };

function _makeGateArm(): GateArm {
    let rearm: (() => void) | null = null;
    let signalled = false;
    let done = false;
    const fire = () => {
        if (done || !rearm || !signalled) return;
        done = true;
        rearm();
    };
    return {
        signal: () => { signalled = true; fire(); },
        attach: (fn) => { rearm = fn; fire(); },
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
    // S33 A2: budzik MUSI zostać rozbrojony po rozstrzygnięciu wyścigu. Bez `clearTimeout`
    // timer tykał do końca (domyślnie 120 s) i trzymał proces przy życiu długo po tym, jak
    // sub-agent oddał wynik — widać to jako wiszące testy/harness i zbędny event loop.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let salvageTimer: ReturnType<typeof setTimeout> | null = null;
    // Z2: po rozstrzygniętym wyścigu spóźniony sygnał bramki nie może uzbroić NOWEGO budzika —
    // `finally` już posprzątał, więc taki timer byłby wyciekiem (wzór `settled` z AgentLoop).
    let settled = false;
    // Front A: znacznik „budzik strzelił" — po nim wynik wyścigu (skądkolwiek przyszedł)
    // jest mapowany na uczciwy timeout z dorobkiem (patrz `.then` na dole).
    let timeoutFiredMs: number | null = null;
    const timeoutPromise = new Promise<{ success: false; error: string }>(resolve => {
        // Zwis subagentow, lokalny most, 2026: timeout musi UBIĆ bieg suba, nie tylko go
        // porzucić. Porzucony sub mielił dalej do własnego timeoutu (nawet 600 s przy
        // podkręconych limitach), trzymając slot bramki platform lokalnych — główny
        // czat stał w kolejce za trupem (incydent 2026-08-11 17:02).
        const kill = (waitedMs: number) => {
            timeoutFiredMs = waitedMs;
            try { onTimeout?.(); } catch { /* abort nie może przykryć timeoutu */ }
            const bare = {
                success: false as const,
                error: `Sub-agent timeout after ${waitedMs}ms`
            };
            // Front A (ratowanie dorobku): abort właśnie poleciał, a ubity bieg zwykle domyka
            // się w milisekundach (stream reject `_aborted` → pętla `finalize('abort')` →
            // runner oddaje częściowy wynik). Dajemy mu krótkie okno, żeby wyścig wygrał
            // DOROBEK, nie goła zwrotka; brak rozstrzygnięcia w oknie = błąd jak dotąd.
            // Bez mappera (salvage wyłączony) zachowanie sprzed Frontu A: resolve od ręki.
            if (!salvage) { resolve(bare); return; }
            salvageTimer = _nodeSafeSetTimeout(() => resolve(bare), SALVAGE_SETTLE_MS);
        };
        const armTimer = () => {
            if (settled) return;
            if (timer !== null) _nodeSafeClearTimeout(timer); // Z2: przezbrojenie liczy budżet od nowa
            timer = _nodeSafeSetTimeout(() => {
                // F5: budżet zadania obejmuje CAŁY bieg, więc budzik potrafił strzelić dokładnie
                // wtedy, gdy sub pisał już finalne podsumowanie — zadanie paliło pełny czas na
                // narzędzia i oddawało zaślepkę zamiast dorobku. Jeśli bieg jest w finalnej
                // iteracji, dokładamy JEDNORAZOWE okno; w zwykłej iteracji ubijamy jak dotąd.
                let defer = false;
                try { defer = grace ? grace.shouldDefer() === true : false; }
                catch { defer = false; /* sonda rejestru nie może przykryć timeoutu */ }
                if (!defer) return kill(effectiveTimeout);

                try { grace!.onDefer?.(); } catch { /* ślad jest miły, nie obowiązkowy */ }
                graceTimer = _nodeSafeSetTimeout(() => kill(effectiveTimeout + grace!.ms), grace!.ms);
            }, effectiveTimeout);
        };
        // Budzik tyka od zlecenia (siatka bezpieczeństwa dla suba, który slotu nigdy nie
        // dostanie), a Z2 przezbraja go przy PIERWSZYM wjeździe na slot — od tej chwili
        // zadanie ma pełny budżet na samą robotę, bez czasu przestanego w kolejce.
        armTimer();
        arm?.attach(armTimer);
    });
    // Front A: przed strzałem budzika odrzucenie biegu leci jak dotąd (wołacz ma catch).
    // PO strzale okno salvage trzyma wyścig otwarty — odrzucenie ubitego biegu (abort
    // potrafi zejść wyjątkiem) nie może wtedy wywrócić delegacji, tylko wraca gołą zwrotką.
    const guarded = promise.catch((err) => {
        if (timeoutFiredMs !== null) {
            return { success: false as const, error: `Sub-agent timeout after ${timeoutFiredMs}ms` };
        }
        throw err;
    });
    return Promise.race([guarded, timeoutPromise]).then((value) => {
        // Front A: budzik strzelił, ale wyścig mógł wygrać DOMKNIĘTY bieg (abort oddał
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
    _resolveDelegate,
    _withTimeout,
    // Z2: uzbrojenie budzika zadania na pierwszym wjeździe na slot bramki.
    _makeGateArm,
    _resolveTaskConcurrency,
    _runWithConcurrency,
    resolveGenericWorkerConfig,
    buildWorkerConfigFromTemplate,
    // F4: wbudowana para explorer/worker — rozpoznanie aspektu, oba syntetyczne configi
    // i mapowanie configu na rolę modelu.
    _resolveBuiltinAspect,
    buildBuiltinExplorerConfig,
    buildBuiltinWorkerConfig,
    _resolveModelRole,
    // F5: rozpoznanie finalnej iteracji z kroków karty biegu + fabryka grace-okna.
    _isInFinalSummary,
    _makeFinalGrace,
    // Front A: ratowanie dorobku po strzale budzika zadania.
    _makeSalvageMapper,
    _digestFromToolDetails,
    SALVAGE_SETTLE_MS,
    PKM_EXPLORER_NAME,
    PKM_WORKER_NAME,
    DEFAULT_TASK_TIMEOUT_MS,
    // F2: licznik zadań w tle jest stanem MODUŁU — testy muszą umieć go podejrzeć i wyzerować,
    // żeby jeden przypadek nie zjadł limitu szerokości następnemu.
    _backgroundCount,
    _resetBackground: (): void => { _backgroundRuns.clear(); },
    // Z7: ile biegów delegacji ma teraz właściciela (test pilnuje, że zbiór nie przecieka).
    _liveAbortCount: (): number => _liveAborts.size,
    // AUD-code-review-001: `_moduleUnloaded` to stan PROCESU (jak `_liveAborts`) — testy,
    // które wołają `stopAllDelegations`, muszą go zerować, żeby nie zatruć kolejnych testów
    // w tym samym procesie AVA.
    _resetModuleUnloaded: (): void => { _moduleUnloaded = false; },
};
