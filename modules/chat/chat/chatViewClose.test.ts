import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { closeTriggerPopup, scheduleTriggerPopupOpen } from './triggerPopupLifecycle.js';

const source = readFileSync(fileURLToPath(new URL('../chat_view.ts', import.meta.url)), 'utf8');

function extractBody(text: string, signature: string): string {
    const start = text.indexOf(signature);
    if (start < 0) throw new Error(`signature missing: ${signature}`);
    const brace = text.indexOf('{', text.indexOf(')', start));
    let depth = 1;
    let index = brace + 1;
    while (depth > 0 && index < text.length) {
        if (text[index] === '{') depth++;
        else if (text[index] === '}') depth--;
        index++;
    }
    return text.slice(brace + 1, index - 1);
}

test('onClose zamyka trigger popup', async t => {
    const body = extractBody(source, 'onClose(this: ChatViewLike): Promise<void> | void {');
    let closeCalls = 0;
    const host = {
        plugin: { subTaskNotifier: { setDeliverer() {} } },
        _unwireSubTaskStrip: null,
        _unsubscribeSkinEvents: null,
        _selectionMenuDetach: null,
        _triggerPopup: { close: () => { closeCalls++; } } as { close: () => void } | null,
        _triggerOpenTimer: null as number | null,
        _closeTriggerPopup: null as (() => void) | null,
        _connectorActivityDetach: null,
        handleGlobalKeydownBound: null,
        handleBeforeUnloadBound: null,
        mentionAutocomplete: null,
        attachmentManager: null,
        _bottomPanelObserver: null,
        _audioRecorder: null,
        _agentManagerUnsub: null,
        _cleanupAskUser() {},
        stop_all_turns() {},
        _streamCtxMap: new Map(),
        _renderThrottle: null,
        _cancelConnectorRedraw() {},
        rollingWindow: { messages: [] },
    };
    host._closeTriggerPopup = function (this: typeof host) { closeTriggerPopup(this); };
    let opened = false;
    scheduleTriggerPopupOpen(host, () => { opened = true; });
    const close = new Function('document', 'window', `return async function() {${body}};`)({}, {}) as (this: typeof host) => Promise<void>;

    await close.call(host);

    t.is(closeCalls, 1);
    t.is(host._triggerPopup, null);
    t.is(host._triggerOpenTimer, null);
    await new Promise(resolve => setTimeout(resolve, 5));
    t.false(opened);
});
