/**
 * Strażnicy NAPRAWY migratora v2→v3 — noc audytowa 2026-08-27 (moduł 20, code review CTO)
 * + naprawa 2026-08-28.
 *
 * HISTORIA: ten plik zaczął życie jako CHARAKTERYZUJĄCY audyt. Nika przysłał 2026-08-27 brief
 * „4 bugi mechanizmów pamięci" (`10_Agenci/Kustosz/_Dla_Agenta/2026-08-27_Brief_Nika_Bugi_Mechanizmow_Pamieci.md`)
 * z OBJAWAMI z vaulta załogi — m.in. „migrator tnie zdania na pół", „name urwane w pół słowa",
 * „sekcja `## Ustalenia` wycięta z brain.md". Pierwsza wersja tego pliku miała testy ZIELONE,
 * które opisywały to, co kod robił WTEDY (błędnie), plus jeden `test.failing` jako PIN kontraktu
 * „każda sekcja starego braina jest w planie policzona".
 *
 * 2026-08-28: naprawa w `MigrationV3.ts` domknęła wszystkie cztery wady:
 *   1. `buildPlan` gubiło sekcje niepasujące do żadnej gałęzi — teraz KAŻDA sekcja ląduje
 *      w notes, `keepInBrain` albo `deletedSections`.
 *   2. `_notesFromSection` cięła akapit na pojedyncze linie — teraz grupuje w bloki
 *      (akapit/bullet), jedna notatka na blok.
 *   3. `keepInBrain` było zadeklarowane i nigdy niewypełniane — teraz `applyPlan` odtwarza
 *      zachowane sekcje z `originalBrain` i przekazuje je do `buildBrainIndex` jako `foreign`.
 *   4. `needsMigration()`/`run()` brały własny format v3 (bez folderu `brain/`) za pamięć v2 —
 *      teraz doczytują treść i rozpoznają indeks v3 (`looksLikeV3Index`), migracja jest wtedy
 *      pominięta w całości (`skipped: true, reason: 'already_v3_format'`).
 *
 * Ten plik jest teraz STRAŻNIKIEM NAPRAWY — testy asertują NOWE, poprawne zachowanie.
 * `test.failing` PIN spełniony i odwrócony na zwykły, zielony `test` (patrz test 5 niżej).
 *
 * Atrapa vaulta skopiowana 1:1 z `MigrationV3.test.ts` (ten sam moduł, ten sam kontrakt adaptera).
 *
 * RUNDA 2 (2026-08-28): drugi adwersaryjny przebieg (opus) znalazł blokera w korroboracji
 * `looksLikeV3Index` (Z1) i sześć dalszych dziur (Z2, Z3, Z4, Z6, Z7a/b, Z8). Testy P1-P9
 * niżej dopisane albo odwrócone wg werdyktu lidera po tej weryfikacji.
 */

import test from 'ava';
import { AgentMemory } from './AgentMemory.js';
import { MigrationV3 } from './MigrationV3.js';
import type { MigrationAgentMemoryLike } from './MigrationV3.js';

type MemoryUnderTest = AgentMemory & MigrationAgentMemoryLike;
const asMemory = (m: AgentMemory): MemoryUnderTest => m as unknown as MemoryUnderTest;

function makeVault(initialFiles: Record<string, string> = {}, initialFolders: string[] = []) {
    const files: Record<string, string> = { ...initialFiles };
    const folders = new Set<string>(initialFolders);

    const parentFoldersFor = (path: string): string[] => {
        const parts = path.split('/');
        const result: string[] = [];
        for (let i = 1; i < parts.length; i++) result.push(parts.slice(0, i).join('/'));
        return result;
    };

    for (const path of Object.keys(files)) {
        for (const folder of parentFoldersFor(path)) folders.add(folder);
    }

    return {
        files,
        folders,
        vault: {
            adapter: {
                async exists(path: string) {
                    return Object.prototype.hasOwnProperty.call(files, path) || folders.has(path);
                },
                async mkdir(path: string) {
                    folders.add(path);
                },
                async read(path: string) {
                    if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error(`missing: ${path}`);
                    return files[path];
                },
                async write(path: string, content: string) {
                    for (const folder of parentFoldersFor(path)) folders.add(folder);
                    files[path] = content;
                },
                async remove(path: string) {
                    delete files[path];
                },
                async list(folder: string) {
                    const prefix = `${folder}/`;
                    return {
                        files: Object.keys(files).filter(path => path.startsWith(prefix)),
                        folders: [...folders].filter(path => path.startsWith(prefix) && path !== folder),
                    };
                },
            },
        },
    };
}

