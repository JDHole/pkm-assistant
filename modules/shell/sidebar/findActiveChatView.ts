/**
 * findActiveChatView.ts - pure lookup for the active chat leaf's view.
 *
 * Split out of `TriggersView.ts` so it can be node-tested without pulling in that
 * file's `import { Notice } from 'obsidian'` - this file itself touches zero
 * Obsidian imports beyond the canonical `CHAT_VIEW_TYPE` constant (`core/index.js`,
 * guaranteed node-safe - see `core/utils/viewTypes.ts`). Importing the one canonical
 * constant here (instead of a local copy of the literal `'pkm-chat'`) removes the
 * chance of the two copies drifting apart.
 */

import { CHAT_VIEW_TYPE } from '../../../core/index.js';

// TS-any: workspace/leaf/view objects are Obsidian runtime shapes not modelled here.
type Runtime = any;

export function findActiveChatView(plugin: Runtime): Runtime {
    const workspace = plugin?.app?.workspace;
    if (!workspace?.getLeavesOfType) return null;
    const leaves = workspace.getLeavesOfType(CHAT_VIEW_TYPE) || [];
    if (!leaves.length) return null;
    // Prefer most recently active leaf; fallback to first
    const active = leaves.find((l: Runtime) => l === workspace.activeLeaf) || leaves[0];
    return active?.view || null;
}
