import test from 'ava';
import { buildSelfTestReport, formatSelfTestReport } from './selftest.js';
import type { SelfTestReport, SelfTestSection } from './selftest.js';

// ─────────────────────────── fakes ───────────────────────────

type FakeIndexerStatus = {
    status?: string;
    progress?: { indexed?: number; total?: number };
    model_key?: string;
    lastError?: string;
};

type FakeModel = { platform?: string; model?: string; isDefault?: boolean };

type FakeMemory = {
    paths: { brain: string; brainNotes: string };
    vault: {
        adapter: {
            exists(p: string): Promise<boolean>;
            list(p: string): Promise<{ files: string[]; folders: string[] }>;
        };
    };
};

type MakePluginOpts = {
    komunikatorEnabled?: boolean;
    tools?: string[];
    indexerStatus?: FakeIndexerStatus;
    hasIndexer?: boolean;
    hasOrama?: boolean;
    agents?: string[];
    active?: string | null;
    memory?: FakeMemory | null;
    modelLibrary?: { main?: FakeModel[] };
    embedProvider?: string;
    fileLogEnabled?: boolean;
};

/**
 * Fake pluginu. Pola `settings` są OPCJONALNE tam, gdzie testy je kasują (`delete`) —
 * inaczej TS by tego nie wpuścił.
 */
type FakePlugin = {
    manifest: { version: string; name: string };
    settings: {
        pkmAssistant: {
            komunikatorEnabled?: boolean;
            fileLogEnabled?: boolean;
            modelLibrary?: { main?: FakeModel[] };
            embedding: { provider: string };
            chat?: { platform?: string };
        };
    };
    vaultIndexer: { getStatus: () => FakeIndexerStatus } | null;
    oramaDb: { __fake: true } | null;
    toolRegistry: { getAllToolNames: () => string[] };
    agentManager: {
        agents: Map<string, { name: string }>;
        getActiveAgent: () => { name: string } | null;
        getMemoryForAgent: () => FakeMemory | null;
        getAgentMemory: () => FakeMemory | null;
    };
};

function makePlugin(opts: MakePluginOpts = {}): FakePlugin {
    const {
        komunikatorEnabled = false,
        tools = ['vault_read', 'memory_save', 'ask_user'],
        indexerStatus = { status: 'ready', progress: { indexed: 10, total: 10 }, model_key: 'ollama:snowflake' },
        hasIndexer = true,
        hasOrama = true,
        agents = ['jaskier'],
        active = 'jaskier',
        memory = null,
        modelLibrary = { main: [{ platform: 'anthropic', model: 'claude-x', isDefault: true }] },
        embedProvider = 'ollama',
        fileLogEnabled = true,
    } = opts;

    const am = {
        agents: new Map(agents.map((n): [string, { name: string }] => [n, { name: n }])),
        getActiveAgent: () => (active ? { name: active } : null),
        getMemoryForAgent: () => memory,
        getAgentMemory: () => memory,
    };

    return {
        manifest: { version: '2.1.0', name: 'PKM Assistant' },
        settings: {
            pkmAssistant: { komunikatorEnabled, fileLogEnabled, modelLibrary, embedding: { provider: embedProvider } },
        },
        vaultIndexer: hasIndexer ? { getStatus: () => indexerStatus } : null,
        oramaDb: hasOrama ? { __fake: true } : null,
        toolRegistry: { getAllToolNames: () => tools },
        agentManager: am,
    };
}

function makeMemory(
    { brainExists = true, notes = [], archived = [] }:
        { brainExists?: boolean; notes?: string[]; archived?: string[] } = {},
): FakeMemory {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const brainPath = `${base}/brain.md`;
    const notesDir = `${base}/brain`;
    const topFiles = notes.map((n) => `${notesDir}/${n}`);
    const archFiles = archived.map((n) => `${notesDir}/archive/${n}`);
    const existing = new Set([notesDir, ...(brainExists ? [brainPath] : []), ...topFiles, ...archFiles]);
    return {
        paths: { brain: brainPath, brainNotes: notesDir },
        vault: {
            adapter: {
                async exists(p: string) { return existing.has(p); },
                async list(p: string) {
                    if (p === notesDir) return { files: [...topFiles, ...archFiles], folders: [`${notesDir}/archive`] };
                    return { files: [], folders: [] };
                },
            },
        },
    };
}

