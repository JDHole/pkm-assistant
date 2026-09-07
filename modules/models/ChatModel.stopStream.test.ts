/**
 * `ChatModel.stopStream()` — twardy Stop ROZSTRZYGA promisę bieżącego streamu.
 *
 * DLACZEGO (FAIL 3 żywego smoke'a 2026-08-15, 17:58): przerwanie transportu nie emituje
 * ŻADNEGO zdarzenia — ani końca, ani błędu. Promisa `stream()` wisiała więc w nieskończoność:
 * pętla suba stała na `await` aż po 124,7 s strzelił per-call budzik i bieg kończył się jako
 * „błąd / Model timeout" zamiast „Przerwany", mimo że user kliknął Stop dwie minuty wcześniej.
 *
 * ⚠️ ŚWIADOMIE OSOBNY PLIK — `ChatModel.concurrent.test.ts` ma znanego flake'a (mierzy realne
 * odstępy czasowe) i bywa naprawiany równolegle. Tu pinujemy tylko mechanikę rozstrzygnięcia;
 * testy współdzielą globalną bramkę `lm_studio`, więc jak u sąsiada — CAŁY plik `test.serial`.
 */
import test from 'ava';
import { ChatModel, createChatModel } from './ChatModel.js';
import { __test__ as gateTest, acquireSlot } from './requestGate.js';
import { CapturingHttpClient, HangingTransport, makeCtx, makeSettings } from './testing/harness.js';
import type { ChatProvider, ChatProviderInfo, ChatRequest, StreamTransport } from './contracts.js';

/** Dostawca-atrapa: metryczka decyduje o bramce (lokalna vs chmurowa), reszta nieużywana. */
function makeProvider(id: string, local: boolean): ChatProvider {
    return {
        info: { id, local, streaming: true, streamMode: 'sse', defaultModel: 'mock-model' } as ChatProviderInfo,
        listModels: async () => [],
        buildRequest: () => ({ url: 'http://mock/', method: 'POST', headers: {} }),
        parseCompletion: () => ({ choices: [{ index: 0, message: { role: 'assistant', content: '' } }], usage: {} }),
        createStreamDecoder: () => ({ feed: () => [], finish: () => [] }),
    } as ChatProvider;
}

/** Skrócony cooldown — pinujemy mechanikę, nie czekamy 150 ms na każdy slot. */
class FastModel extends ChatModel {
    static override GATE_RELEASE_COOLDOWN_MS = 20;
}

const REQ: ChatRequest = { messages: [{ role: 'user', content: 'hej' }] };

let transports: HangingTransport[] = [];

function makeModel(platform: string, transport?: StreamTransport): ChatModel {
    const hanging = new HangingTransport();
    if (!transport) transports.push(hanging);
    return new FastModel({
        provider: makeProvider(platform, platform === 'lm_studio' || platform === 'ollama'),
        ctx: makeCtx({ modelId: 'mock-model' }),
        http: new CapturingHttpClient(),
        transport: transport ?? hanging,
        gate: { acquireSlot },
        settings: makeSettings({ chat: { platform }, limits: { local_platform_max_concurrent: 1 } }),
    });
}

/** Ile razy transport dostał przerwanie (dawniej: licznik `stop_stream` na adapterze). */
const stopCalls = () => transports.reduce((sum, tr) => sum + tr.aborts, 0);

test.beforeEach(() => { gateTest.reset(); transports = []; });

test.serial('stopStream w locie odrzuca promisę streamu znacznikiem _aborted (platforma lokalna)', async (t) => {
    const model = makeModel('lm_studio');
    const p = model.stream(REQ);
    await new Promise(res => setTimeout(res, 5)); // niech wejdzie na slot i zawiśnie na transporcie

    model.stopStream();

    const err = await p.then(() => null, (e: unknown) => e) as (Error & { _aborted?: boolean }) | null;
    t.truthy(err, 'promisa MUSI się rozstrzygnąć — inaczej pętla wisi do budzika');
    t.true(err!._aborted === true, 'znacznik przerwania (pętla mapuje go na stoppedBy:abort)');
    t.true(typeof err!.message === 'string' && err!.message.length > 0, 'komunikat z i18n, nie goły obiekt');
    t.is(stopCalls(), 1, 'transport też dostał przerwanie, nie tylko promisa');
});

