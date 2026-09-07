import test from 'ava';
import { createDeleteTool } from './DeleteTool.js';
import type { DeleteToolArgs } from './DeleteTool.js';

/**
 * AUD-testy-047 [HIGH] — strażnik „nie kasuj folderów" (`isFolderLike`, zdefiniowany w
 * `vault_binary_io.ts` jako `!!abstractFile && Array.isArray(abstractFile.children)`) na
 * ZWYKŁEJ ścieżce Vault API — `DeleteTool.ts:88-94`, PO gałęzi adapterowej admina (linie 72-86,
 * wchodzi tylko gdy `adminAccess && (isHiddenVaultPath(path) || !file)`).
 *
 * Do tego pliku strażnik był ćwiczony WYŁĄCZNIE przez `AdminVaultTools.test.ts`, gdzie atrapa
 * ma `getAbstractFileByPath: () => null` BEZWARUNKOWO — `file` jest tam ZAWSZE `null`, więc
 * `isFolderLike(file)` nigdy nie dostaje realnego obiektu i kod za nim jest martwy w tamtym
 * teście. Mutacja odtworzona w audycie (wycięcie CAŁEGO bloku `if (isFolderLike(file)) { throw
 * ... }`) przechodziła cały pakiet `modules/tools/*.test.ts` bez czerwieni (427/427 passed).
 *
 * Testy niżej karmią `getAbstractFileByPath` obiektami, które REALNIE różnią się kształtem —
 * plik: brak `children`; folder: `children` to tablica, dokładnie kontrakt `isFolderLike` —
 * i pilnują strony ODMOWY przez SPY na `vault.trash`/`vault.delete`, nie tylko `success:false`:
 * mutacja usuwająca guard wywołałaby te metody NA FOLDERZE, a to właśnie ma złapać test.
 */

type DeleteApp = Parameters<ReturnType<typeof createDeleteTool>['execute']>[1];
type DeleteRes = { success?: boolean; error?: string; path?: string; trashedToSystem?: boolean };

/** Atrapa Vault API: `entries` mapuje ścieżkę → kształt zwracany przez `getAbstractFileByPath`. */
function makeApp(entries: Record<string, { children?: unknown[] }>) {
    const trashCalls: Array<{ path: string; system: boolean }> = [];
    const deleteCalls: string[] = [];
    const app: DeleteApp = {
        vault: {
            adapter: {
                trashSystem: async () => true,
                trashLocal: async () => {},
                remove: async () => {},
            },
            getAbstractFileByPath: (path: string) => {
                const entry = entries[path];
                return entry ? { path, name: path.split('/').pop() as string, ...entry } : null;
            },
            trash: async (file, system) => { trashCalls.push({ path: file.path, system }); },
            delete: async (file) => { deleteCalls.push(file.path); },
        },
    };
    return { app, trashCalls, deleteCalls };
}

const run = (app: DeleteApp, args: DeleteToolArgs) =>
    createDeleteTool().execute(args, app, {}) as Promise<DeleteRes>;

test('delete: plik zwykły na normalnej ścieżce Vault API — usuwa (trash domyślnie true)', async t => {
    const { app, trashCalls } = makeApp({ 'Notatki/a.md': {} }); // plik: BEZ `children`
    const res = await run(app, { path: 'Notatki/a.md' });

    t.true(res.success);
    t.is(res.path, 'Notatki/a.md');
    t.is(trashCalls.length, 1, 'app.vault.trash MUSI zostać wywołane dla zwykłego pliku');
    t.deepEqual(trashCalls[0], { path: 'Notatki/a.md', system: true });
});

test('delete: folder (isFolderLike przez children[]) na zwykłej ścieżce Vault API — ODMOWA, trash/delete NIGDY wołane', async t => {
    const { app, trashCalls, deleteCalls } = makeApp({ 'Projekty/Sub': { children: [] } }); // folder: MA `children`
    const res = await run(app, { path: 'Projekty/Sub' });

    t.false(res.success, 'strażnik ma odmówić kasowania folderu przez zwykłe Vault API');
    t.truthy(res.error);
    t.is(trashCalls.length, 0, 'MUTACJA (wycięcie guard-a) wołałaby to — kasowałaby folder');
    t.is(deleteCalls.length, 0);
});

test('delete: folder-like bez rozszerzenia (realny folder, np. "Projekty") — trash:false idzie przez app.vault.delete, guard i tak odmawia', async t => {
    // Realny folder Obsidiana: brak "." w nazwie/ścieżce, brak pola `extension` — dokładnie
    // kształt TFolder. Guard NIE ma prawa polegać na obecności/braku rozszerzenia, tylko na
    // `children` — trash:false ćwiczy DRUGĄ gałąź wykonania (app.vault.delete zamiast trash).
    const { app, trashCalls, deleteCalls } = makeApp({ Projekty: { children: [] } });
    const res = await run(app, { path: 'Projekty', trash: false });

    t.false(res.success);
    t.truthy(res.error);
    t.is(trashCalls.length, 0);
    t.is(deleteCalls.length, 0, 'app.vault.delete też nie może dostać folderu — guard blokuje PRZED rozgałęzieniem trash/delete');
});