const BRAIN = '.pkm-assistant/agents/tester/memory/brain.md';

const newMigration = (brainContent: string) => {
    const built = makeVault({ [BRAIN]: brainContent });
    const memory = asMemory(new AgentMemory(built.vault, 'Tester'));
    return { ...built, migration: new MigrationV3(memory) };
};

/**
 * Naprawa znalezisko #2: akapit zawinięty na kilka linii (hard-wrap każdego edytora markdown)
 * jest teraz JEDNĄ jednostką migracji, nie jedną notatką na linię.
 */
test('buildPlan: akapit zawinięty na 3 linie = JEDNA notatka, treść sklejona spacjami', t => {
    const brain = [
        '## Ustalenia',
        'Konto firmowe prowadzimy w ING, bo tam siedzi cała historia przelewów',
        'z ostatnich czterech lat i nikt nie chce jej przepisywać ręcznie do',
        'innego banku tylko po to, żeby oszczędzić dziesięć złotych miesięcznie.',
        '',
    ].join('\n');
    const { migration } = newMigration(brain);

    const plan = migration.buildPlan(brain);

    t.is(plan.notes.length, 1, 'akapit to JEDNA jednostka migracji, nie trzy linie');
    t.false(plan.notes[0].content.includes('\n'), 'treść notatki jest sklejona spacjami, bez złamań linii');
    t.true(plan.notes[0].content.startsWith('Konto firmowe prowadzimy w ING'), 'notatka niesie początek myśli');
    t.true(plan.notes[0].content.endsWith('miesięcznie.'), 'notatka niesie koniec myśli');
});

/**
 * Lista bulletów: pojedyncze bullety NADAL dają jedną notatkę na bullet (bez regresji), ale
 * bullet zawinięty na kolejną linię (kontynuacja, bez własnego `-`) dokleja się do tej samej
 * notatki zamiast urywać zdanie w pół.
 */
test('buildPlan: bullet zawinięty na 2 linie zostaje JEDNĄ notatką z pełną treścią', t => {
    const brain = [
        '## Ustalenia',
        '- Konto firmowe zawsze w ING.',
        '- Backupy robimy co tydzień, w niedzielę wieczorem, na dwa',
        'niezależne dyski, żeby awaria jednego nie kosztowała danych.',
        '',
    ].join('\n');
    const { migration } = newMigration(brain);

    const plan = migration.buildPlan(brain);

    t.is(plan.notes.length, 2, 'dwa bullety = dwie notatki, mimo że drugi jest zawinięty na dwie linie');
    t.is(plan.notes[0].content, 'Konto firmowe zawsze w ING.');
    t.true(
        plan.notes[1].content.includes('niezależne dyski, żeby awaria jednego nie kosztowała danych.'),
        'druga notatka niesie kontynuację zawiniętej linii, nie tylko jej pierwszy fragment'
    );
});

/**
 * Naprawa znalezisko #2 (druga połowa objawu Niki — „name urwane w pół słowa"): `shortName`
 * nadal bierze pierwsze 6 słów, ale teraz z CAŁEJ sklejonej myśli (`flat`), nie z fragmentu
 * pojedynczej linii — więc `name` jest dosłownym prefiksem `content`.
 */
