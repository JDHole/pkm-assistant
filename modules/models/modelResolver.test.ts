import test from 'ava';
import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { __test__ as resolverTest, clearModelCache, createModelForRole, getModelsForRole } from './modelResolver.js';
import { CHAT_PROVIDERS } from './registry.js';
import { CapturingHttpClient, ScriptedTransport } from './testing/harness.js';
import type { ChatModel, ChatModelDeps, ChatProvider, ModelLibraryEntry, ProviderId, ResolverPluginLike } from './contracts.js';

/**
 * Kształt, w jakim atrapa modelu wystawia to, co dostała z fabryki —
 * dostawca i model siedzą w `deps`.
 */
type ResolvedModelProbe = { providerId: string; modelId: string } | null;

// Rola 'strategist' i slot modelLibrary.master skasowane — żaden produkcyjny wołacz nie pytał
// o tę rolę, slot był tylko do zapisu (migracja main.ts pisała, nic nie czytało). Test pilnuje dwóch rzeczy:
// mapowanie researcher→minion nadal żyje, a stary klucz `master`, który może wciąż leżeć
// w cudzym settings.json, jest po prostu ignorowany (nie wywala resolvera, nie wycieka).
test('getModelsForRole maps researcher to legacy minion slot; stray master key is ignored', t => {
    const settings = {
        modelLibrary: {
            minion: [{ platform: 'ollama', model: 'research' }],
            master: [{ platform: 'anthropic', model: 'strategy' }],
        },
    };

    t.deepEqual(getModelsForRole(settings, 'researcher'), settings.modelLibrary.minion);
});

test('createModelForRole: stary klucz masterPlatform/masterModel w ustawieniach nie wywala resolvera', t => {
    const plugin = makePlugin({
        modelLibrary: {
            main: [{ platform: 'openai', model: 'gpt-4o', isDefault: true }],
        },
    });
    // Symulacja starych kluczy, które mogą wciąż leżeć w cudzym settings.json — resolver ma
    // je po prostu zignorować, nie wywalić się.
    (plugin!.env!.settings!.pkmAssistant as Record<string, unknown>).masterPlatform = 'anthropic';
    (plugin!.env!.settings!.pkmAssistant as Record<string, unknown>).masterModel = 'claude-3-opus';

    const model = createModelForRole(plugin, 'main') as unknown as ResolvedModelProbe;

    t.truthy(model);
    t.is(model!.providerId, 'openai');
    t.is(model!.modelId, 'gpt-4o', 'stary masterModel nie ma wpływu na rolę main');
});

/**
 * Atrapa modelu wstrzykiwana przez seam `__test__.setChatModelFactory` — testy badają
 * DRABINKĘ (która platforma, który model, ile instancji), nie zachowanie modelu.
 */
class FakeChatModel {
    providerId: string;
    modelId: string;
    constructor(deps: ChatModelDeps) {
        this.providerId = deps.provider.info.id;
        this.modelId = deps.ctx.modelId;
    }
    async stream() { /* atrapa */ }
}

/** Dostawca-atrapa: rejestr musi mieć komplet kluczy, żeby `resolveProvider` miał co oddać. */
function fakeProvider(id: string): ChatProvider {
    return { info: { id } } as ChatProvider;
}

/**
 * Rejestr dostawców-atrap dla testowego `env.config.chat`.
 *
 * Klucze wypisane WPROST, nie wzięte z `CHAT_PROVIDERS` — te testy badają DRABINKĘ resolvera
 * (logikę własną), więc nie mogą być zakładnikami tego, czy rejestr dostawców jest już
 * zaimplementowany.
 */
const PROVIDER_IDS: ProviderId[] = [
    'openai', 'anthropic', 'gemini', 'ollama', 'deepseek', 'groq', 'lm_studio', 'open_router', 'xai',
];
const fakeProviders = Object.fromEntries(
    PROVIDER_IDS.map(id => [id, fakeProvider(id)]),
) as typeof CHAT_PROVIDERS;

