/**
 * Testy modelu paska biegów subów.
 *
 * Model jest jedyną częścią paska, którą da się sprawdzić bez Obsidiana — i jedyną,
 * w której da się coś policzyć źle po cichu (bieg z cudzej zakładki, duplikat wiersza,
 * licznik z sufitu, urwany wynik).
 */
import test from 'ava';
import { buildStripModel, formatDuration, summarizeStripRows } from './subTaskPanelModel.js';
import type { StripState } from './subTaskPanelModel.js';
import { SubTaskRegistry } from './SubTaskRegistry.js';
import { SubTaskNotifier } from './SubTaskNotifier.js';
import { runAgentLoop, ArrayMessageStore } from '../agent-loop/index.js';
import { TraceLog, maskSensitiveData } from '../../core/index.js';
import type { SubTask } from './SubTaskRegistry.js';
import { t as tr } from '../../core/i18n/index.js';
import { buildSubTaskResultModel, getStripStateLabelParts } from './index.js';

test('wynik zachowuje rozstrzygnięcie i treść pytania bez odpowiedzi', t => {
    const model = buildSubTaskResultModel({ question: { text: 'Jaki zakres?', resolution: { kind: 'no-answer' } }, thread: { kind: 'single' } });
    t.deepEqual([model.questionResolution, model.openQuestion, model.endLabelKey], ['no-answer', 'Jaki zakres?', 'chat.substrip.question_no_answer_partial']);
    const cancelled = buildSubTaskResultModel({ question: { text: 'Jaki zakres?', resolution: { kind: 'cancelled', by: 'user', reason: 'stop' } }, thread: { kind: 'single' } });
    t.is(cancelled.questionResolution, 'cancelled');
    t.is(cancelled.openQuestion, undefined);
});

const TERAZ = 1_000_000;

test('naturalne zakończenie bez materiału ma tytuł pusty wynik', t => {
    const model = buildSubTaskResultModel({
        outcome: { end: { kind: 'finished' }, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] },
        thread: { kind: 'single' },
    });
    t.is(tr(model.endLabelKey, undefined, 'pl'), 'pusty wynik');
});

test('karta pustego biegu zachowuje przyczynę i kompletność', t => {
    const entry = task({ id: 'stopped', agentName: 'Klara', outcome: { end: { kind: 'stopped', by: 'user' }, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] } });
    const run = buildStripModel({ agentName: 'Klara', tasks: [entry] })[0].runs[0];
    t.is(run.endLabelKey, 'chat.substrip.state_partial_user');
    t.is(run.completenessLabelKey, 'chat.subagent_notification.completeness_empty');
    t.is(run.outcome, '');
});

test('puste biegi zachowują wszystkie przyczyny oraz stop kolejki', t => {
    const ends = [
        [{ kind: 'stopped', by: 'user' }, 'zatrzymany przez Ciebie'],
        [{ kind: 'stopped', by: 'lead' }, 'zatrzymany przez agenta'],
        [{ kind: 'stopped', by: 'system' }, 'zatrzymany przez system'],
        [{ kind: 'limit', reason: 'iteration-limit' }, 'skończył mu się budżet kroków'],
        [{ kind: 'timeout' }, 'przekroczył czas'],
    ] as const;
    for (const [end, label] of ends) {
        const entry = task({ id: label, agentName: 'Klara', outcome: { end, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] } });
        const run = buildStripModel({ agentName: 'Klara', tasks: [entry] })[0].runs[0];
        t.is(tr(run.endLabelKey!, undefined, 'pl'), label);
        t.is(tr(run.completenessLabelKey!, undefined, 'pl'), 'brak wyniku');
        t.deepEqual(run.state, { kind: 'empty' });
        t.is(run.outcome, '');
    }
    const registry = new SubTaskRegistry();
    registry.createThread({ threadId: 'sub/worker#queued', name: 'worker', owner: { agentName: 'Klara' }, origin: { agentName: 'Klara' }, config: {}, phase: 'queued' });
    registry.closeThread('sub/worker#queued', 'lead');
    registry.finishQueuedStop('sub/worker#queued', { taskPreview: 'zadanie' });
    const run = buildStripModel({ agentName: 'Klara', tasks: registry.list(), threads: [registry.getThread('sub/worker#queued')!] })[0].runs[0];
    t.is(tr(run.endLabelKey!, undefined, 'pl'), 'zatrzymany przez agenta');
    t.is(tr(run.completenessLabelKey!, undefined, 'pl'), 'brak wyniku');
    t.is(run.outcome, '');
});

/** Karta biegu w kształcie, jaki naprawdę wychodzi z rejestru (bez uruchamiania runnera). */
function task(over: Partial<SubTask> & { id: string }): SubTask {
    return {
        name: 'pkm-sub',
        agentName: 'Tester',
        status: 'done',
        createdAt: TERAZ - 10_000,
        steps: [],
        budget: {},
        ...over,
    } as SubTask;
}

/** Bieg z adresem zwrotnym — tak, jak zakłada go czat przez `origin`. */
function zTabu(id: string, tabKey: string, over: Partial<SubTask> = {}): SubTask {
    return task({ id, origin: { agentName: 'Klara', tabKey }, ...over });
}

test('pasek: bierze TYLKO biegi tej zakładki', t => {
    const rows = buildStripModel({
        now: TERAZ,
        tabKey: 'tab-a',
        agentName: 'Klara',
        tasks: [
            zTabu('moj', 'tab-a', { endedAt: TERAZ - 1_000 }),
            zTabu('cudzy', 'tab-b', { endedAt: TERAZ - 2_000 }),
        ],
    });

    t.deepEqual(rows.map(r => r.id), ['moj']);
});

test('pasek: bieg BEZ adresu zakładki wpada po nazwie agenta', t => {
    const rows = buildStripModel({
        now: TERAZ,
        tabKey: 'tab-a',
        agentName: 'Klara',
        tasks: [
            task({ id: 'bez-originu', agentName: 'Klara', endedAt: TERAZ - 1_000 }),
            task({ id: 'obcy-agent', agentName: 'Tola', endedAt: TERAZ - 2_000 }),
            task({ id: 'origin-bez-tabu', agentName: 'Tola', origin: { agentName: 'Klara' }, endedAt: TERAZ - 3_000 }),
        ],
    });

    t.deepEqual(rows.map(r => r.id), ['bez-originu', 'origin-bez-tabu'], 'origin.agentName wygrywa z właścicielem biegu');
});

test('pasek: bez klucza zakładki i bez agenta nic nie zgadujemy', t => {
    const rows = buildStripModel({ now: TERAZ, tasks: [task({ id: 'x', endedAt: TERAZ })] });
    t.is(rows.length, 0);
});

