import test from 'ava';
import { RetrievalEngine } from './RetrievalEngine.js';
import type { RetrievalAppLike, RetrievalVaultAdapterLike, RetrievalVaultLike } from './RetrievalEngine.js';

/**
 * Mock vault adapter zbudowany z płaskiej mapy { path: content }.
 * list(dir) liczy bezpośrednie pliki + podfoldery; read/exists proste.
 */
function makeAdapter(files: Record<string, string>): RetrievalVaultAdapterLike {
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

const vaultOf = (files: Record<string, string>): RetrievalVaultLike => ({ adapter: makeAdapter(files) });

const memoryPaths = (base = '.pkm-assistant/agents/jaskier/memory') => ({
    brain: `${base}/brain.md`,
    brainNotes: `${base}/brain`,
    sessionsActive: `${base}/sessions/active`,
    sessionsArchive: `${base}/sessions/archive`,
    l1: `${base}/summaries/L1`,
    l2: `${base}/summaries/L2`,
    l3: `${base}/summaries/L3`
});

// ───────────────────────── where filters ─────────────────────────

test('where.folder ogranicza kandydatów do prefiksu (vault)', async t => {
    const vault = vaultOf({
        'Projekty/a.md': 'alfa target here',
        'Projekty/b.md': 'beta target too',
        'Dziennik/c.md': 'gamma target elsewhere'
    });
    const engine = new RetrievalEngine({ vault });
    const r = await engine.runSearch({ query: 'target', where: { folder: 'Projekty' } });
    const paths = r.results.map(x => x.path).sort();
    t.deepEqual(paths, ['Projekty/a.md', 'Projekty/b.md']);
});

test('where.glob filtruje po wzorcu nazwy', async t => {
    const vault = vaultOf({
        'notes/daily-1.md': 'foo',
        'notes/daily-2.md': 'foo',
        'notes/weekly.md': 'foo'
    });
    const engine = new RetrievalEngine({ vault });
    const r = await engine.runSearch({ query: 'foo', where: { glob: 'notes/daily-*.md' } });
    t.is(r.results.length, 2);
    t.true(r.results.every(x => x.path.includes('daily')));
});

test('where.yaml filtruje po frontmatterze', async t => {
    const vault = vaultOf({
        'a.md': '---\nstatus: wip\n---\ntarget one',
        'b.md': '---\nstatus: done\n---\ntarget two'
    });
    const engine = new RetrievalEngine({ vault });
    const r = await engine.runSearch({ query: 'target', where: { yaml: { status: 'wip' } } });
    t.deepEqual(r.results.map(x => x.path), ['a.md']);
});

test('where łączy folder + yaml jako AND', async t => {
    const vault = vaultOf({
        'P/a.md': '---\nstatus: wip\n---\ntarget',
        'P/b.md': '---\nstatus: done\n---\ntarget',
        'Q/c.md': '---\nstatus: wip\n---\ntarget'
    });
    const engine = new RetrievalEngine({ vault });
    const r = await engine.runSearch({ query: 'target', where: { folder: 'P', yaml: { status: 'wip' } } });
    t.deepEqual(r.results.map(x => x.path), ['P/a.md']);
});

test('where.links_to zwraca backlinki', async t => {
    const vault = vaultOf({
        'linker.md': 'zobacz [[Target]] tutaj target',
        'other.md': 'nie linkuje target',
        'Target.md': 'target sam w sobie'
    });
    const engine = new RetrievalEngine({ vault });
    const r = await engine.runSearch({ query: 'target', where: { links_to: 'Target' } });
    t.deepEqual(r.results.map(x => x.path), ['linker.md']);
});

test('where.links_from zwraca pliki linkowane ze źródła', async t => {
    const vault = vaultOf({
        'source.md': 'linki: [[Alfa]] i [[Beta]] target',
        'Alfa.md': 'target alfa',
        'Beta.md': 'target beta',
        'Gamma.md': 'target gamma'
    });
    const engine = new RetrievalEngine({ vault });
    const r = await engine.runSearch({ query: 'target', where: { links_from: 'source' } });
    t.deepEqual(r.results.map(x => x.path).sort(), ['Alfa.md', 'Beta.md']);
});

// ───────────────────────── keyword ranking ─────────────────────────

test('keyword: ranking po liczbie wystąpień frazy', async t => {
    const vault = vaultOf({
        'low.md': 'foo raz',
        'high.md': 'foo foo foo trzy razy',
        'mid.md': 'foo foo dwa'
    });
    const engine = new RetrievalEngine({ vault });
    const r = await engine.runSearch({ query: 'foo', mode: 'keyword' });
    t.deepEqual(r.results.map(x => x.path), ['high.md', 'mid.md', 'low.md']);
    t.is(r.mode_used, 'keyword');
});

// ───────────────────────── RRF fusion ─────────────────────────

test('RRF: deterministyczna fuzja keyword[A,B,C] + semantic[C,A] → [A,C,B]', async t => {
    const vault = vaultOf({
        'A.md': 'x x x',   // keyword rank 1
        'B.md': 'x x',     // keyword rank 2
        'C.md': 'x'        // keyword rank 3
    });
    const vectorCalls: Array<{ k?: number }> = [];
    const engine = new RetrievalEngine({
        vault,
        embeddingHelper: { embed: async () => [0.1, 0.2, 0.3] },
        oramaDb: {},
        vectorSearch: async (_db: unknown, _vec: number[], opts: { k?: number }) => {
            vectorCalls.push(opts);
            return { hits: [{ document: { path: 'C.md' }, score: 0.9 }, { document: { path: 'A.md' }, score: 0.8 }] };
        }
    });
    const r = await engine.runSearch({ query: 'x', mode: 'auto' });
    t.is(r.mode_used, 'hybrid');
    t.true(vectorCalls.length === 1);
    t.deepEqual(r.results.map(x => x.path), ['A.md', 'C.md', 'B.md']);
    t.deepEqual(r.results.find(x => x.path === 'A.md')!.matched.sort(), ['keyword', 'semantic']);
    t.deepEqual(r.results.find(x => x.path === 'B.md')!.matched, ['keyword']);
});

test('mode=semantic bez oramaDb → fallback keyword + degradacja zgłoszona', async t => {
    const vault = vaultOf({ 'a.md': 'target here', 'b.md': 'no match' });
    const engine = new RetrievalEngine({ vault, embeddingHelper: { embed: async () => [1] }, oramaDb: null });
    const r = await engine.runSearch({ query: 'target', mode: 'semantic' });
    t.is(r.mode_used, 'keyword');
    t.true(r.semantic.requested);
    t.false(r.semantic.used);
    t.deepEqual(r.results.map(x => x.path), ['a.md']);
});

// ───────────────────────── memory scope ─────────────────────────

test('scope=memory NIGDY nie woła oramaDb i zawsze zgłasza brak semantyki', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const vault = vaultOf({
        [`${base}/brain.md`]: 'brain target index',
        [`${base}/brain/user_pref.md`]: 'user target note',
        [`${base}/sessions/active/s1.md`]: 'session target log',
        [`${base}/summaries/L1/l1_x.md`]: 'summary target'
    });
    let vectorCalled = false;
    const engine = new RetrievalEngine({
        vault,
        embeddingHelper: { embed: async () => [1, 2, 3] },
        oramaDb: {},
        vectorSearch: async () => { vectorCalled = true; return { hits: [] }; },
        agentMemory: { paths: memoryPaths(base) }
    });
    const r = await engine.runSearch({ query: 'target', scope: 'memory', mode: 'auto' });
    t.false(vectorCalled, 'oramaDb/vectorSearch must never run for memory scope');
    t.false(r.semantic.used);
    t.is(r.mode_used, 'keyword');
    t.true(r.results.length >= 3);
});

