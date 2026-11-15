import test from 'ava';
import { mock } from 'node:test';
import { AgentMemory, type MemoryVaultAdapterLike } from './AgentMemory.js';
import { log } from '../../core/utils/Logger.js';
import { SessionHeaderWriteError } from './sessionHeaderWrite.js';
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
    t.is(d.files.get(a.path), header.replace('device: aaaaaaaaaaaaaaaa\n', 'device: bbbbbbbbbbbbbbbb\ntaken_over: 2026-11-15T10:00:01.000Z\n') + firstEvent);
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
    mock.timers.enable({ apis: ['Date'], now: Date.parse(timestamp) });
    t.teardown(() => mock.timers.reset());
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
    t.is(d.files.get(a.path), header.replace('device: aaaaaaaaaaaaaaaa\n', 'device: bbbbbbbbbbbbbbbb\ntaken_over: 2026-11-15T10:00:00.000Z\n') + firstEvent + secondEvent);
    // Uncertain content must not be written even when only metadata is broken.
    a.adapter.read = async () => { throw Object.assign(new Error('read unavailable'), { code: 'EACCES' }); };
    await t.throwsAsync(() => a.memory.appendToActiveSession({ type: 'user_message', content: 'Zablokuj też' }));
    t.is(d.files.get(a.path), header.replace('device: aaaaaaaaaaaaaaaa\n', 'device: bbbbbbbbbbbbbbbb\ntaken_over: 2026-11-15T10:00:00.000Z\n') + firstEvent + secondEvent);
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
test.serial(`D2d live and frozen messages preserve unowned header and opaque body: ${mode}`, async t => {
    const d = sharedDisk(), a = d.device(A);
    const oldHeader = '\uFEFF---\r\nagent: Mira\r\nepoch: 0123456789abcdef0123456789abcdef\r\n---\r\n';
    const body = '\r\nOpaque sk-abcdefghijklmnopqrstuvwxyz0123456789\r\n';
    const original = (mode === 'headerless' ? '' : oldHeader) + body;
    d.files.set(a.path, original);
    const append = mode === 'frozen'
        ? a.memory.appendSessionEvent.bind(a.memory, a.path)
        : a.memory.appendToActiveSession.bind(a.memory);
    await append({ type: 'user_message', content: 'Zażółć 🐈', timestamp });
    const expected = original + firstEvent;
    t.is(d.files.get(a.path), expected);
    t.deepEqual(a.calls.filter(([op]) => ['write', 'mkdir', 'remove'].includes(op)), []);
    t.is((await a.memory.loadActiveSession(a.path)).ownership, 'unowned');
    a.reset();
    await append({ type: 'agent_message', content: 'Odpowiedź', timestamp });
    t.is(d.files.get(a.path), expected + secondEvent);
    t.is(a.calls.filter(([op]) => op === 'write').length, 0);
});

for (const id of [A, null]) test.serial(`D2c periodic verification: exact bytes and I/O for 40 warm events, id=${id}`, async t => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse(timestamp) });
    t.teardown(() => mock.timers.reset());
    const d = sharedDisk(), a = d.device(id);
    d.files.set(a.path, header);
    await a.memory.appendToActiveSession({ type: 'user_message', content: 'Zażółć 🐈', timestamp });
    a.reset();
    let expected = header + firstEvent;
    for (let i = 2; i <= 41; i++) {
        await a.memory.appendToActiveSession({ type: 'agent_message', content: 'Odpowiedź', timestamp });
        expected += `## 2026-11-15T10:00:00.000Z — agent message\n\n**content:**\n\nOdpowiedź\n\n**seq:**\n\n${i}\n\n`;
    }
    t.is(d.files.get(a.path), expected);
    t.deepEqual(a.calls.filter(([op]) => op === 'read'), id ? [['read', a.path], ['read', a.path]] : []);
    t.is(a.calls.filter(([op]) => op === 'stat').length, id ? 40 : 0);
    t.is(a.calls.filter(([op]) => op === 'append').length, 40);
    t.deepEqual(a.calls.filter(([op]) => op === 'exists'), id ? [] : [['exists', a.path], ['exists', a.path]]);
});