/** Slice czatu w NOWYM kształcie: platforma + mapy `apiKeys`/`models`/`hosts`. */
type ChatOverrides = { platform?: string; apiKeys?: Record<string, string>; models?: Record<string, string> };

function makePlugin({ modelLibrary = {}, chat = {} }: { modelLibrary?: Record<string, ModelLibraryEntry[]>; chat?: ChatOverrides } = {}): ResolverPluginLike {
    return {
        env: {
            settings: {
                pkmAssistant: {
                    chat: {
                        ...chat,
                        apiKeys: {
                            xai: 'xai-key',
                            openai: 'openai-key',
                            gemini: 'gemini-key',
                            ...(chat.apiKeys ?? {}),
                        },
                    },
                    modelLibrary,
                },
            },
            config: {
                chat: {
                    providers: fakeProviders,
                    http: new CapturingHttpClient(),
                    transport: new ScriptedTransport(),
                },
            },
        },
    };
}

// ⚠️ Testy podstawiające WŁASNĄ, liczącą fabrykę są `test.serial` — seam
// `__test__.setChatModelFactory` jest jeden na proces, a `beforeEach` sąsiada przestawiłby go
// w połowie biegu (AVA odpala testy w pliku równolegle).
test.beforeEach(() => {
    clearModelCache();
    resolverTest.setChatModelFactory((deps: ChatModelDeps) => new FakeChatModel(deps) as unknown as ChatModel);
});
test.afterEach.always(() => {
    resolverTest.reset();
});

// Top-level agent.model NIE hijackuje ról sub-agentowych — slot subów w bibliotece modeli
// musi wygrywać, inaczej każdy agent z własnym modelem głównym mieli suby na modelu głównym.
test('createModelForRole prefers library sub slot over top-level agent.model for researcher', t => {
    const plugin = makePlugin({
        modelLibrary: {
            minion: [{ platform: 'gemini', model: 'gemini-flash-lite', isDefault: true }],
        },
    });
    const agent = {
        name: 'Jaskier',
        model: 'xai/grok-code-fast-1',
    };

    const model = createModelForRole(plugin, 'researcher', agent) as unknown as ResolvedModelProbe;

    t.truthy(model);
    t.is(model!.providerId, 'gemini');
    t.is(model!.modelId, 'gemini-flash-lite');
});

test('createModelForRole falls back to top-level agent.model for researcher when nothing sub-specific is configured', t => {
    const plugin = makePlugin();
    const agent = {
        name: 'Jaskier',
        model: 'xai/grok-code-fast-1',
    };

    const model = createModelForRole(plugin, 'researcher', agent) as unknown as ResolvedModelProbe;

    t.truthy(model);
    t.is(model!.providerId, 'xai');
    t.is(model!.modelId, 'grok-code-fast-1');
});

// ─── Po migracji legacy `model`→`models.main` w `modules/agents/profile/modelFieldSync.ts`,
// agent bez wpisu roli w bibliotece i bez legacy `pkm.minionModel` musi dalej dostawać model
// dla ról SUB (researcher/strategist) — Step 4b musi znać `agent.models.main`, nie tylko
// `agent.model`. Bez tego DelegateTool/WebReadTool/chat_model.ts dostają `null` dla każdego
// zmigrowanego agenta. ───────────────────────────

test('createModelForRole spada na agent.models.main dla roli sub, gdy nic innego nie jest skonfigurowane (agent PO migracji, bez legacy model)', t => {
    const plugin = makePlugin();
    const agent = {
        name: 'Tola',
        models: {
            main: 'openai/gpt-4o',
        },
    };

    const model = createModelForRole(plugin, 'researcher', agent) as unknown as ResolvedModelProbe;

    t.truthy(model, 'agent z models.main (bez legacy model, bez wpisu w bibliotece, bez minionModel) MUSI dostać model dla roli sub — inaczej DelegateTool/WebReadTool/chat_model.ts dostają null');
    t.is(model!.providerId, 'openai');
    t.is(model!.modelId, 'gpt-4o');
});

