import test from 'ava';
import { mock } from 'node:test';
import { AgentMemory, type MemoryVaultAdapterLike } from './AgentMemory.js';
import { ForeignSessionError, parseDeviceId } from './sessionOwnership.js';

const A = parseDeviceId('aaaaaaaaaaaaaaaa')!;
const B = parseDeviceId('bbbbbbbbbbbbbbbb')!;
const epoch = '0123456789abcdef0123456789abcdef';
const timestamp = '2026-11-15T10:00:00.000Z';
const header = '---\nagent: Mira\nepoch: 0123456789abcdef0123456789abcdef\ndevice: aaaaaaaaaaaaaaaa\n---\n';
const firstEvent = '## 2026-11-15T10:00:00.000Z — user message\n\n**content:**\n\nZażółć 🐈\n\n**seq:**\n\n1\n\n';
const secondEvent = '## 2026-11-15T10:00:00.000Z — agent message\n\n**content:**\n\nOdpowiedź\n\n**seq:**\n\n2\n\n';

function sharedDisk() {
    const files = new Map<string, string>();
    const mtimes = new Map<string, number>();
    const folders = new Set<string>();
    // Each call creates an independent adapter and independent AgentMemory caches.
    function device(id: typeof A | null) {
        const calls: Array<[string, string]> = [];
        const adapter: MemoryVaultAdapterLike = {
            async read(path) { calls.push(['read', path]); if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(path)!; },
            async write(path, value) { calls.push(['write', path]); files.set(path, value); mtimes.set(path, Date.now()); },
            async append(path, value, options) { calls.push(['append', path]); files.set(path, (files.get(path) ?? '') + value); mtimes.set(path, options?.mtime ?? Date.now()); },
            async stat(path) { calls.push(['stat', path]); return files.has(path) ? { size: new TextEncoder().encode(files.get(path)!).length, mtime: mtimes.get(path) ?? 1 } : null; },
            async exists(path) { calls.push(['exists', path]); return files.has(path) || folders.has(path); },
            async mkdir(path) { calls.push(['mkdir', path]); folders.add(path); },
            async remove(path) { calls.push(['remove', path]); files.delete(path); },
            async list(path) { calls.push(['list', path]); return { files: [...files.keys()].filter(p => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/')), folders: [] }; },
        };
        const memory = new AgentMemory({ adapter }, 'Mira', {}, id);
        memory._newSessionEpoch = () => epoch;
        const path = `${memory.paths.sessionsActive}/legacy.md`;
        memory.setActiveSessionIdentity(path, epoch);
        return { memory, adapter, path, calls, reset() { calls.length = 0; } };
    }
    return { files, mtimes, device };
}

for (const id of [A, null]) test.serial(`D2b warm append has exact bytes, one stat with id, no reads after warmup: ${id}`, async t => {
    const d = sharedDisk(), a = d.device(id);
    d.files.set(a.path, header);
    await a.memory.appendToActiveSession({ type: 'user_message', content: 'Zażółć 🐈', timestamp });
    t.is(d.files.get(a.path), header + firstEvent);
    a.reset();
    await a.memory.appendToActiveSession({ type: 'agent_message', content: 'Odpowiedź', timestamp });
    t.is(d.files.get(a.path), header + firstEvent + secondEvent);
    t.deepEqual(a.calls, id ? [['stat', a.path], ['append', a.path]] : [['append', a.path]]);
});

test.serial('D2b warm A refuses the first append after B takes over through an independent adapter', async t => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse(timestamp) });
    t.teardown(() => mock.timers.reset());
    const d = sharedDisk(), a = d.device(A), b = d.device(B);
    d.files.set(a.path, header);
    await a.memory.appendToActiveSession({ type: 'user_message', content: 'Zażółć 🐈', timestamp });
    mock.timers.tick(1000);
    await b.memory.takeOverActiveSession(a.path);
    a.reset();
    await t.throwsAsync(() => a.memory.appendToActiveSession({ type: 'agent_message', content: 'Niedozwolone', timestamp }), { instanceOf: ForeignSessionError });
    t.is(d.files.get(a.path), header.replace('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb') + firstEvent);
    t.deepEqual(a.calls, [['stat', a.path], ['read', a.path]]);
});

test.serial('D2b same-device external append refreshes seq and missing newline even if mtime is unchanged', async t => {
    const d = sharedDisk(), a = d.device(A), b = d.device(A);
    d.files.set(a.path, header);
    await a.memory.appendToActiveSession({ type: 'user_message', content: 'Zażółć 🐈', timestamp });
    const mtime = d.mtimes.get(a.path)!;
    await b.memory.appendToActiveSession({ type: 'agent_message', content: 'Odpowiedź', timestamp });
    d.files.set(a.path, d.files.get(a.path)!.trimEnd());
    d.mtimes.set(a.path, mtime);
    a.reset();
    await a.memory.appendToActiveSession({ type: 'user_message', content: 'Trzecia', timestamp });
    t.is(d.files.get(a.path), header + firstEvent + secondEvent.trimEnd() + '\n## 2026-11-15T10:00:00.000Z — user message\n\n**content:**\n\nTrzecia\n\n**seq:**\n\n3\n\n');
    t.deepEqual(a.calls, [['stat', a.path], ['read', a.path], ['append', a.path]]);
});

