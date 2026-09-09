import test from 'ava';
import { SubTaskRegistry } from './SubTaskRegistry.js';
import type { SubTask, SubTaskStep } from './SubTaskRegistry.js';

/** Atrapa `TraceLog`: zapamiętuje etykiety podane do `scope()` i każdy zapis. */
function makeFakeTraceLog() {
    const scopeLabels: string[] = [];
    const writes: Array<{ label: string; type: string; fields: Record<string, unknown> }> = [];
    return {
        scopeLabels,
        writes,
        traceLog: {
            scope(label: string) {
                scopeLabels.push(label);
                return (type: string, fields: Record<string, unknown> = {}) => {
                    writes.push({ label, type, fields });
                };
            },
        },
    };
}

/** Maska testowa — jawnie widoczna w asercjach (produkcja podaje `maskSensitiveData`). */
const fakeMask = (value: string) => value.replace(/sk-[A-Za-z0-9]+/g, 'sk-***');

function newTask(reg: SubTaskRegistry, id = 'sub/pkm-sub#1'): SubTask {
    return reg.create({ id, name: 'pkm-sub', agentName: 'Tester', budget: { maxIterations: 8 } });
}

// --- create ---

test('create zakłada byt w stanie running i ogłasza task:created', t => {
    const reg = new SubTaskRegistry();
    const seen: SubTask[] = [];
    reg.events.on('task:created', (payload: unknown) => seen.push(payload as SubTask));

    const task = reg.create({ id: 'sub/klara-prep#a', name: 'klara-prep', agentName: 'Klara', budget: { maxIterations: 12 } });

    t.is(task.status, 'running');
    t.is(task.id, 'sub/klara-prep#a');
    t.is(task.name, 'klara-prep');
    t.is(task.agentName, 'Klara');
    t.is(task.budget.maxIterations, 12);
    t.true(task.createdAt > 0);
    t.deepEqual(task.steps, []);
    t.is(seen.length, 1);
    t.is(seen[0], task, 'payload zdarzenia to TEN sam obiekt taska');
    t.is(reg.getTask('sub/klara-prep#a'), task);
    t.deepEqual(reg.list(), [task]);
});

// --- step: maskowanie + zdarzenie ---

test('step maskuje stringowe pola i ogłasza task:step', t => {
    const reg = new SubTaskRegistry({ mask: fakeMask });
    const task = newTask(reg);
    const steps: SubTaskStep[] = [];
    reg.events.on('task:step', (payload: unknown) => steps.push((payload as { step: SubTaskStep }).step));

    reg.step(task, 'tool.pre', { i: 1, tool: 'read', args: 'klucz sk-ABC123 w argumencie' });

    t.is(task.steps.length, 1);
    t.is(task.steps[0].type, 'tool.pre');
    t.is(task.steps[0].fields.args, 'klucz sk-*** w argumencie', 'string przechodzi przez maskę');
    t.is(task.steps[0].fields.i, 1, 'nie-stringi zostają nietknięte');
    t.true(task.steps[0].at > 0);
    t.is(steps.length, 1);
    t.is(steps[0], task.steps[0]);
});

test('traceFor daje funkcję o kształcie scope() — pętla nie wie, że pisze do rejestru', t => {
    const reg = new SubTaskRegistry();
    const task = newTask(reg);

    const trace = reg.traceFor(task);
    trace('loop.start', { max_iter: 8 });
    trace('loop.end', { stop: 'natural' });

    t.deepEqual(task.steps.map(s => s.type), ['loop.start', 'loop.end']);
});

test('cap kroków tnie RAM, ale zdarzenia (a więc i plik trace) lecą dalej', t => {
    const reg = new SubTaskRegistry({ maxStepsPerTask: 2 });
    const task = newTask(reg);
    let emitted = 0;
    reg.events.on('task:step', () => { emitted++; });

    for (let i = 0; i < 5; i++) reg.step(task, 'tool.post', { i });

    t.is(task.steps.length, 2, 'tablica w RAM ma sufit');
    t.is(emitted, 5, 'każdy krok nadal ogłoszony — plik ma pełny ślad');
});

// --- domyślny konsument: trace.log ---

