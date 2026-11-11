import test from 'ava';
import { mock } from 'node:test';
import { register } from 'node:module';
import { AgentMemory } from '../../memory/index.js';
import { TokenTracker, SessionWriteConsent } from '../../../core/index.js';
import { SubTaskRegistry } from '../../sub-agents/index.js';
import { setLocale } from '../../../core/i18n/index.js';
import { SessionCloseModal } from '../SessionCloseModal.js';
import { SaveSessionModal } from '../SaveSessionModal.js';
import { __test__ as models, clearModelCache } from '../../models/modelResolver.js';
import type { ChatViewLike } from './chatViewShape.js';

// Node has no CSS module loader. Only this browser resource is replaced; the whole
// ChatView and its production mixins (including rendering/listeners) run unchanged.
register('data:text/javascript,' + encodeURIComponent(`export async function load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true };
    return next(url, context);
}`));
const { ChatView } = await import('../chat_view.js');

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

// The shared Obsidian DOM boundary has no event dispatch. Give elements real
// EventTargets before renderView registers listeners, including children it creates.
function browserEvents(el: HTMLElement): void {
    const target = new EventTarget();
    el.addEventListener = target.addEventListener.bind(target);
    el.removeEventListener = target.removeEventListener.bind(target);
    el.dispatchEvent = target.dispatchEvent.bind(target);
    const div = el.createDiv.bind(el), span = el.createSpan.bind(el), create = el.createEl.bind(el);
    el.createDiv = options => { const child = div(options); browserEvents(child); return child; };
    el.createSpan = options => { const child = span(options); browserEvents(child); return child; };
    el.createEl = ((tag, options) => { const child = create(tag, options); browserEvents(child); return child; }) as typeof el.createEl;
}

