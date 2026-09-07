/**
 * Strażnik składania `RuntimeConfig` (C-02/C-03 + spec §1.3).
 *
 * Ten plik jest jedynym miejscem, w którym plugin decyduje, KTO gada z siecią i CZYM.
 * Trzy rzeczy muszą tu zostać na zawsze:
 *  1. komplet dziewięciu dostawców czatu i czterech embeddingu (rejestr niepełny =
 *     platforma usera cicho spada na fail-safe `resolveProvider`);
 *  2. rejestry są KOPIAMI map modułowych — harness podmienia w nich wpisy przed
 *     `onload()`, a mutacja mapy eksportowanej z modułu przeciekłaby do następnego bootu
 *     w tym samym procesie (scenariusze biegną seryjnie w jednym Node);
 *  3. `defaults` to świeży worek na każde wywołanie (pancerz go merguje z dyskiem).
 *
 * AVA rozwiązuje `obsidian` na atrapę harnessu (`ava.nodeArguments`), więc plik importujący
 * `requestUrl` daje się tu zaimportować normalnie.
 */
import test from 'ava';

import { buildRuntimeConfig } from './runtimeConfig.js';
import { defaultSettings } from './defaultSettings.js';
import { CHAT_PROVIDERS } from '../modules/models/index.js';
import { EMBEDDING_PROVIDERS, DEFAULT_EMBEDDING_SETTINGS } from '../modules/embedding/index.js';
import { DEFAULT_AUTONOMY } from '../core/index.js';
import type { AppLike } from '../core/index.js';

const app = { vault: { adapter: {} }, workspace: {} } as unknown as AppLike;

test('rejestr czatu ma komplet dostawców i jest KOPIĄ mapy modułu', t => {
    const config = buildRuntimeConfig({ app });

    t.deepEqual(Object.keys(config.chat.providers).sort(), Object.keys(CHAT_PROVIDERS).sort());
    t.not(config.chat.providers, CHAT_PROVIDERS as unknown as typeof config.chat.providers);

    // Podmiana wpisu (to robi harness offline) nie ma prawa dotknąć mapy modułowej.
    const zapamietany = CHAT_PROVIDERS.deepseek;
    config.chat.providers.deepseek = { info: { id: 'deepseek' } };
    t.is(CHAT_PROVIDERS.deepseek, zapamietany);
});

test('rejestr embeddingu ma komplet dostawców i jest KOPIĄ mapy modułu', t => {
    const config = buildRuntimeConfig({ app });

    t.deepEqual(Object.keys(config.embedding.providers).sort(), Object.keys(EMBEDDING_PROVIDERS).sort());
    t.not(config.embedding.providers, EMBEDDING_PROVIDERS as unknown as typeof config.embedding.providers);
});

test('tor bez strumienia i tor strumieniowy to DWA różne obiekty, oba obecne', t => {
    const config = buildRuntimeConfig({ app });

    t.is(typeof config.chat.http.send, 'function');
    t.is(typeof config.chat.transport.open, 'function');
    // Embedding nie streamuje — dzieli klienta z czatem (jedna polityka, jeden log).
    t.is(config.embedding.http, config.chat.http);
});

test('defaults: świeży worek na każde wywołanie, kontenery sekretów prowizjonowane', t => {
    const a = buildRuntimeConfig({ app }).defaults;
    const b = buildRuntimeConfig({ app }).defaults;

    t.deepEqual(a, b);
    t.not(a, b);
    t.not(a.pkmAssistant?.chat?.apiKeys, b.pkmAssistant?.chat?.apiKeys);

    // C5.4b: czterosegmentowa ścieżka sekretu nie dotwarza kontenerów przy hydratacji.
    t.deepEqual(a.pkmAssistant?.chat?.apiKeys, {});
    t.deepEqual(a.pkmAssistant?.embedding?.apiKeys, {});
    t.is(a.pkmAssistant?.chat?.platform, '');
    t.is(a.pkmAssistant?.embedding?.provider, '');
});

test('defaults: `defaultAutonomy` jest w worku i jest `edge` (najciaśniejszy start)', t => {
    const pkm = defaultSettings().pkmAssistant ?? {};

    // Czytelnicy i tak spadają na `DEFAULT_AUTONOMY`, ale suwak w Ustawieniach ma pokazać
    // wartość, a nie pustkę — i worek fabryczny ma mówić wprost, na czym plugin startuje.
    t.is(pkm.defaultAutonomy, 'edge');
    t.is(pkm.defaultAutonomy, DEFAULT_AUTONOMY);
});

test('defaults: `batchSize` i `timeoutMs` ZOSTAJĄ nieprowizjonowane (spec §4)', t => {
    const embedding = defaultSettings().pkmAssistant?.embedding ?? {};

    t.false('batchSize' in embedding);
    t.false('timeoutMs' in embedding);
    // Slice embeddingu jest kopią kontraktu modułu, nie własną, rozjeżdżającą się listą.
    t.deepEqual(Object.keys(embedding).sort(), Object.keys(DEFAULT_EMBEDDING_SETTINGS).sort());
});

test('statusBar i log wchodzą TYLKO wtedy, gdy wołacz je poda', t => {
    const bez = buildRuntimeConfig({ app });
    t.false('statusBar' in bez);
    t.false('log' in bez);

    const renderer = { render: () => ({}) as HTMLElement };
    const z = buildRuntimeConfig({ app, statusBar: renderer });
    t.is(z.statusBar, renderer);
});