test('buildPlan: nazwa notatki to pierwsze 6 słów CAŁEJ myśli, nie fragmentu jednej linii', t => {
    const brain = [
        '## Ustalenia',
        'Konto firmowe prowadzimy w ING, bo tam siedzi cała historia przelewów',
        'z ostatnich czterech lat i nikt nie chce jej przepisywać ręcznie do',
        'innego banku tylko po to, żeby oszczędzić dziesięć złotych miesięcznie.',
    ].join('\n');
    const { migration } = newMigration(brain);

    const plan = migration.buildPlan(brain);

    t.is(plan.notes.length, 1);
    const { name, content } = plan.notes[0];
    t.is(name.split(/\s+/).length, 6, 'dokładnie 6 słów');
    t.true(content.startsWith(name), 'name jest dosłownym prefiksem sklejonej treści (flat)');
});

/**
 * Naprawa znalezisko #1 (podstawowe): sekcja spoza trzech znanych gałęzi (np. ręcznie dopisana
 * `## AKTYWNY TEST`, kontrakt trybu testowego CC↔plugin) NIE znika już bez śladu — trafia do
 * `plan.keepInBrain`, nie staje się notatką i nie jest zgłoszona do skasowania.
 */
test('buildPlan: sekcja nierozpoznana z treścią trafia do keepInBrain, nie znika i nie staje się notatką', t => {
    const brain = [
        '## User',
        'Kuba pracuje wieczorami.',
        '',
        '## AKTYWNY TEST',
        'Tryb testowy: Kustosz czeka na wynik.',
    ].join('\n');
    const { migration } = newMigration(brain);

    const plan = migration.buildPlan(brain);

    t.true(plan.keepInBrain.includes('AKTYWNY TEST'), 'tytuł sekcji trafia do keepInBrain');
    t.false(plan.deletedSections.includes('AKTYWNY TEST'), 'nie jest jednocześnie zgłoszona do skasowania');
    t.false(
        plan.notes.some(n => n.content.includes('Kustosz czeka na wynik')),
        'treść sekcji obcej NIE staje się notatką — zostaje w brain.md verbatim'
    );
});

/**
 * PIN z dawnego `test.failing`, teraz spełniony i odwrócony: KAŻDA sekcja starego braina jest
 * w planie policzona — notatka, `keepInBrain` albo `deletedSections`. Cztery sekcje, cztery
 * różne losy, żadna nie wyparowuje.
 */
test('buildPlan: KAŻDA sekcja jest policzona w planie — notes ∪ keepInBrain ∪ deletedSections', t => {
    const brain = [
        '## User',
        'Kuba pracuje wieczorami.',
        '',
        '## Notatki luźne',
        'Coś, czego migrator nie rozpoznaje, ale co ma treść.',
        '',
        '## System',
        '- agora project hub',
        '',
        '## Pusta',
        '',
    ].join('\n');
    const { migration } = newMigration(brain);

    const plan = migration.buildPlan(brain);

    t.true(plan.notes.some(n => n.content.includes('Kuba pracuje wieczorami.')), 'User -> notatka (rozpoznana)');
    t.true(plan.keepInBrain.includes('Notatki luźne'), 'Notatki luźne (nierozpoznana, z treścią) -> keepInBrain');
    t.true(plan.deletedSections.includes('System'), 'System (zombie) -> deletedSections');
    t.true(plan.deletedSections.includes('Pusta'), 'Pusta (nierozpoznana, bez treści) -> deletedSections');

    for (const tytul of ['Notatki luźne', 'System', 'Pusta']) {
        const wKeep = plan.keepInBrain.includes(tytul);
        const wDeleted = plan.deletedSections.includes(tytul);
        t.true(wKeep || wDeleted, `${tytul} musi być policzony w planie — ani jedno, ani drugie by znaczyło, że zniknął`);
    }
});

/**
 * `run()` end-to-end: sekcja obca przeżywa w nowym brain.md verbatim, pod indeksem (ten sam
 * mechanizm co incydent 2026-08-15 z `## AKTYWNY TEST` — `BrainIndex.buildBrainIndex({foreign})`).
 */
