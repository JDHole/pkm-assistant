# modules/shell/

> **TS-5 (2026-07-31):** fizyczne źródła i testy tego modułu mają rozszerzenie `.ts`. Wzmianki `.js` niżej są historyczne albo pokazują celowo zachowane specifiery importów.

**Obudowa pluginu — UI framework.** Settings tab, sidebar nawigacja, custom workspace views, misc modale. To jest **"zlew" na UI** — wszystko co nie pasuje do dedykowanego modułu (chat/agents/artifacts/onboarding/komunikator) ląduje tu.

**Status:** 🚀 **ACTIVE.** Kod fizycznie w `modules/shell/` (Mapa-15, sesja 2026-04-26). Łącznie **~4,900 LOC** (~24 pliki `.js` top-level + ~7 w `sidebar/` + `.css`). ⚠️ Legacy starego frameworka (`settings_tab.js`, `connections_item_view.js`, `connections_codeblock.js`, `lookup_item_view.js`) i `sidebar/AgoraView.js` **skasowane** (patrz Historia) — opisy poniżej odzwierciedlają stan po tych kasacjach.

**Sprint Refaktoru — który mnie dotyka:**
- ✅ [Sprint 09 Artefakty v2 + chat housekeeping](../../Refaktor/Sprinty/SPRINT_09_Artefakty_v2_Chat_Housekeeping.md) **DONE (2026-05-01)** — Z1 wywałka `PlanActionBar`/`PlanEditModal` (PlanArtifact) + Z4 ApprovalModal `idea_review` rename (z `plan_action`) + SubAgentEditorModal default tools refresh (`idea_review`/`plan_review`/`chat_todo`). ProgressModal trafił do `modules/artifacts/` (a nie shell — read-only, należał do artefaktowego pakietu).
- ✅ [Sprint 04 MCP_PORZADEK_v1](../../Refaktor/Sprinty/SPRINT_04_MCP_Porzadek_v1.md) **DONE (2026-04-28)** — Z3 dodał:
  - `obsek_settings_tab.js` SEKCJA 10 "MCP Servers" — listing built-in (lock badge, read-only) + user (gear badge + Delete) + "+ Add new MCP server" button
  - `MCPServerEditorModal.js` — pattern z SkillEditorModal: Template dropdown (3 opcji) + slug + description + informacja o przypięciu konektora w profilu agenta + sandbox safety regex pre-save (block `require/fetch/process/eval/import/__dirname/__filename`). Generuje `.pkm-assistant/mcp-servers/<slug>/{server.js,manifest.json,README.md}` + reload servers + Notice success
  - Eksport `MCPServerEditorModal` w `modules/shell/index.js`
  - i18n PL+EN entries `settings.mcp_servers_*` + `modal.mcp_server_editor.*`
- ✅ [Sprint 10 Settings v2 + Backstage v2](../../Refaktor/Sprinty/SPRINT_10_Settings_v2_Backstage_v2.md) **DONE (2026-05-02, hotfix 2026-05-02)** — `SettingsRegistry` + `BackstageRegistry` frameworky (plug-in registration, hash routing `#settings/<id>`, sortowanie po `order`, sub-fields). 6 ACTIVE owner sekcji rejestrowanych z modułów (`core` NoGo+Zaawansowane+Klucze+Info, `models` Modele, `memory` Pamięć, `mcp` Web Search+MCP Servers, `agents` Agenci, `crystal-soul` Wygląd). 3 Backstage tabs registrowane przez `<module>/BackstageTab.js` (skills/sub-agents/mcp). `ApprovalManager` callback-injection (`setApprovalHandler`). `src/components/*` → `modules/ui-components/`. `getCategoryColor`/`deriveDelegateCategory` → `modules/crystal-soul/category_colors.js`. `CostTrackingModal` canvas chart tokenów/dzień. `profile_skills.js` partial split (overrides/picker/playbook). **Hotfix audytu (2026-05-02):** CS-4 `crystal-soul/utils/hash.js` wspólny + CS-2 `lightning: zap` alias + CS-9 `#4caf50/#ff0000/#e53e3e` → CSS vars + Z7 dup `CATEGORY_COLORS` cleanup w BackstageViews + per-module CLAUDE.md sync. **Hotfix settings split (2026-05-02):** 10 sekcji Settings ma realne `SettingsContent.js` w ownerach; `obsek_settings_tab.js` = shell + context + RoleEditorModal, bez DOM cutting.
- ✅ [Sprint 12 Skiny pluginu](../../Refaktor/Sprinty/SPRINT_12_Skiny_Pluginu.md) — migracja crystal/avatar/color callsite'ow na SkinManager API.
- [Sprint 01 Quick Wins + Security](../../Refaktor/Sprinty/SPRINT_01_Quick_Wins_Security.md) ✅ **DONE** (2026-04-27) — Z3 MCPClient broken dynamic import po Mapie-12 fix (B-1 🔴 → ✅ commit `fcef7a3`); plus Z1 ComfyUI key + Z7 wizard banner też dotknęły `obsek_settings_tab.js`

---

## Zawartość — co jest w shell

### Settings tab (shell rama + rejestry; kontrolki sekcji u ownerów przez `SettingsContent.js`)

| Plik | Rola |
|------|------|
| `pkm_settings_tab.ts` | `PkmSettingsTab` — shell ustawień: header/main layout (dwa kontenery po clean-room), SettingsRegistry wiring, `buildSectionContext()`. Kontrolki sekcji są w ownerach `SettingsContent.js` (S10 hotfix). E2.8: `RoleEditorModal` USUNIĘTY (rola rozpuszczona, A3); shell rejestruje 2 własne sekcje **Vault** (order 35) i **Prompt** (order 50) przez `renderVaultSection`/`renderPromptSection`. |
| `vault_settings.js` | **NEW E2.8 B1** — `renderVaultSection(container, ctx)`: grupy folderów (`settings.pkmAssistant.vaultGroups`) + opisy stref vaulta (globalny `VaultMap`). |
| `prompt_settings.js` | **NEW E2.8 B2** — `renderPromptSection(container, ctx)`: globalne defaulty promptów roboczych (`settings.pkmAssistant.promptDefaults`) + sekcje fabryczne + ostrzeżenia o kontraktach parserów. |
| `PluginSettingsTab.ts` | **clean-room / F2 (zaimplementowane, scalone 2026-09-06).** Baza rozszerzajaca Obsidian `PluginSettingTab`. Szkielet DWOCH kontenerow (`headerContainer` / `mainContainer`, klasy CSS `pkm-settings-header` / `pkm-settings-main`) i DWA stany ekranu: ladowanie (render czeka na `runtime.whenLoaded()`) albo gotowe. Guzik uruchomienia i trzeci stan zeszly razem z galezia mobile-defer. |
| `SettingsRegistry.js` | Framework rejestracji sekcji Settings (S10): plug-in registration, hash routing `#settings/<id>`, sort po `order`, sub-fields. |
| `BackstageRegistry.js` | Framework rejestracji zakładek Backstage (S10): moduły rejestrują tab przez `<module>/BackstageTab.js`. |

> `settings_tab.js` (martwa wczesna zakładka ustawień starego frameworka) **skasowany** razem z resztą tamtego legacy.

