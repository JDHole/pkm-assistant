/**
 * Bramka równoległości platform lokalnych — co `ChatModel` PODAJE bramce (luki L-04/L-05/L-06).
 *
 * Sama bramka (`requestGate.ts`) ma własny komplet testów; tutaj pinujemy WEJŚCIE: klucz,
 * pojemność i priorytet, z jakimi model prosi o slot. Bramka jest wstrzykiwana, więc atrapa
 * zapisuje argumenty bez żadnego globalnego stanu.
 */
import test from 'ava';
import { ChatModel } from './ChatModel.js';
import { CapturingHttpClient, ScriptedTransport, makeCtx, makeSettings, makeSpyGate } from './testing/harness.js';
import type { ChatProvider, ChatProviderInfo, ChatRequest, GateTicket, ModelSettingsBag, RequestGateLike, StreamDecoder, StreamEvent, StreamHandlers } from './contracts.js';

const REQ: ChatRequest = { messages: [{ role: 'user', content: 'hej' }] };

/**
 * Dekoder-atrapa kształtu OpenAI. Musi być ŻYWY, nie pusty: model rozumie wyłącznie
 * zdarzenia dekodera, więc dostawca bez dekodera nie umiałby oddać ani treści, ani
 * sentinela — a ten plik pinuje kolejność `gate_admitted` → `chunk`.
 */
function sseDecoderStub(): StreamDecoder {
    let buffer = '';
    return {
        feed(chunk: string): StreamEvent[] {
            buffer += chunk;
            const out: StreamEvent[] = [];
            let cut = buffer.indexOf('\n\n');
            while (cut !== -1) {
                const line = buffer.slice(0, cut).trim();
                buffer = buffer.slice(cut + 2);
                cut = buffer.indexOf('\n\n');
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6);
                if (payload === '[DONE]') { out.push({ type: 'done' }); continue; }
                try {
                    const json = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
                    const delta = json.choices?.[0]?.delta?.content;
                    if (delta) out.push({ type: 'text', delta });
                } catch { /* zepsuta porcja nie kończy strumienia */ }
            }
            return out;
        },
        finish: () => [],
    };
}

function providerFor(id: string): ChatProvider {
    return {
        info: { id, local: id === 'lm_studio' || id === 'ollama', streaming: true, streamMode: 'sse' } as ChatProviderInfo,
        listModels: async () => [],
        buildRequest: (req) => ({ url: 'http://mock/', method: 'POST', headers: {}, body: JSON.stringify(req) }),
        parseCompletion: () => ({ choices: [{ index: 0, message: { role: 'assistant', content: '' } }], usage: {} }),
        createStreamDecoder: () => sseDecoderStub(),
    } as ChatProvider;
}

function makeModel(platform: string, settings: ModelSettingsBag) {
    const gate = makeSpyGate();
    const transport = new ScriptedTransport();
    const model = new ChatModel({
        provider: providerFor(platform),
        ctx: makeCtx({ modelId: 'mock-model' }),
        http: new CapturingHttpClient(),
        transport,
        gate,
        settings,
    });
    return { model, gate, transport };
}

const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise(res => setImmediate(res));
};

/** Domyka turę sentinelem, żeby nie zostawiać wiszących promis. */
async function finish(transport: ScriptedTransport, p: Promise<unknown>): Promise<void> {
    transport.push('data: [DONE]\n\n');
    transport.closeOk();
    await p.catch(() => { /* sprzątanie */ });
}

test('L-05: stream() PODAJE bramce priorytet z _gatePriority (brak pola = 1)', async t => {
    const settings = makeSettings({ chat: { platform: 'lm_studio' }, limits: { local_platform_max_concurrent: 2 } });

    const plain = makeModel('lm_studio', settings);
    const p1 = plain.model.stream(REQ, {});
    await flush();
    t.is(plain.gate.calls[0].priority, 1, 'brak pola = 1 („to główny czat", B.3 SM-05)');
    await finish(plain.transport, p1);

    const sub = makeModel('lm_studio', settings);
    sub.model._gatePriority = 0;
    const p2 = sub.model.stream(REQ, {});
    await flush();
    t.is(sub.gate.calls[0].priority, 0, 'sub zbity na 0 ustępuje czatowi w kolejce');
    await finish(sub.transport, p2);
});

