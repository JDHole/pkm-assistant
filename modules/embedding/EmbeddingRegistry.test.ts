/**
 * EmbeddingRegistry.test.ts — rejestr modeli embeddingu (clean-room / F4, `contracts.ts` §8).
 *
 * Reshape `standalone_base.test.ts` (12 testów — mapowanie w `plan_embedding.md` §B.3;
 * mechanizm kolekcji `<provider>#<Date.now()>` DELETE w całości, R11) + nowe testy
 * C-19..C-22, C-37 (katalog §C).
 *
 * Napisany przed implementacją (czerwony na stubie — `EmbeddingRegistry` rzucał
 * `not implemented` na każdym członie, więc WSZYSTKIE testy tego pliku były czerwone z tego
 * jednego powodu), dziś zielony.
 */
import test from 'ava';
import { EmbeddingRegistry } from './EmbeddingRegistry.js';
import { UnknownEmbeddingProviderError } from './embedErrors.js';
import { EMBEDDING_PROVIDERS } from './providers/index.js';
import { DEFAULT_EMBED_BATCH_SIZE, DEFAULT_EMBED_TIMEOUT_MS, EMBEDDING_PROVIDER_IDS } from './contracts.js';
import type { EmbeddingRegistryDeps, EmbeddingSettingsSlice, HttpClient, HttpRequestSpec, HttpResponse, SettingsWithEmbedding } from './contracts.js';

function jsonResponse(status: number, body: unknown): HttpResponse {
    const text = JSON.stringify(body);
    return { status, headers: {}, text, json: <T>() => JSON.parse(text) as T };
}

function fakeHttp(): { http: HttpClient; calls: HttpRequestSpec[] } {
    const calls: HttpRequestSpec[] = [];
    return {
        calls,
        http: {
            async send(spec) {
                calls.push(spec);
                return jsonResponse(200, { data: [{ embedding: [1, 2, 3] }] });
            },
        },
    };
}

const log = { debug() {}, info() {}, warn() {}, error() {} };

function makeDeps(settings: SettingsWithEmbedding | null, overrides: Partial<EmbeddingRegistryDeps> = {}): EmbeddingRegistryDeps {
    const { http } = fakeHttp();
    return {
        providers: EMBEDDING_PROVIDERS,
        http,
        settings: () => settings,
        log,
        ...overrides,
    };
}

// ── SB-03 (reshape) ──────────────────────────────────────────────────────────

test('default bierze dostawcę i model z ustawień usera; worek ustawień nietknięty', t => {
    const settings: SettingsWithEmbedding = {
        pkmAssistant: { embedding: { provider: 'ollama', models: { ollama: 'snowflake-arctic-embed2' }, apiKeys: {} } },
    };
    const przed = JSON.parse(JSON.stringify(settings)) as SettingsWithEmbedding;
    const registry = new EmbeddingRegistry(makeDeps(settings));

    const model = registry.default;
    t.truthy(model);
    if (model) {
        t.is(model.providerId, 'ollama');
        t.is(model.modelId, 'snowflake-arctic-embed2');
        t.is(model.modelKey, 'ollama:snowflake-arctic-embed2');
    }
    t.deepEqual(settings, przed, 'getter `default` jest CZYSTY — nie mutuje worka ustawień (B.7 SB-03)');
});

// ── SB-04 (reshape) ──────────────────────────────────────────────────────────

test('dwa odczyty default to ta sama instancja; zmiana ustawień ją unieważnia', t => {
    const settings: SettingsWithEmbedding = { pkmAssistant: { embedding: { provider: 'ollama', models: {}, apiKeys: {} } } };
    const registry = new EmbeddingRegistry(makeDeps(settings));

    const pierwszy = registry.default;
    const drugi = registry.default;
    t.is(pierwszy, drugi, 'niezmienione ustawienia -> ta sama instancja (cache)');

    if (settings.pkmAssistant?.embedding) settings.pkmAssistant.embedding.provider = 'gemini';
    const trzeci = registry.default;
    t.not(trzeci, pierwszy, 'zmiana dostawcy w ustawieniach unieważnia cache');
});

// ── SB-05 (reshape) ──────────────────────────────────────────────────────────

test('default.embed() dowozi wektor przez wstrzyknięty http', async t => {
    const settings: SettingsWithEmbedding = {
        pkmAssistant: { embedding: { provider: 'openai', models: { openai: 'text-embedding-3-small' }, apiKeys: { openai: 'sk-test' } } },
    };
    const registry = new EmbeddingRegistry(makeDeps(settings));

    const model = registry.default;
    t.truthy(model);
    if (model) {
        const [result] = await model.embed(['hello']);
        t.truthy(result.vector);
    }
});

// ── SB-07 (reshape, po R9) ───────────────────────────────────────────────────

