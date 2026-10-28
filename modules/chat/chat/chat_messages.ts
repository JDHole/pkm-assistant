/**
 * @module chat_messages
 * Message rendering and manipulation methods extracted from ChatView.
 * All functions use `this` and are mixed into ChatView.prototype via Object.assign.
 */

import { MarkdownRenderer } from 'obsidian';
import { SkinManager, UiIcons, hexToRgbTriplet, setSvg } from '../../crystal-soul/index.js';
import {
    createCompactToolChip,
    createToolCallDisplay,
    createThinkingBlock,
    createSubAgentBlock,
    createNoteLink,
} from '../../ui-components/index.js';
import { t, getDateLocale } from '../../../core/i18n/index.js';
import { buildDelegateBlockOptions } from './delegateBlockView.js';
import { buildSubTaskResultModel } from '../../sub-agents/index.js';
import { subAgentCallView } from './subAgentCallView.js';
import { answeredSubQuestion, renderAnsweredSubQuestion } from './subQuestionView.js';
import { registerUrlsFromText } from '../../web/index.js';
import { registerUrlsIfHuman } from './messagePrivileges.js';
// Historia liczy status narzędzia TĄ SAMĄ regułą co żywa tura (chat_streaming).
import { resolveMessageOrigin, toolResultStatus } from '../../../core/index.js';
// Wiadomości maszynowe (spec A3, "Czat bez ścian") - powiadomienie o wyniku suba z tła i
// przywołanie agenta po interakcji z artefaktem docierają jako `role: 'user'` (treść dla MODELU
// bez zmian), ale w widoku są kafelkiem systemowym zamiast dymka. Klasyfikator jest czysty (zero
// `obsidian`), mieszka obok w tym samym module. Render (`renderMachineTile`, uwaga 5 spec A3-fix)
// jest TRZECIM plikiem w module, importowanym przez oba mixiny (ten i `chat_streaming.ts`) - bez
// tego byłaby to trzecia kopia tej samej logiki (patrz komentarz modułu `machineTile.ts`).
import { buildMachineView, getSubTaskNotificationTaskId } from './machineMessage.js';
import { renderMachineTile } from './machineTile.js';
// Krysztal agenta jako CSS var `--cs-agent-crystal` (2.3.0, kolumna dymkow) - jeden producent
// dla append_message/render_messages TU i `_ensureAgentMessageContainer` w chat_streaming.ts.
import { agentCrystalCssVar } from './agentCrystal.js';
// Uwaga 10 (spec A2-fix): pokwitowanie delegacji w tle odtworzone z historii sklada details
// TĄ SAMĄ funkcją co żywa tura - jedno źródło prawdy dla kolejności linii (identyfikator
// zawsze ostatni). Import wewnątrz `modules/chat/` (oba pliki to mixiny tego samego modułu,
// żaden cykl - `chat_streaming.ts` nie importuje z `chat_messages.ts`), nie deep-import w
// obcy moduł.
import { buildBackgroundReceiptText, renderNotificationWithReceipt } from './backgroundReceipt.js';
// Receiver mixina = złożony `ChatView` (klasa + osiem deklaracji mixinów). Cykl typów
// chat_view ↔ mixin jest legalny i znika w buildzie (`import type`).
import type { ChatViewLike } from './chatViewShape.js';
import type { SubAgentToolCallDetail, SubAgentUsage } from '../../ui-components/index.js';
import type { ContentBlock, RollingMessage, TextContentBlock, ToolCall } from './RollingWindow.js';

function addTaskQuestion(view: ReturnType<typeof buildMachineView>, task: import('../../sub-agents/index.js').SubTask | undefined): void {
    if (!view?.subAgentResult || !task) return;
    const model = buildSubTaskResultModel({ questionState: task.questionState, question: task.result?.question, thread: { kind: 'unknown' } });
    if (model.openQuestion === undefined) return;
    view.subAgentResult.openQuestion = model.openQuestion;
    view.subAgentResult.title = `${task.name || t('subagent.label')} ${t(model.endLabelKey)}`;
}

type MessageRole = 'user' | 'assistant';
type MessageContent = string | ContentBlock[];

/**
 * Wynik narzędzia odtwarzany z historii. Kształt zależy od serwera, więc modelujemy
 * DOKŁADNIE pola, które render czyta. Trzy ostatnie lecą PROSTO do bloku subagenta
 * (`modules/ui-components`), więc nazywamy je jego typami — właściciel kształtu jest tam,
 * nie tutaj (dawne `unknown[]`/`unknown` nie przechodziły do jego wymaganych pól).
 */
interface HistoryToolOutput {
    [key: string]: unknown;
    result?: string;
    error?: string;
    tools_used?: string[];
    tool_call_details?: SubAgentToolCallDetail[];
    duration_ms?: number;
    usage?: SubAgentUsage | null;
    /** Delegacja zlecona w tle (uwaga 10, spec A2-fix) - kształt jak żywy `ChatToolResult`
     *  (`chat_streaming.ts`), odtworzony z tekstu wyniku narzędzia zapisanego w sesji. */
    started?: boolean;
    task_id?: string;
    name?: string;
    aspect?: string;
    sub_id?: string;
    tasks?: Array<{ task_id?: string; sub_id?: string; name?: string; queued?: boolean }>;
    queued?: number;
}

/** Argumenty wywołania `delegate` odtworzone z historii. */
interface DelegateArgs {
    task?: string;
    aspect?: string;
    action?: string;
}
interface TrimInfo {
    trimmed: number;
    details?: Array<{ toolName: string; originalSize: number }>;
    savedChars: number;
    tokensBefore?: number;
    tokensAfterTrim?: number;
    totalTrimmed: number;
}

