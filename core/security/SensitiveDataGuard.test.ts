import test from 'ava';
import { containsSensitiveData, maskSensitiveData, warnIfSensitive } from './SensitiveDataGuard.js';

// ── containsSensitiveData ──

test('detects OpenAI key', t => {
    t.true(containsSensitiveData('My key is sk-abc123def456ghi789jkl012mno'));
});

test('detects Anthropic key', t => {
    t.true(containsSensitiveData('sk-ant-abc123def456ghi789jkl012'));
});

test('detects Google AI key', t => {
    t.true(containsSensitiveData('AIzaSyAbcdefghijklmnopqrstuvwxyz12345'));
});

test('detects AWS key', t => {
    t.true(containsSensitiveData('AKIAIOSFODNN7EXAMPLE'));
});

test('detects generic api_key=...', t => {
    t.true(containsSensitiveData('api_key=sk1234567890abcdefgh'));
});

test('detects password=...', t => {
    t.true(containsSensitiveData('password="mySuperSecret123"'));
});

test('normal text passes', t => {
    t.false(containsSensitiveData('To jest zwykła notatka o projekcie.'));
});

test('empty/null passes', t => {
    t.false(containsSensitiveData(''));
    t.false(containsSensitiveData(null));
});

// ── maskSensitiveData ──

test('masks OpenAI key in text', t => {
    const input = 'Key: sk-abc123def456ghi789jkl012mno';
    const result = maskSensitiveData(input);
    t.false(result.includes('abc123def456'));
    t.true(result.includes('***'));
});

test('leaves normal text unchanged', t => {
    const input = 'To jest zwykła notatka.';
    t.is(maskSensitiveData(input), input);
});

test('handles null/empty', t => {
    t.is(maskSensitiveData(''), '');
    t.is(maskSensitiveData(null), null);
});

// ── warnIfSensitive ──

test('returns warnings for sensitive text', t => {
    const { hasSensitive, warnings } = warnIfSensitive('api_key=secret1234567890ab');
    t.true(hasSensitive);
    t.true(warnings.length > 0);
});

test('no warnings for clean text', t => {
    const { hasSensitive, warnings } = warnIfSensitive('Zwykła notatka');
    t.false(hasSensitive);
    t.is(warnings.length, 0);
});

// ── K8 (AUD-security-027): maskowanie po NAZWIE pola/nagłówka + brakujące kształty ──

const TOKEN = 'abcdef0123456789xyzQWERTY';

test('K8: nagłówek Authorization: Bearer <token> nie zostaje jawny', t => {
    const result = maskSensitiveData(`Authorization: Bearer ${TOKEN}`);
    t.false(result.includes(TOKEN));
    t.true(result.includes('***'));
    // Ślad zostaje: schemat + pierwsze znaki (diagnostyka nadal działa).
    t.true(result.includes('Bearer'));
});

test('K8: JSON z nagłówkiem x-api-key nie zostaje jawny', t => {
    const result = maskSensitiveData(`{"x-api-key":"${TOKEN}"}`);
    t.false(result.includes(TOKEN));
    t.true(result.includes('x-api-key'));
});

test('K8: JSON z polami api_key / apiKey / token / secret / password', t => {
    for (const field of ['api_key', 'apiKey', 'openrouter_key', 'token', 'secret', 'password', 'Authorization']) {
        const result = maskSensitiveData(`{"model":"gpt-4","${field}":"${TOKEN}"}`);
        t.false(result.includes(TOKEN), `pole ${field} zostało jawne`);
        t.true(result.includes('gpt-4'), `pole ${field}: reszta JSON-a ma zostać nietknięta`);
    }
});

test('K8: nazwa pola jest bez znaczenia dla wielkości liter', t => {
    t.false(maskSensitiveData(`AUTHORIZATION: Bearer ${TOKEN}`).includes(TOKEN));
    t.false(maskSensitiveData(`X-Api-Key=${TOKEN}`).includes(TOKEN));
});

test('K8: api_key=... (forma tekstowa) nadal maskowane', t => {
    t.false(maskSensitiveData(`api_key=${TOKEN}`).includes(TOKEN));
});

