import test from 'ava';
import type { ExecutionContext } from 'ava';
import { CostLog } from './CostLog.js';
import type { CostLogRecord, CostLogVaultLike } from './CostLog.js';

const PATH = '.pkm-assistant/cost_log.jsonl';
const PREFIX = ' {"agent":"Tester","cost_usd":1} \r\n\n';

function fixture(options: { native?: boolean; initial?: string; folder?: boolean; requiresFile?: boolean } = {}) {
    const files = new Map<string, string>();
    if (options.initial !== undefined) files.set(PATH, options.initial);
    let folder = options.folder ?? true;
    let unreadable = false;
    let failAppend = false;
    let lyingExists = false;
    const calls: string[] = [];
    const adapter: CostLogVaultLike['adapter'] = {
        async exists(path) {
            calls.push(`exists:${path}`);
            return path === '.pkm-assistant' ? folder : !lyingExists && files.has(path);
        },
        async read(path) {
            calls.push(`read:${path}`);
            const content = files.get(path);
            if (unreadable || content === undefined) throw new Error('Synthetic read failure');
            return content;
        },
        async write(path, data) {
            calls.push(`write:${path}`);
            if (!folder) throw new Error('Synthetic missing folder');
            files.set(path, data);
        },
    };
    const native = {
        ...adapter,
        async mkdir(path: string) {
            calls.push(`mkdir:${path}`);
            folder = true;
        },
        async append(path: string, data: string) {
            calls.push(`append:${path}`);
            if (failAppend || !folder || (options.requiresFile && !files.has(path))) {
                throw new Error('Synthetic append failure');
            }
            // Deliberately non-atomic adapter: concurrent calls interleave half-lines.
            const middle = Math.floor(data.length / 2);
            files.set(path, (files.get(path) ?? '') + data.slice(0, middle));
            await Promise.resolve();
            files.set(path, (files.get(path) ?? '') + data.slice(middle));
        },
    };
    const vault = { adapter: options.native ? native : adapter };
    return {
        vault, files, calls,
        unreadable: () => { unreadable = true; },
        fail: (value: boolean) => { failAppend = value; },
        lie: () => { lyingExists = true; },
    };
}

function expectedRecord(ts: string, index = 0): CostLogRecord {
    return {
        ts, agent: 'Tester', role: 'main', model: '?', input_tokens: index,
        output_tokens: 0, cached_tokens: 0, savings_usd: 0, cost_usd: 0, status: 'ok',
    };
}

function assertFile(t: ExecutionContext, content: string | undefined, count: number, prefix = '') {
    t.is(typeof content, 'string');
    if (content === undefined) return;
    t.is(content.slice(0, prefix.length), prefix);
    const lines = content.slice(prefix.length).split('\n');
    t.is(lines.pop(), '');
    t.is(lines.length, count);
    for (let i = 0; i < count; i++) {
        const record: CostLogRecord = JSON.parse(lines[i]);
        t.true(Number.isFinite(Date.parse(record.ts)));
        t.deepEqual(record, expectedRecord(record.ts, i));
        t.is(lines[i], JSON.stringify(expectedRecord(record.ts, i)));
    }
}

test('D4 fallback baseline: 20 sequential entries preserve bytes and use 20 reads + 20 writes', async t => {
    const f = fixture({ initial: PREFIX });
    const cost = new CostLog(f.vault);
    for (let i = 0; i < 20; i++) await cost.append({ agent: 'Tester', role: 'main', input_tokens: i });
    assertFile(t, f.files.get(PATH), 20, PREFIX);
    t.deepEqual(f.calls, Array.from({ length: 20 }, () => [`read:${PATH}`, `write:${PATH}`]).flat());
});

test('D4 fallback baseline: first entry confirms missing file before write', async t => {
    const f = fixture();
    await new CostLog(f.vault).append({ agent: 'Tester', role: 'main' });
    assertFile(t, f.files.get(PATH), 1);
    t.deepEqual(f.calls, [`read:${PATH}`, `exists:${PATH}`, `read:${PATH}`, `write:${PATH}`]);
});

