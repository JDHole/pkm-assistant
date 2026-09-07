/**
 * K20b (AUD-security-132, część czatowa) — okno rozmowy pokazuje ZAMASKOWANY tekst błędu.
 *
 * `handle_error` wstawiał `error.message` wprost do DOM-u. Na sieciowym padzie strumienia ta
 * wiadomość bywa zrzutem całego zdarzenia streamera razem z `source.headers.Authorization`,
 * czyli surowym kluczem API. Źródło domyka osobna naprawa — tu pilnujemy ZLEWU.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { safeErrorText, CHAT_ERROR_TEXT_LIMIT } from './safeErrorText.js';

const KEY = 'sk-proj-AbCdEf0123456789AbCdEf0123456789';

// ── maskowanie ──

test('nagłówek Authorization z kluczem NIE wychodzi do okna rozmowy', t => {
    const out = safeErrorText(new Error(`Stream failed: {"source":{"headers":{"Authorization":"Bearer ${KEY}"}}}`));
    t.false(out.includes(KEY), out);
    t.true(out.includes('Stream failed'), 'opis błędu zostaje czytelny');
});

test('pole api_key w zrzucie zdarzenia jest maskowane', t => {
    const out = safeErrorText(`{"model":"deepseek-chat","api_key":"${KEY}"}`);
    t.false(out.includes(KEY), out);
});

test('goły klucz w tekście błędu jest maskowany', t => {
    t.false(safeErrorText(new Error(`Request failed for ${KEY}`)).includes(KEY));
});

test('obiekt bez pola message (surowe zdarzenie streamera) też przechodzi przez maskę', t => {
    const out = safeErrorText({ status: 401, source: { headers: { Authorization: `Bearer ${KEY}` } } });
    t.false(out.includes(KEY), out);
    t.true(out.includes('401'));
});

// ── normalizacja ──

test('zwykły błąd bez sekretów zostaje nietknięty', t => {
    t.is(safeErrorText(new Error('Chat model not configured.')), 'Chat model not configured.');
    t.is(safeErrorText('Timeout po 120 s'), 'Timeout po 120 s');
});

test('brak treści = pusty string (wołający daje własny fallback)', t => {
    t.is(safeErrorText(null), '');
    t.is(safeErrorText(undefined), '');
    t.is(safeErrorText(new Error('')), '');
    t.is(safeErrorText({}), '');
});

test('cyklicznego obiektu nie da się zserializować — i to nie wywraca czatu', t => {
    const cyclic: Record<string, unknown> = { status: 500 };
    cyclic.self = cyclic;
    t.notThrows(() => safeErrorText(cyclic));
});

// ── sufit długości ──

test('kilobajtowy zrzut zdarzenia jest ucinany', t => {
    const out = safeErrorText('x'.repeat(CHAT_ERROR_TEXT_LIMIT * 3));
    t.is(out.length, CHAT_ERROR_TEXT_LIMIT + 1, 'sufit + znak wielokropka');
    t.true(out.endsWith('…'));
});

test('własny sufit jest respektowany', t => {
    t.is(safeErrorText('abcdefghij', { limit: 4 }), 'abcd…');
});

// ── Strażnik PO ŹRÓDLE ──
// `chat_streaming.ts` ciągnie `obsidian`, więc `handle_error` nie wstaje w AVA.

const streamingSource = readFileSync(fileURLToPath(new URL('./chat_streaming.ts', import.meta.url)), 'utf8');

/** Kod bez komentarzy — strażnik pilnuje WYWOŁAŃ, nie opisów wady w komentarzach. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function handleErrorBody(): string {
    const from = streamingSource.indexOf('export function handle_error');
    const to = streamingSource.indexOf('_onStreamStall —', from);
    return stripComments(streamingSource.slice(from, to));
}

test('handle_error nie wstawia surowego error.message do DOM-u', t => {
    const body = handleErrorBody();
    t.true(body.length > 0, 'nie znalazłem handle_error w źródle');
    t.false(/error\.message/.test(body), 'surowy error.message w oknie rozmowy = powrót AUD-security-132');
    t.regex(body, /safeErrorText\(error\)/);
});

test('log błędu tury też idzie przez maskę', t => {
    // catch w `send_message` + `log.error` w `handle_error` — Logger pisze też do pliku.
    t.notRegex(streamingSource, /log\.error\('Chat',[^)]*,\s*error\)/);
    t.is((streamingSource.match(/log\.error\('Chat',[^)]*safeErrorText\(error\)\)/g) || []).length, 2);
});
