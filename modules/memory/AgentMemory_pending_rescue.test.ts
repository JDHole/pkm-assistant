/**
 * D8 (2026-08-27, werdykt 27.08) — poczekalnia `brain/pending_rescue/`.
 *
 * AUD-docs-065: `memory_rescue` (ratunek kandydatów przed kompresją okna) pisał kandydatów
 * WPROST do `brain/` przez `writeBrainNote` — bez review usera, wbrew gotchy 1 modułu ("agent
 * proponuje, user zatwierdza"). Śledztwo (sesja D8) sprawdziło poczekalnię `ArchiveWorkflow`/
 * `ConsolidationRun` i uznało ją za nieosiągalną bez przebudowy (globalny singleton
 * `MemoryOpsCenter`, propozycje wyłącznie w RAM). Werdykt lidera: HYBRYDA — trwała poczekalnia
 * PLIKOWA (ten plik testuje silnik) + review przez ISTNIEJĄCY modal `/save session`
 * (`SaveSessionWorkflow.test.ts` testuje wpięcie).
 *
 * Wzorzec atrapy: `AgentMemory_kolizja_nazw.test.ts` (`makeVault` z opcjonalnym kłamstwem
 * `exists()`) — realny `AgentMemory` na fałszywym, ale kompletnym adapterze, nie mock samej klasy.
 */
import test from 'ava';
import { AgentMemory } from './AgentMemory.js';

/** Adapter z opcjonalnym kłamstwem: `lying` = ścieżki, dla których `exists()` mówi „nie ma". */
function makeVault(initialFiles: Record<string, string> = {}, lying: string[] = []) {
    const files: Record<string, string> = { ...initialFiles };
    const folders = new Set<string>();
    const liars = new Set(lying);

    const parentsOf = (path: string): string[] => {
        const parts = path.split('/');
        return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('/'));
    };
    for (const path of Object.keys(files)) for (const folder of parentsOf(path)) folders.add(folder);

    return {
        files,
        vault: {
            adapter: {
                async exists(path: string) {
                    if (liars.has(path)) return false;
                    return Object.prototype.hasOwnProperty.call(files, path) || folders.has(path);
                },
                async mkdir(path: string) { folders.add(path); },
                async read(path: string) {
                    if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error(`missing: ${path}`);
                    return files[path];
                },
                async write(path: string, content: string) {
                    for (const folder of parentsOf(path)) folders.add(folder);
                    files[path] = content;
                },
                async remove(path: string) { delete files[path]; },
                async list(folder: string) {
                    const prefix = `${folder}/`;
                    return {
                        files: Object.keys(files).filter(p => p.startsWith(prefix)),
                        folders: [...folders].filter(p => p.startsWith(prefix) && p !== folder),
                    };
                },
                async stat(path: string) {
                    return Object.prototype.hasOwnProperty.call(files, path) ? { mtime: 1 } : null;
                },
            },
        },
    };
}

const BRAIN = '.pkm-assistant/agents/jaskier/memory/brain';
const PENDING = `${BRAIN}/pending_rescue`;

// ─── (a) kandydat ląduje w pending, NIE w brain/, NIE w indeksie ──────────────────────

test('writePendingRescue: kandydat ląduje w brain/pending_rescue/, nie w brain/', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');

    const created = await memory.writePendingRescue({
        name: 'Kuba lubi ciemny motyw', type: 'user', content: 'Kuba lubi ciemny motyw w Obsidianie.',
    }, { source: 'auto_compaction' });

    t.true(created.path.startsWith(`${PENDING}/`), 'plik ląduje w poczekalni, nie w brain/');
    t.true(Object.prototype.hasOwnProperty.call(files, created.path));
    t.true(files[created.path]!.includes('Kuba lubi ciemny motyw w Obsidianie.'));
});

test('writePendingRescue: kandydat NIE wchodzi do listBrainNotes()/indeksu', async t => {
    const { vault } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');

    await memory.writePendingRescue({ name: 'sekret', type: 'reference', content: 'tresc' });
    const notes = await memory.listBrainNotes();
    const brain = await memory.getBrain();

    t.deepEqual(notes, [], 'listBrainNotes() pomija poczekalnię tym samym filtrem co brain/archive/');
    t.false(brain.includes('sekret'), 'kandydat nie trafia do brain.md, dopóki nikt go nie zaakceptował');
});

test('writePendingRescue: why/how_to_apply/source przeżywają zapis+odczyt (frontmatter)', async t => {
    const { vault } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');

    await memory.writePendingRescue({
        name: 'x', type: 'user', content: 'tresc c',
        why: 'bo user o to prosił', how_to_apply: 'przypomnij przy następnej okazji',
    }, { source: 'auto_compaction' });
    const [pending] = await memory.listPendingRescue();

    t.is(pending.content, 'tresc c');
    t.is(pending.why, 'bo user o to prosił');
    t.is(pending.how_to_apply, 'przypomnij przy następnej okazji');
    t.is(pending.source, 'auto_compaction');
    t.false(pending.content.includes('Why'), 'RAW body — stopka Why/How dokleja się dopiero przy accept (writeBrainNote)');
});

