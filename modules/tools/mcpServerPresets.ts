/**
 * mcpServerPresets — S32 Z2.2: katalog gotowych serwerów MCP („pierwszy raz" bez czytania docsów).
 *
 * Dane siedzą TU, w kodzie — zero sieci, zero pobierania katalogu z internetu (nie chcemy, żeby
 * lista serwerów do uruchomienia na komputerze usera przychodziła ze zdalnego źródła).
 * Preset tylko WYPEŁNIA formularz w `MCPServerEditorModal` — user może zmienić każde pole,
 * a walidacja przy zapisie (`ExternalMcpManager.validateServerId` + wymagane pola) działa jak zawsze.
 *
 * Kształt presetu:
 *   { id, name, transport:'stdio', command, args[], env?{}, hint }
 *   - `id`  — musi przechodzić `validateServerId` (slug 2-32 [a-z0-9-]) i NIE kolidować z nazwą
 *             serwera wbudowanego (dlatego `mcp-memory`, nie `memory`).
 *   - `name`— nazwa własna produktu (nie tłumaczymy).
 *   - `hint`— KLUCZ i18n z jednozdaniowym „co jeszcze musisz uzupełnić".
 */

/** Placeholder w argumentach, który user MUSI podmienić na swoją ścieżkę. */
export const PRESET_PATH_PLACEHOLDER = '<ŚCIEŻKA>';

/** Gotowy serwer MCP do wypełnienia formularza (kształt opisany w nagłówku pliku). */
export interface McpServerPreset {
    id: string;
    name: string;
    /** Wszystkie presety są lokalnymi procesami — stąd literał, nie `string`. */
    transport: 'stdio';
    command: string;
    args: string[];
    env?: Record<string, string>;
    /** KLUCZ i18n (nie gotowy tekst) — patrz nagłówek pliku. */
    hint: string;
}

export const MCP_SERVER_PRESETS: McpServerPreset[] = [
    {
        id: 'filesystem',
        name: 'Filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', PRESET_PATH_PLACEHOLDER],
        hint: 'settings.mcp_preset_hint_filesystem',
    },
    {
        id: 'github',
        name: 'GitHub',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
        hint: 'settings.mcp_preset_hint_github',
    },
    {
        // id ≠ 'memory' — ta nazwa jest zarezerwowana dla wbudowanego serwera pamięci agenta.
        id: 'mcp-memory',
        name: 'Memory (knowledge graph)',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
        hint: 'settings.mcp_preset_hint_memory',
    },
    {
        id: 'fetch',
        name: 'Fetch',
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-fetch'],
        hint: 'settings.mcp_preset_hint_fetch',
    },
    {
        id: 'blender',
        name: 'Blender',
        transport: 'stdio',
        command: 'uvx',
        args: ['blender-mcp'],
        hint: 'settings.mcp_preset_hint_blender',
    },
];

/**
 * Preset po id (null gdy nie ma) — używane przez modal edytora serwera.
 */
export function getMcpServerPreset(id: string): McpServerPreset | null {
    return MCP_SERVER_PRESETS.find(p => p.id === id) || null;
}
