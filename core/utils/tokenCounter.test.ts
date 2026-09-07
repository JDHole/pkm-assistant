import test from 'ava';
import {
    countTokens,
    countTokensSimple,
    getTokenCount,
    calibrate,
    getCalibratedCharsPerToken,
    resetCalibration,
    countTokensFromStats,
    countNonAsciiChars,
} from './tokenCounter.js';

const SAMPLE = 'The quick brown fox jumps over the lazy dog. ' +
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';

// Kalibracja jest globalna (in-memory) — reset przed każdym testem, żeby
// przypadki się nie nakładały.
test.beforeEach(() => resetCalibration());

test('countTokens returns positive count fewer than chars', t => {
    const n = countTokens(SAMPLE);
    t.true(n > 0);
    t.true(n < SAMPLE.length);
});

test('countTokens empty/null/undefined returns 0', t => {
    t.is(countTokens(''), 0);
    t.is(countTokens(null), 0);
    t.is(countTokens(undefined), 0);
});

test('countTokensSimple uses 4-char approximation (no margin)', t => {
    t.is(countTokensSimple('1234'), 1);
    t.is(countTokensSimple('12345678'), 2);
    t.is(countTokensSimple(''), 0);
});

test('countTokens applies safety margin over the raw 4-char baseline', t => {
    // ASCII text, no calibration → base cpt 4.0; countTokens dokłada margines ×1,2,
    // więc MUSI być większe niż surowe znaki/4 (countTokensSimple).
    const simple = countTokensSimple(SAMPLE);
    const withMargin = countTokens(SAMPLE);
    t.true(withMargin > simple, `expected margin overshoot: ${withMargin} > ${simple}`);
});

test('non-ASCII text estimates MORE tokens than same-length ASCII', t => {
    const ascii = 'a'.repeat(120);
    const polish = 'ą'.repeat(120); // diakrytyki: mniej znaków na token
    t.is(ascii.length, polish.length);
    t.true(countTokens(polish) > countTokens(ascii),
        `non-ASCII should bump tokens: ${countTokens(polish)} > ${countTokens(ascii)}`);
});

test('platform option is accepted and produces a positive estimate', t => {
    const a = countTokens(SAMPLE, { platform: 'anthropic' });
    const b = countTokens(SAMPLE, { platform: 'openai' });
    t.true(a > 0);
    t.true(b > 0);
});

test('legacy string model arg is accepted (backward compat, ignored)', t => {
    // Stare wywołania countTokens(text, 'gpt-4') muszą przeżyć — string → default cpt.
    const n = countTokens(SAMPLE, 'gpt-4');
    t.is(n, countTokens(SAMPLE));
});

test('calibrate moves chars-per-token toward observed value (EMA)', t => {
    t.is(getCalibratedCharsPerToken('openai'), 4.0); // default, świeży start
    // Obserwacja: 200 znaków = 100 tokenów → 2.0 chars/token.
    calibrate('openai', 100, 200);
    // EMA: 4.0 + 0.2*(2.0 - 4.0) = 3.6
    t.true(Math.abs(getCalibratedCharsPerToken('openai') - 3.6) < 1e-9);
    // Kolejna ta sama obserwacja zbliża dalej do 2.0.
    calibrate('openai', 100, 200);
    t.true(getCalibratedCharsPerToken('openai') < 3.6);
});

test('calibration with lower chars-per-token raises the estimate', t => {
    const before = countTokens(SAMPLE, { platform: 'xai' });
    calibrate('xai', 100, 200); // cpt 4.0 → 3.6 (mniej znaków/token = więcej tokenów)
    const after = countTokens(SAMPLE, { platform: 'xai' });
    t.true(after > before, `after calibration estimate should rise: ${after} > ${before}`);
});

test('calibrate is per-platform and does not leak across NAMED platforms', t => {
    calibrate('openai', 100, 200);
    t.true(getCalibratedCharsPerToken('openai') < 4.0);
    t.is(getCalibratedCharsPerToken('ollama'), 4.0); // nazwana, nietknięta → default
});

