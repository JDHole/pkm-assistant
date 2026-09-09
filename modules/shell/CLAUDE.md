# modules/shell/

**Obudowa pluginu - UI framework.** Settings tab, sidebar nawigacja, custom workspace views, misc modale. To jest „zlew" na UI - wszystko co nie pasuje do dedykowanego modułu (chat/agents/artifacts/onboarding/komunikator) ląduje tu.

---

## Zawartość - co jest w shell

### Settings tab (shell rama + rejestry; kontrolki sekcji u ownerów przez `SettingsContent.ts`)

| Plik | Rola |
|------|------|
| `pkm_settings_tab.ts` | `PkmSettingsTab` - shell ustawień: header/main layout, `SettingsRegistry` wiring, `buildSectionContext()`. Kontrolki sekcji są w ownerach `SettingsContent.ts`. Shell rejestruje 2 własne sekcje **Vault** i **Prompt** przez `renderVaultSection`/`renderPromptSection`. |
| `vault_settings.ts` | `renderVaultSection(container, ctx)`: grupy folderów (`settings.pkmAssistant.vaultGroups`) + opisy stref vaulta (globalny `VaultMap`). |
| `prompt_settings.ts` | `renderPromptSection(container, ctx)`: globalne defaulty promptów roboczych (`settings.pkmAssistant.promptDefaults`) + sekcje fabryczne + ostrzeżenia o kontraktach parserów. |
| `PluginSettingsTab.ts` | Baza rozszerzająca Obsidian `PluginSettingTab`. Szkielet dwóch kontenerów (`headerContainer` / `mainContainer`, klasy CSS `pkm-settings-header` / `pkm-settings-main`) i dwa stany ekranu: ładowanie (render czeka na `runtime.whenLoaded()`) albo gotowe. |
| `SettingsRegistry.ts` | Framework rejestracji sekcji Settings: plug-in registration, hash routing `#settings/<id>`, sort po `order`, sub-fields. |
| `BackstageRegistry.ts` | Framework rejestracji zakładek Backstage: moduły rejestrują tab przez `<module>/BackstageTab.ts`. |

### Sidebar

```
AgentSidebar.ts          # ItemView extends, registered as 'pkm-agent-sidebar'
AgentSidebar.css         # stylesheet
sidebar/
├── SidebarNav.ts        # stack-based nav controller (push/pop/replace, scroll preservation, cleanup hooks)
├── HomeView.ts          # agent grid + komunikator + zaplecze sections
├── BackstageViews.ts    # zakładki Zaplecza: Skille + Sub-Agenci, Crystal Soul dual color system
├── DetailViews.ts       # skill / sub-agent detail views
├── TriggersView.ts      # zakładka Triggery - klikalne sub-agenty/skille/tools
├── triggers_collectors.ts # zbieranie dostępnych triggerów per agent
├── backstage_rows.ts    # czysta definicja wierszy sekcji „Zaplecze" na Home + liczniki
├── findActiveChatView.ts # helper: znajdź aktywny widok czatu w workspace
└── SidebarViews.css     # stylesheet
```

`AgentSidebar` subskrybuje `agentManager.on(...)` z 200ms debounce dla komunikator events. Sprzątanie widoku idzie przez `SidebarNav.dispose()` (patrz gotcha niżej).

### Modale

Każdy `extends Modal` z Obsidiana (onOpen/onClose lifecycle). Promise-based result pattern.

