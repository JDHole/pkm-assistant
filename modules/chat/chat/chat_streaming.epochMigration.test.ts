import type { SubTaskOrigin } from '../../sub-agents/index.js';
import test from 'ava';
import type { ExecutionContext } from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { send_message } from './chat_streaming.js';
import { RollingWindow } from './RollingWindow.js';
import streamingManager from './StreamingManager.js';
import { AgentMemory } from '../../memory/index.js';
import type { RollingMessage } from './RollingWindow.js';

const history = '---\ntype: active_session\nagent: Lead\n---\n\n## User\n\nHistoryczne pytanie\n\n## Assistant\n\nHistoryczna odpowiedź\n'
    + '## 2026-11-01T00:00:00Z — tool call\n\n**tool:**\n\nread\n\n**args:**\n\n{"path":"A.md"}\n\n**seq:**\n\n1\n\n'
    + '## 2026-11-01T00:00:01Z — sub task history\n\n**sub_task_history:**\n\n{"version":1,"marker":"zachowaj zdarzenie"}\n\n**seq:**\n\n2\n\n';
const historyBody = history.slice(history.indexOf('\n---\n') + 5);

function fixture() {
    const files = new Map<string, string>();
    const appends: { path: string; data: string }[] = [];
    const adapter = {
        async read(path: string) { if (!files.has(path)) throw new Error('ENOENT'); return files.get(path)!; },
        async write(path: string, data: string) { files.set(path, data); },
        async append(path: string, data: string) { appends.push({ path, data }); files.set(path, (files.get(path) ?? '') + data); },
        async remove(path: string) { files.delete(path); },
        async rename(path: string, target: string) { files.set(target, await adapter.read(path)); files.delete(path); },
        async exists(path: string) { return files.has(path); },
        async list() { return { files: [...files.keys()] }; },
        async mkdir() {},
    };
    const memory = new AgentMemory({ adapter }, 'Lead');
    const path = `${memory.paths.sessionsActive}/legacy.md`;
    files.set(path, history);
    memory.setActiveSessionIdentity(path, null);
    const requests: string[] = [], errors: string[] = [];
    const payloads = new Map<string, unknown>(), answers = new Map<string, string>();
    const origins = new Map<string, SubTaskOrigin>();
    function chat(id: string, delegation = true) {
        const rw = new RollingWindow();
        const agent = { name: 'Lead' };
        const tab = { agentName: 'Lead', sessionId: id, sessionPath: path, sessionEpoch: null as string | null, isActive: true };
        const view = {
            leaf: { id }, input_area: { value: '' }, inputHistory: [], rollingWindow: rw,
            tokenTracker: { record() {} }, chatTabs: [tab],
            _streamCtxMap: new Map(), _preparingTurns: new Map(), _agentStates: new Map(),
            plugin: { agentManager: { getActiveAgent: () => agent, getAgentMemory: () => memory,
                getActiveSystemPromptWithMemory: async () => 'system' },
                toolRegistry: { filterByAgent: () => delegation ? [{ name: 'delegate' }] : [] } },
            env: { settings: { pkmAssistant: { enableOczko: false, chat: { platform: 'ollama' }, limits: { chat_stream_stall_timeout_ms: 0 } } } },
            is_generating: false, set_generating(value: boolean) { this.is_generating = value; },
            showTypingIndicator() {},
            async append_message(role: 'user', content: RollingMessage['content'], _display: unknown, meta: Partial<RollingMessage>) { await rw.addMessage(role, content, meta); },
            appendToActiveSession: memory.appendToActiveSession.bind(memory),
            get_chat_model: () => ({ modelKey: id, providerId: 'ollama', stream(payload: Record<string, unknown>, cb: { done(response: unknown): void }) {
                requests.push(id); payloads.set(id, payload.messages);
                cb.done({ choices: [{ message: { role: 'assistant', content: `Odpowiedź ${id}` } }] });
            } }),
            _chatResolveTools: () => [], _chatOnIterationStart() {}, _chatOnToolCallsParsed() {}, _chatOnToolResults() {},
            _chatBeforeContinue() {}, _chatOnUsage() {}, _chatOnBackstop() {}, _isTurnActiveTab: () => false,
            _finalizeTurn(turn: { origin: SubTaskOrigin }, result: { finalText: string }) { answers.set(id, result.finalText); origins.set(id, turn.origin); }, handle_error(error: unknown) { errors.push(String(error)); },
        };
        return { view, tab, send: () => send_message.call(view as never, { injectedText: `Pytanie ${id}`, meta: { origin: 'human' } }),
            close: () => streamingManager.stopStream(`${id}::${id}`) };
    }
    return { files, appends, adapter, memory, path, requests, payloads, answers, origins, errors, chat };
}

