import test from 'ava';
import { setLocale, t as tr } from '../../../core/i18n/index.js';
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

test('instrukcja sub_agent jest tylko przy subId i stoi przed stopką', t => {
    for (const locale of ['pl', 'en'] as const) {
        setLocale(locale);
        const task = makeTask();
        const expectedSentence = tr('chat.subagent_notification.reusable_thread', { sub_id: task.threadId || 'sub/pkm-sub' }, locale);
        const withId = buildSubTaskNotificationText(task, { subId: task.threadId || 'sub/pkm-sub' });
        const withoutId = buildSubTaskNotificationText(task);
        const expectedBase = [
            tr('chat.subagent_notification.header', { name: 'pkm-sub', task_id: task.id }, locale),
            tr('chat.subagent_notification.meta_with_time', { status: tr('chat.subagent_notification.status_done', undefined, locale), seconds: '3.0' }, locale),
            'Znalazłem trzy notatki.',
        ];
        t.is(withId, `${expectedBase.join('\n\n')}\n\n${expectedSentence}\n\n\n${tr('chat.subagent_notification.footer', undefined, locale)}`);
        t.is(withoutId, [...expectedBase, tr('chat.subagent_notification.footer', undefined, locale)].join('\n\n'));
        t.true(withId.indexOf(expectedSentence) < withId.indexOf(tr('chat.subagent_notification.footer', undefined, locale)));
        t.false(withoutId.includes(tr('chat.subagent_notification.reusable_thread', { sub_id: '' }, locale)));
    }
    setLocale('pl');
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

test('epoka wymaga zgodności także przy tabKey i wybiera zakładkę tej samej sesji', t => {
    const tabs = [
        { agentName: 'Jaskier', sessionId: 'wrong-epoch', sessionPath: 'active/x.md', sessionEpoch: 'bbbb' },
        { agentName: 'Jaskier', sessionId: 'right-epoch', sessionPath: 'active/x.md', sessionEpoch: 'aaaa' },
    ];
    const origin = { agentName: 'Jaskier', sessionPath: 'active/x.md', sessionEpoch: 'aaaa', tabKey: 'wrong-epoch' };
    const hit = matchTabForOrigin(tabs, origin, tabKeyFn, tab => tab.sessionPath, tab => tab.sessionEpoch);
    t.is(hit?.sessionId, 'right-epoch');
    const staleOnly = [tabs[0]!];
    t.is(matchTabForOrigin(staleOnly, origin, tabKeyFn, tab => tab.sessionPath, tab => tab.sessionEpoch), null);
    t.is(matchTabForOrigin(tabs, { ...origin, sessionPath: undefined }, tabKeyFn, tab => tab.sessionPath, tab => tab.sessionEpoch), null);
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

test('outcome unconfirmed dodaje etykiety, czas, wynik i notę o weryfikacji', t => {
    const outcome = { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] } as const;
    const text = buildSubTaskNotificationText(makeTask({ outcome: outcome as any }));
    t.is(text, [
        tr('chat.subagent_notification.header', { name: 'pkm-sub', task_id: 'sub/pkm-sub#3' }),
        tr('chat.subagent_notification.meta_with_time', { status: `${tr('chat.subagent_notification.end_finished')} · ${tr('chat.subagent_notification.completeness_unconfirmed')}`, seconds: '3.0' }),
        'Znalazłem trzy notatki.',
        tr('chat.subagent_notification.unconfirmed'),
        tr('chat.subagent_notification.footer'),
    ].join('\n\n'));
});

test('outcome wyświetla każdy powód końca i nadawcę zatrzymania przez tłumaczenia', t => {
    const cases = [
        [{ kind: 'finished' }, 'end_finished'],
        [{ kind: 'limit', reason: 'iteration-limit' }, 'end_iteration_limit'],
        [{ kind: 'limit', reason: 'synthesis-budget' }, 'end_synthesis_budget'],
        [{ kind: 'uncertain' }, 'end_uncertain'],
        [{ kind: 'stopped', by: 'user' }, 'end_stopped_user'],
        [{ kind: 'stopped', by: 'lead' }, 'end_stopped_lead'],
        [{ kind: 'stopped', by: 'system' }, 'end_stopped_system'],
        [{ kind: 'timeout' }, 'end_timeout'],
        [{ kind: 'failed', stage: 'work' }, 'end_failed_work'],
        [{ kind: 'failed', stage: 'synthesis' }, 'end_failed_synthesis'],
    ] as const;
    for (const [end, key] of cases) {
        const text = buildSubTaskNotificationText(makeTask({
            outcome: { end, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] } as any,
        }));
        t.true(text.includes(`${tr(`chat.subagent_notification.${key as string}`)} · ${tr('chat.subagent_notification.completeness_empty')}`), key);
    }
});

test('outcome partial raportuje zakaz, przycięty dorobek i cztery stany efektów', t => {
    const effects = ['matches', 'mismatch', 'not-checked', 'unknown'].map((check) => ({ tool: 'write', action: 'create', targets: [{ path: 'notatka.md' }], outcome: check === 'unknown' ? 'unknown' : 'returned', check }));
    const text = buildSubTaskNotificationText(makeTask({ outcome: { end: { kind: 'limit', reason: 'iteration-limit' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects } as any, partial: { text: 'z'.repeat(30), lastText: '' } as any }), { maxResultChars: 10 });
    t.is(text, [
        tr('chat.subagent_notification.header', { name: 'pkm-sub', task_id: 'sub/pkm-sub#3' }),
        tr('chat.subagent_notification.meta_with_time', { status: `${tr('chat.subagent_notification.end_iteration_limit')} · ${tr('chat.subagent_notification.completeness_partial')}`, seconds: '3.0' }),
        tr('chat.subagent_notification.partial'),
        `${'z'.repeat(10)}\n${tr('chat.subagent_notification.truncated', { chars: 10 })}`,
        ...['matches', 'mismatch', 'not_checked', 'unknown'].map(check => tr('chat.subagent_notification.effect', { tool: 'write', target: 'notatka.md', check: tr(`chat.subagent_notification.check_${check}` as never) })),
        tr('chat.subagent_notification.footer'),
    ].join('\n\n'));
});

test('outcome partial używa zachowanego text nawet gdy lastText jest pusty', t => {
    const outcome = { end: { kind: 'limit', reason: 'iteration-limit' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [] } as any;
    const text = buildSubTaskNotificationText(makeTask({ outcome, result: undefined, partial: { text: 'DOROBEK ZE SNAPSHOTU', lastText: '' } as any }));
    t.true(text.includes('DOROBEK ZE SNAPSHOTU'));
    t.false(text.includes(tr('chat.subagent_notification.empty_result')));
});

test('outcome partial spada na result.text, gdy snapshot nie ma dorobku', t => {
    const outcome = { end: { kind: 'timeout' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [] } as any;
    const text = buildSubTaskNotificationText(makeTask({ outcome, partial: { text: '', lastText: 'IGNORUJ' } as any, result: { text: 'DOROBEK Z WYNIKU', toolsUsed: [], durationMs: 3000, usage: null } }));
    t.true(text.includes('DOROBEK Z WYNIKU'));
    t.false(text.includes('IGNORUJ'));
});

test('outcome empty wyjaśnia brak wyniku, a starszy bieg zachowuje dokładną treść', t => {
    const legacy = buildSubTaskNotificationText(makeTask());
    const empty = buildSubTaskNotificationText(makeTask({ outcome: { end: { kind: 'timeout' }, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] } as any }));
    t.is(empty, [
        tr('chat.subagent_notification.header', { name: 'pkm-sub', task_id: 'sub/pkm-sub#3' }),
        tr('chat.subagent_notification.meta_with_time', { status: `${tr('chat.subagent_notification.end_timeout')} · ${tr('chat.subagent_notification.completeness_empty')}`, seconds: '3.0' }),
        tr('chat.subagent_notification.empty', { reason: tr('chat.subagent_notification.end_timeout') }),
        tr('chat.subagent_notification.footer'),
    ].join('\n\n'));
    t.is(legacy, [
        tr('chat.subagent_notification.header', { name: 'pkm-sub', task_id: 'sub/pkm-sub#3' }),
        tr('chat.subagent_notification.meta_with_time', { status: tr('chat.subagent_notification.status_done'), seconds: '3.0' }),
        'Znalazłem trzy notatki.',
        tr('chat.subagent_notification.footer'),
    ].join('\n\n'));
});

test('matchTabForOrigin dopasowuje sesję i nie spada na inną sesję agenta', t => {
    const tabs = [{ agentName: 'Jaskier', sessionPath: '/a', sessionId: 'first' }, { agentName: 'Jaskier', sessionPath: '/b', sessionId: 'second' }];
    t.is(matchTabForOrigin(tabs, { agentName: 'Jaskier', tabKey: 'first', sessionPath: '/b' }, tabKeyFn)?.sessionId, 'first');
    t.is(matchTabForOrigin(tabs, { agentName: 'Jaskier', sessionPath: '/b' }, tabKeyFn)?.sessionId, 'second');
    t.is(matchTabForOrigin(tabs, { agentName: 'Jaskier', sessionPath: '/missing' }, tabKeyFn), null);
    t.is(matchTabForOrigin(tabs, { agentName: 'Jaskier' }, tabKeyFn)?.sessionId, 'first');
});