test('scope=memory where.folder wybiera podfolder pamięci', async t => {
    const base = '.pkm-assistant/agents/jaskier/memory';
    const vault = vaultOf({
        [`${base}/brain/user_pref.md`]: 'target brain',
        [`${base}/summaries/L1/l1_x.md`]: 'target l1',
        [`${base}/summaries/L2/l2_y.md`]: 'target l2'
    });
    const engine = new RetrievalEngine({ vault, agentMemory: { paths: memoryPaths(base) } });
    const r = await engine.runSearch({ query: 'target', scope: 'memory', where: { folder: 'summaries/L1' } });
    t.deepEqual(r.results.map(x => x.path), [`${base}/summaries/L1/l1_x.md`]);
});

// ───────────────────────── excerpt / limit / listing ─────────────────────────

test('excerpt: keyword hit daje fragment wokół frazy', async t => {
    const vault = vaultOf({
        'a.md': 'prolog prolog prolog SPECIALWORD epilog epilog'
    });
    const engine = new RetrievalEngine({ vault });
    const r = await engine.runSearch({ query: 'SPECIALWORD', mode: 'keyword' });
    t.true(r.results[0].excerpt.includes('SPECIALWORD'));
});

test('excerpt: semantic-only hit daje początek treści (po frontmatterze)', async t => {
    const vault = vaultOf({
        'a.md': '---\ntitle: Doc\n---\nPoczątek treści dokumentu jest tutaj.'
    });
    const engine = new RetrievalEngine({
        vault,
        embeddingHelper: { embed: async () => [1] },
        oramaDb: {},
        vectorSearch: async () => ({ hits: [{ document: { path: 'a.md' }, score: 0.7 }] })
    });
    // query nie występuje w treści → semantic-only; excerpt = początek body.
    const r = await engine.runSearch({ query: 'zapytanie-bez-trafienia', mode: 'semantic' });
    t.is(r.results[0].path, 'a.md');
    t.true(r.results[0].excerpt.startsWith('Początek treści'));
    t.is(r.results[0].title, 'Doc');
});

