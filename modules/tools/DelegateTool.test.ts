import test from 'ava';
import { createDelegateTool, __test__ } from './DelegateTool.js';
import type { DelegatePlugin, SubAgentConfigLike } from './DelegateTool.js';
import { SubTaskRegistry } from '../../modules/sub-agents/index.js';
import type { SubTask, SubTaskOrigin } from '../../modules/sub-agents/index.js';
// Dwa testy niżej jadą na PRAWDZIWEJ pętli — atrapa nie dotknęłaby mechanizmu,
// który trzeba pokryć (zejście przez abort w środku wywołania modelu).
import { runAgentLoop, ArrayMessageStore } from '../../modules/agent-loop/index.js';
import { log } from '../../core/utils/Logger.js';
import { __test__ as modelsTest } from '../models/index.js';

/** Wynik `delegate` czytany w asercjach — pola typowane POD UŻYCIE w tym pliku. */
type DelegateRes = {
    success?: boolean;
    error: string;
    aspect?: string;
    results: Array<{ success?: boolean; error: string }>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Model powstaje przez `createChatModel(deps)` w `modelResolver`, nie z mapy DI
// (`config.modules.chatModel.class`). Testy delegacji badają, KTÓRY model dostaje sub
// i co się z nim dzieje, więc podstawiają własną klasę przez seam fabryki resolvera.
//
// ⚠️ Klasa jedzie NA DOSTAWCY z configu tego konkretnego pluginu, nie w globalnej zmiennej:
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

/** Opcje, z jakimi runner zostal realnie zawolany. */
type RunnerOptions = { delegationDepth?: number; scopeFolders?: unknown; callerToolNames?: unknown };

/** Zapis jednego biegu runnera w testach kagancow. */
type RunRow = { task: string; config: SubAgentConfigLike; options: RunnerOptions };

const delegates = [
    { name: 'prep-whitelist', role: 'researcher' },
    { name: 'strateg-planer', role: 'strategist' },
];

/**
 * ⚠️ `delegate` domyślnie startuje suba W TLE. Testy poniżej badają MECHANIKĘ BIEGU
 * (timeout, config workera, kagańce, szerokość puli, kolejność wyników), więc jawnie proszą
 * o ścieżkę blokującą przez `background: false` — inaczej sprawdzałyby zwrotkę `started:true`
 * zamiast tego, co deklarują. Ścieżka tła ma własną sekcję na końcu pliku.
 */

test('resolveDelegate exact mode rejects fuzzy fallback', t => {
    const result = __test__._resolveDelegate('prep', delegates, true);

    t.false(result.success);
    t.true(result.error!.includes('prep'));
});

test('resolveDelegate fuzzy mode keeps legacy prep fallback', t => {
    const result = __test__._resolveDelegate('prep', delegates, false);

    t.is(result.delegate!.name, 'prep-whitelist');
});

test('withTimeout returns timeout object', async t => {
    const result = await __test__._withTimeout(new Promise(() => {}), 1) as { success?: boolean; error: string };

    t.false(result.success);
    t.true(result.error.includes('timeout'));
});

// Timeout delegacji UBIJA bieg suba (onTimeout), nie porzuca go samopas.
test('withTimeout woła onTimeout przy strzale budzika (ubicie suba), a NIE woła przy sukcesie', async t => {
    let killed = 0;
    const timedOut = await __test__._withTimeout(new Promise(() => {}), 1, 1, () => { killed++; }) as { success?: boolean };
    t.false(timedOut.success);
    t.is(killed, 1);

    const ok = await __test__._withTimeout(Promise.resolve({ success: true }), 60000, 60000, () => { killed++; }) as { success?: boolean };
    t.true(ok.success);
    t.is(killed, 1); // sukces nie dotyka kontrolki
});

test('timeout zadania ubija suba: stopStream modelu zawołany, runner dostał shouldAbort i modelTimeout taska', async t => {
    let streamStopped = 0;
    class HangingModel {
        constructor(_opts: unknown) {}
        stream() { /* nigdy nie wraca */ }
        stopStream() { streamStopped++; }
    }
    type AbortRunnerOptions = RunnerOptions & { modelTimeout?: number; shouldAbort?: () => boolean };
    const captured: { options?: AbortRunnerOptions } = {};
    const activeAgent = { name: 'Jaskier', activeSubAgents: [] };
    const plugin = {
        currentAutonomy: 'edge',
        toolRegistry: {},
        agentManager: { getActiveAgent: () => activeAgent },
        env: {
            config: chatConfig(HangingModel as unknown as LegacyModelClass),
            settings: {
                pkmAssistant: {
                    chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                    modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] },
                },
            },
        },
    };
    const tool = createDelegateTool({}, {
        makeRunner: () => ({
            runTask: (_task: string, _agent: unknown, _config: SubAgentConfigLike, _model: unknown, options: AbortRunnerOptions) => {
                captured.options = options;
                return new Promise(() => {}); // sub wisi — rozstrzyga timeout delegacji
            },
        }),
    });

    const res = await tool.execute({ task: 'wisisz', timeout_ms: 30, background: false }, {}, plugin as unknown as DelegatePlugin) as DelegateRes;

    t.false(res.success);
    t.true(res.error.includes('timeout'));
    t.is(streamStopped, 1, 'timeout delegacji zawołał stopStream modelu suba');
    t.is(captured.options!.modelTimeout, 30, 'budżet modelu suba = budżet zadania');
    t.true(captured.options!.shouldAbort!(), 'po timeoucie flaga abortu pętli suba jest podniesiona');
});

test('resolveDelegate without aspect returns generic worker marker', t => {
    t.deepEqual(__test__._resolveDelegate(undefined, delegates, false), { generic: true });
    t.deepEqual(__test__._resolveDelegate('', [], false), { generic: true });
});

test('delegate WITHOUT aspect runs the generic worker even with zero custom subs', async t => {
    const captured: { modelKey?: string; resolveCalled?: boolean; config?: SubAgentConfigLike } = {};
    class FakeModel {
        constructor(opts: { modelKey?: string }) { captured.modelKey = opts.modelKey; }
        stream() {}
    }
    const activeAgent = { name: 'Jaskier', activeSubAgents: [] }; // agent nie ma żadnych subów
    const plugin = {
        currentAutonomy: 'edge',
        toolRegistry: {},
        agentManager: {
            getActiveAgent: () => activeAgent,
            // Dla generycznego workera resolveSubAgentConfig NIE powinno być wołane.
            resolveSubAgentConfig: () => { captured.resolveCalled = true; return null; },
        },
        env: {
            config: chatConfig(FakeModel as unknown as LegacyModelClass),
            settings: {
                pkmAssistant: {
                    chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                    modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] },
                },
            },
        },
    };
    const tool = createDelegateTool({}, {
        makeRunner: () => ({
            runTask: async (_taskPrompt: string, _agent: unknown, config: SubAgentConfigLike) => {
                captured.config = config;
                return { result: 'done', toolsUsed: [], toolCallDetails: [], duration: 1, usage: null };
            },
        }),
    });

    const res = await tool.execute({ task: 'zbierz X', timeout_ms: 200, background: false }, {}, plugin as unknown as DelegatePlugin) as DelegateRes;

    t.true(res.success);
    t.is(res.aspect, 'pkm-sub', 'aspect = nazwa fabrycznego workera');
    t.is(captured.config!.name, 'pkm-sub');
    t.deepEqual(captured.config!.tools, ['search', 'list', 'read', 'web_search', 'web_read'],
        'worker dostaje domyślny zestaw (przecięcie z rodzicem robi runner)');
    t.falsy(captured.config!.prompt, 'generyczny worker nie ma wbudowanej instrukcji (encyklopedii)');
    t.falsy(captured.resolveCalled, 'resolveSubAgentConfig NIE wołane dla generycznego workera');
    t.is(captured.modelKey, 'worker-model', 'slot modelu researcher→minion');
});

// ─── Globalny sub (delegate BEZ aspect) ───────────────────────────────

function pluginWithTemplates(
    globalSubTemplate: string | null,
    templates: Record<string, Record<string, unknown>> = {},
): DelegatePlugin {
    return {
        agentManager: {
            subAgentTemplateStore: { get: (slug: string) => templates[slug] || null },
        },
        env: { settings: { pkmAssistant: { globalSubTemplate } } },
    } as unknown as DelegatePlugin;
}

test('bez ustawienia globalnego szablonu delegacja używa fabrycznego pkm-sub', t => {
    const config = __test__.resolveGenericWorkerConfig(pluginWithTemplates(null));

    t.is(config.name, 'pkm-sub');
    t.deepEqual(config.tools, ['search', 'list', 'read', 'web_search', 'web_read']);
    t.falsy(config.prompt, 'fabryczny worker nie niesie instrukcji');
});

test('ustawiony globalny szablon daje config z szablonu', t => {
    const plugin = pluginWithTemplates('zwiadowca', {
        zwiadowca: {
            name: 'Zwiadowca', description: 'zbiera materiał', tools: ['search', 'read'],
            model: 'ollama:qwen', prompt: 'Metoda zwiadu.', max_iterations: 12, version: 3,
        },
    });

    const config = __test__.resolveGenericWorkerConfig(plugin);

    t.is(config.name, 'Zwiadowca');
    t.is(config.description, 'zbiera materiał');
    t.deepEqual(config.tools, ['search', 'read']);
    t.is(config.model, 'ollama:qwen');
    t.is(config.prompt, 'Metoda zwiadu.');
    t.is(config.max_iterations, 12);
    t.falsy((config as unknown as Record<string, unknown>).version, 'wersja szablonu nie wchodzi do configu biegu');
});

test('fail-soft: ustawienie na nieistniejący szablon wraca do pkm-sub + warn', t => {
    const warns: string[] = [];
    const originalWarn = log.warn;
    log.warn = (module: string, message: string) => warns.push(`${module} ${message}`);
    try {
        const config = __test__.resolveGenericWorkerConfig(pluginWithTemplates('duch'));
        t.is(config.name, 'pkm-sub');
    } finally {
        log.warn = originalWarn;
    }
    t.true(warns.some(w => w.includes('duch') && w.includes('pkm-sub')));
});

test('fail-soft: zepsuty szablon (bez opisu / rzucający store) nie wywala delegacji', t => {
    const originalWarn = log.warn;
    log.warn = () => {};
    try {
        const bez = __test__.resolveGenericWorkerConfig(pluginWithTemplates('kaleka', {
            kaleka: { name: 'Kaleka' }, // brak description
        }));
        t.is(bez.name, 'pkm-sub');

        const rzuca = __test__.resolveGenericWorkerConfig({
            agentManager: { subAgentTemplateStore: { get: () => { throw new Error('zepsuty YAML'); } } },
            env: { settings: { pkmAssistant: { globalSubTemplate: 'bomba' } } },
        } as unknown as DelegatePlugin);
        t.is(rzuca.name, 'pkm-sub');
    } finally {
        log.warn = originalWarn;
    }
});