test('D4 fallback baseline: unreadable file skips entry and returns normalized record', async t => {
    const f = fixture({ initial: PREFIX });
    f.unreadable();
    const record = await new CostLog(f.vault).append({ agent: 'Tester', role: 'main' });
    t.deepEqual(record, expectedRecord(record.ts));
    t.is(f.files.get(PATH), PREFIX);
    t.deepEqual(f.calls, [`read:${PATH}`, `exists:${PATH}`]);
});

test('D4 fallback baseline: lying exists cannot erase history', async t => {
    const f = fixture({ initial: PREFIX });
    f.lie();
    await new CostLog(f.vault).append({ agent: 'Tester', role: 'main' });
    assertFile(t, f.files.get(PATH), 1, PREFIX);
    t.deepEqual(f.calls, [`read:${PATH}`, `write:${PATH}`]);
});

test('D4 native: 20 entries use only append and preserve the old bytes', async t => {
    const f = fixture({ native: true, initial: PREFIX });
    f.lie();
    const cost = new CostLog(f.vault);
    for (let i = 0; i < 20; i++) await cost.append({ agent: 'Tester', role: 'main', input_tokens: i });
    assertFile(t, f.files.get(PATH), 20, PREFIX);
    t.deepEqual(f.calls, Array(20).fill(`append:${PATH}`));
});

test('D4 native: first append creates a missing file without read or write', async t => {
    const f = fixture({ native: true });
    await new CostLog(f.vault).append({ agent: 'Tester', role: 'main' });
    assertFile(t, f.files.get(PATH), 1);
    t.deepEqual(f.calls, [`append:${PATH}`]);
});

for (const folder of [true, false]) {
    test(`D4 native: confirmed missing file bootstraps with folder=${folder}`, async t => {
        const f = fixture({ native: true, requiresFile: true, folder });
        await new CostLog(f.vault).append({ agent: 'Tester', role: 'main' });
        assertFile(t, f.files.get(PATH), 1);
        t.deepEqual(f.calls, [
            `append:${PATH}`, `exists:${PATH}`, `read:${PATH}`, 'exists:.pkm-assistant',
            ...(folder ? [] : ['mkdir:.pkm-assistant']), `write:${PATH}`,
        ]);
    });
}

for (const native of [true, false]) {
    for (const shared of [true, false]) {
        test(`D4 queue: 20 parallel entries, native=${native}, new instances=${shared}`, async t => {
            const f = fixture({ native, initial: PREFIX });
            const cost = new CostLog(f.vault);
            await Promise.all(Array.from({ length: 20 }, (_, i) =>
                (shared ? new CostLog(f.vault) : cost).append({ agent: 'Tester', role: 'main', input_tokens: i })));
            assertFile(t, f.files.get(PATH), 20, PREFIX);
            t.deepEqual(f.calls, native ? Array(20).fill(`append:${PATH}`)
                : Array.from({ length: 20 }, () => [`read:${PATH}`, `write:${PATH}`]).flat());
        });
    }
}

for (const lie of [false, true]) {
    test(`D4 native: failed append leaves existing file intact, lying exists=${lie}`, async t => {
        const f = fixture({ native: true, initial: PREFIX });
        f.fail(true);
        if (lie) f.lie();
        const cost = new CostLog(f.vault);
        const record = await cost.append({ agent: 'Tester', role: 'main' });
        t.deepEqual(record, expectedRecord(record.ts));
        t.is(f.files.get(PATH), PREFIX);
        t.deepEqual(f.calls, [`append:${PATH}`, `exists:${PATH}`, ...(lie ? [`read:${PATH}`] : [])]);
        f.fail(false);
        await cost.append({ agent: 'Tester', role: 'main' });
        assertFile(t, f.files.get(PATH), 1, PREFIX);
    });
}

