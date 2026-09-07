/**
 * modules/shell — Public API
 *
 * Obudowa pluginu: settings tab, sidebar, misc modale, custom workspace views.
 * "Zlew" na UI — wszystko co nie pasuje do dedykowanego modułu (chat/agents/
 * artifacts/onboarding/komunikator) ląduje tu.
 *
 * Złota zasada: kod spoza modułu importuje TYLKO przez ten plik.
 * Wewnątrz shell pliki importują się swobodnie.
 *
 * S30 Z4 (przycinka powierzchni): 17 symboli bez ANI JEDNEGO konsumenta spoza shella OUT.
 * Rama i rejestry ustawień (`PluginSettingsTab`, `SettingsRegistry`/`SettingsRegistryClass`,
 * `BackstageRegistry`/`BackstageRegistryClass`) — moduły dostają rejestr ARGUMENTEM
 * w `registerSettings(registry, plugin)` / `registerBackstage(...)`, nie importem.
 * Helpery Zaplecza `renderAgentLinks`/`agentHasSubAgent`. Klasy, których wołacz i tak
 * dostaje przez funkcję-fasadę: `AgentSidebar` + `AGENT_SIDEBAR_VIEW_TYPE`
 * (zostają `registerAgentSidebar`/`openAgentSidebar`), `ApprovalModal`
 * (zostaje `requestApproval`). Modale, do których wołacz i tak wchodzi INNĄ drogą:
 * `CostTrackingModal` (leniwy import lokalny w `pkm_settings_tab.js`),
 * `MCPServerEditorModal` (import lokalny w `pkm_settings_tab.js` + wstrzyknięcie
 * przez `ctx` do `SettingsContent` ownerów), `AgentDeleteModal`/`openAgentDeleteModal`
 * i `AgentPresentationModal`/`openAgentPresentationModal` (import lokalny w
 * `sidebar/HomeView.js`). Definicje ŻYJĄ — kasujemy tylko drzwi.
 *
 * S36b (2026-07-30): `DraftsListModal.js` — wycięty w Z4 z barrela jako martwy — poszedł
 * w całości do kosza razem z resztą rodziny draftów (patrz CLAUDE.md, sekcja S36b).
 */

// ── Custom Workspace Views ────────────────────────────────────────────────
// S35: re-export kompatybilnościowy `ObsekItemView` SKASOWANY (0 konsumentów) —
// bazowa klasa mieszka w `modules/ui-components` jako `PluginItemView` i stamtąd biorą
// ją oba dziedziczące moduły (chat → ChatView, shell → ReleaseNotesView).
export { ReleaseNotesView } from './ReleaseNotesView.js';

// ── Settings tab ──────────────────────────────────────────────────────────
export { PkmSettingsTab } from './pkm_settings_tab.js';

// S31: współdzielone prymitywy kart Zaplecza (`backstage_helpers.js`) przeniesione do
// `modules/ui-components/` — wołają je zakładki z modules/skills i modules/sub-agents,
// więc nie ma powodu, by moduły niższe sięgały po nie do barrela shella.

// ── Sidebar (rejestracja + otwarcie; klasa widoku zostaje wewnątrz shella) ─
export { registerAgentSidebar, openAgentSidebar } from './AgentSidebar.js';

// ── Modale ────────────────────────────────────────────────────────────────
// Approval wchodzi WYŁĄCZNIE przez funkcję-fasadę (core/security/ApprovalManager).
export { requestApproval } from './ApprovalModal.js';
// S31: `DiffModal` przeniesiony do `modules/ui-components/` (wołacz: modules/tools/MCPClient).
export { InlineCommentModal } from './InlineCommentModal.js';
export { SendToAgentModal } from './SendToAgentModal.js';
// S31: modale sesji (`SessionCloseModal`, `SaveSessionModal`, `OpenSessionModal`) przeniesione
// do `modules/chat/` — jedyni wołacze (chat_session, /save session) mieszkają tam. Wewnętrzne,
// NIE ma ich w żadnym barrelu.
// S29 Z4: nieblokujący modal PRZEBIEGU konsolidacji (checklista kroków + review w środku).
// D6 (2026-07-30): `ArchiveModal` (modal per faza starego, blokującego `ArchiveWorkflow.run()`)
// SKASOWANY razem z całym starym torem — od kubełka 2 nie miał produkcyjnego wołacza.
// S31: `ConsolidationProgressModal` razem z `archiveReviewRenders.js` i `consolidationRunState.js`
// przeniesiony do `modules/chat/` — jedyny wołacz (`consolidationRunner.js`) mieszka tam.
// S31: `MigrationModal` przeniesiony do `modules/agents/` (jedyny wołacz to AgentManager)
// — wewnętrzny szczegół agentów, NIE ma go w żadnym barrelu.
// S30 Z4 + merge S32: modale Settings (CostTracking/MCPServerEditor/ClaudeImport)
// ida przez DI z pkm_settings_tab (wnetrze shella) — nie potrzebuja barrela.
// S31: `SkillEditorModal` przeniesiony do `modules/skills/` (właściciel u siebie) —
// konsumenci biorą go z barrela skilli, nie stąd.
// S31: `SubAgentEditorModal` przeniesiony do `modules/sub-agents/` (właściciel u siebie).
