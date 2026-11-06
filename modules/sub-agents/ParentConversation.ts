import { redactExport, toolText, excerpt } from './DependencyResults.js';
import type { LoopMessage } from '../agent-loop/index.js';
import type { SubRunContext, SubTaskOrigin, SubTaskRegistry } from './SubTaskRegistry.js';

export type ConversationEntry = Readonly<{ sequence: number; role: 'user' | 'assistant' | 'tool' | 'powiadomienie pluginu'; text: string }>;
export type ParentConversationSnapshot = Readonly<{
    messages: readonly ConversationEntry[];
    summary: string;
    keptMessages: number;
    summarizedMessages: number;
    omittedMessages: number;
    truncated: boolean;
}>;
export type ParentConversationContext = Readonly<{
    source: 'lead' | 'sub';
    owner: Readonly<SubTaskOrigin>;
    turnId: number | string;
    providerId: string | undefined;
    snapshot: ParentConversationSnapshot;
}>;

// Full source stays private to this process and frozen snapshot; it is never serialized.
const snapshotSources = new WeakMap<ParentConversationSnapshot, (secrets: readonly string[]) => ParentConversationSnapshot>();

export function redactParentConversationSnapshot(snapshot: ParentConversationSnapshot, secrets: readonly string[] = []): ParentConversationSnapshot {
    const rebuild = snapshotSources.get(snapshot);
    if (rebuild) return rebuild(secrets);
    return Object.freeze({ ...snapshot, summary: redactExport(snapshot.summary, secrets),
        messages: Object.freeze(snapshot.messages.map(entry => Object.freeze({ ...entry, text: redactExport(entry.text, secrets) }))),
    });
}

type SourceEntry = ConversationEntry & { toolName?: string };
function exportEntry(entry: SourceEntry, secrets: readonly string[]): ConversationEntry {
    const safe = redactExport(entry.text, secrets);
    return { sequence: entry.sequence, role: entry.role, text: entry.toolName !== undefined
        ? `[narzędzie: ${redactExport(entry.toolName, secrets)}; wynik: ${excerpt(safe, 240) || '[pominięta treść nietekstowa]'}]` : safe };
}

function textOnly(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.flatMap((block: unknown) => block && typeof block === 'object'
        && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string'
        ? [block.text] : []).join('\n');
}

/** Text-only projection, independent of the model's compressed window. No API calls. */
export class ParentConversationProjection {
    private recent: SourceEntry[] = [];
    private older: SourceEntry[] = [];
    private names = new Map<string, string>();
    private sequence = 0;
    private omitted = 0;
    private sources = new WeakMap<LoopMessage, number | 'omitted'>();

    /** Explicit user deletion; compression deliberately keeps the projection. */
    remove(message: LoopMessage): void {
        const id = this.sources.get(message);
        this.sources.delete(message);
        if (id === 'omitted') this.omitted--;
        else if (typeof id === 'number') {
            this.recent = this.recent.filter(entry => entry.sequence !== id);
            this.older = this.older.filter(entry => entry.sequence !== id);
        }
        for (const call of message.tool_calls ?? []) {
            if (call && typeof call === 'object' && 'id' in call && typeof call.id === 'string') this.names.delete(call.id);
        }
    }

    append(message: LoopMessage, requireUserText = false): void {
        if (message.parentConversationInherited === true || message.role === 'system') return;
        for (const raw of message.tool_calls ?? []) {
            if (!raw || typeof raw !== 'object' || !('id' in raw) || typeof raw.id !== 'string') continue;
            const fn = 'function' in raw ? raw.function : raw;
            if (fn && typeof fn === 'object' && 'name' in fn && typeof fn.name === 'string') this.names.set(raw.id, fn.name);
        }
        // Bound unmatched call names, too. Eviction yields an explicitly unmatched result.
        for (const id of this.names.keys()) {
            if (this.names.size <= 256) break;
            this.names.delete(id);
        }
        let text: string;
        let toolName: string | undefined;
        if (message.role === 'tool') {
            const name = this.names.get(message.tool_call_id ?? '') ?? 'niedopasowane';
            this.names.delete(message.tool_call_id ?? '');
            const raw = toolText(message.content);
            text = raw;
            toolName = name;
        } else if (message.role === 'user' && requireUserText) {
            if (typeof message.parentConversationText !== 'string') { this.omitted++; this.sources.set(message, 'omitted'); return; }
            text = message.parentConversationText;
        } else text = textOnly(message.content);
        if (!text.trim() && toolName === undefined) return;
        const role = message.role === 'user' && message.origin !== 'human'
            && (message._subTaskNotification === true || text.startsWith('[SYSTEM NOTIFICATION]'))
            ? 'powiadomienie pluginu' : message.role;
        this.recent.push({ sequence: ++this.sequence, role, text, ...(toolName !== undefined ? { toolName } : {}) });
        this.sources.set(message, this.sequence);
        while (this.recent.filter(entry => entry.role !== 'tool').length > 8) {
            const entry = this.recent.shift()!;
            this.older.push(entry);
        }
        while (this.summary().length > 4096) { this.older.shift(); this.omitted++; }
    }

    private summary(secrets: readonly string[] = []): string {
        return this.older.map(source => { const entry = exportEntry(source, secrets); return `[${entry.sequence} ${entry.role}] ${excerpt(entry.text, 160)}`; }).join('\n');
    }

    snapshot(assistantText?: string, secrets: readonly string[] = []): ParentConversationSnapshot {
        // Work on a copy: the current delegating answer is not yet in the loop's store.
        const copy = new ParentConversationProjection();
        copy.recent = [...this.recent]; copy.older = [...this.older];
        copy.sequence = this.sequence; copy.omitted = this.omitted;
        if (assistantText?.trim()) copy.append({ role: 'assistant', content: assistantText });
        const snapshot = Object.freeze({
            messages: Object.freeze(copy.recent.map(entry => Object.freeze(exportEntry(entry, secrets)))),
            summary: copy.summary(secrets),
            keptMessages: copy.recent.filter(entry => entry.role !== 'tool').length,
            summarizedMessages: copy.older.filter(entry => entry.role !== 'tool').length,
            omittedMessages: copy.omitted,
            truncated: copy.omitted > 0 || copy.older.length > 0,
        });
        snapshotSources.set(snapshot, known => copy.snapshot(undefined, known));
        return snapshot;
    }
}

export function freezeParentConversation(
    source: ParentConversationContext['source'], owner: SubTaskOrigin, turnId: number | string,
    providerId: string | undefined, snapshot: ParentConversationSnapshot,
): ParentConversationContext {
    return Object.freeze({ source, owner: Object.freeze({ ...owner }), turnId, providerId, snapshot });
}

/** A missing/stale run never falls back to the lead chat or a saved thread transcript. */
export function captureSubParentConversation(
    registry: Pick<SubTaskRegistry, 'getDelegationAncestors'> | null | undefined,
    context: SubRunContext, messages: readonly LoopMessage[], providerId: string | undefined, assistantText?: string,
): ParentConversationContext | undefined {
    if (!registry?.getDelegationAncestors(context, context.origin.agentName)) return undefined;
    const projection = new ParentConversationProjection();
    for (const message of messages) projection.append(message);
    return freezeParentConversation('sub', context.origin, context.runId, providerId, projection.snapshot(assistantText));
}
