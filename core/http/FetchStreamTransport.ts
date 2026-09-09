/**
 * `FetchStreamTransport` — `fetch` + `ReadableStream` + `TextDecoder` + `AbortController`.
 * Twardy timeout, zwrotka `{status, headers, body}`, zero ponowień (politykę prowadzi wołacz).
 */
import type {
    HttpRequestSpec,
    StreamOpenResult,
    StreamSink,
    StreamTransport,
} from './contracts.js';
import { STREAM_TRANSPORT_TIMEOUT_MS } from './contracts.js';
import {
    KOD_LIMIT_CZASU,
    KOD_PRZERWANE,
    KOD_TRANSPORT,
    bladTransportu,
} from './transportErrors.js';
import { hostWindow } from '../utils/hostWindow.js';

/** Nazwy nagłówków małymi literami — na `retry-after` stoi polityka 429 wołacza. */
function mapaNaglowkow(naglowki: Headers): Record<string, string> {
    const wynik: Record<string, string> = {};
    naglowki.forEach((wartosc, nazwa) => {
        wynik[nazwa.toLowerCase()] = wartosc;
    });
    return wynik;
}

/** Powód, dla którego czytanie się skończyło przed czasem. */
type PowodPrzerwania = 'stop' | 'limit';

/**
 * Znacznik wewnętrzny: czytanie stanęło, bo ktoś przerwał. Nigdy nie wychodzi na zewnątrz —
 * `open()` zamienia go na właściwy błąd transportu z opisem żądania (i filtrem sekretów).
 */
class PrzerwaneCzytanie extends Error {}

/**
 * Koperta na błąd, który wyszedł Z ODBIORNIKA, a nie z sieci.
 *
 * Odbiornik należy do wołacza — to on parsuje ramki i to on rzuca, gdy dostawca przysłał
 * błąd w paśmie (HTTP 200 z polem `error`). Taki błąd MUSI dojechać do wołacza w jednym
 * kawałku, ze zdaniem dostawcy: przebranie go za „awarię transportu" zamieniłoby czytelne
 * „model przeciążony, spróbuj później" w bezużyteczny token przyczyny.
 */
class BladOdbiornika extends Error {
    declare readonly wlasciwy: unknown;

    constructor(wlasciwy: unknown) {
        super('błąd odbiornika porcji');
        this.wlasciwy = wlasciwy;
    }
}

export class FetchStreamTransport implements StreamTransport {
    /** Atrapa z testów; `undefined` znaczy „bierz aktualny `fetch` środowiska". */
    declare private readonly wstrzykniety: typeof fetch | undefined;

    constructor(fetchImpl?: typeof fetch) {
        this.wstrzykniety = fetchImpl;
    }

    /**
     * Woła `fetch` BEZ ODBIORNIKA i dopiero w chwili żądania.
     *
     * W Electronie (czyli w Obsidianie) `fetch` jest metodą okna z kontrolą odbiornika:
     * wywołany jako `this.cokolwiek(...)` rzuca „Illegal invocation", a w gołym Node ta
     * sama linijka działa — więc testy niczego by nie złapały. Zmienna lokalna daje
     * `this === undefined`, co przeglądarka mapuje na obiekt globalny.
     *
     * Odczyt przy KAŻDYM otwarciu, nie w konstruktorze: transport powstaje raz na starcie
     * pluginu, a atrapy (harness, testy) podmieniają `globalThis.fetch` później.
     */
    private wyslij(url: string, init: RequestInit): Promise<Response> {
        // Rzutowanie na obiekt z `fetch` jako ZWYKŁĄ WŁAŚCIWOŚCIĄ (`typeof fetch`), nie METODĄ
        // interfejsu `Window` — inaczej `unbound-method` doczepia się do referencji, którą
        // MUSIMY odkleić od obiektu (patrz komentarz wyżej: Illegal invocation).
        const wolaj = this.wstrzykniety ?? (hostWindow as { fetch: typeof fetch }).fetch;
        return wolaj(url, init);
    }

