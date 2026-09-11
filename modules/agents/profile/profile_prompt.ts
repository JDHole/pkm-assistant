/**
 * Prompt tab - inspector and editor for system prompt composition.
 */
import { Notice } from 'obsidian';
import { FACTORY_DEFAULTS, DECISION_TREE_GROUPS, DECISION_TREE_DEFAULTS } from '../../prompts/index.js';
import { HiddenFileEditorModal } from './HiddenFileEditorModal.js';
import { StartPromptGeneratorModal } from './StartPromptGeneratorModal.js';
import { UiIcons, setSvg, setSvgLabel } from '../../crystal-soul/index.js';
import { t } from '../../../core/i18n/index.js';
import type { ProfileCtx } from './profile_types.js';

/** Matches PromptBuilder.getSections()'s inline object shape (modules/prompts/PromptBuilder.ts). */
type PromptSection = { key: string; label: string; tokens: number; enabled: boolean; required: boolean; category: string; content: string; editable: boolean };
/** Custom per-agent decision-tree instruction (`custom_<group>_<ts>` keys). */
type DTCustomEntry = { group: string; text: string; tool: string | null };
type DTInstrValue = boolean | string | DTCustomEntry;
/** TS-boundary: `plugin.env.settings.pkmAssistant` fields this file reads - open user-config bag. */
type PkmPromptSettings = { disabledPromptSections?: string[]; promptDefaults?: Record<string, unknown> };
/** Work-prompt fields on ProfileFormData (all plain strings) - see _renderWorkPrompts. */
type WorkPromptKey = 'compression_prompt' | 'save_session_prompt' | 'archive_prompt' | 'summary_prompt' | 'subagent_frame_prompt';
/** TS-boundary: formData.prompt_overrides is an open user-config bag (Record<string, unknown>) -
 * these are the fields this file actually reads/writes on it. */
type PromptOverridesBag = Record<string, unknown> & { disabledSections?: string[]; decisionTreeInstructions?: Record<string, DTInstrValue> };

const SVG_X = '<svg viewBox="0 0 12 12" width="12" height="12"><line x1="3" y1="3" x2="9" y2="9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="9" y1="3" x2="3" y2="9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/**
 * @param {Object} ctx - shared context
 * @param {HTMLElement} el
 */
export async function renderPromptTab(ctx: ProfileCtx, el: HTMLElement) {
    const subTabBar = el.createDiv({ cls: 'cs-profile-tabs cs-profile-tabs--2col' });

    const inspectorBtn = subTabBar.createEl('button', {
        cls: `cs-profile-tab ${ctx.activePromptSubTab === 'inspector' ? 'cs-profile-tab--active' : ''}`
    });
    setSvg(inspectorBtn.createSpan(), UiIcons.eye(14));
    inspectorBtn.createSpan({ text: t('profile.prompt.inspector') });

    const editorBtn = subTabBar.createEl('button', {
        cls: `cs-profile-tab ${ctx.activePromptSubTab === 'editor' ? 'cs-profile-tab--active' : ''}`
    });
    setSvg(editorBtn.createSpan(), UiIcons.edit(14));
    editorBtn.createSpan({ text: t('profile.prompt.editor') });

    const subContent = el.createDiv();

    async function renderSubContent() {
        subContent.empty();
        if (ctx.activePromptSubTab === 'inspector') {
            await _renderPromptInspector(ctx, subContent);
        } else {
            _renderPromptEditor(ctx, subContent);
        }
    }

    for (const [btn, key] of [[inspectorBtn, 'inspector'], [editorBtn, 'editor']] as Array<[HTMLButtonElement, 'inspector' | 'editor']>) {
        btn.addEventListener('click', () => {
            ctx.activePromptSubTab = key;
            subTabBar.querySelectorAll('.cs-profile-tab').forEach((t: Element) => t.classList.remove('cs-profile-tab--active'));
            btn.classList.add('cs-profile-tab--active');
            void renderSubContent();
        });
    }

    await renderSubContent();
}

