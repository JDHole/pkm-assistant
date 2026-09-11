/**
 * Team/Ekipa tab (Ekipa) - sub-agenci agenta.
 *
 * Kafelek członka: nazwa (etykieta roli) · model · liczba narzędzi · limit iteracji.
 * Klik = CAŁY SIDEBAR (sub-agent-detail) - dokładna instrukcja + narzędzia + model + iteracje,
 * wszystko edytowalne (SubAgentEditorModal), zapis do YAML suba. Dodawanie „od zera".
 *
 * Jeden generyczny worker + custom suby (po nazwie, prefiks <agent-slug>-). Rola = etykieta
 * opisowa. Overrides per-sub (prompt_append/extra_tools) WTOPIONE w edycję detalu - osobny
 * formularz override skasowany (jedno miejsce edycji suba).
 *
 * Pętla szablonów: „+ od zera" ma checkbox „Zapisz też jako szablon", jest „+ z szablonu"
 * (odlanie kopii z Zaplecza), a kafelek członka niesie ślad „Z szablonu: X vN" (kopia, nie link).
 */
import { UiIcons, setSvg } from '../../crystal-soul/index.js';
import { renderToggle } from './profile_helpers.js';
import { getVisibleSubAgentsForAgent } from '../../sub-agents/index.js';
import { t } from '../../../core/i18n/index.js';
import type { ProfileCtx } from './profile_types.js';
import type { AgentSubAgentAssignment } from '../Agent.js';
import type { SubAgentData, SubAgentLoader } from '../../sub-agents/index.js';
import type { SidebarNav } from '../../shell/index.js';

/**
 * @param {Object} ctx - shared context
 * @param {HTMLElement} el
 */
export function renderEkipaTab(ctx: ProfileCtx, el: HTMLElement) {
    const { formData, nav, plugin } = ctx;
    const loader = plugin.agentManager?.subAgentLoader;
    const visible = _visibleSubs(ctx);

    const head = el.createDiv({ cls: 'cs-section-head' });
    setSvg(head, UiIcons.users(14));
    head.createSpan({ text: t('profile.team.members_header') });

    const assigned = formData.sub_agents.filter((a: AgentSubAgentAssignment) => visible.some((s: SubAgentData) => s.name === a.name));
    const missing = formData.sub_agents.filter((a: AgentSubAgentAssignment) => !visible.some((s: SubAgentData) => s.name === a.name));

    if (missing.length > 0) {
        const warn = el.createDiv({ cls: 'cs-warning-banner' });
        setSvg(warn, UiIcons.info(14));
        warn.createSpan({ text: ` ${t('profile.team.missing_subs', { names: missing.map((m: AgentSubAgentAssignment) => m.name).join(', ') })}` });
    }

    // ── Member tiles ──
    if (assigned.length === 0) {
        el.createDiv({ cls: 'cs-picker__empty', text: t('profile.team.no_members') });
    } else {
        const grid = el.createDiv({ cls: 'cs-shards cs-shards--compact' });
        for (const assignment of assigned) {
            _renderMemberTile(ctx, grid, assignment, loader, nav);
        }
    }

    // ── Add member ──
    _renderAssignExisting(ctx, el, visible);
    _renderAddFromScratch(ctx, el);
    // Odlanie kopii z formy odlewniczej Zaplecza.
    _renderAddFromTemplate(ctx, el);
    el.createDiv({ text: t('profile.team.detail_hint'), cls: 'setting-item-description' });

    // ── Delegation toggle ──
    renderToggle(el, t('profile.team.delegate_to_subagents'), t('profile.team.delegate_desc'),
        formData.sub_agent_enabled, v => { formData.sub_agent_enabled = v; });
}

function _visibleSubs(ctx: ProfileCtx) {
    const all = ctx.plugin.agentManager?.subAgentLoader?.getAllSubAgents?.() || [];
    return getVisibleSubAgentsForAgent({ name: ctx.formData?.name, activeSubAgents: ctx.formData?.sub_agents || [] } as unknown as { name?: string }, all);
}

