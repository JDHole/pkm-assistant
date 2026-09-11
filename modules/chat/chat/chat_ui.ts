/**
 * @module chat_ui
 * ChatView UI rendering methods — extracted from chat_view.js.
 *
 * All functions use `this` and are meant to be mixed into ChatView.prototype
 * via Object.assign(ChatView.prototype, { ...exports }).
 */

import { Notice, TFile } from 'obsidian';
import { SkinManager, UiIcons, IconGenerator, setSvg, setSvgLabel, adoptSheet } from '../../crystal-soul/index.js';
import { substituteVariables } from '../../skills/index.js';
import { MentionAutocomplete, AttachmentManager } from '../../ui-components/index.js';
import type { MentionAutocompletePlugin, MentionChip } from '../../ui-components/index.js';
import { getVisibleSubAgentsForAgent } from '../../sub-agents/index.js';
import { summonAgentForArtifact, activateArtifactInChat, buildArtifactPickerItems } from '../../artifacts/index.js';
import type { SummonPlugin } from '../../artifacts/index.js';
import { buildTodoPanelModel, resolveBottomBarMode, DEFAULT_BOTTOM_BAR_MODE } from './todoPanel.js';
import { renderSubTaskStrip } from './subTaskStrip.js';
import { _tabKey } from './chat_tabs.js';
import { insertInlineTriggerMarker } from './InlineChipPlugin.js';
import { TriggerPopup } from './TriggerPopup.js';
import { TokenViewerWidget } from './TokenViewerWidget.js';
import { t } from '../../../core/i18n/index.js';
import { HUMAN_MESSAGE_META } from '../../../core/index.js';
import chat_view_styles from '../chat_view.css' with { type: 'css' };
import { log } from '../../../core/utils/Logger.js';
// Receiver mixina = ZŁOŻONY widok (`ChatViewLike`: klasa + osiem paczek mixinów).
import type { ChatSkillConfig, ChatSkillPreQuestion, ChatTab, ChatViewLike } from './chatViewShape.js';
/**
 * Wpis rejestru artefaktów w zakresie, jaki czyta czat (chip aktywnego + picker).
 * Pełny kształt jest wewnętrzny dla `modules/artifacts` i nie wychodzi jego barrelem.
 */
interface ArtifactListEntry {
    id: string;
    tytul?: string | null;
}
import type { ToolDefinition } from '../../tools/index.js';
import type { TriggerItem } from './TriggerPopup.js';
import type { SlashCommand } from './SlashCommandsRegistry.js';
import type { RoleTotals } from '../../../core/index.js';
import type { CacheMetadata } from '../../models/index.js';
import type { TokenRowRefs } from './chatViewShape.js';

/** Opcja listy rozwijanej w mini-formularzu skilla. */
type PreQuestionOption = string | { value: string; label?: string; group?: string };

/**
 * Kontrolka mini-formularza skilla. Pola `_dependsOn`/`_allOptions` dokleja do węzła sam render
 * (kaskada „rodzic filtruje opcje dziecka"), więc typ musi je znać.
 */
type PreQuestionInput = (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) & {
    _dependsOn?: string;
    _allOptions?: PreQuestionOption[];
};

/**
 * Rdzeń ręcznej kompresji kontekstu, dzielony przez guzik 🗜️ „Sumaryzuj chat" (`_renderSlimBar`
 * niżej) i komendę `/compress` (`SlashCommandsRegistry.ts`). Oba wołacze MUSZĄ wołać JEDNĄ
 * wspólną gałąź decyzyjną — dwie osobne kopie tej gałęzi mogłyby się rozjechać na dwa różne
 * teksty i18n dla gałęzi „nic się nie zmieniło" tego samego stanu. Kanon: `chat.nothing_to_summarize`.
 *
 * Wołacze zachowują WŁASNE opakowanie: guzik dokłada busy-state + własny catch/Notice błędu
 * (to jest UI dymka, nie logika kompresji), komenda slash dokłada `resetInputArea()`. Wzór
 * eksportu-nie-mixina jak `_tabKey` w `chat_tabs.js` — funkcja przyjmuje `view` jawnie, nie `this`,
 * więc jest bezpieczna do importu wprost z pliku spoza mixinów.
 *
 * @returns `false` gdy za mało wiadomości (kompresja NIE wystartowała), `true` gdy się odbyła.
 */
export async function runManualCompression(view: ChatViewLike): Promise<boolean> {
    if (view.rollingWindow.messages.length < 4) {
        new Notice(t('chat.too_few_messages'));
        return false;
    }
    const result = await view.rollingWindow.performTwoPhaseCompression(false);
    view.updateTokenCounter();
    view._updateTokenPanel();
    if (result.summarized) {
        new Notice(t('chat.summarize_result', { count: view.rollingWindow.summarizationCount, trimmed: result.trimmed }));
    } else if (result.trimmed > 0) {
        new Notice(t('chat.trim_result', { trimmed: result.trimmed }));
    } else {
        new Notice(t('chat.nothing_to_summarize'));
    }
    return true;
}

// ── Main view render ────────────────────────────────────────────────

