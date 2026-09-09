/**
 * modules/sub-agents — publiczne API modułu sub-agentów (delegation system).
 *
 * To są JEDYNE drzwi na zewnątrz modułu. Reszta pluginu importuje stąd, nie z bebechów.
 * Szczegóły: CLAUDE.md w tym folderze.
 *
 * `DEPRECATED_TOOL_RENAMES`, `migrateDeprecatedTools` i `SUB_AGENT_TEMPLATES_PATH` NIE są
 * eksportowane — zero konsumentów spoza modułu (migrację nazw narzędzi robi `SubAgentLoader`
 * przy load + `SubAgentRunner._resolveToolNames`, ścieżkę magazynu zna store). Definicje
 * żyją w bebechach.
 */

export {
    SubAgentLoader,
    getVisibleSubAgentsForAgent,
    DEFAULT_SUB_AGENT_TOOLS,
    PKM_SUB_NAME,
} from './SubAgentLoader.js';
export { SubAgentRunner } from './SubAgentRunner.js';
// Kształt zwrotki runnera (sposób zejścia + flaga niepowodzenia) — czyta go `DelegateTool`.
export type { SubRunResult, SubRunStoppedBy } from './SubAgentRunner.js';
// Rejestr biegów subów + szyna zdarzeń. Pure (obsidian-free) —
// stawia go composition root (`src/main.js`) jako `plugin.subTaskRegistry`.
export { SubTaskRegistry } from './SubTaskRegistry.js';
// Skrzynka wyników subów odpalonych w tle (delegacja w tle). Też pure — composition root
// stawia ją jako `plugin.subTaskNotifier`, a dostawcę (czat) wstrzykuje osobna warstwa.
export { SubTaskNotifier } from './SubTaskNotifier.js';
// Pasek biegów subów w OKNIE CZATU: model per ZAKŁADKA. Konsumentem jest
// `modules/chat`, więc eksport jest niezbędny — plik pozostaje pure (zero obsidian/DOM/i18n),
// barrel zostaje czysty. Widok sidebara `renderSubTaskRunsView` + `buildPanelModel` OUT:
// biegi należą do agenta i sesji, nie do globalnego panelu.
export { buildStripModel, formatDuration } from './subTaskPanelModel.js';
export type { StripRow, StripStep, BuildStripModelInput } from './subTaskPanelModel.js';
export { registerBackstage } from './BackstageTab.js';
// Magazyn szablonów sub-agentów (Zaplecze) — forma odlewnicza, nie żywy byt.
export { SubAgentTemplateStore } from './SubAgentTemplateStore.js';
// Factory sub-agent task frame — surfaced in Settings→Prompt. Pure (obsidian-free).
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

// `SubAgentEditorModal` żyje tu, nie w `modules/shell/` (edytor suba = sprawa subów).
// Z tego samego powodu co wyżej (statyczny `obsidian`) NIE wchodzi do barrela zwykłym
// re-eksportem — barrel musi zostać obsidian-free dla `DelegateTool`/`TriggerPopup`.
// Konsument spoza modułu (profil agenta → Ekipa) bierze klasę tym akcesorem, w handlerze kliknięcia.
export async function loadSubAgentEditorModal() {
    const mod = await import('./SubAgentEditorModal.js');
    return mod.SubAgentEditorModal;
}
