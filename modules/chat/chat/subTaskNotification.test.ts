import test from 'ava';
import { setLocale } from '../../../core/i18n/index.js';
import { buildSubTaskNotificationText, matchTabForOrigin } from './subTaskNotification.js';
import type { SubTask } from '../../sub-agents/index.js';

// Domyślny locale w i18n to 'en'. Asercje niżej celują w PL, więc ustawiamy język jawnie —
// AVA odpala każdy plik testowy w osobnym procesie, więc nie wycieka to do innych testów.
setLocale('pl');

// Minimalny byt biegu — tyle, ile czyta powiadomienie. Reszta pól SubTaska jest tu nieistotna.
function makeTask(over: Partial<SubTask> = {}): SubTask {
    return {
        id: 'sub/pkm-sub#3',
        name: 'pkm-sub',
        agentName: 'Jaskier',
        status: 'done',
        createdAt: 1000,
        endedAt: 4000,
        steps: [],
        budget: {},
        background: true,
        result: { text: 'Znalazłem trzy notatki.', toolsUsed: ['search'], durationMs: 3000, usage: null },
        ...over,
    } as SubTask;
}

// ── buildSubTaskNotificationText ─────────────────────────────────────────────

test('powiadomienie niesie nazwę suba, id zadania, treść wyniku i stopkę-instrukcję', t => {
    const text = buildSubTaskNotificationText(makeTask());
    t.true(text.includes('pkm-sub'), 'nazwa suba');
    t.true(text.includes('sub/pkm-sub#3'), 'id zadania');
    t.true(text.includes('Znalazłem trzy notatki.'), 'treść wyniku');
    t.true(text.includes('Podejmij wątek'), 'stopka każe modelowi kontynuować');
});

test('czas pracy liczony z durationMs (sekundy, jedno miejsce po przecinku)', t => {
    const text = buildSubTaskNotificationText(makeTask({
        result: { text: 'ok', toolsUsed: [], durationMs: 12340, usage: null },
    }));
    t.true(text.includes('12.3 s'));
});

test('bez durationMs czas liczy się z ram czasowych bytu (endedAt - createdAt)', t => {
    const text = buildSubTaskNotificationText(makeTask({
        status: 'error',
        error: 'model padł',
        result: undefined,
        createdAt: 1000,
        endedAt: 3500,
    }));
    t.true(text.includes('2.5 s'));
});

test('brak jakiegokolwiek czasu → linia stanu bez czasu, nie NaN', t => {
    const text = buildSubTaskNotificationText(makeTask({
        status: 'error',
        error: 'padło',
        result: undefined,
        createdAt: undefined as unknown as number,
        endedAt: undefined,
    }));
    t.false(text.includes('NaN'));
    t.false(text.includes('undefined'));
});

test('wynik dłuższy niż sufit jest przycięty + nota o przycięciu', t => {
    const long = 'x'.repeat(500);
    const text = buildSubTaskNotificationText(
        makeTask({ result: { text: long, toolsUsed: [], durationMs: 10, usage: null } }),
        { maxResultChars: 100 },
    );
    t.false(text.includes('x'.repeat(101)), 'treść ucięta do sufitu');
    t.true(text.includes('x'.repeat(100)), 'sufit wykorzystany w całości');
    t.true(text.includes('100'), 'nota mówi, do ilu znaków przycięto');
});

test('wynik krótszy niż sufit zostaje nietknięty (bez noty o przycięciu)', t => {
    const text = buildSubTaskNotificationText(makeTask(), { maxResultChars: 10000 });
    t.true(text.includes('Znalazłem trzy notatki.'));
    t.false(text.includes('przycięty'));
});

test('status done bez treści → uczciwa informacja o pustym wyniku', t => {
    const text = buildSubTaskNotificationText(makeTask({
        result: { text: '   ', toolsUsed: [], durationMs: 5, usage: null },
    }));
    t.true(text.includes('nie zwrócił żadnej treści'));
});

