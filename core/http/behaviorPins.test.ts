/**
 * Piny zachowań podklastra `core/http` — druga warstwa obok trzech plików kontraktowych
 * (`frames`, `streamTransport`, `httpClient`).
 *
 * PO CO OSOBNY PLIK: tamte trzy pilnują kontraktu opisanego w planie. Ten pilnuje zachowań,
 * które kontrakt zakłada MILCZĄCO, a bez których wołacz dostałby złe dane: rozcięte
 * zakończenie linii, znak wielobajtowy na granicy porcji, sentinel jako zwykła ramka, kod
 * odróżniający Stop od limitu czasu, klucz w zapytaniu adresu i błąd, który wyszedł
 * Z ODBIORNIKA, a nie z sieci. Każdy z nich raz już był tanią pomyłką w cudzym transporcie.
 *
 * Zero atrap `fetch` tam, gdzie chodzi o sieć — serwer `node:http` na loopbacku jest tańszy
 * w utrzymaniu niż udawanie strumienia.
 */
import http from 'node:http';
import test from 'ava';

import { FetchHttpClient } from './FetchHttpClient.js';
import { FetchStreamTransport } from './FetchStreamTransport.js';
import { NdjsonFrames } from './NdjsonFrames.js';
import { ObsidianHttpClient } from './ObsidianHttpClient.js';
import { SseFrames } from './SseFrames.js';
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
    url, method: 'POST', headers: {}, body: '{}', ...extra,
});

function sink(): StreamSink & { porcje: string[] } {
    const porcje: string[] = [];
    return { porcje, onChunk(text: string) { porcje.push(text); } };
}

/** Cały ślad, jaki błąd zostawia u wołacza i w logu — na tym stoi K20. */
function slad(err: unknown): string {
    const e = err as { message?: string };
    return `${String(e?.message ?? '')} ${String(err)} ${JSON.stringify(err)}`.toLowerCase();
}

const kod = (err: unknown): string | undefined => (err as { code?: string })?.code;

// ── SseFrames ────────────────────────────────────────────────────────────────

test('SSE: sentinel platformy wraca jako ZWYKŁA ramka, bez wyróżnienia', t => {
    // Parser nie zna żadnego dostawcy. Co znaczy `[DONE]`, wie dopiero dekoder wołacza —
    // gdyby transport sam kończył strumień na tym ciągu, model piszący „[DONE]" w treści
    // ucinałby sobie odpowiedź.
    t.deepEqual(
        new SseFrames().feed('data: {"a":1}\n\ndata: [DONE]\n\n'),
        [{ data: '{"a":1}' }, { data: '[DONE]' }],
    );
});

test('SSE: para CRLF rozcięta między porcjami to JEDNO zakończenie linii, nie dwa', t => {
    // Gdyby samotny `\r` na końcu porcji domykał linię, następne `\n` domknęłoby RAMKĘ
    // w środku ładunku i wołacz dostałby połówkę JSON-a.
    const parser = new SseFrames();
    t.deepEqual(parser.feed('data: x\r'), []);
    t.deepEqual(parser.feed('\n\r\n'), [{ data: 'x' }]);
});

test('SSE: wiele linii `data:` skleja się `\\n`, `event:` wypełnia pole ramki', t => {
    t.deepEqual(
        new SseFrames().feed('event: ping\ndata: a\ndata: b\n\n'),
        [{ event: 'ping', data: 'a\nb' }],
    );
});

test('SSE: `data:` bez spacji działa, a komentarz `:` jest pomijany', t => {
    // Spacja po dwukropku należy do składni, więc jest opcjonalna; linia zaczynająca się
    // od dwukropka to sygnał podtrzymania połączenia i nie ma prawa zostać ramką.
    t.deepEqual(new SseFrames().feed(':keepalive\ndata:{"z":9}\n\n'), [{ data: '{"z":9}' }]);
});

test('SSE: `event:` bez `data:` nie tworzy ramki i nie wycieka na następną', t => {
    t.deepEqual(new SseFrames().feed('event: ping\n\ndata: tresc\n\n'), [{ data: 'tresc' }]);
});

test('SSE: puste ramki w środku nie gubią kolejnych', t => {
    t.deepEqual(
        new SseFrames().feed('\n\ndata: a\n\n\n\ndata: b\n\n'),
        [{ data: 'a' }, { data: 'b' }],
    );
});

