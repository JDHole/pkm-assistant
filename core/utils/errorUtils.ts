/**
 * errorUtils — normalizacja błędów API modeli (konsolidacja duplikatów).
 *
 * `normalizeError` żyła kiedyś w PIĘCIU identycznych (bajt w bajt) kopiach w
 * `modules/models/` — w klasie modelu, w bazie dostawców i w trzech dostawcach osobno.
 * Tu jest JEDNA kopia; `modules/models/` bierze jej typ przez własne kontrakty
 * (`modules/models/contracts.ts`), a reszta pluginu przez barrel `core/index.js`.
 *
 * Plik jest CZYSTY — zero importów, żeby dostawcy modeli dawali się testować w AVA
 * bez wciągania obsidianowego barrela `core/index.js`.
 */

/**
 * Kształt, w jakim CZYTAMY surowy błąd. Wszystko opcjonalne, bo 12 platform zwraca 12
 * różnych obiektów — tu tylko nazywamy pola, po które kod i tak sięgał.
 */
type ErrLike = {
  message?: string;
  code?: string;
  status?: number;
  http_status?: number;
  details?: unknown;
  error?: { message?: string; code?: string; type?: string };
};

/** Kontrakt zwrotki `normalizeError` — na nim stoją adaptery 12 platform. */
export interface NormalizedError {
  message: string;
  code: string;
  details?: unknown;
  http_status: number | null;
}

/**
 * Pola, które z definicji niosą KONTEKST ŻĄDANIA, nie treść błędu.
 *
 * `message` idzie do pliku logu i na ekran usera, więc nie ma prawa nieść nagłówków
 * (`Authorization`, `api-key`) ani całego obiektu transportu. Filtr jest CZYSTY (po nazwie
 * pola, bez importu maski), bo ten plik z założenia nie ma zależności — maska sekretów
 * z `core/security/SensitiveDataGuard.ts` jest drugą warstwą, tu chodzi o pierwszą:
 * takie pole w ogóle nie wchodzi do tekstu.
 *
 * ⚠️ Dotyczy WYŁĄCZNIE gałęzi `JSON.stringify` budującej `message`. Pole `details` zostaje
 * surowym obiektem — to ustalony kontrakt adapterów, a obiekt idzie do loggera przez maskę.
 */
export const SECRET_BEARING_FIELDS = new Set([
  'headers', 'source', 'request', 'request_params', 'xhr', 'config', 'options',
]);

/** Twardy limit `message` — obiekt zdarzenia nie ma prawa wejść tam w całości. */
/** Twardy limit długości `message` po normalizacji. */
export const MAX_ERROR_MESSAGE_LENGTH = 4000;

/** Przycięcie z widocznym znacznikiem — user ma wiedzieć, że coś zostało obcięte. */
function _truncate(text: string): string {
  return text.length > MAX_ERROR_MESSAGE_LENGTH ? text.slice(0, MAX_ERROR_MESSAGE_LENGTH) + '…' : text;
}

/**
 * `JSON.stringify` bez pól-sekretów, odporny na cykle (streamer ma `xhr` → `source` → …).
 * Nigdy nie rzuca: log i komunikat błędu to ostatnie miejsca, w których wolno się wywalić.
 */
function _safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const out = JSON.stringify(value, function (key, val: unknown) {
      if (key && SECRET_BEARING_FIELDS.has(key.toLowerCase())) return undefined;
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '[circular]';
        seen.add(val);
      }
      return val;
    });
    return out ?? String(value);
  } catch {
    return '[unserializable error]';
  }
}

/**
 * Sprowadza dowolny błąd (string / obiekt API / zagnieżdżony `{error:{...}}`) do jednego kształtu.
 *
 * Kontrakt zwrotki (NIE zmieniać — na nim stoją adaptery 12 platform):
 * `{ message, code, details, http_status }`. Pole `code` zostaje, mimo że dziś nikt go nie czyta.
 *
 * @param error - Surowy błąd: string, `Error`, obiekt odpowiedzi API albo `null`.
 * @param http_status - Status HTTP, jeśli znany z warstwy transportu.
 */
export function normalizeError(error: unknown, http_status: number | null = null): NormalizedError {
  if (!error) return { message: 'Unknown error', code: 'UNKNOWN', http_status };
  if (typeof error === 'string') return { message: _truncate(error), code: 'UNKNOWN', http_status };
  // Gałąź `JSON.stringify` wycina pola-sekrety i przycina wynik — patrz
  // SECRET_BEARING_FIELDS. `message` z samego błędu też dostaje limit długości.
  const raw_message = (error as ErrLike).message || (error as ErrLike).error?.message;
  const message = _truncate(typeof raw_message === 'string' && raw_message ? raw_message : _safeStringify(error));
  const code = (error as ErrLike).code || (error as ErrLike).error?.code || (error as ErrLike).error?.type || 'UNKNOWN';
  const details = (error as ErrLike).error || (error as ErrLike).details || error;
  return { message, code, details, http_status: http_status || (error as ErrLike).http_status || (error as ErrLike).status || null };
}

/** Sekrety krótsze niż to nie są redagowane — zbyt duże ryzyko fałszywych trafień na zwykły tekst. */
export const MIN_SECRET_LENGTH_FOR_REDACTION = 8;

