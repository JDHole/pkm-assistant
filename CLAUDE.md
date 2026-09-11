# PKM Assistant

**What this is:** A plugin for Obsidian. AI agents living inside your vault, with hierarchical memory, skills, and tools (MCP). License: GPL-3.0. Repo: https://github.com/JDHole/pkm-assistant

**Who it's for:** People who want their own AI assistant inside Obsidian - local (Ollama), cloud (OpenAI/Anthropic/xAI/other), or a mix. Non-programmer users manage agents through the UI, not code.

**Authorship:** This project is built entirely with Claude Code (JDHole: vision, prompt engineering, testing; Claude Code sessions: implementation). See `QUICK_START.md`.

## Priorities (in this order)

1. **Zero regressions.** Something breaks - stop, fix it, then continue. The plugin is in production and people use it daily.
2. **Git hygiene** - a commit per meaningful change, tests pass before every commit, a clean history so someone new can land and understand what is going on.

Stability comes before new features - the plugin is headed for the public Obsidian community directory and has to stay predictable.

## Main rule - how this project is organized

**Every module is a physical folder** in `modules/<name>/` with:
- `index.ts` - the only public door, a physical file (import specifiers in code end in `.js` but point at this same physical `.ts` file). It exports whatever the module makes available to the rest of the codebase.
- `CLAUDE.md` - module documentation: what it does, how, and its gotchas.
- Everything else - private internals.

**Golden rule:** outside a module, you may only import from `modules/<name>/index.js`. Never from its internals. Inside a module, files may import each other freely.

**The golden rule also covers `core/`** - its door is `core/index.ts`. Official exceptions, allowed to be deep-imported from anywhere: `core/i18n/index.ts` and `core/utils/Logger.ts` (global utilities with a very large number of importers). The second exception is a single file: `src/main.ts`, the composition root, deep-imports a handful of core Obsidian-facing files (`PluginBase.ts`, `runtime/PluginRuntime.ts`, `runtime/settingsArmor.ts`, `utils/obsidianNav.ts`, `security/MasterPasswordModal.ts`) because they cannot be added to the barrel: `core/index.ts` has to load in plain Node, and the AVA tests have no mock for `obsidian`. Import specifiers still deliberately end in `.js` and point at the physical `.ts` files.

**ESLint enforces this**, not "convention plus review": `no-restricted-imports` in `eslint.config.js` covers `modules/**`, `src/**`, `config/**`, and `utils/**` (tests excluded), and `npm run lint` runs across all four trees. A deep import is a lint error, not a review comment. (`test-support/` dropped out of this scope on 2026-09-11: it now holds only a locator script, not module source with a barrel to enforce - see "Commands and gates" below for what replaced it.)

**Why:** (a) a session working inside a single folder saves tokens, (b) it keeps changes scoped module by module instead of to the whole codebase at once, (c) changes to internals cannot break the plugin from the outside.

## Module map

All modular code lives in `modules/<name>/`. `src/` holds only two files: `src/main.ts` (composition root) and `src/styles.css`.

