/** Geometry only: CSS reads Obsidian's native --keyboard-height independently of events. */
export function bottomOcclusion(windowHeight: number, elementBottom: number, keyboardHeight = 0): number {
    return Math.max(0, elementBottom - (windowHeight - keyboardHeight));
}

export function phoneKeyboardGeometry(
    windowHeight: number, viewBottom: number,
    viewport?: Pick<VisualViewport, 'height' | 'offsetTop'> | null,
) {
    return {
        below: Math.max(0, windowHeight - viewBottom),
        fallback: viewport ? Math.max(0, windowHeight - viewport.height - viewport.offsetTop) : 0,
    };
}

/** Installed once per render, disposed synchronously on close, even during pending saves. */
export function installPhoneKeyboard(
    root: HTMLElement, messages: HTMLElement, panel: HTMLElement, inputRow: HTMLElement,
    isPhone: boolean,
): (() => void) | null {
    if (!isPhone) return null;
    const win = root.ownerDocument.defaultView;
    if (!win) return null;
    const viewport = win.visualViewport;
    let disposed = false;
    let pinned = messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 8;
    let previousHeight = messages.clientHeight;
    const rememberScroll = () => {
        // Layout can clamp scrollTop and dispatch scroll before ResizeObserver (keyboard
        // hiding). That is not the reader moving away from the bottom.
        if (messages.clientHeight !== previousHeight) return;
        pinned = messages.scrollHeight - messages.scrollTop - previousHeight <= 8;
    };
    const update = () => {
        if (disposed) return;
        // The border box keeps its height while padding reduces the flex content box.
        const geometry = phoneKeyboardGeometry(win.innerHeight, root.getBoundingClientRect().bottom, viewport);
        root.style.setProperty('--pkm-chat-below', `${geometry.below}px`);
        root.style.setProperty('--pkm-chat-kb-fallback', `${geometry.fallback}px`);
        const top = Math.max(root.getBoundingClientRect().top, viewport?.offsetTop ?? 0);
        root.style.setProperty('--pkm-chat-popup-space', `${Math.max(0, inputRow.getBoundingClientRect().top - top - 8)}px`);
        root.style.setProperty('--pkm-chat-prequestion-space', `${Math.max(0, panel.getBoundingClientRect().top - top - 8)}px`);
        root.style.setProperty('--pkm-chat-panel-offset', `${panel.offsetHeight + 12}px`);
        if (messages.clientHeight !== previousHeight) {
            if (pinned) messages.scrollTo({ top: messages.scrollHeight - messages.clientHeight, behavior: 'instant' });
            previousHeight = messages.clientHeight;
        }
        // Reveal only within the field's own scroller, never the drawer/window.
        const active = root.ownerDocument.activeElement;
        if (active?.matches('input, textarea') && root.contains(active)) {
            const scroller = messages.contains(active) ? messages : active.closest<HTMLElement>('.pkm-skill-pq-overlay');
            if (!scroller) return;
            const field = active.getBoundingClientRect(), area = scroller.getBoundingClientRect();
            const overlap = bottomOcclusion(area.bottom, field.bottom);
            const delta = overlap > 0 ? overlap
                : field.top < area.top ? field.top - area.top : 0;
            if (delta) scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: 'instant' });
        }
    };
    const events = ['keyboardWillShow', 'keyboardWillHide', 'resize'];
    for (const event of events) win.addEventListener(event, update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    root.addEventListener('focusin', update);
    messages.addEventListener('scroll', rememberScroll);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(root, { box: 'border-box' });
    observer?.observe(messages);
    observer?.observe(panel);
    update();
    return () => {
        disposed = true;
        for (const event of events) win.removeEventListener(event, update);
        viewport?.removeEventListener('resize', update);
        viewport?.removeEventListener('scroll', update);
        root.removeEventListener('focusin', update);
        messages.removeEventListener('scroll', rememberScroll);
        observer?.disconnect();
        for (const name of ['below', 'kb-fallback', 'popup-space', 'prequestion-space', 'panel-offset']) {
            root.style.removeProperty(`--pkm-chat-${name}`);
        }
    };
}