async function fixture(t: import('ava').ExecutionContext, twoTabs = false, empty = false) {
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-11T06:23:00Z') });
    t.teardown(() => mock.timers.reset());
    setLocale('en');
    document.hasFocus = () => true;
    const windowEvents = new EventTarget();
    window.addEventListener = windowEvents.addEventListener.bind(windowEvents);
    window.removeEventListener = windowEvents.removeEventListener.bind(windowEvents);
    const files = new Map<string, string>(), dirs = new Set<string>();
    const adapter = {
        exists: async (path: string) => files.has(path) || dirs.has(path),
        read: async (path: string) => { const value = files.get(path); if (value === undefined) throw new Error(`Missing ${path}`); return value; },
        write: async (path: string, value: string) => { files.set(path, value); },
        append: async (path: string, value: string) => { files.set(path, (files.get(path) ?? '') + value); },
        remove: async (path: string) => { files.delete(path); },
        mkdir: async (path: string) => { dirs.add(path); },
        list: async (path: string) => ({ files: [...files.keys()].filter(p => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/')), folders: [...dirs].filter(p => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/')) }),
    };
    const memory = new AgentMemory({ adapter }, 'Mira');
    await memory.ensureMemoryStructure();
    const agent = { name: 'Mira', model: 'openai/test', color: '#123456', enabled: true };
    const settings = { pkmAssistant: { enableOczko: false, enableAutoSummarization: false,
        chat: { platform: 'openai', apiKeys: { openai: 'test' } }, limits: { chat_stream_stall_timeout_ms: 0 } } };
    const app = { vault: { adapter, getMarkdownFiles: () => [] }, workspace: { getActiveFile: () => null }, metadataCache: { getFirstLinkpathDest: () => null } };
    const registry = new SubTaskRegistry();
    const plugin = { app, settings, manifest: { id: 'pkm-assistant' },
        env: { settings, config: { chat: { providers: { openai: {} }, http: {}, transport: {} } } },
        agentManager: { getActiveAgent: () => agent, getActiveAgentSkills: () => [], getAgent: () => agent, getAllAgents: () => [agent],
            getActiveMemory: () => memory, getAgentMemory: () => memory, switchAgent() {}, getActiveSystemPromptWithMemory: async () => 'System' },
        subTaskRegistry: registry, mcpClient: { sessionWriteConsent: new SessionWriteConsent() },
        showCrystalNotice() {},
    };
    let analysis = false;
    let cancelAt: false | true | 'model' | 'retry' = false;
    let answer = 'Stara odpowiedź';
    models.setChatModelFactory(() => ({ providerId: 'openai', stream(_payload: unknown, cb: { done(result: unknown): void; error(error: Error): void }) {
        if (analysis && cancelAt === 'model') { decision.resolve({ action: 'cancel', notes: [], brainUpdates: [] }); return; }
        if (analysis && cancelAt === 'retry') { cb.error(Object.assign(new Error('test analysis stalled'), { code: 'stream_stalled' })); return; }
        cb.done({ choices: [{ message: { role: 'assistant', content: analysis ? '{"new_notes":[],"na_teraz_updates":[]}' : answer } }] });
    } }) as never);
    clearModelCache();
    t.teardown(() => { models.reset(); clearModelCache(); });
    // Plugin/leaf are the injected Obsidian host boundary. ChatView itself is real.
    const view = new ChatView({ app, id: 'archive-flow' }, plugin as never) as ChatViewLike;
    browserEvents(view.container);
    await view.renderView();
    t.teardown(async () => { await view.onClose(); });
    if (!empty) {
        await view.send_message({ injectedText: 'Stare pytanie', meta: { origin: 'human' } });
    }
    const first = view.chatTabs[0];
    const oldPath = first.sessionPath;
    const oldEpoch = first.sessionEpoch;
    if (oldPath) {
        plugin.mcpClient.sessionWriteConsent.grant(oldPath, 'Note.md');
        const owner = { agentName: 'Mira', sessionPath: oldPath, sessionEpoch: oldEpoch! };
        registry.createThread({ threadId: 'old-thread', name: 'worker', owner, origin: owner, config: {} });
        registry.create({ id: 'old-run', name: 'worker', agentName: 'Mira', threadId: 'old-thread', origin: owner });
        registry.endRun('old-thread', { successful: true, transcript: [{ role: 'assistant', content: 'Zachowany wynik suba' }] });
    }
    if (twoTabs) {
        await memory.startNewSession();
        const otherPath = await memory.startActiveSession('Mira');
        const otherWindow = view._createRollingWindow();
        await otherWindow.addMessage('user', 'Pytanie drugiej zakładki');
        await otherWindow.addMessage('assistant', 'Odpowiedź drugiej zakładki');
        await memory.saveSession(otherWindow.messages);
        view.chatTabs.push({ agentName: 'Mira', isActive: false, sessionId: otherPath, sessionPath: otherPath, sessionEpoch: memory.sessionEpoch });
        view._agentStates.set(otherPath, { rollingWindow: otherWindow, tokenTracker: new TokenTracker(), autonomy: 'edge', scrollTop: 0, isGenerating: false });
        memory.setActiveSessionIdentity(oldPath ?? null, oldEpoch ?? null);
        await memory._persistActiveSession();
    }
    view._activeTodoState = { title: 'Stare zadania', items: [{ text: 'Zachowaj', done: false }] };
    const closePrompt = SessionCloseModal.prototype.prompt, savePrompt = SaveSessionModal.prototype.prompt, proposals = SaveSessionModal.prototype.setProposals, retry = SaveSessionModal.prototype.awaitRetry;
    t.teardown(() => { SessionCloseModal.prototype.prompt = closePrompt; SaveSessionModal.prototype.prompt = savePrompt; SaveSessionModal.prototype.setProposals = proposals; SaveSessionModal.prototype.awaitRetry = retry; });
    type Decision = Awaited<ReturnType<SaveSessionModal['prompt']>>;
    let choice: 'archive' | 'discard' | 'cancel' = 'archive';
    let action: Decision['action'] = 'archive_new';
    const decision = deferred<Decision>();
    SessionCloseModal.prototype.prompt = async () => ({ choice });
    SaveSessionModal.prototype.prompt = function () {
        if (cancelAt === true) decision.resolve({ action: 'cancel', notes: [], brainUpdates: [] });
        return decision.promise;
    };
    SaveSessionModal.prototype.setProposals = function () { decision.resolve({ action, notes: [], brainUpdates: [] }); };
    SaveSessionModal.prototype.awaitRetry = function () {
        decision.resolve({ action: 'cancel', notes: [], brainUpdates: [] });
        return new Promise<void>(() => {});
    };
    const consolidationStarted = deferred<void>();
    let consolidating: Promise<void> = Promise.resolve();
    const consolidate = view.consolidateSession.bind(view);
    view.consolidateSession = (...args) => {
        consolidating = consolidate(...args);
        consolidationStarted.resolve();
        return consolidating;
    };
    let sending: Promise<void> = Promise.resolve();
    const send = view.send_message.bind(view);
    view.send_message = (...args) => { sending = send(...args); return sending; };
    let newSession: Promise<void> = Promise.resolve();
    const handleNew = view.handleNewSession.bind(view);
    view.handleNewSession = (...args) => { newSession = handleNew(...args); return newSession; };
    return { view, memory, adapter, files, first, oldPath, oldEpoch, registry, consent: plugin.mcpClient.sessionWriteConsent,
        async send() {
            view.input_area.value = 'Nowe pytanie';
            view.send_button.dispatchEvent(new Event('click'));
            await sending;
        },
        activeFiles: async () => (await adapter.list(memory.paths.sessionsActive)).files.map(p => p.split('/').pop()).sort(),
        async run(next: Decision['action'], direct: boolean | 'memory' | 'consolidate-button' = false, loading: typeof cancelAt = false, firstChoice: typeof choice = 'archive') {
            action = next; cancelAt = loading; choice = firstChoice; analysis = true;
            if (direct === true || direct === 'memory') {
                await view.slashCommands.execute(direct === true ? '/save session' : '/memory', { view, plugin: view.plugin });
            } else if (direct === 'consolidate-button') {
                view._slimBar!.children[0].children[1].children[3].dispatchEvent(new Event('click'));
                await consolidationStarted.promise;
                await consolidating;
            } else {
                // Production registration in _renderSlimBar; first icon in its actions grid.
                view._slimBar!.children[0].children[1].children[0].dispatchEvent(new Event('click'));
                await newSession;
            }
            analysis = false; answer = 'Nowa odpowiedź';
        },
    };
}

