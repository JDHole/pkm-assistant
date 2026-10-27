import test from 'ava';
import { setLocale } from '../../../core/i18n/index.js';
import { SubTaskRegistry } from '../../sub-agents/index.js';
import { _chatOnToolResults, _deliverSubTaskResult } from './chat_streaming.js';

setLocale('pl');

type FakeEl = {
    children: FakeEl[]; classList: { add(...names: string[]): void; remove(...names: string[]): void; toggle(name: string, force?: boolean): void; contains(name: string): boolean };
    className: string; textContent: string; attributes: Map<string, string>;
    listeners: Record<string, Array<(...args: never[]) => void>>;
    appendChild(child: FakeEl): FakeEl; insertBefore(child: FakeEl, before: FakeEl | null): FakeEl;
    setAttribute(name: string, value: string): void; getAttribute(name: string): string | null;
    removeAttribute(name: string): void; addEventListener(name: string, callback: (...args: never[]) => void): void;
    scrollIntoView(): void; empty(): void; appendText(text: string): void; fire(name: string, event?: unknown): void;
};

function fakeEl(): FakeEl {
    const classes = new Set<string>();
    const el = {
        children: [] as FakeEl[], attributes: new Map<string, string>(), listeners: {} as FakeEl['listeners'],
        classList: {
            add: (...names: string[]) => names.forEach(name => classes.add(name)),
            remove: (...names: string[]) => names.forEach(name => classes.delete(name)),
            toggle: (name: string, force?: boolean) => { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
            contains: (name: string) => classes.has(name),
        },
        get className() { return [...classes].join(' '); },
        set className(value: string) { classes.clear(); value.split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); },
        textContent: '',
        appendChild(child: FakeEl) { this.children.push(child); return child; },
        insertBefore(child: FakeEl, before: FakeEl | null) { const index = before ? this.children.indexOf(before) : -1; if (index < 0) this.children.push(child); else this.children.splice(index, 0, child); return child; },
        setAttribute(name: string, value: string) { this.attributes.set(name, value); },
        getAttribute(name: string) { return this.attributes.get(name) ?? null; },
        removeAttribute(name: string) { this.attributes.delete(name); },
        addEventListener(name: string, callback: (...args: never[]) => void) { (this.listeners[name] ||= []).push(callback); },
        scrollIntoView() {}, empty() { this.textContent = ''; this.children = []; }, appendText(value: string) { this.textContent += value; },
        fire(name: string, event: unknown = {}) { (this.listeners[name] || []).forEach(callback => callback(event as never)); },
    } as FakeEl;
    return el;
}

function findByClass(root: FakeEl, className: string): FakeEl | null {
    if (root.classList.contains(className)) return root;
    for (const child of root.children) { const found = findByClass(child, className); if (found) return found; }
    return null;
}

function allText(root: FakeEl): string { return root.textContent + root.children.map(allText).join(''); }

