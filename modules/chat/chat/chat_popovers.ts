/**
 * Popovers and inline UI blocks — mode, tools, permissions, ask_user.
 * Methods mixed into ChatView.prototype.
 */
import { Notice } from 'obsidian';
import { SkinManager, UiIcons, setSvg } from '../../crystal-soul/index.js';
import { AUTONOMY_MODES, normalizeAutonomy } from '../../../core/index.js';
// Przelaczniki uprawnien licza sie na ZYWEJ osi `disabled_tools`, a nie na polach
// `default_permissions`, ktore Agent._normalizePermissions i tak kasuje.
import {
    PERMISSION_PRESET_SWITCHES,
    isPermissionSwitchOn,
    applyPermissionSwitch,
    applyPermissionPreset,
} from '../../agents/index.js';
import { TOOL_INFO } from '../../ui-components/index.js';
import { log } from '../../../core/utils/Logger.js';
import { t } from '../../../core/i18n/index.js';
import { buildToolPopoverEntries } from './toolPopoverEntries.js';
// KANONICZNY klucz zakładki - `chat_tabs.ts` ostrzega w JSDoc `_tabKey` że druga kopia tej
// samej formuły = wynik suba (albo tu: zapis autonomii) trafiałby do złej zakładki, gdy
// tożsamość zakładki się kiedyś rozszerzy.
import { _tabKey } from './chat_tabs.js';

// TS-any: metody są domiksowywane do ChatView.prototype składanego w runtime.
type ChatViewMixinContext = any;
// TS-any: argumenty ask_user są dynamicznymi metadanymi wywołania narzędzia.
type Runtime = any;

type AutonomyId = 'yolo' | 'edge' | 'all';

interface ChatTabState {
    isActive?: boolean;
    sessionId?: string;
    sessionPath?: string;
    sessionName?: string;
    agentName?: string;
}

interface StoredChatState {
    autonomy: AutonomyId;
}

interface AgentLike {
    disabled_tools?: string[];
    permissions: Record<string, boolean>;
    emoji?: string;
    name?: string;
    update(change: { default_permissions?: Record<string, boolean>; disabled_tools?: string[] }): void;
}

interface AskUserToolCall {
    arguments: Runtime;
}

interface AskUserArguments {
    question?: string;
    options?: string[];
    context?: string;
}

// ══════════════════════════════════════════════════════════════════════════
// AUTONOMIA - per-czat: czy agent PYTA zanim zrobi to, co mu wolno.
// Niezależna oś od uprawnień. Zmiana NIE wstrzykuje wiadomości do rozmowy (polityka UI,
// model o niej nie wie).
// ══════════════════════════════════════════════════════════════════════════

/**
 * Get the UiIcons SVG string for an autonomy state.
 * rocket = yolo (leć), shield = edge (pytaj-na-krawędzi, default), search = all (pytaj o wszystko).
 */
export function _getAutonomyIcon(autonomyId: AutonomyId, size = 16): string {
    switch (autonomyId) {
        case 'yolo': return UiIcons.rocket(size);
        case 'all': return UiIcons.search(size);
        case 'edge':
        default: return UiIcons.shield(size);
    }
}

/** Refresh the autonomy button label + icon from this.currentAutonomy. */
export function _updateAutonomyButton(this: ChatViewMixinContext): void {
    if (!this._autonomyBtn) return;
    const label = t(`autonomy.${this.currentAutonomy}`);
    setSvg(this._autonomyBtn, this._getAutonomyIcon(this.currentAutonomy, 12));
    this._autonomyBtn.createSpan({ text: label });
    this._autonomyBtn.setAttribute('aria-label', t('chat.autonomy', { label }));
}

/**
 * Apply an autonomy change. Unlike the old mode change, this does NOT inject any system
 * message into the conversation — autonomy is a UI-only policy the model never sees.
 */