test('run({interactive:false}): sekcja nierozpoznana przeżywa w nowym brain.md verbatim, pod indeksem', async t => {
    const brain = [
        '## User',
        'Kuba pracuje wieczorami.',
        '',
        '## AKTYWNY TEST',
        'Tryb testowy: Kustosz czeka na wynik.',
    ].join('\n');
    const { migration, files } = newMigration(brain);

    await migration.run({ interactive: false });

    const nowy = files[BRAIN];
    t.true(nowy.includes('## AKTYWNY TEST'), 'nagłówek sekcji obcej przeżywa');
    t.true(nowy.includes('Tryb testowy: Kustosz czeka na wynik.'), 'treść sekcji obcej przeżywa verbatim');
    t.true(nowy.includes('## User'), 'indeks nadal ma swoje nagłówki');
    t.true(
        nowy.indexOf('## AKTYWNY TEST') > nowy.indexOf('## User'),
        'sekcja obca ląduje POD indeksem, nie przed nim'
    );
});

/**
 * `SECTION_TYPES` dostał `workflow` i `projekty i referencje` — te same nagłówki, którymi
 * `BrainIndex` kończy migrację (kontrakt round-trip). Sekcja o takim tytule w STARYM v2 brainie
 * (np. user ręcznie nazwał ją tak samo) staje się notatką odpowiedniego typu, nie `keepInBrain`
 * — verbatim sekcja pod nagłówkiem kolidującym z `INDEX_SECTIONS` zostałaby zjedzona przy
 * najbliższym rebuildzie indeksu.
 */
test('buildPlan: `## Workflow` i `## Projekty i referencje` w starym brainie stają się notatkami, nie keepInBrain', t => {
    const brain = [
        '## Workflow',
        'Rano przegląd skrzynki, wieczorem podsumowanie dnia.',
        '',
        '## Projekty i referencje',
        'Strona tripu do Tajlandii, do zamknięcia po powrocie.',
    ].join('\n');
    const { migration } = newMigration(brain);

    const plan = migration.buildPlan(brain);

    t.true(
        plan.notes.some(n => n.type === 'skill_hint' && n.content.includes('przegląd skrzynki')),
        'Workflow -> notatka typu skill_hint'
    );
    t.true(
        plan.notes.some(n => n.type === 'reference' && n.content.includes('Strona tripu do Tajlandii')),
        'Projekty i referencje -> notatka typu reference'
    );
    t.false(plan.keepInBrain.includes('Workflow'));
    t.false(plan.keepInBrain.includes('Projekty i referencje'));
});

/**
 * T1(a) — runda 2 (BLOKER Z1): niekanoniczny wikilink (bez typu notatki i bez `.md`) NIE jest
 * dowodem v3. Sam v1 sygnał (przed naprawą) łapał KAŻDY `- [[brain/...`, więc taki bullet w
 * zwykłym v2 brainie fałszywie wygaszał migrację. Po naprawie: needsMigration TRUE, `run()`
 * robi normalną migrację z notatkami (nie skip).
 */
test('needsMigration + run: niekanoniczny wikilink `- [[brain/mapa_projektu]]` NIE jest dowodem v3', async t => {
    const brain = [
        '## User',
        '- Kuba lubi krotkie raporty.',
        '- [[brain/mapa_projektu]]',
    ].join('\n');
    const { migration, files } = newMigration(brain);

    t.true(await migration.needsMigration(), 'niekanoniczny wikilink (bez typu i bez .md) nie jest sygnalem v3');

    const result = await migration.run({ interactive: false });

    t.true(result.migrated === true, 'run robi normalna migracje, nie skip');
    t.true(
        Object.keys(files).some(p => p.endsWith('/brain/user_kuba_lubi_krotkie_raporty.md')),
        'notatka z pierwszego bulletu powstaje - migracja przebiegla normalnie'
    );
});

/**
 * T1(b) — runda 2 (BLOKER Z1): ręczny nagłówek „## Na teraz" BEZ korroboracji (mniej niż dwa
 * nagłówki `INDEX_SECTIONS` obecne jako dokładne linie) nie jest dowodem v3. Tu jest tylko
 * `## User` (jeden nagłówek indeksu) — za mało.
 */