async function _renderPromptInspector(ctx: ProfileCtx, el: HTMLElement) {
    const { agent, formData, plugin, agentManager } = ctx;
    if (!agent) {
        el.createEl('p', { text: t('profile.prompt.save_to_inspect'), cls: 'setting-item-description' });
        return;
    }

    const pkm = (plugin.env?.settings?.pkmAssistant || {}) as PkmPromptSettings;
    const globalDisabled = pkm.disabledPromptSections || [];
    const agentDisabled = (formData.prompt_overrides.disabledSections as string[] | undefined) || [];
    const mergedDisabled = [...new Set([...globalDisabled, ...agentDisabled])];

    _renderStartPromptBanner(ctx, el);

    const budgetEl = el.createDiv({ cls: 'cs-prompt-budget' });
    const totalTokensEl = budgetEl.createEl('strong', { text: '...' });
    const totalCountEl = budgetEl.createSpan({ text: '...', cls: 'setting-item-description' });
    const budgetBarEl = budgetEl.createDiv({ cls: 'cs-prompt-budget__bar' });

    const categories = {
        core:     { label: t('profile.prompt.core'),              dot: UiIcons.diamond?.(10) || '◆' },
        behavior: { label: t('profile.prompt.behavior'),          dot: UiIcons.compass?.(10) || '◈' },
        rules:    { label: t('profile.prompt.rules'),              dot: UiIcons.shield?.(10) || '◇' },
        context:  { label: t('profile.prompt.dynamic_context'), dot: UiIcons.layers?.(10) || '◎' },
    };

    let allSections: PromptSection[] = [];
    const catTokenEls = new Map<string, HTMLSpanElement>();

    const updateTokenDisplays = () => {
        let total = 0, enabledCount = 0;
        for (const s of allSections) {
            if (s.enabled) { total += s.tokens; enabledCount++; }
        }
        totalTokensEl.textContent = `${total.toLocaleString()} tok`;
        totalCountEl.textContent = t('profile.prompt.sections_count', { enabled: enabledCount, total: allSections.length });
        const pct = Math.min(100, (total / 8000) * 100);
        budgetBarEl.style.setProperty('--budget-pct', `${pct}%`);
        budgetBarEl.className = `cs-prompt-budget__bar${pct > 80 ? ' cs-prompt-budget__bar--warn' : ''}`;
        for (const [catKey, catTokEl] of catTokenEls) {
            const catTotal = allSections.filter(s => s.category === catKey && s.enabled)
                .reduce((sum, s) => sum + s.tokens, 0);
            catTokEl.textContent = `${catTotal.toLocaleString()} tok`;
        }
    };

    const bodyEl = el.createDiv();
    // Prompt czyta indeks TYPÓW + aktywny artefakt, niezależnie od inspektora.
    const extraContext = { disabledPromptSections: mergedDisabled };

    try {
        const data = await agentManager.getPromptInspectorDataForAgent(formData.name, extraContext);
        allSections = data.sections || [];

        if (!allSections.length) {
            bodyEl.createEl('p', { text: t('profile.prompt.no_sections'), cls: 'setting-item-description' });
            updateTokenDisplays();
            return;
        }

        for (const [catKey, catDef] of Object.entries(categories)) {
            const catSections = allSections.filter(s => s.category === catKey);
            if (!catSections.length) continue;

            const groupEl = bodyEl.createDiv({ cls: 'cs-prompt-category' });
            const catHeader = groupEl.createDiv({ cls: 'cs-prompt-category__header' });
            setSvgLabel(catHeader.createSpan(), catDef.dot, catDef.label);
            // Bez tekstu startowego - `updateTokenDisplays()` (linia niżej, ta sama tura wykonania,
            // przed jakimkolwiek repaintem) i tak zaraz wpisze `${n.toLocaleString()} tok` (ten sam
            // wzorzec co reszta pliku); placeholder "0 tok" nigdy nie był widoczny na ekranie.
            const catTokenEl = catHeader.createSpan({ cls: 'setting-item-description' });
            catTokenEls.set(catKey, catTokenEl);

            for (const section of catSections) {
                _renderInspectorRow(ctx, groupEl, section, updateTokenDisplays);
            }
        }

        updateTokenDisplays();
    } catch (e: unknown) {
        bodyEl.createEl('p', { text: t('profile.prompt.error', { error: (e as Error).message }), cls: 'setting-item-description' });
    }

    // Footer
    const footerEl = el.createDiv({ cls: 'cs-prompt-footer' });

    const previewBtn = footerEl.createEl('button', { cls: 'clickable-icon' });
    setSvg(previewBtn, UiIcons.eye(12));
    previewBtn.appendText(t('profile.prompt.preview_prompt'));
    previewBtn.addEventListener('click', () => {
        void (async () => {
            try {
                const data = await agentManager.getPromptInspectorDataForAgent(formData.name, extraContext);
                const fullText = (data.sections || []).filter((s) => s.enabled).map((s) => s.content).join('\n\n');
                new HiddenFileEditorModal(plugin.app as unknown as ConstructorParameters<typeof HiddenFileEditorModal>[0], '', `System Prompt — ${formData.name}`, fullText, { readOnly: true }).open();
            } catch (e: unknown) { new Notice(t('profile.prompt.error', { error: (e as Error).message })); }
        })();
    });

    const copyBtn = footerEl.createEl('button', { cls: 'clickable-icon' });
    setSvg(copyBtn, UiIcons.copy(12));
    copyBtn.appendText(t('profile.prompt.copy'));
    copyBtn.addEventListener('click', () => {
        void (async () => {
            try {
                const data = await agentManager.getPromptInspectorDataForAgent(formData.name, extraContext);
                const fullText = (data.sections || []).filter((s) => s.enabled).map((s) => s.content).join('\n\n');
                await navigator.clipboard.writeText(fullText);
                setSvg(copyBtn, UiIcons.check(12));
                copyBtn.appendText(t('profile.prompt.copied'));
                window.setTimeout(() => { setSvg(copyBtn, UiIcons.copy(12)); copyBtn.appendText(t('profile.prompt.copy')); }, 2000);
            } catch (e: unknown) { new Notice(t('profile.prompt.copy_error') + (e as Error).message); }
        })();
    });
}

