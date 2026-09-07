/**
 * Z7 (AUD-bledy-054/056) — DEMONTAŻ PLUGINU MUSI ZATRZYMAĆ BIEG W TLE.
 *
 * Nocka 2026-08-16: po `onunload` sub odpalony w tle wykonał jeszcze SZEŚĆ żądań do modelu
 * i kolejne narzędzia na żywym vaultcie — bo `dispose()` czyścił mapę uchwytów abortu BEZ
 * ich wywołania, a `mcpClient`/`toolRegistry` żyją do końca procesu. Jedynym mechanizmem,
 * który bieg w końcu kończył, był własny budzik delegacji (do 900 s).
 *
 * Ten plik jedzie na PRAWDZIWEJ pętli (`runAgentLoop`) i prawdziwym `SubTaskRegistry` —
 * atrapa runnera z pętlą „kręć się, aż ktoś podniesie flagę" nie dotknęłaby mechanizmu,
 * bo zepsuty był styk: uchwyt w rejestrze ↔ abort streamu ↔ `shouldAbort` pętli.
 *
 * Osobny plik (nie `DelegateTool.test.ts`) świadomie: klaster Z7 dokłada tu cały własny
 * osprzęt (model liczący żądania), a tamten plik jest jednocześnie edytowany gdzie indziej.
 */
import test from 'ava';
import { createDelegateTool, stopAllDelegations, __test__ } from './DelegateTool.js';
import type { DelegatePlugin, SubAgentConfigLike } from './DelegateTool.js';
import { SubTaskRegistry } from '../../modules/sub-agents/index.js';
import type { SubTask } from '../../modules/sub-agents/index.js';
import { runAgentLoop, ArrayMessageStore } from '../../modules/agent-loop/index.js';
import { __test__ as modelsTest } from '../models/index.js';

type TloRes = { success?: boolean; started?: boolean; task_id?: string; error?: string };
type TloRunnerOptions = {
    shouldAbort?: () => boolean;
    onGateAdmitted?: () => void;
    onTaskCreated?: (task: SubTask) => void;
};

// ─────────────────────────────────────────────────────────────────────────────
// clean-room: model NIE powstaje już z mapy DI (`config.modules.chatModel.class`) — powstaje przez
// `createChatModel(deps)` w `modelResolver`. Testy delegacji badają, KTÓRY model dostaje sub
// i co się z nim dzieje, więc podstawiają własną klasę przez seam fabryki resolvera.
//
// ⚠️ Klasa jedzie NA DOSTAWCY z configu tego konkretnego pluginu, nie w globalnej zmiennej —
// pliku nie da się w całości zserializować (`test` obok `test.serial`), a globalny stan
// mieszałby atrapy między równoległymi testami.
// ─────────────────────────────────────────────────────────────────────────────

/** Klasa modelu w starym kształcie wołania (`new Cls({ modelKey })`). */
type LegacyModelClass = new (opts: { modelKey?: string; [key: string]: unknown }) => unknown;

/** Dostawca-atrapa niosący klasę modelu dla TEGO configu. Resolver czyta z niego tylko `info.id`. */
interface TestProvider { info: { id: string }; __testModelClass: LegacyModelClass }

const PROVIDER_IDS = ['openai', 'ollama', 'lm_studio', 'anthropic', 'gemini', 'groq', 'deepseek', 'open_router', 'xai'];

/** `env.config` w nowym kształcie: rejestr dostawców + klient HTTP + transport strumienia. */
function chatConfig(Cls: LegacyModelClass): Record<string, unknown> {
    const providers = Object.fromEntries(
        PROVIDER_IDS.map(id => [id, { info: { id }, __testModelClass: Cls } as TestProvider]),
    );
    return {
        chat: {
            providers,
            http: { send: async () => ({ status: 200, headers: {}, text: '', json: () => ({}) }) },
            transport: { open: async () => ({ status: 200, headers: {}, body: '' }) },
        },
    };
}

// Jedna, wspólna fabryka: bierze klasę z dostawcy, którego niesie config danego testu.
modelsTest.setChatModelFactory((deps) => {
    const provider = deps.provider as unknown as TestProvider;
    return new provider.__testModelClass({
        modelKey: deps.ctx.modelId,
        modelId: deps.ctx.modelId,
        adapter: provider.info.id,
    }) as never;
});

/** Ślad biegu: ile razy model dostał ŻĄDANIE i ile narzędzi realnie poszło na vault. */
type Licznik = { zadania: number; narzedzia: number; stopy: number };

async function czekaj(warunek: () => boolean, ms = 2000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!warunek() && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
}