function findSection(report: SelfTestReport, id: string): SelfTestSection | undefined {
    return report.sections.find((s) => s.id === id);
}

// ─────────────────────────── happy path ───────────────────────────

test('happy path: present sections OK, memory skipped when absent', async (t) => {
    const report = await buildSelfTestReport(makePlugin(), { countDocs: () => 42, fileLogActive: true });
    t.is(findSection(report, 'semantics')!.status, 'ok');
    t.is(findSection(report, 'mcp')!.status, 'ok');
    t.is(findSection(report, 'agents')!.status, 'ok');
    t.is(findSection(report, 'models')!.status, 'ok');
    t.is(findSection(report, 'limits')!.status, 'ok');
    t.is(findSection(report, 'filelog')!.status, 'ok');
    t.is(findSection(report, 'memory'), undefined); // no memory → skipped
    t.is(report.summary.error, 0);
    t.is(findSection(report, 'semantics')!.details.doc_count, '42');
});

// ─────────────────────────── semantics ───────────────────────────

test('no indexer → semantics WARN', async (t) => {
    const report = await buildSelfTestReport(makePlugin({ hasIndexer: false, hasOrama: false }), {});
    t.is(findSection(report, 'semantics')!.status, 'warn');
});

test('indexer error → semantics ERROR', async (t) => {
    const report = await buildSelfTestReport(
        makePlugin({ indexerStatus: { status: 'error', lastError: 'embed 500', progress: { indexed: 0, total: 5 } } }),
        {}
    );
    const s = findSection(report, 'semantics')!;
    t.is(s.status, 'error');
    t.true(s.reason.includes('embed 500'));
});

test('semantics OK without countDocs (doc_count n/a)', async (t) => {
    const report = await buildSelfTestReport(makePlugin(), {}); // no countDocs injected
    const s = findSection(report, 'semantics')!;
    t.is(s.status, 'ok');
    t.is(s.details.doc_count, 'n/a');
});

test('no_provider status → semantics WARN', async (t) => {
    const report = await buildSelfTestReport(
        makePlugin({ indexerStatus: { status: 'no_provider', progress: { indexed: 0, total: 0 } }, hasOrama: false }),
        {}
    );
    t.is(findSection(report, 'semantics')!.status, 'warn');
});

// ─────────────────────────── mcp tools + kill-switch ───────────────────────────

test('communicator disabled but kom_* present → mcp ERROR (leak)', async (t) => {
    const report = await buildSelfTestReport(
        makePlugin({ komunikatorEnabled: false, tools: ['vault_read', 'kom_send'] }),
        {}
    );
    t.is(findSection(report, 'mcp')!.status, 'error');
});

test('communicator disabled, no kom_* → mcp OK', async (t) => {
    const report = await buildSelfTestReport(
        makePlugin({ komunikatorEnabled: false, tools: ['vault_read', 'memory_save'] }),
        {}
    );
    const m = findSection(report, 'mcp')!;
    t.is(m.status, 'ok');
    t.is(m.details.kom_tools_present, 'none');
});

test('S28: komunikator włączony + komplet kom_send/kom_list/kom_read → mcp OK', async (t) => {
    const report = await buildSelfTestReport(
        makePlugin({ komunikatorEnabled: true, tools: ['read', 'kom_send', 'kom_list', 'kom_read'] }),
        {}
    );
    const m = findSection(report, 'mcp')!;
    t.is(m.status, 'ok');
    t.is(m.details.komunikator_flag, 'enabled');
    t.is(m.details.kom_tools_present, 'kom_list, kom_read, kom_send');
});

test('S28: komunikator włączony, ale narzędzia poczty się nie zarejestrowały → mcp ERROR', async (t) => {
    const report = await buildSelfTestReport(
        makePlugin({ komunikatorEnabled: true, tools: ['read', 'kom_send'] }),
        {}
    );
    const m = findSection(report, 'mcp')!;
    t.is(m.status, 'error');
    t.regex(m.reason, /kom_list/);
    t.regex(m.reason, /kom_read/);
});