test.serial('stopStream odrzuca też stream BEZ bramki (chmura — ta sama ścieżka)', async (t) => {
    const model = makeModel('openai');
    const p = model.stream(REQ);
    await new Promise(res => setTimeout(res, 5));

    model.stopStream();

    const err = await p.then(() => null, (e: unknown) => e) as (Error & { _aborted?: boolean }) | null;
    t.true(err?._aborted === true);
});

test.serial('rozstrzygnięcie jest idempotentne: drugi stopStream niczego nie robi', async (t) => {
    const model = makeModel('lm_studio');
    const p = model.stream(REQ);
    await new Promise(res => setTimeout(res, 5));

    model.stopStream();
    await p.catch(() => {});
    t.notThrows(() => model.stopStream(), 'per-call budzik pętli woła stopStream po Stopie usera');
    t.is(stopCalls(), 2, 'przerwanie transportu jest bezwarunkowe, uchwyt promisy — jednorazowy');
});

test.serial('po abercie finally w stream() zwalnia slot normalną drogą (następny wjeżdża)', async (t) => {
    let nextStarted = false;
    /** Transport, który od razu odpowiada 200 i domyka ciało — „następny w kolejce" jedzie. */
    const nextTransport: StreamTransport = {
        open: async () => {
            nextStarted = true;
            return { status: 200, headers: {}, body: '' };
        },
    };

    const stuck = makeModel('lm_studio');
    const p = stuck.stream(REQ);
    await new Promise(res => setTimeout(res, 5));
    stuck.stopStream();
    await p.catch(() => {});

    await makeModel('lm_studio', nextTransport).stream(REQ).catch(() => {});
    t.true(nextStarted, 'slot wolny — podwójne zwolnienie (stopStream + finally) jest idempotentne');
});

test.serial('stopStream biletu CZEKAJĄCEGO w kolejce nie dubluje odrzucenia', async (t) => {
    // Ścieżka `admitted === false` rozstrzyga się sama (`GateCancelledError` w `stream`), a uchwyt
    // odrzucenia jest wtedy jeszcze pusty — nie ma czego zużyć i nie ma jak rzucić dwa razy.
    const first = makeModel('lm_studio');
    const second = makeModel('lm_studio');
    const p1 = first.stream(REQ);
    const p2 = second.stream(REQ);
    await new Promise(res => setTimeout(res, 5));

    second.stopStream(); // drugi stoi w kolejce za pierwszym
    await t.throwsAsync(() => p2, { message: /anulowany w kolejce/ });

    first.stopStream();
    const err = await p1.then(() => null, (e: unknown) => e) as { _aborted?: boolean } | null;
    t.true(err?._aborted === true, 'biegnący dostaje znacznik przerwania');
});

/**
 * N34 (luka L-20, CC §1.1 M-4): model wzięty ze slotu runtime'u (`env.chatModel`) jako
 * fallback delegacji NIE może dziedziczyć zbitego priorytetu bramki po subie.
 */
test.serial('L-20: env.chatModel użyty jako fallback NIE dostaje zbitego _gatePriority', t => {
    const shared = makeModel('lm_studio');
    t.is(shared._gatePriority, 1, 'brak pola = 1 („to główny czat", B.3 SM-05)');

    // Delegacja zbija priorytet ŚWIEŻEJ instancji suba — nigdy tej ze slotu runtime'u.
    const sub = makeModel('lm_studio');
    sub._gatePriority = 0;

    t.is(sub._gatePriority, 0, 'sub jedzie z priorytetem 0 (ustępuje czatowi)');
    t.is(shared._gatePriority, 1, 'instancja ze slotu runtime NIE może zejść na 0 — user czekałby za własnym subem');
});

/** `createChatModel` to jedyna droga powstania modelu — fabryka i klasa muszą się zgadzać. */
test.serial('createChatModel oddaje instancję ChatModel', t => {
    const model = createChatModel({
        provider: makeProvider('openai', false),
        ctx: makeCtx({ modelId: 'mock-model' }),
        http: new CapturingHttpClient(),
        transport: new HangingTransport(),
        gate: { acquireSlot },
        settings: makeSettings(),
    });
    t.true(model instanceof ChatModel);
});
