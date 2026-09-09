/**
 * templateAssignmentOutcome — logika „Użyj u agenta" (idempotencja + „pierwszy sub =
 * domyślny") i reset globalnego suba po kasacji szablonu jest wydzielona z
 * `SubAgentsBackstageTab.ts` właśnie po to, żeby dało się ją przetestować bez DOM.
 *
 * Test czystej decyzji — zero DOM, zero obsidian.
 */
import test from 'ava';
import { computeSubAgentsAfterTemplateUse, computeGlobalSubAfterTemplateDelete } from './templateAssignmentOutcome.js';

test('computeSubAgentsAfterTemplateUse: agent bez subów — nowy sub dostaje default:true', t => {
    const res = computeSubAgentsAfterTemplateUse([], 'klara-zwiadowca');

    t.true(res.changed);
    t.deepEqual(res.subAgents, [{ name: 'klara-zwiadowca', role: 'researcher', default: true }]);
});

test('computeSubAgentsAfterTemplateUse: agent MA już subów — drugi/kolejny sub NIE dostaje default', t => {
    const res = computeSubAgentsAfterTemplateUse(
        [{ name: 'klara-prep', role: 'researcher', default: true }],
        'klara-zwiadowca',
    );

    t.true(res.changed);
    t.deepEqual(res.subAgents, [
        { name: 'klara-prep', role: 'researcher', default: true },
        { name: 'klara-zwiadowca', role: 'researcher' },
    ]);
});

test('computeSubAgentsAfterTemplateUse: sub JUŻ przypisany — idempotencja (brak duplikatu)', t => {
    const existing = [{ name: 'klara-zwiadowca', role: 'researcher', default: true }];

    const res = computeSubAgentsAfterTemplateUse(existing, 'klara-zwiadowca');

    t.false(res.changed, 'drugie kliknięcie „Użyj u agenta" nie może dopisać duplikatu przy zapisie');
    t.is(res.subAgents.length, 1);
});

test('computeSubAgentsAfterTemplateUse: istniejące przypisania NIE są mutowane w miejscu', t => {
    const existing = [{ name: 'klara-prep', role: 'researcher', default: true }];

    const res = computeSubAgentsAfterTemplateUse(existing, 'klara-zwiadowca');

    t.not(res.subAgents, existing, 'wołacz nie może dostać z powrotem tej samej referencji, którą podał');
    t.is(existing.length, 1, 'oryginalna tablica agenta zostaje nietknięta');
});

test('computeGlobalSubAfterTemplateDelete: kasowany szablon BYŁ globalny — reset na pkm-sub', t => {
    const res = computeGlobalSubAfterTemplateDelete(true);

    t.true(res.changed);
    t.is(res.slug, null);
});

test('computeGlobalSubAfterTemplateDelete: kasowany szablon NIE był globalny — bez zmian', t => {
    const res = computeGlobalSubAfterTemplateDelete(false);

    t.false(res.changed, 'wskaźnik nie może się ruszyć, gdy kasowany szablon nie był globalny');
});
