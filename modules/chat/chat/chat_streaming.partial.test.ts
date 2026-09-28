import test from 'ava';
import { send_message, stop_generation, _isTurnActiveTab, _releaseStreamCtx, handle_error, _finalizeTurn } from './chat_streaming.js';
import streamingManager from './StreamingManager.js';
import { RollingWindow } from './RollingWindow.js';
import type { ActiveSessionEventInput } from '../../memory/index.js';

type Listener = (ev: unknown) => void;

type FakeEl = {
    tagName: string;
    children: FakeEl[];
    parent: FakeEl | null;
    classList: { add(...c: string[]): void; remove(...c: string[]): void; toggle(c: string, force?: boolean): void; contains(c: string): boolean };
    className: string;
    textContent: string;
    listeners: Record<string, Listener[]>;
    appendText(text: string): void;
    empty(): void;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    removeAttribute(name: string): void;
    hasAttribute(name: string): boolean;
    appendChild(child: FakeEl): FakeEl;
    insertBefore(child: FakeEl, ref: FakeEl | null): FakeEl;
    addEventListener(type: string, cb: Listener): void;
    createDiv(opts?: { cls?: string | string[] }): FakeEl;
    createSpan(opts?: { cls?: string | string[]; text?: string }): FakeEl;
    createEl(tag: string, opts?: { cls?: string | string[]; text?: string }): FakeEl;
    querySelectorAll(): FakeEl[];
    style: { setProperty(name: string, value: string): void; getPropertyValue(name: string): string };
};

function makeFakeEl(tag = 'div'): FakeEl {
    const classes = new Set<string>();
    const attrs = new Map<string, string>();
    const styleProps = new Map<string, string>();
    let text = '';
    const el: FakeEl = {
        tagName: tag,
        style: {
            setProperty(name, value) { styleProps.set(name, value); },
            getPropertyValue(name) { return styleProps.get(name) || ''; },
        },
        children: [],
        parent: null,
        classList: {
            add: (...c) => { c.forEach(x => classes.add(x)); },
            remove: (...c) => { c.forEach(x => classes.delete(x)); },
            toggle: (c, force) => { const next = force === undefined ? !classes.has(c) : force; if (next) classes.add(c); else classes.delete(c); },
            contains: (c) => classes.has(c),
        },
        get className() { return [...classes].join(' '); },
        set className(v: string) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
        get textContent() { return text; },
        set textContent(v: string) { text = v; el.children = []; },
        appendText(t2) { text += t2; },
        empty() { text = ''; el.children = []; },
        setAttribute(name, value) { attrs.set(name, value); },
        getAttribute(name) { return attrs.has(name) ? attrs.get(name)! : null; },
        removeAttribute(name) { attrs.delete(name); },
        hasAttribute(name) { return attrs.has(name); },
        appendChild(child) { child.parent = el; el.children.push(child); return child; },
        insertBefore(child, ref) {
            child.parent = el;
            const idx = ref ? el.children.indexOf(ref) : -1;
            if (ref && idx >= 0) el.children.splice(idx, 0, child);
            else el.children.push(child);
            return child;
        },
        listeners: {},
        addEventListener(type, cb) { (el.listeners[type] ||= []).push(cb); },
        createDiv(opts) { const c = makeFakeEl('div'); if (opts?.cls) c.className = Array.isArray(opts.cls) ? opts.cls.join(' ') : opts.cls; el.appendChild(c); return c; },
        createSpan(opts) { const c = makeFakeEl('span'); if (opts?.cls) c.className = Array.isArray(opts.cls) ? opts.cls.join(' ') : opts.cls; if (opts?.text != null) c.textContent = opts.text; el.appendChild(c); return c; },
        createEl(tag2, opts) { const c = makeFakeEl(tag2); if (opts?.cls) c.className = Array.isArray(opts.cls) ? opts.cls.join(' ') : opts.cls; if (opts?.text != null) c.textContent = opts.text; el.appendChild(c); return c; },
        querySelectorAll() { return []; },
    } as FakeEl;
    return el;
}

function findByClass(root: FakeEl, cls: string): FakeEl | null {
    if (root.classList.contains(cls)) return root;
    for (const child of root.children) {
        const found = findByClass(child, cls);
        if (found) return found;
    }
    return null;
}


type TestDynamic = any;