> **AUD-dead-code-256 (2026-09-02): `SettingsRegistry.render()` malował dwie równoległe
> przestrzenie nazw klas** — sześć `pkm-settings-v2*` (root + `__layout`/`__sidebar`/`__content`/
> `__tab`/`__subfields`) bez ani jednej reguły CSS w żadnym z sześciu arkuszy repo, obok żywych
> `pkm-settings-*` (`layout`/`nav`/`content`/`nav__btn`, `src/styles.css:831-847`), które
> faktycznie stylowały ekran. Relikt przerwanego rename'u sprzed migracji na `src/styles.css`
> (patrz `git show c0fbfe61`) — `pkm-settings-v2*` nigdy nie miało reguły, nawet inline. Naprawa:
> `render()` maluje dziś WYŁĄCZNIE żywe nazwy; `pkm-settings-v2__subfields` (jedyna bez dublera)
> stracił klasę w całości zamiast dostać kolejną martwą. Strażnik:
> `SettingsRegistry.pkmSettingsV2.test.ts`.

### Sidebar

```
AgentSidebar.js          # ItemView extends, registered as 'pkm-agent-sidebar'
AgentSidebar.css         # stylesheet
sidebar/
├── SidebarNav.js        # stack-based nav controller (push/pop/replace, scroll preservation, cleanup hooks)
├── HomeView.js          # agent grid + komunikator + zaplecze sections
├── BackstageViews.js    # zakładki Zaplecza: Skille + Sub-Agenci (2 taby; „Narzędzia MCP" OUT w E2.8 A4/S27), Crystal Soul dual color system
├── DetailViews.js       # skill / sub-agent detail views
├── TriggersView.js      # zakładka Triggery (S05.5) — klikalne sub-agenty/skille/tools
├── triggers_collectors.js # zbieranie dostępnych triggerów per agent
├── backstage_rows.js    # (S27 D7) czysta definicja wierszy sekcji „Zaplecze" na Home + liczniki
└── SidebarViews.css     # stylesheet
```

> `sidebar/AgoraView.js` (1,302 LOC, pełen panel Agora) **skasowany** razem z modułem agora w Sprincie 08 (Z7); routing `agora`/`agora-project-detail` wycofany z `SidebarNav`.