test('pasek: kolejność = w biegu (od najstarszego) → czeka na czat → zakończone (od najświeższego)', t => {
    const czeka = zTabu('czeka', 'tab-a', { background: true, endedAt: TERAZ - 500 });
    const rows = buildStripModel({
        now: TERAZ,
        tabKey: 'tab-a',
        agentName: 'Klara',
        tasks: [
            zTabu('konczony-swiezy', 'tab-a', { endedAt: TERAZ - 1_000 }),
            zTabu('biegnie-mlody', 'tab-a', { status: 'running', createdAt: TERAZ - 2_000 }),
            czeka,
            zTabu('konczony-stary', 'tab-a', { endedAt: TERAZ - 9_000 }),
            zTabu('biegnie-stary', 'tab-a', { status: 'running', createdAt: TERAZ - 8_000 }),
        ],
        pending: [czeka],
    });

    t.deepEqual(rows.map(r => r.id), [
        'biegnie-stary', 'biegnie-mlody', 'czeka', 'konczony-swiezy', 'konczony-stary',
    ]);
    t.is(rows.find(r => r.id === 'czeka')!.state.kind, 'delivery', 'wiersz z kolejki jest oznaczony');
    t.is(rows.find(r => r.id === 'konczony-swiezy')!.state.kind, 'empty');
});

test('pasek: bieg czekający na dostarczenie nie dubluje się w zakończonych', t => {
    const czeka = zTabu('czeka', 'tab-a', { background: true, endedAt: TERAZ - 1_000 });
    const rows = buildStripModel({
        now: TERAZ, tabKey: 'tab-a', agentName: 'Klara',
        tasks: [czeka], pending: [czeka, czeka],
    });

    t.is(rows.length, 1);
});

test('pasek: zakończonych pokazujemy najwyżej 10 najnowszych', t => {
    const tasks = Array.from({ length: 25 }, (_, i) =>
        zTabu(`k${i}`, 'tab-a', { endedAt: TERAZ - (i + 1) * 1_000 }));

    const rows = buildStripModel({ now: TERAZ, tabKey: 'tab-a', agentName: 'Klara', tasks });

    t.is(rows.length, 10);
    t.is(rows[0].id, 'k0', 'najświeższy na górze');
    t.is(rows[9].id, 'k9');
});

test('pasek: wiersz niesie liczniki, ostatni krok z narzędziem i okno ≤20 kroków', t => {
    const reg = new SubTaskRegistry();
    const bieg = reg.create({ id: 'sub/pkm-sub#7', name: 'pkm-sub', agentName: 'Klara', origin: { agentName: 'Klara', tabKey: 'tab-a' } });
    for (let i = 0; i < 12; i++) reg.step(bieg, 'loop.iter', { i });
    reg.step(bieg, 'tool.pre', { tool: 'read' });
    reg.step(bieg, 'tool.post', { tool: 'read', ok: true });
    reg.step(bieg, 'tool.post', { tool: 'search', ok: true });

    const row = buildStripModel({ now: TERAZ, tabKey: 'tab-a', agentName: 'Klara', tasks: reg.list() })[0];

    t.is(row.runs[0].steps.length, 15);
    t.is(row.runs[0].toolCallCount, 2, 'liczymy WYNIKI narzędzi, nie zapowiedzi');
    t.is(row.runs[0].steps.at(-1)?.type, 'tool.post');
    t.is(row.runs[0].steps.at(-1)?.tool, 'search');
    t.is(row.runs[0].steps.filter(s => s.tool).length, 3, 'krok bez narzędzia nie dostaje pola `tool`');
    t.is(row.outcome, '', 'bieg w toku nie ma jeszcze wyniku');
});

test('pasek: wynik tnie się do 400 znaków, błąd wygrywa z tekstem wyniku', t => {
    const rows = buildStripModel({
        now: TERAZ, tabKey: 'tab-a', agentName: 'Klara',
        tasks: [
            zTabu('ok', 'tab-a', { endedAt: TERAZ - 1, result: { text: 'y'.repeat(900), toolsUsed: [], durationMs: 1, usage: null } }),
            zTabu('zly', 'tab-a', { status: 'error', endedAt: TERAZ - 2, error: 'model padł', result: { text: 'nieistotne', toolsUsed: [], durationMs: 1, usage: null } }),
        ],
    });

    t.is(rows.find(r => r.id === 'ok')!.outcome.length, 401, '400 znaków + wielokropek');
    t.is(rows.find(r => r.id === 'zly')!.outcome, 'model padł');
});

test('pasek: stopRequested i czas trwania biegu w toku liczony do TERAZ', t => {
    const rows = buildStripModel({
        now: TERAZ, tabKey: 'tab-a', agentName: 'Klara',
        tasks: [zTabu('r', 'tab-a', { status: 'running', createdAt: TERAZ - 6_000, stopRequested: true })],
    });

    t.is(rows[0].durationMs, 6_000);
    t.is(rows[0].state.kind, 'stopping');
});

test('pasek: brak wejścia / śmieci nie wywracają modelu', t => {
    t.deepEqual(buildStripModel(), []);
    t.deepEqual(buildStripModel({ tasks: null, pending: null, tabKey: null, agentName: null }), []);
});

// --- formatDuration ---

test('formatDuration: sekundy, minuty, minuty z resztą, śmieci', t => {
    t.is(formatDuration(0), '0 s');
    t.is(formatDuration(900), '0 s');
    t.is(formatDuration(7_400), '7 s');
    t.is(formatDuration(59_999), '59 s');
    t.is(formatDuration(60_000), '1 min');
    t.is(formatDuration(125_000), '2 min 5 s');
    t.is(formatDuration(-5), '0 s');
    t.is(formatDuration(NaN), '0 s');
});

// --- per SESJA (chipy nie mogą przeżyć archiwizacji sesji) ---

function zSesji(id: string, sessionPath: string, over: Partial<SubTask> = {}): SubTask {
    return task({ id, origin: { agentName: 'Klara', tabKey: 'Klara', sessionPath }, ...over });
}

test('sesja: zakończony bieg CUDZEJ sesji znika, mimo że klucz zakładki się zgadza', t => {
    const rows = buildStripModel({
        now: TERAZ, tabKey: 'Klara', agentName: 'Klara', sessionPath: 'sessions/active/nowa.md',
        tasks: [zSesji('stary', 'sessions/active/stara.md', { status: 'done', endedAt: TERAZ - 1_000 })],
    });
    t.deepEqual(rows, []);
});

test('sesja: bieg TEJ sesji zostaje; ŻYWY bieg cudzej sesji widać jako sierotę tego agenta', t => {
    const rows = buildStripModel({
        now: TERAZ, tabKey: 'Klara', agentName: 'Klara', sessionPath: 'sessions/active/nowa.md',
        tasks: [
            zSesji('moj', 'sessions/active/nowa.md', { status: 'done', endedAt: TERAZ - 1_000 }),
            zSesji('sierota', 'sessions/active/stara.md', { status: 'running' }),
            zSesji('cudzy-agent', 'sessions/active/stara.md', { status: 'running', origin: { agentName: 'Tola', tabKey: 'Tola', sessionPath: 'sessions/active/stara.md' } }),
        ],
    });
    t.deepEqual(rows.map(r => r.id).sort(), ['moj', 'sierota']);
});