/** Zamiennik, jakim `redactSecretValues` podstawia znaleziony sekret. */
const REDACTED = '[REDACTED]';

function _redactString(text: string, variants: readonly string[]): string {
  let out = text;
  for (const variant of variants) out = out.split(variant).join(REDACTED);
  return out;
}

/** Placeholder dla referencja odwiedzoną drugi raz — obiekt/tablica, które wskazują same na siebie. */
const CYCLE = '[cycle]';

/**
 * Redakcja w głąb dowolnej wartości. `seen` łapie cykle (obiekt/tablica, do której prowadzi
 * odwołanie z jej własnego wnętrza) — bez tego rekurencja po takiej strukturze nigdy by się
 * nie skończyła. Domyślny, świeży `WeakSet` na wywołanie z zewnątrz; rekurencja podaje dalej
 * TEN SAM zestaw, żeby odwiedzone węzły były pamiętane w całym przebiegu, nie per gałąź.
 */
function _redactDeep(value: unknown, variants: readonly string[], seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return _redactString(value, variants);
  if (value && typeof value === 'object') {
    if (seen.has(value)) return CYCLE;
    seen.add(value);
    if (Array.isArray(value)) return value.map(item => _redactDeep(item, variants, seen));
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) out[key] = _redactDeep(val, variants, seen);
    return out;
  }
  return value;
}

/** Warianty formy sekretu do podstawienia — dzielone przez {@link redactSecretValues} i {@link redactSecretsDeep}. */
function _secretVariants(secrets: readonly string[]): string[] {
  const valid = (secrets ?? []).filter((s): s is string => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH_FOR_REDACTION);
  if (valid.length === 0) return [];
  // Trzy formy na sekret: opakowana `Bearer <sekret>` (redagowana W CAŁOŚCI, żeby nie zostawić
  // "Bearer [REDACTED]" - "Bearer" samo w sobie nic nie zdradza, ale spójność z resztą tekstu
  // jest czytelniejsza jako jeden token), zakodowana `encodeURIComponent(sekret)` (klucz odbity
  // w query stringu adresu) i sam sekret. Od najdłuższej do najkrótszej - dłuższa (opakowująca)
  // forma musi zostać podstawiona PIERWSZA, inaczej krótsza zjada część tekstu i zostawia ogon.
  return Array.from(new Set(
    valid.flatMap(s => [`Bearer ${s}`, encodeURIComponent(s), s])
  )).sort((a, b) => b.length - a.length);
}

/**
 * Redakcja PO DOSŁOWNEJ WARTOŚCI sekretu — druga, niezależna warstwa obok maski `core/security/
 * SensitiveDataGuard.ts` (która maskuje po KSZTAŁCIE/nazwie pola). Klucz API NIESTANDARDOWY (bez
 * znanego prefiksu jak `sk-`/`gsk_`, albo krótszy niż próg wzorca) nie łapie się na maskę
 * kształtu — jeśli dostawca albo proxy odbije go w treści błędu, jedyna warstwa, która go
 * jeszcze złapie, to porównanie z wartością klucza NAPRAWDĘ użytego w żądaniu.
 *
 * Plik jest CZYSTY (zero importów) — funkcja nie sięga po `maskSensitiveData`, tylko robi
 * dosłowne podstawienie tekstu.
 *
 * @param err - Znormalizowany błąd (wynik {@link normalizeError}).
 * @param secrets - Sekrety do zredagowania (np. `[ctx.apiKey]`). Puste/krótkie wartości pomijane.
 */
export function redactSecretValues(err: NormalizedError, secrets: readonly string[]): NormalizedError {
  const variants = _secretVariants(secrets);
  if (variants.length === 0) return err;

  const out: NormalizedError = { ...err, message: _redactString(err.message, variants) };
  if ('details' in err) out.details = _redactDeep(err.details, variants);
  return out;
}

/**
 * Redakcja PO DOSŁOWNEJ WARTOŚCI sekretu na DOWOLNEJ wartości, PRZED normalizacją.
 *
 * `normalizeError` tnie `message` do {@link MAX_ERROR_MESSAGE_LENGTH} ZANIM cokolwiek zdąży
 * zredagować sekret — klucz, który siedzi dokładnie na granicy cięcia, wychodziłby przecięty
 * na pół, a `redactSecretValues` (dopasowanie CAŁEGO sekretu) już by go nie znalazł. Ten
 * wariant redaguje wołacz, który ma SUROWĄ wartość (ciało JSON po `JSON.parse`, `payload.error`
 * dostawcy) sprzed normalizacji — sekret znika, zanim jakiekolwiek cięcie długości go dotknie.
 *
 * Sama logika co {@link redactSecretValues} (te same warianty formy, ta sama ochrona cykli),
 * ale bez założenia, że wejście ma kształt {@link NormalizedError} — stąd `unknown` na wejściu
 * i wyjściu.
 *
 * @param value - Dowolna wartość: surowy obiekt błędu, string, cokolwiek odda `JSON.parse`.
 * @param secrets - Sekrety do zredagowania — patrz {@link redactSecretValues}.
 */
export function redactSecretsDeep(value: unknown, secrets: readonly string[]): unknown {
  const variants = _secretVariants(secrets);
  if (variants.length === 0) return value;
  return _redactDeep(value, variants);
}
