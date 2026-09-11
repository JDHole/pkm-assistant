/**
 * SettingsRegistry
 *
 * Small registration layer for Settings v2. Modules register sections here,
 * shell owns only the tab layout and calls each section renderer.
 */
import { hostWindow } from '../../core/index.js';

export interface SettingsSection {
    id: string;
    label?: string;
    icon?: string;
    order?: number;
    render: (...args: unknown[]) => unknown;
}

export interface SettingsSubField {
    order?: number;
    render?: (...args: unknown[]) => unknown;
    [key: string]: unknown;
}

class SettingsRegistryClass {
    declare private sections: Map<string, SettingsSection>;
    declare private subFields: Map<string, SettingsSubField[]>;
    constructor() {
        this.sections = new Map();
        this.subFields = new Map();
    }

    register(section: SettingsSection): void {
        if (!section?.id || typeof section.render !== 'function') {
            throw new Error('SettingsRegistry.register requires { id, render }');
        }
        this.sections.set(section.id, {
            label: section.label || section.id,
            icon: section.icon || '',
            order: Number.isFinite(section.order) ? section.order : 100,
            ...section,
        });
    }

    registerSubFields(sectionId: string, fields: SettingsSubField | SettingsSubField[] = [], plugin: unknown = null): void {
        if (!sectionId) throw new Error('SettingsRegistry.registerSubFields requires sectionId');
        const list = this.subFields.get(sectionId) || [];
        const normalized = Array.isArray(fields) ? fields : [fields];
        for (const field of normalized) {
            if (!field) continue;
            list.push({
                order: Number.isFinite(field.order) ? field.order : 100,
                plugin,
                ...field,
            });
        }
        this.subFields.set(sectionId, list);
    }

    has(id: string): boolean {
        return this.sections.has(id);
    }

    getSections(): SettingsSection[] {
        return [...this.sections.values()].sort((a, b) => (a.order as number) - (b.order as number) || a.id.localeCompare(b.id));
    }

    getSection(id: string): SettingsSection | null {
        return this.sections.get(id) || null;
    }

    getSubFields(sectionId: string): SettingsSubField[] {
        return [...(this.subFields.get(sectionId) || [])].sort((a, b) => (a.order as number) - (b.order as number));
    }

    clear(): void {
        this.sections.clear();
        this.subFields.clear();
    }

    getActiveId(defaultId: string | null = null): string | null {
        // Okno przez `hostWindow` (Obsidian: window, Node: global z preloadu AVA) - `render()`
        // jest wołane wprost w AVA (`SettingsRegistry.pkmSettingsV2.test.ts`), gdzie `location`
        // nie istnieje (stąd `?.`); w Obsidianie to zwykłe `window.location`.
        const hash = hostWindow.location?.hash || '';
        const match = hash.match(/#settings\/([^/?#]+)/);
        const id = match?.[1] || defaultId;
        return this.sections.has(id as string) ? id : defaultId;
    }

    // This render() paints ONLY the live `pkm-settings-*` names (`src/styles.css:831-847`) - the
    // `pkm-settings-v2*` namespace has no CSS rule in any stylesheet and must not be painted.
    async render(containerEl: HTMLElement, plugin: unknown, options: { defaultId?: string } = {}): Promise<void> {
        containerEl.empty();
        containerEl.classList.add('cs-root');

        const sections = this.getSections();
        if (sections.length === 0) {
            containerEl.createEl('p', { text: 'Brak zarejestrowanych sekcji ustawien.', cls: 'setting-item-description' });
            return;
        }

        const activeId = this.getActiveId(options.defaultId || sections[0].id) as string;
        const layout = containerEl.createDiv({ cls: 'pkm-settings-layout' });

        const sidebar = layout.createDiv({ cls: 'pkm-settings-nav' });

        const content = layout.createDiv({ cls: 'pkm-settings-content' });

        for (const section of sections) {
            const button = sidebar.createEl('button', {
                cls: `pkm-settings-nav__btn ${section.id === activeId ? 'is-active' : ''}`,
            });
            button.textContent = `${section.icon ? section.icon + ' ' : ''}${section.label}`;
            if (section.id === activeId) button.classList.add('mod-cta');
            button.addEventListener('click', async () => {
                // `hostWindow` - patrz uzasadnienie przy getActiveId() wyżej.
                if (hostWindow.location) hostWindow.location.hash = `settings/${section.id}`;
                await this.render(containerEl, plugin, options);
            });
        }

        const active = this.getSection(activeId) || sections[0];
        await active.render(content, plugin, options);

        const fields = this.getSubFields(active.id);
        if (fields.length > 0) {
            // `pkm-settings-v2__subfields` has zero dubler and zero CSS rule anywhere (unlike its
            // four siblings above) - dropped outright rather than renamed to another dead class.
            // Content is styled by the sub-field renderers' own `setting-item` markup.
            const subContainer = content.createDiv();
            for (const field of fields) {
                if (typeof field.render === 'function') {
                    await field.render(subContainer, plugin, options);
                }
            }
        }
    }
}

export const SettingsRegistry = new SettingsRegistryClass();
export { SettingsRegistryClass };