test('legacy agent.model nadal działa jako ostatnia deska ratunku dla ról sub', t => {
    const plugin = makePlugin();
    const agent = {
        name: 'Jaskier',
        model: 'xai/grok-code-fast-1',
    };

    const model = createModelForRole(plugin, 'researcher', agent) as unknown as ResolvedModelProbe;

    t.truthy(model);
    t.is(model!.providerId, 'xai');
    t.is(model!.modelId, 'grok-code-fast-1');
});

test('createModelForRole prefers per-role agent.models over top-level agent.model', t => {
    const plugin = makePlugin();
    const agent = {
        name: 'Jaskier',
        model: 'xai/grok-code-fast-1',
        models: {
            researcher: 'openai/gpt-4.1-mini',
        },
    };

    const model = createModelForRole(plugin, 'researcher', agent) as unknown as ResolvedModelProbe;

    t.truthy(model);
    t.is(model!.providerId, 'openai');
    t.is(model!.modelId, 'gpt-4.1-mini');
});

test('createModelForRole uses global role default when no agent override exists', t => {
    const plugin = makePlugin({
        modelLibrary: {
            minion: [{ platform: 'gemini', model: 'gemini-2.5-flash-lite', isDefault: true }],
        },
    });

    const model = createModelForRole(plugin, 'researcher') as unknown as ResolvedModelProbe;

    t.truthy(model);
    t.is(model!.providerId, 'gemini');
    t.is(model!.modelId, 'gemini-2.5-flash-lite');
});

// ─── Rola `sub_worker` (model policy v2) = model RODZICA + świeża instancja ───

test('sub_worker bierze model GŁÓWNY agenta, a nie slot sub-agentów', t => {
    const plugin = makePlugin({
        modelLibrary: {
            main: [{ platform: 'openai', model: 'gpt-duzy', isDefault: true }],
            minion: [{ platform: 'gemini', model: 'gemini-flash-lite', isDefault: true }],
        },
    });

    const worker = createModelForRole(plugin, 'sub_worker') as unknown as ResolvedModelProbe;
    const explorer = createModelForRole(plugin, 'researcher') as unknown as ResolvedModelProbe;

    t.is(worker!.modelId, 'gpt-duzy', 'worker jedzie modelem maina');
    t.is(explorer!.modelId, 'gemini-flash-lite', 'explorer nadal slotem sub-agentów');
});

test('sub_worker respektuje agent.model (ta sama drabinka co main)', t => {
    const plugin = makePlugin({
        modelLibrary: {
            main: [{ platform: 'openai', model: 'gpt-globalny', isDefault: true }],
            minion: [{ platform: 'gemini', model: 'gemini-flash-lite', isDefault: true }],
        },
    });
    const agent = { name: 'Jaskier', model: 'xai/grok-code-fast-1' };

    const worker = createModelForRole(plugin, 'sub_worker', agent) as unknown as ResolvedModelProbe;
    const main = createModelForRole(plugin, 'main', agent) as unknown as ResolvedModelProbe;

    t.is(worker!.providerId, 'xai');
    t.is(worker!.modelId, 'grok-code-fast-1');
    t.is(worker!.modelId, main!.modelId, 'worker = dokładnie model rodzica');
});

test('config.model suba wygrywa nad drabinką rodzica dla sub_worker', t => {
    const plugin = makePlugin({
        modelLibrary: { main: [{ platform: 'openai', model: 'gpt-duzy', isDefault: true }] },
    });
    const agent = { name: 'Jaskier', model: 'xai/grok-code-fast-1' };

    const model = createModelForRole(
        plugin, 'sub_worker', agent, { model: 'gemini/gemini-2.5-pro' },
    ) as unknown as ResolvedModelProbe;

    t.is(model!.providerId, 'gemini');
    t.is(model!.modelId, 'gemini-2.5-pro');
});

