import test from 'ava';
import { readFileSync } from 'node:fs';
import { StateManager } from './StateManager.js';
import { StateCorruptionError } from './StateCorruptionError.js';
import { log } from '../../core/utils/Logger.js';

const PATH = '.pkm-assistant/agents/jaskier/memory/.state.json';
const ACTIVE = '.pkm-assistant/agents/jaskier/memory/sessions/active';
const BACKUPS = '.pkm-assistant/backups';
const RAW = readFileSync(new URL('./__fixtures__/state-conflict.txt', import.meta.url), 'utf8');
const CLEAN = '{\n  "active_sessions": [\n    "jaskier_2026-11-14_14-25.md",\n    "x.md"\n  ],\n  "archived_since_last_consolidation": 8,\n  "last_archive_at": "2026-11-14T15:02:00.000Z",\n  "notes_count_at_last_check": 13,\n  "last_used": "x.md",\n  "brain_notes_limit": 15\n}\n';

function fixture(raw = RAW) {
    const files = new Map([[PATH, raw], [`${ACTIVE}/jaskier_2026-11-14_14-25.md`, 'session']]);
    const dirs = new Set<string>();
    const calls: string[] = [], writes: string[] = [];
    const adapter = {
        async exists(path: string) { calls.push('exists'); return files.has(path) || dirs.has(path); },
        async read(path: string) {
            calls.push('read');
            const text = files.get(path);
            if (text === undefined) throw new Error('ENOENT');
            return text;
        },
        async write(path: string, text: string) { calls.push('write'); writes.push(path); files.set(path, text); },
        async mkdir(path: string) { calls.push('mkdir'); dirs.add(path); },
        async list(path: string) { calls.push('list'); return { files: [...files.keys()].filter(p => p.startsWith(path + '/')) }; },
    };
    return { files, dirs, calls, writes, adapter, manager: new StateManager({ adapter }, PATH),
        backups: () => [...files.entries()].filter(([path]) => path.startsWith(BACKUPS + '/')) };
}

test.serial('D1: repair persists exact backup before clean JSON and mutation, warns once; next mutation needs no backup', async t => {
    const f = fixture();
    const warnings: unknown[][] = [];
    const warn = log.warn;
    log.warn = (...args: unknown[]) => { warnings.push(args); };
    t.teardown(() => { log.warn = warn; });
    await f.manager.addActiveSession('x.md');
    t.is(f.files.get(PATH), CLEAN);
    t.is(f.backups().length, 1);
    const [backup, bytes] = f.backups()[0];
    t.regex(backup, /^\.pkm-assistant\/backups\/state-jaskier-\d+\.json\.bak$/);
    t.is(bytes, RAW);
    t.deepEqual(f.writes, [backup, PATH, PATH]);
    t.deepEqual(warnings, [['StateManager', `Naprawiono konflikt: ${PATH}; kopia: ${backup}`]]);
    await f.manager.addActiveSession('y.md');
    t.deepEqual((await f.manager.read()).active_sessions, ['jaskier_2026-11-14_14-25.md', 'x.md', 'y.md']);
    t.deepEqual(f.backups(), [[backup, RAW]]);
    t.is(warnings.length, 1);
});

test('D1: read merges in RAM only; first mutation still makes the original backup', async t => {
    const f = fixture();
    t.deepEqual(await f.manager.read(), {
        active_sessions: ['jaskier_2026-11-14_14-25.md'], archived_since_last_consolidation: 8,
        last_archive_at: '2026-11-14T15:02:00.000Z', notes_count_at_last_check: 13,
        last_used: 'jaskier_2026-11-14_14-25.md', brain_notes_limit: 15,
    });
    t.is(f.files.get(PATH), RAW);
    t.deepEqual(f.writes, []);
    t.deepEqual([...f.dirs], []);
    await f.manager.addActiveSession('x.md');
    t.is(f.files.get(PATH), CLEAN);
    t.is(f.backups()[0][1], RAW);
});

for (const failure of ['mkdir', 'backup-write', 'backup-readback', 'state-write'] as const) {
    test(`D1: ${failure} fails closed and a later retry can recover`, async t => {
        const f = fixture();
        const { write, read, mkdir } = f.adapter;
        f.adapter.mkdir = async path => { if (failure === 'mkdir') throw new Error('EACCES'); await mkdir(path); };
        f.adapter.write = async (path, text) => {
            if ((failure === 'backup-write' && path.startsWith(BACKUPS)) || (failure === 'state-write' && path === PATH)) throw new Error('EACCES');
            await write(path, text);
        };
        f.adapter.read = async path => path.startsWith(BACKUPS) && f.files.has(path) && failure === 'backup-readback' ? 'partial' : read(path);
        const error = await t.throwsAsync(f.manager.addActiveSession('x.md'), { instanceOf: StateCorruptionError });
        t.is(error?.agentName, 'jaskier');
        t.is(f.files.get(PATH), RAW);
        t.false(f.writes.includes(PATH));
        Object.assign(f.adapter, { write, read, mkdir });
        await f.manager.addActiveSession('x.md');
        t.is(f.files.get(PATH), CLEAN);
        t.true(f.backups().some(([, text]) => text === RAW));
    });
}