// Replacements: R2 unverified backup → read failure; failed replacement → append failure;
// truncated staging → unconfirmed append. Each must retain the exact source history.
for (const failure of ['read', 'append', 'unconfirmed-append'] as const) {
    test.serial(`P2: ${failure} failure preserves exact history and leaves epoch unconfirmed`, async t => {
        const f = fixture(), chat = f.chat(failure);
        t.teardown(chat.close);
        const read = f.adapter.read, append = f.adapter.append;
        let original = '', failed = false, appends = 0;
        f.adapter.read = async path => {
            const data = await read(path);
            if (path === f.path && !original && data.includes(`Pytanie ${failure}`)) {
                original = data;
                if (failure === 'read') { failed = true; throw new Error('EACCES epoch read'); }
            }
            return data;
        };
        f.adapter.append = async (path, data) => {
            if (path === f.path && ++appends === 2) {
                failed = true;
                if (failure === 'append') throw new Error('EACCES epoch append');
                if (failure === 'unconfirmed-append') return;
            }
            await append(path, data);
        };
        await chat.send();
        t.true(failed);
        t.true(original.startsWith(history));
        t.is(await read(f.path), original);
        t.deepEqual((await f.memory.loadActiveSession(f.path)).messages.map(m => m.content),
            ['Historyczne pytanie', 'Historyczna odpowiedź', `Pytanie ${failure}`]);
        t.deepEqual(f.errors, []);
        t.deepEqual(f.requests, [failure]);
        t.is(f.answers.get(failure), `Odpowiedź ${failure}`);
        t.deepEqual([f.memory.sessionEpoch, chat.tab.sessionEpoch], [null, null]);
    });
}

test.serial('R2 b: send_message retains an independent append during the active session read', async t => {
    const f = fixture(), chat = f.chat('b');
    t.teardown(chat.close);
    const read = f.adapter.read;
    let injected = false;
    f.adapter.read = async path => {
        const data = await read(path);
        if (path === f.path && data.includes('Pytanie b') && !injected) {
            injected = true;
            await f.adapter.append(f.path, '\n## User\n\nRównoczesny dopisek\n');
        }
        return data;
    };
    await chat.send();
    t.true(injected);
    t.deepEqual((await f.memory.loadActiveSession(f.path)).messages.map(m => m.content),
        ['Historyczne pytanie', 'Historyczna odpowiedź', 'Pytanie b', 'Równoczesny dopisek']);
    t.deepEqual(f.requests, ['b']);
    t.deepEqual(f.errors, []);
});