test('needsMigration: reczny naglowek "## Na teraz" bez v3-only naglowkow (< 2 INDEX_SECTIONS) NIE jest dowodem v3', async t => {
    const brain = [
        '## Na teraz',
        'Kuba pracuje nad migratorem.',
        '',
        '## User',
        '- Notatka usera.',
    ].join('\n');
    const { migration } = newMigration(brain);

    t.true(await migration.needsMigration(), 'samo "## Na teraz" plus jeden naglowek INDEX_SECTIONS to za malo korroboracji');
});

/**
 * T1(c) — runda 2 (P2/Z1b): prawdziwy v3 (wpis `[[brain/project_context_x.md]]`, kanoniczny)
 * → needsMigration FALSE, a `run()` teraz robi backup NAWET na tej ścieżce skip — brain.md sam
 * nie jest przepisywany przez migrator, ale `ensureMemoryStructure()` woła `getBrain()`, który
 * może dokleić brakujące nagłówki indeksu. Backup daje odwrót, gdyby heurystyka się myliła.
 */
test('needsMigration + run: brain.md już w formacie v3 (bez folderu brain/) NIE jest migrowany', async t => {
    // Wszystkie 5 nagłówków `INDEX_SECTIONS` obecne (nawet puste) — `ensureMemoryStructure()`
    // (wołane w gałęzi C) w środku czyta brain przez `getBrain()`, które „łaskawie" dopisuje
    // brakujące nagłówki indeksu. Test na „bajt w bajt nietknięty" musi startować z pliku, który
    // już ma je wszystkie, inaczej łapie TĘ mutację, nie mutację migratora.
    const brainV3 = [
        '# Tester brain',
        '',
        '## Na teraz: User',
        '- coś aktualnego',
        '',
        '## Bieżące',
        '- [[brain/project_context_cos.md]] — projekt w toku',
        '',
        '## User',
        '- [[brain/user_kuba.md]] — Kuba pracuje wieczorami.',
        '',
        '## Preferencje',
        '',
        '## Workflow',
        '',
        '## Projekty i referencje',
        '',
    ].join('\n');
    const { migration, files, folders } = newMigration(brainV3);

    t.false(await migration.needsMigration(), 'wpis [[brain/...]] rozpoznany jako format v3');

    const result = await migration.run({ interactive: false });

    t.true(result.skipped === true);
    t.is(result.reason, 'already_v3_format');
    t.is(files[BRAIN], brainV3, 'brain.md zostaje BAJT W BAJT nietknięty');
    // Runda 2 (P2/Z1b, odwrócone): skip na ścieżce already_v3_format teraz TWORZY backup —
    // dawna asercja "backup NIE powstaje" opisywała wadę (Z1b), nie kontrakt.
    t.truthy(result.backupPath, 'skip na sciezce already_v3_format niesie backupPath');
    t.true(
        Object.keys(files).some(p => p.includes('memory.v2.backup') && p.endsWith('/brain.md')),
        'backup POWSTAJE - kopia brain.md w memory.v2.backup'
    );
    t.is(
        files[`${result.backupPath}/brain.md`], brainV3,
        'kopia w backupie jest identyczna z oryginalnym brain.md'
    );
    t.true(folders.has('.pkm-assistant/agents/tester/memory/brain'), 'folder brain/ powstaje (ensureMemoryStructure)');
});

/**
 * Świadome, udokumentowane ograniczenie `looksLikeV3Index`: brain zbudowany WYŁĄCZNIE z gołego
 * tekstu (żadna notatka jeszcze nie powstała, żadna sekcja „Na teraz" nietknięta) jest
 * nieodróżnialny od pamięci v2 po samej treści. `needsMigration()` zostaje `true` — bezpieczne,
 * bo `buildPlan` poprawnie rozpozna `## User` i zrobi z niego zwykłą notatkę.
 */
test('needsMigration: brain z samym gołym tekstem (bez wikilinków) nadal wygląda jak v2 — świadome ograniczenie', async t => {
    const { migration } = newMigration('## User\nKuba.');

    t.true(await migration.needsMigration());
});