/**
 * Model-atrapa w kontrakcie `ChatModel`:
 *   - żądanie 1 → prosi o narzędzie (sub realnie coś robi),
 *   - żądanie 2+ → WISI (jak most lokalny, który przyjął request i milczy),
 *   - `stopStream` → odrzuca promisę znacznikiem `_aborted` (kontrakt po FAIL 3).
 */
function makeCountingModel(licznik: Licznik) {
    class CountingModel {
        _reject: ((e: unknown) => void) | null = null;
        stream(_payload: unknown, handlers: { done?: (r: unknown) => void }): Promise<never> {
            licznik.zadania++;
            if (licznik.zadania === 1) {
                setTimeout(() => handlers?.done?.({
                    tool_calls: [{ id: 'call_1', function: { name: 'write', arguments: '{}' } }],
                }), 0);
            }
            return new Promise<never>((_, reject) => { this._reject = reject; });
        }
        stopStream(): void {
            licznik.stopy++;
            const reject = this._reject;
            this._reject = null;
            reject?.(Object.assign(new Error('Strumień modelu przerwany (Stop).'), { _aborted: true }));
        }
    }
    return CountingModel;
}

function pluginZRejestrem(registry: SubTaskRegistry, ModelClass: unknown): DelegatePlugin {
    const activeAgent = { name: 'Jaskier', activeSubAgents: [] as Array<{ name: string }> };
    return {
        currentAutonomy: 'edge',
        toolRegistry: { getTool: () => null, filterByAgent: () => [] },
        subTaskRegistry: registry,
        agentManager: {
            getActiveAgent: () => activeAgent,
            getAgent: () => activeAgent,
            resolveSubAgentConfig: (name: string) => ({ name, tools: [] }),
        },
        env: {
            config: chatConfig(ModelClass as unknown as LegacyModelClass),
            settings: {
                pkmAssistant: {
                    chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                    limits: {},
                    modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] },
                },
            },
        },
    } as unknown as DelegatePlugin;
}

/** Runner-atrapa na PRAWDZIWEJ pętli (wzór `makeLoopRunner` z DelegateTool.test.ts). */
function makeLoopRunner(registry: SubTaskRegistry, licznik: Licznik, zejscia: string[]) {
    return () => ({
        runTask: async (
            prompt: string,
            _agent: unknown,
            config: SubAgentConfigLike,
            model: unknown,
            options: TloRunnerOptions,
        ) => {
            const task = registry.create({ id: `sub/${config.name}#1`, name: config.name, agentName: 'Jaskier' });
            options.onTaskCreated?.(task);
            try {
                const res = await runAgentLoop({
                    model: model as never,
                    store: new ArrayMessageStore([{ role: 'user', content: prompt }]),
                    resolveTools: () => [],
                    // „Realne narzędzie": w produkcji tu siedzi mcpClient.executeToolCall na vaultcie.
                    executeToolCall: async () => { licznik.narzedzia++; return 'ok'; },
                    limits: { maxIterations: 8 },
                    ...(options.shouldAbort ? { shouldAbort: options.shouldAbort } : {}),
                });
                zejscia.push(res.stoppedBy || 'natural');
                registry.finish(task, {
                    text: res.finalText, toolsUsed: res.toolsUsed, durationMs: 1, usage: null, stoppedBy: res.stoppedBy,
                });
                return { result: res.finalText, toolsUsed: [], toolCallDetails: [], duration: 1, usage: null, stoppedBy: res.stoppedBy };
            } catch (e) {
                zejscia.push('error');
                registry.fail(task, (e as Error).message);
                return { result: (e as Error).message, toolsUsed: [], toolCallDetails: [], duration: 1, usage: null, stoppedBy: 'error' as const, failed: true as const };
            }
        },
    });
}

