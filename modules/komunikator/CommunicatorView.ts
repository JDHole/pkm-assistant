/**
 * CommunicatorView - Crystal Soul communicator in the sidebar.
 * Accordion messages, delete, scroll, full Crystal Soul design.
 */
import { Notice } from 'obsidian';
import { SkinManager, UiIcons, hexToRgbTriplet, setSvg, setSvgLabel } from '../crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
import { log } from '../../core/utils/Logger.js';
import { KomunikatorBulkDeleteModal } from './KomunikatorCleanupModal.js';
import type { Message, MessageHeader } from './types.js';
// TS-any: Obsidian DOM extensions and plugin/sidebar services are dynamic runtime APIs.
type UiBoundary = any;

/**
 * Render the communicator view inline in sidebar.
 * @param {HTMLElement} container
 * @param {Object} plugin
 * @param {import('../shell/sidebar/SidebarNav.js').SidebarNav} nav
 * @param {Object} params - { agentName?: string }
 */
export function renderCommunicatorView(container: UiBoundary, plugin: UiBoundary, nav: UiBoundary, params: { agentName?: string }) {
    container.classList.add('cs-root');
    const agentManager = plugin.agentManager;
    if (!agentManager) {
        container.createEl('p', { text: t('sidebar.agent_manager_not_init'), cls: 'agent-error' });
        return;
    }

    // E1.2 kill-switch: guard against a missing KomunikatorManager (flag off / not instantiated).
    if (!agentManager.komunikatorManager) {
        container.createEl('p', { text: t('sidebar.communicator_unavailable'), cls: 'agent-error' });
        return;
    }

    let selectedAgent = params.agentName || null;
    let expandedMsgId: string | null = null; // accordion: only one at a time

    // Auto-select first agent if none specified
    if (!selectedAgent) {
        const agents = agentManager.listKomunikatorAgents();
        if (agents.length > 0) selectedAgent = agents[0].name;
    }

    // Header
    const headerEl = container.createDiv({ cls: 'cs-section-title' });
    setSvg(headerEl, UiIcons.chat(12));
    headerEl.appendText(t('sidebar.communicator'));

    // Agent strip (horizontal, scrollable)
    const agentStrip = container.createDiv({ cls: 'cs-comm-strip' });

    // Inbox container. S28 (D1): sekcja Projects skasowana razem z Project Hubem.
    const inboxEl = container.createDiv({ cls: 'cs-comm-inbox' });

    // Render
    void renderAgentStrip();
    void renderInbox();

    // Subscribe to live events
    const unsub = agentManager.on((event: string) => {
        if (event === 'communicator:message_sent' || event === 'communicator:message_read' || event === 'communicator:message_updated') {
            if (renderTimer) window.clearTimeout(renderTimer);
            renderTimer = window.setTimeout(() => {
                renderTimer = null;
                void renderAgentStrip();
                void renderInbox();
            }, 150);
        }
    });
    // ReturnType<typeof window.setTimeout> rozjeżdża się na `NodeJS.Timeout` (globals.d.ts z
    // @types/node zlewa się z `Window & typeof globalThis`) — `Window['setTimeout']` bierze
    // sygnaturę wprost z DOM, bez tej kolizji.
    let renderTimer: ReturnType<Window['setTimeout']> | null = null;

    // Cleanup on view change
    nav._currentCleanup = () => {
        unsub();
        if (renderTimer) window.clearTimeout(renderTimer);
    };

    // ========== RENDER FUNCTIONS ==========

    async function renderAgentStrip() {
        agentStrip.empty();
        const agents = agentManager.listKomunikatorAgents();
        const komunikator = agentManager.komunikatorManager;

        for (const agent of agents) {
            const isSelected = agent.name === selectedAgent;
            const agentColor = SkinManager.getAgentColor(agent);
            const chip = agentStrip.createDiv({
                cls: `cs-comm-chip ${isSelected ? 'cs-comm-chip--active' : ''}`
            });

            if (isSelected) {
                chip.style.setProperty('--cs-chip-color', agentColor);
                chip.style.setProperty('--cs-agent-color-rgb', hexToRgbTriplet(agentColor));
            }

            const chipIcon = chip.createSpan({ cls: 'cs-inline-icon' });
            setSvg(chipIcon, SkinManager.getCrystal(agent, {
                size: 14, color: isSelected ? agentColor : 'currentColor', glow: false
            }));
            chip.createSpan({ cls: 'cs-comm-chip__name', text: agent.name });

            // Unread count
            if (komunikator) {
                try {
                    const count = await komunikator.getUnreadCount(agent.name);
                    if (count > 0) {
                        chip.createSpan({ cls: 'cs-comm-chip__badge', text: String(count) });
                    }
                } catch (e) {
                    // AUD-bledy-048: pusty `catch {}` robił z awarii licznika „brak nowych" —
                    // chip bez badge'a wygląda identycznie jak zero nieprzeczytanych, więc user
                    // uznawał skrzynkę za pustą. Nieznany stan ma wyglądać jak nieznany.
                    log.warn('CommunicatorView', `Nie policzyłem nieprzeczytanych dla ${agent.name}:`, e);
                    chip.createSpan({ cls: 'cs-comm-chip__badge', text: '?' });
                }
            }

            chip.addEventListener('click', () => {
                selectedAgent = agent.name;
                expandedMsgId = null;
                void renderAgentStrip();
                void renderInbox();
            });
        }
    }

    async function renderInbox() {
        inboxEl.empty();

        if (!selectedAgent) {
            const emptyDiv = inboxEl.createDiv({ cls: 'cs-comm-empty' });
            setSvg(emptyDiv, UiIcons.chat(20));
            emptyDiv.createDiv({ text: t('communicator.select_agent') });
            return;
        }

        const komunikator = agentManager.komunikatorManager;
        if (!komunikator) return;

        const agent = agentManager.getAgent(selectedAgent);
        const agentColor = agent ? SkinManager.getAgentColor(agent) : 'var(--text-muted)';

        // Inbox header
        const header = inboxEl.createDiv({ cls: 'cs-comm-header' });
        const titleArea = header.createDiv({ cls: 'cs-comm-header__title' });
        titleArea.createSpan({ cls: 'cs-comm-header__label', text: 'Inbox' });
        if (agent) {
            const agentTag = titleArea.createSpan({ cls: 'cs-comm-header__agent' });
            const iconSpan = agentTag.createSpan({ cls: 'cs-inline-icon' });
            setSvg(iconSpan, SkinManager.getCrystal(agent, { size: 14, color: agentColor, glow: false }));
            agentTag.createSpan({ text: agent.name });
        }

        // Header actions
        const actions = header.createDiv({ cls: 'cs-comm-header__actions' });

        const markReadBtn = actions.createEl('button', {
            cls: 'cs-comm-action-btn',
            attr: { title: t('communicator.mark_all_read') }
        });
        setSvg(markReadBtn, UiIcons.check(12));
        markReadBtn.addEventListener('click', async () => {
            for (const msg of await komunikator.listMessages(selectedAgent)) {
                if (!msg.userRead) await komunikator.markUserRead(selectedAgent, msg.id);
            }
            agentManager._emit('communicator:message_read');
        });

        // S28 D5: guzik hurtowy — kasuje WSZYSTKIE obustronnie przeczytane, bez podglądu,
        // z jednym zbiorczym potwierdzeniem. Usuwanie twarde (bez kosza).
        const purgeBtn = actions.createEl('button', {
            cls: 'cs-comm-action-btn cs-comm-action-btn--danger',
            attr: { title: t('communicator.cleanup.bulk_title') }
        });
        setSvg(purgeBtn, UiIcons.trash(12));
        purgeBtn.addEventListener('click', async () => {
            const readMessages = await komunikator.listAllRead(selectedAgent);
            if (readMessages.length === 0) {
                new Notice(t('communicator.cleanup.bulk_nothing'));
                return;
            }
            new KomunikatorBulkDeleteModal(
                plugin.app,
                { count: readMessages.length, agent: selectedAgent as string },
                async (confirmed: boolean) => {
                    if (!confirmed) return;
                    let removed = 0;
                    for (const msg of readMessages) {
                        if (await komunikator.deleteMessage(selectedAgent, msg.id)) removed++;
                    }
                    expandedMsgId = null;
                    agentManager._emit('communicator:message_sent');
                    new Notice(t('communicator.cleanup.bulk_done', { count: removed }));
                },
            ).open();
        });

        // Messages scroll area (listMessages zwraca najnowsze pierwsze).
        const messagesScroll = inboxEl.createDiv({ cls: 'cs-comm-messages' });
        const messages = await komunikator.listMessages(selectedAgent);

        if (messages.length === 0) {
            const emptyDiv = messagesScroll.createDiv({ cls: 'cs-comm-empty' });
            setSvg(emptyDiv, UiIcons.chat(18));
            emptyDiv.createDiv({ text: t('communicator.inbox_empty') });
        } else {
            for (const msg of messages) {
                renderMessageCard(messagesScroll, msg, komunikator, agentColor);
            }
        }

        // Compose form
        renderComposeForm(inboxEl, komunikator, agentColor);
    }

    function renderMessageCard(messagesContainer: UiBoundary, msg: MessageHeader, komunikator: UiBoundary, agentColor: string) {
        // S28 (D2): statusy przychodzą z frontmattera wiadomości, nie z regexa na całym pliku.
        const userRead = msg.userRead === true;
        const aiRead = msg.aiRead === true;
        const isUnread = !userRead;
        const isExpanded = expandedMsgId === msg.id;

        const card = messagesContainer.createDiv({
            cls: `cs-comm-msg ${isUnread ? 'cs-comm-msg--unread' : ''} ${isExpanded ? 'cs-comm-msg--expanded' : ''}`
        });
        if (isUnread) {
            card.style.setProperty('--cs-msg-accent', agentColor);
            card.style.setProperty('--cs-agent-color-rgb', hexToRgbTriplet(agentColor));
        }

        // Header (clickable)
        const headerRow = card.createDiv({ cls: 'cs-comm-msg__header' });

        // Status indicator
        const statusEl = headerRow.createDiv({ cls: 'cs-comm-msg__status' });
        if (isUnread) {
            const dot = statusEl.createDiv({ cls: 'cs-comm-msg__dot cs-comm-msg__dot--unread cs-dyn-bg' });
            dot.style.setProperty('--cs-dyn-bg', agentColor);
        } else {
            statusEl.createDiv({ cls: 'cs-comm-msg__dot cs-comm-msg__dot--read' });
        }

        // From + subject
        const infoEl = headerRow.createDiv({ cls: 'cs-comm-msg__info' });
        infoEl.createSpan({ cls: 'cs-comm-msg__from', text: msg.from });
        infoEl.createSpan({ cls: 'cs-comm-msg__subject', text: msg.subject });

        // Right side: date + delete + chevron
        const rightSide = headerRow.createDiv({ cls: 'cs-comm-msg__right' });
        rightSide.createSpan({ cls: 'cs-comm-msg__date', text: msg.date });

        // Delete button (always in header)
        const deleteBtn = rightSide.createEl('button', {
            cls: 'cs-comm-msg__delete',
            attr: { title: t('communicator.delete_message') }
        });
        setSvg(deleteBtn, UiIcons.trash(10));
        deleteBtn.addEventListener('click', async (e: Event) => {
            e.stopPropagation();
            const ok = await komunikator.deleteMessage(selectedAgent, msg.id);
            if (ok) {
                expandedMsgId = null;
                agentManager._emit('communicator:message_sent');
                new Notice(t('communicator.message_deleted'));
            } else {
                new Notice(t('communicator.delete_failed'));
            }
        });

        // Chevron
        const chevron = rightSide.createDiv({ cls: 'cs-comm-msg__chevron' });
        setSvg(chevron, UiIcons.chevronDown(10));

        // Click handler - accordion (only on non-button areas)
        headerRow.addEventListener('click', async (e: Event) => {
            if ((e.target as HTMLElement).closest('.cs-comm-msg__delete')) return;
            if (expandedMsgId === msg.id) {
                expandedMsgId = null;
            } else {
                expandedMsgId = msg.id;
                // Rozwinięcie karty = user przeczytał (jego ptaszek; `ai_read` odhacza tylko agent).
                if (isUnread && komunikator) {
                    await komunikator.markUserRead(selectedAgent, msg.id);
                    agentManager._emit('communicator:message_read');
                }
            }
            void renderInbox();
        });

        // Expanded body — treść dociągana leniwie (lista niesie same nagłówki).
        if (isExpanded) {
            const body = card.createDiv({ cls: 'cs-comm-msg__body' });

            // Message content (no max-height — scroll on outer container)
            const contentEl = body.createDiv({ cls: 'cs-comm-msg__content' });
            komunikator.getMessage(selectedAgent, msg.id)
                .then((full: Message | null) => { contentEl.textContent = full?.body || ''; })
                .catch(() => { contentEl.textContent = ''; });

            // Status row
            const statusRow = body.createDiv({ cls: 'cs-comm-msg__meta' });
            const userStatus = statusRow.createSpan({ cls: `cs-comm-msg__tag ${userRead ? '' : 'cs-comm-msg__tag--active'}` });
            setSvg(userStatus, UiIcons.user(10));
            userStatus.createSpan({ text: userRead ? ' ' + t('communicator.read') : ' ' + t('communicator.status_new') });

            const aiStatus = statusRow.createSpan({ cls: `cs-comm-msg__tag ${aiRead ? '' : 'cs-comm-msg__tag--active'}` });
            setSvg(aiStatus, UiIcons.robot(10));
            aiStatus.createSpan({ text: aiRead ? ' ' + t('communicator.ai_read') : ' ' + t('communicator.ai_new') });
        }
    }

    function renderComposeForm(parentEl: UiBoundary, komunikator: UiBoundary, agentColor: string) {
        const form = parentEl.createDiv({ cls: 'cs-comm-compose' });

        const composeHeader = form.createDiv({ cls: 'cs-comm-compose__header' });
        setSvg(composeHeader, UiIcons.send(11));
        composeHeader.createSpan({ text: ' ' + t('communicator.new_message') });

        const subjectInput = form.createEl('input', {
            type: 'text',
            placeholder: t('communicator.subject_placeholder'),
            cls: 'cs-comm-compose__input'
        });

        const contentArea = form.createEl('textarea', {
            placeholder: t('communicator.body_placeholder'),
            cls: 'cs-comm-compose__textarea'
        });
        contentArea.rows = 3;

        const sendBtn = form.createEl('button', { cls: 'cs-comm-compose__send' });
        setSvgLabel(sendBtn, UiIcons.send(11), t('communicator.send'));
        sendBtn.style.setProperty('--cs-send-color', agentColor);

        sendBtn.addEventListener('click', async () => {
            const subject = subjectInput.value.trim();
            const content = contentArea.value.trim();

            if (!subject || !content) {
                new Notice(t('communicator.fill_subject_and_body'));
                return;
            }

            try {
                const res = await komunikator.sendMessage('User', selectedAgent, subject, content);
                if (!res?.success) {
                    new Notice(res?.error || t('communicator.delete_failed'));
                    return;
                }
                agentManager._emit('communicator:message_sent');
                new Notice(t('communicator.sent_to', { agent: selectedAgent }));
                subjectInput.value = '';
                contentArea.value = '';
            } catch (e) {
                new Notice(t('generic.error') + ': ' + (e as { message?: string }).message);
            }
        });
    }
}