/**
 * Append a message to chat history and render it.
 * @param {string} role - 'user' | 'assistant'
 * @param {string|Array} content - Text string or multimodal content blocks array
 * @param {string} [displayText] - Optional display text for UI (when content is array)
 * @param {Object} [meta] - dodatkowe pola na wiadomości w oknie kontekstu (np.
 *   `{_subTaskNotification: true}` — znacznik, że turę wywołał wynik suba z tła, a nie user).
 *   Trafiają tam, gdzie `timestamp`; render ich nie czyta.
 *   Pole `origin` (`'human'` | `'machine'`) jest PROWENIENCJĄ — decyduje o przywilejach
 *   bezpieczeństwa (rejestr adresów dla `web_read`). Brak = maszyna, patrz
 *   `core/security/messageOrigin.ts`.
 */
export async function append_message(this: ChatViewLike, role: MessageRole, content: MessageContent, displayText?: string, meta?: Partial<RollingMessage>): Promise<void> {
    const timestamp = new Date().toLocaleTimeString(getDateLocale(), { hour: '2-digit', minute: '2-digit' });

    // Add to history with timestamp
    await this.rollingWindow.addMessage(role, content, { timestamp, ...(meta || {}) });
    this.updateTokenCounter();

    // Determine what to show in UI vs what goes to API
    const uiText = displayText || (typeof content === 'string' ? content : this._contentBlocksToText(content));
    const activeAgent = this.plugin?.agentManager?.getActiveAgent();
    const agentColor = SkinManager.getAgentColor(activeAgent || 'default');
    const agentRgb = hexToRgbTriplet(agentColor);
    const idx = this.rollingWindow.messages.length - 1;

    let managedScroll = false;
    if (role === 'user') {
        // URLs the user types are known-provenance and may be fetched by web_read. O proweniencji
        // decyduje JAWNY znacznik `meta.origin`, a nie to, że dymek jest rysowany z rolą 'user'.
        // Bez znacznika = maszyna (fail-closed), więc adres z treści artefaktu czy z wyniku suba
        // NIE odblokowuje `web_read`.
        registerUrlsIfHuman(uiText, meta, registerUrlsFromText);
        // Powiadomienie o wyniku suba z tła / przywołanie agenta po interakcji z artefaktem
        // (spec A3) - klasyfikacja przez meta (świeżo dopisana kilka linii wyżej na tej samej
        // wiadomości). Zasada nadrzędna: treść dla MODELU zostaje identyczna, zmienia się
        // WYŁĄCZNIE render w oknie czatu.
        const machineView = buildMachineView({ role, content, ...(meta || {}) }, { t, getThread: id => this.plugin?.subTaskRegistry?.getThread?.(id) });
        if (machineView) {
            const id = getSubTaskNotificationTaskId({ role, content, ...(meta || {}) });
            if (id) {
                addTaskQuestion(machineView, this.plugin?.subTaskRegistry?.getTask?.(id));
                await renderNotificationWithReceipt(this.messages_container, this.plugin, machineView, id, () => this._scheduleConnectorRedraw?.());
                managedScroll = true;
            } else await renderMachineTile(this.messages_container, this.plugin, machineView);
        } else {
            const userDiv = this.messages_container.createDiv({ cls: 'cs-message cs-message--user' });
            userDiv.style.setProperty('--cs-agent-color-rgb', agentRgb);
            const textDiv = userDiv.createDiv({ cls: 'cs-message__text' });
            if (Array.isArray(content)) {
                this._renderMultimodalUserContent(textDiv, content, uiText);
            } else {
                this._renderUserText(textDiv, uiText);
            }
            const metaEl = userDiv.createDiv({ cls: 'cs-message__meta' });
            metaEl.createSpan({ text: timestamp });
            this.addMessageActions(metaEl, uiText, 'user', idx);
        }
    } else {
        // Kolumna dymkow (2.3.0, kolejna faza "Czat bez scian"): naglowek serii znikl calkiem -
        // krysztal siedzi teraz przy KAZDYM elemencie agenta (kafelek/dymek tekstu), rysowany CSS
        // pseudo-elementem `::after` sterowanym ta zmienna (patrz `chat_view.css`).
        const agentDiv = this.messages_container.createDiv({ cls: 'cs-message cs-message--agent' });
        agentDiv.style.setProperty('--cs-agent-color-rgb', agentRgb);
        agentDiv.style.setProperty('--cs-agent-crystal', agentCrystalCssVar(activeAgent || 'Agent', agentColor));
        const textDiv = agentDiv.createDiv({ cls: 'cs-message__text' });
        await MarkdownRenderer.render(this.app, uiText, textDiv, '', this);
        const metaEl = agentDiv.createDiv({ cls: 'cs-message__meta' });
        metaEl.createSpan({ text: timestamp });
        this._renderCacheSavingsBadge?.(metaEl, this.rollingWindow.messages[idx]?.cache);
        this.addMessageActions(metaEl, uiText, 'assistant', idx);
    }

    // Scroll to bottom
    if (!managedScroll) this.scrollToBottom();
}

