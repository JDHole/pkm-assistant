import test from 'ava';
// `translate` (nie `t`) - AVA nazywa swój argument asercji `t`, a `buildMachineView` przyjmuje
// `ctx.t`; dwa różne `t` w tym samym zasięgu (import + parametr callbacku testu) cieniowałyby
// się nawzajem, więc import dostaje inną nazwę.
import { setLocale, t as translate } from '../../../core/i18n/index.js';
import { classifyMachineMessage, buildMachineView } from './machineMessage.js';
import { buildSubTaskNotificationText } from './subTaskNotification.js';
// Deep-import w bebechy `modules/artifacts` jest tu świadomy: `buildSummonMessage` NIE jest w
// barrelu (zero konsumentów spoza modułu poza `summonAgentForArtifact` u siebie - patrz
// `modules/artifacts/index.ts`), a testy są wyjęte spod `no-restricted-imports`.
import { buildSummonMessage } from '../../artifacts/artifactSummon.js';
import { artifactStatusLabel } from '../../artifacts/index.js';
import type { SubTask } from '../../sub-agents/index.js';

setLocale('pl');

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

function thinArtifact() {
    return {
        id: 'art-20260923-abcd',
        tytul: 'Plan porzadkow',
        typ: 'plan',
        status: 'do-akceptacji',
        frontmatter: { 'pkm-artefakt': 'art-20260923-abcd', typ: 'plan', status: 'do-akceptacji' },
        sections: [
            {
                heading: 'Kroki', text: '', items: [
                    { blockId: 'k1', text: 'Zrobić A', checked: true },
                    { blockId: 'k2', text: 'Zrobić B', checked: false },
                ],
            },
        ],
    };
}

// ── classifyMachineMessage: meta na żywo ─────────────────────────────────────

test('classifyMachineMessage: meta na żywo rozstrzyga bez patrzenia na treść', t => {
    t.is(classifyMachineMessage({ role: 'user', content: 'cokolwiek', _subTaskNotification: true }), 'subtask_notification');
    t.is(classifyMachineMessage({ role: 'user', content: 'cokolwiek', _artifactSummon: true }), 'artifact_summon');
});

test('classifyMachineMessage: rola inna niż user nigdy nie klasyfikuje się jako maszynowa', t => {
    t.is(classifyMachineMessage({ role: 'assistant', content: 'x', _subTaskNotification: true }), null);
    t.is(classifyMachineMessage({ role: 'tool', content: 'x', _artifactSummon: true }), null);
});

// ── classifyMachineMessage: fallback po treści (meta nie przeżywa restartu) ──

test('classifyMachineMessage: treść zbudowana PRAWDZIWYM buildSubTaskNotificationText -> subtask_notification', t => {
    const text = buildSubTaskNotificationText(makeTask());
    t.is(classifyMachineMessage({ role: 'user', content: text }), 'subtask_notification');
});

test('classifyMachineMessage: treść zbudowana PRAWDZIWYM buildSummonMessage -> artifact_summon', t => {
    const text = buildSummonMessage(thinArtifact(), 'przywołał Cię do artefaktu');
    t.is(classifyMachineMessage({ role: 'user', content: text }), 'artifact_summon');
});

test('classifyMachineMessage: dwa negatywy dają null (zwykła wiadomość usera nie łapie się)', t => {
    t.is(classifyMachineMessage({ role: 'user', content: 'Artefakt to fajna rzecz' }), null);
    t.is(classifyMachineMessage({ role: 'user', content: '[POWIADOMIENIE] moje własne' }), null);
});

test('classifyMachineMessage: brak treści / meta -> null, nigdy wyjątek', t => {
    t.is(classifyMachineMessage(null), null);
    t.is(classifyMachineMessage(undefined), null);
    t.is(classifyMachineMessage({ role: 'user', content: '' }), null);
    t.is(classifyMachineMessage({ role: 'user', content: null }), null);
});

// ── buildMachineView: subtask_notification ───────────────────────────────────

test('buildMachineView: powiadomienie o sukcesie - details NIE zawiera stopki-instrukcji dla modelu', t => {
    const text = buildSubTaskNotificationText(makeTask());
    const view = buildMachineView({ role: 'user', content: text }, { t: translate });
    t.truthy(view);
    t.is(view!.kind, 'subtask_notification');
    t.is(view!.status, 'ok');
    const footer = translate('chat.subagent_notification.footer');
    t.false(view!.details.includes(footer), 'stopka dla modelu nie ma prawa trafić do widoku usera');
    t.true(view!.title.includes('pkm-sub'), 'nazwa suba wyciągnięta z nagłówka treści');
});

test('buildMachineView: powiadomienie o błędzie - tytuł "padł w tle", status error', t => {
    const task = makeTask({ status: 'error', error: 'limit czasu', result: undefined });
    const text = buildSubTaskNotificationText(task);
    const view = buildMachineView({ role: 'user', content: text }, { t: translate });
    t.truthy(view);
    t.is(view!.status, 'error');
    t.true(view!.title.includes('padł'));
    t.true(view!.details.includes('limit czasu'), 'treść błędu widoczna w details');
});