export async function renderView(this: ChatViewLike, container = this.container) {
    // Adopt chat styles (CSSStyleSheet from import) przez `adoptSheet`, żeby demontaż pluginu
    // zdjął arkusz zamiast zostawiać go w dokumencie do restartu.
    adoptSheet(chat_view_styles);

    container.empty();
    container.addClass('pkm-chat-view');

    // ── Initialize tabs for active agent ──
    this._initTabs();

    // ── TAB BAR (replaces old header) ──
    this._tabBarContainer = container.createDiv();
    this._renderTabBar(this._tabBarContainer);

    // ── PASEK BIEGÓW SUBÓW ── pod zakładkami, nad wiadomościami.
    // Pusty = klasa `pkm-substrip--empty`, czyli zero wysokości; czat wygląda jak wcześniej.
    this._subStripContainer = container.createDiv({ cls: 'pkm-substrip pkm-substrip--empty' });
    this._renderSubTaskStrip();

    // Create main layout: body (row) → main (column) + slim bar
    const chatBody = container.createDiv({ cls: 'pkm-chat-body' });
    this._chatBody = chatBody;
    const chatMain = chatBody.createDiv({ cls: 'pkm-chat-main' });

    // Messages area (cs-root activates Crystal Soul CSS variables)
    this.messages_container = chatMain.createDiv({ cls: 'pkm-chat-messages cs-root' });
    void this.render_messages();

    // ── SLIM BAR (right side, 66px) ──
    this._slimBar = chatBody.createDiv({ cls: 'cs-skillbar cs-root' });
    this._slimBar.style.setProperty('--cs-agent-color-rgb', this._getAgentRgb());
    this._renderSlimBar();

    // ── BOTTOM PANEL: input + controls ──
    const bottomPanel = chatMain.createDiv({ cls: 'cs-input-panel cs-root' });
    bottomPanel.style.setProperty('--cs-agent-color-rgb', this._getAgentRgb());

    // Chip aktywnego artefaktu nad inputem (tytuł + odśwież + odepnij).
    this._artifactChipBar = bottomPanel.createDiv({ cls: 'cs-artifact-chip-bar' });
    this._renderArtifactChip();

    // Textarea row — pierwszy z DWÓCH widoków slotu.
    const inputRow = bottomPanel.createDiv({ cls: 'cs-input-row' });
    this._inputRow = inputRow;
    this.input_area = inputRow.createEl('textarea', {
        cls: 'cs-input-textarea',
        attr: { rows: '1' }
    });

    // Live-widok listy `todo` agenta — drugi widok TEGO SAMEGO slotu (w miejscu textarea, nie
    // nad nią). Przełącza chip `📋 done/total` w dolnym rzędzie guzików.
    this._todoPanelBar = bottomPanel.createDiv({ cls: 'cs-todo-panel-bar' });

    // Inline trigger popup on `/` and `@`
    this._triggerPopup = null;
    this._triggerPos = -1;
    this.input_area.addEventListener('keydown', (e: KeyboardEvent) => this._handleTriggerKeyDown(e));
    this.input_area.addEventListener('input', () => this._handleTriggerInput());
    this.input_area.addEventListener('blur', () => {
        // Defer close so click on popup item lands first
        window.setTimeout(() => this._closeTriggerPopup(), 150);
    });

    // Chip bar (attachment + mention chips)
    this._chipBar = bottomPanel.createDiv({ cls: 'cs-input-chips' });

    // Separator
    bottomPanel.createDiv({ cls: 'cs-input-separator' });

    // Bottom bar: left controls + right actions
    const bar = bottomPanel.createDiv({ cls: 'cs-input-bar' });
    const barLeft = bar.createDiv({ cls: 'cs-input-bar__left' });
    const barRight = bar.createDiv({ cls: 'cs-input-bar__right' });

    // ── LEFT: Todo, Autonomy, Oczko, Skills, Artifacts, Permissions, Tokens ──
    // Chip-przełącznik widoku slotu (textarea ↔ lista todo). Pierwszy w rzędzie, bo dotyczy
    // całego paska; pokazuje się TYLKO gdy lista `todo` żyje (widoczność ustawia _renderTodoPanel).
    this._todoToggleBtn = barLeft.createEl('button', {
        cls: 'cs-input-ctrl cs-todo-toggle is-hidden',
        attr: { 'aria-label': t('chat.todo.toggle_title'), title: t('chat.todo.toggle_title') },
    });
    this._todoToggleBtn.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); this._toggleBottomBarMode(); });

    // Autonomy selector.
    // Autonomy = whether the agent ASKS before acting (per-chat policy), independent
    // of permissions (what the agent MAY do).
    const autoLabel = t(`autonomy.${this.currentAutonomy}`);
    this._autonomyBtn = barLeft.createEl('button', { cls: 'cs-input-ctrl cs-input-ctrl--anchor', attr: { 'aria-label': t('chat.autonomy', { label: autoLabel }) } });
    setSvg(this._autonomyBtn, this._getAutonomyIcon(this.currentAutonomy, 12));
    this._autonomyBtn.createSpan({ text: autoLabel });
    this._autonomyBtn.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); this._toggleAutonomyPopover(); });

    // Oczko toggle
    const oczkoBtn = barLeft.createEl('button', { cls: 'cs-input-ctrl', attr: { 'aria-label': t('chat.eye') } });
    setSvg(oczkoBtn, UiIcons.eye(12));
    if (this.env?.settings?.pkmAssistant?.enableOczko !== false) oczkoBtn.classList.add('active');
    oczkoBtn.addEventListener('click', () => {
        const pkm = this.env.settings.pkmAssistant || (this.env.settings.pkmAssistant = {});
        const newValue = pkm.enableOczko === false;
        pkm.enableOczko = newValue;
        oczkoBtn.classList.toggle('active', newValue);
        void this.env.settingsStore?.save();
    });

    // Skills + Artifacts are now in the slim bar (cs-skillbar)

    // Permissions
    this._permBtn = barLeft.createEl('button', { cls: 'cs-input-ctrl cs-input-ctrl--anchor', attr: { 'aria-label': t('chat.permissions') } });
    setSvg(this._permBtn, UiIcons.shield(12));
    this._permBtn.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); this._togglePermPopover(); });

    // Context % indicator
    this._tokenDisplay = barLeft.createDiv({ cls: 'cs-input-tokens', text: '0%' });

    // ── RIGHT: Attach, MCP Tools, Send/Stop ──
    // Attachment button (📎)
    const attachBtnWrapper = barRight.createEl('button', { cls: 'cs-input-ctrl', attr: { 'aria-label': t('chat.attachment') } });
    setSvg(attachBtnWrapper, UiIcons.paperclip(12));

    // Microphone button (STT — speech to text)
    this._micBtn = barRight.createEl('button', { cls: 'cs-input-ctrl', attr: { 'aria-label': t('chat.voice_record') } });
    setSvg(this._micBtn, UiIcons.microphone(12));
    this._micBtn.addEventListener('click', () => this._toggleRecording());
    // Hide mic button if STT disabled
    const sttPlatform = this.env?.settings?.pkmAssistant?.stt?.platform;
    if (!sttPlatform || sttPlatform === 'disabled') this._micBtn.addClass('is-hidden');

    // MCP Tools button (quick insert tool name)
    const toolsBtn = barRight.createEl('button', { cls: 'cs-input-ctrl cs-input-ctrl--anchor', attr: { 'aria-label': t('chat.mcp_tools') } });
    setSvg(toolsBtn, UiIcons.tool(12));
    toolsBtn.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        this._toggleToolsPopover(toolsBtn);
    });

    // Diamond send button
    this.send_button = barRight.createEl('button', { cls: 'cs-input-send' });
    setSvg(this.send_button, UiIcons.send(12));

    // Stop button (hidden by default)
    this.stop_button = barRight.createEl('button', { cls: 'cs-input-stop hidden' });
    setSvg(this.stop_button, '<svg viewBox="0 0 12 12" width="12" height="12"><rect x="2" y="2" width="8" height="8" rx="1" fill="currentColor"/></svg>');

    // Attachment manager — wire to chip bar
    this.attachmentManager = new AttachmentManager(this._chipBar, this.plugin, {
        onChange: () => this.handleInputResize(),
        dropZone: this.messages_container,
        pasteTarget: this.input_area,
    });
    // Wire attach button click
    attachBtnWrapper.addEventListener('click', () => {
        // TS-boundary: `AttachmentManager` (modules/ui-components) ma jeszcze sygnatury `any`.
        (this.attachmentManager!.getAttachButton() as HTMLElement | null)?.click();
    });

    // Keep toolbar ref for mode popover positioning
    this.toolbar = bar;

    // @ Mentions autocomplete — chips rendered in AttachmentManager's chip bar
    // TS-boundary: luka core - `PluginApi.app` to node-safe `AppLike`, a `MentionAutocomplete`
    // żąda prawdziwego `App` Obsidiana (woła `app.vault.*`, czego `AppLike` nie modeluje).
    // Runtime podaje ten sam, jeden obiekt pluginu; rozjazd jest wyłącznie w kontrakcie core.
    this.mentionAutocomplete = new MentionAutocomplete(this.input_area, this.plugin as unknown as MentionAutocompletePlugin, {
        onChange: (mentions: MentionChip[]) => {
            this.attachmentManager!.setMentionChips(mentions, (index: number) => {
                this.mentionAutocomplete!.removeMention(index);
            });
            this.handleInputResize();
        },
    });

    // Event listeners
    this.input_area.addEventListener('input', this.handleInputResize.bind(this));
    this.input_area.addEventListener('keydown', this.handle_input_keydown.bind(this));
    // Guzik Wyślij to jedna z dwóch ścieżek z pola wpisywania — jawny znacznik człowieka.
    // (`.bind(this)` podawałoby jako `opts` MouseEvent, więc proweniencja szłaby z UI, nie stąd.)
    this.send_button.addEventListener('click', () => { void this.send_message({ meta: HUMAN_MESSAGE_META }); });
    // TO SAMO co wyżej z guzikiem Wyślij — `.bind(this)` podawałoby jako `agentName` MouseEvent,
    // więc Stop nie trafiałby w kontekst ŻADNEJ tury (mapa jest kluczowana nazwą agenta).
    // Zostawałby tylko ubity XHR wspólnej instancji modelu; tura stojąca w narzędziu nie
    // widziałaby przerwania w ogóle. Wołamy bez argumentu = tura aktywnego agenta.
    this.stop_button.addEventListener('click', () => this.stop_generation());

    // Global listeners
    this.handleGlobalKeydownBound = this.handleGlobalKeydown.bind(this);
    document.addEventListener('keydown', this.handleGlobalKeydownBound);

    // Best-effort save on browser/Obsidian unload (additional safety net)
    this.handleBeforeUnloadBound = () => { void this.handleSaveSession(); };
    window.addEventListener('beforeunload', this.handleBeforeUnloadBound);

    // Widok slotu liczy się dopiero teraz — chip-przełącznik musi już istnieć w DOM.
    this._renderTodoPanel();

    // Pasek jest `position:absolute` NAD wiadomościami, więc każdy jego przyrost (chip artefaktu,
    // dłuższy tekst) zasłaniałby treść, gdyby polegać na sztywnym `padding-bottom: 120px` z CSS.
    // Obserwator rezerwuje dokładnie tyle, ile pasek zajmuje; CSS zostaje fallbackiem
    // (środowiska bez ResizeObserver — m.in. testy node'owe).
    this._bottomPanelObserver?.disconnect();
    this._bottomPanelObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
        const reserveSpace = () => {
            const height = bottomPanel.offsetHeight || 0;
            if (height > 0 && this.messages_container) {
                this.messages_container.style.paddingBottom = `${height + 24}px`;
            }
        };
        this._bottomPanelObserver = new ResizeObserver(reserveSpace);
        this._bottomPanelObserver.observe(bottomPanel);
        reserveSpace();
    }

    // Add welcome message if no messages
    if (this.rollingWindow.messages.length === 0) {
        this.add_welcome_message();
    }
    this.updatePermissionsBadge();
}

