# Core Security Model

This document describes the security boundary for PKM Assistant core. The goal is simple:
the model can suggest actions, but code paths that touch the vault, tools,
agents, logs, or secrets must pass through small explicit guards.

## Threat Model

STRIDE summary:

| Category | Main risk | Mitigation |
| --- | --- | --- |
| Spoofing | Agent or MCP tool pretends to be trusted | `PermissionSystem` maps known actions only; unknown actions fail closed |
| Tampering | Path traversal or unsafe overwrite modifies vault/system files | `sanitizePath`, `isProtectedPath`, `AccessGuard`, approval flow |
| Repudiation | User cannot tell what was approved | `ApprovalManager` history plus persistent always-approved rules |
| Information disclosure | API keys leak through logs, tool output, or plugin data | `SensitiveDataGuard`, logger masking, `SecretsStorage` references |
| Denial of service | Malicious MCP server runs too long or loops path operations | MCP timeouts and vault path validation |
| Elevation of privilege | New tool skips permission mapping, or an autonomy mode grants capability | unknown actions fail closed; autonomy only removes prompts; protected vault internals require explicit per-agent `admin_access` |

## Attack Surface

- MCP tool arguments, especially user-controlled vault paths.
- External MCP servers configured by the user (`settings.pkmAssistant.externalMcpServers`) and run by
  `modules/tools/ExternalMcpManager.js`: `stdio` = a separate OS process with the user's
  privileges, `http` = a remote service receiving conversation data. They do **not** share the
  Obsidian JavaScript heap. The plugin-side boundary is classification, not containment: every
  such tool is registered with `source:'user'` and therefore classified RED unconditionally, so
  the first call always asks, and "always allow" is stored per concrete tool
  (`external.call::<server>__<tool>`).
- Model/tool logs and error objects that may contain API keys.
- Approval rules, because "always approve" can become too broad.
- API key settings in `.pkm-assistant/settings.json` / plugin data.
- Active note context ("Oczko"), including embedded vault images.

## Mitigations

- `core/security/keySanitizer.js` normalizes paths to NFC, decodes URL escapes,
  blocks traversal, absolute paths, UNC paths, null bytes, zero-width unicode,
  Greek/Cyrillic homoglyph-risk characters, Windows reserved filenames, and
  excessive path length.
