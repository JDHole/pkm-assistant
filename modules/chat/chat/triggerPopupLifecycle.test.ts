import test from 'ava';
import { closeTriggerPopup, scheduleTriggerPopupOpen } from './triggerPopupLifecycle.js';

test('zamyka oczekujace otwarcie popupu i kasuje uchwyt timera', async t => {
    const host: { _triggerPopup: { close: () => void } | null; _triggerOpenTimer: number | null } = {
        _triggerPopup: null,
        _triggerOpenTimer: null,
    };
    let opened = false;
    scheduleTriggerPopupOpen(host, () => { opened = true; });
    closeTriggerPopup(host);
    await new Promise(resolve => setTimeout(resolve, 5));

    t.false(opened);
    t.is(host._triggerOpenTimer, null);
});

test('zamyka popup i usuwa go z hosta', t => {
    let closeCount = 0;
    const host: { _triggerPopup: { close: () => void } | null; _triggerOpenTimer: number | null } = {
        _triggerPopup: { close: () => { closeCount++; } },
        _triggerOpenTimer: null,
    };
    closeTriggerPopup(host);

    t.is(closeCount, 1);
    t.is(host._triggerPopup, null);
});

test('closeTriggerPopup kasuje popup i timer hosta', t => {
    let closeCount = 0;
    const host: { _triggerPopup: { close: () => void } | null; _triggerOpenTimer: number | null } = {
        _triggerPopup: { close: () => { closeCount++; } },
        _triggerOpenTimer: null as number | null,
    };
    scheduleTriggerPopupOpen(host, () => { throw new Error('old popup should not open'); });
    closeTriggerPopup(host);

    t.is(closeCount, 1);
    t.is(host._triggerPopup, null);
    t.is(host._triggerOpenTimer, null);
});