test.serial('sub_worker NIGDY nie oddaje instancji z cache (concurrent safety)', t => {
    const plugin = makePlugin({
        modelLibrary: { main: [{ platform: 'openai', model: 'gpt-duzy', isDefault: true }] },
    });
    const agent = { name: 'Jaskier' };

    const main1 = createModelForRole(plugin, 'main', agent);
    const main2 = createModelForRole(plugin, 'main', agent);
    const worker1 = createModelForRole(plugin, 'sub_worker', agent);
    const worker2 = createModelForRole(plugin, 'sub_worker', agent);

    t.is(main1, main2, 'warunek wstępny: main nadal jest cache\'owany');
    t.not(worker1, worker2, 'każdy worker dostaje świeżą instancję');
    t.not(worker1, main1, 'worker nie współdzieli instancji z czatem');
});

// `createModelForRole(plugin, 'main', agent, delegateConfig, callerSkipCache)` musi wymusić
// świeżą instancję TEŻ dla roli main, gdy wołacz jawnie o to prosi — nie tylko dla ról sub (te
// i tak zawsze skipują, patrz test sub_worker wyżej). Bez piątego argumentu `chat_model.ts`
// wołał resolver bez flagi, więc dwie tury roli main (dwa taby tego samego agenta, tura +
// konsolidacja pamięci w tle) zawsze trafiały w tę samą instancję z `_cache`, mimo że
// `skipCache: true` doszło do `get_chat_model`.
test.serial('createModelForRole(callerSkipCache=true) tworzy nową instancję dla roli main zamiast oddawać z cache', t => {
    let factoryCalls = 0;
    resolverTest.setChatModelFactory((deps: ChatModelDeps) => {
        factoryCalls += 1;
        return new FakeChatModel(deps) as unknown as ChatModel;
    });
    const plugin: ResolverPluginLike = {
        env: {
            settings: {
                pkmAssistant: {
                    chat: { apiKeys: { openai: 'openai-key' } },
                    modelLibrary: { main: [{ platform: 'openai', model: 'gpt-4o', isDefault: true }] },
                },
            },
            config: {
                chat: {
                    providers: fakeProviders,
                    http: new CapturingHttpClient(),
                    transport: new ScriptedTransport(),
                },
            },
        },
    };
    const agent = { name: 'Tola', model: 'openai/gpt-4o' };

    const withoutSkip1 = createModelForRole(plugin, 'main', agent);
    const withoutSkip2 = createModelForRole(plugin, 'main', agent);
    t.is(factoryCalls, 1, 'bez skipCache: druga tura dostaje z cache — fabryka woła się raz');
    t.is(withoutSkip1, withoutSkip2, 'warunek wstępny: main nadal jest cache\'owany bez flagi');

    const withSkip = createModelForRole(plugin, 'main', agent, null, true);
    t.is(factoryCalls, 2, 'z callerSkipCache=true: fabryka woła się DRUGI raz — świeża instancja');
    t.not(withSkip, withoutSkip1, 'świeża instancja to NIE ta sama referencja co z cache');

    // callerSkipCache=true nie WYWALA istniejącego wpisu z cache — kolejne wołanie bez flagi
    // nadal dostaje pierwotną, nie tę świeżo utworzoną.
    const backToCache = createModelForRole(plugin, 'main', agent);
    t.is(backToCache, withoutSkip1, 'callerSkipCache nie nadpisuje cache — kolejny bez-flagowy wołacz dostaje starą instancję');
    t.is(factoryCalls, 2, 'trzecie wołanie bez flagi nie tworzy nowej instancji — nadal z cache');
});

// Step 4 (legacy fallback, pre-modelLibrary settings) resolwuje platformę cicho do null, gdy
// `DEFAULT_MODELS[platform]` nie ma wpisu — tylko dlatego, że nikt nie wybrał modelu jawnie.
// Pozostałe platformy dostają sensowny default. `google`/`azure`/`custom` skreślone z
// DEFAULT_MODELS razem z martwymi adapterami/kluczem dispatchu — `xai` zostaje jedynym
// świadkiem tej naprawy.
test('createModelForRole main: legacy fallback (Step 4) ma default dla xai', t => {
    const expected: Record<string, string> = {
        xai: 'grok-3-mini-beta',
    };

    for (const [platform, expectedModel] of Object.entries(expected)) {
        const plugin = makePlugin({
            chat: { platform, apiKeys: { [platform]: 'k' } },
        });

        const model = createModelForRole(plugin, 'main') as unknown as ResolvedModelProbe;

        t.truthy(model, `platforma "${platform}" powinna dostać model z DEFAULT_MODELS zamiast cichego null`);
        t.is(model!.providerId, platform);
        t.is(model!.modelId, expectedModel);
    }
});

