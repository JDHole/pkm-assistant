/**
 * Polityka 429 — okno backoffu (luka L-01, B.5 ST-12).
 *
 * Transport NIE ponawia niczego: ujawnia `status` i `headers`, a politykę prowadzi
 * `ChatModel`. Testy przechwytują seam `ChatModel.scheduleRetry` — zero realnego czekania,
 * zero pomiarów zegara ściennego (klasa usterki, której ten projekt już raz się nauczył
 * unikać: patrz nagłówek `ChatModel.concurrent.test.ts`).
 */
import test from 'ava';
import { ChatModel } from './ChatModel.js';
import { openaiProvider } from './providers/openai.js';
import { STREAM_RETRY_BASE_DELAY_MS, STREAM_MAX_RETRIES } from './contracts.js';
import { __test__ as gateTest, acquireSlot } from './requestGate.js';
import { CapturingHttpClient, ScriptedTransport, makeCtx, makeSettings } from './testing/harness.js';
import type { ChatRequest } from './contracts.js';

const REQ: ChatRequest = { messages: [{ role: 'user', content: 'czesc' }] };

/** Podklasa z przechwyconym seamem czasu: zaplanowane ponowienia lądują w `scheduled`. */
function makeRetryModel() {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    class SeamModel extends ChatModel {
        static override scheduleRetry(fn: () => void, ms: number): void { scheduled.push({ fn, ms }); }
    }
    const transport = new ScriptedTransport();
    const model = new SeamModel({
        provider: openaiProvider,
        ctx: makeCtx({ modelId: 'gpt-4o', apiKey: 'sk-test' }),
        http: new CapturingHttpClient(),
        transport,
        gate: { acquireSlot },
        settings: makeSettings({ chat: { platform: 'openai' } }),
    });
    return { model, transport, scheduled };
}

const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise(res => setImmediate(res));
};

test.beforeEach(() => { gateTest.reset(); });

test.serial('L-01: okno backoffu 429 rośnie wykładniczo od STREAM_RETRY_BASE_DELAY_MS', async t => {
    const { model, transport, scheduled } = makeRetryModel();
    const p = model.stream(REQ, {});

    // Trzy kolejne 429 — po każdym model planuje ponowienie przez seam i sam je odpala.
    for (let round = 0; round < STREAM_MAX_RETRIES; round++) {
        await flush();
        t.is(transport.opens, round + 1, `runda ${round}: transport otwarty dokładnie raz na próbę`);
        transport.fail(429, '', {});
        await flush();
        t.is(scheduled.length, round + 1, `runda ${round}: zaplanowano dokładnie jedno ponowienie`);
        scheduled[round].fn();
    }

    await flush();
    transport.fail(429, '', {});
    await p.catch(() => { /* wyczerpany sufit */ });

    t.deepEqual(
        scheduled.map(s => s.ms),
        [STREAM_RETRY_BASE_DELAY_MS, STREAM_RETRY_BASE_DELAY_MS * 2, STREAM_RETRY_BASE_DELAY_MS * 4],
        'kolejne okna: 1500, 3000, 6000 ms — wykładniczo ×2 od bazy z kontraktu',
    );
    t.is(STREAM_RETRY_BASE_DELAY_MS, 1500, 'baza jest faktem kontraktowym');
});

test.serial('429 z nagłówkiem Retry-After wygrywa nad backoffem wykładniczym', async t => {
    const { model, transport, scheduled } = makeRetryModel();
    const p = model.stream(REQ, {});

    await flush();
    transport.fail(429, '', { 'retry-after': '7' });
    await flush();

    t.is(scheduled.length, 1, 'jedno zaplanowane ponowienie');
    t.is(scheduled[0].ms, 7000, 'Retry-After w sekundach (7) wygrywa nad bazą 1500 ms');

    // Sprzątanie: odpalamy i domykamy turę sentinelem.
    scheduled[0].fn();
    await flush();
    transport.push('data: [DONE]\n\n');
    transport.closeOk();
    await p.catch(() => { /* sprzątanie */ });
});

/**
 * F10 (mutacje): `Retry-After: 0` to poprawna odpowiedź serwera („ponów od razu"), a nie
 * brak nagłówka. Bez tego testu zaostrzenie warunku do `> 0` przechodziło cały pakiet:
 * model dokładałby userowi 1,5 s czekania tam, gdzie serwer wyraźnie powiedział „już".
 */
test.serial('L-01: Retry-After: 0 daje ZEROWE okno backoffu, nie bazowe 1500 ms', async t => {
    const { model, transport, scheduled } = makeRetryModel();
    const p = model.stream(REQ, {});

    await flush();
    transport.fail(429, '', { 'retry-after': '0' });
    await flush();

    t.is(scheduled.length, 1, 'jedno zaplanowane ponowienie');
    t.is(scheduled[0].ms, 0, 'serwer powiedział „ponów natychmiast" — model nie ma prawa dokładać własnego backoffu');

    // Sprzątanie: odpalamy ponowienie i domykamy turę sentinelem.
    scheduled[0].fn();
    await flush();
    transport.push('data: [DONE]\n\n');
    transport.closeOk();
    await p.catch(() => { /* sprzątanie */ });
});

/** `Retry-After` z datą (RFC 9110 dopuszcza obie formy) NIE jest liczbą — wraca backoff. */
test.serial('L-01: Retry-After z datą jest ignorowany — zostaje backoff wykładniczy', async t => {
    const { model, transport, scheduled } = makeRetryModel();
    const p = model.stream(REQ, {});

    await flush();
    transport.fail(429, '', { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' });
    await flush();

    t.is(scheduled[0].ms, STREAM_RETRY_BASE_DELAY_MS, 'nieliczbowa wartość nie może zamienić się w 0 ani w NaN');

    scheduled[0].fn();
    await flush();
    transport.push('data: [DONE]\n\n');
    transport.closeOk();
    await p.catch(() => { /* sprzątanie */ });
});
