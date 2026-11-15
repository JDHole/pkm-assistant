import test from 'ava';
import { readFileSync } from 'node:fs';
import { AgentMemory, type MemoryVaultAdapterLike } from './AgentMemory.js';
import { SessionConflictError, mergeSessionConflict } from './sessionConflict.js';
import { parseDeviceId, ForeignSessionError } from './sessionOwnership.js';
import { formatSessionEvent, parseActiveSession } from './activeSessionFormat.js';
import { log } from '../../core/utils/Logger.js';

const raw = readFileSync(new URL('./fixtures/session-conflict/sesja_konflikt_markery.md', import.meta.url), 'utf8');
const sideA = readFileSync(new URL('./fixtures/session-conflict/sesja_strona_A.md', import.meta.url), 'utf8');
const sideB = readFileSync(new URL('./fixtures/session-conflict/sesja_strona_B.md', import.meta.url), 'utf8');
// Independent expected union: A's complete file plus B's two new events.
const clean = sideA + sideB.slice(sideB.indexOf('## 2026-11-14T14:26:36.762Z'));
const epoch = '24c013732c84ddf9eade43ab0b43445e';
const timestamp = '2026-11-15T12:00:00.000Z';
const event = { type: 'user_message', content: 'Następna wiadomość', timestamp };
const nextBlock = '## 2026-11-15T12:00:00.000Z — user message\n\n**content:**\n\nNastępna wiadomość\n\n**seq:**\n\n8\n\n';
const id = parseDeviceId('aaaaaaaaaaaaaaaa');