test('S28: brak pola w ustawieniach = komunikator WŁĄCZONY (default ON)', async (t) => {
    const plugin = makePlugin({ tools: ['read', 'kom_send', 'kom_list', 'kom_read'] });
    delete plugin.settings.pkmAssistant.komunikatorEnabled;
    const report = await buildSelfTestReport(plugin, {});
    t.is(findSection(report, 'mcp')!.details.komunikator_flag, 'enabled');
});

test('no tools registered → mcp WARN', async (t) => {
    const report = await buildSelfTestReport(makePlugin({ tools: [] }), {});
    t.is(findSection(report, 'mcp')!.status, 'warn');
});

test('mcp tool list is sorted', async (t) => {
    const report = await buildSelfTestReport(makePlugin({ tools: ['zeta', 'alpha', 'mid'] }), {});
    t.is(findSection(report, 'mcp')!.details.tools, 'alpha, mid, zeta');
});

// ─────────────────────────── agents ───────────────────────────

test('no agents loaded → agents WARN', async (t) => {
    const report = await buildSelfTestReport(makePlugin({ agents: [], active: null }), {});
    t.is(findSection(report, 'agents')!.status, 'warn');
});

test('agents loaded but none active → agents WARN', async (t) => {
    const report = await buildSelfTestReport(makePlugin({ agents: ['jaskier'], active: null }), {});
    t.is(findSection(report, 'agents')!.status, 'warn');
});

// ─────────────────────────── models ───────────────────────────

test('models: legacy chat settings + no embedding → WARN', async (t) => {
    const p = makePlugin({ modelLibrary: {}, embedProvider: '' });
    p.settings.pkmAssistant.chat = { platform: 'ollama' };
    const report = await buildSelfTestReport(p, {});
    const m = findSection(report, 'models')!;
    t.is(m.status, 'warn');
    t.is(m.details.chat_platform, 'ollama');
});

// ─────────────────────────── memory ───────────────────────────

test('memory: brain.md present → OK with note count (archive excluded)', async (t) => {
    const memory = makeMemory({ brainExists: true, notes: ['user_x.md', 'agent_rule_y.md'], archived: ['old.md'] });
    const report = await buildSelfTestReport(makePlugin({ memory }), {});
    const m = findSection(report, 'memory')!;
    t.is(m.status, 'ok');
    t.is(m.details.brain_notes, '2');
});

test('memory: no brain.md → WARN', async (t) => {
    const memory = makeMemory({ brainExists: false, notes: [] });
    const report = await buildSelfTestReport(makePlugin({ memory }), {});
    t.is(findSection(report, 'memory')!.status, 'warn');
});

// ─────────────────────────── file log ───────────────────────────

test('file log enabled + sink active → OK', async (t) => {
    const report = await buildSelfTestReport(makePlugin({ fileLogEnabled: true }), { fileLogActive: true });
    t.is(findSection(report, 'filelog')!.status, 'ok');
});

test('file log enabled but sink inactive → WARN', async (t) => {
    const report = await buildSelfTestReport(makePlugin({ fileLogEnabled: true }), { fileLogActive: false });
    t.is(findSection(report, 'filelog')!.status, 'warn');
});

// ─────────────────────────── meta + format + robustness ───────────────────────────

test('meta reflects mobile platform', async (t) => {
    const report = await buildSelfTestReport(makePlugin(), { isMobile: true });
    t.is(report.meta.platform, 'mobile');
});

test('empty plugin does not throw and yields sections', async (t) => {
    const report = await buildSelfTestReport({}, {});
    t.true(report.sections.length >= 5);
    t.is(report.meta.version, 'unknown');
});

test('formatSelfTestReport renders headers, summary, detail bullets', async (t) => {
    const report = await buildSelfTestReport(makePlugin(), { countDocs: () => 5, fileLogActive: true });
    const md = formatSelfTestReport(report);
    t.true(md.startsWith('# PKM Assistant — Self-test'));
    t.true(md.includes('- Version: 2.1.0'));
    t.true(md.includes('Summary:'));
    t.true(md.includes('## ✅'));
    t.true(md.includes('**registered:**'));
});
