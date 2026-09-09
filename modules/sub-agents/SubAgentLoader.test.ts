import test from 'ava';
import {
    SubAgentLoader as RuntimeSubAgentLoader,
    getVisibleSubAgentsForAgent as runtimeGetVisibleSubAgentsForAgent,
    migrateDeprecatedTools as runtimeMigrateDeprecatedTools,
    DEFAULT_SUB_AGENT_TOOLS,
} from './SubAgentLoader.js';
import { DEFAULT_LIMITS } from '../../config/limits.js';

type TestSubAgent = Record<string, unknown> & {
    name: string;
    tools: string[];
    scope: { folders: string[]; sections: string[]; pinned_notes: string[] };
    max_iterations: number;
    max_tool_result_length: number;
};
type TestLoader = {
    loadSystemRoles?: unknown;
    loadAllSubAgents(): Promise<void>;
    getSubAgent(name: string): TestSubAgent;
    createPrepSubAgent(agentName: string): Promise<string>;
    deleteSubAgent(name: string): Promise<boolean>;
};
const SubAgentLoader = RuntimeSubAgentLoader as unknown as new (vault: unknown) => TestLoader;
const getVisibleSubAgentsForAgent = runtimeGetVisibleSubAgentsForAgent as unknown as (agent: unknown, subAgents: unknown[]) => Array<Record<string, unknown>>;
const migrateDeprecatedTools = runtimeMigrateDeprecatedTools as unknown as (data: Record<string, unknown>) => { changed: boolean; renamed: number; deduped: number; mappings: unknown[] };

function makeVault(files: Record<string, string> = {}) {
    const folders = new Set<string>();
    for (const path of Object.keys(files)) {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    }
    return {
        adapter: {
            exists: async (path: string) => Object.prototype.hasOwnProperty.call(files, path) || folders.has(path),
            read: async (path: string) => files[path],
            write: async (path: string, content: string) => { files[path] = content; },
            mkdir: async (path: string) => { folders.add(path); },
            remove: async (path: string) => { delete files[path]; },
            rmdir: async (path: string) => { folders.delete(path); },
            list: async (path: string) => ({
                folders: Array.from(folders).filter(folder => {
                    const rest = folder.slice(path.length + 1);
                    return folder.startsWith(`${path}/`) && rest && !rest.includes('/');
                }),
                files: Object.keys(files).filter(file => {
                    const rest = file.slice(path.length + 1);
                    return file.startsWith(`${path}/`) && rest && !rest.includes('/');
                }),
            }),
        }
    };
}

// Brak ról systemowych — plugin nie ma żadnych wbudowanych subów.
test('DEFAULT_SUB_AGENT_TOOLS is the uniform generic worker toolset', t => {
    t.deepEqual(DEFAULT_SUB_AGENT_TOOLS, ['search', 'list', 'read', 'web_search', 'web_read']);
});

test('SubAgentLoader has no loadSystemRoles (no system roles)', t => {
    const loader = new SubAgentLoader(makeVault());
    t.is(typeof loader.loadSystemRoles, 'undefined');
});

test('getVisibleSubAgentsForAgent returns ONLY custom subs matching the agent prefix', t => {
    const visible = getVisibleSubAgentsForAgent({ name: 'Jaskier' }, [
        { name: 'jaskier-prep' },
        { name: 'jaskier-strateg' },
        { name: 'kustosz-prep' },
        { name: 'prep' },
        // Flaga system:true nie daje globalnej widoczności — bez prefiksu = ukryty.
        { name: 'prep-memory', system: true },
    ]);

    t.deepEqual(visible.map(sa => sa.name), ['jaskier-prep', 'jaskier-strateg']);
    // Brak dekoracji [SYSTEM]/[CUSTOM] w wyniku — wszystkie widoczne suby są custom.
    t.true(visible.every(sa => sa.badge === undefined && sa.isSystem === undefined));
});