// ── Slim bar ────────────────────────────────────────────────────────

/**
 * Render the 66px slim bar on the right side of the chat.
 * TOP: utility icons (artifacts, new chat, consolidate, save, close, tokens)
 * BOTTOM: agent skills in 2-column grid
 */
export function _renderSlimBar(this: ChatViewLike) {
    if (!this._slimBar) return;
    this._slimBar.empty();

    // ── TOP SECTION: utility buttons (2-col grid) ──
    const topSection = this._slimBar.createDiv({ cls: 'cs-skillbar__section' });
    topSection.createDiv({ cls: 'cs-skillbar__label', text: t('chat.actions') });
    const actionsGrid = topSection.createDiv({ cls: 'cs-skillbar__grid' });

    // Row 1: Nowy chat | Zamknij chat
    const newChatBtn = actionsGrid.createDiv({ cls: 'cs-skillbar__icon', attr: { 'data-tip': t('chat.new_chat') } });
    setSvg(newChatBtn, UiIcons.refresh(16));
    newChatBtn.addEventListener('click', () => { void this.handleNewSession(); });

    const closeBtn = actionsGrid.createDiv({ cls: 'cs-skillbar__icon', attr: { 'data-tip': t('chat.close_chat') } });
    setSvg(closeBtn, UiIcons.x(16));
    // _closeActiveTab jest async (czeka na zapis sesji przed przełączeniem zakładki) —
    // handler łyka ewentualny błąd, żeby nie zostawić unhandled rejection w konsoli.
    closeBtn.addEventListener('click', () => {
        void (async () => {
            try {
                await this._closeActiveTab();
            } catch (e) {
                log.warn('Chat', `Close tab failed: ${(e as Error)?.message || String(e)}`);
            }
        })();
    });

    // Row 2: Zapisz sesję | Konsolidacja
    const saveBtn = actionsGrid.createDiv({ cls: 'cs-skillbar__icon', attr: { 'data-tip': t('chat.save_session') } });
    setSvg(saveBtn, UiIcons.save(16));
    saveBtn.addEventListener('click', () => { void this.handleSaveSession(); });

    const consolidateBtn = actionsGrid.createDiv({ cls: 'cs-skillbar__icon', attr: { 'data-tip': t('chat.consolidate') } });
    setSvg(consolidateBtn, UiIcons.brain(16));
    consolidateBtn.addEventListener('click', () => {
        void (async () => {
            const agentMemory = this.plugin?.agentManager?.getActiveMemory();
            const hasCurrentMessages = this.rollingWindow.messages.length >= 2;
            let hasDiskSessions = false;
            if (agentMemory) {
                try {
                    const unconsolidated = await agentMemory.getUnconsolidatedSessions();
                    hasDiskSessions = unconsolidated.length >= 1;
                } catch { /* ignore */ }
            }
            if (!hasCurrentMessages && !hasDiskSessions) {
                new Notice(t('chat.no_sessions'));
                return;
            }
            consolidateBtn.addClass('cs-skillbar__icon--busy');
            try {
                new Notice(t('chat.consolidating'));
                await this.consolidateSession();
                new Notice(t('chat.memory_saved'));
            } catch (e) {
                log.error('Chat', 'Memory consolidation failed:', e);
                new Notice(t('chat.consolidate_error'));
            } finally {
                consolidateBtn.removeClass('cs-skillbar__icon--busy');
            }
        })();
    });

    // Row 3: Sumaryzuj chat. Artefakty mają własny segment slim bara w renderArtifactButtons,
    // a todo — live-widok nad inputem.
    const summarizeBtn = actionsGrid.createDiv({ cls: 'cs-skillbar__icon', attr: { 'data-tip': t('chat.summarize') } });
    setSvg(summarizeBtn, UiIcons.layers(16));
    summarizeBtn.addEventListener('click', () => {
        void (async () => {
            summarizeBtn.addClass('cs-skillbar__icon--busy');
            try {
                await runManualCompression(this);
            } catch (e) {
                log.error('Chat', 'Manual compression failed:', e);
                new Notice(t('chat.summarize_error'));
            } finally {
                summarizeBtn.removeClass('cs-skillbar__icon--busy');
            }
        })();
    });

    const tokenSection = this._slimBar.createDiv({ cls: 'cs-skillbar__section cs-token-viewer-section' });
    this._tokenViewer = new TokenViewerWidget(this, tokenSection);

    // Spacer
    this._slimBar.createDiv({ cls: 'cs-skillbar__spacer' });

    // ── BOTTOM SECTION: skills grid ──
    this.subAgentButtonsBar = this._slimBar.createDiv({ cls: 'cs-skillbar__section' });
    this.renderSubAgentButtons();

    this.skillButtonsBar = this._slimBar.createDiv({ cls: 'cs-skillbar__section' });
    this.renderSkillButtons();

    this.mcpServerButtonsBar = this._slimBar.createDiv({ cls: 'cs-skillbar__section' });
    this.renderMcpServerButtons();

    // Segment ARTEFAKTY — picker artefaktów agenta + aktywny.
    this.artifactButtonsBar = this._slimBar.createDiv({ cls: 'cs-skillbar__section' });
    this.renderArtifactButtons();
}

// ── Skill buttons ───────────────────────────────────────────────────

export function renderSkillButtons(this: ChatViewLike) {
    if (!this.skillButtonsBar) return;
    this.skillButtonsBar.empty();

    const agentManager = this.plugin?.agentManager;
    if (!agentManager) return;

    const skills = agentManager.getActiveAgentSkills();
    if (!skills || skills.length === 0) return;

    // Label
    this.skillButtonsBar.createDiv({ cls: 'cs-skillbar__label', text: t('chat.skills') });

    // Grid
    const grid = this.skillButtonsBar.createDiv({ cls: 'cs-skillbar__grid' });

    for (const skill of skills) {
        if (skill.userInvocable === false) continue;

        const btn = grid.createDiv({
            cls: 'cs-skillbar__icon',
            attr: { 'data-tip': skill.name }
        });
        setSvg(btn, IconGenerator.generate(skill.name, skill.icon_category || 'arcane', { size: 16, color: 'currentColor' }));
        btn.addEventListener('click', () => {
            if (this.is_generating) return;

            if ((skill.preQuestions?.length) > 0) {
                this._showSkillPreQuestions(skill);
                return;
            }

            insertInlineTriggerMarker(this.input_area, 'skill', skill.slug || skill.name);
            this.handleInputResize();
        });
    }
}

export function renderSubAgentButtons(this: ChatViewLike) {
    if (!this.subAgentButtonsBar) return;
    this.subAgentButtonsBar.empty();

    const agentManager = this.plugin?.agentManager;
    const activeAgent = agentManager?.getActiveAgent?.();
    if (!agentManager || !activeAgent) return;
    const allSubs = agentManager.subAgentLoader?.getAllSubAgents?.() || [];
    const visibleSubAgents = getVisibleSubAgentsForAgent(activeAgent, allSubs);
    if (visibleSubAgents.length === 0) return;

    this.subAgentButtonsBar.createDiv({ cls: 'cs-skillbar__label', text: 'SUB' });
    const grid = this.subAgentButtonsBar.createDiv({ cls: 'cs-skillbar__grid' });

    for (const config of visibleSubAgents) {
        const btn = grid.createDiv({
            cls: 'cs-skillbar__icon',
            attr: { 'data-tip': config.description ? `${config.name}: ${config.description}` : config.name }
        });
        const color = SkinManager.getAgentColor(activeAgent || config.name);
        setSvg(btn, SkinManager.getCrystal(config.name, { size: 16, color, glow: false }));
        btn.addEventListener('click', () => {
            if (this.is_generating) return;
            insertInlineTriggerMarker(this.input_area, 'sub-agent', config.name);
            this.handleInputResize();
        });
    }
}

