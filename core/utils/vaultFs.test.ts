import test from 'ava';
import { ensureAdapterFolder, probeFile, readIfExists } from './vaultFs.js';

/** Atrapa DataAdaptera rejestrująca wywołania; `existing` = ścieżki już obecne na dysku. */
function fakeAdapter(existing: string[] = []) {
    const present = new Set(existing);
    const calls: { exists: string[]; mkdir: string[] } = { exists: [], mkdir: [] };
    return {
        calls,
        async exists(path: string) { calls.exists.push(path); return present.has(path); },
        async mkdir(path: string) { calls.mkdir.push(path); present.add(path); },
    };
}

test('zagnieżdżona ścieżka → mkdir rodziców w kolejności od korzenia', async t => {
    const adapter = fakeAdapter();
    await ensureAdapterFolder(adapter, '.pkm-assistant/agents/jaskier/memory');
    t.deepEqual(adapter.calls.mkdir, [
        '.pkm-assistant',
        '.pkm-assistant/agents',
        '.pkm-assistant/agents/jaskier',
        '.pkm-assistant/agents/jaskier/memory',
    ]);
});

test('istniejące foldery → zero mkdir', async t => {
    const adapter = fakeAdapter(['.pkm-assistant', '.pkm-assistant/skins']);
    await ensureAdapterFolder(adapter, '.pkm-assistant/skins');
    t.deepEqual(adapter.calls.mkdir, []);
    t.deepEqual(adapter.calls.exists, ['.pkm-assistant', '.pkm-assistant/skins']);
});

test('brakuje tylko ostatniego segmentu → jeden mkdir', async t => {
    const adapter = fakeAdapter(['.pkm-assistant']);
    await ensureAdapterFolder(adapter, '.pkm-assistant/skins');
    t.deepEqual(adapter.calls.mkdir, ['.pkm-assistant/skins']);
});

test('brak metod adaptera (albo brak adaptera) → no-op bez wybuchu', async t => {
    await t.notThrowsAsync(ensureAdapterFolder(undefined, 'a/b'));
    await t.notThrowsAsync(ensureAdapterFolder(null, 'a/b'));
    await t.notThrowsAsync(ensureAdapterFolder({}, 'a/b'));
    await t.notThrowsAsync(ensureAdapterFolder({ exists: async () => false }, 'a/b'));
    await t.notThrowsAsync(ensureAdapterFolder({ mkdir: async () => {} }, 'a/b'));
});

test('pusta ścieżka → no-op (żadnego exists ani mkdir)', async t => {
    for (const folder of ['', null, undefined, '/', '//']) {
        const adapter = fakeAdapter();
        await ensureAdapterFolder(adapter, folder);
        t.deepEqual(adapter.calls.mkdir, [], `mkdir dla ${JSON.stringify(folder)}`);
        t.deepEqual(adapter.calls.exists, [], `exists dla ${JSON.stringify(folder)}`);
    }
});

test('backslashe i puste segmenty normalizowane', async t => {
    const adapter = fakeAdapter();
    await ensureAdapterFolder(adapter, '.pkm-assistant\\skins//custom');
    t.deepEqual(adapter.calls.mkdir, ['.pkm-assistant', '.pkm-assistant/skins', '.pkm-assistant/skins/custom']);
});

// ───────────────── probeFile: trzy stany zamiast dwóch (K4, AUD-bledy-061) ─────────────────

/** Adapter, któremu można rozkazać, jak ma się zachować `exists` i `read`. */
function probeAdapter(opts: { exists?: boolean | 'throw'; read?: string | 'throw' } = {}) {
    return {
        async exists(_path: string) {
            if (opts.exists === 'throw') throw new Error('EIO');
            return !!opts.exists;
        },
        async read(_path: string) {
            if (opts.read === undefined || opts.read === 'throw') throw new Error('ENOENT');
            return opts.read;
        },
    };
}

test('probeFile: exists() = true → exists (bez zbędnego odczytu)', async t => {
    t.is(await probeFile(probeAdapter({ exists: true }), 'a.md'), 'exists');
});

test('probeFile: exists() = false potwierdzone nieudanym odczytem → missing', async t => {
    t.is(await probeFile(probeAdapter({ exists: false }), 'a.md'), 'missing');
});

test('probeFile: exists() = false, ale read zwraca treść → unknown (sprzeczność)', async t => {
    t.is(await probeFile(probeAdapter({ exists: false, read: 'żywa treść' }), 'a.md'), 'unknown');
});

test('probeFile: exists() rzuca → unknown', async t => {
    t.is(await probeFile(probeAdapter({ exists: 'throw', read: 'żywa treść' }), 'a.md'), 'unknown');
});