const basename = 'mira_2026-11-11_06-23.md';

for (const direct of [false, true]) test.serial(`P4: archive_new direct=${direct} → pierwsza wiadomość zostaje w jednym pliku`, async t => {
    const f = await fixture(t);
    await f.run('archive_new', direct);
    t.deepEqual(await f.activeFiles(), [basename]);
    t.is(f.first.sessionPath, f.memory.paths.sessionsActive + '/' + basename, 'nowa sesja pozostaje przypięta do zakładki');
    t.is(f.memory.activeSessionPath, f.memory.paths.sessionsActive + '/' + basename);
    t.is(f.first.sessionEpoch, f.memory.sessionEpoch);
    t.not(f.first.sessionEpoch, f.oldEpoch);
    await assertSelection(t, f, basename);
    t.is(f.view._activeTodoState, null);
    t.is(f.view._bottomBarMode, 'input');
    t.false(f.consent.has(f.oldPath!, 'Note.md'));
    const path = f.first.sessionPath!;
    await f.send();
    t.deepEqual((await f.memory.loadActiveSession(path)).messages.map(m => m.content), ['Nowe pytanie', 'Nowa odpowiedź']);
    t.deepEqual(await f.activeFiles(), [basename]);
    await assertSelection(t, f, basename);
    t.deepEqual((await f.memory.loadActiveSession(f.memory.paths.sessionsArchive + '/' + basename)).messages.map(m => m.content), ['Stare pytanie', 'Stara odpowiedź']);
});