export function renderMcpServerButtons(this: ChatViewLike) {
    if (!this.mcpServerButtonsBar) return;
    this.mcpServerButtonsBar.empty();

    const agent = this.plugin?.agentManager?.getActiveAgent?.();
    const registry = this.plugin?.toolRegistry;
    if (!registry) return;

    const visibleTools = registry.filterByAgent ? registry.filterByAgent(agent) : (registry.getAllTools?.() || []);
    const servers = new Set<string>();
    for (const tool of visibleTools) {
        const server = tool.serverName || registry.getBuiltinServerForTool?.(tool.name);
        if (server && server !== 'core') servers.add(server);
    }
    if (servers.size === 0) return;

    this.mcpServerButtonsBar.createDiv({ cls: 'cs-skillbar__label', text: 'MCP' });
    const grid = this.mcpServerButtonsBar.createDiv({ cls: 'cs-skillbar__grid' });

    for (const server of Array.from(servers).sort()) {
        const btn = grid.createDiv({ cls: 'cs-skillbar__icon', attr: { 'data-tip': server } });
        setSvg(btn, UiIcons.tool(16));
        btn.addEventListener('click', () => {
            if (this.is_generating) return;
            this._showMcpToolPicker?.(server, btn);
        });
    }
}

/**
 * Chip aktywnego artefaktu nad inputem. Tytuł + „odśwież stan" (ponowne wstrzyknięcie
 * sparsowanego JSON przez przywołanie) + „odepnij" (czyści aktywny artefakt).
 */
export function _renderArtifactChip(this: ChatViewLike) {
    const bar = this._artifactChipBar;
    if (!bar) return;
    bar.empty();

    const id = this.currentArtifactId;
    if (!id) {
        bar.addClass('is-hidden');
        return;
    }
    bar.removeClass('is-hidden');

    // Tytuł ze store'a (śledzenie po frontmatterze); brak → sam id.
    let tytul = id;
    try {
        const found = this.plugin?.artifactStore?.list?.()?.find((a: ArtifactListEntry) => a.id === id);
        if (found?.tytul) tytul = found.tytul;
    } catch { /* store niegotowy → pokaż id */ }

    const chip = bar.createDiv({ cls: 'cs-artifact-chip' });
    chip.createSpan({ cls: 'cs-artifact-chip__icon', text: '📄' });
    chip.createSpan({
        cls: 'cs-artifact-chip__title',
        text: tytul,
        attr: { 'aria-label': t('artifact.chip.active'), title: `${t('artifact.chip.active')}: ${id}` },
    });

    const refreshBtn = chip.createEl('button', {
        cls: 'cs-artifact-chip__btn',
        text: '🔄',
        attr: { 'aria-label': t('artifact.chip.refresh'), title: t('artifact.chip.refresh') },
    });
    refreshBtn.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        if (this.is_generating) return;
        // TS-boundary: ta sama luka core co przy `MentionAutocomplete` wyżej - `SummonPlugin`
        // (modules/artifacts) czyta `app.workspace.getLeavesOfType`, a `AppLike.workspace` jest
        // w core otwartym `Record<string, unknown>`, więc nie pokrywa się z nim w żadną stronę.
        void summonAgentForArtifact(this.plugin as unknown as SummonPlugin, { id, actionLabel: t('artifact.summon.action.refresh') });
    });

    const unpinBtn = chip.createEl('button', {
        cls: 'cs-artifact-chip__btn',
        text: '✕',
        attr: { 'aria-label': t('artifact.chip.unpin'), title: t('artifact.chip.unpin') },
    });
    unpinBtn.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        this.currentArtifactId = null;
        this._renderArtifactChip();
    });
}

/**
 * Pokaż właściwy widok slotu paska dolnego — textarea ('input') albo listę `todo` ('todo').
 * Dolny rząd guzików (wyślij/stop, spinacz, mikrofon, autonomia…) zostaje widoczny w OBU.
 */
export function _applyBottomBarMode(this: ChatViewLike) {
    const todoMode = this._bottomBarMode === 'todo';
    // Wytyczne katalogu wtyczek Obsidiana (obsidianmd/no-static-styles-assignment) wymagają
    // klasy CSS zamiast inline `.style.display`. Przełącznik widoku slotu jest dwustanowy
    // (nie ciągła wartość), więc `.is-hidden` w src/styles.css zastępuje bezpośredni zapis stylu.
    if (this._inputRow) this._inputRow.classList.toggle('is-hidden', todoMode);
    if (this._todoPanelBar) this._todoPanelBar.classList.toggle('is-hidden', !todoMode);
    this._todoToggleBtn?.classList.toggle('active', todoMode);
}

/** Ręczne przełączenie widoku slotu (klik w chip `📋 done/total`). */
export function _toggleBottomBarMode(this: ChatViewLike) {
    this._bottomBarMode = this._bottomBarMode === 'todo' ? 'input' : 'todo';
    this._applyBottomBarMode();
    if (this._bottomBarMode === 'input') this.input_area?.focus();
}

/**
 * Live-widok listy `todo` W SLOCIE inputu. Odhaczana lista (read-only dla usera — agent nią
 * steruje przez narzędzie `todo`), aktualizowana po każdym tool-callu przez reactor, nie przez
 * polling. Stan trzymany w `this._activeTodoState`.
 *
 * O tym, KTÓRY widok jest na wierzchu, decyduje pure `resolveBottomBarMode`: pojawienie się listy
 * przeskakuje na 'todo', jej zniknięcie wraca na 'input', a ręczny wybór usera w trakcie życia
 * listy jest respektowany (check/add nie wyrzuca go z pisania).
 */
export function _renderTodoPanel(this: ChatViewLike) {
    const bar = this._todoPanelBar;
    if (!bar) return;
    bar.empty();

    const model = buildTodoPanelModel(this._activeTodoState);
    // Niewysłany szkic blokuje AUTO-przeskok na listę (chowanie wiersza inputu wyglądałoby dla
    // usera jak skasowanie tego, co pisał). Ręczne przełączenie chipem działa bez zmian.
    const hasDraft = !!(this.input_area?.value || '').trim();
    this._bottomBarMode = resolveBottomBarMode(
        this._prevTodoModel,
        model,
        this._bottomBarMode || DEFAULT_BOTTOM_BAR_MODE,
        hasDraft,
    );
    this._prevTodoModel = model;

    if (this._todoToggleBtn) {
        this._todoToggleBtn.classList.toggle('is-hidden', !model.visible);
        this._todoToggleBtn.textContent = `📋 ${model.done}/${model.total}`;
    }

    // Widoczność samego paska todo należy do trybu (model niewidoczny ⇒ resolver wymusza 'input').
    this._applyBottomBarMode();
    if (!model.visible) return;

    const panel = bar.createDiv({ cls: 'cs-todo-panel' });

    const header = panel.createDiv({ cls: 'cs-todo-panel__header' });
    header.createSpan({ cls: 'cs-todo-panel__icon', text: model.allDone ? '✅' : '📝' });
    header.createSpan({
        cls: 'cs-todo-panel__title',
        text: model.title || t('chat.todo.panel_title'),
    });
    header.createSpan({ cls: 'cs-todo-panel__count', text: `${model.done}/${model.total}` });

    const list = panel.createDiv({ cls: 'cs-todo-panel__list' });
    for (const item of model.items) {
        const row = list.createDiv({ cls: 'cs-todo-panel__item' + (item.checked ? ' is-done' : '') });
        row.createSpan({ cls: 'cs-todo-panel__check', text: item.checked ? '✓' : '○' });
        row.createSpan({ cls: 'cs-todo-panel__text', text: item.text });
    }
}

// ── Pasek biegów subów (pod zakładkami czatu) ───────────────────────

/**
 * Przerysuj pasek biegów dla AKTYWNEJ zakładki.
 *
 * ⚠️ Stan rozwinięcia żyje na `this._subStripExpandedId`, a NIE w DOM — pasek przerysowuje
 * się na każdym kroku suba (debounce 250 ms), więc szczegół trzymany w klasie CSS znikałby
 * userowi co kilka sekund (ta sama mina, która w sidebarze zjadała wpisywaną wiadomość).
 * Rozwinięcie biegu, którego już nie ma na liście, gasimy — inaczej zostałoby na zawsze.
 */