export async function render_messages(this: ChatViewLike, createDelegateBlock: typeof createSubAgentBlock = createSubAgentBlock): Promise<void> {
    this.messages_container.empty();
    const notificationTaskIdsAfter = new Map<number, Set<string>>();
    const laterNotificationIds = new Set<string>();
    for (let i = this.rollingWindow.messages.length - 1; i >= 0; i--) {
        notificationTaskIdsAfter.set(i, new Set(laterNotificationIds));
        const id = getSubTaskNotificationTaskId(this.rollingWindow.messages[i]);
        if (id) laterNotificationIds.add(id);
    }
    const agent = this.plugin?.agentManager?.getActiveAgent();
    const agentColor = SkinManager.getAgentColor(agent || 'default');
    const agentRgb = hexToRgbTriplet(agentColor);
    const agentName = agent?.name || 'Agent';

    for (let idx = 0; idx < this.rollingWindow.messages.length; idx++) {
        const msg = this.rollingWindow.messages[idx];
        const notificationTaskIds = notificationTaskIdsAfter.get(idx) || new Set<string>();
        // Skip tool messages (they were displayed inline with the tool call)
        if (msg.role === 'tool') continue;

        if (msg.role === 'system') {
            const partialView = buildMachineView(msg, { t, getTask: id => this.plugin?.subTaskRegistry?.getTask?.(id), getThread: id => this.plugin?.subTaskRegistry?.getThread?.(id) });
            if (partialView?.kind === 'loop_partial') {
                await renderMachineTile(this.messages_container, this.plugin, partialView);
            }
            continue;
        }

        const uiText = typeof msg.content === 'string' ? msg.content : this._contentBlocksToText(msg.content);

        if (msg.role === 'user') {
            // Wiadomość maszynowa (spec A3) - meta na żywo, albo (po restarcie Obsidiana, meta
            // nie przeżywa zapisu sesji) klasyfikacja po treści wewnątrz `buildMachineView`.
            const machineView = buildMachineView(msg, { t, getTask: id => this.plugin?.subTaskRegistry?.getTask?.(id), getThread: id => this.plugin?.subTaskRegistry?.getThread?.(id) });
            if (machineView) {
                const id = getSubTaskNotificationTaskId(msg);
                if (id) addTaskQuestion(machineView, this.plugin?.subTaskRegistry?.getTask?.(id));
                await renderMachineTile(this.messages_container, this.plugin, machineView);
            } else {
                // -- USER MESSAGE - .cs-message--user --
                const userDiv = this.messages_container.createDiv({ cls: 'cs-message cs-message--user' });
                userDiv.style.setProperty('--cs-agent-color-rgb', agentRgb);

                // Text content
                const textDiv = userDiv.createDiv({ cls: 'cs-message__text' });
                if (Array.isArray(msg.content)) {
                    this._renderMultimodalUserContent(textDiv, msg.content, uiText);
                } else {
                    this._renderUserText(textDiv, uiText);
                }

                // Meta (hover: timestamp + actions)
                const meta = userDiv.createDiv({ cls: 'cs-message__meta' });
                const timestamp = msg.timestamp || '';
                if (timestamp) meta.createSpan({ text: timestamp });
                this.addMessageActions(meta, uiText, 'user', idx);
            }

        } else if (msg.role === 'assistant') {
            const hasToolCalls = (msg.tool_calls?.length as number) > 0;
            // Kod review MINOR #4: `content` puste, BRAK `tool_calls` i BRAK `reasoning_content`
            // nie ma czego pokazać poza rzędem akcji (kopiuj/usuń/kciuki) przyczepionym do
            // pustej treści - realny, obserwowalny defekt: `restore` po BUG C1 potrafi zwrócić
            // taką wiadomość, gdy `**tool_calls:**` w pliku istniało, ale nie dało się
            // sparsować (`parseSessionToolCalls` → `null`, `activeSessionFormat.ts`). Wiadomość
            // z realną treścią (tekst, tool_calls, myślenie) renderuje się jak dotąd - to NIE
            // jest zmiana zachowania dla legalnych tool-calling tur (mają chip, patrz niżej).
            if (!uiText && !hasToolCalls && !msg.reasoning_content) continue;

            // ── AGENT MESSAGE — .cs-message--agent ──
            // Kolumna dymkow (2.3.0): naglowek serii znikl - krysztal siedzi na KAZDYM elemencie
            // agenta (kafelek/dymek tekstu) przez CSS `::after`, sterowany ta zmienna.
            const agentDiv = this.messages_container.createDiv({ cls: 'cs-message cs-message--agent' });
            agentDiv.style.setProperty('--cs-agent-color-rgb', agentRgb);
            agentDiv.style.setProperty('--cs-agent-crystal', agentCrystalCssVar(agent || agentName, agentColor));

            // Reconstruct action rows from metadata (thinking, tool_calls)
            // Note: addMessage() spreads metadata into top-level, so tool_calls/reasoning_content are direct props
            if (msg.reasoning_content) {
                const thinkRow = createThinkingBlock(msg.reasoning_content, false);
                agentDiv.appendChild(thinkRow);
            }
            if (hasToolCalls) {
                for (const tc of msg.tool_calls as ToolCall[]) {
                    const tcName = tc.function?.name || tc.name || 'unknown';
                    const tcArgs = tc.function?.arguments || tc.arguments;
                    // Find matching tool result in next messages
                    let tcOutput: HistoryToolOutput | string | null = null;
                    for (let j = idx + 1; j < this.rollingWindow.messages.length; j++) {
                        const m = this.rollingWindow.messages[j];
                        if (m.role === 'tool' && m.tool_call_id === tc.id) {
                            // TS-boundary: transkrypt z dysku — treść wyniku narzędzia jest stringiem
                            // JSON dowolnego serwera; render czyta z niego tylko pola `HistoryToolOutput`.
                            try { tcOutput = JSON.parse(m.content as string) as HistoryToolOutput; } catch { tcOutput = m.content as string; }
                            break;
                        }
                    }
                    const _hArgs = (typeof tcArgs === 'string'
                        ? (() => { try { return JSON.parse(tcArgs) as DelegateArgs; } catch { return {}; } })()
                        : (tcArgs || {})) as DelegateArgs;
                    const historyOutput = (typeof tcOutput === 'object' && tcOutput) ? tcOutput : null;
                    const isSubAgent = subAgentCallView(tcName, _hArgs, historyOutput, 'result') === 'block';
                    const answeredQuestion = answeredSubQuestion(historyOutput?.sub_question_view);
                    if (tcName === 'sub_agent' && _hArgs.action === 'message' && historyOutput?.success === true && answeredQuestion) {
                        agentDiv.appendChild(renderAnsweredSubQuestion(answeredQuestion));
                        continue;
                    }
                    if (isSubAgent) {
                        const taskQuery = _hArgs.task || '';
                        const _hName = tcName === 'sub_agent'
                            ? historyOutput?.name || historyOutput?.aspect || historyOutput?.sub_id || ''
                            : historyOutput?.name || historyOutput?.aspect || _hArgs.aspect || historyOutput?.sub_id || '';
                        let block: HTMLElement;
                        if (historyOutput && historyOutput.started === true) {
                            // Uwaga 10 (spec A2-fix): delegacja zlecona w TLE, odtworzona z
                            // historii, dawniej renderowala sie jak zielony wynik z samym
                            // "Zadanie" (ta gałąź nie istniała - `historyOutput` bez `pending`
                            // leciał wprost do gałęzi niżej). Ten sam pending-kafelek co na
                            // żywo (`chat_streaming.ts`), ta sama funkcja receipt.
                            const startedList = Array.isArray(historyOutput.tasks)
                                ? historyOutput.tasks
                                : [{ task_id: historyOutput.task_id, name: historyOutput.name }];
                            const receiptBlocks = startedList.flatMap(item => {
                                const taskId = typeof item?.task_id === 'string' ? item.task_id : '';
                                if (taskId && notificationTaskIds.has(taskId)) return [];
                                const markReceipt = (block: HTMLElement) => {
                                    if (taskId) block.setAttribute('data-subtask-receipt-id', taskId);
                                    return block;
                                };
                                const task = taskId ? this.plugin?.subTaskRegistry?.getTask?.(taskId) : undefined;
                                const threadId = typeof task?.threadId === 'string' ? task.threadId
                                    : typeof item?.sub_id === 'string' ? item.sub_id
                                        : typeof historyOutput.sub_id === 'string' ? historyOutput.sub_id : '';
                                const thread = threadId ? this.plugin?.subTaskRegistry?.getThread?.(threadId) : undefined;
                                const known = !!task || !!thread;
                                const name = item?.name || _hName || '';
                                if (!known) {
                                    const resultView = {
                                        title: t('chat.subresult.restart', { name: name || t('subagent.label') }),
                                        status: 'error' as const,
                                        missingTargets: [], effects: [], notes: [],
                                    };
                                    return [markReceipt(createSubAgentBlock({ type: tcName, agentName: name, query: taskQuery, status: 'error', resultView }))];
                                }
                                if (!task && (thread?.phase === 'idle' || thread?.phase === 'closed')) {
                                    const resultView = {
                                        title: t('chat.subresult.unavailable', { name: name || t('subagent.label') }),
                                        status: 'error' as const,
                                        missingTargets: [], effects: [], notes: [],
                                    };
                                    return [markReceipt(createSubAgentBlock({ type: tcName, agentName: name, query: taskQuery, status: 'error', resultView }))];
                                }
                                const isActive = task ? task.status === 'running'
                                    : thread?.phase === 'queued' || thread?.phase === 'running';
                                if (!isActive) {
                                    const outcome = task?.outcome;
                                    const failed = task?.status === 'error' || outcome?.end?.kind === 'stopped' || outcome?.end?.kind === 'failed';
                                    const resultThread = thread?.phase === 'idle' && thread.reusable && threadId
                                        ? { kind: 'reusable' as const, sub_id: threadId }
                                        : { kind: 'unknown' as const };
                                    const options = buildDelegateBlockOptions({
                                        success: !failed,
                                        error: task?.error || (failed ? t('mcp.delegate.outcome_note') : undefined),
                                        result: task?.result ? { text: task.result.text, handoff: task.result.handoff } : '',
                                        partial: task?.partial ? { text: task.partial.text } : undefined,
                                        outcome,
                                        effects: thread?.effects,
                                        thread: resultThread,
                                    }, { type: tcName, agentName: name, query: taskQuery });
                                    const question = buildSubTaskResultModel({ questionState: task?.questionState, question: task?.result?.question, thread: resultThread });
                                    if (options.resultView && question.openQuestion !== undefined) {
                                        options.resultView.openQuestion = question.openQuestion;
                                        options.resultView.title = `${name || t('subagent.label')} ${t(question.endLabelKey)}`;
                                    }
                                    return [markReceipt(createDelegateBlock(options))];
                                }
                                return [markReceipt(createSubAgentBlock({ type: tcName, pending: true, status: 'success', agentName: name,
                                    query: taskQuery, response: buildBackgroundReceiptText([item], item?.queued ? 1 : startedList.length === 1 ? historyOutput.queued : undefined) }))];
                            });
                            if (receiptBlocks.length) {
                                for (const receipt of receiptBlocks) agentDiv.appendChild(receipt);
                                continue;
                            }
                            if (startedList.length > 0 && startedList.every(item => typeof item?.task_id === 'string' && notificationTaskIds.has(item.task_id))) continue;
                            block = createSubAgentBlock({ type: tcName, pending: true, status: 'success', agentName: _hName,
                                query: taskQuery, response: buildBackgroundReceiptText(startedList, historyOutput.queued) });
                        } else {
                            const options = buildDelegateBlockOptions(tcOutput || {}, { type: tcName, agentName: _hName, query: taskQuery });
                            const question = buildSubTaskResultModel({ question: historyOutput?.question, thread: { kind: 'unknown' } });
                            if (options.resultView && question.openQuestion !== undefined) {
                                options.resultView.openQuestion = question.openQuestion;
                                options.resultView.title = `${_hName || t('subagent.label')} ${t(question.endLabelKey)}`;
                            }
                            block = createDelegateBlock(options);
                        }
                        agentDiv.appendChild(block);
                    } else {
                        const makeDisplay = this.env?.settings?.pkmAssistant?.compactToolChips === false ? createToolCallDisplay : createCompactToolChip;
                        const display = makeDisplay({
                            name: tcName,
                            input: typeof tcArgs === 'string' ? (() => { try { return JSON.parse(tcArgs) as unknown; } catch { return tcArgs; } })() : tcArgs,
                            output: tcOutput,
                            status: toolResultStatus(tcOutput),
                            error: (tcOutput as HistoryToolOutput)?.error
                        });
                        agentDiv.appendChild(display);
                    }
                }
            }

            // Text response
            if (uiText) {
                const textDiv = agentDiv.createDiv({ cls: 'cs-message__text' });
                await MarkdownRenderer.render(this.app, uiText, textDiv, '', this);
            }

            // Meta (hover: timestamp + actions)
            const meta = agentDiv.createDiv({ cls: 'cs-message__meta' });
            const timestamp = msg.timestamp || '';
            if (timestamp) meta.createSpan({ text: timestamp });
            this._renderCacheSavingsBadge?.(meta, msg.cache);
            this.addMessageActions(meta, uiText, 'assistant', idx);
        }
    }

    // Draw connector lines
    this._drawConnectorLines();
}

