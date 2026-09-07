import test from 'ava';
import { ChatModel } from './ChatModel.js';
import { acquireSlot } from './requestGate.js';
// CALY PLIK test.serial (audyt nocny 2026-08-13, modul 9): testy dziela globalna
// bramke platformy lm_studio i statyczne liczniki szpiega rownoleglosci, a czesc
// mierzy realne odstepy czasowe. Rownolegle bily sie o ten sam stan - determinizm
// wisial przypadkiem na produkcyjnym cooldownie 150 ms (przy 0 pakiet padal,
// izolacja przechodzila). Serial = kazdy test ma bramke i liczniki dla siebie.
import { CapturingHttpClient, makeCtx, makeSettings } from './testing/harness.js';
import type {
    ChatModelDeps,
    ChatProvider,
    ChatProviderInfo,
    ChatRequest,
    OpenAiCompletion,
    StreamHandlers,
    StreamOpenResult,
    StreamDecoder,
    StreamEvent,
    StreamSink,
    StreamTransport,
} from './contracts.js';

/** Żądanie w tym teście niesie gołą treść — atrapa dostawcy nie potrzebuje nic więcej. */
const reqWith = (prompt: string): ChatRequest => ({ messages: [{ role: 'user', content: prompt }] });
const EMPTY_REQ: ChatRequest = { messages: [] };

const infoOf = (id: string, local: boolean): ChatProviderInfo => ({
    id, local, streaming: true, streamMode: 'sse', defaultModel: 'mock-model',
} as ChatProviderInfo);

/**
 * Dekoder-atrapa kształtu OpenAI. Model rozumie WYŁĄCZNIE zdarzenia dekodera, więc pusty
 * dekoder nie umiałby oddać ani treści (`answer:…`), ani sentinela `data: [DONE]` —
 * a bez sentinela każda tura tego pliku kończyłaby się trzecim wyjściem streamu.
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

/**
 * Dostawca-atrapa. Cały ruch idzie przez wstrzyknięty transport, więc dostawca jest tu
 * nośnikiem metryczki (bramka czyta z niej `local`), ciała żądania (transport-echo szuka
 * w nim promptu) i dekodera.
 */
function makeProvider(id: string): ChatProvider {
    return {
        info: infoOf(id, id === 'lm_studio' || id === 'ollama'),
        listModels: async () => [],
        buildRequest: (req) => ({ url: 'http://mock/', method: 'POST', headers: {}, body: JSON.stringify(req) }),
        parseCompletion: (body) => body as OpenAiCompletion,
        createStreamDecoder: () => sseDecoderStub(),
    } as ChatProvider;
}

/**
 * Transport sterowany funkcją `onOpen` — zastępuje dawne atrapy adapterów
 * (`MockAdapter`/`ConcurrencySpyAdapter`/`HangingAdapter`/`StampAdapter`/`NextAdapter`).
 */
function makeTransport(onOpen: (spec: unknown, sink: StreamSink) => Promise<StreamOpenResult>): StreamTransport {
    return { open: (spec, sink) => onOpen(spec, sink) };
}

