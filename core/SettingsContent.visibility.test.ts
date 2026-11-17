import test from 'ava';
import { readFileSync } from 'node:fs';
import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { renderAdvancedSection } from './SettingsContent.js';
import { setLocale } from './i18n/index.js';

test('render check visibility follows navigation without reopening settings', async t => {
    setLocale('en');
    const rows = new Map<string, { classes: Set<string>; change?: (value: boolean) => unknown }>();
    class CapturingSetting extends Setting {
        row = { classes: new Set<string>(), change: undefined as ((value: boolean) => unknown) | undefined };
        constructor(container: HTMLElement) {
            super(container);
            this.settingEl.classList.toggle = (name: string, force?: boolean) => {
                const active = force ?? !this.row.classes.has(name);
                if (active) this.row.classes.add(name); else this.row.classes.delete(name);
                return active;
            };
        }
        override setName(name: string | DocumentFragment): this { rows.set(String(name), this.row); return this; }
        override addToggle(cb: Parameters<Setting['addToggle']>[0]): this {
            return super.addToggle(toggle => {
                toggle.onChange = callback => { this.row.change = callback; return toggle; };
                cb(toggle);
            });
        }
    }
    const pkm = { obsidianAppEnabled: false };
    let saves = 0;
    renderAdvancedSection(new Modal({} as App).contentEl, {
        Setting: CapturingSetting, pkm, save: async () => { saves++; }, setSvgLabel() {}, openCostTrackingModal() {},
    } as never);
    const navigation = rows.get('Obsidian app navigation');
    const render = rows.get('Note render check (experimental)');
    t.truthy(navigation?.change);
    t.true(render?.classes.has('is-hidden'));
    await navigation?.change?.(true);
    t.false(render?.classes.has('is-hidden'));
    t.true(pkm.obsidianAppEnabled);
    await navigation?.change?.(false);
    t.true(render?.classes.has('is-hidden'));
    t.false(pkm.obsidianAppEnabled);
    t.is(saves, 2);
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    t.regex(css, /\.pkm-render-check-setting\.is-hidden\s*\{\s*display:\s*none\s*;/);
});
