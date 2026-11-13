import test from 'ava';
import { register } from 'node:module';
import { Platform, MarkdownRenderer } from 'obsidian';
import { setLocale } from '../../../core/i18n/index.js';
import type { ChatViewLike } from './chatViewShape.js';
import { bottomOcclusion, phoneKeyboardGeometry } from './phoneKeyboard.js';
import { phoneHistoryPending, renderPhoneHistory } from './phoneHistoryScroll.js';

register('data:text/javascript,' + encodeURIComponent(`export async function load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true };
    return next(url, context);
}`));
const { ChatView } = await import('../chat_view.js');

// Only the browser event boundary is replaced; renderView installs the real listeners.
function browserEvents(el: HTMLElement): void {
    const attributes = new Map<string, string>();
    el.setAttribute = (name, value) => { attributes.set(name, value); };
    el.getAttribute = name => attributes.get(name) ?? null;
    const target = new EventTarget();
    el.addEventListener = target.addEventListener.bind(target);
    el.removeEventListener = target.removeEventListener.bind(target);
    el.dispatchEvent = target.dispatchEvent.bind(target);
    const div = el.createDiv.bind(el), span = el.createSpan.bind(el), create = el.createEl.bind(el);
    el.createDiv = options => { const child = div(options); Object.defineProperty(child, 'parentElement', { configurable: true, value: el }); browserEvents(child); return child; };
    el.createSpan = options => { const child = span(options); Object.defineProperty(child, 'parentElement', { configurable: true, value: el }); browserEvents(child); return child; };
    el.createEl = ((tag, options) => { const child = create(tag, options); Object.defineProperty(child, 'parentElement', { configurable: true, value: el }); browserEvents(child);
        if (options && typeof options === 'object' && options.attr) {
            for (const [name, value] of Object.entries(options.attr)) child.setAttribute(name, String(value));
        }
        return child; }) as typeof el.createEl;
}
function key(key: string, shiftKey = false) {
    return Object.assign(new Event('keydown', { cancelable: true }), { key, shiftKey });
}
async function fixture(t: import('ava').ExecutionContext, mobile: boolean, phone = false, locale = 'en', setup?: (root: HTMLElement) => void) {
    Platform.isMobile = mobile;
    Platform.isPhone = phone;
    t.teardown(() => { Platform.isMobile = false; Platform.isPhone = false; setLocale('en'); });
    setLocale(locale);
    const events = new EventTarget();
    window.addEventListener = events.addEventListener.bind(events);
    window.removeEventListener = events.removeEventListener.bind(events);
    const agent = { name: 'Mira' };
    const app = { workspace: { getActiveFile: () => null }, vault: {
        getMarkdownFiles: () => [{ path: 'Notes/Note.md', basename: 'Note' }], getAllLoadedFiles: () => [],
    } };
    const settings = { pkmAssistant: { enableOczko: false } };
    const plugin = { app, env: { settings }, settings,
        agentManager: { getActiveAgent: () => agent, getAgent: () => agent, getActiveAgentSkills: () => [], getAllAgents: () => [agent] } };
    const view = new ChatView({ app, id: 'mobile-input' }, plugin as never) as ChatViewLike;
    const sent: unknown[] = [];
    view.send_message = async options => { sent.push({ text: view.input_area.value, meta: options?.meta }); };
    browserEvents(view.container);
    setup?.(view.container);
    await view.renderView();
    t.teardown(async () => { await view.onClose(); });
    return { view, sent };
}

for (const mobile of [true, false]) for (const shift of [false, true]) {
    test.serial(`Enter through rendered input: mobile=${mobile}, shift=${shift}`, async t => {
        const { view, sent } = await fixture(t, mobile);
        view.input_area.value = 'First line';
        const event = key('Enter', shift);
        view.input_area.dispatchEvent(event);
        t.is(event.defaultPrevented, !mobile && !shift);
        t.deepEqual(sent, !mobile && !shift ? [{ text: 'First line', meta: { origin: 'human' } }] : []);
        t.is(view.input_area.value, 'First line');
        // A native newline is the browser's job; the button must still send multiline text.
        sent.length = 0;
        view.input_area.value = 'First line\nSecond line';
        view.send_button.dispatchEvent(new Event('click'));
        t.deepEqual(sent, [{ text: 'First line\nSecond line', meta: { origin: 'human' } }]);
    });
}

