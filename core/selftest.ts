/**
 * core/selftest.ts — raport "PKM Assistant: Self-test" (E1.8, 2026-07-21).
 *
 * PO CO: agent AI (albo Kuba) testuje plugin z zewnątrz — klika w Obsidianie i
 * CZYTA PLIKI. `buildSelfTestReport(plugin, deps)` robi READ-ONLY zdjęcie stanu
 * pluginu (semantyka, narzędzia MCP, agenci, modele, limity, pamięć, file-log),
 * a `formatSelfTestReport(report)` renderuje je do czytelnego markdownu ze statusami
 * ✅/⚠️/❌ per sekcja. Bez mutacji, bez side-effectów (nie tworzy brain.md itd.).
 *
 * DLACZEGO NIE W MODULE: core jest podłogą — NIE importuje z modułów. Jedyny
 * moduł-owy helper którego potrzebuje (liczenie dokumentów Oramy) jest wstrzykiwany
 * przez `deps.countDocs` (main.js podaje go z modules/embedding). Reszta to czyste
 * odczyty z `plugin` + `settings` + `config/limits.js`. Dzięki temu testuje się
 * node'em z fake pluginem.
 */

import { getLimits } from '../config/limits.js';

const OK = 'ok';
const WARN = 'warn';
const ERROR = 'error';
const ICON = { ok: '✅', warn: '⚠️', error: '❌' };

// ─────────────────────────── Typy raportu ───────────────────────────

/** Minimalny kształt błędu w `catch` (err jest `unknown`). */
type ErrLike = { message?: string };

/** Status pojedynczej sekcji raportu. */
export type SelfTestStatus = 'ok' | 'warn' | 'error';

/** Nagłówek raportu. Wszystko opcjonalne — formatter dostaje też raporty odczytane z dysku. */
export interface SelfTestMeta {
    version?: string;
    name?: string;
    generatedAt?: string;
    platform?: string;
}

/** Jedna sekcja raportu. `details` to zawsze mapa `etykieta → tekst` (gotowa do renderu). */
export interface SelfTestSection {
    id: string;
    title: string;
    status: SelfTestStatus;
    reason: string;
    details: Record<string, string>;
}

/** Licznik statusów. Pola opcjonalne z tego samego powodu co w `SelfTestMeta`. */
export interface SelfTestSummary {
    ok?: number;
    warn?: number;
    error?: number;
}

export interface SelfTestReport {
    meta: SelfTestMeta;
    sections: SelfTestSection[];
    summary: SelfTestSummary;
}

// ─────────────────── Typy wejścia (duck-typing pluginu) ───────────────────

/** Status VaultIndexera — self-test tylko go CZYTA, więc kształt jest minimalny. */
interface IndexerStatus {
    status?: string;
    progress?: { indexed?: number; total?: number };
    modelKey?: string;
    lastError?: string;
}

/** Wpis biblioteki modeli (`settings.pkmAssistant.modelLibrary.main[]`). */
interface ModelEntry {
    platform?: string;
    model?: string;
    isDefault?: boolean;
}

/** Ustawienia widziane przez self-test — wyłącznie gałęzie, do których naprawdę zagląda. */
export interface SelfTestSettings {
    pkmAssistant?: {
        komunikatorEnabled?: boolean;
        fileLogEnabled?: boolean;
        modelLibrary?: { main?: ModelEntry[] };
        limits?: Record<string, unknown>;
        chat?: { platform?: string };
        embedding?: { provider?: string };
    };
}

/** Adapter vaulta widziany przez sekcję pamięci (dwie metody, obie read-only). */
interface MemoryAdapterLike {
    exists: (path: string) => Promise<boolean>;
    list: (path: string) => Promise<{ files?: string[] } | null | undefined>;
}

/** Pamięć agenta — sekcja pomija się w całości, gdy któregokolwiek pola brak. */
interface MemoryLike {
    paths?: { brain: string; brainNotes: string };
    vault?: { adapter?: MemoryAdapterLike };
}

/** Agent widziany przez self-test (tylko nazwa). */
interface AgentLike {
    name?: string;
}

/**
 * Rejestr agentów. `agents` bywa `Map` (dziś) ALBO tablicą (zaszłość) — kod obsługuje
 * oba kształty, więc typ też je oba dopuszcza.
 */
interface AgentManagerLike {
    agents?: Map<string, unknown> | unknown[] | null;
    getActiveAgent?: () => AgentLike | null;
    activeAgent?: AgentLike | null;
    getMemoryForAgent?: (agent: AgentLike) => MemoryLike | null;
    getAgentMemory?: (name?: string) => MemoryLike | null;
}

