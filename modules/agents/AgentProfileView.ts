/**
 * AgentProfileView - coordinator.
 * Imports tab modules from profile/ and wires them together.
 */
import { Setting, Notice } from 'obsidian';
import { SkinManager, UiIcons, hexToRgbTriplet, setSvg, setSvgLabel } from '../crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';

// Preserve the legacy external module load; TypeScript would otherwise elide these historical imports.
void Setting;
void Notice;

// Tab modules
import { renderOverviewTab } from './profile/profile_overview.js';
import { renderProfileTab } from './profile/profile_persona.js';
import { renderPermissionsTab } from './profile/profile_permissions.js';
import { renderSkillsTab } from './profile/profile_skills.js';
import { renderEkipaTab } from './profile/profile_team.js';
import { renderPromptTab } from './profile/profile_prompt.js';
import { renderMemoryTab } from './profile/profile_memory.js';
import { renderArtifactsTab } from './profile/profile_artifacts.js';
import { renderAdvancedTab, handleSave, showDeleteConfirmation } from './profile/profile_advanced.js';
import { resolveMainModelForForm } from './profile/modelFieldSync.js';
import { log } from '../../core/utils/Logger.js';

// TS-any: profile rendering crosses Obsidian's runtime-extended plugin and sidebar APIs.
type UiBoundary = any;
interface ProfileParams { agentName?: string | null; }

// Tab definitions (Crystal Soul 8-tab layout).
// `editOnly` skasowane - nie ma już create-mode (agent tworzony od razu przy "+",
// profil zawsze otwiera się w normalnym trybie edycji z pełnym zestawem 8 zakładek).
const TABS = [
    { id: 'overview',    labelKey: 'profile.tab.overview',     icon: () => UiIcons.eye(14) },
    { id: 'profile',     labelKey: 'profile.tab.persona',      icon: () => UiIcons.user(14) },
    { id: 'skills',      labelKey: 'profile.tab.skills',       icon: () => UiIcons.zap(14) },
    { id: 'team',        labelKey: 'profile.tab.team',         icon: () => UiIcons.users(14) },
    { id: 'permissions', labelKey: 'profile.tab.permissions',  icon: () => UiIcons.shield(14) },
    { id: 'memory',      labelKey: 'profile.tab.memory',       icon: () => UiIcons.brain(14) },
    { id: 'artifacts',   labelKey: 'profile.tab.artifacts',    icon: () => UiIcons.clipboard(14) },
    { id: 'prompt',      labelKey: 'profile.tab.prompt',       icon: () => UiIcons.edit(14) },
    { id: 'advanced',    labelKey: 'profile.tab.advanced',     icon: () => UiIcons.settings(14) },
];

/**
 * Render agent profile view inline in sidebar.
 * @param {HTMLElement} container
 * @param {Object} plugin
 * @param {import('../shell/sidebar/SidebarNav.js').SidebarNav} nav
 * @param {Object} params - { agentName: string|null }
 */
