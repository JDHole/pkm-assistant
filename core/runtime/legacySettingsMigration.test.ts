/**
 * Migrator KWARANTANNOWY — jedyny test, w którym wolno wystąpić starym nazwom kluczy
 * ustawień (razem z samym plikiem migratora i fixture'ami obok).
 *
 * Wejście: DWA realne kształty `settings.json` trzymane jako fixture'y w pamięci —
 * `__fixtures__/settings_v2.1.json` (kształt sprzed clean-room) i
 * `__fixtures__/settings_v2.2_s35.json` (po rename namespace'u, z sejfem sekretów).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';

import { migrateLegacySettings } from './legacySettingsMigration.js';
import { migrateNamespace } from '../utils/settingsNamespaceMigration.js';
import type { SettingsBag } from './contracts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (name: string): SettingsBag =>
    JSON.parse(fs.readFileSync(path.join(HERE, '__fixtures__', name), 'utf8')) as SettingsBag;

const pkm = (bag: SettingsBag): Record<string, Record<string, Record<string, string>>> =>
    bag.pkmAssistant as unknown as Record<string, Record<string, Record<string, string>>>;

// ── C4.1 ─────────────────────────────────────────────────────────────────────
test('fixture v2.1 → wszystkie klucze pod pkmAssistant.*', t => {
    const bag = load('settings_v2.1.json');
    const wynik = migrateLegacySettings(bag);

    t.is(wynik.migrated, true);
    t.true(wynik.movedKeys > 0);

    const chat = pkm(bag).chat;
    t.is(chat.platform as unknown as string, 'deepseek');
    t.is(chat.apiKeys.deepseek, 'sk-deepseek-PLACEHOLDER');
    t.is(chat.apiKeys.openai, 'sk-openai-PLACEHOLDER');
    t.is(chat.models.deepseek, 'deepseek-chat');
    t.is(chat.models.openai, 'gpt-4o-mini');
    t.is(chat.hosts.ollama, 'http://127.0.0.1:11434');
    t.is(chat.hosts.lm_studio, 'http://127.0.0.1:1234');
    t.is(chat.temperature as unknown as number, 0.4);
    t.is(chat.maxTokens as unknown as number, 3000);

    const embedding = pkm(bag).embedding;
    t.is(embedding.provider as unknown as string, 'openai');
    t.is(embedding.models.openai, 'text-embedding-3-small');
    t.is(embedding.apiKeys.openai, 'sk-openai-embed-PLACEHOLDER');
    t.is(embedding.batchSize.openai as unknown as number, 12);
    t.is(embedding.timeoutMs as unknown as number, 45000);

    t.deepEqual(pkm(bag).notices.muted, { embedding_provider_missing: true });

    t.is(bag.smart_chat_model, undefined, 'stara gałąź czatu została po migracji');
    t.is(bag.smart_sources, undefined, 'stara gałąź źródeł została po migracji');
    t.is(bag.smart_notices, undefined, 'stara gałąź powiadomień została po migracji');
});

// ── C4.2 ─────────────────────────────────────────────────────────────────────
test('fixture v2.2 (po rename namespace) → migrowany razem z sejfem', t => {
    const bag = load('settings_v2.2_s35.json');
    const wynik = migrateLegacySettings(bag);

    t.is(wynik.migrated, true);
    t.is(pkm(bag).chat.platform as unknown as string, '', 'nieobsługiwana platforma nie została wyzerowana');
    t.is(pkm(bag).chat.models.anthropic, 'claude-sonnet-4-5');
    t.is(pkm(bag).embedding.provider as unknown as string, 'gemini');
    t.true(wynik.secretRefsMigrated >= 2, 'wpisy sejfu nie zostały przemianowane');
});

// ── C4.3 ─────────────────────────────────────────────────────────────────────
test('gałąź wątków czatu jest KASOWANA, nie przenoszona', t => {
    const bag = load('settings_v2.1.json');
    const wynik = migrateLegacySettings(bag);

    t.is(bag.smart_chat_threads, undefined);
    t.true(wynik.removedKeys > 0);
    const pkmBag = pkm(bag) as unknown as Record<string, unknown>;
    t.is(pkmBag.chatThreads, undefined, 'gałąź wątków wylądowała pod pkmAssistant.* zamiast zginąć');
    t.is(pkmBag.threads, undefined);
});

// ── C4.4 ─────────────────────────────────────────────────────────────────────
test('idempotencja: drugi przebieg zwraca migrated:false i nie zmienia worka', t => {
    const bag = load('settings_v2.1.json');
    migrateLegacySettings(bag);
    const poPierwszym = JSON.stringify(bag);

    const drugi = migrateLegacySettings(bag);

    t.is(drugi.migrated, false);
    t.is(drugi.movedKeys, 0);
    t.is(JSON.stringify(bag), poPierwszym, 'drugi przebieg zmienił worek — migrator nie jest idempotentny');
});

// ── C4.5 ─────────────────────────────────────────────────────────────────────
test('nowy klucz już istnieje → NIE nadpisuje, stary kasuje', t => {
    const bag: SettingsBag = {
        smart_chat_model: { platform: 'deepseek' },
        pkmAssistant: { chat: { platform: 'anthropic' } },
    };

    migrateLegacySettings(bag);

    t.is(pkm(bag).chat.platform as unknown as string, 'anthropic', 'migrator nadpisał świadomy wybór usera');
    t.is(bag.smart_chat_model, undefined, 'stara gałąź nie została skasowana');
});

// ── C4.6 ─────────────────────────────────────────────────────────────────────
test('platforma google/azure/custom → "" (nieobsługiwane)', t => {
    for (const platform of ['google', 'azure', 'custom']) {
        const bag: SettingsBag = { smart_chat_model: { platform } };
        migrateLegacySettings(bag);
        t.is(pkm(bag).chat.platform as unknown as string, '', `platforma ${platform} przetrwała migrację`);
    }
});

// ── C4.7 ─────────────────────────────────────────────────────────────────────
test('_model wygrywa nad .model_key, gdy oba', t => {
    const bag: SettingsBag = {
        smart_chat_model: {
            deepseek_model: 'z-plaskiego-klucza',
            deepseek: { model_key: 'z-zagniezdzonego' },
        },
    };

    migrateLegacySettings(bag);

    t.is(pkm(bag).chat.models.deepseek, 'z-plaskiego-klucza');
});

// ── C4.8 ─────────────────────────────────────────────────────────────────────
test('secureStorage: klucze refs przepięte I id sekretów przemianowane', t => {
    const bag = load('settings_v2.2_s35.json');
    const przedBloby = Object.values(
        ((bag.pkmAssistant as Record<string, Record<string, Record<string, unknown>>>).secureStorage).encrypted,
    );

    migrateLegacySettings(bag);

    const sejf = (bag.pkmAssistant as Record<string, Record<string, Record<string, unknown>>>).secureStorage;
    const refs = sejf.refs as Record<string, string>;
    const encrypted = sejf.encrypted;

    t.truthy(refs['pkmAssistant.chat.apiKeys.anthropic'], 'ścieżka klucza czatu nie została przepięta');
    t.truthy(refs['pkmAssistant.chat.apiKeys.xai']);
    t.is(refs['smart_chat_model.anthropic_api_key'] as string | undefined, undefined, 'stara ścieżka została w refs');

    for (const id of Object.values(refs)) {
        t.false(/obsek|smart[-_]chat[-_]model/.test(id), `id sekretu nadal niesie stare słownictwo: ${id}`);
        t.true(id in encrypted, `blob dla id ${id} nie został przepięty pod nowy klucz`);
    }

    t.deepEqual(
        Object.values(encrypted).map(v => JSON.stringify(v)).sort(),
        przedBloby.map(v => JSON.stringify(v)).sort(),
        'bloby zostały odszyfrowane albo zmienione — migrator ma je tylko PRZEKLUCZYĆ',
    );
});

// ── C4.8b ────────────────────────────────────────────────────────────────────
test('migrateNamespace NIE rusza id sekretów', t => {
    const bag = load('settings_v2.2_s35.json');
    const przed = { ...((bag.pkmAssistant as Record<string, Record<string, Record<string, string>>>).secureStorage.refs) };

    migrateNamespace(bag);

    const po = (bag.pkmAssistant as Record<string, Record<string, Record<string, string>>>).secureStorage.refs;
    t.deepEqual(Object.values(po).sort(), Object.values(przed).sort(),
        'migrator namespace przemianował id sekretów — po nich chodzi odszyfrowanie (M-02)');
});

// ── C4.9 ─────────────────────────────────────────────────────────────────────
test('martwe klucze skasowane (removedKeys > 0)', t => {
    const bag = load('settings_v2.1.json');
    const wynik = migrateLegacySettings(bag);

    t.true(wynik.removedKeys > 0);
    for (const martwy of ['smart_blocks', 'smart_view_filter', 'is_obsidian_vault', 're_import_wait_time', 'embedding_models', 'language']) {
        t.is(bag[martwy] as unknown, undefined, `martwy klucz ${martwy} przeżył migrację`);
    }
});

// ── C4.10 ────────────────────────────────────────────────────────────────────
test('funkcja czysta — fn.length === 1, zero I/O', t => {
    t.is(migrateLegacySettings.length, 1,
        'migrator przyjmuje więcej niż worek — to strukturalna furtka do I/O w trakcie load()');
});

// ── C4.11 ────────────────────────────────────────────────────────────────────
test('wejście null/string/liczba/tablica → {migrated:false} bez wyjątku', t => {
    for (const wejscie of [null, undefined, 'tekst', 42, true, [1, 2, 3]]) {
        const wynik = migrateLegacySettings(wejscie);
        t.is(wynik.migrated, false, `wejście ${JSON.stringify(wejscie)} zmieniło werdykt`);
        t.is(wynik.movedKeys, 0);
        t.is(wynik.removedKeys, 0);
    }
});

// =============================================================================
// LICZNIKI — dokładne, nie „większe od zera".
//
// `movedKeys` / `removedKeys` / `secretRefsMigrated` to jedyne, co migrator mówi
// o świecie na zewnątrz (poza mutacją worka). Testy wyżej sprawdzały je progowo
// (`> 0`), więc każda pomyłka w KTÓRĄ stronę idzie licznik i o ILE przechodziła
// bez śladu. Poniżej każdy krok migratora dostaje worek z JEDNYM kluczem
// i werdykt co do joty.
// =============================================================================

const licz = (bag: SettingsBag): [number, number, number] => {
    const wynik = migrateLegacySettings(bag);
    return [wynik.movedKeys, wynik.removedKeys, wynik.secretRefsMigrated];
};

// ── C4.12 ────────────────────────────────────────────────────────────────────
test('platforma czatu: przeniesienie liczy sie jako przeniesienie, nie kasacja', t => {
    const bag: SettingsBag = { smart_chat_model: { platform: 'deepseek' } };

    t.deepEqual(licz(bag), [1, 0, 0]);
    t.is(pkm(bag).chat.platform as unknown as string, 'deepseek');
});

// ── C4.13 ────────────────────────────────────────────────────────────────────
test('platforma czatu: kolizja z nowym ksztaltem liczy sie jako kasacja', t => {
    const bag: SettingsBag = {
        smart_chat_model: { platform: 'deepseek' },
        pkmAssistant: { chat: { platform: 'anthropic' } },
    };

    t.deepEqual(licz(bag), [0, 1, 0]);
    t.is(pkm(bag).chat.platform as unknown as string, 'anthropic');
});

// ── C4.14 ────────────────────────────────────────────────────────────────────
test('limit tokenow czatu: przeniesienie liczy sie jako przeniesienie', t => {
    const bag: SettingsBag = { smart_chat_model: { max_tokens: 3000 } };

    t.deepEqual(licz(bag), [1, 0, 0]);
    t.is(pkm(bag).chat.maxTokens as unknown as number, 3000);
});

// ── C4.15 ────────────────────────────────────────────────────────────────────
test('klucz API czatu: jedno pole = jedno przeniesienie', t => {
    const bag: SettingsBag = { smart_chat_model: { deepseek_api_key: 'sk-PLACEHOLDER' } };

    t.deepEqual(licz(bag), [1, 0, 0]);
    t.is(pkm(bag).chat.apiKeys.deepseek, 'sk-PLACEHOLDER');
});

// ── C4.16 ────────────────────────────────────────────────────────────────────
test('adres serwera czatu: jedno pole = jedno przeniesienie', t => {
    const bag: SettingsBag = { smart_chat_model: { ollama_host: 'http://127.0.0.1:11434' } };

    t.deepEqual(licz(bag), [1, 0, 0]);
    t.is(pkm(bag).chat.hosts.ollama, 'http://127.0.0.1:11434');
});

// ── C4.17 ────────────────────────────────────────────────────────────────────
test('model czatu: jedno pole = jedno przeniesienie', t => {
    const bag: SettingsBag = { smart_chat_model: { deepseek_model: 'deepseek-chat' } };

    t.deepEqual(licz(bag), [1, 0, 0]);
    t.is(pkm(bag).chat.models.deepseek, 'deepseek-chat');
});

// ── C4.18 ────────────────────────────────────────────────────────────────────
test('dostawca embeddingu: jedno pole = jedno przeniesienie', t => {
    const bag: SettingsBag = { smart_sources: { embed_model: { adapter: 'openai' } } };

    t.deepEqual(licz(bag), [1, 0, 0]);
    t.is(pkm(bag).embedding.provider as unknown as string, 'openai');
});

// ── C4.19 ────────────────────────────────────────────────────────────────────
test('podgalaz embeddingu nie-obiektowa = dokladnie jedna kasacja', t => {
    const bag: SettingsBag = { smart_sources: { embed_model: 'nonsens' } };

    t.deepEqual(licz(bag), [0, 1, 0]);
    t.is(bag.smart_sources, undefined);
});

// ── C4.20 ────────────────────────────────────────────────────────────────────
test('wykluczenia w galezi zrodel: jeden martwy klucz = dokladnie jedna kasacja', t => {
    const bag: SettingsBag = { smart_sources: { excluded_folders: ['Prywatne'] } };

    t.deepEqual(licz(bag), [0, 1, 0]);
    t.is(bag.smart_sources, undefined);
    t.is((pkm(bag) as unknown as Record<string, unknown>).embedding, undefined,
        'martwe wykluczenia wyladowaly pod pkmAssistant.* zamiast zginac');
});

// ── C4.21 ────────────────────────────────────────────────────────────────────
test('pole dostawcy embeddingu: jedno pole = jedno przeniesienie', t => {
    const bag: SettingsBag = {
        smart_sources: { embed_model: { openai: { api_key: 'sk-PLACEHOLDER' } } },
    };

    t.deepEqual(licz(bag), [1, 0, 0]);
    t.is(pkm(bag).embedding.apiKeys.openai, 'sk-PLACEHOLDER');
});

// ── C4.22 ────────────────────────────────────────────────────────────────────
test('powiadomienia: obcy klucz-obiekt NIE staje sie wyciszeniami', t => {
    const bag: SettingsBag = { smart_notices: { costam_obcego: { a: true } } };

    t.deepEqual(licz(bag), [0, 1, 0]);
    t.is((pkm(bag) as unknown as Record<string, unknown>).notices, undefined,
        'obcy klucz galezi powiadomien przebral sie za wyciszenia');
});

// ── C4.23 ────────────────────────────────────────────────────────────────────
test('wyciszenia: kolizja z nowym ksztaltem = dokladnie jedna kasacja', t => {
    const bag: SettingsBag = {
        smart_notices: { muted: { stare: true } },
        pkmAssistant: { notices: { muted: { nowe: true } } },
    };

    t.deepEqual(licz(bag), [0, 1, 0]);
    t.deepEqual(pkm(bag).notices.muted as unknown as Record<string, boolean>, { nowe: true });
});

// ── C4.24 ────────────────────────────────────────────────────────────────────
test('galaz powiadomien nie-obiektowa = dokladnie jedna kasacja', t => {
    const bag: SettingsBag = { smart_notices: 'nonsens' };

    t.deepEqual(licz(bag), [0, 1, 0]);
    t.is(bag.smart_notices, undefined);
});

// ── C4.25 ────────────────────────────────────────────────────────────────────
test('sejf: kolizja sciezek w refs = dokladnie jedna kasacja, zero przepiec', t => {
    const bag: SettingsBag = {
        pkmAssistant: {
            secureStorage: {
                refs: {
                    'smart_chat_model.anthropic_api_key': 'obsek-smart-chat-model-anthropic-api-key',
                    'pkmAssistant.chat.apiKeys.anthropic': 'pkm-assistant-chat-apikeys-anthropic',
                },
                encrypted: { 'pkm-assistant-chat-apikeys-anthropic': 'BLOB-NOWY' },
            },
        },
    };

    t.deepEqual(licz(bag), [0, 1, 0]);

    const refs = (pkm(bag) as unknown as Record<string, Record<string, Record<string, string>>>)
        .secureStorage.refs;
    t.is(refs['smart_chat_model.anthropic_api_key'] as string | undefined, undefined);
    t.is(refs['pkmAssistant.chat.apiKeys.anthropic'], 'pkm-assistant-chat-apikeys-anthropic',
        'swiadomy wpis w nowym ksztalcie przegral ze starym');
});

// ── C4.26 ────────────────────────────────────────────────────────────────────
test('id sekretu zachowuje cyfry nazwy dostawcy', t => {
    const bag: SettingsBag = {
        pkmAssistant: {
            secureStorage: {
                refs: { 'smart_chat_model.gpt4all_api_key': 'obsek-smart-chat-model-gpt4all-api-key' },
                encrypted: { 'obsek-smart-chat-model-gpt4all-api-key': 'BLOB' },
            },
        },
    };

    t.deepEqual(licz(bag), [0, 0, 1]);

    const sejf = (pkm(bag) as unknown as Record<string, Record<string, Record<string, unknown>>>)
        .secureStorage;
    t.is(sejf.refs['pkmAssistant.chat.apiKeys.gpt4all'], 'pkm-assistant-chat-apikeys-gpt4all',
        'cyfra w nazwie dostawcy wypadla z id sekretu');
    t.is(sejf.encrypted['pkm-assistant-chat-apikeys-gpt4all'], 'BLOB',
        'blob nie poszedl za przemianowanym id');
});