for (const mobile of [true, false]) for (const selectionKey of ['Enter', 'Tab']) {
    test.serial(`autocomplete survives mobile=${mobile}, ${selectionKey}`, async t => {
        const { view, sent } = await fixture(t, mobile);
        view.input_area.value = '@No';
        view.input_area.selectionStart = 3;
        view.input_area.dispatchEvent(new Event('input'));
        const mention = key(selectionKey);
        view.input_area.dispatchEvent(mention);
        t.true(mention.defaultPrevented);
        t.is(view.input_area.value, '@[Note] ');
        t.deepEqual(view.mentionAutocomplete!.getMentions().map(item => item.path), ['Notes/Note.md']);
        t.deepEqual(sent, []);

        view.input_area.value = '/cl';
        view.input_area.selectionStart = 3;
        view._openTriggerPopup(0);
        view._handleTriggerInput();
        const slash = key(selectionKey);
        view.input_area.dispatchEvent(slash);
        t.true(slash.defaultPrevented);
        t.is(view.input_area.value, '/clear ');
        t.deepEqual(sent, []);
    });
}

for (const platform of ['phone', 'tablet', 'desktop']) for (const locale of ['en', 'pl']) {
    test.serial(`U1 rendered Send/Stop labels and toolbar: ${platform}, ${locale}`, async t => {
        const { view, sent } = await fixture(t, platform !== 'desktop', platform === 'phone', locale);
        t.deepEqual([view.send_button.getAttribute('aria-label'), view.stop_button.getAttribute('aria-label')],
            locale === 'pl' ? ['Wyślij wiadomość', 'Zatrzymaj odpowiedź'] : ['Send message', 'Stop response']);
        t.is(view.send_button.parentElement?.className, platform === 'phone' ? 'cs-input-bar' : 'cs-input-bar__right');
        t.is(view.stop_button.parentElement, view.send_button.parentElement);
        t.is(view._autonomyBtn?.parentElement?.parentElement?.className,
            platform === 'phone' ? 'cs-input-bar__controls' : 'cs-input-bar');
        t.is(view._autonomyBtn?.getAttribute('aria-label'), locale === 'pl' ? 'Autonomia: Pytaj na krawędzi' : 'Autonomy: Ask at the edge');
        view.input_area.value = 'First line\nSecond line';
        view.send_button.dispatchEvent(new Event('click'));
        t.deepEqual(sent, [{ text: 'First line\nSecond line', meta: { origin: 'human' } }]);
    });
}

test.serial('U1 floating panel reserves its measured height on desktop/tablet; phone uses flow on re-render', async t => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    let resize: (height: number) => void = (_height: number) => { throw new Error('Observer not installed'); };
    let disconnected = 0;
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
        constructor(private callback: () => void) {}
        observe(panel: HTMLElement) {
            resize = height => { Object.defineProperty(panel, 'offsetHeight', { configurable: true, value: height }); this.callback(); };
        }
        disconnect() { disconnected++; }
    } });
    t.teardown(() => { if (descriptor) Object.defineProperty(globalThis, 'ResizeObserver', descriptor); else Reflect.deleteProperty(globalThis, 'ResizeObserver'); });
    const { view } = await fixture(t, false);
    resize(180);
    t.is(view.messages_container.style.paddingBottom, '204px');
    Platform.isMobile = true; // tablet keeps the floating panel, including queue/chip growth
    await view.renderView();
    resize(260);
    t.is(view.messages_container.style.paddingBottom, '284px');
    Platform.isPhone = true;
    await view.renderView();
    t.is(view.messages_container.style.paddingBottom, '');
    t.is(view.send_button.parentElement?.className, 'cs-input-bar');
    t.is(disconnected, 2);
});

test('U7 geometry: drawer gap, already resized main view, viewport fallback and pan', t => {
    t.is(bottomOcclusion(804, 679, 300), 175);
    t.is(bottomOcclusion(804, 504, 300), 0);
    t.is(bottomOcclusion(804, 679, 0), 0);
    t.deepEqual(phoneKeyboardGeometry(804, 679), { below: 125, fallback: 0 });
    t.deepEqual(phoneKeyboardGeometry(804, 504), { below: 300, fallback: 0 });
    t.deepEqual(phoneKeyboardGeometry(804, 679, { height: 504, offsetTop: 0 }), { below: 125, fallback: 300 });
    t.deepEqual(phoneKeyboardGeometry(804, 679, { height: 504, offsetTop: 24 }), { below: 125, fallback: 276 });
    t.deepEqual(phoneKeyboardGeometry(804, 679, { height: 804, offsetTop: 0 }), { below: 125, fallback: 0 });
});