test('rejestr z traceLog pisze kroki przez scope(task.id) — scope raz na bieg', t => {
    const { traceLog, scopeLabels, writes } = makeFakeTraceLog();
    const reg = new SubTaskRegistry({ traceLog });
    const task = newTask(reg, 'sub/pkm-sub#7');

    reg.step(task, 'loop.start', { max_iter: 8 });
    reg.step(task, 'tool.pre', { i: 1, tool: 'read' });
    reg.step(task, 'loop.end', { stop: 'natural', iters: 1 });

    t.deepEqual(scopeLabels, ['sub/pkm-sub#7'], 'etykieta = id taska, funkcja scope cache’owana');
    t.deepEqual(writes.map(w => w.type), ['loop.start', 'tool.pre', 'loop.end'], 'kolejność zachowana');
    t.deepEqual(writes[1].fields, { i: 1, tool: 'read' }, 'pola idą do trace takie, jakie zapisał rejestr');
    t.true(writes.every(w => w.label === 'sub/pkm-sub#7'));
});

test('równoległe biegi piszą pod własnymi etykietami (osobne scope)', t => {
    const { traceLog, scopeLabels, writes } = makeFakeTraceLog();
    const reg = new SubTaskRegistry({ traceLog });
    const a = reg.create({ id: 'sub/pkm-sub#1', name: 'pkm-sub', agentName: 'Tester' });
    const b = reg.create({ id: 'sub/pkm-sub#2', name: 'pkm-sub', agentName: 'Tester' });

    reg.step(a, 'loop.start', {});
    reg.step(b, 'loop.start', {});

    t.deepEqual(scopeLabels, ['sub/pkm-sub#1', 'sub/pkm-sub#2']);
    t.deepEqual(writes.map(w => w.label), ['sub/pkm-sub#1', 'sub/pkm-sub#2']);
});

test('po task:finished cache scope jest zwalniany (nowy scope przy spóźnionym kroku)', t => {
    const { traceLog, scopeLabels } = makeFakeTraceLog();
    const reg = new SubTaskRegistry({ traceLog });
    const task = newTask(reg, 'sub/pkm-sub#9');

    reg.step(task, 'loop.start', {});
    reg.finish(task, { text: 'ok', toolsUsed: [], durationMs: 1, usage: null, stoppedBy: 'natural' });
    reg.step(task, 'spozniony', {});

    t.deepEqual(scopeLabels, ['sub/pkm-sub#9', 'sub/pkm-sub#9'], 'druga funkcja scope = cache wyczyszczony');
});

// --- finish / fail ---

test('finish mapuje stoppedBy na status (natural/backstop → done, abort → aborted)', t => {
    const reg = new SubTaskRegistry();
    const finished: SubTask[] = [];
    reg.events.on('task:finished', (payload: unknown) => finished.push(payload as SubTask));

    const natural = reg.create({ id: '#1', name: 's', agentName: 'A' });
    const backstop = reg.create({ id: '#2', name: 's', agentName: 'A' });
    const aborted = reg.create({ id: '#3', name: 's', agentName: 'A' });

    reg.finish(natural, { text: 'a', toolsUsed: ['read'], durationMs: 5, usage: null, stoppedBy: 'natural' });
    reg.finish(backstop, { text: 'b', toolsUsed: [], durationMs: 6, usage: null, stoppedBy: 'backstop' });
    reg.finish(aborted, { text: '', toolsUsed: [], durationMs: 7, usage: null, stoppedBy: 'abort' });

    t.is(natural.status, 'done');
    t.is(backstop.status, 'done');
    t.is(aborted.status, 'aborted');
    t.is(natural.result?.text, 'a');
    t.deepEqual(natural.result?.toolsUsed, ['read']);
    t.true((natural.endedAt as number) > 0);
    t.is(finished.length, 3, 'każde domknięcie ogłoszone');
    t.is(finished[0].status, 'done', 'status jest terminalny JUŻ w payloadzie zdarzenia');
});

test('finish bez stoppedBy domyka jako done', t => {
    const reg = new SubTaskRegistry();
    const task = newTask(reg);

    reg.finish(task, { text: 'x', toolsUsed: [], durationMs: 1, usage: null });

    t.is(task.status, 'done');
});

test('fail ustawia status error, endedAt i maskuje treść błędu', t => {
    const reg = new SubTaskRegistry({ mask: fakeMask });
    const task = newTask(reg);
    const finished: SubTask[] = [];
    reg.events.on('task:finished', (payload: unknown) => finished.push(payload as SubTask));

    reg.fail(task, 'Incorrect API key provided: sk-DEADBEEF');

    t.is(task.status, 'error');
    t.is(task.error, 'Incorrect API key provided: sk-***');
    t.true((task.endedAt as number) > 0);
    t.is(finished.length, 1);
    t.is(finished[0].status, 'error');
});