test('limit respektowany', async t => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`n${i}.md`] = 'foo bar';
    const engine = new RetrievalEngine({ vault: vaultOf(files) });
    const r = await engine.runSearch({ query: 'foo', mode: 'keyword', limit: 5 });
    t.is(r.results.length, 5);
    t.true(r.total >= 20);
});

test('brak query → listing kandydatów wg where', async t => {
    const vault = vaultOf({
        'P/a.md': 'aaa',
        'P/b.md': 'bbb',
        'Q/c.md': 'ccc'
    });
    const engine = new RetrievalEngine({ vault });
    const r = await engine.runSearch({ where: { folder: 'P' } });
    t.is(r.mode_used, 'listing');
    t.deepEqual(r.results.map(x => x.path).sort(), ['P/a.md', 'P/b.md']);
    t.deepEqual(r.results[0].matched, []);
});

// ───────────────────── E2.6: app-first (getMarkdownFiles / metadataCache) ─────────────────────

/**
 * Mock Obsidian App. files: { path: { content, frontmatter? } }. resolvedLinks: {src:{target:count}}.
 * getFirstLinkpathDest dopasowuje po basename (uproszczenie testowe).
 */
interface AppFile { content: string; frontmatter?: Record<string, unknown> }

function makeApp(files: Record<string, AppFile>, resolvedLinks: Record<string, Record<string, number>> = {}) {
    const vault = {
        getMarkdownFiles: () => Object.keys(files).map(p => ({ path: p, name: p.split('/').pop() })),
        getAbstractFileByPath: (p: string) => (p in files ? { path: p, name: p.split('/').pop() } : null),
        cachedRead: async (file: { path: string }) => files[file.path]?.content ?? '',
        // Atrapa adaptera jest tu tylko po to, żeby pole istniało — ścieżka API-first
        // nigdy do niej nie schodzi, więc `read` oddaje `null` (stąd rzutowanie kształtu).
        adapter: { read: async () => null, list: async () => ({ files: [], folders: [] }), exists: async () => false } as unknown as RetrievalVaultAdapterLike
    };
    return {
        vault,
        metadataCache: {
            getFileCache: (file: { path: string }) => ({ frontmatter: files[file.path]?.frontmatter || null }),
            resolvedLinks,
            getFirstLinkpathDest: (linkpath: string) => {
                const needle = String(linkpath).toLowerCase();
                const hit = Object.keys(files).find(p =>
                    p === linkpath || p === `${linkpath}.md` ||
                    p.replace(/\.md$/i, '').split('/').pop()!.toLowerCase() === needle);
                return hit ? { path: hit } : null;
            }
        }
    };
}