/**
 * Render user text with inline @[Name] mention badges.
 * Falls back to plain text if no mentions found.
 *
 * Mencje klikalne (spec C, "Czat bez scian" 2.3.0): nazwa z `@[Nazwa]` jest rozwiazywana na
 * sciezke notatki TUTAJ, w widoku - `this.app.metadataCache.getFirstLinkpathDest(name, '')` -
 * bo TYLKO widok zna `app`; `createNoteLink` (`modules/ui-components/`) dostaje juz gotowa
 * sciezke, jak wszedzie indziej w tym mechanizmie. Nazwa bez odpowiednika notatki w vaultcie
 * (agent, osoba, cokolwiek nie-notatkowego) zostaje zwyklym, NIEklikalnym tekstem badge'a -
 * stare zachowanie bez zmian.
 */
export function _renderUserText(this: ChatViewLike, container: HTMLElement, text: string): void {
    if (!text.includes('@[')) {
        container.createEl('p', { text });
        return;
    }
    const p = container.createEl('p');
    const parts = text.split(/(@\[[^\]]+\])/g);
    for (const part of parts) {
        const match = part.match(/^@\[(.+)\]$/);
        if (match) {
            const name = match[1];
            const badge = p.createSpan({ cls: 'pkm-mention-badge' });
            const dest = this.app?.metadataCache?.getFirstLinkpathDest?.(name, '') ?? null;
            if (dest) {
                createNoteLink(badge, dest.path, `@ ${name}`);
            } else {
                badge.textContent = `@ ${name}`;
            }
        } else {
            p.appendText(part);
        }
    }
}

