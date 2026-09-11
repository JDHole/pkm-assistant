/**
 * profile_types.ts - Shared types for the profile/ tab modules (`AgentProfileView` + all
 * `profile_*.ts` tabs). Hoisted here because `ctx`/`formData` are read by every tab file
 * (2+ consumers), not just one - see modules/agents/CLAUDE.md "Technika" for the rule.
 */
import type { Agent, AgentFocusFolder, AgentPermissions, AgentSkillAssignment, AgentSubAgentAssignment } from '../Agent.js';
import type { AgentManager, AgentsPlugin as AgentsPluginBase } from '../AgentManager.js';
import type { SidebarNav } from '../../shell/index.js';

/**
 * Plugin boundary for the profile module: re-exported from here (not straight from
 * AgentManager.ts) so profile/*.ts and AgentProfileView.ts have one import source for
 * everything profile-shaped. `AgentManager` narrowed non-optional - `renderAgentProfileView`
 * already returns early when `plugin.agentManager` is missing.
 */
export interface AgentsPlugin extends AgentsPluginBase {
    agentManager: AgentManager;
}

/** Custom per-agent decision-tree instruction (`custom_<group>_<ts>` keys) - profile_prompt.ts's
 * editor UI and profile_advanced.ts's mem_proactive toggle both read/write this same bag
 * (2+ consumers - hoisted here per modules/agents/CLAUDE.md "Technika"). */
export type DTCustomEntry = { group: string; text: string; tool: string | null };
/** A decisionTreeInstructions entry: plain bool/string overrides, or a full custom entry object -
 * `Record<string, boolean>` (profile_advanced.ts's old local cast) undersold this: `custom_*`
 * keys carry {@link DTCustomEntry} objects, not booleans. */
export type DTInstrValue = boolean | string | DTCustomEntry;

/** Editable working copy of an agent's config while the profile panel is open (pre-save). */
export interface ProfileFormData {
    name: string;
    color: string | null;
    personality: string;
    description: string;
    createdAt: string | null;
    temperature: number;
    language: string;
    default_autonomy: string;
    admin_access: boolean;
    komunikator_visible: boolean;
    focus_folders: AgentFocusFolder[];
    model: string | null;
    skills: AgentSkillAssignment[];
    artifact_types: string[];
    disabled_tools: string[];
    preferred_servers: string[];
    preferred_tools: string[];
    mcp_servers: string[];
    sub_agents: AgentSubAgentAssignment[];
    sub_agent_enabled: boolean;
    permissions: AgentPermissions;
    /** `main` is the only key every consumer names explicitly; rest is an open per-role bag. */
    models: { main?: string; [key: string]: unknown };
    prompt_overrides: Record<string, unknown>;
    agent_rules: string;
    crystal_seed: string | null;
    compression_prompt: string;
    save_session_prompt: string;
    archive_prompt: string;
    summary_prompt: string;
    subagent_frame_prompt: string;
    memory_rescue: boolean;
    /** Lazily set by the Permissions tab the first time it renders (absent until then). */
    approval_toggles?: Record<string, unknown>;
}

/** Shared render context passed by `AgentProfileView` to every `profile_*.ts` tab. */
export interface ProfileCtx {
    formData: ProfileFormData;
    agent: Agent;
    plugin: AgentsPlugin;
    nav: SidebarNav;
    agentManager: AgentManager;
    container: HTMLElement;
    activeSkillsSubTab: string;
    activeEkipaSubTab: string;
    activeMemorySubTab: 'brain' | 'sessions' | 'summaries';
    activePromptSubTab: 'inspector' | 'editor';
    promptExpandedSet: Set<string>;
    dtExpandedGroups: Set<string>;
    memorySessionPage: number;
    memorySessionFilter: string;
    /**
     * Non-nullable from every tab module's point of view: `AgentProfileView` wires the real
     * function onto `ctx` before any tab is ever rendered, and every `profile_*.ts` tab calls
     * it directly (`ctx.renderActiveTab()`, no guard) - see `AgentProfileView.ts`'s `ctx` literal
     * for the one legitimately-null moment, during construction, before that wiring happens.
     */
    renderActiveTab: () => Promise<void>;
    /** Render-generation guard set lazily by the Memory tab's sub-tab switcher. */
    __memorySubTabRenderSeq?: number;
}