const appEngine = (files: Record<string, AppFile>, resolvedLinks?: Record<string, Record<string, number>>) => {
    const app = makeApp(files, resolvedLinks);
    return new RetrievalEngine({ app: app as RetrievalAppLike, vault: app.vault });
};

test('app: getMarkdownFiles + cachedRead — kandydaci wg folderu, keyword po treści', async t => {
    const engine = appEngine({
        'P/a.md': { content: 'alfa target here' },
        'P/b.md': { content: 'beta nic' },
        'Q/c.md': { content: 'target elsewhere' }
    });
    const r = await engine.runSearch({ query: 'target', where: { folder: 'P' }, mode: 'keyword' });
    t.deepEqual(r.results.map(x => x.path), ['P/a.md']);
});

test('app: where.yaml czyta frontmatter z metadataCache (treść bez bloku ---)', async t => {
    const engine = appEngine({
        'a.md': { content: 'target one', frontmatter: { status: 'wip' } },
        'b.md': { content: 'target two', frontmatter: { status: 'done' } }
    });
    const r = await engine.runSearch({ query: 'target', where: { yaml: { status: 'wip' } } });
    t.deepEqual(r.results.map(x => x.path), ['a.md']);
});

test('app: where.links_from używa resolvedLinks (forward)', async t => {
    const engine = appEngine({
        'source.md': { content: 'target src' },
        'Alfa.md': { content: 'target alfa' },
        'Beta.md': { content: 'target beta' },
        'Gamma.md': { content: 'target gamma' }
    }, { 'source.md': { 'Alfa.md': 1, 'Beta.md': 1 } });
    const r = await engine.runSearch({ query: 'target', where: { links_from: 'source' } });
    t.deepEqual(r.results.map(x => x.path).sort(), ['Alfa.md', 'Beta.md']);
});

test('app: where.links_to używa resolvedLinks (backlinks)', async t => {
    const engine = appEngine({
        'linker.md': { content: 'target link' },
        'other.md': { content: 'target other' },
        'Target.md': { content: 'target self' }
    }, { 'linker.md': { 'Target.md': 1 } });
    const r = await engine.runSearch({ query: 'target', where: { links_to: 'Target' } });
    t.deepEqual(r.results.map(x => x.path), ['linker.md']);
});

test('fallback bez app: walker/parser/regex zachowane (yaml po treści ---)', async t => {
    const vault = vaultOf({
        'a.md': '---\nstatus: wip\n---\ntarget',
        'b.md': '---\nstatus: done\n---\ntarget'
    });
    const engine = new RetrievalEngine({ vault }); // brak app → dawna ścieżka
    const r = await engine.runSearch({ query: 'target', where: { yaml: { status: 'wip' } } });
    t.deepEqual(r.results.map(x => x.path), ['a.md']);
});

// ───────────────────── AUD-wydajnosc-024/055/075/025/056 (fabryka W3) ─────────────────────

/** Owija adapter licznikiem odczytów PER ŚCIEŻKA — pozwala zliczyć I/O bez zgadywania. */
function countingAdapter(files: Record<string, string>, reads: Record<string, number>): RetrievalVaultAdapterLike {
    const base = makeAdapter(files);
    return {
        ...base,
        read: async (p: string) => {
            reads[p] = (reads[p] || 0) + 1;
            return base.read(p);
        }
    };
}

