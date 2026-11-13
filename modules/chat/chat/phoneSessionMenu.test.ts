import test, { type ExecutionContext } from 'ava';
import { register } from 'node:module';
import { Platform, Modal } from 'obsidian';
import { setLocale } from '../../../core/i18n/index.js';
import { AgentMemory } from '../../memory/index.js';
import { SvgHelper } from '../../crystal-soul/index.js';
import { log } from '../../../core/utils/Logger.js';
import type { ChatViewLike } from './chatViewShape.js';

// Reuse the harness Menu, including its opened/close lifecycle. Only record events/notices.
const hostSource = `
export * from 'obsidian';
import { Notice as BaseNotice, Menu as BaseMenu } from 'obsidian';
export const notices = [], menus = [];
export const getOpenMenus = () => BaseMenu.opened;
export class Notice extends BaseNotice {
    constructor(message, timeout) { super(message, timeout); notices.push(message); }
}
export class Menu extends BaseMenu {
    showAtMouseEvent(event) { this.event = event; menus.push(this); return super.showAtMouseEvent(event); }
}`;
const hostUrl = 'data:text/javascript,' + encodeURIComponent(hostSource);
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
    if (specifier === 'obsidian' && context.parentURL !== ${JSON.stringify(hostUrl)})
        return { url: ${JSON.stringify(hostUrl)}, shortCircuit: true };
    return next(specifier, context);
}
export async function load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true };
    return next(url, context);
}`));
type Item = { title: string; icon: string; disabled: boolean; callback(): Promise<void> | void };
type HostMenu = { items: (Item | 'separator')[]; event: Event; close(): void };
const host = await import('obsidian') as unknown as typeof import('obsidian') & {
    menus: HostMenu[]; notices: string[]; getOpenMenus(): HostMenu[];
};
const { ChatView } = await import('../chat_view.js');
const { SessionCloseModal } = await import('../SessionCloseModal.js');
const { SaveSessionModal } = await import('../SaveSessionModal.js');

const patched = new WeakSet<HTMLElement>();
function browserEvents(el: HTMLElement): HTMLElement {
    if (patched.has(el)) return el;
    patched.add(el);
    el.querySelector = ((selector: string) => descendants(el).slice(1).find(child =>
        selector.startsWith('.') && child.className.split(' ').includes(selector.slice(1))) ?? null) as typeof el.querySelector;
    el.querySelectorAll = ((selector: string) => descendants(el).slice(1).filter(child =>
        selector.startsWith('.') && child.className.split(' ').includes(selector.slice(1)))) as unknown as typeof el.querySelectorAll;
    el.classList.add = (...names) => { el.className = [...new Set([...el.className.split(' ').filter(Boolean), ...names])].join(' '); };
    el.classList.remove = (...names) => { el.className = el.className.split(' ').filter(name => !names.includes(name)).join(' '); };
    el.classList.contains = name => el.className.split(' ').includes(name);
    el.classList.toggle = (name, force) => { const value = force ?? !el.classList.contains(name); if (value) el.classList.add(name); else el.classList.remove(name); return value; };
    el.addClass = (...names) => el.classList.add(...names);
    el.removeClass = (...names) => el.classList.remove(...names);
    const attributes = new Map<string, string>();
    el.setAttribute = (key, value) => { attributes.set(key, value); };
    el.getAttribute = key => attributes.get(key) ?? null;
    const events = new EventTarget();
    el.addEventListener = events.addEventListener.bind(events);
    el.removeEventListener = events.removeEventListener.bind(events);
    el.dispatchEvent = events.dispatchEvent.bind(events);
    Object.defineProperty(el, 'firstChild', { configurable: true, get: () => el.children[0] ?? null });
    Object.defineProperty(el, 'parentElement', { configurable: true, writable: true, value: null });
    const append = el.appendChild.bind(el);
    el.appendChild = ((child: HTMLElement) => {
        child.parentElement?.removeChild(child);
        Object.defineProperty(child, 'parentElement', { configurable: true, writable: true, value: el });
        return append(child);
    }) as typeof el.appendChild;
    const div = el.createDiv.bind(el), span = el.createSpan.bind(el), create = el.createEl.bind(el);
    const decorate = (child: HTMLElement, options: unknown) => {
        browserEvents(child);
        Object.defineProperty(child, 'parentElement', { configurable: true, writable: true, value: el });
        if (options && typeof options === 'object' && 'attr' in options && options.attr) {
            for (const [key, value] of Object.entries(options.attr)) child.setAttribute(key, String(value));
        }
        return child;
    };
    el.createDiv = options => decorate(div(options), options) as HTMLDivElement;
    el.createSpan = options => decorate(span(options), options) as HTMLSpanElement;
    el.createEl = ((tag, options) => decorate(create(tag, options), options)) as typeof el.createEl;
    return el;
}
function descendants(el: Element): Element[] { return [el, ...Array.from(el.children).flatMap(descendants)]; }
async function until<T>(read: () => T | undefined): Promise<T> {
    for (let i = 0; i < 200; i++) {
        const value = read();
        if (value !== undefined) return value;
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    throw new Error('UI did not settle');
}
async function fixture(t: ExecutionContext, platform = 'phone', locale = 'en') {
    Platform.isPhone = platform === 'phone'; Platform.isMobile = platform !== 'desktop'; setLocale(locale);
    host.notices.length = 0; host.menus.length = 0;
    for (const menu of host.getOpenMenus()) menu.close();
    const div = globalThis.createDiv;
    globalThis.createDiv = ((...args: Parameters<typeof createDiv>) => browserEvents(div(...args))) as typeof createDiv;
    const windowEvents = new EventTarget();
    window.addEventListener = windowEvents.addEventListener.bind(windowEvents);
    window.removeEventListener = windowEvents.removeEventListener.bind(windowEvents);
    const files = new Map<string, string>(), dirs = new Set<string>();
    const adapter = {
        exists: async (path: string) => files.has(path) || dirs.has(path),
        read: async (path: string) => { const text = files.get(path); if (text === undefined) throw new Error('missing'); return text; },
        write: async (path: string, text: string) => { files.set(path, text); },
        append: async (path: string, text: string) => { files.set(path, (files.get(path) ?? '') + text); },
        remove: async (path: string) => { files.delete(path); }, mkdir: async (path: string) => { dirs.add(path); },
        list: async (path: string) => ({ files: [...files.keys()].filter(p => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/')), folders: [] }),
    };
    const memory = new AgentMemory({ adapter }, 'Mira');
    await memory.ensureMemoryStructure();
    const agent = { name: 'Mira', color: '#123456' };
    const app = { workspace: { getActiveFile: () => null }, vault: { adapter, getMarkdownFiles: () => [], getAllLoadedFiles: () => [] } };
    const settings = { pkmAssistant: { enableOczko: false, enableAutoSummarization: false } };
    const plugin = { app, env: { settings }, settings, agentManager: {
        getActiveAgent: () => agent, getAgent: () => agent, getActiveAgentSkills: () => [], getAllAgents: () => [agent],
        getActiveMemory: () => memory, getAgentMemory: () => memory, switchAgent() {},
    } };
    const opened: Modal[] = [];
    const open = Modal.prototype.open, close = Modal.prototype.close, svg = SvgHelper.toElement;
    Modal.prototype.open = function () { browserEvents(this.contentEl); opened.push(this); this.onOpen(); };
    Modal.prototype.close = function () { this.onClose(); };
    SvgHelper.toElement = () => document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const view = new ChatView({ app, id: 'session-menu' }, plugin as never) as ChatViewLike;
    browserEvents(view.container);
    await view.renderView();
    t.teardown(() => {
        view._dismissPhoneSessionMenu();
        view.attachmentManager?.destroy(); view.mentionAutocomplete?.destroy(); view._tokenViewer?.closePopover();
        view._closeTriggerPopup();
        Modal.prototype.open = open; Modal.prototype.close = close; SvgHelper.toElement = svg;
        globalThis.createDiv = div; Platform.isPhone = false; Platform.isMobile = false; setLocale('en');
    });
    const grid = () => view._slimBar!.children[0].children[1];
    const sidebarIndex: Record<string, number> = { new: 0, close: 1, save: 2, consolidate: 3, summarize: 4 };
    const menuIndex: Record<string, number> = { new: 0, save: 1, close: 2, summarize: 4, consolidate: 5, artifacts: 7, tokens: 8 };
    async function menu() {
        const count = host.menus.length;
        const button = view.container.querySelector('.cs-chat-menu')!;
        const event = new Event('click'); button.dispatchEvent(event);
        const result = await until(() => host.menus[count]);
        t.is(result.event, event);
        return result;
    }
    async function invoke(entry: 'menu' | 'sidebar', id: string) {
        if (entry === 'menu') {
            const item = (await menu()).items[menuIndex[id]];
            if (item === 'separator') throw new Error('Expected menu action');
            if (!item.disabled) await item.callback();
        } else {
            grid().children[sidebarIndex[id]].dispatchEvent(new Event('click'));
        }
    }
    return { view, memory, files, opened, grid, menu, invoke };
}

for (const platform of ['phone', 'tablet', 'desktop']) for (const locale of ['pl', 'en']) {
    test.serial(`U2 topbar and literal unchanged sidebar DOM: ${platform}/${locale}`, async t => {
        const f = await fixture(t, platform, locale);
        t.deepEqual(Array.from(f.grid().children).map(el => [el.tagName.toLowerCase(), el.className, el.getAttribute('data-tip')]),
            (locale === 'pl' ? ['Nowy chat', 'Zamknij chat', 'Zapisz sesję', 'Konsolidacja', 'Sumaryzuj chat'] :
                ['New chat', 'Close chat', 'Save session', 'Consolidate', 'Summarize chat']).map(label => ['div', 'cs-skillbar__icon', label]));
        const button = f.view.container.querySelector('.cs-chat-menu');
        if (platform === 'phone') {
            t.is(button?.parentElement?.className, 'cs-chat-topbar cs-root');
            t.is(button?.getAttribute('aria-label'), locale === 'pl' ? 'Menu rozmowy' : 'Conversation menu');
            t.deepEqual((await f.menu()).items.map(item => item === 'separator' ? item : [item.title, item.icon, item.disabled]),
                (locale === 'pl' ? ['Nowy chat', 'Zapisz sesję', 'Zamknij chat', 'separator', 'Sumaryzuj chat', 'Konsolidacja', 'separator', 'Artefakty', 'Kontekst tokenów'] :
                    ['New chat', 'Save session', 'Close chat', 'separator', 'Summarize chat', 'Consolidate', 'separator', 'Artifacts', 'Token Context'])
                    .map((label, i) => label === 'separator' ? label : [label, ['refresh-cw', 'save', 'x', '', 'layers', 'brain', '', 'clipboard', 'chart-pie'][i], false]));
        } else {
            t.is(button, null);
            t.deepEqual(Array.from(f.view.container.querySelector('.cs-chat-topbar')!.children).map(el => el.className),
                ['cs-tab cs-tab--active', 'cs-tab cs-tab--add', 'cs-topbar-tokens']);
        }
    });
}

for (const entry of ['menu', 'sidebar'] as const) {
    test.serial(`U2 ${entry}: save writes the real session transcript`, async t => {
        const f = await fixture(t);
        await f.view.rollingWindow.addMessage('user', 'Remember the blue notebook.');
        await f.view.rollingWindow.addMessage('assistant', 'The notebook is blue.');
        await f.invoke(entry, 'save');
        await until(() => f.memory.activeSessionPath && f.files.get(f.memory.activeSessionPath) ? true : undefined);
        const loaded = await f.memory.loadActiveSession(f.memory.activeSessionPath!);
        t.deepEqual(loaded.messages.map(m => m.content), ['Remember the blue notebook.', 'The notebook is blue.']);
    });
    test.serial(`U2 ${entry}: new conversation opens real archive/discard modal; cancel retains transcript`, async t => {
        const f = await fixture(t);
        await f.view.rollingWindow.addMessage('user', 'Keep this conversation.');
        const running = f.invoke(entry, 'new');
        const modal = await until(() => f.opened.find((m): m is InstanceType<typeof SessionCloseModal> => m instanceof SessionCloseModal));
        t.deepEqual([modal.agentName, modal.messageCount], ['Mira', 1]);
        t.deepEqual(descendants(modal.contentEl).filter(el => el.tagName.toLowerCase() === 'button').map(el => el.className),
            ['cs-session-close__btn cs-session-close__btn--primary', 'cs-session-close__btn cs-session-close__btn--cancel', 'cs-session-close__btn cs-session-close__btn--cancel']);
        modal.contentEl.children[3].children[0].dispatchEvent(new Event('click'));
        await running;
        t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Keep this conversation.']);
    });
    test.serial(`U2 ${entry}: close persists messages and clears the last conversation`, async t => {
        const f = await fixture(t);
        await f.view.rollingWindow.addMessage('user', 'Save before closing.');
        const oldWindow = f.view.rollingWindow;
        await f.invoke(entry, 'close');
        await until(() => f.view.rollingWindow !== oldWindow ? true : undefined);
        t.deepEqual((await f.memory.loadActiveSession(f.memory.activeSessionPath!)).messages.map(m => m.content), ['Save before closing.']);
        t.deepEqual(f.view.rollingWindow.messages, []);
        t.deepEqual(f.view.chatTabs.map(tab => [tab.agentName, tab.isActive]), [['Mira', true]]);
    });
    for (const generating of [false, true]) {
        test.serial(`U2 ${entry}: summarize result and notices, generating=${generating}`, async t => {
            const f = await fixture(t);
            for (const content of ['one', 'two', 'three', 'four']) await f.view.rollingWindow.addMessage('user', content);
            f.view.is_generating = generating;
            f.view.rollingWindow.performTwoPhaseCompression = async () => {
                f.view.rollingWindow.messages.splice(0, 2);
                return { phase: 1, trimDetails: [], savedChars: 0, summaryFailed: false, summarized: false, trimmed: 2 };
            };
            await f.invoke(entry, 'summarize');
            await until(() => host.notices.length ? true : undefined);
            t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['three', 'four']);
            t.deepEqual(host.notices, ['Trimmed 2 tool results (no API call)']);
            t.is(f.grid().children[4].className, 'cs-skillbar__icon');
        });
        test.serial(`U2 ${entry}: consolidate opens the same review, generating=${generating}`, async t => {
            const f = await fixture(t);
            await f.view.rollingWindow.addMessage('user', 'one'); await f.view.rollingWindow.addMessage('assistant', 'two');
            f.view.is_generating = generating;
            f.view.consolidateSession = async () => { new SaveSessionModal(f.view.app, { agentName: 'Mira', messageCount: 2 }).open(); };
            await f.invoke(entry, 'consolidate');
            await until(() => host.notices.length === 2 ? true : undefined);
            t.deepEqual(host.notices, ['Consolidating memory...', 'Memory saved!']);
            t.deepEqual(f.opened.map(modal => modal.contentEl.className), ['cs-save-session-modal pkm-review']);
            t.is(f.grid().children[3].className, 'cs-skillbar__icon');
        });
    }
    for (const disk of [false, true]) test.serial(`U2 ${entry}: consolidation eligibility with disk=${disk}`, async t => {
        const f = await fixture(t);
        f.memory.getUnconsolidatedSessions = async () => disk ? [{ path: 'older.md' } as never] : [];
        f.view.consolidateSession = async () => { new SaveSessionModal(f.view.app, { agentName: 'Mira' }).open(); };
        await f.invoke(entry, 'consolidate');
        await until(() => host.notices.length === (disk ? 2 : 1) ? true : undefined);
        t.deepEqual(host.notices, disk ? ['Consolidating memory...', 'Memory saved!'] : ['No sessions to consolidate']);
        t.deepEqual(f.opened.map(modal => modal.contentEl.className), disk ? ['cs-save-session-modal pkm-review'] : []);
    });
}

for (const entry of ['menu', 'sidebar'] as const) for (const action of ['new', 'consolidate', 'summarize'] as const) {
    test.serial(`U2 ${entry}: ${action} failure reports the existing notice and clears busy`, async t => {
        const f = await fixture(t);
        for (const content of ['one', 'two', 'three', 'four']) await f.view.rollingWindow.addMessage('user', content);
        const fail = async () => { throw new Error('test failure'); };
        if (action === 'new') f.view.handleNewSession = fail;
        else if (action === 'consolidate') f.view.consolidateSession = fail;
        else f.view.rollingWindow.performTwoPhaseCompression = fail;
        await f.invoke(entry, action);
        const expected = action === 'new' ? ['Could not start a new conversation. Check whether the session was archived.'] :
            action === 'consolidate' ? ['Consolidating memory...', 'Memory consolidation error'] : ['Context summarization error'];
        await until(() => host.notices.length === expected.length ? true : undefined);
        t.deepEqual(host.notices, expected);
        t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['one', 'two', 'three', 'four']);
        t.deepEqual(Array.from(f.grid().children).map(el => el.className), Array(5).fill('cs-skillbar__icon'));
    });
}

test.serial('U2 busy is shared with a reopened menu, and is not a new action lock', async t => {
    const f = await fixture(t);
    for (const content of ['one', 'two', 'three', 'four']) await f.view.rollingWindow.addMessage('user', content);
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    f.view.rollingWindow.performTwoPhaseCompression = async () => { await pending; return { phase: 1, trimDetails: [], savedChars: 0, summaryFailed: false, summarized: false, trimmed: 0 }; };
    await f.invoke('sidebar', 'summarize');
    t.is(f.grid().children[4].className, 'cs-skillbar__icon cs-skillbar__icon--busy');
    const item = (await f.menu()).items[4] as Item;
    t.deepEqual([item.title, item.icon, item.disabled], ['Summarize chat', 'loader', false]);
    finish();
    await until(() => host.notices.length ? true : undefined);
    t.deepEqual(host.notices, ['Nothing to summarize']);
    t.is(f.grid().children[4].className, 'cs-skillbar__icon');
    t.is(((await f.menu()).items[4] as Item).icon, 'layers');
});

test.serial('U2 menu opens real artifact picker and token viewer; artifacts retain generation guard', async t => {
    const f = await fixture(t);
    f.view.is_generating = true;
    t.deepEqual((await f.menu()).items.filter((item): item is Item => item !== 'separator').map(item => [item.title, item.disabled]),
        [['New chat', false], ['Save session', false], ['Close chat', false], ['Summarize chat', false], ['Consolidate', false], ['Artifacts', true], ['Token Context', false]]);
    f.view.is_generating = false;
    // Real picker can attach to the real input panel in this local DOM boundary.
    f.view.input_area.closest = (() => f.view._inputRow!.parentElement) as typeof f.view.input_area.closest;
    await f.invoke('menu', 'artifacts');
    t.deepEqual(descendants(f.view._chatBody!).filter(el => el.className === 'pkm-trigger-picker__empty').map(el => el.textContent), ['No artifacts for this agent.']);
    await f.invoke('menu', 'tokens');
    t.deepEqual(descendants(f.view._chatBody!).filter(el => el.className === 'cs-token-popover__title').map(el => el.textContent), ['Token Context']);
});

for (const [section, marker] of [['skills', '@@skill:daily'], ['sub-agents', '@sub-agent:mira-helper'], ['mcp', '@@tool:docs__search']] as const) {
    test.serial(`U2 slash ${section}: direct tap-generated mousedown selects the row without hover`, async t => {
        const f = await fixture(t);
        Object.assign(f.view.plugin.agentManager!, {
            getActiveAgentSkills: () => [{ name: 'daily', slug: 'daily' }],
            subAgentLoader: { getAllSubAgents: () => [{ name: 'mira-helper', description: 'helper' }] },
        });
        f.view.plugin.toolRegistry = { filterByAgent: () => [{ name: 'docs__search', source: 'user', serverName: 'docs' }] } as never;
        f.view.input_area.value = '/'; f.view.input_area.selectionStart = 1;
        f.view._openTriggerPopup(0);
        const popup = f.view._triggerPopup!;
        const index = popup.filteredItems.findIndex(item => item.section === section);
        t.true(index > 0, 'tap targets a row other than the initially selected one');
        const row = descendants(popup.popupEl!).find(el => el.className.includes('pkm-trigger-popup__item') && (el as HTMLElement).dataset.index === String(index))!;
        row.dispatchEvent(new Event('mousedown', { cancelable: true }));
        t.is(f.view.input_area.value, marker + ' ');
        t.is(popup.isOpen(), false);
    });
}

test.serial('U3 closing ChatView closes its menu before pending admission and ignores stale actions', async t => {
    const f = await fixture(t);
    await f.view.rollingWindow.addMessage('user', 'Keep the closed conversation.');
    const menu = await f.menu();
    t.deepEqual(host.getOpenMenus(), [menu]);
    let finish!: () => void;
    f.view._waitForSendAdmissions = () => new Promise<void>(resolve => { finish = resolve; });
    const closing = f.view.onClose();
    try {
        t.is(host.getOpenMenus().length, 0);
        // Even a retained native callback cannot close the conversation or open UI.
        for (const index of [2, 7, 8]) await (menu.items[index] as Item).callback();
        t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Keep the closed conversation.']);
        t.is(f.view.container.querySelector('.cs-token-popover'), null);
        t.is(f.view.container.querySelector('.pkm-trigger-picker'), null);
    } finally { finish(); await closing; }
    t.deepEqual((await f.memory.loadActiveSession(f.memory.activeSessionPath!)).messages.map(m => m.content),
        ['Keep the closed conversation.']);
});

for (const rebuild of ['init', 'topbar', 'view'] as const) {
    test.serial(`U3 ${rebuild} rebuild dismisses the old menu and invalidates its actions`, async t => {
        const f = await fixture(t);
        await f.view.rollingWindow.addMessage('user', 'Still the current conversation.');
        const menu = await f.menu();
        t.deepEqual(host.getOpenMenus(), [menu]);
        if (rebuild === 'init') f.view._initTabs();
        else if (rebuild === 'topbar') f.view._renderTabBar(f.view._tabBarContainer!);
        else await f.view.renderView();
        t.is(host.getOpenMenus().length, 0);
        await (menu.items[2] as Item).callback();
        t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Still the current conversation.']);
        const current = await f.menu();
        await (current.items[2] as Item).callback();
        t.deepEqual((await f.memory.loadActiveSession(f.memory.activeSessionPath!)).messages.map(m => m.content),
            ['Still the current conversation.']);
        t.deepEqual(f.view.rollingWindow.messages, []);
    });
}

for (const boundary of ['close', 'rebuild'] as const) {
    test.serial(`U3 lazy menu import cannot open after ${boundary}`, async t => {
        const f = await fixture(t);
        const previous = await f.menu();
        t.deepEqual(host.getOpenMenus(), [previous]);
        const button = f.view.container.querySelector('.cs-chat-menu')!;
        // import().then always yields, even when the module is already cached.
        button.dispatchEvent(new Event('click'));
        if (boundary === 'close') await f.view.onClose();
        else await f.view.renderView();
        await import('./phoneSessionMenu.js');
        await new Promise<void>(resolve => setImmediate(resolve));
        button.dispatchEvent(new Event('click')); // Detached/closed entry is inert too.
        await new Promise<void>(resolve => setImmediate(resolve));
        t.deepEqual(host.menus, [previous]);
        t.is(host.getOpenMenus().length, 0);
        if (boundary === 'rebuild') {
            const current = await f.menu();
            t.deepEqual(host.getOpenMenus(), [current]);
        }
    });
}

for (const entry of ['menu', 'sidebar'] as const) {
    test.serial(`U3 ${entry}: close failure is caught and logged, retaining the conversation`, async t => {
        const f = await fixture(t);
        await f.view.rollingWindow.addMessage('user', 'Retain on close failure.');
        const warnings: unknown[][] = [];
        const warn = log.warn;
        log.warn = (...args) => { if (args[0] === 'Chat') warnings.push(args); };
        t.teardown(() => { log.warn = warn; });
        // Real close handler reaches this boundary after capturing the active session.
        f.view._createRollingWindow = () => { throw new Error('close failed'); };
        await f.invoke(entry, 'close');
        await until(() => warnings.length ? true : undefined);
        t.deepEqual(warnings, [['Chat', 'Close tab failed: close failed']]);
        t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Retain on close failure.']);
        t.deepEqual((await f.memory.loadActiveSession(f.memory.activeSessionPath!)).messages.map(m => m.content),
            ['Retain on close failure.']);
    });
}
