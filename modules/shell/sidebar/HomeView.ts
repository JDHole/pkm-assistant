/**
 * HomeView - Main sidebar view showing agents, communicator and backstage.
 * Crystal Soul design system.
 */
import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import { openAgentDeleteModal } from '../AgentDeleteModal.js';
import { openAgentPresentationModal } from '../AgentPresentationModal.js';
import { Agent } from '../../../modules/agents/index.js';
import type { AgentManager } from '../../../modules/agents/index.js';
import { SkinManager, UiIcons, hexToRgbTriplet, setSvg, setSvgLabel } from '../../../modules/crystal-soul/index.js';
import { isKomunikatorEnabled } from '../../../modules/komunikator/index.js';
import { buildZapleczeRows, readZapleczeCounts } from './backstage_rows.js';
import { t } from '../../../core/i18n/index.js';
import { log } from '../../../core/utils/Logger.js';
import { CHAT_VIEW_TYPE } from '../../../core/index.js';
import type { PluginApi } from '../../../core/index.js';
import type { SidebarNav } from './SidebarNav.js';

// Value-import (nie tylko typ) - inicjalizuje moduł przy imporcie; sam wynik pozostaje nieużywany.
void Agent;

/** Kształt błędu w `catch` bez narzucania typu wyjątku. */
type ErrLike = { message?: string };

/**
 * Plugin widziany przez Home. `externalMcpManager` zawężony do jedynej metody, której
 * potrzebuje `readZapleczeCounts` (backstage_rows.ts) - bez importu realnej klasy
 * `ExternalMcpManager` z modules/tools (Home jej samej nie woła).
 */
interface HomeViewPlugin extends PluginApi {
    agentManager?: AgentManager;
    externalMcpManager?: { listServersForUi?(): Array<{ connected: boolean }> };
}

/** Jeden wpis listy agentów w UI - kształt zwracany przez `Agent.getDisplayInfo()`. */
type AgentListItem = ReturnType<AgentManager['getAgentListForUI']>[number];

/**
 * `AgentManager.komunikatorManager` jest wciąż `any`-owym polem dynamicznym (`RuntimeDependency`,
 * `modules/agents/AgentManager.ts` - migracja modules/agents jeszcze go nie otypowała) - Home
 * czyta z niego wyłącznie `getUnreadCount`, więc zawężamy TYLKO ten kawałek powierzchni.
 */
interface KomunikatorManagerLike {
    getUnreadCount(agentName: string): Promise<number>;
}

/** Powierzchnia `ChatView`, jakiej dotyka Home (przełączenie agenta w otwartej karcie czatu). */
interface ChatViewLike {
    handleAgentChange?: (agentName: string) => void;
}

/**
 * Pierwsza wolna nazwa domyślnego agenta (Agent1, Agent2, …).
 * @param {Object} agentManager
 * @returns {string}
 */
function firstFreeAgentName(agentManager: AgentManager | null | undefined): string {
    for (let i = 1; i <= 999; i++) {
        const name = `Agent${i}`;
        if (!agentManager?.getAgent?.(name)) return name;
    }
    return `Agent${Date.now()}`;
}

/**
 * Role display text mapping (resolved at render time via t()).
 * `role` bierze `string | undefined` - jedyny wołacz (`renderAgentCard` niżej) przekazuje
 * ZAWSZE `undefined` (`Agent.getDisplayInfo()` nie ma pola `role`, patrz TS-boundary tam).
 */
function getRoleLabel(role: string | undefined): string {
    const labels: Record<string, string> = {
        'orchestrator': 'Orchestrator',
        'specialist': t('sidebar.specialist'),
        'meta_agent': t('sidebar.meta_agent')
    };
    return labels[role as string] || role || '';
}

/**
 * Render the home view (agent grid + communicator + zaplecze).
 * @param {HTMLElement} container
 * @param {Object} plugin
 * @param {import('./SidebarNav.js').SidebarNav} nav
 * @param {Object} params
 */
/**
 * TS-boundary: `renderHomeView` jest zarejestrowany w `SidebarNav` (`AgentSidebar.ts`) pod
 * wspólnym `ViewRenderer` (`plugin: PluginApi`) - węższy `HomeViewPlugin` zostaje WŁASNOŚCIĄ tej
 * funkcji (zawężenie u źródła wiedzy, nie w rejestrze), więc rejestracja nie potrzebuje żadnego
 * castu. Wewnętrzne helpery (`renderAgentCard`/`renderCommunicatorSection`/`renderZapleczeSection`)
 * zostają typowane WĄSKO jak dotąd - dostają zawężony `plugin` w miejscu wywołania.
 */
