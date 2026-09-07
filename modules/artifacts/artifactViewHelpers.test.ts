import test from 'ava';
import {
    sortArtifactsForView,
    buildArtifactPickerItems,
    toggleTypeName,
    buildTypeCheckboxRows,
} from './artifactViewHelpers.js';

// ── sortArtifactsForView ──────────────────────────────────────────────

test('sortArtifactsForView: sortuje po zaktualizowano malejąco', t => {
    const list = [
        { id: 'a', tytul: 'A', zaktualizowano: '2026-07-20' },
        { id: 'b', tytul: 'B', zaktualizowano: '2026-07-23' },
        { id: 'c', tytul: 'C', zaktualizowano: '2026-07-21' },
    ];
    const out = sortArtifactsForView(list);
    t.deepEqual(out.map(x => x.id), ['b', 'c', 'a']);
});

test('sortArtifactsForView: fallback na utworzono gdy brak zaktualizowano', t => {
    const list = [
        { id: 'a', tytul: 'A', utworzono: '2026-07-01' },
        { id: 'b', tytul: 'B', zaktualizowano: '2026-07-23' },
    ];
    const out = sortArtifactsForView(list);
    t.deepEqual(out.map(x => x.id), ['b', 'a']);
});

test('sortArtifactsForView: brak daty ląduje na końcu', t => {
    const list = [
        { id: 'nodate', tytul: 'Z' },
        { id: 'dated', tytul: 'A', zaktualizowano: '2026-07-10' },
    ];
    const out = sortArtifactsForView(list);
    t.deepEqual(out.map(x => x.id), ['dated', 'nodate']);
});

test('sortArtifactsForView: tie-break po tytule rosnąco', t => {
    const list = [
        { id: 'x', tytul: 'Zebra', zaktualizowano: '2026-07-23' },
        { id: 'y', tytul: 'Alfa', zaktualizowano: '2026-07-23' },
    ];
    const out = sortArtifactsForView(list);
    t.deepEqual(out.map(x => x.id), ['y', 'x']);
});

test('sortArtifactsForView: nie mutuje wejścia + odporny na nie-tablicę', t => {
    const list = [
        { id: 'a', zaktualizowano: '2026-07-01' },
        { id: 'b', zaktualizowano: '2026-07-05' },
    ];
    const snapshot = JSON.stringify(list);
    sortArtifactsForView(list);
    t.is(JSON.stringify(list), snapshot);
    t.deepEqual(sortArtifactsForView(null), []);
    t.deepEqual(sortArtifactsForView(undefined), []);
});

// ── buildArtifactPickerItems ──────────────────────────────────────────

test('buildArtifactPickerItems: oznacza aktywny + zachowuje sortowanie', t => {
    const list = [
        { id: 'a', tytul: 'A', typ: 'plan', status: 'szkic', zaktualizowano: '2026-07-20' },
        { id: 'b', tytul: 'B', typ: 'plan', status: 'zamkniety', zaktualizowano: '2026-07-23' },
    ];
    const { items, hasActive } = buildArtifactPickerItems(list, 'a');
    t.deepEqual(items.map(i => i.id), ['b', 'a']);
    t.true(hasActive);
    t.false(items.find(i => i.id === 'b')!.active);
    t.true(items.find(i => i.id === 'a')!.active);
});

test('buildArtifactPickerItems: brak aktywnego gdy id spoza listy/null', t => {
    const list = [{ id: 'a', tytul: 'A', zaktualizowano: '2026-07-20' }];
    t.false(buildArtifactPickerItems(list, 'nieistnieje').hasActive);
    t.false(buildArtifactPickerItems(list, null).hasActive);
    t.deepEqual(buildArtifactPickerItems([], 'a'), { items: [], hasActive: false });
});

test('buildArtifactPickerItems: tytuł fallbackuje na id', t => {
    const { items } = buildArtifactPickerItems([{ id: 'art-1', zaktualizowano: '2026-07-20' }]);
    t.is(items[0].tytul, 'art-1');
});

// ── toggleTypeName ────────────────────────────────────────────────────

test('toggleTypeName: dodaje gdy brak', t => {
    t.deepEqual(toggleTypeName(['plan'], 'kanban'), ['plan', 'kanban']);
});

test('toggleTypeName: usuwa gdy jest', t => {
    t.deepEqual(toggleTypeName(['plan', 'kanban'], 'plan'), ['kanban']);
});

test('toggleTypeName: dedupe + nie mutuje + odporny na śmieci', t => {
    const input = ['plan', 'plan', 3, null, 'kanban'];
    const snapshot = JSON.stringify(input);
    const out = toggleTypeName(input, 'notatka');
    t.deepEqual(out, ['plan', 'kanban', 'notatka']);
    t.is(JSON.stringify(input), snapshot);
    t.deepEqual(toggleTypeName(null, ''), []);
});

// ── buildTypeCheckboxRows ─────────────────────────────────────────────

test('buildTypeCheckboxRows: zaznacza podpięte typy', t => {
    const allTypes = [
        { name: 'plan', opis: 'Plan działania', builtin: true },
        { name: 'kanban', description: 'Tablica' },
        { name: 'notatka', opis: 'Notatka' },
    ];
    const rows = buildTypeCheckboxRows(allTypes, ['kanban']);
    t.deepEqual(rows.map(r => r.checked), [false, true, false]);
    t.is(rows[0].builtin, true);
    t.is(rows[1].opis, 'Tablica'); // description fallback
});

test('buildTypeCheckboxRows: puste assigned = nic zaznaczone + odrzuca typy bez nazwy', t => {
    const allTypes = [
        { name: 'plan' },
        { opis: 'bez nazwy' },
        { name: '' },
    ];
    const rows = buildTypeCheckboxRows(allTypes, []);
    t.is(rows.length, 1);
    t.is(rows[0].name, 'plan');
    t.false(rows[0].checked);
});
