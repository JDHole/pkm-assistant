/**
 * Model Resolver — centralna fabryka modelu czatu dla wszystkich ról.
 *
 * Drabinka resolucji (B.1 MR-04..MR-22):
 * 1. `agent.models[role]` (nadpisanie per agent)
 * 2. default z biblioteki modeli dla roli
 * 3. legacy: `pkmAssistant.chat.platform` + `pkmAssistant.chat.models[platform]`
 * 4. `null` (nic nie skonfigurowano)
 *
 * Klucze API zawsze z jednej puli: `pkmAssistant.chat.apiKeys[platform]`.
 *
 * Instancja powstaje przez `createChatModel(deps)` z `env.config.chat` (rejestr dostawców
 * + klient HTTP + transport strumienia). Typy — `contracts.ts`.
 */
import { log } from '../../core/utils/Logger.js';
import { createChatModel } from './ChatModel.js';
import { acquireSlot } from './requestGate.js';
import { resolveProvider } from './registry.js';
import { resolveMaxOutputTokens } from './cache_utils.js';
import type {
    ChatModel,
    ChatModelDeps,
    ChatSettingsSlice,
    DelegateConfigLike,
    ModelLibraryEntry,
    ModelOverride,
    ModelRole,
    PkmModelSettings,
    ProviderId,
    ResolverAgentLike,
    ResolverPluginLike,
} from './contracts.js';

export type {
    ChatSettingsSlice,
    DelegateConfigLike,
    ModelLibraryEntry,
    ModelOverride,
    ModelRole,
    PkmModelSettings,
    ResolverAgentLike,
    ResolverPluginLike,
};

/**
 * Seam testowy: podmiana fabryki instancji modelu.
 *
 * Testy resolvera i `DelegateTool` badają DRABINKĘ (która platforma, który model, ile razy
 * powstała instancja), nie zachowanie modelu — dlatego wstrzykują tu własną atrapę zamiast
 * budować prawdziwy `ChatModel` z transportem. `reset()` przywraca produkcyjną fabrykę.
 */
type ChatModelFactory = (deps: ChatModelDeps) => ChatModel;
let _chatModelFactory: ChatModelFactory = createChatModel;

export const __test__ = {
    setChatModelFactory(fn: ChatModelFactory): void {
        _chatModelFactory = fn;
    },
    reset(): void {
        _chatModelFactory = createChatModel;
    },
};

/** Cache for model instances */
const _cache = new Map<string, ChatModel>();

/**
 * Default models per platform — legacy fallback (Step 4, pre-modelLibrary settings).
 *
 * AUD-code-review-083: `google`/`azure`/`custom`/`xai` brakowało tu wpisów, więc dla starego
 * `data.json` (sprzed S10) albo ręcznie wpisanego klucza bez wybranego modelu, resolucja tych
 * czterech platform cicho wracała `null` (log.debug, nie error) — pozostałe 8 dostawało sensowny
 * default. `xai` bierze DOKŁADNIE `default_model` z własnego adaptera
 * (`adapters/xai_chat_adapter.ts`) — to samo, co user zobaczy jako pierwszą pozycję dropdownu,
 * gdyby skonfigurował platformę od nowa. (`google`/`azure`/`custom` skreślone 2026-09-03 razem
 * z martwymi adapterami/kluczem dispatchu — AUD-dead-code-026/110/112/168; `gemini` ma wpis
 * od zawsze, patrz gotcha 15 w CLAUDE.md.)
 */
export const DEFAULT_MODELS: Readonly<Record<string, string>> = {
    anthropic: 'claude-sonnet-4-20250514',
    openai: 'gpt-4o',
    gemini: 'gemini-1.5-pro',
    groq: 'llama-3.3-70b-versatile',
    deepseek: 'deepseek-chat',
    open_router: 'anthropic/claude-sonnet-4-20250514',
    ollama: 'llama3',
    lm_studio: 'default',
    xai: 'grok-3-mini-beta',
};

