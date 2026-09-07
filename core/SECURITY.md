# Core Security Model

Sprint 13a documents the security boundary for PKM Assistant core. The goal is simple:
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
  Obsidian JavaScript heap (the old custom-JS sandbox was demolished in E3.1). The plugin-side
  boundary is classification, not containment: every such tool is registered with
  `source:'user'` and therefore classified RED unconditionally, so the first call always asks,
  and "always allow" is stored per concrete tool (`external.call::<server>__<tool>`).
- Model/tool logs and error objects that may contain API keys.
- Approval rules, because "always approve" can become too broad.
- API key settings in `.pkm-assistant/settings.json` / plugin data.
- Active note context ("Oczko"), including embedded vault images.

## Mitigations

- `core/security/keySanitizer.js` normalizes paths to NFC, decodes URL escapes,
  blocks traversal, absolute paths, UNC paths, null bytes, zero-width unicode,
  Greek/Cyrillic homoglyph-risk characters, Windows reserved filenames, and
  excessive path length.
- **One string for the gate and for the sink (K1, 2026-08-22).** `sanitizePath()`
  returns a CANONICAL form (no `./` segments, no `..`, no leading/trailing `/`, no
  `\`, no `%XX`). Canonicalization happens **once, before the gate**:
  `MCPClient._extractToolContext` canonicalizes the vault path and **replaces it in the
  call arguments**, so the tool's `execute` receives exactly the string that No-Go, the
  protected-file list and the whitelist judged. `PermissionSystem.checkPermission`
  repeats it as defense in depth; a path that cannot be canonicalized is denied outright
  (`Invalid path`, fail-closed, no user prompt).
  `AccessGuard._normalizeForDenyCompare` keeps No-Go entries and the compared path in the
  same lightweight normalization. Tools must NOT add their own path normalization —
  `validateVaultPath` inside `execute` is an idempotent repeat, not a second opinion
  (idempotent for real since K13 — see below).
- **Deny gates fold case, allow gates do not (K15, 2026-08-23).** No-Go used to compare
  byte for byte, so on Windows and macOS — where the file system does not distinguish
  case — `Projekty/prywatne/tajne.md` sailed through while `Projekty/Prywatne/tajne.md`
  was refused, for one and the same file; `.Obsidian/workspace.json` and `.TRASH/x.md`
  escaped `SYSTEM_NO_GO` the same way. No-Go was the only path gate that failed OPEN on
  case. It now uses `AccessGuard._normalizeForDenyCompare`, the same recipe as
  `isProtectedPath`: `\` → `/`, `NFC`, `toLowerCase()`. The ALLOW side (the `focusFolders`
  whitelist and a sub-agent's `scope.folders`) deliberately stays case-sensitive. Both
  directions are fail-closed — a deny that catches too much and an allow that admits too
  little. The price on a genuinely case-sensitive vault (Linux) is that banning
  `Prywatne/` also bans a neighbouring `prywatne/`; accepted knowingly. Pinned by
  `core/security/nogo_case.test.ts`.
- **The gate canonicalizes `image.*` too (K12, 2026-08-23).** The defense-in-depth pass in
  `checkPermission` originally covered `action.startsWith('vault.')` only, on the assumption
  that `image.*` carried a prompt rather than a path. K2 invalidated that assumption in the
  same batch of fixes: `generate_image` hands the gate its SAVE FOLDER and
  `add_text_to_image` its SAVE TARGET (`output_path`, or the DERIVED
  `<source>_text.<ext>`). A derived target is not literally the value of any argument
  field, so `MCPClient._canonicalizeToolContext` skips it — the gate is its only
  canonicalizing layer. Before the fix the same path got two different verdicts:
  `vault.write` + `./.pkm-assistant/x.png` → DENY, `image.generate` + the same string →
  ALLOW. Add a new file-touching action → make sure it is covered by this pass.
- **`sanitizePath` is computed to a FIXED POINT (K13, 2026-08-23).** One pass was not
  idempotent: `trim()` runs once on the whole string and `decodeURIComponent` peels a
  single encoding layer, so `'./ A/B.md'` → `' A/B.md'` → `'A/B.md'` and
  `'a%252e%252e/x'` → `'a%2e%2e/x'` → `'a../x'`. That broke the K1 contract in practice:
  the caller canonicalized ONCE and put that value into the tool arguments, while the gate
  canonicalized a SECOND time and ruled on a different string — the approval dialog showed
  `' A/B.md'` (a folder with a leading space, i.e. a NEIGHBOUR of `A`) while the gate
  admitted `'A/B.md'` under the `A/` whitelist. `sanitizePath` now loops until the value
  stops changing (5 passes max, then `null`, fail-closed), so
  `sanitizePath(sanitizePath(x)) === sanitizePath(x)` by construction. Semantic change:
  double-encoded input decodes all the way or is rejected — `'%252e%252e/x'` → `null`
  (it used to pass as an innocent-looking `%2e%2e` file), `'a%252e%252e/x'` → `'a../x'`
  (segment `a..` is a legal filename, not a traversal).
- **`AccessGuard.checkAccess` canonicalizes on entry (K13, 2026-08-23).** Now that
  canonicalization is idempotent, a third layer cannot hand back a different string, so the
  deepest guard stopped trusting its callers: it canonicalizes the target before anything
  else (including the sub-agent scope barrier) and denies `Invalid path` when the target
  has no canonical form. This matters because the `.pkm-assistant/` boundary inside
  `checkAccess` is a raw `startsWith` — one leading `./` used to walk past it whenever a
  caller forgot to canonicalize. Exception: `opts.targetIsVaultPath: false`, passed by
  `PermissionSystem` for the non-vault actions (`web.search`, `web.read`, `agent.message`,
  `delegate`, `external.call`) whose target is a query, a URL or a recipient — running
  those through `sanitizePath` would reject a search phrase starting with `C:\...`, a URL
  with a long query string or a mixed-script phrase. `core/security/path_canonical.test.ts`
  and `core/security/path_canonical_image.test.ts` pin the contract.
- **The folder whitelist measures PATHS only (K14, 2026-08-23).** K13 used
  `targetIsVaultPath: false` to skip canonicalization alone — No-Go, protected files, the
  `focusFolders` whitelist and a sub-agent's `scope.folders` still measured the query, URL
  or recipient as if it were a path. An agent in "assigned folders only" mode
  (`guidance_mode: false`) with a whitelist of `['A/']` therefore got
  `Path "how does X work" is outside the agent's workspace` for `web_search`, losing web
  search, page fetching, agent-to-agent mail and delegation entirely. `checkAccess` now
  returns `{ allowed: true, reason: 'non-vault-target' }` immediately when the flag is
  `false`, before any path check. Nothing else in `checkPermission` changes: risk
  classification, approvals and `disabled_tools` still gate these actions, and their real
  boundaries live in their own layers — the known-URL registry plus user consent for
  `web.*`, recipient visibility and mailbox limits for `agent.message`, scope intersection
  plus runtime depth for `delegate`, mandatory RED approval plus the server opt-in list for
  `external.call`. The flag still defaults to `true` (fail-closed for new callers);
  `core/security/non_vault_targets.test.ts` pins it.
- **No target is not a free pass (K2, 2026-08-22).** Every check below the entry point
  (No-Go, protected files, `focusFolders` whitelist, a sub-agent's `scope.folders`) sits
  behind `if (targetPath)`, so an action arriving with an empty target used to skip all of
  them — that is how `artifact_*` wrote into the vault unguarded and how
  `add_text_to_image` saved under an unchecked `output_path`. `PermissionSystem`
  now denies, fail-closed, any action in `TARGET_REQUIRED_ACTIONS` (`vault.write`,
  `vault.create`, `vault.create_folder`, `vault.delete`, `artifact.create`,
  `artifact.update`, `artifact.read`, `image.generate`) that arrives without a target;
  `admin_access` does not waive it. `vault.read` is deliberately excluded: the same action
  also carries `ask_user`, `todo`, `kom_list`/`kom_read` and `scope:'memory'` calls, which
  have no vault target by design (a root listing uses `'/'`, never an empty string).
  **Consequence for tool authors:** a tool that touches a file must supply the real path
  through its `contextExtractor` — computing it in the engine (as `artifact_*` now does)
  rather than leaving the field empty.
- **A remembered approval for "no target" covers only "no target" (K2).**
  `ApprovalManager.createPatternKey` writes an explicit `action::<bez-celu>` token instead of
  collapsing an empty target into the `action::*` wildcard, and a call without a target no
  longer matches a stored `action::*` rule. One click on "Always allow" for a call with no
  path can no longer auto-approve every later write by that agent.
- **A remembered approval never turns a model-supplied target into a wildcard (K22).**
  The target reaching `createPatternKey` is treated as literal text, so a tool argument the
  model writes — `delete {path:"*"}`, `kom_send {to:"*"}` — can no longer produce the broad
  `action::*` rule; `sanitizePath` additionally rejects `*` in vault paths, since it is a
  control character here (whitelist globs, rule keys) and never a real filename. Wildcard
  rules can now only come from a user's pre-existing settings; they keep working and are
  reported with one warning on load, for review under Settings → Security.
- `PermissionSystem` denies unknown actions regardless of autonomy mode.
- Autonomy (`yolo` / `edge` / `all`, chosen per chat — E2.3 D21) only controls
  whether the user is asked before an already-allowed action. `yolo` skips the
  approval modal and diff preview, but never grants a tool or widens its workspace.
  Autonomy is not a permission; the removed `yolo_mode` permission no longer exists.
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
  explicit `guidance_mode: false` and writes the change back to disk
  (AUD-security-077; changing that behaviour is a product decision, not a patch).
- **A delegated child never gets more than its caller (K11, 2026-08-22).** When a
  sub-agent delegates further (`max_delegation_depth` >= 2), the grandchild receives the
  **intersection** of folder scope and tool whitelist with the CALLING sub-agent, not with
  the main agent. `MCPClient` injects `_invocationScopeFolders` and `_invocationToolNames`
  as trusted runtime markers (deleted outside delegation, like `_invocationDelegationDepth`);
  `AccessGuard.intersectScopeFolders` keeps the narrower entry and returns an empty list
  for disjoint scopes, which `DelegateTool` turns into a fail-closed refusal.
- **`web_read` has its own consent gate (K11, 2026-08-22).** It maps to the `web.read`
  action with its own `APPROVAL_DEFAULTS` key (ask by default), its own profile toggle and
  its own modal wording. Silencing `web_search` no longer silences the one tool that sends
  a model-chosen address out to the network, and a persisted "always allow" rule is stored
  per action (`web.read::<url>`). The URL-provenance gate (`isUrlKnown`) is independent.
- In `edge`, approvals use traffic lights: GREEN = read/think/ask, YELLOW =
  reversible or controlled actions with per-tool toggles, RED = overwrite/delete/
  data send/external server and is mandatory. Unknown tools fail closed to RED.
- `ApprovalManager` can persist always-approved rules under
  `pkmAssistant.security.alwaysApprovedRules`.
- `Logger.warn()` and `Logger.error()` mask sensitive values before writing to
  the console and to the file sink. Since K8 (2026-08-22) masking has **two
  independent filters**: known key SHAPES (`sk-`, `sk-or-v1-`, `gsk_`, `xai-`,
  `AIza`, `AKIA`, …) and sensitive FIELD NAMES (`Authorization`, `api_key`,
  `apiKey`, `x-api-key`, `*_key`, `token`, `secret`, `password`) in JSON, headers
  and plain text — so a provider we do not know yet is still covered.
  `core/utils/http_request.ts` never logs `request_params`; it emits a single
  summary line (method, URL without query, status, duration, header NAMES).
- `SecretsStorage` migrates configured API keys into a local AES-GCM encrypted
  store guarded by a master password, replacing plaintext settings with
  non-enumerable runtime values and secret references.
- **Living artifacts (E2.9): the agent never writes code blocks into artifacts —
  enforced in the ENGINE, not just the prompt.** `modules/artifacts/artifactParser.js`
  `applyPatch` rejects any `set_section`/`add_item` op whose text contains a triple-
  backtick code fence (`code_forbidden`). Executable code (dataviewjs, `dv.view`, …)
  can only come from user-authored TYPE templates, copied verbatim as opaque text at
  instance creation; the agent fills in data only (frontmatter, checkboxes, sections).
  This closes the prompt-injection → JS-execution-in-vault vector, so dataviewjs
  dashboards stay legal without a sandbox. The one exception is
  `ArtifactStore.importInstance` (the one-time D4 migrator), which writes an existing
  artifact's body verbatim — that is preserving the user's own prior data, not agent
  authoring.
- **`todo` tool sits OUTSIDE the `artifacts` permission group's default-off (E2.9 D1).**
  Every other member of the `artifacts` group (`artifact_create/read/update/list`) is
  OFF for a fresh agent; `todo` is the sole exception (`DEFAULT_ENABLED_EXCEPTIONS` in
  `modules/agents/toolAxis.js`) and ships ON. Justification: `todo` writes only to the
  hidden `.pkm-assistant/artifacts/todo/` dotfolder (the agent's own scratch space),
  never to the user's visible vault, so it carries no data-exfiltration or
  unexpected-write risk; `artifact_*` (which create notes in the visible vault) stay
  conservatively OFF until the user enables them. Sub-agents do not receive `todo`.

## Known Limitations

- v2.0 uses the local master-password backend only. Native Obsidian secret
  storage is deferred to v2.1 until its public API and at-rest guarantees are
  verified.
- If secure storage is enabled and the user does not unlock with the master
  password, API keys stay unavailable until manual unlock.
- External MCP servers are not sandboxed and cannot be. A `stdio` server is an ordinary
  process with the user's privileges; an `http` server is someone else's service. The plugin
  controls **whether the agent may call them** (RED classification, mandatory first approval,
  per-tool "always allow", full argument preview in the modal, per-server kill switch, per-agent
  opt-in via `mcp_servers[]`) and **what leaves with the call** (`_invocation*` markers stripped),
  not what the server does once invoked. Trust is the user's explicit decision — see the root
  `SECURITY.md` section "Zewnętrzne serwery MCP — model zaufania".
- Symlink attacks are out of scope for `sanitizePath`; Obsidian vault adapter
  behavior must be audited separately before claiming symlink protection.

## Reporting Vulnerabilities

Report security issues through the repository security policy:
https://github.com/JDHole/pkm-assistant/security
