import test from 'ava';
import * as host from 'obsidian';
import { build } from 'esbuild';
import { runInThisContext } from 'node:vm';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import * as YAML from 'yaml';

type Api = typeof import('./AttachmentManager.js')
    & Pick<typeof import('../skills/SkillsBackstageTab.js'), 'renderSkillsTab'>
    & typeof import('../sub-agents/SubAgentsBackstageTab.js')
    & typeof import('../skills/SkillTemplateStore.js')
    & typeof import('../skills/SkillLoader.js')
    & typeof import('../sub-agents/SubAgentTemplateStore.js')
    & typeof import('../sub-agents/SubAgentLoader.js')
    & Pick<typeof import('../../core/index.js'), 'setYamlEngine'>
    & Pick<typeof import('../../core/i18n/index.js'), 'setLocale'>;

// Exercise the plugin's CJS host boundary, not Node's native ESM resolution.
// Only compile into RAM: esbuild.js, dist and deployment are never invoked.
const compiled = await build({
    stdin: { contents: `
        export { AttachmentManager } from './modules/ui-components/AttachmentManager.ts';
        export { renderSkillsTab } from './modules/skills/SkillsBackstageTab.ts';
        export { renderSubAgentsTab } from './modules/sub-agents/SubAgentsBackstageTab.ts';
        export { SkillTemplateStore } from './modules/skills/SkillTemplateStore.ts';
        export { SkillLoader } from './modules/skills/SkillLoader.ts';
        export { SubAgentTemplateStore } from './modules/sub-agents/SubAgentTemplateStore.ts';
        export { SubAgentLoader } from './modules/sub-agents/SubAgentLoader.ts';
        export { setYamlEngine } from './core/index.ts';
        export { setLocale } from './core/i18n/index.ts';
    `, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'cjs', platform: 'node', target: 'es2022',
    external: ['obsidian', 'electron'], loader: { '.css': 'empty', '.md': 'text' },
});

function pluginModule(extra: Record<string, unknown> = {}) {
    const notices: string[] = [];
    // Harness has no loadPdfJs. Extend a local copy of its exports for this test only.
    const obsidian = { ...host, Notice: class extends host.Notice {
        constructor(message: string) { super(message); notices.push(message); }
    }, ...extra };
    const module = { exports: {} };
    const execute = runInThisContext(`(function(require, module, exports) {\n${compiled.outputFiles[0].text}\n})`) as
        (require: (id: string) => unknown, module: { exports: object }, exports: object) => void;
    execute(id => {
        if (id !== 'obsidian') throw new Error(`Unexpected host dependency: ${id}`);
        return obsidian;
    }, module, module.exports);
    const api = module.exports as Api;
    api.setLocale('en');
    api.setYamlEngine({ parse: text => YAML.parse(text), stringify: value => YAML.stringify(value) });
    return { api, notices };
}

for (const platform of ['phone', 'desktop']) {
    test.serial(`F1b CJS ${platform}: default PDF loader calls host API and includes page text`, async t => {
        const oldPhone = host.Platform.isPhone;
        const globalPdf = window as Window & { pdfjsLib?: unknown };
        const oldPdf = globalPdf.pdfjsLib;
        host.Platform.isPhone = platform === 'phone';
        delete globalPdf.pdfjsLib;
        t.teardown(() => { host.Platform.isPhone = oldPhone; globalPdf.pdfjsLib = oldPdf; });
        let loads = 0;
        const bytes: number[][] = [];
        const { api } = pluginModule({ loadPdfJs: async () => {
            loads++;
            return { getDocument: ({ data }: { data: ArrayBuffer }) => {
                bytes.push([...new Uint8Array(data)]);
                return { promise: Promise.resolve({ numPages: 1, getPage: async () => ({
                    getTextContent: async () => ({ items: [{ str: 'Tajne haslo proby PDF: borsuk 4721' }] }),
                }) }) };
            } };
        } });
        const manager = new api.AttachmentManager(createDiv(), {} as never);
        t.teardown(() => manager.destroy());
        t.is(loads, 0);
        await manager._processFileList([new File(['pdf'], 'probny.pdf')]);
        t.is(loads, 1);
        t.deepEqual(bytes, [[112, 100, 102]]);
        t.is(manager.buildMessageContent('Read').content,
            '📎 Attachment: probny.pdf\n```\n--- Page 1 ---\nTajne haslo proby PDF: borsuk 4721\n```\n\nRead');
    });
}

function vaultFixture() {
    const files = new Map<string, string>();
    const folders = new Set<string>();
    return { files, adapter: {
        exists: async (path: string) => files.has(path) || folders.has(path),
        read: async (path: string) => { const value = files.get(path); if (value === undefined) throw new Error(path); return value; },
        write: async (path: string, value: string) => { files.set(path, value); },
        mkdir: async (path: string) => { folders.add(path); },
        remove: async (path: string) => { files.delete(path); },
        rmdir: async (path: string) => { folders.delete(path); },
        list: async (path: string) => ({
            files: [...files.keys()].filter(p => p.startsWith(`${path}/`)),
            folders: [...folders].filter(p => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/')),
        }),
    } };
}

function tabDom() {
    const nodes: HTMLElement[] = [];
    function element(tag: string, options: { cls?: string; text?: string } = {}): HTMLElement {
        const el = createEl('div');
        el.className = options.cls ?? '';
        el.textContent = options.text ?? '';
        const listeners = new Map<string, EventListenerOrEventListenerObject[]>();
        el.addEventListener = (type: string, listener: EventListenerOrEventListenerObject | null) => { if (listener) listeners.set(type, [...(listeners.get(type) ?? []), listener]); };
        el.click = () => {
            for (const listener of listeners.get('click') ?? []) {
                const event = new Event('click');
                if (typeof listener === 'function') listener(event); else listener.handleEvent(event);
            }
        };
        el.createEl = ((childTag: string, opts?: { cls?: string; text?: string }) => element(childTag, opts)) as typeof el.createEl;
        el.createDiv = ((opts?: { cls?: string; text?: string }) => element('div', opts)) as typeof el.createDiv;
        el.createSpan = ((opts?: { cls?: string; text?: string }) => element('span', opts)) as typeof el.createSpan;
        el.setAttribute('data-test-tag', tag);
        nodes.push(el);
        return el;
    }
    return { root: element('div'), pickAgent() {
        const option = nodes.find(el => el.className === 'cs-picker__option' && el.textContent === 'Kuba');
        if (!option) throw new Error('Missing agent option');
        option.click();
    } };
}

for (const kind of ['skill', 'sub-agent']) {
    test.serial(`F1b CJS ${kind}: use template creates and assigns a copy, then shows success`, async t => {
        const { api, notices } = pluginModule();
        const vault = vaultFixture();
        const updates: unknown[] = [];
        let refreshed = 0;
        const agent = { name: 'Kuba', skills: [], getAllSubAgentNames: () => [] };
        const skillLoader = new api.SkillLoader(vault);
        const subAgentLoader = new api.SubAgentLoader(vault);
        const skillTemplateStore = new api.SkillTemplateStore(vault);
        const subAgentTemplateStore = new api.SubAgentTemplateStore(vault);
        const store = kind === 'skill' ? skillTemplateStore : subAgentTemplateStore;
        await store.createFromData({ name: 'Plan', description: 'Weekly plan', prompt: 'Write a weekly plan.' });
        const plugin = { agentManager: {
            skillLoader, subAgentLoader, skillTemplateStore, subAgentTemplateStore,
            getAllAgents: () => [agent], getAgent: () => agent,
            updateAgent: async (name: string, changes: unknown) => { updates.push({ name, changes }); },
        } };
        const nav = { refresh: () => { refreshed++; } };
        const dom = tabDom();
        if (kind === 'skill') api.renderSkillsTab(dom.root, plugin as never, nav as never);
        else api.renderSubAgentsTab(dom.root, plugin as never, nav as never);
        dom.pickAgent();
        for (let i = 0; i < 100 && !refreshed; i++) await new Promise<void>(resolve => setImmediate(resolve));
        t.is(refreshed, 1);
        if (kind === 'skill') {
            t.regex(await vault.adapter.read('.pkm-assistant/skills/plan/SKILL.md'), /Write a weekly plan\./);
            t.deepEqual(updates, [{ name: 'Kuba', changes: { skills: ['plan'] } }]);
            t.deepEqual(notices, ['Cast "Plan" on agent Kuba.']);
        } else {
            t.is(await vault.adapter.read('.pkm-assistant/sub-agents/kuba-plan/KNOWLEDGE.md'), 'Write a weekly plan.');
            t.deepEqual(updates, [{ name: 'Kuba', changes: { sub_agents: [{ name: 'kuba-plan', role: 'researcher', default: true }] } }]);
            t.deepEqual(notices, ['Cast "kuba-plan" on agent Kuba.']);
        }
    });
}

test('F1b wiring: production sources never dynamically import obsidian or electron', t => {
    const violations: string[] = [];
    let parsed = 0;
    function scan(directory: string) {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) { scan(path); continue; }
            if (!/\.[cm]?[jt]sx?$/.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) continue;
            const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
            parsed++;
            function visit(node: ts.Node) {
                if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                    const argument = node.arguments[0];
                    if (argument && ts.isStringLiteralLike(argument) && ['obsidian', 'electron'].includes(argument.text)) {
                        violations.push(`${relative(process.cwd(), path)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
                    }
                }
                ts.forEachChild(node, visit);
            }
            visit(source);
        }
    }
    for (const directory of ['modules', 'core', 'src', 'config', 'utils']) scan(join(process.cwd(), directory));
    t.true(parsed > 100, 'Guard must actually scan the production trees');
    t.deepEqual(violations, []);
});