/**
 * Get all models configured for a given role from the model library.
 * @param pkmSettings - obiekt settings.pkmAssistant
 * @param role - legacy names are accepted for one release
 */
export function getModelsForRole(pkmSettings: PkmModelSettings | null | undefined, role: ModelRole): ModelLibraryEntry[] {
    const libraryRole = role === 'researcher' ? 'minion' : role;
    return pkmSettings?.modelLibrary?.[libraryRole] || [];
}

/**
 * Get the default model for a given role from the model library.
 * Returns the entry marked isDefault, or the first entry, or null.
 * @param pkmSettings - obiekt settings.pkmAssistant
 */
// AUD-dead-code-214: `export` zdjęty — jedyny wołacz jest w tym pliku (Krok 3 drabinki
// niżej). Barrel `index.ts` i tak jej nie eksportował (S30 Z4), a komentarz tam mylił
// czytelnika sugerując, że robi to ktoś na zewnątrz modułu.
function getDefaultModelForRole(pkmSettings: PkmModelSettings | null | undefined, role: ModelRole): ModelLibraryEntry | null {
    const models = getModelsForRole(pkmSettings, role);
    if (models.length === 0) return null;
    return models.find(m => m.isDefault) || models[0];
}

/**
 * Detect platform from API keys in the `pkmAssistant.chat` slice
 * @param chat - slice `pkmAssistant.chat`
 */
export const PLATFORM_DETECTION_ORDER: readonly string[] = [
    'anthropic', 'openai', 'deepseek', 'gemini', 'groq', 'xai', 'open_router', 'ollama', 'lm_studio',
];

function _detectPlatform(chat: ChatSettingsSlice): string | null {
    for (const p of PLATFORM_DETECTION_ORDER) {
        if (chat.apiKeys?.[p] || p === 'ollama' || p === 'lm_studio') return p;
    }
    return null;
}

/**
 * `ModelOverride` (string "platforma/model" or `{platform, model}`) → plain string, or ''.
 * Small LOCAL copy of the normalization `modules/agents/profile/modelFieldSync.ts` does for
 * the same shape — `models` cannot import from `agents` (agents already imports `models`;
 * the reverse would create a cycle), so this stays a standalone one-off instead of a shared
 * helper. Used only by Step 4b (last-resort sub-role fallback, gotcha B6-2).
 */
function normalizeAgentModelOverride(value: ModelOverride | undefined | null): string {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (value.platform && value.model) return `${value.platform}/${value.model}`;
    return '';
}

/**
 * Create a ChatModel instance for a given role.
 *
 * @param plugin - PKM Assistant plugin instance
 * @param role - Model role
 * @param [agent] - Agent instance (for per-agent overrides)
 * @param [delegateConfig] - Sub-agent/delegate config — checks .model field for override
 * @param [callerSkipCache] - AUD-wydajnosc-079/RR-08-11: wołacz WYMUSZA świeżą instancję dla roli
 *   `main` (np. `chat_model.ts` gdy `skipCache` z `get_chat_model` trafia w gałąź agenta z
 *   WŁASNYM modelem — do tego fixu ta flaga tam ginęła i dwa taby czatu tego samego agenta
 *   dzieliły jedną instancję adaptera w trakcie `stream()`, patrz gotcha 2 w CLAUDE.md). Rolom
 *   sub i tak zawsze skipuje (linia niżej) — ten parametr dokłada wymuszenie TEŻ dla `main`.
 * @returns ChatModel instance or null
 */