test('K8: kształty OpenRouter / Groq / xAI', t => {
    const or = 'sk-or-v1-0123456789abcdef0123456789abcdef';
    const groq = 'gsk_0123456789abcdefABCDEF0123456789';
    const xai = 'xai-0123456789abcdefABCDEF0123456789';
    for (const key of [or, groq, xai]) {
        const result = maskSensitiveData(`Stream error: ${key} padł`);
        t.false(result.includes(key), `kształt ${key.slice(0, 6)} nie zamaskowany`);
        t.true(result.includes('***'));
    }
    t.true(containsSensitiveData(or));
    t.true(containsSensitiveData(groq));
    t.true(containsSensitiveData(xai));
});

test('K8: nowy klucz OpenAI (sk-proj-) też jest kształtem', t => {
    const key = 'sk-proj-0123456789abcdefABCDEF0123456789';
    t.false(maskSensitiveData(`key=${key}`).includes(key));
});

test('K8: maskowanie po nazwie nie zjada zwykłego tekstu ani krótkich wartości', t => {
    t.is(maskSensitiveData('To jest zwykła notatka o projekcie.'), 'To jest zwykła notatka o projekcie.');
    // Krótka wartość (poniżej progu sekretu) zostaje czytelna.
    t.is(maskSensitiveData('key: abc'), 'key: abc');
    // Pola bez sekretu w nazwie zostają nietknięte.
    t.is(maskSensitiveData('{"max_tokens":16384,"model":"deepseek-chat"}'), '{"max_tokens":16384,"model":"deepseek-chat"}');
});

test('K8: maskowanie jest idempotentne (drugi przebieg nic nie psuje)', t => {
    const once = maskSensitiveData(`Authorization: Bearer ${TOKEN}`);
    t.is(maskSensitiveData(once), once);
});

test('K8: maska po nazwie pola NIE łapie zwykłych słów kończących się na key/token', t => {
    const text = 'monkey: bananabanana\nturkey: pieczonyindyk\nhockey: superliga2026';
    t.is(maskSensitiveData(text), text);
});

// ─── K11 (AUD-security-028): weryfikacja, że K8 domknął JSON-ową drogę ───────────────────
//
// Znalezisko mówiło, że oba wzorce vendor-agnostyczne (`api_key`/`password`) wymagają nazwy
// BEZPOŚREDNIO przed `:` — a `JSON.stringify` wstawia tam cudzysłów, więc ogólna siatka nigdy
// nie odpalała na drodze obiektowej Loggera. K8 dołożył DRUGI filtr — po NAZWIE pola
// (`QUOTED_FIELD_RE`) — który tę samą wartość łapie niezależnie od kształtu. Ten test pilnuje,
// że droga JSON-owa zostaje zamknięta, gdyby ktoś kiedyś ruszył wzorce.

test('K11 028: maska łapie sekret w JSON-ie (pole w cudzysłowie), nie tylko w gołym tekście', t => {
    const jawny = maskSensitiveData('api_key: "SECRETVALUE123456"');
    t.false(jawny.includes('SECRETVALUE123456'), jawny);

    for (const json of [
        '{"api_key":"SECRETVALUE123456"}',
        '{"password":"hunter2hunter2"}',
        '{"apiKey":"SECRETVALUE123456"}',
        '{"x-api-key":"SECRETVALUE123456"}',
        '{"Authorization":"Bearer SECRETVALUE123456"}',
    ]) {
        const masked = maskSensitiveData(json);
        t.false(/SECRETVALUE123456|hunter2hunter2/.test(masked), `NIE zamaskowane: ${json} → ${masked}`);
        t.true(containsSensitiveData(json), `wykrywanie nie widzi sekretu w: ${json}`);
    }

    // Schemat autoryzacji zostaje czytelny — user ma widzieć, CO było, nie samą gwiazdkę.
    t.true(maskSensitiveData('{"Authorization":"Bearer SECRETVALUE123456"}').includes('Bearer'));
});

