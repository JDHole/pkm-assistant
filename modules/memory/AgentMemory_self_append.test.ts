/**
 * Domknięcie K4 na wzorcu SELF-APPEND — siostrzana wada, inna niż `AgentMemory_kolizja_nazw.test.ts`.
 *
 * Tamten plik naprawiał pętle „dobierz WOLNĄ NAZWĘ z kandydatów" (`probeFile`). Tu chodzi
 * o pięć miejsc, gdzie kod czytał stary log/sesję/archiwum PRZED dopisaniem NOWEGO wpisu do
 * WŁASNEGO, znanego pliku — wzorzec `if (await adapter.exists(path)) { existing =
 * await adapter.read(path); }`. Na Dysku Google `exists()` potrafi zwrócić `false` DLA PLIKU,
 * KTÓRY JEST (incydent 2026-07-28): kod nigdy nie próbuje `read()`, traktuje plik jako świeży,
 * i zapis NADPISUJE całą dotychczasową treść jednym nowym wpisem. Naprawa: `readIfExists`
 * (`core/utils/vaultFs.ts`) czyta NAJPIERW — `exists()` nie ma szans skłamać.
 *
 * Pięć miejsc, dwie polityki na stan `'unreadable'` (sygnały sprzeczne — plik wygląda na
 * obecny, ale się nie czyta):
 *  - `saveSession` i `_archiveOverflow` (jedyny wołacz: legacy `updateBrain`) → RZUCAJĄ,
 *    transkrypt/kompresja są zbyt cenne, żeby zgadywać;
 *  - `_appendAuditLog`, `appendBrainLog` (ta klasa) i `CostLog.append`
 *    (`CostLog.test.ts`, osobny plik) → kroniki best-effort: `log.warn` + pominięcie
 *    TEGO wpisu, kontrakt „nigdy nie rzuca" zostaje.
 *
 * ⚠️ **`compressBrain()` (nazwa dosłowna z zadania) już NIE dotyka `brain_archive.md`** — w
 * trybie indeksu Memory v3 robi tylko `rebuildBrainIndex()`. Realny append do
 * `brain_archive.md` żyje dziś w `_archiveOverflow`, wołanym WYŁĄCZNIE przez legacy
 * `updateBrain()` — funkcję bez ani jednego callera w produkcji czy testach (zweryfikowane
 * grepem). Naprawa i tak tam trafiła, bo to jest dokładnie wzorzec z zadania; testy niżej
 * wołają `updateBrain()` wprost, żeby dotrzeć do `_archiveOverflow`.
 */
import test from 'ava';
import { AgentMemory } from './AgentMemory.js';
import { parseActiveSession } from './activeSessionFormat.js';
import { log } from '../../core/utils/Logger.js';

/** Ten sam wzorzec fixture co `AgentMemory.test.ts` / `AgentMemory_kolizja_nazw.test.ts`. */
function makeVault(initialFiles: Record<string, string> = {}) {
    const files: Record<string, string> = { ...initialFiles };
    const folders = new Set<string>();

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

const BASE = '.pkm-assistant/agents/jaskier/memory';
const ARCHIVE_FILE = `${BASE}/brain_archive.md`;
const AUDIT_LOG = `${BASE}/audit.log`;
const BRAIN_LOG = `${BASE}/brain.log`;
const BRAIN_MD = `${BASE}/brain.md`;

/** Spy na `log.warn`, wzorem `modules/tools/DelegateTool.test.ts`. */
function spyWarn() {
    const warns: string[] = [];
    const original = log.warn;
    log.warn = (mod: string, msg: string) => { warns.push(`${mod} ${msg}`); };
    return { warns, restore: () => { log.warn = original; } };
}

/** Treść brain.md, która na pewno przekracza BRAIN_MAX_TOKENS/BRAIN_MAX_CHARS_FALLBACK — wymusza `_archiveOverflow`. */
function bigOverflowingBrain(): string {
    const items = Array.from({ length: 30 }, (_, i) =>
        `- Fakt testowy numer ${i} z długim opisem wypełniającym znaki, żeby zawartość mózgu przekroczyła limit i wymusiła archiwizację najstarszych wpisów tej sekcji.`
    );
    return ['# Mózg Jaskra', '', '## Bieżące', ...items, '', '## User', '- jedna rzecz', ''].join('\n');
}

// ═══════════════════════════ 1. saveSession (RZUCA na 'unreadable') ═══════════════════════════

test('saveSession: kłamiący exists() na WŁASNYM pliku sesji NIE gubi wcześniejszego transkryptu', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');

    const path = await memory.saveSession([{ role: 'user', content: 'Wiadomość 1' }], {});
    t.true(files[path]!.includes('Wiadomość 1'));

    // Dysk Google: exists() kłamie DOKŁADNIE na tej ścieżce, read() nadal oddaje prawdziwą treść.
    const honestExists = vault.adapter.exists.bind(vault.adapter);
    vault.adapter.exists = async (p: string) => (p === path ? false : honestExists(p));

    await memory.saveSession(
        [{ role: 'user', content: 'Wiadomość 1' }, { role: 'assistant', content: 'Odpowiedź 2' }],
        {}
    );

    t.true(files[path]!.includes('Wiadomość 1'), 'stara wiadomość NIE zginęła mimo kłamiącego exists()');
    t.true(files[path]!.includes('Odpowiedź 2'), 'nowa wiadomość doszła');
    const parsed = parseActiveSession(files[path]!);
    t.is(parsed.messages.length, 2, 'czytnik widzi OBIE wiadomości, nie tylko surowe bajty pliku');
});

