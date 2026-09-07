/**
 * Noc 24/25.08 - strażnik reguły K4 (AUD-bledy-061) na pętlach dobierania wolnej nazwy.
 *
 * `probeFile` ma w swoim własnym kontrakcie zdanie: „wołaj to na ścieżkach ZAPISU (tam, gdzie
 * od wyniku zależy nadpisanie)" (`core/utils/vaultFs.ts:74`). Werdykt 25.08 naprawił pierwsze
 * dwie pętle spoza `startActiveSession` (`writeBrainNote`, `discardActiveSession`); przegląd
 * opusa po tym commicie ocenił klasę bugu jako SZERSZĄ i zlecił domknięcie całego modułu.
 *
 * **Stan po domknięciu (ten plik, 27.08): SZEŚĆ pętli tego samego kształtu na `probeFile`**
 * (nie trzy, jak mówił poprzedni docstring, i nie pięć, jak liczył werdykt zlecający tę rundę —
 * grep pkt 3 znalazł SZÓSTĄ, przegapioną wcześniej):
 *   1. `AgentMemory.startActiveSession` (~572) — oryginalny wzorzec, probeFile od zawsze.
 *   2. `AgentMemory.writeBrainNote` (~1275) — naprawione 25.08.
 *   3. `AgentMemory.discardActiveSession` (~810) — naprawione 25.08.
 *   4. `AgentMemory.archiveBrainNote` (~1374) — naprawione TU (27.08).
 *   5. `SaveSessionWorkflow._createBrainNote` (~579) — naprawione TU (27.08).
 *   6. `ArchiveWorkflow._uniqueSummaryName` (~1096, zasila zapisy L1/L2/L3) — naprawione TU,
 *      znalezione grepem pkt 3, NIE było na liście zlecenia.
 *
 * Do kompletu, TĄ SAMĄ rundą naprawione też DWA pojedyncze (nie pętlowe) warunki „czy ta nazwa
 * jest wolna, zanim tu napiszę" — ten sam mechanizm ryzyka (kłamiące `false` = licencja na
 * nadpisanie), inny kształt (skip zamiast retry z sufiksem), więc bez suffixu/throwa >50:
 *   7. `AgentMemory._migrateLegacyRootSessionsToArchive` (~531) — migracja płaskich sesji.
 *   8. `MigrationV3.applyPlan` (~218) — migracja v2→v3 brain.md.
 *
 * Ten plik nie zmienia zachowania pluginu poza tymi naprawami: charakteryzuje pętlę przy
 * uczciwym adapterze, a sekcje niżej dowodzą, że przy adapterze, który kłamie - dokładnie ten
 * scenariusz, dla którego `probeFile` powstało (dyski sieciowe / Dysk Google, incydent
 * 2026-07-28) - żadna z pętli już nie wchodzi w cudzy plik. Testy na `writeBrainNote` i
 * `discardActiveSession` (25.08) oraz `archiveBrainNote`/`_createBrainNote` (27.08) pokrywają
 * pozycje 2-5 z listy wyżej. `_uniqueSummaryName` (pozycja 6) ma własne pokrycie w
 * `ArchiveWorkflow.test.ts` („12 paczek zaakceptowanych pod rząd daje 12 RÓŻNYCH plików L1") —
 * nie duplikujemy go tutaj. Pozycje 7-8 (warunki pojedyncze) są bez dedykowanego testu w tym
 * pliku — ryzyko jest analogiczne, ale to ścieżki migracyjne/jednorazowe, nie pętle kolizji.
 */
import test from 'ava';
import { AgentMemory } from './AgentMemory.js';
import { SaveSessionWorkflow } from './SaveSessionWorkflow.js';
import type { SaveAgentMemoryLike } from './SaveSessionWorkflow.js';

/**
 * `AgentMemory` jest jeszcze w JavaScripcie (patrz `SaveSessionWorkflow.test.ts`) — to samo
 * rzutowanie co tam, potrzebne wyłącznie dla testu `_createBrainNote`.
 */
type MemoryUnderTest = AgentMemory & SaveAgentMemoryLike;
const asMemory = (m: AgentMemory): MemoryUnderTest => m as unknown as MemoryUnderTest;

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
                    // Sedno atrapy: plik JEST na dysku, a `exists()` mówi, że go nie ma.
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
const ARCHIVE = `${BRAIN}/archive`;