test('K11 028: zwykły tekst notatki NIE wpada pod maskę po nazwie pola', t => {
    t.is(maskSensitiveData('{"monkey":"banan i jeszcze wiecej"}'), '{"monkey":"banan i jeszcze wiecej"}');
    t.is(maskSensitiveData('{"max_tokens":"2048"}'), '{"max_tokens":"2048"}');
});

// ─── K20 (AUD-security-120/133): maska widzi też ZAESCAPOWANY JSON ──────────────────────
//
// Klucz nie ginie w jednej stringifikacji — ginie w DRUGIEJ. Gdy obiekt błędu wpadnie jako
// tekst do pola `message`, a to pole przejdzie przez `JSON.stringify` w Loggerze, nazwa
// nagłówka wygląda tak: `\"api-key\":\"…\"`. Filtry K8 dopasowywały cudzysłów tylko gołym,
// więc żaden z nich nie trafiał i klucz lądował jawny w pliku logu. Poniżej — obie warstwy
// zaescapowania i obie nazwy nagłówków, których używają nasze platformy.

/** Azure wysyła klucz w nagłówku `api-key` — goła wartość, bez rozpoznawalnego prefiksu. */
const AZURE_SECRET = 'AZURE123456789SECRET';
/** LM Studio / Custom / OpenRouter — `Bearer <token>` o kształcie, którego nie znamy. */
const BEARER_TOKEN = 'lmstudio-abc123def456ghi789';

test('K20: sekret w ZAESCAPOWANYM JSON-ie (Azure api-key) nie zostaje jawny', t => {
    const payload = JSON.stringify({ message: JSON.stringify({ headers: { 'api-key': AZURE_SECRET } }) });
    t.true(payload.includes('\\"api-key\\"'), 'fixture ma być zaescapowany');
    const masked = maskSensitiveData(payload);
    t.false(masked.includes(AZURE_SECRET), masked);
    t.true(masked.includes('api-key'), 'nazwa nagłówka zostaje — diagnostyka ma działać');
    t.true(containsSensitiveData(payload), 'wykrywanie też ma widzieć sekret w zaescapowanym JSON-ie');
});

test('K20: Bearer <token bez znanego kształtu> w zaescapowanym Authorization', t => {
    const payload = JSON.stringify({ message: JSON.stringify({ headers: { Authorization: `Bearer ${BEARER_TOKEN}` } }) });
    const masked = maskSensitiveData(payload);
    t.false(masked.includes(BEARER_TOKEN), masked);
    t.true(masked.includes('Bearer'), 'schemat autoryzacji zostaje czytelny');
});

test('K20: Bearer <token bez znanego kształtu> w gołym nagłówku i w zwykłym JSON-ie', t => {
    t.false(maskSensitiveData(`Authorization: Bearer ${BEARER_TOKEN}`).includes(BEARER_TOKEN));
    t.false(maskSensitiveData(`{"Authorization":"Bearer ${BEARER_TOKEN}"}`).includes(BEARER_TOKEN));
    t.false(maskSensitiveData(`{"api-key":"${AZURE_SECRET}"}`).includes(AZURE_SECRET));
});

test('K20: DWIE warstwy zaescapowania (stringify po stringify) też są łapane', t => {
    const once = JSON.stringify({ headers: { 'x-api-key': AZURE_SECRET } });
    const thrice = JSON.stringify({ message: JSON.stringify({ message: once }) });
    t.regex(thrice, /\\{3}"x-api-key\\{3}"/, 'fixture ma mieć podwójne zaescapowanie');
    t.false(maskSensitiveData(thrice).includes(AZURE_SECRET), maskSensitiveData(thrice));
});

test('K20: maska zaescapowanego JSON-a jest idempotentna', t => {
    const payload = JSON.stringify({ message: JSON.stringify({ headers: { 'api-key': AZURE_SECRET, Authorization: `Bearer ${BEARER_TOKEN}` } }) });
    const once = maskSensitiveData(payload);
    t.is(maskSensitiveData(once), once);
});

test('K20: zaescapowany zwykły tekst NIE wpada pod maskę', t => {
    const plain = JSON.stringify({ message: JSON.stringify({ monkey: 'banan i jeszcze wiecej', max_tokens: '2048' }) });
    t.is(maskSensitiveData(plain), plain);
});
