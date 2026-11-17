import test from 'ava';
import { createWorkspacePort } from '../obsidian-app/index.js';
import { createObsidianAppTool } from './ObsidianAppTool.js';
import { ToolRegistry } from './ToolRegistry.js';
import { MCPClient } from './MCPClient.js';
import { PermissionSystem } from '../../core/security/PermissionSystem.js';

class Element {
    ownerDocument!: { defaultView: unknown };
    parentElement: Element | null = null;
    nodeType = 1;
    children: Element[] = [];
    constructor(public classList: string[] = [], public textContent = '') {}
    querySelectorAll() { return this.children; }
    querySelector() { return null; }
}

function fixture(admin = true) {
    let now = 0; let nextId = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let mutation: (records: unknown[]) => void = () => {};
    let ready = () => {}; const observed = new Promise<void>(resolve => { ready = resolve; });
    class Observer { constructor(cb: (records: unknown[]) => void) { mutation = cb; } observe() { ready(); } disconnect() {} }
    const listeners = new Map<string, (event: never) => void>();
    const original = (..._args: unknown[]) => {};
    const win = { MutationObserver: Observer, console: { error: original },
        setTimeout: (fn: () => void, ms: number) => { const id = ++nextId; timers.set(id, { at: now + ms, fn }); return id; },
        clearTimeout: (id: number) => { timers.delete(id); }, addEventListener: (name: string, callback: (event: never) => void) => { listeners.set(name, callback); }, removeEventListener: (name: string) => { listeners.delete(name); } };
    const advance = (duration: number) => {
        const end = now + duration;
        for (;;) {
            const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            timers.delete(due[0]); now = due[1].at; due[1].fn();
        }
        now = end;
    };
    const root = new Element(); root.ownerDocument = { defaultView: win };
    const own = new Element(['block-language-dataviewjs'], 'own content'); own.parentElement = root;
    const embed = new Element(['internal-embed']); embed.parentElement = root;
    const embedded = new Element(['block-language-dataview'], 'embedded secret'); embedded.parentElement = embed;
    root.children = [own, embedded];
    const file = { path: 'Notes/A.md' }; const other = { path: 'Notes/B.md' };
    let active = file; let state = { file: file.path, mode: 'preview' };
    const view = { file, previewMode: { containerEl: root }, getViewType: () => 'markdown' };
    let opens = 0; let reads = 0; let onOpen = () => {};
    const leaf = { view, getViewState: () => ({ state }), setViewState: async (v: { state: typeof state }) => { state = v.state; }, openFile: async () => { opens++; onOpen(); } };
    const app = { workspace: { getMostRecentLeaf: () => leaf, getActiveFile: () => active, getLeaf: () => leaf, iterateAllLeaves: (fn: (v: unknown) => void) => fn(leaf) }, vault: { getAbstractFileByPath: () => file, read: async () => { reads++; return '```dataviewjs\nx\n```'; } } };
    const port = createWorkspacePort(app as never, (value): value is never => value === file);
    const registry = new ToolRegistry(); registry.registerTool(createObsidianAppTool(port));
    const agent = { name: 'Tola', admin_access: admin, disabled_tools: [], focusFolders: ['Notes'], permissions: { guidance_mode: false, read_notes: true } };
    const plugin = { agentManager: { getAgent: () => agent, getActiveAgent: () => agent }, permissionSystem: new PermissionSystem(null, {}), approvalManager: { requestApproval: async () => ({ result: 'approve' }) } };
    const client = new MCPClient(app as never, plugin as never, registry);
    return { observed, advance, timers, win, listeners, agent, port, counts: () => [opens, reads], setOnOpen: (fn: () => void) => { onOpen = fn; }, embedded, mutate: () => mutation([{ target: embedded }]), swap: (toOther: boolean) => { active = toOther ? other : file; view.file = active; state.file = active.path; }, call: (name: string | null = 'Tola') => client.executeToolCall({ name: 'obsidian_app', arguments: { action: 'render_check', path: file.path, wait_ms: 1000 } }, name) };
}

test.serial('F4c 1: missing caller identity never borrows the active administrator', async t => {
    const f = fixture(); const result = await f.call(null);
    t.true(JSON.stringify(result).includes('"success":false')); t.deepEqual(f.counts(), [0, 0]);
});

test.serial('F4c 2: revoked read access during open prevents source read', async t => {
    const f = fixture(false); f.setOnOpen(() => { f.agent.focusFolders = []; });
    const result = await f.call(); t.true(JSON.stringify(result).includes('"success":false')); t.deepEqual(f.counts(), [1, 0]);
});

