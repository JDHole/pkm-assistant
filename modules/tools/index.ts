/**
 * modules/tools/ — Public API (dawniej modules/mcp; rename E3.1 faza D)
 *
 * MCP runtime + built-in narzędzia + prawdziwy klient MCP (external, stdio/HTTP).
 * Jedyne drzwi modułu — patrz CLAUDE.md.
 *
 * S30 Z4: KONIEC z `export *`. Gwiazdka wynosiła na zewnątrz wszystko, co dany plik
 * eksportuje — także rzeczy, których nikt nie miał widzieć: hak testowy `__test__`
 * z `DelegateTool.js`, `TodoFileStore` + `TODO_FOLDER` z `built-in-servers/artifacts/`
 * (podwójna gwiazdka) i `renderTextOverlay` z `AddTextToImageTool.js` (relikt comfy).
 * Teraz każdy eksport jest wypisany z nazwy. Dopisujesz narzędzie → dopisujesz je TUTAJ,
 * świadomie. Definicje i haki testowe zostają w bebechach (testy deep-importują pliki).
 */

// ── Runtime built-in serwerów ─────────────────────────────────────────────
// ServerLoader NIE jest tu re-eksportowany (AUD-dead-code-016/209): zero konsumentów
// poza modułem, ServerManager go deep-importuje u siebie ('./ServerLoader.js'), a test
// (built-in-servers.test.ts) też idzie deep-importem. Klasa żyje, drzwi barrela — nie.
export { ServerManager } from './ServerManager.js';

// E3.1 faza A: prawdziwy klient MCP (stdio + HTTP przez @modelcontextprotocol/sdk).
// Rejestruje narzędzia zewnętrznych serwerów jako source:'user' (→ RED). SDK importowany leniwie.
export { ExternalMcpManager } from './ExternalMcpManager.js';
// S32 Z2.2 (po przycince S30: jawna lista, bez export *): presety konsumuje
// shell/MCPServerEditorModal; parser importu z Claude jest wewnetrzny (SettingsContent).
export { MCP_SERVER_PRESETS, getMcpServerPreset } from './mcpServerPresets.js';

// ── Registry + client ──────────────────────────────────────────────────────
// ToolLoader SKASOWANY (fix znaleziska TS-3 #10, 2026-07-31): od E3.1 ładował wabiki.
export { ToolRegistry } from './ToolRegistry.js';
export { MCPClient } from './MCPClient.js';

// ── Delegacja (sub-agent + agent). S28: `agent_message` skasowany — pocztę robi `kom_send`.
export { createDelegateTool } from './DelegateTool.js';
// Z7: demontaż pluginu przerywa biegi delegacji, także te bez bytu w rejestrze (onunload).
export { stopAllDelegations } from './DelegateTool.js';
export { createAgentDelegateTool } from './AgentDelegateTool.js';

// ── Vault prymitywy (E2.6): read/list mają scope vault|memory; write/delete/create_folder vault-only.
export { createReadTool } from './ReadTool.js';
export { createListTool } from './ListTool.js';
export { createWriteTool } from './WriteTool.js';
export { createDeleteTool } from './DeleteTool.js';
export { createCreateFolderTool } from './CreateFolderTool.js';
// E2.5: JEDNO narzędzie `search` zastąpiło 12 narzędzi retrieval
// (vault_search/grep/semantic/glob/filter_yaml/links + memory_* analogi + sessions/summaries).
export { createSearchTool } from './SearchTool.js';

// ── Memory tools (Memory v3 note tools). E2.6: memory_read + memory_read_summary +
// memory_list_summaries wchłonięte przez read/list (scope=memory).
export { createMemorySaveTool } from './MemorySaveTool.js';
export { createMemoryDeleteTool } from './MemoryDeleteTool.js';

// Skill tools — D17 (E2.4): skill_list/skill_execute skasowane. Odkrywalność skilli =
// cienki indeks w system promptcie (nazwa + opis + ścieżka), pełny przepis przez read().