export function addMessageActions(this: ChatViewLike, metaEl: HTMLElement, content: string, role: MessageRole, idx: number): void {
    // Copy button
    const copyBtn = metaEl.createEl('button', { cls: 'cs-message__meta-btn' });
    setSvg(copyBtn, UiIcons.copy(12));
    copyBtn.setAttribute('aria-label', t('chat.msg.copy'));
    copyBtn.onclick = async (e: MouseEvent) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(content);
        setSvg(copyBtn, UiIcons.check(12));
        window.setTimeout(() => { setSvg(copyBtn, UiIcons.copy(12)); }, 2000);
    };

    // Delete button
    const deleteBtn = metaEl.createEl('button', { cls: 'cs-message__meta-btn' });
    setSvg(deleteBtn, UiIcons.trash(12));
    deleteBtn.setAttribute('aria-label', t('chat.msg.delete'));
    deleteBtn.onclick = (e: MouseEvent) => {
        e.stopPropagation();
        if (idx < this.rollingWindow.messages.length &&
            this.rollingWindow.messages[idx].content === content &&
            this.rollingWindow.messages[idx].role === role) {
            this.rollingWindow.messages.splice(idx, 1);
            void this.render_messages();
            this.updateTokenCounter();
        } else {
            const foundIdx = this.rollingWindow.messages.findIndex((m: RollingMessage) => m.content === content && m.role === role);
            if (foundIdx > -1) {
                this.rollingWindow.messages.splice(foundIdx, 1);
                void this.render_messages();
                this.updateTokenCounter();
            }
        }
    };

    if (role === 'user') {
        const editBtn = metaEl.createEl('button', { cls: 'cs-message__meta-btn' });
        setSvg(editBtn, UiIcons.edit(12));
        editBtn.setAttribute('aria-label', t('chat.msg.edit'));
        editBtn.onclick = (e: MouseEvent) => { e.stopPropagation(); this.startEditMessage(idx, content); };
    }

    if (role === 'assistant') {
        // Thumbs up/down
        const thumbsUp = metaEl.createEl('button', { cls: 'cs-message__meta-btn' });
        setSvg(thumbsUp, '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M3.5,6 V10 H2 V6 Z M3.5,6 L5,3 C5,2 6,1.2 6.5,2 L6.5,4.5 H9 C10,4.5 10.3,5.3 10,6 L9,10 H3.5" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>');
        const thumbsDown = metaEl.createEl('button', { cls: 'cs-message__meta-btn' });
        setSvg(thumbsDown, '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M8.5,6 V2 H10 V6 Z M8.5,6 L7,9 C7,10 6,10.8 5.5,10 L5.5,7.5 H3 C2,7.5 1.7,6.7 2,6 L3,2 H8.5" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>');

        const msg = this.rollingWindow.messages[idx];
        if (msg?.metadata?.reaction === 'positive') thumbsUp.classList.add('active');
        if (msg?.metadata?.reaction === 'negative') thumbsDown.classList.add('active');

        thumbsUp.onclick = (e: MouseEvent) => {
            e.stopPropagation();
            const msg = this.rollingWindow.messages[idx];
            if (msg) {
                msg.metadata = msg.metadata || {};
                if (thumbsUp.classList.contains('active')) {
                    delete msg.metadata.reaction;
                    thumbsUp.classList.remove('active');
                } else {
                    msg.metadata.reaction = 'positive';
                    thumbsUp.classList.add('active');
                    thumbsDown.classList.remove('active');
                }
            }
        };
        thumbsDown.onclick = (e: MouseEvent) => {
            e.stopPropagation();
            const msg = this.rollingWindow.messages[idx];
            if (msg) {
                msg.metadata = msg.metadata || {};
                if (thumbsDown.classList.contains('active')) {
                    delete msg.metadata.reaction;
                    thumbsDown.classList.remove('active');
                } else {
                    msg.metadata.reaction = 'negative';
                    thumbsDown.classList.add('active');
                    thumbsUp.classList.remove('active');
                }
            }
        };

        // Regenerate (only last assistant)
        if (this.isLastAssistantMessage(content)) {
            const regenBtn = metaEl.createEl('button', { cls: 'cs-message__meta-btn' });
            setSvg(regenBtn, UiIcons.refresh(12));
            regenBtn.setAttribute('aria-label', t('chat.msg.regenerate'));
            regenBtn.onclick = (e: MouseEvent) => { e.stopPropagation(); void this.regenerateLastResponse(); };
        }
    }
}

