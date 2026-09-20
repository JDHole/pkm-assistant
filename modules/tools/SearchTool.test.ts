import test from 'ava';
import { createSearchTool, resolveSearchScope } from './SearchTool.js';
import type { SearchToolArgs, SearchToolPlugin, SearchScopeDecision } from './SearchTool.js';
import { setLocale } from '../../core/i18n/index.js';
import { resolveSearchAlias } from './toolAliases.js';

/** Trafienie wyszukiwania czytane w asercjach. */
type SearchHit = { path: string; title?: string; excerpt?: string; matched?: unknown };

/** Wynik `search` czytany w asercjach — kształt zależy od gałęzi, więc pola opcjonalne. */
type SearchRes = {
    success?: boolean;
    error?: string;
    scope?: string;
    mode_used?: string;
    note?: string;
    scope_hint?: string;
    results: SearchHit[];
};

function makeAdapter(files: Record<string, string>) {
    const paths = Object.keys(files);
    return {
        async read(p: string) {
            if (!(p in files)) throw new Error(`ENOENT ${p}`);
            return files[p];
        },
        async exists(p: string) {
            if (p in files) return true;
            const prefix = `${p.replace(/\/$/, '')}/`;
            return paths.some(x => x.startsWith(prefix));
        },
        async list(dir: string) {
            const norm = (dir === '/' || dir === '') ? '' : `${dir.replace(/\/$/, '')}/`;
            const filesOut = new Set<string>();
            const foldersOut = new Set<string>();
            for (const p of paths) {
                if (norm && !p.startsWith(norm)) continue;
                const rest = p.slice(norm.length);
                const slash = rest.indexOf('/');
                if (slash === -1) filesOut.add(p);
                else foldersOut.add(norm + rest.slice(0, slash));
            }
            return { files: [...filesOut], folders: [...foldersOut] };
        }
    };
}

const MEM_BASE = '.pkm-assistant/agents/jaskier/memory';
function memoryPaths(base: string = MEM_BASE) {
    return {
        brain: `${base}/brain.md`,
        brainNotes: `${base}/brain`,
        sessionsActive: `${base}/sessions/active`,
        sessionsArchive: `${base}/sessions/archive`,
        l1: `${base}/summaries/L1`,
        l2: `${base}/summaries/L2`,
        l3: `${base}/summaries/L3`
    };
}

/** Atrapa agenta: tylko bramka pamięci (tożsamości ten test nie sprawdza). */
type FakeAgent = { permissions?: { memory?: boolean } };

/** Atrapa pamięci agenta: sam zestaw ścieżek — silnik czyta resztę z adaptera. */
type FakeMemory = { paths: ReturnType<typeof memoryPaths> } | null;

function makePlugin(
    files: Record<string, string>,
    {
        agent, memory, env = null, oramaDb = null,
        agents, memories, activeAgentName,
    }: {
        agent?: FakeAgent;
        memory?: FakeMemory;
        env?: unknown;
        oramaDb?: unknown;
        // Tryb PO NAZWIE — opcjonalny, dla testów, którym zależy na tym, że wołający i
        // aktywny agent to DWIE różne tożsamości (dotychczasowy tryb `agent`/`memory` ich
        // nie rozróżniał: wszystkie 4 metody atrapy AgentManagera zwracały to samo, bez
        // względu na przekazaną nazwę). `agents`/`memories` to mapy po nazwie; `getAgent(name)`
        // i `getAgentMemory(name)` patrzą na nazwę, `getActiveAgent()`/`getActiveMemory()`
        // zwracają wpis `activeAgentName`. Nierozpoznana nazwa → `null` (fail-closed, jak
        // realny `AgentManager` — patrz `modules/memory/CLAUDE.md`, gotcha "cross-agent
        // isolation jest twarde").
        agents?: Record<string, FakeAgent>;
        memories?: Record<string, FakeMemory>;
        activeAgentName?: string;
    } = {},
) {
    const vault = { adapter: makeAdapter(files) };
    const agentManager = agents
        ? {
            getActiveAgent: () => (activeAgentName ? agents[activeAgentName] : undefined) || null,
            getAgent: (name: string | null) => (name ? agents[name] : undefined) || null,
            getActiveMemory: () => (activeAgentName ? memories?.[activeAgentName] : undefined) || null,
            getAgentMemory: (name: string) => memories?.[name] || null
        }
        : {
            getActiveAgent: () => agent || null,
            getAgent: () => agent || null,
            getActiveMemory: () => memory || null,
            getAgentMemory: () => memory || null
        };
    return { app: { vault }, agentManager, env, oramaDb } as unknown as SearchToolPlugin & { app: unknown };
}