test('delegate BEZ aspect realnie odpala config globalnego szablonu', async t => {
    const captured: { modelKey?: string; config?: SubAgentConfigLike } = {};
    class FakeModel { constructor(opts: { modelKey?: string }) { captured.modelKey = opts.modelKey; } stream() {} }
    const activeAgent = { name: 'Jaskier', activeSubAgents: [] };
    const plugin = {
        currentAutonomy: 'edge',
        toolRegistry: {},
        agentManager: {
            getActiveAgent: () => activeAgent,
            resolveSubAgentConfig: () => null,
            subAgentTemplateStore: {
                get: (slug: string) => (slug === 'zwiadowca'
                    ? { name: 'Zwiadowca', description: 'zbiera', tools: ['search'], prompt: 'Metoda.' }
                    : null),
            },
        },
        env: {
            config: chatConfig(FakeModel as unknown as LegacyModelClass),
            settings: {
                pkmAssistant: {
                    chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                    globalSubTemplate: 'zwiadowca',
                    modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] },
                },
            },
        },
    };
    const tool = createDelegateTool({}, {
        makeRunner: () => ({
            runTask: async (_taskPrompt: string, _agent: unknown, config: SubAgentConfigLike) => {
                captured.config = config;
                return { result: 'ok', toolsUsed: [], toolCallDetails: [], duration: 1, usage: null };
            },
        }),
    });

    const res = await tool.execute({ task: 'zbierz X', timeout_ms: 200, background: false }, {}, plugin as unknown as DelegatePlugin) as DelegateRes;

    t.true(res.success);
    t.is(res.aspect, 'Zwiadowca');
    t.deepEqual(captured.config!.tools, ['search']);
    t.is(captured.config!.prompt, 'Metoda.');
});

// ─── Wbudowana para aspektów explorer / worker ─────────

test('explorer i worker rozpoznawane po dokładnej nazwie, bez wielkości liter', t => {
    for (const nazwa of ['explorer', 'EXPLORER', ' Explorer ']) {
        t.is(__test__._resolveDelegate(nazwa, [], false).builtin, 'explorer', nazwa);
    }
    for (const nazwa of ['worker', 'Worker', 'WORKER']) {
        t.is(__test__._resolveDelegate(nazwa, [], false).builtin, 'worker', nazwa);
    }
    // Nie-aspekty nadal kończą się odmową, a lista dostępnych niesie wbudowane.
    const nieznany = __test__._resolveDelegate('kosmita', [], false);
    t.false(nieznany.success);
    t.true(nieznany.error!.includes('explorer') && nieznany.error!.includes('worker'),
        'odmowa mówi modelowi, co w ogóle istnieje');
});

test('custom sub usera o nazwie "explorer" WYGRYWA z wbudowanym', t => {
    const wlasny = [{ name: 'explorer' }];

    const exact = __test__._resolveDelegate('explorer', wlasny, false);
    t.is(exact.delegate?.name, 'explorer');
    t.falsy(exact.builtin, 'wbudowany ustępuje własnemu');

    // Także w trybie ścisłym (chip z popupu).
    t.is(__test__._resolveDelegate('explorer', wlasny, true).delegate?.name, 'explorer');
});

test('fuzzy po nazwie ma pierwszeństwo przed wbudowanym; w trybie ścisłym wbudowany wchodzi', t => {
    const wlasny = [{ name: 'klara-explorer-x' }];

    t.is(__test__._resolveDelegate('explorer', wlasny, false).delegate?.name, 'klara-explorer-x',
        'custom sub złapany fuzzy nadal wygrywa');
    t.is(__test__._resolveDelegate('explorer', wlasny, true).builtin, 'explorer',
        'tryb ścisły nie robi fuzzy → schodzimy na wbudowanego');
});

test('config explorera jest read-only i jedzie slotem sub-agentów', t => {
    const config = __test__.buildBuiltinExplorerConfig();

    t.is(config.name, __test__.PKM_EXPLORER_NAME);
    t.is(config.role, 'explorer');
    t.deepEqual(config.tools, ['search', 'list', 'read', 'web_search', 'web_read'],
        'zwiadowca nie dostaje niczego, co pisze');
    t.is(__test__._resolveModelRole(config), 'researcher', 'tani slot sub-agentów');
    t.truthy(config.description);
    t.not(config.description, 'mcp.delegate.explorer_desc', 'i18n rozwiązane, nie goły klucz');
});

test('config workera bierze PEŁNĄ listę narzędzi rodzica i rolę modelu sub_worker', t => {
    const rodzic = { name: 'Jaskier' };
    const plugin = {
        toolRegistry: {
            filterByAgent: () => [{ name: 'read' }, { name: 'write' }, { name: 'delete' }, { name: 'search' }],
        },
    } as unknown as DelegatePlugin;

    const config = __test__.buildBuiltinWorkerConfig(plugin, rodzic);

    t.is(config.name, __test__.PKM_WORKER_NAME);
    t.is(config.role, 'worker');
    t.deepEqual(config.tools, ['read', 'write', 'delete', 'search'],
        'lista JAWNA — pusty config.tools znaczyłby w runnerze read-only, nie „wszystko"');
    t.is(__test__._resolveModelRole(config), 'sub_worker', 'model klasy rodzica');
});

test('fail-soft: brak/zepsute filterByAgent daje workerowi zestaw domyślny, nie wywala delegacji', t => {
    const originalWarn = log.warn;
    log.warn = () => {};
    try {
        const bezRejestru = __test__.buildBuiltinWorkerConfig({} as unknown as DelegatePlugin, { name: 'Jaskier' });
        t.deepEqual(bezRejestru.tools, ['search', 'list', 'read', 'web_search', 'web_read']);

        const rzuca = __test__.buildBuiltinWorkerConfig(
            { toolRegistry: { filterByAgent: () => { throw new Error('boom'); } } } as unknown as DelegatePlugin,
            { name: 'Jaskier' },
        );
        t.deepEqual(rzuca.tools, ['search', 'list', 'read', 'web_search', 'web_read']);
        t.is(rzuca.role, 'worker', 'rola zostaje — worker bez zapisu to nadal worker klasy rodzica');
    } finally {
        log.warn = originalWarn;
    }
});

test('custom sub z YAML role:"worker" też dostaje model rodzica', t => {
    t.is(__test__._resolveModelRole({ name: 'klara-pisarz', description: '', tools: [], role: 'worker' }), 'sub_worker');
    t.is(__test__._resolveModelRole({ name: 'klara-prep', description: '', tools: [], role: 'researcher' }), 'researcher');
    t.is(__test__._resolveModelRole({ name: 'pkm-sub', description: '', tools: [] }), 'researcher',
        'brak roli = dotychczasowy slot sub-agentów (zero zmian dla pkm-sub i szablonów)');
});

test('end-to-end: aspect:"worker" odpala model GŁÓWNY agenta, explorer — slot sub-agentów', async t => {
    const modelKeys: string[] = [];
    class FakeModel {
        constructor(opts: { modelKey?: string }) { modelKeys.push(opts.modelKey || '?'); }
        stream() {}
    }
    const configs: SubAgentConfigLike[] = [];
    const activeAgent = { name: 'Jaskier', activeSubAgents: [] };
    const plugin = {
        currentAutonomy: 'edge',
        toolRegistry: { filterByAgent: () => [{ name: 'read' }, { name: 'write' }] },
        agentManager: { getActiveAgent: () => activeAgent },
        env: {
            config: chatConfig(FakeModel as unknown as LegacyModelClass),
            settings: {
                pkmAssistant: {
                    chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                    modelLibrary: {
                        main: [{ platform: 'ollama', model: 'model-glowny', isDefault: true }],
                        minion: [{ platform: 'ollama', model: 'model-taniutki', isDefault: true }],
                    },
                },
            },
        },
    } as unknown as DelegatePlugin;
    const tool = createDelegateTool({}, {
        makeRunner: () => ({
            runTask: async (_p: string, _a: unknown, config: SubAgentConfigLike) => {
                configs.push(config);
                return { result: 'ok', toolsUsed: [], toolCallDetails: [], duration: 1, usage: null };
            },
        }),
    });

    const zwiad = await tool.execute({ task: 'zwiad', aspect: 'explorer', timeout_ms: 500, background: false }, {}, plugin) as DelegateRes;
    const robota = await tool.execute({ task: 'przepisz', aspect: 'worker', timeout_ms: 500, background: false }, {}, plugin) as DelegateRes;

    t.true(zwiad.success);
    t.is(zwiad.aspect, 'pkm-explorer');
    t.true(robota.success);
    t.is(robota.aspect, 'pkm-worker');
    t.deepEqual(configs[0].tools, ['search', 'list', 'read', 'web_search', 'web_read']);
    t.deepEqual(configs[1].tools, ['read', 'write'], 'worker dostał narzędzia rodzica');
    // Ostatnia sonda `_resolveTaskConcurrency` nie biegnie w trybie single-task, więc lista
    // kluczy modeli jest dokładnie [explorer, worker].
    t.deepEqual(modelKeys, ['model-taniutki', 'model-glowny']);
});

test('cap kontekstu delegacji jedzie z limits, nie z hardcodu 16000', async t => {
    const prompts: string[] = [];
    class FakeModel { stream() {} }
    const activeAgent = { name: 'Jaskier', activeSubAgents: [] };
    const makePlugin = (limits: Record<string, number>) => ({
        currentAutonomy: 'edge',
        toolRegistry: {},
        agentManager: { getActiveAgent: () => activeAgent },
        env: {
            config: chatConfig(FakeModel as unknown as LegacyModelClass),
            settings: {
                pkmAssistant: {
                    chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                    limits,
                    modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] },
                },
            },
        },
    } as unknown as DelegatePlugin);
    const tool = createDelegateTool({}, {
        makeRunner: () => ({
            runTask: async (prompt: string) => {
                prompts.push(prompt);
                return { result: 'ok', toolsUsed: [], toolCallDetails: [], duration: 1, usage: null };
            },
        }),
    });
    const context = 'k'.repeat(30000);

    // Default (48000) przepuszcza 30k w całości — pod starym capem 16000 zostałby ucięty.
    await tool.execute({ task: 'x', context, timeout_ms: 500, background: false }, {}, makePlugin({}));
    t.true(prompts[0].includes('k'.repeat(30000)), 'domyślny budżet 48k mieści cały kontekst');

    // Override usera realnie tnie.
    await tool.execute({ task: 'x', context, timeout_ms: 500, background: false }, {},
        makePlugin({ delegation_context_max_chars: 5000 }));
    t.false(prompts[1].includes('k'.repeat(5001)), 'niższy budżet tnie kontekst');
});

// ─── Strażnicy delegacji (głębokość + szerokość + scope) ─────────────

/**
 * Plugin-atrapa dla testów kagańców. `runs` zbiera wywołania runnera (co realnie odpalono).
 * @param opts - {limits, scope}
 */
function pluginForGuards(
    runs: RunRow[],
    opts: { limits?: Record<string, number>; scope?: unknown; agentTools?: string[] } = {},
) {
    class FakeModel { stream() {} }
    const activeAgent = { name: 'Jaskier', activeSubAgents: [{ name: 'jaskier-prep' }] };
    return {
        plugin: {
            currentAutonomy: 'edge',
            // `filterByAgent` potrzebne dopiero testom aspektu `worker` (klasa rodzica).
            toolRegistry: opts.agentTools
                ? { filterByAgent: () => opts.agentTools!.map(name => ({ name })) }
                : {},
            agentManager: {
                getActiveAgent: () => activeAgent,
                getAgent: () => activeAgent,
                resolveSubAgentConfig: (name: string) => ({ name, tools: [], scope: opts.scope }),
            },
            env: {
                config: chatConfig(FakeModel as unknown as LegacyModelClass),
                settings: {
                    pkmAssistant: {
                        chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                        limits: opts.limits || {},
                        modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] },
                    },
                },
            },
        } as unknown as DelegatePlugin,
        makeRunner: () => ({
            runTask: async (taskPrompt: string, _agent: unknown, config: SubAgentConfigLike, _model: unknown, options: RunnerOptions) => {
                runs.push({ task: taskPrompt, config, options });
                return { result: 'ok', toolsUsed: [], toolCallDetails: [], duration: 1, usage: null };
            },
        }),
    };
}

