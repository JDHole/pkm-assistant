import { parseYaml } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';
import type { Vault } from 'obsidian';
import type { SkinDefinition } from './SkinManager.js';

export const SKINS_PATH = '.pkm-assistant/skins';

function slugFromPath(path: string): string {
    return String(path || '')
        .split('/')
        .pop()!
        .replace(/\.(ya?ml)$/i, '')
        .trim();
}

export class SkinLoader {
    declare vault: Vault;

    constructor(vault: Vault) {
        this.vault = vault;
    }

    async loadAll(): Promise<SkinDefinition[]> {
        const adapter = this.vault?.adapter;
        if (!adapter?.list || !adapter?.read) return [];

        try {
            const exists = await adapter.exists?.(SKINS_PATH);
            if (exists === false) return [];

            const listed = await adapter.list(SKINS_PATH);
            const files = (listed?.files || []).filter(path => /\.(ya?ml)$/i.test(path));
            const skins = [];

            for (const filePath of files) {
                const skin = await this.load(filePath);
                if (skin) skins.push(skin);
            }

            return skins;
        } catch (error) {
            log.warn('SkinLoader', 'Custom skins load failed:', error);
            return [];
        }
    }

    async load(filePath: string): Promise<SkinDefinition | null> {
        try {
            const raw = await this.vault.adapter.read(filePath);
            const data = parseYaml(raw) as (SkinDefinition & Record<string, unknown>) | null;
            if (!data || typeof data !== 'object') return null;

            const slug = data.slug || slugFromPath(filePath);
            if (!slug) return null;

            return {
                ...data,
                id: `custom-${slug}`,
                slug,
                name: data.name || slug,
                parent: data.parent || data.extends || 'default',
                filePath,
                custom: true,
            } as SkinDefinition;
        } catch (error) {
            log.warn('SkinLoader', `Failed to load ${filePath}:`, error);
            return null;
        }
    }
}
