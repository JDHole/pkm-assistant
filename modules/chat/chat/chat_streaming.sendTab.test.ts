import test from 'ava';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { RollingWindow } from './RollingWindow.js';
import { startEditMessage, append_message, render_messages } from './chat_messages.js';
import * as streaming from './chat_streaming.js';
import { handleSaveSession, appendToActiveSession, handleNewSession, initSessionManager, handleLoadSession, _restoreActiveSession, consolidateSession } from './chat_session.js';
import { _switchTab, _renderTabBar, _closeActiveTab } from './chat_tabs.js';
import { AgentMemory } from '../../memory/index.js';
import { SubTaskRegistry, SubTaskNotifier } from '../../sub-agents/index.js';
import { SaveSessionModal } from '../SaveSessionModal.js';
import { OpenSessionModal } from '../OpenSessionModal.js';
import { SessionCloseModal } from '../SessionCloseModal.js';
import { MarkdownRenderer, Notice } from 'obsidian';
import { t as translate } from '../../../core/i18n/index.js';
import { log } from '../../../core/utils/Logger.js';
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

for (const stage of ['mentions', 'note', 'slash', 'session-probe', 'session-read', 'edit-save', 'journal', 'append-message'] as const) for (const action of ['Stop', 'Escape', 'new-cancel', 'close-tab', 'close-view'] as const) {
    test.serial(`F6: ${stage} → ${action} zachowuje pełną rozmowę na granicy przyjęcia`, async t => {
        const f = await fixture();
        const prompt = SessionCloseModal.prototype.prompt;
        SessionCloseModal.prototype.prompt = async () => ({ choice: 'cancel' });
        t.teardown(() => { SessionCloseModal.prototype.prompt = prompt; f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
        startEditMessage.call(f.view as never, 0, 'Pytanie A');
        const phaseA = ['mentions', 'note', 'slash', 'session-probe', 'session-read'].includes(stage);
        const text = stage === 'slash' ? '/Poprawione pytanie A' : 'Poprawione pytanie A';
        f.view.input_area.value = text;
        const path = f.tabs[0].sessionPath;
        const gate = await preparationGate(f, stage);
        const run = f.clickSend();
        await gate.entered.promise;
        const stopping = action === 'new-cancel' ? f.view.handleNewSession.call(f.view as never)
            : action === 'close-tab' ? _closeActiveTab.call(f.view as never) : action === 'close-view' ? closeView(f.view)
            : action === 'Stop' ? f.clickStop() : f.escape();
        gate.release.resolve();
        await Promise.all([run, stopping]);
        const fresh = new AgentMemory({ adapter: { ...f.adapter } }, 'Mira');
        const expected = phaseA ? ['Pytanie A', 'Odpowiedź A'] : [text];
        t.deepEqual(f.windows[0].messages.map(m => m.content), expected, 'RAM zawiera całą starą rozmowę albo przyjętą poprawkę');
        t.deepEqual(f.windows[0].parentConversation.snapshot().messages.map(m => m.text), expected);
        t.deepEqual((await fresh.loadActiveSession(path)).messages.map(m => m.content), expected, 'świeży odczyt zawiera całą starą rozmowę albo przyjętą poprawkę');
        t.is(f.view.input_area.value, phaseA ? text : '');
        t.deepEqual(f.modelInputs, []);
    });
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

async function fixture(newSession = false, tabNames = ['A', 'B']) {
    document.hasFocus = () => true;
    setLocale('pl');
    const files = new Map<string, string>();
    const adapter = {
        exists: async (path: string) => files.has(path),
        read: async (path: string) => { if (!files.has(path)) throw new Error('missing'); return files.get(path)!; },
        write: async (path: string, text: string) => { files.set(path, text); },
        append: async (path: string, text: string) => { files.set(path, (files.get(path) ?? '') + text); },
        remove: async (path: string) => { files.delete(path); }, mkdir: async () => {}, list: async (): Promise<{ files: string[] }> => ({ files: [] }),
    };
    const memory = new AgentMemory({ adapter }, 'Mira');
    const seed = new AgentMemory({ adapter: { ...adapter } }, 'Mira');
    const agent = { name: 'Mira' };
    const tabs = tabNames.map((id, index) => ({ agentName: 'Mira', sessionId: id,
        sessionPath: memory.paths.sessionsActive + '/' + id + '.md', sessionEpoch: id.toLowerCase().repeat(32) as string | null, isActive: index === 0 }));
    const windows = tabs.map(() => new RollingWindow());
    const trackers = tabs.map(() => new TokenTracker());
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
        _autoTurnChainCounts: new Map<string, number>(),
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
            const read = f.memory.loadActiveSession.bind(f.memory);
            f.memory.loadActiveSession = async (...args) => { const value = await read(...args); await hold(); return value; };
        } else if (stage === 'slash') {
            f.view.slashCommands.execute = async () => { await hold(); return false; };
        } else if (stage === 'mentions') {
            const resolve = f.view._resolveMentions;
            f.view._resolveMentions = async text => { const result = await resolve.call(f.view as never, text); await hold(); return result; };
        } else if (stage === 'append-message') {
            const add = f.windows[0].addMessage.bind(f.windows[0]);
            f.windows[0].addMessage = async (...args) => { const result = await add(...args); if (args[0] === 'user') await hold(); return result; };
        } else if (stage === 'journal') {
            let held = false;
            for (const method of ['write', 'append'] as const) {
                const write = f.adapter[method];
                f.adapter[method] = async (path, text) => {
                    if (!held && path === f.tabs[0].sessionPath && text.includes('Poprawione pytanie A')) { held = true; await hold(); }
                    await write(path, text);
                };
            }
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
            const write = f.adapter.write;
            f.adapter.write = async (path, text) => { if (text.includes('Dorobek A')) await hold(); await write(path, text); };
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

function installSaveCommand(view: Awaited<ReturnType<typeof fixture>>['view'], name = '/save') {
    const source = ts.createSourceFile('SlashCommandsRegistry.ts', readFileSync(new URL('./SlashCommandsRegistry.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const registryClass = source.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === 'SlashCommandsRegistry');
    const factory = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'createDefaultSlashCommands');
    if (!registryClass || !factory || !ts.isFunctionDeclaration(factory) || !factory.body) throw new Error('Missing registry');
    const save = factory.body.statements.find(s => s.getText(source).includes(`name: '${name}'`));
    if (!save) throw new Error(`Missing ${name}`);
    const guard = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'guardedInputReset');
    if (!guard) throw new Error('Missing input guard');
    const code = ts.transpile(guard.getText(source) + '\n' + registryClass.getText(source).replace(/^export /, '')
        + '\nconst registry = new SlashCommandsRegistry();\n' + save.getText(source) + '\nreturn registry;', { target: ts.ScriptTarget.ES2022 });
    const ui = ts.createSourceFile('chat_ui.ts', readFileSync(new URL('./chat_ui.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const compression = ui.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'runManualCompression');
    if (!compression) throw new Error('Missing compression');
    const compressionCode = ts.transpile(compression.getText(ui).replace(/^export /, '') + '\nreturn runManualCompression;', { target: ts.ScriptTarget.ES2022 });
    const runManualCompression = new Function('Notice', 't', compressionCode)(Notice, translate);
    view.slashCommands = new Function('Notice', 't', 'log', 'runManualCompression', code)(Notice, translate, log, runManualCompression);
}

test.serial('F2: /save po przełączeniu zachowuje szkic B', async t => {
    const f = await fixture();
    t.teardown(() => f.view.attachmentManager.destroy());
    installSaveCommand(f.view);
    const entered = deferred(), release = deferred();
    const save = f.view.handleSaveSession;
    f.view.handleSaveSession = async function (...args) {
        await save.apply(this, args);
        entered.resolve();
        await release.promise;
    };
    f.view.input_area.value = '/save';
    const run = f.clickSend();
    await entered.promise;
    await f.clickB();
    f.view.input_area.value = 'Szkic B';
    release.resolve();
    await run;
    t.is(f.view.input_area.value, 'Szkic B');
});

test.serial('F2: /save nie usuwa nowej treści w tej samej zakładce', async t => {
    const f = await fixture();
    t.teardown(() => f.view.attachmentManager.destroy());
    installSaveCommand(f.view);
    const entered = deferred(), release = deferred();
    const save = f.view.handleSaveSession;
    f.view.handleSaveSession = async function (...args) {
        await save.apply(this, args);
        entered.resolve();
        await release.promise;
    };
    f.view.input_area.value = '/save';
    const run = f.clickSend();
    await entered.promise;
    f.view.input_area.value = 'Nowy szkic A';
    release.resolve();
    await run;
    t.is(f.view.input_area.value, 'Nowy szkic A');
});

for (const stage of ['memory-read', 'memory-consolidate', 'compress'] as const) test.serial(`F2: /${stage} po przełączeniu zachowuje szkic B`, async t => {
    const f = await fixture();
    t.teardown(() => f.view.attachmentManager.destroy());
    const entered = deferred(), release = deferred();
    const hold = async () => { entered.resolve(); await release.promise; };
    if (stage === 'memory-read') {
        f.memory.getUnconsolidatedSessions = async () => { await hold(); return []; };
        Object.assign(f.view, { consolidateSession: async () => {} });
    }
    if (stage === 'memory-consolidate') Object.assign(f.view, { consolidateSession: hold });
    if (stage === 'compress') {
        await f.windows[0].addMessage('user', 'Dodatkowe pytanie A');
        await f.windows[0].addMessage('assistant', 'Dodatkowa odpowiedź A');
        f.windows[0].performTwoPhaseCompression = async () => { await hold(); return { phase: 0, trimmed: 0, trimDetails: [], savedChars: 0, summarized: false, summaryFailed: false }; };
    }
    installSaveCommand(f.view, stage === 'compress' ? '/compress' : '/memory');
    f.view.input_area.value = stage === 'compress' ? '/compress' : '/memory';
    const run = f.clickSend();
    await Promise.race([entered.promise, run.then(() => { throw new Error('Nie osiągnięto oczekiwania komendy'); })]);
    await f.clickB();
    f.view.input_area.value = 'Szkic B';
    release.resolve();
    await run;
    t.is(f.view.input_area.value, 'Szkic B');
});

test.serial('B1: powrót A przed końcem kontynuacji pokazuje odpowiedź', async t => {
    const f = await fixture();
    t.teardown(() => f.view.attachmentManager.destroy());
    const renderMarkdown = MarkdownRenderer.render;
    MarkdownRenderer.render = async (_app, text, el) => { el.textContent = text; };
    t.teardown(() => { MarkdownRenderer.render = renderMarkdown; });
    const journalEntered = deferred(), releaseJournal = deferred(), modelEntered = deferred(), releaseModel = deferred();
    const append = f.memory.appendSessionEvent.bind(f.memory);
    f.memory.appendSessionEvent = async (...args) => {
        if (args[1]?.type === 'agent_message' && Array.isArray(args[1].tool_calls)) {
            journalEntered.resolve();
            await releaseJournal.promise;
        }
        return append(...args);
    };
    let calls = 0;
    Object.assign(f.view, {
        render_messages,
        _drawConnectorLines() {},
        get_chat_model: () => ({ providerId: 'openai', stream(_payload: unknown, cb: { chunk(value: unknown): void; done(value: unknown): void }) {
            if (++calls === 1) {
                cb.chunk({ choices: [{ message: { content: 'Praca A' } }] });
                cb.done({ choices: [{ message: { role: 'assistant', content: 'Praca A', tool_calls: [{ id: 't1', type: 'function', function: { name: 'list', arguments: '{}' } }] } }] });
            }
            else { modelEntered.resolve(); void releaseModel.promise.then(() => cb.done({ choices: [{ message: { role: 'assistant', content: 'Gotowa odpowiedź A' } }] })); }
        } }),
        _chatResolveTools: () => [{ type: 'function', function: { name: 'list', parameters: {} } }],
        _chatExecuteToolCall: async () => ({ success: true }),
        _chatOnToolCallsParsed() {},
    });
    f.view.input_area.value = 'Pytanie z narzędziem';
    const run = f.clickSend();
    await Promise.race([journalEntered.promise, run.then(() => { throw new Error('Nie osiągnięto zapisu narzędzia'); })]);
    await f.clickB();
    releaseJournal.resolve();
    await Promise.race([modelEntered.promise, run.then(() => { throw new Error('Nie osiągnięto kontynuacji modelu'); })]);
    await f.clickA();
    releaseModel.resolve();
    await run;
    const texts = (el: Element): string[] => [el.textContent || '', ...Array.from(el.children).flatMap(texts)];
    t.is(texts(f.view.messages_container).find(text => text === 'Gotowa odpowiedź A'), 'Gotowa odpowiedź A');
    t.is((await f.memory.loadActiveSession(f.tabs[0].sessionPath)).messages.at(-1)?.content, 'Gotowa odpowiedź A');
});

for (const stage of ['agent_message', 'tool_result', 'compression', 'skill_nudge', 'delegate_nudge', 'queued_add', 'queued_event', 'tile_render'] as const) test.serial(`F2: kontynuacja narzędzia przy ${stage} nie maluje w B`, async t => {
    const f = await fixture();
    t.teardown(() => f.view.attachmentManager.destroy());
    const entered = deferred(), release = deferred();
    const append = f.memory.appendSessionEvent.bind(f.memory);
    f.memory.appendSessionEvent = async (...args) => {
        if ((args[1]?.type === stage && (stage !== 'agent_message' || Array.isArray(args[1].tool_calls))) || (stage === 'queued_event' && args[1]?.type === 'user_message' && args[1].content === 'Kolejka A')) {
            entered.resolve();
            await release.promise;
        }
        return append(...args);
    };
    if (stage === 'compression') {
        f.windows[0].getCompressionNeeded = () => 'summarize';
        f.windows[0].performTwoPhaseCompression = async () => { entered.resolve(); await release.promise; return { phase: 0, trimmed: 0, trimDetails: [], savedChars: 0, summarized: false, summaryFailed: false }; };
    }
    const add = f.windows[0].addMessage.bind(f.windows[0]);
    f.windows[0].addMessage = async (role, content, metadata) => {
        if (role === 'user' && ((stage === 'queued_add' && content === 'Kolejka A')
            || ((stage === 'skill_nudge' || stage === 'delegate_nudge') && content !== 'Pytanie z narzędziem'))) {
            entered.resolve(); await release.promise;
        }
        return add(role, content, metadata);
    };
    if (stage === 'tile_render') Object.assign(f.view.plugin, { artifactStore: { async read() { entered.resolve(); await release.promise; return { path: 'A.md' }; } } });
    let calls = 0;
    Object.assign(f.view, {
        async _chatBeforeContinue(turn: Parameters<typeof streaming._chatBeforeContinue>[0], i: number) {
            if (stage === 'skill_nudge') turn.skillActiveAt = -2;
            if (stage === 'delegate_nudge' && turn.agent) { Object.assign(turn.agent, { getActiveDelegates: () => ['worker'] }); i = 1; }
            if (stage === 'queued_add' || stage === 'queued_event' || stage === 'tile_render') Object.assign(f.view, {
                _queuedMessage: { text: stage === 'tile_render' ? 'Artefakt A\n\n```json\n{"id":"art-a"}\n```' : 'Kolejka A', meta: stage === 'tile_render' ? { origin: 'human', _artifactSummon: true } : { origin: 'human' }, owner: { tabKey: 'A', agentName: 'Mira' } },
            });
            await streaming._chatBeforeContinue.call(f.view as never, turn, i);
        },
        get_chat_model: () => ({ providerId: 'openai', stream(_payload: unknown, cb: { done(value: unknown): void }) {
            calls++;
            cb.done({ choices: [{ message: calls === 1
                ? { role: 'assistant', content: 'Praca A', tool_calls: [{ id: `t${calls}`, type: 'function', function: { name: 'list', arguments: JSON.stringify({ iteration: calls }) } }] }
                : { role: 'assistant', content: 'Gotowe A' } }] });
        } }),
        _chatResolveTools: () => [{ type: 'function', function: { name: 'list', parameters: {} } }],
        _chatExecuteToolCall: async () => ({ success: true }),
        _chatOnToolCallsParsed() {},
        render_messages() { f.view.messages_container.empty(); f.view.messages_container.textContent = 'Rozmowa B'; f.view.messages_container.createDiv({ text: 'Wiadomość B' }); },
        showTypingIndicator(text: string) { f.view.messages_container.textContent = text; },
    });
    f.view.input_area.value = 'Pytanie z narzędziem';
    const run = f.clickSend();
    await Promise.race([entered.promise, run.then(() => { throw new Error('Nie osiągnięto zapisu narzędzia'); })]);
    await f.clickB();
    f.view.input_area.value = 'Szkic B';
    release.resolve();
    await run;
    t.is(f.view.input_area.value, 'Szkic B');
    t.is(f.view.messages_container.textContent, 'Rozmowa B');
    t.deepEqual([...f.view.messages_container.children].map(el => el.textContent), ['Wiadomość B']);
    t.is(f.windows[0].messages.at(-1)?.content, 'Gotowe A');
    t.is((await f.memory.loadActiveSession(f.tabs[0].sessionPath)).messages.at(-1)?.content, 'Gotowe A');
    await f.clickA();
    t.is(f.view.rollingWindow.messages.at(-1)?.content, 'Gotowe A');
});

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
    const guard = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'guardedInputReset');
    if (!guard) throw new Error('Missing input guard');
    const code = ts.transpile(guard.getText(source) + '\n' + registryClass.getText(source).replace(/^export /, '')
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
    test.serial(`F1: poprawka podczas wspólnego zapisu → ${action} pozostawia przyjętą poprawkę`, async t => {
        const f = await fixture();
        const prompt = SessionCloseModal.prototype.prompt;
        SessionCloseModal.prototype.prompt = async () => ({ choice: 'discard' });
        t.teardown(() => { SessionCloseModal.prototype.prompt = prompt; f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
        startEditMessage.call(f.view as never, 0, 'Pytanie A');
        f.view.input_area.value = 'Poprawka A';
        const gate = holdRemoval(f);
        const run = f.clickSend();
        await gate.entered.promise;
        const stopping = action === 'new-session' ? f.view.handleNewSession.call(f.view as never)
            : action === 'Stop' ? f.clickStop() : f.escape();
        gate.release.resolve();
        await Promise.all([run, stopping]);
        t.is(f.view.input_area.value, '');
        t.deepEqual(f.windows[0].messages.map(m => m.content), ['Poprawka A']);
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
    t.teardown(() => { f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
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
    t.teardown(() => { registry.dispose(); notifier.dispose(); f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
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
    t.teardown(() => { SessionCloseModal.prototype.prompt = prompt; AgentMemory.prototype._generateActiveSessionFilename = filename; f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
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
        t.teardown(() => { f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
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
            const read = f.memory.loadActiveSession.bind(f.memory);
            f.memory.loadActiveSession = async (...args) => { const value = await read(...args); await hold(); return value; };
        } else if (stage === 'slash') {
            f.view.slashCommands.execute = async () => { await hold(); return false; };
        } else if (stage === 'mentions') {
            const resolve = f.view._resolveMentions;
            f.view._resolveMentions = async text => { const result = await resolve.call(f.view as never, text); await hold(); return result; };
        } else if (stage === 'append-message') {
            const add = f.windows[0].addMessage.bind(f.windows[0]);
            f.windows[0].addMessage = async (...args) => { const result = await add(...args); if (args[0] === 'user') await hold(); return result; };
        } else if (stage === 'journal') {
            let held = false;
            for (const method of ['write', 'append'] as const) {
                const write = f.adapter[method];
                f.adapter[method] = async (path, text) => {
                    if (!held && path === f.tabs[0].sessionPath && text.includes('Poprawione pytanie A')) { held = true; await hold(); }
                    await write(path, text);
                };
            }
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
            f.view._buildActiveNoteContext = async () => { entered.resolve(); await release.promise; return { text: '', images: [] }; };
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
            t.is(f.view.input_area.value, ['idle-save', 'slash', 'mentions', 'note', 'session-probe', 'session-read'].includes(stage) ? question : '');
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
    t.teardown(() => { f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
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
    t.teardown(() => { f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
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

for (const stage of ['mentions', 'note', 'slash', 'session-probe', 'session-read'] as const) {
    test.serial(`F6 A: ${stage} → Stop oddaje chipy i szkic bez żadnego zapisu`, async t => {
        const f = await fixture();
        t.teardown(() => { f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
        startEditMessage.call(f.view as never, 0, 'Pytanie A');
        const text = stage === 'slash' ? '/Poprawka @[Notatka]' : 'Poprawka @[Notatka]';
        f.view.input_area.value = text;
        f.view.attachmentManager.addTextAttachment({ name: 'A.txt', text: 'Materiał A' });
        f.view.mentionAutocomplete.restoreMentions([{ type: 'note', name: 'Notatka', path: 'Notatka.md', icon: '' }]);
        const path = f.tabs[0].sessionPath, before = f.files.get(path);
        const gate = await preparationGate(f, stage);
        let writes = 0;
        for (const method of ['write', 'append'] as const) {
            const write = f.adapter[method];
            f.adapter[method] = async (...args) => { writes++; await write(...args); };
        }
        const run = f.clickSend();
        await gate.entered.promise;
        f.clickStop();
        gate.release.resolve();
        await run;
        t.deepEqual(f.windows[0].messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A']);
        const fresh = new AgentMemory({ adapter: { ...f.adapter } }, 'Mira');
        t.deepEqual((await fresh.loadActiveSession(path)).messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A']);
        t.is(f.files.get(path), before);
        t.is(f.view.input_area.value, text);
        t.is(f.view.attachmentManager.buildMessageContent('tekst').content, '📎 Załącznik: A.txt\n```\nMateriał A\n```\n\ntekst');
        t.deepEqual(f.view.mentionAutocomplete.getMentions().map(m => m.path), ['Notatka.md']);
        t.deepEqual({ writes, requests: f.modelInputs }, { writes: 0, requests: [] });
    });
}

for (const stage of ['epoch-read', 'epoch-append', 'epoch-readback'] as const) {
    test.serial(`F6 D: ${stage} → Stop → następna pełna tura zachowuje jedną epokę`, async t => {
        const f = await fixture();
        t.teardown(() => { f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
        const path = f.tabs[0].sessionPath;
        f.files.set(path, f.files.get(path)!.replace(/epoch: [a-f0-9]+\n/, ''));
        f.tabs[0].sessionEpoch = null;
        f.memory.setActiveSessionIdentity(path, null);
        startEditMessage.call(f.view as never, 0, 'Pytanie A');
        f.view.input_area.value = 'Poprawione pytanie A';
        const gate = await preparationGate(f, stage);
        const run = f.clickSend();
        await gate.entered.promise;
        f.clickStop();
        gate.release.resolve();
        await run;
        const fresh = new AgentMemory({ adapter: { ...f.adapter } }, 'Mira');
        const parsed = await fresh.loadActiveSession(path);
        t.deepEqual(parsed.messages.map(m => m.content), ['Poprawione pytanie A']);
        t.regex(String(parsed.metadata.epoch), /^[0-9a-f]{32}$/);
        t.is<string | null, string>(f.tabs[0].sessionEpoch, String(parsed.metadata.epoch));
        t.is(f.memory.sessionEpoch, String(parsed.metadata.epoch));
        t.deepEqual(f.modelInputs, []);
        t.is(f.view.input_area.value, '');
        f.view.input_area.value = 'Następne pytanie';
        await f.clickSend();
        const expected = ['Poprawione pytanie A', 'Następne pytanie', 'Odpowiedź na poprawkę A'];
        t.deepEqual(f.windows[0].messages.map(m => m.content), expected);
        const newest = new AgentMemory({ adapter: { ...f.adapter } }, 'Mira');
        t.deepEqual((await newest.loadActiveSession(path)).messages.map(m => m.content), expected);
        t.is(f.modelInputs.length, 1);
        t.is((f.files.get(path)!.match(/— session epoch/g) ?? []).length, 1);
    });
}

function holdRealCompression(rw: RollingWindow) {
    const entered = deferred();
    let finish!: () => void;
    rw.maxTokens = 1;
    rw._modelProvider = () => ({ stream(_payload: unknown, handlers: { done(response: unknown): void }) {
        finish = () => {
            rw.maxTokens = 100000;
            handlers.done({ choices: [{ message: { content: 'Zachowane streszczenie' } }] });
        };
        entered.resolve();
    } });
    return { entered, release: () => finish() };
}

for (const action of ['Stop', 'Escape', 'new-cancel'] as const) {
    test.serial(`F6 B: prawdziwa kompresja addMessage → ${action} kończy przyjęcie`, async t => {
        const f = await fixture();
        const prompt = SessionCloseModal.prototype.prompt;
        SessionCloseModal.prototype.prompt = async () => ({ choice: 'cancel' });
        t.teardown(() => { SessionCloseModal.prototype.prompt = prompt; f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
        startEditMessage.call(f.view as never, 0, 'Pytanie A');
        f.view.input_area.value = 'Poprawka A';
        const gate = holdRealCompression(f.windows[0]);
        let cancelledCompression = 0;
        Object.assign(f.view.env, { chatModel: { stopStream() { cancelledCompression++; } } });
        const run = f.clickSend();
        await gate.entered.promise;
        const stopping = action === 'new-cancel' ? f.view.handleNewSession.call(f.view as never)
            : action === 'Stop' ? f.clickStop() : f.escape();
        t.is(cancelledCompression, 0);
        gate.release();
        await Promise.all([run, stopping]);
        t.is(f.windows[0].conversationSummary, 'Zachowane streszczenie');
        t.deepEqual(f.windows[0].messages.map(m => m.content), ['Poprawka A']);
        const fresh = new AgentMemory({ adapter: { ...f.adapter } }, 'Mira');
        t.deepEqual((await fresh.loadActiveSession(f.tabs[0].sessionPath)).messages.map(m => m.content), ['Poprawka A']);
        t.deepEqual(f.modelInputs, []);
        t.is(f.view.input_area.value, '');
    });
}

const deliveredResult = '[POWIADOMIENIE SYSTEMU] Sub-agent worker skończył zadanie worker-A, które zleciłeś w tle.\n\n'
    + 'Stan: zakończone. Czas pracy: 0.0 s.\n\nDorobek A\n\n'
    + 'Podejmij wątek - wykorzystaj ten wynik do dokończenia zadania. Jeśli zlecałeś więcej zadań, ich wyniki przyjdą osobno; nie zgaduj ich treści.';

for (const afterRam of [false, true]) {
    test.serial(`F6 C: EACCES powiadomienia, istnieje w RAM=${afterRam} → ponowny dren zapisuje i potwierdza raz`, async t => {
        const f = await fixture();
        const registry = new SubTaskRegistry(), notifier = new SubTaskNotifier({ registry });
        Object.assign(f.view.plugin, { subTaskRegistry: registry, subTaskNotifier: notifier });
        f.view._wireSubTaskDeliverer.call(f.view as never);
        t.teardown(() => { registry.dispose(); notifier.dispose(); f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
        const task = registry.create({ id: 'worker-A', name: 'worker', agentName: 'Mira', background: true,
            origin: { agentName: 'Mira', tabKey: 'A', sessionPath: f.tabs[0].sessionPath, sessionEpoch: f.tabs[0].sessionEpoch! } });
        // A legacy in-memory receipt is not evidence that the notification reached disk.
        if (afterRam) await f.windows[0].addMessage('user', deliveredResult, { origin: 'machine', subTaskId: task.id, sessionMessageId: `sub-result:${task.id}` });
        const write = f.adapter.write, append = f.adapter.append;
        for (const method of ['write', 'append'] as const) {
            const persist = f.adapter[method];
            f.adapter[method] = async (path, text) => { if (text.includes('Dorobek A')) throw new Error('EACCES notification'); await persist(path, text); };
        }
        registry.finish(task, { text: 'Dorobek A', toolsUsed: [], durationMs: 1, usage: null });
        await new Promise(resolve => setImmediate(resolve));
        t.deepEqual(notifier.pending().map(task => task.id), ['worker-A']);
        t.is(f.view._autoTurnChainCounts?.get('Mira') ?? 0, 0);
        t.deepEqual(f.modelInputs, []);
        const fresh = new AgentMemory({ adapter: { ...f.adapter } }, 'Mira');
        t.deepEqual((await fresh.loadActiveSession(f.tabs[0].sessionPath)).messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A']);
        f.adapter.write = write;
        f.adapter.append = append;
        notifier.drain();
        await new Promise(resolve => setImmediate(resolve));
        t.deepEqual(notifier.pending().map(task => task.id), []);
        const expected = ['Pytanie A', 'Odpowiedź A', deliveredResult, 'Odpowiedź na poprawkę A'];
        t.deepEqual(f.windows[0].messages.map(m => m.content), expected);
        const newest = new AgentMemory({ adapter: { ...f.adapter } }, 'Mira');
        t.deepEqual((await newest.loadActiveSession(f.tabs[0].sessionPath)).messages.map(m => m.content), expected);
        t.is(f.view._autoTurnChainCounts?.get('Mira'), 1);
    });
}

test.serial('F6 E: opóźnione przyjęcie suba nie nadpisuje późniejszego resetu człowieka w B', async t => {
    const f = await fixture();
    const registry = new SubTaskRegistry(), notifier = new SubTaskNotifier({ registry });
    Object.assign(f.view.plugin, { subTaskRegistry: registry, subTaskNotifier: notifier });
    f.view._wireSubTaskDeliverer.call(f.view as never);
    Object.assign(f.view, { _autoTurnChainCounts: new Map([['Mira', 2]]) });
    t.teardown(() => { registry.dispose(); notifier.dispose(); f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
    const task = registry.create({ id: 'worker-A', name: 'worker', agentName: 'Mira', background: true,
        origin: { agentName: 'Mira', tabKey: 'A', sessionPath: f.tabs[0].sessionPath, sessionEpoch: f.tabs[0].sessionEpoch! } });
    const gate = holdRealCompression(f.windows[0]);
    registry.finish(task, { text: 'Dorobek A', toolsUsed: [], durationMs: 1, usage: null });
    await gate.entered.promise;
    f.clickStop();
    await f.clickB();
    f.view.input_area.value = 'Nowe pytanie człowieka';
    await f.clickSend();
    t.is(f.view._autoTurnChainCounts?.get('Mira'), 0);
    gate.release();
    await new Promise(resolve => setImmediate(resolve));
    t.is(f.view._autoTurnChainCounts?.get('Mira'), 0);
    t.deepEqual(notifier.pending().map(task => task.id), []);
    t.deepEqual(f.windows[0].messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A', deliveredResult]);
    t.deepEqual(f.windows[1].messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B', 'Nowe pytanie człowieka', 'Odpowiedź na poprawkę A']);
    const next = registry.create({ id: 'worker-B', name: 'worker', agentName: 'Mira', background: true,
        origin: { agentName: 'Mira', tabKey: 'B', sessionPath: f.tabs[1].sessionPath, sessionEpoch: f.tabs[1].sessionEpoch! } });
    registry.finish(next, { text: 'Dorobek B', toolsUsed: [], durationMs: 1, usage: null });
    await new Promise(resolve => setImmediate(resolve));
    t.is(f.view._autoTurnChainCounts.get('Mira'), 1);
    t.deepEqual(notifier.pending(), []);
    t.is(f.modelInputs.length, 2);
});

for (const afterRam of [false, true]) {
    test.serial(`F6 C consume: nieudany zapis zatrzymanego wyniku, RAM=${afterRam} zachowuje kolejkę do następnej tury`, async t => {
        const f = await fixture();
        const registry = new SubTaskRegistry(), notifier = new SubTaskNotifier({ registry });
        Object.assign(f.view.plugin, { subTaskRegistry: registry, subTaskNotifier: notifier });
        t.teardown(() => { registry.dispose(); notifier.dispose(); f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
        const task = registry.create({ id: 'worker-A', name: 'worker', agentName: 'Mira', background: true,
            origin: { agentName: 'Mira', tabKey: 'A', sessionPath: f.tabs[0].sessionPath, sessionEpoch: f.tabs[0].sessionEpoch! } });
        registry.attachAbort(task.id, () => {});
        registry.requestStop(task.id, 'user');
        registry.finish(task, { text: 'Dorobek A', toolsUsed: [], durationMs: 1, usage: null, stoppedBy: 'abort',
            outcome: { end: { kind: 'stopped', by: 'user' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [] } });
        const result = '[POWIADOMIENIE SYSTEMU] Sub-agent worker skończył zadanie worker-A, które zleciłeś w tle.\n\n'
            + 'Stan: zatrzymany przez użytkownika · wynik częściowy. Czas pracy: 0.0 s.\n\n'
            + 'Sub nie dokończył zadania. Nie wolno go raportować jako wykonanego.\n\nDorobek A\n\n'
            + 'Podejmij wątek - wykorzystaj ten wynik do dokończenia zadania. Jeśli zlecałeś więcej zadań, ich wyniki przyjdą osobno; nie zgaduj ich treści.';
        if (afterRam) await f.windows[0].addMessage('user', result, { origin: 'machine', subTaskId: task.id });
        const write = f.adapter.write, append = f.adapter.append;
        for (const method of ['write', 'append'] as const) {
            const persist = f.adapter[method];
            f.adapter[method] = async (path, text) => { if (text.includes('Dorobek A')) throw new Error('EACCES stopped result'); await persist(path, text); };
        }
        f.view.input_area.value = 'Kontynuuj';
        await f.clickSend();
        t.deepEqual(notifier.pending().map(task => task.id), ['worker-A']);
        const fresh = new AgentMemory({ adapter: { ...f.adapter } }, 'Mira');
        t.deepEqual((await fresh.loadActiveSession(f.tabs[0].sessionPath)).messages.map(m => m.content),
            ['Pytanie A', 'Odpowiedź A', 'Kontynuuj', 'Odpowiedź na poprawkę A']);
        f.adapter.write = write;
        f.adapter.append = append;
        f.view.input_area.value = 'Ponów odbiór';
        await f.clickSend();
        t.deepEqual(notifier.pending().map(task => task.id), []);
        t.deepEqual(f.windows[0].messages.filter(m => m.subTaskId === task.id).map(m => m.content), [result]);
        const newest = new AgentMemory({ adapter: { ...f.adapter } }, 'Mira');
        t.deepEqual((await newest.loadActiveSession(f.tabs[0].sessionPath)).messages.map(m => m.content).filter(content => content.includes('Dorobek A')), [result]);
        t.is(f.modelInputs.length, 2);
    });
}

test.serial('F6 B: poprawka i usunięcia mają jeden zapis i nie odsłaniają pustej historii', async t => {
    const f = await fixture();
    t.teardown(() => { f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
    startEditMessage.call(f.view as never, 0, 'Pytanie A');
    f.view.input_area.value = 'Poprawka A';
    const path = f.tabs[0].sessionPath, before = f.files.get(path);
    const gate = holdRemoval(f);
    const writes: string[] = [];
    for (const method of ['write', 'append'] as const) {
        const write = f.adapter[method];
        f.adapter[method] = async (target, content) => {
            if (target === path) writes.push(content);
            await write(target, content);
        };
    }
    const run = f.clickSend();
    await gate.entered.promise;
    t.deepEqual(f.windows[0].messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A']);
    t.is(f.files.get(path), before);
    f.clickStop();
    gate.release.resolve();
    await run;
    t.is(writes.length, 1);
    t.true(writes[0].includes('— messages removed'));
    t.true(writes[0].includes('Poprawka A'));
    const fresh = new AgentMemory({ adapter: { ...f.adapter } }, 'Mira');
    t.deepEqual((await fresh.loadActiveSession(path)).messages.map(m => m.content), ['Poprawka A']);
    t.deepEqual(f.windows[0].messages.map(m => m.content), ['Poprawka A']);
    t.deepEqual(f.modelInputs, []);
});

test.serial('F6 C: zapis pytania suba musi się udać przed ACK i ponowny dren nie duplikuje pytania', async t => {
    const f = await fixture();
    const registry = new SubTaskRegistry(), notifier = new SubTaskNotifier({ registry });
    Object.assign(f.view.plugin, { subTaskRegistry: registry, subTaskNotifier: notifier });
    f.view._wireSubTaskDeliverer.call(f.view as never);
    t.teardown(() => { registry.dispose(); notifier.dispose(); f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
    registry.create({ id: 'worker-A', threadId: 'thread-A', name: 'worker', agentName: 'Mira', background: true,
        origin: { agentName: 'Mira', tabKey: 'A', sessionPath: f.tabs[0].sessionPath, sessionEpoch: f.tabs[0].sessionEpoch! } });
    const write = f.adapter.write, append = f.adapter.append;
    for (const method of ['write', 'append'] as const) {
        const persist = f.adapter[method];
        f.adapter[method] = async (path, text) => { if (text.includes('Jaki zakres?')) throw new Error('EACCES question'); await persist(path, text); };
    }
    const opened = registry.openParentQuestion('worker-A', 'Jaki zakres?');
    if (opened.kind !== 'opened') throw new Error('Question did not open');
    const question = `[POWIADOMIENIE SYSTEMU] Sub-agent worker pyta w zadaniu worker-A: Jaki zakres?\n\nOdpowiedz przez sub_agent message, podając sub_id=thread-A i question_id=${opened.question.id}.`;
    await new Promise(resolve => setImmediate(resolve));
    t.deepEqual(notifier.pendingNotices().map(notice => notice.kind), ['question']);
    t.deepEqual(f.windows[0].messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A']);
    t.deepEqual(f.modelInputs, []);
    t.is(f.view._autoTurnChainCounts.get('Mira') ?? 0, 0);
    const fresh = new AgentMemory({ adapter: { ...f.adapter } }, 'Mira');
    t.deepEqual((await fresh.loadActiveSession(f.tabs[0].sessionPath)).messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A']);
    f.adapter.write = write; f.adapter.append = append;
    notifier.drain();
    await new Promise(resolve => setImmediate(resolve));
    t.deepEqual(notifier.pendingNotices(), []);
    const expected = ['Pytanie A', 'Odpowiedź A', question, 'Odpowiedź na poprawkę A'];
    t.deepEqual(f.windows[0].messages.map(m => m.content), expected);
    const newest = new AgentMemory({ adapter: { ...f.adapter } }, 'Mira');
    t.deepEqual((await newest.loadActiveSession(f.tabs[0].sessionPath)).messages.map(m => m.content), expected);
    t.is(f.view._autoTurnChainCounts.get('Mira'), 1);
});

test.serial('F6 C: rzeczywista kompresja wyniku → Stop przyjmuje wynik bez żądania prowadzącego', async t => {
    const f = await fixture();
    const registry = new SubTaskRegistry(), notifier = new SubTaskNotifier({ registry });
    Object.assign(f.view.plugin, { subTaskRegistry: registry, subTaskNotifier: notifier });
    f.view._wireSubTaskDeliverer.call(f.view as never);
    t.teardown(() => { registry.dispose(); notifier.dispose(); f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
    const task = registry.create({ id: 'worker-A', name: 'worker', agentName: 'Mira', background: true,
        origin: { agentName: 'Mira', tabKey: 'A', sessionPath: f.tabs[0].sessionPath, sessionEpoch: f.tabs[0].sessionEpoch! } });
    const gate = holdRealCompression(f.windows[0]);
    registry.finish(task, { text: 'Dorobek A', toolsUsed: [], durationMs: 1, usage: null });
    await gate.entered.promise;
    f.clickStop();
    t.deepEqual(notifier.pending().map(task => task.id), ['worker-A']);
    gate.release();
    await new Promise(resolve => setImmediate(resolve));
    t.deepEqual(notifier.pending(), []);
    t.deepEqual(f.modelInputs, []);
    t.deepEqual(f.windows[0].messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A', deliveredResult]);
    const fresh = new AgentMemory({ adapter: { ...f.adapter } }, 'Mira');
    t.deepEqual((await fresh.loadActiveSession(f.tabs[0].sessionPath)).messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A', deliveredResult]);
    t.is(f.view._autoTurnChainCounts.get('Mira'), 1);
});

test.serial('F6 D: E1 kontra E2 odmawia zapisu i odzyskuje szkic bez zmiany rozmowy', async t => {
    const f = await fixture();
    t.teardown(() => { f.view.attachmentManager?.destroy(); f.view.mentionAutocomplete?.destroy(); });
    const path = f.tabs[0].sessionPath;
    f.files.set(path, f.files.get(path)!.replace('epoch: ' + 'a'.repeat(32), 'epoch: ' + 'c'.repeat(32)));
    const before = f.files.get(path);
    let failure: unknown;
    Object.assign(f.view, { handle_error(error: unknown) { failure = error; } });
    f.view.input_area.value = 'Pytanie do E1';
    await f.clickSend();
    t.is(failure && typeof failure === 'object' && 'kind' in failure ? failure.kind : undefined, 'identity-conflict');
    t.is(f.view.input_area.value, 'Pytanie do E1');
    t.deepEqual(f.windows[0].messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A']);
    t.is(f.files.get(path), before);
    t.deepEqual(f.modelInputs, []);
});


// F7: actual slim-bar registrations, with EventTarget replacing only the DOM boundary.
function lifecycleButtons(f: Awaited<ReturnType<typeof fixture>>) {
    const source = ts.createSourceFile('chat_ui.ts', readFileSync(new URL('./chat_ui.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const render = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === '_renderSlimBar');
    if (!render || !ts.isFunctionDeclaration(render) || !render.body) throw new Error('_renderSlimBar missing');
    const registrations = render.body.statements.filter(s => /^(newChatBtn|closeBtn)\.addEventListener/.test(s.getText(source)));
    const newChatBtn = createDiv(), closeBtn = createDiv();
    events(newChatBtn); events(closeBtn);
    const requests: Promise<void>[] = [];
    const notices: unknown[] = [];
    class CapturedNotice extends Notice {
        constructor(message: string, timeout?: number) { super(message, timeout); notices.push(message); }
    }
    Object.assign(f.view, {
        handleNewSession() { const run = handleNewSession.call(f.view as never); requests.push(run); return run; },
        _closeActiveTab() { const run = _closeActiveTab.call(f.view as never); requests.push(run); return run; },
    });
    new Function('newChatBtn', 'closeBtn', 'log', 'Notice', 't', ts.transpile(registrations.map(s => s.getText(source)).join('\n'), { target: ts.ScriptTarget.ES2022 })).call(f.view, newChatBtn, closeBtn, log, CapturedNotice, translate);
    return {
        requests, notices,
        newSession() { newChatBtn.dispatchEvent(new Event('click')); return requests.at(-1)!; },
        close() { closeBtn.dispatchEvent(new Event('click')); return requests.at(-1)!; },
    };
}

for (const [locale, expected] of [['pl', 'Nie udało się rozpocząć nowej rozmowy. Sprawdź, czy sesja została zarchiwizowana.'], ['en', 'Could not start a new conversation. Check whether the session was archived.']] as const)
test.serial(`B2: Nowa rozmowa zgłasza nieudaną archiwizację (${locale})`, async t => {
    const f = await fixture();
    disposeFixture(t, f);
    setLocale(locale);
    const oldPath = f.tabs[0].sessionPath;
    const name = 'mira_2026-11-11_07-37.md';
    const path = f.memory.paths.sessionsActive + '/' + name;
    f.files.set(path, f.files.get(oldPath)!);
    f.files.delete(oldPath);
    f.tabs[0].sessionPath = path;
    f.memory.setActiveSessionIdentity(path, f.tabs[0].sessionEpoch);
    await f.view.handleSaveSession.call(f.view as never);
    let before = '';
    const archives = Array.from({ length: 50 }, (_, i) => [f.memory.paths.sessionsArchive + '/' + (i === 0 ? name : name.replace('.md', `_${i + 1}.md`)), `Archiwum ${i + 1}`] as const);
    for (const [archive, content] of archives) f.files.set(archive, content);
    const closePrompt = SessionCloseModal.prototype.prompt, savePrompt = SaveSessionModal.prototype.prompt, proposals = SaveSessionModal.prototype.setProposals;
    SessionCloseModal.prototype.prompt = async () => { before = await f.adapter.read(path); return { choice: 'archive' }; };
    let accept!: (value: Awaited<ReturnType<SaveSessionModal['prompt']>>) => void;
    SaveSessionModal.prototype.prompt = () => new Promise(resolve => { accept = resolve; });
    SaveSessionModal.prototype.setProposals = () => { accept({ action: 'archive', notes: [], brainUpdates: [] }); };
    t.teardown(() => { SessionCloseModal.prototype.prompt = closePrompt; SaveSessionModal.prototype.prompt = savePrompt; SaveSessionModal.prototype.setProposals = proposals; });
    Object.assign(f.view, { consolidateSession });
    const buttons = lifecycleButtons(f);
    const failure = await buttons.newSession().catch((error: unknown) => error);
    await new Promise(resolve => setImmediate(resolve));
    t.is(failure instanceof Error ? failure.message : '', `archiveActiveSession: brak wolnej nazwy pliku sesji w ${f.memory.paths.sessionsArchive}`);
    t.deepEqual(buttons.notices, [expected]);
    t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A']);
    t.is(await f.adapter.read(path), before);
    t.deepEqual(await Promise.all(archives.map(async ([archive]) => [archive, await f.adapter.read(archive)])), archives);
    t.is([...f.files.keys()].filter(key => key.startsWith(f.memory.paths.sessionsArchive + '/')).length, 50);
});

function disposeFixture(t: import('ava').ExecutionContext, f: Awaited<ReturnType<typeof fixture>>) {
    t.teardown(() => { f.view.attachmentManager.destroy(); f.view.mentionAutocomplete.destroy(); });
}

test.serial('F7: dwa kliknięcia Zamknij podczas kompresji A zachowują B i C', async t => {
    const f = await fixture(false, ['A', 'B', 'C']);
    disposeFixture(t, f);
    const buttons = lifecycleButtons(f);
    startEditMessage.call(f.view as never, 0, 'Pytanie A');
    f.view.input_area.value = 'Poprawka A';
    const gate = holdRealCompression(f.windows[0]);
    const run = f.clickSend();
    await gate.entered.promise;
    buttons.close(); buttons.close();
    gate.release();
    await Promise.all([run, ...buttons.requests]);
    t.deepEqual(f.view.chatTabs.map(tab => [tab.sessionId, tab.sessionEpoch]), [['B', 'b'.repeat(32)], ['C', 'c'.repeat(32)]], 'Zamknij A musi pozostawić B i C');
    t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B']);
    const fresh = new AgentMemory({ adapter: { ...f.adapter } }, 'Mira');
    for (const id of ['B', 'C']) t.deepEqual((await fresh.loadActiveSession(f.memory.paths.sessionsActive + '/' + id + '.md')).messages.map(m => m.content), [`Pytanie ${id}`, `Odpowiedź ${id}`]);
    t.deepEqual((await fresh.loadActiveSession(f.memory.paths.sessionsActive + '/A.md')).messages.map(m => m.content), ['Poprawka A']);
});

for (const choice of ['discard', 'archive', 'cancel'] as const)
test.serial(`F7: Nowa → Zamknij → ${choice} w oknie A zachowuje sesję B`, async t => {
    const f = await fixture();
    disposeFixture(t, f);
    const buttons = lifecycleButtons(f);
    const opened = deferred(), decision = deferred();
    const prompt = SessionCloseModal.prototype.prompt;
    SessionCloseModal.prototype.prompt = async () => { opened.resolve(); await decision.promise; return { choice }; };
    t.teardown(() => { SessionCloseModal.prototype.prompt = prompt; decision.resolve(); });
    // If a stale Archive reaches the real workflow, approve its real proposal and
    // observe the resulting file/reset, rather than only checking a mock call.
    const savePrompt = SaveSessionModal.prototype.prompt, proposals = SaveSessionModal.prototype.setProposals;
    let acceptArchive!: (value: Awaited<ReturnType<SaveSessionModal['prompt']>>) => void;
    SaveSessionModal.prototype.prompt = () => new Promise(resolve => { acceptArchive = resolve; });
    SaveSessionModal.prototype.setProposals = () => { acceptArchive({ action: 'archive', notes: [], brainUpdates: [] }); };
    t.teardown(() => { SaveSessionModal.prototype.prompt = savePrompt; SaveSessionModal.prototype.setProposals = proposals; });
    Object.assign(f.view, { consolidateSession });
    startEditMessage.call(f.view as never, 0, 'Pytanie A');
    f.view.input_area.value = 'Poprawka A';
    const gate = holdRealCompression(f.windows[0]);
    const run = f.clickSend();
    await gate.entered.promise;
    const newSession = buttons.newSession(), close = buttons.close();
    gate.release();
    await Promise.all([run, close, opened.promise]);
    decision.resolve();
    await newSession;
    t.deepEqual(f.view.chatTabs.map(tab => [tab.sessionId, tab.sessionEpoch]), [['B', 'b'.repeat(32)]]);
    t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B'], 'Modal A nie może wyzerować B');
    t.is(f.memory.activeSessionPath, f.memory.paths.sessionsActive + '/B.md');
    t.false([...f.files.keys()].some(path => path.includes('/.discarded/B.md')));
    const fresh = new AgentMemory({ adapter: { ...f.adapter } }, 'Mira');
    t.deepEqual((await fresh.loadActiveSession(f.memory.paths.sessionsActive + '/B.md')).messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B']);
});

test.serial('F7: quit czeka na pierwsze pytanie A bez ścieżki w tle', async t => {
    const f = await fixture(true);
    disposeFixture(t, f);
    let quit!: (tasks: { addPromise(task: Promise<void>): void }) => void;
    Object.assign(f.view.app.workspace, { on(event: string, callback: typeof quit) { if (event === 'quit') quit = callback; return {}; } });
    Object.assign(f.view, { registerEvent() {}, registerInterval(id: number) { window.clearInterval(id); }, async _restoreActiveSession() {} });
    await initSessionManager.call(f.view as never);
    f.view.input_area.value = 'Pierwsze pytanie A';
    const gate = creationGate(f, 'header');
    const run = f.clickSend();
    await gate.entered.promise;
    const switching = f.clickB();
    const tasks: Promise<void>[] = [];
    quit({ addPromise(task) { tasks.push(task); } });
    let settled = false;
    const quitting = Promise.all(tasks).then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    const settledBeforeAdmission = settled;
    gate.release.resolve();
    await Promise.all([run, switching, quitting]);
    t.is(settledBeforeAdmission, false, 'Zadania quit muszą czekać na przyjęcie A bez ścieżki');
    const fresh = new AgentMemory({ adapter: { ...f.adapter } }, 'Mira');
    t.deepEqual((await fresh.loadActiveSession(f.tabs[0].sessionPath)).messages.map(m => m.content), ['Pierwsze pytanie A']);
    t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B']);
});


for (const stage of ['journal', 'epoch-read', 'epoch-append', 'epoch-readback', 'compression'] as const)
for (const pair of ['new-new', 'close-new', 'stop-close', 'load-close'] as const)
test.serial(`F7: ${stage} → ${pair} zachowuje właściciela operacji`, async t => {
    const f = await fixture();
    disposeFixture(t, f);
    if (stage.startsWith('epoch-')) {
        f.files.set(f.tabs[0].sessionPath, f.files.get(f.tabs[0].sessionPath)!.replace(/epoch: [a-f0-9]+\n/, ''));
        f.tabs[0].sessionEpoch = null;
        f.memory.setActiveSessionIdentity(f.tabs[0].sessionPath, null);
    }
    const buttons = lifecycleButtons(f), decision = deferred();
    const prompt = SessionCloseModal.prototype.prompt, open = OpenSessionModal.prototype.prompt;
    const dialogs: string[] = [];
    SessionCloseModal.prototype.prompt = async () => { dialogs.push('Nowa A'); await decision.promise; return { choice: 'discard' }; };
    OpenSessionModal.prototype.prompt = async () => { dialogs.push('Wczytaj A'); await decision.promise; return 'continue'; };
    t.teardown(() => { SessionCloseModal.prototype.prompt = prompt; OpenSessionModal.prototype.prompt = open; decision.resolve(); });
    const archive = f.memory.paths.sessionsArchive + '/old.md';
    f.files.set(archive, '---\nagent: Mira\n---\n\n## User\n\nHistoria z archiwum\n');
    startEditMessage.call(f.view as never, 0, 'Pytanie A');
    f.view.input_area.value = 'Poprawione pytanie A';
    const compression = stage === 'compression' ? holdRealCompression(f.windows[0]) : null;
    const io = stage === 'compression' ? null : await preparationGate(f, stage);
    const run = f.clickSend();
    await (compression?.entered.promise ?? io!.entered.promise);
    let load: Promise<void> | undefined;
    switch (pair) {
        case 'new-new': buttons.newSession(); buttons.newSession(); break;
        case 'close-new': buttons.close(); buttons.newSession(); break;
        case 'stop-close': f.clickStop(); buttons.close(); break;
        case 'load-close': load = handleLoadSession.call(f.view as never, archive); buttons.close(); break;
        default: { const unreachable: never = pair; throw new Error(unreachable); }
    }
    if (compression) compression.release(); else io!.release.resolve();
    await run;
    // Allow queued saves and opening the dialog, without resolving the user's choice.
    await new Promise(resolve => setImmediate(resolve));
    decision.resolve();
    await Promise.all([...buttons.requests, load]);
    t.deepEqual(dialogs, pair === 'new-new' ? ['Nowa A'] : pair === 'load-close' ? ['Wczytaj A'] : []);
    if (pair === 'new-new') {
        t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), []);
        const discarded = [...f.files.keys()].filter(path => path.includes('/.discarded/'));
        t.deepEqual(discarded, [f.memory.paths.sessionsActive + '/.discarded/A.md']);
        t.deepEqual((await f.memory.loadActiveSession(discarded[0])).messages.map(m => m.content), ['Poprawione pytanie A']);
        await f.clickB();
    } else {
        t.deepEqual(f.view.chatTabs.map(tab => [tab.sessionId, tab.sessionEpoch]), [['B', 'b'.repeat(32)]]);
        t.deepEqual((await f.memory.loadActiveSession(f.memory.paths.sessionsActive + '/A.md')).messages.map(m => m.content), ['Poprawione pytanie A']);
    }
    t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B']);
    t.deepEqual((await f.memory.loadActiveSession(f.memory.paths.sessionsActive + '/B.md')).messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B']);
    t.deepEqual(f.modelInputs, []);
});

for (const order of ['restore-close', 'close-restore'] as const)
test.serial(`F7: kompresja → ${order} nie zamyka zastępczej zakładki`, async t => {
    const f = await fixture();
    disposeFixture(t, f);
    Object.assign(f.view.plugin.agentManager, { getAllAgents: () => [{ name: 'Mira' }] });
    Object.assign(f.adapter, { stat: async () => ({ mtime: 1, size: 100 }) });
    f.adapter.list = async () => ({ files: [f.memory.paths.sessionsActive + '/A.md', f.memory.paths.sessionsActive + '/B.md'] });
    const buttons = lifecycleButtons(f);
    startEditMessage.call(f.view as never, 0, 'Pytanie A');
    f.view.input_area.value = 'Poprawka A';
    const gate = holdRealCompression(f.windows[0]), run = f.clickSend();
    await gate.entered.promise;
    if (order === 'close-restore') buttons.close();
    const restore = _restoreActiveSession.call(f.view as never);
    if (order === 'restore-close') buttons.close();
    gate.release();
    await Promise.all([run, restore, ...buttons.requests]);
    t.deepEqual(f.view.chatTabs.map(tab => tab.sessionPath?.split('/').pop()).sort(), order === 'restore-close' ? ['A.md', 'B.md'] : ['B.md']);
    t.deepEqual((await f.memory.loadActiveSession(f.memory.paths.sessionsActive + '/A.md')).messages.map(m => m.content), ['Poprawka A']);
    const b = f.view.chatTabs.find(tab => tab.sessionPath?.endsWith('/B.md'))!;
    await f.view._switchTab(b.sessionId!);
    t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B']);
    t.is(b.sessionEpoch, 'b'.repeat(32));
});


for (const boundary of ['close-save', 'new-save', 'new-switch', 'discard', 'todo', 'reset'] as const)
test.serial(`F7: po await ${boundary} operacja A nie zmienia B`, async t => {
    const f = await fixture(false, ['A', 'B', 'C']);
    disposeFixture(t, f);
    Object.assign(f.view.app.vault, { adapter: f.adapter });
    const buttons = lifecycleButtons(f), entered = deferred(), release = deferred(), decision = deferred();
    const prompt = SessionCloseModal.prototype.prompt;
    SessionCloseModal.prototype.prompt = async () => {
        if (boundary === 'new-save') await decision.promise;
        return { choice: 'discard' };
    };
    t.teardown(() => { SessionCloseModal.prototype.prompt = prompt; release.resolve(); decision.resolve(); });
    const gate = holdRealCompression(f.windows[0]);
    startEditMessage.call(f.view as never, 0, 'Pytanie A');
    f.view.input_area.value = 'Poprawka A';
    const run = f.clickSend();
    await gate.entered.promise;
    let held = false;
    const hold = async () => { if (!held) { held = true; entered.resolve(); await release.promise; } };
    if (boundary === 'close-save' || boundary === 'new-save') {
        f.view.handleSaveSession = async function(...args) { await handleSaveSession.apply(this as never, args); await hold(); };
    } else if (boundary === 'new-switch') {
        const switching = f.view._switchTab;
        f.view._switchTab = async id => { await switching(id); if (id === 'A') await hold(); };
    } else if (boundary === 'discard') {
        const discard = f.memory.discardActiveSession.bind(f.memory);
        f.memory.discardActiveSession = async path => { const result = await discard(path); await hold(); return result; };
    } else if (boundary === 'reset') {
        const reset = f.memory.startNewSession.bind(f.memory);
        f.memory.startNewSession = async () => { await reset(); await hold(); };
    } else {
        f.files.set('.pkm-assistant/artifacts/todo/mira-a.md', '- [ ] Zadanie A');
        const remove = f.adapter.remove;
        f.adapter.remove = async path => { await remove(path); if (path.includes('/todo/')) await hold(); };
    }
    if (boundary === 'close-save') { buttons.close(); buttons.close(); }
    else { buttons.newSession(); buttons.newSession(); }
    let earlySwitch: Promise<void> | undefined;
    if (boundary === 'new-switch') earlySwitch = f.clickB();
    gate.release();
    await Promise.race([entered.promise, Promise.all([run, ...buttons.requests]).then(() => { throw new Error(`Nie osiągnięto ${boundary}`); })]);
    // A is still visible at the three post-decision boundaries: this Close belongs to A.
    if (boundary === 'discard' || boundary === 'todo' || boundary === 'reset') buttons.close();
    const switching = f.clickB();
    release.resolve();
    await Promise.all([run, switching, earlySwitch]);
    if (boundary === 'new-save') {
        // Close A while its dialog is waiting, through the same production listener.
        await f.clickA();
        await buttons.close();
    }
    decision.resolve();
    await Promise.all(buttons.requests);
    t.deepEqual(f.view.chatTabs.filter(tab => tab.sessionId === 'B' || tab.sessionId === 'C').map(tab => [tab.sessionId, tab.sessionEpoch]), [['B', 'b'.repeat(32)], ['C', 'c'.repeat(32)]]);
    t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B']);
    t.is(f.memory.activeSessionPath, f.memory.paths.sessionsActive + '/B.md');
    const fresh = new AgentMemory({ adapter: { ...f.adapter } }, 'Mira');
    t.deepEqual((await fresh.loadActiveSession(f.memory.paths.sessionsActive + '/B.md')).messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B']);
    t.deepEqual((await fresh.loadActiveSession(f.memory.paths.sessionsActive + '/C.md')).messages.map(m => m.content), ['Pytanie C', 'Odpowiedź C']);
    if (boundary === 'discard' || boundary === 'todo' || boundary === 'reset') {
        t.deepEqual((await fresh.loadActiveSession(f.memory.paths.sessionsActive + '/.discarded/A.md')).messages.map(m => m.content), ['Poprawka A']);
        t.is(f.view.chatTabs[0].sessionEpoch, null);
    }
});

for (const change of ['epoch', 'path', 'tab'] as const)
test.serial(`F7: modal Nowa odmawia po zmianie ${change} właściciela`, async t => {
    const f = await fixture();
    disposeFixture(t, f);
    const buttons = lifecycleButtons(f), opened = deferred(), release = deferred();
    const prompt = SessionCloseModal.prototype.prompt;
    SessionCloseModal.prototype.prompt = async () => { opened.resolve(); await release.promise; return { choice: 'discard' }; };
    t.teardown(() => { SessionCloseModal.prototype.prompt = prompt; release.resolve(); });
    const run = buttons.newSession();
    await opened.promise;
    // Boundary event: a new session identity is published while the old dialog is open.
    const tab = f.tabs[0];
    if (change === 'epoch') tab.sessionEpoch = 'd'.repeat(32);
    else if (change === 'path') tab.sessionPath = f.memory.paths.sessionsActive + '/D.md';
    else f.view.chatTabs[0] = { ...tab };
    release.resolve();
    await run;
    t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A']);
    t.deepEqual((await f.memory.loadActiveSession(f.memory.paths.sessionsActive + '/A.md')).messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A']);
    t.deepEqual((await f.memory.loadActiveSession(f.memory.paths.sessionsActive + '/B.md')).messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B']);
});


test.serial('F7: quit czeka na oba trwające przyjęcia A i B', async t => {
    const f = await fixture(true);
    disposeFixture(t, f);
    let quit!: (tasks: { addPromise(task: Promise<void>): void }) => void;
    Object.assign(f.view.app.workspace, { on(event: string, callback: typeof quit) { if (event === 'quit') quit = callback; return {}; } });
    Object.assign(f.view, { registerEvent() {}, registerInterval(id: number) { window.clearInterval(id); }, async _restoreActiveSession() {} });
    await initSessionManager.call(f.view as never);
    const a = creationGate(f, 'header');
    f.view.input_area.value = 'Pierwsze pytanie A';
    const runA = f.clickSend();
    await a.entered.promise;
    const switching = f.clickB();
    const b = holdRealCompression(f.windows[1]);
    f.view.input_area.value = 'Kolejne pytanie B';
    const runB = f.clickSend();
    await b.entered.promise;
    const tasks: Promise<void>[] = [];
    quit({ addPromise(task) { tasks.push(task); } });
    let settled = false;
    const quitting = Promise.all(tasks).then(() => { settled = true; });
    b.release();
    await runB;
    await new Promise(resolve => setImmediate(resolve));
    const settledWithAStillPending = settled;
    a.release.resolve();
    await Promise.all([runA, switching, quitting]);
    t.is(settledWithAStillPending, false, 'Ukończenie B nie zwalnia quit czekającego na A');
    const fresh = new AgentMemory({ adapter: { ...f.adapter } }, 'Mira');
    t.deepEqual((await fresh.loadActiveSession(f.tabs[0].sessionPath)).messages.map(m => m.content), ['Pierwsze pytanie A']);
    t.deepEqual((await fresh.loadActiveSession(f.tabs[1].sessionPath)).messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B', 'Kolejne pytanie B']);
});

for (const operation of ['close', 'new'] as const)
test.serial(`F7: ${operation} po zapisie odmawia zmienionej epoce A`, async t => {
    const f = await fixture();
    disposeFixture(t, f);
    const buttons = lifecycleButtons(f), entered = deferred(), release = deferred();
    f.view.handleSaveSession = async function(...args) { await handleSaveSession.apply(this as never, args); entered.resolve(); await release.promise; };
    const prompt = SessionCloseModal.prototype.prompt;
    SessionCloseModal.prototype.prompt = async () => ({ choice: 'discard' });
    t.teardown(() => { SessionCloseModal.prototype.prompt = prompt; release.resolve(); });
    const run = operation === 'close' ? buttons.close() : buttons.newSession();
    await entered.promise;
    f.tabs[0].sessionEpoch = 'd'.repeat(32);
    f.memory.setActiveSessionIdentity(f.tabs[0].sessionPath, 'd'.repeat(32));
    release.resolve();
    await run;
    t.deepEqual(f.view.chatTabs.map(tab => [tab.sessionId, tab.sessionEpoch]), [['A', 'd'.repeat(32)], ['B', 'b'.repeat(32)]]);
    t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A']);
    t.deepEqual((await f.memory.loadActiveSession(f.tabs[0].sessionPath)).messages.map(m => m.content), ['Pytanie A', 'Odpowiedź A']);
});


test.serial('F7: Nowa podczas tworzenia sesji bez ID kończy przyjęcie przed resetem', async t => {
    const f = await fixture(true);
    disposeFixture(t, f);
    Object.assign(f.tabs[0], { sessionId: undefined });
    const state = f.view._agentStates.get('A');
    if (!state) throw new Error('Brak stanu świeżej zakładki A');
    f.view._agentStates.delete('A');
    f.view._agentStates.set('Mira', state);
    const buttons = lifecycleButtons(f), gate = creationGate(f, 'header');
    const prompt = SessionCloseModal.prototype.prompt;
    SessionCloseModal.prototype.prompt = async () => ({ choice: 'discard' });
    t.teardown(() => { SessionCloseModal.prototype.prompt = prompt; });
    f.view.input_area.value = 'Pierwsze pytanie A';
    const run = f.clickSend();
    await gate.entered.promise;
    buttons.newSession(); buttons.newSession();
    gate.release.resolve();
    await Promise.all([run, ...buttons.requests]);
    const discarded = [...f.files.keys()].filter(path => path.includes('/.discarded/'));
    t.is(discarded.length, 1);
    t.deepEqual((await f.memory.loadActiveSession(discarded[0])).messages.map(m => m.content), ['Pierwsze pytanie A']);
    t.deepEqual(f.view.rollingWindow.messages.map(m => m.content), []);
    t.deepEqual(f.view.chatTabs.map(tab => tab.sessionEpoch), [null, 'b'.repeat(32)]);
    t.deepEqual((await f.memory.loadActiveSession(f.memory.paths.sessionsActive + '/B.md')).messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B']);
});

for (const replacement of ['path', 'epoch'] as const)
test.serial(`F7: tworzenie sesji nie uprawnia lifecycle do przejęcia obcej ${replacement}`, async t => {
    const f = await fixture(true);
    disposeFixture(t, f);
    const buttons = lifecycleButtons(f), gate = creationGate(f, 'header');
    const prompt = SessionCloseModal.prototype.prompt;
    SessionCloseModal.prototype.prompt = async () => ({ choice: 'discard' });
    t.teardown(() => { SessionCloseModal.prototype.prompt = prompt; });
    f.view.input_area.value = 'Pierwsze pytanie A';
    const run = f.clickSend();
    await gate.entered.promise;
    buttons.newSession();
    // Another session identity replaces the empty identity while B is pending.
    // The sender rejects publication to this owner; lifecycle must reject it too.
    const replacementPath = f.memory.paths.sessionsActive + '/D.md';
    if (replacement === 'path') f.tabs[0].sessionPath = replacementPath;
    else f.tabs[0].sessionEpoch = 'd'.repeat(32);
    gate.release.resolve();
    await Promise.all([run, ...buttons.requests]);
    t.deepEqual([f.tabs[0].sessionPath, f.tabs[0].sessionEpoch], replacement === 'path' ? [replacementPath, null] : ['', 'd'.repeat(32)]);
    t.deepEqual((await f.memory.loadActiveSession(f.memory.paths.sessionsActive + '/B.md')).messages.map(m => m.content), ['Pytanie B', 'Odpowiedź B']);
});
