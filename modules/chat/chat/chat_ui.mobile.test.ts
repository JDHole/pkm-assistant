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
    const target = new EventTarget();
    el.addEventListener = target.addEventListener.bind(target);
    el.removeEventListener = target.removeEventListener.bind(target);
    el.dispatchEvent = target.dispatchEvent.bind(target);
    const div = el.createDiv.bind(el), span = el.createSpan.bind(el), create = el.createEl.bind(el);
    el.createDiv = options => { const child = div(options); Object.defineProperty(child, 'parentElement', { configurable: true, value: el }); browserEvents(child); return child; };
    el.createSpan = options => { const child = span(options); Object.defineProperty(child, 'parentElement', { configurable: true, value: el }); browserEvents(child); return child; };
    el.createEl = ((tag, options) => { const child = create(tag, options); Object.defineProperty(child, 'parentElement', { configurable: true, value: el }); browserEvents(child); return child; }) as typeof el.createEl;
}
function key(key: string, shiftKey = false) {
    return Object.assign(new Event('keydown', { cancelable: true }), { key, shiftKey });
}
async function fixture(t: import('ava').ExecutionContext, mobile: boolean) {
    Platform.isMobile = mobile;
    t.teardown(() => { Platform.isMobile = false; });
    setLocale('en');
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