test('getVisibleSubAgentsForAgent returns empty list when the agent has no prefix', t => {
    t.deepEqual(getVisibleSubAgentsForAgent({}, [{ name: 'jaskier-prep' }]), []);
});

test('loadAllSubAgents parses custom YAML scope', async t => {
    const vault = makeVault({
        '.pkm-assistant/sub-agents/prep-x/SUB_AGENT.yaml': [
            'name: prep-x',
            'description: Scoped finder',
            'role: researcher',
            'tools: [vault_grep, vault_read]',
            'scope:',
            '  folders: ["Projekty/X/"]',
            '  sections: ["## Drafty"]',
            '  pinned_notes: ["Strategia X.md"]',
        ].join('\n'),
        '.pkm-assistant/sub-agents/prep-x/KNOWLEDGE.md': 'Find X posts.',
    });
    const loader = new SubAgentLoader(vault);

    await loader.loadAllSubAgents();
    const config = loader.getSubAgent('prep-x');

    t.deepEqual(config.scope.folders, ['Projekty/X/']);
    t.deepEqual(config.scope.sections, ['## Drafty']);
    t.deepEqual(config.scope.pinned_notes, ['Strategia X.md']);
    t.is(config.max_tool_result_length, 15000);
});

// createPrepSubAgent NIE wolno hardcodować literałów
// (max_iterations: 8, max_tool_result_length: 15000) — musi czytać z config/limits.ts przez
// defaultMaxIterations()/defaultMaxToolResultLength(), żeby zmiana kanonicznych defaultów
// dotarła też do nowo odlewanych prep-subów, nie tylko do runtime fallbacku w runnerze.
test('createPrepSubAgent zapisuje KANONICZNE defaulty z config/limits.ts, nie zwietrzałe literały', async t => {
    const loader = new SubAgentLoader(makeVault());

    await loader.createPrepSubAgent('Jaskier');
    const config = loader.getSubAgent('jaskier-prep');

    t.is(config.max_iterations, DEFAULT_LIMITS.subagent_max_iterations_worker);
    t.not(config.max_iterations, 8, 'stary hardcodowany default nie może wrócić');
    t.is(config.max_tool_result_length, DEFAULT_LIMITS.max_tool_result_length);
});

// Dawne czytniki pamięci mapują wprost na prymitywy list/read (single-pass, bez łańcuchów).
for (const [oldTool, newTool] of [
    ['memory_sessions', 'list'],
    ['memory_summaries', 'read'],
    ['memory_list_summaries', 'list'],
    ['memory_read_summary', 'read'],
]) {
    test(`migrateDeprecatedTools rewrites ${oldTool} to ${newTool}`, t => {
        // Kontrola: web_search NIE jest deprecated → zostaje bez zmian.
        const yamlData = {
            tools: ['web_search', oldTool, newTool, 'chat_todo'],
        };

        const result = migrateDeprecatedTools(yamlData);

        t.true(result.changed);
        t.is(result.renamed, 1);
        t.is(result.deduped, 1);
        t.deepEqual(yamlData.tools, ['web_search', newTool, 'chat_todo']);
        t.deepEqual(result.mappings, [{ from: oldTool, to: newTool, count: 1 }]);
    });
}

test('migrateDeprecatedTools rewrites deprecated retrieval names to search', t => {
    const yamlData = { tools: ['vault_grep', 'web_search'] };
    const result = migrateDeprecatedTools(yamlData);
    t.true(result.changed);
    t.is(result.renamed, 1);
    t.deepEqual(yamlData.tools, ['search', 'web_search']);
});

test('migrateDeprecatedTools collapses multiple retrieval aliases into one search', t => {
    const yamlData = { tools: ['vault_grep', 'vault_semantic', 'vault_filter_yaml', 'web_search'] };
    const result = migrateDeprecatedTools(yamlData);
    t.true(result.changed);
    t.is(result.renamed, 3);
    t.is(result.deduped, 2);
    t.deepEqual(yamlData.tools, ['search', 'web_search']);
});

