/**
 * modules/shell - Public API
 *
 * Obudowa pluginu: settings tab, sidebar, misc modale, custom workspace views.
 * "Zlew" na UI - wszystko co nie pasuje do dedykowanego modułu (chat/agents/
 * artifacts/onboarding/komunikator) ląduje tu.
 *
 * Złota zasada: kod spoza modułu importuje TYLKO przez ten plik.
 * Wewnątrz shell pliki importują się swobodnie.
 *
 * Kilka symboli z tego katalogu NIE jest re-eksportowanych stąd, choć definicje ŻYJĄ - kasujemy
 * tylko drzwi. Rama i rejestry ustawień (`PluginSettingsTab`, `SettingsRegistry`/`SettingsRegistryClass`,
 * `BackstageRegistry`/`BackstageRegistryClass`) - moduły dostają rejestr ARGUMENTEM
 * w `registerSettings(registry, plugin)` / `registerBackstage(...)`, nie importem.
 * Helpery Zaplecza `renderAgentLinks`/`agentHasSubAgent`. Klasy, których wołacz i tak
 * dostaje przez funkcję-fasadę: `AgentSidebar` + `AGENT_SIDEBAR_VIEW_TYPE`
 * (zostają `registerAgentSidebar`/`openAgentSidebar`), `ApprovalModal`
 * (zostaje `requestApproval`). Modale, do których wołacz i tak wchodzi INNĄ drogą:
 * `CostTrackingModal` (leniwy import lokalny w `pkm_settings_tab.js`),
 * `MCPServerEditorModal` (import lokalny w `pkm_settings_tab.js` + wstrzyknięcie
 * przez `ctx` do `SettingsContent` ownerów), `AgentDeleteModal`/`openAgentDeleteModal`
 * i `AgentPresentationModal`/`openAgentPresentationModal` (import lokalny w
 * `sidebar/HomeView.js`).
 */

// ── Custom Workspace Views ────────────────────────────────────────────────
// Bazowa klasa widoku mieszka w `modules/ui-components` jako `PluginItemView` i stamtąd biorą
// ją oba dziedziczące moduły (chat → ChatView, shell → ReleaseNotesView).
export { ReleaseNotesView } from './ReleaseNotesView.js';

// ── Settings tab ──────────────────────────────────────────────────────────
export { PkmSettingsTab } from './pkm_settings_tab.js';

// Współdzielone prymitywy kart Zaplecza (`backstage_helpers.js`) mieszkają w
// `modules/ui-components/` - wołają je zakładki z modules/skills i modules/sub-agents,
// więc nie ma powodu, by moduły niższe sięgały po nie do barrela shella.

// ── Sidebar (rejestracja + otwarcie; klasa widoku zostaje wewnątrz shella) ─
export { registerAgentSidebar, openAgentSidebar } from './AgentSidebar.js';
// Typ nawigacji stosu widoków sidebara - konsument spoza modułu: modules/agents (profile/*.ts,
// `nav.push/pop/goHome`). Wartość (klasa) nie wychodzi stąd, tylko kształt.
export type { SidebarNav } from './sidebar/SidebarNav.js';

// ── Modale ────────────────────────────────────────────────────────────────
// Approval wchodzi WYŁĄCZNIE przez funkcję-fasadę (core/security/ApprovalManager).
export { requestApproval } from './ApprovalModal.js';
// `DiffModal` mieszka w `modules/ui-components/` (wołacz: modules/tools/MCPClient).
export { InlineCommentModal } from './InlineCommentModal.js';
export { SendToAgentModal } from './SendToAgentModal.js';
// Modale sesji (`SessionCloseModal`, `SaveSessionModal`, `OpenSessionModal`) mieszkają
// w `modules/chat/` - jedyni wołacze (chat_session, /save session) są tam. Wewnętrzne,
// NIE ma ich w żadnym barrelu.
// `ConsolidationProgressModal` (nieblokujący modal PRZEBIEGU konsolidacji: checklista kroków
// + review w środku) razem z `archiveReviewRenders.js` i `consolidationRunState.js`
// mieszka w `modules/chat/` - jedyny wołacz (`consolidationRunner.js`) jest tam.
// `MigrationModal` mieszka w `modules/agents/` (jedyny wołacz to AgentManager)
// - wewnętrzny szczegół agentów, NIE ma go w żadnym barrelu.
// Modale Settings (CostTracking/MCPServerEditor/ClaudeImport)
// ida przez DI z pkm_settings_tab (wnetrze shella) - nie potrzebuja barrela.
// `SkillEditorModal` mieszka w `modules/skills/` (właściciel u siebie) -
// konsumenci biorą go z barrela skilli, nie stąd.
// `SubAgentEditorModal` mieszka w `modules/sub-agents/` (właściciel u siebie).
