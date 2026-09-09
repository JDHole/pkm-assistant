/**
 * DetailViews - thin re-export shim.
 *
 * The actual detail-view renderers live in their owning modules. AgentSidebar
 * still imports from here so the registration call sites don't change.
 *
 * Re-exported via the modules' public barrels (index.js) instead of deep-importing
 * internal files. Both barrels expose these renderers as lazy (dynamic-import)
 * wrappers so they stay obsidian-free.
 */
export { renderSubAgentDetailView } from '../../sub-agents/index.js';
export { renderSkillDetailView } from '../../skills/index.js';
