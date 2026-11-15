import test from 'ava';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { AgentMemory, type MemoryVaultAdapterLike } from './AgentMemory.js';
import { parseActiveSession } from './activeSessionFormat.js';
import { mergeSessionConflict, SessionConflictError } from './sessionConflict.js';
import { parseDeviceId } from './sessionOwnership.js';

const header = '---\nagent: Tester\ntype: active_session\n---\n\n';
const time = (second: number) => `2026-11-15T12:00:${String(second).padStart(2, '0')}.000Z`;
// Independent byte oracle, not the production event formatter.
const block = (content: string, seq: number, second: number, role = 'user') =>
    `## ${time(second)} — ${role} message\n\n**content:**\n\n${content}\n\n**seq:**\n\n${seq}\n\n`;

function gitMerge(base: string, ours: string, theirs: string, style: string): string {
    const dir = mkdtempSync(join(process.cwd(), '.d7d-git-'));
    try {
        for (const [name, text] of [['base', base], ['ours', ours], ['theirs', theirs]]) {
            writeFileSync(join(dir, name), text);
        }
        const result = spawnSync('git', ['merge-file', '-p', '-L', 'local', '-L', 'base', '-L', 'remote',
            ...(style === 'merge' ? [] : [`--${style}`]), join(dir, 'ours'), join(dir, 'base'), join(dir, 'theirs')],
        { encoding: 'utf8' });
        if (result.status === null || result.status <= 0 || result.status >= 128) {
            throw new Error(`Expected a real git conflict: ${result.status}, ${result.stderr}`);
        }
        return result.stdout;
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

function sharedDisk(source: string, native = true) {
    const path = '.pkm-assistant/agents/tester/memory/sessions/active/repeated.md';
    const files = new Map([[path, source]]);
    const device = (id: string) => {
        // Each device owns a distinct adapter, queue and cache over the same disk.
        const adapter: MemoryVaultAdapterLike = {
            async read(p) { if (!files.has(p)) throw new Error('missing'); return files.get(p)!; },
            async write(p, text) { files.set(p, text); },
            async exists(p) { return files.has(p); },
            async mkdir() {},
            async list() { return { files: [], folders: [] }; },
            ...(native ? { async append(p: string, text: string) {
                if (!files.has(p)) throw new Error('missing');
                files.set(p, files.get(p)! + text);
            } } : {}),
        };
        const memory = new AgentMemory({ adapter }, 'Tester', {}, parseDeviceId(id));
        memory._structureEnsured = true;
        memory.setActiveSessionIdentity(path, null);
        return memory;
    };
    return { path, files, a: device('aaaaaaaaaaaaaaaa'), b: device('bbbbbbbbbbbbbbbb') };
}

for (const style of ['merge', 'diff3', 'zdiff3']) for (const native of [true, false]) {
    test(`D7d two repair cycles via git ${style}, native append=${native}`, async t => {
        const base = header + block('Base question', 1, 0) + block('Base answer', 2, 1, 'agent');
        const d = sharedDisk(base, native);
        const turn = async (memory: AgentMemory, question: string, answer: string, second: number) => {
            await memory.appendToActiveSession({ type: 'user_message', content: question, timestamp: time(second) });
            await memory.appendToActiveSession({ type: 'agent_message', content: answer, timestamp: time(second + 1) });
            return d.files.get(d.path)!;
        };
        const a1 = await turn(d.a, 'A first question', 'A first answer', 2);
        d.files.set(d.path, base); // Device B starts from the same Git base.
        const b1 = await turn(d.b, 'B first question', 'B first answer', 4);
        const firstConflict = gitMerge(base, a1, b1, style);
        const firstUnion = base + block('A first question', 3, 2) + block('A first answer', 4, 3, 'agent')
            + block('B first question', 3, 4) + block('B first answer', 4, 5, 'agent');
        t.deepEqual(mergeSessionConflict(firstConflict), { kind: 'merged', text: firstUnion });
        d.files.set(d.path, firstConflict);
        await d.a.appendToActiveSession({ type: 'user_message', content: 'After first repair', timestamp: time(6) });
        const repaired = firstUnion + block('After first repair', 5, 6);
        t.is(d.files.get(d.path), repaired);
        t.deepEqual([...d.files].filter(([p]) => p.includes('/backups/')).map(([, text]) => text), [firstConflict]);

        const a2 = await turn(d.a, 'A second question', 'A second answer', 7);
        d.files.set(d.path, repaired); // Both devices now branch from the repaired log.
        const b2 = await turn(d.b, 'B second question', 'B second answer', 9);
        const secondConflict = gitMerge(repaired, a2, b2, style);
        const secondUnion = repaired + block('A second question', 6, 7) + block('A second answer', 7, 8, 'agent')
            + block('B second question', 6, 9) + block('B second answer', 7, 10, 'agent');
        t.deepEqual(mergeSessionConflict(secondConflict), { kind: 'merged', text: secondUnion });
        d.files.set(d.path, secondConflict);
        await d.a.appendToActiveSession({ type: 'user_message', content: 'After second repair', timestamp: time(11) });
        const output = d.files.get(d.path)!;
        t.is(output, secondUnion + block('After second repair', 8, 11));
        t.deepEqual((await d.b.loadActiveSession(d.path)).messages.map(m => [m.role, m.content, m.seq]), [
            ['user', 'Base question', 1], ['assistant', 'Base answer', 2],
            ['user', 'A first question', 3], ['assistant', 'A first answer', 4],
            ['user', 'B first question', 3], ['assistant', 'B first answer', 4],
            ['user', 'After first repair', 5],
            ['user', 'A second question', 6], ['assistant', 'A second answer', 7],
            ['user', 'B second question', 6], ['assistant', 'B second answer', 7],
            ['user', 'After second repair', 8],
        ]);
        t.false(/^(?:<<<<<<<|=======|>>>>>>>)/m.test(output));
        t.deepEqual([...d.files].filter(([p]) => p.includes('/backups/')).map(([, text]) => text),
            [firstConflict, secondConflict]);
    });
}

for (const [name, numbers] of [
    ['below prefix maximum', [3, 5]], ['equal to prefix maximum', [4, 5]],
    ['decreasing divergent seq', [6, 5]], ['repeated divergent seq', [5, 5]],
] as const) for (const side of ['ours', 'theirs']) {
    test(`D7d ${name} on ${side} refuses without writing`, async t => {
        // Last seq is smaller than the maximum: checking just the last is unsafe.
        const base = header + block('Common start', 1, 0) + block('Common maximum', 4, 1)
            + block('Common lower', 2, 2);
        const bad = base + block('Rejected first', numbers[0], 3) + block('Rejected second', numbers[1], 4);
        const good = base + block('Other branch', 5, 5);
        const raw = gitMerge(base, side === 'ours' ? bad : good, side === 'ours' ? good : bad, 'diff3');
        t.deepEqual(mergeSessionConflict(raw), { kind: 'unresolved' });
        const d = sharedDisk(raw);
        await t.throwsAsync(d.a.appendToActiveSession({ type: 'user_message', content: 'NEXT', timestamp: time(6) }),
            { instanceOf: SessionConflictError });
        t.deepEqual([...d.files], [[d.path, raw]]);
    });
}

test('D7d identical legacy and decreasing numbered prefix allows gaps above its maximum', t => {
    const base = header + '## User\n\nLegacy common\n\n' + block('Common maximum', 4, 0)
        + block('Common lower', 2, 1) + block('Common repeat', 2, 2);
    const a = block('A gap', 7, 3), b = block('B gap', 9, 4);
    const raw = gitMerge(base, base + a, base + b, 'diff3');
    t.deepEqual(mergeSessionConflict(raw), { kind: 'merged', text: base + a + b });
    const merged = mergeSessionConflict(raw);
    if (merged.kind !== 'merged') return;
    t.deepEqual(parseActiveSession(merged.text).messages.map(m => [m.content, m.seq]), [
        ['Legacy common', null], ['Common maximum', 4], ['Common lower', 2], ['Common repeat', 2],
        ['A gap', 7], ['B gap', 9],
    ]);
});
