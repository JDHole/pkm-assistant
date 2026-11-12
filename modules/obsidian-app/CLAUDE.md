# Obsidian app

`index.ts` exports a workspace port, validated actions, result types, executor and the opt-in settings helper. The port lists leaves and active file, checks existence and opens a path. Calls are serialized.

Results have `ok` and `success`; success also has `verified`, `effect` and `data`, failure has `error.code` and `message`. State masks inaccessible file leaves, including their titles and paths. Missing read authorization fails closed. Open checks cancellation before its effect and verifies the active file afterward.

The plugin setting defaults off and is read at startup; fresh agents also have this group disabled. Sub-agents are denied before reading workspace state: MCPClient injects the trusted invocation tool names or sub-run context only for their runs and removes model-supplied markers otherwise.

No eval, CDP, reload, palette commands or vault mutations are supported.