test('depth: sub-agent (depth 1) NIE deleguje dalej przy limicie 1', async t => {
    const runs: RunRow[] = [];
    const { plugin, makeRunner } = pluginForGuards(runs);
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute(
        { task: 'zleć dalej', _invocationDelegationDepth: 1, timeout_ms: 200, background: false }, {}, plugin as unknown as DelegatePlugin) as DelegateRes;

    t.false(res.success);
    t.true(res.error.includes('1'), 'komunikat niesie limit');
    t.not(res.error, 'mcp.delegate.depth_limit', 'i18n rozwiązane, nie goły klucz');
    t.is(runs.length, 0, 'ZERO odpalonych subów');
});

test('depth: z głębokości 0 sub startuje, a runner dostaje delegationDepth 1', async t => {
    const runs: RunRow[] = [];
    const { plugin, makeRunner } = pluginForGuards(runs);
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute({ task: 'zbierz X', timeout_ms: 200, background: false }, {}, plugin as unknown as DelegatePlugin) as DelegateRes;

    t.true(res.success);
    t.is(runs.length, 1);
    t.is(runs[0].options.delegationDepth, 1, 'sub stoi o piętro niżej niż wołający');
});

test('depth: podniesiony limit (2) przepuszcza jedno piętro głębiej', async t => {
    const runs: RunRow[] = [];
    const { plugin, makeRunner } = pluginForGuards(runs, { limits: { max_delegation_depth: 2 } });
    const tool = createDelegateTool({}, { makeRunner });

    const ok = await tool.execute({ task: 'a', _invocationDelegationDepth: 1, timeout_ms: 200, background: false }, {}, plugin as unknown as DelegatePlugin) as DelegateRes;
    t.true(ok.success);
    t.is(runs[0].options.delegationDepth, 2);

    const stop = await tool.execute({ task: 'b', _invocationDelegationDepth: 2, timeout_ms: 200, background: false }, {}, plugin as unknown as DelegatePlugin) as DelegateRes;
    t.false(stop.success, 'na drugim piętrze kaganiec znów zamyka');
});

test('depth: ujemna głębokość z palca modelu clampowana do 0 — dziecko i tak dostaje depth 1', async t => {
    const runs: RunRow[] = [];
    const { plugin, makeRunner } = pluginForGuards(runs);
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute(
        { task: 'próba resetu licznika', _invocationDelegationDepth: -5, timeout_ms: 200, background: false }, {}, plugin as unknown as DelegatePlugin) as DelegateRes;

    t.true(res.success);
    t.is(runs.length, 1);
    t.is(runs[0].options.delegationDepth, 1, 'clamp: -5 traktowane jak 0, sub startuje z piętra 1');
});

test('width: 6 zadań przy limicie 5 odrzuca CAŁE wywołanie, zero odpalonych subów', async t => {
    const runs: RunRow[] = [];
    const { plugin, makeRunner } = pluginForGuards(runs);
    const tool = createDelegateTool({}, { makeRunner });

    const tasks = Array.from({ length: 6 }, (_, i) => ({ task: `zadanie ${i}`, timeout_ms: 200 }));
    const res = await tool.execute({ tasks, background: false }, {}, plugin as unknown as DelegatePlugin) as DelegateRes;

    t.false(res.success);
    t.falsy(res.results, 'nie zwracamy częściowych wyników');
    t.true(res.error.includes('6') && res.error.includes('5'), 'komunikat niesie licznik i limit');
    t.is(runs.length, 0, 'ani jedno zadanie nie ruszyło');
});

test('width: 5 zadań przy limicie 5 przechodzi (granica włącznie)', async t => {
    const runs: RunRow[] = [];
    const { plugin, makeRunner } = pluginForGuards(runs);
    const tool = createDelegateTool({}, { makeRunner });

    const tasks = Array.from({ length: 5 }, (_, i) => ({ task: `zadanie ${i}`, timeout_ms: 200 }));
    const res = await tool.execute({ tasks, background: false }, {}, plugin as unknown as DelegatePlugin) as DelegateRes;

    t.true(res.success);
    t.is(runs.length, 5);
    t.true(runs.every(r => r.options.delegationDepth === 1));
});

test('scope: scope.folders custom suba jedzie do runnera jako realna bariera', async t => {
    const runs: RunRow[] = [];
    const { plugin, makeRunner } = pluginForGuards(runs, {
        scope: { folders: ['Projekty'], sections: ['## Drafty'] },
    });
    const tool = createDelegateTool({}, { makeRunner });

    await tool.execute({ task: 'x', aspect: 'jaskier-prep', aspect_explicit: true, timeout_ms: 200, background: false }, {}, plugin as unknown as DelegatePlugin) as DelegateRes;

    t.deepEqual(runs[0].options.scopeFolders, ['Projekty']);
});

test('scope: brak scope.folders = brak nowych ograniczeń (null)', async t => {
    const runs: RunRow[] = [];
    const { plugin, makeRunner } = pluginForGuards(runs, { scope: { folders: [], sections: ['## A'] } });
    const tool = createDelegateTool({}, { makeRunner });

    await tool.execute({ task: 'x', aspect: 'jaskier-prep', aspect_explicit: true, timeout_ms: 200, background: false }, {}, plugin as unknown as DelegatePlugin) as DelegateRes;

    t.is(runs[0].options.scopeFolders, null);
});

// ─── Wiszący budzik + górny timeout w trybie multi-task ──

test.serial('_withTimeout rozbraja budzik po rozstrzygnięciu wyścigu', async t => {
    const cleared = [];
    const realClear = globalThis.clearTimeout;
    globalThis.clearTimeout = (id) => { cleared.push(id); return realClear(id); };
    try {
        // Zadanie kończy się natychmiast, a budzik ustawiony jest na minutę: bez clearTimeout
        // timer wisiałby całą minutę i trzymał proces (koszt w testach i harnessie).
        const res = await __test__._withTimeout(Promise.resolve({ success: true }), 60000);
        t.true(res.success);
        t.true(cleared.length >= 1, 'timer został rozbrojony');
    } finally {
        globalThis.clearTimeout = realClear;
    }
});

/** Runner, który NIGDY nie oddaje wyniku — jedyne wyjście to timeout. */
function pluginWithHangingRunner(opts: { limits?: Record<string, number>; scope?: unknown } = {}) {
    const base = pluginForGuards([], opts);
    return { plugin: base.plugin, makeRunner: () => ({ runTask: () => new Promise<never>(() => {}) }) };
}

test('górny timeout_ms jest defaultem dla zadań bez własnego', async t => {
    const { plugin, makeRunner } = pluginWithHangingRunner();
    const tool = createDelegateTool({}, { makeRunner });

    const started = Date.now();
    const res = await tool.execute({ timeout_ms: 60, tasks: [{ task: 'a' }, { task: 'b' }], background: false }, {}, plugin as unknown as DelegatePlugin) as DelegateRes;

    t.true(res.success, 'wywołanie się kończy — nie zwiesza się na domyślnych 120 s');
    t.is(res.results.length, 2);
    t.true(res.results.every(r => r.success === false && r.error.includes('60ms')),
        'każde zadanie dostało górny limit jako swój');
    t.true(Date.now() - started < 5000, 'czekaliśmy sekundy, nie minuty');
});

test('własny timeout_ms zadania wygrywa z górnym', async t => {
    const { plugin, makeRunner } = pluginWithHangingRunner();
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute(
        { timeout_ms: 60, tasks: [{ task: 'a', timeout_ms: 30 }, { task: 'b' }], background: false }, {}, plugin as unknown as DelegatePlugin) as DelegateRes;

    t.true(res.results[0].error.includes('30ms'), 'per-task wygrywa');
    t.true(res.results[1].error.includes('60ms'), 'reszta bierze górny default');
});

// ─── Szerokość multi-task dopasowana do bramki platformy ───

/** Licznik równoległości biegów runnera: max(active) mówi, ile subów realnie biegło naraz. */
type RunConcurrencyLog = { active: number; maxActive: number; started: string[] };

/**
 * Plugin-atrapa z modelem raportującym pojemność bramki platformy.
 * `gateLimit` 0 = chmura/bez bramki (pełna równoległość), N > 0 = platforma lokalna.
 */
function pluginWithGate(gateLimit: number, runLog: RunConcurrencyLog) {
    class GatedModel {
        stream() {}
        _streamGateLimit() { return gateLimit; }
    }
    const activeAgent = { name: 'Jaskier', activeSubAgents: [] };
    return {
        plugin: {
            currentAutonomy: 'edge',
            toolRegistry: {},
            agentManager: { getActiveAgent: () => activeAgent },
            env: {
                config: chatConfig(GatedModel as unknown as LegacyModelClass),
                settings: {
                    pkmAssistant: {
                        chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                        modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] },
                    },
                },
            },
        } as unknown as DelegatePlugin,
        makeRunner: () => ({
            runTask: async (taskPrompt: string) => {
                runLog.active++;
                runLog.maxActive = Math.max(runLog.maxActive, runLog.active);
                runLog.started.push(taskPrompt);
                await new Promise(r => setTimeout(r, 15));
                runLog.active--;
                return { result: 'ok', toolsUsed: [], toolCallDetails: [], duration: 1, usage: null };
            },
        }),
    };
}

test('bramka lokalna limit 1 → taski multi-task jadą SEKWENCYJNIE', async t => {
    const runLog: RunConcurrencyLog = { active: 0, maxActive: 0, started: [] };
    const { plugin, makeRunner } = pluginWithGate(1, runLog);
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute(
        { timeout_ms: 5000, tasks: [{ task: 'a' }, { task: 'b' }, { task: 'c' }], background: false }, {}, plugin) as DelegateRes;

    t.true(res.success);
    t.is(res.results.length, 3);
    t.true(res.results.every(r => r.success === true), 'żaden task nie umarł w kolejce');
    t.is(runLog.maxActive, 1, 'nigdy więcej niż 1 sub naraz — bramka i tak przerabia po kolei');
    t.deepEqual(runLog.started, ['a', 'b', 'c'], 'kolejność startu = kolejność paczki');
});

test('bramka limit 2 → najwyżej 2 suby naraz', async t => {
    const runLog: RunConcurrencyLog = { active: 0, maxActive: 0, started: [] };
    const { plugin, makeRunner } = pluginWithGate(2, runLog);
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute(
        { timeout_ms: 5000, tasks: [{ task: 'a' }, { task: 'b' }, { task: 'c' }], background: false }, {}, plugin) as DelegateRes;

    t.true(res.success);
    t.is(runLog.maxActive, 2, 'szerokość = pojemność bramki, nie zawsze 1');
});