test('SSE: znacznik BOM ginie NA POCZĄTKU strumienia, ale w treści zostaje', t => {
    // Format każe zignorować jeden BOM na starcie. Bez tego pierwsze pole nazywałoby się
    // „﻿data" i pierwsza ramka dostawcy przepadłaby bez śladu.
    t.deepEqual(new SseFrames().feed('﻿data: a\n\n'), [{ data: 'a' }]);
    t.deepEqual(new SseFrames().feed('data: ﻿a\n\n'), [{ data: '﻿a' }]);
});

test('SSE: `\\r` samotny na SAMYM KOŃCU porcji czeka na następną, nie domyka linii od razu', t => {
    // Gdyby feed() domykał linie tak jak finish() (tryb "koniec strumienia"), samotny `\r`
    // na granicy porcji zostałby od razu wzięty za koniec linii "data: x" — a druga porcja
    // zaczynająca się od zwykłego znaku (nie `\n`) otworzyłaby zupełnie nową linię zamiast
    // kontynuować to, co i tak było już policzone. Rezultat: dwie ramki zamiast jednej,
    // sklejonej `\n` zgodnie z formatem (wiele linii `data:` w jednej ramce).
    const parser = new SseFrames();
    t.deepEqual(parser.feed('data: x\r'), []);
    t.deepEqual(
        parser.feed('\ndata: y\n\n'),
        [{ data: 'x\ny' }],
        '`\\r` z poprzedniej porcji doczekał na `\\n` i domknął TĘ SAMĄ linię "data: x"',
    );
});

test('SseFrames: finish() domyka linię zakończoną samotnym `\\r`, bo strumień się kończy', t => {
    // feed() słusznie trzyma samotny końcowy `\r` w buforze (może to początek `\r\n`
    // rozciętego przez sieć). finish() wie, że kolejnej porcji już nie będzie — więc MUSI
    // potraktować ten `\r` jako pełne zakończenie linii, inaczej ostatnia ramka przepada.
    const parser = new SseFrames();
    parser.feed('data: x\n\r'); // "data: x" domknięte przez \n; samotne \r to (potencjalnie) pusta linia
    t.deepEqual(
        parser.finish(),
        [{ data: 'x' }],
        'strumień się skończył - `\\r` musiał domknąć pustą linię i zamknąć ramkę',
    );
});

test('SseFrames: po finish() flaga początku strumienia wraca, BOM znowu ginie', t => {
    // Instancja parsera bywa używana ponownie dla kolejnego logicznego strumienia (nowe
    // połączenie do tego samego dostawcy). finish() musi zresetować "czy to pierwszy znak",
    // inaczej drugi strumień z rzędu straciłby prawo do zdjęcia własnego BOM-u.
    const parser = new SseFrames();
    parser.feed('data: a\n\n');
    parser.finish();
    t.deepEqual(
        parser.feed('﻿data: b\n\n'),
        [{ data: 'b' }],
        'nowy strumień po finish() znów zdejmuje BOM ze swojego pierwszego znaku',
    );
});

test('SSE: BOM, który NIE jest pierwszym znakiem CAŁEGO strumienia, to zwykła treść', t => {
    // Po pierwszej porcji flaga początku strumienia jest zużyta. Gdyby kolejna porcja mogła
    // zacząć nowe "pierwsze zdjęcie BOM-u", dostawca wysyłający realny znak BOM w środku
    // ładunku (rzadkie, ale prawnie treść, nie nagłówek) dostałby go po cichu obcięty —
    // dokładnie to, przed czym ostrzega komentarz w `bezZnacznikaBom`.
    const parser = new SseFrames();
    parser.feed('data: a\n\n');
    t.deepEqual(
        parser.feed('﻿data: b\n\n'),
        [],
        'BOM w środku strumienia zepsuł nazwę pola "data" zamiast zniknąć - to jest oczekiwane, bo BOM to tu treść',
    );
});

test('SseFrames: `KONIEC_LINII.lastIndex` wraca do zera na starcie KAŻDEGO wywołania', t => {
    // Regex dzielący linie jest jednym, dzielonym modułowo obiektem (`g` flag, stan
    // `lastIndex` między wywołaniami). Gdyby przeszukiwanie zaczynało się choć jeden znak
    // za daleko, dopasowanie dokładnie na pozycji 0 buforu zostałoby ominięte i pierwszy
    // separator linii wpadłby jako treść do sąsiedniej linii.
    const ramki = new SseFrames().feed('\rdata: a\n\n');
    t.deepEqual(ramki, [{ data: 'a' }], '`\\r` na pozycji 0 domknął pustą linię, nie zepsuł "data: a"');
});