for (const id of [A, null]) test.serial(`D2e unowned: 20 warm events keep bytes with one read for id or legacy exists without id, id=${id}`, async t => {
    const d = sharedDisk(), a = d.device(id);
    const original = '\uFEFF---\r\nagent: Mira\r\n---\r\n\r\nHistoria legacy\r\n';
    d.files.set(a.path, original);
    await a.memory.appendToActiveSession({ type: 'user_message', content: 'Zażółć 🐈', timestamp });
    a.reset();
    let expected = original + firstEvent;
    for (let i = 2; i <= 21; i++) {
        await a.memory.appendToActiveSession({ type: 'agent_message', content: 'Odpowiedź', timestamp });
        expected += `## 2026-11-15T10:00:00.000Z — agent message\n\n**content:**\n\nOdpowiedź\n\n**seq:**\n\n${i}\n\n`;
    }
    t.is(d.files.get(a.path), expected);
    t.deepEqual(a.calls.reduce<Record<string, number>>((counts, [op]) => {
        counts[op] = (counts[op] ?? 0) + 1; return counts;
    }, {}), id ? { stat: 20, append: 20, read: 1 } : { append: 20, exists: 1 });
    t.is((await a.memory.loadActiveSession(a.path)).ownership, id ? 'unowned' : undefined);
});

test.serial('D2e unowned writer detects real metadata adoption with colliding size/mtime on event 20', async t => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse(timestamp) });
    t.teardown(() => mock.timers.reset());
    const d = sharedDisk(), a = d.device(A), b = d.device(B);
    // BOM (3 bytes) + 22 CRLFs lose exactly the 25 bytes added by device at save.
    const fields = Array.from({ length: 17 }, (_, i) => `opaque${i}: x`);
    const original = '\uFEFF---\r\nagent: Mira\r\nupdated: 2026-11-15T10:00:00.000Z\r\nmessageCount: 1\r\n'
        + fields.join('\r\n') + '\r\n---\r\n';
    d.files.set(a.path, original);
    await a.memory.appendToActiveSession({ type: 'user_message', content: 'Zażółć 🐈', timestamp });
    t.is(d.files.get(a.path), original + firstEvent);
    const beforeStat = await a.adapter.stat!(a.path);
    await b.memory.saveSession((await b.memory.loadActiveSession(a.path)).messages);
    const adopted = '---\nagent: Mira\nupdated: 2026-11-15T10:00:00.000Z\nmessageCount: 1\n'
        + fields.join('\n') + '\ndevice: bbbbbbbbbbbbbbbb\n---\n' + firstEvent;
    t.is(d.files.get(a.path), adopted);
    t.deepEqual(await b.adapter.stat!(a.path), beforeStat);
    t.is((await b.memory.loadActiveSession(a.path)).ownership, 'mine');
    a.reset();
    let expected = adopted;
    for (let i = 2; i <= 20; i++) {
        mock.timers.tick(17);
        await a.memory.appendToActiveSession({ type: 'agent_message', content: 'Odpowiedź', timestamp });
        expected += `## 2026-11-15T10:00:00.000Z — agent message\n\n**content:**\n\nOdpowiedź\n\n**seq:**\n\n${i}\n\n`;
    }
    t.is(d.files.get(a.path), expected);
    await t.throwsAsync(() => a.memory.appendToActiveSession({ type: 'agent_message', content: 'Zablokowane', timestamp }), { instanceOf: ForeignSessionError });
    t.is(d.files.get(a.path), expected);
    t.deepEqual(a.calls.map(([op]) => op), [
        ...Array.from({ length: 19 }, () => ['stat', 'append']).flat(), 'stat', 'read',
    ]);
    const fresh = await d.device(A).memory.loadActiveSession(a.path);
    t.is(fresh.ownership, 'foreign');
    t.deepEqual(fresh.messages.map(m => m.content), ['Zażółć 🐈', ...Array<string>(19).fill('Odpowiedź')]);
});