// ── Artifact tools (Artefakty żywe + todo). `TodoFileStore`/`TODO_FOLDER` ZOSTAJĄ
// wewnątrz modułu (`TodoTool.js` + jego test) — barrel wystawia tylko fabryki narzędzi.
export {
    createArtifactCreateTool,
    createArtifactReadTool,
    createArtifactUpdateTool,
    createArtifactListTool,
    createTodoTool,
} from './built-in-servers/artifacts/index.js';

// ── Web tools ──────────────────────────────────────────────────────────────
export { createWebSearchTool } from './WebSearchTool.js';
export { createWebReadTool } from './WebReadTool.js';

// ── Komunikacja ────────────────────────────────────────────────────────────
export { createAskUserTool } from './AskUserTool.js';
// S28: poczta agenta — kom_send / kom_list / kom_read (serwer `komunikator`).
export { createKomunikatorTools } from './KomunikatorTools.js';

// ── Multimodal. `renderTextOverlay` ZOSTAJE w `text_overlay_helper.js` (wewnątrz modułu).
export { createGenerateImageTool } from './GenerateImageTool.js';
export { createAddTextToImageTool } from './AddTextToImageTool.js';

export { registerSettings } from './SettingsSection.js';
// E2.8 A4: tab „Narzędzia MCP" (wydmuszka sterowania) skasowany.
// S27 Z5: w jego miejsce wchodzi INFORMACYJNA zakładka „Konektory" (D5) — opis serwerów
// MCP + ich narzędzi + realna lista narzędzi wbudowanych, bez żadnych akcji zarządzających.
export { registerBackstage } from './BackstageTab.js';

// ══════════════════════════════════════════════════════════════════════════
// TYPY PUBLICZNE (kampania TS, fala TS-3)
//
// Te same drzwi co wartości. `export type` ZNIKA przy transpilacji, więc powierzchnia
// runtime'u modułu jest dokładnie taka, jak lista eksportów wyżej.
// ══════════════════════════════════════════════════════════════════════════

// Kanoniczny kształt narzędzia (właścicielem typu jest ToolRegistry — patrz CLAUDE.md).
export type { ToolDefinition, ToolVisibilityAgent } from './ToolRegistry.js';

// Klient MCP: kontrakty trzech argumentów konstruktora + kształt wywołania narzędzia.
export type {
    MCPClientApp,
    MCPClientPlugin,
    MCPToolRegistryLike,
    MCPClientOptions,
    ClientTool,
    ToolCall,
    ToolCallArgs,
    ExecuteToolCallOptions,
    DiffApprovalOptions,
} from './MCPClient.js';

// External MCP (E3.1): config serwera z data.json + status runtime + wiersz dla UI.
export type {
    ExternalMcpServerConfig,
    ExternalServerStatus,
    ExternalServerUiRow,
    ExternalMcpManagerOptions,
    ExternalMcpPluginLike,
    ExternalToolRegistryLike,
    McpClientLike,
    McpClientFactory,
    McpCallToolResult,
} from './ExternalMcpManager.js';
export type { McpServerPreset } from './mcpServerPresets.js';

// Built-in serwery: manifest + wpis w cache loadera + wiersz katalogu dla UI.
export type { BuiltinServerManifest, ResolveManifestsOptions } from './built-in-servers/index.js';
export type { LoadedServerConfig, ServerLoaderOptions, ServerCatalogEntry } from './ServerLoader.js';
export type { OpenAiToolDefinition, ServerVisibilityAgent, ServerManagerPluginLike, ServerManagerOptions } from './ServerManager.js';

// Ustawienia + Zaplecze — worki DI, które składa shell.
export type { ToolsSettingsCtx, ImageGenSettings, SttSettings } from './SettingsContent.js';
export type { ConnectorsPluginLike } from './ConnectorsBackstageTab.js';
export type { BackstageTabDef, BackstageRegistryLike } from './BackstageTab.js';