test('chmura (bramka 0) zachowuje pełną równoległość', async t => {
    const runLog: RunConcurrencyLog = { active: 0, maxActive: 0, started: [] };
    const { plugin, makeRunner } = pluginWithGate(0, runLog);
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute(
        { timeout_ms: 5000, tasks: [{ task: 'a' }, { task: 'b' }, { task: 'c' }], background: false }, {}, plugin) as DelegateRes;

    t.true(res.success);
    t.is(runLog.maxActive, 3, 'bez bramki nic się nie zmienia — paczka jedzie równolegle');
});

test('model bez sondy (_streamGateLimit) = dotychczasowa równoległość', async t => {
    const runLog: RunConcurrencyLog = { active: 0, maxActive: 0, started: [] };
    const base = pluginForGuards([]);
    const tool = createDelegateTool({}, {
        makeRunner: () => ({
            runTask: async () => {
                runLog.active++;
                runLog.maxActive = Math.max(runLog.maxActive, runLog.active);
                await new Promise(r => setTimeout(r, 15));
                runLog.active--;
                return { result: 'ok', toolsUsed: [], toolCallDetails: [], duration: 1, usage: null };
            },
        }),
    });

    const res = await tool.execute(
        { timeout_ms: 5000, tasks: [{ task: 'a' }, { task: 'b' }], background: false }, {}, base.plugin) as DelegateRes;

    t.true(res.success);
    t.is(runLog.maxActive, 2);
});

test('_runWithConcurrency: wyniki wracają w kolejności wejścia niezależnie od czasu trwania', async t => {
    const thunks = [
        async () => { await new Promise(r => setTimeout(r, 30)); return 'wolny'; },
        async () => 'szybki',
    ];
    const results = await __test__._runWithConcurrency(thunks, 2);
    t.deepEqual(results, ['wolny', 'szybki']);
});

test('delegate routes EVERY sub-agent through the researcher/minion model slot', async t => {
    const warns: string[] = [];
    const originalWarn = log.warn;
    log.warn = (module: string, message: string, ...data: unknown[]) => warns.push([module, message, ...data].join(' '));

    const modelKeys: Array<string | undefined> = [];
    class FakeModel {
        constructor(opts: { modelKey?: string }) {
            modelKeys.push(opts.modelKey);
        }
        stream() {}
    }

    const activeAgent = {
        name: 'Jaskier',
        activeSubAgents: [
            { name: 'jaskier-prep', role: 'researcher' },
            { name: 'jaskier-strateg', role: 'strategist' },
        ],
    };
    const plugin = {
        currentAutonomy: 'edge',
        toolRegistry: {},
        agentManager: {
            getActiveAgent: () => activeAgent,
            resolveSubAgentConfig: (name: string) => ({
                name,
                // Etykieta role:'strategist' NIE steruje modelem.
                role: name === 'jaskier-strateg' ? 'strategist' : 'researcher',
                tools: [],
            }),
        },
        env: {
            config: chatConfig(FakeModel as unknown as LegacyModelClass),
            settings: {
                pkmAssistant: {
                    chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                    modelLibrary: {
                        minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }],
                        master: [{ platform: 'ollama', model: 'strategy-model', isDefault: true }],
                    },
                },
            },
        },
    };
    const tool = createDelegateTool({}, {
        makeRunner: () => ({
            runTask: async () => ({ result: 'ok', toolsUsed: [], toolCallDetails: [], duration: 1, usage: null }),
        }),
    });

    try {
        await tool.execute({ task: 'prep', aspect: 'jaskier-prep', aspect_explicit: true, timeout_ms: 1, background: false }, {}, plugin as unknown as DelegatePlugin);
        await tool.execute({ task: 'plan', aspect: 'jaskier-strateg', aspect_explicit: true, timeout_ms: 1, background: false }, {}, plugin as unknown as DelegatePlugin);
    } finally {
        log.warn = originalWarn;
    }

    // Nawet sub z etykietą strategist idzie przez slot researcher→minion (worker-model),
    // a NIE przez master (strategy-model nieużyty). Jeden worker dla wszystkich.
    t.deepEqual(modelKeys, ['worker-model', 'worker-model']);
    t.false(warns.some(w => w.includes('modelRole "minion"') || w.includes('modelRole "master"')));
});

// ─── „Delegacja w tle": default = TŁO, zwrotka to started + task_id ───────
//
// Warunek tła po stronie narzędzia jest JEDEN: `plugin.subTaskRegistry` istnieje (i wołamy
// z głównego czatu). Sam byt zakłada RUNNER i melduje go hakiem `onTaskCreated` — dlatego
// atrapa runnera poniżej ten hak woła, dokładnie jak produkcyjny `SubAgentRunner`.

/** Wynik `delegate` w trybie tła — pola typowane pod użycie w tym pliku. */
type TloRes = {
    success?: boolean;
    started?: boolean;
    task_id?: string;
    name?: string;
    note?: string;
    error?: string;
    aspect?: string;
    result?: unknown;
    tasks?: Array<{ task_id: string; name: string }>;
    queued?: number;
    rejected?: Array<{ task?: string; aspect?: string; error?: string }>;
    results?: Array<{ success?: boolean; error?: string }>;
};

/** Opcje runnera w testach tła (origin/background/onTaskCreated). */
type TloRunnerOptions = {
    delegationDepth?: number;
    scopeFolders?: unknown;
    modelTimeout?: number;
    origin?: SubTaskOrigin;
    background?: boolean;
    shouldAbort?: () => boolean;
    /** Sygnał „sub wjechał na slot bramki" — runner podaje go pętli. */
    onGateAdmitted?: () => void;
    onTaskCreated?: (task: SubTask) => void;
};

/** Byt biegu w atrapie runnera — testom wystarczy id + nazwa, resztę pól nosi produkcja. */
function fakeSubTask(id: string, name: string): SubTask {
    return { id, name } as unknown as SubTask;
}

type TloLog = {
    prompts: string[];
    options: TloRunnerOptions[];
    ukonczone: string[];
};

/**
 * Plugin-atrapa Z REJESTREM + runner, który zachowuje się jak produkcyjny: melduje byt
 * hakiem `onTaskCreated`, a wynik oddaje dopiero po `opoznienieMs`.
 */
function pluginZTlem(log: TloLog, opts: { opoznienieMs?: number; registry?: unknown; limits?: Record<string, number> } = {}) {
    class FakeModel { stream() {} }
    const activeAgent = { name: 'Jaskier', activeSubAgents: [{ name: 'jaskier-prep' }] };
    let seq = 0;
    return {
        plugin: {
            currentAutonomy: 'edge',
            toolRegistry: {},
            subTaskRegistry: 'registry' in opts ? opts.registry : {},
            agentManager: {
                getActiveAgent: () => activeAgent,
                getAgent: () => activeAgent,
                resolveSubAgentConfig: (name: string) => ({ name, tools: [] }),
            },
            env: {
                config: chatConfig(FakeModel as unknown as LegacyModelClass),
                settings: {
                    pkmAssistant: {
                        chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                        limits: opts.limits || {},
                        modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] },
                    },
                },
            },
        } as unknown as DelegatePlugin,
        makeRunner: () => ({
            runTask: async (taskPrompt: string, _agent: unknown, config: SubAgentConfigLike, _model: unknown, options: TloRunnerOptions) => {
                log.prompts.push(taskPrompt);
                log.options.push(options);
                const id = `sub/${config.name}#${(++seq).toString(36)}`;
                options.onTaskCreated?.(fakeSubTask(id, config.name));
                if (opts.opoznienieMs) await new Promise(r => setTimeout(r, opts.opoznienieMs));
                log.ukonczone.push(id);
                return { result: 'wynik suba', toolsUsed: [], toolCallDetails: [], duration: 1, usage: null };
            },
        }),
    };
}

function nowyLog(): TloLog {
    return { prompts: [], options: [], ukonczone: [] };
}

