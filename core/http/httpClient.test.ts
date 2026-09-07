/**
 * Tor bez strumienia — dwa klienty o jednym kontrakcie.
 *
 * KONTRAKT: klient NIGDY nie rzuca na status ≥ 400. Status wraca w odpowiedzi, a rzut
 * znaczy awarię transportu (brak sieci, zgaszony demon, DNS) — dopiero wtedy wołacz mapuje
 * go na `kind:'transport'`.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';

import { FetchHttpClient } from './FetchHttpClient.js';
import { ObsidianHttpClient } from './ObsidianHttpClient.js';
import type { HttpRequestSpec } from './contracts.js';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function withServer(handler: Handler, fn: (url: string) => Promise<void>): Promise<void> {
    const server = http.createServer(handler);
    await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
    const port = (server.address() as { port: number }).port;
    try {
        await fn(`http://127.0.0.1:${port}/v1/models`);
    } finally {
        await new Promise<void>(res => server.close(() => res()));
    }
}

const spec = (url: string): HttpRequestSpec => ({ url, method: 'GET', headers: {} });

// ── C13.10 ───────────────────────────────────────────────────────────────────
test('FetchHttpClient nie rzuca na 4xx/5xx — status wraca w odpowiedzi', async t => {
    await withServer((_req, res) => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"invalid api key"}}');
    }, async url => {
        const odp = await new FetchHttpClient().send(spec(url));

        t.is(odp.status, 401, 'klient rzucił na 4xx — wołacz straciłby status i nie odróżni 401 od padu sieci');
        t.deepEqual(odp.json(), { error: { message: 'invalid api key' } });
    });
});

// ── C13.11 ───────────────────────────────────────────────────────────────────
test('json() rzuca na nie-JSON, text zostaje surowy', async t => {
    await withServer((_req, res) => {
        res.writeHead(502, { 'content-type': 'text/html' });
        res.end('<html>502 Bad Gateway</html>');
    }, async url => {
        const odp = await new FetchHttpClient().send(spec(url));

        t.is(odp.status, 502);
        t.is(odp.text, '<html>502 Bad Gateway</html>', 'surowa treść musi dojść do wołacza');
        t.throws(() => odp.json(), undefined, 'json() na stronie HTML musi rzucić — wołacz normalizuje to u siebie');
    });
});

test('FetchHttpClient: nagłówki odpowiedzi wracają jako mapa z kluczami małymi literami', async t => {
    await withServer((_req, res) => {
        res.writeHead(200, { 'X-Provider-Id': 'abc123', 'Content-Type': 'text/plain' });
        res.end('ok');
    }, async url => {
        const odp = await new FetchHttpClient().send(spec(url));

        t.is(odp.status, 200);
        // `odp.headers` musi być prawdziwą mapą wypełnioną przez `mapaNaglowkow` — jeśli funkcja
        // oddałaby `undefined`, ten odczyt rzuciłby TypeError zamiast dojść do porównania.
        t.is(odp.headers['x-provider-id'], 'abc123', 'nagłówek dostawcy zgubiony — wołacz nie odczyta go po nazwie małymi literami');
        t.is(odp.headers['content-type'], 'text/plain');
    });
});

test('FetchHttpClient: `timeoutMs` przerywa powolne żądanie kodem `timeout`, nie `transport`', async t => {
    await withServer((req, res) => {
        // Serwer odpowiada dużo później niż `timeoutMs` klienta — klient musi przerwać
        // WŁASNYM budzikiem, a nie czekać na padnięcie połączenia.
        const zwloka = setTimeout(() => {
            if (!res.writableEnded) {
                try { res.end('za późno'); } catch { /* gniazdo już zamknięte przez abort */ }
            }
        }, 300);
        req.on('close', () => clearTimeout(zwloka));
    }, async url => {
        const err = await t.throwsAsync(() => new FetchHttpClient().send({
            url, method: 'GET', headers: {}, timeoutMs: 20,
        }));

        t.is((err as { code?: string })?.code, 'timeout', 'limit czasu minął, ale kod błędu to nie „timeout” — wołacz nie odróżni tego od padu sieci');
        t.regex(String((err as Error).message), /limit czasu/, 'komunikat błędu nie mówi o przekroczonym limicie czasu');
    });
});

// ── C13.12 ───────────────────────────────────────────────────────────────────
test('ObsidianHttpClient dostaje requestUrl konstruktorem i NIE importuje obsidiana', async t => {
    const wywolania: Array<Record<string, unknown>> = [];
    const atrapa = async (params: Record<string, unknown>) => {
        wywolania.push(params);
        return { status: 200, headers: { 'content-type': 'application/json' }, text: '{"ok":true}' };
    };

    const klient = new ObsidianHttpClient(atrapa as never);
    const odp = await klient.send({
        url: 'https://api.example.test/v1/models',
        method: 'GET',
        headers: { 'x-api-key': 'sk-x' },
    });

    t.is(odp.status, 200);
    t.deepEqual(odp.json(), { ok: true });
    t.is(wywolania.length, 1, 'klient nie użył wstrzykniętej funkcji — sięgnął gdzie indziej');
    t.is(wywolania[0].throw, false, 'requestUrl musi dostać throw:false, inaczej 4xx wybucha zamiast wrócić statusem');

    // Strażnik po źródle: plik nie ma prawa importować `obsidian` — cały podklaster ma
    // wstawać w gołym Node (AVA bez atrapy, harness).
    const zrodlo = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'ObsidianHttpClient.ts'),
        'utf8',
    );
    t.notRegex(zrodlo, /from ['"]obsidian['"]/, 'plik zaimportował `obsidian` — barrel core przestaje być node-safe');
});
