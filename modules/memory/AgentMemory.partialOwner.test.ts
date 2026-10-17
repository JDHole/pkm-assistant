import test from 'ava';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, dirname } from 'node:path';
import { AgentMemory } from './AgentMemory.js';
import { parseActiveSession } from './activeSessionFormat.js';

async function fixture() {
    const root = await fs.mkdtemp(join(tmpdir(), 'pkm-u3-owner-'));
    const safe = (path: string) => { const target = resolve(root, path); if (relative(root, target).startsWith('..')) throw new Error('test path escape'); return target; };
    let blocked = '';
    const adapter = {
        async exists(path: string) { try { await fs.stat(safe(path)); return true; } catch { return false; } },
        async read(path: string) { if (path === blocked) throw new Error('test read denied'); return fs.readFile(safe(path), 'utf8'); },
        async write(path: string, content: string) { await fs.mkdir(dirname(safe(path)), { recursive: true }); await fs.writeFile(safe(path), content); },
        async append(path: string, content: string) { await fs.appendFile(safe(path), content); },
        async mkdir(path: string) { await fs.mkdir(safe(path), { recursive: true }); },
        async list() { return { files: [], folders: [] }; },
    };
    const memory = new AgentMemory({ adapter }, 'Owner A');
    const a = memory.paths.sessionsActive + '/a.md'; const b = memory.paths.sessionsActive + '/b.md';
    await adapter.write(a, memory._activeSessionHeader('Owner A', '2026-09-28T00:00:00Z'));
    await adapter.write(b, 'B unchanged\n'); memory.activeSessionPath = a;
    return { root, memory, adapter, a, b, safe, block: (path: string) => { blocked = path; } };
}

test('disk owner A retains system partials after switch to B; deletion fails closed even with warm cache', async t => {
    const f = await fixture(); t.teardown(() => fs.rm(f.root, { recursive: true, force: true }));
    await f.memory.appendSessionEvent(f.a, { type: 'agent_loop_partial', role: 'system', content: 'partial one', result: { revision: 1 } });
    f.memory.activeSessionPath = f.b;
    await f.memory.appendSessionEvent(f.a, { type: 'agent_loop_partial', role: 'system', content: 'partial two', result: { revision: 2 } });
    const parsed = parseActiveSession(await f.adapter.read(f.a));
    t.deepEqual(parsed.messages.map(m => [m.role, m.content]), [['system', 'partial one'], ['system', 'partial two']]);
    t.is(await f.adapter.read(f.b), 'B unchanged\n');
    await fs.rm(f.safe(f.a));
    await t.throwsAsync(f.memory.appendSessionEvent(f.a, { type: 'agent_loop_partial', role: 'system', content: 'late partial' }));
    t.false(await f.adapter.exists(f.a));
    t.is(await f.adapter.read(f.b), 'B unchanged\n');
    t.is(f.memory.activeSessionPath, f.b);
});

test('unreadable frozen file is never appended or redirected', async t => {
    const f = await fixture(); t.teardown(() => fs.rm(f.root, { recursive: true, force: true }));
    await f.memory.appendSessionEvent(f.a, { type: 'agent_loop_partial', role: 'system', content: 'warm cache' });
    const before = await f.adapter.read(f.a); f.block(f.a); f.memory.activeSessionPath = f.b;
    await t.throwsAsync(f.memory.appendSessionEvent(f.a, { type: 'agent_loop_partial', role: 'system', content: 'blocked revision' }));
    t.is(await fs.readFile(f.safe(f.a), 'utf8'), before);
    t.is(await f.adapter.read(f.b), 'B unchanged\n');
    await t.throwsAsync(f.memory.appendSessionEvent(f.b + '/../outside.md', { content: 'outside' }));
});
