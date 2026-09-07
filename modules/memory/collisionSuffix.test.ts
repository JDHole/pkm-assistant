/**
 * collisionSuffix.test.ts — AUD-testy-042.
 *
 * `findFreeCollisionPath` jest teraz JEDYNE miejsce w `modules/memory` gdzie żyje pętla „znajdź
 * wolną nazwę pliku przy kolizji" — wcześniej powielona 6× w `AgentMemory.ts`. Zamiast doklejać
 * pięć bliźniaczych testów wyczerpania do pięciu bywszych kopii (co synteza audytu wprost
 * odradza), testujemy KONTRAKT raz, obiema stronami: (1) znajduje wolną nazwę — bazową i przez
 * kolejne sufiksy, aż do granicy 50 prób; (2) po wyczerpaniu 50 kandydatów RZUCA z oczekiwanym
 * komunikatem zamiast oddać zajętą nazwę. Każdy z sześciu wołających (`AgentMemory.ts`) dziedziczy
 * to zachowanie przez delegację — dowód wiązania (throw faktycznie PROPAGUJE się i plik źródłowy
 * zostaje nietknięty) leży w `AgentMemory_kolizja_nazw.test.ts`.
 */
import test from 'ava';
import { findFreeCollisionPath } from './collisionSuffix.js';

const DIR = '.pkm-assistant/agents/jaskier/memory/brain';

/** Adapter minimalny: tylko `exists`/`read`, dokładnie tyle ile woła `probeFile`. */
function makeAdapter(occupied: Set<string>) {
    return {
        async exists(path: string) {
            return occupied.has(path);
        },
        async read(path: string) {
            if (!occupied.has(path)) throw new Error(`ENOENT: ${path}`);
            return 'treść';
        },
    };
}

// ─── strona „znajduje wolną nazwę" ───────────────────────────────────────────────────────────

test('findFreeCollisionPath: nazwa bazowa wolna -> zwraca ją BEZ sufiksu (zero prób kolizji)', async t => {
    const adapter = makeAdapter(new Set());

    const result = await findFreeCollisionPath(adapter, DIR, 'note.md', 'ctx: brak wolnej nazwy');

    t.is(result.filename, 'note.md');
    t.is(result.path, `${DIR}/note.md`);
});

test('findFreeCollisionPath: nazwa bazowa zajęta -> dostaje sufiks _2', async t => {
    const adapter = makeAdapter(new Set([`${DIR}/note.md`]));

    const result = await findFreeCollisionPath(adapter, DIR, 'note.md', 'ctx: brak wolnej nazwy');

    t.is(result.filename, 'note_2.md');
    t.is(result.path, `${DIR}/note_2.md`);
});

test('findFreeCollisionPath: kilka kolejnych kolizji -> pierwszy WOLNY sufiks, nie pierwszy z brzegu', async t => {
    const adapter = makeAdapter(new Set([
        `${DIR}/note.md`,
        `${DIR}/note_2.md`,
        `${DIR}/note_3.md`,
        `${DIR}/note_4.md`,
    ]));

    const result = await findFreeCollisionPath(adapter, DIR, 'note.md', 'ctx: brak wolnej nazwy');

    t.is(result.filename, 'note_5.md');
});

test('findFreeCollisionPath: dokładnie 49 zajętych (baza + _2.._49) -> 50. próba (_50) jest jeszcze legalna, NIE rzuca', async t => {
    const occupied = new Set<string>([`${DIR}/note.md`]);
    for (let s = 2; s <= 49; s++) occupied.add(`${DIR}/note_${s}.md`);

    const result = await findFreeCollisionPath(makeAdapter(occupied), DIR, 'note.md', 'ctx: brak wolnej nazwy');

    t.is(result.filename, 'note_50.md', 'kandydat #50 (baza + 49 sufiksów) to ostatni dozwolony');
});

// ─── strona „po wyczerpaniu prób RZUCA i nie oddaje zajętej nazwy" ──────────────────────────

test('findFreeCollisionPath: wszystkie 50 kandydatów (baza + _2.._50) zajęte -> RZUCA z errorPrefix + dir w treści', async t => {
    const occupied = new Set<string>([`${DIR}/note.md`]);
    for (let s = 2; s <= 50; s++) occupied.add(`${DIR}/note_${s}.md`);
    const adapter = makeAdapter(occupied);

    await t.throwsAsync(
        () => findFreeCollisionPath(adapter, DIR, 'note.md', 'writeBrainNote: brak wolnej nazwy notatki'),
        { message: `writeBrainNote: brak wolnej nazwy notatki w ${DIR}` },
        'komunikat MUSI zachować dokładny kształt errorPrefix + " w " + dir — niektórzy wołający go asertują'
    );
});

test('findFreeCollisionPath: adapter twierdzący, że KAŻDA ścieżka istnieje -> RZUCA (nie zapętla się w nieskończoność)', async t => {
    const adapter = { exists: async () => true, read: async () => 'x' };

    await t.throwsAsync(
        () => findFreeCollisionPath(adapter, DIR, 'note.md', 'archiveBrainNote: brak wolnej nazwy'),
        { message: /archiveBrainNote: brak wolnej nazwy/ }
    );
});

test('findFreeCollisionPath: kłamiący exists() (mówi "nie ma", ale read() dowodzi, że JEST) liczy się jako ZAJĘTA — probeFile fail-closed', async t => {
    // Sedno K4/AUD-bledy-061: `exists()` kłamie na dyskach sieciowych. `probeFile` potwierdza
    // odczytem — więc nawet gdy `exists()` mówi "false", plik, który realnie idzie odczytać,
    // MUSI się liczyć jako zajęty (nie wolno w niego wejść).
    const realFiles = new Set([`${DIR}/note.md`]);
    const adapter = {
        async exists(_path: string) { return false; }, // kłamie zawsze
        async read(path: string) {
            if (!realFiles.has(path)) throw new Error(`ENOENT: ${path}`);
            return 'cudza treść';
        },
    };

    const result = await findFreeCollisionPath(adapter, DIR, 'note.md', 'ctx: brak wolnej nazwy');

    t.not(result.filename, 'note.md', 'probeFile: "nie wiem" (exists=false, ale read się udaje) ma znaczyć ZAJĘTE');
    t.is(result.filename, 'note_2.md');
});

// ─── zachowanie sufiksu: dokleja się do GOTOWEJ nazwy, nie generuje nowego rozszerzenia ─────

test('findFreeCollisionPath: sufiks dokleja się PRZED .md, nie za nim', async t => {
    const adapter = makeAdapter(new Set([`${DIR}/plan_2026.md`]));

    const result = await findFreeCollisionPath(adapter, DIR, 'plan_2026.md', 'ctx: brak wolnej nazwy');

    t.is(result.filename, 'plan_2026_2.md');
});