test('probeFile: adapter bez read zostaje przy słowie exists()', async t => {
    t.is(await probeFile({ async exists() { return false; } }, 'a.md'), 'missing');
    t.is(await probeFile({}, 'a.md'), 'unknown');
});

// ─────────────── readIfExists: self-append, odczyt-najpierw (K4, siostra probeFile) ───────────────

test('readIfExists: plik ma treść → content, NIEZALEŻNIE od tego co mówi exists()', async t => {
    // Sedno naprawy: `exists()` kłamie (false), ale nasz WŁASNY read() i tak się udaje —
    // czyli dokładnie ten scenariusz, w którym stary wzorzec `if (exists) read()` gubił treść.
    t.deepEqual(
        await readIfExists(probeAdapter({ exists: false, read: 'stara treść' }), 'a.md'),
        { state: 'content', content: 'stara treść' },
    );
});

test('readIfExists: pusty string to legalna treść, nie "missing"', async t => {
    t.deepEqual(
        await readIfExists(probeAdapter({ exists: true, read: '' }), 'a.md'),
        { state: 'content', content: '' },
    );
});

test('readIfExists: potwierdzone „nie ma" (exists=false, read też rzuca) → missing, cause = błąd z NASZEGO read()', async t => {
    const result = await readIfExists(probeAdapter({ exists: false }), 'a.md');
    if (result.state === 'content') return t.fail('oczekiwano missing, nie content');
    t.is(result.state, 'missing');
    t.is(result.content, null);
    t.true(result.cause instanceof Error, 'cause niesie prawdziwy błąd, nie znika po drodze');
    t.is((result.cause as Error).message, 'ENOENT');
});

test('readIfExists: exists()=true ale read() rzuca → unreadable (sprzeczne sygnały), cause = błąd z read()', async t => {
    const result = await readIfExists(probeAdapter({ exists: true, read: 'throw' }), 'a.md');
    if (result.state === 'content') return t.fail('oczekiwano unreadable, nie content');
    t.is(result.state, 'unreadable');
    t.is(result.content, null);
    t.true(result.cause instanceof Error);
    t.is((result.cause as Error).message, 'ENOENT');
});

test('readIfExists: exists() sam rzuca, read() też rzuca → unreadable, cause z NASZEJ próby read() (nie z probeFile)', async t => {
    const result = await readIfExists(probeAdapter({ exists: 'throw', read: 'throw' }), 'a.md');
    if (result.state === 'content') return t.fail('oczekiwano unreadable, nie content');
    t.is(result.state, 'unreadable');
    t.is(result.content, null);
    t.true(result.cause instanceof Error);
    t.is((result.cause as Error).message, 'ENOENT');
});

test('readIfExists: adapter bez read w ogóle deleguje wprost do probeFile, cause=undefined (nie było próby)', async t => {
    t.deepEqual(
        await readIfExists({ async exists() { return false; } }, 'a.md'),
        { state: 'missing', content: null, cause: undefined },
    );
    t.deepEqual(
        await readIfExists({ async exists() { return true; } }, 'a.md'),
        { state: 'unreadable', content: null, cause: undefined },
    );
});

test('readIfExists: brak adaptera → unreadable (fail-closed, nie "missing"), cause=undefined', async t => {
    t.deepEqual(await readIfExists(undefined, 'a.md'), { state: 'unreadable', content: null, cause: undefined });
    t.deepEqual(await readIfExists(null, 'a.md'), { state: 'unreadable', content: null, cause: undefined });
});

// ─────── readIfExists: strażnik typu — fail-open adaptera (read() resolvuje, nie rzuca) ───────

test('readIfExists: read() resolwuje undefined (adapter fail-open, nie rzuca) → unreadable z opisowym cause', async t => {
    const result = await readIfExists(
        { async exists() { return true; }, async read() { return undefined; } },
        'a.md',
    );
    if (result.state === 'content') return t.fail('NIE "content" — undefined nie jest legalną treścią pliku');
    t.is(result.state, 'unreadable');
    t.is(result.content, null);
    t.true(result.cause instanceof Error, 'strażnik typu produkuje własny, opisowy Error');
    t.regex((result.cause as Error).message, /a\.md/, 'komunikat wskazuje, KTÓRY odczyt zawiódł');
});

test('readIfExists: read() resolwuje null → unreadable (ten sam strażnik typu, nie tylko undefined)', async t => {
    const result = await readIfExists(
        { async exists() { return true; }, async read() { return null; } },
        'a.md',
    );
    if (result.state === 'content') return t.fail('oczekiwano unreadable, nie content');
    t.is(result.state, 'unreadable');
    t.is(result.content, null);
    t.true(result.cause instanceof Error);
});
