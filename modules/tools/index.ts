/**
 * modules/tools/ — Public API
 *
 * MCP runtime + built-in narzędzia + prawdziwy klient MCP (external, stdio/HTTP).
 * Jedyne drzwi modułu — patrz CLAUDE.md.
 *
 * KONIEC z `export *`. Gwiazdka wynosiłaby na zewnątrz wszystko, co dany plik
 * eksportuje — także rzeczy, których nikt nie ma widzieć: hak testowy `__test__`
 * z `DelegateTool.js`, `TodoFileStore` + `TODO_FOLDER` z `built-in-servers/artifacts/`
 * (podwójna gwiazdka) i `renderTextOverlay` z `AddTextToImageTool.js`.
 * Każdy eksport jest wypisany z nazwy. Dopisujesz narzędzie → dopisujesz je TUTAJ,
 * świadomie. Definicje i haki testowe zostają w bebechach (testy deep-importują pliki).
 */

// ── Runtime built-in serwerów ─────────────────────────────────────────────
// ServerLoader NIE jest tu re-eksportowany: zero konsumentów poza modułem, ServerManager
// go deep-importuje u siebie ('./ServerLoader.js'), a test (built-in-servers.test.ts) też
// idzie deep-importem. Klasa żyje, drzwi barrela — nie.
export { ServerManager } from './ServerManager.js';

// Prawdziwy klient MCP (stdio + HTTP przez @modelcontextprotocol/sdk).
// Rejestruje narzędzia zewnętrznych serwerów jako source:'user' (→ RED). SDK importowany leniwie.
export { ExternalMcpManager } from './ExternalMcpManager.js';
// Jawna lista, bez export *: presety konsumuje shell/MCPServerEditorModal; parser importu
// z Claude jest wewnetrzny (SettingsContent).
export { MCP_SERVER_PRESETS, getMcpServerPreset } from './mcpServerPresets.js';

// ── Registry + client ──────────────────────────────────────────────────────
// ToolLoader nie istnieje — ładował wabiki (fasadowe narzędzia bez pokrycia); nie przywracaj go.
export { ToolRegistry } from './ToolRegistry.js';
export { MCPClient } from './MCPClient.js';

// ── Delegacja (sub-agent + agent). `agent_message` nie istnieje — pocztę robi `kom_send`.
export { createDelegateTool } from './DelegateTool.js';
// Demontaż pluginu przerywa biegi delegacji, także te bez bytu w rejestrze (onunload).
export { stopAllDelegations } from './DelegateTool.js';
export { createAgentDelegateTool } from './AgentDelegateTool.js';

// ── Vault prymitywy: read/list mają scope vault|memory; write/delete/create_folder vault-only.
export { createReadTool } from './ReadTool.js';
export { createListTool } from './ListTool.js';
export { createWriteTool } from './WriteTool.js';
export { createDeleteTool } from './DeleteTool.js';
export { createCreateFolderTool } from './CreateFolderTool.js';
// JEDNO narzędzie `search` zastąpiło 12 narzędzi retrieval
// (vault_search/grep/semantic/glob/filter_yaml/links + memory_* analogi + sessions/summaries).
export { createSearchTool } from './SearchTool.js';

// ── Memory tools (Memory v3 note tools). memory_read + memory_read_summary +
// memory_list_summaries wchłonięte przez read/list (scope=memory).
export { createMemorySaveTool } from './MemorySaveTool.js';
export { createMemoryDeleteTool } from './MemoryDeleteTool.js';

// Skill tools — skill_list/skill_execute nie istnieją. Odkrywalność skilli =
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
// Poczta agenta — kom_send / kom_list / kom_read (serwer `komunikator`).
export { createKomunikatorTools } from './KomunikatorTools.js';

// ── Multimodal. `renderTextOverlay` ZOSTAJE w `text_overlay_helper.js` (wewnątrz modułu).
export { createGenerateImageTool } from './GenerateImageTool.js';
export { createAddTextToImageTool } from './AddTextToImageTool.js';

export { registerSettings } from './SettingsSection.js';
// Zakładka „Konektory" jest INFORMACYJNA — opis serwerów MCP + ich narzędzi + realna lista
// narzędzi wbudowanych, bez żadnych akcji zarządzających.
export { registerBackstage } from './BackstageTab.js';

// ══════════════════════════════════════════════════════════════════════════
// TYPY PUBLICZNE
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

// External MCP: config serwera z data.json + status runtime + wiersz dla UI.
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