function _renderMemberTile(ctx: ProfileCtx, grid: HTMLElement, assignment: AgentSubAgentAssignment, loader: SubAgentLoader | undefined, nav: SidebarNav) {
    const { formData } = ctx;
    const cfg = (loader?.getSubAgent?.(assignment.name) || {}) as Partial<SubAgentData>;
    const isDefault = assignment.default === true;
    const isActive = assignment.active !== false;

    const shard = grid.createDiv({ cls: `cs-shard cs-shard--big ${isActive ? 'cs-shard--filled' : 'cs-shard--empty'}` });
    shard.addClass('cs-shard--clickable');

    const iconEl = shard.createDiv({ cls: 'cs-shard__icon' });
    setSvg(iconEl, UiIcons.robot(24));

    const nameRow = shard.createDiv({ cls: 'cs-shard__main-label' });
    nameRow.textContent = assignment.name;
    if (cfg.role) {
        const roleBadge = nameRow.createSpan({ cls: 'cs-badge cs-badge--default', text: cfg.role });
        roleBadge.addClass('cs-shard-badge');
    }
    if (isDefault) {
        const dfBadge = nameRow.createSpan({ cls: 'cs-badge cs-badge--prep', text: t('profile.prompt.default_badge') });
        dfBadge.addClass('cs-shard-badge');
    }
    // Ślad pochodzenia kopii („z szablonu: X vN") na kafelku członka Ekipy.
    if (cfg.from_template) {
        const originBadge = nameRow.createSpan({
            cls: 'cs-badge cs-badge--default',
            text: `${t('detail.from_template')} ${cfg.from_template}`,
        });
        originBadge.addClass('cs-shard-badge');
    }

    // model · N narzędzi · M iteracji
    const toolCount = Array.isArray(cfg.tools) ? cfg.tools.length : 0;
    const iters = cfg.max_iterations ?? 8;
    const model = cfg.model || t('profile.team.model_inherited');
    shard.createDiv({ cls: 'cs-shard__sub-label', text: `${model} · ${t('profile.team.tools_n', { n: toolCount })} · ${t('profile.team.iters_n', { n: iters })}` });

    // Klik w kafelek = pełny widok suba (edytowalny drugi LLM).
    shard.addEventListener('click', () => {
        nav.push('sub-agent-detail', { subAgentName: assignment.name }, formData.name);
    });

    // Controls: default (★), active toggle, remove.
    const star = shard.createEl('button', { cls: 'clickable-icon cs-shard__action', title: t('profile.team.set_default') });
    star.textContent = isDefault ? '★' : '☆';
    star.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        if (isDefault) { assignment.default = false; }
        else { formData.sub_agents.forEach((it: AgentSubAgentAssignment) => { it.default = false; }); assignment.default = true; }
        ctx.renderActiveTab();
    });

    const activeBtn = shard.createEl('button', { cls: 'clickable-icon cs-shard__action', title: t('profile.team.toggle_active') });
    setSvg(activeBtn, isActive ? UiIcons.eye(12) : UiIcons.eyeOff ? UiIcons.eyeOff(12) : UiIcons.eye(12));
    activeBtn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        if (isActive) assignment.active = false; else delete assignment.active;
        ctx.renderActiveTab();
    });

    const removeBtn = shard.createEl('button', { cls: 'clickable-icon cs-shard__remove', title: t('profile.team.remove_member') });
    setSvg(removeBtn, UiIcons.x(10));
    removeBtn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        const idx = formData.sub_agents.findIndex((m: AgentSubAgentAssignment) => m.name === assignment.name);
        if (idx >= 0) formData.sub_agents.splice(idx, 1);
        ctx.renderActiveTab();
    });
}

/** Assign an already-defined (prefixed) sub that isn't assigned yet. */
function _renderAssignExisting(ctx: ProfileCtx, el: HTMLElement, visible: SubAgentData[]) {
    const { formData } = ctx;
    const unassigned = visible.filter((s: SubAgentData) => !formData.sub_agents.some((a: AgentSubAgentAssignment) => a.name === s.name));
    if (unassigned.length === 0) return;

    const wrap = el.createDiv({ cls: 'cs-picker' });
    const addBtn = wrap.createDiv({ cls: 'cs-picker__add-btn' });
    setSvg(addBtn, UiIcons.plus(12));
    addBtn.createSpan({ text: t('profile.team.assign_existing') });

    const dropWrap = wrap.createDiv({ cls: 'cs-picker__dropdown-wrap' });
    const dropdown = dropWrap.createDiv({ cls: 'cs-picker__dropdown cs-collapsed' });
    const optionsEl = dropdown.createDiv({ cls: 'cs-picker__options' });

    for (const sub of unassigned) {
        const opt = optionsEl.createDiv({ cls: 'cs-picker__option' });
        setSvg(opt.createDiv({ cls: 'cs-picker__option-icon' }), UiIcons.robot(16));
        opt.createSpan({ cls: 'cs-picker__option-name', text: sub.name });
        if (sub.description) opt.createSpan({ cls: 'cs-picker__option-desc', text: sub.description });
        opt.addEventListener('click', () => {
            const entry: AgentSubAgentAssignment = { name: sub.name, role: sub.role || 'researcher' };
            if (formData.sub_agents.length === 0) entry.default = true;
            formData.sub_agents.push(entry);
            ctx.renderActiveTab();
        });
    }

    addBtn.addEventListener('click', () => {
        dropdown.classList.toggle('cs-collapsed');
    });
    const closeHandler = (e: KeyboardEvent | MouseEvent) => {
        if ((e as KeyboardEvent).key === 'Escape' || (e.type === 'click' && !dropWrap.contains(e.target as Node) && !addBtn.contains(e.target as Node))) {
            dropdown.addClass('cs-collapsed');
        }
    };
    document.addEventListener('click', closeHandler);
    document.addEventListener('keydown', closeHandler);
    const observer = new MutationObserver(() => {
        if (!el.contains(wrap)) {
            document.removeEventListener('click', closeHandler);
            document.removeEventListener('keydown', closeHandler);
            observer.disconnect();
        }
    });
    observer.observe(el.parentElement || el, { childList: true });
}

