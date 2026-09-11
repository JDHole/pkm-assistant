/**
 * modules/agents - Public API
 *
 * Infrastruktura agentów: AgentManager (CRUD/lifecycle/switch active), AgentLoader
 * (skan vault + built-in), Agent (klasa bazowa) + AgentProfileView (hub profile_*).
 * Agent v3: Persona + Umiejętności + Uprawnienia + Ekipa + Pamięć - bez archetypu/roli.
 *
 * Tylko Jaskier hardcoded (HumanVibe.js / createJaskier). Reszta agentów żyje
 * w vaulcie usera w `.pkm-assistant/agents/*.yaml`.
 *
 * Dodatkowe modale UI (AgentDeleteModal/AgentPresentationModal/
 * SendToAgentModal/AgentSidebar) są w `modules/shell/` (zlew na UI).
 *
 * Z barrela wypadło szereg symboli bez ANI JEDNEGO konsumenta spoza modułu -
 * `DEFAULT_PERMISSIONS`, `SUB_AGENT_ROLES`, `MAX_SUB_AGENTS`, `AgentLoader`,
 * `VaultMap`/`VAULT_MAP_PATH`/`LEGACY_VAULT_MAP_PATH`/`starterVaultMap`, `createJaskier`,
 * `HUMAN_VIBE_CONFIG`, `HiddenFileEditorModal`,
 * `ensureFactoryTemplates`/`getFactorySkillTemplates`/`getFactorySubAgentTemplates`/
 * `FACTORY_TEMPLATES_MARKER`. Definicje ŻYJĄ w bebechach - moduł używa ich u siebie
 * (`AgentManager` instancjuje loadery, `factoryTemplates` woła `initialize()`).
 * Chcesz coś z tego na zewnątrz? Dopisz eksport świadomie, razem z konsumentem.
 *
 * `PERMISSION_SWITCH_TOOLS` nie jest eksportowany - jedyny konsument popovera
 * (`modules/chat/chat/chat_popovers.ts`) bierze tylko cztery pozostałe helpery poniżej,
 * nigdy tę stałą.
 */

// ── Klasa Agent ──
export { Agent } from './Agent.js';
export type {
    AgentConfig,
    AgentFocusFolder,
    AgentPermissions,
    AgentPromptContext,
    AgentSkillAssignment,
    AgentSubAgentAssignment,
    AgentUpdate,
} from './Agent.js';

// ── Manager (jedyny owner lifecycle'u agentów; loadery instancjuje sam) ──
export { AgentManager } from './AgentManager.js';
// Powierzchnia pluginu, jakiej menedżer żąda w konstruktorze - `src/main.ts` nazywa nią
// swój cast na granicy `App` (Obsidian) vs `AppLike` (core).
export type { AgentsPlugin } from './AgentManager.js';
// Kontekst projektowy nie istnieje w prompcie (Project Hub skasowany). VaultMap żyje dalej
// (osobny byt, wewnątrz modułu).

// Rola rozpuszczona - RoleLoader + built-in role + sekcja Settings/Agenci OUT.

// ── Oś narzędziowa: przełączniki uprawnień pokazywane POZA modułem (popover w czacie) ──
// Popover pisał w martwe pola `default_permissions`; te helpery mapują
// te same etykiety na `disabled_tools` - jedyną oś, którą ktokolwiek egzekwuje.
export {
    PERMISSION_PRESET_SWITCHES,
    isPermissionSwitchOn,
    applyPermissionSwitch,
    applyPermissionPreset,
} from './toolAxis.js';

// ── UI: sidebar profile view (hub profile_*, panel v3 = 8 zakładek) ──
export { renderAgentProfileView } from './AgentProfileView.js';

// ── Kanon "model główny" = agent.models.main, legacy agent.model gaśnie po pierwszym
// zapisie profilu. Node-safe (bez `obsidian`) - dowolny czytelnik LEGACY agent.model
// (w tym poza modułem, np. modules/shell) ma czytać PRZEZ ten helper, nie pole bezpośrednio,
// inaczej po migracji dostanie null zamiast realnej wartości. Patrz profile/modelFieldSync.ts.
export { resolveMainModelForForm } from './profile/modelFieldSync.js';
export type { ModelFieldSyncInput, ModelFieldSyncResult, ModelOverrideValue } from './profile/modelFieldSync.js';