- **One string for the gate and for the sink.** `sanitizePath()` returns a CANONICAL form
  (no `./` segments, no `..`, no leading/trailing `/`, no `\`, no `%XX`). Canonicalization
  happens **once, before the gate**: `MCPClient._extractToolContext` canonicalizes the vault
  path and **replaces it in the call arguments**, so the tool's `execute` receives exactly the
  string that No-Go, the protected-file list and the whitelist judged. `PermissionSystem.checkPermission`
  repeats it as defense in depth; a path that cannot be canonicalized is denied outright
  (`Invalid path`, fail-closed, no user prompt). `AccessGuard._normalizeForDenyCompare` keeps
  No-Go entries and the compared path in the same lightweight normalization. Tools must NOT add
  their own path normalization - `validateVaultPath` inside `execute` is an idempotent repeat,
  not a second opinion.
- **Deny gates fold case, allow gates do not.** On Windows and macOS - where the file system
  does not distinguish case - a byte-for-byte comparison would let `Projekty/prywatne/tajne.md`
  sail through a No-Go rule written as `Projekty/Prywatne/tajne.md`, and the same gap would
  apply to `.Obsidian/workspace.json` and `.TRASH/x.md` against `SYSTEM_NO_GO`. No-Go therefore
  uses `AccessGuard._normalizeForDenyCompare`, the same recipe as `isProtectedPath`: `\` → `/`,
  `NFC`, `toLowerCase()`. The ALLOW side (the `focusFolders` whitelist and a sub-agent's
  `scope.folders`) deliberately stays case-sensitive. Both directions are fail-closed - a deny
  that catches too much and an allow that admits too little. The price on a genuinely
  case-sensitive vault (Linux) is that banning `Prywatne/` also bans a neighbouring `prywatne/`;
  accepted knowingly. Pinned by `core/security/nogo_case.test.ts`.
- **The gate canonicalizes `image.*` too.** The defense-in-depth pass in `checkPermission`
  covers both `vault.*` and `image.*`: `generate_image` hands the gate its SAVE FOLDER and
  `add_text_to_image` its SAVE TARGET (`output_path`, or the DERIVED `<source>_text.<ext>`). A
  derived target is not literally the value of any argument field, so
  `MCPClient._canonicalizeToolContext` skips it - the gate is its only canonicalizing layer for
  that case. Add a new file-touching action → make sure it is covered by this pass, otherwise the
  same path can get two different verdicts depending on which action carried it.
- **`sanitizePath` is computed to a FIXED POINT.** A single pass is not idempotent on its own:
  `trim()` running once on the whole string, or `decodeURIComponent` peeling only one encoding
  layer, would let a second canonicalization pass return a different string than the first
  (`'./ A/B.md'` → `' A/B.md'` → `'A/B.md'`; `'a%252e%252e/x'` → `'a%2e%2e/x'` → `'a../x'`).
  That breaks the "one string for gate and sink" contract in practice - a caller that
  canonicalizes once and a gate that canonicalizes again could disagree, so the approval dialog
  could show one path while the gate ruled on another. `sanitizePath` instead loops until the
  value stops changing (5 passes max, then `null`, fail-closed), so
  `sanitizePath(sanitizePath(x)) === sanitizePath(x)` by construction. Consequence:
  double-encoded input decodes all the way or is rejected - `'%252e%252e/x'` becomes `null`
  rather than passing as an innocent-looking `%2e%2e` file, while `'a%252e%252e/x'` resolves to
  `'a../x'` (segment `a..` is a legal filename, not a traversal).
- **`AccessGuard.checkAccess` canonicalizes on entry.** Because canonicalization is idempotent,
  the deepest guard does not trust its callers either: it canonicalizes the target before
  anything else (including the sub-agent scope barrier) and denies `Invalid path` when the
  target has no canonical form. This matters because the `.pkm-assistant/` boundary inside
  `checkAccess` is a raw `startsWith` - an uncanonicalized leading `./` could otherwise walk
  past it. Exception: `opts.targetIsVaultPath: false`, passed by `PermissionSystem` for the
  non-vault actions (`web.search`, `web.read`, `agent.message`, `delegate`, `external.call`)
  whose target is a query, a URL or a recipient - running those through `sanitizePath` would
  reject a search phrase starting with `C:\...`, a URL with a long query string or a
  mixed-script phrase. `core/security/path_canonical.test.ts` and
  `core/security/path_canonical_image.test.ts` pin the contract.
- **The folder whitelist measures PATHS only.** No-Go, protected files, the `focusFolders`
  whitelist and a sub-agent's `scope.folders` must never measure a query, URL or recipient as
  if it were a path - an agent in "assigned folders only" mode (`guidance_mode: false`) with a
  whitelist of `['A/']` would otherwise lose web search, page fetching, agent-to-agent mail and
  delegation entirely, because none of those targets look like a path under `A/`. `checkAccess`
  returns `{ allowed: true, reason: 'non-vault-target' }` immediately when
  `targetIsVaultPath` is `false`, before any path check. Nothing else in `checkPermission`
  changes: risk classification, approvals and `disabled_tools` still gate these actions, and
  their real boundaries live in their own layers - the known-URL registry plus user consent for
  `web.*`, recipient visibility and mailbox limits for `agent.message`, scope intersection plus
  runtime depth for `delegate`, mandatory RED approval plus the server opt-in list for
  `external.call`. The flag defaults to `true` (fail-closed for new callers);
  `core/security/non_vault_targets.test.ts` pins it.
- **No target is not a free pass.** Every check below the entry point (No-Go, protected files,
  `focusFolders` whitelist, a sub-agent's `scope.folders`) sits behind `if (targetPath)`, so an
  action arriving with an empty target would otherwise skip all of them - that is how
  `artifact_*` and `add_text_to_image` could write into the vault unguarded under an unchecked
  `output_path`. `PermissionSystem` denies, fail-closed, any action in `TARGET_REQUIRED_ACTIONS`
  (`vault.write`, `vault.create`, `vault.create_folder`, `vault.delete`, `artifact.create`,
  `artifact.update`, `artifact.read`, `image.generate`) that arrives without a target;
  `admin_access` does not waive it. `vault.read` is deliberately excluded: the same action also
  carries `ask_user`, `todo`, `kom_list`/`kom_read` and `scope:'memory'` calls, which have no
  vault target by design (a root listing uses `'/'`, never an empty string). **Consequence for
  tool authors:** a tool that touches a file must supply the real path through its
  `contextExtractor` - computing it in the engine (as `artifact_*` does) rather than leaving
  the field empty.
- **A remembered approval for "no target" covers only "no target".**
  `ApprovalManager.createPatternKey` writes an explicit `action::<bez-celu>` token instead of
  collapsing an empty target into the `action::*` wildcard, and a call without a target does not
  match a stored `action::*` rule. One click on "Always allow" for a call with no path cannot
  auto-approve every later write by that agent.
- **A remembered approval never turns a model-supplied target into a wildcard.** The target
  reaching `createPatternKey` is treated as literal text, so a tool argument the model writes -
  `delete {path:"*"}`, `kom_send {to:"*"}` - cannot produce the broad `action::*` rule;
  `sanitizePath` additionally rejects `*` in vault paths, since it is a control character here
  (whitelist globs, rule keys) and never a real filename. Wildcard rules can only come from a
  user's pre-existing settings; they keep working and are reported with one warning on load, for
  review under Settings → Security.
- `PermissionSystem` denies unknown actions regardless of autonomy mode.
- Autonomy (`yolo` / `edge` / `all`, chosen per chat) only controls
  whether the user is asked before an already-allowed action. `yolo` skips the
  approval modal and diff preview, but never grants a tool or widens its workspace.
  Autonomy is not a permission.
- `admin_access` is the single explicit per-agent escape hatch for protected
  **vault-relative** paths. It opens `.pkm-assistant`, `.obsidian`, `.trash`, user
  No-Go folders and protected vault files to the normal `read/list/search/write/
  delete/create_folder` primitives. It is off by default. It does **not** bypass
  `sanitizePath`, so absolute paths, UNC paths and traversal remain blocked, and it
  does not enable disabled tools or remove approval prompts.
- Workspace policy version 2 makes `guidance_mode:false` plus an empty
  `focus_folders` list mean zero ordinary-vault access. Legacy agents are migrated
  once to `guidance_mode:true` so their previous effective access is preserved.
  A hand-written profile that means "no access" must therefore carry
  `access_policy_version: 2`, otherwise the one-time migration overrides its
  explicit `guidance_mode: false` and writes the change back to disk (changing that
  behaviour is a product decision, not a patch).
- **A delegated child never gets more than its caller.** When a sub-agent delegates further
  (`max_delegation_depth` >= 2), the grandchild receives the **intersection** of folder scope
  and tool whitelist with the CALLING sub-agent, not with the main agent. `MCPClient` injects
  `_invocationScopeFolders` and `_invocationToolNames` as trusted runtime markers (deleted
  outside delegation, like `_invocationDelegationDepth`); `AccessGuard.intersectScopeFolders`
  keeps the narrower entry and returns an empty list for disjoint scopes, which `DelegateTool`
  turns into a fail-closed refusal.
- **`web_read` has its own consent gate.** It maps to the `web.read` action with its own
  `APPROVAL_DEFAULTS` key (ask by default), its own profile toggle and its own modal wording, so
  silencing `web_search` does not silence the one tool that sends a model-chosen address out to
  the network. A persisted "always allow" rule is stored per action (`web.read::<url>`). The
  URL-provenance gate (`isUrlKnown`) is independent.
- In `edge`, approvals use traffic lights: GREEN = read/think/ask, YELLOW =
  reversible or controlled actions with per-tool toggles, RED = overwrite/delete/
  data send/external server and is mandatory. Unknown tools fail closed to RED.
- `ApprovalManager` can persist always-approved rules under
  `pkmAssistant.security.alwaysApprovedRules`.
- `Logger.warn()` and `Logger.error()` mask sensitive values before writing to
  the console and to the file sink. Masking has **two independent filters**: known key
  SHAPES (`sk-`, `sk-or-v1-`, `gsk_`, `xai-`, `AIza`, `AKIA`, …) and sensitive FIELD NAMES
  (`Authorization`, `api_key`, `apiKey`, `x-api-key`, `*_key`, `token`, `secret`, `password`)
  in JSON, headers and plain text - so a provider not yet known to the shape filter is still
  covered by the field-name filter. `core/utils/http_request.ts` never logs `request_params`;
  it emits a single summary line (method, URL without query, status, duration, header NAMES).
- `SecretsStorage` migrates configured API keys into a local AES-GCM encrypted
  store guarded by a master password, replacing plaintext settings with
  non-enumerable runtime values and secret references.
- **Living artifacts: the agent never writes code blocks into artifacts -
  enforced in the ENGINE, not just the prompt.** `modules/artifacts/artifactParser.js`
  `applyPatch` rejects any `set_section`/`add_item` op whose text contains a triple-
  backtick code fence (`code_forbidden`). Executable code (dataviewjs, `dv.view`, …)
  can only come from user-authored TYPE templates, copied verbatim as opaque text at
  instance creation; the agent fills in data only (frontmatter, checkboxes, sections).
  This closes the prompt-injection → JS-execution-in-vault vector, so dataviewjs
  dashboards stay legal without a sandbox. The one exception is
  `ArtifactStore.importInstance` (the one-time migrator for pre-existing artifact data),
  which writes an existing artifact's body verbatim - that is preserving the user's own
  prior data, not agent authoring.
- **`todo` tool sits OUTSIDE the `artifacts` permission group's default-off.**
  Every other member of the `artifacts` group (`artifact_create/read/update/list`) is
  OFF for a fresh agent; `todo` is the sole exception (`DEFAULT_ENABLED_EXCEPTIONS` in
  `modules/agents/toolAxis.js`) and ships ON. Justification: `todo` writes only to the
  hidden `.pkm-assistant/artifacts/todo/` dotfolder (the agent's own scratch space),
  never to the user's visible vault, so it carries no data-exfiltration or
  unexpected-write risk; `artifact_*` (which create notes in the visible vault) stay
  conservatively OFF until the user enables them. Sub-agents do not receive `todo`.

## Known Limitations

- v2.0 uses the local master-password backend only. Native Obsidian secret
  storage is deferred until its public API and at-rest guarantees are
  verified.
- If secure storage is enabled and the user does not unlock with the master
  password, API keys stay unavailable until manual unlock.
- External MCP servers are not sandboxed and cannot be. A `stdio` server is an ordinary
  process with the user's privileges; an `http` server is someone else's service. The plugin
  controls **whether the agent may call them** (RED classification, mandatory first approval,
  per-tool "always allow", full argument preview in the modal, per-server kill switch, per-agent
  opt-in via `mcp_servers[]`) and **what leaves with the call** (`_invocation*` markers stripped),
  not what the server does once invoked. Trust is the user's explicit decision - see the root
  `SECURITY.md` section "Zewnętrzne serwery MCP - model zaufania".
- Symlink attacks are out of scope for `sanitizePath`; Obsidian vault adapter
  behavior must be audited separately before claiming symlink protection.

## Reporting Vulnerabilities

Report security issues through the repository security policy:
https://github.com/JDHole/pkm-assistant/security
