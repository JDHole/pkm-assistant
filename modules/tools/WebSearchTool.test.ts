/**
 * WebSearchTool.test.js — E3.3: nowy kształt wyniku, filtr domen, licznik, warstwy.
 *
 * ⚠️ Wzorzec z `GenerateImageTool.test.js`: `obsidian` z npm to same typy (bez runtime'u),
 * więc przez `module.registerHooks` podstawiamy moduł delegujący `requestUrl` do atrapy.
 * Kod narzędzia i providera wykonuje się PRAWDZIWY — podmieniona jest wyłącznie sieć.
 */
import test from 'ava';
// `module.registerHooks` istnieje w Node od 22.15, ale `@types/node` w tym repo jest w wersji
// 20 i jeszcze go nie deklaruje. Brakuje WYŁĄCZNIE typu — w runtimie leci prawdziwa funkcja.
import { registerHooks } from 'node:module';
import type { WebSearchPlugin, WebToolSettings } from './WebSearchTool.js';
import type { UsageState } from '../web/index.js';


/** Zapis JEDNEGO wywołania sieci przez atrapę `requestUrl`. */
interface RecordedRequest {
    url: string;
    [extra: string]: unknown;
}

/** Odpowiedź atrapy sieci (kształt `requestUrl` Obsidiana w zakresie, jaki czyta provider). */
interface MockResponse {
    status: number;
    text: string;
}

/** Surowe trafienie z Jiny — PEŁNA treść, której narzędzie nie ma prawa przepuścić. */
interface JinaItem {
    title: string;
    url: string;
    content: string;
}

/** Wynik `web_search` czytany w asercjach — pola typowane POD UŻYCIE w tym pliku. */
type WebSearchRes = {
    success?: boolean;
    provider?: string;
    fallback_from?: string;
    count?: number;
    results: Array<{ title: string; url: string; fragment: string }>;
    formatted: string;
};

/** Ustawienia w teście: slice `webSearch` + licznik, który narzędzie dopisuje. */
type TestWebSettings = WebToolSettings & { usage?: UsageState };

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

const { createWebSearchTool } = await import('./WebSearchTool.js');
const { isUrlKnown, _clearKnownUrls } = await import('../web/urlRegistry.js');

function mockNetwork(handler: (req: RecordedRequest, n: number) => MockResponse) {
    const calls: RecordedRequest[] = [];
    (globalThis as Record<string, unknown>).__pkmRequestUrl = async (req: RecordedRequest) => {
        calls.push(req);
        return handler(req, calls.length);
    };
    return calls;
}

/** Odpowiedź Jiny: pełne treści stron (to właśnie ich NIE wolno przepuścić do wyniku). */
function jinaResponse(items: JinaItem[]): MockResponse {
    return { status: 200, text: JSON.stringify({ data: items }) };
}

function pluginWith(webSearch: TestWebSettings, extra: { saved?: number } = {}): WebSearchPlugin {
    return {
        env: {
            settings: { pkmAssistant: { webSearch } },
            settingsStore: { save: () => { extra.saved = (extra.saved || 0) + 1; } },
        },
        ...extra,
    };
}

test.beforeEach(() => _clearKnownUrls());

test.serial('nowy kształt: results = {title, url, fragment}, ZERO pełnej treści w JSON', async t => {
    // Znacznik ZA domyślnym trimLimit (1500) — gdyby pełna treść przeciekała, byłby w JSON-ie.
    const long = 'A'.repeat(1600) + 'ZNACZNIK-PELNEJ-TRESCI' + 'B'.repeat(3000);
    mockNetwork(() => jinaResponse([
        { title: 'Strona', url: 'https://example.com/a', content: long },
    ]));

    const tool = createWebSearchTool();
    const res = await tool.execute({ query: 'ksztalt-wyniku-q1' }, {}, pluginWith({ provider: 'jina' })) as WebSearchRes;

    t.true(res.success);
    t.is(res.count, 1);
    t.deepEqual(Object.keys(res.results[0]).sort(), ['fragment', 'title', 'url']);
    t.is(res.results[0].fragment.length, 1500, 'fragment przycięty do trimLimit');
    t.false('content' in res.results[0]);
    t.notRegex(JSON.stringify(res), /ZNACZNIK-PELNEJ-TRESCI/, 'pełna treść nie wychodzi z narzędzia');
    t.regex(res.formatted, /\[1\] Strona/);
    t.regex(res.formatted, /https:\/\/example\.com\/a/);
});