test.serial('Z7: demontaż (stopAll + dispose) ubija bieg W TLE — model NIE dostaje kolejnego żądania', async t => {
    __test__._resetBackground();
    const licznik: Licznik = { zadania: 0, narzedzia: 0, stopy: 0 };
    const registry = new SubTaskRegistry();
    const plugin = pluginZRejestrem(registry, makeCountingModel(licznik));
    const zejscia: string[] = [];
    const tool = createDelegateTool({}, { makeRunner: makeLoopRunner(registry, licznik, zejscia) });

    // Budżet zadania krótki wyłącznie po to, żeby CZERWONY bieg tego testu nie trzymał
    // procesu 900 s — sprawdzamy demontaż, nie budzik.
    const res = await tool.execute({ task: 'zbierz X', timeout_ms: 2000 }, {}, plugin) as TloRes;
    t.true(res.started, 'warunek wstępny: bieg poszedł w tło (tura go nie trzyma)');

    // Sub jest w środku DRUGIEGO żądania do modelu, po wykonaniu pierwszego narzędzia.
    await czekaj(() => licznik.zadania >= 2);
    t.is(licznik.zadania, 2, 'warunek wstępny: bieg żyje i wisi na modelu');
    t.is(licznik.narzedzia, 1, 'warunek wstępny: jedno narzędzie już poszło');

    // ── to samo, co robi `PKMPlugin.onunload`: NAJPIERW zatrzymaj biegi, POTEM odepnij kanały ──
    t.is(registry.stopAll('unload'), 1, 'demontaż zawołał uchwyt biegu');
    registry.dispose();

    await czekaj(() => zejscia.length > 0);
    t.deepEqual(zejscia, ['abort'], 'bieg zszedł jako przerwany, nie mielił dalej');
    t.is(licznik.stopy, 1, 'abort dosięgnął streamu modelu (stopStream)');

    // Sedno Z7: po wyładowaniu pluginu model NIE dostaje kolejnego żądania, a vault —
    // kolejnego narzędzia. Przed naprawą sub dowoził jeszcze sześć żądań, bez śladu w trace.
    const zadaniaPoStopie = licznik.zadania;
    const narzedziaPoStopie = licznik.narzedzia;
    await new Promise(r => setTimeout(r, 150));
    t.is(licznik.zadania, zadaniaPoStopie, 'zero nowych żądań do modelu po demontażu');
    t.is(licznik.narzedzia, narzedziaPoStopie, 'zero nowych narzędzi na vaultcie po demontażu');
    t.is(__test__._liveAbortCount(), 0, 'zamknięty bieg schodzi z listy właścicieli (zero wycieku)');
});

test.serial('Z7: stopAllDelegations dosięga biegu, który nie zdążył założyć bytu w rejestrze', async t => {
    __test__._resetBackground();
    const licznik: Licznik = { zadania: 0, narzedzia: 0, stopy: 0 };
    const registry = new SubTaskRegistry();
    const plugin = pluginZRejestrem(registry, makeCountingModel(licznik));

    // Okno z incydentu: `runTask` buduje prompt (dysk!) ZANIM zawoła `onTaskCreated`.
    // W tym czasie rejestr nie ma uchwytu do niczego — `stopAll()` nie ma czego wołać.
    let wpuscDalej!: () => void;
    const promptGotowy = new Promise<void>((res) => { wpuscDalej = res; });
    let wStarcie = false;
    let abortWidziany: boolean | null = null;
    const tool = createDelegateTool({}, {
        makeRunner: () => ({
            runTask: async (_prompt: string, _agent: unknown, config: SubAgentConfigLike, _model: unknown, options: TloRunnerOptions) => {
                wStarcie = true;
                await promptGotowy;
                abortWidziany = options.shouldAbort?.() ?? null;
                // Prawdziwy runner poszedłby stąd do pętli; bieg przerwany nie zakłada bytu.
                if (abortWidziany) return { result: '', toolsUsed: [], toolCallDetails: [], duration: 1, usage: null, stoppedBy: 'abort' as const };
                const task = registry.create({ id: `sub/${config.name}#1`, name: config.name });
                options.onTaskCreated?.(task);
                return { result: 'dowiozłem', toolsUsed: [], toolCallDetails: [], duration: 1, usage: null };
            },
        }),
    });

    const bieg = tool.execute({ task: 'zbierz X', timeout_ms: 2000 }, {}, plugin) as Promise<TloRes>;
    await czekaj(() => wStarcie);

    t.is(registry.stopAll('unload'), 0, 'rejestr nie ma jeszcze czego zatrzymać — to jest ta dziura');
    t.is(__test__._liveAbortCount(), 1, 'ale narzędzie delegacji zna swój bieg od pierwszej linijki');
    t.is(stopAllDelegations('unload'), 1);

    wpuscDalej();
    await bieg;

    t.true(abortWidziany, 'bieg wystartował już z podniesioną flagą — pętla nie ruszy');
    t.is(licznik.zadania, 0, 'model nie dostał ani jednego żądania po demontażu');
    await czekaj(() => __test__._liveAbortCount() === 0);
    t.is(__test__._liveAbortCount(), 0);
});

