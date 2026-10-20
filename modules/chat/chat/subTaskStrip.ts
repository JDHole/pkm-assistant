/** Render paska wątku i biegów w czacie. Komunikacja do suba pozostaje wyłącznie po stronie agenta. */
import { t } from '../../../core/i18n/index.js';
import { SkinManager, setSvg } from '../../crystal-soul/index.js';
import { buildStripModel, formatDuration } from '../../sub-agents/index.js';
import type { StripRow, StripRun, StripState, StripStep, SubTask, SubThread } from '../../sub-agents/index.js';

interface ElOpts { cls?: string; text?: string; attr?: Record<string, string> }
type El = HTMLElement & {
    empty(): void;
    createDiv(opts?: ElOpts): El;
    createSpan(opts?: ElOpts): El;
    createEl<K extends keyof HTMLElementTagNameMap>(tag: K, opts?: ElOpts): HTMLElementTagNameMap[K] & El;
};
interface RegistryLike {
    list?(): SubTask[];
    listThreads?(owner: { agentName: string; sessionPath?: string; sessionEpoch?: string }): SubThread[];
    getThreadMaxRuns?(threadId: string): number;
    requestStop?(id: string, by: 'user'): boolean;
    closeThread?(threadId: string): boolean;
}
interface NotifierLike { pending?(): SubTask[] }
interface PluginLike { subTaskRegistry?: RegistryLike | null; subTaskNotifier?: NotifierLike | null }
interface SubTaskStripContext {
    plugin: PluginLike | null | undefined;
    tabKey: string;
    agentName: string;
    sessionPath?: string;
    sessionEpoch?: string;
    expandedId?: string | null;
    onToggle: (id: string | null) => void;
}

const expandedRunSteps = new WeakMap<El, Set<string>>();

function stateClass(state: StripState): string {
    switch (state.kind) {
        case 'queued': return 'pkm-substrip__chip--queued';
        case 'running': return 'pkm-substrip__chip--running';
        case 'stopping': return 'pkm-substrip__chip--stopping';
        case 'idle': return 'pkm-substrip__chip--idle';
        case 'done': return 'pkm-substrip__chip--done';
        case 'partial': return `pkm-substrip__chip--partial pkm-substrip__chip--partial-${state.reason}`;
        case 'empty': return 'pkm-substrip__chip--empty-result';
        case 'delivery': return 'pkm-substrip__chip--delivery';
        case 'closed': return 'pkm-substrip__chip--closed';
        default: return assertNever(state);
    }
}

function stateLabel(state: StripState): string {
    switch (state.kind) {
        case 'queued': return t('chat.substrip.state_queued');
        case 'running': return t('chat.substrip.state_running');
        case 'stopping': return t('chat.substrip.state_stopping');
        case 'idle': return t('chat.substrip.state_idle');
        case 'done': return t('chat.substrip.state_done');
        case 'partial':
            switch (state.reason) {
                case 'incomplete': return t('chat.substrip.state_partial_incomplete');
                case 'limit': return t('chat.substrip.state_partial_limit');
                case 'timeout': return t('chat.substrip.state_partial_timeout');
                case 'user-stop': return t('chat.substrip.state_partial_user');
                case 'lead-stop': return t('chat.substrip.state_partial_lead');
                case 'system-stop': return t('chat.substrip.state_partial_system');
                case 'error': return t('chat.substrip.state_partial_error');
                case 'uncertain': return t('chat.substrip.state_partial_uncertain');
                default: return assertNever(state.reason);
            }
        case 'empty': return t('chat.substrip.state_empty');
        case 'delivery': return t('chat.substrip.state_delivery');
        case 'closed': return t('chat.substrip.state_closed');
        default: return assertNever(state);
    }
}

function assertNever(value: never): never { throw new Error(`Nieobsługiwany stan: ${String(value)}`); }

function safeCall<T>(fn: () => T, fallback: T): T {
    try { return fn() ?? fallback; } catch { return fallback; }
}