export function renderAgentProfileView(container: HTMLElement, plugin: UiBoundary, nav: UiBoundary, params: ProfileParams) {
    const agentManager = plugin.agentManager;
    if (!agentManager) {
        container.createEl('p', { text: t('profile.not_init'), cls: 'agent-error' });
        return;
    }

    // Agent tworzony jest OD RAZU przy "+" (HomeView) - profil zawsze ma istniejącego
    // agenta. Brak agenta = ktoś wszedł na skasowany/niepoprawny wpis → komunikat, bez create-mode.
    const agent = params.agentName ? agentManager.getAgent(params.agentName) : null;
    if (!agent) {
        container.createEl('p', { text: t('profile.not_found'), cls: 'agent-error' });
        return;
    }

    // Form data (copy from agent)
    const formData = {
        name: agent.name,
        color: agent.color || null,
        personality: agent.personality || '',
        description: agent.description || '',
        createdAt: agent.createdAt || null,
        temperature: agent.temperature,
        // Język + domyślna autonomia per agent ('' = globalna/auto).
        language: agent.language || 'auto',
        default_autonomy: agent.default_autonomy || '',
        admin_access: agent.admin_access === true,
        // "Uczestniczy w komunikatorze" (default ON).
        komunikator_visible: agent.komunikator_visible !== false,
        focus_folders: [...(agent.focusFolders || [])],
        model: agent.model || null,
        skills: JSON.parse(JSON.stringify(agent._skills || [])),
        // Typy artefaktów podpięte per agent (jak skille). Puste = tylko wbudowany `plan`.
        artifact_types: [...(agent.artifact_types || [])],
        // Jedna oś narzędziowa (disabled_tools). enabled_tools skasowane.
        disabled_tools: [...(agent.disabled_tools || [])],
        preferred_servers: [...(agent.preferredServers || [])],
        preferred_tools: [...(agent.preferredTools || [])],
        mcp_servers: Array.isArray(agent.mcp_servers) ? [...agent.mcp_servers] : ['vault', 'memory', 'core'],
        sub_agents: JSON.parse(JSON.stringify(agent._subAgents || [])),
        sub_agent_enabled: agent.subAgentEnabled !== false,
        permissions: { ...agent.permissions },
        models: JSON.parse(JSON.stringify(agent.models || {})),
        prompt_overrides: JSON.parse(JSON.stringify(agent.promptOverrides || {})),
        agent_rules: agent.agentRules || '',
        crystal_seed: agent.crystalSeed || null,
        // Prompty robocze per agent (puste = global/factory przez resolver).
        compression_prompt: agent.compression_prompt || '',
        save_session_prompt: agent.save_session_prompt || '',
        archive_prompt: agent.archive_prompt || '',
        summary_prompt: agent.summary_prompt || '',
        subagent_frame_prompt: agent.subagent_frame_prompt || '',
        // Ratunek pamięci przed kompresją (per-agent, default ON)
        memory_rescue: agent.memory_rescue !== false
    };

    // KANON to `models.main` - `model` (legacy) NIGDY nie jest kopiowany z powrotem z
    // `models.main` (był to żywy bug, patrz modelFieldSync.ts). Jedyny przypadek, gdy `model`
    // się zmienia tutaj, to jednorazowa migracja starego configu, który ma TYLKO legacy pole
    // (bez models.main) - wtedy awansuje na models.main i gaśnie.
    const modelSync = resolveMainModelForForm({ model: formData.model, models: formData.models });
    formData.model = modelSync.model;
    formData.models = modelSync.models;

    // Agent color for CSS
    const agentColor = SkinManager.getAgentColor(agent || formData.name || 'default');
    const agentRgb = hexToRgbTriplet(agentColor);
    container.addClass('cs-root');
    container.style.setProperty('--cs-agent-color-rgb', agentRgb);

    // ── Shared context object (passed to all tab modules) ──
    const ctx = {
        formData,
        agent,
        plugin,
        nav,
        agentManager,
        container,
        // Mutable sub-tab state
        activeSkillsSubTab: 'skills',
        activeEkipaSubTab: 'minions',
        activeMemorySubTab: 'brain',
        activePromptSubTab: 'inspector',
        promptExpandedSet: new Set(),
        dtExpandedGroups: new Set(),
        memorySessionPage: 0,
        memorySessionFilter: '',
        // Will be set after tabContent is created
        renderActiveTab: null as (() => Promise<void>) | null,
    };

    // ── HEADER ──
    const header = container.createDiv({ cls: 'cs-profile__header' });
    header.createEl('h2', { text: formData.name, cls: 'cs-profile__name' });
    // Badge roli w headerze usunięty - rola rozpuszczona.

    // ── TAB BAR ── (zawsze pełne 8 zakładek, start na Przeglądzie)
    let activeTab = 'overview';
    const tabBar = container.createDiv({ cls: 'cs-profile-tabs' });
    for (const tab of TABS) {
        const tabBtn = tabBar.createEl('button', {
            cls: `cs-profile-tab ${activeTab === tab.id ? 'cs-profile-tab--active' : ''}`
        });
        const tabIconSpan = tabBtn.createSpan();
        setSvg(tabIconSpan, tab.icon());
        tabBtn.createSpan({ text: t(tab.labelKey) });
        tabBtn.dataset.tab = tab.id;
        tabBtn.addEventListener('click', () => {
            activeTab = tab.id;
            tabBar.querySelectorAll('.cs-profile-tab').forEach((t: Element) => t.classList.remove('cs-profile-tab--active'));
            tabBtn.classList.add('cs-profile-tab--active');
            void renderActiveTab();
        });
    }

    // ── TAB CONTENT ──
    const tabContent = container.createDiv({ cls: 'cs-profile-content' });

    // ── BUTTONS (bottom bar) ──
    const buttonContainer = container.createDiv({ cls: 'cs-profile-buttons' });

    const cancelBtn = buttonContainer.createEl('button', { text: t('profile.cancel') });
    cancelBtn.addEventListener('click', () => nav.pop());

    const saveBtn = buttonContainer.createEl('button', {
        text: t('profile.save'),
        cls: 'cs-btn--primary'
    });
    saveBtn.addEventListener('click', () => { void handleSave(ctx); });

    if (!agent.isBuiltIn) {
        const deleteBtn = buttonContainer.createEl('button', { cls: 'cs-btn--danger' });
        setSvgLabel(deleteBtn, UiIcons.trash(12), t('generic.delete'));
        deleteBtn.addEventListener('click', () => showDeleteConfirmation(ctx, tabContent));
    }

    // ── Tab dispatcher ──
    async function renderActiveTab() {
        tabContent.empty();
        try {
            switch (activeTab) {
                case 'overview': await renderOverviewTab(ctx, tabContent); break;
                // Persona jest async (panel aktywnych sesji czyta pamięć z dysku).
                case 'profile': await renderProfileTab(ctx, tabContent); break;
                case 'permissions': renderPermissionsTab(ctx, tabContent); break;
                case 'skills': renderSkillsTab(ctx as unknown as Parameters<typeof renderSkillsTab>[0], tabContent); break;
                case 'team': renderEkipaTab(ctx, tabContent); break;
                case 'prompt': await renderPromptTab(ctx, tabContent); break;
                case 'memory': await renderMemoryTab(ctx, tabContent); break;
                case 'artifacts': renderArtifactsTab(ctx, tabContent); break;
                case 'advanced': await renderAdvancedTab(ctx, tabContent); break;
            }
        } catch (err: unknown) {
            log.error('AgentProfile', 'renderActiveTab error:', err);
            tabContent.createDiv({ text: t('profile.advanced.render_error') + (err as Error).message, cls: 'cs-shard__sub-label' });
        }
    }

    // Wire up ctx.renderActiveTab
    ctx.renderActiveTab = renderActiveTab;

    // Render initial tab
    void renderActiveTab();
}