test('dostawca lokalny działa bez klucza (needsApiKey:false), bez sztucznego \'na\'', t => {
    const settings: SettingsWithEmbedding = { pkmAssistant: { embedding: { provider: 'ollama', models: {}, apiKeys: {} } } };
    const registry = new EmbeddingRegistry(makeDeps(settings));

    t.notThrows(() => registry.default);
    t.false(EMBEDDING_PROVIDERS.ollama.info.needsApiKey);
});

// ── SB-08 (reshape) ──────────────────────────────────────────────────────────

test('klucz z apiKeys.<p> trafia do kontekstu dostawcy', async t => {
    const { http, calls } = fakeHttp();
    const settings: SettingsWithEmbedding = {
        pkmAssistant: { embedding: { provider: 'openai', models: {}, apiKeys: { openai: 'sk-z-ustawien-usera' } } },
    };
    const registry = new EmbeddingRegistry(makeDeps(settings, { http }));

    const model = registry.default;
    t.truthy(model);
    if (model) await model.embed(['hello']);
    t.true(calls.some(c => c.headers.Authorization === 'Bearer sk-z-ustawien-usera'));
});

// ── SB-11 / C-37 (reshape) ───────────────────────────────────────────────────

test('C-37: pełny łańcuch bootowy nie planuje zapisu ustawień (worek → default → createEmbedderFacade().isReady())', async t => {
    let zapisy = 0;
    const raw: SettingsWithEmbedding = {
        pkmAssistant: { embedding: { provider: 'ollama', models: {}, apiKeys: {} } },
    };
    // Proxy udający SettingsStore.settings — obserwowany, planuje zapis na KAŻDĄ mutację.
    const obserwowane = new Proxy(raw, {
        set(target, prop, value) {
            zapisy += 1;
            (target as Record<string | symbol, unknown>)[prop as string] = value as unknown;
            return true;
        },
        get(target, prop) {
            const value = (target as Record<string | symbol, unknown>)[prop as string];
            if (value && typeof value === 'object') {
                return new Proxy(value, {
                    set() { zapisy += 1; return true; },
                });
            }
            return value;
        },
    });

    const registry = new EmbeddingRegistry(makeDeps(null, { settings: () => obserwowane as SettingsWithEmbedding }));
    const isReady = registry.isConfigured();
    void isReady;

    await new Promise(resolve => setTimeout(resolve, 40));
    t.is(zapisy, 0, 'żadna ścieżka bootowa nie mutuje worek ustawień (B.7 SB-03/SB-11, harness 39)');
    t.deepEqual(raw, {
        pkmAssistant: { embedding: { provider: 'ollama', models: {}, apiKeys: {} } },
    });
});

// ── SB-12 (reshape) ──────────────────────────────────────────────────────────

test('bez wybranego providera default nie powstaje: null, isConfigured()===false, zero http.send', t => {
    const { http, calls } = fakeHttp();
    const settings: SettingsWithEmbedding = { pkmAssistant: { embedding: { provider: '', models: {}, apiKeys: {} } } };
    const registry = new EmbeddingRegistry(makeDeps(settings, { http }));

    t.is(registry.default, null);
    t.false(registry.isConfigured());
    t.is(calls.length, 0);
});

// ── C-19 ─────────────────────────────────────────────────────────────────────

test('C-19: nieznany dostawca w ustawieniach -> default===null, ostrzeżenie w logu, zero http.send', t => {
    const { http, calls } = fakeHttp();
    const warns: unknown[][] = [];
    const settings: SettingsWithEmbedding = { pkmAssistant: { embedding: { provider: 'cohere', models: {}, apiKeys: {} } } };
    const registry = new EmbeddingRegistry(makeDeps(settings, { http, log: { ...log, warn: (...a) => { warns.push(a); } } }));

    t.is(registry.default, null);
    t.true(warns.length > 0, 'nieznany dostawca musi zostawić ślad w logu');
    t.is(calls.length, 0);
});

// ── C-20 ─────────────────────────────────────────────────────────────────────

test('C-20: select() na nieznanym id RZUCA UnknownEmbeddingProviderError, nie undefined', t => {
    const registry = new EmbeddingRegistry(makeDeps(null));
    // @ts-expect-error — id spoza unii, dokładnie to co testujemy (wywołanie z zewnątrz TS)
    t.throws(() => registry.select('cohere'), { instanceOf: UnknownEmbeddingProviderError });
});

// ── C-21 ─────────────────────────────────────────────────────────────────────

test('C-21: providers() oddaje 4 metryczki w kolejności EMBEDDING_PROVIDER_IDS', t => {
    const registry = new EmbeddingRegistry(makeDeps(null));
    const infos = registry.providers();
    t.deepEqual(infos.map(i => i.id), [...EMBEDDING_PROVIDER_IDS]);
    for (const info of infos) {
        t.truthy(info.label);
        t.truthy(info.defaultModel);
    }
});

// ── C-22 ─────────────────────────────────────────────────────────────────────

