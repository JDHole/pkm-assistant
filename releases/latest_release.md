# PKM Assistant 2.3.2

**Reads to the end, turns that never hang** - PKM Assistant 2.3.2

**In plain words.** Agents can now read a long note or file all the way to the end instead of
stopping after the first part, and they can search code and data files for exact text. When a
model goes quiet, runs out of tool rounds or fails to write its summary, the turn now ends within
seconds with an honest note of what was done, instead of waiting for many minutes and then
showing nothing. Sub-agents working in the background no longer interfere with your chat: stopping
one sub-agent no longer cuts off the chat or another sub-agent, and a sub-agent that finished
correctly is no longer shown in error red. Nothing changes in how you set up or use the plugin.

What changed, in detail:

- **Reading long files.** `read` returns long documents page by page with the position of the next
  page, and the agent continues from there; the page is tied to the exact version of the file, so a
  file that changed in the meantime is read again from the start. Sub-agents read the same way.
- **Literal text search.** `search` with `mode: "text"` scans `.js`, `.json` and `.md` files in a
  folder (with a pattern) or one exact file, checks access for every file and says whether the scan
  was complete, partial or stopped. Files the agent may read are no longer refused by mistake.
- **Turns that end honestly.** Silence from the model, the tool-round limit, an exhausted summary
  budget or Stop end the turn with a partial result: which tools ran, what they returned and why the
  turn stopped (both causes when the tool rounds ran out and then the summary budget did too). A
  tool result whose effect is uncertain ends the turn instead of repeating the action.
- **Readable partial results.** The "tool responses are recorded below" line appears only when there
  are tool results; JSON results are shown with line breaks and a visible clipping mark.
- **Background sub-agents.** A sub-agent whose role has no model of its own gets its own instance of
  the main model instead of borrowing the chat's, so Stop or a timeout of one sub-agent stops only
  that sub-agent. A successful background sub-agent tile uses the success colour.
- **Memory.** A summary or consolidation stream that goes silent is reported as stalled, never as a
  success.
- **Cleanups.** Two settings fields that never did anything (`preferred_tools`, `permissions.mcp`)
  are gone; older agent profiles that still contain them load as before.
- **Releases.** Every release is checked against a fixed version of the test harness, and a
  published release can no longer have its files replaced: a fix always ships as a new version.