for (const loading of [true, false, 'model', 'retry'] as const) test.serial(`P4: anulowanie drugiego okna loading=${loading} zachowuje rozmowę`, async t => {
    const f = await fixture(t);
    await f.run('cancel', false, loading);
    t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Stare pytanie', 'Stara odpowiedź']);
    t.is(f.first.sessionPath, f.memory.paths.sessionsActive + '/' + basename);
    t.is(f.memory.activeSessionPath, f.memory.paths.sessionsActive + '/' + basename);
    t.is(f.first.sessionEpoch, f.oldEpoch);
    t.deepEqual(await f.activeFiles(), [basename]);
    t.is(f.view._activeTodoState?.title, 'Stare zadania');
    t.true(f.consent.has(f.oldPath!, 'Note.md'));
    t.deepEqual(f.registry.list().map(task => task.id), ['old-run']);
    t.is(f.registry.getThread('old-thread')?.phase, 'idle');
    await assertSelection(t, f, basename);
    t.deepEqual((await f.memory.loadActiveSession(f.oldPath!)).messages.map(m => m.content), ['Stare pytanie', 'Stara odpowiedź']);
});

for (const direct of [false, true]) test.serial(`P4: archive_close direct=${direct} z dwóch zakładek zachowuje drugą rozmowę`, async t => {
    const f = await fixture(t, true);
    await f.run('archive_close', direct);
    t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Pytanie drugiej zakładki', 'Odpowiedź drugiej zakładki']);
    t.is(f.view.chatTabs.length, 1);
    t.is(f.view.chatTabs[0].sessionPath, f.memory.paths.sessionsActive + '/mira_2026-11-11_06-23_2.md');
    t.is(f.memory.activeSessionPath, f.memory.paths.sessionsActive + '/mira_2026-11-11_06-23_2.md');
    await assertSelection(t, f, 'mira_2026-11-11_06-23_2.md');
    t.is(f.view._activeTodoState, null);
    await f.send();
    t.deepEqual((await f.memory.loadActiveSession(f.memory.activeSessionPath!)).messages.map(m => m.content),
        ['Pytanie drugiej zakładki', 'Odpowiedź drugiej zakładki', 'Nowe pytanie', 'Nowa odpowiedź']);
    await assertSelection(t, f, 'mira_2026-11-11_06-23_2.md');
});

async function assertSelection(t: import('ava').ExecutionContext, f: Awaited<ReturnType<typeof fixture>>, name: string) {
    const path = f.memory.paths.sessionsActive + '/' + name;
    t.deepEqual(await f.activeFiles(), [name]);
    const state: unknown = JSON.parse(await f.adapter.read(f.memory.paths.state));
    t.like(state, { active_sessions: [name], last_used: name });
    const meta: unknown = JSON.parse(await f.adapter.read(f.memory.paths.activeSessionMeta));
    // The pointer's schema is {path, updated}; epoch belongs to the referenced file.
    t.deepEqual(meta, { path, updated: Date.parse('2026-11-11T06:23:00Z') });
    const parsed = await f.memory.loadActiveSession(path);
    const tab = f.view.chatTabs.find(tab => tab.isActive)!;
    t.regex(f.memory.sessionEpoch!, /^[a-f0-9]{32}$/);
    t.is(parsed.metadata.epoch, f.memory.sessionEpoch);
    t.is(tab.sessionEpoch, f.memory.sessionEpoch);
    t.is(tab.sessionPath, path);
    t.is(f.memory.activeSessionPath, path);
}

for (const direct of [false, true]) test.serial(`P4: zwykłe archive direct=${direct} zachowuje semantykę wejścia`, async t => {
    const f = await fixture(t);
    await f.run('archive', direct);
    t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), direct ? ['Stare pytanie', 'Stara odpowiedź'] : []);
    t.deepEqual(await f.activeFiles(), []);
    t.like(JSON.parse(await f.adapter.read(f.memory.paths.state)), { active_sessions: [], last_used: null });
    t.deepEqual(JSON.parse(await f.adapter.read(f.memory.paths.activeSessionMeta)), {});
    t.deepEqual(f.first.sessionPath, null);
    t.is(f.first.sessionEpoch, null);
    t.is(f.first.sessionId, undefined);
    t.is(f.memory.activeSessionPath, null);
    t.is(f.view._activeTodoState?.title ?? null, direct ? 'Stare zadania' : null);
    t.deepEqual((await f.memory.loadActiveSession(f.memory.paths.sessionsArchive + '/' + basename)).messages.map(m => m.content), ['Stare pytanie', 'Stara odpowiedź']);
});