test('sesja: świeża zakładka BEZ sesji nie pokazuje zakończonych biegów starej sesji', t => {
    const rows = buildStripModel({
        now: TERAZ, tabKey: 'Klara', agentName: 'Klara', sessionPath: '',
        tasks: [zSesji('stary', 'sessions/active/stara.md', { status: 'done', endedAt: TERAZ - 1_000 })],
    });
    t.deepEqual(rows, []);
});

test('sesja: bieg bez adresu sesji zachowuje się jak dotąd (tabKey → agent)', t => {
    const rows = buildStripModel({
        now: TERAZ, tabKey: 'tab-a', agentName: 'Klara', sessionPath: 'sessions/active/nowa.md',
        tasks: [zTabu('bez-sesji', 'tab-a', { status: 'done', endedAt: TERAZ - 1_000 })],
    });
    t.is(rows.length, 1);
});

// ─── konkret kroku + zadanie od maina ───

test('szyba: tool.pre czyta detail, tool.post rozmiar wyniku', t => {
    const rows = buildStripModel({
        now: TERAZ, tabKey: 'tab-a', agentName: 'Klara',
        tasks: [zTabu('bieg', 'tab-a', {
            status: 'running',
            steps: [
                { at: TERAZ - 5_000, type: 'tool.pre', fields: { tool: 'read', detail: 'Notatki/plan.md' } },
                { at: TERAZ - 4_900, type: 'tool.post', fields: { tool: 'read', status: 'ok', chars: 4222 } },
                { at: TERAZ - 4_000, type: 'tool.pre', fields: { tool: 'search', detail: 'smoke tandemowy' } },
                { at: TERAZ - 3_900, type: 'tool.post', fields: { tool: 'search', status: 'error' } },
                { at: TERAZ - 3_000, type: 'model.done', fields: { i: 2 } },
            ],
        })],
    });
    const steps = rows[0].runs[0].steps;
    t.is(steps[0].detail, 'Notatki/plan.md');
    t.is(steps[1].detail, '4222 zn.');
    t.is(steps[2].detail, 'smoke tandemowy');
    t.is(steps[3].detail, 'error');
    t.is(steps[4].detail, undefined, 'kroki bez narzędzia nie dostają konkretu');
});

test('szyba: konkret kroku ma do 80 znaków; panel nie wraca do surowych argumentów', t => {
    const dluga = 'A'.repeat(200);
    const rows = buildStripModel({
        now: TERAZ, tabKey: 'tab-a', agentName: 'Klara',
        tasks: [zTabu('bieg', 'tab-a', {
            status: 'running',
            steps: [
                { at: TERAZ - 2_000, type: 'tool.pre', fields: { tool: 'read', detail: dluga } },
                { at: TERAZ - 1_000, type: 'tool.pre', fields: { tool: 'search', args: '{krzywy json' } },
            ],
        })],
    });
    const steps = rows[0].runs[0].steps;
    t.is(steps[0].detail, 'A'.repeat(80));
    t.is(steps[1].detail, undefined);
});

test('szyba: pętla przekazuje ścieżkę, zapytanie i zwykły URL przez rejestr, bez task i obrazu w trace', async t => {
    const url = 'https://example.com/Notatki/projekty/planowanie/raport.md';
    const longUrl = `${url}?${'a'.repeat(40)}`;
    const prompt = 'JAWNA_TREŚĆ_ZADANIA';
    const image = 'data:image/png;base64,QUJD';
    const calls = [
        { name: 'read', arguments: JSON.stringify({ path: 'Notatki/plan.md', content: prompt }) },
        { name: 'search', arguments: { query: 'smoke tandemowy', prompt } },
        { name: 'web', arguments: { url } },
        { name: 'web', arguments: { url: longUrl } },
        { name: 'delegate', arguments: { task: prompt, image } },
    ];
    const lines: string[] = [];
    const traceLog = new TraceLog({
        sink: { write: (_level, _tag, message) => { lines.push(message); } },
        mask: maskSensitiveData
    });
    const reg = new SubTaskRegistry({ traceLog, mask: maskSensitiveData });
    const bieg = reg.create({ id: 'sub/pkm-sub#detail', agentName: 'Klara' });
    let response = 0;
    await runAgentLoop({
        model: {
            stream(_payload, { done }) {
                const first = response++ === 0;
                Promise.resolve().then(() => done(first
                    ? { tool_calls: calls.map((call, i) => ({ id: `c${i}`, ...call })) }
                    : { choices: [{ message: { content: 'done' } }] }));
            }
        },
        store: new ArrayMessageStore([{ role: 'user', content: 'go' }]),
        resolveTools: () => ['read', 'search', 'web', 'delegate'].map(name => ({ name })),
        executeToolCall: async () => 'result',
        limits: { maxIterations: 3 },
        trace: reg.traceFor(bieg)
    });
    const row = buildStripModel({ tasks: reg.list(), agentName: 'Klara', now: TERAZ })[0];
    t.deepEqual(row.runs[0].steps.filter(step => step.type === 'tool.pre').map(step => step.detail), [
        'Notatki/plan.md', 'smoke tandemowy', url,
        'https://example.com/Notatki/projekty/planowanie/raport.md?aaaaaaaaaaaaaaaaaaaaaa', undefined
    ]);
    t.deepEqual(bieg.steps.filter(step => step.type === 'tool.pre').map(step => step.fields), [
        { i: 0, tool: 'read', detail: 'Notatki/plan.md' },
        { i: 0, tool: 'search', detail: 'smoke tandemowy' },
        { i: 0, tool: 'web', detail: url },
        { i: 0, tool: 'web', detail: 'https://example.com/Notatki/projekty/planowanie/raport.md?aaaaaaaaaaaaaaaaaaaaaa' },
        { i: 0, tool: 'delegate' }
    ]);
    t.is(lines.find(line => line.includes('tool=read')), `${bieg.id} | tool.pre | i=0 tool=read detail=Notatki/plan.md`);
    for (const text of [JSON.stringify(bieg.steps), lines.join('\n')]) {
        t.false(text.includes(prompt));
        t.false(text.includes(image));
        t.false(text.includes('data:'));
    }
    reg.dispose();
});

test('szyba: taskPreview przechodzi do wiersza (z drugim pasem cięcia), brak = pusty string', t => {
    const rows = buildStripModel({
        now: TERAZ, tabKey: 'tab-a', agentName: 'Klara',
        tasks: [
            zTabu('z-zadaniem', 'tab-a', { endedAt: TERAZ - 1_000, taskPreview: 'Zbierz kontekst smoke testów' }),
            zTabu('bez-zadania', 'tab-a', { endedAt: TERAZ - 2_000 }),
        ],
    });
    t.is(rows[0].taskPreview, 'Zbierz kontekst smoke testów');
    t.is(rows[1].taskPreview, '');
});

