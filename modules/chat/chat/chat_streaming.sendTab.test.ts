import test from 'ava';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { RollingWindow } from './RollingWindow.js';
import { startEditMessage, append_message } from './chat_messages.js';
import * as streaming from './chat_streaming.js';
import { handleSaveSession, appendToActiveSession, handleNewSession } from './chat_session.js';
import { _switchTab, _renderTabBar, _closeActiveTab } from './chat_tabs.js';
import { AgentMemory } from '../../memory/index.js';
import { SubTaskRegistry, SubTaskNotifier } from '../../sub-agents/index.js';
import { SessionCloseModal } from '../SessionCloseModal.js';
import { cancelMessageEdit } from './messageEdit.js';
import { _resolveMentions } from './chat_model.js';
import { AttachmentManager, MentionAutocomplete } from '../../ui-components/index.js';
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
        const { entered, release } = creationGate(f, stage);
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
    const registrations = render.body.statements.filter(s => /this\.(input_area|send_button|stop_button)\.addEventListener/.test(s.getText(source)));
    const keydown = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'handle_input_keydown');
    if (!keydown) throw new Error('keydown missing');
    const helpers = source.statements.filter(s => ts.isFunctionDeclaration(s) && ['resetInputArea', 'handleGlobalKeydown'].includes(s.name?.text || ''));
    const code = ts.transpile(helpers.map(s => s.getText(source).replace(/^export /, '')).join('\n') + '\nthis.resetInputArea = resetInputArea; this.handleGlobalKeydown = handleGlobalKeydown;\n' + keydown.getText(source).replace(/^export /, '') + '\nthis.handle_input_keydown = handle_input_keydown;\n'
        + registrations.map(s => s.getText(source)).join('\n'), { target: ts.ScriptTarget.ES2022 });
    new Function('HUMAN_MESSAGE_META', 'cancelMessageEdit', code).call(view, HUMAN_MESSAGE_META, cancelMessageEdit);
    const globalCode = render.body.statements.filter(s => /this.handleGlobalKeydownBound =|document.addEventListener\('keydown'/.test(s.getText(source))).map(s => s.getText(source)).join('\n');
    new Function(ts.transpile(globalCode)).call(view);
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
    const stop = createEl('button');
    for (const el of [button, stop]) {
        const classes = new Set<string>();
        el.addClass = (...names) => { names.forEach(name => classes.add(name)); };
        el.removeClass = (...names) => { names.forEach(name => classes.delete(name)); };
        el.classList.contains = name => classes.has(name);
    }
    stop.addClass('hidden');
    events(input); events(button); events(stop); events(document as unknown as HTMLElement);
    const modelInputs: unknown[] = [];
    let send: Promise<void> = Promise.resolve();
    let switching: Promise<void> = Promise.resolve();
    const view = {
        ...streaming, append_message, appendToActiveSession, handleSaveSession, handleNewSession, startEditMessage,
        app: { workspace: { getActiveFile: () => null }, vault: { getAbstractFileByPath: (path: string) => ({ path, stat: { size: 1024 } }) } }, leaf: { id: 'send-tab-test' }, rollingWindow: windows[0], input_area: input, send_button: button, stop_button: stop, inputHistory: [] as string[],
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
         showTypingIndicator() {}, hideTypingIndicator() {},
        resetInputArea() { this.input_area.value = ''; }, handleInputResize() {}, _handleTriggerKeyDown() {}, _handleTriggerInput() {}, _closeTriggerPopup() {},
        _resolveMentions,
        _renderUserText(el: HTMLElement, text: string) { el.textContent = text; }, addMessageActions() {}, scrollToBottom() {}, scrollToFinalMessage() {}, _scheduleConnectorRedraw() {},
        get_chat_model: () => ({ providerId: 'openai', stream(payload: { messages: unknown }, cb: { done(value: unknown): void }) {
            modelInputs.push(payload.messages);
            cb.done({ choices: [{ message: { role: 'assistant', content: 'Odpowiedź na poprawkę A' } }] });
        } }),
        _renderCacheSavingsBadge() {}, _cleanupAskUser() {},
        _buildActiveNoteContext: async () => ({ text: '', images: [] }),
        lastMessageTimestamp: 0,
        slashCommands: { execute: async () => false },
        _chatResolveTools: () => [], async _chatOnIterationStart() {}, _chatOnUsage() {},

        send_message(opts: Parameters<typeof streaming.send_message>[0]) { send = streaming.send_message.call(view as never, opts); return send; },
        _switchTab(id: string) { switching = _switchTab.call(view as never, id); return switching; },
    };
    const mentionAutocomplete = new MentionAutocomplete(input, { app: view.app } as never);
    const equipped = Object.assign(view, { mentionAutocomplete });
    installSendListeners(equipped);
    // _renderTabBar installs the real click callback, including its key lookup.
    const bar = createDiv(), create = bar.createDiv.bind(bar);
    bar.createDiv = (options => {
        const top = create(options), child = top.createDiv.bind(top);
        top.createDiv = (opts => { const el = child(opts); events(el); return el; }) as typeof top.createDiv;
        return top;
    }) as typeof bar.createDiv;
    _renderTabBar.call(view as never, bar);
    const tabB = bar.children[0].children[1];
    return { view: equipped, memory, windows, tabs, files, adapter, modelInputs,
        clickSend() { button.dispatchEvent(new Event('click')); return send; },
        pressEnter() { input.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Enter', shiftKey: false })); return send; },
        clickA() { bar.children[0].children[0].dispatchEvent(new Event('click')); return switching; },
        clickStop() { stop.dispatchEvent(new Event('click')); },
        escape() { document.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' })); },
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
            f.view._resolveMentions = async text => { const result = await resolve.call(f.view as never, text); await hold(); return result; };
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

function holdRemoval(f: Awaited<ReturnType<typeof fixture>>) {
    const entered = deferred(), release = deferred();
    const write = f.adapter.write;
    let held = false;
    f.adapter.write = async (path, text) => {
        if (!held && text.includes('— messages removed')) {
            held = true; entered.resolve(); await release.promise;
        }
        await write(path, text);
    };
    return { entered, release };
}

for (const action of ['new-session', 'Stop', 'Escape'] as const) {
    test.serial(`F1: poprawka podczas zapisu usunięć → ${action} oddaje szkic`, async t => {
        const f = await fixture();
        const prompt = SessionCloseModal.prototype.prompt;
        SessionCloseModal.prototype.prompt = async () => ({ choice: 'discard' });
        t.teardown(() => { SessionCloseModal.prototype.prompt = prompt; f.view.attachmentManager.destroy(); f.view.mentionAutocomplete.destroy(); });
        startEditMessage.call(f.view as never, 0, 'Pytanie A');
        f.view.input_area.value = 'Poprawka A';
        const gate = holdRemoval(f);
        const run = f.clickSend();
        await gate.entered.promise;
        const stopping = action === 'new-session' ? f.view.handleNewSession.call(f.view as never)
            : action === 'Stop' ? f.clickStop() : f.escape();
        gate.release.resolve();
        await Promise.all([run, stopping]);
        t.is(f.view.input_area.value, 'Poprawka A');
        t.deepEqual(f.modelInputs, []);
        if (action === 'new-session') {
            t.is<string | undefined, undefined>(f.tabs[0].sessionPath, undefined);
            t.is(f.memory.activeSessionPath, null);
        }
        t.is(f.view.stop_button.classList.contains('hidden'), true);
    });
}

test.serial('F1: EACCES przy usunięciach przywraca poprawkę, załącznik, wzmiankę i historię', async t => {
    const f = await fixture();
    t.teardown(() => { f.view.attachmentManager.destroy(); f.view.mentionAutocomplete.destroy(); });
    startEditMessage.call(f.view as never, 0, 'Pytanie A');
    f.view.input_area.value = 'Poprawka @[Notatka]';
    f.view.attachmentManager.addTextAttachment({ name: 'A.txt', text: 'Materiał A' });
    f.view.mentionAutocomplete.restoreMentions([{ type: 'note', name: 'Notatka', path: 'Notatka.md', icon: '' }]);
    const before = f.files.get(f.tabs[0].sessionPath);
    const write = f.adapter.write;
    f.adapter.write = async (path, text) => {
        if (text.includes('— messages removed')) throw new Error('EACCES');
        await write(path, text);
    };
    // Observe rejection so the production void listener does not become an unhandled rejection.
    await f.clickSend().catch(() => {});
    t.is(f.view.input_area.value, 'Poprawka @[Notatka]');
    t.is(f.view.attachmentManager.buildMessageContent('tekst').content, '📎 Załącznik: A.txt\n```\nMateriał A\n```\n\ntekst');
    t.deepEqual(f.view.mentionAutocomplete.getMentions().map(m => m.path), ['Notatka.md']);
    t.deepEqual(f.windows[0].messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A']);
    t.is(f.files.get(f.tabs[0].sessionPath), before);
    const texts = (el: Element): string[] => [el.textContent || '', ...Array.from(el.children).flatMap(texts)];
    t.deepEqual(texts(f.view.messages_container).filter(text => text.includes('EACCES')), ['Błąd: EACCES']);
});

for (const timing of ['podczas przygotowania', 'przed mikrozadaniem doręczenia'] as const) test.serial(`F1: wynik suba ${timing} dociera dokładnie raz po turze`, async t => {
    const f = await fixture();
    const registry = new SubTaskRegistry(), notifier = new SubTaskNotifier({ registry });
    Object.assign(f.view.plugin, { subTaskRegistry: registry, subTaskNotifier: notifier });
    f.view._wireSubTaskDeliverer.call(f.view as never);
    t.teardown(() => { registry.dispose(); notifier.dispose(); f.view.attachmentManager.destroy(); f.view.mentionAutocomplete.destroy(); });
    const task = registry.create({ id: 'worker-A', name: 'worker', agentName: 'Mira', background: true,
        origin: { agentName: 'Mira', tabKey: 'A', sessionPath: f.tabs[0].sessionPath, sessionEpoch: f.tabs[0].sessionEpoch! } });
    startEditMessage.call(f.view as never, 0, 'Pytanie A');
    f.view.input_area.value = 'Poprawka A';
    const gate = holdRemoval(f);
    if (timing === 'przed mikrozadaniem doręczenia') registry.finish(task, { text: 'Dorobek A', toolsUsed: [], durationMs: 1, usage: null });
    const run = f.clickSend();
    await gate.entered.promise;
    if (timing === 'podczas przygotowania') registry.finish(task, { text: 'Dorobek A', toolsUsed: [], durationMs: 1, usage: null });
    await new Promise(resolve => setImmediate(resolve));
    const pending = notifier.pending().map(task => task.id);
    gate.release.resolve();
    await run;
    await new Promise(resolve => setTimeout(resolve, 250));
    t.deepEqual(pending, ['worker-A']);
    const result = '[POWIADOMIENIE SYSTEMU] Sub-agent worker skończył zadanie worker-A, które zleciłeś w tle.\n\n'
        + 'Stan: zakończone. Czas pracy: 0.0 s.\n\nDorobek A\n\n'
        + 'Podejmij wątek - wykorzystaj ten wynik do dokończenia zadania. Jeśli zlecałeś więcej zadań, ich wyniki przyjdą osobno; nie zgaduj ich treści.';
    t.deepEqual(f.windows[0].messages.map(m => m.content), ['Poprawka A', 'Odpowiedź na poprawkę A', result, 'Odpowiedź na poprawkę A']);
    t.deepEqual((await f.memory.loadActiveSession(f.tabs[0].sessionPath)).messages.map(m => m.content), ['Poprawka A', 'Odpowiedź na poprawkę A', result, 'Odpowiedź na poprawkę A']);
    t.deepEqual(f.modelInputs, [
        [{ role: 'system', content: 'system A' }, { role: 'user', content: 'Poprawka A' }],
        [{ role: 'system', content: 'system A' }, { role: 'user', content: 'Poprawka A' }, { role: 'assistant', content: 'Odpowiedź na poprawkę A' }, { role: 'user', content: result }],
    ]);
});

test.serial('F1: zimne exists → Nowa sesja → Odrzuć → ta sama nazwa nie cofa epoki', async t => {
    const f = await fixture();
    const prompt = SessionCloseModal.prototype.prompt, filename = AgentMemory.prototype._generateActiveSessionFilename;
    SessionCloseModal.prototype.prompt = async () => ({ choice: 'discard' });
    AgentMemory.prototype._generateActiveSessionFilename = () => 'A.md';
    t.teardown(() => { SessionCloseModal.prototype.prompt = prompt; AgentMemory.prototype._generateActiveSessionFilename = filename; f.view.attachmentManager.destroy(); f.view.mentionAutocomplete.destroy(); });
    const entered = deferred(), release = deferred();
    const exists = f.adapter.exists;
    let held = false;
    f.adapter.exists = async path => {
        if (!held && path === f.memory.paths.sessionsActive + '/A.md') { held = true; entered.resolve(); await release.promise; }
        return exists(path);
    };
    f.view.input_area.value = 'Stare pytanie';
    const old = f.clickSend();
    await entered.promise;
    await f.view.handleNewSession.call(f.view as never);
    f.view.input_area.value = 'Nowe pytanie';
    await f.clickSend();
    const epoch = f.memory.sessionEpoch;
    release.resolve();
    await old;
    t.deepEqual((await f.memory.loadActiveSession(f.memory.paths.sessionsActive + '/A.md')).messages.map(m => m.content), ['Nowe pytanie', 'Odpowiedź na poprawkę A']);
    t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Nowe pytanie', 'Odpowiedź na poprawkę A']);
    t.is(f.tabs[0].sessionEpoch, epoch);
    t.is((await f.memory.loadActiveSession(f.tabs[0].sessionPath)).metadata.epoch, epoch);
});

for (const stage of ['edit-save', 'mentions', 'epoch-readback'] as const) {
    test.serial(`F1: A → B → A przy ${stage} zachowuje nowy szkic i rzeczywistą wzmiankę`, async t => {
        const f = await fixture();
        t.teardown(() => { f.view.attachmentManager.destroy(); f.view.mentionAutocomplete.destroy(); });
        Object.assign(f.view.plugin, { permissionSystem: { checkPermission: () => ({ allowed: true }) } });
        if (stage === 'epoch-readback') {
            f.files.set(f.tabs[0].sessionPath, f.files.get(f.tabs[0].sessionPath)!.replace(/epoch: [a-f0-9]+\n/, ''));
            f.tabs[0].sessionEpoch = null; f.memory.setActiveSessionIdentity(f.tabs[0].sessionPath, null);
        }
        startEditMessage.call(f.view as never, 0, 'Pytanie A');
        f.view.input_area.value = 'Poprawka @[Notatka]';
        f.view.mentionAutocomplete.restoreMentions([{ type: 'note', name: 'Notatka', path: 'Notatka.md', icon: '' }]);
        const entered = deferred(), release = deferred();
        if (stage === 'edit-save') {
            const gate = holdRemoval(f);
            gate.entered.promise.then(entered.resolve);
            release.promise.then(gate.release.resolve);
        } else if (stage === 'mentions') {
            f.view._resolveMentions = async function(text) { const value = await _resolveMentions.call(this as never, text); entered.resolve(); await release.promise; return value; };
        } else {
            const read = f.adapter.read;
            f.adapter.read = async path => { const value = await read(path); if (value.includes('— session epoch')) { entered.resolve(); await release.promise; } return value; };
        }
        const run = f.clickSend();
        await entered.promise;
        const b = f.clickB();
        const a = f.clickA();
        f.view.input_area.value = 'Nowy szkic A';
        f.view.mentionAutocomplete.restoreMentions([{ type: 'note', name: 'Druga', path: 'Druga.md', icon: '' }]);
        const stopVisible = !f.view.stop_button.classList.contains('hidden');
        release.resolve();
        await Promise.all([run, a, b]);
        t.is(stopVisible, true);
        t.is(f.view.input_area.value, 'Nowy szkic A');
        t.deepEqual(f.view.mentionAutocomplete.getMentions().map(m => m.path), ['Druga.md']);
        t.deepEqual(f.windows[0].messages.map(m => m.content), ['User wskazał następujące pliki/foldery (użyj read żeby przeczytać potrzebne, lub oddeleguj sub-agentowi):\n- 📄 Notatka: "Notatka.md" (1KB)\n\nPoprawka @[Notatka]', 'Odpowiedź na poprawkę A']);
    });
}

async function preparationGate(f: Awaited<ReturnType<typeof fixture>>, stage: typeof stages[number]) {
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
            f.view._resolveMentions = async text => { const result = await resolve.call(f.view as never, text); await hold(); return result; };
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
            f.view._buildActiveNoteContext = async () => { await release.promise; return { text: '', images: [] }; };
            const prompt = f.view.plugin.agentManager.getActiveSystemPromptWithMemory;
            f.view.plugin.agentManager.getActiveSystemPromptWithMemory = async () => { const value = await prompt(); entered.resolve(); return value; };
        }
    return { entered, release };
}

// New session, keyboard/button Stop, and closing use the same sequence at every yield.
for (const stage of stages) for (const action of ['new-session', 'Stop', 'Escape', 'close-tab', 'close-view'] as const) {
    test.serial(`F1 faza: ${stage} → ${action}`, async t => {
        const f = await fixture();
        const prompt = SessionCloseModal.prototype.prompt;
        SessionCloseModal.prototype.prompt = async () => ({ choice: 'discard' });
        t.teardown(() => { SessionCloseModal.prototype.prompt = prompt; f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
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
        if (!['session-probe', 'session-read'].includes(stage)) startEditMessage.call(f.view as never, 0, 'Pytanie A');
        const question = stage === 'slash' ? '/Poprawione pytanie A' : 'Poprawione pytanie A';
        f.view.input_area.value = question;
        const gate = await preparationGate(f, stage);
        const run = f.clickSend();
        const stopAtAcceptance = !f.view.stop_button.classList.contains('hidden');
        await Promise.race([gate.entered.promise, run.then(() => { throw new Error(`Nie osiągnięto ${stage}`); })]);
        let stopping: Promise<void> | void = undefined;
        switch (action) {
            case 'new-session': stopping = f.view.handleNewSession.call(f.view as never); break;
            case 'Stop': f.clickStop(); break;
            case 'Escape': f.escape(); break;
            case 'close-tab': stopping = _closeActiveTab.call(f.view as never); break;
            case 'close-view': stopping = closeView(f.view); break;
            default: { const unreachable: never = action; throw new Error(`Nieznana akcja: ${unreachable}`); }
        }
        gate.release.resolve();
        await Promise.all([run, stopping]);
        t.is(stopAtAcceptance, true, 'Stop widoczny od przyjęcia wysyłki');
        t.deepEqual(f.modelInputs, []);
        if (action === 'new-session') {
            f.view.input_area.value = 'Nowa rozmowa';
            await f.clickSend();
            t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Nowa rozmowa', 'Odpowiedź na poprawkę A']);
            t.deepEqual((await f.memory.loadActiveSession(f.tabs[0].sessionPath)).messages.map(m => m.content), ['Nowa rozmowa', 'Odpowiedź na poprawkę A']);
        } else if (action === 'close-tab') {
            t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B']);
        } else if (action !== 'close-view') {
            t.is(f.view.input_area.value, ['edit-save', 'previous-removals', 'idle-save', 'slash', 'mentions'].includes(stage) ? question : '');
        }
    });
}

function closeView(view: unknown): Promise<void> {
    // Execute the actual lifecycle method without importing ChatView's CSS into Node.
    const source = ts.createSourceFile('chat_view.ts', readFileSync(new URL('../chat_view.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const klass = source.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === 'ChatView');
    if (!klass || !ts.isClassDeclaration(klass)) throw new Error('ChatView missing');
    const method = klass.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(source) === 'onClose' && m.body);
    if (!method || !ts.isMethodDeclaration(method) || !method.body) throw new Error('onClose missing');
    const code = ts.transpile('function close() ' + method.body.getText(source) + '\nreturn close.call(this);');
    return new Function(code).call(view);
}

function creationGate(f: Awaited<ReturnType<typeof fixture>>, stage: string) {
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
    return { entered, release };
}

for (const stage of ['structure', 'filename', 'header', 'state', 'question', 'selection']) {
    for (const action of ['new-session', 'Stop', 'Escape', 'close-tab', 'close-view'] as const) {
        test.serial(`F1 tworzenie: ${stage} → ${action}`, async t => {
            const f = await fixture(true);
            const prompt = SessionCloseModal.prototype.prompt;
            SessionCloseModal.prototype.prompt = async () => ({ choice: 'discard' });
            t.teardown(() => { SessionCloseModal.prototype.prompt = prompt; f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
            f.view.input_area.value = 'Pierwsze pytanie A';
            const { entered, release } = creationGate(f, stage);
            const run = f.clickSend();
            const stopVisible = !f.view.stop_button.classList.contains('hidden');
            await Promise.race([entered.promise, run.then(() => { throw new Error(`Nie osiągnięto ${stage}`); })]);
            let stopping: Promise<void> | void = undefined;
            switch (action) {
                case 'new-session': stopping = f.view.handleNewSession.call(f.view as never); break;
                case 'Stop': f.clickStop(); break;
                case 'Escape': f.escape(); break;
                case 'close-tab': stopping = _closeActiveTab.call(f.view as never); break;
                case 'close-view': stopping = closeView(f.view); break;
                default: { const unreachable: never = action; throw new Error(`Nieznana akcja: ${unreachable}`); }
            }
            release.resolve();
            await Promise.all([run, stopping]);
            t.is(stopVisible, true, 'Stop widoczny od przyjęcia wysyłki');
            t.deepEqual(f.modelInputs, []);
            if (action === 'new-session') {
                f.view.input_area.value = 'Nowa rozmowa';
                await f.clickSend();
                t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Nowa rozmowa', 'Odpowiedź na poprawkę A']);
                t.deepEqual((await f.memory.loadActiveSession(f.tabs[0].sessionPath)).messages.map(m => m.content), ['Nowa rozmowa', 'Odpowiedź na poprawkę A']);
            }
        });
    }
}

for (const route of ['A → B → A', 'błąd w tle A → B'] as const) test.serial(`F1: EACCES ${route} zachowuje nowy szkic i chipy`, async t => {
    const f = await fixture();
    t.teardown(() => { f.view.attachmentManager.destroy(); f.view.mentionAutocomplete.destroy(); });
    startEditMessage.call(f.view as never, 0, 'Pytanie A');
    f.view.input_area.value = 'Poprawka @[Notatka]';
    f.view.attachmentManager.addTextAttachment({ name: 'A.txt', text: 'Materiał A' });
    f.view.mentionAutocomplete.restoreMentions([{ type: 'note', name: 'Notatka', path: 'Notatka.md', icon: '' }]);
    const before = f.files.get(f.tabs[0].sessionPath);
    const entered = deferred(), release = deferred();
    const write = f.adapter.write;
    f.adapter.write = async (path, text) => {
        if (text.includes('— messages removed')) { entered.resolve(); await release.promise; throw new Error('EACCES'); }
        await write(path, text);
    };
    const run = f.clickSend().catch(() => {});
    await entered.promise;
    const switchingB = f.clickB();
    const switchingA = route === 'A → B → A' ? f.clickA() : undefined;
    f.view.input_area.value = 'Nowszy szkic';
    f.view.mentionAutocomplete.restoreMentions([{ type: 'note', name: 'Druga', path: 'Druga.md', icon: '' }]);
    release.resolve();
    await Promise.all([run, switchingB, switchingA]);
    if (route === 'błąd w tle A → B') {
        t.is(f.view.input_area.value, 'Nowszy szkic');
        t.deepEqual(f.view.mentionAutocomplete.getMentions().map(m => m.path), ['Druga.md']);
        await f.clickA();
    }
    t.is(f.view.input_area.value, 'Poprawka @[Notatka]\n\nNowszy szkic');
    t.is(f.view.attachmentManager.buildMessageContent('tekst').content, '📎 Załącznik: A.txt\n```\nMateriał A\n```\n\ntekst');
    t.deepEqual(f.view.mentionAutocomplete.getMentions().map(m => m.path), ['Notatka.md', 'Druga.md']);
    t.deepEqual(f.windows[0].messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A']);
    t.is(f.files.get(f.tabs[0].sessionPath), before);
});

test.serial('F1: Stop podczas slash-fallback oddaje tekst bez duplikowania zachowanych chipów', async t => {
    const f = await fixture();
    t.teardown(() => { f.view.attachmentManager.destroy(); f.view.mentionAutocomplete.destroy(); });
    startEditMessage.call(f.view as never, 0, 'Pytanie A');
    f.view.input_area.value = '/poprawka @[Notatka]';
    f.view.attachmentManager.addTextAttachment({ name: 'A.txt', text: 'Materiał A' });
    f.view.mentionAutocomplete.restoreMentions([{ type: 'note', name: 'Notatka', path: 'Notatka.md', icon: '' }]);
    const gate = await preparationGate(f, 'slash');
    const run = f.clickSend();
    await gate.entered.promise;
    f.clickStop();
    gate.release.resolve();
    await run;
    t.is(f.view.input_area.value, '/poprawka @[Notatka]');
    t.is(f.view.attachmentManager.buildMessageContent('tekst').content, '📎 Załącznik: A.txt\n```\nMateriał A\n```\n\ntekst');
    t.deepEqual(f.view.mentionAutocomplete.getMentions().map(m => m.path), ['Notatka.md']);
    t.deepEqual(f.windows[0].messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A']);
    t.deepEqual(f.modelInputs, []);
});
