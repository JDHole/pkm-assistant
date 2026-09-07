/**
 * Skills tab (Umiejętności) — E2.8 C5 (S10/S11/S16/S30).
 *
 * Rama: co agent UMIE = przepisy (skille) + podpięte programy (konektory).
 *  - Skille: grid per KATEGORIA (frontmatter `category`), badge „📎 dodatki" gdy skill ma
 *    template/references/examples (S30), klik → pełny widok skilla na sidebar (skill-detail).
 *  - Konektory: zewnętrzne serwery MCP usera (source='user') przypinane do agenta; pełna
 *    mechanika klienta MCP wchodzi w E3.1.
 *
 * WYPROWADZKI (zgodnie z makietą): cały dawny pod-tab MCP (whitelist serwerów / karty / narzędzia
 * standalone / grid built-in) → Uprawnienia (C1/C7); can_message → skasowane (A4/F7); Playbook
 * Builder → skasowany (A4).
 *
 * S27 Z6: TU jest miejsce narodzin żywego skilla („+ nowy skill" — po Z2 Zaplecze pokazuje
 * już tylko szablony) + „+ z szablonu" (odlanie kopii). Ślad „Z szablonu: X vN" na kafelku.
 */
import { IconGenerator, UiIcons, setSvg } from '../../crystal-soul/index.js';
import { showSkillOverrideForm } from './profile_skills_overrides.js';
import { t } from '../../../core/i18n/index.js';

// TS-any: Obsidian's augmented HTMLElement helpers and plugin UI services cross an untyped runtime boundary here.
type UiBoundary = any;
type Skill = { name: string; slug?: string; category?: string; icon_category?: string; description?: string; hasTemplate?: boolean; hasReferences?: boolean; hasExamples?: boolean; fromTemplate?: string };
type SkillAssignment = { name: string };
type SkillTemplate = { name: string; slug: string; version?: number; description?: string };
type Connector = { key: string; label: string; description: string; toolCount: number; icon: null };
type SkillsContext = { formData: { name?: string; skills: SkillAssignment[]; mcp_servers: string[]; preferred_servers: string[] }; nav: UiBoundary; plugin: UiBoundary; renderActiveTab(): void };

/**
 * @param {Object} ctx - shared context
 * @param {HTMLElement} el
 */
export function renderSkillsTab(ctx: SkillsContext, el: UiBoundary) {
    _renderSkillsSection(ctx, el);
    _renderKonektorySection(ctx, el);
}

// ─────────────────────────────────────────────────────────────
// SKILLE — biblioteka umiejętności grupowana kategoriami
// ─────────────────────────────────────────────────────────────

