/**
 * findActiveChatView.ts — pure lookup for the active chat leaf's view.
 *
 * AUD-dead-code-182: split out of `TriggersView.ts` so it can be node-tested
 * without pulling in that file's `import { Notice } from 'obsidian'` — this file
 * itself touches zero Obsidian imports beyond the canonical `CHAT_VIEW_TYPE`
 * constant (`core/index.js`, guaranteed node-safe — see `core/utils/viewTypes.ts`).
 * The old bug was a SECOND local copy of that literal (`'pkm-chat'`, stale) living
 * inside `TriggersView.ts`; importing the one canonical constant here removes the
 * chance of that drift recurring.
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