export function startEditMessage(this: ChatViewLike, msgIndex: number, originalContent: string): void {
    // For simplicity, just remove messages from index and resend
    const messages = this.rollingWindow.messages;
    if (msgIndex >= 0 && msgIndex < messages.length) {
        // Remove edited message and all subsequent
        messages.splice(msgIndex);

        void this.render_messages();
        this.input_area.value = originalContent;
        this.input_area.focus();
        // User can now edit and resend
    }
}

export function isLastAssistantMessage(this: ChatViewLike, content: string): boolean {
    const messages = this.rollingWindow.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') {
            return messages[i].content === content;
        }
    }
    return false;
}

/**
 * Łączy bloki `type === 'text'` znakiem NOWEJ LINII, string zostaje bez zmian - do wklejenia
 * w pole wpisywania przy "ponów odpowiedź" (BUG C2). Osobno od
 * `RollingWindow._contentToTokenText` (silnik liczenia tokenów, kod review #8): tamten łączy
 * bloki BEZ separatora (liczy się DŁUGOŚĆ treści, nie jej czytelność) - user, który ma
 * odczytać tekst z powrotem, potrzebuje bloków rozdzielonych, inaczej dwa sąsiednie bloki
 * text zlewają się w jedną linijkę bez spacji.
 */
function _joinTextBlocksForInput(content: RollingMessage['content']): string {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((b): b is TextContentBlock => b?.type === 'text')
        .map(b => b.text || '')
        .join('\n');
}

export async function regenerateLastResponse(this: ChatViewLike): Promise<void> {
    const messages = this.rollingWindow.messages;

    // Find last user message
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            lastUserIdx = i;
            break;
        }
    }

    if (lastUserIdx === -1) return;

    // `content` okna to `string | null | ContentBlock[]` (patrz `RollingWindow.ts`) - wiadomość
    // Z ZAŁĄCZNIKIEM niesie tablicę bloków, nie string. `_joinTextBlocksForInput` łączy TYLKO
    // bloki `type === 'text'` (nowa linia między nimi) i zwraca string bez zmian - bez tego
    // pole wpisywania dostawało `[object Object]` (BUG C2).
    const userContent = _joinTextBlocksForInput(messages[lastUserIdx].content);
    // Proweniencja jedzie ZA tekstem — ponowienie nie może awansować wiadomości maszynowej
    // (np. powiadomienia o wyniku suba) do rangi „to pisał człowiek". Brak znacznika = maszyna.
    const userOrigin = resolveMessageOrigin(messages[lastUserIdx]);

    // Remove everything INCLUDING last user message to avoid duplication
    messages.splice(lastUserIdx);

    // Re-render and resend
    void this.render_messages();
    this.input_area.value = userContent;
    await this.send_message({ meta: { origin: userOrigin } });
}

/**
 * Renders a visible compression block in the chat when summarization happens.
 * Shows the summary text so user can see what the agent "remembers" from here.
 * @param {string} summary - Compressed summary text
 * @param {number} count - Summarization number
 * @param {number} messagesKept - How many messages were kept
 * @param {boolean} isEmergency - Was this an emergency (hard limit) summarization?
 */
