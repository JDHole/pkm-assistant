/**
 * vault_binary_io.js — API-first zapis/odczyt plików vaulta.
 *
 * Obrazy (generate_image / add_text_to_image) idą do vaulta usera (np. Attachments/),
 * więc pisz je przez Vault API (createBinary/modifyBinary/create/modify + createFolder).
 * Ścieżki ukryte (`.pkm-assistant/` i inne dot-foldery) NIE są w indeksie Obsidiana —
 * dla nich zostaje adapter (API ich nie widzi). Feature-detect metod dla robustności testów.
 */

/**
 * Plik/folder vaulta w zakresie, jakiego dotyka ten moduł. Duck-typing zamiast
 * `TAbstractFile` — pliki narzędziowe muszą wstawać w gołym Node (testy AVA).
 */
export interface VaultFileLike {
    path: string;
    name: string;
    /** TFile only. */
    extension?: string;
    /** Obecne WYŁĄCZNIE na folderach (TFolder) — po tym rozpoznaje je `isFolderLike`. */
    children?: unknown;
}

/** Zapis/odczyt binarny: `ArrayBuffer` z Vault API i adaptera. */
type BinaryData = ArrayBuffer;

/** Minimalny widok DataAdaptera używany przez ten plik. */
export interface BinaryCapableAdapter {
    exists: (path: string) => Promise<boolean>;
    mkdir: (path: string) => Promise<void>;
    write: (path: string, data: string) => Promise<void>;
    readBinary: (path: string) => Promise<BinaryData>;
    writeBinary: (path: string, data: BinaryData) => Promise<void>;
}

/**
 * Minimalny widok `App` — tylko to, czego dotykają funkcje niżej. Metody Vault API
 * są opcjonalne, bo plik je feature-detectuje (`typeof ... === 'function'`).
 */
export interface BinaryIoApp {
    vault: {
        adapter: BinaryCapableAdapter;
        getAbstractFileByPath?: (path: string) => VaultFileLike | null;
        createFolder: (path: string) => Promise<unknown>;
        readBinary: (file: VaultFileLike) => Promise<BinaryData>;
        createBinary: (path: string, data: BinaryData) => Promise<unknown>;
        modifyBinary: (file: VaultFileLike, data: BinaryData) => Promise<unknown>;
        create: (path: string, content: string) => Promise<unknown>;
        modify: (file: VaultFileLike, content: string) => Promise<unknown>;
        /** Zapis atomowy (wytyczna Obsidiana) — opcjonalny, feature-detected jak reszta pliku. */
        process?: (file: VaultFileLike, fn: (data: string) => string) => Promise<string>;
    };
}

/** Ścieżka poza indeksem Obsidiana (dot-folder, np. .pkm-assistant)? */
function isHiddenPath(path: string): boolean {
    return path.startsWith('.') || path.includes('/.');
}

/**
 * TFolder ma `children` (tablica), TFile nie — duck-typing zamiast importu `obsidian`
 * (testowalność AVA). JEDNA kopia dla całego modułu (Read/List/Write/DeleteTool
 * importują ją stąd) zamiast osobnej implementacji w każdym pliku.
 */
export function isFolderLike(abstractFile: VaultFileLike | null | undefined): boolean {
    return !!abstractFile && Array.isArray(abstractFile.children);
}

/**
 * Zapewnia istnienie folderu docelowego (Vault API dla vaulta, adapter dla ukrytych).
 *
 * ⚠️ Świadomie NIE używa `ensureAdapterFolder` z `core/utils/vaultFs.js`: ta wersja jest
 * app-aware i dla zwykłych ścieżek MUSI iść przez Vault API (`createFolder`), żeby Obsidian
 * zaindeksował nowy folder. Adapter jest tu tylko awaryjną ścieżką dla dot-folderów.
 *
 * `export` zdjęty — zero konsumentów poza tym plikiem (kolizja nazwy z metodą
 * `KomunikatorManager.ensureFolder()`, martwa gałąź homonimu). Wołają go u siebie
 * wyłącznie `writeBinary`/`writeText` niżej.
 */
async function ensureFolder(app: BinaryIoApp, folder: string): Promise<void> {
    if (!folder) return;
    if (isHiddenPath(folder)) {
        if (!(await app.vault.adapter.exists(folder))) await app.vault.adapter.mkdir(folder);
        return;
    }
    if (app.vault.getAbstractFileByPath?.(folder)) return;
    try { await app.vault.createFolder(folder); } catch { /* wyścig / już istnieje */ }
}

/** Odczyt binarny: Vault API dla vaulta, adapter dla ukrytych. */
export async function readBinary(app: BinaryIoApp, path: string): Promise<BinaryData> {
    if (!isHiddenPath(path) && typeof app.vault.getAbstractFileByPath === 'function') {
        const file = app.vault.getAbstractFileByPath(path);
        if (file && !isFolderLike(file)) return await app.vault.readBinary(file);
    }
    return await app.vault.adapter.readBinary(path);
}

/** Zapis binarny: Vault API (create/modifyBinary) dla vaulta, adapter dla ukrytych. */
export async function writeBinary(app: BinaryIoApp, path: string, buffer: BinaryData): Promise<void> {
    const folder = path.substring(0, path.lastIndexOf('/'));
    if (isHiddenPath(path)) {
        if (folder && !(await app.vault.adapter.exists(folder))) await app.vault.adapter.mkdir(folder);
        await app.vault.adapter.writeBinary(path, buffer);
        return;
    }
    await ensureFolder(app, folder);
    const existing = app.vault.getAbstractFileByPath?.(path);
    if (existing && !isFolderLike(existing)) await app.vault.modifyBinary(existing, buffer);
    else await app.vault.createBinary(path, buffer);
}

/** Zapis tekstu: Vault API (create/modify) dla vaulta, adapter dla ukrytych. */
export async function writeText(app: BinaryIoApp, path: string, content: string): Promise<void> {
    const folder = path.substring(0, path.lastIndexOf('/'));
    if (isHiddenPath(path)) {
        if (folder && !(await app.vault.adapter.exists(folder))) await app.vault.adapter.mkdir(folder);
        await app.vault.adapter.write(path, content);
        return;
    }
    await ensureFolder(app, folder);
    const existing = app.vault.getAbstractFileByPath?.(path);
    if (existing && !isFolderLike(existing)) {
        // `Vault.process` (zapis atomowy) zamiast `modify` (wytyczna Obsidiana) — `() => content`
        // przenosi już policzoną treść przez tę samą bramkę. Fallback dla hostów/atrap bez `process`.
        if (typeof app.vault.process === 'function') await app.vault.process(existing, () => content);
        else await app.vault.modify(existing, content);
    }
    else await app.vault.create(path, content);
}
