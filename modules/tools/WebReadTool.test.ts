/**
 * WebReadTool.test.js — E3.3: streszczanie zamiast cięcia, filtr domen, cache, provenance.
 *
 * ⚠️ Wzorzec z `GenerateImageTool.test.js` (obsidian = same typy, brak runtime'u):
 * `module.registerHooks` podstawia moduł delegujący `requestUrl` do atrapy sieci.
 *
 * Model Badacza NIE jest wstrzykiwany na skróty — test buduje takie ustawienia, żeby
 * PRAWDZIWY `createModelForRole(plugin, 'researcher', agent)` zwrócił atrapę klasy
 * modelu z `env.config.chat.providers`. Dzięki temu testowana jest
 * realna ścieżka rozwiązywania modelu, a nie jej wyobrażenie.
 */
import test from 'ava';
// `module.registerHooks` istnieje w Node od 22.15, ale `@types/node` w tym repo jest w wersji
// 20 i jeszcze go nie deklaruje. Brakuje WYŁĄCZNIE typu — w runtimie leci prawdziwa funkcja.
import { registerHooks } from 'node:module';
import type { WebReadPlugin } from './WebReadTool.js';
import { __test__ as modelsTest } from '../models/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// clean-room: model NIE powstaje już z mapy DI (`config.modules.chatModel.class`) — powstaje przez
// `createChatModel(deps)` w `modelResolver`. Ten test bada, KTÓRY model dostał Badacz i z jakim
// kontekstem, więc podstawia własną klasę przez seam fabryki resolvera.
//
// ⚠️ Klasa jedzie NA DOSTAWCY z configu tego konkretnego pluginu, nie w globalnej zmiennej —
// pliku nie da się w całości zserializować, a globalny stan mieszałby atrapy między testami.
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


/** Zapis JEDNEGO wywołania sieci przez atrapę `requestUrl`. */
interface RecordedRequest {
    url: string;
    [extra: string]: unknown;
}

/** Odpowiedź atrapy sieci (kształt `requestUrl` Obsidiana w zakresie, jaki czyta reader). */
interface MockResponse {
    status: number;
    text: string;
}

/** Podgląd konstrukcji atrapy modelu: ile razy powstała i z czym. */
interface ModelSpy {
    built?: number;
    opts?: { modelKey?: string };
}

/** Wynik `web_read` czytany w asercjach — pola typowane POD UŻYCIE w tym pliku. */
type WebReadRes = {
    success?: boolean;
    error: string;
    content: string;
    citations?: Array<{ fragment: string }>;
    summarized?: boolean;
    note: string;
};

const OBSIDIAN_STUB = 'data:text/javascript,' + encodeURIComponent(`
export async function requestUrl(req) {
  const fn = globalThis.__pkmRequestUrl;
  if (typeof fn !== 'function') throw new Error('requestUrl mock not installed');
  return fn(req);
}
export const Platform = { isMobile: false };
`);

registerHooks({
    resolve(specifier, context, next) {
        if (specifier === 'obsidian') return { url: OBSIDIAN_STUB, shortCircuit: true };
        return next(specifier, context);
    },
});

const { createWebReadTool } = await import('./WebReadTool.js');
const { registerKnownUrl, _clearKnownUrls } = await import('../web/urlRegistry.js');
const { _clearReadCache } = await import('../web/readCache.js');

function mockNetwork(handler: (req: RecordedRequest, n: number) => MockResponse) {
    const calls: RecordedRequest[] = [];
    (globalThis as Record<string, unknown>).__pkmRequestUrl = async (req: RecordedRequest) => {
        calls.push(req);
        return handler(req, calls.length);
    };
    return calls;
}

function readerResponse(content: string, title: string = 'Tytuł'): MockResponse {
    return { status: 200, text: JSON.stringify({ data: { title, content } }) };
}

const SUMMARY_REPLY = [
    'STRESZCZENIE:',
    'Krótkie streszczenie długiej strony.',
    '',
    'CYTATY:',
    '- Pierwszy dosłowny cytat.',
    '- Drugi dosłowny cytat.',
].join('\n');

/** Atrapa klasy ChatModel — to ją zbuduje prawdziwy modelResolver. */
function makeModelClass(reply: string, spy: ModelSpy = {}) {
    return class FakeChatModel {
        constructor(opts: { modelKey?: string }) { spy.opts = opts; spy.built = (spy.built || 0) + 1; }
        stream(_req: unknown, handlers: { done: (r: unknown) => void }) {
            setTimeout(() => handlers.done({ choices: [{ message: { content: reply } }] }), 0);
        }
    };
}