test('SSE: samotny `\\r` NIE NA KOŃCU bufora domyka linię od razu, bez czekania', t => {
    // Odwrotność testu "czeka na następną porcję" wyżej: `\r` w środku bufora (są po nim
    // jeszcze znaki w TEJ SAMEJ porcji) nie może być traktowany jak potencjalna połówka pary
    // `\r\n` rozciętej przez sieć — bo nic tu nie jest rozcięte, cała reszta już przyszła.
    const ramki = new SseFrames().feed('data: x\rdata: y\n\n');
    t.deepEqual(ramki, [{ data: 'x\ny' }], '`\\r` po środku bufora domknął "data: x" od razu, "data: y" doszło osobną linią');
});

test('SSE: linia pola bez dwukropka to nazwa pola z pustą wartością', t => {
    // Spec SSE dopuszcza linię pola bez dwukropka - cała linia jest wtedy nazwą pola,
    // a wartość jest pusta (nie "cała linia minus ostatni znak").
    t.deepEqual(new SseFrames().feed('data\n\n'), [{ data: '' }], 'pole "data" bez dwukropka = wartość pusta, nie ucięta linia');
});

// ── NdjsonFrames ─────────────────────────────────────────────────────────────

test('NDJSON: CRLF nie wchodzi do ładunku, a urwany ogon czeka na resztę', t => {
    const parser = new NdjsonFrames();
    t.deepEqual(parser.feed('{"a":1}\r\n{"b":2}\r\n{"c":'), [{ data: '{"a":1}' }, { data: '{"b":2}' }]);
    t.deepEqual(parser.feed('3}\n'), [{ data: '{"c":3}' }]);
    t.deepEqual(parser.finish(), []);
});

test('NDJSON: ostatnia linia bez `\\n` wychodzi z finish(), gdy jest całym JSON-em', t => {
    // Serwer bywa oszczędny i nie kończy ostatniej linii. Kompletny obiekt oddajemy;
    // urwany fragment ginie — dekoder i tak by się na nim wywrócił.
    const kompletny = new NdjsonFrames();
    t.deepEqual(kompletny.feed('{"done":true}'), []);
    t.deepEqual(kompletny.finish(), [{ data: '{"done":true}' }]);

    const urwany = new NdjsonFrames();
    t.deepEqual(urwany.feed('{"done":'), []);
    t.deepEqual(urwany.finish(), []);
});

// ── FetchStreamTransport ─────────────────────────────────────────────────────

test('status 500 dociera z ciałem i DOKŁADNIE jednym uderzeniem w serwer', async t => {
    let uderzenia = 0;
    await withServer((_q, res) => { uderzenia++; res.writeHead(500); res.end('boom'); }, async url => {
        const wynik = await new FetchStreamTransport()
            .open(spec(url), sink(), new AbortController().signal);
        t.is(wynik.status, 500);
        t.is(wynik.body, 'boom');
        t.is(uderzenia, 1, 'transport nie ponawia — politykę prowadzi wołacz');
    });
});

test('Stop PRZED wysłaniem nie płaci za połączenie', async t => {
    let uderzenia = 0;
    await withServer((_q, res) => { uderzenia++; res.writeHead(200); res.end(); }, async url => {
        const stop = new AbortController();
        stop.abort();
        const err = await t.throwsAsync(() => new FetchStreamTransport().open(spec(url), sink(), stop.signal));
        t.is(kod(err), 'aborted');
        t.is(uderzenia, 0, 'żądanie, którego nikt już nie chce, nie ma prawa polecieć');
    });
});

test('znak wielobajtowy rozcięty między porcjami składa się z powrotem', async t => {
    // Bez dekodowania strumieniowego połówka znaku zamienia się w znak zastępczy, a wina
    // spada dopiero na parser ramek („niesparsowalny JSON") — o dwa piętra za późno.
    const tresc = 'data: zażółć gesla jazn\n\n';
    await withServer((_q, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const bajty = Buffer.from(tresc, 'utf8');
        res.write(bajty.subarray(0, 9));
        setTimeout(() => { res.write(bajty.subarray(9)); res.end(); }, 15);
    }, async url => {
        const odbiornik = sink();
        await new FetchStreamTransport().open(spec(url), odbiornik, new AbortController().signal);
        const calosc = odbiornik.porcje.join('');
        t.false(calosc.includes('�'), 'znak zastępczy = dekoder nie pracował strumieniowo');
        t.is(calosc, tresc);
    });
});