export function _renderSubTaskStrip(this: ChatViewLike) {
    const host = this._subStripContainer;
    if (!host) return;
    const tab = this.chatTabs?.find((x: ChatTab) => x.isActive) || this.chatTabs?.[0];
    const count = renderSubTaskStrip(host, {
        plugin: this.plugin,
        tabKey: _tabKey(tab),
        agentName: tab?.agentName || this.plugin?.agentManager?.getActiveAgent?.()?.name || '',
        // Ta sama krynica, z której adres zwrotny delegacji bierze origin.sessionPath przy
        // zleceniu — dzięki temu porównanie „ta sama sesja?" jest symetryczne (inaczej chipy
        // przeżywałyby archiwizację).
        sessionPath: this.plugin?.agentManager?.getActiveMemory?.()?.activeSessionPath || '',
        expandedId: this._subStripExpandedId || null,
        onToggle: (id: string | null) => {
            this._subStripExpandedId = id;
            this._renderSubTaskStrip();
        },
    });
    if (count === 0) this._subStripExpandedId = null;
}

/**
 * Żywe odświeżanie paska: sub melduje krok co chwilę, więc zbieramy zdarzenia rejestru
 * w 250 ms okno. Świadomie NIE dotykamy pola tekstowego ani jego focusa — pasek jest
 * osobnym kontenerem nad wiadomościami, przerysowanie nie rusza inputu.
 */
export function _wireSubTaskStrip(this: ChatViewLike) {
    const events = this.plugin?.subTaskRegistry?.events;
    if (!events?.on || this._subStripUnsubs?.length) return;
    this._subStripUnsubs = [];
    const onChange = () => {
        if (this._subStripTimer) window.clearTimeout(this._subStripTimer);
        this._subStripTimer = window.setTimeout(() => {
            this._subStripTimer = null;
            this._renderSubTaskStrip();
        }, 250);
    };
    for (const event of ['task:created', 'task:step', 'task:finished']) {
        const off = events.on(event, onChange);
        if (typeof off === 'function') this._subStripUnsubs.push(off);
    }
}

/** Odpięcie subskrypcji + timera (zamknięty czat nie ma czego przerysowywać). */
export function _unwireSubTaskStrip(this: ChatViewLike) {
    for (const off of this._subStripUnsubs || []) {
        try { off(); } catch { /* sprzątanie nie ma prawa wywalić zamykania widoku */ }
    }
    this._subStripUnsubs = [];
    if (this._subStripTimer) {
        window.clearTimeout(this._subStripTimer);
        this._subStripTimer = null;
    }
}

export function _showMcpToolPicker(this: ChatViewLike, server: string, triggerBtn: HTMLElement | null) {
    this._chatBody?.querySelector('.pkm-trigger-picker')?.remove();
    const registry = this.plugin?.toolRegistry;
    const agent = this.plugin?.agentManager?.getActiveAgent?.();
    if (!registry) return;

    const visibleTools = registry.filterByAgent ? registry.filterByAgent(agent) : (registry.getAllTools?.() || []);
    const tools = visibleTools.filter((tool: ToolDefinition) => (tool.serverName || registry.getBuiltinServerForTool?.(tool.name)) === server);
    if (tools.length === 0) return;

    const overlay = createDiv();
    overlay.className = 'pkm-trigger-picker';

    const title = createDiv();
    title.textContent = server;
    title.className = 'pkm-trigger-picker__title';
    overlay.appendChild(title);

    for (const tool of tools) {
        const row = createEl('button');
        row.type = 'button';
        row.textContent = tool.name;
        row.className = 'pkm-trigger-picker__row';
        row.addEventListener('click', () => {
            insertInlineTriggerMarker(this.input_area, 'tool', tool.name);
            this.handleInputResize();
            overlay.remove();
        });
        overlay.appendChild(row);
    }

    const inputPanel = this.input_area?.closest('.cs-input-panel');
    if (inputPanel && this._chatBody) {
        const bodyRect = this._chatBody.getBoundingClientRect();
        const inputRect = inputPanel.getBoundingClientRect();
        overlay.style.bottom = `${bodyRect.bottom - inputRect.top + 8}px`;
        this._chatBody.appendChild(overlay);
    } else if (triggerBtn?.parentElement) {
        triggerBtn.parentElement.appendChild(overlay);
    }
}

// ── Artifacts segment ────────────────────────────

/**
 * Render the ARTEFAKTY slim-bar segment (mirror of `renderMcpServerButtons`). One icon opening a
 * picker of the active agent's artifacts. Always shown while an agent is active (segment discoverable
 * even before the first artifact — picker handles the empty case; artifact tool-calls don't emit a
 * slim-bar refresh event, so hide-when-empty would leave a new artifact hidden until re-render).
 */
export function renderArtifactButtons(this: ChatViewLike) {
    if (!this.artifactButtonsBar) return;
    this.artifactButtonsBar.empty();

    const agent = this.plugin?.agentManager?.getActiveAgent?.();
    if (!agent) return;

    this.artifactButtonsBar.createDiv({ cls: 'cs-skillbar__label', text: t('chat.artifacts') });
    const grid = this.artifactButtonsBar.createDiv({ cls: 'cs-skillbar__grid' });

    const btn = grid.createDiv({ cls: 'cs-skillbar__icon', attr: { 'data-tip': t('chat.artifacts') } });
    setSvg(btn, UiIcons.clipboard(16));
    btn.addEventListener('click', () => {
        if (this.is_generating) return;
        this._showArtifactPicker?.(btn);
    });
}

/**
 * Picker of the active agent's artifacts (mirror of `_showMcpToolPicker`). Active artifact marked ✓;
 * click = set active + inject fresh state via the B4 summon path; „✕ odepnij" clears the active one.
 */
export function _showArtifactPicker(this: ChatViewLike, triggerBtn: HTMLElement | null) {
    this._chatBody?.querySelector('.pkm-trigger-picker')?.remove();

    const store = this.plugin?.artifactStore;
    const agent = this.plugin?.agentManager?.getActiveAgent?.();
    let list: ArtifactListEntry[] = [];
    try { list = store ? store.list({ agent: agent?.name }) : []; } catch { list = []; }
    const { items } = buildArtifactPickerItems(list, this.currentArtifactId);

    const overlay = createDiv();
    overlay.className = 'pkm-trigger-picker';

    const title = createDiv();
    title.textContent = t('chat.artifacts');
    title.className = 'pkm-trigger-picker__title';
    overlay.appendChild(title);

    if (items.length === 0) {
        const empty = createDiv();
        empty.textContent = t('chat.artifacts.empty');
        empty.className = 'pkm-trigger-picker__empty';
        overlay.appendChild(empty);
    } else {
        for (const item of items) {
            const row = createEl('button');
            row.type = 'button';
            row.className = 'pkm-artifact-pick-row' + (item.active ? ' is-active' : '');

            const titleSpan = createSpan();
            titleSpan.className = 'pkm-artifact-pick-title';
            titleSpan.textContent = `${item.active ? '✓ ' : ''}📄 ${item.tytul}`;
            row.appendChild(titleSpan);

            const metaBits = [item.typ, item.status].filter(Boolean).join(' · ');
            if (metaBits) {
                const metaSpan = createSpan();
                metaSpan.className = 'pkm-artifact-pick-status';
                metaSpan.textContent = metaBits;
                row.appendChild(metaSpan);
            }

            row.addEventListener('click', () => {
                void (async () => {
                    overlay.remove();
                    // Klik = przypnij artefakt + otwórz notatkę. ŻADNEJ wysyłki do modelu — dump
                    // stanu robią guziki w notatce i 🔄 na chipie, nie samo wybranie z listy.
                    // TS-boundary: patrz `summonAgentForArtifact` wyżej - luka core `AppLike` vs `App`.
                    const res = await activateArtifactInChat(this.plugin as unknown as SummonPlugin, { id: item.id });
                    if (!res.ok || !res.path) return;
                    const file = this.app.vault.getAbstractFileByPath(res.path);
                    // `openFile` żąda instancji `TFile`; `getAbstractFileByPath` może też zwrócić
                    // `TFolder`, gdyby `res.path` wskazywał katalog — `instanceof` odsiewa ten
                    // przypadek zamiast wywoływać `openFile` na złym typie (patrz raport fali C:
                    // ZASTANE — wcześniej leciałoby do `catch` niżej z wyjątkiem Obsidiana).
                    if (!(file instanceof TFile)) return;
                    try {
                        await this.app.workspace.getLeaf('tab').openFile(file);
                    } catch (e) {
                        log.warn('Chat', `Open artifact note failed: ${(e as Error)?.message || String(e)}`);
                    }
                })();
            });
            overlay.appendChild(row);
        }

        if (this.currentArtifactId) {
            const unpin = createEl('button');
            unpin.type = 'button';
            unpin.className = 'pkm-artifact-pick-row pkm-artifact-pick-unpin';
            unpin.textContent = `✕ ${t('artifact.chip.unpin')}`;
            unpin.addEventListener('click', () => {
                this.currentArtifactId = null;
                this._renderArtifactChip?.();
                overlay.remove();
            });
            overlay.appendChild(unpin);
        }
    }

    const inputPanel = this.input_area?.closest('.cs-input-panel');
    if (inputPanel && this._chatBody) {
        const bodyRect = this._chatBody.getBoundingClientRect();
        const inputRect = inputPanel.getBoundingClientRect();
        overlay.style.bottom = `${bodyRect.bottom - inputRect.top + 8}px`;
        this._chatBody.appendChild(overlay);
    } else if (triggerBtn?.parentElement) {
        triggerBtn.parentElement.appendChild(overlay);
    }
}

