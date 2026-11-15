import test from 'ava';
import { mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { AgentMemory } from './AgentMemory.js';
import { ForeignSessionError, parseDeviceId, sessionOwnership } from './sessionOwnership.js';
import type { DeviceId } from './sessionOwnership.js';
import { parseFrontmatter } from './activeSessionFormat.js';

const A = parseDeviceId('aaaaaaaaaaaaaaaa')!;
const B = parseDeviceId('bbbbbbbbbbbbbbbb')!;
const epoch = '0123456789abcdef0123456789abcdef';
function disk(files = new Map<string, string>(), folders = new Set<string>()) {
    const mtimes = new Map<string, number>();
    const counts = { read: 0, write: 0, exists: 0, mkdir: 0, list: 0, append: 0, stat: 0, remove: 0 };
    const adapter = {
        async read(path: string) { counts.read++; if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(path)!; },
        async write(path: string, value: string) { counts.write++; files.set(path, value); mtimes.set(path, Date.now()); },
        async exists(path: string) { counts.exists++; return files.has(path) || folders.has(path); },
        async mkdir(path: string) { counts.mkdir++; folders.add(path); },
        async list(path: string) { counts.list++; return { files: [...files.keys()].filter(p => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/')), folders: [] }; },
        async append(path: string, value: string, options?: { mtime?: number }) { counts.append++; files.set(path, (files.get(path) ?? '') + value); mtimes.set(path, options?.mtime ?? Date.now()); },
        async stat(path: string) { counts.stat++; return { mtime: mtimes.get(path) ?? 1, size: new TextEncoder().encode(files.get(path) ?? '').length }; },
        async remove(path: string) { counts.remove++; files.delete(path); },
    };
    return { files, folders, counts, adapter, reset() { for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] = 0; },
        memory(id: DeviceId | null) { const memory = new AgentMemory({ adapter }, 'Mira', {}, id); memory._newSessionEpoch = () => epoch; return memory; } };
}

test('device boundary and ownership: valid, missing and malformed markers, including null fallback', t => {
    t.is<string | null, string>(parseDeviceId('0123456789abcdef'), '0123456789abcdef');
    for (const value of ['ABCDEF0123456789', '1234', 'aaaaaaaaaaaaaaaa\n', 42, null, undefined, {}, []]) t.is(parseDeviceId(value), null);
    for (const [field, expected] of [[A, 'mine'], [B, 'foreign'], [undefined, 'unowned'], ['', 'foreign'], [null, 'foreign'], [[], 'foreign'], [{ device: A }, 'foreign'], [42, 'foreign']] as const) {
        t.is(sessionOwnership(field, A), expected);
        t.is(sessionOwnership(field, null), 'unowned');
    }
});

for (const id of [null, A]) test.serial(`D2 golden from 558d888: start, three turns, metadata; device=${id}`, async t => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-14T10:00:00.000Z') });
    t.teardown(() => mock.timers.reset());
    const baseline = JSON.parse(readFileSync(new URL('./fixtures/device-session-baseline.json', import.meta.url), 'utf8')) as {
        path: string; content: string; state: string; pointer: string; stages: Array<Record<string, number>>;
    };
    const d = disk(), memory = d.memory(id);
    await memory.initialize(); d.reset();
    const path = await memory.startActiveSession();
    const stages = [{ ...d.counts }];
    const messages: Array<{ role: string; content: string }> = [];
    for (let i = 1; i <= 3; i++) {
        await memory.appendToActiveSession({ type: 'user_message', content: `Pytanie ${i}` });
        await memory.appendToActiveSession({ type: 'agent_message', content: `Odpowiedź ${i}` });
        messages.push({ role: 'user', content: `Pytanie ${i}` }, { role: 'assistant', content: `Odpowiedź ${i}` });
        stages.push({ ...d.counts });
    }
    await memory.saveSession(messages); stages.push({ ...d.counts });
    // D2b adds exactly one stat per append with identity; the null fixture is untouched.
    t.deepEqual(stages, id ? baseline.stages.map((stage, i) => ({ ...stage, stat: [0, 2, 4, 6, 6][i] })) : baseline.stages);
    t.is(path, baseline.path);
    t.is(d.files.get(path), id ? baseline.content.replace(`epoch: ${epoch}\n`, `epoch: ${epoch}\ndevice: aaaaaaaaaaaaaaaa\n`) : baseline.content);
    t.is(d.files.get(memory.paths.state), baseline.state);
    t.is(d.files.get(memory.paths.activeSessionMeta), baseline.pointer);
});

test.serial('two devices: foreign writers refuse every mutation, explicit takeover preserves events and reverses ownership', async t => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-15T10:00:00.000Z') });
    t.teardown(() => mock.timers.reset());
    const d = disk(), a = d.memory(A), b = new AgentMemory({ adapter: { ...d.adapter } }, 'Mira', {}, B);
    await a.initialize(); await b.initialize();
    const path = await a.startActiveSession();
    await a.appendToActiveSession({ type: 'user_message', content: 'Moja rozmowa' });
    t.true(d.files.get(path)!.includes('\nepoch: 0123456789abcdef0123456789abcdef\ndevice: aaaaaaaaaaaaaaaa\n'));
    t.deepEqual((await b.listActiveSessions()).map(s => [s.path, s.ownership]), [[path, 'foreign']]);
    t.is(await b.restoreActiveSession(), null);
    b.setActiveSessionIdentity(path, epoch);
    const before = [...d.files]; d.reset();
    for (const mutate of [
        () => b.appendToActiveSession({ type: 'user_message', content: 'Obca tura' }),
        () => b.appendSessionEvent(path, { type: 'tool_call', content: 'Obce narzędzie' }, epoch),
        () => b.createSessionWriter(path, epoch).appendToActiveSession({ type: 'agent_message', content: 'Obcy sub' }),
        () => b.saveSession([{ role: 'user', content: 'Obcy zapis' }]),
        () => b.archiveActiveSession(path), () => b.discardActiveSession(path),
        () => b.ensureActiveSessionEpoch(path, () => true),
    ]) {
        await t.throwsAsync(mutate, { instanceOf: ForeignSessionError });
        t.deepEqual([...d.files], before);
        t.deepEqual([d.counts.write, d.counts.append, d.counts.remove, d.counts.mkdir], [0, 0, 0, 0]);
    }
    await b.takeOverActiveSession(path);
    t.is(d.files.get(path), before.find(([p]) => p === path)![1].replace('device: aaaaaaaaaaaaaaaa\n', 'device: bbbbbbbbbbbbbbbb\ntaken_over: 2026-11-15T10:00:00.000Z\n'));
    t.is(d.counts.write, 2);
    await b.appendToActiveSession({ type: 'agent_message', content: 'Kontynuacja na B' });
    await t.throwsAsync(() => a.appendSessionEvent(path, { type: 'user_message', content: 'Spóźniona tura' }, epoch), { instanceOf: ForeignSessionError });
    t.deepEqual((await b.loadActiveSession(path)).messages.map(m => m.content), ['Moja rozmowa', 'Kontynuacja na B']);
    t.deepEqual((await a.listActiveSessions()).map(s => s.ownership), ['foreign']);
});

test.serial('D2d scenario 74: shared legacy wins over local pointer, append and epoch preserve bytes until metadata save', async t => {
    const d = disk(), a = d.memory(A), b = new AgentMemory({ adapter: { ...d.adapter } }, 'Mira', {}, B);
    await a.initialize(); await b.initialize();
    const path = `${a.paths.sessionsActive}/legacy.md`;
    const local = `${a.paths.sessionsActive}/local.md`;
    const original = '---\ntype: active_session\nagent: Mira\n---\n\nHistoria legacy\n';
    d.files.set(path, original);
    d.files.set(local, '---\nagent: Mira\ndevice: aaaaaaaaaaaaaaaa\n---\n\n## User\n\nLokalna rozmowa\n');
    await a.stateManager.addActiveSession('local.md');
    await a.stateManager.addActiveSession('legacy.md');
    d.files.set(a.paths.activeSessionMeta, JSON.stringify({ path: local }));
    t.is(await a.restoreActiveSession(), path);
    t.is(a.sessionEpoch, null);
    t.is(d.files.get(path), original);
    d.reset();
    await a.appendToActiveSession({ type: 'user_message', content: 'Nowa wiadomość', timestamp: '2026-11-15T10:00:00.000Z' });
    t.is(d.files.get(path), original + '## 2026-11-15T10:00:00.000Z — user message\n\n**content:**\n\nNowa wiadomość\n\n**seq:**\n\n1\n\n');
    t.deepEqual([d.counts.write, d.counts.append, d.counts.mkdir], [0, 1, 0]);
    t.is(await a.ensureActiveSessionEpoch(path, () => true), epoch);
    const bytes = d.files.get(path)!;
    t.true(bytes.startsWith(original));
    t.is(parseFrontmatter(bytes).epoch, null);
    t.false(Object.hasOwn(parseFrontmatter(bytes), 'device'));
    t.is((bytes.match(/— session epoch/g) ?? []).length, 1);
    t.deepEqual([d.counts.write, d.counts.append, d.counts.mkdir], [0, 2, 0]);
    t.deepEqual((await d.adapter.list(a.paths.sessionsActive)).files.sort(), [path, local].sort());
    t.is((await b.loadActiveSession(path)).metadata.epoch, epoch);
    t.is((await b.loadActiveSession(path)).ownership, 'unowned');
    // Metadata-only save: the complete message is already on disk, so no tail is needed.
    const messages = (await a.loadActiveSession(path)).messages;
    d.reset(); await a.saveSession(messages);
    t.deepEqual(d.counts, { read: 1, write: 1, exists: 0, mkdir: 0, list: 0, append: 0, stat: 0, remove: 0 });
    t.is(parseFrontmatter(d.files.get(path)!).device, 'aaaaaaaaaaaaaaaa');
    t.is((await b.loadActiveSession(path)).ownership, 'foreign');
    t.deepEqual((await a.loadActiveSession(path)).messages.map(m => m.content), ['Nowa wiadomość']);
});

for (const id of [A, null]) test.serial(`D2d restore precedence: last_used, active_sessions, local pointer; id=${id}`, async t => {
    const d = disk(), memory = d.memory(id); await memory.initialize();
    const root = memory.paths.sessionsActive;
    d.files.set(`${root}/mine.md`, '---\ndevice: aaaaaaaaaaaaaaaa\n---\n## User\nMine');
    d.files.set(`${root}/foreign.md`, '---\ndevice: bbbbbbbbbbbbbbbb\n---\n## User\nForeign');
    d.files.set(`${root}/ambiguous.md`, '---\ndevice: aaaaaaaaaaaaaaaa\ndevice: bbbbbbbbbbbbbbbb\n---\n## User\nAmbiguous');
    d.files.set(`${root}/legacy.md`, '---\nagent: Mira\n---\n## User\nLegacy');
    for (const [state, expected] of [
        ['{"active_sessions":["mine.md"],"last_used":"legacy.md"}', 'legacy'],
        ['{"active_sessions":["foreign.md","ambiguous.md","mine.md"],"last_used":"foreign.md"}', id ? 'mine' : 'foreign'],
        ['{"active_sessions":["ambiguous.md","mine.md"],"last_used":"missing.md"}', id ? 'mine' : 'ambiguous'],
        ['{"active_sessions":["missing.md"],"last_used":"missing.md"}', 'legacy'],
    ]) {
        d.files.set(memory.paths.state, state);
        d.files.set(memory.paths.activeSessionMeta, JSON.stringify({ path: `${root}/legacy.md` }));
        t.is(await memory.restoreActiveSession(), `${root}/${expected}.md`);
        t.is(d.files.get(memory.paths.state), state);
    }
    if (!id) t.true((await memory.listActiveSessions()).every(s => !('ownership' in s)));
});

for (const mode of ['save', 'repair'] as const) test.serial(`new device header via ${mode}, old parser/editor compatibility and shared archive`, async t => {
    const d = disk(), memory = d.memory(A); await memory.initialize();
    const path = mode === 'save' ? await memory.saveSession([{ role: 'user', content: 'Treść' }]) : await memory.startActiveSession();
    if (mode === 'repair') {
        await memory.appendToActiveSession({ type: 'tool_call', tool: 'read', content: 'Warm writer before deletion' });
        d.files.delete(path);
        d.reset();
        await memory.appendToActiveSession({ type: 'user_message', content: 'Treść' });
        t.is(d.counts.stat, 1);
    }
    const active = memory.activeSessionPath!;
    t.is(parseFrontmatter(d.files.get(active)!).device, 'aaaaaaaaaaaaaaaa');
    const old = d.memory(null);
    const edited = old._setFrontmatterField(d.files.get(active)!, 'updated', '2026-11-14');
    t.is(parseFrontmatter(edited).device, 'aaaaaaaaaaaaaaaa');
    t.deepEqual((await old.listActiveSessions()).map(s => s.path), [active]);
    const archived = await old.archiveActiveSession(active);
    t.truthy(archived); t.false(d.files.get(archived!)!.includes('\ndevice:'));
    t.deepEqual((await old.loadSession(archived!)).messages.map(m => m.content), ['Treść']);
});

test.serial('takeover keeps opaque CRLF event bytes and history-only archive drops only ownership', async t => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-15T10:00:00.000Z') });
    t.teardown(() => mock.timers.reset());
    const d = disk(), memory = d.memory(B); await memory.initialize();
    const path = `${memory.paths.sessionsActive}/opaque.md`;
    const body = '\r\n## unknown event\r\n\r\nprivate: sk-abcdefghijklmnopqrstuvwxyz0123456789\r\n<<<<<<< HEAD\r\nopaque\r\n=======\r\nother\r\n>>>>>>> cloud\r\n';
    d.files.set(path, '\uFEFF---\r\nagent: Mira\r\ndevice: aaaaaaaaaaaaaaaa\r\n---\r\n' + body);
    await memory.takeOverActiveSession(path);
    t.is(d.files.get(path), '\uFEFF---\r\nagent: Mira\r\ndevice: bbbbbbbbbbbbbbbb\r\ntaken_over: 2026-11-15T10:00:00.000Z\r\n---\r\n' + body);
    // Archive's established masking policy remains in effect; use an ordinary opaque body here.
    d.files.set(path, '---\ndevice: bbbbbbbbbbbbbbbb\n  custom: zachowaj\n---\n\r\nOpaque history\r\n');
    const archive = await memory.archiveActiveSession(path);
    t.is(d.files.get(archive!), '---\n  custom: zachowaj\n---\n\r\nOpaque history\r\n');
});