test.serial('D2e unowned writer refuses an ambiguous header with colliding size/mtime on event 20', async t => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse(timestamp) });
    t.teardown(() => mock.timers.reset());
    const d = sharedDisk(), a = d.device(A), b = d.device(B);
    const original = '---\nagent: Mira\npadding: 12345678901234567\npadding: 12345678901234567\n---\n';
    d.files.set(a.path, original);
    await a.memory.appendToActiveSession({ type: 'user_message', content: 'Zażółć 🐈', timestamp });
    const beforeStat = await a.adapter.stat!(a.path);
    const ambiguous = '---\nagent: Mira\ndevice: aaaaaaaaaaaaaaaa  \ndevice: bbbbbbbbbbbbbbbb  \n---\n' + firstEvent;
    await b.adapter.write(a.path, ambiguous);
    t.deepEqual(await b.adapter.stat!(a.path), beforeStat);
    a.reset();
    let expected = ambiguous;
    for (let i = 2; i <= 20; i++) {
        await a.memory.appendToActiveSession({ type: 'agent_message', content: 'Odpowiedź', timestamp });
        expected += `## 2026-11-15T10:00:00.000Z — agent message\n\n**content:**\n\nOdpowiedź\n\n**seq:**\n\n${i}\n\n`;
    }
    await t.throwsAsync(() => a.memory.appendToActiveSession({ type: 'agent_message', content: 'Zablokowane', timestamp }), { instanceOf: ForeignSessionError });
    t.is(d.files.get(a.path), expected);
    t.deepEqual(a.calls.map(([op]) => op), [
        ...Array.from({ length: 19 }, () => ['stat', 'append']).flat(), 'stat', 'read',
    ]);
});

test.serial('D2d unowned writer detects adoption by another device at metadata save', async t => {
    const d = sharedDisk(), a = d.device(A), b = d.device(B);
    const original = '---\nagent: Mira\n---\n';
    d.files.set(a.path, original);
    await a.memory.appendToActiveSession({ type: 'user_message', content: 'Zażółć 🐈', timestamp });
    // Simulates the first app being killed before metadata save: B can still append.
    await b.memory.appendToActiveSession({ type: 'agent_message', content: 'Odpowiedź', timestamp });
    t.is(d.files.get(a.path), original + firstEvent + secondEvent);
    await b.memory.saveSession((await b.memory.loadActiveSession(a.path)).messages);
    const saved = d.files.get(a.path)!;
    t.is((await b.memory.loadActiveSession(a.path)).ownership, 'mine');
    a.reset();
    await t.throwsAsync(() => a.memory.appendToActiveSession({ type: 'user_message', content: 'Za późno', timestamp }), { instanceOf: ForeignSessionError });
    t.deepEqual(a.calls, [['stat', a.path], ['read', a.path]]);
    t.is(d.files.get(a.path), saved);
    t.deepEqual((await b.memory.loadActiveSession(a.path)).messages.map(m => m.content), ['Zażółć 🐈', 'Odpowiedź']);
});

for (const owner of ['foreign', 'ambiguous'] as const)
test.serial(`D2c old-format takeover with colliding size/mtime stops event 20: ${owner}`, async t => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse(timestamp) });
    t.teardown(() => mock.timers.reset());
    const d = sharedDisk(), a = d.device(A), b = d.device(B);
    // Same-sized padding becomes an extra marker, without changing size or mtime.
    const originalHeader = owner === 'foreign' ? header : header.replace('agent: Mira', 'padding: 12345678901234567');
    d.files.set(a.path, originalHeader);
    await a.memory.appendToActiveSession({ type: 'user_message', content: 'Zażółć 🐈', timestamp });
    const before = d.files.get(a.path)!;
    const swapped = owner === 'foreign' ? before.replace('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb')
        : before.replace('padding: 12345678901234567', 'device: bbbbbbbbbbbbbbbb  ');
    t.is(new TextEncoder().encode(swapped).length, new TextEncoder().encode(before).length);
    await b.adapter.write(a.path, swapped);
    a.reset();
    let expected = swapped;
    for (let i = 2; i <= 20; i++) {
        await a.memory.appendToActiveSession({ type: 'agent_message', content: 'Odpowiedź', timestamp });
        expected += `## 2026-11-15T10:00:00.000Z — agent message\n\n**content:**\n\nOdpowiedź\n\n**seq:**\n\n${i}\n\n`;
    }
    await t.throwsAsync(() => a.memory.appendToActiveSession({ type: 'agent_message', content: 'Zablokowane', timestamp }), { instanceOf: ForeignSessionError });
    t.is(d.files.get(a.path), expected);
    t.is(a.calls.filter(([op]) => op === 'append').length, 19);
    t.is(a.calls.filter(([op]) => op === 'stat').length, 20);
    t.deepEqual(a.calls.filter(([op]) => op === 'read'), [['read', a.path]]);
});

