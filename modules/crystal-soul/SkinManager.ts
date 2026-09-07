import { defaultSkin } from './skins/default.js';
import { crystalSoulSkin } from './skins/crystal-soul.js';
import { SkinLoader } from './SkinLoader.js';
import { adoptSheet, removeSheet } from './styleSheets.js';
import { log } from '../../core/utils/Logger.js';
import type { Vault } from 'obsidian';

export type AgentVisual = string | {
    name?: string;
    color?: string | null;
    crystalColor?: string | null;
};

export type SkinRenderOptions = {
    size?: number;
    color?: string;
    glow?: boolean;
    textColor?: string;
};

export type SkinSpec = {
    id: string;
    name: string;
    parent: string | null;
    slug?: string;
    filePath?: string;
    custom?: boolean;
    colors: Record<string, string>;
    animations: {
        enabled?: boolean;
        transition?: string;
        glow?: boolean;
    } & Record<string, boolean | string | undefined>;
    css: Record<string, string>;
    crystals: Record<string, unknown>;
    getCrystal?: (agent: AgentVisual, options?: SkinRenderOptions) => string;
    getAgentColor?: (agent: AgentVisual) => string;
    getShapeName?: (agent: AgentVisual) => string;
};

export type SkinDefinition =
    Pick<SkinSpec, 'id' | 'name' | 'parent'>
    & Partial<Omit<SkinSpec, 'id' | 'name' | 'parent'>>;

type SkinSettings = { activeSkin?: string } & Record<string, unknown>;
type SkinPluginLike = {
    app?: { vault?: Vault };
    settings?: SkinSettings;
    env?: {
        settings?: { pkmAssistant?: SkinSettings };
        settingsStore?: {
            save?: () => Promise<unknown>;
            /** SUROWY worek — z pominięciem obserwowanego proxy (patrz `ensureSettings`). */
            raw?: { pkmAssistant?: SkinSettings };
        };
    };
};
type SkinListener = { event: string; handler: (payload: unknown) => void };

const BUILTIN_SKINS: Record<string, SkinSpec> = {
    default: defaultSkin,
    'crystal-soul': crystalSoulSkin,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return (value && typeof value === 'object' && !Array.isArray(value)) as boolean;
}

