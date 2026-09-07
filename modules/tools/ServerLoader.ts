/**
 * ServerLoader — Ładuje konfiguracje wbudowanych serwerów MCP.
 *
 * E3.1 faza C: skan user-folderów `.pkm-assistant/mcp-servers/` + `.pkm-assistant/mcp-tools/`
 * (custom-JS sandbox) wycięty. Zostaje WYŁĄCZNIE ładowanie built-in manifestów z
 * `modules/tools/built-in-servers/` (bundled w plugin). Zewnętrzne serwery MCP obsługuje
 * ExternalMcpManager (prawdziwy klient stdio/HTTP), nie ten loader.
 *
 * Każdy entry w cache ma `source: 'built-in'`. Cache w Map.
 */
import { log } from '../../core/utils/Logger.js';
import { resolveBuiltinManifests } from './built-in-servers/index.js';
import type { BuiltinServerManifest } from './built-in-servers/index.js';

/**
 * Wpis w cache loadera: manifest + pola, które dokłada ładowanie (`source`/`removable` są
 * już w manifeście i są tu nadpisywane tą samą wartością — jak w JS przed konwersją).
 */
export interface LoadedServerConfig extends BuiltinServerManifest {
    folderPath: string | null;
    knowledge: string;
    paths: string[];
    enabled: boolean;
}

/** Opcje konstruktora loadera. */
export interface ServerLoaderOptions {
    /** Version from package.json (used for built-in manifest version sentinel) */
    pluginVersion?: string;
    /**
     * Wyłącznik komunikatora (przewód E1.2, default ON od S28 D7). `false` = built-in serwer
     * `komunikator` (kom_send/kom_list/kom_read) znika z katalogu. Undefined = bypass (pełny katalog).
     */
    komunikatorEnabled?: boolean;
}

/** Wiersz katalogu serwerów dla UI. */
export interface ServerCatalogEntry {
    name: string;
    description: string;
    toolCount: number;
    icon: string | null;
    source: string;
    removable: boolean;
}

export class ServerLoader {
    /**
     * Obsidianowy Vault. E3.1 faza C wycięła skan user-folderów, więc loader go już nie czyta —
     * pole zostaje, bo konstruktor jest częścią publicznego API (`new ServerLoader(app.vault, …)`).
     */
    declare vault: unknown;
    declare pluginVersion: string;
    declare komunikatorEnabled: boolean | undefined;
    /** name -> built-in server config */
    declare cache: Map<string, LoadedServerConfig>;

    constructor(vault: unknown, options: ServerLoaderOptions = {}) {
        this.vault = vault;
        this.pluginVersion = options.pluginVersion || '1.0.0';
        this.komunikatorEnabled = options.komunikatorEnabled;
        this.cache = new Map();
    }

    /**
     * Load all built-in servers (bundled with plugin).
     */
    async loadAllServers(): Promise<void> {
        this.cache.clear();

        const builtins = resolveBuiltinManifests({ pluginVersion: this.pluginVersion, komunikatorEnabled: this.komunikatorEnabled });
        for (const manifest of builtins) {
            this.cache.set(manifest.name, {
                ...manifest,
                source: 'built-in',
                removable: false,
                folderPath: null,
                knowledge: '',
                paths: [],
                enabled: true,
            });
        }

        log.info('ServerLoader', `Załadowano ${this.cache.size} built-in serwerów MCP`);
    }

    // ═══════════════════════════════════════════
    // SERVER API
    // ═══════════════════════════════════════════

    /**
     * Get a server by name.
     */
    getServer(name: string): LoadedServerConfig | null {
        return this.cache.get(name) || null;
    }

    /**
     * Get all loaded servers (all built-in).
     */
    getAllServers(): LoadedServerConfig[] {
        return Array.from(this.cache.values());
    }

    /**
     * Get only built-in servers (read-only, bundled with plugin).
     */
    getBuiltinServers(): LoadedServerConfig[] {
        return this.getAllServers().filter(s => s.source === 'built-in');
    }

    /**
     * Get server catalog (name + description + tool count + source for UI badge).
     */
    getServerCatalog(): ServerCatalogEntry[] {
        return this.getAllServers().map(s => ({
            name: s.name,
            description: s.description,
            toolCount: s.tools.length,
            icon: s.icon,
            source: s.source || 'built-in',
            removable: s.removable !== false,
        }));
    }

    /**
     * Reload all built-in servers.
     */
    async reloadServers(): Promise<void> {
        return this.loadAllServers();
    }
}