export function _applyAutonomyChange(this: ChatViewMixinContext, newAutonomy: unknown): void {
    const normalized = normalizeAutonomy(newAutonomy);
    this.currentAutonomy = normalized;
    if (this.plugin) this.plugin.currentAutonomy = normalized;
    // Persist onto the active tab's stored state so tab switches restore it.
    const activeTab = this.chatTabs?.find((t: ChatTabState) => t.isActive) as ChatTabState | undefined;
    const activeKey = _tabKey(activeTab) || null;
    const state = activeKey
        ? this._agentStates?.get(activeKey) as StoredChatState | undefined
        : null;
    if (state) state.autonomy = normalized;
    this._updateAutonomyButton();
    new Notice(t('chat.popover.autonomy', { label: t(`autonomy.${normalized}`) }));
    log.info('Chat', `Autonomy changed → ${normalized}`);
}

/** Toggle the autonomy selector popover (3 states with one-line descriptions). */
export function _toggleAutonomyPopover(this: ChatViewMixinContext): void {
    if (this._autonomyPopover) {
        this._autonomyPopover.remove();
        this._autonomyPopover = null;
        return;
    }

    const popover = createDiv();
    popover.className = 'cs-mode-popover cs-autonomy-popover';

    for (const id of AUTONOMY_MODES) {
        const item = createDiv();
        item.className = 'cs-mode-popover-item';
        if (id === this.currentAutonomy) item.classList.add('active');

        const head = createDiv();
        head.className = 'cs-autonomy-popover__head';
        setSvg(head.createSpan(), this._getAutonomyIcon(id, 14));
        head.createSpan({ text: t(`autonomy.${id}`) });

        const desc = createDiv();
        desc.className = 'cs-autonomy-popover__desc';
        desc.textContent = t(`autonomy.${id}.desc`);

        item.appendChild(head);
        item.appendChild(desc);
        item.addEventListener('click', () => {
            this._applyAutonomyChange(id);
            popover.remove();
            this._autonomyPopover = null;
        });
        popover.appendChild(item);
    }

    this._autonomyBtn.appendChild(popover);
    this._autonomyPopover = popover;

    const closeHandler = (e: MouseEvent) => {
        if (!popover.contains(e.target as Node | null) && !this._autonomyBtn.contains(e.target)) {
            popover.remove();
            this._autonomyPopover = null;
            document.removeEventListener('click', closeHandler);
        }
    };
    window.setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

/**
 * Toggle the tools popover.
 */
export function _toggleToolsPopover(this: ChatViewMixinContext, btn: HTMLElement): void {
    if (this._toolsPopover) {
        this._toolsPopover.remove();
        this._toolsPopover = null;
        return;
    }

    const agent = this.plugin?.agentManager?.getActiveAgent() as AgentLike | undefined;
    // Lista = ŻYWY rejestr (co da się TERAZ wywołać), nie klucze TOOL_INFO (mapa ikon/etykiet
    // dla renderu historii - celowo trzyma wpisy dla narzędzi, których już nie ma w rejestrze).
    // `TOOL_INFO` tu tylko dostarcza ikonę/etykietę per nazwa; nazwa bez wpisu (nowe narzędzie,
    // tool z zewnętrznego serwera MCP) dostaje fallback.
    const registryNames: string[] = this.plugin?.toolRegistry?.getAllToolNames?.() ?? [];
    const entries = buildToolPopoverEntries(
        registryNames,
        agent?.disabled_tools,
        TOOL_INFO,
    );

    const popover = createDiv();
    popover.className = 'cs-tools-popover';

    for (const entry of entries) {
        const toolName = entry.name;
        const item = createEl('button');
        item.className = 'cs-tools-popover__item';
        // toolName can come from an external MCP server — text node, never markup.
        setSvg(item, entry.icon ? entry.icon() : UiIcons.tool(14));
        item.createSpan({ text: entry.label });
        item.createSpan({ cls: 'cs-tools-popover__item-name', text: toolName });
        item.addEventListener('click', () => {
            const ta = this.input_area;
            const pos = ta.selectionStart;
            const val = ta.value;
            ta.value = val.slice(0, pos) + toolName + val.slice(pos);
            ta.selectionStart = ta.selectionEnd = pos + toolName.length;
            ta.focus();
            popover.remove();
            this._toolsPopover = null;
        });
        popover.appendChild(item);
    }

    btn.appendChild(popover);
    this._toolsPopover = popover;

    const closeHandler = (e: MouseEvent) => {
        if (!popover.contains(e.target as Node | null) && !btn.contains(e.target as Node | null)) {
            popover.remove();
            this._toolsPopover = null;
            document.removeEventListener('click', closeHandler);
        }
    };
    window.setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

/**
 * JEDNA droga zapisu zmiany uprawnień z popovera.
 *
 * Wołanie `loader.saveAgent(agent)` wprost byłoby błędne dla agenta WBUDOWANEGO (Jaskier):
 * to zapis do `jaskier.yaml`, czyli pliku, który `loadAllAgents` odfiltrowuje - ograniczenie
 * ustawione przez usera znikałoby po restarcie Obsidiana, bez słowa ostrzeżenia. `updateAgent`
 * ma poprawną gałąź dla built-ina (plik `<nazwa>_overrides.yaml`) i rozgłasza `agent:updated`.
 *
 * Zapis jest asynchroniczny, a UI przestawia kropkę od razu — stan w RAM zmienia `agent.update`
 * wewnątrz `updateAgent`, więc popover nie czeka na dysk.
 */
function _persistAgentChange(
    view: ChatViewMixinContext,
    agent: AgentLike,
    updates: { default_permissions?: Record<string, boolean>; disabled_tools?: string[] },
): void {
    const manager = view.plugin?.agentManager;
    if (manager?.updateAgent && agent.name) {
        Promise.resolve(manager.updateAgent(agent.name, updates))
            .catch((e: unknown) => log.warn('Chat', 'Nie udało się zapisać uprawnień agenta:', e));
        return;
    }
    // Awaryjnie (brak managera w atrapie/starym bootstrapie): sam obiekt w RAM.
    agent.update(updates);
}

/**
 * Toggle the permissions popover.
 */
export function _togglePermPopover(this: ChatViewMixinContext): void {
    if (this._permPopover) {
        this._permPopover.remove();
        this._permPopover = null;
        return;
    }

    const agent = this.plugin?.agentManager?.getActiveAgent() as AgentLike | undefined;
    if (!agent) return;

    const popover = createDiv();
    popover.className = 'cs-perm-popover';

    // Header
    const header = createDiv();
    header.className = 'cs-perm-popover__head';
    setSvg(header, UiIcons.shield(12));
    header.createSpan({ text: t('chat.popover.permissions') });
    popover.appendChild(header);

    // Presets
    const presets = createDiv();
    presets.className = 'cs-perm-popover__presets';
    // Presety NIE ustawiają yolo_mode - to nie uprawnienie, tylko tryb autonomii per-czat.
    // „Full” różni się od „Standard” przez delete_files: true.
    // Presety ruszają WYŁĄCZNIE oś narzędzi vaultowych (`disabled_tools`). Nie piszą `memory`
    // ani `guidance_mode` - presety zmieniające `guidance_mode` zawężałyby agenta do whitelisty
    // folderów bez jawnej decyzji usera na to konkretne pole. Te dwie osie mają w popoverze
    // własne wiersze i tam się je przestawia.
    const PRESETS = {
        safe:     { label: t('chat.popover.safe'),     icon: UiIcons.lock(11),   switches: PERMISSION_PRESET_SWITCHES.safe },
        standard: { label: t('chat.popover.standard'), icon: UiIcons.scales(11), switches: PERMISSION_PRESET_SWITCHES.standard },
        full:     { label: t('chat.popover.full'),     icon: UiIcons.rocket(11), switches: PERMISSION_PRESET_SWITCHES.full },
    };
    for (const [key, preset] of Object.entries(PRESETS)) {
        const btn = createEl('button');
        btn.className = `cs-perm-popover__preset cs-perm-popover__preset--${key}`;
        setSvg(btn, preset.icon);
        btn.createSpan({ text: preset.label });
        btn.addEventListener('click', () => {
            _persistAgentChange(this, agent, { disabled_tools: applyPermissionPreset(agent.disabled_tools, preset.switches) });
            this._permPopover?.remove();
            this._permPopover = null;
            this._togglePermPopover();
        });
        presets.appendChild(btn);
    }
    popover.appendChild(presets);

    // Separator
    const sep = createDiv();
    sep.className = 'cs-perm-popover__sep';
    popover.appendChild(sep);

    // Permission rows.
    // `axis` mówi, GDZIE mieszka stan wiersza.
    //  - 'tools' = przełącznik narzędzi built-in (`disabled_tools`) - egzekwowany przez
    //    `ToolRegistry.checkToolAxis` przy widoczności I przy wykonaniu (MCPClient);
    //  - 'perm'  = żywe pole uprawnień agenta (`memory` bramkuje scope=memory, `guidance_mode`
    //    decyduje: cały vault vs whitelista folderów).
    // Brak wiersza „Narzędzia MCP": dostęp do serwera zewnętrznego to opt-in per serwer
    // (`agent.mcp_servers[]` w profilu agenta) - jeden boolean nie miałby czego włączać.
    const PERM_ROWS: Array<{ key: string; label: string; icon: string; axis: 'tools' | 'perm' }> = [
        { key: 'read_notes',    label: t('chat.popover.read_notes'),    icon: UiIcons.eye(11),     axis: 'tools' },
        { key: 'edit_notes',    label: t('chat.popover.edit_notes'),    icon: UiIcons.edit(11),    axis: 'tools' },
        { key: 'create_files',  label: t('chat.popover.create_files'),  icon: UiIcons.file(11),    axis: 'tools' },
        { key: 'delete_files',  label: t('chat.popover.delete_files'),  icon: UiIcons.trash(11),   axis: 'tools' },
        // No YOLO_MODE row here - it lives in the per-chat autonomy button/popover.
        { key: 'memory',        label: t('chat.popover.memory'),        icon: UiIcons.brain(11),   axis: 'perm' },
        { key: 'guidance_mode', label: t('chat.popover.guidance_mode'), icon: UiIcons.compass(11), axis: 'perm' },
    ];

    for (const row of PERM_ROWS) {
        const rowEl = createDiv();
        rowEl.className = 'cs-perm-popover__row';

        const labelEl = createDiv();
        labelEl.className = 'cs-perm-popover__label';
        setSvg(labelEl, row.icon);
        labelEl.createSpan({ text: row.label });

        const isOn = () => (row.axis === 'tools'
            ? isPermissionSwitchOn(agent.disabled_tools, row.key)
            : Boolean(agent.permissions[row.key]));

        const toggle = createDiv();
        toggle.className = 'cs-perm-toggle' + (isOn() ? ' cs-perm-toggle--on' : '');
        const thumb = createDiv();
        thumb.className = 'cs-perm-toggle__thumb';
        toggle.appendChild(thumb);

        toggle.addEventListener('click', () => {
            const newVal = !isOn();
            if (row.axis === 'tools') {
                _persistAgentChange(this, agent, { disabled_tools: applyPermissionSwitch(agent.disabled_tools, row.key, newVal) });
            } else {
                _persistAgentChange(this, agent, { default_permissions: { ...agent.permissions, [row.key]: newVal } });
            }
            toggle.classList.toggle('cs-perm-toggle--on', newVal);
        });

        rowEl.appendChild(labelEl);
        rowEl.appendChild(toggle);
        popover.appendChild(rowEl);
    }

    this._permBtn.appendChild(popover);
    this._permPopover = popover;

    const closeHandler = (e: MouseEvent) => {
        if (!popover.contains(e.target as Node | null) && !this._permBtn.contains(e.target)) {
            popover.remove();
            this._permPopover = null;
            document.removeEventListener('click', closeHandler);
        }
    };
    window.setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

/**
 * Render an inline ask_user question block with clickable options.
 */
export function _renderAskUserBlock(
    this: ChatViewMixinContext,
    toolCall: AskUserToolCall,
    _container: HTMLElement,
): HTMLDivElement {
    let args: Runtime = toolCall.arguments;
    if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
    }
    const question = (args as AskUserArguments).question || 'Agent pyta...';
    const options = (args as AskUserArguments).options || [];
    const context = (args as AskUserArguments).context || '';

    const block = createDiv();
    block.addClass('cs-ask-user');

    // Header
    const head = block.createDiv({ cls: 'cs-ask-user__head' });
    const iconEl = head.createSpan({ cls: 'cs-ask-user__icon' });
    setSvg(iconEl, UiIcons.question(14));
    head.createSpan({ text: t('chat.popover.question'), cls: 'cs-ask-user__label' });

    if (context) {
        block.createDiv({ text: context, cls: 'cs-ask-user__context' });
    }

    block.createDiv({ text: question, cls: 'cs-ask-user__question' });

    // Options
    const optionsWrap = block.createDiv({ cls: 'cs-ask-user__options' });
    let selectedOption: string | null = null;

    for (const opt of options) {
        const optBtn = optionsWrap.createEl('button', { text: opt, cls: 'cs-ask-user__opt' });
        optBtn.addEventListener('click', () => {
            optionsWrap.querySelectorAll<HTMLButtonElement>('.cs-ask-user__opt').forEach(b => b.removeClass('selected'));
            optBtn.addClass('selected');
            selectedOption = opt;
            customInput.value = '';
        });
    }

    // Custom input
    const customRow = block.createDiv({ cls: 'cs-ask-user__custom' });
    const customInput = customRow.createEl('input', {
        type: 'text',
        placeholder: t('chat.custom_answer'),
        cls: 'cs-ask-user__input'
    });
    customInput.addEventListener('input', () => {
        if (customInput.value.trim()) {
            optionsWrap.querySelectorAll<HTMLButtonElement>('.cs-ask-user__opt').forEach(b => b.removeClass('selected'));
            selectedOption = null;
        }
    });

    // Submit
    const submitBtn = block.createEl('button', { text: t('chat.popover.answer'), cls: 'cs-ask-user__submit' });

    // Notify user
    {
        const activeAgent = this.plugin?.agentManager?.getActiveAgent() as AgentLike | undefined;
        const agentColor = SkinManager.getAgentColor(activeAgent || 'default');
        this.plugin.showCrystalNotice(
            t('chat.popover.waiting', { emoji: activeAgent?.emoji || '◆', name: activeAgent?.name || 'Agent' }),
            { type: 'agent', timeout: 6000, agentColor }
        );
    }

    // Promise for AskUserTool to await
    let resolveAnswer: ((answer: string) => void) | undefined;
    this.plugin._askUserPromise = new Promise<string>(resolve => { resolveAnswer = resolve; });
    this.plugin._askUserResolve = resolveAnswer;

    submitBtn.addEventListener('click', () => {
        const answer = customInput.value.trim() || selectedOption || (options.length > 0 ? options[0] : 'OK');
        submitBtn.disabled = true;
        submitBtn.textContent = t('chat.popover.sent');
        customInput.disabled = true;
        optionsWrap.querySelectorAll<HTMLButtonElement>('.cs-ask-user__opt').forEach(b => { b.disabled = true; });
        block.createDiv({ text: t('chat.popover.answer_response', { answer }), cls: 'cs-ask-user__answer' });
        if (this.plugin._askUserResolve) {
            this.plugin._askUserResolve(answer);
        }
    });

    return block;
}
