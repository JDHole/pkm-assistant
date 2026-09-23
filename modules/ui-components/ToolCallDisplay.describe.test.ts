/**
 * `describeToolCall` — tytuł kafelka narzędzia PO LUDZKU (2.3.0, "Czat bez ścian"). Zero
 * technikaliów: żadnego surowego JSON-a wejścia, żadnej surowej nazwy narzędzia dla rozpoznanych
 * przypadków (`read`/`search`/`write`/`web_read`/...). Locale nietknięty (`setLocale` nigdzie w
 * tym pliku) — testuje się na domyślnym `'en'` (`core/i18n/index.ts`), literalne wartości
 * oczekiwane wprost w tekście testu, nie liczone przez `t()`.
 */
import test from 'ava';
import { describeToolCall } from './ToolCallDisplay.js';

test('read: sciezka po ludzku, bez JSON-a i bez surowej nazwy narzedzia w naglowku', t => {
    const result = describeToolCall('read', { path: 'Notes/Foo.md' });
    t.is(result, 'Read: Notes/Foo.md');
    t.false(result.includes('{'), 'zero JSON-a w nagłówku');
    t.false(result.includes('read'), 'zero surowej nazwy narzędzia (case-sensitive: "Read" po ludzku jest OK)');
});

test('vault_read (alias) z argumentami jako string JSON: sciezka skrocona do 2 ostatnich segmentow', t => {
    const result = describeToolCall('vault_read', JSON.stringify({ path: 'a/b/c.md' }));
    t.is(result, 'Read: …/b/c.md');
});

test('search: zapytanie po ludzku', t => {
    const result = describeToolCall('search', { query: 'projekt X' });
    t.is(result, 'Searched: projekt X');
});

test('vault_search (alias): ta sama grupa co search', t => {
    const result = describeToolCall('vault_search', { query: 'notatki' });
    t.is(result, 'Searched: notatki');
});

test('write: sciezka zapisu po ludzku', t => {
    const result = describeToolCall('write', { path: 'a/b/c.md' });
    t.is(result, 'Wrote: …/b/c.md');
});

test('list: folder po ludzku', t => {
    const result = describeToolCall('list', { folder: 'Projekty' });
    t.is(result, 'Listed: Projekty');
});

test('web_search: zapytanie po ludzku', t => {
    const result = describeToolCall('web_search', { query: 'pkm assistant' });
    t.is(result, 'Searched the web: pkm assistant');
});

test('web_read: adres bez protokolu', t => {
    const result = describeToolCall('web_read', { url: 'https://example.com/page' });
    t.is(result, 'Read page: example.com/page');
    t.false(result.includes('https://'), 'protokol zdjety z adresu');
});

test('todo/chat_todo: staly tytul, input ignorowany', t => {
    t.is(describeToolCall('todo', { action: 'create' }), 'Task list');
    t.is(describeToolCall('chat_todo', { action: 'list' }), 'Task list');
});

test('ask_user: staly tytul, tresc pytania NIE ląduje w naglowku', t => {
    const result = describeToolCall('ask_user', { question: 'Czy kontynuowac?' });
    t.is(result, 'Question for you');
    t.false(result.includes('Czy kontynuowac'));
});

test('nieznane narzedzie: uzyj + surowa nazwa (jedyna dostepna informacja)', t => {
    const result = describeToolCall('some_custom_tool', {});
    t.is(result, 'Used: some_custom_tool');
});

test('input niesparsowalny (nie-JSON string) nie wybucha, wraca pusta wartosc pola', t => {
    const result = describeToolCall('read', 'not-json-at-all{');
    t.is(result, 'Read: ');
});

test('brak inputu (undefined) nie wybucha', t => {
    t.is(describeToolCall('search', undefined), 'Searched: ');
    t.is(describeToolCall('todo', undefined), 'Task list');
});

/**
 * B1 fix (recenzja A1-fix, `repro.log`): trzy wejscia, ktore PRZED naprawa rzucaly wyjatek
 * (`TypeError: p.replace is not a function` / `data.url.replace is not a function` / `Cannot
 * read properties of null`) i walily cala ture czatu (`AgentLoop.ts`, brak try) oraz render
 * historii (`chat_messages.ts`, petla bez try). Kazde pole zlego typu jest teraz POMIJANE
 * (typeof !== 'string'), wiec tytul wraca bez tej wartosci zamiast wybuchac - wybrany wariant
 * literalny z dwoch dopuszczalnych przez spec ("generic albo bez sciezki").
 */
test('B1: path jako tablica nie wybucha - pole pominiete jak nieobecne', t => {
    const result = describeToolCall('read', { path: ['a.md', 'b.md'] });
    t.is(result, 'Read: ');
});

test('B1: url jako liczba (web_read) nie wybucha - pole pominiete jak nieobecne', t => {
    const result = describeToolCall('web_read', { url: 42 });
    t.is(result, 'Read page: ');
});

test('B1: input string "null" nie wybucha (JSON.parse("null") === null, nie {})', t => {
    const result = describeToolCall('read', 'null');
    t.is(result, 'Read: ');
});
