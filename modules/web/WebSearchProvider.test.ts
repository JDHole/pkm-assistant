/**
 * WebSearchProvider.test.js — E3.3: keyless Jina, klucze per-provider, warstwy (fallback), reader.
 *
 * ⚠️ Jak w `modules/tools/GenerateImageTool.test.js`: pakiet `obsidian` z npm to SAME
 * TYPY (bez runtime'u), więc Node nie potrafi go zaimportować. Podstawiamy przez
 * `module.registerHooks` malutki moduł, który deleguje `requestUrl` do atrapy
 * ustawianej per test. Hook żyje tylko w tym procesie testowym (AVA daje plikowi
 * własny worker). Kod providera jest wykonywany PRAWDZIWY.
 *
 * Cache wyszukiwania to singleton modułowy (5 min) — każdy test używa własnego,
 * unikalnego zapytania, żeby nie zjadać cudzych wyników.
 */
import test from 'ava';
import { registerHooks } from 'node:module';


/**
 * Zapis JEDNEGO wywołania sieci — pola dokładnie w takim zakresie, w jakim sięgają po nie
 * asercje. `headers` niesie `undefined`, bo część testów sprawdza właśnie BRAK nagłówka
 * `Authorization` (strzał bezkluczowy).
 */
interface RecordedRequest {
    url: string;
    method?: string;
    body?: string;
    headers: Record<string, string | undefined>;
}

/** Odpowiedź atrapy — kod providera czyta z niej wyłącznie `text`. */
interface MockResponse {
    status: number;
    text: string;
}

type MockHandler = (req: RecordedRequest, callIndex: number) => MockResponse;

declare global {
    // `var` (nie `let`) — tylko taka deklaracja ląduje na `globalThis`.
    var __pkmRequestUrl: ((req: RecordedRequest) => Promise<MockResponse>) | undefined;
}

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

const { executeWebSearch, readWebPage, resolveProviderKey, WEB_SEARCH_PROVIDERS } =
    await import('./WebSearchProvider.js');
// `t` to obiekt asercji AVA — funkcja tłumaczeń wchodzi tu jako `tr`.
const { t: tr } = await import('../../core/i18n/index.js');

/** Instaluje atrapę sieci; zwraca log requestów. */
function mockNetwork(handler: MockHandler): RecordedRequest[] {
    const calls: RecordedRequest[] = [];
    globalThis.__pkmRequestUrl = async (req) => {
        calls.push(req);
        return handler(req, calls.length);
    };
    return calls;
}

const jinaOk = (n = 1): MockResponse => ({
    status: 200,
    text: JSON.stringify({
        data: Array.from({ length: n }, (_, i) => ({
            title: `Jina ${i}`,
            url: `https://jina-result.pl/${i}`,
            content: 'treść z jiny',
        })),
    }),
});

const tavilyOk: MockResponse = {
    status: 200,
    text: JSON.stringify({ results: [{ title: 'Tavily', url: 'https://tavily-result.pl/1', content: 'treść' }] }),
};

test.serial('rejestr: Jina nie wymaga klucza, ma go za to jako opcjonalny (fix L13-12)', t => {
    t.false(WEB_SEARCH_PROVIDERS.jina.requiresKey);
    t.true(WEB_SEARCH_PROVIDERS.jina.keyOptional);
    t.true(WEB_SEARCH_PROVIDERS.tavily.requiresKey);
});

