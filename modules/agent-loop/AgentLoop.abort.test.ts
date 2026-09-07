/**
 * AgentLoop — PRZERWANIE z zewnątrz kończy pętlę uczciwie, nie błędem.
 *
 * DLACZEGO ten plik istnieje (FAIL 3 żywego smoke'a 2026-08-15, 17:58):
 * user kliknął Stop na biegu suba. `requestStop` → `abortCtl.stop()` →
 * `ChatModel.stopStream()` → `xhr.abort()`. Adapter po abercie NIE woła ani
 * `done()`, ani `error()`, więc promisa streamu wisiała — pętla stała na `await`
 * aż po 124,7 s strzelił per-call budzik. Karta biegu kończyła się jako **błąd**
 * („Model timeout"), a panel do tego czasu pokazywał „zatrzymywanie…".
 *
 * Fix ma dwie warstwy: `stopStream` ROZSTRZYGA promisę (znacznik `_aborted`,
 * `modules/models/ChatModel.stopStream.test.ts`), a pętla mapuje takie
 * odrzucenie na `stoppedBy:'abort'` — czyli na zejście, które runner tłumaczy na
 * status `aborted` i powiadomienie „przerwany". Te testy pinują drugą warstwę.
 */
import test from 'ava';
import { runAgentLoop } from './AgentLoop.js';
import { ArrayMessageStore } from './MessageStore.js';

type Payload = Record<string, unknown>;
type StreamHandlers = { chunk: (r: unknown) => void; done: (r: unknown) => void; error: (e: unknown) => void };
type TraceEvent = { type: string; fields: Record<string, unknown> };

/** Błąd w kształcie, jaki od tej pory oddaje `ChatModel.stopStream()`. */
function abortError(): Error & { _aborted: true } {
    return Object.assign(new Error('Strumień modelu przerwany (Stop).'), { _aborted: true as const });
}

/** Model, którego stream odrzuca podanym błędem — ścieżką callbackową (jak adapter). */
function makeRejectingModel(err: unknown) {
    return {
        stopCalls: 0,
        stream(_payload: Payload, handlers: StreamHandlers): void {
            Promise.resolve().then(() => handlers.error(err));
        },
        stopStream() { this.stopCalls++; },
    };
}

const store = () => new ArrayMessageStore([{ role: 'user', content: 'zrób coś' }]);

test('odrzucenie ze znacznikiem _aborted kończy pętlę jako abort, bez rzucania', async (t) => {
    const model = makeRejectingModel(abortError());
    const events: TraceEvent[] = [];

    const result = await runAgentLoop({
        model,
        store: store(),
        resolveTools: () => [],
        executeToolCall: async () => 'x',
        limits: { maxIterations: 3 },
        trace: (type, fields) => events.push({ type, fields }),
    });

    t.is(result.stoppedBy, 'abort');
    t.is(result.finalText, '', 'nic nie zdążyło przyjść — pusty tekst, nie komunikat błędu');
    const end = events.filter(e => e.type === 'loop.end');
    t.is(end.length, 1, 'dokładnie jedno domknięcie pętli w trace');
    t.is(end[0].fields.stop, 'abort', 'trace mówi abort, nie error');
});

test('shouldAbort() = true przykrywa nawet błąd BEZ znacznika (Stop wyścigł się z awarią)', async (t) => {
    // Ścieżka czatu: `stop_generation` ustawia `_abortedStream` PRZED `stopStream`, więc
    // pętla ma dowód przerwania nawet gdy adapter odbije zwykłym błędem sieci po abercie.
    const model = makeRejectingModel(new Error('socket hang up'));
    const result = await runAgentLoop({
        model,
        store: store(),
        resolveTools: () => [],
        executeToolCall: async () => 'x',
        limits: { maxIterations: 3 },
        shouldAbort: () => true,
    });
    t.is(result.stoppedBy, 'abort');
});

test('zwykły błąd modelu (bez abortu) dalej LECI W GÓRĘ jako wyjątek', async (t) => {
    // Kontrola negatywna: fix nie ma prawa zamienić awarii w ciche „przerwano".
    const model = makeRejectingModel(new Error('502 bad gateway'));
    const events: TraceEvent[] = [];

    await t.throwsAsync(
        () => runAgentLoop({
            model,
            store: store(),
            resolveTools: () => [],
            executeToolCall: async () => 'x',
            limits: { maxIterations: 3 },
            trace: (type, fields) => events.push({ type, fields }),
        }),
        { message: '502 bad gateway' },
    );
    t.is(events.filter(e => e.type === 'loop.end')[0].fields.stop, 'error');
});