test('szyba: rejestr tnie taskPreview do 300 znaków i maskuje sekrety', t => {
    const registry = new SubTaskRegistry({ mask: (s: string) => s.replace('sk-tajny-klucz', 'sk-***') });
    const created = registry.create({
        id: 'sub/x#1',
        taskPreview: `Użyj klucza sk-tajny-klucz i ${'B'.repeat(400)}`,
    });
    t.true(created.taskPreview!.length <= 300);
    t.true(created.taskPreview!.includes('sk-***'));
    t.false(created.taskPreview!.includes('sk-tajny-klucz'));
    registry.dispose?.();
});

test('wątki queued dostają pozycję w kolejności rejestru i filtrują pełnego właściciela', t => {
    const reg = new SubTaskRegistry();
    const owner = { agentName: 'Klara', sessionPath: 'active.md', sessionEpoch: 'epoch-q' };
    reg.createThread({ threadId: 'q1', name: 'worker-1', owner, origin: owner, config: {}, phase: 'queued' });
    reg.createThread({ threadId: 'q2', name: 'worker-2', owner, origin: owner, config: {}, phase: 'queued' });
    reg.createThread({ threadId: 'other', name: 'other', owner: { ...owner, sessionEpoch: 'epoch-other' }, origin: owner, config: {}, phase: 'queued' });
    const rows = buildStripModel({ threads: reg.listThreads(owner), tasks: reg.list(), agentName: owner.agentName, sessionPath: owner.sessionPath, sessionEpoch: owner.sessionEpoch });
    t.deepEqual(rows.map(row => row.state), [{ kind: 'queued', position: 1 }, { kind: 'queued', position: 2 }]);
    t.is(tr('chat.substrip.queue_position', { position: '1' }, 'pl'), '1. w kolejce');
    t.is(tr('chat.substrip.queue_position', { position: '2' }, 'en'), '2 in queue');
    reg.dispose();
});

test('wątek z dwoma biegami ma jeden wiersz i zachowuje oś runIds oraz limit z rejestru', t => {
    const reg = new SubTaskRegistry();
    const owner = { agentName: 'Klara', sessionPath: 'active.md', sessionEpoch: 'epoch-runs' };
    const thread = reg.createThread({ threadId: 'thread-runs', name: 'worker', owner, origin: owner, config: { limits: { subagent_thread_max_runs: 5 } } });
    const first = reg.create({ id: 'run-a', name: 'worker', agentName: owner.agentName, threadId: thread.threadId });
    reg.finish(first, { text: 'gotowe', toolsUsed: [], durationMs: 1, usage: null, outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] } });
    reg.beginRun(thread.threadId, owner);
    reg.create({ id: 'run-b', name: 'worker', agentName: owner.agentName, threadId: thread.threadId });
    const rows = buildStripModel({ threads: reg.listThreads(owner), tasks: reg.list(), agentName: owner.agentName, sessionPath: owner.sessionPath, sessionEpoch: owner.sessionEpoch, getThreadRunLimit: id => reg.getThreadMaxRuns(id) });
    t.is(rows.length, 1);
    t.deepEqual(rows[0].runs.map(run => run.id), ['run-a', 'run-b']);
    t.is(tr('chat.substrip.run_number', { number: '2', total: String(rows[0].runLimit) }, 'pl'), 'bieg 2 z 5');
    t.is(rows[0].state.kind, 'running');
    reg.dispose();
});

test('stan wyniku nie zależy od słów w treści, a wiadomość agenta jest tylko do odczytu', t => {
    const reg = new SubTaskRegistry();
    const owner = { agentName: 'Klara', sessionPath: 'active.md', sessionEpoch: 'epoch-state' };
    const thread = reg.createThread({ threadId: 'thread-state', name: 'worker', owner, origin: owner, config: {} });
    const task = reg.create({ id: 'run-state', name: 'worker', agentName: owner.agentName, threadId: thread.threadId });
    reg.postMessage(task.id, 'Sprawdź plan');
    reg.finish(task, { text: 'wystąpił błąd, ale gotowe', toolsUsed: [], durationMs: 1, usage: null, outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] } });
    reg.endRun(thread.threadId, { successful: true, answer: 'wystąpił błąd, ale gotowe' });
    const row = buildStripModel({ threads: reg.listThreads(owner), tasks: reg.list(), agentName: owner.agentName, sessionPath: owner.sessionPath, sessionEpoch: owner.sessionEpoch })[0];
    t.deepEqual(row.state, { kind: 'idle' });
    t.is(row.runs[0].steps[0].type, 'user.message');
    t.is(row.runs[0].steps[0].readOnly, true);
    t.is(row.runs[0].steps[0].detail, 'Sprawdź plan');
    reg.dispose();
});

