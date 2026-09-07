/**
 * `core/http/contracts.ts` — kontrakt podklastra transportu HTTP.
 *
 * DLACZEGO TRANSPORT MIESZKA W `core/`, A NIE W MODULE: dokładnie tego samego klienta
 * HTTP i tego samego czytnika strumienia potrzebują DWA moduły (`models` i `embedding`),
 * a moduły nie mają prawa importować się nawzajem po bebechach. `core/` jest ich wspólnym
 * fundamentem; gotowe instancje wstrzykuje composition root przez `RuntimeConfig`.
 *
 * NODE-SAFETY (K-01/K-03): żaden plik tego podklastra NIE importuje `obsidian`.
 * `ObsidianHttpClient` dostaje funkcję `requestUrl` w konstruktorze.
 *
 * GRANICA ODPOWIEDZIALNOŚCI:
 *   • `core/http` UJAWNIA `status` i `headers` (w tym `Retry-After`) i nie rzuca na ≥ 400;
 *   • WOŁACZ prowadzi politykę (backoff 429, sufit prób, budzik po Stopie).
 *     Transport nie ponawia niczego.
 *
 * @packageDocumentation
 */

/**
 * Opis pojedynczego żądania — wspólny dla toru bez strumienia i strumieniowego.
 *
 * `timeoutMs` ma JEDNĄ semantykę w całym repo: to TWARDY limit egzekwowany przez
 * implementację klienta/transportu.
 */
export interface HttpRequestSpec {
    url: string;
    method: 'GET' | 'POST';
    /** Klucz API pod nazwą z metryczki dostawcy (`x-api-key`, `x-goog-api-key`, `Authorization`). */
    headers: Record<string, string>;
    /** Ciało jako STRING JSON — nigdy obiekt. */
    body?: string;
    /**
     * TWARDY limit czasu tego żądania. Brak → {@link STREAM_TRANSPORT_TIMEOUT_MS}
     * dla transportu strumienia; klient bez strumienia bez tego pola nie nakłada limitu.
     */
    timeoutMs?: number;
}

/** Odpowiedź toru bez strumienia. */
export interface HttpResponse {
    status: number;
    headers: Record<string, string>;
    text: string;
    /** Rzuca, gdy `text` nie jest JSON-em — wołacz łapie i normalizuje. */
    json<T = unknown>(): T;
}

/**
 * Klient HTTP bez strumienia.
 *
 * KONTRAKT: NIGDY nie rzuca na status ≥ 400 — status wraca w {@link HttpResponse.status}.
 * Rzut = awaria transportu (brak sieci, zgaszony demon, DNS).
 */
export interface HttpClient {
    send(spec: HttpRequestSpec): Promise<HttpResponse>;
}

/** Zwrotka pojedynczego otwarcia strumienia. */
export interface StreamOpenResult {
    status: number;
    /**
     * Nagłówki odpowiedzi. Transport oddaje je ZAWSZE — na nich stoi polityka 429
     * wołacza (`Retry-After`). Nazwy nagłówków znormalizowane do lowercase.
     */
    headers: Record<string, string>;
    /**
     * Ciało błędu, gdy `status !== 200`. Puste, gdy serwer nic nie odpisał — wtedy K20
     * wymaga od wołacza własnego krótkiego komunikatu.
     */
    body: string;
}

/** Odbiornik porcji strumienia. */
export interface StreamSink {
    /** Porcja TEKSTU zdekodowanego z bajtów; granice ramek NIE są gwarantowane. */
    onChunk(text: string): void;
}

/**
 * Transport strumienia: `fetch` + `ReadableStream` + `TextDecoder` + `AbortController`.
 * Bez XHR.
 *
 * KONTRAKT:
 * - porcje lecą do `sink.onChunk` W KOLEJNOŚCI PRZYBYCIA, bez sklejania i bez rozcinania
 *   na ramki — rozcinanie robi {@link FrameParser}, nie transport;
 * - `spec.timeoutMs` (default {@link STREAM_TRANSPORT_TIMEOUT_MS}) jest TWARDY;
 * - status inny niż 200 rozstrzyga promisę `{ status, headers, body }` BEZ rzucania;
 * - `signal.abort()` przerywa czytanie natychmiast; promisa odrzuca się błędem abortu,
 *   a porcja niedokończona NIE trafia do `sink`;
 * - K20: żaden komunikat błędu wychodzący z transportu nie zawiera nagłówków żądania.
 */
export interface StreamTransport {
    open(spec: HttpRequestSpec, sink: StreamSink, signal: AbortSignal): Promise<StreamOpenResult>;
}

/** TWARDY limit czasu strumienia. Pin: DOKŁADNIE 600000. */
export const STREAM_TRANSPORT_TIMEOUT_MS = 600000;

/** Jedna ramka strumienia. */
export interface StreamFrame {
    /** Nazwa zdarzenia SSE (`event:`), gdy dostawca ją wysyła. */
    event?: string;
    /** Ładunek ramki: dla SSE zawartość po `data: `, dla NDJSON cała linia. */
    data: string;
}

/**
 * Parser ramek z buforem MIĘDZY porcjami — jedyny element transportu, który pamięta
 * cokolwiek poza jedną porcją.
 *
 * - porcja rozcinająca ramkę w połowie NIE gubi jej (ogon zostaje w buforze);
 * - `feed()` zwraca WYŁĄCZNIE ramki kompletne;
 * - `finish()` oddaje resztę bufora, jeśli jest kompletną ramką, inaczej pustą tablicę.
 */
export interface FrameParser {
    feed(chunk: string): StreamFrame[];
    finish(): StreamFrame[];
}