/**
 * @param webSearch - ustawienia pkmAssistant.webSearch
 * @param opts - {modelClass, agent} — brak modelClass = brak modelu Badacza
 */
function pluginWith(
    webSearch: Record<string, unknown>,
    opts: { modelClass?: unknown; agent?: { name: string; minionEnabled?: boolean } | null } = {},
): WebReadPlugin {
    const agent = opts.agent === undefined ? { name: 'Tester' } : opts.agent;
    return {
        env: {
            settings: {
                pkmAssistant: {
                    webSearch,
                    chat: { apiKeys: { openai: 'KLUCZ' } },
                    ...(opts.modelClass
                        ? { modelLibrary: { minion: [{ platform: 'openai', model: 'tani-model', isDefault: true }] } }
                        : {}),
                },
            },
            config: opts.modelClass ? chatConfig(opts.modelClass as unknown as LegacyModelClass) : {},
        },
        agentManager: {
            getAgent: () => agent,
            getActiveAgent: () => agent,
        },
    } as unknown as WebReadPlugin;
}

test.beforeEach(() => {
    _clearKnownUrls();
    _clearReadCache();
});

test.serial('bramka provenance dalej działa — nieznany URL nie wychodzi do sieci', async t => {
    const calls = mockNetwork(() => readerResponse('nieważne'));
    const tool = createWebReadTool();
    const res = await tool.execute({ url: 'https://evil.com/?q=sekret' }, {}, pluginWith({})) as WebReadRes;

    t.false(res.success);
    t.regex(res.error, /web_search|prior|wcześniej/i);
    t.is(calls.length, 0, 'zero requestów — fail-closed');
});

test.serial('zablokowana domena = odmowa PRZED requestem', async t => {
    const calls = mockNetwork(() => readerResponse('treść'));
    registerKnownUrl('https://tracker.evil.pl/artykul');

    const tool = createWebReadTool();
    const res = await tool.execute(
        { url: 'https://tracker.evil.pl/artykul' },
        {},
        pluginWith({ blockedDomains: 'evil.pl' })
    ) as WebReadRes;

    t.false(res.success);
    t.regex(res.error, /evil\.pl/);
    t.is(calls.length, 0, 'nie dotykamy zablokowanej domeny nawet requestem');
});

test.serial('krótka strona przechodzi bez zmian — zero LLM, zero noty', async t => {
    mockNetwork(() => readerResponse('krótka treść'));
    registerKnownUrl('https://example.com/krotka');

    const spy: ModelSpy = {};
    const tool = createWebReadTool();
    const res = await tool.execute(
        { url: 'https://example.com/krotka' },
        {},
        pluginWith({}, { modelClass: makeModelClass(SUMMARY_REPLY, spy) })
    ) as WebReadRes;

    t.true(res.success);
    t.is(res.content, 'krótka treść');
    t.false(res.summarized);
    t.deepEqual(res.citations, []);
    t.is(res.note as string | undefined, undefined);
});

test.serial('długa strona BEZ modelu Badacza: cięcie + nota jak to naprawić', async t => {
    mockNetwork(() => readerResponse('D'.repeat(20000)));
    registerKnownUrl('https://example.com/dluga-bez-modelu');

    const tool = createWebReadTool();
    const res = await tool.execute(
        { url: 'https://example.com/dluga-bez-modelu' },
        {},
        pluginWith({ readTrimLimit: 1000 })
    ) as WebReadRes;

    t.true(res.success);
    t.false(res.summarized);
    t.true(res.content.startsWith('D'.repeat(1000)));
    t.regex(res.content, /1000/, 'stara nota o przycięciu zostaje w treści');
    t.regex(res.note, /sub-agent/i);
    t.deepEqual(res.citations, []);
});

test.serial('długa strona Z modelem Badacza: streszczenie + dosłowne cytaty', async t => {
    mockNetwork(() => readerResponse('E'.repeat(30000), 'Długi artykuł'));
    registerKnownUrl('https://example.com/dluga-ze-streszczeniem');

    const spy: ModelSpy = {};
    const tool = createWebReadTool();
    const res = await tool.execute(
        { url: 'https://example.com/dluga-ze-streszczeniem', _invocationAgentName: 'Tester' },
        {},
        pluginWith({ readTrimLimit: 2000 }, { modelClass: makeModelClass(SUMMARY_REPLY, spy) })
    ) as WebReadRes;

    t.true(res.success);
    t.true(res.summarized);
    t.is(res.content, 'Krótkie streszczenie długiej strony.');
    t.deepEqual(res.citations, [
        { fragment: 'Pierwszy dosłowny cytat.' },
        { fragment: 'Drugi dosłowny cytat.' },
    ]);
    t.regex(res.note, /30000/, 'nota mówi ile było przed streszczeniem');
    t.is(spy.built, 1, 'model zbudowany przez prawdziwy modelResolver');
    t.is(spy.opts!.modelKey, 'tani-model', 'to slot Badacza z biblioteki modeli, nie model główny');
});