function _renderSkillsSection(ctx: SkillsContext, el: UiBoundary) {
    const { formData, nav } = ctx;
    const skillLoader = ctx.plugin.agentManager?.skillLoader;

    const head = el.createDiv({ cls: 'cs-section-head' });
    setSvg(head, UiIcons.zap(14));
    head.createSpan({ text: t('profile.skills.library_header') });

    if (!skillLoader) {
        el.createEl('p', { text: t('profile.skills.no_skills'), cls: 'agent-profile-empty' });
        return;
    }
    const allSkills: Skill[] = skillLoader.getAllSkills();

    // Skille przypisane agentowi (te renderujemy w bibliotece, pogrupowane po kategorii).
    const assigned = formData.skills
        .map((s: SkillAssignment) => ({ assignment: s, skill: allSkills.find((sk: Skill) => (sk.slug || sk.name) === s.name) }))
        .filter((x) => x.skill) as Array<{ assignment: SkillAssignment; skill: Skill }>;
    const missing = formData.skills.filter((s: SkillAssignment) => !allSkills.find((sk: Skill) => (sk.slug || sk.name) === s.name));

    if (missing.length > 0) {
        const warn = el.createDiv({ cls: 'cs-warning-banner' });
        setSvg(warn, UiIcons.info(14));
        warn.createSpan({ text: ` ${t('profile.skills.missing_skills', { names: missing.map((s: SkillAssignment) => s.name).join(', ') })}` });
    }

    if (assigned.length === 0) {
        el.createDiv({ cls: 'cs-picker__empty', text: t('profile.skills.no_skills_assigned') });
    } else {
        // Grupowanie po kategorii (frontmatter `category`; user-defined = unikalne wartości).
        const byCat = new Map<string, { assignment: SkillAssignment; skill: Skill }[]>();
        for (const item of assigned) {
            const cat = item.skill.category || 'general';
            if (!byCat.has(cat)) byCat.set(cat, []);
            byCat.get(cat)!.push(item);
        }
        for (const [cat, items] of byCat) {
            const catHead = el.createDiv({ cls: 'cs-section-head cs-section-head--sub' });
            catHead.createSpan({ text: _categoryLabel(cat) });

            const grid = el.createDiv({ cls: 'cs-shards cs-shards--compact' });
            for (const { skill, assignment } of items) {
                _renderSkillShard(ctx, grid, el, skill, assignment, nav);
            }
        }
    }

    // „+ dodaj skill" — przypisz istniejący.
    _renderAddSkill(ctx, el, allSkills);
    // S27 Z6: miejsce NARODZIN żywego skilla (po Z2 Zaplecze pokazuje już tylko szablony)
    // + odlanie kopii z formy odlewniczej.
    _renderNewSkill(ctx, el);
    _renderSkillFromTemplate(ctx, el);
}

function _renderSkillShard(ctx: SkillsContext, grid: UiBoundary, parentEl: UiBoundary, skill: Skill, assignment: SkillAssignment, nav: UiBoundary) {
    const { formData } = ctx;
    const hasAttachments = skill.hasTemplate || skill.hasReferences || skill.hasExamples;

    const shard = grid.createDiv({ cls: 'cs-shard cs-shard--filled cs-shard--skill' });
    shard.addClass('cs-shard--clickable');

    const iconEl = shard.createDiv({ cls: 'cs-shard__icon' });
    setSvg(iconEl, IconGenerator.generate(skill.name || 'skill', skill.icon_category || 'arcane', { size: 24, color: 'currentColor' }));

    const labelEl = shard.createDiv({ cls: 'cs-shard__main-label' });
    labelEl.textContent = skill.name;
    if (hasAttachments) {
        const badge = labelEl.createSpan({ cls: 'cs-badge cs-badge--auto', text: `📎 ${t('profile.skills.attachments')}` });
        badge.addClass('cs-shard-badge');
    }
    // S27 Z6: ślad pochodzenia kopii — widać z której formy odlewniczej wyszedł ten skill.
    if (skill.fromTemplate) {
        const originBadge = labelEl.createSpan({
            cls: 'cs-badge cs-badge--default',
            text: `${t('detail.from_template')} ${skill.fromTemplate}`,
        });
        originBadge.addClass('cs-shard-badge');
    }
    if (skill.description) shard.createDiv({ cls: 'cs-shard__sub-label', text: skill.description });

    // Klik w kartę = pełny widok skilla na cały sidebar (wszystko co widzi LLM, edytowalne).
    shard.addEventListener('click', () => {
        nav.push('skill-detail', { skillName: skill.slug || skill.name }, formData.name);
    });

    // Override per-agent (prompt_append itd.) — mały guzik, nie główna akcja.
    const editBtn = shard.createEl('button', { cls: 'clickable-icon cs-shard__action' });
    setSvg(editBtn, UiIcons.edit(12));
    editBtn.title = t('profile.skills.edit_for_agent');
    editBtn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        showSkillOverrideForm(parentEl, skill, assignment, () => ctx.renderActiveTab());
    });

    const removeBtn = shard.createEl('button', { cls: 'clickable-icon cs-shard__remove' });
    setSvg(removeBtn, UiIcons.x(10));
    removeBtn.title = t('profile.skills.remove_skill');
    removeBtn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        formData.skills = formData.skills.filter((s: SkillAssignment) => s.name !== (skill.slug || skill.name));
        ctx.renderActiveTab();
    });
}

