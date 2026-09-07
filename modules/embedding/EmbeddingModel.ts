/**
 * modules/embedding/EmbeddingModel.ts — serce klastra (§6 kontraktu).
 *
 * Tu i TYLKO tu żyje polityka: ponowienia po 429 z backoffem, sufit czasu, przycinanie wejść
 * i twardy kontrakt „N wejść → N wyników albo rzut". Dostawca (`EmbeddingProvider`) jest
 * bezstanowy — buduje żądanie i czyta odpowiedź; o tym, ILE RAZY je wysłać i co zrobić
 * z awarią, decyduje ta klasa.
 *
 * TRZY REGUŁY, KTÓRE TU RZĄDZĄ (i których nie wolno „uprościć"):
 *
 *  1. **Krótsza tablica nie istnieje.** Albo tyle wyników, ile było wejść, albo rzut. Wynik
 *     krótszy niż wejście sprawiał, że indekser stemplował pliki jako zaindeksowane, choć
 *     nie miały wektora — po restarcie nic już ich nie doganiało.
 *  2. **Ponawiamy WYŁĄCZNIE 429.** Każdy inny status ≥ 400 leci w górę po pierwszym żądaniu.
 *     Symetria byłaby tu kosztowna: 400 „zły model" nie naprawi się przez powtórzenie.
 *  3. **Sufit czasu to wyścig obietnic, nie anulowanie.** Klient HTTP Obsidiana nie przyjmuje
 *     sygnału przerwania, więc porzuconego żądania nie da się odwołać — uwalniamy wołacza,
 *     a zegar kasujemy na KAŻDEJ drodze wyjścia (inaczej pusta pętla zdarzeń trzymałaby proces).
 */
import {
    DEFAULT_EMBED_BATCH_SIZE,
    DEFAULT_EMBED_TIMEOUT_MS,
    DEFAULT_MAX_INPUT_TOKENS,
    DEFAULT_VECTOR_DIM,
    EMBED_BACKOFF_WAIT_MS,
    EMBED_RETRY_ATTEMPTS,
    EMBED_RETRY_BASE_MS,
    EMBED_TRIM_SAFETY_FACTOR,
    MAX_BACKOFF_FACTOR,
} from './contracts.js';
import { EmbedBatchError, isEmbedBatchError } from './embedErrors.js';
import { trimToTokenBudget } from './tokens.js';
import type {
    EmbedBatchErrorInit,
    EmbeddingModelDeps,
    EmbeddingModelInfo,
    EmbeddingProvider,
    EmbeddingProviderContext,
    EmbeddingProviderId,
    EmbedResult,
    HttpClient,
    HttpResponse,
} from './contracts.js';

// obsidianmd/prefer-window-timers: ten plik wstaje też w gołym Node (testy AVA, harness),
// gdzie `window` nie istnieje — `window.setTimeout` byłby ReferenceError. Inline `eslint-disable`
// dla reguł `obsidianmd/*` jest w tym repo zablokowany, więc globalny zegar czytamy przez
// lokalną zmienną: odczyt jest DYNAMICZNY (przy każdym wywołaniu), więc zachowanie jest
// identyczne z bezpośrednim wywołaniem globala. Ten sam zabieg robi `VaultIndexer`.
function startTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const start = setTimeout;
    return start(fn, ms);
}

function stopTimer(handle: ReturnType<typeof setTimeout>): void {
    const stop = clearTimeout;
    stop(handle);
}

/** Uśpienie produkcyjne. Testy podstawiają własne przez `deps.sleep`. */
function realSleep(ms: number): Promise<void> {
    return new Promise<void>(resolve => { startTimer(resolve, ms); });
}

/** Liczba dodatnia i skończona, albo `undefined` — jedna bramka dla wszystkich knobów. */
function positiveNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Wejście „puste" = brak treści po obcięciu białych znaków (B.5 EB-09). */
function isBlank(text: unknown): boolean {
    return typeof text !== 'string' || text.trim().length === 0;
}

export class EmbeddingModel {
    declare readonly providerId: EmbeddingProviderId;
    declare readonly modelId: string;
    declare readonly modelKey: string;
    declare readonly dims: number;
    declare readonly batchSize: number;
    declare readonly maxInputTokens: number;
    declare readonly safeMaxTokens: number;
    declare readonly timeoutMs: number;

