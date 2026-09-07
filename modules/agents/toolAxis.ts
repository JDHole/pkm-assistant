/**
 * toolAxis.js — Jedna oś narzędziowa agenta v3 (E2.8 C1).
 *
 * MODEL: `agent.disabled_tools[]` = NEGATYWNA lista nazw narzędzi built-in wyłączonych
 * dla agenta. Negatywna z rozmysłem: narzędzie dodane w nowej wersji pluginu jest
 * domyślnie WŁĄCZONE (nie trzeba dotykać każdego agenta). `core` (ask_user) zawsze ON,
 * nieusuwalny.
 *
 * Ten moduł jest PURE (zero importów obsidian / PromptBuilder) — dzięki temu jest
 * node-testowalny (`toolAxis.test.js`), w przeciwieństwie do `Agent.js`, który przez
 * łańcuch `modules/prompts` wciąga obsidian. Agent.js importuje stąd `./toolAxis.js`
 * (import wewnątrz-modułowy, `./` — poza zasięgiem reguły no-restricted-imports).
 *
 * ŹRÓDŁO PRAWDY nazw narzędzi to manifesty `modules/mcp/built-in-servers/*.manifest.js`
 * (+ `ToolRegistry.BUILTIN_TOOL_MAP`). Mapa niżej jest ich pure-kopią po stronie agenta;
 * test `toolAxis.test.js` pilnuje zgodności (deep-import manifestów jest w teście dozwolony).
 */

import { t } from '../../core/i18n/index.js';

export interface LegacyToolAxisConfig {
    mcp_servers?: unknown;
    enabled_tools?: unknown;
    default_permissions?: object;
}

/**
 * Built-in tool groups (logiczne serwery). Odwzorowanie `ToolRegistry.BUILTIN_TOOL_MAP`.
 * Kolejność grup = kolejność wyświetlania w UI (Uprawnienia sekcja 1 + Umiejętności C5).
 */
export const BUILTIN_TOOL_GROUPS: Record<string, string[]> = {
    core: ['ask_user'],
    vault: ['read', 'write', 'list', 'delete', 'create_folder', 'search'],
    memory: ['memory_save', 'memory_delete'],
    web: ['web_search', 'web_read'],
    multimodal: ['generate_image', 'add_text_to_image'],
    // S28 (D3): `agent_message` OUT z delegacji — pocztę obsługuje grupa `komunikator`.
    delegation: ['delegate', 'agent_delegate'],
    artifacts: ['artifact_create', 'artifact_read', 'artifact_update', 'artifact_list', 'todo'],
    // S28 (D3): trzy prymitywy poczty zamiast 13 narzędzi Project Huba.
    komunikator: ['kom_send', 'kom_list', 'kom_read'],
};

/** Serwer zawsze dostępny (ask_user) — nie da się go wyłączyć. */
export const ALWAYS_ON_GROUP = 'core';

/** Wszystkie built-in tools (płasko). */
export const ALL_BUILTIN_TOOLS = Object.values(BUILTIN_TOOL_GROUPS).flat();

/**
 * Grupy wyłączone u ŚWIEŻEGO agenta (default). Zachowuje dawny default vault+memory+core:
 * agent widzi narzędzia vaulta i pamięci, resztę (web/multimodal/delegacja/artefakty/
 * komunikator) ma wyłączoną, dopóki user jej nie włączy w Uprawnieniach.
 */
export const DEFAULT_DISABLED_GROUPS = ['web', 'multimodal', 'delegation', 'artifacts', 'komunikator'];

/**
 * WYJĄTKI od DEFAULT_DISABLED_GROUPS: narzędzia, które mimo wyłączonej grupy są ON u świeżego agenta
 * (E2.9 D1). `todo` (gatunek 2) = samoorganizacja pracy agenta w ukrytym `.pkm-assistant/` — nie pisze
 * do widocznego vaulta usera, więc bezpieczne domyślnie; reszta grupy `artifacts` (artifact_* piszą
 * notatki do vaultu) zostaje OFF konserwatywnie.
 */
export const DEFAULT_ENABLED_EXCEPTIONS = ['todo'];

/**
 * Metadane grup dla UI (ikona emoji + klucz i18n etykiety). Zgodne z makietą E2.8.
 */
