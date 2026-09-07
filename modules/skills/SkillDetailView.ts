/**
 * Skill detail view in the Backstage sidebar (Sprint 10 Z6: extracted from
 * modules/shell/sidebar/DetailViews.js so the rendering lives with its
 * owning module).
 */
import { MarkdownRenderer } from 'obsidian';
import { UiIcons, setSvgLabel } from '../crystal-soul/index.js';
import { SkillEditorModal } from './SkillEditorModal.js';
import { t } from '../../core/i18n/index.js';
// TS-any: Obsidian element extensions and plugin/SidebarNav contracts are dynamically supplied.
type UiBoundary = any;

/**
 * Render detailed view of a single skill.
 *
 * S27 Z2: ten sam widok obsługuje SZABLON (`params.template === true` → źródłem jest
 * `skillTemplateStore`) i żywy skill. Szablon nie ma sekcji „agenci" — nie jest używany,
 * jest kopiowany (D3); zamiast tego dostaje badge wersji.
 *
 * @param {HTMLElement} container
 * @param {Object} plugin
 * @param {import('../shell/sidebar/SidebarNav.js').SidebarNav} nav
 * @param {Object} params - { skillName: string, template?: boolean }
 */
export function renderSkillDetailView(container: UiBoundary, plugin: UiBoundary, nav: UiBoundary, params: { skillName: string; template?: boolean }) {
    const isTemplate = params.template === true;
    const skill = isTemplate
        ? plugin.agentManager?.skillTemplateStore?.get(params.skillName)
        : plugin.agentManager?.skillLoader?.getSkill(params.skillName);

    if (!skill) {
        const h3 = container.createEl('h3', { cls: 'sidebar-section-title' });
        setSvgLabel(h3, UiIcons.zap(16), t('detail.skill_not_found'));
        container.createEl('p', {
            text: t('detail.skill_not_found_desc', { name: params.skillName }),
            cls: 'sidebar-empty-text'
        });
        return;
    }

    const headerRow = container.createDiv({ cls: 'sidebar-detail-header-row' });
    const skillHeader = headerRow.createEl('h3', { cls: 'sidebar-section-title' });
    setSvgLabel(skillHeader, skill.icon || UiIcons.zap(16), skill.name);
    const editBtn = headerRow.createEl('button', { cls: 'cs-detail-edit-btn' });
    setSvgLabel(editBtn, UiIcons.edit(14), t('generic.edit'));
    editBtn.addEventListener('click', () => {
        new SkillEditorModal(plugin.app, plugin, skill, () => nav.refresh(), { template: isTemplate }).open();
    });

    const meta = container.createDiv({ cls: 'sidebar-detail-meta' });

    if (isTemplate) {
        const kindRow = meta.createDiv({ cls: 'sidebar-detail-row' });
        kindRow.createSpan({ cls: 'sidebar-detail-label', text: t('detail.kind') });
        kindRow.createSpan({ cls: 'sidebar-category-badge', text: t('detail.kind_template') });
    } else if (skill.fromTemplate) {
        // S27 Z6: ślad pochodzenia kopii — user widzi z której formy odlewniczej to wyszło.
        const originRow = meta.createDiv({ cls: 'sidebar-detail-row' });
        originRow.createSpan({ cls: 'sidebar-detail-label', text: t('detail.from_template') });
        originRow.createSpan({ cls: 'sidebar-detail-value', text: skill.fromTemplate });
    }

    if (skill.description) {
        const descRow = meta.createDiv({ cls: 'sidebar-detail-row' });
        descRow.createSpan({ cls: 'sidebar-detail-label', text: t('detail.description') });
        descRow.createSpan({ cls: 'sidebar-detail-value', text: skill.description });
    }

    if (skill.category) {
        const catRow = meta.createDiv({ cls: 'sidebar-detail-row' });
        catRow.createSpan({ cls: 'sidebar-detail-label', text: t('detail.category') });
        catRow.createSpan({ cls: 'sidebar-category-badge', text: skill.category });
    }

    if (skill.tags?.length > 0) {
        const tagsRow = meta.createDiv({ cls: 'sidebar-detail-row' });
        tagsRow.createSpan({ cls: 'sidebar-detail-label', text: t('detail.tags') });
        const tagsVal = tagsRow.createSpan({ cls: 'sidebar-detail-value' });
        for (const tag of skill.tags) {
            tagsVal.createSpan({ cls: 'sidebar-category-badge', text: tag });
        }
    }

    const versionRow = meta.createDiv({ cls: 'sidebar-detail-row' });
    versionRow.createSpan({ cls: 'sidebar-detail-label', text: t('detail.version') });
    versionRow.createSpan({ cls: 'sidebar-detail-value', text: String(skill.version || 1) });

    const statusRow = meta.createDiv({ cls: 'sidebar-detail-row' });
    statusRow.createSpan({ cls: 'sidebar-detail-label', text: t('detail.status') });
    const statusVal = statusRow.createSpan({
        cls: `sidebar-detail-value ${skill.enabled ? 'status-active' : 'status-inactive'}`
    });
    setSvgLabel(statusVal,
        skill.enabled ? UiIcons.check(12) : UiIcons.cross(12),
        skill.enabled ? t('detail.active') : t('detail.disabled'));

    if (skill.model) {
        const modelRow = meta.createDiv({ cls: 'sidebar-detail-row' });
        modelRow.createSpan({ cls: 'sidebar-detail-label', text: t('detail.model') });
        modelRow.createSpan({ cls: 'sidebar-detail-value', text: skill.model });
    }

    const flagsRow = meta.createDiv({ cls: 'sidebar-detail-row' });
    flagsRow.createSpan({ cls: 'sidebar-detail-label', text: t('detail.flags') });
    const flagsVal = flagsRow.createSpan({ cls: 'sidebar-detail-value' });
    const autoFlag = flagsVal.createSpan({ cls: 'sidebar-category-badge' });
    setSvgLabel(autoFlag,
        skill.disableModelInvocation ? UiIcons.noEntry(12) : UiIcons.check(12),
        skill.disableModelInvocation ? t('detail.auto_invoke_off') : t('detail.auto_invoke'));
    const visFlag = flagsVal.createSpan({ cls: 'sidebar-category-badge' });
    setSvgLabel(visFlag,
        skill.userInvocable !== false ? UiIcons.eye(12) : UiIcons.lock(12),
        skill.userInvocable !== false ? t('detail.visible_in_ui') : t('detail.hidden'));

    // S27 D3: szablon nie jest „używany" przez agentów — jest kopiowany. Sekcja tylko dla żywych.
    const agents = isTemplate ? [] : (plugin.agentManager?.getAllAgents() || []);
    const usedBy = agents.filter((a: UiBoundary) => a.skills?.includes(skill.slug) || a.skills?.includes(skill.name));

    if (isTemplate) {
        // nic — karta w Zapleczu ma akcję „Użyj u agenta…", detal jest podglądem formy
    } else if (usedBy.length > 0) {
        const agentsSection = container.createDiv({ cls: 'sidebar-detail-section' });
        const agentsH4 = agentsSection.createEl('h4', { cls: 'sidebar-detail-subtitle' });
        setSvgLabel(agentsH4, UiIcons.users(14), `${t('detail.agents')} (${usedBy.length})`);

        const agentsList = agentsSection.createDiv({ cls: 'sidebar-detail-agents' });
        for (const agent of usedBy) {
            const link = agentsList.createSpan({
                cls: 'sidebar-agent-link',
                text: agent.name
            });
            link.addEventListener('click', (e: Event) => {
                e.stopPropagation();
                nav.push('agent-profile', { agentName: agent.name }, skill.name);
            });
        }
    } else {
        const noAgents = container.createDiv({ cls: 'sidebar-detail-section' });
        noAgents.createEl('p', {
            text: t('detail.no_agents_use_skill'),
            cls: 'sidebar-empty-text'
        });
    }

    // S27 D6: sekcja „Dozwolone narzędzia" (chipy z pola-fasady `allowed-tools`) WYCIĘTA.

    if (skill.preQuestions?.length > 0) {
        const pqSection = container.createDiv({ cls: 'sidebar-detail-section' });
        const pqH4 = pqSection.createEl('h4', { cls: 'sidebar-detail-subtitle' });
        setSvgLabel(pqH4, UiIcons.question(14), `${t('detail.questions')} (${skill.preQuestions.length})`);

        for (const pq of skill.preQuestions) {
            const pqRow = pqSection.createDiv({ cls: 'sidebar-detail-row' });
            pqRow.createSpan({ cls: 'sidebar-detail-label', text: `{{${pq.key}}}` });
            pqRow.createSpan({ cls: 'sidebar-detail-value', text: pq.question + (pq.default ? ` (${t('detail.default')}: ${pq.default})` : '') });
        }
    }

    if (skill.prompt) {
        const promptSection = container.createDiv({ cls: 'sidebar-detail-section' });
        const promptH4 = promptSection.createEl('h4', { cls: 'sidebar-detail-subtitle' });
        setSvgLabel(promptH4, UiIcons.edit(14), t('detail.prompt'));

        const promptContent = promptSection.createDiv({ cls: 'sidebar-detail-prompt' });

        try {
            void MarkdownRenderer.render(
                plugin.app,
                skill.prompt,
                promptContent,
                skill.path || '',
                plugin
            );
        } catch {
            promptContent.createEl('pre', { text: skill.prompt, cls: 'sidebar-detail-pre' });
        }
    }
}
