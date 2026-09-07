/**
 * modules/chat/chatViewType.ts — chat's own door onto the canonical view-type id.
 *
 * AUD-dead-code-182: obsidian-free by design (re-export only), so `ChatView.viewType`
 * and this module's barrel can both point at ONE physical constant without pulling
 * `chat_view.ts`'s obsidian-heavy import graph into consumers that need to stay
 * node-safe (e.g. `modules/shell/sidebar/findActiveChatView.ts`,
 * `modules/artifacts/artifactSummon.ts`). The literal itself lives in
 * `core/utils/viewTypes.ts` — see that file for the full "why core, not here"
 * rationale.
 */
export { CHAT_VIEW_TYPE } from '../../core/index.js';