export const GROUP_META: Record<string, { icon: string; labelKey: string }> = {
    core: { icon: '⚙️', labelKey: 'tools.group.core' },
    vault: { icon: '📁', labelKey: 'tools.group.vault' },
    memory: { icon: '🧠', labelKey: 'tools.group.memory' },
    web: { icon: '🌐', labelKey: 'tools.group.web' },
    multimodal: { icon: '🎨', labelKey: 'tools.group.multimodal' },
    delegation: { icon: '🤝', labelKey: 'tools.group.delegation' },
    artifacts: { icon: '📋', labelKey: 'tools.group.artifacts' },
    komunikator: { icon: '📨', labelKey: 'tools.group.komunikator' },
};

/**
 * Pre-C1 domyślne uprawnienia (8 pól). Używane WYŁĄCZNIE przez migrację, żeby wiernie
 * odtworzyć dawną widoczność+używalność narzędzi ze starego YAML-a. NIE mylić z żywym
 * `DEFAULT_PERMISSIONS` (Agent.js, po C1 tylko `memory`+`guidance_mode`).
 */
export const LEGACY_DEFAULT_PERMISSIONS: Record<string, boolean> = {
    read_notes: true,
    edit_notes: false,
    create_files: false,
    delete_files: false,
    mcp: false,
    web_search: true,
};

/**
 * Bramka uprawnienia per narzędzie (dawny `ACTION_TYPE_MAP → ACTION_PERMISSIONS`).
 * Narzędzie było USUWALNE ze zbioru efektywnego, gdy jego uprawnienie było `false`.
 * Narzędzia bez wpisu = niebramkowane uprawnieniem akcji (czytanie / pamięć — te ostatnie
 * bramkuje osobno serwer `memory` + żywe uprawnienie `memory`, nie edit_notes).
 */
const PERMISSION_TOOL_GATES: Record<string, string> = {
    // vault write-side
    write: 'edit_notes',
    create_folder: 'create_files',
    delete: 'delete_files',
    // vault read-side (default read_notes=true; jawny false rzadki, ale honorujemy)
    read: 'read_notes',
    list: 'read_notes',
    search: 'read_notes',
    // web
    web_search: 'web_search',
    web_read: 'web_search',
    // delegacja (dawne action 'delegate' → PERMISSION mcp)
    delegate: 'mcp',
    agent_delegate: 'mcp',
    // generowanie obrazu (dawne EDIT_NOTES). AUD-dead-code-133: `agent_message` skreślony
    // stąd — `permissionAllowsTool` jest wołane WYŁĄCZNIE dla narzędzi z `BUILTIN_TOOL_GROUPS`
    // (pętla w `computeDisabledToolsFromLegacy`), a `agent_message` wypadło z tamtej mapy w S28
    // D3 (pocztę obsługuje dziś grupa `komunikator`) — wpis nigdy nie był czytany. Bliźniaczy
    // wpis w `core/security/autonomy.ts` to INNY przypadek — tam zostaje świadomie, fail-closed.
    generate_image: 'edit_notes',
    add_text_to_image: 'edit_notes',
    // memory_save/memory_delete: BEZ bramki edit_notes (bypass checkPermission w runtime) —
    // rządzi nimi sam serwer `memory` w mcp_servers. Ungated tutaj.
    // chat_todo/idea_review/plan_review/kom_*: ungated (serwer whitelisty wystarczy).
};

/**
 * Czytelna, ludzka etykieta narzędzia na OSI UPRAWNIEŃ (i18n `tools.label.<name>`).
 * Fallback = surowa nazwa techniczna. Używane w UI Uprawnień (grupy + „kiedy pyta")
 * i approvalu — „po ludzku" (S18/C7).
 *
 * ⚠️ S30 Z3 rename z `getToolLabel`: istniała druga funkcja o tej samej nazwie i INNEJ
 * semantyce — `getToolCallLabel` w `modules/ui-components/ToolCallDisplay.js` (etykieta chipa
 * tool-calla, przestrzeń i18n `tool.*`, nie `tools.label.*`). Nie mieszać przestrzeni kluczy.
 *
 * @param {string} name
 * @returns {string}
 */
export function getPermissionToolLabel(name: string) {
    const key = `tools.label.${name}`;
    const label = t(key);
    return label === key ? name : label;
}

/**
 * Czytelna etykieta grupy narzędzi (i18n przez GROUP_META[group].labelKey). Fallback = nazwa grupy.
 * @param {string} group
 * @returns {string}
 */