test('buildMachineView: klasyfikacja przez meta i przez treść dają ten sam widok', t => {
    const text = buildSubTaskNotificationText(makeTask());
    const byMeta = buildMachineView({ role: 'user', content: text, _subTaskNotification: true }, { t: translate });
    const byContent = buildMachineView({ role: 'user', content: text }, { t: translate });
    t.deepEqual(byMeta, byContent);
});

// ── buildMachineView: artifact_summon ────────────────────────────────────────

test('buildMachineView: artefakt z 2 sekcjami - details ma checkboxy po ludzku, bez JSON-a', t => {
    const text = buildSummonMessage(thinArtifact(), 'przywołał Cię do artefaktu');
    const view = buildMachineView({ role: 'user', content: text }, { t: translate });
    t.truthy(view);
    t.is(view!.kind, 'artifact_summon');
    t.true(view!.details.includes('✓ Zrobić A'));
    t.true(view!.details.includes('○ Zrobić B'));
    t.false(view!.details.includes('{'), 'żaden fragment JSON-a nie ma prawa przeciekać do widoku');
});

test('buildMachineView: tytuł artefaktu wyciągnięty z nagłówka, akcja Otwórz niesie id', t => {
    const text = buildSummonMessage(thinArtifact(), 'przywołał Cię do artefaktu');
    const view = buildMachineView({ role: 'user', content: text }, { t: translate });
    t.truthy(view);
    t.true(view!.title.includes('Plan porzadkow'));
    t.deepEqual(view!.open, { label: 'Otwórz', artifactId: 'art-20260923-abcd' });
});

test('buildMachineView: JSON uszkodzony - details bez bloku, bez akcji Otwórz (fail-safe)', t => {
    const text = '📄 Artefakt „Coś" (art-x) - user: test\n\n```json\n{niepoprawny\n```';
    const view = buildMachineView({ role: 'user', content: text }, { t: translate });
    t.truthy(view);
    t.is(view!.kind, 'artifact_summon');
    t.false(view!.details.includes('```'));
    t.is(view!.open, undefined);
});

// ── Uwaga 3 (spec A3-fix): JSON uszkodzony / bez sekcji - details po ludzku, bez id i bez
// frazy akcji dla modelu ────────────────────────────────────────────────────────────────────

test('buildMachineView: JSON uszkodzony - details = SAM tytuł, bez id artefaktu i bez frazy akcji dla modelu', t => {
    const text = '📄 Artefakt „Coś" (art-x) - user: test\n\n```json\n{niepoprawny\n```';
    const view = buildMachineView({ role: 'user', content: text }, { t: translate });
    t.truthy(view);
    t.is(view!.details, 'Coś', 'brak danych poza tytule -> details to SAM tytuł');
    t.false(view!.details.includes('art-x'), 'id artefaktu nie ma prawa trafić do details');
    t.false(view!.details.includes('user:'), 'fraza akcji dla modelu nie ma prawa trafić do details');
});

test('buildMachineView: artefakt bez sekcji (JSON poprawny, sections:[]) - details "{tytul}, {typ}, {status}" po ludzku, bez id', t => {
    const thin = { ...thinArtifact(), sections: [] };
    const text = buildSummonMessage(thin, 'przywołał Cię do artefaktu');
    const view = buildMachineView({ role: 'user', content: text }, { t: translate });
    t.truthy(view);
    t.is(view!.kind, 'artifact_summon');
    const statusLabel = artifactStatusLabel('do-akceptacji');
    t.is(view!.details, `Plan porzadkow, plan, ${statusLabel}`);
    t.false(view!.details.includes(thin.id), 'id artefaktu nie ma prawa trafić do details (dostępny osobno w view.open)');
    t.false(view!.details.includes('user:'), 'fraza akcji dla modelu nie ma prawa trafić do details');
    // `open` NIE zależy od details - id artefaktu jest w JSON-ie, więc akcja "Otwórz" zostaje.
    t.deepEqual(view!.open, { label: 'Otwórz', artifactId: thin.id });
});

// ── Uwaga 1 (spec A3-fix): origin:'human' wygrywa z fallbackiem po treści ───────────────────

test('classifyMachineMessage: origin:"human" na żywo zwraca null, nawet gdy treść zaczyna się od nagłówka maszynowego', t => {
    const subtaskLikeText = translate('chat.subagent_notification.header', { name: 'x', task_id: 'y' }) + ' - co to znaczy?';
    t.is(classifyMachineMessage({ role: 'user', content: subtaskLikeText, origin: 'human' }), null);

    const artifactLikeText = buildSummonMessage(thinArtifact(), 'x') + ' - co poprawić?';
    t.is(classifyMachineMessage({ role: 'user', content: artifactLikeText, origin: 'human' }), null);
});