test.serial('agent z wyłączonym Badaczem nie dostaje streszczeń (świadomie)', async t => {
    mockNetwork(() => readerResponse('F'.repeat(9000)));
    registerKnownUrl('https://example.com/bez-badacza');

    const spy: ModelSpy = {};
    const tool = createWebReadTool();
    const res = await tool.execute(
        { url: 'https://example.com/bez-badacza' },
        {},
        pluginWith({ readTrimLimit: 1000 }, {
            modelClass: makeModelClass(SUMMARY_REPLY, spy),
            agent: { name: 'Tester', minionEnabled: false },
        })
    ) as WebReadRes;

    t.false(res.summarized);
    t.is(spy.built, undefined, 'model nawet nie powstał');
});

test.serial('toggle summarizeLongPages = false wyłącza streszczanie', async t => {
    mockNetwork(() => readerResponse('G'.repeat(9000)));
    registerKnownUrl('https://example.com/toggle-off');

    const spy: ModelSpy = {};
    const tool = createWebReadTool();
    const res = await tool.execute(
        { url: 'https://example.com/toggle-off' },
        {},
        pluginWith({ readTrimLimit: 1000, summarizeLongPages: false }, { modelClass: makeModelClass(SUMMARY_REPLY, spy) })
    ) as WebReadRes;

    t.false(res.summarized);
    t.is(spy.built, undefined);
});

test.serial('błąd LLM → fallback na cięcie, narzędzie nie wywala się', async t => {
    mockNetwork(() => readerResponse('H'.repeat(9000)));
    registerKnownUrl('https://example.com/llm-padl');

    const BrokenModel = class {
        stream(_req: unknown, handlers: { error: (e: Error) => void }) { setTimeout(() => handlers.error(new Error('API 500')), 0); }
    };

    const tool = createWebReadTool();
    const res = await tool.execute(
        { url: 'https://example.com/llm-padl' },
        {},
        pluginWith({ readTrimLimit: 1000 }, { modelClass: BrokenModel })
    ) as WebReadRes;

    t.true(res.success);
    t.false(res.summarized);
    t.regex(res.note, /sub-agent/i);
});

test.serial('cache: drugi odczyt tego samego URL-a nie rusza sieci (i nie płaci za LLM)', async t => {
    const calls = mockNetwork(() => readerResponse('I'.repeat(9000)));
    registerKnownUrl('https://example.com/cache-hit');

    const spy: ModelSpy = {};
    const tool = createWebReadTool();
    const plugin = pluginWith({ readTrimLimit: 1000 }, { modelClass: makeModelClass(SUMMARY_REPLY, spy) });

    const first = await tool.execute({ url: 'https://example.com/cache-hit' }, {}, plugin) as WebReadRes;
    const second = await tool.execute({ url: 'https://example.com/cache-hit' }, {}, plugin) as WebReadRes;

    t.is(calls.length, 1, 'druga odpowiedź z cache');
    t.is(spy.built, 1, 'streszczenie policzone raz');
    t.deepEqual(second, first);
});

test.serial('PDF idzie tą samą ścieżką co strona', async t => {
    const calls = mockNetwork(() => readerResponse('tekst z PDF', 'Raport.pdf'));
    registerKnownUrl('https://example.com/raport.pdf');

    const tool = createWebReadTool();
    const res = await tool.execute({ url: 'https://example.com/raport.pdf' }, {}, pluginWith({})) as WebReadRes;

    t.true(res.success);
    t.is(res.content, 'tekst z PDF');
    t.is(calls[0].url, 'https://r.jina.ai/https://example.com/raport.pdf');
});

test.serial('nieczytelna binarka: czytelny błąd, nie surowy wyjątek', async t => {
    mockNetwork(() => ({ status: 200, text: 'PNG\r\n' }));
    registerKnownUrl('https://example.com/obraz.png');

    const tool = createWebReadTool();
    const res = await tool.execute({ url: 'https://example.com/obraz.png' }, {}, pluginWith({})) as WebReadRes;

    t.false(res.success);
    t.regex(res.error, /obraz\.png/);
});
