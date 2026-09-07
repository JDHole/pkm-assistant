import test from 'ava';
import { createSearchTool } from './SearchTool.js';
import type { SearchToolArgs, SearchToolPlugin } from './SearchTool.js';

/** Trafienie wyszukiwania czytane w asercjach. */
type SearchHit = { path: string; title?: string; excerpt?: string; matched?: unknown };

/** Wynik `search` czytany w asercjach — kształt zależy od gałęzi, więc pola opcjonalne. */
type SearchRes = {
    success?: boolean;
    error?: string;
    scope?: string;
    mode_used?: string;
    note?: string;
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
    { agent, memory, env = null, oramaDb = null }: {
        agent?: FakeAgent;
        memory?: FakeMemory;
        env?: unknown;
        oramaDb?: unknown;
    } = {},
) {
    const vault = { adapter: makeAdapter(files) };
    const agentManager = {
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

test('scope=vault mode=keyword → wyniki bez noty, poprawny kształt', async t => {
    const plugin = makePlugin({
        'a.md': 'jakiś target tutaj',
        'b.md': 'nic ciekawego'
    });
    const res = await run(plugin, { query: 'target', mode: 'keyword' });
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
    const res = await run(plugin, { query: 'target', mode: 'auto' });
    t.true(res.success);
    t.truthy(res.note);
});

test('where.folder z traversalem → invalid_folder', async t => {
    const plugin = makePlugin({ 'a.md': 'target' });
    const res = await run(plugin, { query: 'target', where: { folder: '../../etc' } });
    t.false(res.success);
});

test('limit respektowany przez narzędzie', async t => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 15; i++) files[`n${i}.md`] = 'foo';
    const plugin = makePlugin(files);
    const res = await run(plugin, { query: 'foo', mode: 'keyword', limit: 3 });
    t.true(res.success);
    t.is(res.results.length, 3);
});

// ─── AUD-wydajnosc-024 follow-up: przekazanie `scan` (kontrakt W3, RetrievalEngine) ────────
//
// `RetrievalEngine.runSearch` (branch `refactor/v2.2-perf-W3`, NIE zmergowany do tego
// worktree) dokłada opcjonalne `scan: {candidates, scanned, truncated}` wyłącznie gdy skan
// keyword był obcięty sufitem 300 kandydatów. Silnik w TYM worktree jeszcze go nie zna —
// testy podmieniają `RetrievalEngine.prototype.runSearch` na atrapę, żeby sprawdzić WYŁĄCZNIE
// przewód `SearchTool.execute` → wynik narzędzia, niezależnie od tego, czy W3 jest zmergowany.

// Podmiana idzie przez luźny kontrakt (`unknown` prototyp), żeby nie zderzać się z typem
// `SearchOutcome` deklarowanym w TYM worktree (bez pola `scan` — dojdzie dopiero z W3) —
// dokładnie ten sam powód, dla którego `buildEngine` w `SearchTool.ts` rzutuje na `never`.
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
        const res = await run(plugin, { query: 'target', mode: 'keyword' }) as SearchRes & { scan?: unknown };
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
        // brak pola `scan` — dokładnie kształt silnika sprzed W3
    });
    try {
        const plugin = makePlugin({ 'a.md': 'target' });
        const res = await run(plugin, { query: 'target', mode: 'keyword' }) as SearchRes & { scan?: unknown };
        t.true(res.success);
        t.false('scan' in res, 'brak `scan` w silniku → brak `scan` w wyniku narzędzia, bez pustego pola');
    } finally {
        proto.runSearch = original;
    }
});
