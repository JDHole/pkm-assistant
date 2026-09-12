import test from 'ava';
import {
    buildBrainIndex,
    parseNaTerazSections,
    parseForeignSections,
    parseManualIndexLines,
    applyNaTerazOps,
    naTerazSectionKey,
    isNaTerazHeading,
    NA_TERAZ_MAX_ENTRIES,
    INDEX_SECTIONS,
    NOTE_TYPE_TO_SECTION,
} from './BrainIndex.js';

// DLACZEGO: `buildBrainIndex` robi `sections.get(section)!` - sekcja spoza
// INDEX_SECTIONS dałaby cichy TypeError. Ten test zamienia rozjazd stałych w czerwony test.
test('spójność stałych: każda sekcja z NOTE_TYPE_TO_SECTION istnieje w INDEX_SECTIONS', t => {
    for (const [type, section] of Object.entries(NOTE_TYPE_TO_SECTION)) {
        t.true(INDEX_SECTIONS.includes(section), `typ "${type}" wskazuje nieistniejącą sekcję "${section}"`);
    }
});

const noteMeta = (over = {}) => ({
    filename: 'user_jan.md',
    name: 'Jan',
    description: 'Fakt o Janie',
    type: 'user',
    created: '2026-07-23',
    ...over,
});

// ─── „Na teraz" sekcje w indeksie ───

test('buildBrainIndex emituje sekcje „Na teraz" NA GÓRZE, przed indeksem', t => {
    const md = buildBrainIndex({
        agentName: 'Jaskier',
        notes: [noteMeta()],
        naTeraz: { user: ['Jan testuje panel'], environment: ['Vault w trakcie refaktoru'] },
    });
    const userIdx = md.indexOf('## Na teraz: User');
    const envIdx = md.indexOf('## Na teraz: Środowisko');
    const biezaceIdx = md.indexOf('## Bieżące');
    const indexUserIdx = md.indexOf('## User');
    t.true(userIdx > -1 && envIdx > -1);
    t.true(userIdx < biezaceIdx, '„Na teraz" przed indeksem');
    t.true(envIdx < indexUserIdx, '„Na teraz: Środowisko" przed indeksową ## User');
    t.true(md.includes('- Jan testuje panel'));
    t.true(md.includes('- Vault w trakcie refaktoru'));
});

test('pusty naTeraz → BRAK nagłówków „Na teraz" (kompat starego brain.md)', t => {
    const withEmpty = buildBrainIndex({ agentName: 'Jaskier', notes: [noteMeta()], naTeraz: { user: [], environment: [] } });
    const noArg = buildBrainIndex({ agentName: 'Jaskier', notes: [noteMeta()] });
    t.false(withEmpty.includes('Na teraz'));
    t.is(withEmpty, noArg, 'brak naTeraz == pusty naTeraz — identyczny output');
});

test('parse(build(naTeraz)) round-trip zachowuje wpisy', t => {
    const naTeraz = { user: ['A', 'B'], environment: ['C'] };
    const md = buildBrainIndex({ agentName: 'X', notes: [], naTeraz });
    const parsed = parseNaTerazSections(md);
    t.deepEqual(parsed, naTeraz);
});

test('parseNaTerazSections ignoruje sekcje indeksu i linki', t => {
    const md = `# X brain

## Na teraz: User
- Bieżący stan

## User
- [[brain/user_jan.md]] — Fakt

## Bieżące
`;
    t.deepEqual(parseNaTerazSections(md), { user: ['Bieżący stan'], environment: [] });
});

test('isNaTerazHeading / naTerazSectionKey mapują warianty', t => {
    t.true(isNaTerazHeading('## Na teraz: User'));
    t.true(isNaTerazHeading('## na teraz: środowisko'));
    t.false(isNaTerazHeading('## User'));
    t.is(naTerazSectionKey('Na teraz: User'), 'user');
    t.is(naTerazSectionKey('environment'), 'environment');
    t.is(naTerazSectionKey('Środowisko'), 'environment');
    t.is(naTerazSectionKey('nonsense'), null);
});

// ─── applyNaTerazOps (add / update / delete / dedup / trim) ───