// `google`/`azure`/`custom` skreślone z mapy DI i z DEFAULT_MODELS. Stary `data.json` usera
// może wciąż nieść jedną z tych wartości pod `chatModel.platform` (nikt nie migruje ustawień
// wstecz — świadoma decyzja). Resolucja ma fail-safe wrócić
// `null` (żaden model bez sensownego defaultu), NIE rzucić — to samo zachowanie co dla
// każdej innej nieznanej nazwy platformy.
test('createModelForRole main: stara wartość platform=google/azure/custom nie wywala resolvera — cichy null, nie throw', t => {
    for (const platform of ['google', 'azure', 'custom']) {
        const plugin = makePlugin({
            chat: { platform, apiKeys: { [platform]: 'k' } },
        });

        t.notThrows(() => {
            const model = createModelForRole(plugin, 'main');
            t.is(model, null, `platforma "${platform}" nie ma już DEFAULT_MODELS ani modelu jawnie wybranego — resolucja ma cicho zwrócić null`);
        });
    }
});

test('regresja: no new direct minion/master model role references', async t => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const roots = ['core', 'modules', 'src', 'config'].map(root => path.join(repoRoot, root));
    // Oba rozszerzenia: konwersja `.js` → `.ts` idzie plik po pliku, a ten strażnik
    // ma pilnować całego drzewa niezależnie od tego, gdzie doszła.
    const ignoredFiles = new Set([
        path.normalize(path.join(repoRoot, 'modules/models/modelResolver.js')),
        path.normalize(path.join(repoRoot, 'modules/models/modelResolver.ts')),
        path.normalize(path.join(repoRoot, 'modules/tools/DelegateTool.js')),
        path.normalize(path.join(repoRoot, 'modules/tools/DelegateTool.ts')),
    ]);
    const forbidden = [
        /createModelForRole\s*\([^)]*['"`](?:minion|master)['"`]/,
        /\bmodelRole\s*=\s*['"`](?:minion|master)['"`]/,
    ];
    const hits: string[] = [];

    async function walk(dir: string): Promise<void> {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }
            if (!entry.name.endsWith('.js') && !entry.name.endsWith('.ts')) continue;
            if (entry.name.endsWith('.test.js') || entry.name.endsWith('.test.ts')) continue;
            const normalized = path.normalize(fullPath);
            if (ignoredFiles.has(normalized)) continue;
            const content = await readFile(fullPath, 'utf8');
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                if (forbidden.some(pattern => pattern.test(lines[i]))) {
                    hits.push(`${path.relative(repoRoot, fullPath)}:${i + 1}: ${lines[i].trim()}`);
                }
            }
        }
    }

    for (const root of roots) {
        await walk(root);
    }

    t.deepEqual(hits, []);
});


// ────────────────────────────────────────────────────────────────────────────
// Wykrywanie platformy i zwrotka listy modeli
// ────────────────────────────────────────────────────────────────────────────

/**
 * Wykrycie platformy po kluczach idzie USTALONĄ kolejnością, a `ollama`/`lm_studio` przechodzą
 * BEZ klucza (platformy lokalne).
 */