const run = (plugin: SearchToolPlugin & { app: unknown }, args: SearchToolArgs) =>
    createSearchTool().execute(args, plugin.app, plugin) as Promise<SearchRes>;

// ───────────────────────── memory permission gate ─────────────────────────

test('scope=memory z wyłączonym uprawnieniem memory → odmowa (fail-closed)', async t => {
    const plugin = makePlugin(
        { [`${MEM_BASE}/brain.md`]: 'target' },
        { agent: { permissions: { memory: false } }, memory: { paths: memoryPaths() } }
    );
    const res = await run(plugin, { query: 'target', scope: 'memory' });
    t.false(res.success);
    t.truthy(res.error);
});

test('scope=memory bez aktywnej pamięci → no_agent', async t => {
    const plugin = makePlugin({}, { agent: { permissions: { memory: true } }, memory: null });
    const res = await run(plugin, { query: 'target', scope: 'memory' });
    t.false(res.success);
});

test('scope=memory happy path → wyniki + nota degradacji semantyki', async t => {
    const plugin = makePlugin(
        {
            [`${MEM_BASE}/brain.md`]: 'target index',
            [`${MEM_BASE}/brain/user_x.md`]: 'target user note'
        },
        { agent: { permissions: { memory: true } }, memory: { paths: memoryPaths() } }
    );
    const res = await run(plugin, { query: 'target', scope: 'memory' });
    t.true(res.success);
    t.is(res.scope, 'memory');
    t.is(res.mode_used, 'keyword');
    t.truthy(res.note, 'memory scope zawsze zwraca notę o braku semantyki');
    t.true(res.results.length >= 1);
});

// ───────────────────────── vault scope ─────────────────────────

// ⚠️ `scope: 'vault'` musi być JAWNE od naprawy „default scope = memory" (poniżej) - bez `scope`
// ten sam wywołanie szukałoby domyślnie w pamięci wołającego, nie w vaultcie usera. Ta zmiana
// kontraktu jest opisana w raporcie zadania.
test('scope=vault mode=keyword → wyniki bez noty, poprawny kształt', async t => {
    const plugin = makePlugin({
        'a.md': 'jakiś target tutaj',
        'b.md': 'nic ciekawego'
    });
    const res = await run(plugin, { query: 'target', mode: 'keyword', scope: 'vault' });
    t.true(res.success);
    t.is(res.scope, 'vault');
    t.is(res.mode_used, 'keyword');
    t.falsy(res.note, 'mode=keyword nie prosi o semantykę → brak noty');
    t.deepEqual(res.results.map(x => x.path), ['a.md']);
    const hit = res.results[0];
    t.true('path' in hit && 'title' in hit && 'excerpt' in hit && 'matched' in hit);
});

test('scope=vault mode=auto bez indeksu → nota degradacji (semantyka niedostępna)', async t => {
    const plugin = makePlugin({ 'a.md': 'target' });
    const res = await run(plugin, { query: 'target', mode: 'auto', scope: 'vault' });
    t.true(res.success);
    t.truthy(res.note);
});

test('where.folder z traversalem → invalid_folder', async t => {
    const plugin = makePlugin({ 'a.md': 'target' });
    const res = await run(plugin, { query: 'target', where: { folder: '../../etc' }, scope: 'vault' });
    t.false(res.success);
});

// Brak scope + agent Z pamięcią → default memory (nie vault): przy scope=memory `where.folder`
// jest ETYKIETĄ LOGICZNĄ podfolderu pamięci ('brain'/'sessions'/'summaries'/...), NIE ścieżką
// vaulta - walidator folderu vaulta (`validateVaultFolder`) w ogóle nie jest wołany dla tej
// gałęzi (`SearchTool.execute`: `if (scope === 'vault' && where.folder)`). Traversal, który dla
// scope=vault kończyłby się `invalid_folder`, dla scope=memory jest po prostu etykietą bez
// dopasowania - pusty wynik, sukces.
test('brak scope + agent z pamięcią + where.folder z traversalem → sukces, scope memory, folder to etykieta (walidator vaulta pominięty)', async t => {
    const plugin = makePlugin(
        { [`${MEM_BASE}/brain.md`]: 'target w pamięci' },
        { agent: { permissions: { memory: true } }, memory: { paths: memoryPaths() } }
    );
    const res = await run(plugin, { query: 'target', where: { folder: '../../etc' } });
    t.true(res.success);
    t.is(res.scope, 'memory');
    t.deepEqual(res.results, []);
});