test('powiadomienie dostarcza osobne dane ramki i zachowuje tekst dla modelu', async t => {
    const registry = new SubTaskRegistry();
    const owner = { agentName: 'Jaskier', sessionPath: 'sessions/main.md', sessionEpoch: 'epoch-1', tabKey: 'tab-1' };
    const thread = registry.createThread({ threadId: 'sub-agent-7', name: 'researcher', owner, origin: owner, config: {} });
    const task = registry.create({ id: 'run-7', name: 'researcher', agentName: owner.agentName,
        background: true, origin: owner, threadId: thread.threadId });
    const outcome = { end: { kind: 'limit', reason: 'synthesis-budget' } as const,
        completeness: 'partial' as const, hasAnswer: false, hasMaterial: true,
        effects: [{ tool: 'write', action: 'create', targets: [{ kind: 'vault-file' as const, path: 'notes/result.md' }], outcome: 'returned' as const, check: 'matches' as const }] };
    const partial = { kind: 'agent-loop-partial' as const, revision: 1,
        stopReason: { kind: 'manual-stop' as const }, synthesis: 'pending' as const,
        toolsUsed: [], toolOutcomes: [], toolCallDetails: [], usage: { prompt_tokens: 0, completion_tokens: 0 },
        iterations: 1, lastText: '', text: 'zachowany fragment' };
    registry.finish(task, { text: 'wynik zachowany', handoff: 'dalszy kierunek', toolsUsed: [], durationMs: 1000,
        usage: null, outcome });
    task.partial = partial;
    task.error = 'błąd transportu';
    registry.endRun(thread.threadId, { successful: true, transcript: [], effects: [{ ...outcome.effects[0], expectedCheck: 'exists' }] });
    const sent: Array<{ injectedText: string; meta: Record<string, unknown> }> = [];
    const view = {
        chatTabs: [{ agentName: 'Jaskier', sessionPath: owner.sessionPath, sessionEpoch: owner.sessionEpoch, sessionId: owner.tabKey, isActive: true }],
        _autoTurnChainCounts: new Map(), _subTaskTurnPending: false, is_generating: false, _drainSuppressed: false,
        env: { settings: { pkmAssistant: { limits: {} } } }, plugin: { subTaskRegistry: registry },
        send_message: (opts: { injectedText: string; meta: Record<string, unknown> }) => { sent.push(opts); },
    };

    t.true(_deliverSubTaskResult.call(view as never, task));
    await Promise.resolve();

    t.is(sent[0]?.injectedText,
        '[POWIADOMIENIE SYSTEMU] Sub-agent researcher skończył zadanie run-7, które zleciłeś w tle.\n\n'
        + 'Stan: skończył mu się budżet podsumowania · wynik częściowy. Czas pracy: 1.0 s.\n\n'
        + 'Sub nie dokończył zadania. Nie wolno go raportować jako wykonanego.\n\n'
        + 'dalszy kierunek\n\nEfekt: write, cel notes/result.md, sprawdzenie: zgodny.\n\n'
        + 'Ten sam sub może dostać kolejne zadanie przez narzędzie sub_agent z akcją task i sub_id=sub-agent-7.\n\n\n'
        + 'Podejmij wątek - wykorzystaj ten wynik do dokończenia zadania. Jeśli zlecałeś więcej zadań, ich wyniki przyjdą osobno; nie zgaduj ich treści.');
    t.deepEqual(sent[0]?.meta._subTaskResult, {
        outcome,
        result: { text: 'wynik zachowany', handoff: 'dalszy kierunek' },
        partial,
        error: 'błąd transportu',
        effects: [{ ...outcome.effects[0], expectedCheck: 'exists' }],
        thread: { kind: 'reusable', sub_id: 'sub-agent-7' },
    });
    t.is(sent[0]?.meta.subTaskId, 'run-7');
    t.is(sent[0]?.meta.origin, 'machine');
});

test('notatka o dokończeniu wynika tylko z reusable sub_id', async t => {
    for (const mode of ['single', 'unknown'] as const) {
        const registry = new SubTaskRegistry();
        const owner = { agentName: 'Jaskier', tabKey: `tab-${mode}` };
        const task = registry.create({ id: `run-${mode}`, name: 'worker', agentName: owner.agentName,
            background: true, origin: owner, ...(mode === 'unknown' ? { threadId: 'opaque-thread-id' } : {}) });
        const outcome = { end: { kind: 'finished' } as const, completeness: 'unconfirmed' as const,
            hasAnswer: true, hasMaterial: true, effects: [] };
        registry.finish(task, { text: 'gotowe', toolsUsed: [], durationMs: 1000, usage: null, outcome });
        const sent: Array<{ injectedText: string; meta: Record<string, unknown> }> = [];
        const view = {
            chatTabs: [{ agentName: 'Jaskier', sessionId: `tab-${mode}`, isActive: true }],
            _autoTurnChainCounts: new Map(), _subTaskTurnPending: false, is_generating: false, _drainSuppressed: false,
            env: { settings: { pkmAssistant: { limits: {} } } }, plugin: { subTaskRegistry: registry },
            send_message: (opts: { injectedText: string; meta: Record<string, unknown> }) => { sent.push(opts); },
        };

        t.true(_deliverSubTaskResult.call(view as never, task));
        await Promise.resolve();
        t.deepEqual((sent[0]?.meta._subTaskResult as { thread: unknown }).thread,
            { kind: mode === 'single' ? 'single' : 'unknown' });
        t.false(sent[0]?.injectedText.includes('narzędzie sub_agent z akcją task i sub_id='));
    }
});

