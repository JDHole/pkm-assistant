import test from 'ava';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { RollingWindow } from './RollingWindow.js';
import { startEditMessage, append_message } from './chat_messages.js';
import * as streaming from './chat_streaming.js';
import { handleSaveSession, appendToActiveSession } from './chat_session.js';
import { _switchTab, _renderTabBar } from './chat_tabs.js';
import { AgentMemory } from '../../memory/index.js';
import { SubTaskRegistry, SubTaskNotifier } from '../../sub-agents/index.js';
import { AttachmentManager } from '../../ui-components/index.js';
import { setLocale } from '../../../core/i18n/index.js';
import { HUMAN_MESSAGE_META, TokenTracker } from '../../../core/index.js';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

for (const stage of ['structure', 'filename', 'header', 'state', 'question', 'selection'] as const) {
    test.serial(`P1: nowa sesja → B przy ${stage}`, async t => {
        const f = await fixture(true);
        t.teardown(() => f.view.attachmentManager.destroy());
        f.view.input_area.value = 'Pierwsze pytanie A';
        const entered = deferred(), release = deferred();
        let held = false;
        const hold = async () => { held = true; entered.resolve(); await release.promise; };
        const exists = f.adapter.exists, write = f.adapter.write, append = f.adapter.append;
        f.adapter.exists = async path => {
            if (!held && (stage === 'structure' && path === f.memory.basePath
                || stage === 'filename' && path.startsWith(f.memory.paths.sessionsActive + '/') && path !== f.tabs[1].sessionPath)) await hold();
            return exists(path);
        };
        f.adapter.write = async (path, text) => {
            if (!held && (stage === 'header' && path.startsWith(f.memory.paths.sessionsActive + '/') && text.includes('type: active_session')
                || stage === 'state' && path === f.memory.paths.state
                || stage === 'selection' && path === f.memory.paths.activeSessionMeta)) await hold();
            await write(path, text);
        };
        f.adapter.append = async (path, text) => {
            if (!held && stage === 'question' && text.includes('Pierwsze pytanie A')) await hold();
            await append(path, text);
        };
        const run = f.clickSend();
        await Promise.race([entered.promise, run.then(() => { throw new Error(`Nie osiągnięto ${stage}`); })]);
        const switching = f.clickB();
        f.view.input_area.value = 'Szkic B';
        release.resolve();
        await Promise.all([run, switching]);
        t.deepEqual(f.windows[0].messages.map(m => m.content), ['Pierwsze pytanie A', 'Odpowiedź na poprawkę A']);
        t.deepEqual((await f.memory.loadActiveSession(f.tabs[0].sessionPath)).messages.map(m => m.content), ['Pierwsze pytanie A', 'Odpowiedź na poprawkę A']);
        t.deepEqual(f.windows[1].messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B']);
        t.deepEqual((await f.memory.loadActiveSession(f.tabs[1].sessionPath)).messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B']);
        t.is(f.view.input_area.value, 'Szkic B');
        t.is(f.memory.activeSessionPath, f.memory.paths.sessionsActive + '/B.md');
        t.deepEqual(f.modelInputs, [[{ role: 'system', content: 'system A' }, { role: 'user', content: 'Pierwsze pytanie A' }]]);
    });
}

// The harness DOM deliberately has no event dispatch. Keep the production registrations,
// including the edit listeners, and give only the browser boundary a real EventTarget.
function events(element: HTMLElement) {
    const target = new EventTarget();
    element.addEventListener = target.addEventListener.bind(target);
    element.removeEventListener = target.removeEventListener.bind(target);
    element.dispatchEvent = target.dispatchEvent.bind(target);
}

function installSendListeners(view: unknown) {
    const source = ts.createSourceFile('chat_ui.ts', readFileSync(new URL('./chat_ui.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const render = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'renderView');
    if (!render || !ts.isFunctionDeclaration(render) || !render.body) throw new Error('renderView missing');
    const registrations = render.body.statements.filter(s => /this\.(input_area|send_button)\.addEventListener/.test(s.getText(source)));
    const keydown = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'handle_input_keydown');
    if (!keydown) throw new Error('keydown missing');
    const code = ts.transpile(keydown.getText(source).replace(/^export /, '') + '\nthis.handle_input_keydown = handle_input_keydown;\n'
        + registrations.map(s => s.getText(source)).join('\n'), { target: ts.ScriptTarget.ES2022 });
    new Function('HUMAN_MESSAGE_META', code).call(view, HUMAN_MESSAGE_META);
}

async function fixture(newSession = false) {
    document.hasFocus = () => true;
    setLocale('pl');
    const files = new Map<string, string>();
    const adapter = {
        exists: async (path: string) => files.has(path),
        read: async (path: string) => { if (!files.has(path)) throw new Error('missing'); return files.get(path)!; },
        write: async (path: string, text: string) => { files.set(path, text); },
        append: async (path: string, text: string) => { files.set(path, (files.get(path) ?? '') + text); },
        remove: async (path: string) => { files.delete(path); }, mkdir: async () => {}, list: async () => ({ files: [] }),
    };
    const memory = new AgentMemory({ adapter }, 'Mira');
    const seed = new AgentMemory({ adapter: { ...adapter } }, 'Mira');
    const agent = { name: 'Mira' };
    const tabs = ['A', 'B'].map((id, index) => ({ agentName: 'Mira', sessionId: id,
        sessionPath: memory.paths.sessionsActive + '/' + id + '.md', sessionEpoch: id.toLowerCase().repeat(32) as string | null, isActive: index === 0 }));
    const windows = [new RollingWindow(), new RollingWindow()];
    const trackers = [new TokenTracker(), new TokenTracker()];
    for (const [i, tab] of tabs.entries()) {
        if (newSession && i === 0) { tab.sessionPath = ''; tab.sessionEpoch = null; continue; }
        files.set(tab.sessionPath, `---\nagent: Mira\nepoch: ${tab.sessionEpoch}\n---\n`);
        await windows[i].addMessage('user', `Pytanie ${tab.sessionId}`, { origin: 'human', parentConversationText: `Pytanie ${tab.sessionId}` });
        await windows[i].addMessage('assistant', `Odpowiedź ${tab.sessionId}`);
        await seed.saveSession(windows[i].messages, {}, { expectedSession: { path: tab.sessionPath, epoch: tab.sessionEpoch } });
    }
    memory.setActiveSessionIdentity(tabs[0].sessionPath, tabs[0].sessionEpoch);
    const input = createEl('textarea'), button = createEl('button');
    events(input); events(button);
    const modelInputs: unknown[] = [];
    let send: Promise<void> = Promise.resolve();
    let switching: Promise<void> = Promise.resolve();
    const view = {
        ...streaming, append_message, appendToActiveSession, handleSaveSession, startEditMessage,
        app: { workspace: { getActiveFile: () => null } }, leaf: { id: 'send-tab-test' }, rollingWindow: windows[0], input_area: input, send_button: button, inputHistory: [] as string[],
        tokenTracker: trackers[0], chatTabs: tabs,
        attachmentManager: new AttachmentManager(createDiv(), {} as never),
        _streamCtxMap: new Map(), _preparingTurns: new Map(), _agentStates: new Map(tabs.map((tab, i) => [tab.sessionId, { rollingWindow: windows[i], tokenTracker: trackers[i], isGenerating: false }])),
        plugin: { agentManager: { getActiveAgent: () => agent, getAgent: () => agent, getAgentMemory: () => memory, getActiveMemory: () => memory,
            switchAgent() {}, getActiveSystemPromptWithMemory: async () => 'system A' }, showCrystalNotice() {} },
        env: { settings: { pkmAssistant: { enableOczko: false, enableAutoSummarization: false, limits: { chat_stream_stall_timeout_ms: 0 } } } },
        messages_container: createDiv(),
        async render_messages() { this.messages_container.empty(); }, updateTokenCounter() {}, _updateTokenPanel() {}, add_welcome_message() {},
        _getDefaultAutonomy: () => 'edge', _updateAutonomyButton() {}, updatePermissionsBadge() {}, renderSkillButtons() {}, _getAgentRgb: () => '',
        _getAgentColor: () => '#123456', _buildTokenRow() {}, _updateSlimBarTokens() {},
        _createRollingWindow: () => new RollingWindow(), is_generating: false,
        set_generating(value: boolean) { this.is_generating = value; }, showTypingIndicator() {}, hideTypingIndicator() {},
        resetInputArea() { this.input_area.value = ''; }, handleInputResize() {}, _handleTriggerKeyDown() {}, _handleTriggerInput() {}, _closeTriggerPopup() {},
        async _resolveMentions(text: string) { return { displayText: text, contextText: '' }; },
        _renderUserText(el: HTMLElement, text: string) { el.textContent = text; }, addMessageActions() {}, scrollToBottom() {}, scrollToFinalMessage() {}, _scheduleConnectorRedraw() {},
        get_chat_model: () => ({ providerId: 'openai', stream(payload: { messages: unknown }, cb: { done(value: unknown): void }) {
            modelInputs.push(payload.messages);
            cb.done({ choices: [{ message: { role: 'assistant', content: 'Odpowiedź na poprawkę A' } }] });
        } }),
        _renderCacheSavingsBadge() {},
        _buildActiveNoteContext: async () => ({ text: '', images: [] }),
        lastMessageTimestamp: 0,
        slashCommands: { execute: async () => false },
        _chatResolveTools: () => [], async _chatOnIterationStart() {}, _chatOnUsage() {},
        handle_error(error: unknown) { throw error; },
        send_message(opts: Parameters<typeof streaming.send_message>[0]) { send = streaming.send_message.call(view as never, opts); return send; },
        _switchTab(id: string) { switching = _switchTab.call(view as never, id); return switching; },
    };
    installSendListeners(view);
    // _renderTabBar installs the real click callback, including its key lookup.
    const bar = createDiv(), create = bar.createDiv.bind(bar);
    bar.createDiv = (options => {
        const top = create(options), child = top.createDiv.bind(top);
        top.createDiv = (opts => { const el = child(opts); events(el); return el; }) as typeof top.createDiv;
        return top;
    }) as typeof bar.createDiv;
    _renderTabBar.call(view as never, bar);
    const tabB = bar.children[0].children[1];
    return { view, memory, windows, tabs, files, adapter, modelInputs,
        clickSend() { button.dispatchEvent(new Event('click')); return send; },
        pressEnter() { input.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Enter', shiftKey: false })); return send; },
        clickB() { tabB.dispatchEvent(new Event('click')); return switching; },
    };
}

const stages = ['edit-save', 'previous-removals', 'idle-save', 'slash', 'mentions', 'append-message', 'journal',
    'session-probe', 'session-read', 'epoch-read', 'epoch-append', 'epoch-readback', 'prompt', 'note', 'iteration'] as const;
for (const entry of ['click', 'Enter'] as const) for (const attachments of [false, true])
for (const editing of [true, false]) for (const stage of stages) {
    if (!editing && stage === 'edit-save') continue;
    // The edit removal write warms the writer cache; only an ordinary send probes it.
    if (editing && stage === 'session-probe') continue;
    test.serial(`P1: ${entry}, ${attachments ? 'załącznik' : 'tekst'}, ${editing ? 'poprawka' : 'zwykła'} → B przy ${stage}`, async t => {
        const f = await fixture();
        t.teardown(() => f.view.attachmentManager.destroy());
        if (stage.startsWith('epoch-')) {
            f.files.set(f.tabs[0].sessionPath, f.files.get(f.tabs[0].sessionPath)!.replace(/epoch: [a-f0-9]+\n/, ''));
            f.tabs[0].sessionEpoch = null;
            f.memory.setActiveSessionIdentity(f.tabs[0].sessionPath, null);
        }
        if (stage === 'previous-removals') {
            await f.windows[0].addMessage('user', 'Usunięty szkic');
            await f.view.handleSaveSession.call(f.view as never);
            f.windows[0].removeMessages(2);
        }
        if (editing) startEditMessage.call(f.view as never, 0, 'Pytanie A');
        if (attachments) f.view.attachmentManager.addTextAttachment({ name: 'A.txt', text: 'Materiał A' });
        const question = stage === 'slash' ? '/Poprawione pytanie A' : 'Poprawione pytanie A';
        f.view.input_area.value = question;
        f.view.input_area.dispatchEvent(new Event('input'));
        t.deepEqual(f.windows[0].messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A']);
        const entered = deferred(), release = deferred();
        const hold = async () => { entered.resolve(); await release.promise; };
        if (stage === 'edit-save' || stage === 'previous-removals') {
            const write = f.adapter.write;
            let held = false;
            f.adapter.write = async (path, text) => {
                if (!held && path === f.tabs[0].sessionPath && text.includes('— messages removed')) { held = true; await hold(); }
                await write(path, text);
            };
        } else if (stage === 'idle-save') {
            f.view.lastMessageTimestamp = Date.now() - 60 * 60 * 1000;
            const save = f.view.handleSaveSession;
            f.view.handleSaveSession = async function(...args) { await save.apply(this, args); await hold(); };
        } else if (stage === 'slash') {
            f.view.slashCommands.execute = async () => { await hold(); return false; };
        } else if (stage === 'mentions') {
            const resolve = f.view._resolveMentions;
            f.view._resolveMentions = async text => { const result = await resolve(text); await hold(); return result; };
        } else if (stage === 'append-message') {
            const add = f.windows[0].addMessage.bind(f.windows[0]);
            f.windows[0].addMessage = async (...args) => { const result = await add(...args); if (args[0] === 'user') await hold(); return result; };
        } else if (stage === 'journal') {
            const append = f.adapter.append;
            let held = false;
            f.adapter.append = async (path, text) => {
                if (!held && path === f.tabs[0].sessionPath && text.includes('Poprawione pytanie A')) { held = true; await hold(); }
                await append(path, text);
            };
        } else if (stage === 'session-probe' || stage === 'session-read') {
            const read = f.adapter.read, exists = f.adapter.exists;
            let held = false;
            f.adapter.exists = async path => {
                if (!held && stage === 'session-probe' && path === f.tabs[0].sessionPath) { held = true; await hold(); }
                return exists(path);
            };
            f.adapter.read = async path => {
                if (!held && stage === 'session-read' && path === f.tabs[0].sessionPath) { held = true; await hold(); }
                return read(path);
            };
        } else if (stage.startsWith('epoch-')) {
            const read = f.adapter.read, append = f.adapter.append;
            let held = false;
            f.adapter.read = async path => {
                const content = await read(path);
                if (!held && path === f.tabs[0].sessionPath && content.includes('Poprawione pytanie A')
                    && (stage === 'epoch-read' && !content.includes('— session epoch')
                        || stage === 'epoch-readback' && content.includes('— session epoch'))) { held = true; await hold(); }
                return content;
            };
            f.adapter.append = async (path, text) => {
                if (!held && stage === 'epoch-append' && text.includes('— session epoch')) { held = true; await hold(); }
                await append(path, text);
            };
        } else if (stage === 'iteration') {
            f.view._chatOnIterationStart = hold;
        } else if (stage === 'prompt') {
            f.view.plugin.agentManager.getActiveSystemPromptWithMemory = async () => { await hold(); return 'system A'; };
        } else {
            f.view.env.settings.pkmAssistant.enableOczko = true;
            f.view._buildActiveNoteContext = async () => { await hold(); return { text: '', images: [] }; };
        }
        const run = entry === 'click' ? f.clickSend() : f.pressEnter();
        await Promise.race([entered.promise, run.then(() => { throw new Error(`Nie osiągnięto ${stage}`); })]);
        const switching = f.clickB();
        t.is(f.view.input_area.value, '', 'zaakceptowany tekst A nie przechodzi do pola B');
        f.view.input_area.value = 'Szkic B';
        f.view.attachmentManager.clear();
        f.view.attachmentManager.addTextAttachment({ name: 'B.txt', text: 'Materiał B' });
        release.resolve();
        await Promise.all([run, switching]);
        const expected = editing ? [question, 'Odpowiedź na poprawkę A'] : ['Pytanie A', 'Odpowiedź A', question, 'Odpowiedź na poprawkę A'];
        const apiQuestion = attachments ? '📎 Załącznik: A.txt\n```\nMateriał A\n```\n\n' + question : question;
        const expectedWindow = editing ? [apiQuestion, 'Odpowiedź na poprawkę A'] : ['Pytanie A', 'Odpowiedź A', apiQuestion, 'Odpowiedź na poprawkę A'];
        t.deepEqual(f.windows[0].messages.map(m => m.content), expectedWindow, 'A musi zawierać wysłane pytanie i odpowiedź');
        t.deepEqual(f.windows[1].messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B']);
        t.deepEqual((await f.memory.loadActiveSession(f.tabs[0].sessionPath)).messages.map(m => m.content), expected);
        t.deepEqual((await f.memory.loadActiveSession(f.tabs[1].sessionPath)).messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B']);
        t.is(f.view.input_area.value, 'Szkic B');
        t.is(f.view.attachmentManager.buildMessageContent('Szkic B').content, '📎 Załącznik: B.txt\n```\nMateriał B\n```\n\nSzkic B');
        t.deepEqual(f.modelInputs, [[{ role: 'system', content: 'system A' },
            ...(!editing ? [{ role: 'user', content: 'Pytanie A' }, { role: 'assistant', content: 'Odpowiedź A' }] : []),
            { role: 'user', content: apiQuestion }]]);
        t.is(f.view.is_generating, false, 'B pozostaje bezczynna');
        t.is(f.view._agentStates.get('A')?.isGenerating, false, 'A kończy generowanie');
        t.deepEqual([...f.view.messages_container.children].map(el => el.textContent), [], 'wysyłka A nie maluje dymka w B');
    });
}

for (const editing of [true, false]) for (const stage of ['stopped-message', 'stopped-journal', 'stopped-render'] as const) {
    test.serial(`P1: ${editing ? 'poprawka' : 'zwykła'} → B przy ${stage}`, async t => {
        const f = await fixture();
        const registry = new SubTaskRegistry(), notifier = new SubTaskNotifier({ registry });
        Object.assign(f.view.plugin, { subTaskRegistry: registry, subTaskNotifier: notifier });
        t.teardown(() => { registry.dispose(); notifier.dispose(); f.view.attachmentManager.destroy(); });
        const task = registry.create({ id: 'worker-A', name: 'worker', agentName: 'Mira', background: true,
            origin: { agentName: 'Mira', tabKey: 'A', sessionPath: f.tabs[0].sessionPath, sessionEpoch: f.tabs[0].sessionEpoch! } });
        registry.attachAbort(task.id, () => {});
        registry.requestStop(task.id, 'user');
        registry.finish(task, { text: 'Dorobek A', toolsUsed: [], durationMs: 1, usage: null, stoppedBy: 'abort',
            outcome: { end: { kind: 'stopped', by: 'user' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [] } });
        if (editing) startEditMessage.call(f.view as never, 0, 'Pytanie A');
        f.view.input_area.value = 'Poprawione pytanie A';
        f.view.input_area.dispatchEvent(new Event('input'));
        const entered = deferred(), release = deferred();
        const hold = async () => { entered.resolve(); await release.promise; };
        if (stage === 'stopped-message') {
            const add = f.windows[0].addMessage.bind(f.windows[0]);
            f.windows[0].addMessage = async (...args) => { await add(...args); if (args[2]?.subTaskId) await hold(); };
        } else if (stage === 'stopped-journal') {
            const append = f.adapter.append;
            f.adapter.append = async (path, text) => { if (text.includes('Dorobek A')) await hold(); await append(path, text); };
        } else {
            // renderNotificationWithReceipt awaits its detached tile after reading the DOM.
            // Resolve the browser event here: the real renderer's await yields to the click.
            const query = f.view.messages_container.querySelectorAll.bind(f.view.messages_container);
            f.view.messages_container.querySelectorAll = ((selector: string) => {
                if (selector === '[data-subtask-receipt-id]') entered.resolve();
                return query(selector);
            }) as typeof f.view.messages_container.querySelectorAll;
        }
        const run = f.clickSend();
        await Promise.race([entered.promise, run.then(() => { throw new Error(`Nie osiągnięto ${stage}`); })]);
        const switching = f.clickB();
        f.view.input_area.value = 'Szkic B';
        release.resolve();
        await Promise.all([run, switching]);
        const result = '[POWIADOMIENIE SYSTEMU] Sub-agent worker skończył zadanie worker-A, które zleciłeś w tle.\n\n'
            + 'Stan: zatrzymany przez użytkownika · wynik częściowy. Czas pracy: 0.0 s.\n\n'
            + 'Sub nie dokończył zadania. Nie wolno go raportować jako wykonanego.\n\nDorobek A\n\n'
            + 'Podejmij wątek - wykorzystaj ten wynik do dokończenia zadania. Jeśli zlecałeś więcej zadań, ich wyniki przyjdą osobno; nie zgaduj ich treści.';
        const expected = [...(editing ? [] : ['Pytanie A', 'Odpowiedź A']), 'Poprawione pytanie A', result, 'Odpowiedź na poprawkę A'];
        t.deepEqual(f.windows[0].messages.map(m => m.content), expected);
        t.deepEqual((await f.memory.loadActiveSession(f.tabs[0].sessionPath)).messages.map(m => m.content), expected);
        t.deepEqual(f.windows[1].messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B']);
        t.deepEqual((await f.memory.loadActiveSession(f.tabs[1].sessionPath)).messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B']);
        t.is(f.view.input_area.value, 'Szkic B');
        t.deepEqual([...f.view.messages_container.children].map(el => el.textContent), []);
    });
}

test.serial('P1: rozpoznane /save zapisuje historię i zachowuje załącznik do wiadomości', async t => {
    const f = await fixture();
    t.teardown(() => f.view.attachmentManager.destroy());
    // The registry imports chat_ui's CSS. Execute its real class and /save registration,
    // just as the input registrations above, without replacing command dispatch or saving.
    const source = ts.createSourceFile('SlashCommandsRegistry.ts', readFileSync(new URL('./SlashCommandsRegistry.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const registryClass = source.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === 'SlashCommandsRegistry');
    const factory = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'createDefaultSlashCommands');
    if (!registryClass || !factory || !ts.isFunctionDeclaration(factory) || !factory.body) throw new Error('Missing registry');
    const save = factory.body.statements.find(s => s.getText(source).includes("name: '/save'"));
    if (!save) throw new Error('Missing /save');
    const code = ts.transpile(registryClass.getText(source).replace(/^export /, '')
        + '\nconst registry = new SlashCommandsRegistry();\n' + save.getText(source) + '\nreturn registry;', { target: ts.ScriptTarget.ES2022 });
    f.view.slashCommands = new Function(code)();
    await f.windows[0].addMessage('assistant', 'Dopisek A');
    f.view.attachmentManager.addTextAttachment({ name: 'A.txt', text: 'Materiał A' });
    f.view.input_area.value = '/save';
    await f.clickSend();
    t.deepEqual((await f.memory.loadActiveSession(f.tabs[0].sessionPath)).messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A', 'Dopisek A']);
    t.is(f.view.attachmentManager.buildMessageContent('Następne pytanie').content, '📎 Załącznik: A.txt\n```\nMateriał A\n```\n\nNastępne pytanie');
    t.is(f.view.input_area.value, '');
    t.deepEqual(f.modelInputs, []);
});
