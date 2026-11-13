import test from 'ava';
import { register } from 'node:module';
import { Platform } from 'obsidian';
import { setLocale } from '../../../core/i18n/index.js';
import type { ChatViewLike } from './chatViewShape.js';
import { bottomOcclusion, phoneKeyboardGeometry } from './phoneKeyboard.js';

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