export function renderSubTaskStrip(host: El, ctx: SubTaskStripContext): number {
    const active = host.ownerDocument.activeElement;
    const focusId = active && host.contains(active) ? (active as HTMLElement).dataset?.substripId : undefined;
    const focusRunId = active && host.contains(active) ? (active as HTMLElement).dataset?.substripRunId : undefined;
    const focusStop = active && host.contains(active) && (active as HTMLElement).classList.contains('pkm-substrip__stop');
    host.empty();
    host.classList.add('pkm-substrip');
    const registry = ctx.plugin?.subTaskRegistry;
    const owner = { agentName: ctx.agentName, sessionPath: ctx.sessionPath || undefined, sessionEpoch: ctx.sessionEpoch || undefined };
    const rows = registry?.list
        ? buildStripModel({
            tasks: safeCall(() => registry.list!(), [] as SubTask[]),
            pending: safeCall(() => ctx.plugin?.subTaskNotifier?.pending?.() ?? [], [] as SubTask[]),
            threads: safeCall(() => registry.listThreads?.(owner) ?? [], [] as SubThread[]),
            tabKey: ctx.tabKey, ...owner,
            getThreadRunLimit: id => registry.getThreadMaxRuns?.(id) ?? 0,
        }) : [];
    host.classList.toggle('pkm-substrip--empty', rows.length === 0);
    if (!rows.length) return 0;
    const expanded = rows.find(row => row.id === ctx.expandedId) || null;
    const chips = host.createDiv({ cls: 'pkm-substrip__chips' });
    for (const row of rows) renderChip(chips, row, ctx, expanded?.id === row.id);
    if (expanded) renderDetail(host, host.createDiv({ cls: 'pkm-substrip__detail' }), expanded, registry, ctx);
    if (focusRunId) findRunButton(host, focusRunId)?.focus();
    else if (focusId) findChip(host, focusId)?.focus();
    else if (focusStop) host.querySelector<HTMLElement>('.pkm-substrip__stop')?.focus();
    return rows.length;
}

function findChip(host: El, id: string): HTMLElement | null {
    for (const candidate of Array.from(host.querySelectorAll<HTMLElement>('[data-substrip-id]'))) {
        if (candidate.dataset.substripId === id) return candidate;
    }
    return null;
}

function findRunButton(host: El, id: string): HTMLElement | null {
    for (const candidate of Array.from(host.querySelectorAll<HTMLElement>('[data-substrip-run-id]'))) {
        if (candidate.tagName === 'BUTTON' && candidate.dataset.substripRunId === id) return candidate;
    }
    return null;
}

function renderChip(chips: El, row: StripRow, ctx: SubTaskStripContext, isExpanded: boolean): void {
    const cls = `pkm-substrip__chip ${stateClass(row.state)}` + (isExpanded ? ' pkm-substrip__chip--open' : '');
    const button = chips.createEl('button', {
        cls,
        attr: { type: 'button', 'aria-expanded': String(isExpanded), 'aria-label': `${row.name}: ${stateLabel(row.state)}`, 'data-substrip-id': row.id },
    });
    setSvg(button.createSpan({ cls: 'pkm-substrip__crystal' }), SkinManager.getCrystal(row.name, { size: 12, color: 'currentColor', glow: false }));
    const copy = button.createSpan({ cls: 'pkm-substrip__chip-copy' });
    copy.createSpan({ cls: 'pkm-substrip__name', text: row.name });
    copy.createSpan({ cls: 'pkm-substrip__state', text: stateLabel(row.state) });
    if (row.state.kind === 'queued') button.createSpan({ cls: 'pkm-substrip__queue', text: t('chat.substrip.queue_position', { position: String(row.state.position) }) });
    if (row.threadId && row.runNumber > 0 && row.runLimit) button.createSpan({ cls: 'pkm-substrip__run-number', text: t('chat.substrip.run_number', { number: String(row.runNumber), total: String(row.runLimit) }) });
    button.createSpan({ cls: 'pkm-substrip__time', text: formatDuration(row.durationMs) });
    button.addEventListener('click', event => { event.stopPropagation(); ctx.onToggle(isExpanded ? null : row.id); });
    button.addEventListener('keydown', event => {
        if (event.key === 'Escape' && isExpanded) { event.preventDefault(); ctx.onToggle(null); findChip(chips, row.id)?.focus(); }
    });
}

