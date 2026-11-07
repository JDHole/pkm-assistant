import test from 'ava';
import { send_message } from './chat_streaming.js';
import { RollingWindow } from './RollingWindow.js';
import streamingManager from './StreamingManager.js';
import { AgentMemory } from '../../memory/index.js';
import { formatSessionEvent, parseActiveSession } from '../../memory/activeSessionFormat.js';
import type { RollingMessage } from './RollingWindow.js';

const history = '---\ntype: active_session\nagent: Lead\n---\n\n## User\n\nHistoryczne pytanie\n\n## Assistant\n\nHistoryczna odpowiedź\n'
    + formatSessionEvent('tool_call', { tool: 'read', args: { path: 'A.md' }, seq: 1 }, '2026-11-01T00:00:00Z')
    + formatSessionEvent('sub_task_history', { sub_task_history: { version: 1, marker: 'zachowaj zdarzenie' }, seq: 2 }, '2026-11-01T00:00:01Z');

function fixture() {
    const files = new Map<string, string>();
    const writes: { path: string; data: string }[] = [];
    const adapter = {
        async read(path: string) { if (!files.has(path)) throw new Error('ENOENT'); return files.get(path)!; },
        async write(path: string, data: string) { writes.push({ path, data }); files.set(path, data); },
        async append(path: string, data: string) { files.set(path, await adapter.read(path) + data); },
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
            get_chat_model: () => ({ modelKey: id, providerId: 'ollama', stream(_payload: unknown, cb: { done(response: unknown): void }) {
                requests.push(id); cb.done({ choices: [{ message: { role: 'assistant', content: 'Odpowiedź' } }] });
            } }),
            _chatResolveTools: () => [], _chatOnIterationStart() {}, _chatOnToolCallsParsed() {}, _chatOnToolResults() {},
            _chatBeforeContinue() {}, _chatOnUsage() {}, _chatOnBackstop() {}, _isTurnActiveTab: () => false,
            _finalizeTurn() {}, handle_error(error: unknown) { errors.push(String(error)); },
        };
        return { view, tab, send: () => send_message.call(view as never, { injectedText: `Pytanie ${id}`, meta: { origin: 'human' } }),
            close: () => streamingManager.stopStream(`${id}::${id}`) };
    }
    return { files, writes, adapter, memory, path, requests, errors, chat };
}

test.serial('R2 a: send_message preserves all history when write reports success with only frontmatter', async t => {
    const f = fixture(), chat = f.chat('a');
    t.teardown(chat.close);
    const write = f.adapter.write;
    let original = '', truncated = 0;
    f.adapter.write = async (path, data) => {
        if (data.includes('\nepoch:')) {
            original = await f.adapter.read(f.path); truncated++;
            return write(path, data.slice(0, data.indexOf('\n---\n') + 5));
        }
        return write(path, data);
    };
    await chat.send();
    t.is(truncated, 1);
    t.deepEqual(parseActiveSession(await f.adapter.read(f.path)).messages.map(m => m.content),
        ['Historyczne pytanie', 'Historyczna odpowiedź', 'Pytanie a']);
    t.is(await f.adapter.read(f.path), original, 'pełny oryginał, także zdarzenia, został zachowany');
    const backup = [...f.files].find(([path, data]) => path !== f.path && data === original);
    t.truthy(backup, 'trwała kopia jest dostępna po błędzie');
    t.true(f.errors.some(error => error.includes(backup![0])), 'błąd wskazuje kopię do odtworzenia');
    t.deepEqual(f.requests, []);
    t.is(f.memory.sessionEpoch, null);
});

test.serial('R2 b: send_message retains an independent append while migration is preparing its write', async t => {
    const f = fixture(), chat = f.chat('b');
    t.teardown(chat.close);
    const write = f.adapter.write;
    let injected = false;
    f.adapter.write = async (path, data) => {
        if (data.includes('\nepoch:') && !injected) {
            injected = true;
            await f.adapter.append(f.path, '\n## User\n\nRównoczesny dopisek\n');
        }
        return write(path, data);
    };
    await chat.send();
    t.true(injected);
    t.deepEqual(parseActiveSession(await f.adapter.read(f.path)).messages.map(m => m.content),
        ['Historyczne pytanie', 'Historyczna odpowiedź', 'Pytanie b', 'Równoczesny dopisek']);
    t.deepEqual(f.requests, ['b']);
    t.deepEqual(f.errors, []);
});

test.serial('R2 c: two tabs sending concurrently share one confirmed migration and both reach the model', async t => {
    const f = fixture(), a = f.chat('c-a'), b = f.chat('c-b');
    t.teardown(a.close); t.teardown(b.close);
    await Promise.all([a.send(), b.send()]);
    t.deepEqual(f.requests.sort(), ['c-a', 'c-b']);
    t.deepEqual(f.errors, []);
    t.regex(a.tab.sessionEpoch!, /^[0-9a-f]{32}$/);
    t.is(b.tab.sessionEpoch, a.tab.sessionEpoch);
    t.is(parseActiveSession(await f.adapter.read(f.path)).metadata.epoch, a.tab.sessionEpoch);
    t.is(f.writes.filter(write => write.data.includes('\nepoch:')).length, 1);
    t.deepEqual(parseActiveSession(await f.adapter.read(f.path)).messages.map(m => m.content),
        ['Historyczne pytanie', 'Historyczna odpowiedź', 'Pytanie c-a', 'Pytanie c-b']);
});