// ─── charakteryzacja: uczciwy adapter (zielone) ────────────────────────────────

test('writeBrainNote: wolna nazwa → notatka ląduje pod nazwą bazową', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');

    const created = await memory.writeBrainNote({ name: 'Wzorzec nocny', type: 'reference', content: 'treść A' });

    t.true(created.path.startsWith(`${BRAIN}/`));
    t.true(Object.prototype.hasOwnProperty.call(files, created.path));
    t.true(files[created.path]!.includes('treść A'));
});

test('writeBrainNote: nazwa zajęta → sufiks, stara notatka NIETKNIĘTA', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');

    const first = await memory.writeBrainNote({ name: 'Wzorzec nocny', type: 'reference', content: 'treść A' });
    const second = await memory.writeBrainNote({ name: 'Wzorzec nocny', type: 'reference', content: 'treść B' });

    t.not(second.path, first.path, 'kolizja nazw ma dać NOWY plik, nie nadpisać');
    // Wzmocnienie (werdykt opusa 27.08): nie tylko „inny plik", ale KONKRETNIE sufiks `_2` —
    // i treść B naprawdę pod nim leży, nie gdzieś indziej.
    t.is(second.path, first.path.replace(/\.md$/, '_2.md'), 'druga notatka ma dostać nazwę z sufiksem _2');
    t.true(files[first.path]!.includes('treść A'), 'pierwsza notatka musi przeżyć drugą');
    t.true(files[second.path]!.includes('treść B'), 'treść B ma istnieć pod nazwą z sufiksem _2');
});

test('startActiveSession: ta sama pętla pod probeFile - kłamiący exists() NIE wchodzi w cudzy plik', async t => {
    // Kontrola dodatnia dla reguły K4: tu `probeFile` już jest i potwierdza „nie ma" odczytem,
    // więc kłamstwo `exists()` zostaje wyłapane i nazwa liczy się jako ZAJĘTA.
    const { vault, files } = makeVault();
    const pierwsza = new AgentMemory(vault, 'Jaskier');
    await pierwsza.ensureMemoryStructure();
    const first = await pierwsza.startActiveSession('Jaskier');
    files[first] = 'żywa rozmowa';

    // Świeża instancja pluginu (restart Obsidiana): `activeSessionPath` puste, nazwa ma
    // rozdzielczość minutową, więc wypadnie DOKŁADNIE ta sama - a adapter na niej kłamie.
    const szczery = vault.adapter.exists.bind(vault.adapter);
    vault.adapter.exists = async (path: string) => (path === first ? false : szczery(path));
    const druga = new AgentMemory(vault, 'Jaskier');
    const wybrana = await druga.startActiveSession('Jaskier');

    t.not(wybrana, first, 'probeFile: „nie wiem" ma znaczyć ZAJĘTE, nie „wolne"');
    t.is(files[first], 'żywa rozmowa', 'cudza rozmowa nietknięta');
});

// ─── po naprawie 25.08: writeBrainNote + discardActiveSession pod probeFile (zielone) ──────

test('writeBrainNote: kłamiący exists() NIE MOŻE nadpisać istniejącej notatki', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');

    const first = await memory.writeBrainNote({ name: 'Wzorzec nocny', type: 'reference', content: 'treść A' });

    // Od teraz adapter kłamie DOKŁADNIE na tej jednej ścieżce - reszta vaulta bez zmian.
    const szczery = vault.adapter.exists.bind(vault.adapter);
    vault.adapter.exists = async (path: string) => (path === first.path ? false : szczery(path));

    await memory.writeBrainNote({ name: 'Wzorzec nocny', type: 'reference', content: 'treść B' });

    // NAPRAWIONE (werdykt 25.08): pętla w `writeBrainNote` pyta teraz `probeFile`, więc gołe
    // kłamstwo `exists()` jest potwierdzane odczytem — nazwa liczy się jako ZAJĘTA, treść B
    // ląduje pod sufiksem, a treść A przeżywa. Był to dawny pin (`test.failing`); ten sam plik
    // dowodzi teraz, że `writeBrainNote` ma tę samą ochronę co `startActiveSession`.
    t.true(files[first.path]!.includes('treść A'), 'notatka A nietknięta mimo kłamiącego exists()');
});