test('migrateDeprecatedTools rewrites deprecated file primitives (vault_read → read, vault_write → write)', t => {
    const yamlData = { tools: ['vault_read', 'vault_write', 'vault_list', 'vault_delete', 'vault_create_folder'] };
    const result = migrateDeprecatedTools(yamlData);
    t.true(result.changed);
    t.is(result.renamed, 5);
    t.deepEqual(yamlData.tools, ['read', 'write', 'list', 'delete', 'create_folder']);
});

test('loadAllSubAgents persists deprecated tool migration to YAML', async t => {
    const files = {
        '.pkm-assistant/sub-agents/klara-prep/SUB_AGENT.yaml': [
            'name: klara-prep',
            'description: Prep Klary',
            'role: researcher',
            'tools:',
            '  - vault_search',
            '  - memory_sessions',
            '  - memory_list_summaries',
            '  - vault_read',
        ].join('\n'),
    };
    const vault = makeVault(files);
    const loader = new SubAgentLoader(vault);

    await loader.loadAllSubAgents();
    const config = loader.getSubAgent('klara-prep');

    // vault_search → search; memory_sessions + memory_list_summaries → list (dedup); vault_read → read.
    t.deepEqual(config.tools, ['search', 'list', 'read']);
    const yaml = files['.pkm-assistant/sub-agents/klara-prep/SUB_AGENT.yaml'];
    t.false(yaml.includes('memory_sessions'));
    t.false(yaml.includes('vault_search'));
    t.false(yaml.includes('memory_list_summaries'));
    t.true(yaml.includes('search'));
});


// ─── wyczyszczona instrukcja MUSI zniknąć Z DYSKU ─────────────
//
// Gdyby `saveSubAgent` pisał KNOWLEDGE.md tylko pod `if (data.prompt)`, skasowanie
// instrukcji w edytorze zostawiałoby starą treść na dysku: cache mówiłby „pusto", user
// dostawałby Notice „zapisany", a po reloadzie skasowana metoda wracałaby do promptu suba.

type SaveableLoader = TestLoader & { saveSubAgent(data: Record<string, unknown>): Promise<string> };
const KNOWLEDGE = '.pkm-assistant/sub-agents/klara-prep/KNOWLEDGE.md';

test('pusta instrukcja NIE zostawia starego KNOWLEDGE.md na dysku', async t => {
    const files: Record<string, string> = {};
    const loader = new SubAgentLoader(makeVault(files)) as unknown as SaveableLoader;
    await loader.saveSubAgent({ name: 'klara-prep', description: 'zwiad', prompt: 'STARA METODA' });
    t.is(files[KNOWLEDGE], 'STARA METODA', 'punkt wyjścia: instrukcja jest na dysku');

    await loader.saveSubAgent({ name: 'klara-prep', description: 'zwiad', prompt: '' });

    t.falsy(files[KNOWLEDGE], 'skasowana instrukcja znika z dysku, a nie tylko z cache');
});

test('po „reloadzie" skasowana instrukcja NIE wraca do suba', async t => {
    const files: Record<string, string> = {};
    const vault = makeVault(files);
    const pisarz = new SubAgentLoader(vault) as unknown as SaveableLoader;
    await pisarz.saveSubAgent({ name: 'klara-prep', description: 'zwiad', prompt: 'STARA METODA' });
    await pisarz.saveSubAgent({ name: 'klara-prep', description: 'zwiad', prompt: '' });

    const poRestarcie = new SubAgentLoader(vault);
    await poRestarcie.loadAllSubAgents();

    t.is(poRestarcie.getSubAgent('klara-prep').prompt as string, '');
});

test('niepusta instrukcja zapisuje się jak dotąd', async t => {
    const files: Record<string, string> = {};
    const loader = new SubAgentLoader(makeVault(files)) as unknown as SaveableLoader;

    await loader.saveSubAgent({ name: 'klara-prep', description: 'zwiad', prompt: 'NOWA METODA' });

    t.is(files[KNOWLEDGE], 'NOWA METODA');
});