test('C-22: zmiana provider w ustawieniach zmienia default bez restartu', t => {
    const settings: SettingsWithEmbedding = { pkmAssistant: { embedding: { provider: 'ollama', models: {}, apiKeys: {} } } };
    const registry = new EmbeddingRegistry(makeDeps(settings));

    t.is(registry.default?.providerId, 'ollama');
    if (settings.pkmAssistant?.embedding) settings.pkmAssistant.embedding.provider = 'gemini';
    t.is(registry.default?.providerId, 'gemini');
});

// ── F10 (bramka mutacyjna): dwie bramki wejścia rejestru — `text()` i `positiveNumber()` ──
//
// Rejestr normalizuje wpisy usera ZANIM zbuduje model: tekst pusty po obcięciu białych
// znaków znaczy „nie wpisano", a knob liczbowy niedodatni (0, ujemny, śmieć) jest
// odrzucany. Poniższe testy pinują OBSERWOWALNE skutki obu bramek, bo w środku
// EmbeddingModel ma własne bezpieczniki i sam by je zamaskował.

test('F10: model i host z samych białych znaków są traktowane jak brak wpisu (defaultModel + defaultEndpoint)', async t => {
    const calls: HttpRequestSpec[] = [];
    const http: HttpClient = {
        async send(spec) {
            calls.push(spec);
            return jsonResponse(200, { embeddings: [[1, 2, 3]] });
        },
    };
    const settings: SettingsWithEmbedding = {
        pkmAssistant: { embedding: { provider: 'ollama', models: { ollama: '   ' }, hosts: { ollama: '  ' }, apiKeys: {} } },
    };
    const registry = new EmbeddingRegistry(makeDeps(settings, { http }));

    const model = registry.default;
    t.truthy(model);
    if (!model) return;
    t.is(model.modelId, EMBEDDING_PROVIDERS.ollama.info.defaultModel, 'pusty po obcięciu model -> defaultModel dostawcy');
    t.is(model.modelKey, `ollama:${EMBEDDING_PROVIDERS.ollama.info.defaultModel}`);

    await model.embed(['hello']);
    t.is(
        calls[0]?.url,
        `${EMBEDDING_PROVIDERS.ollama.info.defaultEndpoint}/api/embed`,
        'pusty po obcięciu host -> defaultEndpoint dostawcy, a nie adres sklejony z pustki',
    );
});

test('F10: jednoznakowy klucz modelu z ustawień przechodzi w całości (bramka nie zjada krótkich nazw)', t => {
    const settings: SettingsWithEmbedding = {
        pkmAssistant: { embedding: { provider: 'ollama', models: { ollama: 'x' }, apiKeys: {} } },
    };
    const registry = new EmbeddingRegistry(makeDeps(settings));

    t.is(registry.default?.modelId, 'x');
    t.is(registry.default?.modelKey, 'ollama:x');
});

test('F10: dodatnie knoby z ustawień (timeoutMs, batchSize.<p>) dojeżdżają do modelu', t => {
    const settings: SettingsWithEmbedding = {
        pkmAssistant: { embedding: { provider: 'ollama', models: {}, apiKeys: {}, batchSize: { ollama: 7 }, timeoutMs: 12_345 } },
    };
    const registry = new EmbeddingRegistry(makeDeps(settings));

    const model = registry.default;
    t.truthy(model);
    if (!model) return;
    t.is(model.timeoutMs, 12_345, 'sufit czasu z ustawień usera');
    t.is(model.batchSize, 7, 'porcja doradcza usera wygrywa z katalogiem (B.6 GM-05)');
});

test('F10: 0 i liczba ujemna w knobach znaczą DOKŁADNIE to samo co brak wpisu — domyślne wartości i BEZ przebudowy modelu', t => {
    const slice: EmbeddingSettingsSlice = {
        provider: 'ollama',
        models: {},
        apiKeys: {},
        batchSize: { ollama: 0 },
        timeoutMs: 0,
    };
    const settings: SettingsWithEmbedding = { pkmAssistant: { embedding: slice } };
    const registry = new EmbeddingRegistry(makeDeps(settings));

    const zZerami = registry.default;
    t.truthy(zZerami);
    if (!zZerami) return;
    t.is(zZerami.timeoutMs, DEFAULT_EMBED_TIMEOUT_MS, '0 nigdy nie znaczy „bez limitu"');
    t.is(zZerami.batchSize, DEFAULT_EMBED_BATCH_SIZE);

    slice.timeoutMs = -5;
    slice.batchSize = { ollama: -5 };
    t.is(registry.default, zZerami, 'liczba ujemna odrzucana tak samo jak 0 — ten sam model, zero przebudowy');

    delete slice.timeoutMs;
    delete slice.batchSize;
    t.is(registry.default, zZerami, 'usunięcie odrzuconych knobów też nie unieważnia modelu');
});