test.serial('D2c takeover A -> B -> A -> B grows every time with frozen mtime, blocks first stale append and archives without marker', async t => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse(timestamp) });
    t.teardown(() => mock.timers.reset());
    const d = sharedDisk(), a = d.device(A), b = d.device(B);
    d.files.set(a.path, header);
    await a.memory.appendToActiveSession({ type: 'user_message', content: 'Zażółć 🐈', timestamp });
    const sizes = [new TextEncoder().encode(d.files.get(a.path)!).length];
    let expectedBody = firstEvent;
    for (const [index, [next, stale, device]] of ([[b, a, 'bbbbbbbbbbbbbbbb'], [a, b, 'aaaaaaaaaaaaaaaa'], [b, a, 'bbbbbbbbbbbbbbbb']] as const).entries()) {
        // Warm the old owner after its preceding takeover, without adding an event.
        // A tool event makes this a genuine warm writer on all three transitions.
        if (index > 0) {
            await stale.memory.appendToActiveSession({ type: 'tool_call', tool: 'read', timestamp });
            expectedBody += `## 2026-11-15T10:00:00.000Z — tool call\n\n**tool:**\n\nread\n\n**seq:**\n\n${index + 1}\n\n`;
        }
        const prior = d.files.get(a.path)!;
        const size = new TextEncoder().encode(prior).length;
        await next.memory.takeOverActiveSession(a.path);
        const actual = d.files.get(a.path)!;
        const stamps = Array(index + 1).fill('2026-11-15T10:00:00.000Z').join(',');
        const expectedHeader = `---\nagent: Mira\nepoch: 0123456789abcdef0123456789abcdef\ndevice: ${device}\ntaken_over: ${stamps}\n---\n`;
        t.is(actual, expectedHeader + expectedBody);
        sizes.push(new TextEncoder().encode(actual).length);
        t.true(sizes.at(-1)! > size);
        t.is(d.mtimes.get(a.path), Date.parse(timestamp));
        stale.reset();
        await t.throwsAsync(() => stale.memory.appendToActiveSession({ type: 'user_message', content: 'Nie', timestamp }), { instanceOf: ForeignSessionError });
        t.deepEqual(stale.calls, [['stat', a.path], ['read', a.path]]);
        t.is(d.files.get(a.path), actual);
    }
    t.is(new Set(sizes).size, 4);
    const old = d.device(null);
    t.deepEqual((await old.memory.loadActiveSession(a.path)).messages.map(m => m.content), ['Zażółć 🐈']);
    await b.memory.initialize();
    const archive = await b.memory.archiveActiveSession(a.path);
    t.is(d.files.get(archive!), '---\nagent: Mira\nepoch: 0123456789abcdef0123456789abcdef\nupdated: 2026-11-15T10:00:00.000Z\nmessageCount: 1\n---\n## User\nZażółć 🐈');
});

