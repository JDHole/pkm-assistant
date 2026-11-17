# Obsidian app

`index.ts` exports a workspace port, validated actions, result types, executor and the opt-in settings helper. The port lists leaves and active file, checks existence and opens a path. Calls are serialized. After an open times out, subsequent opens return `busy` until the underlying operation settles; state remains available.

Results have `ok` and `success`; success also has `verified`, `effect` and either `data` or `kind: media`, `summary` and `images`, failure has `error.code` and `message`. State masks inaccessible file leaves, including their titles and paths. Missing read authorization fails closed. Open checks cancellation before its effect and verifies the active file afterward.

The plugin setting defaults off and is read at startup; fresh agents also have this group disabled. Sub-agents are denied before reading workspace state: MCPClient injects the trusted invocation tool names or sub-run context only for their runs and removes model-supplied markers otherwise.

No eval, CDP, reload, palette commands or vault mutations are supported.

Disclosure requires evidence: deferred leaves, unknown view types without a file, invalid identities and per-leaf errors are restricted. File identity comes from `view.file.path` or `getViewState().state.file`; conflicting or invalid identities are restricted. A file is shown only when its path is unchanged by `sanitizePath` and read authorization allows that same path. Its title is derived from the path basename without extension, never from the view's display text. Fileless views are shown only when neither source has a file trace and the type is one of `graph`, `search`, `file-explorer`, `bookmarks`, `tag`, `empty`, `all-properties`, `pkm-assistant-chat`, `pkm-agent-sidebar`, or `pkm-release-notes-view`.

`active` identifies `workspace.getMostRecentLeaf()`. `active_path` is the path of that disclosed tab, or null. `active_file` is `workspace.getActiveFile()` after the same canonicalization and authorization checks, or null; it can remain set when chat has focus.

## Stop

Stop before `openPath` prevents the effect. Once `openPath` starts, it cannot be interrupted or undone; MCP may report Stop while the open still completes. Waiting in the queue is abortable. Each queued operation has a 5000 ms limit; timeout releases the queue for state but cannot cancel an already running port call, which may still have an effect later. Opens return `busy` until that call settles, preserving effect order.

When explicitly enabled for tests, screenshot capture uses a positive disclosure rule for the active main leaf's `contentEl`: only authorized canonical files in `markdown`, `pdf` and `image` views qualify. Other views and uncertainty fail closed. CSS bounds are clipped to the document viewport (`window.innerWidth`/`innerHeight`), then the Electron port multiplies them by its validated positive finite zoom factor and rounds inward in DIP; device pixel ratio is not applied. Missing or invalid zoom makes capture unavailable.

Only top-level embeds with a resolvable, authorized canonical path are allowed. Nested embeds and unresolved embeds block capture. Renderers are denied by default, including `block-language-*`, query, Live Preview renderer and Dataview elements. The static renderer allowlist is empty; add a renderer only after evidence that it cannot disclose other content. Ordinary highlighted `pre > code` is allowed. Any document overlay matching menu, modal, popover, suggestion, tooltip or prompt selectors blocks capture by presence. Embedded backlinks block when rendered and nonempty (result elements or nonzero height); invalid style or geometry fails closed. Notes with nested embeds or renderer blocks therefore cannot be captured.

When enabled, a sub-agent screenshot can still show an approval modal before the tool denies the call; the capture port is not invoked.
The injected Electron port validates the rectangle. JPEGs are resized without upscaling to a 1568 px long edge and encoded at quality 85, retrying at 60 if needed; the byte limit is 1,500,000. No image is written to disk. Only one native capture can remain pending; subsequent screenshots return `busy` until it settles, including after timeout or Stop, and a late frame is discarded before encoding. State remains available. The separate `app:screenshot` permission target scopes approval to screenshots; each screenshot requires a fresh approval even in YOLO mode and cannot be permanently approved.

## Zrzut: wyłączony

Production leaves `screenshot` disabled and excludes it from the tool schema and description. Raw HTML `<img>` and `<iframe>` can bypass embed checks, and an embedded `.base` can show results about other files. Enabling requires a separate card implementing a positive DOM-node allowlist: only known static text and formatting nodes and verified embeds; `img`, `iframe`, `video`, `object`, `embed`, `canvas`, `svg` with references, `.bases-embed`, `.cm-html-embed`, and every unknown element must be refused.

The existing implementation already covers view selection, overlays, zoom, busy/timeout/Stop, and one-time approval; tests enable it explicitly. Disabled requests are rejected before MCP approval and before workspace or capture ports are touched.

## render_check

`render_check` opens an authorized canonical Markdown path in the existing queue, requests preview and observes rendered block DOM until 500 ms of quiet or `wait_ms` (1–15000, default 4000). Its operation timeout adds the wait budget to the existing 5000 ms; other actions retain their limits. Stop and dispose cancel observation and restore listeners and `console.error`; a pending host open cannot be undone. Identity is checked before and after observation; uncertainty fails closed.

All main agents with read access receive only block number, language and rendered/empty/error/timeout, count, elapsed time, stabilization and mode. Only an agent with trusted `admin_access === true` receives masked, bounded block text, DOM error messages and unassigned global errors with truncation flags. Renderers and error stacks can contain data from other vault files, which is why read access to the note alone is insufficient. `rendered` means nonempty without a DOM error, not correctness; quiet is a heuristic. Screenshot remains disabled. Physical phone checks remain necessary for actual Dataview DOM, preview switching, timing, delayed asynchronous rendering and Stop/unload behavior on device.