/**
 * Baner „Generator promptu startowego" na górze Inspektora.
 *
 * Dlaczego TU, a nie w Personie: Inspektor to miejsce, gdzie user pierwszy raz widzi, z czego
 * składa się prompt - i od razu, że sekcja „KIM JESTEM" jest pusta. Generator wypełnia
 * `formData.personality` (bufor panelu), więc zmiana ląduje w YAML-u dopiero po „Zapisz profil".
 */
function _renderStartPromptBanner(ctx: ProfileCtx, el: HTMLElement) {
    const { formData, plugin, agent } = ctx;
    const card = el.createDiv({ cls: 'cs-prompt-override' });
    const header = card.createDiv({ cls: 'cs-prompt-override__header' });
    setSvg(header.createSpan(), UiIcons.zap(12));
    header.createSpan({ text: ` ${t('profile.start_prompt.title')}` });
    if (!String(formData.personality || '').trim()) {
        header.createSpan({ text: t('profile.start_prompt.badge_empty'), cls: 'cs-prompt-badge cs-prompt-badge--default' });
    }
    card.createEl('p', { text: t('profile.start_prompt.desc'), cls: 'setting-item-description' });

    const btn = card.createEl('button', { cls: 'clickable-icon cs-prompt-override__btn' });
    setSvg(btn, UiIcons.edit(11));
    btn.appendText(t('profile.start_prompt.open'));
    btn.addEventListener('click', () => {
        new StartPromptGeneratorModal(plugin.app as unknown as ConstructorParameters<typeof StartPromptGeneratorModal>[0], {
            agentName: agent?.name || formData.name || '',
            currentPersonality: formData.personality,
            onInsert: (text) => {
                formData.personality = text;
                new Notice(t('profile.start_prompt.inserted'));
                ctx.renderActiveTab();
            }
        }).open();
    });
}