test('classifyMachineMessage: brak origin (historia) - fallback po treści działa jak dotąd', t => {
    const text = buildSubTaskNotificationText(makeTask());
    t.is(classifyMachineMessage({ role: 'user', content: text }), 'subtask_notification');
});

test('classifyMachineMessage: meta _subTaskNotification wygrywa NIEZALEŻNIE od origin', t => {
    t.is(classifyMachineMessage({ role: 'user', content: 'x', _subTaskNotification: true, origin: 'human' }), 'subtask_notification');
});

// ── B3 (recenzja A3-fix): status wyłącznie z linii stanu, nigdy z treści wyniku ─────────────

test('buildMachineView: sukces z fraza bledu WEWNATRZ tresci wyniku (PL) - kafelek OK, tytul "skonczyl w tle"', t => {
    const task = makeTask({
        result: { text: 'Sprawdziłem log. Poprzednio: Zadanie się nie udało: brak pliku. Teraz naprawione, 3 notatki.', toolsUsed: [], durationMs: 3000, usage: null },
    });
    const text = buildSubTaskNotificationText(task);
    const view = buildMachineView({ role: 'user', content: text }, { t: translate });
    t.truthy(view);
    t.is(view!.status, 'ok', 'fraza bledu w TRESCI wyniku nie ma prawa zmienic statusu na error');
    t.true(view!.title.includes('skończył'), `tytul powinien byc sukcesu, dostalem: "${view!.title}"`);
    t.false(view!.title.includes('padł'));
});

test('buildMachineView: sukces z fraza bledu WEWNATRZ tresci wyniku (EN) - kafelek OK', t => {
    const task = makeTask({
        result: { text: 'Log said: The task failed: timeout. Fixed now.', toolsUsed: [], durationMs: 3000, usage: null },
    });
    const text = buildSubTaskNotificationText(task);
    const view = buildMachineView({ role: 'user', content: text }, { t: translate });
    t.truthy(view);
    t.is(view!.status, 'ok');
});

test('buildMachineView: status:"error" prawdziwy - tytul "padl w tle", status error', t => {
    const task = makeTask({ status: 'error', error: 'limit czasu', result: undefined });
    const text = buildSubTaskNotificationText(task);
    const view = buildMachineView({ role: 'user', content: text }, { t: translate });
    t.truthy(view);
    t.is(view!.status, 'error');
    t.true(view!.title.includes('padł'));
});

test('buildMachineView: status:"aborted" - status error, tytul WLASNY "przerwany", nie "padl"', t => {
    const task = makeTask({ status: 'aborted', result: undefined });
    const text = buildSubTaskNotificationText(task);
    const view = buildMachineView({ role: 'user', content: text }, { t: translate });
    t.truthy(view);
    t.is(view!.status, 'error');
    t.true(view!.title.includes('przerwany'), `tytul aborted powinien byc WLASNY, dostalem: "${view!.title}"`);
    t.false(view!.title.includes('padł'), 'aborted nie dzieli tytulu z error (uwaga 10, spec A3-fix)');
});

// ── Uwaga 2 (spec A3-fix): identyfikator suba jako OSTATNIA linia details ───────────────────

test('buildMachineView: identyfikator suba jest OSTATNIA linia details (fallback po treści)', t => {
    const task = makeTask();
    const text = buildSubTaskNotificationText(task);
    const view = buildMachineView({ role: 'user', content: text }, { t: translate });
    t.truthy(view);
    t.true(view!.details.includes(task.id), 'identyfikator suba musi trafic do details');
    const expectedLastLine = translate('chat.tile.sub.background_id', { id: task.id });
    t.true(view!.details.trimEnd().endsWith(expectedLastLine), `identyfikator musi byc OSTATNIA linia, dostalem: "${view!.details}"`);
});

test('buildMachineView: identyfikator suba trafia do details takze z meta na zywo (msg.subTaskId)', t => {
    const task = makeTask();
    const text = buildSubTaskNotificationText(task);
    const view = buildMachineView({ role: 'user', content: text, _subTaskNotification: true, subTaskId: task.id }, { t: translate });
    t.truthy(view);
    const expectedLastLine = translate('chat.tile.sub.background_id', { id: task.id });
    t.true(view!.details.trimEnd().endsWith(expectedLastLine));
});

// ── Uwaga 8 (spec A3-fix): summary nie dubluje się jako pierwsza linia details ───────────────

test('buildMachineView: details NIE zaczyna się od powtórzonej linii stanu (summary)', t => {
    const text = buildSubTaskNotificationText(makeTask());
    const view = buildMachineView({ role: 'user', content: text }, { t: translate });
    t.truthy(view);
    t.false(view!.details.startsWith(view!.summary), `details nie ma prawa powtarzac summary na starcie, dostalem summary="${view!.summary}" details="${view!.details}"`);
});

test('buildMachineView: kind nierozpoznany -> null', t => {
    t.is(buildMachineView({ role: 'user', content: 'zwykła wiadomość' }, { t: translate }), null);
});