function keyboardHost(t: import('ava').ExecutionContext) {
    class TrackedEvents extends EventTarget {
        listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
        override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
            if (listener) {
                if (!this.listeners.has(type)) this.listeners.set(type, new Set());
                this.listeners.get(type)!.add(listener);
            }
            super.addEventListener(type, listener);
        }
        override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
            if (listener) this.listeners.get(type)?.delete(listener);
            super.removeEventListener(type, listener);
        }
    }
    const win = Object.assign(new TrackedEvents(), { innerHeight: 804,
        visualViewport: Object.assign(new TrackedEvents(), { height: 804, offsetTop: 0 }) });
    const observers: Array<{ callback(): void; disconnected: boolean }> = [];
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
        entry: typeof observers[number];
        constructor(callback: () => void) { this.entry = { callback, disconnected: false }; observers.push(this.entry); }
        observe() {}
        disconnect() { this.entry.disconnected = true; }
    } });
    t.teardown(() => { if (descriptor) Object.defineProperty(globalThis, 'ResizeObserver', descriptor); else Reflect.deleteProperty(globalThis, 'ResizeObserver'); });
    const roots: Array<{ bottom: number; props: Map<string, string>; writes: number }> = [];
    const setup = (root: HTMLElement) => {
        const state = { bottom: 679, props: new Map<string, string>(), writes: 0 };
        roots.push(state);
        Object.defineProperty(root, 'ownerDocument', { configurable: true, value: { defaultView: win, activeElement: null } });
        root.getBoundingClientRect = () => ({ top: 0, bottom: state.bottom } as DOMRect);
        Object.defineProperty(root, 'style', { configurable: true, value: {
            setProperty(key: string, value: string) { state.props.set(key, value); state.writes++; },
            removeProperty(key: string) { const old = state.props.get(key) ?? ''; state.props.delete(key); return old; },
        } });
    };
    return { win, observers, roots, setup };
}

test.serial('U7 rendered view: native events, fallback, resize, independent views and synchronous close cleanup', async t => {
    const host = keyboardHost(t);
    const a = (await fixture(t, true, true, 'en', host.setup)).view;
    const b = (await fixture(t, true, true, 'en', host.setup)).view;
    const [first, second] = host.roots;
    t.is(host.win.listeners.get('keyboardWillShow')?.size, 2);
    t.is(host.win.visualViewport.listeners.get('resize')?.size, 2);
    t.is(first.props.get('--pkm-chat-below'), '125px');
    second.bottom = 504;
    host.win.dispatchEvent(new Event('keyboardWillShow'));
    t.deepEqual([first.props.get('--pkm-chat-below'), second.props.get('--pkm-chat-below')], ['125px', '300px']);
    host.win.visualViewport.height = 504;
    host.win.visualViewport.dispatchEvent(new Event('resize'));
    t.is(first.props.get('--pkm-chat-kb-fallback'), '300px');
    host.win.visualViewport.offsetTop = 24;
    host.win.visualViewport.dispatchEvent(new Event('scroll'));
    t.is(first.props.get('--pkm-chat-kb-fallback'), '276px');
    first.bottom = 600;
    host.win.dispatchEvent(new Event('resize'));
    t.is(first.props.get('--pkm-chat-below'), '204px');
    first.bottom = 679;
    host.observers[0].callback();
    t.is(first.props.get('--pkm-chat-below'), '125px');
    host.win.visualViewport.height = 804;
    host.win.visualViewport.offsetTop = 0;
    host.win.dispatchEvent(new Event('keyboardWillHide'));
    t.is(first.props.get('--pkm-chat-kb-fallback'), '0px');

    let release!: () => void;
    a._waitForSendAdmissions = () => new Promise<void>(resolve => { release = resolve; });
    const closing = a.onClose();
    const writes = first.writes;
    t.true(host.observers[0].disconnected);
    t.is(host.win.listeners.get('keyboardWillShow')?.size, 1);
    t.is(host.win.listeners.get('keyboardWillHide')?.size, 1);
    t.is(host.win.listeners.get('resize')?.size, 1);
    t.is(host.win.visualViewport.listeners.get('resize')?.size, 1);
    t.is(host.win.visualViewport.listeners.get('scroll')?.size, 1);
    host.win.visualViewport.height = 500;
    for (const event of ['keyboardWillShow', 'keyboardWillHide', 'resize']) host.win.dispatchEvent(new Event(event));
    for (const event of ['resize', 'scroll']) host.win.visualViewport.dispatchEvent(new Event(event));
    host.observers[0].callback(); // already queued browser delivery is also harmless
    a.container.dispatchEvent(new Event('focusin'));
    t.is(first.writes, writes);
    t.is(second.props.get('--pkm-chat-kb-fallback'), '304px');
    release();
    await closing;
    a._waitForSendAdmissions = async () => {};
    await b.renderView();
    t.true(host.observers[1].disconnected);
    second.bottom = 490;
    host.win.dispatchEvent(new Event('resize'));
    t.is(second.props.get('--pkm-chat-below'), '314px');
});