/**
 * Show pre-questions mini-form overlay for a skill.
 * User fills in variables, then prompt is injected with substitutions.
 */
export function _showSkillPreQuestions(this: ChatViewLike, skill: ChatSkillConfig) {
    // Remove existing overlay if any
    this._chatBody?.querySelector('.pkm-skill-pq-overlay')?.remove();

    const overlay = createDiv();
    overlay.className = 'pkm-skill-pq-overlay';
    const hasAdvanced = skill.preQuestions!.some((pq) => pq.type === 'select' || pq.type === 'textarea');
    const overlayWidth = hasAdvanced ? 320 : 240;
    // Static styling lives in chat_view.css (.pkm-skill-pq-overlay); only the width is dynamic.
    overlay.style.width = `${overlayWidth}px`;

    // Position just above the input panel
    const inputPanel = this.input_area?.closest('.cs-input-panel');
    if (inputPanel && this._chatBody) {
        const bodyRect = this._chatBody.getBoundingClientRect();
        const inputRect = inputPanel.getBoundingClientRect();
        const bottomOffset = bodyRect.bottom - inputRect.top + 8;
        overlay.style.bottom = `${bottomOffset}px`;
    }

    const title = createDiv();
    title.className = 'pkm-skill-pq-title';
    setSvgLabel(title, IconGenerator.generate(skill.name, skill.icon_category || 'arcane', { size: 16, color: 'currentColor' }), skill.name);
    overlay.appendChild(title);

    const inputs: Record<string, PreQuestionInput> = {};

    for (const pq of skill.preQuestions as ChatSkillPreQuestion[]) {
        const row = createDiv();
        row.className = 'pkm-skill-pq-row';

        const label = createEl('label');
        label.className = 'pkm-skill-pq-label';
        label.textContent = pq.question;
        row.appendChild(label);

        let inputEl: PreQuestionInput;
        const pqType = pq.type || 'text';

        if (pqType === 'select') {
            inputEl = createEl('select');
            inputEl.className = 'pkm-skill-pq-input';
            if (Array.isArray(pq.options)) {
                for (const opt of pq.options) {
                    const optEl = createEl('option');
                    if (typeof opt === 'object' && opt !== null) {
                        optEl.value = opt.value;
                        optEl.textContent = opt.label || opt.value;
                        if (opt.group) optEl.dataset.group = opt.group;
                    } else {
                        optEl.value = String(opt);
                        optEl.textContent = String(opt);
                    }
                    inputEl.appendChild(optEl);
                }
            }
            if (pq.default) inputEl.value = pq.default;
        } else if (pqType === 'textarea') {
            inputEl = createEl('textarea');
            inputEl.value = pq.default || '';
            inputEl.placeholder = pq.placeholder || pq.key;
            inputEl.rows = pq.rows || 3;
            inputEl.className = 'pkm-skill-pq-input pkm-skill-pq-input--textarea';
        } else {
            inputEl = createEl('input');
            inputEl.type = 'text';
            inputEl.value = pq.default || '';
            inputEl.placeholder = pq.placeholder || pq.key;
            inputEl.className = 'pkm-skill-pq-input';
        }

        row.appendChild(inputEl);
        inputs[pq.key] = inputEl;

        // Store metadata for depends_on wiring
        if (pq.depends_on) {
            inputEl._dependsOn = pq.depends_on;
            inputEl._allOptions = Array.isArray(pq.options) ? [...pq.options] : [];
        }

        overlay.appendChild(row);
    }

    // Wire cascading: parent select change filters child options by group
    for (const el of Object.values(inputs)) {
        if (!el._dependsOn || !inputs[el._dependsOn]) continue;
        const parentEl = inputs[el._dependsOn];
        const childEl = el;
        const allOpts = el._allOptions as PreQuestionOption[];

        const filterOptions = () => {
            const parentVal = parentEl.value;
            childEl.empty();
            for (const opt of allOpts) {
                const group = (typeof opt === 'object' && opt !== null) ? opt.group : null;
                if (!group || group === parentVal) {
                    const optEl = createEl('option');
                    optEl.value = (typeof opt === 'object') ? opt.value : String(opt);
                    optEl.textContent = (typeof opt === 'object') ? (opt.label || opt.value) : String(opt);
                    childEl.appendChild(optEl);
                }
            }
        };

        parentEl.addEventListener('change', filterOptions);
        filterOptions(); // initial filter
    }

    const btnRow = createDiv();
    btnRow.className = 'pkm-skill-pq-btnrow';

    const cancelBtn = createEl('button');
    cancelBtn.textContent = t('chat.cancel');
    cancelBtn.className = 'pkm-skill-pq-btn';
    cancelBtn.addEventListener('click', () => overlay.remove());
    btnRow.appendChild(cancelBtn);

    const useBtn = createEl('button');
    useBtn.textContent = t('chat.use');
    useBtn.className = 'mod-cta pkm-skill-pq-btn';
    useBtn.addEventListener('click', () => {
        // Collect values
        const values: Record<string, string> = {};
        for (const [key, inp] of Object.entries(inputs)) {
            values[key] = inp.value;
        }

        // Substitute variables in prompt
        const prompt = substituteVariables(skill.prompt || t('chat.use_skill', { name: skill.name }), values);

        this.input_area.value = prompt;
        this.input_area.focus();
        this.handleInputResize();
        overlay.remove();
    });
    btnRow.appendChild(useBtn);

    overlay.appendChild(btnRow);

    // Attach to chat body (same as artifact panel)
    if (this._chatBody) {
        this._chatBody.appendChild(overlay);
    }
}

// ── Typing indicator ────────────────────────────────────────────────

export function showTypingIndicator(this: ChatViewLike, statusText?: string) {
    if (!statusText) statusText = t('chat.crystallizing');
    if (this.typingIndicator) {
        this.updateTypingStatus(statusText);
        return;
    }

    const activeAgent = this.plugin?.agentManager?.getActiveAgent();
    const agentColor = SkinManager.getAgentColor(activeAgent || 'default');

    this.typingIndicator = this.messages_container.createDiv({ cls: 'cs-typing' });

    const crystalEl = this.typingIndicator.createDiv({ cls: 'cs-typing__crystal' });
    setSvg(crystalEl, SkinManager.getCrystal(activeAgent || 'default', { size: 20, color: agentColor, glow: true }));

    this.typingStatusEl = this.typingIndicator.createSpan({ cls: 'cs-typing__text', text: statusText });

    this.scrollToBottom();
}

export function updateTypingStatus(this: ChatViewLike, statusText: string) {
    if (this.typingStatusEl) {
        this.typingStatusEl.textContent = statusText;
    }
    this.scrollToBottom();
}

export function hideTypingIndicator(this: ChatViewLike) {
    if (this.typingIndicator) {
        this.typingIndicator.remove();
        this.typingIndicator = null;
        this.typingStatusEl = null;
    }
}

// ── Scrolling ───────────────────────────────────────────────────────