export function _renderCompressionBlock(this: ChatViewLike, summary: string, count: number, messagesKept: number, isEmergency = false): void {
    if (!this.messages_container) return;

    const cls = isEmergency ? 'pkm-compression-block emergency' : 'pkm-compression-block';
    const block = this.messages_container.createDiv({ cls });

    const headerRow = block.createDiv({ cls: 'pkm-compression-header' });
    const compressionIcon = headerRow.createSpan({ cls: 'pkm-compression-icon' });
    setSvg(compressionIcon, isEmergency
        ? '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M8,1 L15,14 H1 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><line x1="8" y1="6" x2="8" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="12" r="0.8" fill="currentColor"/></svg>'
        : UiIcons.layers(14));
    headerRow.createSpan({
        cls: 'pkm-compression-label',
        text: isEmergency
            ? t('chat.msg.emergency_compress', { count })
            : t('chat.msg.compress', { count })
    });
    headerRow.createSpan({
        cls: 'pkm-compression-meta',
        text: t('chat.msg.messages_kept', { count: messagesKept })
    });

    const content = block.createDiv({ cls: 'pkm-compression-content collapsed' });
    content.createDiv({ cls: 'pkm-compression-text', text: summary });

    const toggleBtn = block.createEl('button', {
        cls: 'pkm-compression-toggle',
        text: t('chat.msg.show_summary')
    });
    toggleBtn.addEventListener('click', () => {
        const isCollapsed = content.classList.contains('collapsed');
        content.classList.toggle('collapsed');
        toggleBtn.textContent = isCollapsed ? t('chat.msg.hide_summary') : t('chat.msg.show_summary');
    });

    const hintText = isEmergency
        ? t('chat.msg.context_overflow')
        : t('chat.msg.compressed_above');
    block.createDiv({ cls: 'pkm-compression-hint', text: hintText });

    // Keep a handle so the async "saved N memories" note can attach to this block.
    this._lastCompressionBlockEl = block;

    // Scroll to compression block
    block.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Update token counter after compression
    this.updateTokenCounter();
}

/**
 * Show a note after the compaction rescue queues candidates.
 * Candidates go into the `brain/pending_rescue/` waiting room, NOT straight into brain/ — the
 * text says what really happens ("awaiting your review") instead of "saved". This is preview
 * only, not a gate. Attaches to the most recent compression block when it is still in the DOM,
 * otherwise falls back to a standalone note in the message stream.
 * @param {number} count - How many memory candidates were queued (N>0).
 */
export function _renderMemorySavedNote(this: ChatViewLike, count: number): void {
    if (!count || count < 1) return;
    const attached = this._lastCompressionBlockEl && this._lastCompressionBlockEl.isConnected;
    const target = attached ? this._lastCompressionBlockEl : this.messages_container;
    if (!target) return;
    target.createDiv({
        cls: 'pkm-compression-memory-saved',
        text: t('chat.msg.memory_candidates_pending', { count })
    });
}

/**
 * Renders Phase 1 trim notification as a user-message-style bubble.
 * @param {Object} info - {trimmed, details, savedChars, tokensBefore, tokensAfterTrim, totalTrimmed}
 */
export function _renderTrimBlock(this: ChatViewLike, info: TrimInfo): void {
    if (!this.messages_container) return;

    const block = this.messages_container.createDiv({ cls: 'cs-message cs-message--user cs-trim-bubble' });

    // Main text — header line
    const textDiv = block.createDiv({ cls: 'cs-message__text' });
    const percent = this.rollingWindow.getUsagePercent();
    const headerP = textDiv.createEl('p');
    headerP.createEl('strong', { text: t('chat.msg.trim_phase1') });
    headerP.appendText(` - ${t('chat.msg.trim_context_percent', { percent })}`);

    // Collapsed details
    const detailsDiv = textDiv.createDiv({ cls: 'cs-trim-details collapsed' });

    const lines = [];
    lines.push(t('chat.msg.trim_details', { trimmed: info.trimmed }));
    lines.push(t('chat.msg.trim_saved', { saved: info.savedChars }));
    if (info.tokensBefore && info.tokensAfterTrim) {
        lines.push(t('chat.msg.trim_tokens', { before: info.tokensBefore, after: info.tokensAfterTrim, max: this.rollingWindow.maxTokens }));
    }
    if (info.totalTrimmed > info.trimmed) {
        lines.push(t('chat.msg.trim_total', { total: info.totalTrimmed }));
    }
    if (info.details && info.details.length > 0) {
        lines.push('');
        lines.push(t('chat.msg.trimmed_tools'));
        for (const d of info.details) {
            lines.push(`  ${t('chat.msg.trimmed_tool_entry', { name: d.toolName, size: d.originalSize })}`);
        }
    }
    detailsDiv.textContent = lines.join('\n');

    // Toggle link
    const toggleLink = textDiv.createSpan({
        cls: 'cs-trim-toggle',
        text: t('chat.msg.show_details')
    });
    toggleLink.addEventListener('click', () => {
        const isCollapsed = detailsDiv.classList.contains('collapsed');
        detailsDiv.classList.toggle('collapsed');
        toggleLink.textContent = isCollapsed ? t('chat.msg.hide_details') : t('chat.msg.show_details');
    });

    block.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this.updateTokenCounter();
}

