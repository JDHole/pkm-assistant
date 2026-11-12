# Obsidian app

`index.ts` exports a workspace port, validated actions, result types, executor and the opt-in settings helper. The port lists leaves and active file, checks existence and opens a path. Calls are serialized.

Results have `ok` and `success`; success also has `verified`, `effect` and `data`, failure has `error.code` and `message`. State masks inaccessible file leaves, including their titles and paths. Missing read authorization fails closed. Open checks cancellation before its effect and verifies the active file afterward.

The plugin setting defaults off and is read at startup; fresh agents also have this group disabled. Sub-agents are denied before reading workspace state: MCPClient injects the trusted invocation tool names or sub-run context only for their runs and removes model-supplied markers otherwise.

No eval, CDP, reload, palette commands or vault mutations are supported.

State identifies a file by `view.file.path`, falling back to `getViewState().state.file`. Invalid identities and per-leaf read errors are restricted. A file is shown only when its path is unchanged by `sanitizePath` and read authorization allows that same path; `active_path` comes from the visible active tab.

## Stop

Stop before `openPath` prevents the effect. Once `openPath` starts, it cannot be interrupted or undone; MCP may report Stop while the open still completes. Waiting in the queue is abortable. Each queued operation has a 5000 ms limit; timeout releases the queue but cannot cancel an already running port call, which may still have an effect later.