export function getGroupLabel(group: string) {
    const meta = GROUP_META[group];
    if (!meta) return group;
    const label = t(meta.labelKey);
    return label === meta.labelKey ? group : label;
}

/**
 * Domyślny `disabled_tools` świeżego agenta = narzędzia grup DEFAULT_DISABLED_GROUPS.
 * @returns {string[]}
 */
export function defaultDisabledTools() {
    const exceptions = new Set(DEFAULT_ENABLED_EXCEPTIONS);
    return DEFAULT_DISABLED_GROUPS.flatMap(g => BUILTIN_TOOL_GROUPS[g] || []).filter(tool => !exceptions.has(tool));
}

/**
 * Czy uprawnienia (legacy) pozwalały użyć danego narzędzia.
 * @param {string} tool
 * @param {Object} perms - scalone LEGACY_DEFAULT_PERMISSIONS + config.default_permissions
 * @returns {boolean}
 */
function permissionAllowsTool(tool: string, perms: Record<string, unknown>) {
    const gate = PERMISSION_TOOL_GATES[tool];
    if (!gate) return true;               // niebramkowane akcją → zawsze dozwolone
    return perms[gate] !== false;         // false = zablokowane; undefined/true = dozwolone
}

/**
 * MIGRACJA (C1): wylicz `disabled_tools` ze starych osi (mcp_servers × enabled_tools ×
 * permissions), tak żeby zachować dawną efektywną widoczność+używalność narzędzi.
 *
 * Zasady:
 *  - `mcp_servers` zawiera '*' → wszystko włączone (disabled = []). Wildcard = pełny dostęp
 *    (świadomy wyjątek: nie zawężamy uprawnieniami akcji — agent '*' ma mieć wszystko).
 *  - w przeciwnym razie: narzędzie jest EFEKTYWNE gdy: grupa `core` LUB grupa w `mcp_servers`,
 *    ORAZ (enabled_tools puste LUB narzędzie w enabled_tools), ORAZ uprawnienie akcji je dopuszcza.
 *  - `disabled_tools = ALL_BUILTIN − efektywne`.
 *
 * Uwaga: NIE stosujemy dawnego short-circuitu `mcp:false → tylko core`. `mcp` jako
 * uprawnienie znika w C1; agenta migrujemy po jego whiteliście serwerów (intencja usera),
 * a `mcp:false` degraduje tylko narzędzia delegacji/connect (przez PERMISSION_TOOL_GATES).
 *
 * @param {Object} config - surowy config agenta (z YAML): {mcp_servers?, enabled_tools?, default_permissions?}
 * @returns {string[]} disabled_tools
 */
export function computeDisabledToolsFromLegacy(config: LegacyToolAxisConfig = {}) {
    const servers = Array.isArray(config.mcp_servers) ? config.mcp_servers : ['vault', 'memory', 'core'];
    if (servers.includes('*')) return [];

    const enabledTools = Array.isArray(config.enabled_tools) ? config.enabled_tools : [];
    const hasEnabledFilter = enabledTools.length > 0;
    const perms = { ...LEGACY_DEFAULT_PERMISSIONS, ...(config.default_permissions || {}) };
    const serverSet = new Set([ALWAYS_ON_GROUP, ...servers]);

    const effective = new Set();
    for (const [group, tools] of Object.entries(BUILTIN_TOOL_GROUPS)) {
        if (!serverSet.has(group)) continue;
        for (const tool of tools) {
            if (group !== ALWAYS_ON_GROUP) {
                if (hasEnabledFilter && !enabledTools.includes(tool)) continue;
                if (!permissionAllowsTool(tool, perms)) continue;
            }
            effective.add(tool);
        }
    }

    return ALL_BUILTIN_TOOLS.filter(t => !effective.has(t));
}

/**
 * Normalizuj `disabled_tools` z YAML: tablica stringów, odfiltruj `core` (ask_user nieusuwalny),
 * usuń duplikaty i wartości spoza built-in? (NIE — zostawiamy nieznane, mogą to być narzędzia
 * userowych serwerów wyłączone per agent; C1 dotyczy built-in, ale lista jest wspólna).
 * @param {*} input
 * @returns {string[]}
 */
export function normalizeDisabledTools(input: unknown) {
    if (!Array.isArray(input)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of input) {
        if (typeof raw !== 'string' || !raw) continue;
        // core (ask_user) nie da się wyłączyć — pomijamy przy wczytaniu.
        if (BUILTIN_TOOL_GROUPS.core.includes(raw)) continue;
        if (seen.has(raw)) continue;
        seen.add(raw);
        out.push(raw);
    }
    return out;
}

