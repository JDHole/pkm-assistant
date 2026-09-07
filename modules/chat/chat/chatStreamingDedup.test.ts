/**
 * AUD-code-review-017: `chat_streaming.ts` importuje `obsidian` (MarkdownRenderer, Notice) więc
 * AVA nie może zaimportować go wprost — strażnik czyta ŹRÓDŁO (wzór `turnOwner.test.ts`,
 * `stopSemantics.test.ts`).
 *
 * Dwie deduplikacje w tym pliku:
 *   1. Siedmiokrotnie skopiowany wzorzec „toolCall.arguments bywa stringiem JSON, sparsuj
 *      defensywnie" — dziś jedna funkcja `parseToolCallArgs`, wołana z 7 miejsc.
 *   2. `handle_chunk` powielało w całości ciało `_ensureAgentMessageContainer` — dziś woła je.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const source = readSource('./chat_streaming.ts');

test('parseToolCallArgs: dokładnie JEDNA definicja wzorca string→JSON.parse w try/catch (AUD-code-review-017)', t => {
    const pattern = /typeof toolCall\.arguments === 'string'/g;
    const matches = source.match(pattern) || [];
    t.is(matches.length, 1, `wzorzec parsowania toolCall.arguments powinien żyć w JEDNYM miejscu (parseToolCallArgs), znaleziono ${matches.length} kopii`);
});

test('parseToolCallArgs: wszystkie 7 dawnych call-site\'ów woła wspólny helper', t => {
    const calls = source.match(/parseToolCallArgs\(toolCall\)/g) || [];
    // 7 call-site'ów (_subArgs/_bgArgs/_saArgs/_saErrArgs/_saArgs2/readArgs/writeArgs).
    t.is(calls.length, 7, `oczekiwano 7 wywołań parseToolCallArgs(toolCall), znaleziono ${calls.length}`);
});

test('parseToolCallArgs: zachowanie identyczne ze starym inline wzorcem (string parsowalny/niepoprawny, obiekt, undefined)', t => {
    // Wyciągamy CIAŁO funkcji ze źródła i odpalamy je jako prawdziwy JS (plik ma zero zależności
    // od `this`/obsidian w tej funkcji, więc jest to bezpieczne i wierne oryginałowi).
    const start = source.indexOf('function parseToolCallArgs(');
    t.true(start > 0, 'nie znalazłem definicji parseToolCallArgs — zmieniła się nazwa?');
    const braceStart = source.indexOf('{', start);
    let depth = 1;
    let i = braceStart + 1;
    while (depth > 0 && i < source.length) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') depth--;
        i++;
    }
    const body = source.slice(braceStart + 1, i - 1);
    const parseToolCallArgs = new Function('toolCall', body) as (toolCall: unknown) => unknown;

    t.deepEqual(parseToolCallArgs({ arguments: '{"aspect":"researcher"}' }), { aspect: 'researcher' });
    t.deepEqual(parseToolCallArgs({ arguments: 'not json' }), {});
    t.deepEqual(parseToolCallArgs({ arguments: { path: 'a.md' } }), { path: 'a.md' });
    t.deepEqual(parseToolCallArgs({ arguments: undefined }), {});
    t.deepEqual(parseToolCallArgs({ arguments: null }), {});
});

test('handle_chunk deleguje budowę kontenera agenta do _ensureAgentMessageContainer, nie powiela ciała (AUD-code-review-017)', t => {
    const handleChunkStart = source.indexOf('export function handle_chunk');
    t.true(handleChunkStart > 0, 'nie znalazłem handle_chunk');
    const nextExport = source.indexOf('\nexport function', handleChunkStart + 1);
    const body = source.slice(handleChunkStart, nextExport > 0 ? nextExport : undefined);

    t.regex(body, /this\._ensureAgentMessageContainer\(streamAgent\)/, 'handle_chunk ma wołać wspólny helper zamiast budować kontener od zera');
    t.notRegex(body, /cs-tool-calls-wrapper/, 'ciało budowy kontenera (klasa cs-tool-calls-wrapper) nie powinno być powielone w handle_chunk');
    t.notRegex(body, /cs-message__agent-crystal/, 'ciało budowy nagłówka agenta nie powinno być powielone w handle_chunk');
});

test('_ensureAgentMessageContainer nadal istnieje jako jedyne źródło prawdy o budowie kontenera', t => {
    t.regex(source, /export function _ensureAgentMessageContainer\(this: ChatViewMixinContext, streamAgent: ChatViewMixinContext\)/);
    // Wołane też z _chatOnToolCallsParsed (tool calls bez poprzedzającego tekstu) i _finalizeTurn —
    // oba call-site'y muszą przeżyć dedup bez zmian.
    const calls = source.match(/this\._ensureAgentMessageContainer\(/g) || [];
    t.true(calls.length >= 3, `oczekiwano >=3 wołań _ensureAgentMessageContainer (handle_chunk + _chatOnToolCallsParsed + _finalizeTurn), znaleziono ${calls.length}`);
});
