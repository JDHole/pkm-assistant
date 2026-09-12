# Changelog

All notable user-facing changes to PKM Assistant are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## 2.2.3 - 2026-09-12

A maintenance release prepared for the community catalogue review. The sources pass the
catalogue's static checks without warnings; behaviour matches 2.2.2 apart from the fixes below.

### Fixed

- **Manual notes in the "Current" section of an agent's brain file survive memory saves.**
  Previously every memory save rebuilt the file and dropped what you had written there.
- **Custom configuration folders are respected.** Access rules and the plugin folder
  migration use the configuration folder Obsidian reports instead of assuming `.obsidian`.
- **The log file keeps the full details of a failed model request** (error code, HTTP status,
  provider details), not only the message.

### Changed

- Sidebar and chat crystal animations use transforms instead of clip paths; same shapes,
  rendered on every Obsidian build.
- Less console output: only debug, warning and error messages are logged.

Upgrade notes: no migration. Settings and agent files are untouched.

## 2.2.2 - 2026-09-09

A source-hygiene release before the community catalogue listing. No functional changes
apart from the renamed backup file listed below.

### Changed

- **Source comments and developer documentation describe the current behaviour only.**
  Internal audit and sprint identifiers, dates and references to planning documents that
  never lived in this repository are gone; the reasoning behind each decision stays.
- **Changelog and release notes are in English** and list only what a user can notice.
- **The settings backup written before the first save after an upgrade is now
  `.pkm-assistant/settings.pre-migration.json`.** An older backup under the previous name,
  if present, is left untouched.
- A few interface texts and one on-disk marker file lost stray internal references.

Upgrade notes: no migration. Settings and agent files are untouched.

## 2.2.1 - 2026-09-07

A housekeeping release for the Obsidian community plugin catalogue. No new features: the
plugin does exactly what 2.2.0 does, but it follows the catalogue policies, ships fewer
dependencies and is built and signed by CI.

### Changed

- **Releases are built by GitHub Actions.** The release files (`main.js`, `manifest.json`,
  `styles.css`) are built on GitHub from exactly the tagged commit and signed with a build
  provenance attestation, so anyone can verify that the download matches the sources. A
  release now contains only those three files.
- **Fewer dependencies.** YAML is read and written with Obsidian's built-in functions
  instead of a bundled library, several development packages were dropped, and three known
  vulnerabilities in the MCP SDK server dependencies were closed.
- **Internal tidy-up with no change in behaviour.** Timers and window access go through a
  single place, promises are no longer left unhandled, and unused variables are gone.
- **The README now describes what the plugin does outside your vault:** which services it
  talks to, when it starts a local process, the single file it reads outside the vault, and
  when it touches the clipboard.

### Removed

- **Unused code that could disable and re-enable the plugin from inside itself.** Obsidian's
  plugin policies forbid this outright. A permanent test now guards against it coming back,
  together with a ban on `eval` / `new Function` and on reaching for `globalThis`.

Upgrade notes: no migration. Settings and agent files are untouched.

## 2.2.0 - 2026-09-06

The plugin is now called PKM Assistant everywhere (`pkm-assistant`), it stopped promising
things it did not do, and it lost a third of its weight.

### Added

- **External MCP server client on the real protocol** (stdio and HTTP), replacing the old
  runner that executed custom JavaScript from the vault. In Settings: a preview of the
  server's tool list *before* you save the configuration, an on/off switch per server,
  ready-made presets for five popular servers (filesystem, github, memory, fetch, blender),
  an *Import from Claude Desktop* window that reads existing server definitions, and a
  readable message on a 401 response instead of an opaque failure.
- **Agent mail v3.** Every message is its own file in the mailbox, with three simple actions
  (send / list / read), the option to hide an agent from the mail system, cleanup of read
  messages one by one or in bulk, and a global switch in Settings -> Advanced (on by default).
- **Deep Research.** Two skill templates that build an in-depth research report; the result
  is saved as a new "report" document type in your vault.