for (const failure of ['none', 'backup-write', 'backup-mismatch', 'partial-throw', 'partial-silent', 'readback', 'restore-throw', 'restore-mismatch'] as const)
test.serial(`D2c verified backup and header recovery: takeover/${failure}`, async t => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse(timestamp) });
    t.teardown(() => { mock.timers.reset(); mock.restoreAll(); });
    const d = sharedDisk(), a = d.device(A);
    const original = header.replace('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb')
        + '\r\nOpaque sk-abcdefghijklmnopqrstuvwxyz0123456789\r\n\r\n## User\r\n\r\nHistoria\r\n';
    const backup = '.pkm-assistant/backups/session-mira-legacy-1794736800000.md.bak';
    d.files.set(a.path, original);
    const warnings: unknown[][] = [], errors: unknown[][] = [];
    mock.method(log, 'warn', (...args: unknown[]) => { warnings.push(args); });
    mock.method(log, 'error', (...args: unknown[]) => { errors.push(args); });
    const write = a.adapter.write, read = a.adapter.read;
    let attempts = 0, failReadback = false;
    a.adapter.write = async (path, content) => {
        if (path === backup && failure === 'backup-write') throw new Error('full');
        if (path === backup && failure === 'backup-mismatch') return write(path, 'partial backup');
        if (path === a.path) {
            attempts++;
            if (attempts === 1 && ['partial-throw', 'partial-silent', 'restore-throw', 'restore-mismatch'].includes(failure)) {
                await write(path, new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(content).slice(0, 20)));
                if (failure !== 'partial-silent') throw new Error('partial write');
                return;
            }
            if (attempts === 1 && failure === 'readback') failReadback = true;
            if (attempts === 2 && failure === 'restore-throw') throw new Error('restore failed');
            if (attempts === 2 && failure === 'restore-mismatch') return write(path, new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(original).slice(0, 20)));
        }
        await write(path, content);
    };
    a.adapter.read = async path => {
        if (path === a.path && failReadback) { failReadback = false; throw new Error('readback failed'); }
        return read(path);
    };
    const run = () => a.memory.takeOverActiveSession(a.path);
    const broken = failure === 'restore-throw' || failure === 'restore-mismatch';
    if (failure !== 'none') await t.throwsAsync(run, { instanceOf: SessionHeaderWriteError });
    else await run();
    const body = original.slice(original.indexOf('\n---\n') + 5);
    const output = header.replace('device: aaaaaaaaaaaaaaaa\n', 'device: aaaaaaaaaaaaaaaa\ntaken_over: 2026-11-15T10:00:00.000Z\n') + body;
    t.is(d.files.get(a.path), broken ? '---\nagent: Mira\nepoc' : failure === 'none' ? output : original);
    const noBackup = failure === 'backup-write' || failure === 'backup-mismatch';
    t.is(attempts, noBackup ? 0 : failure === 'none' ? 1 : 2);
    if (!noBackup) t.is(d.files.get(backup), original);
    t.is(warnings.length, failure === 'none' || broken ? 0 : 1);
    t.is(errors.length, broken ? 1 : 0);
    if (broken) {
        t.deepEqual(errors[0], ['AgentMemory', 'Session header restoration failed; recover from backup', { path: a.path, backupPath: backup }]);
        t.is(a.calls.filter(([op]) => op === 'append').length, 0);
    }
});

for (const escaped of [false, true]) test.serial(`D2c takeover grows a BOM/CRLF header without shrinking a padded or escaped device: ${escaped}`, async t => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse(timestamp) });
    t.teardown(() => mock.timers.reset());
    const d = sharedDisk(), a = d.device(A), b = d.device(B);
    const prefix = '\uFEFF---\r\n' + 'unknown: żółć\r\n'.repeat(80);
    const deviceLine = escaped ? 'device: "' + '\\u0061'.repeat(16) + '"' : 'device:   "aaaaaaaaaaaaaaaa"' + ' '.repeat(80);
    const original = prefix + deviceLine + '\r\n---\r\n\r\n## User\r\n\r\nHistoria\r\n';
    d.files.set(a.path, original);
    await b.memory.takeOverActiveSession(a.path);
    const expectedDevice = escaped ? 'device: bbbbbbbbbbbbbbbb' + ' '.repeat(82) : 'device:   "bbbbbbbbbbbbbbbb"' + ' '.repeat(80);
    const expected = prefix + expectedDevice + '\r\ntaken_over: 2026-11-15T10:00:00.000Z\r\n---\r\n\r\n## User\r\n\r\nHistoria\r\n';
    t.is(d.files.get(a.path), expected);
    t.true(new TextEncoder().encode(expected).length > new TextEncoder().encode(original).length);
    t.is((await b.memory.loadActiveSession(a.path)).ownership, 'mine');
    t.is(d.files.get('.pkm-assistant/backups/session-mira-legacy-1794736800000.md.bak'), original);
});
