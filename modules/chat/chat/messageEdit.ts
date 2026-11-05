import type { RollingMessage, RollingWindow } from './RollingWindow.js';

// Bind the draft to the original object, so deleting/reordering messages cannot edit a neighbour.
const pending = new WeakMap<RollingWindow, RollingMessage>();
export function beginMessageEdit(window: RollingWindow, message: RollingMessage): void {
    pending.set(window, message);
}
export function hasPendingMessageEdit(window: RollingWindow): boolean { return pending.has(window); }
export function commitMessageEdit(window: RollingWindow): void {
    const message = pending.get(window);
    pending.delete(window);
    if (!message) return;
    const index = window.messages.indexOf(message);
    if (index >= 0) window.removeMessages(index);
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
