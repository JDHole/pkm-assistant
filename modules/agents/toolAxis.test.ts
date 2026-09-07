import test from 'ava';
import {
    BUILTIN_TOOL_GROUPS,
    ALL_BUILTIN_TOOLS,
    computeDisabledToolsFromLegacy,
    defaultDisabledTools,
    normalizeDisabledTools,
    hasLegacyToolAxis,
    DEFAULT_DISABLED_GROUPS,
    DEFAULT_ENABLED_EXCEPTIONS,
} from './toolAxis.js';
// Deep-import dozwolony w testach (ESLint ignoruje *.test.js) — guard zgodności ze źródłem prawdy.
import { BUILTIN_MANIFESTS } from '../tools/built-in-servers/index.js';

// ─── Guard: mapa grup zgodna z manifestami MCP (źródło prawdy nazw narzędzi) ───

test('BUILTIN_TOOL_GROUPS zgodne z manifestami built-in-servers (bez driftu nazw)', t => {
    const fromManifests: Record<string, string[]> = {};
    for (const m of BUILTIN_MANIFESTS) fromManifests[m.name] = [...m.tools].sort();
    const fromAxis: Record<string, string[]> = {};
    for (const [g, tools] of Object.entries(BUILTIN_TOOL_GROUPS)) fromAxis[g] = [...tools].sort();
    t.deepEqual(fromAxis, fromManifests);
});

// ─── Migracja: 3 warianty (spec sekcja 7) ───

test('migracja: default servery [vault,memory,core] → brak web_search/delegate/generate_image', t => {
    const disabled = computeDisabledToolsFromLegacy({ mcp_servers: ['vault', 'memory', 'core'] });
    t.true(disabled.includes('web_search'));
    t.true(disabled.includes('delegate'));
    t.true(disabled.includes('generate_image'));
    // Vault read-side + memory + core NIE są wyłączone.
    t.false(disabled.includes('read'));
    t.false(disabled.includes('search'));
    t.false(disabled.includes('memory_save'));
    t.false(disabled.includes('ask_user'));
});

test('migracja: [*] → wszystko włączone (disabled = [])', t => {
    t.deepEqual(computeDisabledToolsFromLegacy({ mcp_servers: ['*'] }), []);
    // Nawet z restrykcyjnymi permami — wildcard = pełny dostęp.
    t.deepEqual(computeDisabledToolsFromLegacy({ mcp_servers: ['*'], default_permissions: { edit_notes: false } }), []);
});

test('migracja: enabled_tools niepuste zawęża do wskazanych + core', t => {
    const disabled = computeDisabledToolsFromLegacy({
        mcp_servers: ['vault'],
        enabled_tools: ['read', 'search'],
    });
    const enabled = ALL_BUILTIN_TOOLS.filter(t => !disabled.includes(t));
    t.deepEqual(enabled.sort(), ['ask_user', 'read', 'search'].sort());
});

test('migracja: uprawnienia akcji zawężają zestaw (edit_notes/delete_files false → write/delete OUT)', t => {
    const disabled = computeDisabledToolsFromLegacy({
        mcp_servers: ['vault'],
        default_permissions: { read_notes: true, edit_notes: false, create_files: false, delete_files: false },
    });
    t.true(disabled.includes('write'));
    t.true(disabled.includes('create_folder'));
    t.true(disabled.includes('delete'));
    t.false(disabled.includes('read'));
    t.false(disabled.includes('search'));
});

test('migracja: pełne uprawnienia vault → wszystkie narzędzia vaulta ON', t => {
    const disabled = computeDisabledToolsFromLegacy({
        mcp_servers: ['vault', 'memory'],
        default_permissions: { read_notes: true, edit_notes: true, create_files: true, delete_files: true },
    });
    for (const tool of BUILTIN_TOOL_GROUPS.vault) t.false(disabled.includes(tool), `${tool} enabled`);
    for (const tool of BUILTIN_TOOL_GROUPS.memory) t.false(disabled.includes(tool), `${tool} enabled`);
});

test('migracja: mcp:false degraduje delegację, ale nie vault (short-circuit only-core usunięty)', t => {
    const disabled = computeDisabledToolsFromLegacy({
        mcp_servers: ['vault', 'delegation'],
        default_permissions: { mcp: false, edit_notes: true },
    });
    t.true(disabled.includes('delegate'));
    t.false(disabled.includes('read'), 'vault dalej dostępny mimo mcp:false');
});

// ─── Default nowego agenta ───

test('defaultDisabledTools: 5 grup wyłączonych (web/multimodal/delegation/artifacts/komunikator) minus wyjątki', t => {
    const disabled = defaultDisabledTools();
    const exceptions = new Set(DEFAULT_ENABLED_EXCEPTIONS);
    const expected = DEFAULT_DISABLED_GROUPS.flatMap(g => BUILTIN_TOOL_GROUPS[g]).filter(x => !exceptions.has(x)).sort();
    t.deepEqual([...disabled].sort(), expected);
    // vault + memory + core NIE są wyłączone (świeży agent ma je w całości).
    for (const tool of [...BUILTIN_TOOL_GROUPS.vault, ...BUILTIN_TOOL_GROUPS.memory, ...BUILTIN_TOOL_GROUPS.core]) {
        t.false(disabled.includes(tool));
    }
    // E2.9 D1: `todo` jest wyjątkiem — default ON mimo grupy artifacts wyłączonej.
    t.false(disabled.includes('todo'), 'todo default ON (wyjątek z grupy artifacts)');
    t.true(disabled.includes('artifact_create'), 'reszta grupy artifacts zostaje OFF');
});

// ─── normalize + wykrywanie starej osi ───

test('normalizeDisabledTools: odfiltrowuje core (ask_user), dedupuje, tnie nie-stringi', t => {
    t.deepEqual(normalizeDisabledTools(['write', 'write', 'ask_user', 'delete', null, 5]).sort(), ['delete', 'write']);
    t.deepEqual(normalizeDisabledTools(null), []);
    t.deepEqual(normalizeDisabledTools('nope'), []);
});

test('hasLegacyToolAxis: wykrywa stare osie', t => {
    t.true(hasLegacyToolAxis({ mcp_servers: ['vault'] }));
    t.true(hasLegacyToolAxis({ enabled_tools: ['read'] }));
    t.true(hasLegacyToolAxis({ default_permissions: { memory: true } }));
    t.false(hasLegacyToolAxis({}));
    t.false(hasLegacyToolAxis({ enabled_tools: [] }));
});