for (const direct of [false, true]) test.serial(`P4: archive_close direct=${direct} ostatniej zakładki resetuje todo`, async t => {
    const f = await fixture(t);
    await f.run('archive_close', direct);
    t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), []);
    t.deepEqual(await f.activeFiles(), []);
    t.is(f.view.chatTabs.length, 0);
    t.is(f.view._activeTodoState, null);
    t.is(f.view._bottomBarMode, 'input');
    t.like(JSON.parse(await f.adapter.read(f.memory.paths.state)), { active_sessions: [], last_used: null });
    t.deepEqual(JSON.parse(await f.adapter.read(f.memory.paths.activeSessionMeta)), {});
    t.deepEqual((await f.memory.loadActiveSession(f.memory.paths.sessionsArchive + '/' + basename)).messages.map(m => m.content), ['Stare pytanie', 'Stara odpowiedź']);
});

for (const empty of [false, true]) test.serial(`P4: nowa rozmowa empty=${empty}, Discard bez sieroty`, async t => {
    const f = await fixture(t, false, empty);
    await f.run('cancel', false, false, 'discard');
    t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), []);
    t.deepEqual(await f.activeFiles(), []);
    t.like(JSON.parse(await f.adapter.read(f.memory.paths.state)), { active_sessions: [], ...(empty ? {} : { last_used: null }) });
    t.deepEqual(JSON.parse(await f.adapter.read(f.memory.paths.activeSessionMeta)), {});
    t.is(f.view._activeTodoState, null);
    t.is(f.first.sessionPath, undefined);
    if (!empty) {
        const discarded = await f.adapter.list(f.memory.paths.sessionsActive + '/.discarded');
        t.is(discarded.files.length, 1);
        t.deepEqual((await f.memory.loadActiveSession(discarded.files[0])).messages.map(m => m.content), ['Stare pytanie', 'Stara odpowiedź']);
    }
    await f.send();
    await assertSelection(t, f, basename);
    t.deepEqual((await f.memory.loadActiveSession(f.memory.activeSessionPath!)).messages.map(m => m.content), ['Nowe pytanie', 'Nowa odpowiedź']);
});

test.serial('P4: archive_new → wysłanie nie tworzy pliku _2', async t => {
    const f = await fixture(t);
    await f.run('archive_new');
    await f.send();
    t.deepEqual(await f.activeFiles(), ['mira_2026-11-11_06-23.md']);
    t.deepEqual((await f.memory.loadActiveSession(f.memory.paths.sessionsActive + '/' + basename)).messages.map(m => m.content), ['Nowe pytanie', 'Nowa odpowiedź']);
});

