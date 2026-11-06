import { t } from '../../core/i18n/index.js';
import { terminalPlanState } from '../sub-agents/index.js';
import type { PlanNodeId, SubTaskResult } from '../sub-agents/index.js';

export type DependencyResult = Readonly<{ nodeId: PlanNodeId; result: SubTaskResult }>;
export type DependencyContext = Readonly<{ text: string; truncated: boolean }>;

/** Water filling in input order: short results release their share to longer ones. */
function shareBudget(lengths: readonly number[], budget: number): number[] {
    const kept = lengths.map(() => 0);
    let pending = lengths.map((_, i) => i).filter(i => lengths[i] > 0);
    while (budget > 0 && pending.length) {
        const share = Math.floor(budget / pending.length);
        const remainder = budget % pending.length;
        pending.forEach((i, position) => {
            const extra = Math.min(lengths[i] - kept[i], share + (position < remainder ? 1 : 0));
            kept[i] += extra;
            budget -= extra;
        });
        pending = pending.filter(i => kept[i] < lengths[i]);
    }
    return kept;
}

/** Caller selects ONLY direct predecessors, in depends_on order, from full registry
 * results (never the shortened lead notification). Reject non-success instead of
 * silently handing partial material to a successor. cap is frozen by the plan caller.
 * Counts UTF-16 characters, like the other delegation limits.
 */
export function buildDependencyContext(results: readonly DependencyResult[], cap: number): DependencyContext {
    if (!Number.isSafeInteger(cap) || cap <= 0) throw new RangeError('Dependency context cap must be a positive integer.');
    if (!results.length) return { text: '', truncated: false };
    const intro = t('mcp.delegate.dependencies.intro');
    const parts = results.map(({ nodeId, result }) => {
        if (terminalPlanState({ kind: 'result', result }).kind !== 'finished') {
            throw new Error(`Dependency ${nodeId} has no successful result.`);
        }
        // A result cannot close its own material fence, even if it contains Markdown/XML.
        let suffix = 0;
        while (result.text.includes(`</material-${suffix}>`)) suffix++;
        const tag = `material-${suffix}`;
        return { body: result.text, prefix: `\n\n${t('mcp.delegate.dependencies.result', { id: nodeId })}\n<${tag}>\n`,
            suffix: `\n</${tag}>` };
    });
    const lengths = parts.map(part => part.body.length);
    const marker = (i: number, kept: number) => kept === lengths[i] ? ''
        : `\n${t('mcp.delegate.dependencies.truncated', { kept, total: lengths[i] })}`;
    const framing = intro.length + parts.reduce((sum, part) => sum + part.prefix.length + part.suffix.length, 0);
    const render = (kept: readonly number[]) => intro + parts.map((part, i) =>
        part.prefix + part.body.slice(0, kept[i]) + part.suffix + marker(i, kept[i])).join('');
    if (framing + lengths.reduce((sum, length) => sum + length, 0) <= cap) {
        return { text: render(lengths), truncated: false };
    }
    // Reserve the longest possible count marker for every nonempty result first.
    const reserves = lengths.map((length, i) => length ? marker(i, 0).length - 1 + String(length).length : 0);
    let budget = cap - framing - reserves.reduce((sum, length) => sum + length, 0);
    if (budget < 0) throw new RangeError('Dependency context cap cannot fit all result headings and markers.');
    let kept = shareBudget(lengths, budget);
    // A short result needs no marker. Reclaim that space and redistribute fairly.
    for (;;) {
        let released = 0;
        kept.forEach((count, i) => {
            if (count === lengths[i]) { released += reserves[i]; reserves[i] = 0; }
        });
        if (!released) break;
        budget += released;
        kept = shareBudget(lengths, budget);
    }
    // Reclaim shorter count digits too, accounting for a possible digit rollover or
    // removal of the marker when the last character fits. Ties go to depends_on order.
    let spare = cap - framing - kept.reduce((sum, count, i) => sum + count + marker(i, count).length, 0);
    for (;;) {
        const candidates = kept.map((_, i) => i).filter(i => kept[i] < lengths[i])
            .sort((a, b) => kept[a] - kept[b] || a - b);
        const i = candidates.find(i => 1 + marker(i, kept[i] + 1).length - marker(i, kept[i]).length <= spare);
        if (i === undefined) break;
        spare -= 1 + marker(i, kept[i] + 1).length - marker(i, kept[i]).length;
        kept[i]++;
    }
    return { text: render(kept), truncated: kept.some((count, i) => count < lengths[i]) };
}