test.serial('R2 c: two tabs sending concurrently share one confirmed migration and both reach the model', async t => {
    const f = fixture(), a = f.chat('c-a'), b = f.chat('c-b');
    t.teardown(a.close); t.teardown(b.close);
    await Promise.all([a.send(), b.send()]);
    t.deepEqual(f.requests.sort(), ['c-a', 'c-b']);
    t.deepEqual(f.payloads.get('c-a'), [{ role: 'system', content: 'system' }, { role: 'user', content: 'Pytanie c-a' }]);
    t.deepEqual(f.payloads.get('c-b'), [{ role: 'system', content: 'system' }, { role: 'user', content: 'Pytanie c-b' }]);
    t.deepEqual([...f.answers].sort(), [['c-a', 'Odpowiedź c-a'], ['c-b', 'Odpowiedź c-b']]);
    t.deepEqual(f.errors, []);
    t.regex(a.tab.sessionEpoch!, /^[0-9a-f]{32}$/);
    t.is(b.tab.sessionEpoch, a.tab.sessionEpoch);
    t.is((await f.memory.loadActiveSession(f.path)).metadata.epoch, a.tab.sessionEpoch);
    t.is(f.appends.filter(append => append.path === f.path).length, 3);
    t.is(f.appends.filter(append => append.data.includes('— session epoch')).length, 1);
    t.deepEqual((await f.memory.loadActiveSession(f.path)).messages.map(m => m.content),
        ['Historyczne pytanie', 'Historyczna odpowiedź', 'Pytanie c-a', 'Pytanie c-b']);
});

test.serial('R2 d: a real owner switch during preparation refuses the turn and leaves the original session intact', async t => {
    const f = fixture(), chat = f.chat('d');
    t.teardown(chat.close);
    const read = f.adapter.read;
    let original = '', switched = false;
    f.adapter.read = async path => {
        const data = await read(path);
        if (path === f.path && data.includes('Pytanie d') && !switched) {
            original = data; switched = true;
            f.memory.setActiveSessionIdentity('other.md', 'b'.repeat(32));
        }
        return data;
    };
    await chat.send();
    t.true(switched);
    t.deepEqual(f.requests, []);
    t.deepEqual(f.errors, ['Error: Session epoch: owner changed']);
    t.deepEqual([f.memory.activeSessionPath, f.memory.sessionEpoch, chat.tab.sessionEpoch], ['other.md', 'b'.repeat(32), null]);
    t.is(await f.adapter.read(f.path), original);
});

test.serial('R2: an external append without newline before readback survives and refreshes the writer', async t => {
    const f = fixture(), chat = f.chat('boundary');
    t.teardown(chat.close);
    const read = f.adapter.read, append = f.adapter.append;
    let appended = false, appends = 0;
    f.adapter.append = async (path, data) => {
        await append(path, data);
        if (path === f.path) appends++;
    };
    f.adapter.read = async path => {
        if (path === f.path && appends === 2 && !appended) {
            appended = true;
            await append(path, '\n## 2026-11-01T00:00:02Z — user message\n\n**seq:**\n\n9\n\n**content:**\n\nDopisek przed readbackiem');
        }
        return read(path);
    };
    await chat.send();
    t.true(appended);
    await f.memory.appendToActiveSession({ type: 'user_message', content: 'Po migracji' });
    t.deepEqual((await f.memory.loadActiveSession(f.path)).messages.map(m => m.content),
        ['Historyczne pytanie', 'Historyczna odpowiedź', 'Pytanie boundary', 'Dopisek przed readbackiem', 'Po migracji']);
    t.deepEqual((await f.memory.loadActiveSession(f.path)).messages.slice(-2).map(message => message.seq), [9, 10]);
    t.deepEqual(f.requests, ['boundary']);
    t.deepEqual(f.errors, []);
});

test.serial('R2: append from another memory instance waits for migration in the same session queue', async t => {
    const f = fixture(), chat = f.chat('queue');
    t.teardown(chat.close);
    const other = new AgentMemory({ adapter: f.adapter }, 'Lead');
    const read = f.adapter.read;
    let appended: Promise<string> | undefined;
    f.adapter.read = async path => {
        const data = await read(path);
        if (path === f.path && data.includes('Pytanie queue') && !appended) {
            appended = other.appendSessionEvent(f.path, { type: 'user_message', content: 'Dopisek z kolejki' });
        }
        return data;
    };
    await chat.send();
    await appended;
    await f.memory.appendToActiveSession({ type: 'user_message', content: 'Następny dopisek' });
    const parsed = await f.memory.loadActiveSession(f.path);
    t.deepEqual(parsed.messages.map(m => m.content),
        ['Historyczne pytanie', 'Historyczna odpowiedź', 'Pytanie queue', 'Dopisek z kolejki', 'Następny dopisek']);
    t.deepEqual(parsed.messages.slice(-2).map(message => message.seq), [5, 6]);
    t.deepEqual(f.requests, ['queue']);
    t.deepEqual(f.errors, []);
});