test.serial('trimLimit z ustawień steruje długością fragmentu', async t => {
    mockNetwork(() => jinaResponse([{ title: 'S', url: 'https://example.com/b', content: 'C'.repeat(900) }]));
    const tool = createWebSearchTool();
    const res = await tool.execute(
        { query: 'trimlimit-q2' },
        {},
        pluginWith({ provider: 'jina', trimLimit: 200 })
    ) as WebSearchRes;
    t.is(res.results[0].fragment.length, 200);
});

test.serial('filtr domen odsiewa wyniki i NIE rejestruje ich jako znanych URL-i', async t => {
    mockNetwork(() => jinaResponse([
        { title: 'Dobra', url: 'https://dobra.pl/1', content: 'ok' },
        { title: 'Zła', url: 'https://sub.evil.pl/x', content: 'nope' },
    ]));

    const tool = createWebSearchTool();
    const res = await tool.execute(
        { query: 'filtr-domen-q3' },
        {},
        pluginWith({ provider: 'jina', blockedDomains: 'evil.pl' })
    ) as WebSearchRes;

    t.is(res.count, 1, 'count liczony PO filtrze');
    t.is(res.results[0].url, 'https://dobra.pl/1');
    t.true(isUrlKnown('https://dobra.pl/1'));
    t.false(isUrlKnown('https://sub.evil.pl/x'), 'zablokowany URL nie odblokowuje się dla web_read');
    t.notRegex(res.formatted, /evil\.pl/);
});

test.serial('formatted niesie notę o zejściu na darmową podłogę', async t => {
    mockNetwork((req: RecordedRequest) => {
        if (req.url.includes('tavily')) throw new Error('tavily padł');
        return jinaResponse([{ title: 'Z podłogi', url: 'https://example.com/c', content: 'treść' }]);
    });

    const tool = createWebSearchTool();
    const res = await tool.execute(
        { query: 'fallback-nota-q4' },
        {},
        pluginWith({ provider: 'tavily', apiKeys: { tavily: 'K' } })
    ) as WebSearchRes;

    t.is(res.provider, 'jina');
    t.is(res.fallback_from, 'tavily');
    t.regex(res.formatted, /tavily/);
    t.regex(res.formatted, /jina/);
    t.regex(res.formatted.split('\n')[0], /tavily/, 'nota jest na górze, przed wynikami');
});

test.serial('licznik podbija się po sukcesie i prosi o zapis ustawień', async t => {
    mockNetwork(() => ({
        status: 200,
        text: JSON.stringify({ results: [{ title: 'T', url: 'https://example.com/d', content: 'x' }] }),
    }));

    const ws: TestWebSettings = { provider: 'tavily', apiKeys: { tavily: 'K' } };
    const extra: { saved?: number } = {};
    const tool = createWebSearchTool();
    await tool.execute({ query: 'licznik-q5' }, {}, pluginWith(ws, extra));

    t.is(ws.usage!.day.tavily, 1);
    t.is(ws.usage!.monthTotals.tavily, 1);
    t.is(extra.saved, 1, 'zapis ustawień poproszony jawnie');
});

test.serial('cache dostawcy nie podbija licznika drugi raz (u dostawcy nic się nie zużyło)', async t => {
    const calls = mockNetwork(() => ({
        status: 200,
        text: JSON.stringify({ results: [{ title: 'T', url: 'https://example.com/e', content: 'x' }] }),
    }));

    const ws: TestWebSettings = { provider: 'tavily', apiKeys: { tavily: 'K' } };
    const tool = createWebSearchTool();
    await tool.execute({ query: 'cache-licznik-q6' }, {}, pluginWith(ws));
    await tool.execute({ query: 'cache-licznik-q6' }, {}, pluginWith(ws));

    t.is(calls.length, 1, 'drugie zapytanie poszło z cache');
    t.is(ws.usage!.day.tavily, 1);
});

test.serial('jina nie jest liczona — darmowa podłoga nie ma progu do pokazania', async t => {
    mockNetwork(() => jinaResponse([{ title: 'S', url: 'https://example.com/f', content: 'x' }]));
    const ws: TestWebSettings = { provider: 'jina' };
    const tool = createWebSearchTool();
    await tool.execute({ query: 'jina-bez-licznika-q7' }, {}, pluginWith(ws));
    t.is(ws.usage, undefined);
});

test.serial('wyłączony Web Search i puste query odbijają się jak dotąd', async t => {
    const calls = mockNetwork(() => jinaResponse([]));
    const tool = createWebSearchTool();

    const off = await tool.execute({ query: 'x' }, {}, pluginWith({ enabled: false })) as WebSearchRes;
    t.false(off.success);

    const empty = await tool.execute({ query: '' }, {}, pluginWith({ provider: 'jina' })) as WebSearchRes;
    t.false(empty.success);
    t.is(calls.length, 0);
});
