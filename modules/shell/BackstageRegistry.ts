/**
 * BackstageRegistry
 *
 * Same idea as SettingsRegistry, but for Zaplecze tabs in the sidebar.
 */
export interface BackstageTab {
    id: string;
    label?: string;
    icon?: string;
    order?: number;
    render: (...args: unknown[]) => unknown;
}

class BackstageRegistryClass {
    declare private tabs: Map<string, BackstageTab>;
    constructor() {
        this.tabs = new Map();
    }

    register(tab: BackstageTab): void {
        if (!tab?.id || typeof tab.render !== 'function') {
            throw new Error('BackstageRegistry.register requires { id, render }');
        }
        this.tabs.set(tab.id, {
            label: tab.label || tab.id,
            icon: tab.icon || '',
            order: Number.isFinite(tab.order) ? tab.order : 100,
            ...tab,
        });
    }

    has(id: string): boolean {
        return this.tabs.has(id);
    }

    getTabs(): BackstageTab[] {
        return [...this.tabs.values()].sort((a, b) => (a.order as number) - (b.order as number) || a.id.localeCompare(b.id));
    }

    getTab(id: string): BackstageTab | null {
        return this.tabs.get(id) || null;
    }

    clear(): void {
        this.tabs.clear();
    }
}

export const BackstageRegistry = new BackstageRegistryClass();
export { BackstageRegistryClass };
