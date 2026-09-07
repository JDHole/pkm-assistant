/**
 * SubAgentRunner
 * Unified runner for sub-agent tasks (replaces MinionRunner + MasterRunner).
 * Role determines behavior: researcher (search/prep) vs strategist (analyze/plan).
 * E2.1: pętla tool-callingu wyciągnięta do modules/agent-loop (runAgentLoop) — wspólna
 * z czatem (D11). SubAgentRunner buduje store/tools/limity/egzekutor i mapuje wynik.
 */
import { runAgentLoop, ArrayMessageStore } from '../agent-loop/index.js';
import { log } from '../../core/utils/Logger.js';
import { t } from '../../core/i18n/index.js';
import { getLimits } from '../../config/limits.js';
// AUD-bledy-013: „co jest porażką narzędzia" liczy ta sama funkcja, co status chipa w czacie.
import { resolveWorkPrompt, maskSensitiveData, toolResultStatus } from '../../core/index.js';
import { DEFAULT_SUBAGENT_FRAME_PROMPT } from './framePrompt.js';
// E2.5: rozpoznaj stare nazwy retrieval przy budowie whitelisty (fail-safe, gdyby
// config nie przeszedł migracji przez loader) — np. vault_grep → search.
// D18: jednolity domyślny zestaw narzędzi workera (brak podziału research/strateg).
import { DEPRECATED_TOOL_RENAMES, DEFAULT_SUB_AGENT_TOOLS } from './SubAgentLoader.js';
import type { SubAgentData } from './types.js';
// F1 (przebudowa subów 2026): bieg suba jest BYTEM w rejestrze (`plugin.subTaskRegistry`).
// Sam rejestr przychodzi z pluginu (DI), stąd tylko typ — runner go nie tworzy.
import type { SubTask, SubTaskOrigin } from './SubTaskRegistry.js';
// TS-any: these services are plugin-managed dynamic runtime adapters.
type RunnerBoundary = any;
type AgentLike = { name: string };
type RunOptions = {
    delegationDepth?: number;
    scopeFolders?: string[];
    /**
     * K11 (AUD-security-072): whitelista narzędzi WOŁAJĄCEGO (suba, który zlecił ten bieg).
     * Trzeci składnik przecięcia w `_getTools` obok configu dziecka i widoczności agenta —
     * bez niego wnuk odpalony przez read-only suba dostawał pełną whitelistę agenta głównego.
     * Brak = piętro 1 (zlecenie z czatu), czyli przecięcie jak dotąd.
     */
    callerToolNames?: string[];
    /**
     * K4 (AUD-security-050): tryb autonomii TURY, która zleciła ten bieg — zamrożony w chwili
     * zlecenia, dokładnie jak `scopeFolders` w S33. Delegacja z czatu jest od rundy 3 zawsze
     * w tle, więc lustro `plugin.currentAutonomy` zmienia się pod biegiem przy każdym
     * przełączeniu zakładki. Brak wartości = stare zachowanie (lustro jako fallback).
     */
    autonomy?: string | null;
    modelTimeout?: number;
    shouldAbort?: () => boolean;
    /**
     * Z2 (FAIL 4): sygnał „sub dostał slot bramki" — runner przekazuje go pętli 1:1
     * (`RunAgentLoopOptions.onGateAdmitted`) i sam go nie interpretuje. Czyta go
     * `DelegateTool`, żeby budżet zadania liczył czas ROBOTY, a nie stania w kolejce.
     */
    onGateAdmitted?: () => void;
    /** F2: adres zwrotny zlecenia — leci 1:1 do `registry.create`. */
    origin?: SubTaskOrigin;
    /** F2: bieg w tle (wołający nie czeka na wynik) — leci 1:1 do `registry.create`. */
    background?: boolean;
    /**
     * F2: hak „byt już istnieje". Wołany ZARAZ po `registry.create`, zanim runner zrobi
     * cokolwiek awaitowalnego — dzięki temu `DelegateTool` może oddać modelowi `task_id`
     * biegu, który dopiero się zaczyna. Bez rejestru NIE jest wołany.
     */
    onTaskCreated?: (task: SubTask) => void;
};
/**
 * F5: jak sub ZSZEDŁ z biegu. Trzy pierwsze wartości przychodzą wprost z `runAgentLoop`
 * (`RunAgentLoopResult.stoppedBy`), czwarta — `'error'` — powstaje TUTAJ, w gałęzi `catch`
 * runnera: pętla nigdy nie oddaje `'error'`, bo przy wyjątku po prostu rzuca dalej.
 */
export type SubRunStoppedBy = 'natural' | 'backstop' | 'abort' | 'error';