test('status error niesie treść błędu zamiast wyniku', t => {
    const text = buildSubTaskNotificationText(makeTask({
        status: 'error',
        error: 'brak modelu dla roli researcher',
        result: undefined,
    }));
    t.true(text.includes('błąd'), 'stan po ludzku');
    t.true(text.includes('brak modelu dla roli researcher'));
});

test('status aborted (timeout delegacji) też wraca powiadomieniem', t => {
    const text = buildSubTaskNotificationText(makeTask({
        status: 'aborted',
        error: 'timeout',
        result: undefined,
    }));
    t.true(text.includes('przerwane'));
    t.true(text.includes('timeout'));
});

test('błąd bez treści → zastępczy komunikat, nigdy puste miejsce', t => {
    const text = buildSubTaskNotificationText(makeTask({ status: 'error', error: '', result: undefined }));
    t.true(text.includes('nieznany błąd'));
});

// ── matchTabForOrigin ────────────────────────────────────────────────────────

const tabKeyFn = (tab: { sessionId?: string; agentName?: string }) => tab.sessionId || tab.agentName || '';

test('tabKey z originu wygrywa — trafia w konkretną zakładkę, nie w pierwszą agenta', t => {
    const tabs = [
        { agentName: 'Jaskier', sessionId: 'sesja-A' },
        { agentName: 'Jaskier', sessionId: 'sesja-B' },
    ];
    const hit = matchTabForOrigin(tabs, { agentName: 'Jaskier', tabKey: 'sesja-B' }, tabKeyFn);
    t.is(hit?.sessionId, 'sesja-B');
});

test('nieznany tabKey → fallback na pierwszą zakładkę tego agenta', t => {
    const tabs = [
        { agentName: 'Borys', sessionId: 'sesja-D' },
        { agentName: 'Jaskier', sessionId: 'sesja-A' },
    ];
    const hit = matchTabForOrigin(tabs, { agentName: 'Jaskier', tabKey: 'sesja-nieistniejaca' }, tabKeyFn);
    t.is(hit?.sessionId, 'sesja-A');
});

test('origin bez tabKey → dopasowanie po agencie', t => {
    const tabs = [{ agentName: 'Jaskier', sessionId: 'sesja-A' }];
    t.is(matchTabForOrigin(tabs, { agentName: 'Jaskier' }, tabKeyFn)?.sessionId, 'sesja-A');
});

test('agent bez otwartej zakładki → null (wynik czeka w kolejce)', t => {
    const tabs = [{ agentName: 'Borys', sessionId: 'sesja-D' }];
    t.is(matchTabForOrigin(tabs, { agentName: 'Jaskier', tabKey: 'sesja-A' }, tabKeyFn), null);
});

test('brak zakładek / brak originu → null, nigdy wyjątek', t => {
    t.is(matchTabForOrigin([], { agentName: 'Jaskier' }, tabKeyFn), null);
    t.is(matchTabForOrigin(null, { agentName: 'Jaskier' }, tabKeyFn), null);
    t.is(matchTabForOrigin([{ agentName: 'Jaskier' }], null, tabKeyFn), null);
    t.is(matchTabForOrigin([{ agentName: 'Jaskier' }], undefined, tabKeyFn), null);
});

// ─── wynik suba to deliverable - własny sufit, 0 = bez limitu ───

test('maxResultChars 0 = bez limitu - długi wynik przechodzi w całości', t => {
    const dlugi = 'W'.repeat(80_000);
    const text = buildSubTaskNotificationText(makeTask({ result: { text: dlugi, toolsUsed: [], durationMs: 1000, usage: null } }), { maxResultChars: 0 });
    t.true(text.includes(dlugi));
});

test('śmieciowy maxResultChars spada na default subagent_result_max_chars (60k)', t => {
    const dlugi = 'W'.repeat(70_000);
    const text = buildSubTaskNotificationText(makeTask({ result: { text: dlugi, toolsUsed: [], durationMs: 1000, usage: null } }), { maxResultChars: Number.NaN });
    t.false(text.includes(dlugi));
    t.true(text.includes('W'.repeat(60_000)));
});
