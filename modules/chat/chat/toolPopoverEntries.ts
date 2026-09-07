/**
 * Pure list-building logic for the chat "tools" popover (AUD-dead-code-205).
 *
 * `_toggleToolsPopover` (chat_popovers.ts) used to build the popover list from
 * `Object.keys(TOOL_INFO)` — a map of icons/labels kept for rendering OLD chat history
 * (it deliberately carries dead names like `minion_task`, `connect_to_server`: E2.4/S28/E3.1
 * killed the tools, but old transcripts still reference them by name and need a label).
 * Using that map as the SOURCE of "what can I call right now" meant the popover offered
 * six tool names the registry doesn't know, and hid six real ones (`todo`, `artifact_*`,
 * `add_text_to_image`) that simply never got a TOOL_INFO entry.
 *
 * `buildToolPopoverEntries` takes the list of names straight from `ToolRegistry` (the LIVE
 * registry — `getAllToolNames()`, in registration order), filters `disabled_tools` the same
 * way `_toggleToolsPopover` always has (a plain Set), and only consults `toolInfo` for
 * icon/label. A registry name with no `toolInfo` entry (new built-in without a TOOL_INFO
 * entry yet, or an external MCP tool) still gets a popover row — with a fallback label
 * (its own name) and no icon (caller paints a default one).
 */

/** Shape `buildToolPopoverEntries` needs from a TOOL_INFO-style catalog entry. */
export interface ToolPopoverIconLabel {
    icon?: () => string;
    label: string;
}

/** One row the popover renders. `icon` is absent when the caller should use a default. */
export interface ToolPopoverEntry {
    name: string;
    label: string;
    icon?: () => string;
}

/**
 * @param registryNames - tool names from `ToolRegistry.getAllToolNames()` (registry order).
 * @param disabledTools - `agent.disabled_tools`, or a falsy/non-array value (treated as empty).
 * @param toolInfo - icon/label catalog (TOOL_INFO). NOT the source of the list — only consulted
 *   per name that already survived the registry+disabled filter.
 */
export function buildToolPopoverEntries(
    registryNames: readonly string[],
    disabledTools: unknown,
    toolInfo: Record<string, ToolPopoverIconLabel>,
): ToolPopoverEntry[] {
    const disabled = new Set(Array.isArray(disabledTools) ? disabledTools : []);
    const entries: ToolPopoverEntry[] = [];
    for (const name of registryNames) {
        if (disabled.has(name)) continue;
        const info = toolInfo[name];
        entries.push(info ? { name, label: info.label, icon: info.icon } : { name, label: name });
    }
    return entries;
}
