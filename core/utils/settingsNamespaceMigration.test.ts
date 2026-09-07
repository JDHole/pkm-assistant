import test from 'ava';
import { migrateNamespace } from './settingsNamespaceMigration.js';

/**
 * Migrator dostaje `unknown` i przestawia obiekt W MIEJSCU, więc testy anotują wejście
 * jako luźny worek — inaczej TS zna tylko kształt SPRZED migracji i nie widzi `pkmAssistant`.
 */
type Bag = Record<string, unknown>;

/** Gałąź sejfu sekretów po migracji — do asercji na `refs` / `encrypted`. */
type SecureBranch = { secureStorage: { refs: Record<string, string>; encrypted?: unknown } };

test('stary kształt → klucz przemianowany, stary zniknął', t => {
    const data: Bag = { smart_chat_model: { platform: 'deepseek' }, obsek: { debugMode: true } };
    const res = migrateNamespace(data);
    t.true(res.migrated);
    t.deepEqual(data.pkmAssistant, { debugMode: true });
    t.false('obsek' in data);
    t.deepEqual(data.smart_chat_model, { platform: 'deepseek' });
});

test('refs sejfu przepięte na nowy namespace, id sekretów nietknięte', t => {
    const data: Bag = {
        obsek: {
            secureStorage: {
                enabled: true,
                backend: 'master-password',
                refs: {
                    'obsek.webSearch.apiKey': 'obsek-obsek-websearch-apikey',
                    'obsek.stt.deepgram_api_key': 'obsek-obsek-stt-deepgram-api-key',
                    'smart_chat_model.anthropic_api_key': 'obsek-smart-chat-model-anthropic-api-key',
                },
                encrypted: { 'obsek-obsek-websearch-apikey': { iv: 'x', data: 'y' } },
            },
        },
    };
    const res = migrateNamespace(data);
    t.true(res.migrated);
    t.is(res.refsMigrated, 2);
    const refs = (data.pkmAssistant as SecureBranch).secureStorage.refs;
    t.deepEqual(Object.keys(refs).sort(), [
        'pkmAssistant.stt.deepgram_api_key',
        'pkmAssistant.webSearch.apiKey',
        'smart_chat_model.anthropic_api_key',
    ]);
    // Wartości (id sekretów) BEZ zmian — po nich chodzi odszyfrowanie.
    t.is(refs['pkmAssistant.webSearch.apiKey'], 'obsek-obsek-websearch-apikey');
    t.is(refs['smart_chat_model.anthropic_api_key'], 'obsek-smart-chat-model-anthropic-api-key');
    // Bloby zaszyfrowane nietknięte.
    t.deepEqual((data.pkmAssistant as SecureBranch).secureStorage.encrypted, { 'obsek-obsek-websearch-apikey': { iv: 'x', data: 'y' } });
});

test('nowy kształt → nietknięty (idempotencja)', t => {
    const data: Bag = { pkmAssistant: { debugMode: true } };
    const res = migrateNamespace(data);
    t.false(res.migrated);
    t.deepEqual(data, { pkmAssistant: { debugMode: true } });
});

test('dwa razy z rzędu = ten sam wynik (idempotencja realna)', t => {
    const data = { obsek: { a: 1, secureStorage: { refs: { 'obsek.stt.deepgram_api_key': 'id-1' } } } };
    migrateNamespace(data);
    const snapshot = JSON.parse(JSON.stringify(data));
    const second = migrateNamespace(data);
    t.false(second.migrated);
    t.deepEqual(data, snapshot);
});

test('oba klucze naraz → wygrywa pkmAssistant, obsek zostaje jak leży', t => {
    const data = { obsek: { a: 1 }, pkmAssistant: { b: 2 } };
    const res = migrateNamespace(data);
    t.false(res.migrated);
    t.deepEqual(data, { obsek: { a: 1 }, pkmAssistant: { b: 2 } });
});

test('brak obu kluczy → nietknięty', t => {
    const data = { smart_chat_model: { platform: 'ollama' } };
    const res = migrateNamespace(data);
    t.false(res.migrated);
    t.deepEqual(data, { smart_chat_model: { platform: 'ollama' } });
});

test('null / undefined / string / tablica → nie wywala się', t => {
    for (const bad of [null, undefined, 'obsek', 42, true, []]) {
        t.deepEqual(migrateNamespace(bad), { migrated: false });
    }
});

test('refs w dziwnym kształcie (null / tablica) nie wywalają migracji klucza', t => {
    const a: Bag = { obsek: { secureStorage: { refs: null } } };
    t.true(migrateNamespace(a).migrated);
    t.truthy(a.pkmAssistant);

    const b: Bag = { obsek: { secureStorage: null } };
    t.true(migrateNamespace(b).migrated);
    t.truthy(b.pkmAssistant);

    const c: Bag = { obsek: { secureStorage: { refs: ['obsek.stt.deepgram_api_key'] } } };
    const res = migrateNamespace(c);
    t.true(res.migrated);
    t.is(res.refsMigrated, 0);
});

test('kolizja: nowa ścieżka już w refs → stary wpis tylko kasowany, nowy nie nadpisany', t => {
    const data: Bag = {
        obsek: {
            secureStorage: {
                refs: {
                    'obsek.webSearch.apiKey': 'stare-id',
                    'pkmAssistant.webSearch.apiKey': 'nowe-id',
                },
            },
        },
    };
    const res = migrateNamespace(data);
    t.true(res.migrated);
    t.is(res.refsMigrated, 0);
    t.deepEqual((data.pkmAssistant as SecureBranch).secureStorage.refs, { 'pkmAssistant.webSearch.apiKey': 'nowe-id' });
});

test('funkcja jest czysta — zero I/O (żadnego fs/adaptera nie da się wywołać)', t => {
    // Gwarancja „load nie pisze": migrator nie ma i nie może mieć dostępu do dysku,
    // bo jego jedynym argumentem jest zwykły obiekt. Test pilnuje sygnatury.
    t.is(migrateNamespace.length, 1);
    const data = { obsek: {} };
    const res = migrateNamespace(data);
    t.true(res.migrated);
    t.is(typeof res.refsMigrated, 'number');
});