function _renderAddSkill(ctx: SkillsContext, el: UiBoundary, allSkills: Skill[]) {
    const { formData } = ctx;
    const isAssigned = (id: string) => formData.skills.some((s: SkillAssignment) => s.name === id);
    const unassigned = allSkills.filter((s: Skill) => !isAssigned(s.slug || s.name));
    if (unassigned.length === 0) return;

    const wrap = el.createDiv({ cls: 'cs-picker' });
    const addBtn = wrap.createDiv({ cls: 'cs-picker__add-btn' });
    setSvg(addBtn, UiIcons.plus(12));
    addBtn.createSpan({ text: t('profile.skills.add_skill') });

    const dropWrap = wrap.createDiv({ cls: 'cs-picker__dropdown-wrap' });
    const dropdown = dropWrap.createDiv({ cls: 'cs-picker__dropdown cs-collapsed' });

    const searchWrap = dropdown.createDiv({ cls: 'cs-picker__search-wrap' });
    setSvg(searchWrap, UiIcons.search(12));
    const searchInput = searchWrap.createEl('input', {
        cls: 'cs-picker__search', attr: { type: 'text', placeholder: t('profile.skills.search_skill') }
    });
    const optionsEl = dropdown.createDiv({ cls: 'cs-picker__options' });

    function renderOptions(filter = '') {
        optionsEl.empty();
        const lf = filter.toLowerCase();
        const filtered = unassigned.filter((s: Skill) => s.name.toLowerCase().includes(lf));
        if (filtered.length === 0) {
            optionsEl.createDiv({ cls: 'cs-picker__no-results', text: t('profile.skills.no_results') });
            return;
        }
        for (const skill of filtered) {
            const opt = optionsEl.createDiv({ cls: 'cs-picker__option' });
            const optIcon = opt.createDiv({ cls: 'cs-picker__option-icon' });
            setSvg(optIcon, IconGenerator.generate(skill.name || 'skill', skill.icon_category || 'arcane', { size: 16, color: 'currentColor' }));
            opt.createSpan({ cls: 'cs-picker__option-name', text: skill.name });
            if (skill.description) opt.createSpan({ cls: 'cs-picker__option-desc', text: skill.description });
            opt.addEventListener('click', () => {
                formData.skills.push({ name: skill.slug || skill.name });
                ctx.renderActiveTab();
            });
        }
    }
    searchInput.addEventListener('input', () => renderOptions(searchInput.value));

    addBtn.addEventListener('click', () => {
        dropdown.classList.toggle('cs-collapsed');
        const isOpen = !dropdown.classList.contains('cs-collapsed');
        if (isOpen) { renderOptions(); searchInput.value = ''; searchInput.focus(); }
    });

    const closeHandler = (e: Event) => {
        if ((e as KeyboardEvent).key === 'Escape' || (e.type === 'click' && !dropWrap.contains(e.target) && !addBtn.contains(e.target))) {
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
 * S27 Z6: „+ nowy skill" — jedyne miejsce narodzin ŻYWEGO skilla (Zaplecze trzyma szablony).
 * Modal umie od razu dołożyć formę odlewniczą („Zapisz też jako szablon w Zapleczu").
 */
function _renderNewSkill(ctx: SkillsContext, el: UiBoundary) {
    const { formData, plugin } = ctx;
    const btn = el.createEl('button', { cls: 'cs-preset-btn', text: t('profile.skills.new_skill') });
    btn.addEventListener('click', async () => {
        const { loadSkillEditorModal } = await import('../../skills/index.js');
        const SkillEditorModal = await loadSkillEditorModal();
        new SkillEditorModal(plugin.app, plugin, null, (saved?: UiBoundary) => {
            void (async () => {
                const loader = plugin.agentManager?.skillLoader;
                try { await loader?.reloadSkills?.(); } catch { /* best effort */ }
                // Auto-przypisanie świeżo utworzonego skilla temu agentowi.
                const created = saved?.name ? loader?.getSkill?.(saved.name) : null;
                const id = created ? (created.slug || created.name) : null;
                if (id && !formData.skills.some((s: SkillAssignment) => s.name === id)) {
                    formData.skills.push({ name: id });
                }
                ctx.renderActiveTab();
            })();
        }, { alsoTemplate: true }).open();
    });
    el.createDiv({ text: t('profile.skills.new_skill_hint'), cls: 'setting-item-description' });
}

/** S27 Z6: „+ z szablonu" — odlej kopię z Zaplecza i przypisz ją temu agentowi (D3). */
function _renderSkillFromTemplate(ctx: SkillsContext, el: UiBoundary) {
    const { formData, plugin } = ctx;
    const store = plugin.agentManager?.skillTemplateStore;
    const templates: SkillTemplate[] = store?.list() || [];
    if (templates.length === 0) return;

    const wrap = el.createDiv({ cls: 'cs-picker' });
    const addBtn = wrap.createDiv({ cls: 'cs-picker__add-btn' });
    setSvg(addBtn, UiIcons.plus(12));
    addBtn.createSpan({ text: t('profile.skills.from_template') });

    const dropWrap = wrap.createDiv({ cls: 'cs-picker__dropdown-wrap' });
    const dropdown = dropWrap.createDiv({ cls: 'cs-picker__dropdown cs-collapsed' });
    const optionsEl = dropdown.createDiv({ cls: 'cs-picker__options' });

    for (const tpl of templates) {
        const opt = optionsEl.createDiv({ cls: 'cs-picker__option' });
        opt.createSpan({ cls: 'cs-picker__option-name', text: `${tpl.name} · v${tpl.version || 1}` });
        if (tpl.description) opt.createSpan({ cls: 'cs-picker__option-desc', text: tpl.description });
        opt.addEventListener('click', async () => {
            dropdown.classList.add('cs-collapsed');
            const { Notice } = await import('obsidian');
            const result = await store.instantiate(tpl.slug, { skillLoader: plugin.agentManager.skillLoader });
            if (!result?.success) {
                new Notice(t('backstage.template_use_failed', { error: result?.error || '?' }));
                return;
            }
            if (result.renamed) new Notice(t('backstage.template_slug_taken', { name: result.name }));
            if (!formData.skills.some((s: SkillAssignment) => s.name === result.slug)) {
                formData.skills.push({ name: result.slug });
            }
            ctx.renderActiveTab();
        });
    }

    addBtn.addEventListener('click', () => dropdown.classList.toggle('cs-collapsed'));
}

/** Kapitalizowana etykieta kategorii (kategorie są user-defined z frontmatterów). */
function _categoryLabel(cat: string) {
    const key = `skill.category.${cat}`;
    const label = t(key);
    if (label !== key) return label;
    return cat.charAt(0).toUpperCase() + cat.slice(1);
}

// ─────────────────────────────────────────────────────────────
// KONEKTORY — zewnętrzne serwery MCP usera przypięte do agenta
// ─────────────────────────────────────────────────────────────

function _renderKonektorySection(ctx: SkillsContext, el: UiBoundary) {
    const { formData, plugin } = ctx;

    const head = el.createDiv({ cls: 'cs-section-head cs-section-head--spaced' });
    setSvg(head, UiIcons.wrench(14));
    head.createSpan({ text: t('profile.skills.connectors_header') });
    el.createDiv({ text: t('profile.skills.connectors_desc'), cls: 'setting-item-description' });

    // E3.1: external MCP servers (real client) — keyed by server ID (tool.serverName === id,
    // co jest osią opt-in w ToolRegistry.filterByAgent). Status/toolCount z managera (R2).
    // Legacy user-JS serwery (serverLoader source:'user') wycięte w fazie C (D-A).
    const connectors = _externalConnectors(plugin);
    if (connectors.length === 0) {
        el.createDiv({ cls: 'cs-picker__empty', text: t('profile.skills.no_connectors') });
        return;
    }

    if (!Array.isArray(formData.mcp_servers)) formData.mcp_servers = ['vault', 'memory', 'core'];
    if (!Array.isArray(formData.preferred_servers)) formData.preferred_servers = [];
    const grid = el.createDiv({ cls: 'cs-shards cs-shards--compact' });
    for (const server of connectors) {
        const pinned = formData.mcp_servers.includes('*') || formData.mcp_servers.includes(server.key);
        const shard = grid.createDiv({ cls: `cs-shard cs-shard--mcp-server ${pinned ? 'cs-shard--filled' : 'cs-shard--empty'}` });

        const iconEl = shard.createDiv({ cls: 'cs-shard__icon' });
        try {
            setSvg(iconEl, server.icon ? IconGenerator.generate(server.label, server.icon, { size: 24, color: 'currentColor' }) : UiIcons.wrench(24));
        } catch { setSvg(iconEl, UiIcons.wrench(24)); }

        shard.createDiv({ cls: 'cs-shard__main-label', text: `${server.label} (${server.toolCount})` });
        if (server.description) shard.createDiv({ cls: 'cs-shard__sub-label', text: server.description });

        // Toggle „przypięty do agenta" (pin = mcp_servers + preferred_servers, keyed by server.key).
        const toggle = shard.createDiv({ cls: `cs-toggle ${pinned ? 'cs-toggle--on' : ''}` });
        toggle.addClass('cs-shard__corner-toggle');
        toggle.createDiv({ cls: 'cs-toggle__track' });
        toggle.createDiv({ cls: 'cs-toggle__thumb' });
        toggle.addEventListener('click', (e: Event) => {
            e.stopPropagation();
            if (formData.mcp_servers.includes('*')) return; // wildcard — nic nie zmieniamy per-serwer
            const nowPinned = !formData.mcp_servers.includes(server.key);
            if (nowPinned) {
                formData.mcp_servers.push(server.key);
                if (!formData.preferred_servers.includes(server.key)) formData.preferred_servers.push(server.key);
            } else {
                formData.mcp_servers = formData.mcp_servers.filter((n: string) => n !== server.key);
                formData.preferred_servers = formData.preferred_servers.filter((n: string) => n !== server.key);
            }
            ctx.renderActiveTab();
        });
    }
}

/**
 * External MCP servers dla listy konektorów profilu agenta (E3.1). Zaciąga id + nazwę + liczbę
 * narzędzi ze snapshotu managera (`listServersForUi`), a gdy manager niedostępny — z samego configu.
 * @returns {Array<{key:string,label:string,description:string,toolCount:number,icon:null}>}
 */
function _externalConnectors(plugin: UiBoundary): Connector[] {
    const transportDesc = (tr: string) => (tr === 'http'
        ? t('profile.skills.connector_transport_http')
        : t('profile.skills.connector_transport_stdio'));
    const mgr = plugin?.externalMcpManager;
    if (mgr?.listServersForUi) {
        try {
            return mgr.listServersForUi().map((s: { id: string; name: string; transport: string; toolCount?: number }) => ({
                key: s.id, label: s.name, description: transportDesc(s.transport), toolCount: s.toolCount || 0, icon: null,
            }));
        } catch { /* fall through to raw config */ }
    }
    const cfgs = plugin?.env?.settings?.pkmAssistant?.externalMcpServers;
    if (!Array.isArray(cfgs)) return [];
    return cfgs.map((c: { id: string; name?: string; transport?: string }) => ({
        key: c.id, label: c.name || c.id, description: transportDesc(c.transport || 'stdio'), toolCount: 0, icon: null,
    }));
}