// --- retencja ---

test('retencja kasuje najstarsze ZAKOŃCZONE biegi, running zostaje na zawsze', t => {
    const reg = new SubTaskRegistry({ maxDone: 2 });
    const running = reg.create({ id: 'running', name: 's', agentName: 'A' });
    const first = reg.create({ id: 'd1', name: 's', agentName: 'A' });
    const second = reg.create({ id: 'd2', name: 's', agentName: 'A' });
    const third = reg.create({ id: 'd3', name: 's', agentName: 'A' });

    reg.finish(first, { text: '', toolsUsed: [], durationMs: 1, usage: null, stoppedBy: 'natural' });
    reg.finish(second, { text: '', toolsUsed: [], durationMs: 1, usage: null, stoppedBy: 'natural' });
    reg.finish(third, { text: '', toolsUsed: [], durationMs: 1, usage: null, stoppedBy: 'natural' });

    t.is(reg.getTask('d1'), undefined, 'najstarszy zakończony wyparował');
    t.truthy(reg.getTask('d2'));
    t.truthy(reg.getTask('d3'));
    t.is(reg.getTask('running'), running, 'bieg w toku NIGDY nie jest usuwany');
    t.deepEqual(reg.list().map(x => x.id), ['running', 'd2', 'd3'], 'kolejność powstania zachowana');
});

// --- odporność ---

test('step nie rzuca na braku taska ani po dispose', t => {
    const reg = new SubTaskRegistry({ traceLog: makeFakeTraceLog().traceLog });
    const task = newTask(reg);

    reg.dispose();

    t.notThrows(() => reg.step(task, 'po-dispose', { a: 1 }));
    t.notThrows(() => reg.step(null as unknown as SubTask, 'brak-taska', {}));
    t.notThrows(() => reg.finish(null as unknown as SubTask, { text: '', toolsUsed: [], durationMs: 0, usage: null }));
    t.notThrows(() => reg.fail(null as unknown as SubTask, 'boom'));
});

test('step przeżywa wysypanego konsumenta (szyna łapie wyjątki handlerów)', t => {
    const reg = new SubTaskRegistry();
    const task = newTask(reg);
    reg.events.on('task:step', () => { throw new Error('panel padł'); });

    t.notThrows(() => reg.step(task, 'tool.post', { i: 1 }));
    t.is(task.steps.length, 1, 'krok i tak zapisany');
});

test('dispose odpina konsumentów i czyści rejestr', t => {
    const { traceLog, writes } = makeFakeTraceLog();
    const reg = new SubTaskRegistry({ traceLog });
    const task = newTask(reg, 'sub/pkm-sub#5');
    let panelCalls = 0;
    reg.events.on('task:step', () => { panelCalls++; });

    reg.step(task, 'loop.start', {});
    reg.dispose();
    reg.step(task, 'po-dispose', {});

    t.is(panelCalls, 1, 'konsument odpięty');
    t.is(writes.length, 1, 'trace też przestał dostawać');
    t.is(reg.events.listenerCount('task:step'), 0);
    t.deepEqual(reg.list(), [], 'mapa wyczyszczona');
});

// --- metadane pochodzenia + tła (rejestr ich NIE interpretuje) ---

test('create przechowuje background i origin 1:1', t => {
    const reg = new SubTaskRegistry();
    const origin = { agentName: 'Klara', sessionPath: 'Czaty/klara-2026.md', tabKey: 'tab-3' };

    const task = reg.create({ id: 'sub/klara-prep#z', name: 'klara-prep', agentName: 'Klara', background: true, origin });

    t.true(task.background);
    t.deepEqual(task.origin, origin);
    t.is(reg.getTask('sub/klara-prep#z')?.origin?.tabKey, 'tab-3');
});

test('create bez nowych pól daje byt w kształcie bez nich (brak kluczy, nie undefined)', t => {
    const reg = new SubTaskRegistry();

    const task = newTask(reg, 'sub/pkm-sub#bez');

    t.false('background' in task);
    t.false('origin' in task);
});