test('per-call budzik dalej wygrywa swój wyścig: timeout to BŁĄD, nie abort', async (t) => {
    // Budzik woła `model.stopStream()`, a ten od tej pory odrzuca promisę streamu znacznikiem
    // `_aborted`. Kolejność jest kontraktem: odrzucenie z `stopStream` wędruje przez ŁAŃCUCH
    // mikrozadań (`Promise.race` w `_streamViaAdapter` → `await` w `stream()` → `.catch` w
    // `stream()`), a budzik odrzuca swoją promisę SYNCHRONICZNIE tuż po `stopStream()` —
    // więc wyścig `Promise.race` rozstrzyga timeout i tura kończy się jak dotąd błędem.
    // Atrapa oddaje tę asynchroniczność (jeden skok wystarczy, produkcja ma ich kilka).
    const model = {
        stopCalls: 0,
        settle: null as null | ((e: unknown) => void),
        stream(_payload: Payload, handlers: StreamHandlers): void {
            this.settle = (e: unknown) => { void Promise.resolve().then(() => handlers.error(e)); };
        },
        stopStream() { this.stopCalls++; this.settle?.(abortError()); },
    };

    await t.throwsAsync(
        () => runAgentLoop({
            model,
            store: store(),
            resolveTools: () => [],
            executeToolCall: async () => 'x',
            limits: { maxIterations: 2, perCallTimeoutMs: 30 },
        }),
        { message: /Model timeout/ },
    );
    t.is(model.stopCalls, 1, 'budzik ubił request (stopStream), zanim rzucił timeoutem');
});