test('kod błędu odróżnia limit czasu od Stopu', async t => {
    // Wołacz na tej różnicy stoi: po Stopie ma zamilknąć, po limicie — pokazać awarię.
    await withServer(() => { /* serwer milczy */ }, async url => {
        const limit = await t.throwsAsync(
            () => new FetchStreamTransport().open(spec(url, { timeoutMs: 30 }), sink(), new AbortController().signal),
        );
        t.is(kod(limit), 'timeout');

        const stop = new AbortController();
        stop.abort();
        const przerwane = await t.throwsAsync(() => new FetchStreamTransport().open(spec(url), sink(), stop.signal));
        t.is(kod(przerwane), 'aborted');
    });
});

test('K20: klucz z ZAPYTANIA adresu nie wychodzi w komunikacie błędu', async t => {
    // Część dostawców przyjmuje klucz w query stringu — pełny adres w komunikacie byłby
    // wyciekiem równie dotkliwym jak nagłówek.
    const KLUCZ = 'AIzaSyTAJNYKLUCZDOSTAWCY1234567890';
    await withServer((_q, res) => res.socket?.destroy(), async url => {
        const err = await t.throwsAsync(
            () => new FetchStreamTransport().open(spec(`${url}?key=${KLUCZ}`), sink(), new AbortController().signal),
        );
        t.false(slad(err).includes(KLUCZ.toLowerCase()), `klucz wyciekł: ${String((err as Error).message)}`);
    });
});

test('200 domknięte bez żadnego sentinela rozstrzyga się normalnie, a treść zostaje u wołacza', async t => {
    // Transport nie wie, co kończy strumień danego dostawcy — decyzja „to był koniec czy
    // urwanie" należy do wołacza i musi dostać do niej materiał, nie wyjątek.
    const smiec = 'data: {niesparsowalne\n\nnie-ramka bez dwukropka\n';
    await withServer((_q, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(smiec);
    }, async url => {
        const odbiornik = sink();
        const wynik = await new FetchStreamTransport().open(spec(url), odbiornik, new AbortController().signal);
        t.is(wynik.status, 200);
        t.is(wynik.body, '', 'ciało błędu jest puste, bo błędu nie było');
        t.is(odbiornik.porcje.join(''), smiec, 'transport niczego nie parsuje i niczego nie poprawia');
    });
});

test('błąd Z ODBIORNIKA wraca do wołacza NIETKNIĘTY (błąd w paśmie przy HTTP 200)', async t => {
    // Dostawca potrafi odesłać awarię w ładunku przy statusie 200. Rozpoznaje ją dekoder
    // wołacza i to on rzuca — jeśli transport przebrałby ten rzut za „awarię sieci", user
    // zamiast zdania dostawcy zobaczyłby suchy token przyczyny.
    const wlasny = Object.assign(new Error('Upstream provider is overloaded, try again later.'), {
        code: 'server_error',
        http_status: 200,
    });
    await withServer((_q, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"error":{"message":"overloaded"}}\n\n');
    }, async url => {
        const wybuchowy: StreamSink = { onChunk() { throw wlasny; } };
        const err = await t.throwsAsync(
            () => new FetchStreamTransport().open(spec(url), wybuchowy, new AbortController().signal),
        );
        t.is(err, wlasny, 'ten sam obiekt błędu, nie kopia i nie opakowanie');
        t.is((err as { code?: string }).code, 'server_error');
        t.is(err?.message, 'Upstream provider is overloaded, try again later.');
    });
});

test('nagłówki żądania idą do serwera BEZ ingerencji transportu', async t => {
    // Klucz jedzie pod nazwą z metryczki dostawcy. Transport nie zna dostawców, więc nie ma
    // prawa nic dokładać ani przemianowywać.
    let widziane: http.IncomingHttpHeaders = {};
    await withServer((req, res) => {
        widziane = req.headers;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: ok\n\n');
    }, async url => {
        const naglowki = { 'x-api-key': 'sk-klucz-dostawcy-123', 'anthropic-version': '2023-06-01' };
        await new FetchStreamTransport().open(spec(url, { headers: naglowki }), sink(), new AbortController().signal);
        t.is(widziane['x-api-key'], 'sk-klucz-dostawcy-123');
        t.is(widziane['anthropic-version'], '2023-06-01');
    });
});