for (const raw of ['{broken secret', '<<<<<<< HEAD\n{}\n=======\nnot-json\n>>>>>>> branch\n', '<<<<<<< HEAD\n{}']) {
    test(`D1: unrepairable input remains untouched: ${raw.slice(0, 20)}`, async t => {
        const f = fixture(raw);
        await t.throwsAsync(f.manager.addActiveSession('x.md'), { instanceOf: StateCorruptionError });
        t.deepEqual(await f.manager.read(), { active_sessions: [], archived_since_last_consolidation: 0, last_archive_at: null });
        t.is(f.files.get(PATH), raw);
        t.deepEqual(f.writes, []);
    });
}

test('D1: valid state retains measured pre-D1 I/O and literal bytes', async t => {
    const f = fixture('{"active_sessions":["a.md"],"archived_since_last_consolidation":4,"last_archive_at":null}');
    await f.manager.addActiveSession('x.md');
    // Measured on unmodified StateManager before D1, using the same initial file and operation.
    t.deepEqual(f.calls, ['exists', 'read', 'read', 'write']);
    t.is(f.files.get(PATH), '{\n  "active_sessions": [\n    "a.md",\n    "x.md"\n  ],\n  "archived_since_last_consolidation": 4,\n  "last_archive_at": null,\n  "last_used": "x.md"\n}\n');
});

test('D1: concurrent mutations share one repair and preserve both additions', async t => {
    const f = fixture();
    await Promise.all([f.manager.addActiveSession('x.md'), f.manager.addActiveSession('y.md')]);
    t.deepEqual((await f.manager.read()).active_sessions, ['jaskier_2026-11-14_14-25.md', 'x.md', 'y.md']);
    t.is(f.backups().length, 1);
    t.is(f.backups()[0][1], RAW);
});

test('D1: failed or unavailable listing keeps union; nested files do not count as active', async t => {
    const f = fixture();
    f.adapter.list = async () => { throw new Error('offline'); };
    t.deepEqual((await f.manager.read()).active_sessions, ['jaskier_2026-11-14_14-25.md', 'jaskier_2026-11-14_15-01.md']);
    const { read, write, exists } = f.adapter;
    t.deepEqual((await new StateManager({ adapter: { read, write, exists } }, PATH).read()).active_sessions, ['jaskier_2026-11-14_14-25.md', 'jaskier_2026-11-14_15-01.md']);
    f.adapter.list = async () => ({ files: [`${ACTIVE}/.discarded/jaskier_2026-11-14_15-01.md`] });
    t.deepEqual(await f.manager.read(), {
        active_sessions: [], archived_since_last_consolidation: 8, last_archive_at: '2026-11-14T15:02:00.000Z',
        notes_count_at_last_check: 13, last_used: null, brain_notes_limit: 15,
    });
});

test('D1: a pull during backup is not overwritten', async t => {
    const f = fixture();
    const write = f.adapter.write;
    f.adapter.write = async (path, text) => {
        await write(path, text);
        if (path.startsWith(BACKUPS)) f.files.set(PATH, '{"active_sessions":["external.md"]}');
    };
    await t.throwsAsync(f.manager.addActiveSession('x.md'), { instanceOf: StateCorruptionError });
    t.is(f.files.get(PATH), '{"active_sessions":["external.md"]}');
    t.is(f.backups()[0][1], RAW);
});

test('D1: backup collision keeps earlier copy and uses a free name', async t => {
    const f = fixture();
    const exists = f.adapter.exists;
    let occupied: string | undefined;
    f.adapter.exists = async path => {
        if (path.startsWith(BACKUPS + '/') && !occupied) { occupied = path; f.files.set(path, 'earlier conflict'); }
        return exists(path);
    };
    await f.manager.addActiveSession('x.md');
    t.is(f.files.get(PATH), CLEAN);
    t.deepEqual(f.backups(), [[occupied!, 'earlier conflict'], [occupied!.replace('.json.bak', '-1.json.bak'), RAW]]);
});