test('discardActiveSession: kłamiący exists() NIE MOŻE wejść w cudzy odłożony plik', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');
    const path = await memory.appendToActiveSession({
        type: 'user_message',
        content: 'Druga porzucona',
        timestamp: '2026-07-29T10:00:00.000Z'
    });
    const filename = path.split('/').pop() as string;
    const discardedDir = '.pkm-assistant/agents/jaskier/memory/sessions/active/.discarded';
    const firstTarget = `${discardedDir}/${filename}`;
    // Prawdziwy plik już leży pod nazwą, którą dostanie druga odkładana sesja — dokładnie ten
    // sam kształt kolizji co w teście „suffix _2" wyżej, ale teraz adapter o nim KŁAMIE.
    files[firstTarget] = 'pierwsza porzucona';

    const szczery = vault.adapter.exists.bind(vault.adapter);
    vault.adapter.exists = async (p: string) => (p === firstTarget ? false : szczery(p));

    const secondTarget = await memory.discardActiveSession(path);

    t.not(secondTarget, firstTarget, 'probeFile: „nie wiem" ma znaczyć ZAJĘTE, nie „wolne"');
    t.is(files[firstTarget], 'pierwsza porzucona', 'cudza odłożona sesja nietknięta');
    t.true(files[secondTarget!]!.includes('Druga porzucona'));
});

// ─── po naprawie 27.08: archiveBrainNote + _createBrainNote pod probeFile (zielone) ────────

test('archiveBrainNote: kłamiący exists() NIE MOŻE nadpisać cudzej zarchiwizowanej notatki', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');
    const source = await memory.writeBrainNote({ name: 'Do zarchiwizowania', type: 'reference', content: 'treść źródła' });

    const firstTarget = `${ARCHIVE}/${source.filename}`;
    // Cudza, prawdziwa zarchiwizowana notatka już leży DOKŁADNIE pod nazwą, którą dostałaby
    // ta archiwizacja (source.filename się nie zmienia przy przenosinach do brain/archive/).
    files[firstTarget] = '---\nname: "Cudza archiwalna"\n---\ntreść cudza';

    const szczery = vault.adapter.exists.bind(vault.adapter);
    vault.adapter.exists = async (p: string) => (p === firstTarget ? false : szczery(p));

    const result = await memory.archiveBrainNote(source.filename);

    // NAPRAWIONE (ten commit): pętla w `archiveBrainNote` pyta teraz `probeFile`, więc gołe
    // kłamstwo na `firstTarget` jest potwierdzane odczytem — nazwa liczy się jako ZAJĘTA.
    t.not(result.targetPath, firstTarget, 'probeFile: „nie wiem" ma znaczyć ZAJĘTE, nie „wolne"');
    t.is(result.targetPath, firstTarget.replace(/\.md$/, '_2.md'), 'nowa archiwizacja dostaje sufiks _2');
    t.true(files[firstTarget]!.includes('treść cudza'), 'cudza zarchiwizowana notatka NIETKNIĘTA');
    t.true(files[result.targetPath]!.includes('treść źródła'), 'treść źródła realnie ląduje pod sufiksem');
    t.false(
        Object.prototype.hasOwnProperty.call(files, source.path),
        'źródło poprawnie PRZENIESIONE (usunięte z brain/) po udanej archiwizacji pod wolną nazwą'
    );
});

test('archiveBrainNote: bezpiecznik sufiksu rzuca PRZED write/remove — źródło zostaje nietknięte', async t => {
    // UWAGA z werdyktu opusa: po pętli jest write(targetPath) i dopiero potem remove(sourcePath).
    // Ten test dowodzi, że gdy pętla poddaje się (bezpiecznik `suffix > 50`), throw ląduje
    // PRZED obiema operacjami — nic nie jest nadpisane i źródło nie znika bez śladu.
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');
    const source = await memory.writeBrainNote({ name: 'Do zarchiwizowania', type: 'reference', content: 'treść źródła' });
    const originalSourceContent = files[source.path];

    // Adapter, który twierdzi, że KAŻDA ścieżka istnieje — żadna z 50 prób sufiksu nie trafia
    // na `'missing'`, więc pętla musi dojść do bezpiecznika i rzucić.
    vault.adapter.exists = async () => true;

    await t.throwsAsync(
        () => memory.archiveBrainNote(source.filename),
        { message: /archiveBrainNote: brak wolnej nazwy/ },
        'bezpiecznik > 50 ma rzucić, nie zapętlić się w nieskończoność'
    );

    t.is(files[source.path], originalSourceContent, 'źródło NIETKNIĘTE — przerwanie padło przed remove(sourcePath)');
    t.false(
        Object.prototype.hasOwnProperty.call(files, `${ARCHIVE}/${source.filename}`),
        'nic nie zostało zapisane do brain/archive/ — przerwanie padło przed write(targetPath)'
    );
});