test('limit respektowany przez narzędzie', async t => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 15; i++) files[`n${i}.md`] = 'foo';
    const plugin = makePlugin(files);
    const res = await run(plugin, { query: 'foo', mode: 'keyword', limit: 3, scope: 'vault' });
    t.true(res.success);
    t.is(res.results.length, 3);
});

// ─── przekazanie opcjonalnego `scan` z `RetrievalEngine.runSearch` do wyniku narzędzia ────────
//
// `RetrievalEngine.runSearch` dokłada opcjonalne `scan: {candidates, scanned, truncated}`
// wyłącznie gdy skan keyword był obcięty sufitem 300 kandydatów. Testy podmieniają
// `RetrievalEngine.prototype.runSearch` na atrapę, żeby sprawdzić WYŁĄCZNIE przewód
// `SearchTool.execute` → wynik narzędzia, niezależnie od kształtu, jaki akurat zwraca silnik.

// Podmiana idzie przez luźny kontrakt (`unknown` prototyp), żeby nie zderzać się z typem
// `SearchOutcome` (nie deklaruje pola `scan` jako zawsze obecnego) — dokładnie ten sam powód,
// dla którego `buildEngine` w `SearchTool.ts` rzutuje na `never`.
type LooseRunSearchProto = { runSearch: (...args: unknown[]) => Promise<unknown> };

test('scan: obecne w silniku i truncated=true → pole `scan` w wyniku narzędzia', async t => {
    const engineModule = await import('../memory/index.js');
    const proto = engineModule.RetrievalEngine.prototype as unknown as LooseRunSearchProto;
    const original = proto.runSearch;
    const fakeScan = { candidates: 640, scanned: 300, truncated: true };
    proto.runSearch = async () => ({
        mode_used: 'keyword',
        results: [],
        total: 0,
        semantic: { requested: false, used: false },
        scan: fakeScan,
    });
    try {
        const plugin = makePlugin({ 'a.md': 'target' });
        const res = await run(plugin, { query: 'target', mode: 'keyword', scope: 'vault' }) as SearchRes & { scan?: unknown };
        t.true(res.success);
        t.deepEqual(res.scan, fakeScan, '`scan` musi trafić do wyniku narzędzia bez zmian');
    } finally {
        proto.runSearch = original;
    }
});

test('scan: NIEOBECNE w silniku (skan nieobcięty) → brak pola `scan` w wyniku (bajtowa parytet ze stanem sprzed naprawy)', async t => {
    const engineModule = await import('../memory/index.js');
    const proto = engineModule.RetrievalEngine.prototype as unknown as LooseRunSearchProto;
    const original = proto.runSearch;
    proto.runSearch = async () => ({
        mode_used: 'keyword',
        results: [],
        total: 0,
        semantic: { requested: false, used: false },
        // brak pola `scan` — dokładnie kształt silnika bez obciętego skanu
    });
    try {
        const plugin = makePlugin({ 'a.md': 'target' });
        const res = await run(plugin, { query: 'target', mode: 'keyword', scope: 'vault' }) as SearchRes & { scan?: unknown };
        t.true(res.success);
        t.false('scan' in res, 'brak `scan` w silniku → brak `scan` w wyniku narzędzia, bez pustego pola');
    } finally {
        proto.runSearch = original;
    }
});

// ───────────────────────── default scope (brak `scope`) → pamięć wołającego ─────────────────
//
// Kontrakt: brak `scope` (albo nierozpoznana wartość) domyślnie przeszukuje PAMIĘĆ wołającego
// agenta, nie notatki usera. Notatki usera wymagają jawnego `scope: "vault"`. Trzy wyjątki
// (sub-agent / pamięć wyłączona / brak pamięci) spadają na `vault` zamiast na odmowę.

