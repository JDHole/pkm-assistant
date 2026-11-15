import test from 'ava';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { AgentMemory, type MemoryVaultAdapterLike } from './AgentMemory.js';
import { formatSessionEvent, parseActiveSession } from './activeSessionFormat.js';
import { mergeSessionConflict } from './sessionConflict.js';
import { sessionMessageId } from './sessionMessageIdentity.js';
import { SessionRemovalConflictError, sessionRemovalContext } from './sessionRemovals.js';

const header = '---\nagent: Tester\ntype: active_session\n---\n\n';
const example = 'Example:\n<<<<<<< literal\nkeep A\n=======\nkeep B\n>>>>>>> literal\nEnd';
const time = (second: number) => `2026-11-15T12:00:${String(second).padStart(2, '0')}.000Z`;
const event = (id: string, second: number, legacy = false, content = id) =>
    formatSessionEvent('user_message', { ...(!legacy ? { message_id: id } : {}), content, seq: second + 1 }, time(second));
const wrap = (a: string, b: string) => `<<<<<<< local\n${a}=======\n${b}>>>>>>> remote\n`;

function disk(initial: string) {
    const files = new Map<string, string>();
    const calls: string[] = [];
    const adapter: MemoryVaultAdapterLike = {
        async read(path) { calls.push(`read ${path}`); if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(path)!; },
        async write(path, text) { calls.push(`write ${path}`); files.set(path, text); },
        async exists(path) { return files.has(path); },
        async mkdir() {},
        async list() { return { files: [], folders: [] }; },
    };
    const memory = new AgentMemory({ adapter }, 'Tester');
    memory._structureEnsured = true;
    const path = memory.paths.sessionsActive + '/review.md';
    memory.setActiveSessionIdentity(path, null);
    files.set(path, initial);
    return { files, calls, adapter, memory, path };
}

for (const field of ['content', 'result', 'args', 'prompt', 'parent_conversation_text', 'question', 'tool_calls', 'sub_task_history']) for (const crlf of [false, true]) {
    test(`D7b common literal markers in ${field} survive byte for byte, CRLF=${crlf}`, async t => {
        const common = formatSessionEvent('user_message', { message_id: 'BASE', [field]: example, seq: 1 }, time(0));
        const a = event('A1', 1), b = event('B1', 2);
        const bytes = (text: string) => crlf ? text.replace(/\n/g, '\r\n') : text;
        const raw = bytes(header + common + wrap(a, b));
        t.deepEqual(mergeSessionConflict(raw), { kind: 'merged', text: bytes(header + common + a + b) });
        const d = disk(raw);
        await d.memory.appendToActiveSession({ type: 'user_message', content: 'NEXT', timestamp: time(3) });
        t.true(d.files.get(d.path)!.startsWith(bytes(header + common + a + b)));
        t.deepEqual([...d.files].filter(([p]) => p.includes('/backups/')).map(([, value]) => value), [raw]);
        if (field === 'content') t.deepEqual((await d.memory.loadActiveSession(d.path)).messages.map(m => m.content), [example, 'A1', 'B1', 'NEXT']);
    });
}

for (const field of ['message_id', 'seq', 'tokens', 'duration_ms', 'tool_call_id']) {
    test(`D7b marker hunk in ${field} before event divergence refuses`, t => {
        const common = `## ${time(0)} — user message\n\n**${field}:**\n\n${wrap('1\n', '2\n')}\n`;
        t.deepEqual(mergeSessionConflict(header + common + wrap(event('A1', 1), event('B1', 2))), { kind: 'unresolved' });
    });
}

test('D7b nested example and common example after a real hunk refuse without rewriting', t => {
    const common = event('BASE', 0, false, example);
    t.deepEqual(mergeSessionConflict(header + wrap(common + event('A1', 1), event('B1', 2))), { kind: 'unresolved' });
    t.deepEqual(mergeSessionConflict(header + wrap(event('A1', 1), event('B1', 2)) + common), { kind: 'unresolved' });
});