test.serial('U7 resizing preserves bottom pinning, but leaves a reader above the bottom in place', async t => {
    const host = keyboardHost(t);
    const { view } = await fixture(t, true, true, 'en', host.setup);
    const messages = view.messages_container;
    let height = 400;
    Object.defineProperty(messages, 'clientHeight', { configurable: true, get: () => height });
    Object.defineProperty(messages, 'scrollHeight', { configurable: true, value: 1200 });
    messages.scrollTo = options => { messages.scrollTop = (options as ScrollToOptions).top ?? 0; };
    messages.scrollTop = 800; // Start at the real bottom, not a stale pin from the empty installation.
    host.observers[0].callback();
    t.is(messages.scrollTop, 800);
    height = 225;
    host.observers[0].callback();
    t.is(messages.scrollTop, 975);
    height = 400;
    messages.scrollTop = 800; // browser clamps during keyboard hide, before ResizeObserver
    messages.dispatchEvent(new Event('scroll'));
    host.observers[0].callback();
    t.is(messages.scrollTop, 800);
    height = 225;
    host.observers[0].callback();
    t.is(messages.scrollTop, 975);
    messages.scrollTop = 200;
    messages.dispatchEvent(new Event('scroll'));
    height = 400;
    host.observers[0].callback();
    t.is(messages.scrollTop, 200);
});

test.serial('U7 desktop and tablet keep their geometry while phone popup selection uses the composer anchor', async t => {
    const host = keyboardHost(t);
    for (const mobile of [false, true]) {
        const { view } = await fixture(t, mobile, false, 'en', host.setup);
        view.input_area.value = '/cl';
        view.input_area.selectionStart = 3;
        view._openTriggerPopup(0);
        view._handleTriggerInput();
        view.input_area.dispatchEvent(key('Enter'));
        t.is(view.input_area.value, '/clear ');
        t.deepEqual([...host.roots.at(-1)!.props], []);
    }
    const { view } = await fixture(t, true, true, 'en', host.setup);
    view.input_area.value = '/cl';
    view.input_area.selectionStart = 3;
    view._openTriggerPopup(0);
    view._handleTriggerInput();
    t.true(Array.from(view.input_area.parentElement!.children).includes(view._triggerPopup!.popupEl!));
    view.input_area.dispatchEvent(key('Enter'));
    t.is(view.input_area.value, '/clear ');
    t.is(host.roots.at(-1)!.props.get('--pkm-chat-below'), '125px');
});


function measuredList(view: ChatViewLike, height: number, content: number, top: number) {
    const geometry = { height, content };
    const messages = view.messages_container;
    Object.defineProperties(messages, {
        clientHeight: { configurable: true, get: () => geometry.height },
        scrollHeight: { configurable: true, get: () => geometry.content },
    });
    messages.scrollTop = top;
    messages.scrollTo = options => { messages.scrollTop = (options as ScrollToOptions).top ?? 0; };
    return geometry;
}

test.serial('U9 smooth stream frame still follows the bottom when keyboard shrinks the list', async t => {
    const host = keyboardHost(t);
    const { view } = await fixture(t, true, true, 'en', host.setup);
    const geometry = measuredList(view, 400, 1200, 800);
    host.observers[0].callback();
    geometry.content = 1220;
    const requests: ScrollToOptions[] = [];
    view.messages_container.scrollTo = options => {
        const request = options as ScrollToOptions;
        requests.push(request);
        view.messages_container.scrollTop = request.behavior === 'smooth' ? 801 : request.top ?? 0;
        view.messages_container.dispatchEvent(new Event('scroll'));
    };
    view.scrollToBottom(true, { drawConnectors: false });
    t.deepEqual(requests, [{ top: 820, behavior: 'smooth' }]);
    t.is(view.messages_container.scrollTop, 801);
    geometry.height = 225;
    host.observers[0].callback();
    t.is(view.messages_container.scrollTop, 995);
    geometry.height = 400;
    host.observers[0].callback();
    t.is(view.messages_container.scrollTop, 820);
});

