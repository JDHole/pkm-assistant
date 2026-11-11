import test from 'ava';
import { mock } from 'node:test';
import { AgentMemory } from './AgentMemory.js';
import { SaveSessionWorkflow } from './SaveSessionWorkflow.js';
import { RetrievalEngine } from './RetrievalEngine.js';

function fixture(t: import('ava').ExecutionContext) {
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-11T07:37:00Z') });
    t.teardown(() => mock.timers.reset());
    const files = new Map<string, string>(), dirs = new Set<string>();
    const adapter = {
        exists: async (p: string) => files.has(p) || dirs.has(p),
        read: async (p: string) => { const text = files.get(p); if (text === undefined) throw new Error('ENOENT'); return text; },
        write: async (p: string, text: string) => { files.set(p, text); },
        append: async (p: string, text: string) => { files.set(p, (files.get(p) ?? '') + text); },
        remove: async (p: string) => { files.delete(p); },
        mkdir: async (p: string) => { dirs.add(p); },
        list: async (p: string) => ({ files: [...files.keys()].filter(f => f.startsWith(p + '/') && !f.slice(p.length + 1).includes('/')), folders: [] }),
        stat: async (p: string) => ({ mtime: Date.now(), size: files.get(p)?.length ?? 0 }),
    };
    return { files, adapter, memory: new AgentMemory({ adapter }, 'Jaskier') };
}
const base = 'jaskier_2026-11-11_07-37.md';
const second = 'jaskier_2026-11-11_07-37_2.md';
const oldArchive = '---\ncreated: 2026-11-11T07:37:00.000Z\n---\n\n## User\n\nRozmowa A\n\n---\n\n## Assistant\n\nOdpowiedź A';

for (const entry of ['startActiveSession', 'saveSession'] as const)
test.serial(`F4: ${entry} reserves names in active and archive`, async t => {
    const f = fixture(t);
    await f.memory.ensureMemoryStructure();
    f.files.set(f.memory.paths.sessionsArchive + '/' + base, oldArchive);
    const path = entry === 'startActiveSession' ? await f.memory.startActiveSession() : await f.memory.saveSession([{ role: 'user', content: 'Rozmowa B' }]);
    t.is(path, f.memory.paths.sessionsActive + '/' + second, 'New active session must not reuse an archived name');
    await f.memory.appendToActiveSession({ type: 'agent_message', content: 'Odpowiedź B' });
    t.deepEqual((await f.memory.loadActiveSession(path)).messages.map(m => m.content), entry === 'startActiveSession' ? ['Odpowiedź B'] : ['Rozmowa B', 'Odpowiedź B']);
    t.like(JSON.parse(await f.adapter.read(f.memory.paths.state)), { active_sessions: [second], last_used: second });
    t.deepEqual(JSON.parse(await f.adapter.read(f.memory.paths.activeSessionMeta)), { path, updated: Date.now() });
    const restored = new AgentMemory({ adapter: f.adapter }, 'Jaskier');
    t.is(await restored.restoreActiveSession(), path);
    t.is(restored.sessionEpoch, f.memory.sessionEpoch);
});

