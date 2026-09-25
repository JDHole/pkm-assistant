/**
 * SensitiveDataGuard — wykrywanie i maskowanie wrażliwych danych (klucze API, hasła).
 * Chroni przed wyciekiem kluczy w snippetach, logach i odpowiedziach narzędzi.
 */

/**
 * Wzorce kluczy API i wrażliwych danych - maskowanie po KSZTAŁCIE wartości.
 * `sk-` przyjmuje też myślniki i podkreślenia, więc jednym wzorcem łapiemy `sk-proj-`
 * (OpenAI) i `sk-or-v1-` (OpenRouter); dołożone są też osobne kształty Groq (`gsk_`)
 * i xAI (`xai-`), które plugin ma w ustawieniach.
 */
const SENSITIVE_PATTERNS = [
    { name: 'OpenAI', regex: /\bsk-[A-Za-z0-9_-]{20,}/g },
    { name: 'OpenRouter', regex: /\bsk-or-v1-[A-Za-z0-9_-]{16,}/g },
    { name: 'Groq', regex: /\bgsk_[A-Za-z0-9]{20,}/g },
    { name: 'xAI', regex: /\bxai-[A-Za-z0-9_-]{20,}/g },
    { name: 'Anthropic', regex: /\bsk-ant-[A-Za-z0-9-]{20,}/g },
    { name: 'Google AI', regex: /\bAIza[A-Za-z0-9\-_]{30,}/g },
    { name: 'AWS', regex: /\bAKIA[A-Z0-9]{12,}/g },
    { name: 'DeepSeek', regex: /\bsk-[a-f0-9]{32,}/g },
    { name: 'Generic API Key', regex: /(?:api[_-]?key|api[_-]?secret|api[_-]?token)\s*[:=]\s*["']?([A-Za-z0-9\-_]{16,})["']?/gi },
    { name: 'Generic Secret', regex: /(?:secret|password|passwd|token)\s*[:=]\s*["']?([^\s"']{8,})["']?/gi },
];

/**
 * Maskowanie po NAZWIE pola/nagłówka - drugi, niezależny filtr obok kształtów.
 * Kształt zawodzi przy każdym dostawcy, którego nie znamy (i przy `Bearer <cokolwiek>`),
 * więc wartość pola o wrażliwej nazwie maskujemy NIEZALEŻNIE od tego, jak wygląda.
 * Dopasowanie idzie po CAŁEJ nazwie pola (kotwice `^...$`), bez względu na wielkość liter,
 * więc `max_tokens` (liczba mnoga) ani `prompt_tokens` nie łapią się przypadkiem.
 */
// Generyczne słowa (`key`, `token`, `secret`, `password`, `cookie`) liczą się TYLKO jako osobny
// człon: całe pole (`token`, `cookie`), po separatorze (`api_key`, `x-api-key`, `set-cookie`)
// albo w camelCase (`apiKey`). Inaczej `monkey: ...` czy `turkey: ...` w zwykłej notatce szłoby
// pod maskę. `cookie`/`set-cookie` łapie nagłówek `Set-Cookie` odbity przez proxy w treści błędu
// dostawcy - bez tego token sesji wychodził jawny w logu (bug B1: `details` w `errorUtils.ts`
// zostaje CELOWO surowym obiektem i to WYŁĄCZNIE ta maska po nazwie pola go osłania).
const SENSITIVE_KEY_RE = /^(?:[a-z0-9_.-]*(?:authorization|apikey)|(?:[a-z0-9_.-]*[_.-])?(?:key|token|secret|password|passwd|passphrase|cookie))$/i;
/** camelCase — osobno, bo tu wielkość liter niesie granicę członu (`apiKey` tak, `monkey` nie,
 * `setCookie` tak, `cookiePolicy` nie — dopasowanie jest na SUFIKSIE, więc pole opisujące
 * politykę ciasteczek, a nie niosące ich wartość, zostaje czytelne). */
const SENSITIVE_CAMEL_RE = /^[A-Za-z0-9_.-]*[a-z0-9](?:Key|Token|Secret|Password|Passphrase|Cookie)$/;

/** Poniżej tej długości wartość nie jest traktowana jak sekret (chroni zwykły tekst). */
const MIN_SECRET_VALUE_LENGTH = 8;

/** `"pole": "wartość"` — JSON i literały obiektów (klucz w cudzysłowie). */
const QUOTED_FIELD_RE = /(["'])([A-Za-z0-9_.-]{1,64})\1(\s*:\s*)(["'])([^"']*)\4/g;

/**
 * `Authorization: Bearer xxx`, `api_key=xxx`, `x-api-key: xxx` — nagłówki i goły tekst.
 *
 * Wartość NIE wyklucza `]` - inaczej token `[REDACTED]` (redakcja po wartości uruchomiona
 * WCZEŚNIEJ, `redactSecretValues` w `core/utils/errorUtils.ts`) łapałby się jako `[REDACTED`
 * bez zamykającego nawiasu, a ewentualny sekret doklejony BEZPOŚREDNIO po nim bez separatora
 * (`token=[REDACTED]hunter2hunter2`) zostawałby całkiem poza dopasowaniem - i jawny. Z `]`
 * w dozwolonych znakach oba przypadki łapie JEDNO dopasowanie: sam token (nic po nim) trafia
 * do `_maskValue` w całości i JEST rozpoznawany przez guard tokenu niżej; token ze sklejonym
 * ogonem trafia tam też w całości, ale ogon sprawia, że guard (dopasowanie DOKŁADNE) nie
 * odpala i cała wartość dostaje zwykłą maskę.
 */
const BARE_FIELD_RE = /\b([A-Za-z][A-Za-z0-9_.-]{0,63})(\s*[:=]\s*)(["']?)((?:bearer|basic|token)\s+)?([^\s"',;)}]{8,})/gi;

/**
 * Ta sama para `pole: wartość`, ale w JSON-ie ZAESCAPOWANYM -
 * `\"api-key\":\"…\"` (jedna stringifikacja za dużo) albo `\\\"api-key\\\"` (dwie).
 *
 * Skąd się to bierze: obiekt błędu wpada jako TEKST do pola `message`, a to pole przechodzi
 * przez `JSON.stringify` w Loggerze. Wtedy cudzysłowy wokół nazwy pola są poprzedzone
 * backslashami i `QUOTED_FIELD_RE` (który wymaga gołego cudzysłowu) nie trafia - klucz
 * lądowałby jawny w pliku logu.
 *
 * To ŚWIADOMIE trzeci, osobny przebieg zamiast rozluźnienia dwóch poprzednich: tamte trzymają
 * istniejące testy i nie ma powodu ruszać ich kształtu. `(\\+)` z backreferencją `\1` wymaga
 * tej samej głębokości zaescapowania we wszystkich czterech miejscach - dokładnie tak, jak
 * produkuje ją `JSON.stringify`. Wartość bez cudzysłowów i backslashy: sekrety (`Bearer …`,
 * klucze) takich znaków nie mają, a backslashe muszą zostać w grupie zamykającej, żeby
 * odtworzenie tekstu było wierne co do znaku.
 */
const ESCAPED_FIELD_RE = /(\\+)(["'])([A-Za-z0-9_.-]{1,64})\1\2(\s*:\s*)\1\2([^"'\\]*)\1\2/g;

/** Szybki pre-check: bez zaescapowanego cudzysłowa trzeci przebieg nie ma czego szukać. */
function _hasEscapedQuote(text: string): boolean {
    return text.includes('\\"') || text.includes("\\'");
}

function _isSensitiveKeyName(name: string): boolean {
    const n = name.trim();
    return SENSITIVE_KEY_RE.test(n) || SENSITIVE_CAMEL_RE.test(n);
}

/** Maskuje wartość, zostawiając schemat autoryzacji (`Bearer`/`Basic`) czytelnym. */
function _maskSecretValue(value: string): string {
    const scheme = /^(bearer|basic|token)(\s+)([\s\S]+)$/i.exec(value);
    if (scheme) return `${scheme[1]}${scheme[2]}${_maskValue(scheme[3])}`;
    return _maskValue(value);
}

/** Trzy przebiegi po nazwie pola: forma JSON, forma zaescapowana, forma nagłówka/tekstu. */
function _maskSensitiveFields(text: string): string {
    QUOTED_FIELD_RE.lastIndex = 0;
    let masked = text.replace(QUOTED_FIELD_RE, (match: string, kq: string, name: string, sep: string, vq: string, value: string) => {
        if (!_isSensitiveKeyName(name) || String(value).length < MIN_SECRET_VALUE_LENGTH) return match;
        return `${kq}${name}${kq}${sep}${vq}${_maskSecretValue(String(value))}${vq}`;
    });
    if (_hasEscapedQuote(masked)) {
        ESCAPED_FIELD_RE.lastIndex = 0;
        masked = masked.replace(ESCAPED_FIELD_RE, (match: string, esc: string, quote: string, name: string, sep: string, value: string) => {
            if (!_isSensitiveKeyName(name) || String(value).length < MIN_SECRET_VALUE_LENGTH) return match;
            const q = `${esc}${quote}`;
            return `${q}${name}${q}${sep}${q}${_maskSecretValue(String(value))}${q}`;
        });
    }
    BARE_FIELD_RE.lastIndex = 0;
    masked = masked.replace(BARE_FIELD_RE, (match: string, name: string, sep: string, quote: string, scheme: string | undefined, value: string) => {
        if (!_isSensitiveKeyName(name)) return match;
        return `${name}${sep}${quote}${scheme || ''}${_maskValue(String(value))}`;
    });
    return masked;
}

/** Czy w tekście stoi pole o wrażliwej nazwie z wartością długości sekretu. */
function _hasSensitiveField(text: string): boolean {
    return _maskSensitiveFields(text) !== text;
}

/**
 * Check if text contains sensitive data.
 * @param text - `unknown`, bo strażnik dostaje treści z narzędzi/logów bez gwarancji typu
 *   i sam odsiewa nie-stringi (`typeof`).
 */
export function containsSensitiveData(text: unknown): boolean {
    if (!text || typeof text !== 'string') return false;
    if (SENSITIVE_PATTERNS.some(p => { p.regex.lastIndex = 0; return p.regex.test(text); })) return true;
    return _hasSensitiveField(text);
}

/**
 * Mask sensitive data in text.
 * "sk-Tq1234567890abcdef" → "sk-T***cdef"
 *
 * Dwie sygnatury, bo funkcja realnie ma dwa zachowania (test tego pilnuje):
 * string wchodzi → zamaskowany string wychodzi; cokolwiek innego (null, obiekt)
 * PRZELATUJE NIETKNIĘTE — dlatego druga sygnatura nie obiecuje stringa.
 * @param text
 * @returns text with sensitive values masked
 */
export function maskSensitiveData(text: string): string;
export function maskSensitiveData(text: unknown): unknown;
export function maskSensitiveData(text: unknown): unknown {
    if (!text || typeof text !== 'string') return text;

    let masked = text;
    for (const pattern of SENSITIVE_PATTERNS) {
        // Reset regex lastIndex (global flag)
        pattern.regex.lastIndex = 0;
        // Kształty bez prefiksu (`sk-…`, `AIza…`…) NIE mają grupy - cały match JEST sekretem.
        // `Generic API Key`/`Generic Secret` MAJĄ grupę (sama wartość, bez `pole:`/`pole=`) -
        // maskujemy TYLKO ją, zostawiając prefiks (nazwę pola i separator) czytelnym, tak samo
        // jak robi to drugi filtr niżej (`_maskSensitiveFields`). Bez tego rozróżnienia guard
        // tokenu w `_maskValue` dostawałby CAŁY match (`token=[REDACTED]`), nie sam token, i
        // nigdy by go nie rozpoznał jako już bezpiecznego.
        masked = masked.replace(pattern.regex, (match: string, group1: unknown) => {
            // Zamiennik jako FUNKCJA, nie string: `String.replace` ze stringiem interpretuje
            // wzorce `$&`, `$1`, `` $` `` i `$'` w tekscie zamiennika - sekret zawierajacy `$&`
            // wracalby w calosci do wyniku zamiast maski.
            if (typeof group1 === 'string' && group1) return match.replace(group1, () => _maskValue(group1));
            return _maskValue(match);
        });
    }
    // Drugi filtr - po nazwie pola. Idzie PO kształtach i jest idempotentny
    // (zamaskowana wartość `abcd***wxyz` przepuszczona ponownie daje samą siebie).
    return _maskSensitiveFields(masked);
}

/**
 * Check and return warnings about sensitive data.
 * @param text - patrz uwaga przy `containsSensitiveData`
 */
export function warnIfSensitive(text: unknown): { hasSensitive: boolean; warnings: string[] } {
    if (!text || typeof text !== 'string') return { hasSensitive: false, warnings: [] };

    const warnings: string[] = [];
    for (const pattern of SENSITIVE_PATTERNS) {
        pattern.regex.lastIndex = 0;
        if (pattern.regex.test(text)) {
            warnings.push(`Wykryto potencjalny klucz: ${pattern.name}`);
        }
    }
    // Pole o wrażliwej nazwie (Authorization / api_key / token / secret / *_key).
    if (_hasSensitiveField(text)) warnings.push('Wykryto pole z sekretem (nazwa pola/nagłówka)');
    return { hasSensitive: warnings.length > 0, warnings };
}

/**
 * Mask a single sensitive value.
 *
 * Wartość, która JEST DOKŁADNIE tokenem `[REDACTED]` (redakcja po wartości, `redactSecretValues`
 * w `core/utils/errorUtils.ts`, uruchomiona wcześniej na tym samym tekście), wraca bez zmian -
 * inaczej maska po nazwie pola dopasowuje się do samego tokenu (`"bad key: [REDACTED]"` czyta
 * `key:` jako wrażliwe pole) i zamienia go w `[RED***CTED]`, czyli DRUGI raz maskuje coś, co już
 * jest bezpieczne.
 *
 * Guard jest DOKŁADNY (`^\[REDACTED\]$` na przyciętej wartości), nie podciągowy - wartość, która
 * NIESIE token, ale ma wokół niego coś więcej (`"[REDACTED] hunter2hunter2"`,
 * `"[REDACTED]hunter2hunter2"` sklejone bez separatora) NIE jest tylko tokenem i ma dostać
 * zwykłą maskę - inaczej prawdziwy sekret doklejony obok już zredagowanego tokenu przechodziłby
 * jawny, bo cała wartość odbijałaby się od guarda jako "już bezpieczna".
 * @param value
 */
function _maskValue(value: string): string {
    if (/^\[REDACTED\]$/.test(value.trim())) return value;
    if (value.length <= 8) return '****';
    return value.slice(0, 4) + '***' + value.slice(-4);
}