    declare private readonly _provider: EmbeddingProvider;
    declare private readonly _ctx: EmbeddingProviderContext;
    declare private readonly _http: HttpClient;
    declare private readonly _retryBaseMs: number;
    declare private readonly _backoffWaitMs: number;
    declare private readonly _sleep: (ms: number) => Promise<void>;

    /** Mnożnik odczekania po WYCZERPANEJ rundzie 429. Start 1, sufit, reset po sukcesie. */
    declare private _factor: number;
    /** Dług czasu do odrobienia PRZED następnym wywołaniem (skutek wyczerpanej rundy 429). */
    declare private _cooldownMs: number;

    constructor(deps: EmbeddingModelDeps) {
        this._provider = deps.provider;
        this._ctx = deps.ctx;
        this._http = deps.http;

        this.providerId = deps.provider.info.id;
        this.modelId = deps.ctx.modelId;
        this.modelKey = `${this.providerId}:${this.modelId}`;

        // Katalog dostawcy zna TWARDE limity modelu; nieznany model oddaje `undefined` bez rzutu.
        const spec = deps.provider.modelSpec(this.modelId);

        // ⚠️ Wymiar jest STAŁY z rozmysłu. Podniesienie go do natywnego wymiaru dostawcy przy
        // niezmienionym `modelKey` unieważniłoby indeksy userów bez rebuildu (odtwarzanie
        // schematu idzie z zapisanego `dims`). Realny wymiar i tak wygrywa u indeksera, który
        // bierze długość pierwszego wektora.
        this.dims = DEFAULT_VECTOR_DIM;

        // Dwie kolejności, ODWROTNE i celowo:
        //  • limit tokenów — katalog PRZED ustawieniami (twardy limit modelu, user go nie osłabi),
        //  • porcja — ustawienia PRZED katalogiem (knob wydajnościowy, wolno userowi zejść niżej).
        this.maxInputTokens = positiveNumber(spec?.maxInputTokens) ?? DEFAULT_MAX_INPUT_TOKENS;
        this.batchSize = positiveNumber(deps.batchSize) ?? positiveNumber(spec?.batchSize) ?? DEFAULT_EMBED_BATCH_SIZE;

        // Margines na niedoszacowanie estymaty tokenów — nigdy nie schodzi do zera.
        this.safeMaxTokens = Math.max(1, Math.floor(this.maxInputTokens * EMBED_TRIM_SAFETY_FACTOR));

        // `0` i śmieć NIGDY nie znaczą „bez limitu" — wracają na wartość domyślną.
        this.timeoutMs = positiveNumber(deps.timeoutMs) ?? DEFAULT_EMBED_TIMEOUT_MS;

        this._retryBaseMs = positiveNumber(deps.retryBaseMs) ?? EMBED_RETRY_BASE_MS;
        this._backoffWaitMs = positiveNumber(deps.backoffWaitMs) ?? EMBED_BACKOFF_WAIT_MS;
        this._sleep = typeof deps.sleep === 'function' ? deps.sleep : realSleep;

        this._factor = 1;
        this._cooldownMs = 0;
    }

    /** Mnożnik odczekania po 429: start 1, sufit {@link MAX_BACKOFF_FACTOR}, reset po sukcesie. */
    get backoffFactor(): number {
        return this._factor;
    }