test('AUD-024/055: sufit kandydatów PRZED czytaniem treści — bez `where` na 500 plikach czyta ≤300, nie 500', async t => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 500; i++) files[`n${i}.md`] = 'foo bar baz';
    const reads: Record<string, number> = {};
    const engine = new RetrievalEngine({ vault: { adapter: countingAdapter(files, reads) } });
    const r = await engine.runSearch({ query: 'foo', mode: 'keyword', limit: 10 });

    const totalReads = Object.values(reads).reduce((a, b) => a + b, 0);
    // Sufit skanu (musi się zgadzać z MAX_KEYWORD_SCAN_CANDIDATES=300) + do `limit`(10)
    // re-odczytów excerptu dla top wyniku (AUD-025: scan zwalnia treść po zliczeniu, więc
    // top jest doczytywany ponownie) — 300+10=310. Mutacja usuwająca sufit podniesie to
    // do ~500+10 i test oblewa.
    t.true(totalReads <= 310, `totalReads=${totalReads} — skan musi być obcięty na sufit, nie skanować całego vaulta (500)`);
    t.true(totalReads < 500, 'przed naprawą było dokładnie 500 (jeden odczyt na plik)');
    t.truthy(r.scan, 'wynik musi nieść uczciwą notę o obcięciu skanu');
    t.is(r.scan!.candidates, 500);
    t.true(r.scan!.scanned <= 300);
    t.true(r.scan!.truncated);
    t.true(r.results.length > 0, 'obcięty skan nadal musi zwracać trafienia');
});

test('scan info NIEOBECNE poniżej sufitu — kontrakt wyniku bez zmian dla małych vaultów', async t => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`n${i}.md`] = 'foo bar';
    const engine = new RetrievalEngine({ vault: vaultOf(files) });
    const r = await engine.runSearch({ query: 'foo', mode: 'keyword' });
    t.is(r.scan, undefined);
});

test('AUD-075: 5 równoległych identycznych `search` (ta sama vault) dzielą JEDEN skan (dedup w locie)', async t => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 50; i++) files[`n${i}.md`] = 'target content here';
    const reads: Record<string, number> = {};
    // 5 osobnych instancji silnika nad TYM SAMYM obiektem vault — dokładnie jak
    // `SearchTool.buildEngine` (nowa instancja per tool call) nad `plugin.app.vault`
    // wołane przez 5 równoległych sub-agentów z `delegate`.
    const vault: RetrievalVaultLike = { adapter: countingAdapter(files, reads) };
    const engines = Array.from({ length: 5 }, () => new RetrievalEngine({ vault }));
    const outcomes = await Promise.all(
        engines.map(e => e.runSearch({ query: 'target', mode: 'keyword', limit: 5 }))
    );

    const totalReads = Object.values(reads).reduce((a, b) => a + b, 0);
    // Bez dedupu: 5 × 50 = 250 odczytów tylko na sam skan. Z dedupem: JEDEN skan (50) +
    // każdy z 5 callerów dokłada najwyżej `limit`(5) odczytów excerptu dla swojego top —
    // sufit górny 50 + 5*5 = 75, daleko poniżej 250.
    t.true(totalReads < 5 * 50, `totalReads=${totalReads} — musi być dużo mniej niż 5×50=250 bez dedupu`);
    t.true(totalReads <= 50 + 5 * 5, `totalReads=${totalReads} — jeden skan (~50) + do 5×limit(5) excerptów`);
    for (const o of outcomes) t.true(o.results.length > 0);
});

