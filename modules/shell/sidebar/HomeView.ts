/**
 * HomeView - Main sidebar view showing agents, communicator and backstage.
 * Crystal Soul design system — Faza 6.
 */
import { Notice } from 'obsidian';
import { openAgentDeleteModal } from '../AgentDeleteModal.js';
import { openAgentPresentationModal } from '../AgentPresentationModal.js';
import { Agent } from '../../../modules/agents/index.js';
import { SkinManager, UiIcons, hexToRgbTriplet, setSvg, setSvgLabel } from '../../../modules/crystal-soul/index.js';
import { isKomunikatorEnabled } from '../../../modules/komunikator/index.js';
import { buildZapleczeRows, readZapleczeCounts } from './backstage_rows.js';
import { t } from '../../../core/i18n/index.js';
import { log } from '../../../core/utils/Logger.js';
import { CHAT_VIEW_TYPE } from '../../../core/index.js';

// Zachowuje historyczny value-import i jego inicjalizację modułu; sam wynik pozostaje nieużywany.
void Agent;

// TS-any: these values cross dynamic Obsidian/plugin APIs not yet modelled by the migration.
type Runtime = any;

/**
 * E2.8 C2: pierwsza wolna nazwa domyślnego agenta (Agent1, Agent2, …).
 * @param {Object} agentManager
 * @returns {string}
 */
function firstFreeAgentName(agentManager: Runtime): string {
    for (let i = 1; i <= 999; i++) {
        const name = `Agent${i}`;
        if (!agentManager?.getAgent?.(name)) return name;
    }
    return `Agent${Date.now()}`;
}

/**
 * Role display text mapping (resolved at render time via t()).
 */
function getRoleLabel(role: string): string {
    const labels: Record<string, string> = {
        'orchestrator': 'Orchestrator',
        'specialist': t('sidebar.specialist'),
        'meta_agent': t('sidebar.meta_agent')
    };
    return labels[role] || role || '';
}

/**
 * Render the home view (agent grid + communicator + zaplecze).
 * @param {HTMLElement} container
 * @param {Object} plugin
 * @param {import('./SidebarNav.js').SidebarNav} nav
 * @param {Object} params
 */
export function renderHomeView(container: Runtime, plugin: Runtime, nav: Runtime, _params: Runtime): void {
    container.classList.add('cs-root');
    const agentManager = plugin.agentManager;
    if (!agentManager) {
        container.createEl('p', {
            text: t('sidebar.agent_manager_not_init'),
            cls: 'agent-error'
        });
        return;
    }

    const agents = agentManager.getAgentListForUI();

    // ── Section: Agenci ──
    const agentTitle = container.createDiv({ cls: 'cs-section-title' });
    setSvgLabel(agentTitle, UiIcons.users(12), t('sidebar.agents'));
    agentTitle.createSpan({ cls: 'cs-section-title__count', text: `(${agents.length})` });

    // Agent cards grid
    const colCount = agents.length <= 4 ? 2 : 3;
    const grid = container.createDiv({ cls: `cs-agent-grid cs-agent-grid--${colCount}col` });

    for (const agentInfo of agents) {
        renderAgentCard(grid, agentInfo, plugin, nav);
    }

    // Add agent card (dashed)
    // E2.8 C2: „czysta kartka" — od razu twórz agenta z pierwszą wolną nazwą (Agent1/Agent2…)
    // i otwórz jego profil w NORMALNYM trybie edycji (bez osobnego create-mode).
    const addCard = grid.createDiv({ cls: 'cs-agent-card cs-agent-card--add' });
    setSvg(addCard, UiIcons.plus(16));
    addCard.addEventListener('click', async () => {
        try {
            const name = firstFreeAgentName(plugin.agentManager);
            await plugin.agentManager.createAgent({ name });
            nav.push('agent-profile', { agentName: name }, t('sidebar.agents'));
        } catch (e: Runtime) {
            new Notice(t('profile.advanced.create_error') + (e?.message || e));
        }
    });

    // ── Section: Komunikator ── (E1.2 kill-switch: hidden unless enabled, default off)
    if (isKomunikatorEnabled(plugin.settings)) {
        renderCommunicatorSection(container, agents, plugin, nav);
    }

    // ── Section: Agora ──

    // ── Section: Zaplecze ──
    renderZapleczeSection(container, plugin, nav);
}

