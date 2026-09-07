/**
 * `FetchStreamTransport` — czytnik strumienia na `fetch` + `ReadableStream`.
 *
 * GRANICA: transport UJAWNIA `status` i `headers` (w tym `Retry-After`) i NIE PONAWIA
 * niczego. Backoff 429, sufit prób i budzik po Stopie to sprawa wołacza (`ChatModel`).
 * Gdyby transport dołożył własny backoff, biegłby RÓWNOLEGLE do tamtego i podwoił
 * opóźnienia — a testy tego nie złapią, bo obie warstwy są zielone osobno.
 *
 * Testy stoją na PRAWDZIWYM serwerze HTTP z `node:http` (fałszywe serwery harnessu też są
 * prawdziwym HTTP — spec §0 zasada 4), więc nie ma tu ani XHR, ani atrapy `fetch`.
 */
import http from 'node:http';
import test from 'ava';

import { FetchStreamTransport } from './FetchStreamTransport.js';
import { STREAM_TRANSPORT_TIMEOUT_MS } from './contracts.js';
import type { HttpRequestSpec, StreamSink } from './contracts.js';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function withServer(handler: Handler, fn: (url: string) => Promise<void>): Promise<void> {
    const server = http.createServer(handler);
    await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
    const port = (server.address() as { port: number }).port;
    try {
        await fn(`http://127.0.0.1:${port}/v1/stream`);
    } finally {
        await new Promise<void>(res => server.close(() => res()));
    }
}

const spec = (url: string, extra: Partial<HttpRequestSpec> = {}): HttpRequestSpec => ({
    url, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', ...extra,
});

function sink(): StreamSink & { porcje: string[] } {
    const porcje: string[] = [];
    return { porcje, onChunk(text: string) { porcje.push(text); } };
}

// ── PIN ──────────────────────────────────────────────────────────────────────
test('012: PIN — twardy limit strumienia to DOKŁADNIE 600000 ms', t => {
    t.is(STREAM_TRANSPORT_TIMEOUT_MS, 600000);
});

// ── C13.5 ────────────────────────────────────────────────────────────────────
test('porcje lecą do sink.onChunk w kolejności, bez sklejania i bez rozcinania na ramki', async t => {
    // Druga porcja idzie z serwera DOPIERO, gdy sink odebrał pierwszą — sztywne 10 ms sprawiało,
    // że pod obciążeniem obie lądowały w buforze gniazda zanim klient zaczął czytać i sklejały
    // się po stronie TCP (test mówił wtedy o czasie, nie o transporcie).
    let pierwszaOdebrana!: () => void;
    const odebrana = new Promise<void>(r => { pierwszaOdebrana = r; });
    await withServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: pierw');
        void odebrana.then(() => { res.write('sza\n\ndata: druga\n\n'); res.end(); });
    }, async url => {
        const s = sink();
        const zapisz = s.onChunk.bind(s);
        s.onChunk = (text: string) => { zapisz(text); pierwszaOdebrana(); };
        const wynik = await new FetchStreamTransport().open(spec(url), s, new AbortController().signal);

        t.is(wynik.status, 200);
        t.true(s.porcje.length >= 2, 'transport skleił porcje — traci właściwość „w kolejności przybycia"');
        t.is(s.porcje.join(''), 'data: pierwsza\n\ndata: druga\n\n',
            'transport pociął strumień na ramki — to robota parsera, nie transportu');
    });
});

// ── C13.6 ────────────────────────────────────────────────────────────────────
test('status != 200 rozstrzyga promisę {status, headers, body} BEZ rzucania', async t => {
    let uderzenia = 0;
    await withServer((_req, res) => {
        uderzenia++;
        res.writeHead(429, { 'retry-after': '7', 'content-type': 'application/json' });
        res.end('{"error":"rate limited"}');
    }, async url => {
        const s = sink();
        const wynik = await new FetchStreamTransport().open(spec(url), s, new AbortController().signal);

        t.is(wynik.status, 429);
        t.is(wynik.headers['retry-after'], '7', 'nagłówek Retry-After nie dotarł do wołacza — polityka 429 nie ma na czym stanąć');
        t.true(wynik.body.includes('rate limited'), 'ciało błędu przepadło');
        t.is(uderzenia, 1, 'TRANSPORT PONOWIŁ ŻĄDANIE — backoff należy do wołacza, inaczej opóźnienia się podwoją');
    });
});

// ── C13.7 ────────────────────────────────────────────────────────────────────
test('abort w ŚRODKU ramki przerywa czytanie i nie dosyła ogona', async t => {
    await withServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: pierwsza\n\n');
        setTimeout(() => { res.write('data: druga\n\n'); res.end(); }, 80);
    }, async url => {
        const s = sink();
        const controller = new AbortController();
        const promise = new FetchStreamTransport().open(spec(url), s, controller.signal);

        await new Promise(r => setTimeout(r, 25));
        const poPierwszej = s.porcje.length;
        controller.abort();

        await t.throwsAsync(promise, undefined, 'abort ma ODRZUCIĆ obietnicę, nie rozstrzygnąć ją cicho');
        await new Promise(r => setTimeout(r, 100));
        t.is(s.porcje.length, poPierwszej, 'porcja po abortcie i tak trafiła do odbiornika');
    });
});