// ── Klienci bez strumienia ───────────────────────────────────────────────────

test('ObsidianHttpClient: most dostaje `throw:false`, a 401 wraca jako zwykła odpowiedź', async t => {
    // Bez `throw:false` most sam rzuca na 4xx i wołacz traci status — nie odróżni złego
    // klucza od padu sieci, więc ponowi żądanie, które ponowienia nie ma jak naprawić.
    let zadanie: { throw?: boolean } | null = null;
    const klient = new ObsidianHttpClient(async (params) => {
        zadanie = params;
        return { status: 401, headers: { 'Retry-After': '3' }, text: 'nope' };
    });

    const odp = await klient.send({
        url: 'https://dostawca.example/v1/x', method: 'POST', headers: { 'x-api-key': 'k' }, body: '{}',
    });

    t.is(zadanie!.throw, false);
    t.is(odp.status, 401);
    t.is(odp.headers['retry-after'], '3', 'nazwy nagłówków znormalizowane — wołacz czyta małymi literami');
    t.throws(() => odp.json(), undefined, 'treść nie jest JSON-em, więc json() ma się zgłosić');
});

test('ObsidianHttpClient: odrzucenie mostu rzuca BEZ klucza i bez słowa „bearer"', async t => {
    const KLUCZ = 'sk-tajny-klucz-1234567890';
    const klient = new ObsidianHttpClient(async () => {
        throw new Error(`net fail for Bearer ${KLUCZ}`);
    });

    const err = await t.throwsAsync(() => klient.send({
        url: `https://dostawca.example/v1/x?token=${KLUCZ}`,
        method: 'POST',
        headers: { Authorization: `Bearer ${KLUCZ}` },
        body: '{}',
    }));

    t.is(kod(err), 'transport');
    const widoczne = slad(err);
    t.false(widoczne.includes(KLUCZ.toLowerCase()), `klucz w komunikacie: ${String((err as Error).message)}`);
    t.false(widoczne.includes('bearer'), 'nawet nazwa schematu autoryzacji nie ma po co tam być');
});

test('ObsidianHttpClient: `timeoutMs` uwalnia wołacza, a spóźnialski nie wywraca procesu', async t => {
    // Mostu nie da się przerwać w locie — żądanie leci sobie dalej. Kontrakt mówi tylko tyle,
    // że my przestajemy na nie czekać, i że jego późniejsze odrzucenie ma właściciela.
    let odrzuc: (powod: unknown) => void = () => { /* ustawiane niżej */ };
    const klient = new ObsidianHttpClient(() => new Promise((_, rej) => { odrzuc = rej; }));

    const err = await t.throwsAsync(() => klient.send({
        url: 'https://dostawca.example/v1/x', method: 'POST', headers: {}, body: '{}', timeoutMs: 20,
    }));
    t.is(kod(err), 'timeout');

    odrzuc(new Error('spóźniona odpowiedź mostu'));
    await new Promise(res => setTimeout(res, 10));
    t.pass('brak nieobsłużonego odrzucenia po czasie');
});

test.serial('ObsidianHttpClient: `timeoutMs` sprząta budzik po sukcesie — spóźnialski naprawdę skasowany', async t => {
    // Jeśli budzik nie zostanie skasowany, żyje dalej po zwróceniu odpowiedzi — a to właśnie
    // ten budzik jest odrzucany w poprzednim teście „bez wywalenia procesu". Licznik wołań
    // `clearTimeout` jest jedynym oknem na to zachowanie: `zegar` jest prywatną zmienną `zLimitem`.
    // `test.serial`, bo podmiana globalnego `clearTimeout` łapie WSZYSTKIE równoległe testy —
    // konkurencyjne testy w tym pliku też odpalają timery i psują licznik.
    const oryginalny = globalThis.clearTimeout;
    let wolania = 0;
    Object.defineProperty(globalThis, 'clearTimeout', {
        configurable: true,
        writable: true,
        value: ((id: Parameters<typeof clearTimeout>[0]) => { wolania += 1; return oryginalny(id); }) as typeof clearTimeout,
    });

    try {
        const klient = new ObsidianHttpClient(async () => ({ status: 200, headers: {}, text: '{}' }));
        await klient.send({
            url: 'https://dostawca.example/v1/x', method: 'GET', headers: {}, timeoutMs: 1000,
        });
        t.is(wolania, 1, 'sukces musi skasować budzik dokładnie raz — inaczej timer wisi do timeoutMs');
    } finally {
        Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, writable: true, value: oryginalny });
    }
});