function renderDetail(host: El, details: El, row: StripRow, registry: RegistryLike | null | undefined, ctx: SubTaskStripContext): void {
    const head = details.createDiv({ cls: 'pkm-substrip__detail-head' });
    head.createSpan({ cls: 'pkm-substrip__detail-status', text: `${row.name} · ${stateLabel(row.state)}` });
    if (row.threadId && row.runNumber && row.runLimit) head.createSpan({ cls: 'pkm-substrip__run-badge', text: t('chat.substrip.run_number', { number: String(row.runNumber), total: String(row.runLimit) }) });
    if (row.state.kind === 'queued') renderStopButton(head, registry, row);
    const remembered = expandedRunSteps.get(host) ?? new Set<string>();
    expandedRunSteps.set(host, remembered);
    if (row.runs.length) {
        const axis = details.createDiv({ cls: 'pkm-substrip__run-axis', attr: { 'aria-label': t('chat.substrip.run_axis') } });
        for (const run of row.runs) renderRunCard(axis, run, row, registry, remembered);
    }
    details.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        ctx.onToggle(null);
        findChip(host, row.id)?.focus();
    });
}

function renderRunCard(axis: El, run: StripRun, row: StripRow, registry: RegistryLike | null | undefined, remembered: Set<string>): void {
    const live = run.state.kind === 'running' || run.state.kind === 'stopping';
    const showSteps = live || remembered.has(run.id);
    const card = axis.createDiv({ cls: `pkm-substrip__run-card pkm-substrip__run-card--${showSteps ? 'expanded' : 'collapsed'}`, attr: { 'data-substrip-run-id': run.id } });
    const header = card.createDiv({ cls: 'pkm-substrip__run-head' });
    header.createEl('strong', { cls: 'pkm-substrip__run-title', text: t('chat.substrip.run_title', { number: String(run.number), title: run.taskPreview || row.name }) });
    header.createSpan({ cls: 'pkm-substrip__run-state', text: run.available ? stateLabel(run.state) : t('chat.substrip.run_unavailable', { number: String(run.number) }) });
    if (live && (row.state.kind === 'running' || row.state.kind === 'stopping')) renderStopButton(header, registry, row);
    if (run.endReason) card.createDiv({ cls: 'pkm-substrip__end-reason', text: run.endReason });
    if (!run.available) {
        card.createDiv({ cls: 'pkm-substrip__unavailable', text: t('chat.substrip.run_unavailable', { number: String(run.number) }) });
        return;
    }
    section(card, 'chat.substrip.heading_task', 'ZLECENIE');
    card.createDiv({ cls: 'pkm-substrip__task', text: run.taskPreview || t('chat.substrip.no_task') });
    const stepsSlot = card.createDiv({ cls: 'pkm-substrip__run-steps' });
    if (showSteps) renderRunSteps(stepsSlot, run);
    if (!live) {
        const toggle = header.createEl('button', {
            cls: 'pkm-substrip__run-toggle', text: showSteps ? t('chat.substrip.collapse_steps') : t('chat.substrip.expand_steps'),
            attr: { type: 'button', 'data-substrip-run-id': run.id, 'aria-expanded': String(showSteps) },
        });
        toggle.addEventListener('click', event => {
            event.stopPropagation();
            if (remembered.has(run.id)) remembered.delete(run.id); else remembered.add(run.id);
            const open = remembered.has(run.id);
            stepsSlot.empty();
            if (open) renderRunSteps(stepsSlot, run);
            card.classList.toggle('pkm-substrip__run-card--expanded', open);
            card.classList.toggle('pkm-substrip__run-card--collapsed', !open);
            toggle.textContent = open ? t('chat.substrip.collapse_steps') : t('chat.substrip.expand_steps');
            toggle.setAttribute('aria-expanded', String(open));
        });
    }
    if (!live) renderRunOutcome(card, run);
    const meta = card.createDiv({ cls: 'pkm-substrip__detail-meta' });
    meta.textContent = `${t('chat.substrip.tokens_in', { count: String(run.tokenInput) })} · ${t('chat.substrip.tokens_out', { count: String(run.tokenOutput) })} · ${t('chat.substrip.tools', { count: String(run.toolCallCount) })} · ${formatDuration(run.durationMs)}`;
}

