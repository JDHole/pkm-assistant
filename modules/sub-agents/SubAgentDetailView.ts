/**
 * Sub-Agent detail view in the Backstage sidebar (extracted
 * from modules/shell/sidebar/DetailViews.js).
 */
import { MarkdownRenderer } from 'obsidian';
import { TOOL_INFO, getToolIcon } from '../ui-components/index.js';
import { UiIcons, setSvgLabel, setSvg } from '../crystal-soul/index.js';
import { SubAgentEditorModal } from './SubAgentEditorModal.js';
import { t } from '../../core/i18n/index.js';
import { DEFAULT_LIMITS } from '../../config/limits.js';
import type { SidebarNav } from '../shell/index.js';
import type { SubAgentsPlugin } from './types.js';

/**
 * Render detailed view of a single sub-agent.
 *
 * Ten sam widok obsługuje SZABLON (`params.template === true` → źródłem jest
 * `subAgentTemplateStore`) i żywego suba. Szablon nie ma sekcji „agenci" — nie jest
 * używany, jest kopiowany.
 *
 * @param {HTMLElement} container
 * @param {Object} plugin
 * @param {import('../shell/sidebar/SidebarNav.js').SidebarNav} nav
 * @param {Object} params - { subAgentName | minionName | masterName: string, template?: boolean }
 */