test('D4 native: append failure and unreadable existing file never trigger replacement', async t => {
    const f = fixture({ native: true, initial: PREFIX });
    f.fail(true);
    f.unreadable();
    const record = await new CostLog(f.vault).append({ agent: 'Tester', role: 'main' });
    t.deepEqual(record, expectedRecord(record.ts));
    t.is(f.files.get(PATH), PREFIX);
    t.deepEqual(f.calls, [`append:${PATH}`, `exists:${PATH}`]);
});

test('D4 queue: a failed write does not block an already queued entry', async t => {
    const f = fixture({ native: true, initial: PREFIX });
    const append = f.vault.adapter.append;
    if (!append) throw new Error('Synthetic adapter requires append');
    let first = true;
    f.vault.adapter.append = async (path, data) => {
        if (first) {
            first = false;
            throw new Error('Synthetic first append failure');
        }
        await append(path, data);
    };
    const cost = new CostLog(f.vault);
    const records = await Promise.all([
        cost.append({ agent: 'Tester', role: 'main', input_tokens: 99 }),
        cost.append({ agent: 'Tester', role: 'main' }),
    ]);
    t.deepEqual(records, [expectedRecord(records[0].ts, 99), expectedRecord(records[1].ts)]);
    assertFile(t, f.files.get(PATH), 1, PREFIX);
});

test('D4 reader: conflict markers, blanks and corrupt lines do not hide either side', async t => {
    const initial = [
        '{"agent":"Tester","cost_usd":1}', '', '<<<<<<< device-a',
        '{"agent":"Tester","cost_usd":2}', 'broken json', '=======',
        '{"agent":"Tester","cost_usd":3}', '>>>>>>> device-b', ' \t',
        '{"agent":"Tester","cost_usd":4}', '',
    ].join('\r\n');
    const f = fixture({ initial });
    t.deepEqual(await new CostLog(f.vault).readAll(), [
        { agent: 'Tester', cost_usd: 1 }, { agent: 'Tester', cost_usd: 2 },
        { agent: 'Tester', cost_usd: 3 }, { agent: 'Tester', cost_usd: 4 },
    ]);
    t.is(f.files.get(PATH), initial);
    t.deepEqual(f.calls, [`exists:${PATH}`, `read:${PATH}`]);
});

test('D4 reader: adjacent objects recover in file order, strings and nesting stay intact', async t => {
    const f = fixture({ initial:
        '{"agent":"Tester","error":"}{","cache":{"cached_tokens":7}}'
        + '{"agent":"Tester","error":"escaped \\" quote and \\\\ slash }{"}'
        + '{"agent":"Tester","cost_usd":3}\n',
    });
    t.deepEqual(await new CostLog(f.vault).readAll(), [
        { agent: 'Tester', error: '}{', cache: { cached_tokens: 7 } },
        { agent: 'Tester', error: 'escaped " quote and \\ slash }{' },
        { agent: 'Tester', cost_usd: 3 },
    ]);
});

test('D4 reader: an incomplete glued line is skipped as a whole, later records survive', async t => {
    const f = fixture({ initial: [
        '{"cost_usd":1}{"cost_usd":',
        '{"cost_usd":2}{broken}',
        '{"cost_usd":3}junk{"cost_usd":4}',
        '{"cost_usd":5}\n',
    ].join('\n') });
    t.deepEqual(await new CostLog(f.vault).readAll(), [{ cost_usd: 5 }]);
});

test('D4 native: missing final newline preserves old bytes and reader recovers both entries', async t => {
    const f = fixture({ native: true, initial: '{"agent":"Tester","cost_usd":1}' });
    const cost = new CostLog(f.vault);
    const record = await cost.append({ agent: 'Tester', role: 'main' });
    assertFile(t, f.files.get(PATH), 1, '{"agent":"Tester","cost_usd":1}');
    t.deepEqual(await cost.readAll(), [{ agent: 'Tester', cost_usd: 1 }, expectedRecord(record.ts)]);
});
