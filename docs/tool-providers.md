# Tool providers API v1

Installed Obsidian plugins can register local agent tools on desktop and Android.
No MCP server, Node API, vault script loader or sandbox is involved. Providers
supply functions already loaded by Obsidian and retain normal plugin privileges.
PKM Assistant gates calls initiated by its agents, not the provider's own activity.

Read `app.plugins.plugins['pkm-assistant']?.api`. It is `undefined` until ready and
after unload. Check at your startup **and** subscribe to the workspace event
`pkm-assistant:api-ready` (argument: API), including after PKM Assistant reloads.
Check `apiVersion === 1`. The event fires after the tool registry and plugin are
ready. Do not depend on internal registries. Types are maintained in
[`ToolProviderRegistry.ts`](../modules/tools/ToolProviderRegistry.ts) and exported
by the tools module's `index.ts`.

```ts
interface PkmAssistantPublicApi {
  apiVersion: 1;
  registerToolProvider(provider: ToolProviderRegistration): ToolProviderHandle;
}
interface ToolProviderRegistration {
  id: string;            // ^[a-z][a-z0-9_]{1,31}$; unique
  name: string;          // 1–60 characters
  description?: string; // at most 300 characters
  tools: ProviderTool[]; // 0–64
}
interface ProviderTool {
  name: string;          // ^[a-z][a-z0-9_]{1,47}$; unique within provider
  description: string;   // 1–2000 characters, for the model
  inputSchema: Record<string, unknown>; // JSON Schema with type: 'object'
  timeoutMs?: number;    // integer 1000–120000; default 30000
  execute(args: Record<string, unknown>, context: ProviderToolContext): Promise<unknown>;
}
interface ProviderToolContext {
  agentName: string | null;
  isMobile: boolean;
  signal: AbortSignal;
}
interface ToolProviderHandle {
  setTools(tools: ProviderTool[]): void;
  unregister(): void;
}
```

IDs/names must match in full (no trailing newline). Lengths use JavaScript string
units. Schemas must be JSON data and are snapshotted on registration. Describe and
validate arguments in your provider, just as an MCP server does. Localize your own
labels/descriptions; PKM Assistant does not translate third-party text.

The model sees `<providerId>__<toolName>` and `[provider name] description`.
Registration and `setTools` validate the entire list before publishing it. Invalid
registrations throw readable `Error`s without partial changes. `setTools` replaces
the list atomically, including an empty list. Already executing calls may finish
with their original implementation; calls waiting for approval cannot start a
removed/replaced implementation.

Built-in server IDs and configured MCP IDs (including disabled servers) are
reserved. A live provider blocks MCP connections added later under its ID,
including a handshake in progress. Existing prefixed names cannot be overwritten,
even when IDs/names contain `__`. The settings editor/import refuses provider IDs.
If settings are changed outside that UI, the provider keeps ownership until
unregister/unload. On next startup saved MCP configuration reserves the ID first.
Choose a stable, distinct ID: opt-in and persistent approvals identify ID/tool
name, not the identity of the plugin supplying the function.

Users enable providers in profile → Skills → Connectors (`mcp_servers`, including
existing wildcard semantics). The same ToolRegistry/MCPClient permissions, RED
risk, approval and output budgets apply as for MCP. The modal shows complete
cleaned JSON arguments; “Always allow” is per agent and specific
`external.call::<id>__<tool>` rule. Existing `yolo` autonomy suppresses questions;
opt-in remains mandatory. Sub-agents additionally need the inherited tool
whitelist. External tools are unavailable in draft execution, exactly as MCP is.

Context has **only** `agentName`, `isMobile`, and `signal`. `agentName` is the calling
agent profile, including the owning profile used by a sub-agent, not a thread/run
ID. No host, permission callback, budget, session or conversation context is
passed. Internal argument markers are stripped with the shared MCP filter.

Return JSON data. Cycles, BigInt, undefined, functions, symbols and non-finite
numbers produce errors, including nested unsupported values. Arrays are JSON
text, not multimodal blocks. Exceptions become model errors with the message
passed through the shared secret mask, without stacks. The normal agent loop
serializes and budgets results. Do not return secrets: pattern-based masking
cannot detect all sensitive content.

Timeout races execution, aborts `signal`, and returns a model error naming the
limit. Stop, unregister and PKM Assistant unload also abort pending calls and
release the waiter. Cancellation is cooperative: code ignoring `signal` may keep
running with side effects. Synchronous blocking in this shared process can block
Obsidian and delay timers; this API cannot forcibly stop it. Unload removes all
providers; old handles' methods are harmless no-ops and old API objects cannot
register into a replacement instance. Registrations are not persisted.

## Minimal JavaScript plugin

This is the entry point of an **installed Obsidian plugin**, not a vault script.
It uses only Obsidian/browser APIs and also works on Android.

```js
const { Plugin } = require('obsidian');

module.exports = class LocalCountPlugin extends Plugin {
  onload() {
    const app = this.app;
    const connect = api => {
      if (api?.apiVersion !== 1 || api === this.connectedApi) return;
      this.handle?.unregister();
      this.handle = api.registerToolProvider({
        id: 'local_count',
        name: 'Local note counter',
        tools: [{
          name: 'count_notes',
          description: 'Count Markdown notes indexed by this Obsidian instance.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          async execute(_args, context) {
            if (context.signal.aborted) throw new Error('Cancelled');
            return { count: app.vault.getMarkdownFiles().length };
          },
        }],
      });
      this.connectedApi = api;
    };
    this.registerEvent(app.workspace.on('pkm-assistant:api-ready', connect));
    connect(app.plugins.plugins['pkm-assistant']?.api);
  }
  onunload() {
    this.handle?.unregister();
  }
};
```

Settings → MCP servers shows a read-only provider with name, ID and tool count.
Pin `local_count` to the agent before using `local_count__count_notes`.
Registration alone never enables tools for an agent.
