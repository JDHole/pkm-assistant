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
} from '../../ui-components/index.js';
import { t, getDateLocale } from '../../../core/i18n/index.js';
import { registerUrlsFromText } from '../../web/index.js';
import { registerUrlsIfHuman } from './messagePrivileges.js';
// AUD-bledy-027/058: historia liczy status narzędzia TĄ SAMĄ regułą co żywa tura (chat_streaming).
import { resolveMessageOrigin, toolResultStatus } from '../../../core/index.js';

// TS-any: receiver legacy mixinów jest składany runtime przez Object.assign(ChatView.prototype, ...).
type ChatViewMixinContext = any;
// TS-any: multimodal content, tool calls and provider metadata have provider-specific runtime shapes.
type Runtime = any;

type MessageRole = 'user' | 'assistant';
type MessageContent = string | Runtime[];
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
 * @param {Object} [meta] - F2: dodatkowe pola na wiadomości w oknie kontekstu (np.
 *   `{_subTaskNotification: true}` — znacznik, że turę wywołał wynik suba z tła, a nie user).
 *   Trafiają tam, gdzie `timestamp`; render ich nie czyta.
 *   K7: pole `origin` (`'human'` | `'machine'`) jest PROWENIENCJĄ — decyduje o przywilejach
 *   bezpieczeństwa (rejestr adresów dla `web_read`). Brak = maszyna, patrz
 *   `core/security/messageOrigin.ts`.
 */
export async function append_message(this: ChatViewMixinContext, role: MessageRole, content: MessageContent, displayText?: string, meta?: Runtime): Promise<void> {
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

    if (role === 'user') {
        // E1.3 P6: URLs the user types are known-provenance and may be fetched by web_read.
        // K7 (AUD-security-062/003): o proweniencji decyduje JAWNY znacznik `meta.origin`, a nie
        // to, że dymek jest rysowany z rolą 'user'. Bez znacznika = maszyna (fail-closed), więc
        // adres z treści artefaktu czy z wyniku suba NIE odblokowuje `web_read`.
        registerUrlsIfHuman(uiText, meta, registerUrlsFromText);
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
        this._agentHeaderShown = false;
    } else {
        const agentDiv = this.messages_container.createDiv({ cls: 'cs-message cs-message--agent' });
        agentDiv.style.setProperty('--cs-agent-color-rgb', agentRgb);
        if (!this._agentHeaderShown) {
            const head = agentDiv.createDiv({ cls: 'cs-message__agent-head' });
            const crystalEl = head.createDiv({ cls: 'cs-message__agent-crystal' });
            setSvg(crystalEl, SkinManager.getCrystal(activeAgent || 'Agent', { size: 18, color: agentColor, glow: false }));
            head.createSpan({ cls: 'cs-message__agent-name', text: activeAgent?.name || 'Agent' });
            this._agentHeaderShown = true;
        }
        const textDiv = agentDiv.createDiv({ cls: 'cs-message__text' });
        await MarkdownRenderer.render(this.app, uiText, textDiv, '', this);
        const metaEl = agentDiv.createDiv({ cls: 'cs-message__meta' });
        metaEl.createSpan({ text: timestamp });
        this._renderCacheSavingsBadge?.(metaEl, this.rollingWindow.messages[idx]?.cache);
        this.addMessageActions(metaEl, uiText, 'assistant', idx);
    }

    // Scroll to bottom
    this.scrollToBottom();
}