test('background:false jest przechowywane jawnie (blokująca delegacja to nie „brak informacji")', t => {
    const reg = new SubTaskRegistry();

    const task = reg.create({ id: 'sub/pkm-sub#sync', background: false });

    t.is(task.background, false);
});

test('origin jest kopiowany — późniejsza mutacja źródła nie rusza bytu', t => {
    const reg = new SubTaskRegistry();
    const origin = { agentName: 'Klara', tabKey: 'tab-1' };

    const task = reg.create({ id: 'sub/klara-prep#kopia', origin });
    origin.tabKey = 'tab-999';

    t.is(task.origin?.tabKey, 'tab-1');
});

// --- side-channel abortów (attachAbort / requestStop) ---

test('requestStop woła podpięty uchwyt, znaczy byt i zostawia ślad', t => {
    const { traceLog, writes } = makeFakeTraceLog();
    const reg = new SubTaskRegistry({ traceLog });
    const task = newTask(reg);
    let wolania = 0;
    reg.attachAbort(task.id, () => { wolania++; });

    const wynik = reg.requestStop(task.id);

    t.true(wynik);
    t.is(wolania, 1, 'uchwyt zawołany dokładnie raz');
    t.true(task.stopRequested, 'byt niesie znacznik prośby');
    t.is(task.status, 'running', 'status zmienia dopiero domknięcie biegu, nie prośba');
    const slad = task.steps.filter(s => s.type === 'stop.requested');
    t.is(slad.length, 1);
    t.is(slad[0].fields.by, 'panel');
    t.true(writes.some(w => w.type === 'stop.requested'), 'ślad poszedł też do trace');
});

test('requestStop bez podpiętego uchwytu zwraca false i nic nie znaczy', t => {
    const reg = new SubTaskRegistry();
    const task = newTask(reg);

    t.false(reg.requestStop(task.id));
    t.falsy(task.stopRequested);
    t.deepEqual(task.steps, [], 'brak śladu — nie było czego prosić');
});

test('requestStop na nieznanym id zwraca false', t => {
    const reg = new SubTaskRegistry();
    reg.attachAbort('sub/pkm-sub#duch', () => { t.fail('uchwyt sieroty nie ma prawa się odpalić'); });

    t.false(reg.requestStop('sub/pkm-sub#duch'));
});

test('bieg NIE running nie da się zatrzymać (status running jest wymagany)', t => {
    const reg = new SubTaskRegistry();
    const task = newTask(reg);
    let wolania = 0;
    reg.attachAbort(task.id, () => { wolania++; });
    reg.finish(task, { text: 'gotowe', toolsUsed: [], durationMs: 1, usage: null });

    t.false(reg.requestStop(task.id));
    t.is(wolania, 0);
});

test('uchwyt jest kasowany po task:finished (żadnych wycieków domknięć)', t => {
    const reg = new SubTaskRegistry();
    const task = newTask(reg);
    let wolania = 0;
    reg.attachAbort(task.id, () => { wolania++; });

    reg.fail(task, 'boom');
    // Byt wraca do stanu running tylko sztucznie — chodzi o sprawdzenie, że uchwytu JUŻ NIE MA.
    task.status = 'running';

    t.false(reg.requestStop(task.id), 'wpis zniknął razem z końcem biegu');
    t.is(wolania, 0);
});

test('rzucający uchwyt nie wywala requestStop (prośba i tak jest zapisana)', t => {
    const reg = new SubTaskRegistry();
    const task = newTask(reg);
    reg.attachAbort(task.id, () => { throw new Error('stop padł'); });

    t.true(reg.requestStop(task.id));
    t.true(task.stopRequested);
});

test('attachAbort ignoruje śmieci zamiast rzucać', t => {
    const reg = new SubTaskRegistry();
    const task = newTask(reg);

    t.notThrows(() => reg.attachAbort(task.id, null as unknown as () => void));
    t.notThrows(() => reg.attachAbort('', () => {}));
    t.false(reg.requestStop(task.id), 'nic sensownego nie zostało podpięte');
});

test('dispose puszcza uchwyty abortu', t => {
    const reg = new SubTaskRegistry();
    const task = newTask(reg);
    reg.attachAbort(task.id, () => { t.fail('po dispose nie ma czego wołać'); });

    reg.dispose();

    t.false(reg.requestStop(task.id));
});

// ─── demontaż najpierw ZATRZYMUJE, potem odpina ───────