| Module | Role |
|---|---|
| `core/` | Foundation: `PluginBase`, runtime (`runtime/PluginRuntime` + `SettingsStore` + `NoticeCenter` + `StatusBar`), HTTP transport (`core/http/`), security, i18n, utils. Details: `core/CLAUDE.md` |
| `modules/memory/` | Agent memory: `brain.md` short index + `brain/` persistent notes + `sessions/active` + `sessions/archive` + L1-L3 summaries, create-only `memory_save`, LLM-driven consolidation, isolation between agents |
| `modules/embedding/` | Vectorization (Orama): `EmbeddingModel` + `EmbeddingRegistry` + `providers/` (OpenAI/Ollama/Gemini/LM Studio and others) + `VaultIndexer` |
| `modules/prompts/` | `PromptBuilder` + Decision Tree - agent behavior instructions, grouped and toggleable |
| `modules/sub-agents/` | `SubAgentLoader` + `Runner` (delegation) + system roles loaded via `loadSystemRoles()` + custom YAML scope (folders / frontmatter / sections / pinned_notes) + DelegateTool DI + parallel execution + per-task timeout |
| `modules/tools/` | Agent tools: built-in (vault, artifacts, communication, media...) + external MCP client (stdio/HTTP) |
| `modules/skills/` | Skill engine (recipes for agents) |
| `modules/chat/` | `ChatView` + mixins + `InlineChipPlugin` + `StreamingManager` + `RollingWindow`/`Summarizer` + `TriggerPopup` (inline `/` and `@` triggers) |
| `modules/models/` | `ChatModel` + providers in `providers/` (many platforms: DeepSeek, Anthropic, OpenAI, Google, Groq, OpenRouter, Ollama, LM Studio, xAI...) + `registry.ts`; DI from `config/runtimeConfig.ts` |
| `modules/artifacts/` | Plans and notes (user-facing, with an approval flow) - agent-internal todos live in `tools/` |
| `modules/agents/` | `AgentManager`, `AgentProfile`, the built-in onboarding agent, agent personality model (Persona + Skills + Permissions + Team + Memory) |
| `modules/multimodal/` | Audio STT + image generation + vision + active-note awareness |
| `modules/onboarding/` | Wizard + `PlaybookManager` |
| `modules/komunikator/` | Inter-agent mail: one file per message, `kom_send`/`kom_list`/`kom_read` primitives, per-agent invisibility, semi-automatic cleanup |
| `modules/crystal-soul/` | UI generators (icons, crystals, colors) + `SkinManager` |
| `modules/shell/` | Settings tab, sidebar, modals |
| `modules/agent-loop/` | **The core tool loop, no UI.** `runAgentLoop()`, `ArrayMessageStore`, canonical `parseToolCalls()` (handles several response shapes) + `splitConcatenatedToolCalls()` (anti-merging for model output) + `sanitizeToolTranscript()`. Consumers: sub-agents, chat, `tools/MCPClient` |
| `modules/ui-components/` | Shared UI primitives: `ToolCallDisplay`, `ThinkingBlock`, `SubAgentBlock`, `AttachmentManager`, `MentionAutocomplete` |
| `modules/web/` | Web access layer: `WebSearchProvider` (several providers), `urlRegistry` (URL provenance), search settings |

## Commands and gates

```bash
npm test                 # AVA - unit tests, free, offline
npm run typecheck        # tsc --noEmit - strict TypeScript gate (noUnusedLocals + noUnusedParameters)
npm run lint              # ESLint over modules/ + src/ + config/ + utils/
npm run lint:obsidian     # ESLint with the Obsidian community-directory ruleset, over core + modules + src + config + utils
npm run build             # Production build -> dist/main.js
```

`npm run build` also deploys to every vault listed in `DESTINATION_VAULTS` in `.env`. For the owner that includes their live, daily-use vault - treat that as the last gate, not a work step.

