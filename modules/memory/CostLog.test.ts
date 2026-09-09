/**
 * `CostLog` nie miała dotąd żadnego testu - pierwszy plik dla tej klasy.
 *
 * Bramka self-append w `append()` (ta sama klasa błędu co
 * `AgentMemory_self_append.test.ts`). Stary wzorzec `if (await exists()) { read() }` przed
 * dopisaniem nowej linii JSONL na Dysku Google potrafi dostać `exists()===false` dla PLIKU,
 * KTÓRY JEST - kod nigdy nie próbuje `read()`, traktuje log jako świeży, i zapis NADPISUJE
 * całą dotychczasową historię kosztów jedną nową linią. `readIfExists` (core/utils/vaultFs.ts)
 * czyta najpierw, więc kłamstwo `exists()` nie ma jak przeciąć drogi do treści.
 */
import test from 'ava';
import { log } from '../../core/utils/Logger.js';
import { CostLog } from './CostLog.js';
import type { CostLogVaultLike } from './CostLog.js';

/** Adapter minimalny wymagany przez CostLog: exists/read/write. */
function makeVault(initialFiles: Record<string, string> = {}) {
    const files: Record<string, string> = { ...initialFiles };
    const vault: CostLogVaultLike = {
        adapter: {
            async exists(path: string) { return Object.prototype.hasOwnProperty.call(files, path); },
            async read(path: string) {
                if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error(`missing: ${path}`);
                return files[path];
            },
            async write(path: string, content: string) { files[path] = content; },
        },
    };
    return { vault, files };
}

test('append: pierwszy wpis tworzy plik JSONL z jedną linią', async t => {
    const { vault, files } = makeVault();
    const costLog = new CostLog(vault);

    const record = await costLog.append({ agent: 'Jaskier', role: 'main', model: 'claude-haiku-4-5', input_tokens: 10, output_tokens: 5 });

    t.is(record.agent, 'Jaskier');
    t.true(files[costLog.path].includes('"agent":"Jaskier"'));
});

test('append: drugi wpis DOPISUJE, nie nadpisuje (uczciwy adapter)', async t => {
    const { vault, files } = makeVault();
    const costLog = new CostLog(vault);

    await costLog.append({ agent: 'Jaskier', role: 'main', input_tokens: 1, output_tokens: 1 });
    await costLog.append({ agent: 'Tola', role: 'main', input_tokens: 2, output_tokens: 2 });

    const lines = files[costLog.path].trim().split('\n');
    t.is(lines.length, 2);
    t.true(lines[0].includes('"agent":"Jaskier"'));
    t.true(lines[1].includes('"agent":"Tola"'));
});

// ───────────────── self-append: odczyt-najpierw zamiast exists()+read() ─────────────────

test('append: kłamiący exists() na WŁASNYM cost_log.jsonl NIE gubi wcześniejszych wpisów', async t => {
    const { vault, files } = makeVault();
    const costLog = new CostLog(vault);

    await costLog.append({ agent: 'Jaskier', role: 'main', input_tokens: 1, output_tokens: 1 });
    t.true(files[costLog.path].includes('"agent":"Jaskier"'));

    // Dysk Google: exists() kłamie na TEJ ścieżce, read() nadal oddaje prawdziwą treść.
    const honestExists = vault.adapter.exists.bind(vault.adapter);
    vault.adapter.exists = async (p: string) => (p === costLog.path ? false : honestExists(p));

    await costLog.append({ agent: 'Tola', role: 'main', input_tokens: 2, output_tokens: 2 });

    const lines = files[costLog.path].trim().split('\n');
    t.is(lines.length, 2, 'oba wpisy widoczne w pliku — nic nie zostało nadpisane mimo kłamiącego exists()');
    t.true(lines[0].includes('"agent":"Jaskier"'), 'pierwszy wpis NIE zginął');
    t.true(lines[1].includes('"agent":"Tola"'), 'drugi wpis doszedł');
});

test('append: sprzeczne sygnały (exists=true, read rzuca) na WŁASNYM cost_log.jsonl → SKIP (warn), NIE rzuca, plik nietknięty', async t => {
    const { vault, files } = makeVault();
    const costLog = new CostLog(vault);
    files[costLog.path] = '{"agent":"StaryWpis"}\n';

    const honestRead = vault.adapter.read.bind(vault.adapter);
    vault.adapter.read = async (p: string) => {
        if (p === costLog.path) throw new Error('EIO: dysk nie odpowiada');
        return honestRead(p);
    };

    const warns: string[] = [];
    const originalWarn = log.warn;
    log.warn = (mod: string, msg: string) => { warns.push(`${mod} ${msg}`); };
    let record;
    try {
        record = await costLog.append({ agent: 'Nowy', role: 'main', input_tokens: 3, output_tokens: 3 });
    } finally {
        log.warn = originalWarn;
    }

    t.truthy(record, 'kontrakt „nigdy nie rzuca" zostaje — append zwraca znormalizowany rekord mimo pominiętego zapisu');
    t.is(files[costLog.path], '{"agent":"StaryWpis"}\n', 'plik NIETKNIĘTY — wpis pominięty, nie nadpisany');
    t.true(warns.some(w => w.includes('CostLog') && w.includes('pomijam')), 'warn wyemitowany');
    t.true(
        warns.some(w => w.includes('EIO: dysk nie odpowiada')),
        'warn niesie PRZYCZYNĘ (cause z readIfExists), nie sam suchy „nie mogę odczytać"'
    );
});
