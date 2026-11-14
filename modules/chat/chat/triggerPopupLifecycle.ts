import type { TriggerPopup } from './TriggerPopup.js';

/** InputEvent fields are checked at the browser boundary; no event/DOM object is needed. */
export function mobileTriggerPosition(input: {
    isMobile: boolean;
    popupOpen: boolean;
    openScheduled: boolean;
    inputType: unknown;
    data: unknown;
    value: string;
    selectionStart: number;
    selectionEnd: number;
}): number | null {
    if (!input.isMobile || input.popupOpen || input.openScheduled) return null;
    // Composition may replace a whole string. Paste/drop/undo must not open a popup.
    if (input.inputType !== 'insertText' && input.inputType !== 'insertCompositionText') return null;
    if (typeof input.data !== 'string' || !input.data.endsWith('/')) return null;
    const cursor = input.selectionStart;
    if (cursor !== input.selectionEnd || cursor < 1 || cursor > input.value.length) return null;
    const position = cursor - 1;
    if (input.value.charAt(position) !== '/') return null;
    if (position > 0 && !/\s/.test(input.value.charAt(position - 1))) return null;
    return position;
}

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
