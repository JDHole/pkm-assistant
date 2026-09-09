/**
 * Testy modelu paska biegów subów.
 *
 * Model jest jedyną częścią paska, którą da się sprawdzić bez Obsidiana — i jedyną,
 * w której da się coś policzyć źle po cichu (bieg z cudzej zakładki, duplikat wiersza,
 * licznik z sufitu, urwany wynik).
 */
import test from 'ava';
import { buildStripModel, formatDuration } from './subTaskPanelModel.js';
import { SubTaskRegistry } from './SubTaskRegistry.js';
import type { SubTask } from './SubTaskRegistry.js';

const TERAZ = 1_000_000;

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
    t.true(rows.find(r => r.id === 'czeka')!.waiting, 'wiersz z kolejki jest oznaczony');
    t.false(rows.find(r => r.id === 'konczony-swiezy')!.waiting);
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

    t.is(row.stepCount, 15);
    t.is(row.toolCallCount, 2, 'liczymy WYNIKI narzędzi, nie zapowiedzi');
    t.is(row.lastStep?.type, 'tool.post');
    t.is(row.lastStep?.tool, 'search');
    t.is(row.recentSteps.length, 15);
    t.is(row.recentSteps.filter(s => s.tool).length, 3, 'krok bez narzędzia nie dostaje pola `tool`');
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
    t.true(rows[0].stopRequested);
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

test('szyba: tool.pre niesie konkret z argumentów (path > inne klucze), tool.post rozmiar wyniku', t => {
    const rows = buildStripModel({
        now: TERAZ, tabKey: 'tab-a', agentName: 'Klara',
        tasks: [zTabu('bieg', 'tab-a', {
            status: 'running',
            steps: [
                { at: TERAZ - 5_000, type: 'tool.pre', fields: { tool: 'read', args: '{"scope":"vault","path":"Notatki/plan.md"}' } },
                { at: TERAZ - 4_900, type: 'tool.post', fields: { tool: 'read', status: 'ok', chars: 4222 } },
                { at: TERAZ - 4_000, type: 'tool.pre', fields: { tool: 'search', args: { query: 'smoke tandemowy', limit: 30 } } },
                { at: TERAZ - 3_900, type: 'tool.post', fields: { tool: 'search', status: 'error' } },
                { at: TERAZ - 3_000, type: 'model.done', fields: { i: 2 } },
            ],
        })],
    });
    const steps = rows[0].recentSteps;
    t.is(steps[0].detail, 'Notatki/plan.md');
    t.is(steps[1].detail, '4222 zn.');
    t.is(steps[2].detail, 'smoke tandemowy');
    t.is(steps[3].detail, 'error');
    t.is(steps[4].detail, undefined, 'kroki bez narzędzia nie dostają konkretu');
});

test('szyba: konkret kroku przycięty do 80 znaków; zły JSON = przycięty surowiec', t => {
    const dluga = 'A'.repeat(200);
    const rows = buildStripModel({
        now: TERAZ, tabKey: 'tab-a', agentName: 'Klara',
        tasks: [zTabu('bieg', 'tab-a', {
            status: 'running',
            steps: [
                { at: TERAZ - 2_000, type: 'tool.pre', fields: { tool: 'read', args: `{"path":"${dluga}"}` } },
                { at: TERAZ - 1_000, type: 'tool.pre', fields: { tool: 'search', args: '{krzywy json' } },
            ],
        })],
    });
    const steps = rows[0].recentSteps;
    t.is(steps[0].detail!.length, 81); // 80 + wielokropek
    t.is(steps[1].detail, '{krzywy json');
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
