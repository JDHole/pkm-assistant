import { t } from '../../../core/i18n/index.js';
import { parseDraftSummary } from '../../vault-drafts/index.js';
import type { DraftSummary } from '../../vault-drafts/index.js';
import type { SubTaskRegistry } from '../../sub-agents/index.js';
import type { SubAgentDraftView } from '../../ui-components/index.js';

export function draftSummaryText(summary: DraftSummary): string {
    return (['pending', 'conflicts', 'accepted', 'rejected'] as const)
        .filter(key => summary[key] > 0).map(key => t(`chat.subdraft.${key}`, { count: summary[key] })).join(' · ');
}
export function draftPresentation(raw: unknown, registry?: Pick<SubTaskRegistry, 'draftSummaries' | 'events'>): SubAgentDraftView | undefined {
    const summary = parseDraftSummary(raw);
    if (!summary) return undefined;
    const current = () => registry?.draftSummaries?.(summary.owner).find(value => value.ref.draftId === summary.ref.draftId) ?? summary;
    return {
        read: () => ({ title: t('chat.subdraft.heading'), summary: draftSummaryText(current()),
            details: current().changes.map(change => `${change.path}: ${t(`chat.subdraft.${change.status === 'accepted' || change.status === 'rejected' ? change.status : change.status === 'conflict' || change.status === 'recovery-required' ? 'conflicts' : 'pending'}`, { count: 1 })}`) }),
        ...(registry?.events ? { subscribe: (refresh: () => void) => registry.events.on('draft:changed', refresh) } : {}),
    };
}