for (const lying of [false, true]) test.serial(`F4: legacy collision preserves original and returns actual archive lying=${lying}`, async t => {
    const f = fixture(t);
    const path = await f.memory.appendToActiveSession({ type: 'user_message', content: 'Rozmowa B' });
    await f.memory.appendToActiveSession({ type: 'agent_message', content: 'Odpowiedź B' });
    const original = f.memory.paths.sessionsArchive + '/' + base;
    f.files.set(original, oldArchive);
    if (lying) { const exists = f.adapter.exists; f.adapter.exists = async p => p === original ? false : exists(p); }
    const workflow = new SaveSessionWorkflow(f.memory);
    const prep = await workflow.prepareProposals({ path });
    const result = await workflow.applyDecision({ path }, prep, { action: 'archive', notes: [], brainUpdates: [] });
    t.is(await f.adapter.read(original), oldArchive, 'Existing archive bytes must survive');
    t.is(result.archivedPath, f.memory.paths.sessionsArchive + '/' + second);
    t.deepEqual((await f.memory.loadSession(result.archivedPath)).messages.map(m => m.content), ['Rozmowa B', 'Odpowiedź B']);
    t.like(result.counters, { archived_since_last_consolidation: 1 });
    t.like(JSON.parse(await f.adapter.read(f.memory.paths.state)), { active_sessions: [], last_used: null, archived_since_last_consolidation: 1 });
    t.deepEqual(JSON.parse(await f.adapter.read(f.memory.paths.activeSessionMeta)), {});
    t.deepEqual((await f.memory.listArchiveSessions()).map(s => s.name).sort(), [base, second]);
    const search = new RetrievalEngine({ vault: { adapter: f.adapter }, agentMemory: f.memory });
    const found = await search.runSearch({ query: 'Rozmowa B', scope: 'memory', mode: 'keyword', limit: 10 });
    t.deepEqual(found.results.filter(hit => hit.path.endsWith(second)).map(hit => hit.path), ['.pkm-assistant/agents/jaskier/memory/sessions/archive/jaskier_2026-11-11_07-37_2.md']);
    t.deepEqual(await f.memory._cleanupAfterL1([second], 'l1_collision.md'), { marked: 1, skipped: [] });
    t.deepEqual((await f.memory.listUncoveredArchiveSessions()).map(s => s.name), [base]);
    t.deepEqual(await f.memory.pruneArchive({ maxFiles: 1 }), { removed: 1 });
    t.is(await f.adapter.read(original), oldArchive);
});

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

// Different source basenames can compete for the same suffixed destination.
for (const stage of ['source-read', 'target-probe', 'target-missing-read', 'target-write', 'target-readback', 'source-remove', 'state-probe', 'state-read', 'state-write', 'state-counter-write', 'pointer-write'] as const)
test.serial(`F4: concurrent archive during ${stage} preserves both sources`, async t => {
    const f = fixture(t);
    await f.memory.ensureMemoryStructure();
    const a = f.memory.paths.sessionsActive + '/same.md', b = f.memory.paths.sessionsActive + '/same_2.md';
    const archive = f.memory.paths.sessionsArchive;
    f.files.set(a, 'Rozmowa A'); f.files.set(b, 'Rozmowa B');
    f.files.set(archive + '/same.md', 'Starsze archiwum');
    await f.memory.stateManager.addActiveSession('same.md');
    await f.memory.stateManager.addActiveSession('same_2.md');
    f.memory.setActiveSessionIdentity(a, null);
    const entered = deferred(), release = deferred();
    let held = false;
    const hold = async (matches: boolean) => { if (matches && !held) { held = true; entered.resolve(); await release.promise; } };
    const read = f.adapter.read, write = f.adapter.write, exists = f.adapter.exists, remove = f.adapter.remove;
    f.adapter.read = async p => {
        await hold(stage === 'source-read' && p === a || stage === 'target-missing-read' && p === archive + '/same_2.md' && !f.files.has(p)
            || stage === 'target-readback' && p.startsWith(archive + '/') && f.files.get(p) === 'Rozmowa A'
            || stage === 'state-read' && p === f.memory.paths.state);
        return read(p);
    };
    f.adapter.exists = async p => { await hold(stage === 'target-probe' && p.startsWith(archive + '/') || stage === 'state-probe' && p === f.memory.paths.state); return exists(p); };
    f.adapter.write = async (p, text) => {
        await hold(stage === 'target-write' && p.startsWith(archive + '/') || stage === 'state-write' && p === f.memory.paths.state || stage === 'state-counter-write' && p === f.memory.paths.state && text.includes('\"archived_since_last_consolidation\": 1') || stage === 'pointer-write' && p === f.memory.paths.activeSessionMeta);
        await write(p, text);
    };
    f.adapter.remove = async p => { await hold(stage === 'source-remove' && p === a); await remove(p); };
    const first = f.memory.archiveActiveSession(a);
    let other: Promise<string | null> | undefined;
    try {
        await Promise.race([entered.promise, first.then(() => { throw new Error('Boundary not reached: ' + stage); })]);
        const sibling = new AgentMemory({ adapter: f.adapter }, 'Jaskier');
        other = sibling.archiveActiveSession(b);
        // Let the competing writer reach its own first storage await.
        await new Promise<void>(resolve => setImmediate(resolve));
    } finally { release.resolve(); }
    const [firstPath, secondPath] = await Promise.all([first, other]);
    t.is(await f.adapter.read(archive + '/same.md'), 'Starsze archiwum');
    t.is(await f.adapter.read(firstPath!), 'Rozmowa A');
    t.is(await f.adapter.read(secondPath!), 'Rozmowa B');
    t.is((await f.adapter.list(archive)).files.length, 3);
    t.like(JSON.parse(await f.adapter.read(f.memory.paths.state)), { active_sessions: [], last_used: null, archived_since_last_consolidation: 2 });
});