Full verification order: tests -> typecheck -> lint -> lint:obsidian -> build -> harness (`npm run selftest` + `npm run scenarios`). The harness runs the real plugin in Node without Obsidian and lives in a separate repo (`pkm-assistant-harness`, https://github.com/JDHole/pkm-assistant-harness) because the community-directory linter scans the whole plugin repo, and the test harness is not part of the plugin. Clone it next to this repo; see its own README for details.

`test-support/` (root-level, one file: `register-obsidian-for-ava.mjs`) is a **locator**, not source: since 2026-09-11 the `obsidian` module stub, its DOM shim, and the actual AVA preload live in the harness repo (same reason as above - the directory validator flagged things the stub needs by definition, like `globalThis` and bare timers). This means `npm test` itself now also needs that harness clone next to this repo (or a `PKM_ASSISTANT_HARNESS` env var pointing at it, or CI's `.harness-ci` checkout) - without it, `npm test` fails immediately with an error naming exactly what to clone or set.

The same gates run automatically in CI (`.github/workflows/ci.yml`) on every push and pull request to `main` - a safety net, not a substitute for running them locally before you commit.

## Git flow

- One task, one branch. Do not commit code directly to `main` (small doc fixes are the only exception).
- Tests pass before every commit. Red - stop and fix, then commit.
- Commit titles follow Conventional Commits: `type(scope): subject`, for example `fix(memory): correct session index lookup`.
- Merge a finished branch into `main` with `git merge --no-ff`.
- Update the documentation touched by the change as part of the same piece of work, not as a follow-up.

## Documentation rule

Documentation that lies is treated as a bug in this project. After a change, update the affected module's `CLAUDE.md` if the public API changed, a gotcha was added, or a TODO was resolved.

Each module's `CLAUDE.md` keeps:
- **What lives here** (module structure)
- **Public API** (what `index.js` exports)
- **Gotchas / historical decisions** still relevant to today's behavior
- A link to module-specific findings or tests, if relevant

## Evidence, not claims

1. Every claim in a report carries its proof in the same sentence, or a label: `[measured]` - actually run or read, `[inferred]` - follows from code or logs but not run, `[guess]` - a guess (a prediction, or an unseen cause, is always a guess). Never hand back a check you could have run yourself.
2. Evidence means a real artifact: a function actually run, a value actually read, command output pasted verbatim, a diff. "It compiles", a green build, or green CI are not evidence by themselves. Match the type of evidence to the change: CLI - a real command; UI - walking the changed flow in Obsidian; parser/migration - replaying real input; storage - reading back the stored value.
3. "Inconclusive" is a valid answer; confidence without evidence is a red flag. Whoever verifies a change should not be the same person, or agent, who wrote it.

### PR description

Title: Conventional Commits `type(scope): subject`, imperative mood, no trailing period. The body is a briefing, not a log: sections in order Why / Scope / Tradeoffs / Blast Radius / Verification, only the non-empty ones, about 40 lines max. Verification lists what you ran and what it showed, using the labels from point 1. Prefer five narrow PRs over one large one.

## TypeScript and tests

| Rule | Instead of |
|---|---|
| Discriminated unions (`kind` as a literal discriminant) | a bag of optional fields |
| Branded types for semantic primitives, validated once at the boundary | bare `string` / `number` everywhere |
| A type shape that makes illegal state unrepresentable | a runtime guard that polices it at runtime |
| `unknown` for external data | `any` |
| Parsing at the boundary with a schema | a hand-written type guard field by field |
| `as` only after validation | an `as` cast on faith |
| Narrow in this order: discriminant switch, `in`, typeof/instanceof, guard, `as` last | reaching for `as` first |
| `satisfies` | `as` (widens the type and hides it) |
| Validate at the boundary (Obsidian API, vault files, network, LLM provider), trust the inside | guards scattered through the whole codebase |
| `Pick` / `Omit` / `Parameters` / `ReturnType` | a new interface from scratch |
| An exhaustive switch with `never` in the default branch | a switch with no exhaustiveness check |
| Logging through `core/utils/Logger.ts` | `console.log` |

### Tests: behavior, not implementation

A test calls the code the way its caller would, and checks the observable result against a literal expected value. Control test: would it still pass if every imported function returned undefined? If yes, rewrite the assertion or delete the test. Five patterns of a false test:

- Weak or missing assertion - just `t.pass()`, `t.truthy()`, or `t.notThrows()` with no check of a specific value.
- Checking only that a mock was called, or that something is absent - an empty array, `undefined`, comparing against a "wrong value" instead of the real result.
- A self-referential test - the expected value is computed by the same function under test.
- Pinning a constant - the assertion just repeats a hand-maintained constant, a default config, or prompt text.
- Fixture checks fixture - the assertion reads data built by the test itself, and the code under test never actually runs in the middle.
