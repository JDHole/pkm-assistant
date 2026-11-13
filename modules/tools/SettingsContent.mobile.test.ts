import test from 'ava';
import { Platform } from 'obsidian';
import { renderMcpServersSection } from './SettingsContent.js';
import { setLocale } from '../../core/i18n/index.js';
import type { ClaudeImportRow } from './claudeConfigImport.js';

for (const mobile of [true, false]) test.serial(`Claude import uses ${mobile ? 'file picker' : 'desktop discovery'}`, async t => {
    Platform.isMobile = mobile; setLocale('en');
    const oldRequire = Object.getOwnPropertyDescriptor(window, 'require'), appData = process.env.APPDATA;
    const raw = '{"mcpServers":{"remote":{"url":"https://example.test/mcp"}}}';
    let nodeReads = 0;
    process.env.APPDATA = 'test-app-data';
    Object.defineProperty(window, 'require', { configurable: true, value: () => {
        nodeReads++;
        return { existsSync: () => true, readFileSync: () => raw };
    } });
    t.teardown(() => {
        Platform.isMobile = false;
        if (appData === undefined) delete process.env.APPDATA; else process.env.APPDATA = appData;
        if (oldRequire) Object.defineProperty(window, 'require', oldRequire); else Reflect.deleteProperty(window, 'require');
    });
    const buttons: HTMLElement[] = [], picked: HTMLElement[] = [], notices: string[] = [];
    let fileInput: HTMLElement | undefined;
    function events(el: HTMLElement) {
        const target = new EventTarget();
        el.addEventListener = target.addEventListener.bind(target);
        el.dispatchEvent = target.dispatchEvent.bind(target);
        const div = el.createDiv.bind(el), create = el.createEl.bind(el);
        el.createDiv = options => { const child = div(options); events(child); return child; };
        el.createEl = ((tag, options) => {
            const child = create(tag, options); events(child);
            if (tag === 'button') buttons.push(child);
            if (tag === 'input') { fileInput = child; child.click = () => { picked.push(child); }; }
            return child;
        }) as typeof el.createEl;
    }
    const container = createDiv(); events(container);
    let imported!: (rows: ClaudeImportRow[]) => void;
    const opened = new Promise<ClaudeImportRow[]>(resolve => { imported = resolve; });
    class ImportModal {
        constructor(_app: unknown, private options: { rows: ClaudeImportRow[] }) {}
        open() { imported(this.options.rows); }
    }
    renderMcpServersSection(container, { pkm: {}, owner: { app: {}, render() {} }, save: async () => {},
        ClaudeImportModal: ImportModal, Notice: class { constructor(message: string) { notices.push(message); } },
    } as never);
    // The external-server section renders Add followed by Import from Claude.
    buttons[1].dispatchEvent(new Event('click'));
    if (mobile) {
        t.is(picked.length, 1);
        Object.defineProperty(fileInput, 'files', { value: [{ text: async () => raw }] });
        fileInput!.dispatchEvent(new Event('change'));
    }
    const rows = await opened;
    t.deepEqual(rows, [{ config: { id: 'remote', name: 'remote', enabled: true, autostart: false,
        transport: 'http', url: 'https://example.test/mcp', headers: {} }, exists: false, selected: true }]);
    t.is(nodeReads, mobile ? 0 : 1);
    t.is(picked.length, mobile ? 1 : 0);
    t.deepEqual(notices, []);
});