/**
 * Render a single agent card — Crystal Soul style.
 */
function renderAgentCard(container: Runtime, agentInfo: Runtime, plugin: Runtime, nav: Runtime): void {
    const agent = plugin.agentManager.getAgent(agentInfo.name);
    if (!agent) return;

    const agentColor = SkinManager.getAgentColor(agent || agentInfo.name);
    const rgb = hexToRgbTriplet(agentColor);

    const card = container.createDiv({ cls: 'cs-agent-card' });
    card.style.setProperty('--cs-agent-color-rgb', rgb);

    // Crystal avatar
    const crystalEl = card.createDiv({ cls: 'cs-agent-card__crystal' });
    const crystalSeed = agent?.effectiveCrystalSeed || agentInfo.name;
    setSvg(crystalEl, SkinManager.getCrystal(agent || crystalSeed, { size: 32, color: agentColor, glow: false }));

    // Name
    card.createDiv({ cls: 'cs-agent-card__name', text: agentInfo.name });

    // Role
    const roleText = getRoleLabel(agentInfo.role);
    if (roleText) {
        card.createDiv({ cls: 'cs-agent-card__role', text: roleText });
    }

    // Hover action buttons
    const actions = card.createDiv({ cls: 'cs-agent-card__actions' });

    const profileBtn = actions.createEl('button', {
        cls: 'cs-agent-card__action',
        attr: { 'aria-label': t('sidebar.profile') }
    });
    setSvg(profileBtn, UiIcons.settings(10));
    profileBtn.addEventListener('click', (e: Runtime) => {
        e.stopPropagation();
        nav.push('agent-profile', { agentName: agent.name }, t('sidebar.agents'));
    });

    // E2.8 A6 (S25): kosz ukryty dla agenta wbudowanego (Jaskier) — nieusuwalny (defense in depth).
    if (!agent.isBuiltIn) {
        const deleteBtn = actions.createEl('button', {
            cls: 'cs-agent-card__action cs-agent-card__action--danger',
            attr: { 'aria-label': t('generic.delete') }
        });
        setSvg(deleteBtn, UiIcons.trash(10));
        deleteBtn.addEventListener('click', (e: Runtime) => {
            e.stopPropagation();
            openAgentDeleteModal(plugin, agent, () => {
                nav.refresh();
            });
        });
    }

    // Click card to open presentation modal
    card.addEventListener('click', () => {
        openAgentPresentationModal(plugin, agentInfo.name, {
            onEditNavigate: () => {
                nav.push('agent-profile', { agentName: agentInfo.name }, t('sidebar.agents'));
            },
            onChatNavigate: () => {
                // Switch to or create a tab for this agent in the chat view
                const chatView = plugin.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)?.[0]?.view;
                if (chatView?.handleAgentChange) {
                    chatView.handleAgentChange(agentInfo.name);
                }
            },
        });
    });
}

/**
 * Render the communicator section — Crystal Soul style.
 */
function renderCommunicatorSection(container: Runtime, agents: Runtime[], plugin: Runtime, nav: Runtime): void {
    const section = container.createDiv({ cls: 'cs-home-section' });

    // Header (clickable — opens communicator)
    const header = section.createDiv({ cls: 'cs-home-section__header cs-home-section__header--clickable' });
    const title = header.createDiv({ cls: 'cs-section-title cs-section-title--flush' });
    setSvgLabel(title, UiIcons.chat(12), t('sidebar.communicator'));

    const openBtn = header.createEl('button', {
        cls: 'cs-home-section__open',
        attr: { 'aria-label': t('sidebar.open_communicator') }
    });
    setSvg(openBtn, UiIcons.externalLink(10));
    openBtn.addEventListener('click', (e: Runtime) => {
        e.stopPropagation();
        nav.push('communicator', {}, t('sidebar.agents'));
    });
    header.addEventListener('click', () => {
        nav.push('communicator', {}, t('sidebar.agents'));
    });

    // Compact: show only agents with unread messages as horizontal chips
    const chipContainer = section.createDiv({ cls: 'cs-comm-chips' });
    const emptyLabel = section.createDiv({ cls: 'cs-comm-empty-label', text: t('sidebar.no_new_messages') });

    // Async: load unread counts and render chips
    void updateCommunicatorChips(chipContainer, emptyLabel, agents, plugin, nav);
}

