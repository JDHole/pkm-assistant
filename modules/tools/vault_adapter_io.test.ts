import test from 'ava';
import { listAdapterFolder, isHiddenVaultPath } from './vault_adapter_io.js';
import type { ListCapableAdapter } from './vault_adapter_io.js';

/**
 * AUD-wydajnosc-074: `listAdapterFolder` chodziła po CAŁYM drzewie (do `maxScanned`, domyślnie
 * 5000) niezależnie od tego, ile wpisów wołający realnie potrzebował — `ListTool` i tak tnie
 * wynik do `MAX_RESULTS` (100) PO fakcie. Nowa opcja `maxFiles` zatrzymuje `walk` W TRAKCIE,
 * jak tylko `files` ją osiągnie — bez dalszej rekursji i bez kolejnych `adapter.list()`.
 *
 * Testy niżej liczą wywołania `adapter.list()` (nie tylko wynik) — dowód mutacyjny na to, że
 * naprawa realnie ogranicza I/O, a nie tylko przycina tablicę na końcu (to już robił kod sprzed
 * naprawy, patrz `AdapterListing.truncated` przy `maxScanned`).
 */

function makeTreeAdapter(folders: number, filesPerFolder: number) {
    const listCalls: string[] = [];
    const adapter: ListCapableAdapter = {
        list: async (folder: string) => {
            listCalls.push(folder);
            if (folder === '') {
                return { files: [], folders: Array.from({ length: folders }, (_, i) => `f${i}`) };
            }
            const m = /^f(\d+)$/.exec(folder);
            if (m) {
                return { files: Array.from({ length: filesPerFolder }, (_, j) => `${folder}/file${j}.md`), folders: [] };
            }
            return { files: [], folders: [] };
        },
    };
    return { adapter, listCalls };
}

test('074: maxFiles zatrzymuje walk PO zebraniu limitu — bez rekursji w kolejne podfoldery', async t => {
    const { adapter, listCalls } = makeTreeAdapter(50, 100); // 5000 wpisów razem (dowód audytu)
    const res = await listAdapterFolder(adapter, '/', { recursive: true, maxFiles: 100 });

    t.is(res.files.length, 100);
    t.true(res.truncated);
    t.true(listCalls.length <= 3, `${listCalls.length} wywołań adapter.list() — miały być ~2 (root + f0), nie 51`);
});

test('074: BEZ maxFiles (domyślnie Infinity) — zachowanie IDENTYCZNE jak przed naprawą (pełny przebieg do maxScanned)', async t => {
    const { adapter, listCalls } = makeTreeAdapter(50, 100);
    const res = await listAdapterFolder(adapter, '/', { recursive: true });

    // 50 folderów + 5000 plików = 5050 wpisów > maxScanned domyślny (5000) → obcięte na maxScanned,
    // ale WSZYSTKIE 50 podfolderów muszą zostać odwiedzone (walk nie ma powodu się zatrzymać wcześniej).
    t.is(listCalls.length, 51, 'root + wszystkie 50 podfolderów — domyślne zachowanie bez zmian');
    t.true(res.truncated, 'maxScanned=5000 i tak zostaje trafiony przy 5050 wpisach');
});

test('074: maxFiles większe niż realna liczba wpisów — walk kończy się naturalnie, truncated=false', async t => {
    const { adapter, listCalls } = makeTreeAdapter(3, 10); // 30 plików razem
    const res = await listAdapterFolder(adapter, '/', { recursive: true, maxFiles: 1000 });

    t.is(res.files.length, 30);
    t.false(res.truncated, 'wszystkie wpisy zmieściły się — nic nie zostało obcięte');
    t.is(listCalls.length, 4, 'root + 3 podfoldery — pełny przebieg, bo maxFiles nie był wąskim gardłem');
});

test('074: kolejność PIERWSZYCH N wpisów jest identyczna niezależnie od maxFiles (cięcie nie zmienia WYNIKU)', async t => {
    const { adapter: fullAdapter } = makeTreeAdapter(5, 20);
    const { adapter: cappedAdapter } = makeTreeAdapter(5, 20);

    const full = await listAdapterFolder(fullAdapter, '/', { recursive: true });
    const capped = await listAdapterFolder(cappedAdapter, '/', { recursive: true, maxFiles: 15 });

    t.deepEqual(capped.files, full.files.slice(0, 15));
});

test('074: non-recursive listing respektuje maxFiles tak samo (foldery liczą się jako wpisy)', async t => {
    const { adapter } = makeTreeAdapter(200, 0); // 200 pustych podfolderów, zero plików
    const res = await listAdapterFolder(adapter, '/', { recursive: false, maxFiles: 50 });

    t.is(res.files.length, 50);
    t.true(res.truncated);
    t.true(res.files.every(f => f.isFolder));
});

// sanity: `isHiddenVaultPath` bez zmian w tej naprawie — regresja jednym testem wystarczy.
test('isHiddenVaultPath: bez zmian po AUD-wydajnosc-074', t => {
    t.true(isHiddenVaultPath('.pkm-assistant/agents'));
    t.false(isHiddenVaultPath('Notatki/a.md'));
});