test.serial('FetchHttpClient: `timeoutMs` sprząta budzik po sukcesie — spóźnialski naprawdę skasowany', async t => {
    // Bliźniaczy pin dla `FetchHttpClient` — ma WŁASNY lokalny `zegar` (osobny tor bez
    // strumienia), niezależny od `ObsidianHttpClient`. Bez skasowania budzika timer wisi
    // do `timeoutMs` mimo że żądanie już się skończyło.
    const oryginalny = globalThis.clearTimeout;
    let wolania = 0;
    Object.defineProperty(globalThis, 'clearTimeout', {
        configurable: true,
        writable: true,
        value: ((id: Parameters<typeof clearTimeout>[0]) => { wolania += 1; return oryginalny(id); }) as typeof clearTimeout,
    });

    try {
        const klient = new FetchHttpClient(async () => new Response('{}', { status: 200 }));
        await klient.send({ url: 'https://dostawca.example/v1/x', method: 'GET', headers: {}, timeoutMs: 1000 });
        t.is(wolania, 1, 'sukces musi skasować budzik dokładnie raz — inaczej timer wisi do timeoutMs');
    } finally {
        Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, writable: true, value: oryginalny });
    }
});

test('ObsidianHttpClient: body trafia do mostu tylko gdy podane w spec — nigdy jako pole widmo', async t => {
    // Bez tego rozróżnienia GET bez ciała i POST z ciałem wyglądają dla mostu identycznie
    // (albo odwrotnie: ciało ginie po drodze), a most rozstrzyga metodę też po obecności `body`.
    const zadania: Array<Record<string, unknown>> = [];
    const klient = new ObsidianHttpClient(async (params) => {
        zadania.push(params as unknown as Record<string, unknown>);
        return { status: 200, headers: {}, text: '' };
    });

    await klient.send({ url: 'https://dostawca.example/v1/a', method: 'POST', headers: {}, body: '{"x":1}' });
    await klient.send({ url: 'https://dostawca.example/v1/b', method: 'GET', headers: {} });

    t.is(zadania[0].body, '{"x":1}', 'ciało podane w spec musi dojść do mostu');
    t.false('body' in zadania[1], 'brak ciała w spec nie ma prawa dopisać pola `body` (nawet jako undefined)');
});

test('ObsidianHttpClient: rzut przy odczycie treści wraca jako pusty string, nie `undefined`', async t => {
    // `text` po stronie mostu bywa WYLICZANE (dekodowanie bajtów), więc samo sięgnięcie po nie
    // potrafi rzucić. Kontrakt mówi: brak treści = pusta, nie `undefined` — inaczej `json()`
    // dostaje śmieć zamiast normalnego rzutu na pustym stringu, a odpowiedź łamie `HttpResponse.text: string`.
    const atrapa = async () => ({
        status: 200,
        headers: {},
        get text(): string {
            throw new Error('treść wyliczana rzuciła przy odczycie');
        },
    });
    const klient = new ObsidianHttpClient(atrapa as never);

    const odp = await klient.send({ url: 'https://dostawca.example/v1/x', method: 'GET', headers: {} });

    t.is(odp.text, '', 'rzut przy odczycie ma dać pusty string — `undefined` łamie kontrakt `HttpResponse.text: string`');
    t.throws(() => odp.json(), undefined, 'pusta treść nie jest JSON-em, `json()` ma się zgłosić');
});

test('FetchHttpClient: awaria transportu rzuca błąd z kodem i bez sekretów', async t => {
    const KLUCZ = 'sk-drugi-tajny-klucz-99887766';
    const klient = new FetchHttpClient();

    const err = await t.throwsAsync(() => klient.send({
        // Port zamknięty na loopbacku: pewna awaria połączenia, zero zależności od sieci.
        url: `http://127.0.0.1:1/v1/models?key=${KLUCZ}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${KLUCZ}` },
    }));

    t.is(kod(err), 'transport');
    t.false(slad(err).includes(KLUCZ.toLowerCase()), 'adres w komunikacie idzie bez zapytania');
});

// ── K-01 / Electron: `fetch` nie może dostać odbiornika ───────────────────────
// W gołym Node `this.cokolwiek(...)` na funkcji `fetch` przechodzi, w Electronie (czyli
// w Obsidianie) rzuca „Illegal invocation". Pin trzyma wywołanie bez odbiornika, bo tej
// różnicy nie widać w żadnym teście jadącym w Node.