    /**
     * Otwiera strumień i pompuje porcje do `sink` w kolejności przybycia.
     *
     * Rozstrzygnięcia:
     * - status ≠ 200 → `{status, headers, body}` BEZ rzucania (ponowienia to sprawa wołacza);
     * - status 200 → czytanie do końca ciała, potem `{status: 200, headers, body: ''}`;
     * - Stop z zewnątrz albo przekroczony `timeoutMs` → ODRZUCENIE obietnicy.
     *
     * Transport nie zna pojęcia ramki: nie skleja porcji i nie tnie ich po `\n\n`.
     */
    async open(spec: HttpRequestSpec, sink: StreamSink, signal: AbortSignal): Promise<StreamOpenResult> {
        const opis = { url: spec.url, method: spec.method, headers: spec.headers };
        if (signal.aborted) {
            // Stop zdążył przed żądaniem — nie płacimy za połączenie, którego nikt nie chce.
            throw bladTransportu('Strumień przerwany przed wysłaniem', opis, KOD_PRZERWANE);
        }

        const kontroler = new AbortController();
        let powod: PowodPrzerwania | null = null;
        const naStop = (): void => {
            powod ??= 'stop';
            kontroler.abort();
        };
        signal.addEventListener('abort', naStop, { once: true });
        const zegar = hostWindow.setTimeout(() => {
            powod ??= 'limit';
            kontroler.abort();
        }, spec.timeoutMs ?? STREAM_TRANSPORT_TIMEOUT_MS);

        try {
            const odp = await this.wyslij(spec.url, {
                method: spec.method,
                headers: spec.headers,
                body: spec.body,
                signal: kontroler.signal,
            });
            const naglowki = mapaNaglowkow(odp.headers);

            if (odp.status !== 200) {
                // Ciało błędu bywa puste (proxy, zerwane połączenie) — wtedy zostaje pustka,
                // a krótki komunikat dopisuje wołacz. Zrzut żądania NIE wchodzi w grę (sekret
                // nigdy w komunikacie błędu).
                const cialo = await odp.text().catch(() => {
                    // Ciała nie da się doczytać (zerwane połączenie w połowie błędu) — zamykamy
                    // je jawnie, żeby gniazdo nie wisiało do końca życia procesu.
                    kontroler.abort();
                    return '';
                });
                return { status: odp.status, headers: naglowki, body: cialo };
            }

            await this.czytaj(odp, sink, signal, () => powod);
            return { status: 200, headers: naglowki, body: '' };
        } catch (przyczyna) {
            if (przyczyna instanceof BladOdbiornika) {
                // Nie nasz błąd — nasze jest tylko zamknięcie połączenia, żeby bajty przestały
                // płynąć do odbiornika, który już się na nich wywrócił.
                kontroler.abort();
                throw przyczyna.wlasciwy;
            }
            if (powod === 'limit') {
                throw bladTransportu('Strumień przekroczył limit czasu', opis, KOD_LIMIT_CZASU);
            }
            if (powod === 'stop' || signal.aborted) {
                throw bladTransportu('Strumień przerwany', opis, KOD_PRZERWANE);
            }
            throw bladTransportu('Strumień nie doszedł do skutku', opis, KOD_TRANSPORT, przyczyna);
        } finally {
            hostWindow.clearTimeout(zegar);
            signal.removeEventListener('abort', naStop);
        }
    }

    /**
     * Pompuje bajty ciała do `sink`.
     *
     * `TextDecoder` pracuje w trybie strumieniowym: znak wielobajtowy rozcięty między
     * porcjami czeka na resztę zamiast zamienić się w znak zastępczy. Po Stopie ani jedna
     * porcja więcej nie trafia do odbiornika — nawet ta, którą właśnie odebraliśmy.
     */
    private async czytaj(
        odp: Response,
        sink: StreamSink,
        signal: AbortSignal,
        powod: () => PowodPrzerwania | null,
    ): Promise<void> {
        const cialo = odp.body;
        if (!cialo) {
            // Środowisko bez strumieniowego ciała (albo odpowiedź pusta) — oddajemy całość naraz.
            const tekst = await odp.text();
            if (tekst) this.oddaj(sink, tekst);
            return;
        }

        const czytnik = cialo.getReader();
        const dekoder = new TextDecoder('utf-8');
        for (;;) {
            const { done, value } = await czytnik.read();
            // Sprawdzenie PO odbiorze, a przed oddaniem: porcja, która przyszła równo ze
            // Stopem, nie ma prawa dojść do odbiornika.
            if (powod() !== null || signal.aborted) throw new PrzerwaneCzytanie();
            if (done) break;
            const tekst = dekoder.decode(value, { stream: true });
            if (tekst) this.oddaj(sink, tekst);
        }
        const ogon = dekoder.decode();
        if (ogon) this.oddaj(sink, ogon);
    }

    /**
     * Oddaje porcję odbiornikowi i pilnuje granicy odpowiedzialności: co poleci Z ODBIORNIKA,
     * wraca do wołacza NIETKNIĘTE — z jego własnym zdaniem, kodem i typem.
     *
     * Bez tego błąd w paśmie (HTTP 200 z polem `error` w ładunku) przebierałby się za awarię
     * sieci i user zamiast „dostawca przeciążony, spróbuj później" widziałby suchy token.
     */
    private oddaj(sink: StreamSink, tekst: string): void {
        try {
            sink.onChunk(tekst);
        } catch (przyczyna) {
            throw new BladOdbiornika(przyczyna);
        }
    }
}