test.serial('takeover rejects unavailable identity, missing/outside targets and ambiguous headers without writes', async t => {
    const d = disk(), memory = d.memory(A); await memory.initialize();
    const path = `${memory.paths.sessionsActive}/bad.md`;
    for (const content of ['no header', '---\ndevice:\n  - aaaaaaaaaaaaaaaa\n---\n', '---\ndevice: aaaaaaaaaaaaaaaa\ndevice: bbbbbbbbbbbbbbbb\n---\n', '---\n<<<<<<< HEAD\ndevice: aaaaaaaaaaaaaaaa\n=======\ndevice: bbbbbbbbbbbbbbbb\n>>>>>>> B\n---\n']) {
        d.files.set(path, content); d.reset();
        await t.throwsAsync(() => memory.takeOverActiveSession(path));
        t.is(d.files.get(path), content); t.is(d.counts.write, 0);
    }
    await t.throwsAsync(() => d.memory(null).takeOverActiveSession(path), { message: 'Device identity unavailable' });
    await t.throwsAsync(() => memory.takeOverActiveSession(`${memory.paths.sessionsArchive}/bad.md`));
    await t.throwsAsync(() => memory.takeOverActiveSession(`${memory.paths.sessionsActive}/missing.md`));
    t.is(d.counts.write, 0);
});

