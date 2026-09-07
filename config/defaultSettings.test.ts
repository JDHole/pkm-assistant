/**
 * Strażnik fabrycznego worka ustawień (`defaultSettings()` + stałe B.14 SE-12/SE-13).
 *
 * Dwie stałe eksportowane z tego pliku mają realną, obserwowalną wartość liczbową —
 * to nie jest szczegół implementacji, tylko kontrakt: `maxTokens` i `temperature`
 * wchodzą wprost do worka, który leci do modeli czatu. Testy pinują te liczby
 * wprost (nie przez import stałej z powrotem do asercji — to byłoby tautologią,
 * która przeżyłaby zmianę wartości), żeby zmiana `4096` na cokolwiek innego
 * rozjechała się z resztą pluginu w sposób widoczny w tym pliku.
 */
import test from 'ava';

import { defaultSettings, DEFAULT_CHAT_MAX_TOKENS, DEFAULT_CHAT_TEMPERATURE } from './defaultSettings.js';

test('DEFAULT_CHAT_MAX_TOKENS jest dokładnie 4096 (legacy limit odpowiedzi, B.14 SE-13)', t => {
    t.is(DEFAULT_CHAT_MAX_TOKENS, 4096);
});

test('chat.maxTokens w worku fabrycznym jest dokładnie 4096, nie inną liczbą', t => {
    const pkm = defaultSettings().pkmAssistant ?? {};

    t.is(pkm.chat?.maxTokens, 4096);
});

test('DEFAULT_CHAT_TEMPERATURE jest dokładnie 0.7 (suwak w Ustawieniach, B.14 SE-12)', t => {
    t.is(DEFAULT_CHAT_TEMPERATURE, 0.7);
});

test('chat.temperature w worku fabrycznym jest dokładnie 0.7', t => {
    const pkm = defaultSettings().pkmAssistant ?? {};

    t.is(pkm.chat?.temperature, 0.7);
});

test('chat: apiKeys/models/hosts startują jako puste obiekty, platform jako pusty string', t => {
    const pkm = defaultSettings().pkmAssistant ?? {};

    t.deepEqual(pkm.chat?.apiKeys, {});
    t.deepEqual(pkm.chat?.models, {});
    t.deepEqual(pkm.chat?.hosts, {});
    t.is(pkm.chat?.platform, '');
});

test('każde wywołanie oddaje ŚWIEŻY obiekt najwyższego poziomu i świeże mapy chat', t => {
    const a = defaultSettings();
    const b = defaultSettings();

    t.not(a, b);
    t.not(a.pkmAssistant, b.pkmAssistant);
    t.not(a.pkmAssistant?.chat, b.pkmAssistant?.chat);
    t.not(a.pkmAssistant?.chat?.apiKeys, b.pkmAssistant?.chat?.apiKeys);
    t.not(a.pkmAssistant?.chat?.models, b.pkmAssistant?.chat?.models);
    t.not(a.pkmAssistant?.chat?.hosts, b.pkmAssistant?.chat?.hosts);
});

test('każde wywołanie oddaje świeże mapy embeddingu (models/apiKeys/hosts)', t => {
    const a = defaultSettings();
    const b = defaultSettings();

    t.not(a.pkmAssistant?.embedding, b.pkmAssistant?.embedding);
    t.not(a.pkmAssistant?.embedding?.models, b.pkmAssistant?.embedding?.models);
    t.not(a.pkmAssistant?.embedding?.apiKeys, b.pkmAssistant?.embedding?.apiKeys);
    t.not(a.pkmAssistant?.embedding?.hosts, b.pkmAssistant?.embedding?.hosts);
});