test.serial('default: delegate startuje suba w TLE — tura dostaje started + task_id, nie wynik', async t => {
    __test__._resetBackground();
    const log = nowyLog();
    const { plugin, makeRunner } = pluginZTlem(log, { opoznienieMs: 40 });
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute({ task: 'zbierz X' }, {}, plugin) as TloRes;

    t.true(res.success);
    t.true(res.started, 'zwrotka melduje START, nie wynik');
    t.regex(res.task_id || '', /^sub\/pkm-sub#/);
    t.is(res.name, 'pkm-sub');
    t.falsy(res.result, 'wyniku suba w zwrotce NIE MA — wróci powiadomieniem');
    t.truthy(res.note, 'model dostaje instrukcję, żeby nie zgadywać wyniku');
    t.not(res.note, 'subagent.background_started', 'i18n rozwiązane, nie goły klucz');
    t.deepEqual(log.ukonczone, [], 'w chwili zwrotki sub jeszcze biegnie');
    t.is(log.options[0].background, true, 'runner (a przez niego rejestr) wie, że to bieg w tle');

    await new Promise(r => setTimeout(r, 120));
    t.is(log.ukonczone.length, 1, 'bieg domyka się PO turze');
});

// Model wybierał `background:false` z przyzwyczajenia i mroził userowi czat na cały bieg
// suba. Z głównego czatu tło jest PRZYMUSOWE — jawnie podany parametr jest ignorowany.
// Blokada żyje dalej TYLKO bez rejestru (fail-soft, test niżej) i przy delegacji z wnętrza
// suba (depth >= 1, testy budżetów niżej).
test.serial('background:false z czatu IGNOROWANE — sub i tak startuje w tle', async t => {
    __test__._resetBackground();
    const log = nowyLog();
    const { plugin, makeRunner } = pluginZTlem(log, { opoznienieMs: 40 });
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute({ task: 'zbierz X', background: false, timeout_ms: 500 }, {}, plugin) as TloRes;

    t.true(res.success);
    t.true(res.started, 'model nie ma już furtki blokującej — zwrotka to pokwitowanie');
    t.regex(res.task_id || '', /^sub\/pkm-sub#/);
    t.falsy(res.result, 'wyniku w turze NIE MA — wróci powiadomieniem');
    t.is(log.options[0].background, true, 'bieg jest tłowy mimo background:false w args');
    await new Promise(r => setTimeout(r, 120));
    t.is(log.ukonczone.length, 1, 'bieg domyka się PO turze');
});

test.serial('fail-soft: bez plugin.subTaskRegistry delegacja leci ścieżką BLOKUJĄCĄ', async t => {
    __test__._resetBackground();
    const log = nowyLog();
    const { plugin, makeRunner } = pluginZTlem(log, { registry: null });
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute({ task: 'zbierz X', timeout_ms: 500 }, {}, plugin) as TloRes;

    t.true(res.success);
    t.falsy(res.started, 'nie ma czym wrócić z wynikiem, więc nie udajemy tła');
    t.is(res.result, 'wynik suba');
    t.is(log.ukonczone.length, 1);
});

test.serial('multi-task: cała paczka jedzie w tle, zwrotka niesie listę task_id', async t => {
    __test__._resetBackground();
    const log = nowyLog();
    const { plugin, makeRunner } = pluginZTlem(log, { opoznienieMs: 40 });
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute(
        { tasks: [{ task: 'a' }, { task: 'b' }, { task: 'c' }] }, {}, plugin) as TloRes;

    t.true(res.success);
    t.true(res.started);
    t.is(res.tasks?.length, 3, 'chmura (bramka 0) startuje całą paczkę od razu');
    t.true((res.tasks || []).every(x => /^sub\//.test(x.task_id) && x.name === 'pkm-sub'));
    t.falsy(res.results, 'wyników w zwrotce nie ma');
    t.deepEqual(log.ukonczone, [], 'w chwili zwrotki żaden sub jeszcze nie skończył');

    await new Promise(r => setTimeout(r, 140));
    t.is(log.ukonczone.length, 3);
});

test.serial('szerokość: zadania biegnące W TLE liczą się do limitu następnego wywołania', async t => {
    __test__._resetBackground();
    const log = nowyLog();
    const { plugin, makeRunner } = pluginZTlem(log, { opoznienieMs: 150 });
    const tool = createDelegateTool({}, { makeRunner });

    const pierwsze = await tool.execute(
        { tasks: [{ task: 'a' }, { task: 'b' }, { task: 'c' }, { task: 'd' }] }, {}, plugin) as TloRes;
    t.true(pierwsze.started);
    t.is(__test__._backgroundCount(), 4);

    // Limit domyślny = 5, w tle biegnie 4 → paczka dwóch już się nie zmieści.
    const drugie = await tool.execute({ tasks: [{ task: 'e' }, { task: 'f' }] }, {}, plugin) as TloRes;
    t.false(drugie.success);
    t.true((drugie.error || '').includes('6') && (drugie.error || '').includes('5'),
        `komunikat niesie łączny licznik i limit: ${drugie.error}`);

    // Pojedyncze zadanie wchodzi (4 + 1 = 5, granica włącznie).
    const trzecie = await tool.execute({ task: 'g' }, {}, plugin) as TloRes;
    t.true(trzecie.started);

    await new Promise(r => setTimeout(r, 300));
    t.is(__test__._backgroundCount(), 0, 'licznik zwalnia się po zakończeniu biegów');
});

test.serial('timeout w tle: tura ma started, a sub i tak zostaje UBITY (abort + stopStream)', async t => {
    __test__._resetBackground();
    let streamStopped = 0;
    class HangingModel {
        stream() { /* nigdy nie wraca */ }
        stopStream() { streamStopped++; }
    }
    const captured: { options?: TloRunnerOptions } = {};
    const activeAgent = { name: 'Jaskier', activeSubAgents: [] };
    const plugin = {
        currentAutonomy: 'edge',
        toolRegistry: {},
        subTaskRegistry: {},
        agentManager: { getActiveAgent: () => activeAgent },
        env: {
            config: chatConfig(HangingModel as unknown as LegacyModelClass),
            settings: {
                pkmAssistant: {
                    chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                    modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] },
                },
            },
        },
    } as unknown as DelegatePlugin;
    const tool = createDelegateTool({}, {
        makeRunner: () => ({
            runTask: (_task: string, _agent: unknown, config: SubAgentConfigLike, _model: unknown, options: TloRunnerOptions) => {
                captured.options = options;
                options.onTaskCreated?.(fakeSubTask(`sub/${config.name}#t`, config.name));
                return new Promise<never>(() => {}); // sub wisi — rozstrzyga timeout delegacji
            },
        }),
    });

    const res = await tool.execute({ task: 'wisisz', timeout_ms: 30 }, {}, plugin) as TloRes;
    t.true(res.started, 'tura nie czeka na budzik');

    await new Promise(r => setTimeout(r, 120));
    t.is(streamStopped, 1, 'porzucony sub NIE mieli dalej — timeout go ubija tak samo jak w trybie blokującym');
    t.true(captured.options!.shouldAbort!(), 'flaga abortu pętli suba podniesiona');
});

test.serial('origin jedzie do rejestru, ale NIE trafia do promptu suba', async t => {
    __test__._resetBackground();
    const log = nowyLog();
    const { plugin, makeRunner } = pluginZTlem(log);
    const tool = createDelegateTool({}, { makeRunner });
    const origin = { agentName: 'Klara', sessionPath: 'Czaty/klara.md', tabKey: 'tab-7' };

    const res = await tool.execute(
        { task: 'zbierz X', context: 'kontekst od rodzica', _invocationOrigin: origin }, {}, plugin) as TloRes;

    t.true(res.started);
    t.deepEqual(log.options[0].origin, origin, 'adres zwrotny dociera do runnera → rejestru');
    t.false(log.prompts[0].includes('_invocationOrigin'), 'znacznik nie przecieka do promptu suba');
    t.false(log.prompts[0].includes('tab-7'));
    t.true(log.prompts[0].includes('kontekst od rodzica'), 'zwykły kontekst przechodzi jak dotąd');
});

test.serial('podrobiony origin bez agentName jest odrzucany (do rejestru nie idzie nic)', async t => {
    __test__._resetBackground();
    const log = nowyLog();
    const { plugin, makeRunner } = pluginZTlem(log);
    const tool = createDelegateTool({}, { makeRunner });

    await tool.execute({ task: 'zbierz X', _invocationOrigin: { tabKey: 'tab-9' } }, {}, plugin) as TloRes;

    t.is(log.options[0].origin, undefined);
});

test.serial('sub-agent (depth 1) przy podniesionym limicie deleguje BLOKUJĄCO, nie w tle', async t => {
    __test__._resetBackground();
    const log = nowyLog();
    const { plugin, makeRunner } = pluginZTlem(log, { limits: { max_delegation_depth: 2 } });
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute(
        { task: 'zleć niżej', _invocationDelegationDepth: 1, timeout_ms: 500 }, {}, plugin) as TloRes;

    t.true(res.success);
    t.falsy(res.started, 'tło jest przywilejem GŁÓWNEGO czatu — sub czeka na swojego suba');
    t.is(res.result, 'wynik suba');
});

// ─── „Panel biegów": Stop z panelu ubija bieg ─────────────────────────────
//
// Test jedzie na PRAWDZIWYM `SubTaskRegistry` (nie atrapie), bo cała wartość tej
// ścieżki to spotkanie trzech rzeczy: id nadanego przez runnera, uchwytu podpiętego
// przez `delegate` i prośby przychodzącej z panelu, który zna wyłącznie id.

/**
 * Plugin z żywym rejestrem + model umiejący `stopStream` (tylko na nim widać,
 * że abort naprawdę dosięgnął streamu, a nie skończył się na fladze).
 */
function pluginZeStopem(registry: SubTaskRegistry) {
    const stopy: string[] = [];
    class FakeModel {
        stream() {}
        stopStream() { stopy.push('stop'); }
    }
    const activeAgent = { name: 'Jaskier', activeSubAgents: [] as Array<{ name: string }> };
    return {
        stopy,
        plugin: {
            currentAutonomy: 'edge',
            toolRegistry: {},
            subTaskRegistry: registry,
            agentManager: {
                getActiveAgent: () => activeAgent,
                getAgent: () => activeAgent,
                resolveSubAgentConfig: (name: string) => ({ name, tools: [] }),
            },
            env: {
                config: chatConfig(FakeModel as unknown as LegacyModelClass),
                settings: {
                    pkmAssistant: {
                        chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                        limits: {},
                        modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] },
                    },
                },
            },
        } as unknown as DelegatePlugin,
    };
}

/**
 * Runner-atrapa naśladujący produkcyjny `SubAgentRunner`: zakłada byt w rejestrze,
 * melduje go hakiem, a potem kręci się do skutku patrząc na `shouldAbort` — dokładnie
 * jak prawdziwa pętla między iteracjami.
 */
function makeStopRunner(registry: SubTaskRegistry, seq = { n: 0 }) {
    return () => ({
        runTask: async (_prompt: string, _agent: unknown, config: SubAgentConfigLike, _model: unknown, options: TloRunnerOptions) => {
            const task = registry.create({ id: `sub/${config.name}#${(++seq.n).toString(36)}`, name: config.name });
            options.onTaskCreated?.(task);
            // „Pętla" suba: kręci się, dopóki ktoś nie poprosi o stop.
            for (let i = 0; i < 200 && !options.shouldAbort?.(); i++) {
                await new Promise(r => setTimeout(r, 5));
            }
            registry.finish(task, { text: 'przerwane', toolsUsed: [], durationMs: 1, usage: null, stoppedBy: 'abort' });
            return { result: 'przerwane', toolsUsed: [], toolCallDetails: [], duration: 1, usage: null };
        },
    });
}

test.serial('requestStop po id z rejestru zatrzymuje bieg odpalony W TLE', async t => {
    __test__._resetBackground();
    const registry = new SubTaskRegistry();
    const { plugin, stopy } = pluginZeStopem(registry);
    const tool = createDelegateTool({}, { makeRunner: makeStopRunner(registry) });

    const res = await tool.execute({ task: 'zbierz X' }, {}, plugin) as TloRes;
    t.true(res.started, 'warunek wstępny: bieg poszedł w tło');

    t.true(registry.requestStop(res.task_id!), 'uchwyt był podpięty przy starcie biegu');
    t.is(stopy.length, 1, 'abort dosięgnął streamu modelu (stopStream)');
    t.true(registry.getTask(res.task_id!)?.stopRequested);

    // Pętla suba naprawdę staje — bez tego „Stop" byłby napisem na guziku.
    const deadline = Date.now() + 3000;
    while (registry.getTask(res.task_id!)?.status === 'running' && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 10));
    }
    t.is(registry.getTask(res.task_id!)?.status, 'aborted');
    registry.dispose();
});

test.serial('Stop działa też dla biegu BLOKUJĄCEGO (background:false)', async t => {
    __test__._resetBackground();
    const registry = new SubTaskRegistry();
    const { plugin, stopy } = pluginZeStopem(registry);
    const tool = createDelegateTool({}, { makeRunner: makeStopRunner(registry) });

    // Zwrotki tu nie ma (tura CZEKA), więc panel bierze bieg z rejestru — tak jak w Obsidianie:
    // widok odświeża się na zdarzeniu i klika Stop po id, gdy bieg już wisi na liście.
    const bieg = tool.execute({ task: 'zbierz X', background: false, timeout_ms: 5000 }, {}, plugin) as Promise<TloRes>;
    let zatrzymany = false;
    const deadline = Date.now() + 3000;
    while (!zatrzymany && Date.now() < deadline) {
        const running = registry.list().find(x => x.status === 'running');
        if (running) zatrzymany = registry.requestStop(running.id);
        if (!zatrzymany) await new Promise(r => setTimeout(r, 10));
    }
    const res = await bieg;

    t.true(zatrzymany, 'blokująca ścieżka też rejestruje uchwyt Stop');
    t.is(stopy.length, 1);
    t.true(res.success);
    registry.dispose();
});

// ─── Gotchas pokryte tu na PRAWDZIWEJ pętli, nie atrapie ────────────────────────────
// Stop może wisieć na „zatrzymywanie…" w nieskończoność, jeśli pętla suba stoi na
// `await model.stream()`, a abort adaptera nie rozstrzyga tej promisy — bieg kończyłby się
// dopiero po pełnym budżecie, jako błąd. Osobno: worker (priorytet 0) może długo stać
// w kolejce bramki lokalnej platformy, a budżet zadania minąć mu w trakcie tego czekania
// zamiast dać pełny czas na samą robotę — „anulowany w kolejce bramki".