/**
 * F5: zwrotka `runTask`. Do F5 gałąź `catch` oddawała NORMALNY wynik z tekstem błędu w polu
 * `result` i bez żadnej flagi — `DelegateTool` owijał to w `{success:true}`, więc dla agenta
 * zlecającego padnięty sub wyglądał identycznie jak sub, który zadanie domknął. Stąd dwa
 * nowe pola: `stoppedBy` (sposób zejścia) i `failed` (obecne WYŁĄCZNIE w gałęzi catch).
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
};

type ToolCall = { name: string; arguments: unknown };
type ToolDefinition = { name: string; description: string; inputSchema: unknown; execute: (args: unknown, app: RunnerBoundary, plugin: RunnerBoundary) => Promise<unknown> };
type ErrLike = { message?: unknown; error?: unknown; details?: { message?: unknown }; cause?: { message?: unknown } };

/**
 * Licznik WYWOŁAŃ suba w tym procesie — daje krótki, unikalny sufiks etykiety trace
 * (`sub/pkm-sub#3`). Poligon F2: bez niego `delegate` z listą `tasks` odpalał N równoległych
 * workerów piszących w trace pod TĄ SAMĄ etykietą i przebiegów nie dało się rozdzielić.
 *
 * Dlaczego licznik, a nie czas jak w pętli głównej (`harness/Tester#15-41-51`): równoległe suby
 * startują w tej samej sekundzie, więc stempel czasu by ich nie rozróżnił.
 */
let _subCallSeq = 0;

/**
 * Bezpiecznik księgowości (F1): wołanie rejestru SubTask NIE MOŻE zmienić wyniku `runTask`
 * ani wywrócić biegu suba. Sam rejestr jest fail-soft w środku — to drugi pas, na wypadek
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
 * F1 (weryfikacja opus, werdykt 19.08): sufit deliverable dla `delegate`/`agent_delegate` NIE
 * MOŻE wyjść niższy niż ogólny sufit TEGO suba (`config.max_tool_result_length` — per-sub
 * override edytowalny w SubAgentEditorModal, patrz `runTask` linia z `maxResultLen`). Bez tej
 * funkcji sub skonfigurowany np. na 100k dostawałby wynik zagnieżdżonej delegacji ścięty do
 * 60k — naprawa z 19.08 OBNIŻAŁABY mu sufit zamiast go podnosić. Czat (`chat_streaming.ts`)
 * tego problemu nie ma, bo tam nie istnieje per-agent override (jeden wspólny sufit dla
 * wszystkich agentów) — tu bierzemy WIĘKSZY z dwóch. `deliverableDefault === 0` (świadome
 * „bez limitu" na poziomie globalnego `subagent_result_max_chars`) zostaje zerem: zwykły
 * `Math.max` by je zepsuł (0 przegrywa z każdą dodatnią liczbą), a `AgentLoop._truncateResult`
 * przy cap<=0 w ogóle nie tnie — więc zero musi zostać zerem, nie zamienić się w 60000.
 *
 * JEDNA funkcja dla obu miejsc, które o tym mówią (`loopLimits` w `runTask` i blok BUDŻET
 * w `_buildTaskPrompt`, F2) — te dwa miejsca już raz się rozjechały (prompt obiecywał inny
 * sufit niż runtime realnie egzekwował), więc licząc to niezależnie w dwóch miejscach
 * ryzykujemy powtórkę tego samego błędu.
 *
 * Review lidera (ten sam dzień): `subCommonCap` TEŻ może wyjść zerem — `config.max_tool_result_length`
 * to pole edytowalne per sub w SubAgentEditorModal, puste pole zapisuje się jako 0. Zero po
 * KTÓREJKOLWIEK stronie znaczy „bez limitu" i musi wygrać: semantycznie 0 to NAJWIĘKSZY możliwy
 * sufit (nieskończoność), ale liczbowo jest najmniejszy, więc goły `Math.max` by go przegrał.
 */
function _deliverableResultCap(subCommonCap: number, deliverableDefault: number): number {
    return (subCommonCap === 0 || deliverableDefault === 0) ? 0 : Math.max(subCommonCap, deliverableDefault);
}

export class SubAgentRunner {
    declare toolRegistry: RunnerBoundary;
    declare app: RunnerBoundary;
    declare plugin: RunnerBoundary;
    declare mcpClient: RunnerBoundary;
    /**
     * @param {Object} options
     * @param {Object} options.toolRegistry - ToolRegistry instance
     * @param {Object} options.app - Obsidian App instance
     * @param {Object} options.plugin - Plugin instance (for tool execution context)
     */
    constructor({ toolRegistry, app, plugin }: { toolRegistry: RunnerBoundary; app: RunnerBoundary; plugin: RunnerBoundary }) {
        this.toolRegistry = toolRegistry;
        this.app = app;
        this.plugin = plugin;
        this.mcpClient = plugin?.mcpClient || null;
    }