test('L-06: pojemność bramki lokalnej czytana z pkmAssistant.limits.local_platform_max_concurrent', async t => {
    const cases: Array<[unknown, number, string]> = [
        [3, 3, 'wartość z ustawień jedzie wprost'],
        [undefined, 1, 'brak ustawienia = 1 (najostrożniejszy default)'],
        [0, 1, 'wartość poniżej widełek podciągana do 1'],
        [999, 10, 'wartość powyżej widełek przycinana do sufitu 10'],
    ];

    for (const [value, expected, why] of cases) {
        const limits: Record<string, number> = value === undefined ? {} : { local_platform_max_concurrent: value as number };
        const { model, gate, transport } = makeModel('lm_studio', makeSettings({ chat: { platform: 'lm_studio' }, limits }));
        const p = model.stream(REQ, {});
        await flush();
        t.is(gate.calls[0].limit, expected, why);
        t.is(gate.calls[0].key, 'lm_studio', 'klucz bramki to nazwa platformy — różne platformy = różne bramki');
        await finish(transport, p);
    }
});

test('L-04: _streamGateLimit() oddaje pojemność bramki tej platformy (chmura = 0)', t => {
    const local = makeModel('lm_studio', makeSettings({ chat: { platform: 'lm_studio' }, limits: { local_platform_max_concurrent: 4 } }));
    t.is(local.model._streamGateLimit(), 4, 'platforma lokalna: pojemność z ustawień');

    const cloud = makeModel('openai', makeSettings({ chat: { platform: 'openai' }, limits: { local_platform_max_concurrent: 4 } }));
    t.is(cloud.model._streamGateLimit(), 0, 'chmura: 0 = bramka WYŁĄCZONA, zero kolejki');
});

test('gate_admitted leci NATYCHMIAST dla platformy bez bramki', async t => {
    const { model, transport } = makeModel('openai', makeSettings({ chat: { platform: 'openai' } }));
    const order: string[] = [];
    const handlers: StreamHandlers = {
        gate_admitted: () => { order.push('gate_admitted'); },
        chunk: () => { order.push('chunk'); },
    };

    const p = model.stream(REQ, handlers);
    await flush();
    transport.push('data: {"choices":[{"delta":{"content":"hej"}}]}\n\n');
    transport.push('data: [DONE]\n\n');
    transport.closeOk();
    await p;

    t.is(order[0], 'gate_admitted', 'pętla przezbraja tym budziki — musi dojść PRZED pierwszym chunkiem');
    t.true(order.includes('chunk'));
});

// ── F10 (mutacje): cykl życia biletu, którego nie pilnował żaden test ────────
//
// Bieg mutacyjny na `ChatModel.ts` pokazał trzy nieprzypięte miejsca: bilet toru BEZ
// strumienia (branie i oddawanie go przy Stopie) oraz strażnik podwójnego zwolnienia slotu.

/** Bilet sterowany z testu: wjazd rozstrzyga test, a `cancel`/`release` się liczą. */
interface ControlledTicket extends GateTicket {
    cancels: number;
    releases: number;
    admit(ok?: boolean): void;
}

/** Bramka, która NIKOGO nie wpuszcza sama z siebie — każdy bilet czeka na test. */
function makeControlledGate(): RequestGateLike & { tickets: ControlledTicket[] } {
    const tickets: ControlledTicket[] = [];
    return {
        tickets,
        acquireSlot(): GateTicket {
            let settle!: (ok: boolean) => void;
            const ticket: ControlledTicket = {
                cancels: 0,
                releases: 0,
                queued: true,
                admitted: new Promise<boolean>(res => { settle = res; }),
                admit(ok = true) { settle(ok); },
                cancel() { ticket.cancels += 1; settle(false); },
                release() { ticket.releases += 1; },
            };
            tickets.push(ticket);
            return ticket;
        },
    };
}

const WISI = Symbol('promisa nie rozstrzygnięta');

/** Czeka na rozstrzygnięcie albo oddaje `WISI` — zamiast wieszać cały bieg testów. */
async function settleOrHang(p: Promise<unknown>, ms = 400): Promise<unknown> {
    return Promise.race([
        p.then(v => ({ ok: v }), e => ({ err: e })),
        new Promise<symbol>(res => setTimeout(() => res(WISI), ms)),
    ]);
}