test.serial('R2: ordinary chat without delegation never rewrites the legacy session', async t => {
    const f = fixture(), chat = f.chat('ordinary', false);
    t.teardown(chat.close);
    f.adapter.write = async () => { throw new Error('ordinary chat must only append'); };
    await chat.send();
    t.deepEqual(f.requests, ['ordinary']);
    t.deepEqual(f.errors, []);
    t.is(f.memory.sessionEpoch, null);
    t.deepEqual((await f.memory.loadActiveSession(f.path)).messages.map(m => m.content),
        ['Historyczne pytanie', 'Historyczna odpowiedź', 'Pytanie ordinary']);
});

test.serial('R2: changing the initiating tab does not cancel its valid sibling waiting for the same migration', async t => {
    const f = fixture(), a = f.chat('sibling-a'), b = f.chat('sibling-b');
    t.teardown(a.close); t.teardown(b.close);
    const read = f.adapter.read;
    f.adapter.read = async path => {
        const data = await read(path);
        if (path === f.path && data.includes('Pytanie sibling-b')) a.tab.isActive = false;
        return data;
    };
    await Promise.all([a.send(), b.send()]);
    t.deepEqual(f.requests, ['sibling-b']);
    t.deepEqual([...f.answers], [['sibling-b', 'Odpowiedź sibling-b']]);
    t.deepEqual(f.errors, ['Error: Session epoch: owner changed']);
    t.is(a.tab.sessionEpoch, null);
    t.is((await f.memory.loadActiveSession(f.path)).metadata.epoch, b.tab.sessionEpoch);
    t.regex(b.tab.sessionEpoch!, /^[0-9a-f]{32}$/);
});


// Real files and the production send_message, like the reviewer's r3-fs-probes.ts.
function diskFixture(t: ExecutionContext) {
    const f = fixture();
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'pkm-epoch-r3-'));
    const abs = (path: string) => nodePath.join(root, path);
    fs.mkdirSync(nodePath.dirname(abs(f.path)), { recursive: true });
    fs.writeFileSync(abs(f.path), history);
    t.teardown(() => fs.rmSync(root, { recursive: true, force: true }));
    f.adapter.read = async path => fs.readFileSync(abs(path), 'utf8');
    f.adapter.write = async (path, data) => { fs.writeFileSync(abs(path), data); };
    f.adapter.append = async (path, data) => { fs.appendFileSync(abs(path), data); };
    f.adapter.rename = async (path, target) => { fs.renameSync(abs(path), abs(target)); };
    f.adapter.remove = async path => { fs.unlinkSync(abs(path)); };
    f.adapter.exists = async path => fs.existsSync(abs(path));
    f.adapter.list = async () => ({ files: fs.readdirSync(abs(f.memory.paths.sessionsActive)).map(name => `${f.memory.paths.sessionsActive}/${name}`) });
    return { ...f, abs };
}