    /**
     * Run a sub-agent task.
     * @param {string} taskPrompt - Task description from the agent
     * @param {Object} agent - Agent instance
     * @param {Object} config - Sub-agent config from SubAgentLoader
     * @param {Object} model - ChatModel instance
     * @param {Object} [options]
     * @param {number} [options.delegationDepth=0] - S33 Z1: piętro delegacji, na którym stoi ten
     *   sub (1 = odpalony z głównego czatu). Wędruje do `MCPClient.executeToolCall`, żeby
     *   `delegate` wołany z wnętrza suba wiedział, jak głęboko już jesteśmy.
     * @param {string[]} [options.scopeFolders] - S33 Z1: foldery ze `scope.folders` custom suba.
     *   Dodatkowe (koniunkcyjne) zawężenie ścieżek vaultowych — patrz AccessGuard.
     * @returns {Promise<SubRunResult>} — od F5 zwrotka niesie też `stoppedBy` (sposób zejścia)
     *   i `failed: true` w gałęzi błędu. Patrz `SubRunResult`.
     */
    async runTask(taskPrompt: string, agent: AgentLike, config: SubAgentData, model: RunnerBoundary, options: RunOptions = {}): Promise<SubRunResult> {
        const startTime = Date.now();
        // S33 Z1: kaganiec delegacji + bariera scope — przenoszone przez cały bieg suba.
        const delegationDepth = Number(options.delegationDepth) || 0;
        const scopeFolders = Array.isArray(options.scopeFolders) && options.scopeFolders.length > 0
            ? options.scopeFolders
            : null;
        // K4 (AUD-security-050): tryb pytań zamrożony na CAŁY bieg — jedna wartość dla wszystkich
        // wywołań narzędzi, nawet gdy user w międzyczasie przeskoczy na zakładkę z `yolo`.
        const autonomy = typeof options.autonomy === 'string' && options.autonomy
            ? options.autonomy
            : null;
        // D18: jeden generyczny worker — brak rozgałęzień po roli. Rola w config to etykieta.
        const logTag = 'SubAgent';

        log.group(logTag, `Task: ${config.name} dla ${agent.name}`);
        log.debug(logTag, `Zadanie: "${taskPrompt.slice(0, 200)}..."`);

        // F1: deklaracja PRZED `try`, bo domknięcie biegu robi też gałąź `catch` (fail).
        const registry: RunnerBoundary = this.plugin?.subTaskRegistry || null;
        let subTask: SubTask | undefined;

        try {
            // E1.5: limity z config/limits.js — JEDNO źródło prawdy. Per sub-agent config
            // nadal wygrywa; getLimits() daje aktualne kanoniczne defaulty (patrz limits.ts).
            const limits = getLimits(this.plugin?.env?.settings);
            const maxResultLen = config.max_tool_result_length ?? limits.max_tool_result_length;
            // F1 (weryfikacja opus): sufit delegate/agent_delegate nie może być NIŻSZY niż
            // sufit tego suba (patrz komentarz przy `_deliverableResultCap`).
            const deliverableResultCap = _deliverableResultCap(maxResultLen, limits.subagent_result_max_chars);
            // E2.2: trace pętli sub-agenta → .pkm-assistant/logs/trace.log.
            // traceLog przychodzi z plugin (DI z DelegateTool); suby dostają trace za darmo, bez hooków.
            // Poligon F2: etykieta `sub/<nazwa|rola>#<nr wywołania>` — konwencja pętli głównej
            // (`chat/<agent>#<id sesji>`, `harness/<agent>#<runId>`). Bez numeru N równoległych
            // workerów z jednego `delegate` pisało pod wspólną etykietą i nie dało się ich rozdzielić.
            // Czytelnicy trace dopasowują etykietę PREFIKSOWO (patrz `scenarios/_asserts.ts` w repo harnessu).
            const label = `sub/${config.name || config.role || 'sub'}#${(++_subCallSeq).toString(36)}`;
            const loopLimits = {
                maxIterations: config.max_iterations || limits.subagent_max_iterations_worker,
                minIterations: config.min_iterations || 1,
                perCallTimeoutMs: options.modelTimeout || config.model_timeout || limits.delegation_timeout_ms,
                maxToolResultLength: maxResultLen,
                // Front A: watchdog ciszy (chunk przezbraja budzik) + skrót dorobku przy padzie
                // finalnej syntezy. Zegar ścienny wyżej zostaje awaryjnym sufitem.
                stallTimeoutMs: limits.subagent_stall_timeout_ms,
                salvageMaxChars: limits.subagent_salvage_max_chars,
                // Werdykt 19.08 (ten sam sufit też W PĘTLI SUBA): wynik zagnieżdżonej delegacji
                // (sub deleguje głębiej, max_delegation_depth > 1) to DELIVERABLE, nie zrzut
                // narzędzia — dokładnie ten sam wyjątek co w turze czatu (chat_streaming.ts),
                // z tego samego źródła configu. Bez tego wracał przycięty wspólnym 15k.
                // F1 (weryfikacja opus): NIE przelot wprost jak w czacie — czat nie ma per-agent
                // override, sub ma (`config.max_tool_result_length`), więc mapa nie może nikomu
                // obniżyć sufitu; `_deliverableResultCap` bierze większy z dwóch (zero = bez limitu).
                maxToolResultLengthPerTool: {
                    delegate: deliverableResultCap,
                    agent_delegate: deliverableResultCap,
                },
            };
            // F1: bieg suba zakładany w rejestrze POD TĄ SAMĄ etykietą co dotąd w trace —
            // id taska = etykieta trace. Rejestr rozsyła kroki do konsumentów, a pierwszym
            // konsumentem jest trace.log (subskrypcja w SubTaskRegistry), więc format linii
            // nie zmienia się o bajt. Bez rejestru (stary plugin / test bez DI) lecimy
            // ścieżką dotychczasową: trace prosto z `traceLog.scope`.
            //
            // F2: byt zakładamy NA SAMYM POCZĄTKU — przed budową promptu i przed pierwszym
            // `await`. Delegacja w tle oddaje modelowi `task_id`, więc identyfikator musi
            // istnieć, zanim cokolwiek długiego się zacznie (budowa promptu sięga do dysku).
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
                    // Front B (szyba): panel pokazuje, PO CO bieg wystartował. Skrót zadania,
                    // nie pełny prompt — sufit i maska siedzą w rejestrze.
                    taskPreview: taskPrompt,
                }))
                : undefined;
            // F2: „byt istnieje" — hak dla wołacza (DelegateTool), pod tym samym bezpiecznikiem
            // co reszta księgowości. Bez rejestru nie ma czego zgłaszać, więc hak milczy.
            if (subTask && typeof options.onTaskCreated === 'function') {
                _safeRegistry(() => options.onTaskCreated!(subTask as SubTask));
            }
            // Tee też pod bezpiecznikiem (kontrakt: KAŻDE wołanie rejestru przez _safeRegistry) —
            // rejestr bez `traceFor` nie może wywrócić suba; wtedy spadamy na trace wprost.
            const traceTee = (registry && subTask)
                ? _safeRegistry(() => registry.traceFor?.(subTask))
                : undefined;
            const trace = traceTee || this.plugin?.traceLog?.scope?.(label);

            // AUD-bledy-013: pętla stawia `status:'error'` na kroku `tool.post` WYŁĄCZNIE po
            // wyjątku egzekutora, a egzekutor suba z kontraktu nie rzuca — więc bieg, w którym
            // padło każde narzędzie, wyglądał w trace.log i w pasku biegów jak bieg udany
            // (`detailFromPost` w subTaskPanelModel miało martwą gałąź błędu). Znacznik liczy
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

            const systemPrompt = await this._buildTaskPrompt(agent, config);

            // Resolve tools: config.tools → role defaults
            const toolNames = this._resolveToolNames(config);
            const tools = this._getTools(toolNames, agent, options.callerToolNames);
            // Fail-closed whitelist (E1.3 P8): the sub-agent may ONLY execute tools that
            // survived the parent∩sub intersection in _getTools. _executeTool enforces this
            // so the direct-execution fallback cannot run a tool outside the whitelist.
            const allowedToolNames = new Set<string>(tools.map((td) => td.function.name));

            const messages: Array<{ role: 'system' | 'user'; content: string }> = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: taskPrompt }
            ];

            // E2.1: wspólna pętla (runAgentLoop). Store = ArrayMessageStore (system+user).
            // resolveTools = zamrożona lista jak dotąd. Obcinanie wyniku narzędzia przejmuje
            // pętla (limits.maxToolResultLength) — _executeTool już nie truncuje.
            const store = new ArrayMessageStore(messages);
            // F5: JEDYNY hak, jaki suby podpinają do pętli. `beforeContinue` leci przed KAŻDYM
            // kolejnym wywołaniem modelu, więc wiadomość wrzucona przez usera do rejestru
            // (panel biegów → `postMessage`) wchodzi do transkryptu suba dokładnie tam, gdzie
            // model ją przeczyta — jak nudge, a nie jak przerwanie w połowie zdania.
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
                model,
                store,
                resolveTools: () => tools,
                // AUD-bledy-013: numer wywołania łapiemy PRZY STARCIE (kolejność tablicy pętli),
                // a nie przy zakończeniu — wywołania jednego batcha rozstrzygają się równolegle.
                executeToolCall: (toolCall) => {
                    const seq = toolCallSeq++;
                    return this._executeTool(toolCall as ToolCall, agent.name, allowedToolNames,
                        { delegationDepth, scopeFolders: scopeFolders as string[], autonomy },
                        () => { failedToolCalls.add(seq); });
                },
                ...(steerHooks ? { hooks: steerHooks } : {}),
                // Zwis subagentow, lokalny most, 2026: delegate po SWOIM timeoucie ubija bieg suba
                // (abort streamu robi stopStream z kontrolki; flaga zatrzymuje pętlę między
                // iteracjami, żeby porzucony sub nie mielił dalej na narzędziach).
                ...(options.shouldAbort ? { shouldAbort: options.shouldAbort } : {}),
                // Z2: przelot sygnału bramki do wołacza (DelegateTool uzbraja nim budzik zadania).
                ...(options.onGateAdmitted ? { onGateAdmitted: options.onGateAdmitted } : {}),
                trace: loopTrace,
                limits: loopLimits,
                modelOptions: { maxTokens: 16384, agentName: agent.name },
            });

            log.info(logTag, `Task DONE: ${response.toolsUsed?.length || 0} tools, ${(response.finalText || '').length} znaków (stop: ${response.stoppedBy})`);
            log.timing(logTag, 'Task', startTime);
            log.groupEnd();
            await this._appendMemoryEvent(agent.name, {
                type: 'subagent_call',
                role: config.role || 'researcher',
                prompt: taskPrompt,
                result: response.finalText || '',
                duration_ms: Date.now() - startTime
            });
            // F1: domknięcie bytu wynikiem (status z `stoppedBy`: abort → aborted, reszta → done).
            if (subTask) {
                _safeRegistry(() => registry?.finish?.(subTask, {
                    text: response.finalText || '',
                    toolsUsed: response.toolsUsed || [],
                    durationMs: Date.now() - startTime,
                    usage: response.usage || null,
                    stoppedBy: response.stoppedBy,
                }));
            }
            return {
                result: response.finalText || '',
                toolsUsed: response.toolsUsed || [],
                toolCallDetails: response.toolCallDetails || [],
                duration: Date.now() - startTime,
                usage: response.usage || null,
                // F5: sposób zejścia przestaje ginąć na granicy runnera. Do F5 wołacz
                // (`DelegateTool` → agent zlecający) nie miał JAK odróżnić suba, który
                // zadanie domknął, od suba, któremu skończyły się iteracje i oddał
                // zaślepkę backstopu.
                stoppedBy: response.stoppedBy,
            };
        } catch (error) {
            const safeErrorMsg = _extractSafeErrorMessage(error);
            log.error(logTag, 'Task FAIL:', error, '| extracted:', safeErrorMsg);
            log.groupEnd();
            // AUD-bledy-011: TEN SAM kształt bloku co przy udanym biegu (`subagent_call`) —
            // te same pola nagłówka, status niesie treść `result`. Do naprawy pole `result`
            // woziło goły komunikat wyjątku, a `roleFromEvent` w ogóle nie znało typu
            // `subagent_error`, więc parser pliku sesji POMIJAŁ cały blok: padnięty bieg
            // znikał z odtworzonej rozmowy i z pamięci długoterminowej. Zdanie jest to samo,
            // które dostaje agent zlecający — plik sesji i wołacz mówią jedno.
            await this._appendMemoryEvent(agent.name, {
                type: 'subagent_error',
                role: config.role || 'researcher',
                prompt: taskPrompt,
                result: t('subagent.error', { name: config.name, error: safeErrorMsg }),
                duration_ms: Date.now() - startTime
            });
            // F1: bieg mógł się nie założyć (błąd przed `create`) — wtedy nie ma czego domykać.
            if (subTask) _safeRegistry(() => registry?.fail?.(subTask, safeErrorMsg));
            return {
                result: t('subagent.error', { name: config.name, error: safeErrorMsg }),
                toolsUsed: [],
                toolCallDetails: [],
                duration: Date.now() - startTime,
                usage: null,
                // F5: JEDYNE miejsce, w którym `failed` się pojawia. `DelegateTool` czyta tę
                // flagę i oddaje modelowi uczciwe `success:false` zamiast sukcesu z tekstem
                // błędu w środku (bieg live 2026-08-15: agent referował błąd jako wynik).
                stoppedBy: 'error',
                failed: true,
            };
        }
    }

    /**
     * Dziennik biegu → plik aktywnej sesji WŁAŚCICIELA biegu.
     *
     * K4 (AUD-security-091): `agentName` to agent, dla którego bieg wystartował — zamrożony
     * w chwili zlecenia (argument `runTask(…, agent, …)`, ten sam, który ląduje w `SubTask.agentName`).
     * Do K4 adresatem był `getActiveMemory()`, czyli agent AKURAT wybrany w UI: delegacja z czatu
     * leci od rundy 3 zawsze w tle, więc jedno przełączenie zakładki wsypywało treść zlecenia
     * i cały wynik suba do `sessions/active/` obcego agenta.
     *
     * Fail-closed: agent bez wpisu w `agentMemories` (pad inicjalizacji, skasowany w trakcie biegu)
     * NIE dostaje podstawionej cudzej pamięci — po prostu nie zapisujemy dziennika.
     */
    async _appendMemoryEvent(agentName: string, event: Record<string, unknown>): Promise<void> {
        try {
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
        // D18: jeden generyczny worker — jednolity domyślny zestaw narzędzi dla wszystkich subów.
        // config.tools (z YAML custom suba) nadal wygrywa. Przecięcie z uprawnieniami rodzica
        // (parent∩sub) robi _getTools. E2.6: read/list mają scope vault|memory.
        // S33: martwy kanał extraTools/allowExtraTools WYCIĘTY (flaga nigdy nie była podawana).
        const toolNames = [...(config.tools || DEFAULT_SUB_AGENT_TOOLS)];

        // E2.5: przemapuj deprecated nazwy na kanoniczne (vault_grep → search itd.) + dedup,
        // żeby whitelist nie wypadła pusta gdy config trzyma starą nazwę.
        const seen = new Set<string>();
        return toolNames
            .map((name) => DEPRECATED_TOOL_RENAMES[name as keyof typeof DEPRECATED_TOOL_RENAMES] || name)
            .filter(name => (seen.has(name) ? false : (seen.add(name), true)));
    }

    /**
     * Build the sub-agent system prompt — D18 THIN template (jeden szablon dla wszystkich).
     * „Piecz metodę, pulluj dane": sub NIE dostaje pamięci rodzica pushem (brain injection
     * 12k USUNIĘTY). Jeśli potrzebuje pamięci — czyta ją sam (search/read/list scope=memory,
     * pamięć własnego agenta) albo dostaje istotny fragment od rodzica w `context`.
     * `config.prompt` (metoda custom suba z KNOWLEDGE.md) ma miękki cap z `config/limits.js`
     * (`subagent_prompt_max_chars`, default 24000) — obrona przed encyklopediami, ale
     * konfigurowalna: instrukcja jest karmą dla modelu, nie wynikiem narzędzia (F4).
     * Rola (F6) nie steruje treścią promptu.
     */
    async _buildTaskPrompt(agent: AgentLike, config: SubAgentData): Promise<string> {
        // F4: limity czytamy RAZ — ten sam obiekt karmi cap instrukcji i blok BUDŻET niżej,
        // więc prompt nie może obiecać modelowi czegoś innego, niż realnie dostał.
        const limits = getLimits(this.plugin?.env?.settings);
        // F4: cap instrukcji custom suba przestał być hardcodem 6000 — to budżet
        // `subagent_prompt_max_chars` (default 24000), zmienialny w Ustawieniach → Limity.
        const configPromptCap = limits.subagent_prompt_max_chars;

        // E2.8 B3: the fixed frame (header/pull/ZASADY) lives in framePrompt.js and is overridable
        // (agent>global>factory). The mechanical sections below are still composed here and injected.
        const frame = resolveWorkPrompt(agent, 'subagent_frame_prompt', this.plugin?.env?.settings, DEFAULT_SUBAGENT_FRAME_PROMPT);

        // METHOD — custom sub method (KNOWLEDGE.md), soft cap z limits.
        let methodBlock = '';
        if (config.prompt) {
            const method = config.prompt.length > configPromptCap
                ? config.prompt.slice(0, configPromptCap) + `\n[... instrukcja obcięta do ${configPromptCap} znaków]`
                : config.prompt;
            methodBlock = `${method}\n`;
        }

        // SCOPE — only when the custom sub defines it (content unchanged).
        let scopeBlock = '';
        if (config.scope) {
            const folders = config.scope.folders?.length ? config.scope.folders.join(', ') : 'brak explicit folderow';
            const sections = config.scope.sections?.length ? config.scope.sections.join(', ') : 'brak explicit sekcji';
            const pinned = config.scope.pinned_notes?.length ? config.scope.pinned_notes.join(', ') : 'brak przypietych notatek';
            const frontmatter = config.scope.frontmatter && Object.keys(config.scope.frontmatter).length
                ? JSON.stringify(config.scope.frontmatter)
                : 'brak frontmatter';
            // S33 Z1: foldery są egzekwowane technicznie (bariera w łańcuchu uprawnień), reszta
            // pól scope to nadal wskazówki. Model ma to wiedzieć, żeby nie próbował ich obchodzić.
            const foldersNote = config.scope.folders?.length
                ? ' (EGZEKWOWANE technicznie — proba dostepu poza nie zostanie odrzucona)'
                : '';
            scopeBlock = `SCOPE:\n- Foldery: ${folders}${foldersNote}\n- Frontmatter: ${frontmatter}\n- Sekcje: ${sections}\n- Przypiete notatki: ${pinned}\n\n`;
        }

        // BUDŻET — spójny z runtime (runTask limits): iteracje + obcięcie wyniku narzędzia +
        // wyjątek delegate/agent_delegate. F2 (weryfikacja opus): to zdanie i `loopLimits` w
        // `runTask` MUSZĄ liczyć tą samą funkcją (`_deliverableResultCap`) — inaczej prompt
        // znowu zacznie obiecywać subowi inny sufit niż ten, który realnie egzekwuje pętla.
        const maxIter = config.max_iterations || limits.subagent_max_iterations_worker;
        const maxLen = config.max_tool_result_length ?? limits.max_tool_result_length;
        const delegateCap = _deliverableResultCap(maxLen, limits.subagent_result_max_chars);
        const budgetBlock = `BUDŻET:\n- Dostępne iteracje narzędzi: ${maxIter}\n- Max rozmiar wyniku narzędzia: ${maxLen ? maxLen + ' znaków' : 'bez limitu'}\n- Wyjątek \`delegate\`/\`agent_delegate\` (wynik suba to deliverable, nie zrzut narzędzia): ${delegateCap ? delegateCap + ' znaków' : 'bez limitu'}\n`;

        // Function replacers avoid `$`-sequence interpretation from injected content.
        return frame
            .replace('{{SUB_NAME}}', () => config.name)
            .replace('{{AGENT_NAME}}', () => agent.name)
            .replace('{{DESCRIPTION}}', () => config.description || 'asystent agenta')
            .replace('{{METHOD}}', () => methodBlock)
            .replace('{{SCOPE}}', () => scopeBlock)
            .replace('{{BUDGET}}', () => budgetBlock)
            .replace(/\n{3,}/g, '\n\n')
            .trimEnd();
    }

    /**
     * Get tool definitions from registry (filtered by allowed names).
     * Sprint 04 MCP_PORZADEK_v1: sub-agent inherits parent agent's `mcp_servers[]` whitelist
     * (intersection — sub-agent never sees a server the parent agent cannot see).
     * K11 (AUD-security-072): na piętrze >1 dochodzi TRZECI składnik przecięcia — whitelista
     * suba, który ten bieg zlecił. `parentAgent` jest wtedy nadal agentem GŁÓWNYM, więc samo
     * `filterByAgent` nie chroni: wnuk dostawał narzędzia, których jego rodzic w ogóle nie ma.
     * @param {string[]} toolNames - Tool names declared by sub-agent config
     * @param {Object} [parentAgent] - Parent agent (for mcp_servers whitelist intersection)
     * @param {string[]} [callerToolNames] - K11: whitelista wołającego suba (koniunkcja).
     * @returns {Array} Tool definitions in OpenAI format
     */
    _getTools(
        toolNames: string[],
        parentAgent: AgentLike | null | undefined,
        callerToolNames?: string[] | null,
    ): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
        if (!toolNames || toolNames.length === 0) return [];

        const parentVisible = parentAgent && typeof this.toolRegistry.filterByAgent === 'function'
            ? new Set<string>(this.toolRegistry.filterByAgent(parentAgent).map((t: ToolDefinition) => t.name))
            : null;
        const callerVisible = Array.isArray(callerToolNames) && callerToolNames.length > 0
            ? new Set<string>(callerToolNames)
            : null;

        return toolNames
            .map(name => this.toolRegistry.getTool(name))
            .filter(Boolean)
            .filter((tool: ToolDefinition) => !parentVisible || parentVisible.has(tool.name))
            .filter((tool: ToolDefinition) => !callerVisible || callerVisible.has(tool.name))
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
     *   the direct-execution fallback that previously ran any registered tool when MCPClient
     *   was unavailable (E1.3 P8).
     * @param {Object} [execOptions] - S33 Z1: kaganiec delegacji przenoszony do MCPClient.
     * @param {number} [execOptions.delegationDepth] - piętro delegacji tego suba.
     * @param {string[]|null} [execOptions.scopeFolders] - foldery scope suba (koniunkcja z rodzicem).
     * @param {string|null} [execOptions.autonomy] - K4: tryb pytań ZAMROŻONY przy zleceniu biegu.
     * @param {Function} [onFailure] - AUD-bledy-013: sygnał „to wywołanie padło" dla telemetrii
     *   biegu (`runTask` znaczy nim krok `tool.post`). Kontrakt „egzekutor NIE rzuca" zostaje
     *   bez zmian — porażka wraca tekstem do transkryptu suba, a osobno znacznikiem do rejestru.
     * @returns {Promise<string>} Tool result as string.
     *   E2.1: obcinanie do max_tool_result_length przejęła pętla (runAgentLoop limits.maxToolResultLength);
     *   ten egzekutor już NIE truncuje — zwraca surowy string.
     */
    async _executeTool(toolCall: ToolCall, agentName: string, allowedToolNames: Set<string> | null = null, execOptions: Pick<RunOptions, 'delegationDepth' | 'scopeFolders' | 'autonomy'> = {}, onFailure?: () => void) {
        log.debug('SubAgent', `_executeTool: ${toolCall.name} (agent: ${agentName || 'brak'})`);

        // Fail-closed: never execute a tool outside the sub-agent's intersection whitelist,
        // regardless of which execution path (MCPClient or fallback) handles it.
        if (allowedToolNames && !allowedToolNames.has(toolCall.name)) {
            log.warn('SubAgent', `_executeTool ODMOWA (spoza whitelisty rodzic∩sub): ${toolCall.name}`);
            onFailure?.();
            return t('subagent.tool_not_allowed', { name: toolCall.name });
        }

        // AUD-bledy-013: obie ścieżki wykonania mierzą wynik JEDNĄ regułą (`toolResultStatus`).
        // Porażka wraca do transkryptu suba tą samą linią co wyjątek (`subagent.tool_error` —
        // po polsku dosłownie „Błąd narzędzia …"), więc model nie czyta awarii jako zwykłego
        // wyniku; pełny payload zostaje w komunikacie, nic nie ginie. Równolegle zapala się
        // znacznik dla telemetrii biegu (krok `tool.post` w `runTask`).
        const asTranscript = (result: unknown): string => {
            // AUD-wydajnosc-098: `generate_image` niesie w SUKCESIE pełny base64 (obraz jest
            // już zapisany w vaulcie i wskazany przez `path`/`note_path`) — czat go wycina przed
            // wstawieniem do transkryptu (`chat_streaming.ts` — `delete copy.base64`), tu nikt
            // tego nie robił. Sama normalizacja co w czacie, tylko bez gałęzi vision (sub nie
            // renderuje obrazów inline — base64 nie ma tu żadnego konsumenta).
            const sanitized = stripImageBase64ForTranscript(toolCall.name, result);
            const text = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
            if (toolResultStatus(sanitized) !== 'error') return text;
            onFailure?.();
            // K8: komunikat błędu jadący do transkryptu suba idzie przez maskę — tak samo,
            // jak ten z `catch` niżej.
            return t('subagent.tool_error', { name: toolCall.name, error: maskSensitiveData(text) });
        };

        try {
            // Route through MCPClient for permission + whitelist enforcement.
            // E2.3 (D21): sub-agent dziedziczy tryb PYTAŃ po turze, która go zleciła.
            // K4 (AUD-security-050): wartość jest ZAMROŻONA w `execOptions.autonomy` (podaje ją
            // `runTask` z opcji zlecenia). Globalne lustro `plugin.currentAutonomy` zostaje
            // wyłącznie jako fallback dla starych wołaczy, którzy autonomii nie przekazują —
            // czytane w trakcie biegu dawało subowi tryb zakładki, na którą user właśnie przeskoczył.
            if (this.mcpClient && agentName) {
                const result = await this.mcpClient.executeToolCall(toolCall, agentName, {
                    autonomy: execOptions.autonomy ?? this.plugin?.currentAutonomy,
                    // S33 Z1: głębokość delegacji + bariera scope suba jadą z biegu suba do
                    // klienta narzędzi (MCPClient wstrzykuje je dalej: do args / checkPermission).
                    delegationDepth: execOptions.delegationDepth,
                    scopeFolders: execOptions.scopeFolders,
                    // K11 (AUD-security-072): whitelista TEGO suba jedzie dalej jako znacznik,
                    // żeby `delegate` policzył narzędzia wnuka względem niego, nie względem
                    // agenta głównego. Lista jest już przecięciem rodzic∩sub (patrz `runTask`).
                    ...(allowedToolNames ? { callerToolNames: [...allowedToolNames] } : {}),
                });
                return asTranscript(result);
            }

            // Fallback: direct execution (when MCPClient unavailable). F2.13 (release 2.2.0/W3):
            // ta ścieżka wywołuje `tool.execute()` wprost — omija `PermissionSystem.checkPermission`
            // w całości (foldery, No-Go, admin_access, oś akcji), nie tylko `scopeFolders`. Jedyną
            // ochroną tutaj jest whitelista NAZW narzędzi wyżej. Gdy wołacz podał `scopeFolders`
            // (zamierzał ograniczyć suba do konkretnych folderów), fail-open by cicho podmieniło
            // "zakres suba" na "cały vault" — fail-closed jest bezpieczniejsze niż milczące
            // rozszerzenie dostępu. Brak `scopeFolders` w execOptions (dawne zachowanie, testy
            // whitelisty) przechodzi bez zmian.
            if (Array.isArray(execOptions.scopeFolders) && execOptions.scopeFolders.length > 0) {
                log.warn('SubAgent', `_executeTool ODMOWA (fallback bez MCPClient nie umie wyegzekwować scopeFolders): ${toolCall.name}`);
                onFailure?.();
                return t('subagent.tool_scope_unenforceable', { name: toolCall.name });
            }

            log.warn('SubAgent', `_executeTool fallback (brak MCPClient): ${toolCall.name}`);
            const tool: ToolDefinition | null = this.toolRegistry.getTool(toolCall.name);
            if (!tool) {
                onFailure?.();
                return t('subagent.tool_not_found', { name: toolCall.name });
            }

            let args = toolCall.arguments;
            if (typeof args === 'string') {
                args = JSON.parse(args);
            }
            // S33 Z1: ta ścieżka omija MCPClient, więc sama musi dołożyć znacznik głębokości —
            // inaczej `delegate` wołany tędy startowałby zawsze od zera (rekurencja bez kagańca).
            if ((execOptions.delegationDepth as number) > 0 && args && typeof args === 'object' && !Array.isArray(args)) {
                args = { ...args, _invocationDelegationDepth: execOptions.delegationDepth };
            }
            const result = await tool.execute(args, this.app, this.plugin);
            return asTranscript(result);
        } catch (error) {
            onFailure?.();
            // K8: błąd narzędzia wraca do transkryptu suba — też przez maskę.
            return t('subagent.tool_error', {
                name: toolCall.name,
                error: maskSensitiveData(String((error as { message?: string }).message ?? error)),
            });
        }
    }
}

