/**
 * Strażnik AUD-code-review-041: `_genericVaultMap` i `compileVaultMap` czytają wpisy
 * `focusFolders` (string | {path,access} | {group}) poprawnie — bez `[object Object]`
 * ani `undefined/` w wygenerowanym `vault_map.md`.
 *
 * `PlaybookManager.ts` importuje `obsidian` WYŁĄCZNIE jako `import type { Vault }` — typ
 * znika przy transpilacji (esbuild/tsx), więc moduł faktycznie wstaje w AVA. Testujemy
 * bezpośrednio, nie po źródle.
 */
import test from 'ava';
import { PlaybookManager } from './PlaybookManager.js';
import { setLocale } from '../../core/i18n/index.js';

setLocale('pl');

// `_genericVaultMap` i `compileVaultMap` nie dotykają `this.vault` — atrapa wystarczy do
// konstruktora, testy wołają tylko metody czytające focusFolders.
function makeManager() {
    return new PlaybookManager({} as never);
}

test('_genericVaultMap: wpis string trafia na listę bez zmian (AUD-code-review-041)', t => {
    const pm = makeManager() as never as { _genericVaultMap: (agent: { name: string; focusFolders?: unknown[] }) => string };
    const md = pm._genericVaultMap({ name: 'Testowy', focusFolders: ['Projekty', 'Notatki'] });
    t.true(md.includes('- Projekty'));
    t.true(md.includes('- Notatki'));
    t.false(md.includes('[object Object]'));
});

test('_genericVaultMap: wpis {path,access} pokazuje ścieżkę, nie [object Object] (AUD-code-review-041)', t => {
    const pm = makeManager() as never as { _genericVaultMap: (agent: { name: string; focusFolders?: unknown[] }) => string };
    const md = pm._genericVaultMap({ name: 'Testowy', focusFolders: [{ path: 'Projekty', access: 'read' }] });
    t.true(md.includes('- Projekty'), `oczekiwano ścieżki 'Projekty' w:\n${md}`);
    t.false(md.includes('[object Object]'));
});

test('_genericVaultMap: wpis {group} pokazuje etykietę grupy, nie [object Object] (AUD-code-review-041)', t => {
    const pm = makeManager() as never as { _genericVaultMap: (agent: { name: string; focusFolders?: unknown[] }) => string };
    const md = pm._genericVaultMap({ name: 'Testowy', focusFolders: [{ group: 'Praca' }] });
    t.true(md.includes('Praca'), `oczekiwano nazwy grupy 'Praca' w:\n${md}`);
    t.false(md.includes('[object Object]'));
});

test('compileVaultMap: wpis {group} w focusFolders nie produkuje undefined/ na whiteliście (AUD-code-review-041)', async t => {
    const pm = makeManager();
    // Atrapa vault.adapter — compileVaultMap zapisuje wynik na dysk zanim go zwróci.
    (pm as unknown as { vault: unknown }).vault = {
        adapter: {
            exists: async () => true,
            mkdir: async () => {},
            write: async () => {},
        },
    };
    const plugin = { agentManager: undefined };
    const md = await pm.compileVaultMap({ name: 'Testowy', focusFolders: [{ group: 'Praca' }, { path: 'Projekty', access: 'readwrite' }] }, plugin);
    t.false(md.includes('undefined/'), `oczekiwano braku 'undefined/' w:\n${md}`);
    t.true(md.includes('Projekty/'), `oczekiwano prawdziwej ścieżki 'Projekty/' w:\n${md}`);
});