// Replaces both recreated-source races: protect history and both owners at the I/O boundary.
for (const timing of ['read', 'readback'] as const) {
    test.serial(`P2 filesystem: owner switch during ${timing} preserves both sessions`, async t => {
        const f = diskFixture(t), chat = f.chat(`switch-${timing}`);
        t.teardown(chat.close);
        const otherPath = `${f.memory.paths.sessionsActive}/other.md`;
        const other = '---\nagent: Lead\nepoch: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n---\n\n## User\n\nInna rozmowa\n';
        await f.adapter.write(otherPath, other);
        const read = f.adapter.read, append = f.adapter.append;
        let switched = false, appends = 0;
        f.adapter.append = async (path, data) => { await append(path, data); if (path === f.path) appends++; };
        f.adapter.read = async path => {
            const data = await read(path);
            if (path === f.path && appends === (timing === 'read' ? 1 : 2) && !switched) {
                switched = true;
                await append(path, `\n## User\n\nEXTERNAL switch-${timing}\n`);
                f.memory.setActiveSessionIdentity(otherPath, 'b'.repeat(32));
            }
            return data;
        };
        await chat.send();
        t.true(switched);
        t.true((await read(f.path)).includes(historyBody));
        t.deepEqual((await f.memory.loadActiveSession(f.path)).messages.map(m => m.content),
            ['Historyczne pytanie', 'Historyczna odpowiedź', `Pytanie switch-${timing}`, `EXTERNAL switch-${timing}`]);
        t.is(await read(otherPath), other);
        t.deepEqual([f.memory.activeSessionPath, f.memory.sessionEpoch, chat.tab.sessionEpoch],
            [otherPath, 'b'.repeat(32), null]);
        t.deepEqual(f.errors, ['Error: Session epoch: owner changed']);
        t.deepEqual(f.requests, []);
    });
}

// Replaces the readback rewrite/rollback test with an actual read failure.
for (const mode of ['append', 'read-failure'] as const) {
    test.serial(`P2 filesystem: history survives ${mode} before readback`, async t => {
        const f = diskFixture(t), chat = f.chat(`readback-${mode}`);
        t.teardown(chat.close);
        const marker = '\n## User\n\nEXTERNAL readback\n';
        const read = f.adapter.read, append = f.adapter.append;
        let appends = 0, injected = false;
        f.adapter.append = async (path, data) => { await append(path, data); if (path === f.path) appends++; };
        f.adapter.read = async path => {
            if (path === f.path && appends === 2 && !injected) {
                injected = true;
                if (mode === 'read-failure') throw new Error('EACCES epoch readback');
                fs.appendFileSync(f.abs(path), marker);
            }
            return read(path);
        };
        await chat.send();
        t.true(injected);
        t.true((await read(f.path)).includes(historyBody));
        const parsed = await new AgentMemory({ adapter: f.adapter }, 'Lead').loadActiveSession(f.path);
        const expected = ['Historyczne pytanie', 'Historyczna odpowiedź', `Pytanie readback-${mode}`];
        if (mode === 'append') {
            t.deepEqual(parsed.messages.map(m => m.content), [...expected, 'EXTERNAL readback']);
            t.is(typeof parsed.metadata.epoch, 'string');
            t.regex(String(parsed.metadata.epoch), /^[0-9a-f]{32}$/);
            t.is(parsed.metadata.epoch, chat.tab.sessionEpoch);
            t.deepEqual(f.requests, ['readback-append']);
            t.deepEqual(f.errors, []);
        } else {
            t.deepEqual(parsed.messages.map(m => m.content), expected);
            t.deepEqual([f.memory.sessionEpoch, chat.tab.sessionEpoch], [null, null]);
            t.deepEqual(f.requests, ['readback-read-failure']);
            t.is(f.answers.get('readback-read-failure'), 'Odpowiedź readback-read-failure');
            t.deepEqual(f.errors, []);
        }
    });
}

test.serial('P2 filesystem: five failed epoch reads preserve history and the next send retries', async t => {
    const f = diskFixture(t), read = f.adapter.read;
    let failures = 0;
    f.adapter.read = async path => {
        const data = await read(path);
        if (path === f.path && data.includes(`Pytanie failure-${failures}`) && failures < 5) {
            failures++;
            throw new Error('EACCES epoch read');
        }
        return data;
    };
    for (let i = 0; i < 5; i++) {
        const chat = f.chat(`failure-${i}`); t.teardown(chat.close);
        await chat.send();
        t.is(f.memory.sessionEpoch, null);
    }
    t.is(failures, 5);
    t.deepEqual(f.errors, []);
    t.deepEqual([...f.answers], [0, 1, 2, 3, 4].map(i => [`failure-${i}`, `Odpowiedź failure-${i}`]));
    t.deepEqual(f.requests, ['failure-0', 'failure-1', 'failure-2', 'failure-3', 'failure-4']);
    t.true((await read(f.path)).startsWith(history));
    t.deepEqual((await f.memory.loadActiveSession(f.path)).messages.map(message => message.content),
        ['Historyczne pytanie', 'Historyczna odpowiedź', 'Pytanie failure-0', 'Pytanie failure-1', 'Pytanie failure-2', 'Pytanie failure-3', 'Pytanie failure-4']);
    const retry = f.chat('retry'); t.teardown(retry.close);
    await retry.send();
    t.deepEqual(f.requests, ['failure-0', 'failure-1', 'failure-2', 'failure-3', 'failure-4', 'retry']);
    t.regex(retry.tab.sessionEpoch!, /^[0-9a-f]{32}$/);
    t.is((await f.memory.loadActiveSession(f.path)).metadata.epoch, retry.tab.sessionEpoch);
});

