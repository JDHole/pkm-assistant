import test from 'ava';
import { createWorkspacePort } from './index.js';

test.serial('host removes global listeners and restores console.error after success, timeout, Stop, unload and observer failure', async t => {
    const oldElement = globalThis.HTMLElement;
    class Element { ownerDocument!: unknown; querySelectorAll() { return []; } }
    Object.defineProperty(globalThis, 'HTMLElement', { value: Element, configurable: true });
    try {
        let listeners = 0; let disconnects = 0; let fail = false;
        class Observer { observe() { if (fail) throw new Error('failed'); } disconnect() { disconnects++; } }
        const original = () => {};
        const win = { MutationObserver: Observer, console: { error: original }, setTimeout, clearTimeout,
            addEventListener: () => { listeners++; }, removeEventListener: () => { listeners--; } };
        const content = new Element(); content.ownerDocument = { defaultView: win };
        let state = { file: 'A.md', mode: 'source' };
        const leaf = { isDeferred: false, view: { contentEl: content, previewMode: { containerEl: content }, containerEl: {}, getViewType: () => 'markdown' },
            getViewState: () => ({ type: 'markdown', state }), setViewState: async (value: { state: typeof state }) => { state = value.state; } };
        const app = { workspace: { getMostRecentLeaf: () => leaf, iterateAllLeaves: (fn: (v: unknown) => void) => fn(leaf), getActiveFile: () => ({ path: 'A.md' }) }, vault: {} };
        const make = () => createWorkspacePort(app as never, (_value): _value is never => false, { renderCheck: 'enabled' });
        const port = make();
        const success = await port.observeRender!('A.md', 1000, new AbortController().signal);
        t.true(success.stabilized); t.is(success.mode, 'preview'); t.is(win.console.error, original); t.is(listeners, 0);
        const timeout = await port.observeRender!('A.md', 1, new AbortController().signal);
        t.false(timeout.stabilized); t.is(win.console.error, original); t.is(listeners, 0);
        const controller = new AbortController();
        const stopped = port.observeRender!('A.md', 1000, controller.signal); await Promise.resolve(); controller.abort();
        await t.throwsAsync(stopped); t.is(win.console.error, original); t.is(listeners, 0);
        const unloaded = port.observeRender!('A.md', 1000, new AbortController().signal); await Promise.resolve(); port.dispose!();
        await t.throwsAsync(unloaded); t.is(win.console.error, original); t.is(listeners, 0);
        fail = true;
        await t.throwsAsync(make().observeRender!('A.md', 1000, new AbortController().signal));
        t.is(win.console.error, original); t.is(listeners, 0); t.is(disconnects, 5);
    } finally { Object.defineProperty(globalThis, 'HTMLElement', { value: oldElement, configurable: true }); }
});

test.serial('wrapped console forwards without converting after cleanup', async t => {
    const oldElement = globalThis.HTMLElement;
    class Element { ownerDocument!: unknown; querySelectorAll() { return []; } }
    Object.defineProperty(globalThis, 'HTMLElement', { value: Element, configurable: true });
    try {
        let calls = 0; let conversions = 0;
        class Observer { observe() {} disconnect() {} }
        const original = (..._args: unknown[]) => { calls++; };
        const win = { MutationObserver: Observer, console: { error: original }, setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} };
        const content = new Element(); content.ownerDocument = { defaultView: win };
        let state = { file: 'A.md', mode: 'preview' };
        const leaf = { view: { previewMode: { containerEl: content }, getViewType: () => 'markdown' }, getViewState: () => ({ state }), setViewState: async (v: { state: typeof state }) => { state = v.state; } };
        const app = { workspace: { getMostRecentLeaf: () => leaf, iterateAllLeaves: (fn: (v: unknown) => void) => fn(leaf), getActiveFile: () => ({ path: 'A.md' }) }, vault: {} };
        const port = createWorkspacePort(app as never, (_v): _v is never => false, { renderCheck: 'enabled' });
        const pending = port.observeRender!('A.md', 10, new AbortController().signal);
        await Promise.resolve();
        const wrapper = win.console.error;
        win.console.error = (...args: unknown[]) => wrapper(...args);
        const result = await pending;
        win.console.error({ toString: () => { conversions++; return 'late'; } });
        t.is(calls, 1); t.is(conversions, 0); t.deepEqual(result.errors, []);
    } finally { Object.defineProperty(globalThis, 'HTMLElement', { value: oldElement, configurable: true }); }
});

test.serial('host refuses to inspect a view that remains in source mode', async t => {
    const oldElement = globalThis.HTMLElement;
    class Element { ownerDocument = {}; }
    Object.defineProperty(globalThis, 'HTMLElement', { value: Element, configurable: true });
    try {
        const root = new Element();
        const leaf = { view: { previewMode: { containerEl: root }, getViewType: () => 'markdown' }, getViewState: () => ({ state: { file: 'A.md', mode: 'source' } }), setViewState: async () => {} };
        const app = { workspace: { getMostRecentLeaf: () => leaf, iterateAllLeaves: (fn: (v: unknown) => void) => fn(leaf), getActiveFile: () => ({ path: 'A.md' }) }, vault: {} };
        const port = createWorkspacePort(app as never, (_v): _v is never => false, { renderCheck: 'enabled' });
        await t.throwsAsync(port.observeRender!('A.md', 5, new AbortController().signal), { message: 'Reading mode unavailable' });
    } finally { Object.defineProperty(globalThis, 'HTMLElement', { value: oldElement, configurable: true }); }
});