/**
 * Create a brand-new sub-agent from scratch (editor modal) and auto-assign it.
 * Modal umie od razu dołożyć formę odlewniczą do Zaplecza („Zapisz też jako szablon").
 */
function _renderAddFromScratch(ctx: ProfileCtx, el: HTMLElement) {
    const { formData, plugin } = ctx;
    const btn = el.createEl('button', { cls: 'cs-preset-btn', text: t('profile.team.add_from_scratch') });
    btn.addEventListener('click', () => {
        void (async () => {
            // Modal mieszka w `modules/sub-agents/` i statycznie ciągnie `obsidian`, więc barrel
            // subów wydaje go leniwym akcesorem - ładujemy dopiero tutaj, w handlerze kliknięcia.
            const { loadSubAgentEditorModal } = await import('../../sub-agents/index.js');
            const SubAgentEditorModal = await loadSubAgentEditorModal();
            const loader = plugin.agentManager?.subAgentLoader;
            const before = new Set(_visibleSubs(ctx).map((s: SubAgentData) => s.name));
            new SubAgentEditorModal(plugin.app, plugin, null, () => {
                void (async () => {
                    try { await loader?.reloadSubAgents?.(); } catch { /* best effort */ }
                    // Auto-assign any newly-created sub that is visible to this agent (prefix <agent>-).
                    for (const s of _visibleSubs(ctx)) {
                        if (!before.has(s.name) && !formData.sub_agents.some((a: AgentSubAgentAssignment) => a.name === s.name)) {
                            const entry: AgentSubAgentAssignment = { name: s.name, role: s.role || 'researcher' };
                            if (formData.sub_agents.length === 0) entry.default = true;
                            formData.sub_agents.push(entry);
                        }
                    }
                    ctx.renderActiveTab();
                })();
            }, { alsoTemplate: true }).open();
        })();
    });
    el.createDiv({ text: t('profile.team.add_from_scratch_hint'), cls: 'setting-item-description' });
}

/** „+ z szablonu" - odlej kopię suba z Zaplecza do Ekipy tego agenta. */
function _renderAddFromTemplate(ctx: ProfileCtx, el: HTMLElement) {
    const { formData, plugin } = ctx;
    const store = plugin.agentManager?.subAgentTemplateStore;
    const templates = store?.list() || [];
    if (templates.length === 0) return;

    const wrap = el.createDiv({ cls: 'cs-picker' });
    const addBtn = wrap.createDiv({ cls: 'cs-picker__add-btn' });
    setSvg(addBtn, UiIcons.plus(12));
    addBtn.createSpan({ text: t('profile.team.add_from_template') });

    const dropWrap = wrap.createDiv({ cls: 'cs-picker__dropdown-wrap' });
    const dropdown = dropWrap.createDiv({ cls: 'cs-picker__dropdown cs-collapsed' });
    const optionsEl = dropdown.createDiv({ cls: 'cs-picker__options' });

    for (const tpl of templates) {
        const opt = optionsEl.createDiv({ cls: 'cs-picker__option' });
        setSvg(opt.createDiv({ cls: 'cs-picker__option-icon' }), UiIcons.robot(16));
        opt.createSpan({ cls: 'cs-picker__option-name', text: `${tpl.name} · v${tpl.version || 1}` });
        if (tpl.description) opt.createSpan({ cls: 'cs-picker__option-desc', text: tpl.description });
        opt.addEventListener('click', () => {
            void (async () => {
                dropdown.classList.add('cs-collapsed');
                const { Notice } = await import('obsidian');
                const result = await store.instantiate(tpl.slug, formData.name, {
                    subAgentLoader: plugin.agentManager.subAgentLoader,
                });
                if (!result?.success) {
                    new Notice(t('backstage.template_use_failed', { error: result?.error || '?' }));
                    return;
                }
                if (result.renamed) new Notice(t('backstage.template_slug_taken', { name: result.name }));
                if (!formData.sub_agents.some((a: AgentSubAgentAssignment) => a.name === result.name)) {
                    const entry: AgentSubAgentAssignment = { name: result.name as string, role: 'researcher' };
                    if (formData.sub_agents.length === 0) entry.default = true;
                    formData.sub_agents.push(entry);
                }
                ctx.renderActiveTab();
            })();
        });
    }

    addBtn.addEventListener('click', () => dropdown.classList.toggle('cs-collapsed'));
}
