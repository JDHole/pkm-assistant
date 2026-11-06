import { fenceUntrusted, maskSensitiveData, redactSecretValues } from '../../core/index.js';
import { t } from '../../core/i18n/index.js';
import { estimateContextTokens } from '../models/index.js';
import type { ContextWindow } from '../models/index.js';
import type { LoopMessage } from '../agent-loop/index.js';
import type { PlanNode } from './SubTaskPlan.js';
import { contextReserves } from './ParentConversationBudget.js';

/** Export-only patterns allow glued keys, but ordinary lower-case hyphenated words
 * (e.g. task-przygotowanie-dokumentacji) are not key bodies. Generic sk- requires
 * a long alphanumeric body with a digit or uppercase letter; provider prefixes
 * explicitly allow the separators used by their keys. */
export function redactExport(text: string, secrets: readonly string[] = []): string {
    const known = redactSecretValues({ message: text, code: '', http_status: null }, secrets).message;
    return maskSensitiveData(known.replace(/sk-(?:or-v1-[A-Za-z0-9_-]{16,}|(?:ant-|proj-)[A-Za-z0-9_-]{20,}|(?=[A-Za-z0-9_]*[A-Z0-9])[A-Za-z0-9_]{20,})/g, key => maskSensitiveData(key)));
}

// Never stringify raw tool payloads: structured results can carry arguments, images and thinking.
export function toolText(content: unknown, depth = 0): string {
    if (depth > 8) return '';
    if (typeof content === 'string') {
        let parsed: unknown;
        try { parsed = JSON.parse(content); }
        catch {
            // A loop-clipped JSON result cannot safely be interpreted as plain prose.
            if (/^\s*[[{]/.test(content)) return '';
            return content.replace(/data:[^\s]+|[A-Za-z0-9+/=]{128,}/gi, '[pominięte dane]')
                .replace(/<(?:think|reasoning)\b[^>]*>[\s\S]*?(?:<\/(?:think|reasoning)>|$)/gi, '[pominięte rozumowanie]');
        }
        return toolText(parsed, depth + 1);
    }
    if (Array.isArray(content)) return content.map(block => toolText(block, depth + 1)).filter(Boolean).join('\n');
    if (typeof content === 'number' || typeof content === 'boolean') return String(content);
    if (!content || typeof content !== 'object') return '';
    if ('type' in content && content.type !== 'text') return '';
    return Object.entries(content).flatMap(([key, value]) =>
        /^(text|content|result|output|message|error|summary|results|files|matches|path|name|title|excerpt|fragment|formatted|snippet|url|line|count)$/.test(key) ? [toolText(value, depth + 1)] : []).filter(Boolean).join('\n');
}

export function excerpt(text: string, limit: number): string {
    const line = text.replace(/\s+/g, ' ').trim();
    const sentence = line.match(/^.*?[.!?](?:\s|$)/)?.[0].trim() || line;
    return sentence.length > limit ? sentence.slice(0, limit - 1) + '…' : sentence;
}

export type DependencyResult = Readonly<{ id: string; mode: 'summary' | 'full'; text: string }>;
export type DependencyPreparation = Readonly<{ id: string; mode: 'summary' | 'full'; sentChars: number;
    truncated: boolean; reason?: 'summary' | 'context_limit' | 'model_window' }>;

/** Read frozen, finally settled material, never previews or later thread continuations. */
export function dependencyResults(nodes: readonly PlanNode[], node: PlanNode): DependencyResult[] {
    return node.depends_on.map(id => {
        const predecessor = nodes.find(entry => entry.id === id)!;
        if (predecessor.state.kind !== 'done') throw new Error('dependency_result_unavailable');
        return { id, mode: node.dependency_results, text: predecessor.state.material };
    });
}

export function fitDependencyResults(sources: readonly DependencyResult[], base: readonly LoopMessage[],
    tools: readonly unknown[], window: ContextWindow, maxChars: number, secrets: readonly string[] = [],
): { message: LoopMessage; metadata: DependencyPreparation[]; maxOutputTokens: number } {
    const { maxOutputTokens, marginTokens } = contextReserves(window);
    const full = sources.map(source => toolText(redactExport(source.text, secrets)));
    const texts = full.map((text, i) => sources[i].mode === 'summary' ? excerpt(text, 240) : text);
    const marker = t('subagent.dependencies.truncated');
    // A marker must never cost more than the original short result.
    const textAt = (i: number, cap: number) => texts[i].length > Math.max(cap, marker.length)
        ? texts[i].slice(0, Math.min(cap, texts[i].length - marker.length)) + marker : texts[i];
    const body = (cap: number) => sources.map((source, i) => t(source.mode === 'summary'
        ? 'subagent.dependencies.summary' : 'subagent.dependencies.full', { id: source.id })
        + '\n' + textAt(i, cap)).join('\n\n');
    const message = (cap: number): LoopMessage => ({ role: 'user', parentConversationInherited: true,
        content: t('subagent.dependencies.frame') + '\n' + fenceUntrusted(body(cap), 'dependency_results') });
    const withinChars = (cap: number) => body(cap).length <= maxChars;
    const withinWindow = (cap: number) => estimateContextTokens({ messages: [base[0], message(cap), ...base.slice(1)], tools })
        + maxOutputTokens + marginTokens <= window.tokens;
    let low = 0, high = Math.max(0, ...texts.map(text => text.length));
    if (withinChars(high) && withinWindow(high)) low = high;
    else if (!withinChars(0) || !withinWindow(0)) throw new Error('dependency_context_budget');
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (withinChars(mid) && withinWindow(mid)) low = mid; else high = mid - 1;
    }
    return { message: message(low), maxOutputTokens, metadata: sources.map((source, i) => ({
        id: source.id, mode: source.mode, sentChars: textAt(i, low).length,
        truncated: textAt(i, low) !== full[i],
        ...(textAt(i, low) !== texts[i] ? { reason: withinChars(low + 1) ? 'model_window' as const : 'context_limit' as const }
            : texts[i] !== full[i] ? { reason: 'summary' as const } : {}),
    })) };
}