test.serial('R2 d: a real owner switch during preparation refuses the turn and leaves the original session intact', async t => {
    const f = fixture(), chat = f.chat('d');
    t.teardown(chat.close);
    const write = f.adapter.write;
    let original = '', switched = false;
    f.adapter.write = async (path, data) => {
        if (data.includes('\nepoch:') && !switched) {
            original = await f.adapter.read(f.path); switched = true;
            f.memory.setActiveSessionIdentity('other.md', 'b'.repeat(32));
        }
        return write(path, data);
    };
    await chat.send();
    t.true(switched);
    t.deepEqual(f.requests, []);
    t.deepEqual(f.errors, ['Error: Session epoch: owner changed']);
    t.deepEqual([f.memory.activeSessionPath, f.memory.sessionEpoch, chat.tab.sessionEpoch], ['other.md', 'b'.repeat(32), null]);
    t.is(await f.adapter.read(f.path), original);
});

test.serial('R2: failed replacement restores the exact source and retains a usable backup', async t => {
    const f = fixture(), chat = f.chat('rollback');
    t.teardown(chat.close);
    const rename = f.adapter.rename;
    let original = '';
    f.adapter.rename = async (path, target) => {
        if (path.endsWith('.prepared')) {
            original = [...f.files].find(([name]) => name.endsWith('.bak'))![1];
            await rename(path, target);
            f.files.set(target, '---\nepoch: ' + 'a'.repeat(32) + '\n---\n');
            throw new Error('rename failed after replacing bytes');
        }
        return rename(path, target);
    };
    await chat.send();
    t.is(await f.adapter.read(f.path), original);
    t.true(original.startsWith(history));
    t.true(f.errors[0].includes('original restored; backup:'));
    t.is(f.files.get(f.errors[0].split('backup: ')[1]), original);
    t.deepEqual(f.requests, []);
    t.is(f.memory.sessionEpoch, null);
});

test.serial('R2: no verified backup means no replacement of the source', async t => {
    const f = fixture(), chat = f.chat('backup');
    t.teardown(chat.close);
    const write = f.adapter.write;
    f.adapter.write = (path, data) => write(path, path.endsWith('.bak') ? 'damaged backup' : data);
    await chat.send();
    t.deepEqual(parseActiveSession(await f.adapter.read(f.path)).messages.map(m => m.content),
        ['Historyczne pytanie', 'Historyczna odpowiedź', 'Pytanie backup']);
    t.deepEqual(f.errors, [`Error: Session epoch: backup verification failed; source untouched: ${f.path}`]);
    t.deepEqual(f.requests, []);
});

test.serial('R2: a last-moment external append is retained in the displaced original and retried', async t => {
    const f = fixture(), chat = f.chat('boundary');
    t.teardown(chat.close);
    const rename = f.adapter.rename;
    let appended = false;
    f.adapter.rename = async (path, target) => {
        if (path === f.path && !appended) {
            appended = true;
            await f.adapter.append(path, formatSessionEvent('user_message', { content: 'Dopisek przy zastąpieniu', seq: 9 }, '2026-11-01T00:00:02Z').trimEnd());
        }
        return rename(path, target);
    };
    await chat.send();
    await f.memory.appendToActiveSession({ type: 'user_message', content: 'Po migracji' });
    t.deepEqual(parseActiveSession(await f.adapter.read(f.path)).messages.map(m => m.content),
        ['Historyczne pytanie', 'Historyczna odpowiedź', 'Pytanie boundary', 'Dopisek przy zastąpieniu', 'Po migracji']);
    t.deepEqual(parseActiveSession(await f.adapter.read(f.path)).messages.slice(-2).map(message => message.seq), [9, 10]);
    t.deepEqual(f.requests, ['boundary']);
    t.deepEqual(f.errors, []);
});

test.serial('R2: append from another memory instance waits for migration in the same session queue', async t => {
    const f = fixture(), chat = f.chat('queue');
    t.teardown(chat.close);
    const other = new AgentMemory({ adapter: f.adapter }, 'Lead');
    const write = f.adapter.write;
    let appended: Promise<string> | undefined;
    f.adapter.write = async (path, data) => {
        if (path.endsWith('.prepared')) {
            appended = other.appendSessionEvent(f.path, { type: 'user_message', content: 'Dopisek z kolejki' });
        }
        return write(path, data);
    };
    await chat.send();
    await appended;
    await f.memory.appendToActiveSession({ type: 'user_message', content: 'Następny dopisek' });
    const parsed = await f.memory.loadActiveSession(f.path);
    t.deepEqual(parsed.messages.map(m => m.content),
        ['Historyczne pytanie', 'Historyczna odpowiedź', 'Pytanie queue', 'Dopisek z kolejki', 'Następny dopisek']);
    t.deepEqual(parsed.messages.slice(-2).map(message => message.seq), [4, 5]);
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
    t.deepEqual(parseActiveSession(await f.adapter.read(f.path)).messages.map(m => m.content),
        ['Historyczne pytanie', 'Historyczna odpowiedź', 'Pytanie ordinary']);
});

test.serial('R2: changing the initiating tab does not cancel its valid sibling waiting for the same migration', async t => {
    const f = fixture(), a = f.chat('sibling-a'), b = f.chat('sibling-b');
    t.teardown(a.close); t.teardown(b.close);
    const write = f.adapter.write;
    f.adapter.write = async (path, data) => {
        if (path.endsWith('.prepared')) a.tab.isActive = false;
        return write(path, data);
    };
    await Promise.all([a.send(), b.send()]);
    t.deepEqual(f.requests, ['sibling-b']);
    t.deepEqual(f.errors, ['Error: Session epoch: owner changed']);
    t.is(a.tab.sessionEpoch, null);
    t.is((await f.memory.loadActiveSession(f.path)).metadata.epoch, b.tab.sessionEpoch);
    t.regex(b.tab.sessionEpoch!, /^[0-9a-f]{32}$/);
});