> **Widok `sub-agent-runs` (panel biegów subów) ŻYŁ JEDEN DZIEŃ — 2026-08-15 OUT.** F3
> zarejestrował go tu rano (render z `modules/sub-agents`, wiersz „Biegi subów" na Home,
> licznik „w biegu/czeka", CSS `pkm-subruns-*`, subskrypcja `subTaskRegistry.events`);
> wieczorem Kuba zdecydował, że biegi subów należą do AGENTA i SESJI, więc podgląd przeniósł
> się do **okna czatu** (pasek pod zakładkami — `modules/chat/chat/subTaskStrip.ts`).
> Z shella zniknęły: rejestracja widoku i import `renderSubTaskRunsView`, cała subskrypcja
> rejestru (`_subscribeSubTaskRuns` + odpinacze + timer), wiersz Home z licznikami
> `subRunsRunning`/`subRunsWaiting` i blok CSS. **`count` w `backstage_rows` wrócił do
> `number | null`** — string („2/1") był wyłącznie dla tego wiersza.

`AgentSidebar` subskrybuje `agentManager.on(...)` z 200ms debounce dla komunikator events.

### Modale (~10 plików)

Każdy `extends Modal` z Obsidiana (onOpen/onClose lifecycle). Promise-based result pattern.

| Plik | LOC | Co robi |
|------|-----|---------|
| `ApprovalModal.js` | ~330 | Approval/deny modal dla AccessGuard. Action type badge, content preview, deny reason. Eksportuje `requestApproval(app, action)` używane przez `core/security/ApprovalManager`. **S33 Z3:** dla `external.call` renderuje `action.externalArgs` jako JSON (indent 2, cięcie ~1500 znaków, „(bez argumentów)" gdy pusto) — user widzi, co dokładnie leci do cudzego serwera. Mechanika „Zawsze zezwalaj (to narzędzie)" / `approvalTarget` NIETKNIĘTA. |
| `MCPServerEditorModal.js` | ~330 | Dodaj/edytuj ZEWNĘTRZNY serwer MCP (nazwa, id, transport stdio/http + pola, autostart, ostrzeżenie zaufania per transport). Zapis do ustawień pluginu (`data.json`), nie do vaulta — komenda/env/nagłówki niosą sekrety. **S33 Z3:** guzik „Sprawdź połączenie i pokaż narzędzia" (`ExternalMcpManager.previewTools` na configu z pól, bez zapisu; efemeryczne, nic nie rejestruje) + `enabled` zachowywane przy edycji (kill-switch usera nie odwraca się po edycji). Dostęp per agent żyje wyłącznie w `mcp_servers[]`. |
| `AgentPresentationModal.js` | 140 | Karta prezentacji agenta — Crystal Soul styling, info read-only. |
| `SendToAgentModal.js` | 132 | Selektor agenta + textarea do wysłania wiadomości. |
| `AgentDeleteModal.js` | 103 | Confirmation modal usunięcia agenta z listą rzeczy do zniszczenia. E2.8 A6: guard `agent.isBuiltIn` — dla Jaskra przycisk delete `disabled` (ochrona Jaskra ×3: modal + `HomeView` kosz ukryty + `AgentManager.deleteAgent` throw). |
| `InlineCommentModal.js` | 88 | Inline comments w czacie. |
| `CostTrackingModal.js` | — | Wykres kosztów tokenów/dzień z `.pkm-assistant/cost_log.jsonl` (S03 Z17). |
> Modal + logika podglądu zużycia limitu subskrypcji ChatGPT z lokalnego mostu API
> (wprowadzone S32 Z3) **SKASOWANE w całości** (2026-09-07) — oba pliki funkcji, testy,
> klucze i18n i CSS. Zero wołaczy nie zostało.

> `DraftsListModal.js` **SKASOWANY w S36b** (2026-07-30) razem z całą rodziną draftów — patrz
> sekcja na końcu pliku.

> **S31 — 8 plików WYPROWADZONYCH z shella do właścicieli** (przenosiny 1:1, zero zmian logiki).
> Każdy z nich miał wołaczy wyłącznie w JEDNYM module niższym, a mieszkanie w shellu zmuszało
> ten moduł do importu z barrela shella (krawędź „w górę").
> - `SkillEditorModal.js` → `modules/skills/` (barrel skilli wydaje go leniwym `loadSkillEditorModal()` — statyczny `obsidian` nie może wejść do barrela)
> - `SubAgentEditorModal.js` → `modules/sub-agents/` (analogicznie: `loadSubAgentEditorModal()`)
> - `SaveSessionModal.js`, `SessionCloseModal.js`, `OpenSessionModal.js` → `modules/chat/` (wewnętrzne, w żadnym barrelu)
> - `ConsolidationProgressModal.js` + `archiveReviewRenders.js` + `consolidationRunState.js` (+ test) → `modules/chat/` obok `consolidationRunner.js` (wewnętrzne)
> - `DiffModal.js` → `modules/ui-components/` (wołacz: `modules/tools/MCPClient.js`)
> - `sidebar/backstage_helpers.js` → `modules/ui-components/` (wołacze: zakładki Zaplecza w skills + sub-agents)

### Custom Workspace Views (1 plik)

| Plik | Co robi |
|------|---------|
| `ReleaseNotesView.ts` | `ReleaseNotesView` — viewType `pkm-release-notes-view`. Otwiera tab z markdown z `releases/latest_release.md`. Dziedziczy z `PluginItemView` (importowanego z `modules/ui-components/`); statyka `openForVersion(workspace, version)` woła bazowe `open(workspace, {version})` (decyzja A4 — jedna sygnatura `open` w całym repo). |

> **S31 (2026-07-30): baza widoków wyprowadzona do `modules/ui-components/`** (dziś `PluginItemView.ts`, wtedy `ObsekItemView.js`). Dziedziczą
> z niego DWA moduły (chat → `ChatView`, shell → `ReleaseNotesView`), więc jego dom jest tam,
> gdzie klocki dla ≥2 modułów. Shell trzyma tylko re-export kompatybilnościowy. Skutek uboczny:
> `chat` przestał importować barrel shella, więc padł hotfix `da5b675` (komentarz-strażnik
> o kolejności eksportów w `index.js` — nie jest już potrzebny).

> Legacy starego frameworka: `connections_item_view.js`, `connections_codeblock.js`, `lookup_item_view.js` **skasowane** (Sprint 02, Opcja B — wycofane razem ze starym frameworkiem / panelem Connections panel).

---

## Public API — `modules/shell/index.js`

Poza shell wolno importować TYLKO przez `index.js`. Wewnątrz shell pliki importują się swobodnie.
**Stan bieżący: 7 eksportów** (zmierzone 2026-08-27 z bloków `export { ... } from` w index.ts).
Po przycince S30 Z4 barrel miał 21 (było 38) — S31 (przenosiny modali/widoku/helperów do
właścicieli) + D6 (kasacja `ArchiveModal`) + S35 (kasacja re-exportu bazy widoków) wycięły
kolejne 14, patrz noty niżej.

**Settings:**
- `PkmSettingsTab`

> **S31: helpery Zaplecza przeniesione do `modules/ui-components/index.js`.**
> `renderFilterBar`, `getCategoryLabel`, `renderUseAtAgentButton`, `renderTemplateVersionBadge`,
> `renderCardAction` (dawny `sidebar/backstage_helpers.js`) już NIE są w barrelu shella — wołają
> je stamtąd zakładki Zaplecza w `modules/skills` i `modules/sub-agents` (patrz nota „S31 — 8
> plików WYPROWADZONYCH" wyżej). Kto potrzebuje tych helperów spoza shella, importuje
> `modules/ui-components/index.js`, nie stąd.

**Sidebar:**
- `registerAgentSidebar`, `openAgentSidebar` (funkcje-fasady; klasa widoku zostaje wewnątrz)

**Custom views:**
- ~~baza widoków~~ — re-export kompatybilnościowy (S31) **SKASOWANY w S35** (0 konsumentów). Baza widoków żyje wyłącznie w `modules/ui-components/`; shell bierze ją stamtąd wprost tak samo jak chat
- `ReleaseNotesView`
- (legacy `ConnectionsItemView`/`LookupItemView`/rejestrator starego codeblocka — **skasowane** w Sprincie 02, już nie eksportowane)

**Modale:**
- `requestApproval` (funkcja-fasada dla `core/security/ApprovalManager`)
- `InlineCommentModal`, `SendToAgentModal`
- `ArchiveModal` **skasowany w D6** (2026-07-30) razem ze starym torem konsolidacji; `MigrationModal` **przeniesiony do `modules/agents/`** w S31 (jedyny wołacz to `AgentManager`, więc jest tam wewnętrznym szczegółem — nie ma go w żadnym barrelu)
- **S31 — OUT z barrela** (definicje przeniesione do właścicieli, patrz nota pod tabelą modali):
  `SkillEditorModal` (→ skills), `SubAgentEditorModal` (→ sub-agents), `SessionCloseModal` /
  `SaveSessionModal` / `OpenSessionModal` / `ConsolidationProgressModal` (→ chat),
  `DiffModal` + prymitywy `backstage_helpers` (→ ui-components)

> ### S30 Z4 — 17 eksportów WYCIĘTYCH z barrela
>
> Zero konsumentów spoza shella (weryfikacja: skan WSZYSTKICH importów barrela w repo,
> statycznych i dynamicznych). **Definicje i pliki ŻYJĄ — zmieniły się tylko drzwi.**
>
> | Wycięte | Dlaczego bezpiecznie |
> |---|---|
> | `PluginSettingsTab` | rozszerza ją `pkm_settings_tab.ts` **wewnątrz** shella |
> | `SettingsRegistry`/`SettingsRegistryClass`, `BackstageRegistry`/`BackstageRegistryClass` | moduły dostają rejestr **ARGUMENTEM** — `registerSettings(registry, plugin)` / `registerBackstage(registry, plugin)`. Nikt ich nie importuje |
> | `renderAgentLinks`, `agentHasSubAgent` | helpery Zaplecza bez wołaczy poza shellem |
> | `AgentSidebar` (klasa) + `AGENT_SIDEBAR_VIEW_TYPE` | wołacz wchodzi przez `registerAgentSidebar`/`openAgentSidebar` (zostają) |
> | `ApprovalModal` (klasa) | wołacz wchodzi przez `requestApproval` (zostaje) |
> | `CostTrackingModal` | shell otwiera go **lokalnym leniwym importem** (`pkm_settings_tab.js:145`) |
> | `MCPServerEditorModal` | `pkm_settings_tab.js:5` importuje go lokalnie i **wstrzykuje przez `ctx`** do `SettingsContent.js` ownerów |
> | `AgentDeleteModal`/`openAgentDeleteModal`, `AgentPresentationModal`/`openAgentPresentationModal` | `sidebar/HomeView.js` importuje fasady **lokalnie** (`'../AgentDeleteModal.js'`) |
> | `DraftsListModal` | 🔴 martwy w całości — **plik SKASOWANY w S36b**, patrz niżej |
>
> 🔴 **`DraftsListModal.js` NIE MIAŁ ANI JEDNEGO WOŁACZA W CAŁYM REPO.** Nie chodziło tylko
> o eksport: nikt nie tworzył tej klasy. Opis w jej nagłówku obiecywał dwa wejścia —
> `_checkRecoverableDrafts` przy starcie pluginu i slash `/drafts` w czacie — **ani jedno
> nie istniało** (grep: `DraftsList` → tylko definicja + eksport; `/drafts` → brak komendy
> w `SlashCommandsRegistry`). W Z4 wycięte zostały tylko drzwi (eksport z barrela).
> ✅ **Domknięte w S36b (2026-07-30):** plik + zaplecze + i18n + CSS w koszu — patrz sekcja
> „S36b update" na końcu pliku.

---

## Zależności

**Importuje z** — lista wyprostowana grepem w S30 Z4 (wcześniej wymieniała importy, których
w kodzie NIE MA: `HiddenFileEditorModal`, `CrystalGenerator`, `pickColor`, `COLOR_GROUPS`,
`getCategoryColor`, `deriveDelegateCategory`, `getDefaultModelForRole`, `isLocalPlatform`,
`TOOL_DESCRIPTIONS`, `AttachmentManager`, `MentionAutocomplete`, `SubAgentBlock`,
`ThinkingBlock`, `WEB_SEARCH_PROVIDERS`, `PROVIDER_SIGNUP_URLS`):

- `core/i18n` (`t`, `setLocale`)
- `core/security/keySanitizer` (`maskKey`)
- `core/security/AccessGuard` (ApprovalModal / guardy w modalach)
- `core/utils/Logger` (`log`)
- `modules/agents` — `Agent`, `renderAgentProfileView`
- `modules/chat` — `insertInlineTriggerMarker` (leniwym `import()` z `TriggersView`). **S31: `DEFAULT_COMPRESSION_PROMPT` już NIE stąd** — `prompt_settings.js` bierze go z `config/default_prompts.js` (to była statyczna krawędź shell→chat zamykająca cykl)
- `config/default_prompts.js` — `DEFAULT_COMPRESSION_PROMPT` (S31)
- `modules/crystal-soul` — `UiIcons`, `SkinManager`, `IconGenerator`, `SvgHelper`, `setSvg`, `setSvgLabel`, `getColorByHex`, `hexToRgbTriplet`, `registerSettings`
- `modules/komunikator` — `renderCommunicatorView`, `isKomunikatorEnabled`
- `modules/memory` — cały pakiet etykiet przebiegu konsolidacji (`stepLabel`/`stepDetail`/`stepStatusIcon`/`stepStatusLabel`/`stepDurationMs`/`isFallbackStep`/`formatDuration`/`formatUsageLine`/`buildRunSummary`/`summaryToText`) + `ConsolidationRun`/`STEP_KIND`/`STEP_STATUS`/`memoryOpsCenter` + `CostLog` + 4 fabryczne prompty robocze + `registerSettings`
- `modules/models` — `getModelsForRole`, `registerSettings`
- `modules/prompts` — `FACTORY_DEFAULTS`
- `modules/skills` / `modules/sub-agents` / `modules/tools` / `modules/web` — `registerBackstage` / `registerSettings` (+ `getVisibleSubAgentsForAgent`, `DEFAULT_SUBAGENT_FRAME_PROMPT`, `ExternalMcpManager`)
- `modules/ui-components` — `TOOL_INFO`, `getToolIcon` (moved from `src/components/` in Sprint 10 Z12)

> `src/utils/pause_controls` (legacy `apply_pause_state`/`toggle_pause_state`) **skasowany** w E1.6 A1 — już nie importowany.

**Importowany przez:**
- `src/main.js` — importy z barrel: `ReleaseNotesView`, `PkmSettingsTab`, `registerAgentSidebar`, `openAgentSidebar`, `SendToAgentModal`, `InlineCommentModal`, modale sesji/pamięci itd. (legacy `ConnectionsItemView`/`LookupItemView`/rejestrator starego codeblocka **już nie importowane** — skasowane w Sprincie 02)
- `core/security/ApprovalManager.js` — `requestApproval` przez barrel (zamknięcie TODO core/ z Mapy-15)
- (`modules/chat`, `modules/skills`, `modules/sub-agents`, `modules/tools` — **już NIE**;
  po S31 ŻADEN moduł niższy nie importuje z shella, ani statycznie, ani dynamicznie.
  Zostały wyłącznie adnotacje typów JSDoc `import('../shell/sidebar/SidebarNav.js')`
  w `SkillDetailView`/`SubAgentDetailView` — to nie jest import w runtime)

**✅ FIXED Sprint 01 Z3 (2026-04-27):**
- `modules/mcp/MCPClient.js:349,390` — `await import('../views/DiffModal.js')` → `await import('../shell/index.js')` (DiffModal przez barrel po Mapie-15). Commit `fcef7a3`.

---

## Settings tab — sekcje rejestrowane przez ownerów (po S10)

Po Sprincie 10 (Settings v2) shell trzyma tylko ramę + `SettingsRegistry`. Poszczególne sekcje są **u ownerów** jako `<module>/SettingsContent.js` i rejestrują się przez `registerSettings(...)`. Hash routing `#settings/<id>`, sort po `order`, sub-fields.

| Sekcja | Owner (`SettingsContent.js`) |
|---|---|
| Modele | `modules/models` |
| Pamięć i kontekst | `modules/memory` |
| **Vault** (grupy folderów + strefy) — **NEW E2.8 B1**, order 35 | `modules/shell` (`vault_settings.js`, shell-owned — byt vaultowy, nie agents) |
| Web Search + Image Gen + STT + MCP Servers | `modules/tools` + `modules/web` (Web Search) |
| **Prompt** (globalne defaulty promptów roboczych) — **NEW E2.8 B2**, order 50 | `modules/shell` (`prompt_settings.js`, shell-owned) |
| Wygląd (Skiny) | `modules/crystal-soul` |
| NoGo + Zaawansowane + Klucze API + Informacje | `core` (`core/SettingsContent.js`) |

> **E2.8:** sekcja **„Agenci / Role"** USUNIĘTA — `modules/agents/SettingsContent.js`+`SettingsSection.js` skasowane (rola rozpuszczona A3, archetyp skasowany A1; sterowanie agentem żyje w panelu `AgentProfileView`, nie w Settings). Vault + Prompt to jedyne sekcje rejestrowane **bezpośrednio przez shell** (nie przez owner-moduł), bo to byty globalne/vaultowe.

`pkm_settings_tab.js` = shell + `buildSectionContext()` (E2.8: `RoleEditorModal` OUT), **bez DOM-cutting** (hotfix S10). Wcześniejszy pomysł osobnego folderu `modules/shell/settings/` NIE został zrealizowany — sekcje mieszkają u ownerów (poza shell-owned Vault/Prompt).

---

## Kluczowe decyzje

- **Shell jako "zlew" na UI** — gdzie nie ma sensu osobnego modułu, tutaj. Świadomy kompromis.
- **`AgentSidebar` w shell, nie w `modules/agents/`** — bo to widget UI w Obsidianie (registered jako sidebar view), nie logic agentów. Logic w agents/.
- **`ApprovalManager` (core/security) → `ApprovalModal` (shell)** — pre-existing wyjątek od ADR 003. **Mapa-15 zaktualizowała na barrel** (`core/security/ApprovalManager.js` importuje przez `modules/shell/index.js`, nie deep). Rozluźnia ścisłość ADR 003 ale szanuje "jedyne drzwi" zasadę. UI modal jest fundamentem dla approval flow.
- **Baza widoków (`PluginItemView`) jako klasa cross-modułowa** — używana przez ChatView (modules/chat) jako baza. Historycznie mieszkała tutaj („view-related, nie infra, więc shell"). **S31 poprawił adres:** skoro dziedziczą z niej dwa moduły, jej dom to `modules/ui-components/` (klocki dla ≥2 modułów). **S35 dociął:** re-export kompatybilnościowy w barrelu shella skasowany — jedno źródło, zero duplikatu drzwi.

---

## Gotchas (miny)

### 1. `pkm_settings_tab.js` po S10 hotfix: shell, nie monolit

**Status po hotfixie S10:** 10 sekcji Settings mieszka w `SettingsContent.js` u ownerów modułów. Shell trzyma tylko ramę, context i modal roli.

### 2. `ApprovalModal` import z core/security/ApprovalManager

Cykliczny risk — `ApprovalManager` (w core) importuje z `modules/shell/index.js` (przez barrel). Shell nie może importować z `ApprovalManager` (bo zrobiłby cykl). Trzymaj się reguły: shell → core OK, core → shell tylko przez barrel.

### 3. `MCPClient.js` dynamic import broken po Mapie-12 ✅ FIXED Sprint 01 Z3 (2026-04-27)

~~`await import('../views/DiffModal.js')` w `modules/mcp/MCPClient.js:349,390` celuje w `modules/views/` które nie istnieje. Cichy bug — strzela tylko gdy DiffModal ma być pokazany przed `vault_write`. Naprawa w Refaktorze.~~

**Naprawione:** linie 349+390 → `await import('../shell/index.js')` (DiffModal przez shell barrel). Commit `fcef7a3`.

### 4. Modale CSS w plain `.css`

Nie używają Obsidian CSS variables consistently. Theming/accessibility ucierpi. Migracja na CSS vars w post-MAX.

### 5. `AgoraView` — SKASOWANY (S08 Z7)

Cały panel Agora (1,302 LOC) usunięty razem z modułem `agora/` w Sprincie 08. Routing `agora`/`agora-project-detail` wycofany z `SidebarNav`. (Historyczny gotcha „DEPRECATED ale ŻYWY" jest już nieaktualny — pliku nie ma na dysku.)

### 6. Legacy starego frameworka — SKASOWANE (Sprint 02)

`settings_tab.js`, `connections_item_view.js`, `connections_codeblock.js`, `lookup_item_view.js` usunięte razem ze starym frameworkiem bazowym i embedding reset. Eksporty wycofane z `index.js` (restore w v3.0 wg komentarza w barrelu).

### 7. Crystal Soul dual color system w `BackstageViews`

CSS vars `--cs-user-color` (UI accents) + `--cs-category-color-rgb` (per-card). 12 kategorii skilli (productivity, writing, analysis, system, creative, general, vault, memory, communication, planning, search, mixed) → mapowane na hex z palety Crystal Soul (Antyczne Złoto, Głęboki Szafir, Turkus, etc.). Spójne z `modules/crystal-soul`.

### 8. Baza widoków — dług nazewniczy SPŁACONY (S31 + S35)

Dawny `ObsekItemView` nosił ślady starego frameworka bazowego (domyślna ikona i usuwanie starego prefiksu z nazw ikon). **S31** przeniósł plik do `modules/ui-components/`, **S35** przemianował go (ikona `pkm-icon`), a **clean-room / F2** przepisał na `PluginItemView` i skasował re-export z barrela shella. Mina zamknięta — szczegóły klasy patrz `modules/ui-components/CLAUDE.md`.

### 9. Sprzątanie widoku sidebara idzie przez `SidebarNav.dispose()` (AUD-bledy-045)

Widok wiesza swoje odpięcia na `nav._currentCleanup` (Komunikator: `agentManager.on(...)` + budzik renderu 150 ms). Ten uchwyt wołał WYŁĄCZNIE `_render()` przy przełączeniu widoku, więc zamknięcie panelu zostawiało nasłuch do końca sesji Obsidiana, a ponowne otwarcie budowało NOWY `SidebarNav` (po pięciu cyklach każda wiadomość mieliła listing skrzynek pięć razy, na odpiętym DOM-ie). Dziś `AgentSidebar.onClose()` woła `this.nav?.dispose?.()` — idempotentne, fail-soft. **Nowy widok sidebara rejestruje sprzątanie tam samo**; nie dokładaj własnej ścieżki zamykania.

---

## TODO

→ matryca znalezisk: [`Refaktor/01_Surowizna_TODO_Wizje.md`](../../Refaktor/01_Surowizna_TODO_Wizje.md) — backlog modułu.

**Najpilniejsze (z Mapy-15):**
- ✅ Settings split DONE (S10 hotfix 2026-05-02): kontrolki przeniesione do per-module `SettingsContent.js`; `pkm_settings_tab.js` ma 395 LOC (z 1800 przed hotfixem, -1405 LOC).
- ✅ Wywałka plików legacy starego frameworka (`settings_tab.js`, `connections_item_view.js`, `connections_codeblock.js`, `lookup_item_view.js`) — **DONE** (skasowane, brak na dysku; eksporty wycofane z `index.js`).
- 🟡 Modale CSS na Obsidian CSS variables (theming/accessibility) — częściowo done w Sprint 10 Z4 (error/recording → `var(--text-error)`); brand colors zostają per Skin (S12)
- ✅ `src/components/ToolCallDisplay` → `modules/ui-components/` (Sprint 10 Z12)
- ✅ Cost tracking historical view w settings (Sprint 10 Z14)

---

## Powiązane

- **Wszystkie moduły** — settings dotyka każdego (per-module settings w monolicie)
- `core/security/ApprovalManager.js` — używa `requestApproval` z shell (przez barrel)
- `modules/chat` — **nie importuje już z shella** (S31: modale sesji i trio konsolidacji przeniesione do chatu, baza widoków do `modules/ui-components/`); shell wciąż renderuje sidebar, z którego chat się otwiera
- `modules/agents` — sidebar renderuje agent grid + AgentProfileView (panel v3: 8 zakładek), modale `AgentDelete` (guard Jaskra) / `Presentation`. E2.8: sekcja Settings „Agenci/Role" + `RoleEditorModal` + archetype dropdown OUT
- `modules/crystal-soul` — sidebar i settings używają UiIcons / CrystalGenerator / pickColor / colors palette
- (Agora removed in S08 Z7 — `AgoraView.js` deleted z `sidebar/`, routing wycofany z SidebarNav)

---

## Historia

- **Sesja 19** — pierwszy ObsekSettingsTab (mały)
- **Sesja 47-54** — Crystal Soul v2 → AgentSidebar redesign
- **Sesja 100** — wyciągnięcie zależności zewnętrznych: S2 (`ObsekItemView`) i S3 (`ObsekSettingsTabBase`)
- **Sesja 107** — modularyzacja sidebar (HomeView/BackstageViews/DetailViews/AgoraView)
- **Sesja 116** — public release v1.2.1
- **Sesja 128 D6** (2026-04-25) — placeholder rozbudowany do wzorca
- **Mapa-15** (2026-04-26) — **TA MIGRACJA**. 21 plików z `src/views/` + 5 z `src/views/sidebar/` przeniesione do `modules/shell/`. `index.js` barrel z 22 eksportami. Update importerów: `main.js` (8), `ApprovalManager` (deep→barrel, zamknięcie TODO core/), `chat_view.js` (1), `chat_session.js` (1). 11 znalezisk wpisanych do TODO. 4 Nauka cards w Hogwarcie. Build 8.1MB, 58/58 tests PASS.
- **E1.6 docs-freshness** (2026-07-21) — CLAUDE.md zsynchronizowany ze stanem na dysku po kasacjach: usunięto opisy `AgoraView.js` (skasowany S08), legacy `settings_tab.js`/`connections_item_view.js`/`connections_codeblock.js`/`lookup_item_view.js` (skasowane S02) i zależności `src/utils/pause_controls` (skasowany E1.6 A1). Dopisano realne pliki: `SettingsRegistry`/`BackstageRegistry`, modale sesji/pamięci (`SaveSessionModal`/`OpenSessionModal`/`ArchiveModal`/`MigrationModal`/`CostTrackingModal`/`DraftsListModal`), sidebar `TriggersView`/`triggers_collectors`/`backstage_helpers`. Sekcja „Settings tab" przepisana na architekturę S10 (sekcje u ownerów przez `SettingsContent.js`, bez fikcyjnego folderu `shell/settings/`). LOC 6,579/21 plików → ~4,900/~31 plików.

## E2.8 update (2026-07-23) — Settings Vault/Prompt + Zaplecze 2 taby + guard Jaskra
- **Settings→Vault (B1) i Settings→Prompt (B2) — nowe, shell-owned.** `vault_settings.js` (`renderVaultSection`) = grupy folderów (`settings.pkmAssistant.vaultGroups`, CRUD z autouzupełnianiem + access per folder) + opisy stref vaulta (globalny `VaultMap`). `prompt_settings.js` (`renderPromptSection`) = globalne defaulty promptów roboczych (`settings.pkmAssistant.promptDefaults`: compression/save_session/archive/summary/subagent_frame) + sekcje fabryczne + ostrzeżenia o kontraktach parserów. Obie rejestrowane przez `SettingsRegistry.register` **bezpośrednio w `obsek_settings_tab.js`** (order 35 między Pamięć/Web, order 50 po Web) — nie przez owner-moduł (to byty globalne/vaultowe). `AccessGuard.setVaultGroups` żywi referencje `{group}` w focus_folders.
  ⚠️ **AUD-dead-code-124 (2026-09-02): szósty slot, `brief_prompt`, WYCIĘTY** z `WORK_PROMPTS`
  tutaj i z `WORK_PROMPT_KEYS` (`core/utils/workPromptResolver.ts`) — zero czytelników od
  skasowania `ContextSessionGenerator` w E2.9 fazie D, mimo że kontrolka w Settings dalej
  obiecywała działanie w czasie teraźniejszym. `DEFAULT_BRIEF_PROMPT` skasowany z
  `modules/memory/workPrompts.ts` (patrz `modules/memory/CLAUDE.md`). Stara wartość
  `promptDefaults.brief_prompt` w `settings.json` usera jest nieszkodliwie ignorowana.
- **Sekcja Settings „Agenci / Role" + `RoleEditorModal` USUNIĘTE (A1/A3).** `modules/agents/SettingsContent.js`+`SettingsSection.js` skasowane; `obsek_settings_tab.js` nie importuje już `registerAgentsSettings` ani `RoleEditorModal`. Sterowanie agentem = panel `AgentProfileView` (8 zakładek), nie Settings.
- **Zaplecze = 2 taby (A4/S27).** `BackstageViews` rejestruje tylko Skille + Sub-Agenci; tab „Narzędzia MCP" wycofany (`McpBackstageTab`/`BackstageTab` z `modules/mcp/` skasowane, import + case `getTabCount('tools')` OUT). Backward-compat routingu `minions`/`masters` → sub-agents bez zmian.
- **Guard Jaskra w `AgentDeleteModal` (A6).** `agent.isBuiltIn` → przycisk delete `disabled` (jedna z 3 warstw ochrony; pozostałe: `HomeView` kosz ukryty + `AgentManager.deleteAgent` throw).
- **`SubAgentEditorModal` obsługuje zakładkę Ekipa (C6).** `profile_team.js` (modules/agents) importuje go przez barrel shell do dodawania „od zera" + edycji członka ekipy.


## E2.9 FAZA D update (2026-07-23) — context-session out + resztki review
- **`SessionCloseModal`:** checkbox „Kontekst sesji jako artefakt" + opcja `createContextArtifact` USUNIĘTE (A18 — ruch przejęły propozycje „Na teraz" w `/save session`). Kształt zwrotu `prompt()` → `{choice, options}` zachowany (`_options = {}`).
- **`ApprovalModal`:** case/label `todo.save` + gałęzie desc `idea_review`/`plan_review` usunięte (aliasy remapują na `artifact_create` PRZED approvalem).
- **`SubAgentEditorModal`:** domyślne narzędzia — researcher `search/read/list` (prymitywy E2.6), strategist `artifact_create/write` (było `idea_review/plan_review/chat_todo/vault_write`).

## A1–A2 security UI update (2026-07-24)

- `MCPServerEditorModal` nie pokazuje już fałszywej whitelisty „allowed agents” i
  nie zapisuje `default_roles`. Po utworzeniu wyjaśnia realną ścieżkę:
  profil agenta → Umiejętności → Konektory (`mcp_servers[]`).
- Profil agenta → Zaawansowane renderuje ostrzegawczy toggle
  `admin_access` („Totalna wolność”). CSS `cs-perm-row--danger` /
  `cs-admin-access-warning` celowo odróżnia go od zwykłych ustawień.

## S29 update (2026-07-29) — „Puls pamięci": nieblokujący modal przebiegu + wspólne rendery review

- **`ConsolidationProgressModal.js` (NOWY)** — okno przebiegu konsolidacji pamięci. Checklista
  WSZYSTKICH kroków (dedup + N paczek L1 + L2 + L3) z ikoną statusu (✅/🔄/⏸️/⬜/🔒/❌/⏭️),
  czasem kroku (sekundnik 1 s dla kroku w biegu), tym co z kroku wynikło i sumą kosztu z
  `run.totalUsage()`. **Nie blokuje**: zamknięcie okna nie przerywa roboty, powrót klikiem w 🧠
  na pasku statusu. Klik w krok `awaiting_review` otwiera review **w tym samym oknie** (panel pod
  checklistą) — pierwszą paczkę L1 można przejrzeć, gdy piąta się liczy. Krok `failed` ma „Ponów"
  i „Pomiń". Po `isSettled()` dochodzi sekcja podsumowania + `finishRun()` przy zamknięciu.
  Modal jest GŁUPI — decyzje/retry/bramkę L2-L3/notice/koszt robi kontroler
  `modules/chat/consolidationRunner.js` wstrzykiwany jako `controller`.
- **`archiveReviewRenders.js` (NOWY)** — rendery review wyjęte z `ArchiveModal` i **dzielone
  przez oba modale**: `renderDedupReview` (2 kolumny scaleń/usunięć z edytowalną nazwą i treścią),
  `renderSummaryReview` (źródła + edytowalna treść L1/L2/L3, `readOnly` dla podglądu),
  `normalizeMerges/normalizeDeletions`, eksportowany prymityw `renderReviewBanner`.
  Klasy CSS i klucze i18n **nietknięte** — stary tor wygląda identycznie.
  **Poprawka 2026-09-02 (fabryka dead-code, klaster D4):** `renderReviewColumn`/`renderReviewItem`/
  `renderReviewEmpty` NIE są eksportowane — to prywatne helpery pliku
  `modules/chat/archiveReviewRenders.ts`, używane tylko wewnątrz `renderDedupReview`. Publiczne
  API pliku to `renderDedupReview`, `renderSummaryReview`, `renderReviewBanner`,
  `normalizeMerges`, `normalizeDeletions` + typy `MergeReview`/`DeletionReview`.
- **`ArchiveModal` ZOSTAJE** (stary, blokujący tor: guziki w profilu agenta + testy) — tylko
  woła teraz wspólne rendery zamiast własnych kopii; `_columnWrap`/`_itemBox`/`_emptyState`
  i osobne kolumny dedup usunięte jako duplikaty.
- **`SaveSessionModal` — faza loading przestała kłamać.** String „Zwykle 4-10s" **wyleciał**
  (dotyczył tylko 1. z 5 strzałów). Zamiast niego: sekundnik na żywo (`analyzing_timer`), puls na
  chunku modelu (`noteChunk()` → „Model pisze…"), a po padzie/zwisie `awaitRetry(message)` —
  przyczyna + guzik „Ponów analizę" zamiast wiecznie kręcącego się diamentu.
  ⚠️ `setError()` **USUNIĘTY** (dead-end: dorysowywał banner i jechał dalej z pustymi propozycjami,
  udając sukces). „Anuluj" w tej fazie naprawdę przerywa strzał — patrz `save_session.js` (race +
  `AbortController`).
- CSS: nowy blok `cs-consolidation__*` + `cs-save-session__loading-timer` / `.is-pulsing`
  w `src/styles.css`; `.obsek-status-bar-item--clickable` (pasek klikalny w trakcie konsolidacji).

## Kubełek 2 update (2026-07-29) — modal przebiegu nie zostawia trupa, edycje usera przeżywają

- **Zamknięcie okna zwalnia UTKNIĘTY przebieg.** `onClose` wołało tylko `finishIfSettled()`.
  Scenariusz-zabójca: paczka L1 `failed`, L2/L3 pod kłódką `gated`, user zamyka okno → nikt już
  nie kliknie „Ponów"/„Pomiń", `isSettled()` nigdy nie jest prawdą, `MemoryOpsCenter` zostaje
  zajęty **do restartu Obsidiana** (🧠 świeci wiecznie, kolejny zapis sesji nie ruszy konsolidacji).
  Nowy `_releaseIfStuck()` → `memoryOpsCenter.finishRun()` + notice
  `memory.consolidation.notice_postponed` (pl+en). ⚠️ Zamknięcie przy kroku `awaiting_review`
  NICZEGO nie zwalnia — to normalna przerwa, pasek ma świecić i pozwalać wrócić.
  Warunek „utknięty" mieszka w `consolidationRunState.isRunStuck` (czysty, testowalny).
- **Szkic review żyje na KROKU (`step.draft`), nie w panelu.** `_openReview` robił przy każdym
  otwarciu świeże kopie z `step.result` — user poprawiał treść L1 / odznaczał scalenia, zwijał
  panel, otwierał ponownie i wracała wersja modelu. Teraz `resolveStepDraft(step)` oddaje TEN SAM
  mutowalny obiekt (pierwszeństwo: decyzja usera → istniejący szkic → świeże kopie z propozycji),
  a `renderSummaryReview` dostaje `onChange`, który go aktualizuje. `ArchiveModal` bez zmian
  (nie podaje `onChange`, czyta treść przez `getBody()`).
- **Podgląd po zapisie pokazuje to, co poszło na dysk** — `step.decision?.body ?? proposal.body`
  (wcześniej zawsze propozycja modelu, więc po edycji usera kłamał).
- Notice modalu idzie przez `controller.plugin.showCrystalNotice` (spójność z resztą komunikatów
  konsolidacji), z awaryjnym fallbackiem na zwykły `Notice`.

## S27 update (2026-07-28) — Zaplecze jako katalog zasobów (3 taby) + Home na danych

**Filozofia (słowa Kuby): „Zaplecze to raczej podsumowywajka zasobów usera".** Zaplecze NIE
zarządza żywymi bytami — pokazuje formy odlewnicze (szablony) i opisuje zasoby. Byty żywe
(skille/suby przypisane agentom) żyją w profilach agentów.

- **`BackstageViews` rejestruje 3 zakładki:** `skills` (order 10, szablony skilli),
  `sub-agents` (order 20, szablony subów + wbudowany `pkm-sub`), **`connectors`** (order 30,
  informacyjny przegląd konektorów MCP — owner `modules/tools`). `getTabCount` liczy SZABLONY
  (a nie żywe byty) i PODŁĄCZONE serwery; suby mają +1 za `pkm-sub`.
- **`sidebar/backstage_rows.js` (NOWY, pure)** — definicja wierszy sekcji „Zaplecze" na Home
  jako czysta struktura danych + `readZapleczeCounts(plugin)`. `HomeView` robi już tylko DOM.
  Powód (D7): 2026-07-28 wisiał martwy wiersz „Narzędzia MCP" celujący w nieistniejący tab
  `tools` → Zaplecze po cichu spadało na Skille. `backstage_rows.test.js` sprawdza mapowanie
  wiersz→tab przeciw **realnemu** `BackstageRegistry` (rejestracja tymi samymi funkcjami co
  produkcja) w obie strony: żaden wiersz nie celuje w pustkę i żadna zakładka nie jest ukryta.
- **`backstage_helpers.js` +3 prymitywy kart szablonów:** `renderUseAtAgentButton`
  (rozwijana lista agentów → odlanie kopii), `renderTemplateVersionBadge` (`vN`),
  `renderCardAction` (mały guzik edycja/kosz). Wystawione przez barrel shell.
- **`SkillEditorModal` / `SubAgentEditorModal` — 5. argument `options`:** `{template:true}`
  (zapis do magazynu szablonów, wersja podbijana przez store) i `{alsoTemplate:true}`
  (checkbox „Zapisz też jako szablon w Zapleczu" przy tworzeniu żywego bytu u agenta).
  Wołacze z 4 argumentami działają bez zmian.
- **`SkillEditorModal`: siatka „Dozwolone narzędzia" WYCIĘTA** (D6 — pole-fasada
  `allowed-tools`; renderowała martwe nazwy z `TOOL_INFO`).
- **CSS:** nowy blok „S27: Zaplecze jako katalog SZABLONÓW" w `sidebar/SidebarViews.css`
  (`cs-backstage-intro`, `cs-template-use*`, `cs-template-action*`, `cs-item-card__actions`,
  `cs-item-card--builtin`, `cs-connector-*`).

## Werdykt D6 update (2026-07-30) — `ArchiveModal.js` SKASOWANY

> Uwaga na nazwy: to werdykt **D6 z 2026-07-30** (kasacja starego toru konsolidacji), nie „D6"
> z sekcji S27 wyżej (tam D6 to litera decyzji wewnątrz sprintu).

- **`ArchiveModal.js` usunięty w całości** (~150 LOC) + eksport z `index.js` + klucze i18n, których
  używał wyłącznie on: `modal.archive.title_dedup`/`title_l1`/`title_l2`/`title_l3`/
  `subtitle_dedup`/`subtitle_summary`/`skip`/`cost_line` (pl+en). Obsługiwał stary, blokujący
  `ArchiveWorkflow.run()` (modal per faza), który od kubełka 2 nie miał produkcyjnego wołacza,
  a w D6 poszedł do kosza razem z modalem.
- **`archiveReviewRenders.js` ZOSTAJE bez zmian** — `ConsolidationProgressModal` stoi na nim
  w całości. Zostają też wszystkie klucze `modal.archive.*`, których używają rendery
  (`llm_driven`, `col_merges`, `col_deletions`, `no_merges`, `no_deletions`, `dedup_empty`,
  `sources_label`, `target_name_placeholder`, `merged_content_placeholder`).
- **CSS w większości NIETKNIĘTY** — korekta D9 (2026-09-02): klasy `cs-archive-modal__*` renderują
  dalej z `archiveReviewRenders.js`, a `cs-archive-modal-wide` dokłada sobie
  `ConsolidationProgressModal` (`:73`). Nazwa jest dziś myląca (nie ma już modalu o tej nazwie) —
  rename to kandydat na sesję czystek CSS, nie tutaj. **Wyjątek: `.cs-archive-modal__cost-line`
  poszła w D9** (`src/styles.css`) — pokazywała koszt LLM w starym, blokującym `ArchiveModal`;
  `archiveReviewRenders.js` tej linijki nigdy nie odtworzył, więc reguła była osierocona od D6.

## D9 update (2026-09-02) — kasacja martwego CSS (SidebarViews.css + src/styles.css) + martwa metoda w bazie zakładki ustawień

Klaster dead-code AUD-082/083/098/100/145/146/151/152/154/200/232/251/252/253/257 (część
`modules/shell/**` + `src/styles.css`; części tych samych znalezisk w `chat_view.css` i
`KomunikatorModal.css` należą do innego klastra, nietknięte tutaj).

- **`SidebarViews.css`: -149 linii.** Skasowane bez żadnego producenta w `.ts`: rodzina
  `.cs-picker__row*` + `.cs-picker__list` (11 reguł — wariant listowy pickera zastąpiony
  dropdownem w E2.8 C6, `.cs-picker` root i reszta rodziny `__dropdown`/`__option*`/`__search*`
  **ŻYJE** przez `modules/agents/profile/*`), `.cs-item-card__agents` + `.cs-agent-link(:hover)`
  (jedyny producent to `renderAgentLinks` w `modules/ui-components/backstage_helpers.ts` — bez
  wołacza; funkcję kasuje inny klaster, i18n `backstage.agents_label` zostaje ich ZLECENIEM),
  `.cs-comm-msg__context`, `.cs-profile-hero__badge`, `.cs-shard__detail` (usunięta z grupowanych
  selektorów obok żywego `.cs-shard__action`, który zostaje), cała rodzina `.cs-comm-row*` (6 reguł
  — Komunikator w sidebarze renderuje dziś `cs-comm-msg__*`, nie `cs-comm-row*`), `.cs-mem-add*`
  (3 reguły — stary kształt guzika „dodaj” z ramką kreskowaną; żywy następca `cs-mem-add-row`
  ma już własną regułę w `src/styles.css:~1019`, więc to nie był przerwany rename tylko osierocony
  stary kod), `.cs-mem-entry--editing`, `.cs-mem-item--empty*`.
  **Przepięcie, nie kasacja:** `.cs-mem-entry__input(:focus)` → `.cs-mem-entry__edit-input(:focus)`
  — `profile_memory.ts:246` maluje inline-input klasą `cs-mem-entry__edit-input` bez ŻADNEJ reguły
  w repo; obok leżała reguła o niemal identycznej, martwej nazwie. To przerwany rename z jednej
  starszej sesji — naprawiony repinem, bo przywraca zamierzony wygląd (tło/border/padding pola
  edycji), którego dziś brakowało.
- **`src/styles.css`: 8 reguł `[data-agent-color="…"]` (64-75) skasowane** — atrybutu nikt nie
  nadaje (żywa droga to `style.setProperty('--cs-agent-color', …)`, np.
  `modules/agents/profile/HiddenFileEditorModal.ts:65`); komentarz nagłówkowy pliku (linia 4) i
  blok nad regułami zaktualizowane, żeby nie wspominać już atrybutowej ścieżki. **8 klas
  narzędziowych z bloku „Utility classes” skasowane** (`.cs-agent-accent/-bg/-border/-glow`,
  `.cs-crystal-enter`, `.cs-send-pulse`, `.cs-message-enter`, `.cs-connector-pulse`) — `.cs-breathing`
  z tego samego bloku ZOSTAJE (żywa w 4 miejscach). Przechodnio martwe **`@keyframes cs-send-pulse`
  i `@keyframes cs-connector-pulse`** też skasowane (jedyny `animation:` użytkownik siedział w
  martwej klasie obok); `@keyframes cs-crystal-build`/`cs-message-enter`/`cs-glow-pulse` ZOSTAJĄ —
  mają żywych konsumentów w `modules/chat/chat_view.css` bezpośrednio, nie przez utility class.
  `.cs-archive-modal__cost-line` skasowana (patrz nota D6 wyżej).
- **`render_component()` bazy zakładki ustawień skasowana w całości** — czytała nieistniejące
  `env.smart_components` (relikt starego frameworka bazowego, wycięty w E3.7) i nie miała ani jednego
  wołacza w repo (jedyna podklasa, `pkm_settings_tab.ts`, jej nie nadpisuje ani nie woła).
  Druga połowa tego samego znaleziska (baza widoków, ten sam
  `smart_components` po stronie mobilnego paska statusu) NIE jest tym cięciem — inny moduł,
  inny wykonawca.
- **Strażnik:** `modules/shell/deadCssPins.test.ts` — pin-lista (nie „każdy selektor ma wołacza",
  bo w tych arkuszach mnóstwo klas budowanych szablonem, np. `cs-agent-grid--${col}col`, i pełny
  strażnik dawałby fałszywe alarmy). Pilnuje, że skasowane selektory nie wracają + że żywe
  sąsiadki (w tym repin `cs-mem-entry__edit-input`) zostały na miejscu.

## S32 Z3 (2026-07-30) → SKASOWANE (2026-09-07) — podgląd zużycia limitu ChatGPT

Funkcja z S32 Z3 (modal + logika czytająca lokalny plik `usage_limits.json`, wystawiany przez
lokalny most zgodny z API LM Studio podpinający subskrypcję ChatGPT pod plugin — guzik obok
„Koszty LLM" w Ustawieniach → Zaawansowane) **skasowana w całości**: oba pliki funkcji + ich
test (23 testy), wpięcie w `core/SettingsContent.js` i `pkm_settings_tab.js`, klucze i18n
dedykowane temu ekranowi (pl+en) i dopasowany blok CSS w `src/styles.css`. Zero pozostałości —
kasacja funkcji, nie tylko rebranding.

## S36b update (2026-07-30) — `DraftsListModal.js` SKASOWANY + opcja „draft" znika z `SessionCloseModal`

Kasacja całej rodziny draftów (faza 2b handoffu S36; wtopy #1+#6 z S30 Z4). Sedno: modal zamknięcia
sesji oferował guzik **„Zostaw jako draft"**, który zapisywał plik do `.draft/` — a **czytnika nie
było od Memory v3**. User dostawał notice „Sesja zapisana jako draft" o rozmowie, do której nie
miał jak wrócić. Guzik, który kłamie, jest gorszy od braku guzika.

- **`DraftsListModal.js` usunięty w całości** (133 LOC). Zero wołaczy w repo (weryfikacja grepem
  przed kasacją); od S30 Z4 nie był nawet w barrelu. Razem z nim: klucze i18n `modal.drafts_list.*`
  (pl+en, 5 kluczy) i blok CSS `.cs-drafts-list*` w `src/styles.css` (~50 linii).
- **`SessionCloseModal`: opcja/guzik `'draft'` OUT.** Zostają **`archive`** (podsumuj + zapisz)
  i **`discard`** (odłóż do `.discarded/`, z `window.confirm`) + `cancel`. Klucze i18n
  `modal.session_close.draft` / `draft_tooltip` skasowane (pl+en). **Kształt zwrotu `prompt()`
  NIETKNIĘTY** — nadal `{choice, options}`, więc konsument (`chat_session.handleNewSession`)
  nie zmienił kontraktu, tylko stracił jedną gałąź `else if`.
- **Zaplecze w `modules/memory`** (`saveDraft`/`listDrafts`/`loadDraft`/`discardDraft`/
  `promoteDraft` + ścieżka `paths.draft`) skasowane tym samym cięciem — patrz
  [`modules/memory/CLAUDE.md`](../memory/CLAUDE.md).
- ⚠️ **Pliki draftów leżące u userów na dysku NIE są kasowane** (dane usera — filozofia Memory v3).
  Po prostu nie powstają nowe. Flow `.discarded/` (gałąź „odrzuć") **nietknięty**.
