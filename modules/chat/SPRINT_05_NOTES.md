# Sprint 05 Notes

- Added `chat/InlineChipPlugin.js` with parser/helpers for `@@skill:`, `@sub-agent:`, and `@@tool:` markers.
- Slim bar now has trigger sections for sub-agents, skills, and MCP servers. Clicks insert markers into the textarea.
- Chat send preprocessing injects per-message force-trigger instructions for matching markers.
- Tool history can render compact expandable chips, controlled by `obsek.compactToolChips`.