test.serial('F4c 3: dispose during open prevents source read', async t => {
    const f = fixture(); f.setOnOpen(() => f.port.dispose!());
    const result = await f.call(); t.true(JSON.stringify(result).includes('"code":"unavailable"')); t.deepEqual(f.counts(), [1, 0]);
});

for (const admin of [true, false]) {
    test.serial(`F4c 5: embedded mutations do not delay stabilization or leak content, admin=${admin}`, async t => {
        const previous = globalThis.HTMLElement; Object.defineProperty(globalThis, 'HTMLElement', { value: Element, configurable: true });
        try {
            const f = fixture(admin); const pending = f.call(); await f.observed;
            for (let i = 0; i < 12; i++) { f.advance(40); f.mutate(); }
            f.advance(20); const result = await pending; const json = JSON.stringify(result);
            t.true(json.includes('"stabilized":true')); t.true(json.includes('"status":"rendered"')); t.true(json.includes('"block_count":1')); t.false(json.includes('embedded secret')); t.is(f.timers.size, 0);
        } finally { Object.defineProperty(globalThis, 'HTMLElement', { value: previous, configurable: true }); }
    });
}

test.serial('F4c 4: silent A to B to A for 120 ms is rejected by periodic identity check', async t => {
    const previous = globalThis.HTMLElement; Object.defineProperty(globalThis, 'HTMLElement', { value: Element, configurable: true });
    try {
        const f = fixture(); const pending = f.call(); await f.observed; f.swap(true); f.advance(120); f.swap(false);
        const result = await pending; t.true(JSON.stringify(result).includes('"code":"unavailable"')); t.false(JSON.stringify(result).includes('own content')); t.is(f.timers.size, 0);
    } finally { Object.defineProperty(globalThis, 'HTMLElement', { value: previous, configurable: true }); }
});

test.serial('F4c 6: secret is masked before result truncation', async t => {
    const previous = globalThis.HTMLElement; Object.defineProperty(globalThis, 'HTMLElement', { value: Element, configurable: true });
    try {
        const f = fixture(); const pending = f.call(); await f.observed;
        f.win.console.error('x'.repeat(977) + ' sk-abcdefghijklmnopqrstuvwxyz1234567890'); f.advance(500);
        const json = JSON.stringify(await pending); t.false(json.includes('sk-abcdefghijklmnopqrs')); t.true(json.includes('"truncated":'));
    } finally { Object.defineProperty(globalThis, 'HTMLElement', { value: previous, configurable: true }); }
});

test.serial('F4c 7: detached event handlers never read event getters', async t => {
    const previous = globalThis.HTMLElement; Object.defineProperty(globalThis, 'HTMLElement', { value: Element, configurable: true });
    try {
        const f = fixture(); const pending = f.call(); await f.observed;
        const error = f.listeners.get('error')!; const rejection = f.listeners.get('unhandledrejection')!;
        f.advance(500); const result = await pending; let reads = 0;
        error({ get error() { reads++; return null; }, get message() { reads++; return ''; } } as never);
        rejection({ get reason() { reads++; return null; } } as never);
        t.true(JSON.stringify(result).includes('"success":true')); t.is(reads, 0); t.is(f.listeners.size, 0);
    } finally { Object.defineProperty(globalThis, 'HTMLElement', { value: previous, configurable: true }); }
});

test.serial('F4c 8: 5000 large errors leave bounded copied strings and truncation flags', async t => {
    const previous = globalThis.HTMLElement; Object.defineProperty(globalThis, 'HTMLElement', { value: Element, configurable: true });
    try {
        const f = fixture(); const pending = f.call(); await f.observed;
        const large = 'error '.repeat(16666) + 'abcd'; for (let i = 0; i < 5000; i++) f.win.console.error(large);
        f.advance(500); const result = await pending;
        if (!result || typeof result !== 'object' || !('data' in result)) return t.fail('missing result');
        const data = result.data as { global_errors: { text: string; truncated: boolean }[]; global_errors_truncated: boolean };
        t.true(data.global_errors.length > 0 && data.global_errors.length <= 20); t.true(data.global_errors.reduce((sum, e) => sum + e.text.length, 0) <= 20000);
        t.true(data.global_errors[0].truncated); t.true(data.global_errors_truncated); t.is(f.timers.size, 0);
    } finally { Object.defineProperty(globalThis, 'HTMLElement', { value: previous, configurable: true }); }
});