function renderRunSteps(slot: El, run: StripRun): void {
    section(slot, 'chat.substrip.heading_steps', 'KROKI');
    const steps = slot.createDiv({ cls: 'pkm-substrip__steps' });
    for (const step of run.steps) renderStep(steps, step);
}

function renderRunOutcome(details: El, selected: StripRun): void {
    section(details, 'chat.substrip.heading_created', 'CO POWSTAŁO');
    if (selected.outcome) details.createDiv({ cls: 'pkm-substrip__outcome', text: selected.outcome });
    for (const effect of selected.effects) {
        const targets = effect.targets.map(target => target.path || target.id || '').filter(Boolean).join(', ');
        const label = effect.check === 'matches' ? t('chat.substrip.effect_matches')
            : effect.check === 'not-checked' ? t('chat.substrip.effect_unchecked')
                : effect.expectedCheck === 'exists' ? t('chat.substrip.effect_missing') : t('chat.substrip.effect_mismatch');
        details.createDiv({ cls: 'pkm-substrip__effect', text: `${targets || effect.tool}: ${label}` });
    }
    if (selected.missingTargets.length) {
        section(details, 'chat.substrip.heading_missing', 'CZEGO BRAKUJE');
        for (const target of selected.missingTargets) details.createDiv({ cls: 'pkm-substrip__missing', text: target });
    }
    section(details, 'chat.substrip.heading_effects', 'EFEKTY');
    for (const effect of selected.effects) {
        const label = effect.check === 'matches' ? t('chat.substrip.effect_matches')
            : effect.check === 'not-checked' ? t('chat.substrip.effect_unchecked')
                : effect.expectedCheck === 'exists' ? t('chat.substrip.effect_missing') : t('chat.substrip.effect_mismatch');
        const targets = effect.targets.map(target => target.path || target.id || '').filter(Boolean).join(', ');
        details.createDiv({ cls: `pkm-substrip__effect pkm-substrip__effect--${effect.check}`, text: `${effect.tool} · ${targets} · ${label}` });
    }
}

function section(parent: El, key: string, literal: string): void {
    parent.createDiv({ cls: 'pkm-substrip__section-title', text: t(key) || literal });
}

function renderStep(list: El, step: StripStep): void {
    const line = list.createDiv({ cls: `pkm-substrip__step${step.readOnly ? ' pkm-substrip__step--agent-message' : ''}` });
    line.createSpan({ cls: 'pkm-substrip__step-time', text: formatClock(step.at) });
    line.createSpan({ cls: 'pkm-substrip__step-type', text: step.readOnly ? t('chat.substrip.agent_message') : step.type });
    if (step.readOnly) line.createSpan({ cls: 'pkm-substrip__step-readonly', text: t('chat.substrip.read_only') });
    if (step.tool) line.createSpan({ cls: 'pkm-substrip__step-tool', text: step.tool });
    if (step.detail) line.createSpan({ cls: 'pkm-substrip__step-detail', text: step.detail });
}

function renderStopButton(parent: El, registry: RegistryLike | null | undefined, row: StripRow): void {
    const stopping = row.state.kind === 'stopping';
    const button = parent.createEl('button', { cls: 'pkm-substrip__stop', text: stopping ? t('chat.substrip.state_stopping') : t('chat.substrip.stop'), attr: { type: 'button', 'aria-label': t('chat.substrip.stop_aria', { name: row.name }) } });
    button.disabled = stopping;
    button.addEventListener('click', event => {
        event.stopPropagation();
        const stopped = row.state.kind === 'queued'
            ? safeCall(() => registry?.closeThread?.(row.threadId || row.id), false)
            : safeCall(() => registry?.requestStop?.(row.runs[row.runs.length - 1]?.id || row.id, 'user'), false);
        if (stopped) { button.textContent = t('chat.substrip.stopping'); button.disabled = true; }
    });
}

function formatClock(at: number): string {
    const date = new Date(at);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}