function setup() {
    const rw = new RollingWindow(); const rwB = new RollingWindow();
    const container = makeFakeEl(); let calls = 0; let stops = 0; let paints = 0; let finals = 0;
    let heldHandlers: TestDynamic; let ready!: () => void;
    const held = new Promise<void>(resolve => { ready = resolve; });
    const events: Array<{ path: string; event: ActiveSessionEventInput }> = [];
    const memory = { activeSessionPath: 'owner-a.md', async startActiveSession() { return 'owner-a.md'; }, async appendSessionEvent(path: string, event: ActiveSessionEventInput) { events.push({ path, event }); return path; } };
    const agent = { name: 'Owner', emoji: 'O' };
    const key = 'FAKE-U3-KEY-SENTINEL-789';
    const model = { modelKey: 'synthetic', stream(_payload: unknown, handlers: TestDynamic) {
        calls++;
        if (calls === 1) handlers.done({ choices: [{ message: { content: '', tool_calls: [{ id: 'create-1', type: 'function', function: { name: 'create_folder', arguments: '{"password":"fake arg"}' } }] } }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
        else { heldHandlers = handlers; ready(); }
    }, stopStream() { stops++; } };
    const ctx: TestDynamic = {
        leaf: { id: 'u3-fixture' }, input_area: { value: '' }, inputHistory: [], rollingWindow: rw, tokenTracker: { record() {} },
        chatTabs: [{ agentName: 'Owner', sessionId: 'tab-a', isActive: true }], _streamCtxMap: new Map(), _preparingTurns: new Map(), _agentStates: new Map(),
        plugin: { agentManager: { getActiveAgent: () => agent, getAgentMemory: () => memory, getActiveSystemPromptWithMemory: async () => 'synthetic system' } },
        env: { settings: { pkmAssistant: { enableOczko: false, chat: { apiKeys: { openai: key } }, limits: { chat_max_iterations: 1, chat_stream_stall_timeout_ms: 0, model_synthesis_timeout_ms: 10000 } } } },
        messages_container: container, is_generating: false,
        set_generating(value: boolean) { this.is_generating = value; }, showTypingIndicator() {}, hideTypingIndicator() {},
        async append_message(role: 'user', content: string) { await rw.addMessage(role, content); }, async appendToActiveSession() {},
        get_chat_model: () => model,
        _chatResolveTools: () => [{ type: 'function', function: { name: 'create_folder', parameters: {} } }],
        _chatExecuteToolCall: async () => 'created Notes/U3; ' + key + ' https://user:password@test.invalid/ data:image/png;base64,AAAA',
        _chatOnIterationStart() {}, _chatOnToolCallsParsed() {}, _chatOnToolResults() {}, _chatBeforeContinue() {}, _chatOnUsage() {}, _chatOnBackstop() {},
        handle_chunk() { paints++; }, _finalizeTurn() { finals++; }, handle_error(error: unknown) { throw error; },
        _clearQueuedDrainTimer() {}, _hideQueuedIndicator() {}, _resetPaintTargets() {}, _scheduleConnectorRedraw() {},
    };
    ctx._isTurnActiveTab = _isTurnActiveTab.bind(ctx); ctx._releaseStreamCtx = _releaseStreamCtx.bind(ctx);
    return { ctx, rw, rwB, container, memory, events, held, key, counts: () => ({ calls, stops, paints, finals }), handlers: () => heldHandlers };
}

async function fakeDocument<T>(fn: () => Promise<T>): Promise<T> {
    const prev = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { createElement: (tag: string) => makeFakeEl(tag), hasFocus: () => true };
    try { return await fn(); } finally { (globalThis as Record<string, unknown>).document = prev; streamingManager.stopStream('u3-fixture::Owner'); }
}

test.serial('real send_message publishes a masked system tile before synthesis and native Stop settles hanging transport', async t => {
    await fakeDocument(async () => {
        const f = setup(); const run = send_message.call(f.ctx, { injectedText: 'synthetic create folder' });
        await f.held; const live = f.ctx._streamCtxMap.get('Owner');
        t.is(f.rw.messages.filter(m => m._loopPartial).length, 1);
        t.truthy(findByClass(f.container, 'cs-tile--system'));
        t.is(live.partial.latest.synthesis, 'pending');
        t.false(JSON.stringify(live.partial.latest).includes(f.key));
        t.false(JSON.stringify(live.partial.latest).includes('user:password'));
        stop_generation.call(f.ctx, 'Owner');
        await run; await live.partial.persisted();
        t.deepEqual(f.counts(), { calls: 2, stops: 1, paints: 0, finals: 0 });
        t.is(live.partial.latest.stopReason.kind, 'manual-stop');
        t.true(f.events.length >= 1);
        t.true(f.events.every(e => e.path === 'owner-a.md' && e.event.type === 'agent_loop_partial'));
        t.false(JSON.stringify(f.events).includes(f.key));
        f.handlers().chunk({ choices: [{ message: { content: 'late' } }] });
        f.handlers().gate_admitted?.();
        t.is(f.counts().stops, 1);
        t.is(f.counts().paints, 0);
    });
});

test.serial('owner A keeps partials after switch; late A callbacks and finally leave same-agent B untouched', async t => {
    await fakeDocument(async () => {
        const f = setup(); const run = send_message.call(f.ctx, { injectedText: 'synthetic create folder' });
        await f.held; const a = f.ctx._streamCtxMap.get('Owner');
        f.memory.activeSessionPath = 'owner-b.md';
        f.ctx.chatTabs[0].isActive = false; f.ctx.chatTabs.push({ agentName: 'Owner', sessionId: 'tab-b', isActive: true });
        f.ctx.rollingWindow = f.rwB;
        let bStops = 0;
        const b = { ...a, turnId: a.turnId + 1, rollingWindow: f.rwB, chatModel: { stopStream() { bStops++; } } };
        f.ctx._streamCtxMap.set('Owner', b); f.ctx.is_generating = true;
        const before = f.container.children.length;
        a.abort.abort('superseded');
        await run; await a.partial.persisted();
        f.handlers().chunk({ choices: [{ message: { content: 'late A' } }] }); f.handlers().gate_admitted?.();
        t.is(f.ctx._streamCtxMap.get('Owner'), b);
        t.true(f.ctx.is_generating); t.is(bStops, 0);
        t.is(f.rwB.messages.length, 0);
        t.is(f.rw.messages.filter(m => m._loopPartial).length, 1);
        t.is(f.container.children.length, before);
        t.true(f.events.every(e => e.path === 'owner-a.md'));
        t.is(a.partial.latest.stopReason.kind, 'superseded');
        t.is(streamingManager.getActiveStreams().length, 1);
        handle_error.call(f.ctx, new Error('late A error'), 'Owner', a.turnId, 'tab-a');
        await _finalizeTurn.call(f.ctx, { agentName: 'Owner', turnId: a.turnId } as never, { finalText: 'late A final' } as never);
        t.true(f.ctx.is_generating); t.is(bStops, 0); t.is(f.rwB.messages.length, 0);
    });
});