// Delay every storage boundary in the post-decision phase. All go through the same
// two dialogs, resume the real workflow and then send a real turn in the frozen minute.
for (const stage of ['archive-file', 'archive-state', 'clear-pointer', 'clear-before-new', 'new-file', 'new-state', 'new-pointer'] as const)
test.serial(`P4: archive_new po await ${stage} zachowuje właściciela`, async t => {
    const f = await fixture(t);
    const entered = deferred<void>(), release = deferred<void>();
    const write = f.adapter.write;
    let held = false;
    let cleared = 0;
    f.adapter.write = async (path, value) => {
        if (path === f.memory.paths.activeSessionMeta && value === '{}') cleared++;
        const matches = stage === 'archive-file' ? path.startsWith(f.memory.paths.sessionsArchive + '/')
            : stage === 'archive-state' ? path === f.memory.paths.state && value.includes('"active_sessions": []')
            : stage === 'clear-pointer' ? path === f.memory.paths.activeSessionMeta && value === '{}'
            : stage === 'clear-before-new' ? path === f.memory.paths.activeSessionMeta && value === '{}' && cleared === 2
            : stage === 'new-file' ? path.startsWith(f.memory.paths.sessionsActive + '/') && value.includes('type: active_session')
            : stage === 'new-state' ? path === f.memory.paths.state && value.includes(basename)
            : path === f.memory.paths.activeSessionMeta && value.includes(basename);
        if (!held && matches) { held = true; entered.resolve(); await release.promise; }
        await write(path, value);
    };
    const run = f.run('archive_new');
    try {
        await Promise.race([entered.promise, run.then(() => { throw new Error(`Nie osiągnięto ${stage}`); })]);
    } finally { release.resolve(); }
    await run;
    await assertSelection(t, f, basename);
    await f.send();
    await assertSelection(t, f, basename);
    t.deepEqual((await f.memory.loadActiveSession(f.memory.activeSessionPath!)).messages.map(m => m.content), ['Nowe pytanie', 'Nowa odpowiedź']);
});

test.serial('P4: archive_close czeka na zapis wyboru następnej zakładki', async t => {
    const f = await fixture(t, true);
    const entered = deferred<void>(), release = deferred<void>();
    const write = f.adapter.write;
    f.adapter.write = async (path, value) => {
        if (path === f.memory.paths.activeSessionMeta && value.includes('_2.md')) { entered.resolve(); await release.promise; }
        await write(path, value);
    };
    let finished = false;
    const run = f.run('archive_close').then(() => { finished = true; });
    try {
        await Promise.race([entered.promise, run.then(() => { throw new Error('Nie osiągnięto zapisu wyboru'); })]);
        await new Promise<void>(resolve => setImmediate(resolve));
        t.is(finished, false);
    } finally { release.resolve(); }
    await run;
    await assertSelection(t, f, 'mira_2026-11-11_06-23_2.md');
    t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Pytanie drugiej zakładki', 'Odpowiedź drugiej zakładki']);
});

for (const entry of ['memory', 'consolidate-button'] as const)
for (const action of ['archive', 'archive_new', 'archive_close', 'cancel'] as const)
test.serial(`P4: wejście ${entry} → ${action} respektuje decyzję`, async t => {
    const f = await fixture(t);
    await f.run(action, entry);
    switch (action) {
        case 'archive_new':
            await assertSelection(t, f, basename);
            await f.send();
            await assertSelection(t, f, basename);
            t.deepEqual((await f.memory.loadActiveSession(f.memory.activeSessionPath!)).messages.map(m => m.content), ['Nowe pytanie', 'Nowa odpowiedź']);
            t.is(f.view._activeTodoState, null);
            break;
        case 'archive_close':
            t.is(f.view.chatTabs.length, 0);
            t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), []);
            t.is(f.view._activeTodoState, null);
            t.deepEqual((await f.memory.loadActiveSession(f.memory.paths.sessionsArchive + '/' + basename)).messages.map(m => m.content), ['Stare pytanie', 'Stara odpowiedź']);
            break;
        case 'archive':
            t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Stare pytanie', 'Stara odpowiedź']);
            t.is(f.memory.activeSessionPath, null);
            t.deepEqual(JSON.parse(await f.adapter.read(f.memory.paths.activeSessionMeta)), {});
            t.like(JSON.parse(await f.adapter.read(f.memory.paths.state)), { active_sessions: [], last_used: null });
            t.deepEqual((await f.memory.loadActiveSession(f.memory.paths.sessionsArchive + '/' + basename)).messages.map(m => m.content), ['Stare pytanie', 'Stara odpowiedź']);
            break;
        case 'cancel':
            t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Stare pytanie', 'Stara odpowiedź']);
            await assertSelection(t, f, basename);
            t.is(f.view._activeTodoState?.title, 'Stare zadania');
            break;
        default: {
            const exhaustive: never = action;
            throw new Error(`Unexpected action: ${exhaustive}`);
        }
    }
});
