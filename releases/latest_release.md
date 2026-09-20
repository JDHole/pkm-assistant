# PKM Assistant 2.2.8

**Memory first, no bundled skills** - PKM Assistant 2.2.8

**In plain words.** Two changes in how agents behave out of the box. First, when an agent
looks something up and nobody said where, it now checks its own memory first - what it has
learned about you and what you agreed on together. Your notes are searched when the agent asks
for them on purpose, and agents are now told to do exactly that whenever your question is about
your notes. In live test chats with three different models every question about notes was
still answered with a single search, the same as before. Second, the plugin no longer installs
ready-made skills. We want skills to go through proper rounds of iteration and evaluation
before we ship any, so for now the plugin ships none. Skills you already have stay exactly
where they are.

What changed, in detail:

- **`search` without a scope looks in the calling agent's memory.** User notes need an explicit
  `scope: "vault"`. The tool description, the parameter description and the "one search" prompt
  rule say so, with examples for both kinds of question. Three cases still default to the
  vault: a call made by a sub-agent, an agent with the memory permission switched off, and an
  agent that has no memory yet. A result from the default scope carries a `scope_hint` field
  that tells the model how to widen the search, so an empty memory result is not mistaken for
  "there is no such note". Legacy tool names (`vault_search`, `vault_grep` and the rest) keep
  searching the vault.
- **No starter skills.** A fresh vault gets no skill files, and the plugin no longer creates
  the skills folder at startup - the first skill you save creates it. The built-in agent
  Jaskier starts with no skills assigned. Backstage templates (the two Deep Research skills and
  the researcher sub-agent) are unchanged.
- **No promises about things that are not there.** Jaskier's persona says he helps you design
  agents and skills while you create them in the panel, and the chat welcome hint no longer
  points at a skill bar that only appears once an agent has skills.
- The quick start guide describes where a skill is actually created: agent profile, Skills tab.

Both changes ship with tests that fail without them. The search change was additionally
walked through in a live chat, reading the tool calls the models actually made.

Known limits: the `scope_hint` safety net has only been exercised in automated tests, because
every model we tried passed the scope on its own. Very small local models may still stop after
an empty memory result - if your agent says it cannot find a note you know exists, ask it to
search the vault. The vault map starter still lists `skills/` as the skill library although
the folder now appears only with your first skill.

Upgrading from 2.2.7: no migration, no changes to settings, and your skill files are not
touched. If you never edited Jaskier's profile, his list of assigned skills is empty after the
update - the eight starter files are still in your skill library and can be assigned again in
his profile (Skills tab). If you wrote your own prompts or skills that tell an agent to
"search" your notes, they kept working with the models we tested, but adding `scope: "vault"`
to the instruction makes it certain. The downgrade warning from 2.2.6 still stands: **do not
downgrade** below 2.2.6 with active chat sessions written by 2.2.6 or newer - archive or
discard them first.