// ─── (b) accept → notatka w brain/, pending pusty ─────────────────────────────────────

test('acceptPendingRescue: tworzy notatkę w brain/ i kasuje kandydata z poczekalni', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');
    const pending = await memory.writePendingRescue({
        name: 'Kuba lubi ciemny motyw', type: 'user', content: 'Kuba lubi ciemny motyw.',
        why: 'user wspomniał w rozmowie',
    });

    const created = await memory.acceptPendingRescue(pending.filename);

    t.true(created.path.startsWith(`${BRAIN}/`) && !created.path.includes('pending_rescue'));
    t.true(files[created.path]!.includes('Kuba lubi ciemny motyw.'));
    t.true(files[created.path]!.includes('user wspomniał w rozmowie'), 'why przeżywa do finalnej notatki');
    t.false(Object.prototype.hasOwnProperty.call(files, pending.path), 'kandydat zniknął z poczekalni');
    t.deepEqual(await memory.listPendingRescue(), []);

    const notes = await memory.listBrainNotes();
    t.is(notes.length, 1);
    t.is(notes[0].filename, created.filename);
});

test('acceptPendingRescue: reużywa writeBrainNote — kolizja nazwy w brain/ dostaje sufiks, nie odmowę', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');
    // Notatka o tej samej nazwie już żyje w brain/ (np. z memory_save).
    await memory.writeBrainNote({ name: 'Wzorzec nocny', type: 'reference', content: 'już istnieje' });
    const pending = await memory.writePendingRescue({ name: 'Wzorzec nocny', type: 'reference', content: 'kandydat rescue' });

    const created = await memory.acceptPendingRescue(pending.filename);

    t.true(created.filename.endsWith('_2.md'), 'kolizja nazwy → sufiks, jak w writeBrainNote');
    t.true(files[created.path]!.includes('kandydat rescue'));
});

test('acceptPendingRescue: edycja z modalu (note) wygrywa z oryginałem pliku poczekalni', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');
    const pending = await memory.writePendingRescue({
        name: 'Oryginał', type: 'reference', content: 'oryginalna treść', description: 'opis oryginalny',
    });

    const created = await memory.acceptPendingRescue(pending.filename, {
        name: 'Oryginał', description: 'opis PO EDYCJI usera', content: 'treść PO EDYCJI usera', type: 'reference',
    });

    t.true(files[created.path]!.includes('treść PO EDYCJI usera'));
    t.false(files[created.path]!.includes('oryginalna treść'));
    t.true(files[created.path]!.includes('opis PO EDYCJI usera'));
});

test('acceptPendingRescue: nieznany plik rzuca (nic nie tworzy, nic nie kasuje)', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');

    await t.throwsAsync(
        () => memory.acceptPendingRescue('nie_ma_takiego.md'),
        { message: /Pending rescue candidate not found/ }
    );
    t.deepEqual(await memory.listBrainNotes(), []);
    t.is(Object.keys(files).filter(p => p.includes('brain/') && !p.includes('pending_rescue')).length, 0);
});

// ─── (c) reject → pending pusty, brain/ bez zmian ─────────────────────────────────────

test('rejectPendingRescue: kasuje kandydata, brain/ pozostaje puste', async t => {
    const { vault } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');
    const pending = await memory.writePendingRescue({ name: 'do odrzucenia', type: 'reference', content: 'x' });

    const result = await memory.rejectPendingRescue(pending.filename);

    t.true(result.removed);
    t.deepEqual(await memory.listPendingRescue(), []);
    t.deepEqual(await memory.listBrainNotes(), [], 'reject nie tworzy NICZEGO w brain/');
});

test('rejectPendingRescue: nieznany plik → {removed:false}, nie rzuca', async t => {
    const { vault } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');

    const result = await memory.rejectPendingRescue('widmo.md');
    t.deepEqual(result, { removed: false });
});

// ─── walidacja nazwy pliku (te same reguły co archiveBrainNote) ───────────────────────

test('acceptPendingRescue/rejectPendingRescue: odrzucają nazwy plików poza bezpiecznym wzorcem', async t => {
    const { vault } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');

    await t.throwsAsync(() => memory.acceptPendingRescue('../../../etc/passwd'), { message: /safe \.md filename/ });
    await t.throwsAsync(() => memory.rejectPendingRescue('../../../etc/passwd'), { message: /safe \.md filename/ });
});

// ─── K4 (AUD-bledy-061): probeFile/readIfExists w poczekalni, nie goły exists() ───────

