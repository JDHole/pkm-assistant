import { t } from '../../../core/i18n/index.js';
import { isVisionModel } from '../capabilities.js';
import type { VisionModelLike, OpenAiContentBlock, OpenAiRequestMessage } from '../contracts.js';

/** Przenosi obrazy wyników narzędzi za cały ciągły blok ich wiadomości. */
export function moveToolImagesToUser(messages: OpenAiRequestMessage[]): OpenAiRequestMessage[] {
    const isTool = (message: OpenAiRequestMessage): boolean => message.role === 'tool' || message.role === 'function';
    if (!messages.some(message => isTool(message) && Array.isArray(message.content)
        && message.content.some(block => block.type === 'image_url'))) return messages;

    const out: OpenAiRequestMessage[] = [];
    let images: OpenAiContentBlock[] = [];
    let ids: string[] = [];
    const flush = (): void => {
        if (images.length === 0) return;
        out.push({ role: 'user', content: [{ type: 'text', text: t('model.tool_image_intro', { ids: ids.join(', ') }) }, ...images] });
        images = [];
        ids = [];
    };
    for (const message of messages) {
        if (!isTool(message)) {
            flush();
            out.push(message);
            continue;
        }
        const blocks = Array.isArray(message.content) ? message.content : [];
        const found = blocks.filter(block => block.type === 'image_url');
        if (found.length === 0) {
            out.push(message);
            continue;
        }
        images.push(...found);
        ids.push(message.tool_call_id ?? '');
        const text = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
        const marker = t('model.tool_image_marker');
        out.push({ ...message, content: text ? `${text}\n${marker}` : marker });
    }
    flush();
    return out;
}

/** Natywne adaptery stosują tę samą decyzję i zastępnik co czat/OpenAI. */
export function filterImageBlocks(messages: OpenAiRequestMessage[], model: VisionModelLike): OpenAiRequestMessage[] {
    if (isVisionModel(model)) return messages;
    const placeholder = t('model.image_stripped');
    return messages.map(message => {
        if (!Array.isArray(message.content) || !message.content.some(block => block.type === 'image_url')) return message;
        return {
            ...message,
            content: message.content.every(block => block.type === 'image_url') ? placeholder
                : message.content.map(block => block.type === 'image_url' ? { type: 'text', text: placeholder } : block),
        };
    });
}