export async function render_messages(this: ChatViewMixinContext): Promise<void> {
    this.messages_container.empty();
    const agent = this.plugin?.agentManager?.getActiveAgent();
    const agentColor = SkinManager.getAgentColor(agent || 'default');
    const agentRgb = hexToRgbTriplet(agentColor);
    const agentName = agent?.name || 'Agent';

    let prevRole = null;
    for (let idx = 0; idx < this.rollingWindow.messages.length; idx++) {
        const msg = this.rollingWindow.messages[idx];
        // Skip tool messages (they were displayed inline with the tool call)
        if (msg.role === 'tool') continue;

        const uiText = typeof msg.content === 'string' ? msg.content : this._contentBlocksToText(msg.content);

        if (msg.role === 'user') {
            // ── USER MESSAGE — .cs-message--user ──
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

        } else if (msg.role === 'assistant') {
            // ── AGENT MESSAGE — .cs-message--agent ──
            const agentDiv = this.messages_container.createDiv({ cls: 'cs-message cs-message--agent' });
            agentDiv.style.setProperty('--cs-agent-color-rgb', agentRgb);

            // Agent header (crystal + name) — only on first in a series
            if (prevRole !== 'assistant') {
                const head = agentDiv.createDiv({ cls: 'cs-message__agent-head' });
                const crystalEl = head.createDiv({ cls: 'cs-message__agent-crystal' });
                setSvg(crystalEl, SkinManager.getCrystal(agent || agentName, { size: 16, color: agentColor, glow: false }));
                head.createSpan({ cls: 'cs-message__agent-name', text: agentName });
            }

            // Reconstruct action rows from metadata (thinking, tool_calls)
            // Note: addMessage() spreads metadata into top-level, so tool_calls/reasoning_content are direct props
            if (msg.reasoning_content) {
                const thinkRow = createThinkingBlock(msg.reasoning_content, false);
                agentDiv.appendChild(thinkRow);
            }
            if (msg.tool_calls?.length > 0) {
                for (const tc of msg.tool_calls) {
                    const tcName = tc.function?.name || tc.name || 'unknown';
                    const tcArgs = tc.function?.arguments || tc.arguments;
                    // Find matching tool result in next messages
                    let tcOutput = null;
                    for (let j = idx + 1; j < this.rollingWindow.messages.length; j++) {
                        const m = this.rollingWindow.messages[j];
                        if (m.role === 'tool' && m.tool_call_id === tc.id) {
                            try { tcOutput = JSON.parse(m.content); } catch { tcOutput = m.content; }
                            break;
                        }
                    }
                    const isSubAgent = tcName === 'delegate';
                    if (isSubAgent) {
                        const _hArgs = typeof tcArgs === 'string'
                            ? (() => { try { return JSON.parse(tcArgs); } catch { return {}; } })()
                            : (tcArgs || {});
                        const taskQuery = _hArgs.task || '';
                        const _hName = _hArgs.aspect || '';
                        const block = createSubAgentBlock({
                            type: tcName,
                            // K7/AUD-code-review-044: status z JEDNEJ reguły (jak makeDisplay
                            // kilka linii niżej), nie z dopasowania stringa 'Błąd' w response —
                            // ten literał sklejał WYŁĄCZNIE chat_streaming.ts, więc padnięta
                            // delegacja odtworzona z historii świeciła na zielono.
                            status: toolResultStatus(tcOutput),
                            agentName: _hName,
                            query: taskQuery,
                            response: typeof tcOutput === 'string' ? tcOutput : (tcOutput?.result || ''),
                            toolsUsed: tcOutput?.tools_used || [],
                            toolCallDetails: tcOutput?.tool_call_details || [],
                            duration: tcOutput?.duration_ms || 0,
                            usage: tcOutput?.usage,
                        });
                        agentDiv.appendChild(block);
                    } else {
                        const makeDisplay = this.env?.settings?.pkmAssistant?.compactToolChips === false ? createToolCallDisplay : createCompactToolChip;
                        const display = makeDisplay({
                            name: tcName,
                            input: typeof tcArgs === 'string' ? (() => { try { return JSON.parse(tcArgs); } catch { return tcArgs; } })() : tcArgs,
                            output: tcOutput,
                            status: toolResultStatus(tcOutput),
                            error: tcOutput?.error
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
        prevRole = msg.role;
    }

    // Track crystal header state for streaming continuation
    this._agentHeaderShown = (prevRole === 'assistant');
    // Draw connector lines
    this._drawConnectorLines();
}

/**
 * Render user text with inline @[Name] mention badges.
 * Falls back to plain text if no mentions found.
 */
export function _renderUserText(this: ChatViewMixinContext, container: HTMLElement, text: string): void {
    if (!text.includes('@[')) {
        container.createEl('p', { text });
        return;
    }
    const p = container.createEl('p');
    const parts = text.split(/(@\[[^\]]+\])/g);
    for (const part of parts) {
        const match = part.match(/^@\[(.+)\]$/);
        if (match) {
            const badge = p.createSpan({ cls: 'pkm-mention-badge' });
            badge.textContent = `@ ${match[1]}`;
        } else {
            p.appendText(part);
        }
    }
}

export function addMessageActions(this: ChatViewMixinContext, metaEl: HTMLElement, content: string, role: MessageRole, idx: number): void {
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
            this.render_messages();
            this.updateTokenCounter();
        } else {
            const foundIdx = this.rollingWindow.messages.findIndex((m: Runtime) => m.content === content && m.role === role);
            if (foundIdx > -1) {
                this.rollingWindow.messages.splice(foundIdx, 1);
                this.render_messages();
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
            regenBtn.onclick = (e: MouseEvent) => { e.stopPropagation(); this.regenerateLastResponse(); };
        }
    }
}

export function startEditMessage(this: ChatViewMixinContext, msgIndex: number, originalContent: string): void {
    // For simplicity, just remove messages from index and resend
    const messages = this.rollingWindow.messages;
    if (msgIndex >= 0 && msgIndex < messages.length) {
        // Remove edited message and all subsequent
        messages.splice(msgIndex);

        this.render_messages();
        this.input_area.value = originalContent;
        this.input_area.focus();
        // User can now edit and resend
    }
}

export function isLastAssistantMessage(this: ChatViewMixinContext, content: string): boolean {
    const messages = this.rollingWindow.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') {
            return messages[i].content === content;
        }
    }
    return false;
}

export async function regenerateLastResponse(this: ChatViewMixinContext): Promise<void> {
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

    const userContent = messages[lastUserIdx].content;
    // K7: proweniencja jedzie ZA tekstem — ponowienie nie może awansować wiadomości maszynowej
    // (np. powiadomienia o wyniku suba) do rangi „to pisał człowiek". Brak znacznika = maszyna.
    const userOrigin = resolveMessageOrigin(messages[lastUserIdx]);

    // Remove everything INCLUDING last user message to avoid duplication
    messages.splice(lastUserIdx);

    // Re-render and resend
    this.render_messages();
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
export function _renderCompressionBlock(this: ChatViewMixinContext, summary: string, count: number, messagesKept: number, isEmergency = false): void {
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

    // E2.7 W2 (K3): keep a handle so the async "saved N memories" note can attach to this block.
    this._lastCompressionBlockEl = block;

    // Scroll to compression block
    block.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Update token counter after compression
    this.updateTokenCounter();
}

/**
 * E2.7 W2 (K3): show a note after the compaction rescue queues candidates.
 * D8 (2026-08-27, werdykt 27.08): candidates now go into the `brain/pending_rescue/` waiting
 * room, NOT straight into brain/ — the text says what really happens ("awaiting your review")
 * instead of "saved". Preview only, not a gate (D2) still holds, but the wording is now honest
 * about it. Attaches to the most recent compression block when it is still in the DOM, otherwise
 * falls back to a standalone note in the message stream.
 * @param {number} count - How many memory candidates were queued (N>0).
 */
export function _renderMemorySavedNote(this: ChatViewMixinContext, count: number): void {
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
export function _renderTrimBlock(this: ChatViewMixinContext, info: TrimInfo): void {
    if (!this.messages_container) return;

    const block = this.messages_container.createDiv({ cls: 'cs-message cs-message--user cs-trim-bubble' });

    // Main text — header line
    const textDiv = block.createDiv({ cls: 'cs-message__text' });
    const percent = this.rollingWindow.getUsagePercent();
    const headerP = textDiv.createEl('p');
    headerP.createEl('strong', { text: t('chat.msg.trim_phase1') });
    headerP.appendText(` — ${t('chat.msg.trim_context_percent', { percent })}`);

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
 * Draw a continuous vertical line from crystal header through all action rows.
 * Uses absolute positioning within messages_container so it spans across multiple agent divs.
 */
export function _drawConnectorLines(this: ChatViewMixinContext): void {
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

    // For each group, find first crystal and last action row icon, draw one line
    for (const group of groups) {
        const firstMsg = group[0];
        const crystal = firstMsg.querySelector('.cs-message__agent-crystal');
        if (!crystal) continue;

        // Find last action row's icon in the group
        let lastIcon: Element | null = null;
        for (let i = group.length - 1; i >= 0; i--) {
            const rows = group[i].querySelectorAll('.cs-action-row');
            if (rows.length) {
                lastIcon = rows[rows.length - 1].querySelector('.cs-action-row__icon') || rows[rows.length - 1];
                break;
            }
        }
        if (!lastIcon) continue;

        const crystalRect = crystal.getBoundingClientRect();
        const lastRect = lastIcon.getBoundingClientRect();

        // Dynamic horizontal position: center of crystal
        const crystalCenterX = crystalRect.left + crystalRect.width / 2 - containerRect.left;
        const top = crystalRect.bottom - containerRect.top + this.messages_container.scrollTop;
        const bottom = lastRect.top + lastRect.height / 2 - containerRect.top + this.messages_container.scrollTop;
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
