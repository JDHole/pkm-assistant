import test from 'ava';
import { formatToMarkdown, parseSessionFile } from './sessionParser.js';

/**
 * E1.8 regression (znaleziona przez smoke na żywym pluginie): odpowiedź agenta
 * zawierająca nagłówek "## Wyniki" rozjeżdżała restore sesji — parser brał go za
 * granicę wiadomości z rolą "wyniki", a API odrzucało żądanie
 * ("unknown variant 'wyniki'"). Do tego "## [object Object]" gdy rola nie była
 * stringiem.
 */

test('roundtrip: nagłówki markdown w treści NIE stają się rolami', t => {
    const messages = [
        { role: 'user', content: 'Znajdź notatki o wyspach' },
        { role: 'assistant', content: 'Szukam...\n## Wyniki\n- nic nie znalazłem\n## Wnioski\nBrak notatek.' },
    ];
    const md = formatToMarkdown(messages, { agent: 'jaskier' });
    const parsed = parseSessionFile(md);
    t.is(parsed.messages.length, 2);
    t.is(parsed.messages[1].role, 'assistant');
    t.true(parsed.messages[1].content.includes('## Wyniki'));
    t.true(parsed.messages[1].content.includes('## Wnioski'));
    // Porównanie z rolą SPOZA `SessionRole` jest sensem tego testu — typ mówi, że
    // takiej roli być nie może, a asercja pilnuje tego w runtime na starych plikach.
    t.false(parsed.messages.some(m => (m.role as string) === 'wyniki'));
});

test('roundtrip: treść cytująca "## User" nie tworzy fałszywej granicy', t => {
    const messages = [
        { role: 'assistant', content: 'Format sesji wygląda tak:\n## User\ntreść usera\n## Assistant\nodpowiedź' },
        { role: 'user', content: 'dzięki' },
    ];
    const md = formatToMarkdown(messages);
    const parsed = parseSessionFile(md);
    t.is(parsed.messages.length, 2);
    t.is(parsed.messages[0].role, 'assistant');
    t.true(parsed.messages[0].content.includes('## User'));
    t.is(parsed.messages[1].content, 'dzięki');
});

test('stary zatruty plik (bez escapowania) parsuje się bez wymyślonych ról', t => {
    const legacy = [
        '## Assistant',
        'Przeszukałem vault.',
        '## Wyniki',
        '- zero trafień',
        '## User',
        'spróbuj jeszcze raz',
    ].join('\n');
    const parsed = parseSessionFile(legacy);
    t.deepEqual(parsed.messages.map(m => m.role), ['assistant', 'user']);
    t.true(parsed.messages[0].content.includes('## Wyniki'));
    t.true(parsed.messages[0].content.includes('- zero trafień'));
});

test('rola-obiekt nie produkuje "## [object Object]" (zapis → system)', t => {
    const md = formatToMarkdown([{ role: {}, content: 'jakiś event' }]);
    t.false(md.includes('[object Object]'));
    const parsed = parseSessionFile(md);
    t.is(parsed.messages.length, 1);
    t.is(parsed.messages[0].role, 'system');
});

test('stary plik z "## [object Object]" nie wysypuje parsera', t => {
    const legacy = '## [object Object]\nsystem prompt treść\n## User\nhej';
    const parsed = parseSessionFile(legacy);
    t.deepEqual(parsed.messages.map(m => m.role), ['user']);
    t.is(parsed.messages[0].content, 'hej');
});

test('frontmatter + podsumowanie dalej działają po fixie', t => {
    const messages = [{ role: 'user', content: 'hej' }, { role: 'assistant', content: 'cześć' }];
    const md = formatToMarkdown(messages, { agent: 'jaskier', tokens_used: 42 }, 'Krótka rozmowa powitalna.');
    const parsed = parseSessionFile(md);
    t.is(parsed.metadata.agent, 'jaskier');
    t.is(parsed.metadata.tokens_used, 42);
    t.is(parsed.summary, 'Krótka rozmowa powitalna.');
    t.is(parsed.messages.length, 2);
});