export function renderSubAgentDetailView(container: HTMLElement, plugin: SubAgentsPlugin, nav: SidebarNav, params: { subAgentName?: string; minionName?: string; masterName?: string; template?: boolean }): void {
    // `!`: kontrakt wołacza (JSDoc @param wyżej) gwarantuje dokładnie jedno z trzech pól.
    const name = (params.subAgentName || params.minionName || params.masterName)!;
    const isTemplate = params.template === true;
    const subAgent = isTemplate
        ? plugin.agentManager?.subAgentTemplateStore?.get(name)
        : plugin.agentManager?.subAgentLoader?.getSubAgent(name);

    if (!subAgent) {
        const notFoundH3 = container.createEl('h3', { cls: 'sidebar-section-title' });
        setSvgLabel(notFoundH3, UiIcons.robot(16), t('detail.sub_agent_not_found'));
        container.createEl('p', {
            text: t('detail.sub_agent_not_found_desc', { name }),
            cls: 'sidebar-empty-text'
        });
        return;
    }

    const icon = UiIcons.robot(16);
    const roleLabel = t('backstage.role_sub_agent');

    const headerRow = container.createDiv({ cls: 'sidebar-detail-header-row' });
    const h3 = headerRow.createEl('h3', { cls: 'sidebar-section-title' });
    setSvgLabel(h3, icon, subAgent.name);
    const editBtn = headerRow.createEl('button', { cls: 'cs-detail-edit-btn' });
    setSvgLabel(editBtn, UiIcons.edit(14), t('generic.edit'));
    editBtn.addEventListener('click', () => {
        // `plugin.app as never`: `PluginApi.app` to strukturalny `AppLike` (core/ nie importuje
        // 'obsidian'); most do prawdziwego `App` — ten sam idiom co `core/PluginBase.ts` i
        // `modules/shell/PluginSettingsTab.ts` (`plugin as never` do bazowego `Plugin`).
        new SubAgentEditorModal(plugin.app as never, plugin, subAgent, () => nav.refresh(), { template: isTemplate }).open();
    });

    const meta = container.createDiv({ cls: 'sidebar-detail-meta' });

    if (isTemplate) {
        const kindRow = meta.createDiv({ cls: 'sidebar-detail-row' });
        kindRow.createSpan({ cls: 'sidebar-detail-label', text: t('detail.kind') });
        kindRow.createSpan({ cls: 'sidebar-category-badge', text: `${t('detail.kind_template')} · v${subAgent.version || 1}` });
    } else if (subAgent.from_template) {
        // Ślad pochodzenia kopii („z szablonu: X vN").
        const originRow = meta.createDiv({ cls: 'sidebar-detail-row' });
        originRow.createSpan({ cls: 'sidebar-detail-label', text: t('detail.from_template') });
        originRow.createSpan({ cls: 'sidebar-detail-value', text: subAgent.from_template });
    }

    const roleRow = meta.createDiv({ cls: 'sidebar-detail-row' });
    roleRow.createSpan({ cls: 'sidebar-detail-label', text: t('detail.role') });
    roleRow.createSpan({ cls: 'sidebar-detail-value', text: roleLabel });

    if (subAgent.description) {
        const descRow = meta.createDiv({ cls: 'sidebar-detail-row' });
        descRow.createSpan({ cls: 'sidebar-detail-label', text: t('detail.description') });
        descRow.createSpan({ cls: 'sidebar-detail-value', text: subAgent.description });
    }

    const iterRow = meta.createDiv({ cls: 'sidebar-detail-row' });
    iterRow.createSpan({ cls: 'sidebar-detail-label', text: t('detail.max_iterations') });
    // Fallback = kanoniczny default z config/limits.ts, nie zwietrzały hardcoded literał —
    // szablon bez jawnego max_iterations dostaje realnie 25, nie 8.
    iterRow.createSpan({ cls: 'sidebar-detail-value', text: String(subAgent.max_iterations || DEFAULT_LIMITS.subagent_max_iterations_worker) });

    if (subAgent.model) {
        const modelRow = meta.createDiv({ cls: 'sidebar-detail-row' });
        modelRow.createSpan({ cls: 'sidebar-detail-label', text: t('detail.model') });
        modelRow.createSpan({ cls: 'sidebar-detail-value', text: subAgent.model });
    }

    const statusRow = meta.createDiv({ cls: 'sidebar-detail-row' });
    statusRow.createSpan({ cls: 'sidebar-detail-label', text: t('detail.status') });
    const statusVal = statusRow.createSpan({
        cls: `sidebar-detail-value ${subAgent.enabled !== false ? 'status-active' : 'status-inactive'}`
    });
    setSvgLabel(statusVal,
        subAgent.enabled !== false ? UiIcons.check(12) : UiIcons.cross(12),
        subAgent.enabled !== false ? t('detail.active') : t('detail.disabled'));

    if (subAgent.tools?.length > 0) {
        const toolsSection = container.createDiv({ cls: 'sidebar-detail-section' });
        const toolsH4 = toolsSection.createEl('h4', { cls: 'sidebar-detail-subtitle' });
        setSvgLabel(toolsH4, UiIcons.wrench(14), `${t('detail.tools')} (${subAgent.tools.length})`);

        const toolsList = toolsSection.createDiv({ cls: 'sidebar-detail-tools' });
        for (const toolName of subAgent.tools) {
            const info = (TOOL_INFO as Record<string, { label: string }>)[toolName] || { category: 'mixed', label: toolName };
            const toolCard = toolsList.createDiv({ cls: 'sidebar-tool-mini-card' });
            const toolIconSpan = toolCard.createSpan({ cls: 'sidebar-tool-icon' });
            // TS-boundary: `getToolIcon` (modules/ui-components, poza zakresem tej fali) nadal
            // rozwiązuje się do `any` u siebie — realnie zawsze zwraca SVG string
            // (`IconGenerator.generate(...): string`).
            setSvg(toolIconSpan, getToolIcon(toolName, 'currentColor', 14) as string);
            toolCard.createSpan({ cls: 'sidebar-tool-label', text: info.label });
            toolCard.createSpan({ cls: 'sidebar-tool-name', text: toolName });
        }
    }

    // Szablon nie jest „używany" — jest kopiowany. Sekcja tylko dla żywych subów.
    const agents = isTemplate ? [] : (plugin.agentManager?.getAllAgents() || []);
    const usedBy = agents.filter((a) =>
        a.getAllSubAgentNames?.().includes(subAgent.name)
    );

    if (isTemplate) {
        // brak sekcji „agenci" — akcja „Użyj u agenta…" żyje na karcie w Zapleczu
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
                nav.push('agent-profile', { agentName: agent.name }, subAgent.name);
            });
        }
    } else {
        const noAgents = container.createDiv({ cls: 'sidebar-detail-section' });
        noAgents.createEl('p', {
            text: t('detail.no_agents_use_sub_agent'),
            cls: 'sidebar-empty-text'
        });
    }

    if (subAgent.prompt) {
        const promptSection = container.createDiv({ cls: 'sidebar-detail-section' });
        const promptH4 = promptSection.createEl('h4', { cls: 'sidebar-detail-subtitle' });
        setSvgLabel(promptH4, UiIcons.edit(14), t('detail.prompt'));

        const promptContent = promptSection.createDiv({ cls: 'sidebar-detail-prompt' });

        try {
            // `plugin.app`/`plugin` as `never`: `PluginApi.app` jest strukturalnym `AppLike`
            // (core/ nie importuje 'obsidian'), a `MarkdownRenderer.render` chce prawdziwych
            // `App`/`Component` z pakietu obsidian — ten sam most co gdzie indziej w repo
            // (np. `core/PluginBase.ts`, `modules/shell/PluginSettingsTab.ts`). Runtime bez zmian:
            // to zawsze te same, prawdziwe obiekty Obsidiana, tylko inaczej opisane po stronie TS.
            void MarkdownRenderer.render(
                plugin.app as never,
                subAgent.prompt,
                promptContent,
                subAgent.path || '',
                plugin as never
            );
        } catch {
            promptContent.createEl('pre', { text: subAgent.prompt, cls: 'sidebar-detail-pre' });
        }
    }
}
