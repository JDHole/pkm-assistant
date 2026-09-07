/**
 * errorUtils — normalizacja błędów API modeli (S30 Z3, konsolidacja duplikatów).
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
 * K20 (AUD-security-120) — pola, które z definicji niosą KONTEKST ŻĄDANIA, nie treść błędu.
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
/**
 * Pola, które z definicji niosą kontekst żądania (a więc i klucz API) — gałąź
 * `JSON.stringify` budująca `message` wycina je w całości. Publiczne, bo stoją na nich
 * testy K20 klastra `models` i transport w `core/http`.
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
  // K20: gałąź `JSON.stringify` wycina pola-sekrety i przycina wynik — patrz
  // SECRET_BEARING_FIELDS. `message` z samego błędu też dostaje limit długości.
  const raw_message = (error as ErrLike).message || (error as ErrLike).error?.message;
  const message = _truncate(typeof raw_message === 'string' && raw_message ? raw_message : _safeStringify(error));
  const code = (error as ErrLike).code || (error as ErrLike).error?.code || (error as ErrLike).error?.type || 'UNKNOWN';
  const details = (error as ErrLike).error || (error as ErrLike).details || error;
  return { message, code, details, http_status: http_status || (error as ErrLike).http_status || (error as ErrLike).status || null };
}