/** Model na sterowanej bramce; zwolnienia slotu lądują w `scheduled` zamiast w setTimeout. */
function makeGatedModel(gate: RequestGateLike, http = new CapturingHttpClient({ body: {} })) {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    class SeamModel extends ChatModel {
        static override scheduleGateRelease(fn: () => void, ms: number): void { scheduled.push({ fn, ms }); }
    }
    const transport = new ScriptedTransport();
    const model = new SeamModel({
        provider: providerFor('lm_studio'),
        ctx: makeCtx({ modelId: 'mock-model' }),
        http,
        transport,
        gate,
        settings: makeSettings({ chat: { platform: 'lm_studio' }, limits: { local_platform_max_concurrent: 1 } }),
    });
    return { model, transport, scheduled };
}

test('Stop anuluje bilet toru BEZ strumienia stojący w kolejce', async t => {
    const gate = makeControlledGate();
    const { model } = makeGatedModel(gate);

    const p = model.complete(REQ); // bilet czeka w kolejce: nikt go nie wpuścił
    await flush();
    model.stopStream();

    const out = await settleOrHang(p);
    t.not(out, WISI, 'complete() stojące w kolejce MUSI się rozstrzygnąć po Stopie, nie wisieć bez końca');
    t.regex(String((out as { err?: { message?: string } })?.err?.message ?? ''), /anulowany w kolejce/);
    t.is(gate.tickets[0].cancels, 1, 'Stop anuluje bilet, którym nikt nie wjechał na slot');
});

test('bilet toru bez strumienia jest oddawany po zakończeniu — późniejszy Stop go nie rusza', async t => {
    const gate = makeControlledGate();
    const { model, scheduled } = makeGatedModel(gate);

    const p = model.complete(REQ);
    await flush();
    gate.tickets[0].admit();
    await p;

    t.is(scheduled.length, 1, 'wjazd na slot rozlicza się zwolnieniem z cooldownem');
    model.stopStream();
    t.is(gate.tickets[0].cancels, 0, 'bilet już rozliczony — Stop nie ma prawa go ruszać (cancel na cudzym slocie)');

    scheduled[0].fn();
    t.is(gate.tickets[0].releases, 1, 'slot wraca do bramki dokładnie raz');
});

test('wybuch bramki przy nowym żądaniu nie zwalnia slotu poprzedniej tury po raz drugi', async t => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    class SeamModel extends ChatModel {
        static override scheduleGateRelease(fn: () => void, ms: number): void { scheduled.push({ fn, ms }); }
    }
    let acquisitions = 0;
    let releases = 0;
    const gate: RequestGateLike = {
        acquireSlot(): GateTicket {
            acquisitions += 1;
            if (acquisitions === 2) throw new Error('bramka padla');
            return {
                admitted: Promise.resolve(true),
                queued: false,
                cancel: (): void => {},
                release: (): void => { releases += 1; },
            };
        },
    };
    const transport = new ScriptedTransport();
    const model = new SeamModel({
        provider: providerFor('lm_studio'),
        ctx: makeCtx({ modelId: 'mock-model' }),
        http: new CapturingHttpClient(),
        transport,
        gate,
        settings: makeSettings({ chat: { platform: 'lm_studio' }, limits: { local_platform_max_concurrent: 1 } }),
    });

    const p1 = model.stream(REQ, {});
    await flush();
    transport.push('data: [DONE]\n\n');
    transport.closeOk();
    await p1;
    t.is(scheduled.length, 1, 'zakończona tura planuje DOKŁADNIE jedno zwolnienie slotu');

    // Druga tura nie wchodzi nawet do kolejki: bramka wybucha przy braniu biletu.
    let handlerError: unknown = null;
    let threwSynchronously = false;
    let p2: Promise<unknown> | null = null;
    try { p2 = model.stream(REQ, { error: (e) => { handlerError = e; } }); } catch { threwSynchronously = true; }

    t.false(threwSynchronously, 'wybuch bramki NIE może wylecieć synchronicznie — pętla łapie go tylko na promisie');
    const out = await settleOrHang(p2!);
    t.not(out, WISI, 'nieudane wejście do kolejki rozstrzyga turę');
    t.truthy(handlerError, 'handlers.error dostaje powód');
    t.is(scheduled.length, 1, 'nieudana tura NIE zwalnia po raz drugi slotu tury poprzedniej — to zabrałoby slot komuś innemu');

    scheduled[0].fn();
    t.is(releases, 1, 'bilet poprzedniej tury wraca do bramki dokładnie raz');
});
