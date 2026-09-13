/**
 * Global vault map owned by the agents module.
 *
 * - Canonical path: .pkm-assistant/agents/vault_map.md
 * - Legacy read fallback: .pkm-assistant/agora/vault_map.md
 */
import { t } from '../../core/i18n/index.js';
import { log } from '../../core/utils/Logger.js';

interface VaultMapAdapter {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    mkdir(path: string): Promise<void>;
}

export interface VaultMapVault {
    adapter: VaultMapAdapter;
}

export const VAULT_MAP_PATH = '.pkm-assistant/agents/vault_map.md';
export const LEGACY_VAULT_MAP_PATH = '.pkm-assistant/agora/vault_map.md';

/**
 * Tekst zasiewany do `vault_map.md` przy PIERWSZYM starcie, w języku interfejsu.
 *
 * Czytany przez `t()` w środku funkcji, nie na poziomie modułu: `setLocale()` leci
 * w `src/main.ts` po imporcie modułów. ISTNIEJĄCEGO pliku nikt nie podmienia przy zmianie
 * języka (inaczej niż szablony typów artefaktów) - mapa vaulta to dokument, który agenci
 * dopisują od pierwszej sesji, więc nie ma tu „nietkniętego tekstu fabrycznego".
 */
function starterVaultMap() {
    return t('starter.vault_map.global');
}

export class VaultMap {
    declare vault: VaultMapVault;

    constructor(vault: VaultMapVault) {
        this.vault = vault;
    }

    async initialize() {
        await this._ensureDir('.pkm-assistant');
        await this._ensureDir('.pkm-assistant/agents');

        if (await this._exists(VAULT_MAP_PATH)) return;

        const legacy = await this._read(LEGACY_VAULT_MAP_PATH);
        await this.vault.adapter.write(VAULT_MAP_PATH, legacy || starterVaultMap());
        log.info('VaultMap', legacy
            ? `Migrated global vault map to ${VAULT_MAP_PATH}`
            : `Created starter global vault map at ${VAULT_MAP_PATH}`);
    }

    async readVaultMap() {
        const current = await this._read(VAULT_MAP_PATH);
        if (current) return current;
        return await this._read(LEGACY_VAULT_MAP_PATH);
    }

    async getVaultMapDescriptions() {
        const content = await this.readVaultMap();
        if (!content) return {};

        const descriptions: Record<string, string> = {};
        const regex = /[-*]\s*(?:\*\*)?([^*\n-][^*\n]*?\/?)(?:\*\*)?\s*[—–:-]\s*(.+)/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
            const folder = match[1].replace(/\/+$/, '').trim();
            if (!folder || folder.startsWith('>')) continue;
            descriptions[folder] = match[2].trim();
        }
        return descriptions;
    }

    /**
     * Overwrite the whole vault map document (raw editor in Settings→Vault).
     * @param {string} content
     */
    async writeVaultMap(content: string | null | undefined) {
        await this._ensureDir('.pkm-assistant');
        await this._ensureDir('.pkm-assistant/agents');
        await this.vault.adapter.write(VAULT_MAP_PATH, content ?? '');
        log.info('VaultMap', 'Vault map overwritten from Settings→Vault');
        return { success: true };
    }

    async _exists(path: string) {
        try {
            return await this.vault.adapter.exists(path);
        } catch {
            return false;
        }
    }

    async _read(path: string) {
        try {
            if (!(await this._exists(path))) return '';
            return await this.vault.adapter.read(path);
        } catch {
            return '';
        }
    }

    async _ensureDir(path: string) {
        if (await this._exists(path)) return;
        await this.vault.adapter.mkdir(path);
    }
}