/** Plugin widziany przez self-test. Wszystko opcjonalne: raport ma NIGDY nie wybuchnąć. */
export interface SelfTestPlugin {
    manifest?: { version?: string; name?: string };
    settings?: SelfTestSettings;
    env?: { settings?: SelfTestSettings } | null;
    vaultIndexer?: { getStatus?: () => IndexerStatus | null } | null;
    oramaDb?: unknown;
    toolRegistry?: { getAllToolNames?: () => string[]; tools?: Map<string, unknown> } | null;
    agentManager?: AgentManagerLike | null;
}

/** Wstrzykiwane zależności (core nie importuje z modułów — patrz nagłówek pliku). */
export interface SelfTestDeps {
    /** licznik dokumentów Oramy (z modules/embedding) */
    countDocs?: (db: unknown) => number;
    /** Platform.isMobile */
    isMobile?: boolean;
    /** log.fileSinkActive */
    fileLogActive?: boolean;
    /** testowalny zegar */
    now?: () => Date;
}

/**
 * Zbiera raport diagnostyczny pluginu.
 * @param plugin - instancja pluginu (manifest, settings, agentManager, toolRegistry, vaultIndexer, oramaDb, ...)
 * @param deps - wstrzykiwane zależności (patrz `SelfTestDeps`)
 */
export async function buildSelfTestReport(
    plugin: SelfTestPlugin | null | undefined,
    deps: SelfTestDeps = {},
): Promise<SelfTestReport> {
    const now = deps.now ? deps.now() : new Date();
    const settings: SelfTestSettings = (plugin && (plugin.settings || plugin.env?.settings)) || {};
    const manifest: SelfTestPlugin['manifest'] = (plugin && plugin.manifest) || {};

    const meta = {
        version: manifest.version || 'unknown',
        name: manifest.name || 'PKM Assistant',
        generatedAt: now.toISOString(),
        platform: deps.isMobile ? 'mobile' : 'desktop',
    };

    const sections: SelfTestSection[] = [];
    // Each collector is guarded: one failing section becomes an ❌ row, never a thrown report.
    const collectors: Array<() => SelfTestSection | null | Promise<SelfTestSection | null>> = [
        () => sectionSemantics(plugin, settings, deps),
        () => sectionMcpTools(plugin, settings),
        () => sectionAgents(plugin),
        () => sectionModels(settings),
        () => sectionLimits(settings),
        () => sectionMemory(plugin),
        () => sectionFileLog(settings, deps),
    ];
    for (const collect of collectors) {
        try {
            const section = await collect();
            if (section) sections.push(section);
        } catch (e) {
            sections.push({
                id: 'unknown',
                title: 'Section',
                status: ERROR,
                reason: `collector threw: ${((e as ErrLike)?.message || e) as string}`,
                details: {},
            });
        }
    }

    const summary = { ok: 0, warn: 0, error: 0 };
    for (const s of sections) summary[s.status] = (summary[s.status] || 0) + 1;

    return { meta, sections, summary };
}

// ─────────────────────────── Sekcje ───────────────────────────

function sectionSemantics(
    plugin: SelfTestPlugin | null | undefined,
    _settings: SelfTestSettings,
    deps: SelfTestDeps,
): SelfTestSection {
    const indexer = plugin?.vaultIndexer;
    const status = indexer?.getStatus?.() || null;
    const hasOrama = !!plugin?.oramaDb;
    let docCount: number | null = null;
    if (hasOrama && typeof deps.countDocs === 'function') {
        try { docCount = deps.countDocs(plugin.oramaDb); } catch { docCount = null; }
    }

    const details = {
        indexer_status: status?.status || '(no indexer)',
        progress: status ? `${status.progress?.indexed ?? 0}/${status.progress?.total ?? 0}` : 'n/a',
        model_key: status?.modelKey || '(none)',
        oramaDb: hasOrama ? 'present' : 'absent',
        doc_count: docCount === null ? 'n/a' : String(docCount),
    };

    if (!indexer) {
        return sec('semantics', 'Semantics (vault index)', WARN, 'VaultIndexer not initialized — semantic search falls back to keyword.', details);
    }
    switch (status?.status) {
        case 'ready':
            return sec('semantics', 'Semantics (vault index)', hasOrama ? OK : WARN,
                hasOrama ? `Index ready${docCount === null ? '' : ` (${docCount} docs)`}, oramaDb published.`
                    : 'Indexer ready but plugin.oramaDb not published.', details);
        case 'building':
            return sec('semantics', 'Semantics (vault index)', WARN, `Index still building (${details.progress}).`, details);
        case 'disabled_mobile':
            return sec('semantics', 'Semantics (vault index)', WARN, 'Semantic index disabled on mobile (desktop-first).', details);
        case 'no_provider':
            return sec('semantics', 'Semantics (vault index)', WARN, 'No embedding provider selected — index not built.', details);
        case 'error':
            return sec('semantics', 'Semantics (vault index)', ERROR, `Indexer error: ${status.lastError || 'unknown'}.`, details);
        case 'idle':
            return sec('semantics', 'Semantics (vault index)', WARN, 'Indexer idle — not started yet.', details);
        default:
            return sec('semantics', 'Semantics (vault index)', WARN, `Indexer status: ${status?.status || 'unknown'}.`, details);
    }
}