test('rejestr wyprowadza wszystkie stany paska z phase, stopRequested, outcome i notifiera', t => {
    const reg = new SubTaskRegistry();
    const owner = { agentName: 'Klara', sessionPath: 'active.md', sessionEpoch: 'epoch-states' };
    const thread = (id: string, phase: 'queued' | 'running' | 'idle' | 'closed' = 'running') => reg.createThread({ threadId: id, name: id, owner, origin: owner, config: {}, phase });
    const makeThreadRun = (threadId: string, id: string) => reg.create({ id, name: threadId, agentName: owner.agentName, origin: owner, threadId });
    const result = (end: NonNullable<SubTask['outcome']>['end'], completeness: NonNullable<SubTask['outcome']>['completeness'] = 'partial') => ({
        end, completeness, hasAnswer: false, hasMaterial: completeness !== 'empty', effects: [],
    });

    thread('queued-state', 'queued');
    const runningThread = thread('running-state');
    makeThreadRun(runningThread.threadId, 'running-run');
    const stoppingThread = thread('stopping-state');
    const stoppingRun = makeThreadRun(stoppingThread.threadId, 'stopping-run');
    reg.attachAbort(stoppingRun.id, () => {});
    reg.requestStop(stoppingRun.id, 'user');
    const idleThread = thread('idle-state');
    const idleRun = makeThreadRun(idleThread.threadId, 'idle-run');
    reg.finish(idleRun, { text: 'answer', toolsUsed: [], durationMs: 1, usage: null, outcome: result({ kind: 'finished' }, 'unconfirmed') });
    reg.endRun(idleThread.threadId, { successful: true, answer: 'answer' });
    const closedThread = thread('closed-state', 'queued');
    reg.closeThread(closedThread.threadId);

    const makeFinished = (id: string, outcome: NonNullable<SubTask['outcome']>, text = 'material') => {
        const task = reg.create({ id, name: id, agentName: owner.agentName, origin: owner });
        reg.finish(task, { text, toolsUsed: [], durationMs: 1, usage: null, outcome });
        return task;
    };
    makeFinished('done-state', result({ kind: 'finished' }, 'unconfirmed'), 'done');
    const delivery = makeFinished('delivery-state', result({ kind: 'finished' }, 'unconfirmed'), 'delivery');
    makeFinished('incomplete-state', result({ kind: 'finished' }));
    makeFinished('limit-state', result({ kind: 'limit', reason: 'iteration-limit' }));
    makeFinished('uncertain-state', result({ kind: 'uncertain' }));
    makeFinished('user-stop-state', result({ kind: 'stopped', by: 'user' }));
    makeFinished('lead-stop-state', result({ kind: 'stopped', by: 'lead' }));
    makeFinished('system-stop-state', result({ kind: 'stopped', by: 'system' }));
    makeFinished('timeout-state', result({ kind: 'timeout' }));
    makeFinished('error-state', result({ kind: 'failed', stage: 'work' }));
    const empty = makeFinished('empty-state', result({ kind: 'failed', stage: 'work' }, 'empty'), '');

    const input = { tasks: reg.list(), threads: reg.listThreads(owner), pending: [delivery], agentName: owner.agentName, sessionPath: owner.sessionPath, sessionEpoch: owner.sessionEpoch };
    const rows = buildStripModel(input);
    const byName = new Map(rows.map(row => [row.name, row]));
    const cases: Array<[string, StripState['kind'], string, string]> = [
        ['queued-state', 'queued', 'czeka na miejsce', 'waiting for a slot'],
        ['running-state', 'running', 'pracuje', 'working'],
        ['stopping-state', 'stopping', 'zatrzymuje się', 'stopping'],
        ['idle-state', 'idle', 'czeka na kolejne zadanie', 'waiting for another task'],
        ['done-state', 'done', 'skończył sam · wynik niesprawdzony', 'finished on its own · result unchecked'],
        ['delivery-state', 'delivery', 'czeka na doręczenie', 'waiting for delivery'],
        ['incomplete-state', 'partial', 'wynik częściowy', 'partial result'],
        ['limit-state', 'partial', 'skończył mu się budżet kroków · częściowy', 'step budget reached · partial'],
        ['uncertain-state', 'partial', 'stanął na niepewnym zapisie · częściowy', 'stopped at an uncertain write · partial'],
        ['user-stop-state', 'partial', 'zatrzymany przez Ciebie · częściowy', 'stopped by you · partial'],
        ['lead-stop-state', 'partial', 'zatrzymany przez agenta · częściowy', 'stopped by agent · partial'],
        ['system-stop-state', 'partial', 'zatrzymany przez system · częściowy', 'stopped by system · partial'],
        ['timeout-state', 'partial', 'przekroczył czas · częściowy', 'timed out · partial'],
        ['error-state', 'partial', 'awaria · częściowy', 'failed · partial'],
        ['empty-state', 'empty', 'pusty wynik', 'empty result'],
        ['closed-state', 'closed', 'zamknięty', 'closed'],
    ];
    t.is(rows.find(row => row.id === empty.id)?.state.kind, 'empty');
    for (const [name, kind, pl, en] of cases) {
        const row = byName.get(name);
        t.is(row?.state.kind, kind, `${name}: literal kind`);
        const parts = getStripStateLabelParts(row!.state);
        const label = (locale: 'pl' | 'en') => [tr(parts.end, undefined, locale), parts.completeness ? tr(parts.completeness, undefined, locale) : ''].filter(Boolean).join(' · ');
        t.is(label('pl'), pl, `${name}: literal PL label`);
        t.is(label('en'), en, `${name}: literal EN label`);
    }
    reg.dispose();
});

