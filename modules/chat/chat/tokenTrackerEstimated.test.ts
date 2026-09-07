/**
 * tokenTrackerEstimated — strażnik OKABLOWANIA: TokenTracker.record('main', …) musi oznaczać
 * `{ estimated: true }`, gdy input/output tokenów pochodzi z FALLBACKU (brak `usage` z API),
 * a nie z pomiaru zwróconego przez model.
 *
 * Dlaczego test po ŹRÓDLE, a nie po zachowaniu: `chat_streaming.ts` wisi na `obsidian`
 * (import runtime'u wtyczki), więc AVA nie zaimportuje tego modułu — wzorzec taki sam jak
 * `chat_streaming.limits.test.ts` (fs.readFileSync + asercje na treści).
 *
 * Bug (risk register 2026-09-02 / S34 z8): `_chatOnUsage` przy braku `usage.prompt_tokens`
 * z API wołało `turn.tt.record('main', inputTokens, outputTokens)` BEZ meta — Token Viewer
 * pokazywał estymatę (turn.lastInputTokens, licznik znaków/token) jako pomiar realny.
 * Dwa dalsze wołania w `_chatBeforeContinue`/`_finalizeTurn` (gałąź `!turn.responseRecorded`,
 * ZAWSZE fallback: input z estymaty, output z lokalnego `countTokens`) miały tę samą wadę.
 */
import test from 'ava';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./chat_streaming.ts', import.meta.url), 'utf8');

/** Ciało funkcji `nazwa` — od nagłówka do następnego `export function`/`export async function`. */
function cialoFunkcji(naglowekRegex: RegExp): string {
    const head = naglowekRegex.exec(source);
    if (!head) return '';
    const rest = source.slice(head.index + head[0].length);
    const to = rest.search(/\nexport (?:async )?function /);
    return to < 0 ? rest : rest.slice(0, to);
}

const cialoOnUsage = () => cialoFunkcji(/export function _chatOnUsage\(/);
const cialoBeforeContinue = () => cialoFunkcji(/export async function _chatBeforeContinue\(/);
const cialoFinalizeTurn = () => cialoFunkcji(/export async function _finalizeTurn\(/);

test('_chatOnUsage: fallback input (brak prompt_tokens z API) oznacza estimated', t => {
    const body = cialoOnUsage();
    t.not(body, '', 'Nie znalazłem `_chatOnUsage` — zmienił się kształt hooka pętli.');

    t.regex(
        body,
        /const estimated = apiInput === 0 && inputTokens > 0;/,
        '`_chatOnUsage` przestało liczyć, czy input jest estymatą (apiInput===0) — Token Viewer znów pokaże fallback jako pomiar z API.',
    );
    t.regex(
        body,
        /turn\.tt\.record\('main',\s*inputTokens,\s*outputTokens,\s*\{\s*estimated\s*\}\)/,
        '`turn.tt.record(\'main\', …)` w `_chatOnUsage` przestało przekazywać `{ estimated }` — flaga liczona wyżej, ale nie dociera do TokenTrackera.',
    );
});

test('_chatBeforeContinue: fallback zapisu (onUsage nie zapisał) oznacza estimated:true', t => {
    // Blok jest zawsze fallbackiem (input z estymaty kontekstu, output z lokalnego countTokens),
    // więc flaga jest tu STAŁA `true`, nie warunkowa jak w _chatOnUsage.
    const body = cialoBeforeContinue();
    t.not(body, '', 'Nie znalazłem `_chatBeforeContinue` — zmienił się kształt hooka pętli.');

    t.regex(
        body,
        /if\s*\(!turn\.responseRecorded\)\s*\{[\s\S]*?turn\.tt\.record\('main',\s*inp,\s*out,\s*\{\s*estimated:\s*true\s*\}\)/,
        '`_chatBeforeContinue` przestało oznaczać fallback zapis tokenów jako `estimated: true` — Token Viewer pokaże estymatę output (countTokens lokalny) jako pomiar z API.',
    );
});

test('_finalizeTurn: fallback zapisu finalnej odpowiedzi oznacza estimated:true', t => {
    const body = cialoFinalizeTurn();
    t.not(body, '', 'Nie znalazłem `_finalizeTurn` — zmienił się kształt hooka pętli.');

    t.regex(
        body,
        /if\s*\(!turn\.responseRecorded\)\s*\{[\s\S]*?turn\.tt\.record\('main',\s*inp,\s*out,\s*\{\s*estimated:\s*true\s*\}\)/,
        '`_finalizeTurn` przestało oznaczać fallback zapis tokenów finalnej odpowiedzi jako `estimated: true`.',
    );
});

test('wszystkie trzy `record(\'main\', …)` w tym pliku niosą meta o estymacie', t => {
    const wywolania = source.match(/turn\.tt\.record\('main',[^)]*\)/g) || [];
    t.is(wywolania.length, 3, `Oczekiwano 3 wywołań record('main', …) w chat_streaming.ts, znaleziono ${wywolania.length} — sprawdź, czy nie doszło nowe bez meta.`);
    for (const w of wywolania) {
        t.regex(w, /estimated/, `Wywołanie \`${w}\` nie niesie flagi estimated.`);
    }
});
