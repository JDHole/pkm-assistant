/**
 * PluginVaultFs — cienka warstwa nad adapterem vaulta Obsidiana, z prefiksem ścieżki.
 *
 * API: `scan`, `files`, `exists`, `read`, `write`, `mkdir`, `rmdir`, `rename`, `remove`,
 * `list`, `stat`. Filtrowanie globem nie istnieje — `app.vault` sam potrafi listować pliki.
 */
// `import type` = ZERO emitu (esbuild i tsx wycinają go w całości), więc ten plik dalej
// nie wciąga `obsidian` do runtime'u — typy adaptera bierzemy wprost z API Obsidiana.
import type { App, DataAdapter, ListedFiles, Stat } from 'obsidian';
import { log } from './utils/Logger.js';

/** Gospodarz, z którego wyciągamy `app` (dziś PKMEnv; historycznie cokolwiek z `.app`). */
interface VaultFsHost {
    main?: { app?: App | null } | null;
    app?: App | null;
}

/** `window.app` NIE jest w `obsidian.d.ts` — publicznie znana, nieudokumentowana furtka. */
type GlobalWithApp = Window & { app?: App };

/** Minimalny kształt błędu w `catch` (err jest `unknown`). */
type ErrLike = { message?: string };

export class PluginVaultFs {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3).
    declare env: VaultFsHost | null | undefined;
    declare basePath: string;
    declare files: string[];
    declare private _app: App | null | undefined;

    /**
     * @param env — PKMEnv instance (uses env.main.app)
     * @param opts
     * @param opts.basePath — prefiks doklejany do każdej ścieżki.
     */
    constructor(env: VaultFsHost | null | undefined, opts: { basePath?: string } = {}) {
        this.env = env;
        this.basePath = opts.basePath || '';
        this.files = [];
        this._app = env?.main?.app || env?.app || (window as GlobalWithApp).app;
    }

    get adapter(): DataAdapter | undefined {
        return this._app?.vault?.adapter;
    }

    _resolvePath(path: string | null | undefined): string {
        if (!path) return this.basePath || '';
        if (this.basePath) return `${this.basePath}/${path}`.replace(/\/+/g, '/');
        return path;
    }

    /**
     * Wczytuje listę ścieżek do `files`. Z prefiksem `basePath` listuje w jego obrębie,
     * bez prefiksu — wszystkie pliki vaulta. Fail-soft: brak katalogu = pusta lista.
     */
    async scan(): Promise<string[]> {
        if (!this._app?.vault) {
            this.files = [];
            return [];
        }
        try {
            if (this.basePath) {
                // tryb z prefiksem — listuj wewnątrz `basePath`
                const exists = await this.exists('');
                if (!exists) {
                    this.files = [];
                    return [];
                }
                // `!` bezpieczne: `exists('')` zwraca false, gdy adaptera nie ma — więc tu jest.
                const listing = await this.adapter!.list(this.basePath);
                this.files = [...(listing.files || [])];
                return this.files;
            }
            // Default: full vault file list
            this.files = this._app.vault.getFiles().map(f => f.path);
            return this.files;
        } catch (e) {
            log.warn('PluginVaultFs', 'scan error:', (e as ErrLike)?.message || e);
            this.files = [];
            return [];
        }
    }

    async exists(path: string): Promise<boolean> {
        if (!this.adapter) return false;
        try { return await this.adapter.exists(this._resolvePath(path)); }
        catch { return false; }
    }

    async read(path: string): Promise<string> {
        if (!this.adapter) throw new Error('Vault adapter unavailable');
        return this.adapter.read(this._resolvePath(path));
    }

    async write(path: string, data: string): Promise<void> {
        if (!this.adapter) throw new Error('Vault adapter unavailable');
        return this.adapter.write(this._resolvePath(path), data);
    }

    async mkdir(path: string): Promise<void> {
        if (!this.adapter) throw new Error('Vault adapter unavailable');
        const full = this._resolvePath(path);
        if (await this.adapter.exists(full)) return;
        return this.adapter.mkdir(full);
    }

    async rmdir(path: string, recursive = false): Promise<void> {
        if (!this.adapter) throw new Error('Vault adapter unavailable');
        return this.adapter.rmdir(this._resolvePath(path), recursive);
    }

    async rename(src: string, dest: string): Promise<void> {
        if (!this.adapter) throw new Error('Vault adapter unavailable');
        return this.adapter.rename(this._resolvePath(src), this._resolvePath(dest));
    }

    async remove(path: string): Promise<void> {
        if (!this.adapter) throw new Error('Vault adapter unavailable');
        return this.adapter.remove(this._resolvePath(path));
    }

    async list(path = ''): Promise<ListedFiles> {
        if (!this.adapter) return { files: [], folders: [] };
        try { return await this.adapter.list(this._resolvePath(path)); }
        catch { return { files: [], folders: [] }; }
    }

    async stat(path: string): Promise<Stat | null> {
        if (!this.adapter) return null;
        try { return await this.adapter.stat(this._resolvePath(path)); }
        catch { return null; }
    }
}