function sectionMcpTools(
    plugin: SelfTestPlugin | null | undefined,
    settings: SelfTestSettings,
): SelfTestSection {
    const registry = plugin?.toolRegistry;
    const names = registry?.getAllToolNames?.()
        || (registry?.tools ? Array.from(registry.tools.keys()) : []);
    const sorted = [...names].sort();
    const count = sorted.length;

    // S28 D7: flaga domyślnie ON — wyłącza ją dopiero jawne `false` (brak pola = włączone).
    const komunikatorEnabled = settings?.pkmAssistant?.komunikatorEnabled !== false;
    const komTools = sorted.filter((n) => n.startsWith('kom_') || n === 'agent_message');
    const MAIL_TOOLS = ['kom_send', 'kom_list', 'kom_read'];
    const missingMail = komunikatorEnabled ? MAIL_TOOLS.filter((n) => !sorted.includes(n)) : [];

    const details = {
        registered: String(count),
        komunikator_flag: komunikatorEnabled ? 'enabled' : 'disabled',
        kom_tools_present: komTools.length ? komTools.join(', ') : 'none',
        tools: sorted.join(', ') || '(none)',
    };

    // Przeciek wyłącznika: wyłączony komunikator NIE MOŻE wystawiać żadnego `kom_*`.
    if (!komunikatorEnabled && komTools.length > 0) {
        return sec('mcp', 'MCP tools', ERROR,
            `Communicator disabled but ${komTools.length} kom_* tool(s) registered — kill-switch leak.`, details);
    }
    if (count === 0) {
        return sec('mcp', 'MCP tools', WARN, 'No tools registered.', details);
    }
    // Odwrotna niespójność: włączona poczta bez własnych narzędzi = coś się nie zarejestrowało.
    if (missingMail.length > 0) {
        return sec('mcp', 'MCP tools', ERROR,
            `Communicator enabled but mail tool(s) missing: ${missingMail.join(', ')}.`, details);
    }
    const consistency = komunikatorEnabled
        ? 'communicator enabled, kom_send/kom_list/kom_read present (consistent)'
        : 'communicator disabled, kom_* absent (consistent)';
    return sec('mcp', 'MCP tools', OK, `${count} tools registered; ${consistency}.`, details);
}

function sectionAgents(plugin: SelfTestPlugin | null | undefined): SelfTestSection {
    const am = plugin?.agentManager;
    // Asercja zamiast rozgałęzienia: `agents` bywa `Map` ALBO tablicą, a `?.size` istnieje
    // tylko na pierwszym kształcie — drugi łapie `Array.isArray` w tej samej linii.
    const agentCount = (am?.agents as Map<string, unknown> | undefined)?.size
        ?? (Array.isArray(am?.agents) ? am.agents.length : 0);
    const active = am?.getActiveAgent?.()?.name || am?.activeAgent?.name || null;
    const details = { loaded: String(agentCount), active: active || '(none)' };

    if (!am) return sec('agents', 'Agents', WARN, 'AgentManager not initialized.', details);
    if (agentCount === 0) return sec('agents', 'Agents', WARN, 'No agents loaded.', details);
    if (!active) return sec('agents', 'Agents', WARN, `${agentCount} agent(s) loaded but none active.`, details);
    return sec('agents', 'Agents', OK, `${agentCount} agent(s) loaded, active: ${active}.`, details);
}

function sectionModels(settings: SelfTestSettings): SelfTestSection {
    const pkm = settings?.pkmAssistant || {};
    const mainModels = Array.isArray(pkm.modelLibrary?.main) ? pkm.modelLibrary.main : [];
    const mainDefault = mainModels.find((m) => m?.isDefault) || mainModels[0] || null;

    let chatPlatform = mainDefault?.platform || null;
    const chatModel = mainDefault?.model || null;
    if (!chatPlatform) {
        chatPlatform = settings?.pkmAssistant?.chat?.platform || null;
    }
    const embedProvider = settings?.pkmAssistant?.embedding?.provider || '';

    const details = {
        chat_platform: chatPlatform || '(not configured)',
        chat_model: chatModel || '(not configured)',
        embedding_provider: embedProvider || '(not configured)',
    };

    if (!chatModel && !chatPlatform) {
        return sec('models', 'Models', WARN, 'Chat model not configured (Settings → Models).', details);
    }
    if (!embedProvider) {
        return sec('models', 'Models', WARN, `Chat: ${chatPlatform}/${chatModel || '?'}; embedding provider not configured.`, details);
    }
    return sec('models', 'Models', OK, `Chat: ${chatPlatform}/${chatModel || '?'}; embedding: ${embedProvider}.`, details);
}

