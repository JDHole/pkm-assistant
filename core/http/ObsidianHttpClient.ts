/**
 * `ObsidianHttpClient` — tor bez strumienia w Obsidianie.
 *
 * Funkcję `requestUrl` dostaje W KONSTRUKTORZE, dzięki czemu plik NIE importuje
 * `obsidian` i wstaje w gołym Node. Jedyny wołacz produkcyjny: `config/runtimeConfig.ts`
 * (⚠️ NIE `src/main.ts` — pilnuje tego strażnik `src/main.test.ts`).
 */
import type { HttpClient, HttpRequestSpec, HttpResponse } from './contracts.js';
import { KOD_LIMIT_CZASU, KOD_TRANSPORT, bladTransportu } from './transportErrors.js';
import { hostWindow } from '../utils/hostWindow.js';

/** Kształt funkcji `requestUrl` Obsidiana w zakresie, którego używa klient. */
export type RequestUrlFn = (params: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    throw?: boolean;
}) => Promise<{ status: number; headers: Record<string, string>; text: string; json?: unknown }>;

/** Nazwy nagłówków małymi literami — wołacz szuka `retry-after`, nie `Retry-After`. */
function mapaNaglowkow(naglowki: Record<string, string> | undefined): Record<string, string> {
    const wynik: Record<string, string> = {};
    for (const [nazwa, wartosc] of Object.entries(naglowki ?? {})) {
        wynik[nazwa.toLowerCase()] = wartosc;
    }
    return wynik;
}

/**
 * Treść odpowiedzi mostu.
 *
 * `text` po drugiej stronie bywa WYLICZANE (dekodowanie bajtów przy odczycie pola), więc samo
 * sięgnięcie po nie potrafi rzucić — a taki rzut udawałby awarię sieci przy odpowiedzi, która
 * przyszła w komplecie. Brak treści traktujemy jak pustą: status i nagłówki wołacz ma i tak,
 * a `json()` zgłosi się samo, gdy ktoś liczył na ładunek.
 */
function trescOdpowiedzi(odp: { text?: string }): string {
    try {
        return odp.text ?? '';
    } catch {
        return '';
    }
}

export class ObsidianHttpClient implements HttpClient {
    declare private readonly requestUrl: RequestUrlFn;

    constructor(requestUrl: RequestUrlFn) {
        this.requestUrl = requestUrl;
    }

    /**
     * Wysyła żądanie przez most Obsidiana (omija CORS strony `app://`).
     *
     * `throw: false` jest tu KONTRAKTEM, nie preferencją: bez niego most sam rzuca na
     * 4xx/5xx, a wołacz traci status i nie odróżni złego klucza od padu sieci.
     */
    async send(spec: HttpRequestSpec): Promise<HttpResponse> {
        const zadanie: Parameters<RequestUrlFn>[0] = {
            url: spec.url,
            method: spec.method,
            headers: spec.headers,
            throw: false,
        };
        if (spec.body !== undefined) zadanie.body = spec.body;

        const opis = { url: spec.url, method: spec.method, headers: spec.headers };
        const wlasciwe = this.requestUrl(zadanie).catch((przyczyna: unknown) => {
            throw bladTransportu('Żądanie nie doszło do skutku', opis, KOD_TRANSPORT, przyczyna);
        });

        const odp = spec.timeoutMs === undefined
            ? await wlasciwe
            : await this.zLimitem(wlasciwe, spec.timeoutMs, opis);

        const tekst = trescOdpowiedzi(odp);
        return {
            status: odp.status,
            headers: mapaNaglowkow(odp.headers),
            text: tekst,
            json<T = unknown>(): T {
                return JSON.parse(tekst) as T;
            },
        };
    }

    /**
     * Twardy limit czasu po stronie WOŁACZA.
     *
     * Mostu Obsidiana nie da się przerwać w locie, więc żądanie leci sobie dalej w tle —
     * my przestajemy na nie czekać. Odrzucenie spóźnialskiego jest wyciszane, żeby nie
     * wywrócić procesu nieobsłużoną obietnicą.
     */
    private async zLimitem<T>(
        wlasciwe: Promise<T>,
        timeoutMs: number,
        opis: { url: string; method: string; headers: Record<string, string> },
    ): Promise<T> {
        // `Window['setTimeout']`, NIE `ReturnType<typeof hostWindow.setTimeout>` — `@types/node`
        // w tym samym projekcie zlewa przeciążenia Node+DOM na `Window & typeof globalThis`,
        // a `ReturnType<>` łapie wtedy `NodeJS.Timeout` zamiast liczby, którą realnie zwraca
        // `setTimeout` w Obsidianie/harnessie (patrz ten sam gotcha w AgentSidebar.ts/CommunicatorView.ts).
        let zegar: ReturnType<Window['setTimeout']> | null = null;
        const budzik = new Promise<never>((_, odrzuc) => {
            zegar = hostWindow.setTimeout(
                () => odrzuc(bladTransportu('Żądanie przekroczyło limit czasu', opis, KOD_LIMIT_CZASU)),
                timeoutMs,
            );
        });
        wlasciwe.catch(() => { /* spóźnialski już nikogo nie obchodzi */ });
        try {
            return await Promise.race([wlasciwe, budzik]);
        } finally {
            if (zegar !== null) hostWindow.clearTimeout(zegar);
        }
    }
}
