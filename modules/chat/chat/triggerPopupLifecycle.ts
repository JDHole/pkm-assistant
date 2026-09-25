import type { TriggerPopup } from './TriggerPopup.js';

interface TriggerPopupHost {
    _triggerPopup: Pick<TriggerPopup, 'close'> | null;
    _triggerOpenTimer: number | null;
}

export function scheduleTriggerPopupOpen(host: TriggerPopupHost, open: () => void): void {
    if (host._triggerOpenTimer !== null) window.clearTimeout(host._triggerOpenTimer);
    host._triggerOpenTimer = window.setTimeout(() => {
        host._triggerOpenTimer = null;
        open();
    }, 0);
}

export function closeTriggerPopup(host: TriggerPopupHost): void {
    if (host._triggerOpenTimer !== null) {
        window.clearTimeout(host._triggerOpenTimer);
        host._triggerOpenTimer = null;
    }
    host._triggerPopup?.close();
    host._triggerPopup = null;
}