test('writePendingRescue: kłamiący exists() NIE MOŻE nadpisać istniejącego kandydata', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');
    const first = await memory.writePendingRescue({ name: 'Wzorzec nocny', type: 'reference', content: 'kandydat A' });

    const szczery = vault.adapter.exists.bind(vault.adapter);
    vault.adapter.exists = async (path: string) => (path === first.path ? false : szczery(path));

    const second = await memory.writePendingRescue({ name: 'Wzorzec nocny', type: 'reference', content: 'kandydat B' });

    t.not(second.path, first.path, 'probeFile: "nie wiem" ma znaczyć ZAJĘTE, nie "wolne"');
    t.true(files[first.path]!.includes('kandydat A'), 'pierwszy kandydat nietknięty');
    t.true(files[second.path]!.includes('kandydat B'));
});

test('acceptPendingRescue: read() pada na źródle (exists() mówi TAK) — sprzeczne sygnały, fail-closed', async t => {
    // K4/K12 (`readIfExists`): `exists()` uczciwie potwierdza, że plik JEST, ale `read()` na NIM
    // pada — to jest DOKŁADNIE ta sprzeczność, na którą `readIfExists` odpowiada `'unreadable'`.
    // Wołacz nie ma prawa ani utworzyć notatki z tego, czego nie przeczytał, ani skasować pliku,
    // którego treści nie widział.
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');
    const pending = await memory.writePendingRescue({ name: 'x', type: 'reference', content: 'tresc' });

    const originalRead = vault.adapter.read.bind(vault.adapter);
    vault.adapter.read = async (path: string) => {
        if (path === pending.path) throw new Error('symulowany błąd odczytu');
        return originalRead(path);
    };

    await t.throwsAsync(
        () => memory.acceptPendingRescue(pending.filename),
        { message: /nie mogę odczytać kandydata/ }
    );
    t.true(Object.prototype.hasOwnProperty.call(files, pending.path), 'kandydat NIETKNIĘTY po padzie odczytu');
    t.deepEqual(await memory.listBrainNotes(), [], 'nic nie powstało w brain/ z nieprzeczytanej treści');
});

test('rejectPendingRescue: sygnały sprzeczne (exists() mówi NIE, ale read() się udaje) — fail-closed, nie kasuje', async t => {
    // probeFile: exists()=false + read() się udaje = sprzeczność = 'unknown'. rejectPendingRescue
    // ma wtedy NIE kasować — user może odrzucić ponownie w kolejnej rundzie, gdy sygnał się wyjaśni.
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');
    const pending = await memory.writePendingRescue({ name: 'x', type: 'reference', content: 'tresc' });

    const originalExists = vault.adapter.exists.bind(vault.adapter);
    vault.adapter.exists = async (path: string) => (path === pending.path ? false : originalExists(path));

    const result = await memory.rejectPendingRescue(pending.filename);

    t.deepEqual(result, { removed: false }, "'unknown' (sygnały sprzeczne) fail-closed — nie kasujemy");
    t.true(Object.prototype.hasOwnProperty.call(files, pending.path), 'kandydat NIETKNIĘTY');
});

// ─── Weryfikacja opusa — nit 1: torn write (write() rzuca, ale bajty realnie wylądowały) ──

test('writePendingRescue: torn write — adapter.write() rzuca MIMO że plik realnie istnieje — traktowane jako sukces (bez duplikatu)', async t => {
    // Klasa incydentu z lipca 2026 (utrata zapisu): dysk sieciowy/Dysk Google potrafi odrzucić Promise zapisu,
    // mimo że bajty faktycznie wylądowały. Bez tej ochrony wołacz (turnOwner.saveMemoryCandidatesFor)
    // widziałby fałszywy fail i fail-softem dopisałby DUPLIKAT wprost do brain/, podczas gdy
    // kandydat i tak zostałby w poczekalni — user zobaczyłby ten sam fakt dwa razy.
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');
    const originalWrite = vault.adapter.write.bind(vault.adapter);
    vault.adapter.write = async (path: string, content: string) => {
        await originalWrite(path, content); // bajty NAPRAWDĘ lądują na dysku
        throw new Error('symulowany torn write — adapter odrzuca mimo udanego zapisu');
    };

    const result = await memory.writePendingRescue({ name: 'x', type: 'reference', content: 'tresc' });

    t.true(result.path.includes('pending_rescue'));
    t.true(files[result.path]!.includes('tresc'), 'plik naprawdę istnieje z poprawną treścią');
    const pending = await memory.listPendingRescue();
    t.is(pending.length, 1, 'DOKŁADNIE jeden kandydat w poczekalni — żadnego duplikatu z fallbacku wołacza');
});

test('writePendingRescue: prawdziwy pad zapisu (plik NIE istnieje po write()) nadal rzuca normalnie', async t => {
    // Kontrola negatywna dla testu wyżej: torn-write guard nie ma prawa POŁYKAĆ prawdziwych
    // porażek zapisu — tylko te, które probeFile potwierdza jako 'exists'.
    const { vault } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');
    vault.adapter.write = async () => { throw new Error('prawdziwy pad zapisu — dysk pełny'); };

    await t.throwsAsync(
        () => memory.writePendingRescue({ name: 'x', type: 'reference', content: 'tresc' }),
        { message: /prawdziwy pad zapisu/ }
    );
});