test('saveSession: sprzeczne sygnały (exists=true, read rzuca) na WŁASNYM pliku sesji → throw, plik NIETKNIĘTY', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');

    const path = await memory.saveSession([{ role: 'user', content: 'Wiadomość 1' }], {});
    const originalContent = files[path]!;

    const honestRead = vault.adapter.read.bind(vault.adapter);
    vault.adapter.read = async (p: string) => {
        if (p === path) throw new Error('EIO: dysk nie odpowiada');
        return honestRead(p);
    };

    const err = await t.throwsAsync(
        () => memory.saveSession(
            [{ role: 'user', content: 'Wiadomość 1' }, { role: 'assistant', content: 'Odpowiedź 2' }],
            {}
        ),
        { message: /saveSession: nie mogę odczytać/ },
        'wołający ma dostać błąd zamiast cichej utraty transkryptu'
    );
    t.true(
        err.message.includes('EIO: dysk nie odpowiada'),
        'komunikat niesie PRZYCZYNĘ (cause z readIfExists), nie sam suchy „nie mogę odczytać"'
    );

    t.is(files[path], originalContent, 'plik sesji NIETKNIĘTY — throw ląduje przed jakimkolwiek write()');
});

// ═══════════════ 2. _archiveOverflow przez updateBrain (RZUCA na 'unreadable') ═══════════════

test('_archiveOverflow (przez updateBrain): kłamiący exists() na WŁASNYM brain_archive.md NIE gubi wcześniejszej historii', async t => {
    const oldArchive = '# Archiwum Jaskra\n\nSTARY WPIS Z PRZESZŁOŚCI';
    const { vault, files } = makeVault({ [ARCHIVE_FILE]: oldArchive });
    const memory = new AgentMemory(vault, 'Jaskier');

    const honestExists = vault.adapter.exists.bind(vault.adapter);
    vault.adapter.exists = async (p: string) => (p === ARCHIVE_FILE ? false : honestExists(p));

    await memory.updateBrain(bigOverflowingBrain());

    t.true(files[ARCHIVE_FILE]!.includes('STARY WPIS Z PRZESZŁOŚCI'), 'stara historia archiwum NIE zginęła mimo kłamiącego exists()');
    t.true(files[ARCHIVE_FILE]!.includes('Fakt testowy numer 0'), 'najstarszy nowo zarchiwizowany fakt doszedł');
});

test('_archiveOverflow (przez updateBrain): sprzeczne sygnały na WŁASNYM brain_archive.md → throw, ABORTUJE całą kompresję (brain.md też nietknięty)', async t => {
    const oldArchive = '# Archiwum Jaskra\n\nSTARY WPIS Z PRZESZŁOŚCI';
    const oldBrain = '# Stary mózg — PRZED próbą kompresji';
    const { vault, files } = makeVault({ [ARCHIVE_FILE]: oldArchive, [BRAIN_MD]: oldBrain });
    const memory = new AgentMemory(vault, 'Jaskier');

    const honestRead = vault.adapter.read.bind(vault.adapter);
    vault.adapter.read = async (p: string) => {
        if (p === ARCHIVE_FILE) throw new Error('EIO: dysk nie odpowiada');
        return honestRead(p);
    };

    const err = await t.throwsAsync(
        () => memory.updateBrain(bigOverflowingBrain()),
        { message: /_archiveOverflow: nie mogę odczytać/ },
        'rzut z archiwum ma przerwać CAŁĄ kompresję, nie tylko pominąć archiwizację'
    );
    t.true(
        err.message.includes('EIO: dysk nie odpowiada'),
        'komunikat niesie PRZYCZYNĘ (cause z readIfExists), nie sam suchy „nie mogę odczytać"'
    );

    t.is(files[ARCHIVE_FILE], oldArchive, 'brain_archive.md NIETKNIĘTY');
    t.is(
        files[BRAIN_MD],
        oldBrain,
        'brain.md też NIETKNIĘTY — dowód, że zapis archiwum poprzedza (i tu blokuje) zapis przyciętej treści w updateBrain'
    );
});

// ═══════════════════ 3. _appendAuditLog (SKIP + warn na 'unreadable') ═══════════════════

