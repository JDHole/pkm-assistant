import test, { type ExecutionContext } from 'ava';
import { mock } from 'node:test';
import { register } from 'node:module';
import { Modal } from 'obsidian';
import { AgentMemory } from '../../memory/index.js';
import { SessionWriteConsent } from '../../../core/index.js';
import { setLocale } from '../../../core/i18n/index.js';
import { __test__ as models, clearModelCache } from '../../models/modelResolver.js';
import { SessionCloseModal } from '../SessionCloseModal.js';
import { SvgHelper } from '../../crystal-soul/index.js';
import type { ChatViewLike } from './chatViewShape.js';

register('data:text/javascript,' + encodeURIComponent(`export async function load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true };
    return next(url, context);
}`));
const { ChatView } = await import('../chat_view.js');

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

function browserEvents(el: HTMLElement): void {
    Object.defineProperty(el, 'then', { value: undefined, configurable: true });
    const target = new EventTarget();
    el.addEventListener = target.addEventListener.bind(target);
    el.removeEventListener = target.removeEventListener.bind(target);
    el.dispatchEvent = target.dispatchEvent.bind(target);
    const div = el.createDiv.bind(el), span = el.createSpan.bind(el), create = el.createEl.bind(el);
    el.createDiv = options => { const child = div(options); browserEvents(child); return child; };
    el.createSpan = options => { const child = span(options); browserEvents(child); return child; };
    el.createEl = ((tag, options) => { const child = create(tag, options); browserEvents(child); return child; }) as typeof el.createEl;
}

function descendants(el: Element): Element[] {
    return [el, ...Array.from(el.children).flatMap(descendants)];
}

