import type { ChatViewLike } from './chatViewShape.js';

type ScrollRequest = { ready: boolean; top: number | 'bottom'; visibleFrames: number };
type BeginScroll = (top: number | 'bottom') => (rendered: boolean) => void;
const controllers = new WeakMap<HTMLElement, { begin: BeginScroll; pending(): boolean }>();
// About one second at 60 Hz (half a second at 120 Hz), without charging hidden drawers.
const MAX_VISIBLE_FRAMES = 60;

/** A tab left before its first reveal has no reading position to remember yet. */
export function phoneHistoryPending(messages: HTMLElement): boolean {
    return controllers.get(messages)?.pending() ?? false;
}

/** Called only on phones, before rendering, so an older render cannot scroll a new tab. */
export async function renderPhoneHistory(view: ChatViewLike, top: number | 'bottom' = 'bottom'): Promise<void> {
    const renderedWindow = view.rollingWindow;
    const messages = view.messages_container;
    const finish = controllers.get(messages)?.begin(top);
    let rendered = false;
    try {
        await view.render_messages();
        rendered = view.rollingWindow === renderedWindow && view.messages_container === messages;
    } finally {
        finish?.(rendered);
    }
}

/** Owned by the phone keyboard installation; hidden drawers wait without a polling loop. */
export function installPhoneHistoryScroll(root: HTMLElement, messages: HTMLElement) {
    const win = root.ownerDocument.defaultView!;
    let disposed = false;
    let request: ScrollRequest | null = null;
    let frame: number | null = null;
    let previousGeometry = '';
    const cancel = () => {
        request = null;
        previousGeometry = '';
        if (frame !== null) win.cancelAnimationFrame(frame);
        frame = null;
    };
    const layoutChanged = () => {
        if (!disposed && request?.ready && frame === null) frame = win.requestAnimationFrame(settle);
    };
    const settle = () => {
        frame = null;
        if (disposed || !request?.ready) return;
        const rect = root.getBoundingClientRect();
        if (!root.isConnected || messages.clientHeight === 0 || rect.width === 0 || rect.height === 0
            || rect.right <= 0 || rect.left >= win.innerWidth || rect.bottom <= 0 || rect.top >= win.innerHeight) {
            previousGeometry = '';
            return; // ResizeObserver or IntersectionObserver wakes us on reveal.
        }
        request.visibleFrames++;
        const geometry = [rect.left, rect.top, rect.width, rect.height, messages.clientHeight, messages.scrollHeight].join(',');
        if (geometry !== previousGeometry && request.visibleFrames < MAX_VISIBLE_FRAMES) {
            previousGeometry = geometry;
            layoutChanged();
            return;
        }
        const top = request.top === 'bottom' ? messages.scrollHeight - messages.clientHeight : request.top;
        messages.scrollTo({ top, behavior: 'instant' });
        cancel();
    };
    const begin: BeginScroll = top => {
        cancel();
        const next: ScrollRequest = { ready: false, top, visibleFrames: 0 };
        request = next;
        return rendered => {
            if (disposed || request !== next) return;
            if (!rendered) { cancel(); return; }
            next.ready = true;
            layoutChanged();
        };
    };
    controllers.set(messages, { begin, pending: () => request !== null });
    const visibility = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(layoutChanged);
    visibility?.observe(root);
    // A reader taking control while Markdown/layout settles wins over automatic positioning.
    const inputs = ['touchstart', 'pointerdown', 'wheel', 'keydown'];
    for (const event of inputs) messages.addEventListener(event, cancel, { passive: true });
    return {
        pending: () => request !== null,
        layoutChanged,
        dispose() {
            disposed = true;
            cancel();
            controllers.delete(messages);
            visibility?.disconnect();
            for (const event of inputs) messages.removeEventListener(event, cancel);
        },
    };
}