- **Sub-agent runs panel.** A sidebar tab (plus a Home tile with a counter) showing running,
  pending and finished sub-agent jobs, with expandable steps and a Stop button for each. You
  can send a running sub-agent an extra message while it works.
- **Three new tabs in the agent backstage:** Skills, Sub-agents and Connectors - a store for
  your own skill templates and sub-agents, including a global sub-agent for delegated tasks.
- **Memory pulse** - a window showing live progress of memory consolidation, plus a refreshed
  indicator for archived sessions.
- **Stronger web search:** summarising fetched pages with a cheaper model while keeping
  verbatim source quotes, daily and monthly search usage counters, an allowed/blocked domain
  filter, and PDF support when reading pages.
- **New windows in the agent profile:** a persona starter-prompt generator (role, tone and
  rules, live preview, result inserted into the Personality field), a *Brain entry log* card
  with the last 50 real changes to durable memory, and a panel of active sessions with quick
  access to the conversation file.
- **Retention for the memory session archive** - a number of days and a maximum number of
  files (no limit by default). Sessions not yet covered by a summary are never deleted,
  whatever the settings say.
- **Generate artifact Bases view command** - creates a `.base` file with ready-made table
  views (All / Open) for the artifacts folder, using Obsidian's native Bases feature.
- **A holding area for rescued memory.** Fragments cut out when a conversation is compacted
  land in a durable holding area and are offered for review in the session save window
  instead of disappearing for good.
- **A global timeout for a single model call in chat** (Settings -> Limits, can be turned
  off) as a last line of defence against a conversation that hangs forever.
- **Artifact types assigned to an agent are enforced** when a new artifact is created:
  creating a disallowed type fails with a readable refusal instead of being silently ignored.

### Changed

- **The core layer was rebuilt from scratch.** HTTP and streaming transport (fetch with
  SSE/NDJSON, no more XMLHttpRequest), the plugin runtime (start-up, hardened settings,
  notices, status bar), nine chat model providers and four embedding providers were written
  from the ground up against written-down behaviours and tests. Settings keys inherited from
  the earlier code base are rewritten automatically to the plugin's own keys
  (`pkmAssistant.chat.*`, `pkmAssistant.embedding.*`, `pkmAssistant.notices.*`): platform,
  models, hosts, API keys and the embedding model all carry over at start-up, and a backup
  copy of the previous settings file is written before the first save in the new shape. Dead
  keys from years back are deleted.
- **The plugin identifier and name are now `pkm-assistant`** across the plugin folder,
  settings, logs and CSS classes. Data, API keys and settings migrate automatically on first
  start - see Upgrade notes below.
- **Settings live in your vault** at `.pkm-assistant/settings.json`.
- **Command names in the palette no longer repeat the plugin name** (Open chat, Random note,
  Open agent panel, Self-test, Generate artifact Bases view). Obsidian adds the plugin name
  itself. Hotkeys keep working, because the command ids did not change.
- **The minimum required Obsidian version is now 1.11.0** (previously declared as 1.2.3 even
  though the plugin already used newer API) - an honest declaration instead of a silent risk
  on older versions.
- **One name for the helper:** it is *Sub-agent* everywhere in the interface.
- **Delegating a task to a sub-agent always runs in the background.** The chat gets an
  immediate confirmation instead of freezing until the run ends, and the result comes back as
  an automatic turn once it is ready. The default budget of consecutive automatic turns after
  sub-agent tasks went up from 5 to 10, so sending out several tasks at once no longer
  exhausts it immediately.
- **Higher sub-agent limits so work is not cut in half:** prompt budget, delegation context,
  iteration count (worker 12 to 25), total run time (up to 900 s), time to write the final
  summary (45 s to 120 s) and result length (15k to 60k characters, configurable, can be
  switched off). All of it in Settings -> Limits.