test('wynik blokujący zachowuje sub_id w adapterze i metadanych ramki', async t => {
    const output: Array<Record<string, unknown>> = [];
    const toolDisplay = { replaceWith() {} };
    const turn = {
        agentName: 'Jaskier', owner: { memory: null }, origin: {}, turnId: 1, turnKind: 'user',
        rawResults: new Map([['call-1', { result: {
            success: true, result: 'gotowe', sub_id: 'reusable-sub',
            outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true }, effects: [],
        }, error: null }]]),
        pendingEntries: [{ toolDisplay, args: { action: 'task', task: 'zrób rzecz', sub_id: 'reusable-sub' } }],
        lastRoundToolResults: [], toolCallsContainer: null, tt: { record() {} },
    };
    const view = { _isTurnActiveTab: () => true, chatTabs: [], env: {}, _updateTokenPanel() {},
        _agentStates: new Map(), tokenTracker: { record() {} }, _renderSubTaskStrip() {},
        _scheduleConnectorRedraw() {}, showTypingIndicator() {}, plugin: {} };
    const call = { id: 'call-1', name: 'sub_agent', arguments: { task: 'zrób rzecz', sub_id: 'reusable-sub' } };

    await _chatOnToolResults.call(view as never, turn as never,
        [{ toolCall: call, result: 'ok' }] as never, 0,
        (options => { output.push(options as unknown as Record<string, unknown>); return { scrollIntoView() {} } as never; }));

    const resultView = output[0]?.resultView as { notes?: string[]; material?: string; title?: string };
    t.is(output[0]?.agentName, 'reusable-sub');
    t.deepEqual(resultView?.notes, ['Agent może dokończyć tym samym subem']);
    t.is(resultView?.material, 'gotowe');
});

test('_chatOnToolResults zachowuje task_id i queued w pokwitowaniu listy', async t => {
    const originalDocument = globalThis.document;
    (globalThis as unknown as { document: unknown }).document = { createElement: () => fakeEl() };
    const receipts: HTMLElement[] = [];
    const toolDisplay = { replaceWith(...values: HTMLElement[]) { receipts.push(...values); } };
    const tasks = [
        { task_id: 'sub/run-1', name: 'researcher', sub_id: 'thread-1' },
        { task_id: 'sub/run-2', name: 'writer', sub_id: 'thread-2' },
    ];
    const turn = {
        agentName: 'Jaskier', owner: { memory: null }, origin: {}, turnId: 1, turnKind: 'user',
        rawResults: new Map([['call-queued', { result: { started: true, tasks, queued: 1 }, error: null }]]),
        pendingEntries: [{ toolDisplay, args: { action: 'task', task: 'dwa zadania' } }],
        lastRoundToolResults: [], toolCallsContainer: null, tt: { record() {} },
    };
    const view = { _isTurnActiveTab: () => true, chatTabs: [], env: {}, _updateTokenPanel() {},
        _agentStates: new Map(), _renderSubTaskStrip() {}, _scheduleConnectorRedraw() {}, showTypingIndicator() {}, plugin: {} };
    const call = { id: 'call-queued', name: 'sub_agent', arguments: { action: 'task', task: 'dwa zadania' } };

    try {
        await _chatOnToolResults.call(view as never, turn as never,
            [{ toolCall: call, result: 'accepted' }] as never, 0);

        t.deepEqual(receipts.map(row => row.getAttribute('data-subtask-receipt-id')), ['sub/run-1', 'sub/run-2']);
        const row = receipts[0] as unknown as FakeEl;
        findByClass(row, 'cs-tile__head')?.fire('click');
        t.true(allText(findByClass(row, 'cs-tile__details')!).includes('sub/run-1'));
    } finally {
        (globalThis as unknown as { document: Document }).document = originalDocument;
    }
});
