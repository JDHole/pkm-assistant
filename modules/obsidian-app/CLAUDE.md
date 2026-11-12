# Obsidian app

`index.ts` exports a workspace port, validated actions, result types, executor and the opt-in settings helper. The port lists leaves and active file, checks existence and opens a path. Calls are serialized. After an open times out, subsequent opens return `busy` until the underlying operation settles; state remains available.

Results have `ok` and `success`; success also has `verified`, `effect` and `data`, failure has `error.code` and `message`. State masks inaccessible file leaves, including their titles and paths. Missing read authorization fails closed. Open checks cancellation before its effect and verifies the active file afterward.

The plugin setting defaults off and is read at startup; fresh agents also have this group disabled. Sub-agents are denied before reading workspace state: MCPClient injects the trusted invocation tool names or sub-run context only for their runs and removes model-supplied markers otherwise.

No eval, CDP, reload, palette commands or vault mutations are supported.

Disclosure requires evidence: deferred leaves, unknown view types without a file, invalid identities and per-leaf errors are restricted. File identity comes from `view.file.path` or `getViewState().state.file`; conflicting or invalid identities are restricted. A file is shown only when its path is unchanged by `sanitizePath` and read authorization allows that same path. Its title is derived from the path basename without extension, never from the view's display text. Fileless views are shown only when neither source has a file trace and the type is one of `graph`, `search`, `file-explorer`, `bookmarks`, `tag`, `empty`, `all-properties`, `pkm-assistant-chat`, `pkm-agent-sidebar`, or `pkm-release-notes-view`.

`active` identifies `workspace.getMostRecentLeaf()`. `active_path` is the path of that disclosed tab, or null. `active_file` is `workspace.getActiveFile()` after the same canonicalization and authorization checks, or null; it can remain set when chat has focus.

## Stop

Stop before `openPath` prevents the effect. Once `openPath` starts, it cannot be interrupted or undone; MCP may report Stop while the open still completes. Waiting in the queue is abortable. Each queued operation has a 5000 ms limit; timeout releases the queue for state but cannot cancel an already running port call, which may still have an effect later. Opens return `busy` until that call settles, preserving effect order.

Screenshot capture uses an injected Electron port, validated at the boundary. JPEGs are resized without upscaling to a 1568 px long edge and encoded at quality 85, retrying at 60 if needed; the byte limit is 1,500,000. Capture times out with the operation queue and never writes to disk. Before capture every leaf is checked through the state disclosure rules; restricted leaves block capture unless the adapter establishes that they are not visible (deferred or `containerEl.isShown()` returns false). Unknown visibility fails closed. Capture covers the main window; leaves in pop-out windows count as visible unless the adapter reliably establishes otherwise. The separate `app:screenshot` permission target is non-vault data and scopes approval to screenshots; approval is required even in YOLO mode.
