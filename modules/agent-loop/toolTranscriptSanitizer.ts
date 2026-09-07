/**
 * Sanitize chat transcripts before API calls.
 *
 * OpenAI-compatible tool transcripts require every tool result to have a
 * matching earlier assistant.tool_calls[] entry. Recovery/compression paths can
 * leave orphan tool messages behind; drop them before the provider sees the
 * request.
 */
import type { LoopMessage } from './MessageStore.js';

/** Logger na tyle luźny, ile sanitizer realnie potrzebuje (woła tylko `warn`, i to opcjonalnie). */
interface SanitizerLogger {
    warn?: (tag: string, message: string) => void;
}

export interface SanitizeToolTranscriptOptions {
    logger?: SanitizerLogger | null;
    tag?: string;
}

export interface SanitizeToolTranscriptResult {
    messages: LoopMessage[];
    droppedOrphanTools: number;
    strippedInvalidAssistantCalls: number;
    changed: boolean;
}

export function sanitizeToolTranscript(
    messages: LoopMessage[] | null | undefined = [],
    options: SanitizeToolTranscriptOptions = {},
): SanitizeToolTranscriptResult {
    const logger = options.logger || null;
    const tag = options.tag || 'ToolTranscript';
    const sanitized: LoopMessage[] = [];
    const validToolCallIds = new Set<string>();
    let droppedOrphanTools = 0;
    let strippedInvalidAssistantCalls = 0;

    for (const msg of messages || []) {
        if (!msg || typeof msg !== 'object') continue;

        const hasContent = _hasContent(msg.content);

        if (msg.role === 'tool') {
            if (!msg.tool_call_id || !validToolCallIds.has(msg.tool_call_id)) {
                droppedOrphanTools++;
                logger?.warn?.(tag, `sanitizeForAPI: drop orphan tool message (tool_call_id="${msg.tool_call_id || 'undefined'}")`);
                continue;
            }
            sanitized.push(_copyApiMessage(msg));
            continue;
        }

        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
            const validToolCalls = (msg.tool_calls as ApiToolCall[]).filter(tc => tc?.id && tc?.function?.name);
            if (validToolCalls.length === 0) {
                strippedInvalidAssistantCalls++;
                logger?.warn?.(tag, 'sanitizeForAPI: strip empty/invalid tool_calls from assistant message');
                if (!hasContent) continue;
                const apiMsg: LoopMessage = { role: msg.role, content: msg.content };
                if (msg.reasoning_content !== undefined) apiMsg.reasoning_content = msg.reasoning_content;
                sanitized.push(apiMsg);
                continue;
            }

            for (const tc of validToolCalls) validToolCallIds.add(tc.id as string);
            const apiMsg = _copyApiMessage(msg);
            apiMsg.tool_calls = validToolCalls;
            sanitized.push(apiMsg);
            continue;
        }

        if (!hasContent && !msg.tool_calls?.length && !msg.tool_call_id) continue;
        sanitized.push(_copyApiMessage(msg));
    }

    return {
        messages: sanitized,
        droppedOrphanTools,
        strippedInvalidAssistantCalls,
        changed: sanitized.length !== (messages || []).length || droppedOrphanTools > 0 || strippedInvalidAssistantCalls > 0,
    };
}

/** Minimalny widok wpisu `assistant.tool_calls[]`, którego dotyka sanitizer. */
type ApiToolCall = { id?: string; function?: { name?: string } };

function _copyApiMessage(msg: LoopMessage): LoopMessage {
    const apiMsg: LoopMessage = { role: msg.role, content: msg.content };
    if (msg.tool_call_id) apiMsg.tool_call_id = msg.tool_call_id;
    if (msg.tool_calls) apiMsg.tool_calls = msg.tool_calls;
    if (msg.reasoning_content !== undefined) apiMsg.reasoning_content = msg.reasoning_content;
    return apiMsg;
}

function _hasContent(content: unknown): boolean {
    if (typeof content === 'string') return content.length > 0;
    if (Array.isArray(content)) return content.length > 0;
    return content !== null && content !== undefined;
}