test('Z7: stopAll woła uchwyt KAŻDEGO żywego biegu, a rzucający uchwyt nie blokuje reszty', t => {
    const { traceLog, writes } = makeFakeTraceLog();
    const reg = new SubTaskRegistry({ traceLog });
    const a = newTask(reg, 'sub/pkm-sub#a');
    const b = newTask(reg, 'sub/pkm-sub#b');
    const wolane: string[] = [];
    reg.attachAbort(a.id, () => { wolane.push(a.id); throw new Error('uchwyt padł'); });
    reg.attachAbort(b.id, () => { wolane.push(b.id); });

    const dostarczone = reg.stopAll('unload');

    t.deepEqual(wolane, [a.id, b.id], 'oba uchwyty zawołane — pierwszy rzucił, drugi i tak poszedł');
    t.is(dostarczone, 1, 'liczymy uchwyty, które NIE rzuciły (b)');
    t.true(a.stopRequested);
    t.true(b.stopRequested);
    t.true(writes.some(w => w.type === 'stop.requested' && w.fields.by === 'unload'), 'ślad z powodem poszedł do trace');
    t.notThrows(() => reg.dispose(), 'dispose po stopAll zostaje best-effort');
});

test('Z7: stopAll pomija biegi ZAKOŃCZONE i jest idempotentne (drugi przebieg nie dubluje śladu)', t => {
    const reg = new SubTaskRegistry();
    const zywy = newTask(reg, 'sub/pkm-sub#zywy');
    const martwy = newTask(reg, 'sub/pkm-sub#martwy');
    let wolaniaMartwego = 0;
    reg.attachAbort(martwy.id, () => { wolaniaMartwego++; });
    reg.finish(martwy, { text: 'gotowe', toolsUsed: [], durationMs: 1, usage: null });
    let wolaniaZywego = 0;
    reg.attachAbort(zywy.id, () => { wolaniaZywego++; });

    t.is(reg.stopAll('unload'), 1);
    t.is(reg.stopAll('unload'), 1, 'drugie wołanie nie wywraca się i nadal dosięga żywego biegu');

    t.is(wolaniaMartwego, 0, 'zakończony bieg nie ma czego zatrzymywać (uchwyt już skasowany)');
    t.is(wolaniaZywego, 2);
    t.is(zywy.steps.filter(s => s.type === 'stop.requested').length, 1, 'ślad prośby leci RAZ');
});

test('Z7: sam dispose() NIE woła uchwytów — gwarancja stopu leży w kolejności onunload', t => {
    const reg = new SubTaskRegistry();
    const task = newTask(reg);
    let wolania = 0;
    reg.attachAbort(task.id, () => { wolania++; });

    reg.dispose();
    t.is(wolania, 0, 'dzisiejsze (złe samo w sobie) zachowanie dispose zostaje udokumentowane');

    // Kolejność z `onunload`: NAJPIERW zatrzymanie biegów, POTEM odpięcie kanałów.
    const reg2 = new SubTaskRegistry();
    const task2 = newTask(reg2);
    let wolania2 = 0;
    reg2.attachAbort(task2.id, () => { wolania2++; });

    reg2.stopAll('unload');
    reg2.dispose();

    t.is(wolania2, 1, 'stopAll przed dispose = bieg dostaje sygnał, zanim zniknie mapa uchwytów');
});

test('Z7: stopAll na pustym rejestrze zwraca 0 i nie rzuca', t => {
    const reg = new SubTaskRegistry();

    t.is(reg.stopAll('unload'), 0);
    reg.dispose();
    t.is(reg.stopAll('unload'), 0, 'po dispose też nie ma czego wołać');
});

// ─── wiadomość do biegu w trakcie (side-channel sterowania) ───────────────

test('postMessage wrzuca wiadomość do biegu running, takeMessages ją ZDEJMUJE', t => {
    const reg = new SubTaskRegistry();
    const task = newTask(reg);

    t.true(reg.postMessage(task.id, 'skup się na folderze Projekty'));
    t.true(reg.postMessage(task.id, 'i pomiń archiwum'));

    t.deepEqual(reg.takeMessages(task.id), [
        'skup się na folderze Projekty',
        'i pomiń archiwum',
    ]);
    t.deepEqual(reg.takeMessages(task.id), [], 'kolejka opróżniona — drugi odbiór nic nie daje');
});

