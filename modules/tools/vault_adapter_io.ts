/**
 * Adapter helpers for vault paths invisible to Obsidian's indexed Vault API.
 *
 * Used only after central path validation and admin_access verification. Paths stay
 * relative to the vault root — this is NOT a whole-computer filesystem bridge.
 */

export function isHiddenVaultPath(path: unknown): boolean {
    return String(path || '')
        .replace(/\\/g, '/')
        .split('/')
        .some(segment => segment.startsWith('.') && segment.length > 1);
}

// S30 Z3: `ensureAdapterFolder` (mkdir -p po segmentach) przeniesiony do
// `core/utils/vaultFs.js` — było 3 warianty tej samej logiki (tu + MigrationV3 +
// domknięcie w crystal-soul/SettingsContent). Re-eksport pod tą samą nazwą, bo
// `WriteTool.js` i `CreateFolderTool.js` importują ją stąd. Deep-import świadomy:
// barrel `core/index.js` wciąga obsidian, a ten plik musi być node-safe (testy AVA).
export { ensureAdapterFolder } from '../../core/index.js';

/** Minimalny widok DataAdaptera: tylko `list` (duck-typing, żeby testy AVA nie wciągały obsidiana). */
export interface ListCapableAdapter {
    list: (folder: string) => Promise<{ files?: string[]; folders?: string[] } | null | undefined>;
}

/** Wpis listingu — ten sam kształt, co zwraca `ListTool` z Vault API. */
export interface AdapterEntry {
    name: string;
    path: string;
    isFolder: boolean;
    extension: string | undefined;
}

/** Opcje chodzenia po drzewie adaptera. */
interface ListAdapterOptions {
    recursive?: boolean;
    maxDepth?: number;
    maxScanned?: number;
    /**
     * AUD-wydajnosc-074: sufit liczby ZEBRANYCH wpisów — walk kończy się, gdy `files` go
     * osiągnie, zamiast dobijać do `maxScanned`. Domyślnie `Infinity` (zachowanie sprzed
     * naprawy: pełny przebieg do `maxScanned`, przycięcie dopiero u wołacza).
     */
    maxFiles?: number;
}

/** Wynik listingu adapterowego (`truncated` = trafiliśmy w `maxScanned`). */
interface AdapterListing {
    files: AdapterEntry[];
    scanned: number;
    truncated: boolean;
}

/**
 * List an adapter folder in the same result shape as ListTool.
 * Recursive mode returns files only, matching Vault API's existing recursive behavior.
 *
 * AUD-wydajnosc-074: `maxScanned` (5000) jest tylko a sufitem awaryjnym — z domyślnym
 * `maxFiles: Infinity` walk go dobija w każdym wywołaniu z dużym drzewem, nawet gdy wołający
 * i tak przytnie wynik do garstki pozycji PO fakcie. Gdy `maxFiles` jest podane, `walk`
 * zatrzymuje się, jak tylko `files` je osiągnie — bez rekursji w kolejne podfoldery i bez
 * dalszych `adapter.list()`. Kolejność wpisów (a więc PIERWSZE `maxFiles` pozycji) jest
 * identyczna jak przy pełnym przebiegu — cięcie nie zmienia, co trafia do wyniku, tylko ile
 * operacji na dysku po drodze się odbywa.
 */
export async function listAdapterFolder(adapter: ListCapableAdapter, folderPath: unknown, {
    recursive = false,
    maxDepth = 12,
    maxScanned = 5000,
    maxFiles = Infinity,
}: ListAdapterOptions = {}): Promise<AdapterListing> {
    const root = folderPath === '/' ? '' : String(folderPath || '').replace(/\/+$/, '');
    const files: AdapterEntry[] = [];
    let scanned = 0;

    const makeEntry = (path: string, isFolder: boolean): AdapterEntry => ({
        name: path.split('/').pop() || '/',
        path,
        isFolder,
        extension: isFolder || !path.includes('.') ? undefined : path.split('.').pop(),
    });

    const walk = async (folder: string, depth: number): Promise<void> => {
        if (depth > maxDepth || scanned >= maxScanned || files.length >= maxFiles) return;
        const listed = await adapter.list(folder);

        for (const file of listed?.files || []) {
            if (scanned++ >= maxScanned) return;
            files.push(makeEntry(file, false));
            if (files.length >= maxFiles) return;
        }

        for (const subFolder of listed?.folders || []) {
            if (scanned++ >= maxScanned) return;
            if (!recursive) {
                files.push(makeEntry(subFolder, true));
                if (files.length >= maxFiles) return;
            } else {
                await walk(subFolder, depth + 1);
                if (files.length >= maxFiles) return;
            }
        }
    };

    await walk(root, 0);
    return { files, scanned, truncated: scanned >= maxScanned || files.length >= maxFiles };
}