test('D7c common legacy examples with different labels survive before divergence', t => {
    const a = event('A1', 1), b = event('B1', 2);
    for (const common of ['## User\n\n' + example + '\n\n',
        `## ${time(0)} — user message\n\n**content:**\n\n**message_id:**\n\n${example}\n\n`]) {
        t.deepEqual(mergeSessionConflict(header + common), { kind: 'not-applicable' });
        t.deepEqual(mergeSessionConflict(header + common + wrap(a, b)), { kind: 'merged', text: header + common + a + b });
    }
    const common = event('EXAMPLE', 3, false, example);
    const c = event('C1', 4), d = event('D1', 5);
    t.deepEqual(mergeSessionConflict(header + a + b + common + wrap(c, d)), { kind: 'merged', text: header + a + b + common + c + d });
    const incomplete = event('TEXT', 0, false, 'Example:\n<<<<<<< literal\nunfinished');
    t.deepEqual(mergeSessionConflict(header + incomplete), { kind: 'not-applicable' });
    const isolated = event('TEXT', 0, true, wrap('keep A\n', 'keep B\n').trimEnd());
    t.deepEqual(mergeSessionConflict(header + isolated), { kind: 'not-applicable' });
});

test('D7b removal without explicit IDs refuses after repair, retaining every message', async t => {
    const base = header + event('BASE', 0), a = event('A1', 1), b = event('B1', 2);
    const d = disk(base + wrap(a, b));
    await t.throwsAsync(d.memory.saveSession([], {}, { removedRanges: [{ from: 'A1', to: 'B1' }] }), { instanceOf: SessionRemovalConflictError });
    t.deepEqual((await d.memory.loadActiveSession(d.path)).messages.map(m => m.content), ['BASE', 'A1', 'B1']);
    t.is(d.files.get(d.path), base + a + b);
});