/**
 * ROUND-TRIP domknięty (dawne najostrzejsze znalezisko nocy): pełny brain.md w formacie v3,
 * z sekcjami `## Workflow`/`## Projekty i referencje` niosącymi wikilinki, w ogóle nie trafia
 * do `buildPlan` — `run()` rozpoznaje format v3 i pomija migrację całkowicie. Nic nie ginie,
 * bo nic nie jest ruszane.
 */
test('ROUND-TRIP domknięty: pełny brain.md w formacie v3 NIE jest w ogóle migrowany — nic nie ginie', async t => {
    // Wszystkie 5 nagłówków `INDEX_SECTIONS` obecne — patrz komentarz w teście wyżej o
    // `getBrain()` dopisującym brakujące nagłówki wewnątrz `ensureMemoryStructure()`.
    const brainV3 = [
        '# Tester brain',
        '',
        '## Bieżące',
        '- [[brain/project_context_cos.md]] — projekt w toku',
        '',
        '## User',
        '- [[brain/user_kuba.md]] — Kuba pracuje wieczorami.',
        '',
        '## Preferencje',
        '',
        '## Workflow',
        '- [[brain/skill_hint_rytm_dnia.md]] — rano skrzynka, wieczorem podsumowanie',
        '',
        '## Projekty i referencje',
        '- [[brain/project_context_tajlandia.md]] — strona tripu',
        '',
    ].join('\n');
    const { migration, files } = newMigration(brainV3);

    const result = await migration.run({ interactive: false });

    // Runda 2 (P2/Z1b, odwrócone): skip teraz niesie backupPath — deepEqual rozszerzony,
    // reszta kontraktu (plik nietknięty) bez zmian.
    t.true(result.skipped === true);
    t.is(result.reason, 'already_v3_format');
    t.truthy(result.backupPath);
    t.is(files[BRAIN], brainV3, 'nic nie ginie — plik jest nietknięty, migrator nie ruszył ani jednej sekcji');
});

/**
 * T2 (P4/Z2): treść PRZED pierwszym `##` (poza samym H1) liczy się do planu. Runda 1 ją
 * po cichu wyrzucała ("sentinel Preamble" + goły `continue`) — teraz staje się notatką
 * `reference`, obok normalnej notatki z `## User`.
 */
test('buildPlan: akapit wstępu PRZED pierwszym ## (poza H1) trafia do planu jako notatka reference', t => {
    const brain = [
        '# Tester brain',
        '',
        'To jest wstep opisujacy agenta, napisany przez usera pod automatycznym H1.',
        '',
        '## User',
        'Kuba pracuje wieczorami.',
    ].join('\n');
    const { migration } = newMigration(brain);

    const plan = migration.buildPlan(brain);

    t.true(
        plan.notes.some(n => n.type === 'reference' && n.content.includes('To jest wstep opisujacy agenta')),
        'wstep przed H1 staje sie notatka reference'
    );
    t.true(
        plan.notes.some(n => n.type === 'user' && n.content.includes('Kuba pracuje wieczorami.')),
        'notatka z ## User nadal powstaje'
    );
    t.false(
        plan.notes.some(n => n.content.includes('# Tester brain')),
        'sam naglowek H1 nie jest tresc — nie wchodzi do zadnej notatki'
    );
});

/**
 * T3 (P3/Z8): realna, ręcznie dopisana sekcja `## Preamble` (NIE sentinel — to zwykła sekcja H2
 * o takim tytule) trafia do `keepInBrain` jak każda inna nierozpoznana sekcja z treścią. Przed
 * naprawą P3 literał 'Preamble' kolidował z sentinelem bucketa treści przed pierwszym `##`.
 */