function _renderInspectorRow(ctx: ProfileCtx, parentEl: HTMLElement, section: PromptSection, updateTokenDisplays: () => void) {
    const { formData, plugin } = ctx;
    const po = formData.prompt_overrides as PromptOverridesBag;
    const pkm = (plugin.env?.settings?.pkmAssistant || {}) as PkmPromptSettings;

    const rowEl = parentEl.createDiv({ cls: `cs-prompt-row${section.enabled ? '' : ' cs-prompt-row--disabled'}` });

    const cb = rowEl.createEl('input', { type: 'checkbox' });
    cb.checked = section.enabled;
    cb.disabled = section.required;
    if (section.required) cb.title = t('profile.prompt.required_section');

    const isExpanded = ctx.promptExpandedSet.has(section.key);
    const arrow = rowEl.createSpan({ text: isExpanded ? '▾' : '▸', cls: 'cs-prompt-row__arrow' });
    const labelEl = rowEl.createSpan({ text: section.label, cls: 'cs-prompt-row__label' });

    if (section.editable && po[section.key]) {
        rowEl.createSpan({ text: 'AGENT', cls: 'cs-prompt-badge cs-prompt-badge--agent' });
    } else if (section.editable && (pkm.promptDefaults || {})[section.key]) {
        rowEl.createSpan({ text: 'GLOBAL', cls: 'cs-prompt-badge cs-prompt-badge--global' });
    }

    const tokEl = rowEl.createSpan({
        text: section.enabled ? `${section.tokens.toLocaleString()} tok` : '—',
        cls: 'cs-prompt-row__tokens'
    });

    const expandEl = parentEl.createDiv({ cls: 'cs-prompt-expand' });
    expandEl.classList.toggle('cs-collapsed', !isExpanded);

    cb.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!po.disabledSections) po.disabledSections = [];
        if (section.enabled) {
            if (!po.disabledSections.includes(section.key)) po.disabledSections.push(section.key);
            section.enabled = false;
            rowEl.classList.add('cs-prompt-row--disabled');
            tokEl.textContent = '—';
        } else {
            po.disabledSections = po.disabledSections.filter((k: string) => k !== section.key);
            section.enabled = true;
            rowEl.classList.remove('cs-prompt-row--disabled');
            tokEl.textContent = `${section.tokens.toLocaleString()} tok`;
        }
        updateTokenDisplays();
    });

    const toggleExpand = () => {
        if (expandEl.classList.contains('cs-collapsed')) {
            ctx.promptExpandedSet.add(section.key);
            expandEl.classList.remove('cs-collapsed');
            arrow.textContent = '▾';
            if (!expandEl.dataset.rendered) {
                const pre = expandEl.createEl('pre', { cls: 'cs-prompt-preview' });
                pre.textContent = section.content || t('profile.prompt.no_content');
                if (section.editable) {
                    const hint = expandEl.createEl('p', { text: t('profile.prompt.edit_in_editor'), cls: 'cs-prompt-expand__hint' });
                    hint.addEventListener('click', () => {
                        ctx.activePromptSubTab = 'editor';
                        ctx.renderActiveTab();
                    });
                }
                expandEl.dataset.rendered = 'true';
            }
        } else {
            ctx.promptExpandedSet.delete(section.key);
            expandEl.classList.add('cs-collapsed');
            arrow.textContent = '▸';
        }
    };
    arrow.addEventListener('click', toggleExpand);
    labelEl.addEventListener('click', toggleExpand);
}