test('_detectPlatform — kolejność, a ollama/lm_studio przechodzą bez klucza', t => {
    const both = makePlugin({ chat: { apiKeys: { openai: 'k-openai', groq: 'k-groq' } } });
    // `makePlugin` dokłada domyślne klucze — kasujemy je, żeby zostały dokładnie dwa z testu.
    both!.env!.settings!.pkmAssistant!.chat!.apiKeys = { openai: 'k-openai', groq: 'k-groq' };
    const detected = createModelForRole(both, 'main') as unknown as ResolvedModelProbe;
    t.is(detected!.providerId, 'openai', 'openai stoi w kolejności wykrywania przed groq');

    const empty = makePlugin();
    empty!.env!.settings!.pkmAssistant!.chat!.apiKeys = {};
    const local = createModelForRole(empty, 'main') as unknown as ResolvedModelProbe;
    t.is(local!.providerId, 'ollama', 'worek bez kluczy spada na pierwszą platformę lokalną');
});

/** Nadpisanie `"platforma/model"` rozcina się na PIERWSZYM ukośniku. */
test('"open_router/anthropic/claude-…" rozcina się na PIERWSZYM ukośniku', t => {
    const plugin = makePlugin({ chat: { apiKeys: { open_router: 'or-key' } } });
    const agent = { name: 'Jaskier', model: 'open_router/anthropic/claude-sonnet-4-20250514' };

    const model = createModelForRole(plugin, 'main', agent) as unknown as ResolvedModelProbe;

    t.is(model!.providerId, 'open_router', 'platforma to człon PRZED pierwszym ukośnikiem');
    t.is(model!.modelId, 'anthropic/claude-sonnet-4-20250514', 'reszta — razem z ukośnikami — to nazwa modelu');
});

/** `clearModelCache()` zmusza fabrykę do ponownego stworzenia instancji. */
test.serial('clearModelCache() zmusza fabrykę do ponownego stworzenia instancji', t => {
    let calls = 0;
    resolverTest.setChatModelFactory((deps: ChatModelDeps) => {
        calls += 1;
        return new FakeChatModel(deps) as unknown as ChatModel;
    });
    const plugin = makePlugin({ modelLibrary: { main: [{ platform: 'openai', model: 'gpt-4o', isDefault: true }] } });

    createModelForRole(plugin, 'main');
    createModelForRole(plugin, 'main');
    t.is(calls, 1, 'druga tura dostaje instancję z cache');

    clearModelCache();
    createModelForRole(plugin, 'main');
    t.is(calls, 2, 'po wyczyszczeniu cache fabryka woła się od nowa');
});

/** Cztery argumenty z UI — config delegata wygrywa nad slotem biblioteki. */
test('createModelForRole(plugin, \'researcher\', agent, delegateConfig) — cztery argumenty z UI', t => {
    const plugin = makePlugin({
        modelLibrary: { minion: [{ platform: 'gemini', model: 'gemini-flash-lite', isDefault: true }] },
    });
    const agent = { name: 'Jaskier' };

    const fromLibrary = createModelForRole(plugin, 'researcher', agent) as unknown as ResolvedModelProbe;
    t.is(fromLibrary!.modelId, 'gemini-flash-lite', 'warunek wstępny: bez configu jedzie slot biblioteki');

    const overridden = createModelForRole(plugin, 'researcher', agent, { model: 'gpt-4o' }) as unknown as ResolvedModelProbe;
    t.is(overridden!.modelId, 'gpt-4o', 'delegateConfig.model wygrywa nad slotem biblioteki dla roli sub');
});

/** `listModels()` oddaje TABLICĘ `ModelInfo[]`, nie mapę. */
test.serial('listModels() oddaje ModelInfo[], nie mapę', async t => {
    resolverTest.reset(); // prawdziwa fabryka — badamy powierzchnię modelu, nie drabinkę
    const plugin = makePlugin({ modelLibrary: { main: [{ platform: 'openai', model: 'gpt-4o', isDefault: true }] } });
    const model = createModelForRole(plugin, 'main');

    t.truthy(model, 'model musi powstać — inaczej test niczego nie sprawdza');
    const models = await model!.listModels();
    t.true(Array.isArray(models), 'zwrotka to TABLICA, nie Record');
    t.deepEqual(models, [], 'bez sieci: PUSTA tablica (nie `{}`)');
});