test('buildPlan: reczna sekcja "## Preamble" (nie sentinel) trafia do keepInBrain', t => {
    // Sekcja rozpoznana (`## User`) obok, żeby `notes.length` nie spadło do zera i nie
    // uruchomiła się NIEZWIĄZANA ścieżka „Legacy brain dump" (P8) — testujemy TYLKO los
    // sekcji `## Preamble`, ten sam wzorzec co test „AKTYWNY TEST" wyżej w tym pliku.
    const brain = [
        '## User',
        'Kuba pracuje wieczorami.',
        '',
        '## Preamble',
        'To jest reczna sekcja usera o tytule Preamble, nie automatyczny wstep przed H1.',
    ].join('\n');
    const { migration } = newMigration(brain);

    const plan = migration.buildPlan(brain);

    t.true(plan.keepInBrain.includes('Preamble'), 'realna sekcja "## Preamble" idzie do keepInBrain');
    t.false(plan.deletedSections.includes('Preamble'), 'nie jest jednoczesnie zgloszona do skasowania');
    t.false(plan.notes.some(n => n.content.includes('reczna sekcja usera')), 'tresc sekcji Preamble nie staje sie notatka');
});

/**
 * T4 (P5/Z3): dwa akapity o identycznych pierwszych 6 słowach dają identyczny `makeMemoryNoteFilename`.
 * Runda 1 druga notatkę po cichu porzucała (`continue` na kolizji) — teraz dostaje sufiks `_2`
 * i ZOSTAJE w planie, obie treści są obecne.
 */
test('buildPlan: kolizja nazwy dwoch notatek daje sufiks _2, obie tresci zostaja w planie', t => {
    const brain = [
        '## Ustalenia',
        'Kupujemy nowy laptop dla zespolu w tym miesiacu, bo stary sie psuje.',
        '',
        'Kupujemy nowy laptop dla zespolu w przyszlym tygodniu, bo poprzedni sie zepsul.',
    ].join('\n');
    const { migration } = newMigration(brain);

    const plan = migration.buildPlan(brain);

    t.is(plan.notes.length, 2, 'oba akapity zostaja jako DWIE notatki, zadna nie znika');
    const filenames = plan.notes.map(n => n.filename);
    t.true(filenames.some(f => f?.endsWith('_2.md')), 'druga notatka dostaje sufiks _2 w filename');
    t.not(filenames[0], filenames[1], 'filenames sa rozne mimo identycznych pierwszych 6 slow');
    t.true(plan.notes.some(n => n.content.includes('w tym miesiacu, bo stary sie psuje.')));
    t.true(plan.notes.some(n => n.content.includes('w przyszlym tygodniu, bo poprzedni sie zepsul.')));
});

/**
 * T5(a) (P6/Z4): bullet-rodzic + dwa WCIĘTE sub-bullety = JEDNA notatka niosąca rodzica
 * i oboje dzieci — sub-bullet to kontekst rodzica, nie osobna myśl.
 */
test('buildPlan: bullet-rodzic + dwa wciete sub-bullety = JEDNA notatka z rodzicem i dziecmi', t => {
    const brain = [
        '## Ustalenia',
        '- Rodzic bullet o backupach.',
        '  - Dziecko pierwsze: dysk A.',
        '  - Dziecko drugie: dysk B.',
    ].join('\n');
    const { migration } = newMigration(brain);

    const plan = migration.buildPlan(brain);

    t.is(plan.notes.length, 1, 'rodzic + dwa wciete sub-bullety to JEDNA jednostka migracji');
    t.true(plan.notes[0].content.includes('Rodzic bullet o backupach.'));
    t.true(plan.notes[0].content.includes('Dziecko pierwsze: dysk A.'));
    t.true(plan.notes[0].content.includes('Dziecko drugie: dysk B.'));
});

/**
 * T5(b) (P6/Z4): nagłówek `###`-`######` wewnątrz sekcji domyka bieżący blok i jego tekst
 * staje się PREFIXEM następnego bloku (`"<prefix>: <flat>"`). Sam nagłówek NIE tworzy własnej,
 * pustej notatki.
 */
test('buildPlan: podnaglowek `### Finanse` + tresc daje notatke z flat "Finanse: ..." i zadnej notatki-samego-naglowka', t => {
    const brain = [
        '## Ustalenia',
        '### Finanse',
        '',
        'Konto w ING.',
    ].join('\n');
    const { migration } = newMigration(brain);

    const plan = migration.buildPlan(brain);

    t.is(plan.notes.length, 1, 'podnaglowek + jedna tresc = JEDNA notatka, nie dwie');
    t.is(plan.notes[0].content, 'Finanse: Konto w ING.');
});

