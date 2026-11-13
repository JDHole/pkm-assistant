import test from 'ava';
import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { renderInfoSection } from './SettingsContent.js';
import { setLocale } from './i18n/index.js';

test('Information displays version/build and its button invokes device diagnostics', t => {
    setLocale('en');
    const names: string[] = [], labels: string[] = [];
    let click: (() => unknown) | undefined;
    let runs = 0;
    class CapturingSetting extends Setting {
        override setName(name: string | DocumentFragment): this { names.push(String(name)); return this; }
        override addButton(cb: Parameters<Setting['addButton']>[0]): this {
            return super.addButton(button => {
                button.setButtonText = text => { labels.push(text); return button; };
                button.onClick = callback => { click = () => callback({ type: 'click' } as MouseEvent); return button; };
                cb(button);
            });
        }
    }
    const modal = new Modal({} as App);
    renderInfoSection(modal.contentEl, {
        Setting: CapturingSetting,
        plugin: { manifest: { version: '2.4.1' }, diagnosticBuildMarker: 'abc1234 2026-11-13T12:00:00Z', runDeviceDiagnostics: async () => { runs++; } },
        setSvgLabel() {},
    } as never);
    const text = (node: { textContent?: string | null; children: ArrayLike<unknown> }): string => (node.textContent ?? '') + Array.from(node.children).map(child => text(child as never)).join('');
    t.true(text(modal.contentEl).includes('2.4.1 (abc1234 2026-11-13T12:00:00Z)'));
    t.deepEqual(names, ['Device diagnostics']); t.deepEqual(labels, ['Run device diagnostics']);
    click!();
    t.is(runs, 1);
});