    /**
     * Zamienia teksty na wektory. Wynik ma DŁUGOŚĆ WEJŚCIA, pozycja w pozycję;
     * `vector: null` znaczy „to wejście było puste", a nie „nie udało się".
     * Każda awaria wychodzi rzutem {@link EmbedBatchError}.
     */
    async embed(texts: string[]): Promise<EmbedResult[]> {
        if (!Array.isArray(texts)) {
            throw this._error({ kind: 'shape', code: 'bad_shape', message: 'Embedding input must be an array of strings', attempts: 0 });
        }

        // Miejsca na wyniki powstają PRZED wysyłką — dzięki temu wyrównanie wejść z wyjściami
        // nie zależy od tego, co odpowiedział dostawca.
        const results: EmbedResult[] = texts.map(() => ({ vector: null }));
        const slots: number[] = [];
        const payload: string[] = [];

        texts.forEach((text, index) => {
            if (isBlank(text)) return;
            slots.push(index);
            payload.push(trimToTokenBudget(text, this.safeMaxTokens));
        });

        // Same puste wejścia — nie ma czego liczyć, więc nie płacimy za żądanie.
        if (payload.length === 0) return results;

        // Brak klucza rozstrzygamy PRZED transportem: user ma zobaczyć „nie skonfigurowano",
        // a nie odbicie od API po kilku sekundach.
        if (this._provider.info.needsApiKey && isBlank(this._ctx.apiKey)) {
            throw this._error({
                kind: 'api',
                code: 'api_key_missing',
                message: `API key not set for ${this.providerId}`,
                attempts: 0,
            });
        }

        await this._payBackoffDebt();

        // Licznik żyje TU, a nie w polu klasy: `embed()` bywa wołane równolegle na tej samej
        // instancji (indekser puszcza kilka porcji naraz), więc stan współdzielony kłamałby.
        // Zegar sufitu czasu i błąd kształtu czytają z niego prawdziwą liczbę żądań.
        const tally = { attempts: 0 };

        const vectors = await this._raceTimeout(() => this._sendWithRetries(payload, tally), tally);

        if (!Array.isArray(vectors) || vectors.length !== payload.length) {
            const got = Array.isArray(vectors) ? vectors.length : 0;
            throw this._error({
                kind: 'shape',
                code: 'bad_shape',
                // Obie liczby W KOMUNIKACIE — bez nich nie da się odróżnić „API oddało mniej"
                // od „porcja była pusta", a to dwie różne awarie.
                message: `Embedding provider returned ${got} vectors for ${payload.length} inputs`,
                attempts: tally.attempts,
            });
        }

        slots.forEach((slot, i) => {
            const vector = vectors[i];
            // Pozycja bez wektora jest awarią kształtu, nie „pustym wejściem" — puste wejścia
            // odsialiśmy wyżej, więc `null` w tym miejscu oznaczałby plik zaindeksowany donikąd.
            if (!Array.isArray(vector)) {
                throw this._error({
                    kind: 'shape',
                    code: 'bad_shape',
                    message: `Embedding provider returned no vector at position ${i}`,
                });
            }
            results[slot] = { vector };
        });

        // Runda zakończona sukcesem zeruje dług backoffu — inaczej limit sprzed godziny
        // spowalniałby indeksowanie do końca sesji.
        this._factor = 1;
        this._cooldownMs = 0;

        return results;
    }

    /**
     * Estymata tokenów pojedynczego tekstu. Delegat do dostawcy — niektórzy liczą inaczej
     * niż domyślne „znaki / stała".
     */
    countTokens(text: string): number {
        return this._provider.countTokens(text);
    }

    /** Lista modeli dostawcy (dziś bez konsumenta produkcyjnego — patrz kontrakt §5). */
    async listModels(): Promise<EmbeddingModelInfo[]> {
        return this._provider.listModels(this._ctx, this._http);
    }

    // ── Wnętrze ──────────────────────────────────────────────────────────────

    /**
     * Odrabia odczekanie zapisane po poprzedniej wyczerpanej rundzie 429.
     * ŚWIADOMIE poza wyścigiem z zegarem: to nie jest czas żądania, tylko celowa przerwa,
     * a wliczenie jej do sufitu czasu zamieniałoby limit API w fałszywy „timeout".
     */
    private async _payBackoffDebt(): Promise<void> {
        const debt = this._cooldownMs;
        if (debt <= 0) return;
        this._cooldownMs = 0;
        await this._sleep(debt);
    }

    /**
     * Wyścig: praca kontra zegar. Wygrywa zegar → wołacz dostaje `kind:'timeout'`.
     * Porzuconego żądania nie da się anulować — uwalniamy tylko wołacza.
     */
    private async _raceTimeout<T>(work: () => Promise<T>, tally: { attempts: number }): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;

        const alarm = new Promise<never>((_resolve, reject) => {
            timer = startTimer(() => {
                reject(this._error({
                    kind: 'timeout',
                    code: 'timeout',
                    message: `Embedding request timed out after ${this.timeoutMs} ms`,
                    attempts: tally.attempts,
                }));
            }, this.timeoutMs);
            // Bez `unref()` — przy bezczynnej pętli zdarzeń zegar nigdy by nie wystrzelił,
            // a to jego jedyne zadanie.
        });