export function createModelForRole(plugin: ResolverPluginLike, role: ModelRole, agent: ResolverAgentLike = null, delegateConfig: DelegateConfigLike = null, callerSkipCache = false): ChatModel | null {
    const env = plugin?.env;
    if (!env) return null;

    if (role === 'minion') {
        log.debug('ModelResolver', '[deprecated v2.1] modelRole "minion" -> "researcher"');
    }

    // Normalize legacy alias: 'researcher' → 'minion' (nazwa slotu w bibliotece modeli).
    const normalizedRole = role === 'researcher' ? 'minion' : role;
    // F4: `sub_worker` = sub klasy rodzica. Do RESOLUCJI udaje `main` (ta sama drabinka, ten sam
    // model co czat), ale nadal jest subem — dlatego pamiętamy o tym osobną flagą i niżej
    // wymuszamy świeżą instancję (współdzielenie instancji z czatem = wyścig na `stream()`).
    const isSubWorker = normalizedRole === 'sub_worker';
    const effectiveRole = isSubWorker ? 'main' : normalizedRole;

    const chat: ChatSettingsSlice = env.settings?.pkmAssistant?.chat || {};
    const pkm: PkmModelSettings = env.settings?.pkmAssistant || {};

    // --- Resolution chain ---
    let platform: string | null = null;
    let modelId: string | null = null;

    const applyOverride = (override: ModelOverride): void => {
        if (typeof override === 'string') {
            const slashIdx = override.indexOf('/');
            if (slashIdx > 0) {
                platform = override.slice(0, slashIdx);
                modelId = override.slice(slashIdx + 1);
            } else {
                modelId = override;
            }
        } else {
            platform = override.platform || null;
            modelId = override.model || null;
        }
    };

    // Step 0 (F4, tylko `sub_worker`): model z configu suba (YAML `model:`) wygrywa nad CAŁĄ
    // drabinką rodzica. Dla `sub_worker` „model rodzica" jest domyślnym wyborem, nie przymusem —
    // user, który jawnie wpisał model w SUB_AGENT.yaml, ma dostać dokładnie ten model.
    if (isSubWorker && delegateConfig?.model) applyOverride(delegateConfig.model);

    // Step 1: Per-agent override. Top-level `agent.model` counts ONLY for the main role —
    // for sub roles it is the last resort (Step 4b), AFTER the model library. Otherwise any
    // agent with its own main model silently hijacks every sub role and the library's
    // sub-agent slot is dead configuration.
    const agentOverride = agent?.models?.[role]
        || agent?.models?.[effectiveRole]
        || (effectiveRole === 'main' ? agent?.model : null)
        || null;
    if (!modelId && agentOverride) applyOverride(agentOverride);

    // Step 2: Delegate config override (SUB_AGENT.yaml .model field)
    if (!modelId && delegateConfig?.model) {
        modelId = delegateConfig.model;
    }

    // Step 3: Model Library default
    if (!modelId) {
        const libDefault = getDefaultModelForRole(pkm, effectiveRole);
        if (libDefault) {
            platform = platform || libDefault.platform;
            modelId = libDefault.model;
        }
    }

    // Step 4: Legacy fallback (pre-modelLibrary settings)
    if (!modelId) {
        if (effectiveRole === 'main') {
            platform = platform || chat.platform || _detectPlatform(chat);
            modelId = chat.models?.[platform as string] || DEFAULT_MODELS[platform as string] || null;
        } else if (effectiveRole === 'minion') {
            modelId = pkm.minionModel || null;
            platform = platform || pkm.minionPlatform || null;
        }
        // Slot 'master' (rola stratega) skasowany w fabryce kasacji S1 (2026-09-02,
        // AUD-dead-code-173) — po E3.6 żaden produkcyjny wołacz nie pytał o tę rolę.
    }

    // Step 4b: sub roles — top-level agent.model (legacy) OR normalized agent.models.main
    // (canon after the B6-2 migration, see modules/agents/profile/modelFieldSync.ts) as LAST
    // resort, so delegation still works when the user configured nothing sub-specific (no
    // library entry, no legacy slot). Both are normalized to the same "platform/model" string
    // shape before falling through to `applyOverride` — models CANNOT import from agents
    // (agents imports models; the reverse would cycle), so this is a small local copy of the
    // same normalization `modelFieldSync.ts` does, not a shared import.
    if (!modelId && effectiveRole !== 'main') {
        const lastResort = normalizeAgentModelOverride(agent?.model) || normalizeAgentModelOverride(agent?.models?.main);
        if (lastResort) applyOverride(lastResort);
    }

    // Step 5: If no platform yet, detect from keys
    if (!platform) {
        platform = chat.platform || _detectPlatform(chat);
    }

    if (!platform || !modelId || !modelId.trim()) {
        log.debug('ModelResolver', `${role}: brak platformy lub modelu (platform=${platform}, model=${modelId})`);
        return null;
    }

    // API key always from global pool
    const apiKey = chat.apiKeys?.[platform];
    if (!apiKey && platform !== 'ollama' && platform !== 'lm_studio') {
        log.debug('ModelResolver', `${role}: brak API key dla ${platform}`);
        return null;
    }

    // Cache check — skip for non-main roles: they may run in parallel,
    // and ChatModel.stream() is NOT safe for concurrent calls on same instance.
    // F4: `sub_worker` rozwiązuje się JAK main (effectiveRole==='main'), ale biegnie równolegle
    // z czatem — musi dostać własną instancję, inaczej sub i czat dzielą jeden `stream()`.
    // AUD-wydajnosc-079/RR-08-11: `callerSkipCache` dokłada wymuszenie TEŻ dla `main` — bez tego
    // dwie tury na roli main (dwa taby, albo tura + konsolidacja pamięci w tle) zawsze dostawały
    // TĘ SAMĄ instancję z `_cache`, niezależnie od tego, co wołacz jawnie zażądał.
    const skipCache = (effectiveRole !== 'main') || isSubWorker || callerSkipCache;
    const agentName = agent?.name || '_global';
    const cacheKey = `${agentName}:${effectiveRole}:${platform}:${modelId.trim()}`;
    if (!skipCache) {
        const cached = _cache.get(cacheKey);
        if (cached?.stream) {
            log.debug('ModelResolver', `${role}: z CACHE → ${platform}/${modelId.trim()}`);
            return cached;
        }
    }

    // Create model
    const chatConfig = env.config?.chat;
    if (!chatConfig?.providers || !chatConfig.http || !chatConfig.transport) return null;

    try {
        // B.3 SM-02: znana platforma = wpis wprost z rejestru; NIEZNANA nazwa (`azure`/`custom`/
        // `google` ze starego `settings.json`) idzie przez fail-safe, który spada na PIERWSZY wpis.
        const provider = chatConfig.providers[platform as ProviderId]
            ?? resolveProvider(chatConfig.providers, platform);
        const model = _chatModelFactory({
            provider,
            ctx: {
                modelId: modelId.trim(),
                apiKey,
                endpoint: chat.hosts?.[platform],
                agentName: agent?.name,
                maxOutputTokens: resolveMaxOutputTokens({ settings: env.settings, platform, modelId: modelId.trim() }),
                temperature: chat.temperature,
                keepAlive: typeof pkm?.ollama_keep_alive === 'string' ? pkm.ollama_keep_alive : undefined,
                log,
            },
            http: chatConfig.http,
            transport: chatConfig.transport,
            gate: { acquireSlot },
            notices: env.notices,
            settings: env.settings ?? {},
        });
        if (!skipCache) _cache.set(cacheKey, model);
        // Log pokazuje rolę WOŁANĄ (sub_worker), nie tę, którą udaje przy resolucji (main) —
        // inaczej w logu nie da się odróżnić modelu czatu od modelu suba klasy rodzica.
        log.model(isSubWorker ? 'sub_worker' : effectiveRole, platform, modelId.trim());
        return model;
    } catch (e) {
        log.warn('ModelResolver', `Nie udało się stworzyć modelu ${role}:`, e);
        return null;
    }
}

/**
 * Clear the model cache (call when settings change, agent switches, etc.)
 */
export function clearModelCache(): void {
    _cache.clear();
}

/** LOCAL platforms — data stays on user's machine */
export const LOCAL_PLATFORMS: readonly ProviderId[] = ['ollama', 'lm_studio'];

/**
 * Check if a platform runs locally (no data leaves user's machine).
 */
export function isLocalPlatform(platform: string): boolean {
    return (LOCAL_PLATFORMS as readonly string[]).includes(platform);
}
