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
import { t } from '../../../core/i18n/index.js';

/**
 * Manifest wbudowanego serwera MCP — dokładnie to, co eksportują pliki `*.manifest.ts`.
 * `version` bywa wartownikiem `'plugin'` (rozwijanym przez `resolveBuiltinManifests`).
 *
 * ŚWIADOMIE bez pola `description` — manifesty PL/EN na sztywno pokazywały userowi opis w
 * niewłaściwym języku (user z angielskim UI widział polskie zdania dla artifacts/delegation/
 * komunikator/multimodal, user z polskim UI widział angielskie dla core/vault/memory). Tekst
 * dla UI liczy `resolveServerDescription(name)` NIŻEJ, przy KAŻDYM odczycie (nie raz, przy
 * imporcie modułu — `t()` zależy od `setLocale()`, która leci z `src/main.ts` PO imporcie).
 */
export interface BuiltinServerManifest {
    name: string;
    version: string;
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

/**
 * Opis wbudowanego serwera dla UI (Ustawienia → Serwery MCP), w aktualnym języku interfejsu.
 * Liczony PRZY KAŻDYM WYWOŁANIU — wołacze (`ServerLoader.getServerCatalog()`,
 * `ServerManager.connectServer()`) mają wołać tę funkcję na każdy odczyt/render, nie cache'ować
 * wyniku, żeby zmiana języka w sesji (Ustawienia → dropdown język → `owner.render()`) pokazała
 * właściwy tekst BEZ restartu pluginu.
 *
 * Klucze są LITERALNE (`t('mcp.server.core.desc')` itd.), nie sklejane z `name` w locie —
 * `core/i18n/parity_repo.test.ts` skanuje dokładnie literalne wywołania `t('...')` i pilnuje,
 * żeby każdy klucz istniał w obu słownikach. Szablon `t('mcp.server.' + name + '.desc')`
 * byłby dla tego strażnika niewidzialny.
 */
export function resolveServerDescription(name: string): string {
    switch (name) {
        case 'core': return t('mcp.server.core.desc');
        case 'vault': return t('mcp.server.vault.desc');
        case 'memory': return t('mcp.server.memory.desc');
        case 'web': return t('mcp.server.web.desc');
        case 'multimodal': return t('mcp.server.multimodal.desc');
        case 'delegation': return t('mcp.server.delegation.desc');
        case 'artifacts': return t('mcp.server.artifacts.desc');
        case 'komunikator': return t('mcp.server.komunikator.desc');
        default: return name;
    }
}

// Nie dodawaj aliasów re-eksportu (coreManifest…komunikatorManifest) — realni wołacze chodzą
// przez BUILTIN_MANIFESTS / getBuiltinManifest, alias bez konsumenta jest martwym kodem.