test.serial('brak scope + agent z pamięcią → domyślny zakres to memory (nowy default) + scope_hint', async t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    const plugin = makePlugin(
        {
            'Notatka.md': 'target w vaulcie',
            [`${MEM_BASE}/brain.md`]: 'target w pamięci'
        },
        { agent: { permissions: { memory: true } }, memory: { paths: memoryPaths() } }
    );
    const res = await run(plugin, { query: 'target' });
    t.true(res.success);
    t.is(res.scope, 'memory');
    t.true(res.results.some(x => x.path === `${MEM_BASE}/brain.md`), 'notatka pamięci jest w wynikach');
    t.false(res.results.some(x => x.path === 'Notatka.md'), 'notatka vaulta NIE jest w wynikach');
    // Literał, nie `t()` — oczekiwana wartość nie może być liczona tą samą funkcją co wynik.
    // Kontrakt podpowiedzi: nazywa DOKŁADNY parametr, którym model poszerza zakres.
    t.regex(String(res.scope_hint), /scope: "vault"/);
});

// Stara nazwa `vault_search` obiecuje vault. Alias niesie `scope:'vault'` jawnie — bez tego
// po zmianie defaultu przeszukiwałby po cichu pamięć agenta. Test idzie przez PRAWDZIWE
// wykonanie (alias → execute), nie przez samo mapowanie argumentów.
test('alias vault_search → realne wykonanie trafia w vault mimo domyślnego memory', async t => {
    const plugin = makePlugin(
        {
            'Notatka.md': 'target w vaulcie',
            [`${MEM_BASE}/brain.md`]: 'target w pamięci'
        },
        { agent: { permissions: { memory: true } }, memory: { paths: memoryPaths() } }
    );
    const mapped = resolveSearchAlias('vault_search', { query: 'target' });
    t.is(mapped?.name, 'search');
    const res = await run(plugin, mapped!.arguments as SearchToolArgs);
    t.true(res.success);
    t.is(res.scope, 'vault');
    t.deepEqual(res.results.map(x => x.path), ['Notatka.md']);
    t.false('scope_hint' in res);
});

test('jawne scope="vault" → notatka vaulta, brak pola scope_hint', async t => {
    const plugin = makePlugin(
        {
            'Notatka.md': 'target w vaulcie',
            [`${MEM_BASE}/brain.md`]: 'target w pamięci'
        },
        { agent: { permissions: { memory: true } }, memory: { paths: memoryPaths() } }
    );
    const res = await run(plugin, { query: 'target', scope: 'vault' });
    t.true(res.success);
    t.is(res.scope, 'vault');
    t.true(res.results.some(x => x.path === 'Notatka.md'));
    t.false('scope_hint' in res, 'scope jawny → brak scope_hint');
});

test('jawne scope="memory" → brak pola scope_hint', async t => {
    const plugin = makePlugin(
        { [`${MEM_BASE}/brain.md`]: 'target w pamięci' },
        { agent: { permissions: { memory: true } }, memory: { paths: memoryPaths() } }
    );
    const res = await run(plugin, { query: 'target', scope: 'memory' });
    t.true(res.success);
    t.is(res.scope, 'memory');
    t.false('scope_hint' in res, 'scope jawny → brak scope_hint, nawet gdy jawny scope=memory');
});

test('brak scope + permissions.memory === false → fallback na vault (sukces, NIE odmowa)', async t => {
    const plugin = makePlugin(
        {
            'Notatka.md': 'target w vaulcie',
            [`${MEM_BASE}/brain.md`]: 'target w pamięci'
        },
        { agent: { permissions: { memory: false } }, memory: { paths: memoryPaths() } }
    );
    const res = await run(plugin, { query: 'target' });
    t.true(res.success, 'domyślne wywołanie bez scope nie odmawia, gdy pamięć jest wyłączona');
    t.is(res.scope, 'vault');
    t.true(res.results.some(x => x.path === 'Notatka.md'));
    t.false('scope_hint' in res, 'fallback na vault (memory_off) nie jest domyślnym memory → brak scope_hint');
});