test('applyNaTerazOps dodaje wpis + dedupe (case-insensitive)', t => {
    let res = applyNaTerazOps({ user: [], environment: [] }, [{ section: 'user', add: 'Stan X' }]);
    t.deepEqual(res.naTeraz.user, ['Stan X']);
    res = applyNaTerazOps(res.naTeraz, [{ section: 'user', add: 'stan x' }]);
    t.deepEqual(res.naTeraz.user, ['Stan X'], 'duplikat pominięty');
});

test('applyNaTerazOps usuwa wpis (exact + substring)', t => {
    const start = { user: ['Jan pracuje nad panelem', 'Inny wpis'], environment: [] };
    const exact = applyNaTerazOps(start, [{ section: 'user', remove: 'Inny wpis' }]);
    t.deepEqual(exact.naTeraz.user, ['Jan pracuje nad panelem']);
    const sub = applyNaTerazOps(start, [{ section: 'user', remove: 'nad panelem' }]);
    t.deepEqual(sub.naTeraz.user, ['Inny wpis'], 'substring dopasowuje');
});

test('applyNaTerazOps update = remove + add w jednym opie', t => {
    const start = { user: ['Stary stan'], environment: [] };
    const res = applyNaTerazOps(start, [{ section: 'user', remove: 'Stary stan', add: 'Nowy stan' }]);
    t.deepEqual(res.naTeraz.user, ['Nowy stan']);
});

test('applyNaTerazOps trim najstarszych ponad limit + licznik', t => {
    const many = Array.from({ length: NA_TERAZ_MAX_ENTRIES + 3 }, (_, i) => ({ section: 'user', add: `wpis ${i}` }));
    const res = applyNaTerazOps({ user: [], environment: [] }, many);
    t.is(res.naTeraz.user.length, NA_TERAZ_MAX_ENTRIES);
    t.is(res.trimmed, 3);
    t.is(res.naTeraz.user[0], 'wpis 3', 'najstarsze (0,1,2) ucięte z przodu');
    t.is(res.naTeraz.user.at(-1), `wpis ${NA_TERAZ_MAX_ENTRIES + 2}` as string | undefined);
});

test('applyNaTerazOps ignoruje nieznaną sekcję', t => {
    const res = applyNaTerazOps({ user: [], environment: [] }, [{ section: 'bogus', add: 'X' }]);
    t.deepEqual(res.naTeraz, { user: [], environment: [] });
});

// ─── Sekcje spoza katalogu zarządzanych (ręczne, np. „## AKTYWNY TEST") ───

test('parseForeignSections wyciąga ręczną sekcję, pomija zarządzane i „Na teraz"', t => {
    const md = `# X brain

## Na teraz: User
- stan bieżący

## AKTYWNY TEST — F1-F5
- krok 1

### Podsekcja
treść pod H3

## User
- [[brain/user_jan.md]] — Fakt

## Druga ręczna
tekst
`;
    const foreign = parseForeignSections(md);
    t.deepEqual(foreign.map(s => s.heading), ['## AKTYWNY TEST — F1-F5', '## Druga ręczna']);
    t.deepEqual(foreign[0].lines, ['- krok 1', '', '### Podsekcja', 'treść pod H3'], 'body verbatim z H3, bez końcowych pustych');
    t.deepEqual(foreign[1].lines, ['tekst']);
});

test('parseForeignSections na czystym indeksie → pusta lista', t => {
    const md = buildBrainIndex({ agentName: 'X', notes: [noteMeta()], naTeraz: { user: ['A'], environment: [] } });
    t.deepEqual(parseForeignSections(md), []);
    t.deepEqual(parseForeignSections(''), []);
    t.deepEqual(parseForeignSections(null), []);
});

test('buildBrainIndex emituje foreign NA KOŃCU, a round-trip jest stabilny', t => {
    const foreign = [{ heading: '## AKTYWNY TEST', lines: ['- krok 1', '- krok 2'] }];
    const md = buildBrainIndex({ agentName: 'X', notes: [noteMeta()], foreign });
    t.true(md.indexOf('## AKTYWNY TEST') > md.indexOf('## Projekty i referencje'), 'foreign pod indeksem');
    t.true(md.includes('- krok 1'));
    const md2 = buildBrainIndex({ agentName: 'X', notes: [noteMeta()], foreign: parseForeignSections(md) });
    t.is(md2, md, 'parse(build) → build daje identyczny plik');
});