for (const top of [0, 3000]) {
    test.serial(`U9 keyboard respects reader at ${top} without any previous scroll events`, async t => {
        const host = keyboardHost(t);
        const { view } = await fixture(t, true, true, 'en', host.setup);
        const geometry = measuredList(view, 458, 6496, top);
        host.observers[0].callback();
        t.is(view.messages_container.scrollTop, top);
        geometry.height = 279;
        host.observers[0].callback();
        t.is(view.messages_container.scrollTop, top);
        geometry.height = 458;
        host.observers[0].callback();
        t.is(view.messages_container.scrollTop, top);
    });
}

function historyFrames(host: ReturnType<typeof keyboardHost>, view: ChatViewLike) {
    const frames = new Map<number, FrameRequestCallback>();
    let next = 0;
    Object.assign(host.win, {
        innerWidth: 360,
        requestAnimationFrame(callback: FrameRequestCallback) { frames.set(++next, callback); return next; },
        cancelAnimationFrame(id: number) { frames.delete(id); },
    });
    const rect = { left: 360, top: 0, width: 354, height: 679, right: 714, bottom: 679 };
    view.container.getBoundingClientRect = () => rect as DOMRect;
    Object.defineProperty(view.container, 'isConnected', { configurable: true, value: true });
    return {
        rect,
        queued: () => frames.size,
        tick() { const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback(0); },
        reveal() { rect.left = 0; rect.right = 354; host.observers[0].callback(); },
    };
}

async function restoreHistory(view: ChatViewLike) {
    const memory = {
        listActiveSessions: async () => [{ path: 'recent.md', name: 'recent.md', mtime: 2 }, { path: 'older.md', name: 'older.md', mtime: 1 }],
        loadActiveSession: async () => ({ messages: [{ role: 'user', content: 'Question' }, { role: 'assistant', content: 'Latest answer' }], metadata: {} }),
        setActiveSessionIdentity() {},
    };
    Object.assign(view.plugin.agentManager!, { getAgentMemory: () => memory, switchAgent() {} });
    await view._restoreActiveSession();
}

for (const [position, expected] of [['bottom', 6098], [0, 0], [3000, 3000]] as const) {
    test.serial(`U10 changing history geometry finishes once at ${position} after 60 visible frames`, async t => {
        const host = keyboardHost(t);
        const { view } = await fixture(t, true, true, 'en', host.setup);
        const frames = historyFrames(host, view);
        const geometry = measuredList(view, 458, 6496, 1200);
        const calls: ScrollToOptions[] = [];
        view.messages_container.scrollTo = options => {
            const call = options as ScrollToOptions;
            calls.push(call);
            view.messages_container.scrollTop = call.top ?? 0;
        };
        await renderPhoneHistory(view, position);
        frames.reveal();
        for (let i = 0; i < 59; i++) { geometry.content++; frames.tick(); }
        t.is(view.messages_container.scrollTop, 1200);
        t.true(phoneHistoryPending(view.messages_container));
        t.is(frames.queued(), 1);
        t.deepEqual(calls, []);
        geometry.content++;
        frames.tick();
        t.is(view.messages_container.scrollTop, expected);
        t.deepEqual(calls, [{ top: expected, behavior: 'instant' }]);
        t.false(phoneHistoryPending(view.messages_container));
        t.is(frames.queued(), 0);
        for (let i = 0; i < 100; i++) { geometry.content++; frames.tick(); }
        host.observers[0].callback();
        t.deepEqual(calls, [{ top: expected, behavior: 'instant' }]);
        t.is(frames.queued(), 0);
    });
}