/**
 * @param smooth - płynne przewinięcie (jak dotąd)
 * @param opts - `drawConnectors: false` = TRYB „TYLKO PRZEWIŃ". Malowanie strumienia
 *   (`_paintStreamFrame`) korzysta z niego, bo rosnący tekst ostatniej wiadomości nie przesuwa
 *   ani kryształu, ani wierszy akcji — a `_drawConnectorLines` skanuje CAŁĄ listę wiadomości
 *   i przeplata odczyty `getBoundingClientRect` z wstawianiem węzłów.
 */
export function scrollToBottom(this: ChatViewLike, smooth = true, opts: { drawConnectors?: boolean } = {}) {
    const container = this.messages_container;
    if (!container) return;

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const isAtBottom = distanceFromBottom < 150;

    if (isAtBottom || !smooth) {
        const target = container.scrollHeight - container.clientHeight;
        if (smooth) {
            container.scrollTo({ top: target, behavior: 'smooth' });
        } else {
            container.scrollTop = target;
        }
    }

    if (opts.drawConnectors === false) return;
    // Redraw connector lines (position depends on layout) — skoalescowane do jednej klatki.
    this._scheduleConnectorRedraw();
}

/**
 * JEDNO przerysowanie łączników na klatkę, nie na wywołanie.
 *
 * `_drawConnectorLines` usuwa i wstawia węzły przeplatając to z odczytami geometrii (layout
 * thrashing), a jego koszt rośnie z liczbą wiadomości w oknie. Wołaczy jest kilku i potrafią
 * strzelać seriami (przewijanie, status narzędzia, malowanie strumienia) — dlatego zamiast
 * rysować od razu, planujemy jedno rysowanie na klatkę animacji.
 *
 * ⚠️ `requestAnimationFrame` NIE chodzi, gdy okno jest schowane — i dobrze: `getBoundingClientRect`
 * zwraca wtedy zera, więc rysowanie i tak dałoby śmieci. Zaległe rysowanie wykona się, gdy okno
 * wróci. Fallback na `setTimeout` dla środowisk bez rAF (harness/testy).
 */
export function _scheduleConnectorRedraw(this: ChatViewLike) {
    if (this._connectorRedrawCancel) return;
    const run = () => {
        this._connectorRedrawCancel = null;
        this._drawConnectorLines();
    };
    if (typeof requestAnimationFrame === 'function') {
        const handle = window.requestAnimationFrame(run);
        this._connectorRedrawCancel = () => cancelAnimationFrame(handle);
    } else {
        const handle = window.setTimeout(run, 16);
        this._connectorRedrawCancel = () => window.clearTimeout(handle);
    }
}

/** Rozbraja zaplanowane przerysowanie łączników (zamknięcie widoku). */
export function _cancelConnectorRedraw(this: ChatViewLike) {
    if (!this._connectorRedrawCancel) return;
    try { this._connectorRedrawCancel(); } catch { /* best-effort */ }
    this._connectorRedrawCancel = null;
}

/**
 * After generation completes, smoothly center the final agent message.
 */
export function scrollToFinalMessage(this: ChatViewLike) {
    const container = this.messages_container;
    if (!container) return;
    const lastMessage = container.querySelector('.cs-message--agent:last-of-type');
    if (lastMessage) {
        lastMessage.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

// ── Welcome message ─────────────────────────────────────────────────

export function add_welcome_message(this: ChatViewLike) {
    const agentManager = this.plugin?.agentManager;
    const activeAgent = agentManager?.getActiveAgent();
    const agentName = activeAgent?.name || 'PKM Assistant';

    const welcome = this.messages_container.createDiv({ cls: 'pkm-welcome-container' });
    const welcomeAvatar = welcome.createDiv({ cls: 'pkm-welcome-avatar' });
    welcomeAvatar.appendChild(this._createCrystalAvatar(activeAgent, 48));
    welcome.createDiv({ cls: 'pkm-welcome-name', text: agentName });
    welcome.createDiv({
        cls: 'pkm-welcome-text',
        text: t('chat.welcome')
    });
    welcome.createDiv({
        cls: 'pkm-welcome-hint',
        text: t('chat.welcome_hint')
    });
}

// ── Input handling ──────────────────────────────────────────────────

export function handleInputResize(this: ChatViewLike) {
    if (!this.input_area) return;
    const textarea = this.input_area;
    textarea.style.removeProperty('height'); // Reset to count scrollHeight correctly (falls back to CSS auto)
    const newHeight = Math.min(Math.max(textarea.scrollHeight, 40), 160);
    textarea.style.height = newHeight + 'px';
}

export function resetInputArea(this: ChatViewLike) {
    if (!this.input_area) return;
    this.input_area.value = '';
    this.input_area.style.removeProperty('height'); // Reset to min-height (CSS floor, .cs-input-textarea)
    this.historyIndex = -1;
}

export function handle_input_keydown(this: ChatViewLike, e: KeyboardEvent) {
    // @ mention autocomplete takes priority when open
    if (this.mentionAutocomplete?.isOpen) {
        if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
            return; // MentionAutocomplete handles these via its own keydown listener
        }
    }

    // Send on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // Druga (i ostatnia) ścieżka z pola wpisywania — jawny znacznik człowieka.
        void this.send_message({ meta: HUMAN_MESSAGE_META });
        return;
    }

    // History navigation
    if (e.key === 'ArrowUp' && this.input_area.selectionStart === 0) {
        // Only if cursor at start (or generic if preferred, but user asked for specific condition)
        e.preventDefault();
        if (this.inputHistory.length > 0) {
            if (this.historyIndex < this.inputHistory.length - 1) {
                this.historyIndex++;
                this.input_area.value = this.inputHistory[this.inputHistory.length - 1 - this.historyIndex] || '';
                this.handleInputResize();
            }
        }
        return;
    }

    if (e.key === 'ArrowDown' && this.input_area.selectionEnd === this.input_area.value.length) {
        e.preventDefault();
        if (this.historyIndex > 0) {
            this.historyIndex--;
            this.input_area.value = this.inputHistory[this.inputHistory.length - 1 - this.historyIndex] || '';
        } else if (this.historyIndex !== -1) {
            this.historyIndex = -1;
            this.input_area.value = '';
        }
        this.handleInputResize();
        return;
    }
}

export function handleGlobalKeydown(this: ChatViewLike, e: KeyboardEvent) {
    if (e.key === 'Escape' && this.is_generating) {
        e.preventDefault();
        this.stop_generation();
    }
}

// ── Token counter & context ─────────────────────────────────────────

export function updateTokenCounter(this: ChatViewLike) {
    const el = this._tokenDisplay || this.container?.querySelector('.cs-input-tokens');
    if (!el) return;

    // Pod inputem: % okna kontekstu
    const current = this.rollingWindow.getCurrentTokenCount();
    const max = this.rollingWindow.maxTokens;
    const percent = max > 0 ? Math.min(100, Math.round((current / max) * 100)) : 0;
    const threshold = this.env?.settings?.pkmAssistant?.summarizationThreshold || 0.9;
    const thresholdPercent = Math.round(threshold * 100);

    // Okno kontekstu to zawsze estymata (RollingWindow) — tylda + tooltip mówią to wprost.
    el.textContent = `~${percent}%`;
    el.title = t('chat.token_viewer.approx_tooltip');

    // Glow agent color at compression threshold
    if (percent >= thresholdPercent) {
        el.classList.add('cs-context-hot');
        el.classList.remove('cs-context-warm');
    } else if (percent >= 50) {
        el.classList.add('cs-context-warm');
        el.classList.remove('cs-context-hot');
    } else {
        el.classList.remove('cs-context-warm', 'cs-context-hot');
    }

    this._updateSlimBarTokens();
    this._tokenViewer?.update();
}

/** Update token panels — redirects to slim bar counters. */
export function _updateTokenPanel(this: ChatViewLike) {
    this._updateSlimBarTokens();
    this._tokenViewer?.update();
}

// _updateContextCircle usunięty (martwy stary donut). `.token-wrapper` nigdy nie
// powstawał w DOM, więc funkcja zawsze wchodziła w early-return. Aktywny wskaźnik kontekstu
// to TokenViewerWidget (donut w slim barze). CSS .token-wrapper/.pkm-context-circle/.pkm-donut* też out.

/**
 * Build a single token counter row for slim bar.
 * Te wiersze mierzą SUMĘ SESJI z API (`tokenTracker`), nie okno kontekstu — stąd tooltip,
 * żeby ↑↓ nie były mylone z licznikiem KONTEKST (Token Viewer).
 * @param {HTMLElement} parent
 * @param {'main'|'minion'} role
 * @returns {{el: HTMLElement, valEl: HTMLElement}}
 */
