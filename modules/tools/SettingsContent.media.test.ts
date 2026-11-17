import test from 'ava';
import { setLocale } from '../../core/i18n/index.js';
import { renderMediaToolsSection } from './SettingsContent.js';
import type { ToolsSettingsCtx } from './SettingsContent.js';

class FakeSetting {
    static rows: FakeSetting[] = [];
    label = '';
    click: (() => void) | undefined;
    settingEl = document.createElement('div');
    nameEl = document.createElement('div');
    constructor(_container: HTMLElement) {
        this.nameEl.appendText = text => { this.label += text; };
        FakeSetting.rows.push(this);
    }
    setName(_name: string) { return this; }
    setDesc(_desc: string) { return this; }
    addDropdown(fn: (control: unknown) => void) { fn(control()); return this; }
    addText(fn: (control: unknown) => void) { fn(control()); return this; }
    addButton(fn: (control: unknown) => void) {
        const button = { setButtonText: (_text: string) => button, onClick: (click: () => void) => { this.click = click; return button; } };
        fn(button); return this;
    }
}
function control() {
    const inputEl = document.createElement('input');
    const obj = { inputEl, addOption: () => obj, setValue: () => obj, setPlaceholder: () => obj, onChange: () => obj };
    return obj;
}

test.serial('status mediów czyta wspólne klucze, nie ujawnia ich i otwiera Klucze API', t => {
    setLocale('pl');
    t.teardown(() => setLocale('en'));
    FakeSetting.rows = [];
    const opened: string[] = [];
    const secret = 'sekret-nigdy-nie-pokazuj';
    const ctx = { pkm: { stt: { platform: 'google' }, imageGen: { platform: 'openai' }, chat: { apiKeys: { gemini: secret } } },
        owner: { render() {}, openSection(id: string) { opened.push(id); } }, icons: {}, Setting: FakeSetting, save() {} } as unknown as ToolsSettingsCtx;
    renderMediaToolsSection(document.createElement('div'), ctx);
    const statuses = FakeSetting.rows.filter(row => row.click);
    t.is(statuses.length, 2);
    t.regex(statuses[0].label, /Brak klucza/);
    t.regex(statuses[1].label, /Klucz API jest wpisany/);
    t.false(statuses.some(row => row.label.includes(secret)));
    statuses[0].click?.();
    statuses[1].click?.();
    t.deepEqual(opened, ['api-keys', 'api-keys']);
});


test.serial('saved locked media keys prompt for unlocking in both languages', t => {
    for (const locale of ['pl', 'en'] as const) {
        setLocale(locale); FakeSetting.rows = [];
        const ctx = { pkm: { stt: { platform: 'google' }, imageGen: { platform: 'openai' }, chat: { apiKeys: {} }, secureStorage: { refs: { 'pkmAssistant.chat.apiKeys.gemini': 'secret-id', 'pkmAssistant.chat.apiKeys.openai': 'secret-id' } } }, plugin: { secretsStorage: { passwordKey: null } }, owner: { render() {}, openSection() {} }, icons: {}, Setting: FakeSetting, save() {} } as unknown as ToolsSettingsCtx;
        renderMediaToolsSection(document.createElement('div'), ctx);
        const labels = FakeSetting.rows.filter(row => row.click).map(row => row.label);
        t.is(labels.length, 2);
        t.true(labels.every(label => locale === 'pl' ? label.includes('Odblokuj') : label.includes('Unlock')));
        t.false(labels.some(label => label.includes('secret-id')));
    }
    setLocale('en');
});