function sectionLimits(settings: SelfTestSettings): SelfTestSection {
    const limits = getLimits(settings);
    const details: Record<string, string> = {};
    for (const [k, v] of Object.entries(limits)) details[k] = String(v);
    return sec('limits', 'Limits (agent leashes)', OK, 'Effective loop/timeout limits resolved.', details);
}

async function sectionMemory(plugin: SelfTestPlugin | null | undefined): Promise<SelfTestSection | null> {
    const am = plugin?.agentManager;
    const activeAgent = am?.getActiveAgent?.() || am?.activeAgent || null;
    // `am!` — `activeAgent` może być prawdziwe TYLKO wtedy, gdy `am` istnieje (linia wyżej).
    const memory = activeAgent
        ? (am!.getMemoryForAgent?.(activeAgent) || am!.getAgentMemory?.(activeAgent.name))
        : null;

    // "inaczej pomiń sekcję" — skip cleanly when memory isn't cheaply reachable.
    if (!memory || !memory.paths || !memory.vault?.adapter) return null;

    const adapter = memory.vault.adapter;
    const brainPath = memory.paths.brain;
    const notesDir = memory.paths.brainNotes;

    let brainExists = false;
    let notesCount: number | null = null;
    try { brainExists = !!(await adapter.exists(brainPath)); } catch { brainExists = false; }
    try {
        if (notesDir && (await adapter.exists(notesDir))) {
            const listed = await adapter.list(notesDir);
            const prefix = notesDir.endsWith('/') ? notesDir : notesDir + '/';
            notesCount = (listed?.files || [])
                .filter((p) => p.endsWith('.md'))
                .filter((p) => {
                    const rel = p.startsWith(prefix) ? p.slice(prefix.length) : p;
                    return rel && !rel.includes('/'); // top-level only (exclude brain/archive/)
                }).length;
        } else {
            notesCount = 0;
        }
    } catch { notesCount = null; }

    const details = {
        agent: activeAgent?.name || '(unknown)',
        'brain.md': brainExists ? 'exists' : 'missing',
        brain_notes: notesCount === null ? 'n/a' : String(notesCount),
    };
    return sec('memory', 'Active agent memory', brainExists ? OK : WARN,
        brainExists
            ? `brain.md present${notesCount === null ? '' : `, ${notesCount} note(s) in brain/`}.`
            : 'No brain.md yet for the active agent (created on first save).', details);
}

function sectionFileLog(settings: SelfTestSettings, deps: SelfTestDeps): SelfTestSection {
    const enabled = settings?.pkmAssistant?.fileLogEnabled !== false;
    const active = deps.fileLogActive === true;
    const details = {
        setting: enabled ? 'enabled' : 'disabled',
        sink: active ? 'active' : 'inactive',
        path: '.pkm-assistant/logs/pkm-assistant.log',
    };
    if (enabled && active) return sec('filelog', 'File log', OK, 'Log file sink active — logs written to disk.', details);
    if (enabled && !active) return sec('filelog', 'File log', WARN, 'Enabled in settings but sink not active.', details);
    return sec('filelog', 'File log', WARN, 'File log disabled — logs go to console only.', details);
}

// ─────────────────────────── Formatowanie ───────────────────────────

/**
 * Renderuje raport do markdownu (czysta funkcja, testowalna).
 * @param report - raport z `buildSelfTestReport` (albo jego kawałek — wszystko ma domyślne).
 */
export function formatSelfTestReport(report: Partial<SelfTestReport> | null | undefined): string {
    const { meta = {}, sections = [], summary = {} } = report || {};
    const lines: string[] = [];
    lines.push(`# ${meta.name || 'PKM Assistant'} — Self-test`);
    lines.push('');
    lines.push(`- Version: ${meta.version || 'unknown'}`);
    lines.push(`- Generated: ${meta.generatedAt || ''}`);
    lines.push(`- Platform: ${meta.platform || 'desktop'}`);
    lines.push(`- Summary: ${summary.ok || 0} ✅ · ${summary.warn || 0} ⚠️ · ${summary.error || 0} ❌`);
    lines.push('');

    for (const s of sections) {
        const icon = ICON[s.status] || '•';
        lines.push(`## ${icon} ${s.title} — ${s.reason}`);
        const details = s.details || {};
        for (const [k, v] of Object.entries(details)) {
            lines.push(`- **${k}:** ${v}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

// ─────────────────────────── helpery ───────────────────────────

function sec(
    id: string,
    title: string,
    status: SelfTestStatus,
    reason: string,
    details?: Record<string, string>,
): SelfTestSection {
    return { id, title, status, reason, details: details || {} };
}