/**
 * AUD-code-review-001 — `stopAllDelegations` musi dosięgnąć też zadania ZAKOLEJKOWANE
 * w puli multi-task, nie tylko biegi już wystartowane.
 *
 * `_trackAbort` (i tym samym `_liveAborts`, siatka Z7 wyżej) rejestruje kontrolkę abortu
 * DOPIERO wewnątrz thunka — czyli dopiero gdy robotnik puli (`_runWithConcurrency`) po niego
 * sięgnie. Bramka lokalnej platformy (`_streamGateLimit() === 1`) tnie szerokość puli do
 * JEDNEGO robotnika, więc paczka 3 zadań zostawia 2 z nich w kolejce (`queued: 2`) — dla
 * `_liveAborts` niewidzialne. Przed naprawą `stopAllDelegations('unload')` widziała tylko
 * pierwsze zadanie; gdy ono się kończyło, robotnik sięgał po KOLEJNY thunk i odpalał pełny
 * bieg suba (budowa modelu, prompt z dysku, `runTask`) na już zdemontowanym pluginie.
 */
test.serial('AUD-code-review-001: stopAllDelegations ubija KOLEJKĘ multi-task w tle — zero startów po demontażu', async t => {
    __test__._resetBackground();
    __test__._resetModuleUnloaded();

    // Bramka lokalnej platformy = 1 → `_resolveTaskConcurrency` tnie pulę do JEDNEGO
    // robotnika (wzór `pluginWithGate` z DelegateTool.test.ts).
    class GatedModel {
        stream() { /* nigdy realnie wołane — makeRunner jest atrapą */ }
        _streamGateLimit() { return 1; }
    }
    const activeAgent = { name: 'Jaskier', activeSubAgents: [] as Array<{ name: string }> };
    const registry = new SubTaskRegistry();
    const plugin = {
        currentAutonomy: 'edge',
        toolRegistry: { filterByAgent: () => [] },
        subTaskRegistry: registry,
        agentManager: {
            getActiveAgent: () => activeAgent,
            getAgent: () => activeAgent,
            resolveSubAgentConfig: (name: string) => ({ name, tools: [] }),
        },
        env: {
            config: chatConfig(GatedModel as unknown as LegacyModelClass),
            settings: {
                pkmAssistant: {
                    chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                    limits: {},
                    modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] },
                },
            },
        },
    } as unknown as DelegatePlugin;

    let starts = 0;
    let taskCounter = 0;
    let letFirstFinish!: () => void;
    const firstGate = new Promise<void>((res) => { letFirstFinish = res; });
    const tool = createDelegateTool({}, {
        makeRunner: () => ({
            runTask: async (_prompt: string, _agent: unknown, config: SubAgentConfigLike, _model: unknown, options: TloRunnerOptions) => {
                starts++;
                const task = registry.create({ id: `sub/${config.name}#${++taskCounter}`, name: config.name, agentName: 'Jaskier' });
                options.onTaskCreated?.(task);
                if (starts === 1) await firstGate; // zadanie 1 trzyma robotnika, aż go zwolnimy
                registry.finish(task, { text: 'ok', toolsUsed: [], durationMs: 1, usage: null, stoppedBy: 'natural' });
                return { result: 'ok', toolsUsed: [], toolCallDetails: [], duration: 1, usage: null };
            },
        }),
    });

    const res = await tool.execute(
        { tasks: [{ task: 'a' }, { task: 'b' }, { task: 'c' }] }, {}, plugin) as TloRes & { tasks?: Array<{ task_id: string }>; queued?: number };

    t.true(res.started, 'warunek wstępny: pierwsza fala poszła w tło');
    t.is(res.tasks?.length, 1, 'bramka lokalna = 1 → pierwsza fala to JEDNO zadanie');
    t.is(res.queued, 2, 'warunek wstępny: dwa zadania czekają w kolejce puli');
    t.is(starts, 1, 'warunek wstępny: tylko pierwsze zadanie wystartowało');

    // ── to samo, co robi `PKMPlugin.onunload`: rejestr NIE zna zakolejkowanych zadań ──
    t.is(registry.stopAll('unload'), 1, 'rejestr zna tylko bieg już wystartowany — to jest ta dziura');
    t.is(stopAllDelegations('unload'), 1, 'to samo widzi _liveAborts — 2 zakolejkowane zadania mu niewidzialne');

    // Zwolnij zadanie 1 — robotnik puli sięgnie po KOLEJNY thunk (zadanie 2).
    letFirstFinish();
    await czekaj(() => __test__._backgroundCount() === 0);

    t.is(starts, 1, 'SEDNO: zero nowych startów suba po demontażu — kolejka NIE rusza dalej');

    __test__._resetModuleUnloaded();
});

