/**
 * TriggersView.
 *
 * Sidebar tab "Triggery" - 3 sekcje (Skille / Sub-Agenty / MCP servery).
 * Klik na element wstawia chip-marker (`@@skill:foo`, `@sub-agent:foo`,
 * `@@tool:foo`) do textarea aktywnego czatu.
 *
 * Działa równolegle do slim baru (chat_ui.js) i popupu /@ -
 * zapewnia trzecią drogę odkrycia: stationary panel zamiast pop-up'a.
 */

import { Notice } from 'obsidian';
import { t } from '../../../core/i18n/index.js';
import { SkinManager, IconGenerator, UiIcons, hexToRgbTriplet, setSvg, setSvgLabel } from '../../../modules/crystal-soul/index.js';
import {
    collectSkillItems,
    collectSubAgentItems,
    collectMcpServerItems,
} from './triggers_collectors.js';
import type { TriggerItem as CollectorTriggerItem } from './triggers_collectors.js';
import { findActiveChatView } from './findActiveChatView.js';
import type { AgentManager } from '../../../modules/agents/index.js';
import type { ToolRegistry } from '../../../modules/tools/index.js';
import type { PluginApi } from '../../../core/index.js';

// Re-export for tests / outside callers that want pure logic.
export { collectSkillItems, collectSubAgentItems, collectMcpServerItems } from './triggers_collectors.js';

type TriggerItem = CollectorTriggerItem;
type TriggerSection = { sectionLabel: string; emptyText: string; items: TriggerItem[]; onSelect: (item: TriggerItem) => void };

/** Plugin widziany przez ten widok: managery agentów i narzędzi. */
interface TriggersViewPlugin extends PluginApi {
    agentManager?: AgentManager;
    toolRegistry?: ToolRegistry;
}

/** Karta czatu, jaką zwraca `findActiveChatView` - tylko pola, których ten widok dotyka. */
interface ChatViewLike {
    input_area?: HTMLTextAreaElement;
    handleInputResize?: () => void;
}

/**
 * Render the triggers view.
 * @param {HTMLElement} container
 * @param {Object} plugin
 * @param {import('./SidebarNav.js').SidebarNav} nav
 * @param {Object} _params
 */
export function renderTriggersView(container: HTMLElement, plugin: TriggersViewPlugin, _nav: unknown, _params: unknown): void {
    container.classList.add('cs-root');
    const agentManager = plugin?.agentManager;
    const activeAgent = agentManager?.getActiveAgent?.();

    if (activeAgent) {
        const rgb = hexToRgbTriplet(SkinManager.getAgentColor(activeAgent));
        container.style.setProperty('--cs-agent-color-rgb', rgb);
    }

    const header = container.createDiv({ cls: 'cs-section-title' });
    setSvgLabel(header, UiIcons.zap(12), t('sidebar.triggers'));

    const description = container.createDiv({ cls: 'cs-triggers-description' });
    description.textContent = t('sidebar.triggers_description');

    if (!agentManager || !activeAgent) {
        const empty = container.createDiv({ cls: 'cs-triggers-empty' });
        empty.textContent = t('sidebar.agent_manager_not_init');
        return;
    }

    // ── Section: Skills ──
    renderTriggerSection(container, {
        sectionLabel: t('triggers.section.skills'),
        emptyText: t('triggers.empty.skills'),
        items: collectSkillItems(agentManager),
    onSelect: (item: TriggerItem) => { void insertTriggerMarker(plugin, 'skill', item.name); },
    });

    // ── Section: Sub-agents ──
    renderTriggerSection(container, {
        sectionLabel: t('triggers.section.sub_agents'),
        emptyText: t('triggers.empty.sub_agents'),
        items: collectSubAgentItems(agentManager, activeAgent),
    onSelect: (item: TriggerItem) => { void insertTriggerMarker(plugin, 'sub-agent', item.name); },
    });

    // ── Section: MCP servers ──
    renderTriggerSection(container, {
        sectionLabel: t('triggers.section.mcp'),
        emptyText: t('triggers.empty.mcp'),
        items: collectMcpServerItems(plugin, activeAgent),
    onSelect: (item: TriggerItem) => { void insertTriggerMarker(plugin, 'tool', item.name); },
    });
}

// ── Internal helpers ─────────────────────────────────────────────────

function renderTriggerSection(container: HTMLElement, { sectionLabel, emptyText, items, onSelect }: TriggerSection): void {
    const section = container.createDiv({ cls: 'cs-home-section' });
    const titleEl = section.createDiv({ cls: 'cs-section-title cs-section-title--trigger' });
    titleEl.textContent = sectionLabel;

    if (!items.length) {
        const empty = section.createDiv({ cls: 'cs-trigger-section-empty' });
        empty.textContent = emptyText;
        return;
    }

    const list = section.createDiv({ cls: 'cs-trigger-list' });

    for (const item of items) {
        const row = list.createEl('button', { cls: 'cs-trigger-row' });
        row.type = 'button';

        const iconWrap = row.createSpan({ cls: 'cs-trigger-row__icon' });
        setSvg(iconWrap, renderIcon(item));

        const text = row.createDiv({ cls: 'cs-trigger-row__text' });

        const top = text.createDiv({ cls: 'cs-trigger-row__top' });
        top.createSpan({ text: item.label });
        if (item.kind === 'sub-agent') {
            const badge = top.createSpan({ text: '[CUSTOM]', cls: 'cs-trigger-row__badge' });
            // `activeAgent` is not in scope here (it lives in the caller), so this title
            // must stay a plain string - referencing it in a template would throw ReferenceError.
            badge.title = 'Custom sub-agent of the active agent';
        }

        if (item.description) {
            const desc = text.createDiv({ cls: 'cs-trigger-row__desc' });
            desc.textContent = item.description.length > 70 ? item.description.slice(0, 70) + '…' : item.description;
        }

        row.addEventListener('click', () => onSelect(item));
    }
}

function renderIcon(item: TriggerItem): string {
    if (item.kind === 'skill') {
        return IconGenerator.generate(item.label, item.icon || 'arcane', { size: 14, color: 'currentColor' });
    }
    if (item.kind === 'sub-agent') {
        return SkinManager.getCrystal(item.name, { size: 14, color: 'currentColor', glow: false });
    }
    return UiIcons.tool(14);
}

async function insertTriggerMarker(plugin: TriggersViewPlugin, type: string, name: string): Promise<void> {
    // TS-boundary: `AppLike.workspace` (core, node-safe) nie modeluje `getLeavesOfType`/
    // `activeLeaf` - findActiveChatView jest node-safe z tego samego powodu i trzyma własny,
    // luźniejszy kontrakt; shell już importuje obsidian wprost gdzie indziej.
    const chatView = findActiveChatView(plugin as unknown as Parameters<typeof findActiveChatView>[0]) as ChatViewLike | null;
    if (!chatView || !chatView.input_area) {
        new Notice(t('sidebar.no_chat_open'));
        return;
    }
    const { insertInlineTriggerMarker } = await import('../../../modules/chat/index.js');
    insertInlineTriggerMarker(chatView.input_area, type as Parameters<typeof insertInlineTriggerMarker>[1], name);
    chatView.handleInputResize?.();
}
