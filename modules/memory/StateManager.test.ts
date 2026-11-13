import test from 'ava';
import { StateManager } from './StateManager.js';

const PATH = '.pkm-assistant/agents/jaskier/memory/.state.json';
const ORIGINAL = '{\n  "last_archive_at": null,\n  "extra": {"b": 2, "a": [1, 3]},\n  "archived_since_last_consolidation": 4,\n  "active_sessions": ["live.md"],\n  "last_used": "live.md"\n}\n';

function fixture(initial: string | null = ORIGINAL) {
    let content = initial;
    const writes: string[] = [];
    const adapter = {
        async exists() { return content !== null; },
        async read() {
            if (content === null) throw new Error('ENOENT');
            return content;
        },
        async write(_path: string, value: string) { writes.push(value); content = value; },
    };
    return { adapter, writes, manager: new StateManager({ adapter }, PATH) };
}

test('chat pruning an already absent empty session preserves state bytes including newline', async t => {
    const f = fixture();
    const state = await f.manager.removeActiveSession('empty.md');
    t.deepEqual(state, {
        active_sessions: ['live.md'], archived_since_last_consolidation: 4,
        last_archive_at: null, last_used: 'live.md', extra: { b: 2, a: [1, 3] },
    });
    t.is(await f.adapter.read(), ORIGINAL);
    t.is(f.writes.length, 0);
});

test('real state change writes once with newline and keeps unknown fields', async t => {
    const f = fixture();
    await f.manager.removeActiveSession('live.md');
    t.is(f.writes.length, 1);
    t.is(await f.adapter.read(), '{\n  "active_sessions": [],\n  "archived_since_last_consolidation": 4,\n  "last_archive_at": null,\n  "extra": {\n    "b": 2,\n    "a": [\n      1,\n      3\n    ]\n  },\n  "last_used": null\n}\n');
    t.deepEqual(await new StateManager({ adapter: f.adapter }, PATH).read(), {
        active_sessions: [], archived_since_last_consolidation: 4,
        last_archive_at: null, last_used: null, extra: { b: 2, a: [1, 3] },
    });
});

test('write/update/add compare all JSON values, ignoring object order but retaining array order', async t => {
    const f = fixture();
    await f.manager.write({
        extra: { a: [1, 3], b: 2 }, last_used: 'live.md', last_archive_at: null,
        active_sessions: ['live.md'], archived_since_last_consolidation: 4,
    });
    await f.manager.update(state => { state.extra = { a: [1, 3], b: 2 }; });
    await f.manager.addActiveSession('live.md');
    t.is(await f.adapter.read(), ORIGINAL);
    t.is(f.writes.length, 0);
    await f.manager.update(state => { state.extra = { a: [3, 1], b: 2 }; });
    t.is(f.writes.length, 1);
    t.deepEqual((await f.manager.read()).extra, { a: [3, 1], b: 2 });
    t.true((await f.adapter.read()).endsWith('\n'));
});

test('comparison reads fresh disk values after an external writer', async t => {
    const f = fixture();
    await f.manager.removeActiveSession('empty.md');
    await f.adapter.write(PATH, ORIGINAL.replace('"b": 2', '"b": 9'));
    f.writes.length = 0;
    await f.manager.update(state => { state.extra = { b: 2, a: [1, 3] }; });
    t.is(f.writes.length, 1);
    t.deepEqual((await f.manager.read()).extra, { b: 2, a: [1, 3] });
});

test('missing state is seeded with newline', async t => {
    const f = fixture(null);
    t.deepEqual(await f.manager.read(), {
        active_sessions: [], archived_since_last_consolidation: 0, last_archive_at: null,
    });
    t.is(f.writes.length, 1);
    t.is(await f.adapter.read(), '{\n  "active_sessions": [],\n  "archived_since_last_consolidation": 0,\n  "last_archive_at": null\n}\n');
});

test('failed comparison falls back to writing and preserves the write queue', async t => {
    const f = fixture();
    const read = f.adapter.read;
    f.adapter.read = async () => { throw new Error('offline'); };
    await f.manager.write({ active_sessions: ['new.md'] });
    t.is(f.writes.length, 1);
    f.adapter.read = read;
    t.is(await f.adapter.read(), '{\n  "active_sessions": [\n    "new.md"\n  ],\n  "archived_since_last_consolidation": 0,\n  "last_archive_at": null\n}\n');
    await f.manager.addActiveSession('next.md');
    t.is(f.writes.length, 2);
    t.deepEqual((await f.manager.read()).active_sessions, ['new.md', 'next.md']);
});

test('corrupt comparison input still permits an explicit state write', async t => {
    const f = fixture('{broken');
    await f.manager.write({ active_sessions: ['restored.md'] });
    t.is(await f.adapter.read(), '{\n  "active_sessions": [\n    "restored.md"\n  ],\n  "archived_since_last_consolidation": 0,\n  "last_archive_at": null\n}\n');
});