/**
 * Draw a continuous vertical line connecting the crystal markers of consecutive agent elements.
 * Uses absolute positioning within messages_container so it spans across multiple agent divs.
 *
 * Kolumna dymkow (2.3.0, kolejna faza "Czat bez scian"): naglowek serii (jeden krysztal na CALA
 * serie, w `.cs-message__agent-head`) znikl - krysztal siedzi teraz PRZY KAZDYM elemencie agenta
 * (kafelek `.cs-tile--agent`/`.cs-tile--agent-muted`, dymek tekstu `.cs-message__text`), rysowany
 * CSS pseudo-elementem `::after` (patrz `chat_view.css`). Lacznik dalej rysuje JEDNA pionowa
 * linie na serie (ciag `.cs-message--agent` bez przerwy w DOM - grupowanie bez zmian), ale teraz
 * od srodka krysztalu PIERWSZEGO elementu serii do srodka krysztalu OSTATNIEGO - nie od naglowka
 * do ostatniej ikony kafelka (naglowek juz nie istnieje).
 */
export function _drawConnectorLines(this: ChatViewLike): void {
    // Remove old lines
    this.messages_container.querySelectorAll('.cs-connector-line').forEach((el: Element) => el.remove());

    const containerRect = this.messages_container.getBoundingClientRect();
    const agentMsgs = this.messages_container.querySelectorAll('.cs-message--agent');
    if (!agentMsgs.length) return;

    // Group consecutive agent messages
    let groups: HTMLElement[][] = [];
    let current: HTMLElement[] = [];
    let prev: HTMLElement | null = null;
    for (const msg of agentMsgs as NodeListOf<HTMLElement>) {
        if (prev && msg.previousElementSibling === prev) {
            current.push(msg);
        } else {
            if (current.length) groups.push(current);
            current = [msg];
        }
        prev = msg;
    }
    if (current.length) groups.push(current);

    for (const group of groups) {
        // Elementy grupy w kolejnosci DOM: kazdy kafelek agenta (gdziekolwiek zagniezdzony - w
        // `.cs-tool-chip-wrap` albo `.cs-tool-calls-wrapper` przy streamingu, selektor lapie je
        // niezaleznie od opakowania), kazdy blok `.cs-ask-user` (ta sama zagniezdzona lokalizacja
        // co kafelki - dostaje krysztal tak samo, patrz `chat_view.css`) i kazdy dymek tekstu,
        // BEZPOSREDNI dzieckiem kontenera agenta. Element bez wysokosci (pusty `.cs-message__text`,
        // ukryty przez `:empty{display:none}`) pomijamy - nie ma gdzie narysowac krysztalu.
        const elements: HTMLElement[] = [];
        for (const msg of group) {
            const tiles = msg.querySelectorAll<HTMLElement>('.cs-tile--agent, .cs-tile--agent-muted, .cs-ask-user');
            for (const tile of tiles) {
                if (tile.offsetHeight === 0) continue;
                elements.push(tile);
            }
            for (const child of Array.from(msg.children) as HTMLElement[]) {
                if (!child.classList.contains('cs-message__text')) continue;
                if (child.offsetHeight === 0) continue;
                elements.push(child);
            }
        }
        // Jeden element w grupie (albo zero) = brak linii - nic do laczenia.
        if (elements.length < 2) continue;

        const first = elements[0];
        const last = elements[elements.length - 1];
        const firstMsg = group[0];
        const firstRect = firstMsg.getBoundingClientRect();
        // x = lewa krawedz PIERWSZEGO kontenera agenta minus rynna (marginLeft realny, fallback
        // 22 - ten sam `--cs-bubble-gutter` co `src/styles.css`) plus 9 (polowa 18px krysztalu).
        const computedMarginLeft = parseFloat(getComputedStyle(firstMsg).marginLeft);
        const gutter = Number.isFinite(computedMarginLeft) ? computedMarginLeft : 22;
        const crystalCenterX = firstRect.left - gutter + 9 - containerRect.left;

        const top = _crystalCenterY(first) - containerRect.top + this.messages_container.scrollTop;
        const bottom = _crystalCenterY(last) - containerRect.top + this.messages_container.scrollTop;
        const height = bottom - top;
        if (height <= 0) continue;

        const line = createDiv();
        line.className = 'cs-connector-line';
        line.style.top = `${top}px`;
        line.style.height = `${height}px`;
        line.style.left = `${crystalCenterX}px`;
        // Inherit agent color from the group
        const agentRgb = firstMsg.style.getPropertyValue('--cs-agent-color-rgb');
        if (agentRgb) line.style.setProperty('--cs-agent-color-rgb', agentRgb);
        this.messages_container.appendChild(line);
    }
}

/**
 * Y srodka krysztalu `::after` danego elementu, wzgledem viewportu (przed przeliczeniem na
 * wspolrzedne messages_container). W PIONIE liczy sie zawsze border-TOP (border-left zmienia
 * tylko `left`, patrz komentarz przy `left` w `_drawConnectorLines` wyzej) - kafelek, dymek
 * tekstu i blok `.cs-ask-user` maja WSZYSTKIE border-top 1px (kafelek ma go dokola, dymek i
 * ask_user go dostaja z bazowego `border: 1px`, `border-left: 3px` nadpisuje TYLKO lewa krawedz).
 * Trzy offsety zgodne z CSS (`chat_view.css`):
 * kafelek = border-top 1 + top 9 + polowa 18 = 19; dymek tekstu = border-top 1 + top 7 + polowa
 * 18 = 17; blok ask_user = border-top 1 + top 12 + polowa 18 = 22 (top wiekszy niz dymka, bo
 * ask_user ma wiekszy padding-top, 10px zamiast 5px).
 */
function _crystalCenterY(el: HTMLElement): number {
    const rect = el.getBoundingClientRect();
    const offset = el.classList.contains('cs-message__text') ? 17
        : el.classList.contains('cs-ask-user') ? 22
        : 19;
    return rect.top + offset;
}