/** Model-atrapa w kontrakcie ChatModel PO fixie: wisi, a `stopStream` ODRZUCA promisę. */
function makeAbortableModel(opts: { admitAfterMs?: number } = {}) {
    const state = { stopCalls: 0, admits: 0 };
    class AbortableModel {
        _settle: ((e: unknown) => void) | null = null;
        stream(_payload: unknown, handlers: { gate_admitted?: () => void }): Promise<never> {
            // Bramka platformy lokalnej: sygnał „wjechałem na slot" leci z opóźnieniem.
            setTimeout(() => { state.admits++; handlers?.gate_admitted?.(); }, opts.admitAfterMs ?? 0);
            return new Promise<never>((_, reject) => { this._settle = reject; });
        }
        stopStream(): void {
            state.stopCalls++;
            const settle = this._settle;
            this._settle = null;
            settle?.(Object.assign(new Error('Strumień modelu przerwany (Stop).'), { _aborted: true }));
        }
    }
    return { state, AbortableModel };
}

/** Plugin-atrapa z rejestrem, w którym model jest `AbortableModel` (Stop realnie kończy stream). */
function pluginZAbortem(registry: SubTaskRegistry, ModelClass: unknown) {
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

/** Runner-atrapa na PRAWDZIWEJ pętli — atrapa prostszej pętli nie dotknęłaby mechanizmu. */
function makeLoopRunner(registry: SubTaskRegistry, seq = { n: 0 }) {
    return () => ({
        runTask: async (
            prompt: string,
            _agent: unknown,
            config: SubAgentConfigLike,
            model: unknown,
            options: TloRunnerOptions,
        ) => {
            const task = registry.create({ id: `sub/${config.name}#${(++seq.n).toString(36)}`, name: config.name });
            options.onTaskCreated?.(task);
            try {
                const res = await runAgentLoop({
                    model: model as never,
                    store: new ArrayMessageStore([{ role: 'user', content: prompt }]),
                    resolveTools: () => [],
                    executeToolCall: async () => 'x',
                    limits: { maxIterations: 3 },
                    ...(options.shouldAbort ? { shouldAbort: options.shouldAbort } : {}),
                    ...(options.onGateAdmitted ? { onGateAdmitted: options.onGateAdmitted } : {}),
                });
                registry.finish(task, {
                    text: res.finalText, toolsUsed: res.toolsUsed, durationMs: 1, usage: null, stoppedBy: res.stoppedBy,
                });
                return { result: res.finalText, toolsUsed: [], toolCallDetails: [], duration: 1, usage: null, stoppedBy: res.stoppedBy };
            } catch (e) {
                registry.fail(task, (e as Error).message);
                return { result: (e as Error).message, toolsUsed: [], toolCallDetails: [], duration: 1, usage: null, stoppedBy: 'error' as const, failed: true as const };
            }
        },
    });
}

test.serial('Stop na biegu stojącym W ŚRODKU wywołania modelu kończy go NATYCHMIAST jako Przerwany', async t => {
    __test__._resetBackground();
    const registry = new SubTaskRegistry();
    const { state, AbortableModel } = makeAbortableModel();
    const plugin = pluginZAbortem(registry, AbortableModel);
    const tool = createDelegateTool({}, { makeRunner: makeLoopRunner(registry) });

    const res = await tool.execute({ task: 'zbierz X' }, {}, plugin) as TloRes;
    t.true(res.started, 'warunek wstępny: bieg poszedł w tło');

    const startedAt = Date.now();
    t.true(registry.requestStop(res.task_id!), 'uchwyt Stop podpięty');
    t.is(state.stopCalls, 1, 'abort dosięgnął streamu modelu');

    const deadline = Date.now() + 2000;
    while (registry.getTask(res.task_id!)?.status === 'running' && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5));
    }
    // Bez tego mechanizmu bieg wisiałby tu aż do per-call budzika (120 s) i kończyłby się
    // jako `error`, zamiast dawać Przerwany od razu.
    t.is(registry.getTask(res.task_id!)?.status, 'aborted', 'karta biegu: Przerwany, nie błąd');
    t.true(Date.now() - startedAt < 1000, 'domknięcie idzie od ręki, nie po budziku');
    registry.dispose();
});

test.serial('budżet zadania liczy się od WJAZDU na slot bramki, nie od zlecenia', async t => {
    __test__._resetBackground();
    const registry = new SubTaskRegistry();
    // Miniaturowa reprodukcja: kolejka 60 ms, budżet zadania 80 ms. Budzik uzbrojony na
    // starcie zlecenia strzeliłby w 80 ms (ledwie 20 ms realnej roboty po wjeździe na slot);
    // dopiero przezbrojenie budzika na pierwszej admisji do bramki daje pełny budżet PO wjeździe.
    const { state, AbortableModel } = makeAbortableModel({ admitAfterMs: 60 });
    const plugin = pluginZAbortem(registry, AbortableModel);
    // Z czatu (depth 0) tło jest przymusowe — kontrakt ścieżki BLOKUJĄCEJ testujemy
    // tam, gdzie ona nadal legalnie żyje: delegacja z WNĘTRZA suba (depth 1, limit podniesiony).
    (plugin.env!.settings!.pkmAssistant!.limits as Record<string, number>).max_delegation_depth = 2;
    const tool = createDelegateTool({}, { makeRunner: makeLoopRunner(registry) });

    const startedAt = Date.now();
    const res = await tool.execute(
        { task: 'zbierz X', timeout_ms: 80, _invocationDelegationDepth: 1 },
        {}, plugin,
    ) as { success?: boolean; error?: string };
    const waited = Date.now() - startedAt;

    t.is(state.admits, 1, 'sub dostał slot dopiero po czekaniu w kolejce');
    t.true(waited >= 125, `budzik strzelił po ${waited} ms — kolejka (60) + PEŁNY budżet (80)`);
    t.false(res.success, 'po przezbrojeniu budzik i tak pilnuje biegu (nie zniknął)');
    registry.dispose();
});

test.serial('bez sygnału bramki budzik zadania działa jak dotąd (siatka bezpieczeństwa)', async t => {
    // Model, który NIGDY nie melduje admisji (atrapy, obce implementacje) nie może zostać
    // bez sufitu — budzik uzbrojony przy zleceniu strzela normalnie.
    __test__._resetBackground();
    const registry = new SubTaskRegistry();
    const { AbortableModel } = makeAbortableModel({ admitAfterMs: 300 });
    const plugin = pluginZAbortem(registry, AbortableModel);
    // Ścieżka blokująca przez depth 1 (z czatu tło jest przymusowe).
    (plugin.env!.settings!.pkmAssistant!.limits as Record<string, number>).max_delegation_depth = 2;
    const tool = createDelegateTool({}, { makeRunner: makeLoopRunner(registry) });

    const startedAt = Date.now();
    const res = await tool.execute(
        { task: 'zbierz X', timeout_ms: 60, _invocationDelegationDepth: 1 },
        {}, plugin,
    ) as { success?: boolean; error?: string };

    t.false(res.success);
    t.true(Date.now() - startedAt < 1000, 'ubity budżetem od zlecenia, nie czekał na admisję');
    registry.dispose();
});

test.serial('brak attachAbort w rejestrze nie psuje delegacji (fail-soft)', async t => {
    __test__._resetBackground();
    const log = nowyLog();
    // Rejestr-atrapa BEZ `attachAbort` — jak starszy bootstrap albo wysypana implementacja.
    const { plugin, makeRunner } = pluginZTlem(log, { registry: { attachAbort: () => { throw new Error('boom'); } } });
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute({ task: 'zbierz X' }, {}, plugin) as TloRes;

    t.true(res.started, 'delegacja przeszła mimo wysypanego attachAbort');
});

// ─── Sposób zejścia suba (stopped_by) ───
// Sub potrafi wyczerpać iteracje i zejść backstopem, a bez `stopped_by` agent zlecający
// dostaje `status=ok` bez żadnego pola mówiącego, że to zejście awaryjne — referuje wynik
// jako „zadanie wykonane", mimo że to zaślepka. To samo dotyczy sytuacji, gdy finalny strzał
// backstopu sam pada błędem („Backstop final call błąd: Model timeout"): bez oznaczenia tą
// samą ścieżką wracałaby goła zaślepka, nadal jako `success: true`.
// Zwrotka delegacji niesie `stopped_by`.
function pluginDlaZejscia() {
    return {
        agentManager: {
            getActiveAgent: () => ({ name: 'Tester', activeSubAgents: [] }),
            resolveSubAgentConfig: () => null,
        },
        toolRegistry: {},
        env: { chatModel: { stream: () => { /* atrapa: obecność .stream wystarcza */ } } },
    } as unknown as DelegatePlugin;
}

test('wynik delegacji niesie sposób zejścia suba (stopped_by)', async t => {
    const tool = createDelegateTool({}, {
        makeRunner: () => ({
            runTask: async () => ({
                result: '(Osiągnięto limit iteracji narzędzi)',
                toolsUsed: ['read'],
                toolCallDetails: [],
                duration: 22080,
                usage: null,
                stoppedBy: 'backstop',
            }),
        }),
    });

    const out = await tool.execute({ task: 'zrób raport', timeout_ms: 500, background: false }, {}, pluginDlaZejscia()) as
        { success?: boolean; stopped_by?: string };

    // Kontrola założenia: delegacja przeszła normalną ścieżką i wróciła jako sukces.
    t.true(out.success);
    t.is(out.stopped_by, 'backstop', 'wynik delegacji nie mówi, że sub zszedł backstopem');
});

test('bieg z failed:true wraca do modelu jako success:false + stopped_by "error"', async t => {
    const tool = createDelegateTool({}, {
        makeRunner: () => ({
            runTask: async () => ({
                result: 'Błąd sub-agenta pkm-sub: Model timeout',
                toolsUsed: [],
                toolCallDetails: [],
                duration: 1234,
                usage: null,
                stoppedBy: 'error',
                failed: true as const,
            }),
        }),
    });

    const out = await tool.execute({ task: 'zrób raport', timeout_ms: 500, background: false }, {}, pluginDlaZejscia()) as
        { success?: boolean; error?: string; stopped_by?: string; duration_ms?: number; result?: unknown };

    t.false(out.success, 'błąd suba NIE MOŻE udawać sukcesu');
    t.is(out.stopped_by, 'error');
    t.true((out.error || '').includes('Model timeout'));
    t.is(out.duration_ms, 1234);
    t.is(out.result, undefined, 'gałąź błędu nie udaje, że jest wynik');
});

test('multi-task — element z błędem jest success:false, sąsiad z sukcesem nietknięty', async t => {
    __test__._resetBackground();
    let n = 0;
    const tool = createDelegateTool({}, {
        makeRunner: () => ({
            runTask: async () => (n++ === 0
                ? { result: 'ok', toolsUsed: [], toolCallDetails: [], duration: 1, usage: null, stoppedBy: 'natural' as const }
                : { result: 'Błąd sub-agenta pkm-sub: padło', toolsUsed: [], toolCallDetails: [], duration: 2, usage: null, stoppedBy: 'error' as const, failed: true as const }),
        }),
    });

    const out = await tool.execute(
        { tasks: [{ task: 'a' }, { task: 'b' }], background: false },
        {},
        pluginDlaZejscia(),
    ) as { success?: boolean; results: Array<{ success?: boolean; stopped_by?: string; error?: string }> };

    t.true(out.success, 'całe wywołanie przechodzi — o losie zadań mówią elementy');
    t.true(out.results[0].success);
    t.is(out.results[0].stopped_by, 'natural');
    t.false(out.results[1].success);
    t.is(out.results[1].stopped_by, 'error');
});