function _renderPromptEditor(ctx: ProfileCtx, el: HTMLElement) {
    const { formData, plugin } = ctx;
    const po = formData.prompt_overrides as PromptOverridesBag;
    const pkm = (plugin.env?.settings?.pkmAssistant || {}) as PkmPromptSettings;
    const globalDefaults = pkm.promptDefaults || {};

    // Agent Rules
    const rulesHead = el.createDiv({ cls: 'cs-section-head' });
    setSvg(rulesHead, UiIcons.shield(14));
    rulesHead.createSpan({ text: t('profile.prompt.agent_special_rules') });
    el.createEl('p', { text: t('profile.prompt.rules_desc'), cls: 'setting-item-description' });

    const rulesTextarea = el.createEl('textarea', {
        placeholder: t('profile.prompt.rules_placeholder'),
        cls: 'cs-prompt-textarea'
    });
    rulesTextarea.value = formData.agent_rules;
    rulesTextarea.addEventListener('change', () => { formData.agent_rules = rulesTextarea.value.trim(); });

    // Section Overrides
    const overHead = el.createDiv({ cls: 'cs-section-head' });
    setSvg(overHead, UiIcons.edit(14));
    overHead.createSpan({ text: t('profile.prompt.section_overrides') });
    el.createEl('p', { text: t('profile.prompt.section_overrides_desc'), cls: 'setting-item-description' });

    // `minion_guide` + `master_guide` WYCIĘTE. Były martwymi slotami - od unifikacji trybów
    // PromptBuilder renderuje wyłącznie `delegate_guide` (komentarze `PromptBuilder.js:176,577`),
    // więc cokolwiek user wpisał w te dwa okienka, NIE trafiało do promptu. Okienko obiecujące
    // wpływ, którego nie ma, jest gorsze od jego braku. Stare wartości zostają nieszkodliwie
    // w YAML-ach userów (bez migratora - nikt ich nie czyta).
    const overrideDefs = [
        { key: 'environment', label: t('profile.prompt.environment'), icon: UiIcons.globe(12) },
        { key: 'rules', label: t('profile.prompt.rules_section'), icon: UiIcons.clipboard(12) },
    ];

    for (const def of overrideDefs) {
        const isAvailable = !(def as { condition?: () => boolean }).condition
            || (def as { condition?: () => boolean }).condition!();
        const sectionEl = el.createDiv({ cls: `cs-prompt-override${isAvailable ? '' : ' cs-prompt-override--unavailable'}` });

        const header = sectionEl.createDiv({ cls: 'cs-prompt-override__header' });
        setSvg(header.createSpan(), def.icon);
        header.createSpan({ text: ` ${def.label}` });

        const hasAgentOverride = !!po[def.key];
        const hasGlobalOverride = !!globalDefaults[def.key];
        if (hasAgentOverride) {
            header.createSpan({ text: t('profile.prompt.overridden'), cls: 'cs-prompt-badge cs-prompt-badge--agent' });
        } else if (hasGlobalOverride) {
            header.createSpan({ text: t('profile.prompt.global_badge'), cls: 'cs-prompt-badge cs-prompt-badge--global' });
        } else {
            header.createSpan({ text: t('profile.prompt.default_badge'), cls: 'cs-prompt-badge cs-prompt-badge--default' });
        }

        if (!isAvailable) {
            header.createSpan({ text: t('profile.prompt.not_assigned'), cls: 'cs-prompt-override__unavail-note' });
            continue;
        }

        const body = sectionEl.createDiv({ cls: 'cs-prompt-override__body cs-collapsed' });
        header.addEventListener('click', () => { body.classList.toggle('cs-collapsed'); });

        const effectiveText = (globalDefaults[def.key] as string | undefined) || FACTORY_DEFAULTS[def.key as keyof typeof FACTORY_DEFAULTS] || '';
        if (effectiveText) {
            const refBlock = body.createDiv({ cls: 'cs-prompt-ref' });
            const refLabel = refBlock.createDiv({ cls: 'cs-prompt-ref__label' });
            setSvg(refLabel, UiIcons.eye(10));
            refLabel.createSpan({ text: globalDefaults[def.key] ? t('profile.prompt.current_global') : t('profile.prompt.factory_default') });
            refBlock.createEl('pre', { cls: 'cs-prompt-preview cs-prompt-preview--capped', text: effectiveText });
        }

        const textarea = body.createEl('textarea', { placeholder: t('profile.prompt.empty_uses_default'), cls: 'cs-prompt-textarea' });
        textarea.value = (po[def.key] as string | undefined) || '';

        const _updateBadge = () => {
            const badge = header.querySelector('.cs-prompt-badge');
            if (!badge) return;
            const val = textarea.value.trim();
            if (val) { badge.textContent = t('profile.prompt.overridden'); badge.className = 'cs-prompt-badge cs-prompt-badge--agent'; }
            else if (globalDefaults[def.key]) { badge.textContent = t('profile.prompt.global_badge'); badge.className = 'cs-prompt-badge cs-prompt-badge--global'; }
            else { badge.textContent = t('profile.prompt.default_badge'); badge.className = 'cs-prompt-badge cs-prompt-badge--default'; }
        };

        textarea.addEventListener('change', () => {
            const val = textarea.value.trim();
            if (val) { po[def.key] = val; } else { delete po[def.key]; }
            _updateBadge();
        });

        const actions = body.createDiv({ cls: 'cs-prompt-override__actions' });
        if (effectiveText) {
            const useBaseBtn = actions.createEl('button', { cls: 'clickable-icon cs-prompt-override__btn' });
            setSvg(useBaseBtn, UiIcons.edit(11));
            useBaseBtn.appendText(t('profile.prompt.use_as_base'));
            useBaseBtn.addEventListener('click', () => { textarea.value = effectiveText; po[def.key] = effectiveText; _updateBadge(); textarea.focus(); });
        }
        const clearBtn = actions.createEl('button', { cls: 'clickable-icon cs-prompt-override__btn' });
        setSvg(clearBtn, UiIcons.refresh(11));
        clearBtn.appendText(t('profile.prompt.clear'));
        clearBtn.addEventListener('click', () => { textarea.value = ''; delete po[def.key]; _updateBadge(); });
    }

    // Decision Tree
    const dtHead = el.createDiv({ cls: 'cs-section-head' });
    setSvg(dtHead, UiIcons.target(14));
    dtHead.createSpan({ text: t('profile.prompt.decision_tree') });
    el.createEl('p', { text: t('profile.prompt.decision_tree_desc'), cls: 'setting-item-description' });

    if (!po.decisionTreeInstructions) po.decisionTreeInstructions = {};
    const agentDT = po.decisionTreeInstructions as Record<string, DTInstrValue>;

    const sortedDTGroups = Object.entries(DECISION_TREE_GROUPS).sort(([, a], [, b]) => a.order - b.order);
    const globalDT = (globalDefaults.decisionTreeOverrides as Record<string, DTInstrValue> | undefined) || {};

    for (const [groupId, groupDef] of sortedDTGroups) {
        const groupInstructions = DECISION_TREE_DEFAULTS.filter(d => d.group === groupId);
        const customKeys = Object.keys(agentDT).filter(k =>
            k.startsWith('custom_') && typeof agentDT[k] === 'object' && (agentDT[k] as DTCustomEntry | undefined)?.group === groupId
        );
        const totalCount = groupInstructions.length + customKeys.length;
        const disabledCount = groupInstructions.filter(i => agentDT[i.id] === false).length;
        const overriddenCount = groupInstructions.filter(i => typeof agentDT[i.id] === 'string').length;

        const groupEl = el.createDiv({ cls: 'cs-dt-group' });
        const groupHeader = groupEl.createDiv({ cls: 'cs-dt-group__header' });

        const isExpanded = ctx.dtExpandedGroups.has(groupId);
        const arrow = groupHeader.createSpan({ text: isExpanded ? '▾' : '▸', cls: 'cs-prompt-row__arrow' });
        groupHeader.createEl('strong', { text: groupDef.label });
        if (overriddenCount > 0) {
            groupHeader.createSpan({ text: t('profile.prompt.overridden_count', { count: overriddenCount }), cls: 'cs-prompt-badge cs-prompt-badge--agent' });
        }
        groupHeader.createSpan({ text: `${totalCount - disabledCount}/${totalCount}`, cls: 'cs-dt-group__count' });

        const groupBody = groupEl.createDiv({ cls: 'cs-dt-group__body' });
        groupBody.classList.toggle('cs-collapsed', !isExpanded);

        groupHeader.addEventListener('click', () => {
            if (groupBody.classList.contains('cs-collapsed')) {
                ctx.dtExpandedGroups.add(groupId);
                groupBody.classList.remove('cs-collapsed');
                arrow.textContent = '▾';
            } else {
                ctx.dtExpandedGroups.delete(groupId);
                groupBody.classList.add('cs-collapsed');
                arrow.textContent = '▸';
            }
        });

        for (const instr of groupInstructions) {
            const agentVal = agentDT[instr.id];
            const globalVal = globalDT[instr.id];
            const isDisabled = agentVal === false || (agentVal === undefined && globalVal === false);
            const hasAgentOverride = typeof agentVal === 'string';
            const hasGlobalOverride = typeof globalVal === 'string';
            const effectiveText = hasAgentOverride ? agentVal : hasGlobalOverride ? globalVal : instr.text;
            const referenceText = hasGlobalOverride ? globalVal : instr.text;

            const instrEl = groupBody.createDiv({ cls: `cs-prompt-override${isDisabled ? ' cs-prompt-override--disabled-instr' : ''}` });
            const instrHeader = instrEl.createDiv({ cls: 'cs-prompt-override__header' });

            const instrCb = instrHeader.createEl('input', { type: 'checkbox' });
            instrCb.checked = !isDisabled;
            instrCb.addClass('cs-prompt-override__checkbox');
            instrCb.addEventListener('click', (e) => e.stopPropagation());

            const truncated = effectiveText.length > 70 ? effectiveText.slice(0, 67) + '...' : effectiveText;
            const instrLabel = instrHeader.createSpan({ text: truncated, cls: 'cs-prompt-override__instr-label' });
            if (isDisabled) instrLabel.addClass('is-dimmed');

            // Rozróżnij rdzeń (CORE_RULES, always-on) od reguł rozszerzonych (furtka).
            if (instr.tier === 'core') instrHeader.createSpan({ text: t('profile.prompt.core_rule'), cls: 'cs-dt-badge' });
            if (instr.tool) instrHeader.createSpan({ text: instr.tool, cls: 'cs-dt-badge' });
            if (hasAgentOverride) instrHeader.createSpan({ text: t('profile.prompt.overridden'), cls: 'cs-prompt-badge cs-prompt-badge--agent' });
            else if (hasGlobalOverride) instrHeader.createSpan({ text: t('profile.prompt.global_badge'), cls: 'cs-prompt-badge cs-prompt-badge--global' });

            const instrBody = instrEl.createDiv({ cls: 'cs-prompt-override__body cs-collapsed' });
            instrHeader.addEventListener('click', () => { instrBody.classList.toggle('cs-collapsed'); });

            const refBlock = instrBody.createDiv({ cls: 'cs-prompt-ref' });
            const refLabel = refBlock.createDiv({ cls: 'cs-prompt-ref__label' });
            setSvg(refLabel, UiIcons.eye(10));
            refLabel.createSpan({ text: hasGlobalOverride ? t('profile.prompt.current_global') : t('profile.prompt.factory_default') });
            refBlock.createEl('pre', { cls: 'cs-prompt-preview', text: referenceText });

            const textarea = instrBody.createEl('textarea', { placeholder: t('profile.prompt.empty_uses_default'), cls: 'cs-prompt-textarea cs-prompt-textarea--instr' });
            textarea.value = hasAgentOverride ? agentVal : '';

            const _updateInstrUI = () => {
                const val = textarea.value.trim();
                const badge = instrHeader.querySelector('.cs-prompt-badge');
                const newEffective = val || referenceText;
                const newTruncated = newEffective.length > 70 ? newEffective.slice(0, 67) + '...' : newEffective;
                instrLabel.textContent = newTruncated;
                instrLabel.classList.toggle('is-dimmed', !instrCb.checked);
                if (val) {
                    if (badge) { badge.textContent = t('profile.prompt.overridden'); badge.className = 'cs-prompt-badge cs-prompt-badge--agent'; }
                    else { instrHeader.createSpan({ text: t('profile.prompt.overridden'), cls: 'cs-prompt-badge cs-prompt-badge--agent' }); }
                } else if (hasGlobalOverride) {
                    if (badge) { badge.textContent = t('profile.prompt.global_badge'); badge.className = 'cs-prompt-badge cs-prompt-badge--global'; }
                    else { instrHeader.createSpan({ text: t('profile.prompt.global_badge'), cls: 'cs-prompt-badge cs-prompt-badge--global' }); }
                } else {
                    if (badge) badge.remove();
                }
            };

            textarea.addEventListener('change', () => {
                const val = textarea.value.trim();
                if (val) { agentDT[instr.id] = val; } else { delete agentDT[instr.id]; }
                _updateInstrUI();
            });

            const instrActions = instrBody.createDiv({ cls: 'cs-prompt-override__actions' });
            const useBaseBtn = instrActions.createEl('button', { cls: 'clickable-icon cs-prompt-override__btn' });
            setSvg(useBaseBtn, UiIcons.edit(11));
            useBaseBtn.appendText(t('profile.prompt.use_as_base'));
            useBaseBtn.addEventListener('click', () => { textarea.value = referenceText; agentDT[instr.id] = referenceText; _updateInstrUI(); textarea.focus(); });

            const instrClearBtn = instrActions.createEl('button', { cls: 'clickable-icon cs-prompt-override__btn' });
            setSvg(instrClearBtn, UiIcons.refresh(11));
            instrClearBtn.appendText(t('profile.prompt.clear'));
            instrClearBtn.addEventListener('click', () => {
                textarea.value = '';
                delete agentDT[instr.id];
                instrCb.checked = true;
                instrEl.classList.remove('cs-prompt-override--disabled-instr');
                _updateInstrUI();
            });

            instrCb.addEventListener('change', () => {
                if (instrCb.checked) {
                    if (agentDT[instr.id] === false) delete agentDT[instr.id];
                    instrEl.classList.remove('cs-prompt-override--disabled-instr');
                } else {
                    agentDT[instr.id] = false;
                    instrEl.classList.add('cs-prompt-override--disabled-instr');
                }
                _updateInstrUI();
            });
        }

        // Custom per-agent instructions
        for (const key of customKeys) {
            const custom = agentDT[key] as DTCustomEntry;
            const row = groupBody.createDiv({ cls: 'cs-dt-row' });
            const customCb = row.createEl('input', { type: 'checkbox' });
            customCb.checked = true;
            const input = row.createEl('input', { type: 'text', cls: 'cs-dt-input' });
            input.value = custom.text;
            const delBtn = row.createEl('button', { cls: 'clickable-icon cs-dt-clear cs-btn--danger' });
            setSvg(delBtn, SVG_X);
            delBtn.title = t('profile.prompt.delete');
            input.addEventListener('change', () => { custom.text = input.value.trim(); });
            delBtn.addEventListener('click', () => { delete agentDT[key]; row.remove(); });
        }

        const addBtn = groupBody.createEl('button', { cls: 'clickable-icon cs-dt-add' });
        setSvg(addBtn, UiIcons.plus(11));
        addBtn.appendText(t('profile.prompt.add'));
        addBtn.addEventListener('click', () => {
            const customId = `custom_${groupId}_${Date.now()}`;
            agentDT[customId] = { group: groupId, text: t('profile.prompt.new_instruction'), tool: null };
            ctx.renderActiveTab();
        });
    }

    // ── Prompty robocze per agent ──
    _renderWorkPrompts(ctx, el);
}

