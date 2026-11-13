import test from 'ava';
import { register } from 'node:module';
import { Platform } from 'obsidian';
import { setLocale } from '../../../core/i18n/index.js';
import type { ChatViewLike } from './chatViewShape.js';

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
async function fixture(t: import('ava').ExecutionContext, mobile: boolean, phone = false, locale = 'en') {
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
