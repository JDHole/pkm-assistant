# PKM Assistant 2.3.0

**Chat without walls of text** - PKM Assistant 2.3.0

**In plain words.** The chat has a new face, built around one rule: no walls of text. Everything
the agent does on the way to an answer - thinking, reading a note, searching, handing a task to
a sub-agent, keeping a task list, asking you a question, running into an error - is now a small
tile with a human title and a status dot, and the details open only when you click. Nothing
technical sits in a tile header: no call ids, no raw tool names, no JSON. Three colours tell
you who is speaking: system things are red, the agent's things are in the agent's colour, and
your own messages are in your colour from Settings. The agent's replies sit in a column with
the agent's crystal next to every tile and every bubble, joined by a thin line, so a long turn
reads like a timeline instead of a pile. Any note the agent mentions is a link that opens in a
new tab. You can finally select and copy text from any message, and a small menu on the
selection offers Copy, Add as context and Quote. Typing `/` opens commands, skills, sub-agents
and the tools of your MCP servers; typing `@` opens note suggestions only - one popup at a time,
and Enter in the popup picks an item instead of sending the message. The typing indicator's
dots light up one after another, a queued message stays visible while the task list is open,
and the "hand over to another agent" button is retired for now.

What changed, in detail:

- **One tile for every action.** Thinking, tool calls, sub-agent results, the task list, a
  question from a past session, a stream error, a background sub-agent notification and an
  artifact card all use the same tile: icon, human title, short summary, status dot, details on
  click. Failure is one standard: a red icon on the left and a red dot on the right. Reads,
  searches and the task list use a dimmed variant of the agent's colour.
- **Bubbles.** Your message spans the full width in your colour from Settings (falls back to the
  theme accent), with a gutter on the right that mirrors the agent's crystal gutter on the left.
  The agent's reply is a bubble in the agent's colour; the agent's name is gone from the header,
  the crystal stays. The context-trim block keeps its previous look.
- **Agent column with crystals.** The agent's crystal is drawn next to every tile and every text
  bubble (also next to a live question to you), and the connector line runs from the first
  crystal to the last one in a series. The line is redrawn when a tile is expanded or collapsed,
  when the first text of a reply arrives, when a thinking block folds after a tool round, and
  when a tile is replaced by its result.
- **Clickable notes everywhere.** Note names in read, search and list tiles, in the note-saved
  line, in mentions and on the artifact card open the note in a new tab of the main area. Hidden
  plugin paths are shown as plain text, not links.
- **Select, copy, quote.** Text in bubbles and tiles can be selected. On a selection a menu
  offers Copy, Add as context (a text attachment in the chip bar, kept in memory only) and Quote
  (inserted into the input as a quote, with the caret placed after it).
- **Triggers.** `/` opens the trigger popup: slash commands, skills, sub-agents and the tools of
  external MCP servers, each tool with its full name so the marker points at a real tool. `@`
  opens note and folder suggestions only. `/` followed by `@` hands the field over to the note
  suggestions. Enter inside the popup picks the item; it no longer also sends the message.
- **Small things.** Typing-indicator dots appear in sequence; a queued message is shown above the
  chip bar even when the task-list panel takes the input slot; the delegation-to-another-agent
  tool and its button are dormant (the code stays for a later release).
