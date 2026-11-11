import type { AttachmentManager, MentionAutocomplete } from '../../ui-components/index.js';
import type { ChatViewLike } from './chatViewShape.js';
import type { FrozenTurnOwner } from './turnOwner.js';
import type { RollingMessage, RollingWindow } from './RollingWindow.js';
import { beginMessageEdit } from './messageEdit.js';

type SubmittedDraft = {
    text: string;
    attachments: ReturnType<AttachmentManager['snapshotAttachments']>;
    mentions: ReturnType<MentionAutocomplete['getMentions']>;
    editedMessage: RollingMessage | undefined;
};
const waiting = new WeakMap<RollingWindow, SubmittedDraft[]>();

/** A failed/background submission belongs to its window, never the currently selected input. */
export function recoverSendDraft(view: ChatViewLike, owner: FrozenTurnOwner, draft: SubmittedDraft): void {
    const window = owner.rollingWindow;
    if (!window) return;
    waiting.set(window, [...(waiting.get(window) ?? []), draft]);
    if (view.rollingWindow === window && (!owner.tab || owner.tab.isActive)) restoreSendDraft(view);
}

/** Called on recovery and when the owning tab becomes visible again. Preserve a newer draft too. */
export function restoreSendDraft(view: ChatViewLike): void {
    const window = view.rollingWindow;
    const drafts = waiting.get(window);
    if (!drafts) return;
    waiting.delete(window);
    for (const draft of drafts) {
        const current = view.input_area.value;
        view.input_area.value = current && current !== draft.text ? `${draft.text}\n\n${current}` : draft.text;
        view.attachmentManager?.restoreAttachments([...draft.attachments, ...(view.attachmentManager.snapshotAttachments() ?? [])]);
        view.mentionAutocomplete?.restoreMentions([...draft.mentions, ...view.mentionAutocomplete.getMentions()]);
        if (draft.editedMessage && window.messages.includes(draft.editedMessage)) {
            beginMessageEdit(window, draft.editedMessage, view.input_area, () => view.rollingWindow === window);
        }
    }
    view.handleInputResize?.();
}