function deepMerge(base: Record<string, unknown> | undefined, override: Record<string, unknown> | undefined): Record<string, unknown> {
    const out = { ...(base || {}) };
    for (const [key, value] of Object.entries(override || {})) {
        if (isPlainObject(value) && isPlainObject(out[key])) {
            out[key] = deepMerge(out[key] as Record<string, unknown>, value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

function normalizeSkinId(id: string | null | undefined): string {
    if (!id || id === 'crystal') return 'crystal-soul';
    return id;
}

export class SkinManagerClass {
    declare plugin: SkinPluginLike | null;
    declare loader: SkinLoader | null;
    declare customSkins: Map<string, SkinDefinition>;
    declare listeners: Set<SkinListener>;
    declare _styleEl: null;
    declare private _sheet?: CSSStyleSheet;

    constructor() {
        this.plugin = null;
        this.loader = null;
        this.customSkins = new Map();
        this.listeners = new Set();
        this._styleEl = null;
    }

    async initialize(plugin: SkinPluginLike): Promise<this> {
        this.plugin = plugin || this.plugin;
        this.loader = this.plugin?.app?.vault ? new SkinLoader(this.plugin.app.vault) : null;
        await this.reloadCustomSkins();
        this.ensureSettings();
        this.applyCss();
        return this;
    }

    /**
     * Dosztukowanie domyślnego skina to NIE jest decyzja usera — idzie do SUROWEGO worka
     * (`settingsStore.raw`), z pominięciem obserwowanego proxy.
     *
     * Mutacja proxy planuje zapis CAŁEGO `.pkm-assistant/settings.json` (a tam mieszkają klucze
     * API) sekundę po starcie — a boot nie ma prawa pisać (reguła „boot nie pisze", incydent
     * 2026-07-28; strażnik: scenariusz harnessa `39_boot_nie_pisze`). Do clean-room objaw był
     * niewidoczny, bo fabryczne ustawienia niosły `activeSkin` i warunek nigdy nie wchodził;
     * nowe `config/defaultSettings.ts` prowizjonuje wyłącznie kontenery czatu i embeddingu
     * (spec §4), więc gałąź stała się osiągalna przy każdym starcie nowego usera.
     *
     * ⚠️ `setActiveSkin` pisze DALEJ przez proxy — tam zapis jest w porządku, bo to wybór usera.
     */
    ensureSettings(): SkinSettings | null {
        const settings = this.getSettings();
        if (settings && !settings.activeSkin) {
            const raw = this.plugin?.env?.settingsStore?.raw?.pkmAssistant;
            if (raw) raw.activeSkin = 'crystal-soul';
            else settings.activeSkin = 'crystal-soul';
        }
        return settings;
    }

    getSettings(): SkinSettings | null {
        const envSettings = this.plugin?.env?.settings?.pkmAssistant;
        if (envSettings) return envSettings;
        if (this.plugin?.settings) return this.plugin.settings;
        return null;
    }

    async reloadCustomSkins(): Promise<SkinDefinition[]> {
        this.customSkins.clear();
        const skins = await this.loader?.loadAll?.() || [];
        for (const skin of skins) {
            this.customSkins.set(skin.id, skin);
        }
        return skins;
    }

    listSkins(): Array<{ id: string; name: string; type: string; parent?: string | null; filePath?: string }> {
        return [
            { id: 'crystal-soul', name: 'Crystal Soul', type: 'built-in' },
            { id: 'default', name: 'Default', type: 'built-in' },
            ...[...this.customSkins.values()].map(skin => ({
                id: skin.id,
                name: skin.name,
                type: 'custom',
                parent: skin.parent,
                filePath: skin.filePath,
            })),
        ];
    }

    getActiveSkinId(): string {
        return normalizeSkinId(this.getSettings()?.activeSkin || 'crystal-soul');
    }

    getActiveSkin(): SkinSpec {
        return this.resolveSkin(this.getActiveSkinId()) || BUILTIN_SKINS['crystal-soul'];
    }

    /**
     * K7/AUD-code-review-092: `_visited` łapie cykl dziedziczenia (`parent` wpisany ręcznie
     * w YAML usera — self-referencja albo dwa skiny wskazujące na siebie nawzajem). Bez tego
     * rekurencja wybucha `RangeError: Maximum call stack size exceeded` przy KAŻDYM renderze
     * (getColor/getCrystal/applyCss), czyli zamraża całą warstwę wizualną agentów.
     */
    resolveSkin(id: string, _visited: Set<string> = new Set()): SkinSpec | null {
        const normalized = normalizeSkinId(id);
        if (BUILTIN_SKINS[normalized]) return BUILTIN_SKINS[normalized];

        const custom = this.customSkins.get(normalized);
        if (!custom) return null;

        if (_visited.has(normalized)) {
            log.warn('SkinManager', `cykl dziedziczenia skina wykryty przy '${normalized}' — fallback na default`);
            return defaultSkin;
        }
        _visited.add(normalized);

        const parent = this.resolveSkin(custom.parent || 'default', _visited) || defaultSkin;
        return this.mergeSkin(parent, custom);
    }

    /**
     * Klucze spoza `SkinSpec` w YAML usera (np. `icons:` z archiwalnego schematu S12 — pole
     * skasowane 2026-09-02 razem z martwą ścieżką `getIcon`, AUD-dead-code-198) przechodzą
     * przez `...custom` bez walidacji i nikt ich nie czyta. Świadomie: loader nie ma schematu,
     * a nieznany klucz nie może psuć ładowania skina. Strażnik w `SkinManager.test.ts`.
     */
    mergeSkin(parent: SkinSpec, custom: SkinDefinition): SkinSpec {
        const merged = {
            ...parent,
            ...custom,
            colors: deepMerge(parent.colors, custom.colors) as Record<string, string>,
            crystals: deepMerge(parent.crystals, custom.crystals),
            animations: deepMerge(parent.animations, custom.animations) as SkinSpec['animations'],
            css: deepMerge(parent.css, custom.css) as Record<string, string>,
        };
        merged.getCrystal = parent.getCrystal?.bind(merged);
        merged.getAgentColor = parent.getAgentColor?.bind(merged);
        merged.getShapeName = parent.getShapeName?.bind(merged);
        return merged;
    }

    async setActiveSkin(id: string, options: { save?: boolean } = {}): Promise<boolean> {
        const skinId = normalizeSkinId(id);
        if (!this.resolveSkin(skinId)) return false;

        const settings = this.ensureSettings();
        if (settings) settings.activeSkin = skinId;
        if (options.save !== false) {
            await this.plugin?.env?.settingsStore?.save?.();
        }
        this.applyCss();
        this.emit('skin_changed', { skinId, skin: this.getActiveSkin() });
        return true;
    }

    getColor(key: string, fallback = 'var(--text-normal)'): string {
        return this.getActiveSkin()?.colors?.[key] || fallback;
    }

    getCrystal(agent: AgentVisual, options: SkinRenderOptions = {}): string {
        const skin = this.getActiveSkin();
        return skin.getCrystal?.(agent, options) || crystalSoulSkin.getCrystal!(agent, options);
    }

    getAgentColor(agent: AgentVisual, fallbackKey = 'agent_default'): string {
        return this.getActiveSkin()?.getAgentColor?.(agent) || this.getColor(fallbackKey);
    }

    getShapeName(agent: AgentVisual): string {
        return this.getActiveSkin()?.getShapeName?.(agent) || 'monogram';
    }

    applyCss() {
        if (typeof document === 'undefined') return;
        const skin = this.getActiveSkin();
        const root = document.body;
        root?.classList?.add('pkm-skin-root');
        root?.setAttribute?.('data-pkm-skin', skin.id);
        root?.style?.setProperty('--pkm-skin-agent-default', this.getColor('agent_default'));
        root?.style?.setProperty('--pkm-skin-accent', this.getColor('accent'));
        // Legacy --cs-accent alias for user theme.css files.
        root?.style?.setProperty('--cs-accent', this.getColor('accent'));

        const css = [
            '.pkm-icon-base,.cs-ui-icon{display:inline-block;vertical-align:middle;}',
            skin.css?.custom || '',
        ].join('\n');

        // Dynamic skin CSS (user skins from YAML) must be injected at runtime — a
        // constructed stylesheet instead of a <style> element (catalog guideline
        // obsidianmd/no-forbidden-elements). Same mechanism as the module CSS files
        // loaded via adoptedStyleSheets elsewhere in the repo. Desktop-only plugin
        // → Electron/Chromium, constructable stylesheets are always available.
        if (typeof CSSStyleSheet === 'undefined') return;
        if (!this._sheet) {
            this._sheet = new CSSStyleSheet();
            adoptSheet(this._sheet);
        }
        this._sheet.replaceSync(css);
    }

    /**
     * Demontaż skina (AUD-bledy-037) — wołane z `onunload` pluginu.
     *
     * Bez tego arkusz skina i znaczniki na `document.body` zostawały po wyłączeniu pluginu
     * (Obsidian stylizowany przez martwy plugin aż do restartu), a każdy cykl wyłącz/włącz
     * dokładał kolejny arkusz. Idempotentne — drugi demontaż nic nie psuje.
     */
    dispose(): void {
        removeSheet(this._sheet);
        this._sheet = undefined;
        if (typeof document === 'undefined') return;
        const root = document.body;
        root?.classList?.remove('pkm-skin-root');
        root?.removeAttribute?.('data-pkm-skin');
        for (const prop of ['--pkm-skin-agent-default', '--pkm-skin-accent', '--cs-accent']) {
            root?.style?.removeProperty(prop);
        }
    }

    on(event: string, handler: (payload: unknown) => void): () => boolean {
        const listener = { event, handler };
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(event: string, payload: unknown): void {
        for (const listener of this.listeners) {
            if (listener.event !== event) continue;
            try {
                listener.handler(payload);
            } catch (error) {
                log.warn('SkinManager', 'listener failed:', error);
            }
        }
    }
}

export const SkinManager = new SkinManagerClass();