test.serial('F4: exhausted archive suffixes leave source, selection and archive intact', async t => {
    const f = fixture(t);
    const path = await f.memory.appendToActiveSession({ type: 'user_message', content: 'Nie wolno zgubić tej rozmowy' });
    for (let i = 1; i <= 50; i++) f.files.set(f.memory.paths.sessionsArchive + '/' + (i === 1 ? base : base.replace('.md', `_${i}.md`)), 'Zajęte archiwum');
    await t.throwsAsync(f.memory.archiveActiveSession(path), { message: /archiveActiveSession: brak wolnej nazwy pliku sesji/ });
    t.deepEqual((await f.memory.loadActiveSession(path)).messages.map(m => m.content), ['Nie wolno zgubić tej rozmowy']);
    t.is(await f.adapter.read(f.memory.paths.sessionsArchive + '/' + base), 'Zajęte archiwum');
    t.like(JSON.parse(await f.adapter.read(f.memory.paths.state)), { active_sessions: [base], last_used: base, archived_since_last_consolidation: 0 });
    t.is(f.memory.activeSessionPath, path);
});

test.serial('F4: concurrent Discards protect overlapping suffixes', async t => {
    const f = fixture(t);
    await f.memory.ensureMemoryStructure();
    const root = f.memory.paths.sessionsActive, dir = root + '/.discarded';
    f.files.set(root + '/same.md', 'Rozmowa A');
    f.files.set(root + '/same_2.md', 'Rozmowa B');
    f.files.set(dir + '/same.md', 'Starsze odrzucenie');
    const entered = deferred(), release = deferred(), write = f.adapter.write;
    f.adapter.write = async (p, content) => {
        if (p.startsWith(dir + '/') && content === 'Rozmowa A') { entered.resolve(); await release.promise; }
        await write(p, content);
    };
    const first = f.memory.discardActiveSession(root + '/same.md');
    await entered.promise;
    const sibling = new AgentMemory({ adapter: f.adapter }, 'Jaskier');
    const other = sibling.discardActiveSession(root + '/same_2.md');
    await new Promise<void>(resolve => setImmediate(resolve));
    release.resolve();
    const [a, b] = await Promise.all([first, other]);
    t.is(await f.adapter.read(a!), 'Rozmowa A');
    t.is(await f.adapter.read(b!), 'Rozmowa B');
    t.is(await f.adapter.read(dir + '/same.md'), 'Starsze odrzucenie');
    t.is((await f.adapter.list(dir)).files.length, 3);
});

test.serial('F4: legacy migration competing with archive preserves both files', async t => {
    const f = fixture(t);
    await f.memory.ensureMemoryStructure();
    const root = f.memory.paths.sessions, archive = f.memory.paths.sessionsArchive;
    const active = f.memory.paths.sessionsActive + '/same.md';
    f.files.set(active, 'Aktywna rozmowa');
    f.files.set(root + '/same.md', 'Rozmowa legacy');
    const entered = deferred(), release = deferred(), write = f.adapter.write;
    f.adapter.write = async (p, content) => {
        if (p === archive + '/same.md' && content === 'Aktywna rozmowa') { entered.resolve(); await release.promise; }
        await write(p, content);
    };
    const moving = f.memory.archiveActiveSession(active);
    await entered.promise;
    const sibling = new AgentMemory({ adapter: f.adapter }, 'Jaskier');
    const migrating = sibling.ensureMemoryStructure();
    await new Promise<void>(resolve => setImmediate(resolve));
    release.resolve();
    await Promise.all([moving, migrating]);
    t.is(await f.adapter.read(archive + '/same.md'), 'Aktywna rozmowa');
    t.is(await f.adapter.read(root + '/same.md'), 'Rozmowa legacy');
});
