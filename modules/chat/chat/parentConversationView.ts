import { t } from '../../../core/i18n/index.js';
import type { ParentConversationMetadata } from '../../sub-agents/index.js';
import type { SubAgentConversationView } from '../../ui-components/index.js';

/** Presentation only: pending never claims that the conversation was sent. */
export function buildParentConversationView(metadata?: ParentConversationMetadata, translate: typeof t = t): SubAgentConversationView | undefined {
    if (!metadata) return undefined;
    const state = metadata.status === 'included' && metadata.truncated ? 'truncated' : metadata.status;
    const details = [translate(`chat.parent_conversation.source_${metadata.source}`, { id: metadata.sourceId })];
    if (metadata.status === 'pending') details.push(translate('chat.parent_conversation.pending_details'));
    else {
        if (metadata.status === 'omitted') details.push(translate('chat.parent_conversation.omitted_details'));
        details.push(translate('chat.parent_conversation.scope', {
            kept: metadata.keptMessages, summarized: metadata.summarizedMessages, omitted: metadata.omittedMessages,
        }));
        details.push(translate('chat.parent_conversation.tokens', { tokens: metadata.estimatedTokens }));
        if (metadata.window.estimated) details.push(translate('chat.parent_conversation.estimated_window'));
    }
    details.push(translate('chat.parent_conversation.exclusions'));
    return { state, badge: translate(`chat.parent_conversation.${state}`), details };
}