test.serial('P2 filesystem: successful migration preserves history and a fresh reader confirms identity', async t => {
    const f = diskFixture(t), chat = f.chat('success');
    t.teardown(chat.close);
    const before = await f.adapter.list();
    for (const operation of ['write', 'rename', 'remove', 'mkdir'] as const) {
        f.adapter[operation] = async () => { throw new Error(`Forbidden ${operation}`); };
    }
    await chat.send();
    t.deepEqual(await f.adapter.list(), before);
    t.deepEqual(f.requests, ['success']);
    t.deepEqual(f.errors, []);
    t.true((await f.adapter.read(f.path)).startsWith(history));
    const fresh = new AgentMemory({ adapter: { ...f.adapter } }, 'Lead');
    const parsed = await fresh.loadActiveSession(f.path);
    t.is(typeof parsed.metadata.epoch, 'string');
    t.regex(String(parsed.metadata.epoch), /^[0-9a-f]{32}$/);
    t.is(parsed.metadata.epoch, chat.tab.sessionEpoch);
    t.is(parsed.metadata.epoch, f.memory.sessionEpoch);
    t.deepEqual(parsed.messages.map(m => m.content),
        ['Historyczne pytanie', 'Historyczna odpowiedź', 'Pytanie success']);
});


test.serial('P4: read-only legacy session reaches the model with an unsaved question in RAM', async t => {
    const f = fixture(), chat = f.chat('read-only');
    t.teardown(chat.close);
    f.adapter.append = async () => { throw new Error('EACCES session'); };
    await chat.send();
    t.deepEqual(f.payloads.get('read-only'), [{ role: 'system', content: 'system' }, { role: 'user', content: 'Pytanie read-only' }]);
    t.is(f.answers.get('read-only'), 'Odpowiedź read-only');
    t.deepEqual(f.origins.get('read-only')?.sessionEpochFailure, { kind: 'append-failed', detail: 'EACCES session' });
    t.deepEqual(f.errors, []);
    t.is(await f.adapter.read(f.path), history);
    t.deepEqual([f.memory.sessionEpoch, chat.tab.sessionEpoch], [null, null]);
    t.deepEqual(f.memory.getSessionEpochFailure(f.path), { kind: 'append-failed', detail: 'EACCES session' });
});

for (const kind of ['confirmed', 'owner-switch', 'window-error'] as const) {
    test.serial(`P4: question persistence catch does not swallow ${kind}`, async t => {
        const f = fixture(), chat = f.chat(kind);
        t.teardown(chat.close);
        if (kind === 'confirmed') f.memory.setActiveSessionIdentity(f.path, 'a'.repeat(32));
        if (kind === 'window-error') chat.view.append_message = async () => { throw new Error('window failed'); };
        f.adapter.append = async () => {
            if (kind === 'owner-switch') f.memory.setActiveSessionIdentity(f.path, null);
            throw new Error('EACCES question');
        };
        await t.throwsAsync(chat.send(), { message: kind === 'window-error' ? 'window failed' : 'EACCES question' });
        t.is(await f.adapter.read(f.path), history);
        t.deepEqual(f.requests, []);
    });
}
