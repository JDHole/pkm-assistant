import test from 'ava';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AgentMemory, type MemoryVaultAdapterLike } from './AgentMemory.js';
import { formatSessionEvent, parseActiveSession } from './activeSessionFormat.js';
import { mergeSessionConflict, rawSessionBlocks, readConflictAwareSession, SessionConflictError } from './sessionConflict.js';
import { rememberSessionRead, safeRemovalRanges, sessionRemovalContext, SessionRemovalConflictError } from './sessionRemovals.js';

const header = '---\nagent: Tester\ntype: active_session\n---\n\n';
const event = (content: string, seq: number, second = seq) => formatSessionEvent('user_message',
    { content, seq }, `2026-11-15T12:00:${String(second).padStart(2, '0')}.000Z`);
const example = '<<<<<<< example\nkeep A\n=======\nkeep B\n>>>>>>> example';
const wrap = (a: string, b: string) => `<<<<<<< local\n${a}=======\n${b}>>>>>>> remote\n`;

function gitMerge(base: string, a: string, b: string, style: string): string {
    const dir = mkdtempSync(join(process.cwd(), '.d7c-git-'));
    try {
        for (const [name, text] of [['base', base], ['a', a], ['b', b]]) writeFileSync(join(dir, name), text);
        const result = spawnSync('git', ['merge-file', '-p', '-L', 'local', '-L', 'base', '-L', 'remote',
            ...(style === 'merge' ? [] : [`--${style}`]), join(dir, 'a'), join(dir, 'base'), join(dir, 'b')], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
        if (result.status === null || result.status < 0 || result.status >= 128) throw new Error(result.stderr);
        return result.stdout;
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

function disk(source: string) {
    const files = new Map<string, string>();
    const calls: string[] = [];
    const adapter: MemoryVaultAdapterLike = {
        async read(path) { calls.push('read'); if (!files.has(path)) throw new Error('missing'); return files.get(path)!; },
        async write(path, text) { calls.push('write'); files.set(path, text); },
        async append(path, text) { calls.push('append'); files.set(path, files.get(path)! + text); },
        async exists(path) { calls.push('exists'); return files.has(path); },
        async mkdir() { calls.push('mkdir'); },
        async list() { calls.push('list'); return { files: [], folders: [] }; },
    };
    const memory = new AgentMemory({ adapter }, 'Tester');
    memory._structureEnsured = true;
    const path = memory.paths.sessionsActive + '/strict.md';
    memory.setActiveSessionIdentity(path, null);
    files.set(path, source);
    return { memory, path, files, calls };
}

for (const style of ['merge', 'diff3', 'zdiff3']) for (const crlf of [false, true]) {
    test(`D7e git ${style}, CRLF=${crlf}, conflict at first event remains structural`, t => {
        const bytes = (s: string) => crlf ? s.replace(/\n/g, '\r\n') : s;
        const base = bytes(header), a = bytes(event('First A', 1, 1)), b = bytes(event('First B', 1, 2));
        t.deepEqual(mergeSessionConflict(gitMerge(base, base + a, base + b, style)),
            { kind: 'merged', text: base + a + b });
    });
    test(`D7e git ${style}, CRLF=${crlf}, tied ours opening retains the known recognition limit`, t => {
        const bytes = (s: string) => crlf ? s.replace(/\n/g, '\r\n') : s;
        const base = bytes(header + event('BASE', 1));
        const raw = gitMerge(base, base + bytes(event('before\n<<<<<<< literal\nafter', 2, 2)),
            base + bytes(event('normal B', 2, 2)), style);
        t.deepEqual(mergeSessionConflict(raw), { kind: style === 'diff3' ? 'unresolved' : 'not-applicable' });
        t.deepEqual(readConflictAwareSession(raw), style === 'diff3'
            ? { ...parseActiveSession(raw), conflict: 'unresolved' } : parseActiveSession(raw));
    });
    for (const side of ['ours', 'theirs']) for (const [name, literal] of [['close', '>>>>>>> literal'], ['open', '<<<<<<< literal'],
        ['separator', '======='], ['example', example]]) {
        test(`D7c git ${style}, CRLF=${crlf}, literal ${name} on ${side} in divergent message refuses first write`, async t => {
            const bytes = (s: string) => crlf ? s.replace(/\n/g, '\r\n') : s;
            const base = bytes(header + event('BASE', 1));
            const normal = base + bytes(event('normal A', 2, side === 'ours' ? 3 : 2));
            const marked = base + bytes(event(`before\n${literal}\nafter`, 2, side === 'ours' ? 2 : 3));
            const raw = gitMerge(base, side === 'ours' ? marked : normal, side === 'ours' ? normal : marked, style);
            t.deepEqual(mergeSessionConflict(raw), { kind: 'unresolved' });
            const d = disk(raw);
            await t.throwsAsync(d.memory.appendToActiveSession({ type: 'user_message', content: 'NEXT' }), { instanceOf: SessionConflictError });
            t.is(d.files.get(d.path), raw);
            t.deepEqual([...d.files.keys()], [d.path]);
            t.false(d.calls.includes('write') || d.calls.includes('append'));
        });
    }
    test(`D7c git ${style}, CRLF=${crlf}, common example labels decide preservation`, async t => {
        const bytes = (s: string) => crlf ? s.replace(/\n/g, '\r\n') : s;
        const base = bytes(header + event(example, 1));
        const a = bytes(event('A', 2, 2)), b = bytes(event('B', 2, 3));
        const raw = gitMerge(base, base + a, base + b, style);
        t.deepEqual(mergeSessionConflict(raw), { kind: 'merged', text: base + a + b });
        t.deepEqual(readConflictAwareSession(raw).messages.map(m => m.content), [example, 'A', 'B']);
        const same = raw.replaceAll('<<<<<<< example', '<<<<<<< local').replaceAll('>>>>>>> example', '>>>>>>> remote');
        t.deepEqual(mergeSessionConflict(same), { kind: 'unresolved' });
        const d = disk(same);
        await t.throwsAsync(d.memory.appendToActiveSession({ type: 'user_message', content: 'NEXT' }), { instanceOf: SessionConflictError });
        t.is(d.files.get(d.path), same);
    });
}

test('D7c pseudo-block spanning healthy messages refuses and preserves every byte', async t => {
    const raw = header + event('before\n<<<<<<< local\nafter', 1)
        + event('before\n=======\nmiddle\n>>>>>>> remote\nafter', 2);
    t.deepEqual(mergeSessionConflict(raw), { kind: 'unresolved' });
    const d = disk(raw);
    t.deepEqual((await d.memory.loadActiveSession(d.path)).messages.map(m => m.content),
        ['before\n<<<<<<< local\nafter', 'before\n=======\nmiddle\n>>>>>>> remote\nafter']);
    await t.throwsAsync(d.memory.appendToActiveSession({ type: 'user_message', content: 'NEXT' }), { instanceOf: SessionConflictError });
    t.is(d.files.get(d.path), raw);
    t.deepEqual(d.calls, ['read', 'exists', 'read']);
});

for (const literal of [example, '<<<<<<< loose\nunfinished', '>>>>>>> loose', '=======\n||||||| base',
    '<<<<<<< outer\n' + example + '\n>>>>>>> outer']) {
    test(`D7c healthy literal ${JSON.stringify(literal)} keeps read and append IO`, async t => {
        const raw = header + event(literal, 1);
        t.deepEqual(mergeSessionConflict(raw), { kind: 'not-applicable' });
        const d = disk(raw);
        t.deepEqual((await d.memory.loadActiveSession(d.path)).messages, [{ role: 'user', content: literal, seq: 1 }]);
        t.deepEqual(d.calls, ['read']);
        d.calls.length = 0;
        await d.memory.appendToActiveSession({ type: 'user_message', content: 'NEXT', timestamp: '2026-11-15T12:00:02.000Z' });
        t.is(d.files.get(d.path), raw + event('NEXT', 2));
        t.deepEqual(d.calls, ['exists', 'read', 'append']);
        t.deepEqual([...d.files.keys()], [d.path]);
    });
}

for (const malformed of ['<<<<<<< loose\n', '>>>>>>> loose\n',
    '<<<<<<< local\na\n=======\nb\n=======\nc\n>>>>>>> remote\n',
    '<<<<<<< local\n||||||| base\na\n||||||| base\nb\n=======\nc\n>>>>>>> remote\n',
    '<<<<<<< local\n' + example + '\n>>>>>>> remote\n']) {
    test(`D7c structural conflict plus malformed ${JSON.stringify(malformed)} refuses`, t => {
        t.deepEqual(mergeSessionConflict(header + wrap(event('A', 1), event('B', 1, 2)) + malformed), { kind: 'unresolved' });
    });
}

test('D7c label pairs agree across structural blocks and content after divergence', t => {
    const first = wrap(event('A', 1), event('B', 1, 2));
    const second = wrap(event('C', 2, 3), event('D', 2, 4));
    t.deepEqual(mergeSessionConflict(header + first + second.replace('remote', 'other')), { kind: 'unresolved' });
    t.deepEqual(mergeSessionConflict(header + first + event(example, 2, 3)), { kind: 'unresolved' });
    t.deepEqual(mergeSessionConflict(header + first + second), { kind: 'merged',
        text: header + event('A', 1) + event('B', 1, 2) + event('C', 2, 3) + event('D', 2, 4) });
});

test('D7c side completion and increasing seq are checked before raw union', t => {
    const good = event('A', 1);
    for (const bad of [good.replace('**seq:**\n\n1\n\n', ''), good + 'trailing text\n',
        good.replace('\n1\n', '\n0\n'), good + event('next', 1, 2)]) {
        t.deepEqual(mergeSessionConflict(header + wrap(bad, event('B', 1, 3))), { kind: 'unresolved' });
    }
    // No per-type content requirement: empty/control/unknown events still end in seq.
    const empty = formatSessionEvent('unknown_event', { seq: 1 }, '2026-11-15T12:00:01.000Z');
    t.deepEqual(mergeSessionConflict(header + wrap(empty, event('B', 1, 2))), { kind: 'merged', text: header + empty + event('B', 1, 2) });
});

test('D7c removal receipt accepts only unchanged event prefix, independent of header and tail', t => {
    const source = header + event('A😀', 1) + event('B', 2);
    const messages = parseActiveSession(source).messages;
    rememberSessionRead(messages, messages, source);
    const context = sessionRemovalContext(messages)!;
    t.is(JSON.stringify(context).length < 80, true);
    const ranges = [{ from: 'legacy:1', to: 'legacy:2' }];
    const ids = ['legacy:1', 'legacy:2'];
    t.deepEqual(safeRemovalRanges(source.replace('Tester', 'Another tester') + event('C', 3), ids, new Set(ids), ranges, context), ranges);
    for (const changed of [source.replace('A😀', 'Z😀'), source.slice(0, -1), header]) {
        t.throws(() => safeRemovalRanges(changed, ids, new Set(ids), ranges, context), { instanceOf: SessionRemovalConflictError });
    }
});

test('D7e a synthetic FNV collision cannot authorize removing unseen legacy text', async t => {
    // Deterministic synthetic collision for the entire UTF-16 event body, not user data.
    const first = header + '## User\n\nSynthetic 9b2f94195c3c992f\n\n';
    const second = header + '## User\n\nSynthetic 6166395e6ff8e578\n\n';
    const d = disk(first);
    const old = await d.memory.loadActiveSession(d.path);
    const context = sessionRemovalContext(old)!;
    const fresh = parseActiveSession(second);
    rememberSessionRead(fresh, fresh.messages, second);
    const other = sessionRemovalContext(fresh)!;
    t.is(context.length, other.length);
    t.is(context.hash, other.hash);
    t.not(context.hash2, other.hash2);
    const ranges = [{ from: 'legacy:1', to: 'legacy:1' }];
    t.deepEqual(safeRemovalRanges(first, ['legacy:1'], new Set(['legacy:1']), ranges, context), ranges);
    d.files.set(d.path, second);
    await t.throwsAsync(d.memory.saveSession([], {}, { removedMessageIds: ['legacy:1'],
        removedRanges: ranges, removalContext: context }), { instanceOf: SessionRemovalConflictError });
    t.is(d.files.get(d.path), second);
    t.deepEqual((await d.memory.loadActiveSession(d.path)).messages,
        [{ role: 'user', content: 'Synthetic 6166395e6ff8e578', seq: null }]);
});

test.serial('D7c linear read cost: 1/5 MB plain, 20 examples, dense examples and real conflict', t => {
    for (const mb of [1, 5]) for (const mode of ['plain', '20', 'dense']) {
        const target = mb * 1_000_000;
        const unit = mode === 'dense' ? example + '\n' : 'Neutral text.\n';
        const content = (mode === '20' ? (example + '\n').repeat(20) : '') + unit.repeat(Math.ceil(target / unit.length));
        const raw = header + event(content, 1);
        const samples: number[] = [];
        for (let n = 0; n < 5; n++) {
            const start = performance.now();
            const parsed = readConflictAwareSession(raw);
            samples.push(performance.now() - start);
            t.deepEqual(parsed.messages, [{ role: 'user', content: content.trimEnd(), seq: 1 }]);
            t.is(parsed.conflict, undefined);
        }
        const median = samples.sort((a, b) => a - b)[2];
        t.log(`${mb} MB ${mode}: ${median.toFixed(1)} ms median`);
        if (mb === 1) t.true(median < 2000);
    }
    const base = header + event('Neutral text.\n'.repeat(77_000), 1);
    const raw = gitMerge(base, base + event('A', 2, 2), base + event('B', 2, 3), 'merge');
    const samples: number[] = [];
    for (let n = 0; n < 5; n++) {
        const start = performance.now();
        const parsed = readConflictAwareSession(raw);
        samples.push(performance.now() - start);
        t.deepEqual(parsed.messages.map(m => m.content), ['Neutral text.\n'.repeat(77_000).trimEnd(), 'A', 'B']);
        t.is(parsed.conflict, undefined);
    }
    const median = samples.sort((a, b) => a - b)[2];
    t.log(`1 MB real conflict: ${median.toFixed(1)} ms median`);
    t.true(median < 2000);
});

// D7e preflight: a terminal seq in every literal block is NOT sufficient proof
// of a healthy log. zdiff3 factors out a common first heading and final seq.
// Keep the refusal: literal completeness cannot certify the absence of a conflict.
for (const crlf of [false, true]) for (const numberedByWriter of [false, true])
for (const tools of [false, true]) for (const ids of [false, true]) {
    test(`D7e rejects complete-looking zdiff3, CRLF=${crlf}, writer seq=${numberedByWriter}, tools=${tools}, IDs=${ids}`, async t => {
        const bytes = (s: string) => crlf ? s.replace(/\n/g, '\r\n') : s;
        const base = bytes(header + event('BASE', 1, 0));
        const branch = (side: string) => bytes(Array.from({ length: 3 }, (_, turn) => {
            const second = 1 + turn * 6;
            const seq = 2 + turn * (tools ? 3 : 2);
            const part = (type: string, content: string, number: number, offset: number) =>
                formatSessionEvent(type, { ...(ids ? { message_id: content } : {}),
                    ...(type === 'tool_result' ? { result: content } : { content }), seq: number },
                `2026-11-15T12:00:${String(second + offset).padStart(2, '0')}.000Z`);
            return part('user_message', side + turn, numberedByWriter ? seq : second + 1, 0)
                + (tools ? part('tool_result', side + turn + ' result', numberedByWriter ? seq + 1 : turn + 2, 1) : '')
                + part('agent_message', side + turn + ' answer', numberedByWriter ? seq + (tools ? 2 : 1) : turn + 3, 2);
        }).join(''));
        const raw = gitMerge(base, base + branch('A'), base + branch('B'), 'zdiff3');
        assertCompleteLookingConflict(t, raw);
        const d = disk(raw);
        await t.throwsAsync(d.memory.appendToActiveSession({ type: 'user_message', content: 'NEXT' }),
            { instanceOf: SessionConflictError });
        t.deepEqual([...d.files], [[d.path, raw]]);
    });
}

for (const crlf of [false, true]) test(`D7e increasing seq alone also misses a real zdiff3 conflict, CRLF=${crlf}`, t => {
    const bytes = (s: string) => crlf ? s.replace(/\n/g, '\r\n') : s;
    const base = bytes(header + event('BASE', 1, 0));
    const a = bytes(event('A question', 2, 1) + event('A answer', 6, 2));
    const b = bytes(event('B question', 4, 1) + event('B answer', 6, 2));
    const raw = gitMerge(base, base + a, base + b, 'zdiff3');
    assertCompleteLookingConflict(t, raw);
    t.deepEqual(rawSessionBlocks(raw).blocks.map(block => Number(block.match(/\*\*seq:\*\*\s*(\d+)\s*$/)?.[1])),
        [1, 2, 4, 6]);
});

function assertCompleteLookingConflict(t: import('ava').ExecutionContext, raw: string): void {
    const { header: prefix, blocks } = rawSessionBlocks(raw);
    t.false(/^<<<<<<<(?: |\r?$)/m.test(prefix));
    // Independent checks of every premise of the requested witness on real Git output.
    // Expected refusal is literal; no candidate implementation generates the oracle.
    for (const block of blocks) {
        t.is([...block.matchAll(/^\*\*seq:\*\*[ \t]*\r?$/gm)].length, 1);
        const seq = Number(block.match(/\n\*\*seq:\*\*[ \t]*\r?\n\s*(\d+)\s*$/)?.[1]);
        t.true(Number.isSafeInteger(seq) && seq > 0);
    }
    t.deepEqual(mergeSessionConflict(raw), { kind: 'unresolved' });
}