test('platform-less estimate uses global calibration (RollingWindow path)', t => {
    // RollingWindow/ToolTokenCache wołają countTokens/getTokenCount BEZ platformy —
    // kalibracja z API musi tam dotrzeć globalnym kanałem, inaczej P2 jest martwe.
    const before = countTokens(SAMPLE); // brak platformy → global cpt (default 4.0)
    calibrate('anthropic', 100, 200);   // gęstszy tekst → niższy cpt → więcej tokenów
    const after = countTokens(SAMPLE);  // brak platformy → global cpt już niższy
    t.true(after > before, `global calibration should reach platform-less estimate: ${after} > ${before}`);
    // Izolacja nazwanych platform nadal trzyma: nietknięta platforma = default.
    t.is(getCalibratedCharsPerToken('ollama'), 4.0);
});

test('calibrate clamps absurd observations into a realistic range', t => {
    // 1 token na 1000 znaków = 1000 cpt → clamp do 20 przed EMA.
    calibrate('deepseek', 1, 1000);
    // EMA na sklampowanym 20: 4.0 + 0.2*(20-4) = 7.2 (a NIE ~203).
    t.true(Math.abs(getCalibratedCharsPerToken('deepseek') - 7.2) < 1e-9);
});

test('calibrate ignores garbage input (no platform / zero / negative)', t => {
    calibrate('', 100, 200);
    calibrate('gemini', 0, 200);
    calibrate('gemini', 100, 0);
    calibrate('gemini', -5, 200);
    t.is(getCalibratedCharsPerToken('gemini'), 4.0); // wciąż default
});

test('getTokenCount never throws and matches countTokens for strings', t => {
    const n = getTokenCount(SAMPLE);
    t.true(n > 0);
    t.is(n, countTokens(SAMPLE));
    t.is(getTokenCount(''), 0);
});

// ── AUD-wydajnosc-017/048: estymata ze STATYSTYK tekstu ────────────────────
// Kontrakt: `countTokensFromStats(len, nonAscii)` daje DOKŁADNIE to samo co
// `countTokens(tekst)` o tych statystykach — na tym stoi przyrostowy licznik okna
// kontekstu czatu (`modules/chat/chat/RollingWindow.ts`).

test('countTokensFromStats == countTokens dla tego samego materiału', t => {
    const samples = [
        SAMPLE,
        'ĄĆĘŁŃÓŚŹŻ ąćęłńóśźż – tekst z diakrytykami i myślnikiem',
        'テキスト 日本語 mixed with ASCII 12345',
        'x',
        'a'.repeat(10000),
        'ż'.repeat(5000) + 'plain ascii tail'.repeat(100),
    ];
    for (const text of samples) {
        t.is(countTokensFromStats(text.length, countNonAsciiChars(text)), countTokens(text), text.slice(0, 24));
    }
});

test('statystyki są ADDYTYWNE — suma kawałków = całość (baza licznika przyrostowego)', t => {
    const parts = ['prompt systemowy ', 'wiadomość usera ąę ', 'wynik narzędzia '.repeat(50), '日本語'];
    const whole = parts.join('');
    let chars = 0;
    let nonAscii = 0;
    for (const part of parts) {
        chars += part.length;
        nonAscii += countNonAsciiChars(part);
    }
    t.is(chars, whole.length);
    t.is(nonAscii, countNonAsciiChars(whole));
    t.is(countTokensFromStats(chars, nonAscii), countTokens(whole));
});

test('countTokensFromStats zachowuje kalibrację i pusty materiał', t => {
    t.is(countTokensFromStats(0, 0), 0);
    t.is(countTokensFromStats(-5, 0), 0);
    const before = countTokensFromStats(4000, 0, { platform: 'testowa' });
    calibrate('testowa', 2000, 4000); // 2 znaki/token → więcej tokenów niż default 4
    const after = countTokensFromStats(4000, 0, { platform: 'testowa' });
    t.true(after > before);
    t.is(after, countTokens('a'.repeat(4000), { platform: 'testowa' }));
});