/**
 * AUD-wydajnosc-098: `GenerateImageTool` zwraca w sukcesie pełny base64 zapisanego obrazu
 * (obok `path`/`note_path` — obraz JEST już w vaulcie, base64 jest tu wyłącznie dla ścieżki
 * czatu z vision). Bez tej normalizacji medianowy obraz (~594 000 znaków base64, dane realne
 * z `Attachments/generated`) zjadał 99% sufitu `max_tool_result_length` transkryptu suba
 * (domyślnie 15000 — `config/limits.ts`), wypychając poza limit `format`/`revised_prompt`/
 * `message`, i był budowany od nowa przy KAŻDEJ kolejnej iteracji pętli suba. Tylko
 * `generate_image` — inne narzędzia nie niosą base64 w wyniku. Wejście bez `base64`
 * (błąd, inne narzędzie) wraca bez zmian.
 */
function stripImageBase64ForTranscript(toolName: string, result: unknown): unknown {
    if (toolName !== 'generate_image' || !result || typeof result !== 'object') return result;
    const raw = result as { base64?: unknown };
    if (typeof raw.base64 !== 'string' || raw.base64.length === 0) return result;
    // Rozmiar liczony z długości base64 (4 znaki = 3 bajty) — bez dekodowania. Wzór:
    // `normalizeMcpResult` w `modules/tools/ExternalMcpManager.ts` (adnotacja obrazka z serwerów
    // zewnętrznych MCP).
    const kb = Math.round((raw.base64.length * 3) / 4 / 1024);
    const copy: Record<string, unknown> = { ...(result as Record<string, unknown>) };
    delete copy.base64;
    copy.image = `[image ~${kb} kB — zapisany w vaultcie, patrz path/note_path]`;
    return copy;
}

/**
 * K8 (AUD-security-055): JEDNA granica maskowania dla wszystkich trzech odbiorców błędu
 * (rejestr biegów, plik aktywnej sesji w vaultcie, wynik oddany narzędziu `delegate`).
 * Do K8 maskowała tylko `SubTaskRegistry` — dwie pozostałe drogi woziły surowy komunikat,
 * a ten przy zdarzeniu strumienia bez `data` bywa całym `JSON.stringify(event)` razem
 * z nagłówkiem `Authorization`.
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
                return String(candidate);
            }
        }
    }

    return 'Unknown sub-agent error';
}