for (const event of ['touchstart', 'pointerdown', 'wheel', 'keydown']) {
    test.serial(`U10 reader ${event} cancels changing geometry just before the limit`, async t => {
        const host = keyboardHost(t);
        const { view } = await fixture(t, true, true, 'en', host.setup);
        const frames = historyFrames(host, view);
        const geometry = measuredList(view, 458, 6496, 1200);
        const calls: ScrollToOptions[] = [];
        view.messages_container.scrollTo = options => { calls.push(options as ScrollToOptions); };
        await renderPhoneHistory(view);
        frames.reveal();
        for (let i = 0; i < 59; i++) { geometry.content++; frames.tick(); }
        t.true(phoneHistoryPending(view.messages_container));
        t.is(frames.queued(), 1);
        view.messages_container.dispatchEvent(event === 'keydown' ? key('PageUp') : new Event(event));
        view.messages_container.scrollTop = 3000;
        for (let i = 0; i < 100; i++) { geometry.content++; frames.tick(); }
        host.observers[0].callback();
        t.is(view.messages_container.scrollTop, 3000);
        t.deepEqual(calls, []);
        t.false(phoneHistoryPending(view.messages_container));
        t.is(frames.queued(), 0);
        // Cancellation also resets the budget for the next history request.
        await renderPhoneHistory(view, 1200);
        for (let i = 0; i < 59; i++) { geometry.content++; frames.tick(); }
        t.true(phoneHistoryPending(view.messages_container));
        t.deepEqual(calls, []);
        geometry.content++;
        frames.tick();
        t.deepEqual(calls, [{ top: 1200, behavior: 'instant' }]);
        t.false(phoneHistoryPending(view.messages_container));
        t.is(frames.queued(), 0);
    });
}

for (const hidden of ['drawer', 'zero-size']) {
    test.serial(`U10 hidden ${hidden} pauses the visible frame budget without polling`, async t => {
        const host = keyboardHost(t);
        const { view } = await fixture(t, true, true, 'en', host.setup);
        const frames = historyFrames(host, view);
        const geometry = measuredList(view, 458, 6496, 1200);
        await renderPhoneHistory(view);
        frames.reveal();
        for (let i = 0; i < 30; i++) { geometry.content++; frames.tick(); }
        if (hidden === 'drawer') frames.rect.left = 360;
        else { frames.rect.width = 0; frames.rect.height = 0; }
        frames.tick();
        t.true(phoneHistoryPending(view.messages_container));
        t.is(frames.queued(), 0);
        // Even repeated host notifications while hidden cannot spend the budget.
        for (let i = 0; i < 100; i++) { host.observers[0].callback(); frames.tick(); }
        t.is(view.messages_container.scrollTop, 1200);
        t.true(phoneHistoryPending(view.messages_container));
        t.is(frames.queued(), 0);
        frames.rect.width = 354; frames.rect.height = 679;
        frames.reveal();
        for (let i = 0; i < 29; i++) { geometry.content++; frames.tick(); }
        t.is(view.messages_container.scrollTop, 1200);
        t.true(phoneHistoryPending(view.messages_container));
        geometry.content++;
        frames.tick();
        t.is(view.messages_container.scrollTop, 6098);
        t.false(phoneHistoryPending(view.messages_container));
        t.is(frames.queued(), 0);
    });
}

test.serial('U9 restore waits for Markdown and visible stable geometry, then tab positions including zero win', async t => {
    const host = keyboardHost(t);
    const { view } = await fixture(t, true, true, 'en', host.setup);
    const frames = historyFrames(host, view);
    const geometry = measuredList(view, 458, 6496, 0);
    let release!: () => void;
    const oldRender = MarkdownRenderer.render;
    MarkdownRenderer.render = async (...args) => { await new Promise<void>(resolve => { release = resolve; }); await oldRender(...args); };
    t.teardown(() => { MarkdownRenderer.render = oldRender; });
    await restoreHistory(view);
    frames.tick();
    t.is(view.messages_container.scrollTop, 0);
    release();
    // Flush the production renderer and its completion continuation.
    await new Promise<void>(resolve => setImmediate(resolve));
    frames.tick();
    t.is(view.messages_container.scrollTop, 0, 'finished Markdown in a hidden drawer does not scroll');
    frames.reveal();
    frames.tick();
    geometry.content = 6675; // final layout after drawer reveal
    frames.tick();
    frames.tick();
    t.is(view.messages_container.scrollTop, 6217);
    MarkdownRenderer.render = oldRender;

    view.messages_container.scrollTop = 0;
    await view._switchTab('older.md');
    await new Promise<void>(resolve => setImmediate(resolve));
    frames.tick(); frames.tick();
    t.is(view.messages_container.scrollTop, 6217, 'first visit to restored background tab opens at end');
    view.messages_container.scrollTop = 3000;
    await view._switchTab('recent.md');
    await new Promise<void>(resolve => setImmediate(resolve));
    frames.tick(); frames.tick();
    t.is(view.messages_container.scrollTop, 0, 'saved zero beats automatic bottom');
    view.chatTabs.find(tab => tab.sessionId === 'older.md')!._needsRefresh = true;
    await view._switchTab('older.md');
    await new Promise<void>(resolve => setImmediate(resolve));
    frames.tick(); frames.tick();
    t.is(view.messages_container.scrollTop, 3000, 'saved middle beats background refresh');
});