export function renderHomeView(container: HTMLElement, plugin: PluginApi, nav: SidebarNav, _params: Record<string, unknown>): void {
    container.classList.add('cs-root');
    const agentManager = (plugin as HomeViewPlugin).agentManager;
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
        renderAgentCard(grid, agentInfo, plugin as HomeViewPlugin, nav);
    }

    // Add agent card (dashed)
    // „Czysta kartka" - od razu twórz agenta z pierwszą wolną nazwą (Agent1/Agent2…)
    // i otwórz jego profil w NORMALNYM trybie edycji (bez osobnego create-mode).
    const addCard = grid.createDiv({ cls: 'cs-agent-card cs-agent-card--add' });
    setSvg(addCard, UiIcons.plus(16));
    addCard.addEventListener('click', async () => {
        try {
            const name = firstFreeAgentName((plugin as HomeViewPlugin).agentManager);
            await (plugin as HomeViewPlugin).agentManager!.createAgent({ name });
            nav.push('agent-profile', { agentName: name }, t('sidebar.agents'));
        } catch (e) {
            new Notice(t('profile.advanced.create_error') + (((e as ErrLike)?.message || (e as ErrLike)) as string));
        }
    });

    // ── Section: Komunikator ── (kill-switch: hidden unless enabled, default off)
    if (isKomunikatorEnabled(plugin.settings)) {
        renderCommunicatorSection(container, agents, plugin as HomeViewPlugin, nav);
    }

    // ── Section: Agora ──

    // ── Section: Zaplecze ──
    renderZapleczeSection(container, plugin as HomeViewPlugin, nav);
}

/**
 * Render a single agent card - Crystal Soul style.
 */
function renderAgentCard(container: HTMLElement, agentInfo: AgentListItem, plugin: HomeViewPlugin, nav: SidebarNav): void {
    const agent = plugin.agentManager!.getAgent(agentInfo.name);
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
    // TS-boundary: `role` nie jest polem `Agent.getDisplayInfo()` (name/color/description/isBuiltIn) -
    // zastane: `role` nigdy nie ma, blok jest martwy; kasacja tego bloku byłaby zmianą runtime
    // (poza zakresem tej migracji), więc zostaje 1:1 z oryginałem (getRoleLabel(undefined) → '').
    const roleText = getRoleLabel((agentInfo as unknown as { role?: string }).role);
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
    profileBtn.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        nav.push('agent-profile', { agentName: agent.name }, t('sidebar.agents'));
    });

    // Kosz ukryty dla agenta wbudowanego (Jaskier) - nieusuwalny (defense in depth).
    if (!agent.isBuiltIn) {
        const deleteBtn = actions.createEl('button', {
            cls: 'cs-agent-card__action cs-agent-card__action--danger',
            attr: { 'aria-label': t('generic.delete') }
        });
        setSvg(deleteBtn, UiIcons.trash(10));
        deleteBtn.addEventListener('click', (e: MouseEvent) => {
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
                // TS-boundary: `AppLike.workspace` (core, node-safe) erasuje realne Obsidian API -
                // shell już importuje `obsidian` wprost, więc sięga po prawdziwy `App`/`WorkspaceLeaf`.
                const chatView = ((plugin.app as unknown as App).workspace.getLeavesOfType(CHAT_VIEW_TYPE)?.[0]?.view as unknown) as ChatViewLike | undefined;
                if (chatView?.handleAgentChange) {
                    chatView.handleAgentChange(agentInfo.name);
                }
            },
        });
    });
}

/**
 * Render the communicator section - Crystal Soul style.
 */
function renderCommunicatorSection(container: HTMLElement, agents: AgentListItem[], plugin: HomeViewPlugin, nav: SidebarNav): void {
    const section = container.createDiv({ cls: 'cs-home-section' });

    // Header (clickable - opens communicator)
    const header = section.createDiv({ cls: 'cs-home-section__header cs-home-section__header--clickable' });
    const title = header.createDiv({ cls: 'cs-section-title cs-section-title--flush' });
    setSvgLabel(title, UiIcons.chat(12), t('sidebar.communicator'));

    const openBtn = header.createEl('button', {
        cls: 'cs-home-section__open',
        attr: { 'aria-label': t('sidebar.open_communicator') }
    });
    setSvg(openBtn, UiIcons.externalLink(10));
    openBtn.addEventListener('click', (e: MouseEvent) => {
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
async function updateCommunicatorChips(chipContainer: HTMLElement, emptyLabel: HTMLElement, agents: AgentListItem[], plugin: HomeViewPlugin, nav: SidebarNav): Promise<void> {
    // TS-boundary: `AgentManager.komunikatorManager` jest wciąż nieotypowanym polem dynamicznym
    // (migracja modules/agents go jeszcze nie dotknęła) - zawężamy do jedynej metody, którą Home woła.
    const komunikator = plugin.agentManager?.komunikatorManager as KomunikatorManagerLike | undefined;
    if (!komunikator) {
        emptyLabel.textContent = t('sidebar.communicator_unavailable');
        return;
    }

    let hasUnread = false;
    for (const agentInfo of agents) {
        const agent = plugin.agentManager!.getAgent(agentInfo.name);
        if (!agent) continue;
        // Agent-duch nie pokazuje skrzynki ani licznika.
        if (plugin.agentManager!.isKomunikatorVisible(agent) === false) continue;

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
            // Skrzynka JEDNEGO agenta może paść (uszkodzony plik, brak folderu) - nie ma
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
 * Render the Agora section - Crystal Soul style.
 */

/**
 * Async update Agora stats on home view.
 */
/**
 * Render the Zaplecze (Backstage) section - Crystal Soul style.
 */
function renderZapleczeSection(container: HTMLElement, plugin: Parameters<typeof readZapleczeCounts>[0], nav: SidebarNav): void {
    const section = container.createDiv({ cls: 'cs-home-section' });

    // Header
    const title = section.createDiv({ cls: 'cs-section-title cs-section-title--flush-gap' });
    setSvgLabel(title, UiIcons.wrench(12), t('sidebar.backstage'));

    const items = section.createDiv();

    // Definicja wierszy = czysta struktura danych (backstage_rows.js). Tu tylko DOM.
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