/** Atrapa `fetch`, która zapamiętuje, z jakim `this` ją wywołano. */
function atrapaZPodgladem(): { fetch: typeof fetch; odbiornik: () => unknown } {
    let widziany: unknown = '<nie wywołano>';
    const impl = function (this: unknown): Promise<Response> {
        widziany = this;
        return Promise.resolve(new Response('{}', { status: 200 }));
    };
    return { fetch: impl as unknown as typeof fetch, odbiornik: () => widziany };
}

const bezOdbiornika = (widziany: unknown): boolean => widziany === undefined || widziany === globalThis;

test('FetchHttpClient: `fetch` wołany BEZ odbiornika (Illegal invocation w Electronie)', async t => {
    const atrapa = atrapaZPodgladem();
    await new FetchHttpClient(atrapa.fetch).send({ url: 'https://x.example/y', method: 'GET', headers: {} });
    t.true(bezOdbiornika(atrapa.odbiornik()), 'fetch dostał obiekt klienta jako `this`');
});

test('FetchStreamTransport: `fetch` wołany BEZ odbiornika', async t => {
    const atrapa = atrapaZPodgladem();
    await new FetchStreamTransport(atrapa.fetch).open(
        spec('https://x.example/y'),
        { onChunk() { /* pusta odpowiedź atrapy */ } },
        new AbortController().signal,
    );
    t.true(bezOdbiornika(atrapa.odbiornik()), 'fetch dostał obiekt transportu jako `this`');
});

test('podmiana `globalThis.fetch` PO konstrukcji jest widziana (harness stawia atrapy późno)', async t => {
    const oryginal = globalThis.fetch;
    const klient = new FetchHttpClient();
    const transport = new FetchStreamTransport();
    let uderzenia = 0;
    Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: () => { uderzenia += 1; return Promise.resolve(new Response('podmiana', { status: 200 })); },
    });
    try {
        const odp = await klient.send({ url: 'https://x.example/y', method: 'GET', headers: {} });
        t.is(odp.text, 'podmiana');
        await transport.open(spec('https://x.example/y'), { onChunk() { /* bez treści */ } }, new AbortController().signal);
        t.is(uderzenia, 2, 'zamrożona w konstruktorze referencja ominęła podmianę');
    } finally {
        Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: oryginal });
    }
});

// ── Granice porcji: atrapa `fetch` zamiast gniazda ───────────────────────────
// Tu chodzi o RĘCZNIE wyznaczone granice porcji i o odpowiedź bez strumieniowego ciała —
// czego przez prawdziwe gniazdo nie da się ustawić powtarzalnie (system sam decyduje, ile
// bajtów przyjdzie naraz). Sieci te piny nie dotyczą, więc atrapa niczego nie zafałszowuje.

/** Odpowiedź 200 ze strumieniem o DOKŁADNIE takich granicach porcji, jakie podano. */
function atrapaStrumienia(porcje: Uint8Array[]): typeof fetch {
    return (() => {
        const cialo = new ReadableStream<Uint8Array>({
            start(kontroler) {
                for (const porcja of porcje) kontroler.enqueue(porcja);
                kontroler.close();
            },
        });
        return Promise.resolve(new Response(cialo, {
            status: 200, headers: { 'content-type': 'text/event-stream' },
        }));
    }) as unknown as typeof fetch;
}

/** Odpowiedź BEZ `body` — środowisko bez strumieniowego ciała (mosty, polyfille). */
function atrapaBezStrumienia(tresc: string): typeof fetch {
    return (() => Promise.resolve({
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: null,
        text: () => Promise.resolve(tresc),
    } as unknown as Response)) as unknown as typeof fetch;
}

const adres = 'https://x.example/v1/stream';

test('ogon dekodera: znak urwany na końcu ciała dolatuje, a porcja pusta NIE leci', async t => {
    // Ostatnia porcja to POŁÓWKA dwubajtowego znaku: dekoder strumieniowy zwraca z niej
    // pustkę (odbiornik nie ma prawa dostać pustej porcji), a znak zastępczy wychodzi
    // dopiero z domknięcia dekodera. Bez tego domknięcia ostatni znak ciała ginie bez śladu.
    const polowka = Buffer.from('ą', 'utf8').subarray(0, 1);
    const odbiornik = sink();

    await new FetchStreamTransport(atrapaStrumienia([Buffer.from('data: ', 'utf8'), polowka]))
        .open(spec(adres), odbiornik, new AbortController().signal);

    t.deepEqual(odbiornik.porcje, ['data: ', '\uFFFD'],
        'albo ogon dekodera przepadł, albo odbiornik dostał pustą porcję');
});