test('_createBrainNote (SaveSessionWorkflow): kłamiący exists() NIE MOŻE nadpisać cudzej notatki', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new SaveSessionWorkflow(asMemory(memory));

    const first = await workflow._createBrainNote({ name: 'Wzorzec nocny', type: 'reference', content: 'treść A' });

    const szczery = vault.adapter.exists.bind(vault.adapter);
    vault.adapter.exists = async (p: string) => (p === first.path ? false : szczery(p));

    const second = await workflow._createBrainNote({ name: 'Wzorzec nocny', type: 'reference', content: 'treść B' });

    // NAPRAWIONE (30.08, AUD-code-review-067/068): `_createBrainNote` deleguje dziś WPROST do
    // `AgentMemory.writeBrainNote` — kanoniczna ścieżka zamiast kopii z własną pętlą.
    t.is(second.path, first.path.replace(/\.md$/, '_2.md'), 'druga notatka ma dostać nazwę z sufiksem _2');
    t.true(files[first.path]!.includes('treść A'), 'notatka A nietknięta mimo kłamiącego exists()');
    t.true(files[second.path]!.includes('treść B'));
});

// ─── po naprawie 30.08: writeBrainNote/writePendingRescue nie gubią się na slugu ≥80 znaków (AUD-code-review-010) ────

// Slug (po normalizacji i obcięciu diakrytyków) jest znacznie dłuższy niż limit 80 znaków
// `makeMemoryNoteFilename` — dokładnie klasa nazwy, którą LLM potrafi zaproponować w
// `memory_rescue` (kompresja okna czatu).
const DLUGA_NAZWA = 'Ustalenia dotyczace sposobu pracy Kuby z agentem w projekcie PKM Assistant w sierpniu i pozniej w tym samym roku';

test('writeBrainNote: kolizja przy slugu ≥80 znaków dostaje KOLEJNY sufiks zamiast rzutu po 50 identycznych próbach', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');

    const first = await memory.writeBrainNote({ name: DLUGA_NAZWA, type: 'user', content: 'treść A' });
    const second = await memory.writeBrainNote({ name: DLUGA_NAZWA, type: 'user', content: 'treść B' });

    // Przed naprawą: sufiks doklejał się do TEKSTU wchodzącego w slugifikację, a ta i tak
    // ucina do 80 znaków — więc `${DLUGA_NAZWA} 2}` dawał DOKŁADNIE tę samą nazwę pliku co
    // `DLUGA_NAZWA` bez sufiksu, pętla mieliła 50 identycznych prób i rzucała.
    t.not(second.path, first.path, 'druga notatka o tej samej DŁUGIEJ nazwie dostaje INNY plik, nie throw');
    t.is(second.path, first.path.replace(/\.md$/, '_2.md'), 'sufiks dokleja się do GOTOWEJ NAZWY PLIKU, nie do tekstu przed slugifikacją');
    t.true(files[first.path]!.includes('treść A'), 'pierwsza notatka przeżywa drugą');
    t.true(files[second.path]!.includes('treść B'));
});

test('writePendingRescue: ta sama naprawa co writeBrainNote dla slugu ≥80 znaków', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');

    const first = await memory.writePendingRescue({ name: DLUGA_NAZWA, type: 'user', content: 'kandydat A' });
    const second = await memory.writePendingRescue({ name: DLUGA_NAZWA, type: 'user', content: 'kandydat B' });

    t.not(second.path, first.path, 'drugi kandydat o tej samej DŁUGIEJ nazwie dostaje INNY plik, nie throw');
    t.is(second.path, first.path.replace(/\.md$/, '_2.md'));
    t.true(files[first.path]!.includes('kandydat A'));
    t.true(files[second.path]!.includes('kandydat B'));
});