/**
 * T5(c) (P6/Z4): pozioma kreska `---` między dwoma akapitami działa jak separator (jak pusta
 * linia) — nie tworzy z niej własnej notatki, a dwa akapity zostają dwiema OSOBNYMI notatkami.
 */
test('buildPlan: pozioma kreska --- miedzy akapitami nie tworzy wlasnej notatki', t => {
    const brain = [
        '## Ustalenia',
        'Akapit pierwszy o urlopie.',
        '',
        '---',
        '',
        'Akapit drugi o budzecie.',
    ].join('\n');
    const { migration } = newMigration(brain);

    const plan = migration.buildPlan(brain);

    t.is(plan.notes.length, 2, 'dwa akapity, ZERO notatek z samej kreski');
    t.false(plan.notes.some(n => n.content === '---' || n.content.includes('---')), 'kreska nie wchodzi do tresci zadnej notatki');
    t.true(plan.notes.some(n => n.content.includes('Akapit pierwszy o urlopie.')));
    t.true(plan.notes.some(n => n.content.includes('Akapit drugi o budzecie.')));
});

/**
 * T6 (P7/Z7a): sekcja ROZPOZNANA (`## User`), ale BEZ treści, obok innej sekcji z treścią.
 * Runda 1 taką sekcję gubiła bez śladu (zero bloków = zero notatek = nic w żadnej liście).
 * Teraz jest policzona jako `deletedSections`.
 */
test('buildPlan: pusta rozpoznana sekcja "## User" (obok sekcji z trescia) trafia do deletedSections', t => {
    const brain = [
        '## User',
        '',
        '## Preferencje',
        '- Odpowiadaj krotko.',
    ].join('\n');
    const { migration } = newMigration(brain);

    const plan = migration.buildPlan(brain);

    t.true(plan.deletedSections.includes('User'), 'pusta rozpoznana sekcja trafia do deletedSections');
    t.false(plan.notes.some(n => n.type === 'user'), 'zero notatek typu user - sekcja byla pusta');
    t.true(plan.notes.some(n => n.type === 'agent_rule'), 'sekcja z trescia (Preferencje) nadal daje notatke');
});

/**
 * T7 (P8/Z7b): pusty szkielet wszystkich 5 nagłówków `INDEX_SECTIONS` (bez wikilinków, bez
 * ręcznego "Na teraz") wciąż wygląda jak v2 (świadome ograniczenie `looksLikeV3Index`) —
 * needsMigration TRUE. Ale `run()` na takim pliku NIE tworzy ANI JEDNEJ notatki (w tym brak
 * `reference_legacy_brain_dump.md` — sam szkielet nagłówków to nie treść), a nowy brain.md
 * to świeży, pusty indeks.
 */
test('run: pusty szkielet 5 naglowkow INDEX_SECTIONS -> needsMigration TRUE, ZERO notatek, brak dumpu', async t => {
    const brain = [
        '# Tester brain',
        '',
        '## Bieżące',
        '',
        '## User',
        '',
        '## Preferencje',
        '',
        '## Workflow',
        '',
        '## Projekty i referencje',
        '',
    ].join('\n');
    const { migration, files } = newMigration(brain);

    t.true(await migration.needsMigration(), 'szkielet samych naglowkow bez wikilinkow/Na teraz nadal wyglada jak v2');

    const result = await migration.run({ interactive: false });

    t.true(result.migrated === true, 'run robi migracje (nie skip), bo needsMigration bylo true');
    t.deepEqual(result.notesCreated, [], 'ZERO notatek powstaje z pustego szkieletu naglowkow');
    t.false(
        Object.keys(files).some(p => p.endsWith('/brain/reference_legacy_brain_dump.md')),
        'brak dumpu - sam szkielet naglowkow to nie realna tresc (P8)'
    );
    const nowy = files[BRAIN];
    t.true(nowy.includes('## Bieżące') && nowy.includes('## Projekty i referencje'), 'nowy brain.md to swiezy indeks');
});
