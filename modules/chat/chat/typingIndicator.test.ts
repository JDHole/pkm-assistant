/**
 * Wskaźnik pisania (spec E, "Czat bez ścian" 2.3.0) - trzy kropki `.cs-typing__dot` obok
 * kryształu i tekstu statusu, animowane czystym CSS (`@keyframes csTypingDots`,
 * `modules/chat/chat_view.css`), zero timera JS.
 *
 * `chat_ui.ts` importuje `../chat_view.css` z atrybutem `with { type: 'css' }` (nagłówek
 * pliku) - loader AVA/tsx nie zna atrybutów importu CSS i pada `ERR_UNKNOWN_FILE_EXTENSION`
 * zanim dojdzie do jakiegokolwiek `test()`. Ta sama granica, co `profile_advanced.ts`
 * (`modules/agents/CLAUDE.md`, gotcha "profile_advanced.ts nie wstaje w AVA wcale") - u nas
 * zmierzone wprost na tej gałęzi: `await import('./chat_ui.js')` w AVA rzuca dokładnie ten
 * wyjątek (`TypeError: Unknown file extension ".css" for .../chat_view.css`). `showTypingIndicator`
 * na sfabrykowanym `this` więc się nie da odpalić - zostaje strażnik PO ŹRÓDLE (wzór
 * `modules/agents/AgentManager.test.ts`), a realne wywołanie idzie do `test.skip` z powodem.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Ciało `export function <name>(...) { ... }` - liczy nawiasy klamrowe, żeby złapać CAŁE ciało. */
function methodBodyOf(src: string, name: string): string {
    const head = new RegExp(`\\n\\s*export function ${name}\\([^)]*\\)[^{]*\\{`).exec(src);
    if (!head) return '';
    let depth = 1;
    let i = head.index + head[0].length;
    const start = i;
    while (depth > 0 && i < src.length) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
    }
    return src.slice(start, i - 1);
}

const source = readSource('./chat_ui.ts');

test('showTypingIndicator tworzy kontener trzech kropek .cs-typing__dot obok kryształu i tekstu (strażnik po źródle)', t => {
    const body = methodBodyOf(source, 'showTypingIndicator');
    t.true(body.length > 0, 'nie znalazłem showTypingIndicator w chat_ui.ts - zmieniła się sygnatura?');

    t.regex(body, /createDiv\(\{\s*cls:\s*'cs-typing__dots'\s*\}\)/,
        'brak kontenera .cs-typing__dots (obok .cs-typing__crystal i .cs-typing__text)');

    const dotMatches = body.match(/createSpan\(\{\s*cls:\s*'cs-typing__dot'\s*\}\)/g) || [];
    t.is(dotMatches.length, 3, 'mają być DOKŁADNIE trzy kropki .cs-typing__dot');

    t.notRegex(body, /setInterval|setTimeout/,
        'animacja kropek ma być czysto CSS (@keyframes csTypingDots) - zero timera JS w showTypingIndicator');

    // Kryształ nadal pulsuje jak dziś - nie ruszony przez tę zmianę.
    t.regex(body, /createDiv\(\{\s*cls:\s*'cs-typing__crystal'\s*\}\)/);
});

test('updateTypingStatus dalej aktualizuje tekst statusu narzędzia bez zmian', t => {
    const body = methodBodyOf(source, 'updateTypingStatus');
    t.true(body.length > 0, 'nie znalazłem updateTypingStatus w chat_ui.ts - zmieniła się sygnatura?');
    t.regex(body, /this\.typingStatusEl\.textContent\s*=\s*statusText/);
});

test.skip('showTypingIndicator() na atrapie widoku tworzy element z 3 .cs-typing__dot - ' +
    'skip: import chat_ui.js w AVA rzuca ERR_UNKNOWN_FILE_EXTENSION na "../chat_view.css" ' +
    '(with { type: "css" }), ta sama granica co profile_advanced.ts (measured na tej gałęzi)', t => {
    t.pass();
});