test.serial('keyless Jina przechodzi bramkę i realnie strzela (bez Authorization)', async t => {
    const calls = mockNetwork(() => jinaOk(2));
    const res = await executeWebSearch('keyless-jina-query', { provider: 'jina' }, 5);

    t.true(res.success);
    t.is(res.provider, 'jina');
    t.is(res.count, 2);
    t.is(calls.length, 1);
    t.regex(calls[0].url, /^https:\/\/s\.jina\.ai\//);
    t.is(calls[0].headers.Authorization, undefined, 'bez klucza nie wysyłamy nagłówka');
});

test.serial('klucz per-provider trafia do właściwego dostawcy', async t => {
    const calls = mockNetwork(() => tavilyOk);
    await executeWebSearch(
        'klucz-per-provider-query',
        { provider: 'tavily', apiKeys: { tavily: 'TAV-KEY', jina: 'JINA-KEY' } },
        5
    );
    t.is((JSON.parse(calls[0].body as string) as { api_key?: string }).api_key, 'TAV-KEY');
});

test.serial('legacy pole apiKey działa dla WYBRANEGO dostawcy i nie wycieka do innych', t => {
    const legacy = { provider: 'tavily', apiKey: 'STARY-KLUCZ-TAVILY' };
    t.is(resolveProviderKey(legacy, 'tavily'), 'STARY-KLUCZ-TAVILY');
    t.is(resolveProviderKey(legacy, 'jina'), '', 'klucz Tavily nie poleci do Jiny (dawne 401 readera)');
    t.is(
        resolveProviderKey({ provider: 'tavily', apiKey: 'STARY', apiKeys: { tavily: 'NOWY' } }, 'tavily'),
        'NOWY',
        'apiKeys wygrywa z legacy'
    );
    t.is(resolveProviderKey({ apiKey: 'K' }, 'jina'), 'K', 'brak provider = jina jest wybrana');
});

test.serial('bramka klucza dalej broni płatnych dostawców', async t => {
    mockNetwork(() => tavilyOk);
    await t.throwsAsync(
        executeWebSearch('bramka-klucza-query', { provider: 'tavily' }, 5),
        { message: /Tavily/ }
    );
});

test.serial('WARSTWY: padnięty płatny dostawca spada na darmową podłogę Jiny', async t => {
    const calls = mockNetwork((req) => {
        if (req.url.includes('tavily')) {
            const err: Error & { status?: number } = new Error('401 unauthorized');
            err.status = 401;
            throw err;
        }
        return jinaOk(1);
    });

    const res = await executeWebSearch(
        'warstwy-fallback-query',
        { provider: 'tavily', apiKeys: { tavily: 'ZDECHLY-KLUCZ' } },
        5
    );

    t.true(res.success);
    t.is(res.provider, 'jina', 'w wyniku jest ten, kto REALNIE obsłużył');
    t.is(res.fallback_from, 'tavily');
    t.is(res.count, 1);
    t.is(calls.length, 2, 'dwa strzały: płatny, potem podłoga');
    t.regex(calls[1].url, /s\.jina\.ai/);
});

test.serial('podłoga bierze wyłącznie własny klucz Jiny, nie klucz padniętego dostawcy', async t => {
    const calls = mockNetwork((req) => {
        if (req.url.includes('brave')) throw new Error('brave down');
        return jinaOk(1);
    });

    await executeWebSearch(
        'podloga-klucz-query',
        { provider: 'brave', apiKey: 'LEGACY-BRAVE', apiKeys: { brave: 'BRAVE-KEY' } },
        5
    );

    t.is(calls[1].headers.Authorization, undefined, 'brak apiKeys.jina = strzał bezkluczowy');
});

test.serial('gdy padnie też podłoga, leci ORYGINALNY błąd wybranego dostawcy', async t => {
    mockNetwork((req) => {
        if (req.url.includes('serper')) throw new Error('serper: kredyty wyczerpane');
        throw new Error('jina: brak sieci');
    });

    await t.throwsAsync(
        executeWebSearch('obie-padly-query', { provider: 'serper', apiKeys: { serper: 'K' } }, 5),
        { message: 'serper: kredyty wyczerpane' }
    );
});

test.serial('Jina jako wybrany dostawca nie próbuje fallbacku sama na siebie', async t => {
    const calls = mockNetwork(() => { throw new Error('jina down'); });
    await t.throwsAsync(executeWebSearch('jina-sama-query', { provider: 'jina' }, 5), { message: 'jina down' });
    t.is(calls.length, 1);
});

test.serial('readWebPage używa klucza Jiny (nie klucza wybranego dostawcy) i czyta treść', async t => {
    const calls = mockNetwork(() => ({
        status: 200,
        text: JSON.stringify({ data: { url: 'https://example.com/a', title: 'Tytuł', content: 'pełna treść' } }),
    }));

    const res = await readWebPage('https://example.com/a', {
        provider: 'tavily',
        apiKey: 'TAVILY-LEGACY',
        apiKeys: { jina: 'JINA-KEY' },
    });

    t.is(res.content, 'pełna treść');
    t.is(res.title, 'Tytuł');
    t.regex(calls[0].url, /^https:\/\/r\.jina\.ai\//);
    t.is(calls[0].headers.Authorization, 'Bearer JINA-KEY');
});

test.serial('PDF idzie przez reader tak samo jak strona (bez biblioteki po naszej stronie)', async t => {
    const calls = mockNetwork(() => ({
        status: 200,
        text: JSON.stringify({ data: { title: 'Raport.pdf', content: 'tekst wyciągnięty z PDF' } }),
    }));

    const res = await readWebPage('https://example.com/raport.pdf', {});
    t.is(res.content, 'tekst wyciągnięty z PDF');
    t.is(calls[0].url, 'https://r.jina.ai/https://example.com/raport.pdf');
});

test.serial('nieczytelna binarka daje uczciwy komunikat zamiast pustki albo wyjątku parsera', async t => {
    mockNetwork(() => ({ status: 200, text: 'binarka-ktora-nie-jest-JSON-em' }));
    const err = await t.throwsAsync(readWebPage('https://example.com/obraz.png', {}), {
        message: /obraz\.png/,
    }) as Error;
    t.is(err.message, tr('websearch.unreadable_binary', { url: 'https://example.com/obraz.png' }));
});

// S32 Z4.1: poprawny JSON + pusta treść to NIE binarka. Dawniej oba przypadki dawały
// `unreadable_binary` — model dostawał info „to obrazek", choć reader po prostu nic nie znalazł.
test.serial('poprawny JSON bez treści daje komunikat o braku treści, nie o binarce', async t => {
    mockNetwork(() => ({ status: 200, text: JSON.stringify({ data: { title: 'x', content: '   ' } }) }));
    const err = await t.throwsAsync(readWebPage('https://example.com/pusto', {}), { message: /pusto/ }) as Error;
    t.is(err.message, tr('websearch.no_content', { url: 'https://example.com/pusto' }));
    t.not(err.message, tr('websearch.unreadable_binary', { url: 'https://example.com/pusto' }));
});

// ─── K1 / znalezisko 001: strażnik kanoniczności adresu przed sklejką z readerem ───

test.serial('readWebPage ODMAWIA, gdy sklejka z readerem zmieniłaby adres (segmenty `..`)', async t => {
    // `https://r.jina.ai/https://good.com/a/../../../../evil.com/collect` po normalizacji URL
    // zwija się do `https://r.jina.ai/evil.com/collect` — filtr domen widział `good.com`,
    // a reader poszedłby na `evil.com`. Strażnik ma to zatrzymać PRZED strzałem w sieć.
    const calls = mockNetwork(() => ({ status: 200, text: JSON.stringify({ data: { content: 'nie powinno dojść' } }) }));

    await t.throwsAsync(readWebPage('https://good.com/a/../../../../evil.com/collect', {}));
    t.is(calls.length, 0, 'strażnik przepuścił request mimo niekanonicznego adresu');
});

test.serial('readWebPage: adres kanoniczny przechodzi, sklejka jest stabilna', async t => {
    const calls = mockNetwork(() => ({
        status: 200,
        text: JSON.stringify({ data: { title: 'ok', content: 'treść' } }),
    }));

    const res = await readWebPage('https://good.com/evil.com/collect', {});
    t.is(res.content, 'treść');
    t.is(calls[0].url, 'https://r.jina.ai/https://good.com/evil.com/collect');
});