test('_appendAuditLog (przez memoryWrite): kłamiący exists() na WŁASNYM audit.log NIE gubi wcześniejszych wpisów', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');

    await memory.memoryWrite([{ category: 'TEST', content: 'pierwszy zignorowany update' }]);
    t.true(files[AUDIT_LOG]!.includes('pierwszy zignorowany update'));

    const honestExists = vault.adapter.exists.bind(vault.adapter);
    vault.adapter.exists = async (p: string) => (p === AUDIT_LOG ? false : honestExists(p));

    await memory.memoryWrite([{ category: 'TEST', content: 'drugi zignorowany update' }]);

    t.true(files[AUDIT_LOG]!.includes('pierwszy zignorowany update'), 'pierwszy wpis NIE zginął mimo kłamiącego exists()');
    t.true(files[AUDIT_LOG]!.includes('drugi zignorowany update'), 'drugi wpis doszedł');
});

// `log.warn` jest singletonem modułowym mutowanym przez podmiankę (wzór `DelegateTool.test.ts`).
// AVA odpala testy w PLIKU równolegle domyślnie — dwa testy podmieniające `log.warn`
// w tym samym momencie nadpisują sobie nawzajem łatkę i gubią wpisy. `test.serial` na OBU
// testach niżej, które to robią, usuwa ten wyścig.
test.serial('_appendAuditLog: sprzeczne sygnały na WŁASNYM audit.log → SKIP (warn), NIE throw, plik NIETKNIĘTY', async t => {
    const { vault, files } = makeVault({ [AUDIT_LOG]: 'STARA LINIA AUDYTU' });
    const memory = new AgentMemory(vault, 'Jaskier');

    const honestRead = vault.adapter.read.bind(vault.adapter);
    vault.adapter.read = async (p: string) => {
        if (p === AUDIT_LOG) throw new Error('EIO: dysk nie odpowiada');
        return honestRead(p);
    };

    const spy = spyWarn();
    try {
        await t.notThrowsAsync(
            () => memory.memoryWrite([{ category: 'TEST', content: 'nowy update' }]),
            'kronika legacy jest best-effort — nie ma prawa rzucić w górę'
        );
    } finally {
        spy.restore();
    }

    t.is(files[AUDIT_LOG], 'STARA LINIA AUDYTU', 'audit.log NIETKNIĘTY — wpis pominięty, nie nadpisany');
    t.true(spy.warns.some(w => w.includes('_appendAuditLog') && w.includes('pomijam')), 'warn wyemitowany');
    t.true(
        spy.warns.some(w => w.includes('EIO: dysk nie odpowiada')),
        'warn niesie PRZYCZYNĘ (cause z readIfExists), nie sam suchy „nie mogę odczytać"'
    );
});

// ═══════════════════════ 4. appendBrainLog (SKIP + warn na 'unreadable') ═══════════════════════

test('appendBrainLog: kłamiący exists() na WŁASNYM brain.log NIE gubi wcześniejszych wpisów', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Jaskier');

    t.true(await memory.appendBrainLog('create', 'nota_pierwsza.md', 'test'));
    t.true(files[BRAIN_LOG]!.includes('nota_pierwsza.md'));

    const honestExists = vault.adapter.exists.bind(vault.adapter);
    vault.adapter.exists = async (p: string) => (p === BRAIN_LOG ? false : honestExists(p));

    t.true(await memory.appendBrainLog('create', 'nota_druga.md', 'test'));

    t.true(files[BRAIN_LOG]!.includes('nota_pierwsza.md'), 'pierwszy wpis NIE zginął mimo kłamiącego exists()');
    t.true(files[BRAIN_LOG]!.includes('nota_druga.md'), 'drugi wpis doszedł');
});

test.serial('appendBrainLog: sprzeczne sygnały na WŁASNYM brain.log → SKIP (warn), zwraca false, NIE throw, plik NIETKNIĘTY', async t => {
    const oldLine = '2020-01-01T00:00:00.000Z\tcreate\told_note.md\t';
    const { vault, files } = makeVault({ [BRAIN_LOG]: oldLine });
    const memory = new AgentMemory(vault, 'Jaskier');

    const honestRead = vault.adapter.read.bind(vault.adapter);
    vault.adapter.read = async (p: string) => {
        if (p === BRAIN_LOG) throw new Error('EIO: dysk nie odpowiada');
        return honestRead(p);
    };

    const spy = spyWarn();
    let result: boolean;
    try {
        result = await memory.appendBrainLog('create', 'new_note.md', 'test');
    } finally {
        spy.restore();
    }

    t.false(result, 'appendBrainLog zwraca false — kontrakt „czy wpis wylądował na dysku" pozostaje uczciwy');
    t.is(files[BRAIN_LOG], oldLine, 'brain.log NIETKNIĘTY');
    t.true(spy.warns.some(w => w.includes('appendBrainLog') && w.includes('pomijam')), 'warn wyemitowany');
    t.true(
        spy.warns.some(w => w.includes('EIO: dysk nie odpowiada')),
        'warn niesie PRZYCZYNĘ (cause z readIfExists), nie sam suchy „nie mogę odczytać"'
    );
});