/**
 * BLOKER werdyktu adwersarialnego review (opus, 2026-08-30) na AUD-code-review-001: test
 * wyżej łapał tylko wariant, w którym PIERWSZA bramka fali już jest otwarta (zadanie 1
 * wystartowało PRZED `stopAllDelegations`). Prawdziwa dziura była inna — `_moduleUnloaded`
 * żyła w `_runWithConcurrency`, robotnik robił `continue` BEZ wywołania thunka, a `gate.open()`
 * woła WYŁĄCZNIE sam thunk (na starcie / w `onTaskCreated` / w `.finally()`). Gdy flaga jest
 * PODNIESIONA JUŻ PRZED `execute()` (unload zaszedł, zanim model w ogóle zawołał `delegate`),
 * ŻADNA bramka fali nigdy się nie otwierała — `await Promise.all(acceptedGates...opened)`
 * wisiał w nieskończoność i `execute()` nigdy nie wracał (reprodukcja opusa: >3 s na tym
 * branchu, na main wraca od razu). To ten sam deadlock, który wieszał
 * scenariusze harnessu na `32_deep_research` — runner woła `onunload()` po KAŻDYM
 * scenariuszu w JEDNYM procesie, więc flaga została lepka od scenariusza 01 i zwis czekał
 * na scenariusz z `delegate({tasks:[...]})` w tle.
 */
test.serial('AUD-code-review-001 (bloker): execute() WRACA, nie wisi, gdy _moduleUnloaded jest PODNIESIONA już PRZED wywołaniem (tło, multi-task)', async t => {
    __test__._resetBackground();
    __test__._resetModuleUnloaded();

    const activeAgent = { name: 'Jaskier', activeSubAgents: [] as Array<{ name: string }> };
    const registry = new SubTaskRegistry();
    // Bez `_streamGateLimit` → pełna szerokość puli (obie bramki fali muszą się otworzyć
    // NIEZALEŻNIE od siebie — pokrywa też wariant „szeroka pula", nie tylko „bramka=1").
    class UngatedModel { stream() { /* nigdy realnie wołane — makeRunner jest atrapą */ } }
    const plugin = {
        currentAutonomy: 'edge',
        toolRegistry: { filterByAgent: () => [] },
        subTaskRegistry: registry,
        agentManager: {
            getActiveAgent: () => activeAgent,
            getAgent: () => activeAgent,
            resolveSubAgentConfig: (name: string) => ({ name, tools: [] }),
        },
        env: {
            config: chatConfig(UngatedModel as unknown as LegacyModelClass),
            settings: {
                pkmAssistant: {
                    chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                    limits: {}, modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] },
                },
            },
        },
    } as unknown as DelegatePlugin;

    let starts = 0;
    const tool = createDelegateTool({}, {
        makeRunner: () => ({
            runTask: async (_prompt: string, _agent: unknown, config: SubAgentConfigLike, _model: unknown, options: TloRunnerOptions) => {
                // Ten runner NIE MA PRAWA być wołany — flaga demontażu jest podniesiona
                // od PRZED wywołania `execute()`. Jeśli licznik ruszy, guard nie zadziałał.
                starts++;
                const task = registry.create({ id: `sub/${config.name}#1`, name: config.name, agentName: 'Jaskier' });
                options.onTaskCreated?.(task);
                registry.finish(task, { text: 'ok', toolsUsed: [], durationMs: 1, usage: null, stoppedBy: 'natural' });
                return { result: 'ok', toolsUsed: [], toolCallDetails: [], duration: 1, usage: null };
            },
        }),
    });

    // ── unload zaszedł PIERWSZY — dokładnie reprodukcja z werdyktu review ──
    t.is(stopAllDelegations('unload'), 0, 'brak żywych biegów w tej chwili — flaga i tak idzie w górę');

    const wynik = tool.execute({ tasks: [{ task: 'a' }, { task: 'b' }] }, {}, plugin) as Promise<TloRes & {
        results?: Array<{ success?: boolean; error?: string }>;
    }>;
    const strażnik = Symbol('timeout');
    const res = await Promise.race([
        wynik,
        new Promise((resolve) => setTimeout(() => resolve(strażnik), 3000)),
    ]);

    t.not(res, strażnik, 'SEDNO BLOKERA: execute() musi WRÓCIĆ w rozsądnym czasie, nie wisieć w nieskończoność');
    const wynikRes = res as TloRes & { results?: Array<{ success?: boolean; error?: string }> };
    t.is(starts, 0, 'żaden bieg suba nie wystartował — zero modelu, zero promptu z dysku');
    t.is(wynikRes.results?.length, 2, 'oba zadania dostały odpowiedź (żadne nie zawisło w kolejce)');
    for (const r of wynikRes.results ?? []) {
        t.false(r.success, 'każde zadanie odbite jako plugin_unloaded');
    }

    __test__._resetModuleUnloaded();
});
