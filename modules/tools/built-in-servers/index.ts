/**
 * Built-in MCP servers — bundled with the plugin (read-only for users).
 * Logical servers: core, artifacts, vault, memory, web, multimodal, delegation, komunikator.
 *
 * User-added MCP servers live in `.pkm-assistant/mcp-servers/` (vault) — handled by ServerLoader.
 * Built-in vs user separation is deliberate: built-ins ship read-only with the plugin, user
 * servers are editable.
 *
 * Serwer `skills` (skill_list/skill_execute) nie istnieje — skille odkrywane
 * indeksem w system promptcie, przepis czytany przez `read`.
 *
 * `version: 'plugin'` is a sentinel — resolved to the actual plugin version at runtime
 * (via resolveBuiltinManifests({ pluginVersion })) so manifests stay in sync with package.json.
 */
import core from './core.manifest.js';
import artifacts from './artifacts.manifest.js';
import vault from './vault.manifest.js';
import memory from './memory.manifest.js';
import web from './web.manifest.js';
import multimodal from './multimodal.manifest.js';
import delegation from './delegation.manifest.js';
import komunikator from './komunikator.manifest.js';

/**
 * Manifest wbudowanego serwera MCP — dokładnie to, co eksportują pliki `*.manifest.ts`.
 * `version` bywa wartownikiem `'plugin'` (rozwijanym przez `resolveBuiltinManifests`).
 */
export interface BuiltinServerManifest {
    name: string;
    version: string;
    description: string;
    icon: string;
    tools: string[];
    requires_permission: string[];
    /**
     * Deklaratywny sufit czasu. Realnie odczytuje go tylko `resolveTimeoutMs`
     * (server_timeout.ts), a jedynym wołaczem jest `ExternalMcpManager` (serwery
     * zewnętrzne) — dla WBUDOWANYCH narzędzi to pole nie ma żadnego egzekutora.
     * Zostaje jako dokumentacja zamierzonego budżetu, nie jako aktywny limit.
     */
    timeout_ms: number;
    source: string;
    removable: boolean;
}

/** Opcje rozwijania katalogu manifestów. */
export interface ResolveManifestsOptions {
    /** Version from package.json (e.g. "1.2.1") */
    pluginVersion?: string;
    komunikatorEnabled?: boolean;
}

export const BUILTIN_MANIFESTS: BuiltinServerManifest[] = [core, artifacts, vault, memory, web, multimodal, delegation, komunikator];

/**
 * Resolve `version: 'plugin'` sentinel to the actual plugin version.
 * Returns a fresh array of manifests with concrete versions.
 *
 * @returns Manifests with resolved versions
 */
export function resolveBuiltinManifests({ pluginVersion, komunikatorEnabled = true }: ResolveManifestsOptions = {}): BuiltinServerManifest[] {
    let manifests = BUILTIN_MANIFESTS;
    // Kill-switch komunikatora (flaga default ON): gdy user wyłączy pocztę, cały serwer
    // `komunikator` (kom_send/kom_list/kom_read) znika z katalogu.
    // `delegation` (delegate / agent_delegate) zostaje — działa bez KomunikatorManagera.
    // Domyślne `true` sprawia, że każdy caller bez flagi widzi pełny katalog (czysty bypass).
    if (komunikatorEnabled === false) {
        manifests = manifests.filter(m => m.name !== 'komunikator');
    }
    return manifests.map(m => ({
        ...m,
        version: m.version === 'plugin' ? (pluginVersion || '1.0.0') : m.version,
    }));
}

/**
 * Get a single built-in manifest by name.
 * @param name - Server name (core, vault, memory, ...)
 */
export function getBuiltinManifest(name: string): BuiltinServerManifest | null {
    return BUILTIN_MANIFESTS.find(m => m.name === name) || null;
}

// Nie dodawaj aliasów re-eksportu (coreManifest…komunikatorManifest) — realni wołacze chodzą
// przez BUILTIN_MANIFESTS / getBuiltinManifest, alias bez konsumenta jest martwym kodem.