test('runner bez stoppedBy (starszy kształt wyniku) nie wstawia pustego stopped_by — kształt jak dotąd', async t => {
    const tool = createDelegateTool({}, {
        makeRunner: () => ({
            runTask: async () => ({ result: 'ok', toolsUsed: [], toolCallDetails: [], duration: 1, usage: null }),
        }),
    });

    const out = await tool.execute({ task: 'x', background: false }, {}, pluginDlaZejscia()) as
        Record<string, unknown>;

    t.true(out.success as boolean);
    t.false('stopped_by' in out);
});

// ─── Grace-okno na finalne podsumowanie suba ───────────────────────────
// `delegation_timeout_ms` obejmuje CAŁY bieg, więc budzik potrafi strzelić dokładnie
// wtedy, gdy sub pisze już podsumowanie backstopu — bez grace-okna zadanie zjadałoby pełny
// budżet na narzędzia i oddawało zaślepkę zamiast dorobku.

/** Karta biegu w zakresie, jakiego dotyka `_isInFinalSummary`. */
function karta(typy: string[]) {
    return { id: 'sub/x#1', steps: typy.map((type, i) => ({ at: i, type, fields: {} })) } as unknown as SubTask;
}

test('_isInFinalSummary widzi backstop bez późniejszego loop.end', t => {
    t.true(__test__._isInFinalSummary(karta(['loop.start', 'tool.pre', 'tool.post', 'backstop'])));
    // Między backstopem a końcem pętla zapisuje jeszcze model.done — to nadal finalna iteracja.
    t.true(__test__._isInFinalSummary(karta(['backstop', 'model.done'])));
});

test('_isInFinalSummary NIE odracza w zwykłej iteracji ani po domknięciu pętli', t => {
    t.false(__test__._isInFinalSummary(karta(['loop.start', 'model.done', 'tool.pre'])));
    t.false(__test__._isInFinalSummary(karta(['backstop', 'model.done', 'loop.end'])), 'pętla już zeszła');
    t.false(__test__._isInFinalSummary(karta([])), 'bieg bez kroków');
    t.false(__test__._isInFinalSummary(undefined), 'brak karty = brak dowodu = brak odroczenia');
});

test('timeout w trakcie backstopu ODRACZA abort, timeout w zwykłej iteracji ubija natychmiast', async t => {
    const zrobGrace = (typy: string[], odroczenia: string[]) => __test__._makeFinalGrace(
        {
            subTaskRegistry: {
                getTask: () => karta(typy),
                step: (_task: SubTask, type: string) => { odroczenia.push(type); },
            },
        } as unknown as DelegatePlugin,
        30,
        () => 'sub/x#1',
    );

    // (a) zwykła iteracja — budzik ubija od razu, bez śladu odroczenia.
    // Sprawdzanie realnym zegarem ściennym (`Date.now() - startA < 45`) przy tak wąskim
    // marginesie (20ms budżet + tylko 25ms luzu) flake'uje pod obciążonym `npm test`.
    // Komunikat błędu dowodzi braku odroczenia deterministycznie: `kill()` wpisuje w niego
    // dokładnie `effectiveTimeout` (tu 20), a okno grace dopisałoby +30 — "20ms" zamiast
    // "50ms" jest tym samym dowodem co pomiar zegara, bez wrażliwości na obciążenie procesu
    // testowego.
    const sladyA: string[] = [];
    const a = await __test__._withTimeout(new Promise(() => {}), 20, 20, null, zrobGrace(['tool.post'], sladyA)) as { error: string };
    t.true(/timeout after 20ms/.test(a.error), 'brak grace w komunikacie = abort natychmiastowy, bez doliczonych 30ms');
    t.deepEqual(sladyA, []);

    // (b) finalne podsumowanie — abort odroczony, w karcie ląduje `timeout.grace`.
    const sladyB: string[] = [];
    const b = await __test__._withTimeout(new Promise(() => {}), 20, 20, null, zrobGrace(['backstop'], sladyB)) as { error: string };
    t.deepEqual(sladyB, ['timeout.grace'], 'ślad odroczenia trafia do rejestru');
    t.true(/timeout after 50ms/.test(b.error), `komunikat ma pokazywać CAŁY przeczekany czas: ${b.error}`);
});

test('wynik, który zdążył w grace-oknie, wygrywa wyścig (abort nie leci)', async t => {
    let ubity = 0;
    const grace = __test__._makeFinalGrace(
        { subTaskRegistry: { getTask: () => karta(['backstop']), step: () => {} } } as unknown as DelegatePlugin,
        200,
        () => 'sub/x#1',
    );
    const bieg = new Promise(res => setTimeout(() => res({ success: true, result: 'podsumowanie' }), 40));

    const out = await __test__._withTimeout(bieg, 10, 10, () => { ubity++; }, grace) as { success?: boolean; result?: string };

    t.true(out.success, 'sub dojechał w grace-oknie');
    t.is(out.result, 'podsumowanie');
    t.is(ubity, 0, 'abortu nie było — bieg zdążył');
});

// Sprawdzanie realnym zegarem (`Date.now() - t1 < 40` / `< 40`) przy marginesie 15ms budżetu
// + tylko 25ms luzu flake'uje pod obciążonym `npm test`. Dowód idzie zamiast tego przez
// TREŚĆ komunikatu: `kill()` wpisuje weń `effectiveTimeout` (15), a doliczone okno grace
// zmieniłoby go na `15+30=45` — "15ms" w obu gałęziach jest deterministycznym dowodem
// "zero odroczenia", niezależnym od tego, jak długo faktycznie trwał bieg testu na
// obciążonej maszynie.
test('brak rejestru / wysypany getTask = zero odroczenia (fail-soft)', async t => {
    const bezRejestru = __test__._makeFinalGrace({} as DelegatePlugin, 30, () => 'sub/x#1');
    const res1 = await __test__._withTimeout(new Promise(() => {}), 15, 15, null, bezRejestru) as { error: string };
    t.true(/timeout after 15ms/.test(res1.error), 'brak rejestru nie może odraczać (komunikat bez doliczonych 30ms)');

    const wysypany = __test__._makeFinalGrace(
        { subTaskRegistry: { getTask: () => { throw new Error('boom'); } } } as unknown as DelegatePlugin,
        30,
        () => 'sub/x#1',
    );
    const res2 = await __test__._withTimeout(new Promise(() => {}), 15, 15, null, wysypany) as { error: string };
    t.true(/timeout after 15ms/.test(res2.error), 'wyjątek sondy nie może przykryć timeoutu ani dopisać grace');
});

test.serial('end-to-end: delegacja z realnym rejestrem odracza abort, gdy sub jest w backstopie', async t => {
    __test__._resetBackground();
    const registry = new SubTaskRegistry();
    const kroki: string[] = [];
    registry.events.on('task:step', (p: unknown) => kroki.push((p as { step: { type: string } }).step.type));

    class FakeModel { stream() {} }
    const activeAgent = { name: 'Jaskier', activeSubAgents: [] };
    const plugin = {
        toolRegistry: {},
        subTaskRegistry: registry,
        agentManager: {
            getActiveAgent: () => activeAgent,
            getAgent: () => activeAgent,
            resolveSubAgentConfig: () => null,
        },
        env: {
            config: chatConfig(FakeModel as unknown as LegacyModelClass),
            settings: {
                // Grace poniżej `min` z LIMIT_SPECS spada na default — dlatego bierzemy 5000
                // (dokładnie podłoga) i ucinamy czekanie realnym wynikiem po 40 ms.
                // Depth 2, bo ścieżkę BLOKUJĄCĄ (na której czekamy na grace) wołamy
                // z wnętrza suba (depth 1) — z czatu tło jest przymusowe.
                pkmAssistant: {
                    chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                    limits: { subagent_final_grace_ms: 5000, max_delegation_depth: 2 },
                    modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] },
                },
            },
        },
    } as unknown as DelegatePlugin;

    const tool = createDelegateTool({}, {
        makeRunner: () => ({
            runTask: async (_p: string, _a: unknown, config: SubAgentConfigLike, _m: unknown, options: { onTaskCreated?: (t: SubTask) => void }) => {
                const task = registry.create({ id: `sub/${config.name}#1`, name: config.name, agentName: 'Jaskier' });
                options.onTaskCreated?.(task);
                // Sub wchodzi w finalną iterację, a potem PISZE dłużej niż budżet zadania.
                registry.step(task, 'backstop', { after: 12 });
                await new Promise(r => setTimeout(r, 40));
                registry.step(task, 'loop.end', { stop: 'backstop' });
                registry.finish(task, { text: 'PODSUMOWANIE', toolsUsed: [], durationMs: 40, usage: null, stoppedBy: 'backstop' });
                return { result: 'PODSUMOWANIE', toolsUsed: [], toolCallDetails: [], duration: 40, usage: null, stoppedBy: 'backstop' as const };
            },
        }),
    });

    const out = await tool.execute({ task: 'raport', timeout_ms: 10, _invocationDelegationDepth: 1 }, {}, plugin) as
        { success?: boolean; result?: string; stopped_by?: string };

    t.true(kroki.includes('timeout.grace'), `brak śladu odroczenia w rejestrze: ${kroki.join(', ')}`);
    t.true(out.success, 'grace-okno pozwoliło podsumowaniu dojechać');
    t.is(out.result, 'PODSUMOWANIE');
    t.is(out.stopped_by, 'backstop');
    registry.dispose();
});

// ─── Ratowanie dorobku po strzale budzika zadania ───

test('_withTimeout z mapperem — ubity bieg oddaje dorobek jako partial_result', async t => {
    const mapper = __test__._makeSalvageMapper(12000);
    // Bieg „domyka się" 40 ms po strzale budzika (abort → pętla finalize → runner) z częściowym
    // wynikiem — dokładnie tak wraca _executeSubAgent po abort (success:true, stopped_by:'abort').
    const run = new Promise((resolve) => setTimeout(() => resolve({
        success: true,
        result: 'CZĘŚCIOWY DOROBEK BIEGU',
        aspect: 'pkm-explorer',
        stopped_by: 'abort',
        tools_used: ['search', 'read'],
        duration_ms: 55,
    }), 40));
    let killed = 0;
    const res = await __test__._withTimeout(run, 10, 10, () => { killed++; }, null, null, mapper) as Record<string, unknown>;
    t.is(killed, 1);
    t.false(res.success as boolean);
    t.true(String(res.error).includes('timeout after 10ms'));
    t.is(res.stopped_by, 'timeout');
    t.is(res.partial_result, 'CZĘŚCIOWY DOROBEK BIEGU');
    t.deepEqual(res.tools_used, ['search', 'read']);
    t.is(res.aspect, 'pkm-explorer');
});

test('mapper NIE przykrywa realnego błędu biegu (success:false zostaje bez zmian)', async t => {
    const mapper = __test__._makeSalvageMapper(12000);
    const run = new Promise((resolve) => setTimeout(() => resolve({
        success: false, error: 'runner init failed', stopped_by: 'error',
    }), 30));
    const res = await __test__._withTimeout(run, 10, 10, null, null, null, mapper) as Record<string, unknown>;
    t.false(res.success as boolean);
    t.is(res.error, 'runner init failed');
});