test('AUD-025: contentCache nie trzyma treści po zliczeniu — top wynik czytany ponownie do excerptu', async t => {
    const files: Record<string, string> = { 'hit.md': 'target content once', 'other.md': 'no match here' };
    const reads: Record<string, number> = {};
    const engine = new RetrievalEngine({ vault: { adapter: countingAdapter(files, reads) } });
    const r = await engine.runSearch({ query: 'target', mode: 'keyword' });

    t.deepEqual(r.results.map(x => x.path), ['hit.md']);
    // Bez zwolnienia po zliczeniu (stary kod): 1 odczyt (scan), excerpt bierze z cache → 1.
    // Ze zwolnieniem (naprawa): 1 (scan) + 1 (excerpt re-read, bo scan zwolnił treść) = 2.
    // Mutacja usuwająca `contentCache.delete` w `_scanKeywordCandidates` sprowadzi to do 1
    // i test oblewa — dowód, że mapa NIE trzyma treści wszystkich zeskanowanych plików.
    t.is(reads['hit.md'], 2, 'top wynik musi być doczytany ponownie do excerptu, nie brany z trzymanego cache');
});

test('AUD-056: `_excerptStart` na dużym pliku nie normalizuje całej treści (widoczny excerpt bez zmian)', async t => {
    // Dużo białych znaków ZA granicą zapasu (max*4), właściwa treść na początku — dowód,
    // że widoczny excerpt jest identyczny z/bez optymalizacji (semantyka nie zmienia się).
    const head = 'Początek dokumentu z treścią do excerptu. '.repeat(3); // ~129 znaków, w limicie 200
    const tail = 'x '.repeat(200000); // daleko poza zapasem max*4=800 — dawniej normalizowane niepotrzebnie
    const vault = vaultOf({ 'big.md': head + tail });
    const engine = new RetrievalEngine({ vault });
    const r = await engine.runSearch({ where: {} }); // listing → _excerptStart
    const hit = r.results.find(x => x.path === 'big.md')!;
    t.true(hit.excerpt.startsWith('Początek dokumentu'));
    t.true(hit.excerpt.endsWith('…'), 'plik dłuższy niż max musi nadal nieść znak obcięcia');
    t.true(hit.excerpt.length <= 201); // 200 + '…'
});

// ───────────────────── Review rundy 2 (2026-09-02): bloker cross-agent + korekty ─────────────────────

test('BLOKER AUD-review-2: dedup NIE przecieka między agentami — równoległy search(scope:memory) różnych agentów widzi tylko swoje', async t => {
    // Dwaj agenci, WSPÓLNY obiekt vault (jak plugin.app.vault dla wszystkich agentów w produkcji),
    // KAŻDY z własną instancją silnika (jak SearchTool.buildEngine per tool call) i WŁASNYM
    // agentMemory.paths (różne roots). Oba pytają {scope:'memory', query:'projekt'} RÓWNOLEGLE —
    // identyczne scope+where+query, różni kandydaci. Bez naprawy dedup dzieliłby jeden skan i
    // agent B dostałby ścieżki/excerpt z brain agenta A ("sekret agenta A").
    const baseA = '.pkm-assistant/agents/agent-a/memory';
    const baseB = '.pkm-assistant/agents/agent-b/memory';
    const reads: Record<string, number> = {};
    const files: Record<string, string> = {
        [`${baseA}/brain/sekret_a.md`]: 'projekt tajny sekret agenta A - hasło do sejfu',
        [`${baseB}/brain/notatka_b.md`]: 'projekt agenta B - zupełnie inna sprawa'
    };
    const vault: RetrievalVaultLike = { adapter: countingAdapter(files, reads) };

    const engineA = new RetrievalEngine({ vault, agentMemory: { paths: memoryPaths(baseA) } });
    const engineB = new RetrievalEngine({ vault, agentMemory: { paths: memoryPaths(baseB) } });

    const [resultA, resultB] = await Promise.all([
        engineA.runSearch({ scope: 'memory', query: 'projekt', mode: 'keyword' }),
        engineB.runSearch({ scope: 'memory', query: 'projekt', mode: 'keyword' })
    ]);

    t.true(resultA.results.every(r => r.path.startsWith(baseA)), 'agent A nie może dostać ścieżek agenta B');
    t.true(resultB.results.every(r => r.path.startsWith(baseB)), 'agent B nie może dostać ścieżek agenta A');
    t.false(resultB.results.some(r => r.excerpt.includes('sekret agenta A')), 'agent B nie może zobaczyć sekretu agenta A w excerpcie');
    t.false(resultA.results.some(r => r.path.includes('notatka_b')));
});