test('częściowy wynik pozostaje widoczny po przejściu wątku do idle', t => {
    const reg = new SubTaskRegistry();
    const owner = { agentName: 'Klara', sessionPath: 'active.md', sessionEpoch: 'epoch-partial' };
    reg.createThread({ threadId: 'partial-thread', name: 'worker', owner, origin: owner, config: {} });
    const run = reg.create({ id: 'partial-run', name: 'worker', agentName: owner.agentName, origin: owner, threadId: 'partial-thread' });
    reg.finish(run, { text: 'Zachowany dorobek', toolsUsed: [], durationMs: 1, usage: null,
        outcome: { end: { kind: 'limit', reason: 'iteration-limit' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [] } });
    reg.endRun('partial-thread', { successful: true });
    const row = buildStripModel({ tasks: reg.list(), threads: reg.listThreads(owner), ...owner })[0];
    t.deepEqual(row.state, { kind: 'partial', reason: 'limit' });
    t.deepEqual(row.runs[0].state, { kind: 'partial', reason: 'limit' });
    reg.dispose();
});

test('biegnący osierocony bieg starej sesji pozostaje widoczny', t => {
    const reg = new SubTaskRegistry();
    const old = { agentName: 'Klara', sessionPath: 'old.md', sessionEpoch: 'old' };
    const current = { agentName: 'Klara', sessionPath: 'new.md', sessionEpoch: 'new' };
    reg.createThread({ threadId: 'old-thread', name: 'old-worker', owner: old, origin: old, config: {} });
    reg.create({ id: 'old-run', name: 'old-worker', agentName: old.agentName, origin: old, threadId: 'old-thread' });
    reg.createThread({ threadId: 'new-thread', name: 'new-worker', owner: current, origin: current, config: {} });
    const rows = buildStripModel({ tasks: reg.list(), threads: reg.listThreads(current), ...current });
    t.deepEqual(rows.map(row => row.id), ['new-thread', 'old-run']);
    t.deepEqual(rows[1].state, { kind: 'running' });
    reg.dispose();
});

test('liczniki i efekty korzystają z pełnych danych rejestru', t => {
    const reg = new SubTaskRegistry();
    const owner = { agentName: 'Klara', sessionPath: 'active.md', sessionEpoch: 'epoch-effects' };
    reg.createThread({ threadId: 'effects-thread', name: 'worker', owner, origin: owner, config: {} });
    const run = reg.create({ id: 'effects-run', name: 'worker', agentName: owner.agentName, origin: owner, threadId: 'effects-thread' });
    for (let i = 0; i < 15; i++) {
        reg.step(run, 'tool.pre', { tool: 'read', detail: `plik-${i}.md` });
        reg.step(run, 'tool.post', { tool: 'read', chars: 10 });
    }
    reg.step(run, 'model.done', { tokens: 99 });
    const effects = [
        { tool: 'write', action: 'create', targets: [{ kind: 'vault-file' as const, path: 'ok.md' }], outcome: 'returned' as const, check: 'matches' as const },
        { tool: 'write', action: 'create', targets: [{ kind: 'vault-file' as const, path: 'brak.md' }], outcome: 'returned' as const, check: 'mismatch' as const },
        { tool: 'delete', action: 'delete', targets: [{ kind: 'vault-file' as const, path: 'do-usuniecia.md' }], outcome: 'returned' as const, check: 'mismatch' as const },
        { tool: 'write', action: 'create', targets: [{ kind: 'vault-file' as const, path: 'bez-kontroli.md' }], outcome: 'returned' as const, check: 'not-checked' as const },
    ];
    reg.finish(run, { text: 'dorobek', toolsUsed: ['read'], durationMs: 1,
        usage: { prompt_tokens: 123, completion_tokens: 45 },
        outcome: { end: { kind: 'finished' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects } });
    reg.endRun('effects-thread', { successful: true, effects: [
        { ...effects[0], expectedCheck: 'exists' },
        { ...effects[1], expectedCheck: 'exists' },
        { ...effects[2], expectedCheck: 'absent' },
        { ...effects[3], expectedCheck: 'exists' },
    ] });
    const row = buildStripModel({ tasks: reg.list(), threads: reg.listThreads(owner), ...owner })[0];
    t.is(row.runs[0].toolCallCount, 15);
    t.is(row.runs[0].steps.length, 20);
    t.is(row.runs[0].tokenInput, 123);
    t.is(row.runs[0].tokenOutput, 45);
    t.deepEqual(row.runs[0].effects.map(effect => effect.check), ['matches', 'mismatch', 'mismatch', 'not-checked']);
    t.deepEqual(row.runs[0].missingTargets, ['brak.md']);
    reg.dispose();
});

test('biegnący bieg obcego agenta z tą samą ścieżką sesji nie trafia do paska', t => {
    const reg = new SubTaskRegistry();
    const owner = { agentName: 'Klara', sessionPath: 'active.md', sessionEpoch: 'epoch-klara' };
    const other = { agentName: 'Tola', sessionPath: 'active.md', sessionEpoch: 'epoch-tola' };
    reg.createThread({ threadId: 'tola-thread', name: 'tola', owner: other, origin: other, config: {} });
    reg.create({ id: 'tola-run', name: 'tola', agentName: other.agentName, origin: other, threadId: 'tola-thread' });
    const rows = buildStripModel({ tasks: reg.list(), threads: reg.listThreads(owner), ...owner });
    t.deepEqual(rows.map(row => row.id), []);
    reg.dispose();
});

test('wynik oczekujący w notifierze pozostaje dostępny po retencji rejestru', t => {
    const reg = new SubTaskRegistry({ maxDone: 1 });
    const notifier = new SubTaskNotifier({ registry: reg });
    const owner = { agentName: 'Klara', sessionPath: 'active.md', sessionEpoch: 'epoch-retention' };
    for (const [threadId, runId, answer] of [
        ['first-thread', 'first-run', 'Pierwszy wynik'],
        ['second-thread', 'second-run', 'Drugi wynik'],
    ]) {
        reg.createThread({ threadId, name: threadId, owner, origin: owner, config: {} });
        const run = reg.create({ id: runId, name: threadId, agentName: owner.agentName, origin: owner, threadId, background: true });
        reg.finish(run, { text: answer, toolsUsed: [], durationMs: 1, usage: null,
            outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] } });
    }
    t.deepEqual(reg.list().map(run => run.id), ['second-run']);
    t.deepEqual(notifier.pending().map(run => run.id), ['first-run', 'second-run']);
    const rows = buildStripModel({ tasks: reg.list(), pending: notifier.pending(), threads: reg.listThreads(owner), ...owner });
    const first = rows.find(row => row.id === 'first-thread');
    t.is(first?.state.kind, 'delivery');
    t.is(first?.runs[0].available, true);
    t.is(first?.runs[0].outcome, 'Pierwszy wynik');
    t.is(rows.filter(row => row.id === 'first-thread').length, 1);
    notifier.dispose();
    reg.dispose();
});

test('biegnący bieg pokazuje tokeny zapisane w kroku model.done', t => {
    const reg = new SubTaskRegistry();
    const owner = { agentName: 'Klara', sessionPath: 'active.md', sessionEpoch: 'epoch-tokens' };
    reg.createThread({ threadId: 'tokens-thread', name: 'worker', owner, origin: owner, config: {} });
    const run = reg.create({ id: 'tokens-run', name: 'worker', agentName: owner.agentName, origin: owner, threadId: 'tokens-thread' });
    reg.step(run, 'model.done', { i: 0, in: 123, out: 45 });
    const row = buildStripModel({ tasks: reg.list(), threads: reg.listThreads(owner), ...owner })[0];
    t.is(row.runs[0].tokenInput, 123);
    t.is(row.runs[0].tokenOutput, 45);
    reg.dispose();
});