async function until<T>(read: () => T | undefined, description: string): Promise<T> {
    for (let attempt = 0; attempt < 200; attempt++) {
        const value = read();
        if (value !== undefined) return value;
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    throw new Error(`Nie osiągnięto: ${description}`);
}

async function fixture(t: ExecutionContext) {
    setLocale('en');
    document.hasFocus = () => true;
    const windowEvents = new EventTarget();
    window.addEventListener = windowEvents.addEventListener.bind(windowEvents);
    window.removeEventListener = windowEvents.removeEventListener.bind(windowEvents);
    const files = new Map<string, string>(), dirs = new Set<string>();
    const adapter = {
        exists: async (path: string) => files.has(path) || dirs.has(path),
        read: async (path: string) => { const value = files.get(path); if (value === undefined) throw new Error('missing'); return value; },
        write: async (path: string, value: string) => { files.set(path, value); },
        append: async (path: string, value: string) => { files.set(path, (files.get(path) ?? '') + value); },
        remove: async (path: string) => { files.delete(path); }, mkdir: async (path: string) => { dirs.add(path); },
        list: async (path: string) => ({ files: [...files.keys()].filter(p => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/')), folders: [] }),
    };
    const memory = new AgentMemory({ adapter }, 'Mira');
    await memory.ensureMemoryStructure();
    const agent = { name: 'Mira', model: 'openai/test', color: '#123456', enabled: true };
    const settings = { pkmAssistant: { enableOczko: false, enableAutoSummarization: false,
        chat: { platform: 'openai', apiKeys: { openai: 'test' } }, limits: { chat_stream_stall_timeout_ms: 0 } } };
    const app = { vault: { adapter, getMarkdownFiles: () => [] }, workspace: { getActiveFile: () => null }, metadataCache: { getFirstLinkpathDest: () => null } };
    const plugin = { app, settings, manifest: { id: 'pkm-assistant' },
        env: { settings, config: { chat: { providers: { openai: {} }, http: {}, transport: {} } } },
        agentManager: { getActiveAgent: () => agent, getActiveAgentSkills: () => [], getAgent: () => agent, getAllAgents: () => [agent],
            getActiveMemory: () => memory, getAgentMemory: () => memory, switchAgent() {}, getActiveSystemPromptWithMemory: async () => 'System' },
        mcpClient: { sessionWriteConsent: new SessionWriteConsent() }, showCrystalNotice() {},
    };
    let analysis = false, answer = 'Odpowiedź A';
    models.setChatModelFactory(() => ({ providerId: 'openai', stream(_payload: unknown, cb: { done(result: unknown): void }) {
        cb.done({ choices: [{ message: { role: 'assistant', content: analysis ? '{"new_notes":[],"na_teraz_updates":[]}' : answer } }] });
    } }) as never);
    clearModelCache();
    t.teardown(() => { models.reset(); clearModelCache(); });
    const svg = SvgHelper.toElement;
    SvgHelper.toElement = () => document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    t.teardown(() => { SvgHelper.toElement = svg; });
    const opened: Modal[] = [];
    const open = Modal.prototype.open, close = Modal.prototype.close;
    Modal.prototype.open = function () { browserEvents(this.contentEl); opened.push(this); this.onOpen(); };
    Modal.prototype.close = function () { this.onClose(); };
    t.teardown(() => { Modal.prototype.open = open; Modal.prototype.close = close; });
    const view = new ChatView({ app, id: 'lifecycle-regression' }, plugin as never) as ChatViewLike;
    browserEvents(view.container);
    await view.renderView();
    // No autosave in teardown: assertions must see only writes made by the tested flow.
    t.teardown(() => { view.attachmentManager?.destroy(); view.mentionAutocomplete?.destroy(); });
    const requests: Promise<void>[] = [];
    const newSession = view.handleNewSession.bind(view);
    view.handleNewSession = (...args) => { const run = newSession(...args); requests.push(run); return run; };
    let sending = Promise.resolve(), consolidating = Promise.resolve();
    const send = view.send_message.bind(view), consolidate = view.consolidateSession.bind(view);
    view.send_message = (...args) => { sending = send(...args); return sending; };
    view.consolidateSession = (...args) => { consolidating = consolidate(...args); return consolidating; };
    const actions = () => view._slimBar!.children[0].children[1];
    async function click(modal: Modal, label: string) {
        const button = await until(() => descendants(modal.contentEl).find(el => el.tagName.toLowerCase() === 'button' && el.textContent === label), label);
        button.dispatchEvent(new Event('click'));
    }
    async function choose(choice: 'discard' | 'archive' | 'cancel', modal: SessionCloseModal) {
        if (choice === 'discard') {
            const count = opened.length;
            // Icon labels are nested spans; use the production action layout.
            modal.contentEl.children[2].children[1].dispatchEvent(new Event('click'));
            const confirm = await until(() => opened[count], 'Confirm');
            await click(confirm, 'Confirm');
        } else {
            if (choice === 'archive') analysis = true;
            const count = opened.length;
            const button = choice === 'archive' ? modal.contentEl.children[2].children[0] : modal.contentEl.children[3].children[0];
            button.dispatchEvent(new Event('click'));
            if (choice === 'archive') {
                const review = await until(() => opened[count], 'Archive review');
                await click(review, 'Archive session');
            }
        }
        await Promise.all(requests);
        analysis = false;
    }
    return { view, memory, adapter, files, opened, requests, choose,
        newSession() { actions().children[0].dispatchEvent(new Event('click')); return requests.at(-1)!; },
        async closeModal() { return until(() => opened.filter((modal): modal is SessionCloseModal => modal instanceof SessionCloseModal).at(-1), 'New conversation'); },
        async send(question = 'Pytanie A', response = 'Odpowiedź A') {
            answer = response; view.input_area.value = question;
            view.send_button.dispatchEvent(new Event('click')); await sending;
        },
        async archive(entry: 'slash' | 'button') {
            analysis = true;
            const count = opened.length;
            const run = entry === 'slash' ? view.slashCommands.execute('/save session', { view, plugin: view.plugin })
                : (actions().children[3].dispatchEvent(new Event('click')), consolidating);
            const modal = await until(() => opened[count], 'Save session');
            await click(modal, 'Archive session'); await run; await consolidating; analysis = false;
        },
        fresh: () => new AgentMemory({ adapter: { ...adapter } }, 'Mira'),
    };
}

for (const origin of ['slash', 'button', 'unsaved'] as const)
for (const boundary of ['ready', 'file', 'state', 'pointer'] as const)
test.serial(`F8 lifecycle: ${origin}, ${boundary} → Nowa → Archive/Cancel/Discard → pełny plik następnej sesji`, async t => {
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-11T06:23:00Z') });
    t.teardown(() => mock.timers.reset());
    // Each branch starts with the same transcript and no active file. Cancel is
    // followed by a new explicit request, proving the owner/queue can be reused.
    for (const choice of ['archive', 'discard', 'cancel'] as const) {
        const f = await fixture(t);
        if (origin === 'unsaved') {
            await f.view.append_message('user', 'Pytanie A');
            await f.view.append_message('assistant', 'Odpowiedź A');
        } else {
            await f.send(); await f.archive(origin);
        }
        t.is(f.memory.activeSessionPath, null);
        t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A']);
        const entered = deferred(), release = deferred();
        const write = f.adapter.write;
        let held = false;
        f.adapter.write = async (path, text) => {
            const match = boundary === 'file' ? path.startsWith(f.memory.paths.sessionsActive + '/') && path.endsWith('.md')
                : boundary === 'state' ? path === f.memory.paths.state
                : boundary === 'pointer' && path === f.memory.paths.activeSessionMeta;
            if (!held && match) { held = true; entered.resolve(); await release.promise; }
            await write(path, text);
        };
        const run = f.newSession();
        if (boundary !== 'ready') {
            try {
                await Promise.race([entered.promise, run.then(() => { throw new Error(`Nie osiągnięto ${boundary}`); })]);
                f.newSession();
            } finally { release.resolve(); }
        }
        const modal = await f.closeModal();
        await f.choose(choice, modal);
        t.deepEqual(f.opened.filter((item): item is SessionCloseModal => item instanceof SessionCloseModal).map(item => item.messageCount), [2]);
        if (choice === 'cancel') {
            t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A']);
            t.deepEqual((await f.fresh().loadActiveSession(f.memory.activeSessionPath!)).messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A']);
            await f.send('Pytanie po Cancel', 'Odpowiedź po Cancel');
            t.deepEqual((await f.fresh().loadActiveSession(f.memory.activeSessionPath!)).messages.map(m => m.content),
                ['Pytanie A', 'Odpowiedź A', 'Pytanie po Cancel', 'Odpowiedź po Cancel']);
            const count = f.opened.length;
            f.newSession();
            const modal = await until(() => f.opened[count], 'Second New after Cancel');
            if (!(modal instanceof SessionCloseModal)) throw new Error('Expected session dialog');
            await f.choose('discard', modal);
        }
        t.is(f.memory.activeSessionPath, null, `${choice}: pamięć musi mieć pusty wskaźnik`);
        t.is(f.memory.sessionEpoch, null);
        t.is(f.view.chatTabs[0].sessionPath ?? null, null);
        t.is(f.view.chatTabs[0].sessionEpoch ?? null, null);
        t.deepEqual(JSON.parse(await f.adapter.read(f.memory.paths.activeSessionMeta)), {});
        t.deepEqual((await f.adapter.list(f.memory.paths.sessionsActive)).files, []);
        t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), []);
        const dir = choice === 'archive' ? f.memory.paths.sessionsArchive : f.memory.paths.sessionsActive + '/.discarded';
        const stored = (await f.adapter.list(dir)).files;
        t.is(stored.length, choice === 'archive' && origin !== 'unsaved' ? 2 : 1);
        for (const path of stored) t.deepEqual((await f.fresh().loadActiveSession(path)).messages.map(m => m.content), choice === 'cancel'
            ? ['Pytanie A', 'Odpowiedź A', 'Pytanie po Cancel', 'Odpowiedź po Cancel'] : ['Pytanie A', 'Odpowiedź A']);
        await f.send('Nowe pytanie', 'Nowa odpowiedź');
        t.deepEqual((await f.fresh().loadActiveSession(f.memory.activeSessionPath!)).messages.map(m => m.content), ['Nowe pytanie', 'Nowa odpowiedź']);
    }
});

for (const stage of ['selection', 'compression'] as const)
test.serial(`F8 lifecycle: dwa kliknięcia Nowa rozdzielone publikacją przy ${stage} otwierają jedno okno`, async t => {
    const f = await fixture(t);
    const header = deferred(), releaseHeader = deferred(), published = deferred(), releasePublished = deferred();
    const write = f.adapter.write;
    f.adapter.write = async (path, text) => {
        if (path.startsWith(f.memory.paths.sessionsActive + '/') && text.includes('type: active_session')) {
            header.resolve(); await releaseHeader.promise;
        }
        if (stage === 'selection' && path === f.memory.paths.activeSessionMeta) { published.resolve(); await releasePublished.promise; }
        await write(path, text);
    };
    const rw = f.view.rollingWindow;
    if (stage === 'compression') {
        rw.maxTokens = 1;
        rw._modelProvider = () => ({ stream(_payload: unknown, handlers: { done(response: unknown): void }) {
            published.resolve();
            void releasePublished.promise.then(() => { rw.maxTokens = 100000; handlers.done({ choices: [{ message: { content: 'Streszczenie' } }] }); });
        } });
    }
    t.teardown(() => { releaseHeader.resolve(); releasePublished.resolve(); });
    const sending = f.send('Pierwsze pytanie');
    await header.promise;
    f.newSession();
    releaseHeader.resolve();
    await published.promise;
    f.newSession();
    releasePublished.resolve();
    await sending;
    await f.closeModal();
    await new Promise<void>(resolve => setImmediate(resolve));
    const dialogs = f.opened.filter((modal): modal is SessionCloseModal => modal instanceof SessionCloseModal);
    // Resolve all actual dialogs so the red control run also drains every request.
    for (const modal of dialogs) modal.contentEl.children[3].children[0].dispatchEvent(new Event('click'));
    await Promise.all(f.requests);
    t.deepEqual(dialogs.map(modal => modal.messageCount), [1], 'jedno okno z jedną przyjętą wiadomością');
    t.deepEqual((await f.fresh().loadActiveSession(f.memory.activeSessionPath!)).messages.map(m => m.content), ['Pierwsze pytanie']);
});
