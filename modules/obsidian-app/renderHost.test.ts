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
        const leaf = { isDeferred: false, view: { contentEl: content, containerEl: {}, getViewType: () => 'markdown' },
            getViewState: () => ({ type: 'markdown', state }), setViewState: async (value: { state: typeof state }) => { state = value.state; } };
        const app = { workspace: { getMostRecentLeaf: () => leaf, iterateAllLeaves: (fn: (v: unknown) => void) => fn(leaf), getActiveFile: () => ({ path: 'A.md' }) }, vault: {} };
        const make = () => createWorkspacePort(app as never, (_value): _value is never => false);
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
