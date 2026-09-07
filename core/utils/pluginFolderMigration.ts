/**
 * S35 „Wielki Rename" — przeprowadzka `data.json` ze starego folderu pluginu
 * (`.obsidian/plugins/obsek/`) do nowego (`.obsidian/plugins/<manifestId>/`).
 *
 * W `data.json` siedzi TYLKO wersjonowanie (`installed_at`, `last_version`) — żywe
 * ustawienia mieszkają w vaultcie w `.pkm-assistant/settings.json`. Bez tej kopii
 * user po zmianie id dostałby powitanie „nowy użytkownik" i modal Release Notes.
 *
 * Zasady:
 *  • gdy `manifestId === 'obsek'` (stan sprzed S35 paczki 3) funkcja jest CAŁKOWICIE
 *    bezczynna — dzięki temu wpięcie mogło żyć w kodzie, zanim id faktycznie się zmieniło;
 *    od zmiany id na `pkm-assistant` ścieżka jest ŻYWA;
 *  • „czy nowy już istnieje" sprawdzamy PRÓBĄ ODCZYTU, nie `exists()` — po incydencie
 *    2026-07-28 wiemy, że `exists()` potrafi skłamać na dysku sieciowym (Google Drive);
 *  • starego folderu NIE kasujemy (user sam wywiezie do kosza);
 *  • total-catch: to nigdy nie ma prawa wywalić `onload()`.
 */

const OLD_PLUGIN_ID = 'obsek';
const DATA_FILE = 'data.json';

/** Minimalny kształt złapanego błędu (`catch` daje `unknown`). */
type ErrLike = { message?: string };

/**
 * Adapter widziany przez migrator. Wszystkie metody OPCJONALNE, bo funkcja sama sprawdza
 * `typeof …=== 'function'` i wychodzi po cichu — wołacze podają czasem gołe `{}`.
 */
export interface PluginFolderAdapter {
    read?: (path: string) => Promise<string | null | undefined> | string | null | undefined;
    write?: (path: string, content: string) => unknown;
    mkdir?: (path: string) => unknown;
}

/** Logger duck-typowany na `core/utils/Logger` — używamy tylko `info`/`warn` i to opcjonalnie. */
type MigrationLog = {
    info?: (module: string, message: string) => void;
    warn?: (module: string, message: string) => void;
};

/**
 * @param params
 * @param params.adapter - `app.vault.adapter` (read/write/mkdir)
 * @param params.configDir - `app.vault.configDir` (zwykle `.obsidian`)
 * @param params.manifestId - id z manifest.json
 * @param params.log - logger (info/warn), opcjonalny
 */
export async function migrateOldPluginFolder({ adapter, configDir, manifestId, log }: {
    adapter?: PluginFolderAdapter | null;
    configDir?: string;
    manifestId?: string;
    log?: MigrationLog | null;
} = {}): Promise<{ migrated: boolean; reason?: string }> {
    try {
        if (!adapter || typeof adapter.read !== 'function' || typeof adapter.write !== 'function') {
            return { migrated: false, reason: 'no-adapter' };
        }
        if (!manifestId || manifestId === OLD_PLUGIN_ID) {
            return { migrated: false, reason: 'same-id' };
        }
        const base = `${configDir || '.obsidian'}/plugins`;
        const oldPath = `${base}/${OLD_PLUGIN_ID}/${DATA_FILE}`;
        const newDir = `${base}/${manifestId}`;
        const newPath = `${newDir}/${DATA_FILE}`;

        // 1. Nowy plik już czytelny → nic nie robimy (i NIC nie nadpisujemy).
        try {
            const existing = await adapter.read(newPath);
            if (existing != null) return { migrated: false, reason: 'new-exists' };
        } catch { /* brak nowego — jedziemy dalej */ }

        // 2. Stary plik — jak go nie ma, to nie ma czego przeprowadzać.
        let content = null;
        try {
            content = await adapter.read(oldPath);
        } catch {
            return { migrated: false, reason: 'no-old' };
        }
        if (content == null || String(content).trim() === '') {
            return { migrated: false, reason: 'no-old' };
        }

        // 3. Kopia (nie przeprowadzka z kasowaniem) — tylko data.json.
        try { await adapter.mkdir?.(newDir); } catch { /* folder pewnie już jest */ }
        await adapter.write(newPath, content);
        log?.info?.('Plugin', `Migracja folderu pluginu: skopiowano ${oldPath} → ${newPath} (stary folder zostaje).`);
        return { migrated: true };
    } catch (e) {
        // `catch` daje `unknown` — dokładamy asercję, wyrażenie zostaje bez zmian.
        log?.warn?.('Plugin', `Migracja folderu pluginu nieudana (pomijam): ${((e as ErrLike)?.message || e) as string}`);
        return { migrated: false, reason: 'error' };
    }
}