        try {
            return await Promise.race([work(), alarm]);
        } finally {
            if (timer !== undefined) stopTimer(timer);
        }
    }

    /** Jedno żądanie na wywołanie — plus ponowienia, ale WYŁĄCZNIE po 429. */
    private async _sendWithRetries(payload: string[], tally: { attempts: number }): Promise<number[][]> {
        for (let round = 0; ; round++) {
            tally.attempts += 1;
            const attempts = tally.attempts;
            const response = await this._send(payload, attempts);
            const outcome = this._read(response, payload, attempts);

            if (outcome.ok) return outcome.vectors;
            if (!outcome.rateLimited) throw outcome.error;

            if (round < EMBED_RETRY_ATTEMPTS) {
                await this._sleep(this._retryDelayMs(round, outcome.retryAfterMs));
                continue;
            }

            // Runda wyczerpana: podbijamy mnożnik (z sufitem — bez niego pojedyncza próba
            // czekałaby ponad półtorej minuty) i zapisujemy dług na NASTĘPNE wywołanie.
            this._factor = Math.min(this._factor + 1, MAX_BACKOFF_FACTOR);
            this._cooldownMs = this._backoffWaitMs * this._factor;
            throw outcome.error;
        }
    }

    /** Wysyłka jednego żądania. Rzut transportu = awaria sieci, nie odpowiedź API. */
    private async _send(payload: string[], attempts: number): Promise<HttpResponse> {
        const spec = this._provider.buildEmbedRequest(payload, this._ctx);
        let response: HttpResponse;

        try {
            response = await this._http.send({ ...spec, timeoutMs: spec.timeoutMs ?? this.timeoutMs });
        } catch (cause) {
            throw this._error({
                kind: 'transport',
                code: 'no_response',
                message: `Embedding transport failed (${this.providerId})`,
                attempts,
                cause,
            });
        }

        // Brak odpowiedzi to awaria TRANSPORTU, nie kształtu — i ta różnica jest kosztowna.
        // `shape` jest dla indeksera fatalne (porcji NIE wolno rozbijać ani ponawiać), a martwy
        // transport jest przejściowy: ma wrócić przy następnym podejściu. Typ obiecuje tu
        // `HttpResponse`, ale klient bywa cudzy (atrapa, własna implementacja usera, adapter,
        // który połknął wyjątek i oddał `null`) — na tej granicy ufamy sprawdzeniu, nie typowi.
        if (response === null || typeof response !== 'object' || typeof response.json !== 'function') {
            throw this._error({
                kind: 'transport',
                code: 'no_response',
                message: `Embedding transport returned no response (${this.providerId})`,
                attempts,
            });
        }

        return response;
    }

    /**
     * Rozstrzyga JEDNĄ odpowiedź: sukces, limit do ponowienia albo awaria do rzucenia.
     * Status ≥ 400 to oczywista awaria; 2xx z polem `error` w ciele też (niektóre API tak
     * właśnie zgłaszają limit minutowy — czytanie samego statusu kończyło porcję po 0 ms).
     */
    private _read(
        response: HttpResponse,
        payload: string[],
        attempts: number,
    ): { ok: true; vectors: number[][] } | { ok: false; rateLimited: boolean; retryAfterMs?: number; error: EmbedBatchError } {
        const status = typeof response?.status === 'number' ? response.status : 0;

        if (status >= 400) return this._readError(response, status, attempts);

        let body: unknown;
        try {
            body = response.json();
        } catch (cause) {
            return {
                ok: false,
                rateLimited: false,
                error: this._error({
                    kind: 'shape',
                    code: 'bad_shape',
                    message: `Embedding response is not valid JSON (HTTP ${status})`,
                    httpStatus: status,
                    attempts,
                    cause,
                }),
            };
        }

        if (body !== null && typeof body === 'object' && (body as { error?: unknown }).error) {
            return this._readError(response, status, attempts);
        }

        try {
            return { ok: true, vectors: this._provider.parseEmbedResponse(body, payload, this._ctx) };
        } catch (cause) {
            return {
                ok: false,
                rateLimited: false,
                error: isEmbedBatchError(cause)
                    ? cause
                    : this._error({
                        kind: 'shape',
                        code: 'bad_shape',
                        message: `Embedding response has unexpected shape (HTTP ${status})`,
                        httpStatus: status,
                        attempts,
                        cause,
                    }),
            };
        }
    }

    /** Zamienia odpowiedź błędną na gotowy rzut; dostawca mówi, CO to było i jak długo czekać. */
    private _readError(
        response: HttpResponse,
        status: number,
        attempts: number,
    ): { ok: false; rateLimited: boolean; retryAfterMs?: number; error: EmbedBatchError } {
        let init: EmbedBatchErrorInit;
        let retryAfterMs: number | undefined;

        try {
            const parsed = this._provider.parseEmbedError(response, this._ctx);
            init = parsed.error;
            retryAfterMs = positiveNumber(parsed.retryAfterMs);
        } catch {
            // Dostawca nie poradził sobie z własnym błędem — nie gubimy przez to statusu.
            init = { kind: 'api', code: 'http_error', message: `Embedding request failed (HTTP ${status})`, httpStatus: status };
        }

        const httpStatus = init.httpStatus ?? (status > 0 ? status : undefined);
        const rateLimited = httpStatus === 429 || init.code === 'rate_limited';

        return {
            ok: false,
            rateLimited,
            retryAfterMs,
            error: this._error({
                ...init,
                httpStatus,
                attempts,
                // K20: ciało odpowiedzi bywa echem żądania razem z nagłówkiem autoryzacji,
                // więc do błędu NIE trafia. Zostaje status, rodzaj i komunikat po maskowaniu.
                cause: undefined,
            }),
        };
    }

    /** Ile czekać przed ponowieniem: zdanie dostawcy wygrywa, inaczej wykładniczy backoff. */
    private _retryDelayMs(round: number, retryAfterMs?: number): number {
        if (retryAfterMs !== undefined) return retryAfterMs;
        return this._retryBaseMs * Math.pow(2, round) * this._factor;
    }

    /** Jedno miejsce, w którym powstaje błąd — stąd pewność, że tożsamość i maska są wszędzie. */
    private _error(init: Partial<EmbedBatchErrorInit> & { kind: EmbedBatchErrorInit['kind']; code: EmbedBatchErrorInit['code']; message: string }): EmbedBatchError {
        return new EmbedBatchError({
            ...init,
            message: this._mask(init.message),
            // Przyczyna przechodzi przez tę samą maskę co komunikat — K20 wymienia `cause`
            // wprost, a błąd transportu potrafi wciągnąć do treści cały URL z żądania.
            cause: this._maskCause(init.cause),
            providerId: this.providerId,
            modelId: this.modelId,
        });
    }

    /**
     * Wycina klucz API z komunikatu (K20). Krótkich wartości nie maskujemy — trafiłyby
     * w przypadkowe fragmenty tekstu i zrobiły z komunikatu bełkot.
     */
    private _mask(message: string): string {
        const key = this._secret();
        return key === undefined ? message : message.split(key).join('***');
    }

    /**
     * To samo dla przyczyny. Cudzego błędu NIE mutujemy — gdy niesie klucz, w jego miejsce
     * wchodzi zamiennik z zamaskowaną treścią; stos oryginału zostaje odcięty razem z nim,
     * bo w komunikacie klienta HTTP klucz bywa doklejony do adresu.
     */
    private _maskCause(cause: unknown): unknown {
        const key = this._secret();
        if (cause === undefined || cause === null || key === undefined) return cause;

        if (cause instanceof Error) {
            if (!cause.message.includes(key)) return cause;
            const zastepnik = new Error(this._mask(cause.message));
            zastepnik.name = cause.name;
            return zastepnik;
        }

        return typeof cause === 'string' && cause.includes(key) ? this._mask(cause) : cause;
    }

    /** Klucz wart maskowania: krótkie wartości pomijamy, bo trafiałyby w przypadkowy tekst. */
    private _secret(): string | undefined {
        const key = this._ctx.apiKey;
        return typeof key === 'string' && key.length >= 8 ? key : undefined;
    }
}