test('domknięty strumień nie kończy się PUSTĄ porcją', async t => {
    // Pusta porcja na końcu jest niewidoczna w sklejeniu treści, a u wołacza potrafi
    // udawać zdarzenie („przyszło coś nowego") i domknąć ramkę przed czasem.
    const odbiornik = sink();

    await new FetchStreamTransport(atrapaStrumienia([Buffer.from('data: ok\n\n', 'utf8')]))
        .open(spec(adres), odbiornik, new AbortController().signal);

    t.deepEqual(odbiornik.porcje, ['data: ok\n\n']);
});

test('odpowiedź BEZ strumieniowego ciała: całość jednym kawałkiem, pustka wcale', async t => {
    const pelna = sink();
    await new FetchStreamTransport(atrapaBezStrumienia('data: ok\n\n'))
        .open(spec(adres), pelna, new AbortController().signal);
    t.deepEqual(pelna.porcje, ['data: ok\n\n'], 'treść odpowiedzi bez strumienia nie dotarła do odbiornika');

    const pusta = sink();
    const wynik = await new FetchStreamTransport(atrapaBezStrumienia(''))
        .open(spec(adres), pusta, new AbortController().signal);
    t.deepEqual(pusta.porcje, [], 'odbiornik dostał pustą porcję z pustej odpowiedzi');
    t.is(wynik.status, 200);
});

test('sygnał zgłaszający SAM `aborted` zatrzymuje porcje w pół strumienia', async t => {
    // Wołacz bywa cudzy: opakowanie sygnału potrafi podnieść `aborted`, nie wysyłając
    // zdarzenia. Porcja, która przyszła równo ze Stopem, i tak nie ma prawa dojść dalej,
    // a obietnica musi ODRZUCIĆ się kodem Stopu — nie rozstrzygnąć się jak udany strumień.
    const sygnal = { aborted: false, addEventListener() { /* zdarzenie nie przyjdzie */ }, removeEventListener() { /* — */ } };
    const porcje: string[] = [];
    const odbiornik: StreamSink = { onChunk(tekst) { porcje.push(tekst); sygnal.aborted = true; } };

    const err = await t.throwsAsync(() => new FetchStreamTransport(atrapaStrumienia([
        Buffer.from('data: pierwsza\n\n', 'utf8'),
        Buffer.from('data: druga\n\n', 'utf8'),
    ])).open(spec(adres), odbiornik, sygnal as unknown as AbortSignal));

    t.is(kod(err), 'aborted', 'Stop przebrał się za awarię sieci albo strumień domknął się jak udany');
    t.deepEqual(porcje, ['data: pierwsza\n\n'], 'porcja po Stopie i tak trafiła do odbiornika');
});

test('ciała błędu nie da się doczytać: `body` to PUSTY łańcuch, a połączenie zostaje zamknięte', async t => {
    // Zerwane połączenie w połowie ciała błędu. Wołacz ma dostać pustkę (K20 każe mu dopisać
    // własny krótki komunikat), a gniazdo nie ma prawa wisieć do końca życia procesu.
    let widziany: RequestInit | undefined;
    const atrapa = ((_url: string, init: RequestInit) => {
        widziany = init;
        return Promise.resolve({
            status: 502,
            headers: new Headers({ 'retry-after': '3' }),
            body: null,
            text: () => Promise.reject(new Error('zerwane w połowie ciała')),
        } as unknown as Response);
    }) as unknown as typeof fetch;

    const wynik = await new FetchStreamTransport(atrapa).open(spec(adres), sink(), new AbortController().signal);

    t.is(wynik.status, 502);
    t.is(wynik.body, '', 'wołacz dostał coś innego niż pusty łańcuch — nie ma jak odróżnić „serwer milczał" od awarii odczytu');
    t.is(wynik.headers['retry-after'], '3', 'nagłówki muszą dojechać nawet bez ciała — na nich stoi polityka 429');
    t.true((widziany?.signal as AbortSignal | undefined)?.aborted,
        'nieudany odczyt ciała zostawił otwarte gniazdo');
});