// ─── Ręczne linie WEWNĄTRZ sekcji zarządzanych (bulletу sesji Claude Code w np. „## Bieżące") ───

test('parseManualIndexLines wyciąga ręczne bullety z sekcji zarządzanych, ignoruje linki', t => {
    const md = `# X brain

## Bieżące
- Kuba testuje panel Ram
- Sprint dogrywki walidatora w toku
- [[brain/project_context_dogrywka.md]] — Dogrywka walidatora katalogu

## User

## Preferencje
- Nie pytaj drugi raz o rozstrzygnięte

## Workflow

## Projekty i referencje
`;
    const manual = parseManualIndexLines(md);
    t.deepEqual(manual.get('## Bieżące'), ['- Kuba testuje panel Ram', '- Sprint dogrywki walidatora w toku']);
    t.deepEqual(manual.get('## Preferencje'), ['- Nie pytaj drugi raz o rozstrzygnięte']);
    t.false(manual.has('## User'), 'brak ręcznych linii → brak wpisu dla tej sekcji');
    t.false(manual.has('## Workflow'));
    t.false(manual.has('## Projekty i referencje'));
});

test('parseManualIndexLines na pustej/nieistniejącej treści → pusta mapa', t => {
    t.is(parseManualIndexLines('').size, 0);
    t.is(parseManualIndexLines(null).size, 0);
    t.is(parseManualIndexLines(undefined).size, 0);
});

test('buildBrainIndex emituje ręczne linie PRZED wygenerowanymi linkami, w oryginalnej kolejności', t => {
    const notes = [
        { filename: 'project_context_a.md', name: 'A', description: 'Projekt A', type: 'project_context', created: '2026-09-01' },
        { filename: 'project_context_b.md', name: 'B', description: 'Projekt B', type: 'project_context', created: '2026-09-02' },
    ];
    const manual = new Map([['## Bieżące', ['- Kuba testuje panel Ram', '- Sprint dogrywki walidatora w toku']]]);
    const md = buildBrainIndex({ agentName: 'Jaskier', notes, manual });
    const biezace = md.slice(md.indexOf('## Bieżące'), md.indexOf('## User'));
    t.is(
        biezace,
        '## Bieżące\n'
            + '- Kuba testuje panel Ram\n'
            + '- Sprint dogrywki walidatora w toku\n'
            + '- [[brain/project_context_b.md]] — Projekt B\n'
            + '- [[brain/project_context_a.md]] — Projekt A\n'
            + '\n'
    );
});

test('rebuild(rebuild) z ręcznymi liniami jest idempotentny bajtowo', t => {
    const notes = [
        { filename: 'user_jan.md', name: 'Jan', description: 'Fakt o Janie', type: 'user', created: '2026-05-14' },
    ];
    const before = `# Jaskier brain

## Bieżące
- Kuba testuje panel Ram

## User
- ręczna notatka usera

## Preferencje

## Workflow

## Projekty i referencje
`;
    const once = buildBrainIndex({ agentName: 'Jaskier', notes, manual: parseManualIndexLines(before) });
    const twice = buildBrainIndex({ agentName: 'Jaskier', notes, manual: parseManualIndexLines(once) });
    t.is(twice, once, 'druga przebudowa z tych samych notatek nie zmienia bajtu');
    t.true(once.includes('- Kuba testuje panel Ram'));
    t.true(once.includes('- ręczna notatka usera'));
});

test('index-like linia dopisana ręcznie (np. do usuniętej notatki) jest wycinana, nie zachowywana', t => {
    const before = `# X brain

## Bieżące
- [[brain/project_context_usunieta.md]] - stary, martwy link

## User

## Preferencje

## Workflow

## Projekty i referencje
`;
    const manual = parseManualIndexLines(before);
    t.false(manual.has('## Bieżące'), 'stary link jest index-like → nie ląduje w manualu, będzie regenerowany/zniknie');
});