export function _buildTokenRow(this: ChatViewLike, parent: HTMLElement, role: string): TokenRowRefs {
    const row = parent.createDiv({ cls: `cs-skillbar__token-row cs-skillbar__token-row--${role}` });
    const sessionTooltip = t('chat.token_viewer.session_total_tooltip');
    row.setAttribute('title', sessionTooltip);
    row.setAttribute('aria-label', sessionTooltip);
    const icon = row.createSpan({ cls: 'cs-skillbar__token-icon' });
    if (role === 'main') {
        // Diamond crystal for main
        setSvg(icon, '<svg viewBox="0 0 10 10" width="8" height="8"><polygon points="5,0 10,5 5,10 0,5" fill="currentColor"/></svg>');
    } else {
        // 'minion' — jedyna pozostała rola sub-agentów w slim barze. Nic w kodzie nie woła
        // `_buildTokenRow` z rolą inną niż 'main'/'minion', więc gałęzi 'master' (ikona korony)
        // tu nie ma.
        setSvg(icon, UiIcons.robot(8));
    }
    const valEl = row.createSpan({ cls: 'cs-skillbar__token-val' });
    valEl.textContent = '0';
    return { el: row, valEl };
}

/**
 * Update the slim bar token display (2 counters: main/minion).
 * Each shows in↑ out↓ from API.
 */
export function _updateSlimBarTokens(this: ChatViewLike) {
    if (!this._slimBarTokenMain) return;
    const s = this.tokenTracker.getSessionTotal();
    const fmt = (n: number) => n > 999 ? `${(n / 1000).toFixed(1)}k` : String(n);

    const update = (ref: TokenRowRefs, data: RoleTotals) => {
        const total = (data.input || 0) + (data.output || 0);
        if (total > 0) {
            ref.valEl.textContent = `${fmt(data.input)}↑${fmt(data.output)}↓`;
            ref.el.classList.remove('is-hidden');
        } else {
            ref.valEl.textContent = '0';
            ref.el.classList.add('is-hidden');
        }
    };

    const main = s.byRole?.main || { input: 0, output: 0 };
    // Runtime raportuje role 'researcher' — bez fallbacku na `byRole.minion` wiersz subów
    // czytałby martwy klucz i wiecznie pokazywałby 0.
    const minion = s.byRole?.researcher || s.byRole?.minion || { input: 0, output: 0 };
    // Nie ma wiersza 'master': żadna konfiguracja produkowana przez plugin nie zasila
    // `byRole.master`, więc taki wiersz byłby trwale ukryty (`is-hidden` przy totalu 0).

    // `_slimBarTokenMain` sprawdzone na wejściu funkcji; oba wiersze powstają razem.
    update(this._slimBarTokenMain, main);
    update(this._slimBarTokenMinion!, minion);

    // Show main always if session has any tokens
    if (s.total > 0) {
        this._slimBarTokenMain.el.classList.remove('is-hidden');
    }
}

// ── Permissions badge ───────────────────────────────────────────────

export function updatePermissionsBadge(this: ChatViewLike) {
    const agent = this.plugin.agentManager?.getActiveAgent();
    if (!agent) return;

    // Nie ma gałęzi rocket/yolo tutaj — YOLO to per-chat tryb autonomii (własny
    // button/popover), nie uprawnienie. Badge liczy z jednej osi (disabled_tools), nie z pól
    // edit_notes/mcp: tarcza gdy agent może modyfikować vault (narzędzie `write` włączone),
    // kłódka gdy tylko czyta.
    const canModify = !(Array.isArray(agent.disabled_tools) && agent.disabled_tools.includes('write'));
    let iconFn;
    if (canModify) {
        iconFn = (s: number) => UiIcons.shield(s);
    } else {
        iconFn = (s: number) => UiIcons.lock(s);
    }

    if (this.permissionsBtn) setSvg(this.permissionsBtn, iconFn(16));
    if (this._permBtn) setSvg(this._permBtn, iconFn(12));
}

// ── Inline trigger popup ───────────────────────────

export function _handleTriggerKeyDown(this: ChatViewLike, e: KeyboardEvent) {
    // If popup open, give it first chance to consume key
    if (this._triggerPopup?.isOpen()) {
        if (this._triggerPopup.handleKeyDown(e)) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
    }
    if (e.key !== '/' && e.key !== '@') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const value = this.input_area.value || '';
    const cursor = this.input_area.selectionStart ?? value.length;
    const charBefore = cursor > 0 ? value.charAt(cursor - 1) : '';
    // Only open at start of line/value, or after whitespace — avoids triggering in URLs / mid-word
    if (cursor !== 0 && !/\s/.test(charBefore)) return;
    const triggerChar = e.key;
    const triggerPos = cursor; // pre-key cursor; after key is committed, char will be at this index
    window.setTimeout(() => this._openTriggerPopup(triggerChar, triggerPos), 0);
}

export function _handleTriggerInput(this: ChatViewLike) {
    if (!this._triggerPopup?.isOpen()) return;
    const value = this.input_area.value || '';
    const cursor = this.input_area.selectionStart ?? value.length;
    if (this._triggerPos < 0 || this._triggerPos >= value.length) {
        this._closeTriggerPopup();
        return;
    }
    const triggerChar = value.charAt(this._triggerPos);
    if (triggerChar !== '/' && triggerChar !== '@') {
        this._closeTriggerPopup();
        return;
    }
    if (cursor <= this._triggerPos) {
        this._closeTriggerPopup();
        return;
    }
    const filter = value.slice(this._triggerPos + 1, cursor);
    if (/\s/.test(filter)) {
        this._closeTriggerPopup();
        return;
    }
    this._triggerPopup.setFilter(filter);
}

export function _openTriggerPopup(this: ChatViewLike, triggerChar: string, triggerPos: number) {
    this._closeTriggerPopup();
    const agent = this.plugin?.agentManager?.getActiveAgent?.();
    this._triggerPos = triggerPos;
    const slashList = (typeof this.slashCommands?.list === 'function' ? this.slashCommands.list() : [])
        .map((cmd: SlashCommand) => ({ name: cmd.name, description: cmd.description || '' }));
    this._triggerPopup = new TriggerPopup(this.plugin, agent, this.input_area, {
        slashCommands: slashList,
        onSelect: (item: TriggerItem, marker: string) => {
            const value = this.input_area.value || '';
            const cursor = this.input_area.selectionStart ?? value.length;
            const cutStart = Math.max(0, this._triggerPos);
            const cutEnd = Math.max(cutStart, Math.min(value.length, cursor));
            const before = value.slice(0, cutStart);
            const after = value.slice(cutEnd);

            if (item.type === 'slash') {
                // Slash command: replace trigger+filter with `/cmd ` text so user can press Enter to run.
                const replacement = marker || `${item.name} `;
                this.input_area.value = before + replacement + after;
                const caret = before.length + replacement.length;
                this.input_area.setSelectionRange(caret, caret);
                this._triggerPos = -1;
                this.handleInputResize?.();
                this.input_area.focus();
                return;
            }

            this.input_area.value = before + after;
            this.input_area.setSelectionRange(before.length, before.length);
            insertInlineTriggerMarker(this.input_area, item.type, item.name);
            this._triggerPos = -1;
            this.handleInputResize?.();
        }
    });
    this._triggerPopup.open(triggerChar, this.input_area);
}

export function _closeTriggerPopup(this: ChatViewLike) {
    if (this._triggerPopup) {
        this._triggerPopup.close();
        this._triggerPopup = null;
    }
    this._triggerPos = -1;
}

export function _renderCacheSavingsBadge(this: ChatViewLike, container: HTMLElement | null, cacheMeta: Partial<CacheMetadata> | null | undefined) {
    if (!container || !cacheMeta?.cached_tokens) return;
    const cached = Number(cacheMeta.cached_tokens || 0).toLocaleString();
    const total = Number(cacheMeta.total_input_tokens || 0).toLocaleString();
    const badge = container.createSpan({ cls: 'cs-cache-savings-badge', text: '💾' });
    const tooltip = t('chat.token_viewer.cache_badge_tooltip', { cached, total });
    badge.setAttribute('aria-label', tooltip);
    badge.setAttribute('title', tooltip);
}
