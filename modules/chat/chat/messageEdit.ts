import type { RollingMessage, RollingWindow } from './RollingWindow.js';
import { t } from '../../../core/i18n/index.js';

// An edit belongs to one window and the exact original message, never its array index.
const pending = new WeakMap<RollingWindow, { message: RollingMessage; isCurrent(): boolean; cleanup(): void }>();
export function cancelMessageEdit(window: RollingWindow): void {
    pending.get(window)?.cleanup();
    pending.delete(window);
}
export function beginMessageEdit(window: RollingWindow, message: RollingMessage, input?: HTMLTextAreaElement, isCurrent = () => true): void {
    cancelMessageEdit(window);
    const row = input?.parentElement;
    const indicator = row?.parentElement?.createDiv({ cls: 'cs-message-edit-indicator', text: t('chat.msg.editing'), attr: { role: 'status' } });
    if (indicator) row?.parentElement?.insertBefore(indicator, row);
    const onInput = () => { if (!input?.value.trim()) cancelMessageEdit(window); };
    const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
            event.preventDefault();
            cancelMessageEdit(window);
        }
    };
    // Popup listeners run first and may consume Escape before the edit is cancelled.
    input?.addEventListener?.('input', onInput);
    input?.addEventListener?.('keydown', onKey);
    pending.set(window, { message, isCurrent, cleanup() {
        indicator?.remove();
        input?.removeEventListener?.('input', onInput);
        input?.removeEventListener?.('keydown', onKey);
    } });
}
export function hasPendingMessageEdit(window: RollingWindow): boolean {
    const edit = pending.get(window);
    if (edit && (!edit.isCurrent() || !window.messages.includes(edit.message))) cancelMessageEdit(window);
    return pending.has(window);
}
/** Detach a submitted edit from input/tab cancellation; commit only after slash dispatch. */
export function takeMessageEdit(window: RollingWindow): () => void {
    const message = hasPendingMessageEdit(window) ? pending.get(window)?.message : undefined;
    cancelMessageEdit(window);
    return () => {
        if (!message) return;
        const index = window.messages.indexOf(message);
        if (index >= 0) window.removeMessages(index);
    };
}

export function commitMessageEdit(window: RollingWindow): void {
    takeMessageEdit(window)();
}

/** Legacy plain text stays editable. Only evidence of expanded attachments needs an empty draft. */
export function messageEditText(message: RollingMessage, originalContent: string): string {
    if (typeof message.parentConversationText === 'string') return message.parentConversationText;
    const content = message.content;
    const blocks = Array.isArray(content) ? content : [];
    const text = typeof content === 'string' ? content : blocks.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
    const expanded = !!message.userAttachments?.length || !!message.userMentions?.length
        || blocks.some(b => b.type !== 'text')
        || /(?:^|\n)📎 [^\n]+\n```/.test(text)
        || /^(?:User wskazał następujące pliki\/foldery|User pointed to the following files\/folders)/.test(text);
    return expanded ? '' : originalContent;
}