for (const mode of ['absent', 'throws', 'null', 'size-only', 'ignored-mtime'] as const)
test.serial(`D2b ${mode} stat falls back to fresh ownership and keeps healthy conversations writable`, async t => {
    const d = sharedDisk(), a = d.device(A), b = d.device(B);
    d.files.set(a.path, header);
    await a.memory.appendToActiveSession({ type: 'user_message', content: 'Zażółć 🐈', timestamp });
    if (mode === 'absent') delete a.adapter.stat;
    else a.adapter.stat = async path => {
        a.calls.push(['stat', path]);
        if (mode === 'throws') throw new Error('stat unavailable');
        if (mode === 'null') return null;
        if (mode === 'size-only') return { size: new TextEncoder().encode(d.files.get(path)!).length };
        return { size: new TextEncoder().encode(d.files.get(path)!).length, mtime: 1 };
    };
    a.reset();
    await a.memory.appendToActiveSession({ type: 'agent_message', content: 'Odpowiedź', timestamp });
    t.is(d.files.get(a.path), header + firstEvent + secondEvent);
    t.deepEqual(a.calls, [...(mode === 'absent' ? [] : [['stat', a.path]]), ['read', a.path], ['append', a.path]]);
    await b.memory.takeOverActiveSession(a.path);
    await t.throwsAsync(() => a.memory.appendToActiveSession({ type: 'user_message', content: 'Zablokuj' }), { instanceOf: ForeignSessionError });
    t.is(d.files.get(a.path), header.replace('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb') + firstEvent + secondEvent);
    // Uncertain content must not be written even when only metadata is broken.
    a.adapter.read = async () => { throw Object.assign(new Error('read unavailable'), { code: 'EACCES' }); };
    await t.throwsAsync(() => a.memory.appendToActiveSession({ type: 'user_message', content: 'Zablokuj też' }));
    t.is(d.files.get(a.path), header.replace('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb') + firstEvent + secondEvent);
});

for (const fields of [
    'device: bbbbbbbbbbbbbbbb\ndevice: aaaaaaaaaaaaaaaa',
    '<<<<<<< HEAD\ndevice: bbbbbbbbbbbbbbbb\n=======\ndevice: aaaaaaaaaaaaaaaa\n>>>>>>> sync',
    'device: aaaaaaaaaaaaaaaa\n=======',
    'device: aaaaaaaaaaaaaaaa\n||||||| base',
]) test.serial(`D2b ambiguous header is listed, never restored, and every writer refuses: ${fields}`, async t => {
    const d = sharedDisk(), a = d.device(A);
    await a.memory.initialize();
    const text = `---\nagent: Mira\nepoch: ${epoch}\n${fields}\n---\n\n## User\n\nHistoria\n`;
    d.files.set(a.path, text);
    await a.memory.stateManager.addActiveSession('legacy.md');
    t.deepEqual((await a.memory.listActiveSessions()).map(s => [s.name, s.ownership]), [['legacy.md', 'ambiguous']]);
    t.is((await a.memory.loadActiveSession(a.path)).ownership, 'ambiguous');
    t.is(await a.memory.restoreActiveSession(), null);
    const before = [...d.files];
    a.reset();
    for (const mutate of [
        () => a.memory.appendToActiveSession({ type: 'user_message', content: 'Nie' }),
        () => a.memory.appendSessionEvent(a.path, { type: 'agent_message', content: 'Nie' }, epoch),
        () => a.memory.createSessionWriter(a.path, epoch).appendToActiveSession({ type: 'user_message', content: 'Nie' }),
        () => a.memory.saveSession([{ role: 'user', content: 'Nie' }]),
        () => a.memory.archiveActiveSession(a.path), () => a.memory.discardActiveSession(a.path),
        () => a.memory.ensureActiveSessionEpoch(a.path, () => true), () => a.memory.takeOverActiveSession(a.path),
    ]) {
        await t.throwsAsync(mutate, { instanceOf: ForeignSessionError });
        t.deepEqual([...d.files], before);
    }
    t.deepEqual(a.calls.filter(([op]) => ['write', 'append', 'remove', 'mkdir'].includes(op)), []);
});

for (const mode of ['live', 'frozen', 'headerless'] as const)
test.serial(`D2b first message adopts once with opaque body preserved: ${mode}`, async t => {
    const d = sharedDisk(), a = d.device(A);
    const oldHeader = '\uFEFF---\r\nagent: Mira\r\nepoch: 0123456789abcdef0123456789abcdef\r\n---\r\n';
    const body = '\r\nOpaque sk-abcdefghijklmnopqrstuvwxyz0123456789\r\n';
    const original = (mode === 'headerless' ? '' : oldHeader) + body;
    d.files.set(a.path, original);
    const append = mode === 'frozen'
        ? a.memory.appendSessionEvent.bind(a.memory, a.path)
        : a.memory.appendToActiveSession.bind(a.memory);
    await append({ type: 'user_message', content: 'Zażółć 🐈', timestamp });
    const expected = (mode === 'headerless' ? '' : header) + body + firstEvent;
    t.is(d.files.get(a.path), expected);
    t.is(a.calls.filter(([op]) => op === 'write').length, mode === 'headerless' ? 0 : 1);
    a.reset();
    await append({ type: 'agent_message', content: 'Odpowiedź', timestamp });
    t.is(d.files.get(a.path), expected + secondEvent);
    t.is(a.calls.filter(([op]) => op === 'write').length, 0);
});
