# PKM Assistant 2.2.9

**Smaller index, quieter memory, fewer questions** - PKM Assistant 2.2.9

**In plain words.** Four things you will notice. First, the semantic index of your vault is no
longer rewritten as one huge text file every time you edit a note. It is now kept as a small
description plus compact binary pieces, and an edit adds only a tiny piece. On a vault with
5,200 indexed notes the files on disk shrink from about 122 MB to about 22 MB, and the save after
an edit drops from over a second of work that froze the interface to a few milliseconds. The
switch happens by itself the first time the plugin starts: the old file is removed only after
the new files have been written and read back, and a notice tells you when it is done. Second,
automatic memory consolidation is off by default - the plugin no longer proposes to merge an
agent's sessions or brain notes on every save unless you turn it on, and when you decline a
proposal it stops asking until the next threshold. Third, when an agent asks to write to a
file, you can tick "don't ask again for this file in this session" - the approval is remembered
for that chat only. Fourth, a brand-new agent under an English interface gets an English brain
file, with English section headings and English artifact statuses; existing Polish files keep
working unchanged.

What changed, in detail:

- **Semantic index v2.** `vault-index.meta.json` (version 2) is the only source of truth: model
  key, vector size, per-note timestamps and a row pointer per note. Vectors live in immutable
  binary segments `vault-index.NNNNNN.vec` (Float32, little-endian, 16-byte header). A save after
  edits writes one new segment with only the changed notes; when segments pile up (more than 8,
  or half the rows are stale) they are compacted into one. Writes are serialised, so an edit
  that lands while a save is in progress is never lost. The in-memory search engine and the
  search results are unchanged.
- **Migration with a safety net.** On first start the old `vault-index.json` is read, converted,
  written as v2, read back and verified; only then is the old file deleted. If any step fails
  the old file stays untouched, you get a notice with the reason, and the index is rebuilt from
  your notes as before.
- **Detected rebuilds instead of silent breakage.** If the embedding model starts returning
  vectors of a different size, or you switch models, the plugin says so and rebuilds the index.
  Previously a size change made the indexer retry forever. A wrong API key or model name now
  ends the scan with a visible error instead of retrying the whole vault every few minutes.
- **Embedding timeout in Settings.** The request timeout for embedding calls is a field in
  Settings → Models → Embedding, in seconds; before it could only be changed by editing the
  settings file.
- **Optional consolidation.** Two switches in Settings (sessions and summaries, brain notes),
  threshold controls with their effective values shown, and a declined proposal resets the
  counter instead of coming back on the next save.
- **Remember write approval for this session.** Checkbox in the approval and diff dialogs, kept
  in memory per file and per chat, cleared on a new chat or when the session is archived.
  Concurrent writes to the same file from one model turn are serialised and no longer overwrite
  each other.
- **Brain file and artifact statuses in the interface language.** New brain files are born in
  the interface language and stay in it; parsers know both Polish and English headings; artifact
  types created under English have English statuses, and the buttons work on old Polish files too.

Every change ships with tests that fail without it. The index migration was additionally
replayed on a copy of a real 122 MB index: 5,200 vectors converted in under a second, zero
embedding calls, identical top results before and after.

Known limits: the index directory stays inside the vault (plugins may not write elsewhere), so a
sync client will still upload the small segment files after each save. Closing Obsidian within
30 seconds of an edit may leave that edit un-persisted; the next start re-embeds only that
note. Reindex on a vault that has zero indexable notes produces an empty index, as before.

Upgrading from 2.2.8: no settings change needed. The index migrates itself on first start and
shows a notice; on a large vault expect that one start to take about a second longer.
Downgrading to 2.2.8 or older after the migration means a full re-index, because the old build
does not read the new format. The downgrade warning from 2.2.6 still stands for active chat
sessions.
