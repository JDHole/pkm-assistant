/**
 * DetailViews — thin re-export shim.
 *
 * Sprint 10 Z6 (2026-05-02 hotfix): the actual detail-view renderers were
 * moved to their owning modules. AgentSidebar still imports from here so
 * the registration call sites don't change.
 *
 * E1.6 C1 (2026-07-21): re-export via the modules' public barrels (index.js)
 * instead of deep-importing internal files. Both barrels expose these renderers
 * as lazy (dynamic-import) wrappers so they stay obsidian-free.
 */
export { renderSubAgentDetailView } from '../../sub-agents/index.js';
export { renderSkillDetailView } from '../../skills/index.js';