test('brak scope + _invocationDelegationDepth:1 (sub-agent) → fallback na vault', async t => {
    const plugin = makePlugin(
        {
            'Notatka.md': 'target w vaulcie',
            [`${MEM_BASE}/brain.md`]: 'target w pamięci'
        },
        { agent: { permissions: { memory: true } }, memory: { paths: memoryPaths() } }
    );
    const res = await run(plugin, { query: 'target', _invocationDelegationDepth: 1 });
    t.true(res.success);
    t.is(res.scope, 'vault');
    t.true(res.results.some(x => x.path === 'Notatka.md'), 'sub-agent bez scope trafia notatkę vaulta');
    t.false(res.results.some(x => x.path === `${MEM_BASE}/brain.md`), 'sub-agent bez scope NIE dostaje pamięci rodzica');
    t.false('scope_hint' in res, 'fallback na vault (sub_agent) nie jest domyślnym memory → brak scope_hint');
});

test('brak scope + brak pamięci agenta (getAgentMemory zwraca null) → fallback na vault', async t => {
    const plugin = makePlugin(
        { 'Notatka.md': 'target w vaulcie' },
        { agent: { permissions: { memory: true } }, memory: null }
    );
    const res = await run(plugin, { query: 'target' });
    t.true(res.success);
    t.is(res.scope, 'vault');
    t.true(res.results.some(x => x.path === 'Notatka.md'));
    t.false('scope_hint' in res, 'fallback na vault (no_memory) nie jest domyślnym memory → brak scope_hint');
});

// ───────────────────────── tożsamość WOŁAJĄCEGO ≠ aktywny agent w UI ─────────────────────
//
// Dotychczasowa atrapa AgentManagera (`makePlugin({agent, memory})`) ignorowała nazwę — te
// dwa testy używają trybu PO NAZWIE (`agents`/`memories`/`activeAgentName`), żeby faktycznie
// odróżnić tożsamość z `_invocationAgentName` od aktywnego agenta w UI (patrz
// `modules/memory/CLAUDE.md`, gotcha "`AgentManager.getActiveMemory()` NIE JEST na ścieżce
// tła").

test('brak scope + _invocationAgentName:"Ala" (aktywny agent w UI to Bob, bez pamięci) → memory ALI, nie Boba', async t => {
    const ALA_BASE = '.pkm-assistant/agents/ala/memory';
    const plugin = makePlugin(
        {
            'Notatka.md': 'target w vaulcie',
            [`${ALA_BASE}/brain.md`]: 'target w pamięci Ali'
        },
        {
            agents: {
                Bob: { permissions: { memory: false } },
                Ala: { permissions: { memory: true } }
            },
            memories: {
                Ala: { paths: memoryPaths(ALA_BASE) }
            },
            activeAgentName: 'Bob'
        }
    );
    const res = await run(plugin, { query: 'target', _invocationAgentName: 'Ala' });
    t.true(res.success);
    t.is(res.scope, 'memory');
    t.true(res.results.some(x => x.path === `${ALA_BASE}/brain.md`), 'notatka z pamięci ALI jest w wynikach');
    t.false(res.results.some(x => x.path === 'Notatka.md'), 'notatka vaulta NIE jest w wynikach');
});

test('brak scope + _invocationAgentName:"Zonk" (nieznana tożsamość) przy aktywnym agencie Z pamięcią → fallback na vault (fail-closed)', async t => {
    const ALA_BASE = '.pkm-assistant/agents/ala/memory';
    const plugin = makePlugin(
        {
            'Notatka.md': 'target w vaulcie',
            [`${ALA_BASE}/brain.md`]: 'target w pamięci Ali'
        },
        {
            agents: { Ala: { permissions: { memory: true } } },
            memories: { Ala: { paths: memoryPaths(ALA_BASE) } },
            activeAgentName: 'Ala'
        }
    );
    const res = await run(plugin, { query: 'target', _invocationAgentName: 'Zonk' });
    t.true(res.success);
    t.is(res.scope, 'vault', 'nieznana tożsamość NIE dostaje pamięci aktywnego agenta (fail-closed)');
    t.true(res.results.some(x => x.path === 'Notatka.md'));
    t.false(res.results.some(x => x.path === `${ALA_BASE}/brain.md`), 'pamięć Ali (aktywnej w UI) nie wycieka do nieznanej tożsamości');
});

// ───────────────────────── contextExtractor: targetPath zależny od zakresu ─────────────────────