for (const phone of [false, true]) {
    test.serial(`U9 history respects reader takeover; phone=${phone}`, async t => {
        const host = keyboardHost(t);
        const { view } = await fixture(t, true, phone, 'en', host.setup);
        const frames = historyFrames(host, view);
        measuredList(view, 458, 6496, 0);
        await restoreHistory(view);
        await new Promise<void>(resolve => setImmediate(resolve));
        view.messages_container.dispatchEvent(new Event('touchstart'));
        view.messages_container.scrollTop = 3000;
        frames.reveal(); frames.tick(); frames.tick();
        t.is(view.messages_container.scrollTop, 3000);
        await view._switchTab('older.md');
        await new Promise<void>(resolve => setImmediate(resolve));
        frames.tick(); frames.tick();
        t.is(view.messages_container.scrollTop, phone ? 6038 : 3000);
    });
}

test.serial('U9 leaving an unseen tab does not save zero; stale render cannot override the selected tab', async t => {
    const host = keyboardHost(t);
    const { view } = await fixture(t, true, true, 'en', host.setup);
    const frames = historyFrames(host, view);
    measuredList(view, 458, 6496, 0);
    const oldRender = MarkdownRenderer.render;
    const releases: Array<() => void> = [];
    MarkdownRenderer.render = async (...args) => { await new Promise<void>(resolve => { releases.push(resolve); }); await oldRender(...args); };
    t.teardown(() => { MarkdownRenderer.render = oldRender; });
    await restoreHistory(view);
    await view._switchTab('older.md');
    await new Promise<void>(resolve => setImmediate(resolve));
    t.is(releases.length, 2);
    releases[1]();
    await new Promise<void>(resolve => setImmediate(resolve));
    frames.reveal(); frames.tick(); frames.tick();
    t.is(view.messages_container.scrollTop, 6038);
    view.messages_container.scrollTop = 3000;
    releases[0]();
    await new Promise<void>(resolve => setImmediate(resolve));
    frames.tick(); frames.tick();
    t.is(view.messages_container.scrollTop, 3000);
    MarkdownRenderer.render = oldRender;
    await view._switchTab('recent.md');
    await new Promise<void>(resolve => setImmediate(resolve));
    frames.tick(); frames.tick();
    t.is(view.messages_container.scrollTop, 6038, 'unseen tab still opens at newest message');
});

for (const end of ['close', 'render'] as const) {
    test.serial(`U9 pending history scroll is disposed on ${end}`, async t => {
        const host = keyboardHost(t);
        const { view } = await fixture(t, true, true, 'en', host.setup);
        const frames = historyFrames(host, view);
        measuredList(view, 458, 6496, 0);
        await restoreHistory(view);
        await new Promise<void>(resolve => setImmediate(resolve));
        frames.reveal(); frames.tick(); // positioning is still queued for a stable frame
        const oldMessages = view.messages_container;
        if (end === 'close') await view.onClose();
        else await view.renderView();
        oldMessages.scrollTop = 3000;
        frames.tick(); frames.tick();
        t.is(oldMessages.scrollTop, 3000);
        t.true(host.observers[0].disconnected);
        // A live installation remains capable of positioning the next history.
        const nextView = end === 'close' ? (await fixture(t, true, true, 'en', host.setup)).view : view;
        const nextFrames = historyFrames(host, nextView);
        measuredList(nextView, 458, 6496, 0);
        await restoreHistory(nextView);
        await new Promise<void>(resolve => setImmediate(resolve));
        nextFrames.rect.left = 0; nextFrames.rect.right = 354;
        nextFrames.tick(); nextFrames.tick();
        t.is(nextView.messages_container.scrollTop, 6038);
    });
}