test.serial('cold device writer cannot trust a cache warmed by a legacy instance; independent device sees synced takeover on next save', async t => {
    const d = disk(), old = d.memory(null); await old.initialize();
    const path = await old.startActiveSession();
    d.files.set(path, d.files.get(path)!.replace('---\n', '---\ndevice: aaaaaaaaaaaaaaaa\n'));
    await old.appendToActiveSession({ type: 'user_message', content: 'Legacy writer' });
    const b = d.memory(B); b.setActiveSessionIdentity(path, epoch);
    await t.throwsAsync(() => b.appendToActiveSession({ type: 'user_message', content: 'Not mine' }), { instanceOf: ForeignSessionError });
    const external = disk(d.files, d.folders).memory(B);
    await external.takeOverActiveSession(path);
    const a = d.memory(A); a.setActiveSessionIdentity(path, epoch);
    await t.throwsAsync(() => a.saveSession([{ role: 'user', content: 'Late send' }]), { instanceOf: ForeignSessionError });
    t.deepEqual((await external.loadActiveSession(path)).messages.map(m => m.content), ['Legacy writer']);
});

for (const type of ['tool_call', 'mcp_call', 'subagent_call', 'subagent_error'])
test.serial(`D2d events stay unowned until metadata save: ${type}`, async t => {
    const d = disk(), old = d.memory(null); await old.initialize();
    const path = await old.startActiveSession();
    const memory = d.memory(A); memory.setActiveSessionIdentity(path, epoch);
    await memory.appendToActiveSession({ type, content: 'Wynik operacji' });
    t.is((await memory.loadActiveSession(path)).ownership, 'unowned');
    const parsed = await memory.loadActiveSession(path);
    t.is(parsed.messages.length, type === 'tool_call' ? 0 : 1);
    d.reset(); await memory.saveSession(parsed.messages);
    const metadata = parseFrontmatter(d.files.get(path)!);
    t.is(metadata.device, 'aaaaaaaaaaaaaaaa');
    t.is(d.counts.write, 1); t.is(d.counts.read, 1); t.is(d.counts.append, 0);
});

test.serial('takeover resets old autosave coverage so the next new message is not silently skipped', async t => {
    const d = disk(), memory = d.memory(B); await memory.initialize();
    const path = await memory.saveSession([
        { role: 'user', content: 'Stare 1' }, { role: 'assistant', content: 'Stare 2' }, { role: 'user', content: 'Stare 3' },
    ]);
    // A synced remote revision can have fewer messages than the old local coverage count.
    d.files.set(path, '---\nagent: Mira\ndevice: aaaaaaaaaaaaaaaa\n---\n\n## User\n\nZ laptopa\n');
    await memory.takeOverActiveSession(path);
    await memory.saveSession([{ role: 'user', content: 'Z laptopa' }, { role: 'assistant', content: 'Nowy dopisek' }]);
    t.deepEqual((await memory.loadActiveSession(path)).messages.map(m => m.content), ['Z laptopa', 'Nowy dopisek']);
});