// ─── AUD-testy-042 (2026-09-01): wyczerpanie 50 prób — wiązanie z `findFreeCollisionPath` ──────
//
// Wszystkie SZEŚĆ pętli wyżej dzielą dziś JEDNĄ implementację (`collisionSuffix.ts`), która ma
// własny plik testowy (`collisionSuffix.test.ts`) pokrywający kontrakt „znajduje wolną nazwę /
// po wyczerpaniu rzuca" w izolacji. Zamiast doklejać tu pięć bliźniaczych testów wyczerpania do
// pięciu bywszych kopii (audyt to wprost odradza), dwa testy niżej dowodzą tylko WIĄZANIA — że
// throw ze wspólnej funkcji faktycznie PROPAGUJE się przez każdy z DWÓCH różnych kształtów
// obsługi błędu, jakie mają te sześć wołających:
//   - throw wprost do wołającego (`startActiveSession`, `saveSession`, `writeBrainNote`,
//     `writePendingRescue`, `archiveBrainNote` — ten ostatni ma już test wyżej, „bezpiecznik
//     sufiksu rzuca PRZED write/remove"),
//   - throw złapany WEWNĄTRZ metody, fail-soft `null` (`discardActiveSession` — JEDYNY wyjątek).
// Obie próbki dowodzą też strony „NIE nadpisuje istniejącego pliku", której sama
// `findFreeCollisionPath` nie może udowodnić (nie dotyka treści plików — tylko wybiera ścieżkę).

test('startActiveSession: bezpiecznik sufiksu przy wyczerpaniu — RZUCA, zero plików sesji na dysku', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');

    // Adapter, który twierdzi, że KAŻDA ścieżka istnieje — żadna z 50 prób sufiksu nie trafia
    // na `probeFile() === 'missing'`, więc `findFreeCollisionPath` musi dojść do bezpiecznika
    // i rzucić (ten sam mechanizm co w `archiveBrainNote`, dziś WSPÓLNY kod).
    vault.adapter.exists = async () => true;

    await t.throwsAsync(
        () => memory.startActiveSession('Jaskier'),
        { message: /startActiveSession: brak wolnej nazwy pliku sesji/ },
        'throw ze wspólnej findFreeCollisionPath ma PROPAGOWAĆ się do wołającego, nie zniknąć'
    );

    const wroteAnySessionFile = Object.keys(files).some(p => p.startsWith(`${memory.paths.sessionsActive}/`));
    t.false(wroteAnySessionFile, 'żaden plik sesji nie mógł powstać — throw ląduje PRZED _writeSessionFile');
});

test('discardActiveSession: bezpiecznik sufiksu przy wyczerpaniu — fail-soft null (JEDYNY z sześciu, gdzie throw jest złapany WEWNĄTRZ), oryginalna sesja NIE ZNIKA', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');
    const path = await memory.appendToActiveSession({
        type: 'user_message',
        content: 'Sesja do odłożenia',
        timestamp: '2026-07-29T10:00:00.000Z'
    });
    const originalContent = files[path];

    // Od tego momentu KAŻDA ścieżka „istnieje" — pętla w `.discarded/` nie trafi na 'missing'
    // ani razu, więc `findFreeCollisionPath` rzuca. `discardActiveSession` ma WŁASNY try/catch
    // wokół tego wywołania (log.warn + return null) — jedyne z sześciu miejsc, gdzie wołający
    // NIE dostaje wyjątku. Ten test dowodzi, że po wydzieleniu wspólnej funkcji ten catch nadal
    // łapie DOKŁADNIE ten throw (nie ucieka jako unhandled rejection).
    vault.adapter.exists = async () => true;

    const result = await memory.discardActiveSession(path);

    t.is(result, null, 'wyczerpanie prób = fail-soft null (kontrakt tej metody, nie throw na zewnątrz)');
    t.is(files[path], originalContent, 'oryginalna sesja NIE ZOSTAJE USUNIĘTA — throw ląduje PRZED read()/remove(path)');
});