/** Transport oddający treść jako jedną ramkę SSE i domykający ciało. */
function echoTransport(delayFor: (body: string) => number): StreamTransport {
    return makeTransport(async (spec, sink) => {
        const body = String((spec as { body?: string }).body ?? '');
        await new Promise(resolve => setTimeout(resolve, delayFor(body)));
        sink.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { content: `answer:${body}` } }] })}\n\n`);
        sink.onChunk('data: [DONE]\n\n');
        return { status: 200, headers: {}, body: '' };
    });
}

function makeModel(platform: string, transport: StreamTransport, Cls: typeof ChatModel = ChatModel): ChatModel {
    const deps: ChatModelDeps = {
        provider: makeProvider(platform),
        ctx: makeCtx({ modelId: 'mock-model' }),
        http: new CapturingHttpClient(),
        transport,
        gate: { acquireSlot },
        settings: makeSettings({ chat: { platform }, limits: { local_platform_max_concurrent: 1 } }),
    };
    return new Cls(deps);
}

test.serial('ChatModel.stream parallel calls return distinct provider responses', async t => {
    const prompts = ['What is 1+1?', 'What is 2+2?', 'What is 3+3?'];
    const transport = makeTransport(async (spec, sink) => {
        const raw = String((spec as { body?: string }).body ?? '');
        const prompt = prompts.find(p => raw.includes(p)) ?? raw;
        await new Promise(resolve => setTimeout(resolve, prompt.includes('2+2') ? 5 : 1));
        sink.onChunk(`data: ${JSON.stringify({ choices: [{ delta: { content: `answer:${prompt}` } }] })}\n\n`);
        sink.onChunk('data: [DONE]\n\n');
        return { status: 200, headers: {}, body: '' };
    });

    const responses = await Promise.all(
        prompts.map(prompt => makeModel('openai', transport).stream(reqWith(prompt))),
    );

    t.deepEqual(
        responses.map(r => r.choices[0].message.content),
        prompts.map(prompt => `answer:${prompt}`),
    );
});

// ── Bramka platform lokalnych (Zwis subagentow, lokalny most, 2026) ────────────────────────

/** Transport-szpieg: mierzy, ile streamów biegnie RÓWNOCZEŚNIE. */
function makeSpyTransport(): { transport: StreamTransport; state: { active: number; maxActive: number } } {
    const state = { active: 0, maxActive: 0 };
    const transport = makeTransport(async (_spec, sink) => {
        state.active++;
        state.maxActive = Math.max(state.maxActive, state.active);
        await new Promise(resolve => setTimeout(resolve, 5));
        state.active--;
        sink.onChunk('data: [DONE]\n\n');
        return { status: 200, headers: {}, body: '' };
    });
    return { transport, state };
}

test.serial('bramka lokalna: 3 streamy do lm_studio ida gesiego (max 1 naraz), chmura bez bramki', async t => {
    const local = makeSpyTransport();
    // Osobna instancja per request — jak w produkcie (suby: skipCache w modelResolver).
    await Promise.all([1, 2, 3].map(() => makeModel('lm_studio', local.transport).stream(EMPTY_REQ)));
    t.is(local.state.maxActive, 1); // lokalna platforma: gesiego

    const cloud = makeSpyTransport();
    await Promise.all([1, 2, 3].map(() => makeModel('openai', cloud.transport).stream(EMPTY_REQ)));
    t.is(cloud.state.maxActive, 3); // chmura: prawdziwa rownoleglosc
});

// Test 3 (2026-08-11 17:40): po przerwaniu transportu nie leci ani koniec, ani blad, wiec
// finally w stream() nie rusza - stopStream MUSI sam zwolnic slot biegnacego biletu, inaczej
// nastepny request (glowny czat) stoi w kolejce za trupem na zawsze.
test.serial('bramka lokalna: stopStream BIEGNACEGO streamu zwalnia slot (nastepny wjezdza)', async t => {
    const hangingTransport = makeTransport(() => new Promise<StreamOpenResult>(() => {})); // wisi jak most

    const stuck = makeModel('lm_studio', hangingTransport);
    void stuck.stream(EMPTY_REQ).catch(() => {}); // trzyma slot, nigdy nie wraca
    await new Promise(res => setTimeout(res, 5));

    stuck.stopStream(); // timeout/stop ubija - slot MUSI byc wolny

    let nextStarted = false;
    const nextTransport = makeTransport(async (_spec, sink) => {
        nextStarted = true;
        sink.onChunk('data: [DONE]\n\n');
        return { status: 200, headers: {}, body: '' };
    });
    await makeModel('lm_studio', nextTransport).stream(EMPTY_REQ);
    t.true(nextStarted, 'po stopStream trupa nastepny request dostaje slot');
});

// ── Cooldown zwolnienia slotu (audyt nocny 2026-08-13, modul 9) ──────────────────────
// Commit fb58207 dolozyl GATE_RELEASE_COOLDOWN_MS = 150 jako lekarstwo na incydent
// 2026-08-11: transport konczyl KAZDY stream przerwaniem, a request wystrzelony
// milisekundy pozniej dostawal od Chromium gniazdo z puli w trakcie rozbiorki i wisial
// 120 s. Fix wjechal BEZ ani jednego testu - mutacja stalej na 0 przechodzila caly plik
// w izolacji. Ponizsze testy pinuja mechanizm, zeby cisza po tej zmianie byla slyszalna.
//
// 2026-08-15: pierwotna wersja mierzyla odstep zegarem sciennym (Date.now przed/po)
// z marginesem -10 ms i FLAKE'owala pod pelnym `npm test` — timer libuv liczy termin od
// czasu petli zcache'owanego na starcie iteracji, wiec pod obciazonym CPU odpala
// „wczesniej" wzgledem stempli Date.now() (zmierzone: gap 69 ms przy cooldownie 80 ms).
// Teraz testy przechwytuja seam `ChatModel.scheduleGateRelease` i pinuja WIECEJ,
// bez jednego pomiaru czasu: (a) zwolnienie slotu idzie wylacznie przez zaplanowany
// callback — dopoki nie odpalony, nastepny stream NIE dostaje slotu, (b) zaplanowany
// odstep to dokladnie GATE_RELEASE_COOLDOWN_MS (hardcode 0 w wywolaniu tez by wpadl),
// (c) po odpaleniu callbacka kolejka rusza. Wartosc produkcyjna pinuje osobny test nizej.

/** Inny niz produkcyjne 150, zeby zlapac hardcode: odstep MUSI plynac ze stalej klasy. */
const TEST_COOLDOWN_MS = 80;

/** Podklasa z przechwyconym seamem czasu: zaplanowane zwolnienia laduja w `scheduled`
 *  zamiast w setTimeout — test odpala je recznie i W PELNI kontroluje uplyw cooldownu. */
const makeSeamModel = () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    class SeamModel extends ChatModel {
        static override GATE_RELEASE_COOLDOWN_MS = TEST_COOLDOWN_MS;
        static override scheduleGateRelease(fn: () => void, ms: number): void { scheduled.push({ fn, ms }); }
    }
    // Drenaz na koniec testu: bramka `lm_studio` jest globalna (mapa w requestGate),
    // wiec nieodpalone zwolnienia przeciekalyby slotem do nastepnego testu w pliku.
    // release() jest idempotentne — podwojne odpalenie nie szkodzi.
    const drain = () => { scheduled.forEach(s => s.fn()); };
    return { SeamModel, scheduled, drain };
};

/** Dwie tury makrotaskow: kazda sciezka „slot zwolniony → transport ruszyl" (czyste
 *  mikrotaski, requestGate nie ma timerow) zdazy sie wykonac, jesli w ogole moze. */
const flushTasks = async () => {
    await new Promise(res => setTimeout(res, 0));
    await new Promise(res => setTimeout(res, 0));
};

test.serial('bramka lokalna: slot zwalnia sie z cooldownem - nastepny stream nie wskakuje na gniazdo w rozbiorce', async t => {
    const { SeamModel, scheduled, drain } = makeSeamModel();
    const starts: number[] = [];
    const stampTransport = makeTransport(async (_spec, sink) => {
        starts.push(Date.now());
        await new Promise(res => setTimeout(res, 1));
        sink.onChunk('data: [DONE]\n\n');
        return { status: 200, headers: {}, body: '' };
    });

    try {
        // Oba strzelaja naraz: pierwszy bierze slot, drugi laduje w kolejce.
        const p1 = makeModel('lm_studio', stampTransport, SeamModel).stream(EMPTY_REQ);
        const p2 = makeModel('lm_studio', stampTransport, SeamModel).stream(EMPTY_REQ);
        await p1;

        t.is(scheduled.length, 1, 'finally pierwszego streamu zaplanowalo zwolnienie przez seam');
        t.is(scheduled[0].ms, TEST_COOLDOWN_MS, 'zaplanowany odstep = GATE_RELEASE_COOLDOWN_MS klasy');
        await flushTasks();
        t.is(starts.length, 1, 'cooldown trzyma slot: drugi stream NIE ruszyl przed odpaleniem callbacka');

        scheduled[0].fn(); // uplyw cooldownu
        await p2;
        t.is(starts.length, 2, 'po cooldownie drugi stream wjezdza na slot');
    } finally {
        drain();
    }
});

// Sciezka z incydentu: stream NIE konczy sie sam, tylko przerwaniem. Tu gniazdo jest
// najswiezsze w rozbiorce, wiec to wlasnie tu cooldown musi zadzialac.
test.serial('bramka lokalna: stopStream biegnacego streamu tez zwalnia slot przez cooldown', async t => {
    const { SeamModel, scheduled, drain } = makeSeamModel();
    const hangingTransport = makeTransport(() => new Promise<StreamOpenResult>(() => {}));
    let nextStarted = false;
    const nextTransport = makeTransport(async (_spec, sink) => {
        nextStarted = true;
        sink.onChunk('data: [DONE]\n\n');
        return { status: 200, headers: {}, body: '' };
    });

    try {
        const stuck = makeModel('lm_studio', hangingTransport, SeamModel);
        void stuck.stream(EMPTY_REQ).catch(() => {});
        // Czekamy na BILET, nie na sztywne 5 ms: pod obciazeniem (pelny `npm test`)
        // stopStream trafial w pusty bilet i nic nie planowal (flake 2026-08-22).
        for (let i = 0; i < 400 && !(stuck as unknown as { _gateTicket: unknown })._gateTicket; i++) {
            await new Promise(res => setTimeout(res, 5));
        }
        t.truthy((stuck as unknown as { _gateTicket: unknown })._gateTicket, 'wiszacy stream zajal slot');

        stuck.stopStream();
        t.is(scheduled.length, 1, 'stopStream zaplanowal zwolnienie slotu przez seam');
        t.is(scheduled[0].ms, TEST_COOLDOWN_MS, 'zaplanowany odstep = GATE_RELEASE_COOLDOWN_MS klasy');

        const nextP = makeModel('lm_studio', nextTransport, SeamModel).stream(EMPTY_REQ);
        await flushTasks();
        t.false(nextStarted, 'cooldown trzyma slot po abercie: nastepny stream NIE ruszyl przed odpaleniem callbacka');

        scheduled[0].fn(); // uplyw cooldownu
        await nextP;
        t.true(nextStarted, 'po cooldownie nastepny request dostaje slot');
    } finally {
        drain();
    }
});

// Pin na wartosc produkcyjna. 150 ms nie jest okragla liczba z sufitu - to odstep,
// przy ktorym most przestal gubic body (incydent 2026-08-11 18:52). Zejscie do zera
// bez tego pinu nie zapala zadnej lampki.
test.serial('bramka lokalna: domyslny cooldown zwolnienia slotu to 150ms', t => {
    t.is(ChatModel.GATE_RELEASE_COOLDOWN_MS, 150);
});

test.serial('bramka lokalna: stopStream anuluje request czekajacy w kolejce (handlers.error + reject)', async t => {
    const { transport } = makeSpyTransport();
    const first = makeModel('lm_studio', transport);
    const second = makeModel('lm_studio', transport);
    const p1 = first.stream(EMPTY_REQ);

    let errFromHandlers: unknown = null;
    const handlers: StreamHandlers = { error: (e) => { errFromHandlers = e; } };
    const p2 = second.stream(EMPTY_REQ, handlers);
    second.stopStream(); // anuluj, zanim dostal slot

    await t.throwsAsync(() => p2, { message: /anulowany w kolejce/ });
    t.truthy(errFromHandlers);
    await t.notThrowsAsync(() => p1); // pierwszy dojezdza normalnie
});

/** Nieużywany dziś helper zostawiony celowo poza testami byłby martwym kodem — patrz `echoTransport`. */
test.serial('echoTransport oddaje treść żądania jako odpowiedź (helper pliku)', async t => {
    const model = makeModel('openai', echoTransport(() => 0));
    const out = await model.stream(reqWith('ping'));
    t.true(String(out.choices[0].message.content).startsWith('answer:'));
});

// Poprawka po weryfikacji clean-room (2026-09-06): `complete()` zerowało `_gateTicket`
// BIEGNĄCEJ tury strumienia (instancja nie jest concurrent-safe, ale wołaczom nikt tego
// nie zabrania). Tura zwalnia slot właśnie przez to pole, więc na platformie lokalnej
// (pojemność 1) slot zostawał zajęty na zawsze i kolejka stawała — objaw identyczny
// z incydentem „zwis subagentów", tylko z zupełnie innego powodu.
test.serial('bramka lokalna: complete() nie zabiera biletu biegnącej turze strumienia', async t => {
    const hangingTransport = makeTransport(() => new Promise<StreamOpenResult>(() => {}));
    const stuck = makeModel('lm_studio', hangingTransport);
    const widok = stuck as unknown as { _gateTicket: unknown };

    void stuck.stream(EMPTY_REQ).catch(() => {});
    for (let i = 0; i < 400 && !widok._gateTicket; i++) {
        await new Promise(res => setTimeout(res, 5));
    }
    const biletStreamu = widok._gateTicket;
    t.truthy(biletStreamu, 'wiszący stream zajął slot');

    // Tor bez strumienia na TEJ SAMEJ instancji. Bramka lokalna ma pojemność 1, więc jego
    // bilet ląduje w kolejce — i nie ma prawa dotknąć niczego, co należy do tury streamu.
    let rozstrzygniete = false;
    const completeP = stuck.complete(EMPTY_REQ).then(
        () => { rozstrzygniete = true; },
        () => { rozstrzygniete = true; },
    );
    await flushTasks();

    t.is(widok._gateTicket, biletStreamu, 'complete() wyzerował bilet biegnącej tury');
    t.false(rozstrzygniete, 'complete() wjechał na slot zajęty przez stream');

    // Dowód końcowy: skoro bilet tury ocalał, Stop ma czym zwolnić slot i kolejka rusza.
    stuck.stopStream();
    await completeP;

    let nastepnyRuszyl = false;
    const nextTransport = makeTransport(async (_spec, sink) => {
        nastepnyRuszyl = true;
        sink.onChunk('data: [DONE]\n\n');
        return { status: 200, headers: {}, body: '' };
    });
    await makeModel('lm_studio', nextTransport).stream(EMPTY_REQ);
    t.true(nastepnyRuszyl, 'slot został zajęty na zawsze — kolejka platformy lokalnej stanęła');
});
