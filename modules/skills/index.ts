/**
 * modules/skills — Public API barrel
 *
 * Skill engine v2: SkillLoader (CRUD + cache + starter skills) + SkillVariables ({{placeholders}}).
 * Patrz CLAUDE.md tego modułu dla decyzji architektonicznych.
 *
 * `SKILL_TEMPLATES_PATH`, `parseSkillMarkdown` i `serializeSkillFile` NIE są
 * eksportowane — zero konsumentów spoza modułu (format `SKILL.md`
 * czytają `SkillLoader` i `SkillTemplateStore` u siebie, a ścieżkę magazynu zna
 * store). Definicje żyją w bebechach; testy deep-importują pliki wprost.
 *
 * `extractVariables` (SkillVariables.ts) nie istnieje: w odróżnieniu od trójki wyżej nie miała
 * żadnego wołacza, nawet wewnątrz modułu (podstawianie robi wyłącznie `substituteVariables`).
 */

export { SkillLoader } from './SkillLoader.js';
export { substituteVariables } from './SkillVariables.js';
export { registerBackstage } from './BackstageTab.js';
// Magazyn szablonów skilli (Zaplecze) — owner: AgentManager.skillTemplateStore.
export { SkillTemplateStore } from './SkillTemplateStore.js';
export type { SkillData, SkillInput, SkillQuestion, VaultLike } from './types.js';

// SkillDetailView.js statically imports `obsidian` (MarkdownRenderer). Lazy-load it via
// dynamic import so this barrel stays obsidian-free — it is imported by chat_ui / AgentManager,
// whose AVA tests cannot resolve `obsidian`. SidebarNav invokes route renderers fire-and-forget.
// TS-any: lazy module preserves the historical dynamic UI call contract.
export async function renderSkillDetailView(...args: any[]) {
    const mod = await import('./SkillDetailView.js');
    return mod.renderSkillDetailView(...args as [any, any, any, any]);
}

// `SkillEditorModal` żyje tu, nie w `modules/shell/` (edytor skilla = sprawa skilli).
// Też statycznie importuje `obsidian`, więc z tego samego powodu co wyżej NIE wchodzi do barrela
// zwykłym re-eksportem — konsument spoza modułu (profil agenta) bierze klasę tym leniwym
// akcesorem, w handlerze kliknięcia.
export async function loadSkillEditorModal() {
    const mod = await import('./SkillEditorModal.js');
    return mod.SkillEditorModal;
}