| Plik | Co robi |
|------|---------|
| `ApprovalModal.ts` | Approval/deny modal dla AccessGuard. Action type badge, content preview, deny reason. Eksportuje `requestApproval(app, action)` używane przez `core/security/ApprovalManager`. Dla `external.call` renderuje `action.externalArgs` jako JSON (indent 2, cięcie ~1500 znaków, „(bez argumentów)" gdy pusto) - user widzi, co dokładnie leci do cudzego serwera. |
| `MCPServerEditorModal.ts` | Dodaj/edytuj ZEWNĘTRZNY serwer MCP (nazwa, id, transport stdio/http + pola, autostart, ostrzeżenie zaufania per transport). Zapis do ustawień pluginu (`data.json`), nie do vaulta - komenda/env/nagłówki niosą sekrety. Guzik „Sprawdź połączenie i pokaż narzędzia" (`ExternalMcpManager.previewTools` na configu z pól, bez zapisu; efemeryczne, nic nie rejestruje) + `enabled` zachowywane przy edycji (kill-switch usera nie odwraca się po edycji). Dostęp per agent żyje wyłącznie w `mcp_servers[]`. |
| `ClaudeImportModal.ts` | Potwierdzenie importu serwerów MCP z Claude Desktop. Modal jest GŁUPI: dostaje gotowe wiersze (`buildImportRows` z `modules/tools/claudeConfigImport.ts`) i callback `onConfirm` - nie parsuje pliku, nie zna ustawień, nie zapisuje; cała logika siedzi u wołającego (`modules/tools/SettingsContent.ts`). Serwer, którego `id` już mamy w ustawieniach, ma checkbox odznaczony i zablokowany - import NIGDY nie nadpisuje istniejącej konfiguracji. |
| `AgentPresentationModal.ts` | Karta prezentacji agenta - Crystal Soul styling, info read-only. |
| `SendToAgentModal.ts` | Selektor agenta + textarea do wysłania wiadomości. |
| `AgentDeleteModal.ts` | Confirmation modal usunięcia agenta z listą rzeczy do zniszczenia. Guard `agent.isBuiltIn` - dla wbudowanego agenta przycisk delete `disabled` (ochrona wielowarstwowa: modal + `HomeView` kosz ukryty + `AgentManager.deleteAgent` throw). |
| `InlineCommentModal.ts` | Inline comments w czacie. |
| `CostTrackingModal.ts` | Wykres kosztów tokenów/dzień z `.pkm-assistant/cost_log.jsonl`. |

Modale Settings (`CostTrackingModal`/`MCPServerEditorModal`/`ClaudeImportModal`) idą przez DI z `pkm_settings_tab.ts` (wnętrze shella) - nie potrzebują barrela.

Modale sesji (`SessionCloseModal`, `SaveSessionModal`, `OpenSessionModal`) mieszkają w `modules/chat/` - jedyni wołacze (chat_session, `/save session`) są tam. `ConsolidationProgressModal` (nieblokujący modal przebiegu konsolidacji: checklista kroków + review w środku) razem z `archiveReviewRenders.ts` i `consolidationRunState.ts` mieszka w `modules/chat/` - jedyny wołacz (`consolidationRunner.ts`) jest tam. `MigrationModal` mieszka w `modules/agents/` (jedyny wołacz to `AgentManager`) - wewnętrzny szczegół agentów, NIE ma go w żadnym barrelu. `SkillEditorModal` mieszka w `modules/skills/`, `SubAgentEditorModal` w `modules/sub-agents/` - właściciele u siebie, konsumenci biorą je z barreli tych modułów, nie stąd. `DiffModal` mieszka w `modules/ui-components/` (wołacz: `modules/tools/MCPClient.ts`).

### Custom Workspace Views

| Plik | Co robi |
|------|---------|
| `ReleaseNotesView.ts` | `ReleaseNotesView` - viewType `pkm-release-notes-view`. Otwiera tab z markdown z `releases/latest_release.md`. Dziedziczy z `PluginItemView` (importowanego z `modules/ui-components/`); statyka `openForVersion(workspace, version)` woła bazowe `open(workspace, {version})` (jedna sygnatura `open` w całym repo). |

Bazowa klasa widoku (`PluginItemView`) mieszka w `modules/ui-components/`, bo dziedziczą z niej dwa moduły (chat → `ChatView`, shell → `ReleaseNotesView`) - jej dom jest tam, gdzie klocki dla ≥2 modułów. Shell nie trzyma re-exportu tej bazy.

---

## Public API - `modules/shell/index.ts`

Poza shell wolno importować TYLKO przez `index.ts`. Wewnątrz shell pliki importują się swobodnie.

**Settings:**
- `PkmSettingsTab`

**Sidebar:**
- `registerAgentSidebar`, `openAgentSidebar` (funkcje-fasady; klasa widoku zostaje wewnątrz)

**Custom views:**
- `ReleaseNotesView`

**Modale:**
- `requestApproval` (funkcja-fasada dla `core/security/ApprovalManager`)
- `InlineCommentModal`, `SendToAgentModal`

Helpery kart Zaplecza (`renderFilterBar`, `getCategoryLabel`, `renderUseAtAgentButton`, `renderTemplateVersionBadge`, `renderCardAction`) NIE są w barrelu shella - wołają je stamtąd zakładki Zaplecza w `modules/skills` i `modules/sub-agents`; kto potrzebuje tych helperów spoza shella, importuje `modules/ui-components/index.ts`, nie stąd.

Reszta symboli modułu (rama i rejestry ustawień `PluginSettingsTab`, `SettingsRegistry`/`SettingsRegistryClass`, `BackstageRegistry`/`BackstageRegistryClass`, helpery Zaplecza `renderAgentLinks`/`agentHasSubAgent`, klasy `AgentSidebar`/`ApprovalModal`, modale Settings uzyskiwane przez DI) świadomie NIE jest w barrelu - zero konsumentów spoza modułu, albo wołacz i tak wchodzi inną drogą (funkcja-fasada, wstrzyknięcie przez `ctx`, import lokalny wewnątrz shella).

---

## Zależności

**Importuje z:**
- `core/i18n` (`t`, `setLocale`)
- `core/security/keySanitizer` (`maskKey`)
- `core/security/AccessGuard` (ApprovalModal / guardy w modalach)
- `core/utils/Logger` (`log`)
- `modules/agents` - `Agent`, `renderAgentProfileView`
- `modules/chat` - `insertInlineTriggerMarker` (leniwym `import()` z `TriggersView`)
- `config/default_prompts.ts` - `DEFAULT_COMPRESSION_PROMPT`
- `modules/crystal-soul` - `UiIcons`, `SkinManager`, `IconGenerator`, `SvgHelper`, `setSvg`, `setSvgLabel`, `getColorByHex`, `hexToRgbTriplet`, `registerSettings`
- `modules/komunikator` - `renderCommunicatorView`, `isKomunikatorEnabled`
- `modules/memory` - pakiet etykiet przebiegu konsolidacji (`stepLabel`/`stepDetail`/`stepStatusIcon`/`stepStatusLabel`/`stepDurationMs`/`isFallbackStep`/`formatDuration`/`formatUsageLine`/`buildRunSummary`/`summaryToText`) + `ConsolidationRun`/`STEP_KIND`/`STEP_STATUS`/`memoryOpsCenter` + `CostLog` + fabryczne prompty robocze + `registerSettings`
- `modules/models` - `getModelsForRole`, `registerSettings`
- `modules/prompts` - `FACTORY_DEFAULTS`
- `modules/skills` / `modules/sub-agents` / `modules/tools` / `modules/web` - `registerBackstage` / `registerSettings` (+ `getVisibleSubAgentsForAgent`, `DEFAULT_SUBAGENT_FRAME_PROMPT`, `ExternalMcpManager`)
- `modules/ui-components` - `TOOL_INFO`, `getToolIcon`

**Importowany przez:**
- `src/main.ts` - importy z barrel: `ReleaseNotesView`, `PkmSettingsTab`, `registerAgentSidebar`, `openAgentSidebar`, `SendToAgentModal`, `InlineCommentModal`, modale sesji/pamięci itd.
- `core/security/ApprovalManager.ts` - `requestApproval` przez barrel
- Żaden moduł niższy (`chat`, `skills`, `sub-agents`, `tools`) nie importuje z shella - ani statycznie, ani dynamicznie. Zostały wyłącznie adnotacje typów JSDoc w `SkillDetailView`/`SubAgentDetailView` - to nie jest import w runtime.

---

## Settings tab - sekcje rejestrowane przez ownerów

Shell trzyma tylko ramę + `SettingsRegistry`. Poszczególne sekcje są **u ownerów** jako `<module>/SettingsContent.ts` i rejestrują się przez `registerSettings(...)`. Hash routing `#settings/<id>`, sort po `order`, sub-fields.

| Sekcja | Owner (`SettingsContent.ts`) |
|---|---|
| Modele | `modules/models` |
| Pamięć i kontekst | `modules/memory` |
| **Vault** (grupy folderów + strefy) | `modules/shell` (`vault_settings.ts`, shell-owned - byt vaultowy, nie agents) |
| Web Search + Image Gen + STT + MCP Servers | `modules/tools` + `modules/web` (Web Search) |
| **Prompt** (globalne defaulty promptów roboczych) | `modules/shell` (`prompt_settings.ts`, shell-owned) |
| Wygląd (Skiny) | `modules/crystal-soul` |
| NoGo + Zaawansowane + Klucze API + Informacje | `core` (`core/SettingsContent.ts`) |

Sekcja „Agenci / Role" nie istnieje w Settings - sterowanie agentem żyje w panelu `AgentProfileView`, nie w Settings. Vault + Prompt to jedyne sekcje rejestrowane **bezpośrednio przez shell** (nie przez owner-moduł), bo to byty globalne/vaultowe.

`pkm_settings_tab.ts` = shell + `buildSectionContext()`, **bez DOM-cutting** - sekcje mieszkają u ownerów (poza shell-owned Vault/Prompt).

---

## Kluczowe decyzje

- **Shell jako „zlew" na UI** - gdzie nie ma sensu osobnego modułu, tutaj. Świadomy kompromis.
- **`AgentSidebar` w shell, nie w `modules/agents/`** - bo to widget UI w Obsidianie (registered jako sidebar view), nie logic agentów. Logic w agents/.
- **`ApprovalManager` (core/security) → `ApprovalModal` (shell)** - pre-existing wyjątek od reguły „core nie importuje z modules". `core/security/ApprovalManager.ts` importuje przez barrel `modules/shell/index.ts`, nie deep - rozluźnia ścisłość reguły, ale szanuje zasadę „jedyne drzwi". UI modal jest fundamentem dla approval flow.
- **Baza widoków (`PluginItemView`) jako klasa cross-modułowa** - używana przez `ChatView` (modules/chat) jako baza. Skoro dziedziczą z niej dwa moduły, jej dom to `modules/ui-components/` (klocki dla ≥2 modułów); szczegóły klasy patrz `modules/ui-components/CLAUDE.md`.

---

## Gotchas

### 1. `pkm_settings_tab.ts`: shell, nie monolit

Sekcje Settings mieszkają w `SettingsContent.ts` u ownerów modułów. Shell trzyma tylko ramę, context i DI dla modali Settings.

### 2. `ApprovalModal` import z `core/security/ApprovalManager`

Cykliczny risk - `ApprovalManager` (w core) importuje z `modules/shell/index.ts` (przez barrel). Shell nie może importować z `ApprovalManager` (bo zrobiłby cykl). Trzymaj się reguły: shell → core OK, core → shell tylko przez barrel.

### 3. Modale CSS w plain `.css`

Nie używają Obsidian CSS variables konsekwentnie. Theming/accessibility ucierpi na tym w miejscach, które jeszcze nie przeszły na CSS vars.

### 4. Crystal Soul dual color system w `BackstageViews`

CSS vars `--cs-user-color` (UI accents) + `--cs-category-color-rgb` (per-card). 12 kategorii skilli (productivity, writing, analysis, system, creative, general, vault, memory, communication, planning, search, mixed) → mapowane na hex z palety Crystal Soul. Spójne z `modules/crystal-soul`.

### 5. Sprzątanie widoku sidebara idzie przez `SidebarNav.dispose()`

Widok wiesza swoje odpięcia na `nav._currentCleanup` (np. Komunikator: `agentManager.on(...)` + budzik renderu 150 ms). Jeśli ten uchwyt woła WYŁĄCZNIE `_render()` przy przełączeniu widoku, zamknięcie panelu zostawia nasłuch do końca sesji Obsidiana, a ponowne otwarcie buduje NOWY `SidebarNav` - powielone nasłuchy mielą pracę wielokrotnie na odpiętym DOM-ie. `AgentSidebar.onClose()` woła `this.nav?.dispose?.()` - idempotentne, fail-soft. **Nowy widok sidebara rejestruje sprzątanie tą samą drogą** - nie dokładaj własnej ścieżki zamykania.

### 6. Dead CSS jest pilnowane pin-listą, nie „każdy selektor ma wołacza"

`modules/shell/deadCssPins.test.ts` pilnuje, że raz skasowane martwe selektory nie wracają + że żywe sąsiadki zostały na miejscu. Pełny strażnik typu „każdy selektor ma wołacza" dawałby fałszywe alarmy - w arkuszach CSS tego modułu jest mnóstwo klas budowanych szablonem (np. `cs-agent-grid--${col}col`).

---

## Powiązane

- **Wszystkie moduły** - settings dotyka każdego (per-module settings w monolicie)
- `core/security/ApprovalManager.ts` - używa `requestApproval` z shell (przez barrel)
- `modules/chat` - nie importuje z shella; shell renderuje sidebar, z którego chat się otwiera
- `modules/agents` - sidebar renderuje agent grid + `AgentProfileView` (panel wielozakładkowy), modale `AgentDelete` (guard wbudowanego agenta) / `Presentation`
- `modules/crystal-soul` - sidebar i settings używają `UiIcons` / `CrystalGenerator` / `pickColor` / palety kolorów