- **Two built-in sub-agent profiles** in the delegation tool: a fast, cheap *explorer*
  (read-only) and a *worker* (full permissions and a model in the main agent's class). Your
  own sub-agent with the same name takes precedence.
- **A tool step in the sub-agent run view shows the concrete detail** (which file, which
  query), and expanding a row reveals the delegated task and a frame with the result (errors
  in red) - no more "something is happening but you cannot tell what".
- **One mechanism for the Thinking block** across LM Studio, Groq, custom OpenAI-compatible
  endpoints and OpenRouter.
- **The bottom bar of the chat holds two views in one place:** the input field and the agent's
  task list. It switches automatically as the list appears or disappears, the switch shows a
  counter of completed tasks, and the bar reserves exactly as much room as it needs, so it
  stops covering message content.
- **Clicking an artifact row no longer sends a state snapshot to the agent.** It pins the
  artifact and opens the note in a new tab. Sending the state by hand still works from the
  button in the note or the refresh icon on the chip.
- **Agent memory session files are versioned in the vault's git repository again**, so they
  travel between machines. Any secrets in session content are masked at write time.
- **Internal cleanup with no change in behaviour:** the whole source moved to TypeScript in
  strict mode, imports between modules were untangled, dead code and unused CSS rules were
  removed, inline styles became CSS classes, and the translation files were tidied (unused
  keys removed, missing ones translated).

### Fixed

- **The microphone (speech to text) sees your Groq / OpenAI / Gemini key again.** After
  entering a key in Settings, recording ended with "No API key", because the microphone
  button looked in an old location instead of the same key pool the chat uses. The
  missing-key message now tells you to enter it in Settings instead of quoting an internal
  field name.
- **No more false "a new version is available".** The version comparison that announced an
  update on every start was fixed, and then the whole GitHub update check was removed - see
  Removed.
- **Conversations no longer hang forever.** A turn that froze because the model stopped
  responding mid-generation is fixed, a sub-agent stuck on a dead stream has its own silence
  watchdog (not confused with a model that is simply slow), and opening a new chat session no
  longer kills a running conversation in another tab.
- **Stop really interrupts generation**, including while a tool is running and when the chat
  panel is closed. An interrupted turn could previously come back to life or finish anyway.
- **The final agent message refreshes correctly** once the answer ends: no visible rollback of
  the Thinking block and no leftover hallucinated tool markers.
- **Thinking is back where it was missing:** Ollama (qwen3, deepseek-r1) lost the model's
  internal reasoning, and the `<think>` marker parser in LM Studio and Ollama deleted the rest
  of the answer when the marker was truncated at the end.
- **DeepSeek no longer truncates its own answer** on a fragment of content that looks like an
  end-of-stream marker. A rare collision of tool call identifiers (several calls in the same
  millisecond) was fixed too.
- **Active memory sessions stopped disappearing.** Closing the chat tab waits for the write to
  finish, autosave appends only the missing tail instead of overwriting the whole file
  (previously, after the context window was compacted, it could permanently cut the history
  down to the summary alone), and crash recovery reads the new file format correctly.
- **The memory archive tells the truth:** corrected session save date, restored summary status
  badge, a consolidation counter that no longer shows a false threshold for an archive smaller
  than one batch, and the save-session command no longer leaves an invalid session path
  attached to the tab.
- **Memory consolidation respects your manual edits.** Sections you added by hand to
  `brain.md` stopped vanishing on save (they stay in the file, moved below the generated
  content), your edits survive consolidation, the progress window leaves nothing behind when
  closed, an "in progress" state is recognised as a still-running pass, and Cancel simply
  stops the operation instead of pretending the stream hung. The emergency memory dump now
  writes the real note content instead of an empty file.
- **The memory migrator from format v2 to v3 was rewritten:** it counts every section and
  every paragraph of the old file (no more sentences cut in half or fragments lost), notes
  with colliding names get a unique suffix instead of overwriting an existing file, and Cancel
  in the migration window really cancels.
- **Settings and API keys survive degraded disk reads.** The plugin will not overwrite the
  settings backup with corrupted content (which used to cost you settings and keys on
  restart), and start-up will not write defaults over your file. Reads of memory and session
  files on cloud-synchronised drives are no longer mistaken for "file does not exist".
- **Agent profile permissions finally work.** The four switches (reading and editing notes,
  creating and deleting files) were saved but never checked. The Safe / Standard / Full
  presets no longer change the "assigned folders only" mode, where picking *Full* could
  paradoxically narrow the agent down to a folder whitelist.
- **Artifacts keep their structure.** A model inserting an extra section heading in the body
  no longer orphans the original section - the attempt is rejected with a readable error;
  heading recognition works for both Markdown styles; the interactive artifact block
  (Approve / Reject) works only in the artifact's own note, not in a copy; and the missing
  "blind spots" section was added to the report template.
- **A tool failure is visible and consistent:** the status in the bubble, the "open the saved
  file" link and the conversation history all agree on whether the operation actually
  succeeded. A failed sub-agent task no longer disappears from restored history, and a model
  error inside a sub-agent (a wrong API key, say) gives a red error frame instead of a false
  green "done".
- **Sub-agents do not lose their work when they run out of time** just before writing the
  summary: they get one extra window to finish, and an interrupted run returns a condensed
  digest of what it gathered instead of an empty placeholder. Parallel sub-agents under the
  same label are now distinguishable.
- **Disabling or updating the plugin stops running sub-agent tasks.** They could previously
  keep grinding for up to 30 minutes after the plugin was turned off.
- **Skills:** deleting a skill by name or by technical identifier removes the whole folder (no
  leftovers on disk), and a skill's intake questions are no longer lost when it is reloaded.
- **Agent mail:** missing translations were added (you see the message instead of a bare key),
  and a failed mailbox read is reported as an error instead of falsely marking the message as
  read.
- **Counters finally count the right thing.** The token preview shows one consistent number
  for context window usage, tokens recovered from the model cache are shown separately instead
  of hidden, the Sub-agent tab no longer shows zero despite real usage, labels are translated,
  and usage data from Anthropic models is not lost. LLM costs now include the single call
  behind the save-session command and real token usage for DeepSeek and OpenAI-style
  platforms.
- **Semantic search over your notes is sturdier:** the index status shows the real document
  count and tells an empty index apart from an error, the index no longer locks up for the
  whole session after an embedding provider failure, and notes rejected by a rate limit are
  retried instead of being marked permanently unprocessed.
- **Polish command names reach the command palette.** Commands registered before the plugin
  set the language, so the palette showed English names even with a Polish interface.
- **Confirmation dialogs look like the rest of Obsidian**, not like a browser popup: closing a
  session, deleting a skill or a sub-agent and removing an external MCP server all ask through
  the same modal window as everything else.
- **Interface details:** the mail cleanup and open-session windows got their missing styles,
  the Triggers tab in the sidebar finds an open chat again, tool hints in the chat list the
  tools that are actually available, saving an agent profile no longer overwrites the model
  field or loses the chosen language, text with a dollar sign in a substituted value renders
  correctly, memory notes no longer carry stray English label sentences, and an empty but
  valid search response is no longer taken for an unreadable binary file.
- **Parallel writes of todo lists and other files in the same turn** no longer overwrite one
  another.
- **The token preview marks estimates as approximate** when the model provider returned no
  real usage data, so the numbers are no longer presented as a certainty they are not.
- **Overrides of the built-in agent save only the real difference** from the factory template
  rather than its whole configuration, so the override file in your vault stays small and
  readable even after a small tweak.

### Removed

- **The GitHub update check.** The plugin no longer polls api.github.com every three hours
  looking for a new version; updates arrive through Obsidian's community plugin catalogue or
  through BRAT, just like installation did. After a version bump you still get the local
  "what's new" window with the release notes, with no network traffic at all.
- **ComfyUI in full** - the generation preview and the bundled workflows. Image generation
  stays available through cloud providers.
- **The sandbox that executed custom JavaScript for MCP servers**, replaced by the real MCP
  protocol over external processes and services.
- **Project Hub in agent mail** (projects, threads, briefs and their 12 tools), replaced by
  three simple mail tools.
- **The "who can write to me" field (`can_message`)** in the agent definition. Every agent can
  write to every agent; the restriction never worked as an access list anyway.
- **The blanket "MCP tools" switch in the agent profile.** Access to external servers is set
  per server.
- **The "leave as draft" option when closing a chat session.** There had been no way back to a
  saved draft for a long time, so it only wrote files nothing ever returned to. *Archive* and
  *Discard* remain.
- **The duplicate "Summarize summaries" button in the agent profile.** One *Summarize
  conversations* button remains (both did the same thing), with a description that covers the
  whole L1 to L2 to L3 consolidation.
- **Dead fields and settings with no effect:** the master/minion instruction overrides in the
  agent profile, "keep last sessions after L1", the L3 threshold, the brief prompt, and
  leftovers of the old v2 settings panel.

### Security

- **External MCP servers are under control:** a new server needs explicit consent before its
  first tool call (with an "always allow" option per tool), the consent dialog shows the full
  call arguments, you can preview the server's tool list before saving the configuration, and
  a kill switch per server hides its tools without deleting the configuration.
- **File paths are compared in one consistent form at every stage of a permission check**,
  which closes ways around forbidden zones and protected files through different spellings of
  the same path (`./`, double character encoding, letter case differences on Windows and
  macOS).
- **A disabled tool is really blocked** when something tries to use it, not merely hidden from
  the list. Write, delete and create actions with an empty "target" field are rejected instead
  of slipping through without a consent prompt.
- **Content from notes, agent memory and tool results is uniformly marked in the prompt as
  data, not instructions**, so the model cannot be fooled by a heading or a command smuggled
  into note text. Text generated by the agent itself does not get the privileges of a message
  written by a human (it will not fire a `/` command or a skill trigger unasked), and a web
  address suggested by the model is not treated as a link you trusted.
- **Reading web pages (`web_read`) has its own separate consent window.** It used to share one
  with the search tool, so a single approval quietly unlocked fetching arbitrary addresses.
- **Background work started from a chat tab uses the memory, model and autonomy mode of the
  agent that ordered it**, not of whichever agent happens to be on screen, closing a leak of
  data and permissions between agents.
- **Delegation is hard-limited:** a depth limit for further delegation (no further delegation
  by default, up to three levels in Settings), a ceiling of five parallel tasks per call, an
  enforced folder scope for the sub-agent, and inheritance of the intersection of parent and
  child permissions. A sub-agent with a narrow scope could previously hand a further
  delegation full access to the vault.
- **Agent mail resists spam loops:** a limit of 20 messages per 10 minutes between the same
  pair of agents, and a bounce counter in a reply chain (after three hand-offs the agent is
  told to break the loop and hand the matter back to you). Sending and its limits behave
  correctly under many parallel sends.
- **API keys are masked in logs by field name, not only by recognised format**, which covers
  OpenRouter, Groq, xAI and the newer OpenAI key format. Errors returned by sub-agents and a
  failed model response stream (a DNS or proxy error, for instance) are masked too; the latter
  could write a key into the error message.
- **Saving settings is protected** against a failed write wiping the existing contents of the
  settings file.
- **Image generation and adding text to an image run the full permission check on the source
  file too.** An agent with access to a public folder could previously copy a file out of a
  forbidden one this way. Artifact field content goes through the same content filter as the
  rest of the artifact.
- **An agent in "assigned folders only" mode got web search, page fetching, mail and
  delegation back.** A bug rejected every such call as "outside the workspace" even though it
  involved no vault path at all.
- **Fail-closed where things used to half-work:** rebuilding the search index, the skin change
  cycle, reading the agent mailbox and the memory inspector now refuse openly instead of
  quietly continuing on incomplete data. Renaming an agent is resilient to errors
  mid-operation: it neither deletes memory under the old name nor takes over someone else's
  mailbox.
- **An agent access policy is now enforced**, limiting what an agent actually reaches for in
  the vault.
- **13 XSS holes in the interface were fixed**, including code injection through a tool name
  coming from an external MCP server.
- **Dependencies:** vulnerabilities patched in `js-yaml` (an old version with an unsafe default
  loading mode, so a crafted note header could potentially execute code) and in `fast-uri`.
  The version release script no longer prints a GitHub token to the console on error.

### Performance

- **Plugin start-up went from about 8 seconds to a fraction of a second.** First by cutting
  two hard-coded, unjustified start-up delays inherited from the earlier code base (about 8 s
  to about 0.2 s), then by further polishing (176 ms to 52 ms under production conditions).
- **The plugin slimmed down from 3.0 MB to 2.16 MB.**
- **Note mention suggestions after typing `@`** are far faster; every keystroke used to search
  the entire vault from scratch.
- **The artifact list in the chat** is no longer rebuilt from a full vault scan on every turn.
- **Searching agent memory is noticeably faster** (a capped number of candidates per query),
  and memory consolidation (L1/L2/L3) reads from disk once instead of repeatedly when there
  are many sessions.
- **The session file is appended to** rather than rewritten in full on every change.
- **Answer text is throttled while streaming** instead of repainted on every frame, which
  makes scrolling smoother during long answers.
- **The agent mail sidebar** refreshes mailbox headers from cached data instead of reading
  every mail file on each render.
- **The register of addresses fetched by `web_read` has a ceiling** (2000 entries); past that
  the oldest address is dropped, so the list cannot grow without bound in long sessions.

### Upgrade notes

- **The plugin identifier changed.** Settings, API keys and data migrate automatically the
  first time the new version starts: the settings namespace is repointed along with the key
  vault references, and the plugin's data file is copied into the new plugin folder. Nothing
  has to be retyped by hand. After the update:
  - **Hotkeys have to be assigned again.** Obsidian stores them as
    `<plugin-id>:<command-id>`, and both halves changed.
  - **The plugin list may show two "PKM Assistant" entries** (the old, inactive one and the
    new one). This is harmless.
  - **Delete the old plugin folder by hand** once you have confirmed the new version works.
    The plugin does not remove it.
- **Settings move into the vault** at `.pkm-assistant/settings.json`. Nothing to do by hand.
- **After the removal of Project Hub, the old agent mail files** (projects, threads, briefs and
  the old `inbox_<agent>.md` mailbox format) stay in your vault unused. The plugin neither sees
  nor deletes them; remove them yourself if you want to.

### Known limitations

- **Desktop only.** The plugin is marked desktop-only and will not start on a phone. Semantic
  indexing in particular is desktop-first.
- **API keys sit in plain text in `.pkm-assistant/settings.json`**, that is, inside your vault,
  until you turn on the secure store (AES-GCM encryption with a master password). The file is
  added to the vault's `.gitignore` automatically, but synchronisation services replicate it
  along with the vault.

## 2.1.0 - 2026-07-21

No new features outside the core: this release is about the plugin no longer pretending. What
it promises, it actually does.

### Added

- **Semantic vault search that genuinely works.** A meaning-based index of the vault is built
  at start-up, follows changes as they happen, and is kept on disk, so a restart does not
  recompute it. Status and a *Re-index* button live in Settings. Desktop-first: on a phone you
  get an honest message instead of a silent failure. Agent memories and No-Go zones are hard
  excluded from the index.
- **All agent limits in one place**, editable in Settings -> Limits.
- **Diagnostics:** a plugin log written to a file, plus a self-test command with a health
  report.

### Changed

- **The plugin slimmed down from 8.35 MB to 3.0 MB.** Token counters show real usage reported
  by the API, and estimates are honestly marked as approximate and calibrate themselves.
- **The tool loop has a real hard stop:** the last round runs without tools, so the model has
  to answer in text. Tool results are trimmed before they can blow up the context.
- **Agent mail was put to sleep behind a kill switch** for the duration of the rework. Data was
  left untouched; bringing it back is a single flag.
- **ESLint enforces module boundaries**, and the project documentation was reviewed for
  freshness so it tells the truth about the state of the code.

### Removed

- **Dead code:** the Cohere provider, old tools and legacy formats.

### Security

- **Fail-closed in the places that matter.** An agent with a missing or broken tool whitelist
  gets the minimal set of tools, not all of them, and a sub-agent cannot run a tool outside the
  intersection of permissions by any route.
- **`web_read` only fetches addresses of known origin** - a search result, or a link you gave
  it yourself.
- **`.pkm-assistant/` is out of reach of the vault tools.**
- **Parallel memory writes no longer overwrite one another** (one queue per file).
- **An XSS hole in the model settings was fixed**, and you now get a warning when API keys are
  stored unencrypted.

## 2.0.0 - 2026-05-17

The stable release of the v2 line.

### Added

- **Memory v3:** a short brain index plus durable memory notes, a live session file and a
  session archive, with consolidation driven by the model rather than by hard-coded rules.
- **Sub-agents** with core roles, inline triggers, `@` and `/` popups and a sidebar trigger
  tab.
- **Agent mail**, replacing the older messaging module.
- **Artifacts v2** and a registry of slash commands.
- **Prompt caching** for Anthropic, OpenAI, xAI and Ollama, with cache telemetry in the
  interface.
- **Token context viewer** with a breakdown per category and per model.
- **Plugin skins:** Default, Crystal Soul and a custom option.
- **Rebuilt settings and agent backstage**, with skills split per profile.
- **Semantic retrieval on Orama**, replacing the previous embedding stack.
- **MCP:** built-in and user servers separated, permissions per agent and per role, server
  templates and a settings interface.
- **Roles v2** defined in YAML.

### Changed

- **A security pass** brought stronger path sanitisation, secrets stored behind a master
  password and secret masking in logs.

### Removed

- **The old base runtime and the connections panel.**
- **`plan_action`** - use plan review, idea review or the chat todo tool instead.
- **The legacy `minion` / `master` role names**, replaced by researcher and strategist.
- **The onboarding wizard**, deferred to a later version.

Upgrade notes: settings from 1.x are migrated automatically on first start.

## 2.0.0-rc.1 - 2026-05-09

Release candidate for 2.0.0. Same scope as the 2.0.0 entry above, minus Memory v3 and the
fixes that came with it.

## 1.2.1 - 2026-03-25

First public release, installable from GitHub Releases and through BRAT.

### Added

- **Multi-modal support:** vision input, image generation across seven platforms, and speech
  to text across six platforms.
- **Bilingual interface** (Polish and English) with roughly 1000 translation keys and a
  language picker in settings.
- **Onboarding:** a three-step wizard plus a built-in mentor agent that explains the system.
- **Security hardening:** path sanitisation, a sensitive-data guard and protected paths.
- **Built-in MCP servers** for agent building, bug tracking and vault building.
- **Sub-agent system** with shared and per-agent sub-agents.
- **Work modes:** talk, or act.
- **Memory** with brain, sessions, summaries and save tools.
- **Skills** in a plain markdown format, with a guard for skill mode.
- **Extended thinking** across all nine platforms.
- **Plan and todo interface overhaul**, including a plan review window and an action bar.
- **Web search and page reading** with a short-lived cache.

### Changed

- **All external dependencies were pulled into the plugin's own source tree.**
- **Licence:** GPL-3.0-or-later.

## 1.1.0 and earlier

Pre-release development history, before the first public release.

## Links

- Repository and releases: https://github.com/JDHole/pkm-assistant