/**
 * Prompty robocze agenta: kompresja / zapis / dedup / streszczenia / rama suba.
 * Puste = resolver bierze global (Settings→Prompt) lub factory. Reset = wyczyść override.
 * Ostrzeżenie o kontrakcie przy compression/save/archive (parsery: MEMORY_CANDIDATES fence,
 * JSON new_notes, {{LEVEL}}). Sloty promptów artefaktów jeszcze nie budujemy.
 */
function _renderWorkPrompts(ctx: ProfileCtx, el: HTMLElement) {
    const { formData } = ctx;

    const head = el.createDiv({ cls: 'cs-section-head' });
    setSvg(head, UiIcons.edit(14));
    head.createSpan({ text: t('profile.prompt.work_prompts') });
    el.createEl('p', { text: t('profile.prompt.work_prompts_desc'), cls: 'setting-item-description' });

    const defs: Array<{ key: WorkPromptKey; label: string; contract: boolean }> = [
        { key: 'compression_prompt', label: `🗜️ ${t('profile.prompt.wp_compression')}`, contract: true },
        { key: 'save_session_prompt', label: `💾 ${t('profile.prompt.wp_save')}`, contract: true },
        { key: 'archive_prompt', label: `🔀 ${t('profile.prompt.wp_archive')}`, contract: true },
        { key: 'summary_prompt', label: `📚 ${t('profile.prompt.wp_summary')}`, contract: false },
        { key: 'subagent_frame_prompt', label: `🖼️ ${t('profile.prompt.wp_subframe')}`, contract: false },
    ];

    for (const def of defs) {
        const sectionEl = el.createDiv({ cls: 'cs-prompt-override' });
        const header = sectionEl.createDiv({ cls: 'cs-prompt-override__header' });
        header.createSpan({ text: def.label });
        const hasOverride = !!(formData[def.key] || '').trim();
        header.createSpan({
            text: hasOverride ? t('profile.prompt.overridden') : t('profile.prompt.default_badge'),
            cls: `cs-prompt-badge ${hasOverride ? 'cs-prompt-badge--agent' : 'cs-prompt-badge--default'}`
        });

        const body = sectionEl.createDiv({ cls: 'cs-prompt-override__body cs-collapsed' });
        header.addEventListener('click', () => { body.classList.toggle('cs-collapsed'); });

        if (def.contract) {
            const warn = body.createDiv({ cls: 'cs-warning-banner' });
            setSvg(warn, UiIcons.info(12));
            warn.createSpan({ text: ` ${t('profile.prompt.contract_warning')}` });
        }

        const textarea = body.createEl('textarea', { placeholder: t('profile.prompt.empty_uses_default'), cls: 'cs-prompt-textarea' });
        textarea.value = formData[def.key] || '';
        const badge = header.querySelector('.cs-prompt-badge');
        const refreshBadge = () => {
            const on = !!textarea.value.trim();
            badge!.textContent = on ? t('profile.prompt.overridden') : t('profile.prompt.default_badge');
            badge!.className = `cs-prompt-badge ${on ? 'cs-prompt-badge--agent' : 'cs-prompt-badge--default'}`;
        };
        textarea.addEventListener('change', () => { formData[def.key] = textarea.value.trim(); refreshBadge(); });

        const actions = body.createDiv({ cls: 'cs-prompt-override__actions' });
        const resetBtn = actions.createEl('button', { cls: 'clickable-icon cs-prompt-override__btn' });
        setSvg(resetBtn, UiIcons.refresh(11));
        resetBtn.appendText(t('profile.prompt.restore_default'));
        resetBtn.addEventListener('click', () => { textarea.value = ''; formData[def.key] = ''; refreshBadge(); });
    }
}
