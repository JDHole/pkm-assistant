/** `FetchHttpClient` — tor bez strumienia w Node/harnessie (natywny `fetch`). */
import type { HttpClient, HttpRequestSpec, HttpResponse } from './contracts.js';
import { KOD_LIMIT_CZASU, KOD_TRANSPORT, bladTransportu } from './transportErrors.js';
import { hostWindow } from '../utils/hostWindow.js';

/**
 * Nagłówki odpowiedzi jako zwykła mapa z nazwami małymi literami — na tym stoi
 * odczyt `retry-after` u wołacza, a `Headers` już normalizuje nazwy za nas.
 */
function mapaNaglowkow(naglowki: Headers): Record<string, string> {
    const wynik: Record<string, string> = {};
    naglowki.forEach((wartosc, nazwa) => {
        wynik[nazwa.toLowerCase()] = wartosc;
    });
    return wynik;
}

/**
 * Buduje zwrotkę kontraktu. `json()` jest LENIWE i rzuca na treści, która nie jest
 * JSON-em — wołacz łapie to u siebie i normalizuje (strona HTML z proxy, pusta odpowiedź).
 */
function odpowiedz(status: number, headers: Record<string, string>, text: string): HttpResponse {
    return {
        status,
        headers,
        text,
        json<T = unknown>(): T {
            return JSON.parse(text) as T;
        },
    };
}

export class FetchHttpClient implements HttpClient {
    /** Atrapa z testów; `undefined` znaczy „bierz aktualny `fetch` środowiska". */
    declare private readonly wstrzykniety: typeof fetch | undefined;

    constructor(fetchImpl?: typeof fetch) {
        this.wstrzykniety = fetchImpl;
    }

    /**
     * Woła `fetch` BEZ ODBIORNIKA i dopiero w chwili żądania.
     *
     * Dwa powody, obie rzeczy niewidoczne w gołym Node:
     * 1. W Electronie (a więc w Obsidianie) `fetch` jest metodą okna z kontrolą odbiornika —
     *    wywołany jako `this.cokolwiek(...)` rzuca „Illegal invocation". Zdjęcie referencji
     *    do zmiennej lokalnej daje `this === undefined`, co przeglądarka mapuje na obiekt
     *    globalny.
     * 2. Odczyt PRZY KAŻDYM żądaniu, nie w konstruktorze: klient powstaje raz na starcie
     *    pluginu, a atrapy (harness, testy) podmieniają `globalThis.fetch` później —
     *    zamrożona referencja cicho omijałaby podmianę.
     */
    private wyslij(url: string, init: RequestInit): Promise<Response> {
        // Rzutowanie na obiekt z `fetch` jako ZWYKŁĄ WŁAŚCIWOŚCIĄ (`typeof fetch`), nie METODĄ
        // interfejsu `Window` — inaczej `unbound-method` doczepia się do referencji, którą
        // MUSIMY odkleić od obiektu (patrz komentarz wyżej: Illegal invocation).
        const wolaj = this.wstrzykniety ?? (hostWindow as { fetch: typeof fetch }).fetch;
        return wolaj(url, init);
    }

    /**
     * Wysyła żądanie i oddaje odpowiedź BEZ WZGLĘDU na status — 401 i 500 to normalne
     * zwrotki, nie wyjątki. Rzut znaczy wyłącznie awarię transportu albo przekroczony
     * `timeoutMs`.
     */
    async send(spec: HttpRequestSpec): Promise<HttpResponse> {
        const kontroler = new AbortController();
        let minalCzas = false;
        const zegar = spec.timeoutMs === undefined
            ? null
            : hostWindow.setTimeout(() => {
                minalCzas = true;
                kontroler.abort();
            }, spec.timeoutMs);

        try {
            const odp = await this.wyslij(spec.url, {
                method: spec.method,
                headers: spec.headers,
                body: spec.body,
                signal: kontroler.signal,
            });
            const tekst = await odp.text();
            return odpowiedz(odp.status, mapaNaglowkow(odp.headers), tekst);
        } catch (przyczyna) {
            const opis = { url: spec.url, method: spec.method, headers: spec.headers };
            throw minalCzas
                ? bladTransportu('Żądanie przekroczyło limit czasu', opis, KOD_LIMIT_CZASU)
                : bladTransportu('Żądanie nie doszło do skutku', opis, KOD_TRANSPORT, przyczyna);
        } finally {
            if (zegar !== null) hostWindow.clearTimeout(zegar);
        }
    }
}