/**
 * K3 (AUD-security-025) — PRZEŁĄCZNIKI POPOVERA UPRAWNIEŃ, PRZEPIĘTE NA ŻYWĄ OŚ.
 *
 * Do K3 popover w czacie pisał `default_permissions.read_notes/edit_notes/create_files/
 * delete_files/mcp`. Te klucze `Agent._normalizePermissions` cicho kasuje (po E2.8 C1 żywe
 * są tylko `memory` i `guidance_mode`), a `checkPermission` ich nie czyta — kropka przesuwała
 * się na ekranie i nic z tego nie wynikało. Tu jest mapa tych samych etykiet na NAZWY NARZĘDZI,
 * czyli na `disabled_tools` — jedyną oś, którą ktokolwiek egzekwuje.
 *
 * `mcp` (dawne „Narzędzia MCP") NIE MA tu wpisu świadomie: po E3.1 dostęp do serwera
 * zewnętrznego to opt-in per serwer (`agent.mcp_servers[]`, ustawiany w profilu agenta),
 * a nie jeden globalny włącznik — przełącznik boolean nie miałby czego włączyć.
 */
export const PERMISSION_SWITCH_TOOLS: Record<string, string[]> = {
    read_notes: ['read', 'list', 'search'],
    edit_notes: ['write'],
    create_files: ['create_folder'],
    delete_files: ['delete'],
};

/**
 * Czy przełącznik jest WŁĄCZONY dla danej listy wyłączonych narzędzi.
 * Włączony = ŻADNE z narzędzi przełącznika nie jest wyłączone (stan mieszany pokazujemy jako OFF,
 * żeby UI nie obiecywał więcej, niż agent ma).
 */
export function isPermissionSwitchOn(disabledTools: string[] | undefined, key: string): boolean {
    const tools = PERMISSION_SWITCH_TOOLS[key];
    if (!tools) return false;
    const disabled = new Set(Array.isArray(disabledTools) ? disabledTools : []);
    return tools.every(tool => !disabled.has(tool));
}

/**
 * Nowa lista `disabled_tools` po przestawieniu jednego przełącznika. Narzędzi spoza mapy
 * przełącznika NIE RUSZA — user, który wyłączył sobie np. `web_search`, nie traci tego ustawienia
 * przy klikaniu w wiersz „Usuwanie plików".
 */
export function applyPermissionSwitch(disabledTools: string[] | undefined, key: string, on: boolean): string[] {
    const tools = PERMISSION_SWITCH_TOOLS[key];
    const current = normalizeDisabledTools(disabledTools);
    if (!tools) return current;
    if (on) return current.filter(tool => !tools.includes(tool));
    return normalizeDisabledTools([...current, ...tools]);
}

/**
 * Presety popovera wyrażone w tych samych przełącznikach. Dotykają WYŁĄCZNIE osi vaultowej —
 * grupy web/multimodal/delegacja/artefakty/komunikator zostają takie, jakie user ustawił
 * w profilu agenta.
 */
export const PERMISSION_PRESET_SWITCHES: Record<string, Record<string, boolean>> = {
    safe: { read_notes: true, edit_notes: false, create_files: false, delete_files: false },
    standard: { read_notes: true, edit_notes: true, create_files: true, delete_files: false },
    full: { read_notes: true, edit_notes: true, create_files: true, delete_files: true },
};

/** Nowa lista `disabled_tools` po zastosowaniu presetu (kolejno każdy przełącznik). */
export function applyPermissionPreset(disabledTools: string[] | undefined, preset: Record<string, boolean>): string[] {
    let out = normalizeDisabledTools(disabledTools);
    for (const [key, on] of Object.entries(preset || {})) {
        out = applyPermissionSwitch(out, key, on);
    }
    return out;
}

/**
 * Czy config agenta niesie stare osie narzędzi (sygnał do migracji przy load).
 * @param {Object} config
 * @returns {boolean}
 */
export function hasLegacyToolAxis(config: LegacyToolAxisConfig = {}) {
    return Boolean(
        Array.isArray(config.mcp_servers)
        || (Array.isArray(config.enabled_tools) && config.enabled_tools.length > 0)
        || (config.default_permissions && typeof config.default_permissions === 'object')
    );
}