test('POWAŻNE (korekta review): scope=memory ma sufit WYŁĄCZONY — trafienie w L2 znalezione mimo 400 plików archiwum przed nim', async t => {
    // _listMemoryFiles listuje brain -> brain/ -> sessions/active -> sessions/ARCHIVE -> L1 -> L2 -> L3.
    // Z sufitem 300 (jak dla scope=vault) 400 plików archiwum zjadłoby cały sufit i L2 nigdy
    // nie trafiłby do skanu. Bez sufitu (naprawa) trafienie w L2 jest znajdowane zawsze.
    const base = '.pkm-assistant/agents/jaskier/memory';
    const files: Record<string, string> = {};
    for (let i = 0; i < 400; i++) files[`${base}/sessions/archive/s${i}.md`] = 'stara rozmowa, nic ciekawego';
    files[`${base}/summaries/L2/l2_hit.md`] = 'ULUBIONYFRAZAUNIKALNA znaleziona w streszczeniu L2';

    const engine = new RetrievalEngine({ vault: vaultOf(files), agentMemory: { paths: memoryPaths(base) } });
    const r = await engine.runSearch({ scope: 'memory', query: 'ULUBIONYFRAZAUNIKALNA', mode: 'keyword' });

    t.deepEqual(r.results.map(x => x.path), [`${base}/summaries/L2/l2_hit.md`]);
    t.falsy(r.scan, 'scope=memory nie niesie noty o obcięciu — sufit jest wyłączony, nie tylko podniesiony');
});

test('REGRESJA (korekta review) AUD-056: 1000 pustych linii na początku pliku nie gubi treści w excerpcie', async t => {
    // Zapas STAŁY (max*4=800) dawał dawniej pusty "…" — cała pierwsza próba trafiała w same
    // puste linie. Zapas ROSNĄCY musi sięgnąć dalej i znaleźć prawdziwą treść.
    const blanks = '\n'.repeat(1000);
    const real = 'PRAWDZIWATRESCPOWINNABYCWIDOCZNA w excerpcie mimo tysiąca pustych linii przed nią.';
    const vault = vaultOf({ 'blanks.md': blanks + real });
    const engine = new RetrievalEngine({ vault });
    const r = await engine.runSearch({ where: {} });
    const hit = r.results.find(x => x.path === 'blanks.md')!;
    t.true(hit.excerpt.includes('PRAWDZIWATRESCPOWINNABYCWIDOCZNA'), `excerpt="${hit.excerpt}" — treść nie może zniknąć za pustymi liniami`);
    t.not(hit.excerpt.trim(), '…', 'excerpt nie może być samym znakiem obcięcia');
});

test('REGRESJA (korekta review) AUD-056: krótka treść + 900 białych znaków na końcu NIE dostaje fałszywego „…"', async t => {
    // Cała treść pliku mieści się dawno przed max(200) - nic nie zostało naprawdę obcięte,
    // tylko ogon białych znaków wypełniał zapas. Fałszywe "…" sugerowałoby userowi, że jest
    // więcej treści, choć plik się skończył.
    const content = 'Krótka notatka bez dalszej treści.' + ' '.repeat(900);
    const vault = vaultOf({ 'short.md': content });
    const engine = new RetrievalEngine({ vault });
    const r = await engine.runSearch({ where: {} });
    const hit = r.results.find(x => x.path === 'short.md')!;
    t.is(hit.excerpt, 'Krótka notatka bez dalszej treści.');
    t.false(hit.excerpt.endsWith('…'), `excerpt="${hit.excerpt}" — nic nie zostało obcięte, "…" byłby fałszywy`);
});
