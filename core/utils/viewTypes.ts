/**
 * Canonical Obsidian view-type identifiers shared across modules.
 *
 * AUD-dead-code-182: `modules/shell/sidebar/TriggersView.ts` carried its own stale
 * copy of the chat view-type string (`'pkm-chat'`), so `findActiveChatView` never
 * matched the real leaf — Obsidian registers `ChatView` under `'pkm-assistant-chat'`
 * (`modules/chat/chat_view.ts` `static get viewType()`), and view-type lookup is an
 * exact string match (`modules/ui-components/PluginItemView.ts` `registerView`/
 * `getViewType`). `modules/shell/sidebar/HomeView.ts` carried a second stale copy;
 * `modules/artifacts/artifactSummon.ts` and `src/main.ts` had independent (correct,
 * but still duplicated) copies of the right value. This file is the ONE physical
 * source of truth — the literal string appears here and nowhere else.
 *
 * Lives in `core/`, not `modules/chat/`, because `modules/chat/index.ts` is NOT
 * node-safe: its barrel re-exports `ChatView` from `chat_view.ts`, which statically
 * pulls in `chat/chat_streaming.ts` (`import { MarkdownRenderer, Notice } from
 * 'obsidian'`, see `modules/chat/CLAUDE.md` Gotchas). `modules/artifacts/
 * artifactSummon.ts` is explicitly documented to stay `obsidian`-free so its tests
 * run in bare Node, and `modules/shell/sidebar/findActiveChatView.ts` needs the same
 * — a static import of the chat barrel from either module would drag `obsidian` into
 * that graph and crash their AVA tests (no `obsidian` mock — see `core/index.ts`'s
 * node-safety contract). `core/index.ts` is guaranteed node-safe, so this is the
 * smallest safe home for a value ≥3 modules need (ADR 003: cross-module, infra, rare
 * change → core/).
 *
 * `modules/chat/chatViewType.ts` re-exports this constant as chat's own module-local
 * door onto it, so `ChatView.viewType` and `modules/chat/index.ts` don't reach into
 * `core/` by name; every other consumer imports it straight from `core/index.js`.
 *
 * ⚠️ Changing this string orphans users' saved Obsidian workspace layouts (the view
 * type is persisted per leaf on disk) — treat it as a stable, load-bearing id, not a
 * cosmetic rename.
 */
export const CHAT_VIEW_TYPE = 'pkm-assistant-chat';