test('contextExtractor: brak scope + where.folder przy domyślnym memory → targetPath vide (folder = podfolder pamięci, nie ścieżka vaulta)', t => {
    const plugin = makePlugin(
        {},
        { agent: { permissions: { memory: true } }, memory: { paths: memoryPaths() } }
    );
    const tool = createSearchTool();
    const ctxDefault = tool.contextExtractor(
        { query: 'x', where: { folder: 'Projekty' } },
        { plugin }
    );
    t.is(ctxDefault.targetPath, '');

    const ctxVault = tool.contextExtractor(
        { query: 'x', scope: 'vault', where: { folder: 'Projekty' } },
        { plugin }
    );
    t.is(ctxVault.targetPath, 'Projekty');
});

// ─── tabela równoważności: bramka (contextExtractor) ↔ wykonanie (execute) ─────────────────
//
// `contextExtractor` (bramka `targetPath`) i `execute` (silnik, pole `scope` w wyniku) MUSZĄ
// ocenić TĘ SAMĄ decyzję dla TEGO SAMEGO worka argumentów - to jest cały sens tego, że obie
// strony wołają `resolveSearchScope` (patrz `modules/tools/CLAUDE.md`, gotcha "bramka i zlew
// oglądają jeden ciąg"). Oczekiwane pary `{targetPath, scope}` są wpisane LITERALNIE w tabeli
// (nie liczone przez `resolveSearchScope`) - inaczej test porównywałby kod z samym sobą.
test('tabela: brak/jawny scope + where.folder:"Projekty" → ta sama para {targetPath, scope} w bramce i w wykonaniu', async t => {
    const agentZPamiecia = { agent: { permissions: { memory: true } }, memory: { paths: memoryPaths() } };
    const CASES: Array<{
        name: string;
        args: SearchToolArgs;
        pluginOpts: Parameters<typeof makePlugin>[1];
        expected: { targetPath: string; scope: string };
    }> = [
        {
            name: '(a) agent z pamięcią, brak scope → default memory',
            args: { query: 'x', where: { folder: 'Projekty' } },
            pluginOpts: agentZPamiecia,
            expected: { targetPath: '', scope: 'memory' }
        },
        {
            name: '(b) permissions.memory:false, brak scope → fallback vault',
            args: { query: 'x', where: { folder: 'Projekty' } },
            pluginOpts: { agent: { permissions: { memory: false } }, memory: { paths: memoryPaths() } },
            expected: { targetPath: 'Projekty', scope: 'vault' }
        },
        {
            name: '(c) brak pamięci, brak scope → fallback vault',
            args: { query: 'x', where: { folder: 'Projekty' } },
            pluginOpts: { agent: { permissions: { memory: true } }, memory: null },
            expected: { targetPath: 'Projekty', scope: 'vault' }
        },
        {
            name: '(d) _invocationDelegationDepth:1 (sub-agent), brak scope → fallback vault',
            args: { query: 'x', where: { folder: 'Projekty' }, _invocationDelegationDepth: 1 },
            pluginOpts: agentZPamiecia,
            expected: { targetPath: 'Projekty', scope: 'vault' }
        },
        {
            name: 'jawne scope:"vault"',
            args: { query: 'x', scope: 'vault', where: { folder: 'Projekty' } },
            pluginOpts: agentZPamiecia,
            expected: { targetPath: 'Projekty', scope: 'vault' }
        },
        {
            name: 'jawne scope:"memory"',
            args: { query: 'x', scope: 'memory', where: { folder: 'Projekty' } },
            pluginOpts: agentZPamiecia,
            expected: { targetPath: '', scope: 'memory' }
        }
    ];

    for (const c of CASES) {
        const plugin = makePlugin({}, c.pluginOpts);
        const tool = createSearchTool();
        const ctx = { agentName: null, plugin };

        const extracted = tool.contextExtractor(c.args, ctx);
        t.is(extracted.targetPath, c.expected.targetPath, `${c.name}: targetPath bramki`);

        const res = await run(plugin, c.args);
        t.is(res.scope, c.expected.scope, `${c.name}: scope wykonania`);
    }
});

// ───────────────────────── resolveSearchScope — bezpośrednio ─────────────────────

test('resolveSearchScope: literówka scope="Vault" traktowana jak brak scope → default memory (agent z pamięcią)', t => {
    const plugin = makePlugin(
        {},
        { agent: { permissions: { memory: true } }, memory: { paths: memoryPaths() } }
    );
    const decision: SearchScopeDecision = resolveSearchScope({ query: 'x', scope: 'Vault' }, plugin);
    t.deepEqual(decision, { scope: 'memory', source: 'default' });
});