test('nowy bieg nie dziedziczy efektów ani brakujących celów poprzedniego biegu', t => {
    const reg = new SubTaskRegistry();
    const owner = { agentName: 'Klara', sessionPath: 'active.md', sessionEpoch: 'epoch-effects' };
    const thread = reg.createThread({ threadId: 'effects-thread', name: 'worker', owner, origin: owner, config: {} });
    const first = reg.create({ id: 'first-run', name: 'worker', agentName: owner.agentName, threadId: thread.threadId });
    const effect = { tool: 'write', action: 'create', targets: [{ kind: 'vault-file' as const, path: 'brak.md' }],
        outcome: 'returned' as const, check: 'mismatch' as const };
    reg.finish(first, { text: 'pierwszy wynik', toolsUsed: ['write'], durationMs: 1, usage: null,
        outcome: { end: { kind: 'finished' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [effect] } });
    reg.endRun(thread.threadId, { successful: true, effects: [{ ...effect, expectedCheck: 'exists' }] });
    t.true(reg.beginRun(thread.threadId, owner));
    reg.create({ id: 'second-run', name: 'worker', agentName: owner.agentName, threadId: thread.threadId });

    const row = buildStripModel({ tasks: reg.list(), threads: reg.listThreads(owner), ...owner })[0];
    t.deepEqual(row.runs.map(run => run.id), ['first-run', 'second-run']);
    t.deepEqual(row.runs[0].effects.map(item => item.targets[0].path), ['brak.md']);
    t.deepEqual(row.runs[0].missingTargets, ['brak.md']);
    t.deepEqual(row.runs[1].steps, []);
    t.deepEqual(row.runs[1].effects, []);
    t.deepEqual(row.runs[1].missingTargets, []);
    t.deepEqual(row.runs[1].state, { kind: 'running' });
    reg.dispose();
});

test('awaria po zachowaniu dorobku pokazuje handoff osobno od powodu końca', t => {
    const reg = new SubTaskRegistry();
    const owner = { agentName: 'Klara', sessionPath: 'active.md', sessionEpoch: 'epoch-failure' };
    const thread = reg.createThread({ threadId: 'failure-thread', name: 'worker', owner, origin: owner, config: {} });
    const run = reg.create({ id: 'failure-run', name: 'worker', agentName: owner.agentName, origin: owner, threadId: thread.threadId });
    const outcome = { end: { kind: 'failed' as const, stage: 'work' as const }, completeness: 'partial' as const,
        hasAnswer: false, hasMaterial: true, effects: [] };
    reg.endRun(thread.threadId, { successful: false });
    reg.fail(run, 'Awaria modelu', outcome, { text: '', toolsUsed: [], durationMs: 1, usage: null, outcome,
        handoff: 'Zachowany dorobek: odczytano Plan.md i ustalono trzy kroki' });

    const row = buildStripModel({ tasks: reg.list(), threads: reg.listThreads(owner), ...owner })[0];
    t.deepEqual(row.runs[0].state, { kind: 'partial', reason: 'error' });
    t.is(row.runs[0].outcome, 'Zachowany dorobek: odczytano Plan.md i ustalono trzy kroki');
    t.is(row.runs[0].endReason, 'Awaria modelu');
    reg.dispose();
});

test('częściowy bieg używa handoff, a bez niego zachowanego partial.text', t => {
    const reg = new SubTaskRegistry();
    const owner = { agentName: 'Klara', sessionPath: 'active.md', sessionEpoch: 'epoch-partial' };
    for (const [threadId, handoff, expected] of [
        ['with-handoff', 'Dorobek z przekazania', 'Dorobek z przekazania'],
        ['without-handoff', '', 'Dorobek z migawki'],
    ]) {
        const thread = reg.createThread({ threadId, name: 'worker', owner, origin: owner, config: {} });
        const run = reg.create({ id: `${threadId}-run`, name: 'worker', agentName: owner.agentName, origin: owner, threadId: thread.threadId });
        reg.publishPartial(run, { kind: 'agent-loop-partial', revision: 1, stopReason: { kind: 'iteration-limit' },
            synthesis: 'skipped', toolsUsed: [], toolOutcomes: [], toolCallDetails: [],
            usage: { prompt_tokens: 0, completion_tokens: 0 }, iterations: 1, lastText: '', text: 'Dorobek z migawki' });
        reg.finish(run, { text: 'Tekst wyniku', toolsUsed: [], durationMs: 1, usage: null,
            outcome: { end: { kind: 'limit', reason: 'iteration-limit' }, completeness: 'partial', hasAnswer: false,
                hasMaterial: true, effects: [] }, handoff });
        const row = buildStripModel({ tasks: reg.list(), threads: reg.listThreads(owner), ...owner })
            .find(candidate => candidate.id === threadId)!;
        t.is(row.runs[0].outcome, expected);
        t.is(row.runs[0].endReason, undefined);
    }
    reg.dispose();
});

test('pasek: bieg w podsumowaniu i pad zapisu dorobku niosą notkę biegu, zwykły bieg jej nie ma', t => {
    const rows = buildStripModel({
        now: TERAZ,
        tabKey: 'tab-a',
        agentName: 'Klara',
        tasks: [
            zTabu('synteza', 'tab-a', { status: 'running', partial: { synthesis: 'pending' } as SubTask['partial'] }),
            zTabu('zapis', 'tab-a', { endedAt: TERAZ - 1_000, partialStorageError: true }),
            zTabu('zwykly', 'tab-a', { endedAt: TERAZ - 2_000 }),
        ],
    });
    const note = (id: string) => rows.find(r => r.id === id)?.runs[0]?.note;
    t.is(note('synteza'), 'synthesis-pending');
    t.is(note('zapis'), 'storage-error');
    t.is(note('zwykly'), undefined);
});

test('publiczny model wyniku klasyfikuje stan, etykiety i jawny dowód wielokrotnego wątku', t => {
    const outcome = { end: { kind: 'limit', reason: 'iteration-limit' } as const, completeness: 'partial' as const,
        hasAnswer: false, hasMaterial: true, effects: [] };
    const model = buildSubTaskResultModel({ outcome, text: 'Wynik', thread: { kind: 'reusable', sub_id: 'sub/worker#1' } });

    t.deepEqual(model.state, { kind: 'partial', reason: 'limit' });
    t.deepEqual(getStripStateLabelParts(model.state), { end: 'chat.substrip.state_partial_limit', completeness: 'chat.substrip.completeness_partial' });
    t.deepEqual(model.end, { kind: 'limit', reason: 'iteration-limit' });
    t.is(model.material, 'Wynik');
    t.is(model.thread.kind, 'reusable');
    if (model.thread.kind === 'reusable') t.is(model.thread.sub_id, 'sub/worker#1');
});

test('model i pasek wybierają tekst przed handoff poza wynikiem częściowym', t => {
    for (const completeness of [undefined, 'unconfirmed', 'empty', 'partial'] as const) {
        const outcome = completeness === undefined ? undefined : {
            end: { kind: 'finished' } as const, completeness, hasAnswer: true, hasMaterial: true, effects: [],
        };
        const result = { text: 'Tekst wyniku', handoff: 'Dorobek z przekazania', toolsUsed: [], durationMs: 1, usage: null };
        const expected = completeness === 'partial' ? 'Dorobek z przekazania' : 'Tekst wyniku';
        const model = buildSubTaskResultModel({ ...result, outcome, thread: { kind: 'single' } });
        const rows = buildStripModel({ agentName: 'Klara', tabKey: 'tab-a', now: TERAZ,
            tasks: [zTabu('wynik', 'tab-a', { result, outcome })] });

        t.is(model.material, expected);
        t.is(rows[0].runs[0].outcome, expected);
    }
});

test('pasek zachowuje legacy wybór: tekst przed handoff poza partial, błąd przed result.text przy partial error', t => {
    const partialError = {
        end: { kind: 'failed' as const, stage: 'work' as const }, completeness: 'partial' as const,
        hasAnswer: false, hasMaterial: true, effects: [],
    };
    const rows = buildStripModel({ agentName: 'Klara', tabKey: 'tab-a', now: TERAZ, tasks: [
        zTabu('non-partial', 'tab-a', { result: { text: 'Legacy text', handoff: 'Legacy handoff', toolsUsed: [], durationMs: 1, usage: null } }),
        zTabu('partial-error', 'tab-a', { status: 'error', error: 'Legacy error', outcome: partialError,
            result: { text: 'Result text only', toolsUsed: [], durationMs: 1, usage: null } }),
    ] });

    t.is(rows.find(row => row.id === 'non-partial')?.runs[0].outcome, 'Legacy text');
    t.is(rows.find(row => row.id === 'partial-error')?.runs[0].outcome, 'Legacy error');
    t.is(rows.find(row => row.id === 'partial-error')?.runs[0].endReason, undefined);

    // The shared chat model continues to expose material even when the strip's
    // legacy failure presentation intentionally shows only the error.
    const shared = buildSubTaskResultModel({ outcome: partialError, text: 'Result text only', thread: { kind: 'single' } });
    t.is(shared.material, 'Result text only');
});

test('publiczny model wyniku zachowuje dorobek przy awarii i osobno zwraca błąd', t => {
    const model = buildSubTaskResultModel({
        outcome: { end: { kind: 'failed', stage: 'work' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [] },
        text: 'Zwykły wynik', handoff: 'Zachowany handoff', error: 'Awaria modelu', thread: { kind: 'single' },
    });

    t.is(model.material, 'Zachowany handoff');
    t.is(model.error, 'Awaria modelu');
    t.deepEqual(model.thread, { kind: 'single' });
    t.is(model.userStopped, false);
});

test('publiczny model wyniku raportuje stany efektów i braki tylko dla oczekiwanego istnienia', t => {
    const model = buildSubTaskResultModel({
        outcome: { end: { kind: 'stopped', by: 'user' }, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [
            { tool: 'write', action: 'create', targets: [{ kind: 'vault-file', path: 'brak.md' }], outcome: 'returned', check: 'mismatch' },
            { tool: 'write', action: 'create', targets: [{ kind: 'vault-file', path: 'ok.md' }], outcome: 'returned', check: 'matches' },
            { tool: 'read', action: 'read', targets: [{ kind: 'vault-file', path: 'unknown.md' }], outcome: 'unknown', check: 'not-checked' },
            { tool: 'delete', action: 'delete', targets: [{ kind: 'vault-file', path: 'still-here.md' }], outcome: 'returned', check: 'mismatch' },
        ] },
        effects: [{ tool: 'write', action: 'create', targets: [{ kind: 'vault-file', path: 'brak.md' }], outcome: 'returned', check: 'mismatch', expectedCheck: 'exists' },
            { tool: 'write', action: 'create', targets: [{ kind: 'vault-file', path: 'ok.md' }], outcome: 'returned', check: 'matches', expectedCheck: 'exists' },
            { tool: 'read', action: 'read', targets: [{ kind: 'vault-file', path: 'unknown.md' }], outcome: 'unknown', check: 'not-checked', expectedCheck: 'exists' },
            { tool: 'delete', action: 'delete', targets: [{ kind: 'vault-file', path: 'still-here.md' }], outcome: 'returned', check: 'mismatch', expectedCheck: 'absent' }],
        thread: { kind: 'unknown' },
    });

    t.deepEqual(model.effects.map(effect => effect.state), ['missing', 'matches', 'unchecked', 'mismatch']);
    t.deepEqual(model.missingTargets, ['brak.md']);
    t.deepEqual(model.end, { kind: 'stopped', by: 'user' });
    t.is(model.userStopped, true);
    t.deepEqual(model.thread, { kind: 'unknown' });
});

test('publiczny model wyniku mapuje każdy rodzaj końca i zachowuje przyczynę pustego Stopu', t => {
    const base = { completeness: 'partial' as const, hasAnswer: false, hasMaterial: false, effects: [] };
    const cases = [
        [{ kind: 'finished' } as const, 'chat.substrip.state_partial_incomplete'],
        [{ kind: 'limit', reason: 'iteration-limit' } as const, 'chat.substrip.state_partial_limit'],
        [{ kind: 'uncertain' } as const, 'chat.substrip.state_partial_uncertain'],
        [{ kind: 'stopped', by: 'user' } as const, 'chat.substrip.state_partial_user'],
        [{ kind: 'stopped', by: 'lead' } as const, 'chat.substrip.state_partial_lead'],
        [{ kind: 'stopped', by: 'system' } as const, 'chat.substrip.state_partial_system'],
        [{ kind: 'timeout' } as const, 'chat.substrip.state_partial_timeout'],
        [{ kind: 'failed', stage: 'work' } as const, 'chat.substrip.state_partial_error'],
    ] as const;
    for (const [end, expectedKey] of cases) {
        const model = buildSubTaskResultModel({ outcome: { ...base, end }, thread: { kind: 'single' } });
        t.is(model.endLabelKey, expectedKey);
    }
    const finished = buildSubTaskResultModel({ outcome: { ...base, end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true }, thread: { kind: 'single' } });
    t.is(finished.endLabelKey, 'chat.substrip.state_done');
    t.is(finished.completenessLabelKey, 'chat.subresult.completeness.unconfirmed');

    const emptyStop = buildSubTaskResultModel({ outcome: { ...base, end: { kind: 'stopped', by: 'user' }, completeness: 'empty' }, thread: { kind: 'single' } });
    t.is(emptyStop.endLabelKey, 'chat.substrip.state_partial_user');
    t.is(emptyStop.completenessLabelKey, 'chat.subagent_notification.completeness_empty');
    t.deepEqual(emptyStop.state, { kind: 'empty' });
    t.is(emptyStop.userStopped, true);
});

test('publiczny model zachowuje przyczynę pustego błędu, timeoutu i limitu', t => {
    const cases = [
        [{ kind: 'failed', stage: 'work' } as const, 'chat.substrip.state_partial_error'],
        [{ kind: 'timeout' } as const, 'chat.substrip.state_partial_timeout'],
        [{ kind: 'limit', reason: 'iteration-limit' } as const, 'chat.substrip.state_partial_limit'],
    ] as const;
    for (const [end, endLabelKey] of cases) {
        const model = buildSubTaskResultModel({ outcome: { end, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] }, thread: { kind: 'single' } });
        t.is(model.endLabelKey, endLabelKey);
        t.is(model.completenessLabelKey, 'chat.subagent_notification.completeness_empty');
        t.deepEqual(model.state, { kind: 'empty' });
    }
});

test('publiczny model nie wyprowadza kontynuacji z samego biegu ani task_id', t => {
    for (const thread of [{ kind: 'single' } as const, { kind: 'unknown' } as const]) {
        const model = buildSubTaskResultModel({ text: 'Wynik', thread, outcome: null });
        t.deepEqual(model.thread, thread);
        t.false('sub_id' in model.thread);
    }
    t.throws(() => buildSubTaskResultModel({ thread: { kind: 'reusable', sub_id: '  ' } }), { message: 'Reusable sub-agent thread requires a non-empty sub_id' });
});
test('model zachowuje żywy bieg i treść pytania', t => {
    const registry = new SubTaskRegistry();
    const task = registry.create({ id: 'r1', threadId: 's1', name: 'Klara', origin: { agentName: 'Jaskier', sessionPath: 's.md', sessionEpoch: 'e1' } });
    const opened = registry.openParentQuestion('r1', 'Jaki zakres?');
    if (opened.kind !== 'opened') throw new Error('question did not open');
    const rows = buildStripModel({ tasks: [task], agentName: 'Jaskier', sessionPath: 's.md' });
    const state = rows[0].questionState;
    t.deepEqual({ state: rows[0].state.kind, questionId: state.kind === 'waiting' && state.question.id === opened.question.id ? 'q1' : '', text: state.kind === 'waiting' ? state.question.text : '', running: summarizeStripRows(rows).running }, { state: 'running', questionId: 'q1', text: 'Jaki zakres?', running: 1 });
    registry.dispose();
});
