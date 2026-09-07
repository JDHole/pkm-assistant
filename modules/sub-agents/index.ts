/**
 * modules/sub-agents — publiczne API modułu sub-agentów (delegation system).
 *
 * To są JEDYNE drzwi na zewnątrz modułu. Reszta pluginu importuje stąd, nie z bebechów.
 * Szczegóły: CLAUDE.md w tym folderze.
 *
 * S30 Z4 (przycinka powierzchni): `DEPRECATED_TOOL_RENAMES`, `migrateDeprecatedTools`
 * i `SUB_AGENT_TEMPLATES_PATH` OUT — zero konsumentów spoza modułu (migrację nazw
 * narzędzi robi `SubAgentLoader` przy load + `SubAgentRunner._resolveToolNames`,
 * ścieżkę magazynu zna store). Definicje żyją w bebechach.
 */

export {
    SubAgentLoader,
    getVisibleSubAgentsForAgent,
    DEFAULT_SUB_AGENT_TOOLS,
    PKM_SUB_NAME,
} from './SubAgentLoader.js';
export { SubAgentRunner } from './SubAgentRunner.js';
// F5: kształt zwrotki runnera (sposób zejścia + flaga niepowodzenia) — czyta go `DelegateTool`.
export type { SubRunResult, SubRunStoppedBy } from './SubAgentRunner.js';
// F1 (przebudowa subów 2026): rejestr biegów subów + szyna zdarzeń. Pure (obsidian-free) —
// stawia go composition root (`src/main.js`) jako `plugin.subTaskRegistry`.
export { SubTaskRegistry } from './SubTaskRegistry.js';
// F2 (delegacja w tle): skrzynka wyników subów odpalonych w tle. Też pure — composition root
// stawia ją jako `plugin.subTaskNotifier`, a dostawcę (czat) wstrzykuje faza B.
export { SubTaskNotifier } from './SubTaskNotifier.js';
// Pasek biegów subów w OKNIE CZATU (2026-08-15): model per ZAKŁADKA. Konsumentem jest
// `modules/chat`, więc eksport jest niezbędny — plik pozostaje pure (zero obsidian/DOM/i18n),
// barrel zostaje czysty. Widok sidebara `renderSubTaskRunsView` + `buildPanelModel` OUT:
// biegi należą do agenta i sesji, nie do globalnego panelu.
export { buildStripModel, formatDuration } from './subTaskPanelModel.js';
export type { StripRow, StripStep, BuildStripModelInput } from './subTaskPanelModel.js';
export { registerBackstage } from './BackstageTab.js';
// S27 Z1: magazyn szablonów sub-agentów (Zaplecze) — forma odlewnicza, nie żywy byt.
export { SubAgentTemplateStore } from './SubAgentTemplateStore.js';
// E2.8 B3: factory sub-agent task frame — surfaced in Settings→Prompt (B2). Pure (obsidian-free).
export { DEFAULT_SUBAGENT_FRAME_PROMPT } from './framePrompt.js';
export type { ScopeData, SubAgentData, SubAgentInput, VaultLike } from './types.js';
export type {
    SubTask,
    SubTaskStatus,
    SubTaskStep,
    SubTaskBudget,
    SubTaskResult,
    SubTaskOrigin,
} from './SubTaskRegistry.js';
export type { SubTaskDeliverer } from './SubTaskNotifier.js';

// SubAgentDetailView.js statically imports `obsidian` (MarkdownRenderer). Lazy-load it
// via dynamic import so this barrel stays obsidian-free — it is imported by TriggerPopup /
// chat_ui / DelegateTool, whose AVA tests cannot resolve `obsidian`. SidebarNav invokes
// route renderers fire-and-forget, so an async renderer is fine (see registerBackstage).
// TS-any: lazy UI export preserves its existing dynamic renderer signature.
export async function renderSubAgentDetailView(...args: any[]) {
    const mod = await import('./SubAgentDetailView.js');
    return mod.renderSubAgentDetailView(...args as [any, any, any, any]);
}

// S31: `SubAgentEditorModal` przeprowadzony tu z `modules/shell/` (edytor suba = sprawa subów).
// Z tego samego powodu co wyżej (statyczny `obsidian`) NIE wchodzi do barrela zwykłym
// re-eksportem — barrel musi zostać obsidian-free dla `DelegateTool`/`TriggerPopup`.
// Konsument spoza modułu (profil agenta → Ekipa) bierze klasę tym akcesorem, w handlerze kliknięcia.
export async function loadSubAgentEditorModal() {
    const mod = await import('./SubAgentEditorModal.js');
    return mod.SubAgentEditorModal;
}