/**
 * Async: render compact chips for agents with unread messages.
 * Shows "Brak nowych wiadomości" if no unread.
 */
async function updateCommunicatorChips(chipContainer: Runtime, emptyLabel: Runtime, agents: Runtime[], plugin: Runtime, nav: Runtime): Promise<void> {
    const komunikator = plugin.agentManager?.komunikatorManager;
    if (!komunikator) {
        emptyLabel.textContent = t('sidebar.communicator_unavailable');
        return;
    }

    let hasUnread = false;
    for (const agentInfo of agents) {
        const agent = plugin.agentManager.getAgent(agentInfo.name);
        if (!agent) continue;
        // S28 D6: agent-duch nie pokazuje skrzynki ani licznika.
        if (plugin.agentManager.isKomunikatorVisible(agent) === false) continue;

        try {
            const count = await komunikator.getUnreadCount(agentInfo.name);
            if (count > 0) {
                hasUnread = true;
                const agentColor = SkinManager.getAgentColor(agent || agentInfo.name);
                const chip = chipContainer.createDiv({ cls: 'cs-comm-home-chip' });
                chip.style.setProperty('--cs-agent-color-rgb', hexToRgbTriplet(agentColor));

                const icon = chip.createSpan({ cls: 'cs-inline-icon' });
                const crystalSeed = agent?.effectiveCrystalSeed || agentInfo.name;
                setSvg(icon, SkinManager.getCrystal(agent || crystalSeed, { size: 12, color: agentColor, glow: false }));
                chip.createSpan({ text: agentInfo.name });
                chip.createSpan({ cls: 'cs-comm-home-chip__badge', text: String(count) });

                chip.addEventListener('click', () => {
                    nav.push('communicator', { agentName: agentInfo.name }, t('sidebar.agents'));
                });
            }
        } catch (e) {
            // Skrzynka JEDNEGO agenta może paść (uszkodzony plik, brak folderu) — nie ma
            // powodu wywalać całej listy Home dla reszty agentów. Fail-open: pomiń ten chip,
            // ale zostaw ślad w logu (cichy `catch {}` gubił sygnał o zepsutej skrzynce).
            log.warn('HomeView', `komunikator.getUnreadCount(${agentInfo.name}) failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    if (hasUnread) {
        emptyLabel.classList.add('hidden');
    }
}

/**
 * Render the Agora section — Crystal Soul style.
 */

/**
 * Async update Agora stats on home view.
 */
/**
 * Render the Zaplecze (Backstage) section — Crystal Soul style.
 */
function renderZapleczeSection(container: Runtime, plugin: Runtime, nav: Runtime): void {
    const section = container.createDiv({ cls: 'cs-home-section' });

    // Header
    const title = section.createDiv({ cls: 'cs-section-title cs-section-title--flush-gap' });
    setSvgLabel(title, UiIcons.wrench(12), t('sidebar.backstage'));

    const items = section.createDiv();

    // S27 Z7: definicja wierszy = czysta struktura danych (backstage_rows.js). Tu tylko DOM.
    for (const rowData of buildZapleczeRows(readZapleczeCounts(plugin))) {
        const label = t(rowData.labelKey);
        const row = items.createDiv({ cls: 'cs-home-row' });
        const left = row.createDiv({ cls: 'cs-home-row__left' });
        setSvgLabel(left, (UiIcons[rowData.icon] || UiIcons.wrench)(12), label);
        if (rowData.count !== null && rowData.count !== undefined) {
            const countEl = row.createSpan({ cls: 'cs-home-row__count', text: `(${rowData.count})` });
            if (rowData.countTitleKey) countEl.title = t(rowData.countTitleKey);
        }
        if (rowData.viewId) {
            row.addEventListener('click', () => nav.push(rowData.viewId, {}, label));
        } else {
            row.addEventListener('click', () => nav.push('zaplecze', { tab: rowData.tab }, t('sidebar.backstage')));
        }
    }
}