test('pad zapisu leci wyjątkiem do wołającego (nie melduje „zapisany")', async t => {
    const vault = makeVault({});
    vault.adapter.write = async () => { throw new Error('dysk odmówił'); };
    const loader = new SubAgentLoader(vault) as unknown as SaveableLoader;

    await t.throwsAsync(() => loader.saveSubAgent({ name: 'klara-prep', description: 'zwiad', prompt: 'X' }),
        { message: 'dysk odmówił' });
});

// ─── deleteSubAgent — sukces I porażka ─────
//
// Cała logika kasowania z dysku (linie 381-391) nie ma ŻADNEGO innego testu w tym module —
// jedyny inny test dotykający tematu (`deleteOutcome.test.ts`) testuje WYŁĄCZNIE czystą funkcję
// `resolveDeleteOutcome(boolean, string)`, która nigdy nie dotyka `vault.adapter`. Gdyby ktoś
// zostawił samo `this.cache.delete(name); return true;` (wycięcie exists/remove/rmdir), user
// dostałby „Usunięto", sub zniknąłby z listy, a pliki wróciłyby po restarcie Obsidiana.

const KLARA_PREP_YAML = '.pkm-assistant/sub-agents/klara-prep/SUB_AGENT.yaml';
const KLARA_PREP_KNOWLEDGE = '.pkm-assistant/sub-agents/klara-prep/KNOWLEDGE.md';
const KLARA_PREP_FOLDER = '.pkm-assistant/sub-agents/klara-prep';

test('deleteSubAgent kasuje YAML/KNOWLEDGE/folder z dysku i z cache (sukces)', async t => {
    const files: Record<string, string> = {};
    const vault = makeVault(files);
    const loader = new SubAgentLoader(vault) as unknown as SaveableLoader;
    await loader.saveSubAgent({ name: 'klara-prep', description: 'zwiad', prompt: 'METODA' });

    t.truthy(files[KLARA_PREP_YAML], 'punkt wyjścia: YAML jest na dysku');
    t.truthy(files[KLARA_PREP_KNOWLEDGE], 'punkt wyjścia: KNOWLEDGE jest na dysku');

    const ok = await loader.deleteSubAgent('klara-prep');

    t.true(ok);
    t.falsy(files[KLARA_PREP_YAML], 'YAML musi zniknąć z dysku, nie tylko z cache');
    t.falsy(files[KLARA_PREP_KNOWLEDGE], 'KNOWLEDGE musi zniknąć z dysku');
    t.false(await vault.adapter.exists(KLARA_PREP_FOLDER), 'folder suba musi zniknąć z dysku');
    t.falsy(loader.getSubAgent('klara-prep'), 'cache też czyszczony');
});

test('deleteSubAgent — porażka I/O (remove rzuca) zwraca false, cache i plik NIETKNIĘTE', async t => {
    const files: Record<string, string> = {};
    const vault = makeVault(files);
    const loader = new SubAgentLoader(vault) as unknown as SaveableLoader;
    await loader.saveSubAgent({ name: 'klara-prep', description: 'zwiad', prompt: 'METODA' });

    // `remove` (nie `rmdir`) — pętla usuwa pliki PRZED rmdirem, więc to jest pierwszy punkt
    // porażki, który zostawia stan w 100% nietknięty (żaden plik nie zdążył zniknąć).
    vault.adapter.remove = async () => { throw new Error('plik zablokowany (sync w toku)'); };

    const ok = await loader.deleteSubAgent('klara-prep');

    t.false(ok);
    t.truthy(loader.getSubAgent('klara-prep'), 'cache NIE jest czyszczony przy nieudanym kasowaniu');
    t.truthy(files[KLARA_PREP_YAML], 'YAML zostaje na dysku po porażce — user nie może dostać fałszywe „Usunięto"');
    t.truthy(files[KLARA_PREP_KNOWLEDGE], 'KNOWLEDGE też zostaje — porażka nie kasuje połowy suba');
});