for (const crlf of [false, true]) for (const numbering of ['original', 'writer']) for (const style of ['merge', 'diff3', 'zdiff3']) for (const [left, right] of [[0, 1], [1, 3], [3, 3]])
for (const tools of [false, true]) for (const tied of [false, true]) for (const legacy of [false, true]) {
    test(`D7b git merge-file ${style} ${left}/${right}, tools=${tools}, tied=${tied}, legacy=${legacy}, numbering=${numbering}, CRLF=${crlf}`, t => {
        const dir = mkdtempSync(join(process.cwd(), '.d7b-git-'));
        t.teardown(() => rmSync(dir, { recursive: true, force: true }));
        const bytes = (s: string) => crlf ? s.replace(/\n/g, '\r\n') : s;
        const base = bytes(header + event('BASE', 0, false, example));
        const branch = (side: string, count: number, offset: number) => Array.from({ length: count }, (_, n) => {
            const second = 1 + n * 6 + (tied ? 0 : offset);
            const seq = 2 + n * (tools ? 3 : 2);
            const user = numbering === 'original' ? event(side + n, second, legacy)
                : formatSessionEvent('user_message', { ...(!legacy ? { message_id: side + n } : {}), content: side + n, seq }, time(second));
            return user + (tools
                ? formatSessionEvent('tool_result', { ...(!legacy ? { message_id: side + n + 'tool' } : {}), tool: 'read_note', result: side + n + ' result', tool_call_id: side + n, seq: numbering === 'original' ? n + 2 : seq + 1 }, time(second + 1))
                : '') + formatSessionEvent('agent_message', { ...(!legacy ? { message_id: side + n + 'answer' } : {}), content: side + n + ' answer', seq: numbering === 'original' ? n + 3 : seq + (tools ? 2 : 1) }, time(second + 2));
        }).join('');
        const a = bytes(branch('A', left, 0)), b = bytes(branch('B', right, 3));
        for (const [name, bytes] of [['base', base], ['ours', base + a], ['theirs', base + b]]) writeFileSync(join(dir, name), bytes);
        const result = spawnSync('git', ['merge-file', '-p', ...(style === 'merge' ? [] : [`--${style}`]), join(dir, 'ours'), join(dir, 'base'), join(dir, 'theirs')], { encoding: 'utf8' });
        t.true(result.status !== null && result.status >= 0 && result.status < 128, result.stderr);
        const merged = mergeSessionConflict(result.stdout);
        // Original matrix contains repeated/decreasing seq in multi-turn branches.
        // Keep those exact inputs as refusal regressions, and also run writer numbering.
        const contentOnly = style === 'merge' && left === 3 && tied;
        const refused = left > 0 && !contentOnly && (numbering === 'original' || style !== 'diff3' && tied);
        t.is(merged.kind, refused ? 'unresolved' : left && !contentOnly ? 'merged' : 'not-applicable');
        if (refused || contentOnly) {
            t.deepEqual(merged, { kind: refused ? 'unresolved' : 'not-applicable' });
            return;
        }
        const output = merged.kind === 'merged' ? merged.text : result.stdout;
        const expectedBlocks = (a + b).split(/(?=^## )/m).filter(Boolean).sort((x, y) => x.slice(3, 27).localeCompare(y.slice(3, 27)));
        t.is(output, base + expectedBlocks.join(''));
        t.is(parseActiveSession(output).messages[0].content, example);
    });
}

for (const legacy of [false, true]) for (const repairedFirst of [false, true]) {
    test(`D7b pending removal across independent adapters, legacy=${legacy}, earlier repair=${repairedFirst}`, async t => {
        const base = header + event('BASE', 0, legacy), a1 = event('A1', 1, legacy), a2 = event('A2', 4, legacy);
        const b = event('B1', 2, legacy) + event('B2', 3, legacy);
        const d = disk(base + a1 + a2);
        const old = await d.memory.loadActiveSession(d.path);
        const raw = base + wrap(a1 + a2, b);
        d.files.set(d.path, raw);
        // Distinct adapter object means distinct queue/cache, as on another device.
        const other = new AgentMemory({ adapter: { ...d.adapter } }, 'Tester');
        other._structureEnsured = true;
        other.setActiveSessionIdentity(d.path, null);
        if (repairedFirst) await other.appendToActiveSession({ type: 'user_message', content: 'NEXT', timestamp: time(5) });
        const ids = old.messages.slice(1).map(sessionMessageId);
        const saving = d.memory.saveSession(old.messages.slice(0, 1), {}, {
            removedMessageIds: ids, removedRanges: [{ from: ids[0], to: ids[1] }], removalContext: sessionRemovalContext(old),
        });
        if (legacy) await t.throwsAsync(saving, { instanceOf: SessionRemovalConflictError });
        else await saving;
        const visible = (await other.loadActiveSession(d.path)).messages.map(m => m.content);
        t.deepEqual(visible, [...(legacy ? ['BASE', 'A1', 'B1', 'B2', 'A2'] : ['BASE', 'B1', 'B2']), ...(repairedFirst ? ['NEXT'] : [])]);
        t.deepEqual([...d.files].filter(([p]) => p.includes('/backups/')).map(([, value]) => value), [raw]);
        if (!legacy) t.true(d.files.get(d.path)!.includes('**removed_ranges:**\n\n[]\n\n'));
        else t.false(d.files.get(d.path)!.includes('messages removed'));
    });
}

for (const legacy of [false, true]) test(`D7b healthy removal retains exact event and IO, legacy=${legacy}`, async t => {
    const source = header + event('BASE', 0, legacy) + event('A1', 1, legacy) + event('A2', 4, legacy);
    const d = disk(source);
    const old = await d.memory.loadActiveSession(d.path);
    const ids = legacy ? ['legacy:2', 'legacy:3'] : ['A1', 'A2'];
    d.calls.length = 0;
    await d.memory.saveSession(old.messages.slice(0, 1), {}, {
        removedMessageIds: ids, removedRanges: [{ from: ids[0], to: ids[1] }], removalContext: sessionRemovalContext(old),
    });
    const text = d.files.get(d.path)!;
    const removal = text.slice(text.indexOf(' — messages removed') + ' — messages removed'.length);
    t.is(removal, `\n\n**removed_messages:**\n\n[\n  "${ids[0]}",\n  "${ids[1]}"\n]\n\n**removed_ranges:**\n\n[\n  {\n    "from": "${ids[0]}",\n    "to": "${ids[1]}"\n  }\n]\n\n**seq:**\n\n6\n\n`);
    t.deepEqual(d.calls, [`read ${d.path}`, `write ${d.path}`]);
    t.deepEqual((await d.memory.loadActiveSession(d.path)).messages.map(m => m.content), ['BASE']);
});