test('bieg bez tekstu — partial_result budowany z tool_call_details', async t => {
    const mapper = __test__._makeSalvageMapper(12000);
    const run = new Promise((resolve) => setTimeout(() => resolve({
        success: true,
        result: '',
        stopped_by: 'abort',
        tool_call_details: [
            { name: 'search', args: { query: 'x' }, resultPreview: 'PODGLĄD WYNIKU SEARCH' },
            { name: 'read', args: { path: 'a.md' }, resultPreview: 'PODGLĄD NOTATKI' },
        ],
    }), 30));
    const res = await __test__._withTimeout(run, 10, 10, null, null, null, mapper) as Record<string, unknown>;
    t.false(res.success as boolean);
    t.true(String(res.partial_result).includes('### search'));
    t.true(String(res.partial_result).includes('PODGLĄD WYNIKU SEARCH'));
    t.true(String(res.partial_result).includes('PODGLĄD NOTATKI'));
});

test('odrzucenie ubitego biegu PO strzale budzika nie wywraca delegacji', async t => {
    const mapper = __test__._makeSalvageMapper(12000);
    const run = new Promise((_, reject) => setTimeout(() => reject(new Error('abort zszedł wyjątkiem')), 30));
    const res = await __test__._withTimeout(run, 10, 10, null, null, null, mapper) as Record<string, unknown>;
    t.false(res.success as boolean);
    t.true(String(res.error).includes('timeout after 10ms'));
});

test('bez mappera: goła zwrotka od ręki, bez czekania', async t => {
    const start = Date.now();
    const run = new Promise((resolve) => setTimeout(() => resolve({ success: true, result: 'za późno' }), 200));
    const res = await __test__._withTimeout(run, 10, 10) as Record<string, unknown>;
    t.false(res.success as boolean);
    t.true(Date.now() - start < 150, 'goła zwrotka bez okna salvage');
});

test('_digestFromToolDetails — sufit znaków, pomijanie wpisów bez podglądu', t => {
    const digest = __test__._digestFromToolDetails([
        { name: 'search', args: '{"q":"x"}', resultPreview: 'A'.repeat(300) },
        { name: 'bez_podgladu' },
        { name: 'read', args: { path: 'n.md' }, resultPreview: 'B'.repeat(300) },
    ], 400);
    t.true(digest.length <= 401); // sufit + wielokropek
    t.true(digest.includes('### search'));
    t.false(digest.includes('bez_podgladu'));
});

// ─── Dziecko NIGDY szerzej niż sub, który je zleca ───────────
//
// Liczenie zakresu folderów WYŁĄCZNIE z configu odpalanego suba, a whitelisty narzędzi
// względem agenta GŁÓWNEGO, jest dziurą: wąski sub (`scope.folders: ['Publiczne']`, `tools:
// [read, delegate]`) na piętrze 1 mógłby wystawić wnukowi pełny vault i pełny zestaw
// narzędzi agenta. Znaczniki `_invocationScopeFolders` / `_invocationToolNames` wstrzykuje
// `MCPClient` (jak `_invocationDelegationDepth`), a te testy pilnują, że są PRZECINANE.

test('wnuk dziedziczy zakres wołającego suba, gdy własnego configu scope nie ma', async t => {
    const runs: RunRow[] = [];
    const { plugin, makeRunner } = pluginForGuards(runs, { limits: { max_delegation_depth: 2 } });
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute({
        task: 'przeczytaj wszystko',
        _invocationDelegationDepth: 1,
        _invocationScopeFolders: ['Publiczne'],
        timeout_ms: 200,
        background: false,
    }, {}, plugin as unknown as DelegatePlugin) as DelegateRes;

    t.true(res.success);
    t.deepEqual(runs[0].options.scopeFolders, ['Publiczne'], 'pusty scope dziecka NIE poszerza zakresu');
});

test('przecięcie zostawia węższy wpis dziecka', async t => {
    const runs: RunRow[] = [];
    const { plugin, makeRunner } = pluginForGuards(runs, {
        limits: { max_delegation_depth: 2 },
        scope: { folders: ['Publiczne/Drafty'] },
    });
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute({
        task: 'x',
        aspect: 'jaskier-prep',
        aspect_explicit: true,
        _invocationDelegationDepth: 1,
        _invocationScopeFolders: ['Publiczne'],
        timeout_ms: 200,
        background: false,
    }, {}, plugin as unknown as DelegatePlugin) as DelegateRes;

    t.true(res.success);
    t.deepEqual(runs[0].options.scopeFolders, ['Publiczne/Drafty']);
});

test('zakresy rozłączne = odmowa fail-closed, zero odpalonych subów', async t => {
    const runs: RunRow[] = [];
    const { plugin, makeRunner } = pluginForGuards(runs, {
        limits: { max_delegation_depth: 2 },
        scope: { folders: ['Sekrety'] },
    });
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute({
        task: 'x',
        aspect: 'jaskier-prep',
        aspect_explicit: true,
        _invocationDelegationDepth: 1,
        _invocationScopeFolders: ['Publiczne'],
        timeout_ms: 200,
        background: false,
    }, {}, plugin as unknown as DelegatePlugin) as DelegateRes;

    t.false(res.success);
    t.not(res.error, 'mcp.delegate.scope_disjoint', 'i18n rozwiązane, nie goły klucz');
    t.is(runs.length, 0);
});

test('aspect "worker" zlecony przez suba bierze JEGO whitelistę, nie agenta głównego', async t => {
    const runs: RunRow[] = [];
    const { plugin, makeRunner } = pluginForGuards(runs, {
        limits: { max_delegation_depth: 2 },
        agentTools: ['read', 'list', 'write', 'delete', 'kom_send', 'delegate'],
    });
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute({
        task: 'x',
        aspect: 'worker',
        aspect_explicit: true,
        _invocationDelegationDepth: 1,
        _invocationToolNames: ['read', 'delegate'],
        timeout_ms: 200,
        background: false,
    }, {}, plugin as unknown as DelegatePlugin) as DelegateRes;

    t.true(res.success);
    t.deepEqual(runs[0].config.tools, ['read', 'delegate'], 'worker prosi o tyle, ile ma sub zlecający');
    t.false(runs[0].config.tools.includes('write'));
    t.deepEqual(runs[0].options.callerToolNames, ['read', 'delegate'], 'runner dostaje trzeci składnik przecięcia');
});

test('bez znaczników (zlecenie z czatu) worker nadal bierze klasę agenta', async t => {
    const runs: RunRow[] = [];
    const { plugin, makeRunner } = pluginForGuards(runs, {
        agentTools: ['read', 'write', 'delegate'],
    });
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute({
        task: 'x', aspect: 'worker', aspect_explicit: true, timeout_ms: 200, background: false,
    }, {}, plugin as unknown as DelegatePlugin) as DelegateRes;

    t.true(res.success);
    t.deepEqual(runs[0].config.tools, ['read', 'write', 'delegate']);
    t.is(runs[0].options.callerToolNames, undefined);
    t.is(runs[0].options.scopeFolders, null, 'brak znaczników = zero nowych ograniczeń');
});

// ─── Multi-task w tle: odrzucone NIE są „w kolejce" ──────────
//
// Zadanie odbite od ręki (puste `task`, literówka w `aspect`) nigdy nie wchodzi do
// rejestru, więc powiadomienie o nim NIE przyjdzie. Licząc je jako `queued` zgubiłbyś
// komunikat odmowy (z listą dostępnych aspektów!) w porzuconej puli — dlatego wraca
// osobnym polem `rejected`.

test.serial('odrzucone zadania wracają jako `rejected`, nie jako `queued`', async t => {
    __test__._resetBackground();
    const log = nowyLog();
    const { plugin, makeRunner } = pluginZTlem(log, { opoznienieMs: 40 });
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute({
        tasks: [
            { task: 'zbierz X' },
            { task: '   ' },
            { task: 'zbierz Z', aspect: 'jaskier-prepp', aspect_explicit: true },
        ],
    }, {}, plugin) as TloRes;

    t.true(res.started, 'jedno zadanie realnie ruszyło');
    t.is(res.tasks?.length, 1, 'w rejestrze jest tylko to, co wystartowało');
    t.is(res.queued, undefined, 'nic nie czeka w kolejce - dwa zadania zostały ODRZUCONE');
    t.is(res.rejected?.length, 2, 'model widzi, które zadania nie ruszyły');
    t.true((res.rejected || []).every(r => typeof r.error === 'string' && r.error.length > 0),
        'każda odmowa niesie powód');
    t.true((res.rejected || []).some(r => (r.error || '').includes('jaskier-prepp')),
        'komunikat o nietrafionym aspekcie dociera do modelu (to z niego poprawia wywołanie)');
    t.true((res.note || '').includes('1'), 'nota mówi o 1 zleconym zadaniu, nie o trzech');
});

test.serial('same odmowy = success:false (nic nie ruszyło)', async t => {
    __test__._resetBackground();
    const log = nowyLog();
    const { plugin, makeRunner } = pluginZTlem(log);
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute({
        tasks: [{ task: '  ' }, { task: 'zbierz Z', aspect: 'nie-ma-takiego', aspect_explicit: true }],
    }, {}, plugin) as TloRes;

    t.false(res.success, 'zero zleconych zadań to nie jest sukces');
    t.falsy(res.started);
    t.is(res.rejected?.length, 2);
    t.deepEqual(log.prompts, [], 'żaden sub nie ruszył');
});

test.serial('paczka bez odmów zachowuje się jak dotąd (brak pola `rejected`)', async t => {
    __test__._resetBackground();
    const log = nowyLog();
    const { plugin, makeRunner } = pluginZTlem(log, { opoznienieMs: 40 });
    const tool = createDelegateTool({}, { makeRunner });

    const res = await tool.execute({ tasks: [{ task: 'a' }, { task: 'b' }] }, {}, plugin) as TloRes;

    t.true(res.started);
    t.is(res.tasks?.length, 2);
    t.is(res.rejected, undefined, 'czysta paczka nie dostaje pustej listy odmów');
    t.is(res.queued, undefined);

    await new Promise(r => setTimeout(r, 120));
});

// ─── Zewnętrzny catch `delegate` maskuje sekret ───
//
// `SubAgentRunner.runTask` maskuje tę samą klasę wycieku, ale TYLKO u siebie. Bez osobnej
// maski tutaj własny, zewnętrzny catch `DelegateTool` oddawałby `(e as Error).message`
// wprost modelowi i do transkryptu — a komunikat wyjątku bywa całym zrzutem zdarzenia
// strumienia razem z nagłówkiem `Authorization`.

test('catch w delegate nie oddaje modelowi surowego komunikatu z sekretem', async t => {
    const SECRET = 'sk-ant-TAJNYKLUCZ0123456789abcdef';
    const plugin = {
        agentManager: {
            getActiveAgent: () => {
                throw new Error(`stream event failed: {"Authorization":"Bearer ${SECRET}"}`);
            },
        },
    } as unknown as DelegatePlugin;
    const tool = createDelegateTool({}, {
        makeRunner: () => ({ runTask: () => new Promise(() => {}) }),
    });

    const res = await tool.execute({ task: 'cokolwiek' }, {}, plugin) as DelegateRes;

    t.false(res.success);
    t.false(String(res.error).includes(SECRET), `klucz jawny w zwrotce: ${res.error}`);
});