function disk(content = raw, device = id) {
    const files = new Map<string, string>();
    const folders = new Set<string>();
    const calls: Array<[string, string]> = [];
    const mtimes = new Map<string, number>();
    const adapter: MemoryVaultAdapterLike = {
        async read(path) { calls.push(['read', path]); if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(path)!; },
        async write(path, value) { calls.push(['write', path]); files.set(path, value); mtimes.set(path, Date.now()); },
        async append(path, value, options) { calls.push(['append', path]); files.set(path, files.get(path)! + value); mtimes.set(path, options?.mtime ?? Date.now()); },
        async stat(path) { calls.push(['stat', path]); return files.has(path) ? { size: new TextEncoder().encode(files.get(path)!).length, mtime: mtimes.get(path) ?? 1 } : null; },
        async exists(path) { calls.push(['exists', path]); return files.has(path) || folders.has(path); },
        async mkdir(path) { calls.push(['mkdir', path]); folders.add(path); },
        async list(path) { calls.push(['list', path]); return { files: [...files.keys()].filter(p => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/')), folders: [] }; },
        async remove(path) { calls.push(['remove', path]); files.delete(path); },
    };
    const memory = new AgentMemory({ adapter }, 'Jaskier', {}, device);
    memory._structureEnsured = true;
    const path = `${memory.paths.sessionsActive}/conflict.md`;
    memory.setActiveSessionIdentity(path, epoch);
    files.set(path, content);
    files.set(memory.paths.state, '{"active_sessions":["conflict.md"],"last_used":"conflict.md","archived_since_last_consolidation":0,"last_archive_at":null}');
    return { memory, adapter, files, calls, path, backups: () => [...files].filter(([p]) => p.startsWith('.pkm-assistant/backups/')) };
}

for (const device of [null, id]) for (const native of [false, true]) test.serial(`D7 read is pure, first append repairs once, second is warm: id=${device}, native=${native}`, async t => {
    const d = disk(raw, device);
    if (!native) delete d.adapter.append;
    const parsed = await d.memory.loadActiveSession(d.path);
    t.deepEqual(parsed.messages.slice(-4).map(m => [m.role, m.content]), [
        ['user', 'A1: wiadomosc z telefonu, odpowiedz slowem telefon'], ['assistant', 'telefon'],
        ['user', 'B1: wiadomosc z laptopa, odpowiedz slowem laptop'], ['assistant', 'laptop'],
    ]);
    t.deepEqual(d.calls, [['read', d.path]]);
    t.is(d.files.get(d.path), raw);
    const warnings: unknown[][] = [];
    const warn = log.warn;
    log.warn = (...args) => { warnings.push(args); };
    t.teardown(() => { log.warn = warn; });
    await d.memory.appendToActiveSession(event);
    t.deepEqual(d.backups().map(([, value]) => value), [raw]);
    t.is(d.files.get(d.path), clean + nextBlock);
    t.is(warnings.length, 1);
    t.true(JSON.stringify(warnings).includes(d.backups()[0][0]));
    t.false(JSON.stringify(warnings).includes('A1:'));
    d.calls.length = 0;
    await d.memory.appendToActiveSession({ ...event, content: 'Druga' });
    t.is(d.files.get(d.path), clean + nextBlock + nextBlock.replace('Następna wiadomość', 'Druga').replace('\n8\n', '\n9\n'));
    t.is(d.backups().length, 1);
    if (native) t.deepEqual(d.calls, device ? [['stat', d.path], ['append', d.path]] : [['append', d.path]]);
});

for (const operation of ['frozen', 'save', 'archive', 'discard', 'epoch', 'takeover'] as const) test.serial(`D7 every writer repairs before ${operation}`, async t => {
    const original = operation === 'epoch' ? raw.replace(`epoch: ${epoch}\n`, '') : raw;
    const d = disk(original);
    if (operation === 'epoch') d.memory.setActiveSessionIdentity(d.path, null);
    let target = d.path;
    if (operation === 'frozen') await d.memory.appendSessionEvent(d.path, event, epoch);
    if (operation === 'save') await d.memory.saveSession((await d.memory.loadActiveSession(d.path)).messages);
    if (operation === 'archive') target = (await d.memory.archiveActiveSession())!;
    if (operation === 'discard') target = (await d.memory.discardActiveSession())!;
    if (operation === 'epoch') await d.memory.ensureActiveSessionEpoch(d.path, () => true);
    if (operation === 'takeover') await d.memory.takeOverActiveSession(d.path);
    t.is(d.backups()[0][1], original);
    const bytes = d.files.get(target)!;
    t.is(/^(?:<<<<<<<|=======|>>>>>>>)/m.test(bytes), false);
    const parsed = operation === 'archive' ? await d.memory.loadSession(target) : await d.memory.loadActiveSession(target);
    t.deepEqual(parsed.messages.filter(m => m.content === 'telefon' || m.content === 'laptop').map(m => [m.role, m.content]), [['assistant', 'telefon'], ['assistant', 'laptop']]);
    t.true(d.calls.findIndex(([op, path]) => op === 'write' && path === d.path) > d.calls.findIndex(([op, path]) => op === 'read' && path.includes('/backups/')));
    if (operation === 'frozen') t.is(bytes, clean + nextBlock);
    if (operation === 'discard') t.is(bytes, clean);
    if (operation === 'epoch') t.is((await d.memory.loadActiveSession(d.path)).metadata.epoch, d.memory.sessionEpoch);
});

for (const fault of ['backup-write', 'backup-read', 'partial-throw', 'partial-silent', 'readback', 'restore-fails'] as const)
test.serial(`D7 failed repair refuses append and preserves original or verified backup: ${fault}`, async t => {
    const d = disk();
    const write = d.adapter.write, read = d.adapter.read;
    let sourceWrites = 0;
    d.adapter.write = async (path, value) => {
        if (path.includes('/backups/') && fault === 'backup-write') throw new Error('private adapter failure');
        if (path === d.path) {
            sourceWrites++;
            if (sourceWrites === 1 && ['partial-throw', 'partial-silent', 'restore-fails'].includes(fault)) {
                await write(path, value.slice(0, 20));
                if (fault !== 'partial-silent') throw new Error('partial');
                return;
            }
            if (sourceWrites === 2 && fault === 'restore-fails') throw new Error('restore failed');
        }
        await write(path, value);
    };
    d.adapter.read = async path => {
        if (path.includes('/backups/') && fault === 'backup-read') return 'wrong backup';
        if (path === d.path && sourceWrites === 1 && fault === 'readback') throw new Error('readback failed');
        return read(path);
    };
    await t.throwsAsync(() => d.memory.appendToActiveSession(event), { instanceOf: SessionConflictError });
    t.is(d.files.get(d.path), fault === 'restore-fails' ? clean.slice(0, 20) : raw);
    t.is(d.calls.filter(([op]) => op === 'append').length, 0);
    t.is(sourceWrites, fault.startsWith('backup') ? 0 : 2);
    if (!fault.startsWith('backup')) t.deepEqual(d.backups().map(([, value]) => value), [raw]);
    // A failed cache must never make a later writer skip the failed repair.
    d.adapter.write = write; d.adapter.read = read;
    if (fault !== 'restore-fails') {
        await d.memory.appendToActiveSession(event);
        t.is(d.files.get(d.path), clean + nextBlock);
    }
});

for (const mode of ['foreign', 'ambiguous', 'unresolved'] as const) test.serial(`D7 ${mode} refuses all writers without repairing source`, async t => {
    const original = mode === 'foreign' ? raw.replace('type: active_session', 'type: active_session\ndevice: bbbbbbbbbbbbbbbb')
        : mode === 'ambiguous' ? raw.replace('type: active_session', 'type: active_session\ndevice: aaaaaaaaaaaaaaaa\ndevice: bbbbbbbbbbbbbbbb')
        : raw.replace('<<<<<<< HEAD', '<<<<<<< HEAD\n<<<<<<< nested');
    const d = disk(original);
    for (const act of [
        () => d.memory.appendToActiveSession(event), () => d.memory.appendSessionEvent(d.path, event, epoch),
        () => d.memory.saveSession([{ role: 'user', content: 'Szkic' }]), () => d.memory.archiveActiveSession(),
        () => d.memory.discardActiveSession(), () => d.memory.ensureActiveSessionEpoch(d.path, () => true),
        () => d.memory.takeOverActiveSession(d.path),
    ]) {
        await t.throwsAsync(act, { instanceOf: mode === 'unresolved' ? SessionConflictError : ForeignSessionError });
        t.is(d.files.get(d.path), original);
        t.deepEqual(d.backups(), []);
    }
    if (mode !== 'foreign') t.is((await d.memory.loadActiveSession(d.path)).conflict, 'unresolved');
});

for (const change of ['healthy', 'conflict', 'foreign', 'twice', 'read-error'] as const) test.serial(`D7 pull during backup: ${change}, at most one fresh retry`, async t => {
    const d = disk();
    const write = d.adapter.write, read = d.adapter.read;
    let copies = 0;
    const newer = change === 'foreign' ? raw.replace('type: active_session', 'type: active_session\ndevice: bbbbbbbbbbbbbbbb')
        : change === 'healthy' ? clean + nextBlock : raw.replaceAll('A1:', 'A2:');
    d.adapter.write = async (path, value) => {
        await write(path, value);
        if (path.includes('/backups/')) {
            copies++;
            if (copies === 1) d.files.set(d.path, newer);
            else if (change === 'twice') d.files.set(d.path, raw.replaceAll('A1:', 'A3:'));
        }
    };
    d.adapter.read = async path => {
        if (path === d.path && copies && change === 'read-error') throw new Error('source read failed');
        return read(path);
    };
    if (['foreign', 'twice', 'read-error'].includes(change)) {
        await t.throwsAsync(() => d.memory.appendToActiveSession(event), { instanceOf: change === 'foreign' ? ForeignSessionError : SessionConflictError });
        t.is(d.files.get(d.path), change === 'twice' ? raw.replaceAll('A1:', 'A3:') : newer);
        t.is(d.calls.filter(([op]) => op === 'append').length, 0);
    } else {
        await d.memory.appendToActiveSession(event);
        t.is(d.files.get(d.path), change === 'healthy' ? clean + nextBlock + nextBlock.replace('\n8\n', '\n9\n') : clean.replaceAll('A1:', 'A2:') + nextBlock);
    }
    t.is(copies, change === 'conflict' || change === 'twice' ? 2 : 1);
    t.is(d.backups()[0][1], raw);
});

test.serial('D7 warm stat detects synced conflict; fallback append also refreshes seq on its existing read', async t => {
    for (const native of [true, false]) {
        const d = disk(sideA, native ? id : null);
        await d.memory.appendToActiveSession(event);
        if (!native) delete d.adapter.append;
        d.files.set(d.path, raw);
        await d.memory.appendToActiveSession(event);
        t.is(d.files.get(d.path), clean + nextBlock);
        t.deepEqual(d.backups().map(([, value]) => value), [raw]);
    }
});

test.serial('D7 metadata-only conflicts are writable by the same device and visible in list without repair', async t => {
    const input = raw.replace('type: active_session', 'device: aaaaaaaaaaaaaaaa\ntype: active_session\n<<<<<<< HEAD\nupdated: old\n=======\nupdated: newer\n>>>>>>> theirs');
    const d = disk(input);
    const listed = await d.memory.listActiveSessions();
    t.deepEqual(listed.map(s => [s.ownership, s.created, s.conflict]), [['mine', '2026-11-14T14:25:05.864Z', undefined]]);
    t.is(d.files.get(d.path), input);
    t.is(d.calls.filter(([op]) => op === 'write').length, 0);
    await d.memory.appendToActiveSession(event);
    t.is(d.files.get(d.path), clean.replace('type: active_session', 'device: aaaaaaaaaaaaaaaa\ntype: active_session\nupdated: old') + nextBlock);
});

test.serial('D7 healthy embedded example keeps old read/write bytes with and without identity', async t => {
    const example = '<<<<<<< HEAD\nA\n=======\nB\n>>>>>>> other';
    const original = '---\nagent: Jaskier\n---\n' + formatSessionEvent('user_message', { content: example, seq: 1 }, timestamp);
    for (const device of [id, null]) {
        const d = disk(original, device);
        t.deepEqual((await d.memory.loadActiveSession(d.path)).messages, [{ role: 'user', content: example, seq: 1 }]);
        t.deepEqual(d.calls, [['read', d.path]]);
        await d.memory.appendToActiveSession(event);
        t.is(d.files.get(d.path), original + nextBlock.replace('\n8\n', '\n2\n'));
        t.deepEqual(d.backups(), []);
    }
});

test.serial('D7 concurrent writers share one repair and assign subsequent seq from max', async t => {
    const d = disk();
    const other = d.memory.createSessionWriter(d.path, epoch);
    await Promise.all([d.memory.appendSessionEvent(d.path, event, epoch), other.appendSessionEvent(d.path, { ...event, content: 'Druga' }, epoch)]);
    t.is(d.files.get(d.path), clean + nextBlock + nextBlock.replace('Następna wiadomość', 'Druga').replace('\n8\n', '\n9\n'));
    t.deepEqual(d.backups().map(([, value]) => value), [raw]);
    t.deepEqual(parseActiveSession(d.files.get(d.path)!).messages.slice(-2).map(m => [m.content, m.seq]), [['Następna wiadomość', 8], ['Druga', 9]]);
});

test.serial('D7 313df88 regression: subsequent save and round-trip cannot reintroduce markers', async t => {
    const d = disk();
    const messages = (await d.memory.loadActiveSession(d.path)).messages;
    await d.memory.saveSession([...messages, { role: 'user', content: 'Nowa tura' }]);
    const fresh = new AgentMemory({ adapter: { ...d.adapter } }, 'Jaskier', {}, id);
    t.deepEqual((await fresh.loadActiveSession(d.path)).messages.filter(m => m.role === 'user').map(m => m.content), [
        'B0: poczatek wspolnej sesji, odpowiedz slowem baza', 'A1: wiadomosc z telefonu, odpowiedz slowem telefon',
        'B1: wiadomosc z laptopa, odpowiedz slowem laptop', 'Nowa tura',
    ]);
    t.is(/^(?:<<<<<<<|=======|>>>>>>>)/m.test(d.files.get(d.path)!), false);
    t.deepEqual(d.backups().map(([, value]) => value), [raw]);
    t.deepEqual(mergeSessionConflict(d.files.get(d.path)!), { kind: 'not-applicable' });
});

for (const read of ['load', 'list', 'failed-frozen-write'] as const) test.serial(`D7 ${read} invalidates a previously warm writer without device id`, async t => {
    const d = disk(sideA, null);
    await d.memory.appendToActiveSession(event);
    const conflict = read === 'failed-frozen-write' ? raw.replace('<<<<<<< HEAD', '<<<<<<< HEAD\n<<<<<<< nested') : raw;
    d.files.set(d.path, conflict);
    if (read === 'load') await d.memory.loadActiveSession(d.path);
    if (read === 'list') await d.memory.listActiveSessions();
    if (read === 'failed-frozen-write') await t.throwsAsync(() => d.memory.appendSessionEvent(d.path, event), { instanceOf: SessionConflictError });
    if (read === 'failed-frozen-write') {
        await t.throwsAsync(() => d.memory.appendToActiveSession(event), { instanceOf: SessionConflictError });
        t.is(d.files.get(d.path), conflict);
    } else {
        await d.memory.appendToActiveSession(event);
        t.is(d.files.get(d.path), clean + nextBlock);
        t.deepEqual(d.backups().map(([, bytes]) => bytes), [raw]);
    }
});

test.serial('D7 epoch readback cannot warm a cache with a concurrent synchronization conflict', async t => {
    const initial = sideA.replace(`epoch: ${epoch}\n`, '');
    const d = disk(initial, null);
    d.memory.setActiveSessionIdentity(d.path, null);
    const append = d.adapter.append!;
    let synced = '';
    d.adapter.append = async (path, chunk, options) => {
        await append(path, chunk, options);
        synced = d.files.get(path)! + '<<<<<<< HEAD\n## 2026-11-15T13:00:00.000Z — user message\n\n**content:**\n\nRemote A\n\n=======\n## 2026-11-15T13:00:01.000Z — user message\n\n**content:**\n\nRemote B\n\n>>>>>>> sync\n';
        d.files.set(path, synced);
    };
    await t.throwsAsync(() => d.memory.ensureActiveSessionEpoch(d.path, () => true), { instanceOf: SessionConflictError });
    t.is(d.memory.sessionEpoch, null);
    d.adapter.append = append;
    await d.memory.appendToActiveSession(event);
    t.deepEqual(d.backups().map(([, bytes]) => bytes), [synced]);
    t.deepEqual((await d.memory.loadActiveSession(d.path)).messages.slice(-3).map(m => m.content), ['Remote A', 'Remote B', 'Następna wiadomość']);
    t.is(/^(?:<<<<<<<|=======|>>>>>>>)/m.test(d.files.get(d.path)!), false);
});