test('postMessage zapisuje krok user.message z samą DŁUGOŚCIĄ (treść jest w transkrypcie)', t => {
    const reg = new SubTaskRegistry();
    const kroki: SubTaskStep[] = [];
    reg.events.on('task:step', (p: unknown) => kroki.push((p as { step: SubTaskStep }).step));
    const task = newTask(reg);

    reg.postMessage(task.id, 'zmień kierunek');

    t.is(kroki.length, 1);
    t.is(kroki[0].type, 'user.message');
    t.deepEqual(kroki[0].fields, { chars: 'zmień kierunek'.length });
});

test('wiadomość do biegu ZAKOŃCZONEGO albo nieznanego = false', t => {
    const reg = new SubTaskRegistry();
    const task = newTask(reg);
    reg.finish(task, { text: 'ok', toolsUsed: [], durationMs: 1, usage: null, stoppedBy: 'natural' });

    t.false(reg.postMessage(task.id, 'za późno'), 'bieg już zszedł');
    t.false(reg.postMessage('sub/nie-ma#9', 'donikąd'), 'nieznany bieg');
    t.deepEqual(reg.takeMessages(task.id), []);
});

test('pusta/biała wiadomość odrzucona, kolejka ma sufit i odmawia zamiast gubić', t => {
    const reg = new SubTaskRegistry({ maxMessagesPerTask: 3 });
    const task = newTask(reg);

    t.false(reg.postMessage(task.id, '   '), 'sam whitespace to nie polecenie');

    t.true(reg.postMessage(task.id, 'a'));
    t.true(reg.postMessage(task.id, 'b'));
    t.true(reg.postMessage(task.id, 'c'));
    t.false(reg.postMessage(task.id, 'd'), 'ponad sufit — odmowa, NIE wypchnięcie najstarszej');

    t.deepEqual(reg.takeMessages(task.id), ['a', 'b', 'c']);
    t.true(reg.postMessage(task.id, 'd'), 'po opróżnieniu kolejki znowu jest miejsce');
});

test('treść wiadomości przechodzi przez maskę (user potrafi wkleić klucz)', t => {
    const reg = new SubTaskRegistry({ mask: (v: string) => v.replace(/sk-\w+/g, 'sk-***') });
    const task = newTask(reg);

    reg.postMessage(task.id, 'użyj klucza sk-tajne123');

    t.deepEqual(reg.takeMessages(task.id), ['użyj klucza sk-***']);
});

test('koniec biegu i dispose puszczają niedoręczone wiadomości', t => {
    const reg = new SubTaskRegistry();
    const a = newTask(reg, 'sub/pkm-sub#1');
    reg.postMessage(a.id, 'wisi');
    reg.finish(a, { text: '', toolsUsed: [], durationMs: 1, usage: null, stoppedBy: 'natural' });
    t.deepEqual(reg.takeMessages(a.id), [], 'kolejka zniknęła razem z biegiem');

    const b = newTask(reg, 'sub/pkm-sub#2');
    reg.postMessage(b.id, 'też wisi');
    reg.dispose();
    t.deepEqual(reg.takeMessages(b.id), []);
});

test('pruneSession: wymiata zakończone biegi sesji, zostawia running i inne sesje', t => {
    const reg = new SubTaskRegistry();
    const a = reg.create({ id: 'sub/a#1', name: 'a', agentName: 'Klara', origin: { agentName: 'Klara', sessionPath: 's1.md' } });
    reg.create({ id: 'sub/b#1', name: 'b', agentName: 'Klara', origin: { agentName: 'Klara', sessionPath: 's1.md' } });
    const c = reg.create({ id: 'sub/c#1', name: 'c', agentName: 'Klara', origin: { agentName: 'Klara', sessionPath: 's2.md' } });
    reg.finish(a, { text: 'ok', toolsUsed: [], durationMs: 1, usage: null, stoppedBy: 'natural' });
    reg.finish(c, { text: 'ok', toolsUsed: [], durationMs: 1, usage: null, stoppedBy: 'natural' });

    t.is(reg.pruneSession('s1.md'), 1);
    t.is(reg.getTask('sub/a#1'), undefined);       // zakończony z s1 — wymieciony
    t.truthy(reg.getTask('sub/b#1'));              // running z s1 — zostaje (sierota)
    t.truthy(reg.getTask('sub/c#1'));              // inna sesja — nietknięta
    t.is(reg.pruneSession(''), 0);                 // pusta ścieżka = no-op
});