// ── C13.8 ────────────────────────────────────────────────────────────────────
test('twardy timeout: brak odpowiedzi w timeoutMs kończy otwarcie', async t => {
    await withServer((_req, res) => {
        // serwer milczy — nagłówki nigdy nie lecą
        void res;
    }, async url => {
        const start = Date.now();
        await t.throwsAsync(
            new FetchStreamTransport().open(spec(url, { timeoutMs: 30 }), sink(), new AbortController().signal),
            undefined,
            'milczący serwer zawiesił otwarcie na zawsze — twardy limit nie zadziałał',
        );
        t.true(Date.now() - start < 2000, 'limit zadziałał dużo później niż podany timeoutMs');
    });
});

// ── C13.9 (K20) ──────────────────────────────────────────────────────────────
test('K20: pad BEZ ciała nie wypuszcza nagłówków żądania', async t => {
    const KLUCZ = 'sk-tajny-klucz-uzytkownika-1234567890';
    await withServer((_req, res) => {
        res.socket?.destroy(); // zerwane połączenie: zero statusu, zero ciała
    }, async url => {
        const blad = await t.throwsAsync(
            new FetchStreamTransport().open(
                spec(url, { headers: { Authorization: `Bearer ${KLUCZ}` } }),
                sink(),
                new AbortController().signal,
            ),
        );

        const tekst = `${blad?.message ?? ''} ${String(blad)} ${JSON.stringify(blad ?? {})}`.toLowerCase();
        t.false(tekst.includes(KLUCZ.toLowerCase()), 'KLUCZ API wyszedł w komunikacie błędu transportu');
        t.false(tekst.includes('bearer'), 'komunikat niesie nagłówek autoryzacji — K20 zamyka dokładnie tę drogę');
    });
});

/** Kod przyczyny, po którym wołacz odróżnia Stop od limitu czasu i od padu sieci. */
const kod = (err: unknown): string | undefined => (err as { code?: string })?.code;

/**
 * Atrapa sygnału rozdzielająca DWA sposoby zgłoszenia Stopu: zdarzenie `abort` i samo pole
 * `aborted`. Prawdziwy `AbortController` zapala oba naraz, więc na nim nie widać, czy
 * transport reaguje na KAŻDY z nich osobno — a wołacze bywają cudze (opakowania, mosty)
 * i potrafią zapalić tylko jeden.
 */
function atrapaSygnalu(): { aborted: boolean; odpalZdarzenie(): void; jako(): AbortSignal } {
    const sluchacze = new Set<() => void>();
    const atrapa = {
        aborted: false,
        addEventListener(_typ: string, fn: () => void) { sluchacze.add(fn); },
        removeEventListener(_typ: string, fn: () => void) { sluchacze.delete(fn); },
        odpalZdarzenie() { for (const fn of [...sluchacze]) fn(); },
        jako(): AbortSignal { return atrapa as unknown as AbortSignal; },
    };
    return atrapa;
}

// ── C13.10 ───────────────────────────────────────────────────────────────────
test('pad sieci ma kod `transport` — inaczej wołacz weźmie awarię za Stop i zamilknie', async t => {
    await withServer((_req, res) => {
        res.socket?.destroy(); // zerwane połączenie: ani statusu, ani ciała
    }, async url => {
        const blad = await t.throwsAsync(
            new FetchStreamTransport().open(spec(url), sink(), new AbortController().signal),
        );

        t.is(kod(blad), 'transport',
            'nikt nie naciskał Stopu i nie minął limit — to awaria transportu, a po Stopie wołacz milczy zamiast pokazać pad');
    });
});

// ── C13.11 ───────────────────────────────────────────────────────────────────
test('Stop zgłoszony SAMYM zdarzeniem `abort` kończy strumień kodem `aborted`', async t => {
    await withServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: pierwsza\n\n');
        // reszta nigdy nie przychodzi — czytanie wisi aż do Stopu
    }, async url => {
        const sygnal = atrapaSygnalu();
        const promise = new FetchStreamTransport().open(spec(url), sink(), sygnal.jako());

        await new Promise(r => setTimeout(r, 40));
        sygnal.odpalZdarzenie(); // pole `aborted` CELOWO zostaje `false`

        const blad = await t.throwsAsync(promise, undefined, 'Stop nie odrzucił obietnicy');
        t.is(kod(blad), 'aborted',
            'samo zdarzenie `abort` wystarczy za Stop — inaczej przerwanie przebiera się za awarię sieci');
    });
});