test('onGateAdmitted (Z2) leci do wołacza przy każdym wpuszczeniu na slot', async (t) => {
    // Sygnał jest fire-and-forget: wyjątek wołacza nie ma prawa wywrócić streamu.
    let admits = 0;
    const model = {
        stream(_payload: Payload, handlers: StreamHandlers & { gate_admitted?: () => void }): void {
            handlers.gate_admitted?.();
            Promise.resolve().then(() => handlers.done({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
        },
    };

    const result = await runAgentLoop({
        model,
        store: store(),
        resolveTools: () => [],
        executeToolCall: async () => 'x',
        limits: { maxIterations: 2 },
        onGateAdmitted: () => { admits++; throw new Error('wołacz się wywalił'); },
    });

    t.is(admits, 1);
    t.is(result.stoppedBy, 'natural', 'rzucający sygnał nie wywrócił tury');
});

// ─── K5 (AUD-security-038): backstop pod bramką abortu ───────────────────────

/** Model odgrywający listę odpowiedzi; liczy wywołania (backstop = wywołanie ponad iteracje). */
function makeScriptedModel(responses: unknown[]) {
    let idx = 0;
    return {
        calls: 0,
        stream(_payload: Payload, handlers: StreamHandlers): void {
            this.calls++;
            const resp = responses[idx++];
            Promise.resolve().then(() => handlers.done(resp));
        },
        stopStream() { /* nic — ten model rozstrzyga sam */ },
    };
}

const toolCallResp = (name: string) => ({
    choices: [{ message: { role: 'assistant', content: '', tool_calls: [
        { id: `c${name}`, function: { name, arguments: '{}' } },
    ] } }],
});

test('Stop w trakcie narzędzi OSTATNIEJ iteracji nie przepuszcza backstopu (AUD-security-038)', async (t) => {
    // Sufit iteracji = 1, więc po narzędziach pętla wchodzi wprost w backstop. Stop klikamy
    // W TRAKCIE narzędzia (egzekutor podnosi flagę) — do K5 backstop był JEDYNYM punktem
    // trasy bez pytania `abort()`, więc leciało jeszcze jedno pełne wywołanie modelu, a tura
    // kończyła się jako `backstop` (czyli z finalizacją: wpis w oknie kontekstu i w dzienniku).
    let aborted = false;
    const model = makeScriptedModel([
        toolCallResp('read'),
        { choices: [{ message: { role: 'assistant', content: 'ODPOWIEDŹ PO STOPIE' } }] },
    ]);
    const events: TraceEvent[] = [];

    const result = await runAgentLoop({
        model,
        store: store(),
        resolveTools: () => [{ type: 'function', function: { name: 'read', description: '', parameters: {} } }],
        executeToolCall: async () => { aborted = true; return 'wynik narzędzia'; },
        limits: { maxIterations: 1 },
        shouldAbort: () => aborted,
        trace: (type, fields) => events.push({ type, fields }),
    });

    t.is(result.stoppedBy, 'abort', 'tura ma zejść jako przerwana, nie jako backstop');
    t.is(model.calls, 1, 'po Stopie NIE leci kolejne wywołanie modelu (backstop)');
    t.false(result.finalText.includes('ODPOWIEDŹ PO STOPIE'), 'odpowiedź backstopu nie wraca do wołacza');
    t.is(events.filter(e => e.type === 'backstop').length, 0, 'brak zdarzenia backstop w trace');
    t.is(events.filter(e => e.type === 'loop.end').length, 1, 'dokładnie jedno domknięcie pętli');
    t.is(events.filter(e => e.type === 'loop.end')[0].fields.stop, 'abort');
});

test('Stop w trakcie iteracji: narzędzia NASTĘPNEJ iteracji się nie wykonują', async (t) => {
    // Stop klikany w trakcie narzędzia iteracji 2 — narzędzie iteracji 3 nie ma prawa ruszyć.
    let aborted = false;
    let toolCalls = 0;
    const model = makeScriptedModel([toolCallResp('read'), toolCallResp('read'), toolCallResp('read')]);

    const result = await runAgentLoop({
        model,
        store: store(),
        resolveTools: () => [{ type: 'function', function: { name: 'read', description: '', parameters: {} } }],
        executeToolCall: async () => {
            toolCalls++;
            if (toolCalls === 2) aborted = true; // user klika Stop, gdy narzędzie jeszcze biegnie
            return 'wynik narzędzia';
        },
        limits: { maxIterations: 5 },
        shouldAbort: () => aborted,
    });

    t.is(result.stoppedBy, 'abort');
    t.is(toolCalls, 2, 'narzędzie trzeciej iteracji NIE zostało wywołane');
    t.is(model.calls, 2, 'po Stopie nie ma kolejnego wywołania modelu');
});

// ─── Klaster I: Stop ma pierwszeństwo przed każdym „domknij turę" ────────────

const READ_TOOL = [{ type: 'function', function: { name: 'read', description: '', parameters: {} } }];

test('Stop w trakcie FINALNEGO strzału backstopu kończy jako abort, nie jako backstop (AUD-security-113)', async (t) => {
    // K5 zamknął bramkę PRZED backstopem, ale nie po niej: Stop kliknięty, gdy finalny strzał
    // JUŻ LECI (potrafi trwać dziesiątki sekund — naturalny moment na Stop), lądował w `catch`
    // backstopu, który — inaczej niż `catch` pętli głównej — nie pytał o abort. Tura schodziła
    // jako `backstop`, czyli u wołacza gałęzią FINALIZACJI: wpis w oknie kontekstu i w pliku sesji.
    let aborted = false;
    let calls = 0;
    const model = {
        stream(_payload: Payload, handlers: StreamHandlers): void {
            calls++;
            if (calls === 1) {
                Promise.resolve().then(() => handlers.done(toolCallResp('read')));
                return;
            }
            // Finalny strzał backstopu jest w locie — user klika Stop (stopStream odrzuca
            // promisę znacznikiem `_aborted`, dokładnie jak ChatModel).
            aborted = true;
            Promise.resolve().then(() => handlers.error(abortError()));
        },
        stopStream() { /* rozstrzyga sam, wyżej */ },
    };
    const events: TraceEvent[] = [];

    const result = await runAgentLoop({
        model,
        store: store(),
        resolveTools: () => READ_TOOL,
        executeToolCall: async () => 'wynik narzędzia',
        limits: { maxIterations: 1, salvageMaxChars: 2000 },
        shouldAbort: () => aborted,
        trace: (type, fields) => events.push({ type, fields }),
    });

    t.is(result.stoppedBy, 'abort', 'przerwany backstop to abort, nie backstop');
    const end = events.filter(e => e.type === 'loop.end');
    t.is(end.length, 1, 'dokładnie jedno domknięcie pętli w trace');
    t.is(end[0].fields.stop, 'abort', 'trace mówi abort, nie backstop');
    t.is(end[0].fields.fallback, undefined, 'przerwanie to nie zaślepka backstopu');
});

test('Stop w trakcie FINALNEGO strzału backstopu, gdy strzał SIĘ POWIÓDŁ, kończy jako abort (AUD-testy-014/037, druga bramka AUD-security-113)', async (t) => {
    // Test wyżej ćwiczy backstop, którego finalny strzał ODRZUCA (trafia w `catch`, linia 705).
    // Ta bramka jest INNA: `AgentLoop.ts:658`, `if (abort())` zaraz PO tym, jak finalny strzał
    // WRÓCIŁ SUKCESEM (`handlers.done`). Żaden istniejący scenariusz nie odgrywał „Stop kliknięty,
    // a backstop mimo to zdążył dokończyć się poprawnie" — AUD-testy-014/037 pokazały, że wycięcie
    // tej bramki (`if (false)`) nie zapala ani jednego testu w repo (295, potem 2465 zielonych).
    let aborted = false;
    let calls = 0;
    const model = {
        stream(_payload: Payload, handlers: StreamHandlers): void {
            calls++;
            if (calls === 1) {
                Promise.resolve().then(() => handlers.done(toolCallResp('read')));
                return;
            }
            // Finalny strzał backstopu WRACA sukcesem — ale Stop już padł, zanim wrócił.
            aborted = true;
            Promise.resolve().then(() => handlers.done({ choices: [{ message: { role: 'assistant', content: 'ODPOWIEDŹ PO STOPIE' } }] }));
        },
        stopStream() { /* ta gałąź nie odrzuca — do stopStream nie dochodzi */ },
    };
    const events: TraceEvent[] = [];

    const result = await runAgentLoop({
        model,
        store: store(),
        resolveTools: () => READ_TOOL,
        executeToolCall: async () => 'wynik narzędzia',
        limits: { maxIterations: 1, salvageMaxChars: 2000 },
        shouldAbort: () => aborted,
        trace: (type, fields) => events.push({ type, fields }),
    });

    t.is(result.stoppedBy, 'abort', 'udany finalny strzał NIE ratuje tury przed Stopem, który padł w międzyczasie');
    t.false(result.finalText.includes('ODPOWIEDŹ PO STOPIE'), 'odpowiedź backstopu nie wraca do wołacza');
    const end = events.filter(e => e.type === 'loop.end');
    t.is(end.length, 1, 'dokładnie jedno domknięcie pętli w trace');
    t.is(end[0].fields.stop, 'abort', 'trace mówi abort, nie backstop');
    t.is(end[0].fields.fallback, undefined, 'przerwanie po udanym strzale to nie zaślepka backstopu');
});

test('Stop w trakcie narzędzi: beforeContinue NIE leci, ale dorobek zostaje (AUD-security-129)', async (t) => {
    // Do fixu pętla po `Promise.all` wołała bezwarunkowo onToolResults i beforeContinue —
    // a chatowy `beforeContinue` potrafi tam odpalić kompresję mid-loop: OSOBNE wywołanie
    // modelu i trwały zapis notatek do `brain/`. Po Stopie. Bramka blokuje KONTYNUACJĘ tury;
    // zapis dorobku (dziennik/UI w onToolResults + transkrypt) zostaje.
    let aborted = false;
    const calls: string[] = [];
    const s = new ArrayMessageStore([{ role: 'user', content: 'zrób coś' }]);
    const model = makeScriptedModel([toolCallResp('read'), toolCallResp('read')]);

    const result = await runAgentLoop({
        model,
        store: s,
        resolveTools: () => READ_TOOL,
        executeToolCall: async () => { aborted = true; return 'WYNIK NARZĘDZIA'; },
        limits: { maxIterations: 4 },
        shouldAbort: () => aborted,
        hooks: {
            onToolResults: () => { calls.push('onToolResults'); },
            beforeContinue: () => { calls.push('beforeContinue'); },
        },
    });

    t.is(result.stoppedBy, 'abort');
    t.false(calls.includes('beforeContinue'), 'po Stopie pętla NIE kontynuuje tury (kompresja mid-loop, nudges, kolejka)');
    t.true(calls.includes('onToolResults'), 'zapis dorobku (dziennik + UI) leci normalnie');
    t.true(
        s.messages.some(m => m.role === 'tool' && String(m.content).includes('WYNIK NARZĘDZIA')),
        'wykonane narzędzie zostaje w transkrypcie (kontrakt Front A)',
    );
});

test('wyjątek z hooka domyka trace loop.end stop=error, a dorobek zostaje w transkrypcie (AUD-bledy-002)', async (t) => {
    // Korpus iteracji (hooki, resolveTools, store) leżał poza jakimkolwiek try: rzut z chatowego
    // `onToolResults` (pierwszy await to zapis dziennika sesji na dysku) kończył pętlę bez
    // `loop.end` i bez groupEnd, a wykonane narzędzie znikało z transkryptu — model przy
    // następnej turze nie widział zapisu, który już się wydarzył w vaultcie.
    const s = new ArrayMessageStore([{ role: 'user', content: 'zapisz plik' }]);
    const events: TraceEvent[] = [];
    const model = makeScriptedModel([toolCallResp('read')]);

    await t.throwsAsync(
        () => runAgentLoop({
            model,
            store: s,
            resolveTools: () => READ_TOOL,
            executeToolCall: async () => 'ZAPISANE',
            limits: { maxIterations: 3 },
            hooks: { onToolResults: () => { throw new Error('dziennik sesji padl (EBUSY)'); } },
            trace: (type, fields) => events.push({ type, fields }),
        }),
        { message: 'dziennik sesji padl (EBUSY)' },
        'awaria hooka dalej leci w górę jako wyjątek (kontrola negatywna)',
    );

    const end = events.filter(e => e.type === 'loop.end');
    t.is(end.length, 1, 'pętla, która padła na hooku, MUSI zostawić loop.end');
    t.is(end[0].fields.stop, 'error');
    t.true(
        s.messages.some(m => m.role === 'tool' && String(m.content).includes('ZAPISANE')),
        'skutek uboczny narzędzia zostawia ślad w transkrypcie',
    );
});

test('wyjątek z resolveTools też domyka loop.end stop=error (AUD-bledy-002)', async (t) => {
    const events: TraceEvent[] = [];
    await t.throwsAsync(
        () => runAgentLoop({
            model: makeScriptedModel([]),
            store: store(),
            resolveTools: () => { throw new Error('rejestr narzedzi padl'); },
            executeToolCall: async () => 'x',
            limits: { maxIterations: 2 },
            trace: (type, fields) => events.push({ type, fields }),
        }),
        { message: 'rejestr narzedzi padl' },
    );
    const end = events.filter(e => e.type === 'loop.end');
    t.is(end.length, 1);
    t.is(end[0].fields.stop, 'error');
});

test('hardstop backstopu NIE zostaje w transkrypcie jako wiadomość usera (AUD-bledy-003)', async (t) => {
    // Instrukcja „NIE wywołuj żadnych narzędzi" jechała do store rolą `user`: okno rozmowy
    // rysowało ją jako dymek Kuby, a `getMessagesForAPI()` wiozło ją w KAŻDYM kolejnym żądaniu
    // tej sesji. Do modelu ma polecieć raz — w payloadzie finalnego strzału, nie w transkrypcie.
    const s = new ArrayMessageStore([{ role: 'user', content: 'zrób coś' }]);
    const payloads: Payload[] = [];
    let calls = 0;
    const model = {
        stream(payload: Payload, handlers: StreamHandlers): void {
            calls++;
            payloads.push(payload);
            const resp = calls === 1
                ? toolCallResp('read')
                : { choices: [{ message: { role: 'assistant', content: 'podsumowanie' } }] };
            Promise.resolve().then(() => handlers.done(resp));
        },
        stopStream() { /* nic */ },
    };

    const result = await runAgentLoop({
        model,
        store: s,
        resolveTools: () => READ_TOOL,
        executeToolCall: async () => 'wynik',
        limits: { maxIterations: 1 },
    });

    t.is(result.stoppedBy, 'backstop');
    const userTexts = s.messages.filter(m => m.role === 'user').map(m => String(m.content));
    t.false(
        userTexts.some(text => /NIE wywołuj|Do NOT call any tools/.test(text)),
        'hardstop w transkrypcie = dymek, którego user nie napisał, w każdym kolejnym żądaniu sesji',
    );
    // …ale model MUSI go dostać w finalnym strzale (payload bez `tools`).
    const finalPayload = payloads[payloads.length - 1];
    t.is(finalPayload.tools, undefined, 'finalny strzał backstopu leci bez narzędzi');
    const sent = JSON.stringify(finalPayload.messages);
    t.regex(sent, /NIE wywołuj|Do NOT call any tools/, 'hardstop leci do modelu w payloadzie');
});
