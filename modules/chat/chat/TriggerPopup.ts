/**
 * TriggerPopup - popup uruchamiany z keypress `/` lub `@` w textarea czatu.
 * Pokazuje 3 sekcje (Skille / Sub-Agenty / MCP servery) filtrowane po
 * tym co user dopisze po triggerze. Wybór wstawia marker
 * (`@@skill:foo`, `@sub-agent:foo`, `@@tool:foo`) do textarea.
 *
 * Discovery flow: user widzi co ma do dyspozycji, klawiatura ↑↓ Enter Esc.
 * Intersection security trzymamy na poziomie wykonania (DelegateTool / SkillExecuteTool),
 * tu jedynie filtrujemy listę po tym co agent ma w whitelist.
 */

import { makeInlineTriggerMarker, type InlineTriggerType } from './InlineChipPlugin.js';
import type { ChatSkillConfig } from './chatViewShape.js';
import type { SubAgentData } from '../../sub-agents/index.js';

/** Tozsamosc agenta w zakresie, jakiego dotyka popup (`@`-wzmianki, etykiety subow). */
interface PopupAgentLike { name?: string }

/** Narzedzie w zakresie, jakiego dotyka sekcja MCP: nazwa serwera pod jednym z czterech pol. */
interface PopupToolLike {
    name?: string;
    description?: string;
    serverName?: string;
    server?: string;
    serverId?: string;
}

/**
 * Plugin w zakresie, jaki czyta popup `/@`. Swiadomie STRUKTURALNY, nie `ChatPlugin`:
 * plik jest node-testowalny, a jego test podstawia wlasne, czesciowe atrapy.
 */
interface PopupPluginLike {
    agentManager?: {
        getActiveAgent?(): PopupAgentLike | null;
        getActiveAgentSkills?(): ChatSkillConfig[];
        subAgentLoader?: { getAllSubAgents?(): SubAgentData[] } | null;
    } | null;
    toolRegistry?: {
        /** `unknown` w parametrze: rejestr czyta agenta WŁASNYM kontraktem widoczności narzędzi. */
        filterByAgent?(agent: unknown): PopupToolLike[];
        getAllTools?(): PopupToolLike[];
    } | null;
}
import { getVisibleSubAgentsForAgent } from '../../sub-agents/index.js';
import { t } from '../../../core/i18n/index.js';

const POPUP_CLASS = 'pkm-trigger-popup';

// TS-any: plugin, agent manager, registry i rekordy skilli/narzędzi są składane runtime z wielu modułów.


type TriggerSection = 'slash' | 'skills' | 'sub-agents' | 'mcp';
type TriggerItemType = InlineTriggerType | 'slash';
export interface TriggerItem {
    type: TriggerItemType;
    name: string;
    label: string;
    description: string;
    section: TriggerSection;
    isSystem?: boolean;
}
interface SlashCommandItem { name: string; description?: string }
interface TriggerPopupOptions {
    onSelect?: ((item: TriggerItem, marker: string) => void) | null;
    slashCommands?: SlashCommandItem[];
}

export class TriggerPopup {
    declare plugin: PopupPluginLike | null | undefined;
    declare agent: PopupAgentLike | null | undefined;
    declare textarea: HTMLTextAreaElement;
    declare onSelect: ((item: TriggerItem, marker: string) => void) | null;
    declare slashCommands: SlashCommandItem[];
    declare triggerChar: string | null;
    declare popupEl: HTMLDivElement | null;
    declare items: TriggerItem[];
    declare filteredItems: TriggerItem[];
    declare selectedIndex: number;
    declare filter: string;
    declare _docMouseHandler: ((event: MouseEvent) => void) | null;

    constructor(plugin: PopupPluginLike | null | undefined, agent: PopupAgentLike | null | undefined, textarea: HTMLTextAreaElement, opts: TriggerPopupOptions = {}) {
        this.plugin = plugin;
        this.agent = agent;
        this.textarea = textarea;
        this.onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;
        this.slashCommands = Array.isArray(opts.slashCommands) ? opts.slashCommands : [];
        this.triggerChar = null;
        this.popupEl = null;
        this.items = [];
        this.filteredItems = [];
        this.selectedIndex = 0;
        this.filter = '';
        this._docMouseHandler = null;
    }

    open(triggerChar: string, anchorEl: HTMLElement = this.textarea): void {
        if (this.popupEl) this.close();
        this.triggerChar = triggerChar || null;
        this.items = this.buildItems();
        this.filter = '';
        this.selectedIndex = this._defaultSelectedIndex(triggerChar);
        this._applyFilter();
        this._renderShell();
        this._renderItems();
        this._position(anchorEl);
        this._attachListeners();
    }

    close(): void {
        this._detachListeners();
        if (this.popupEl) {
            this.popupEl.remove();
            this.popupEl = null;
        }
        this.filteredItems = [];
        this.selectedIndex = 0;
        this.filter = '';
    }

    isOpen(): boolean {
        return this.popupEl !== null;
    }

    setFilter(filter: string): void {
        this.filter = filter || '';
        this.selectedIndex = 0;
        this._applyFilter();
        if (!this.popupEl) return;
        const headerEl = this.popupEl.querySelector(`.${POPUP_CLASS}__header`);
        if (headerEl) headerEl.textContent = this._headerText();
        this._renderItems();
    }

    /**
     * Zwraca true jeśli klawisz został skonsumowany przez popup.
     * Wołane z chat_ui.js przed default behavior textarea.
     */
    handleKeyDown(e: KeyboardEvent): boolean {
        if (!this.popupEl) return false;
        if (e.key === 'Escape') {
            this.close();
            return true;
        }
        if (e.key === 'ArrowDown') {
            this._move(1);
            return true;
        }
        if (e.key === 'ArrowUp') {
            this._move(-1);
            return true;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
            this._commit(this.selectedIndex);
            return true;
        }
        return false;
    }

    /**
     * Public: builduje listę items z aktualnego stanu pluginu.
     * Wystawione żeby test mógł sprawdzić intersection security.
     */
    buildItems(): TriggerItem[] {
        const items: TriggerItem[] = [];
        const agentManager = this.plugin?.agentManager;
        const activeAgent = this.agent || agentManager?.getActiveAgent?.();

        // ── Slash commands (Memory v3: discoverable /save session, /memory, /compress, /clear) ──
        // Only surface for `/` trigger so the `@` flow stays focused on sub-agents.
        if (this.triggerChar !== '@') {
            for (const cmd of this.slashCommands) {
                if (!cmd?.name) continue;
                items.push({
                    type: 'slash',
                    name: cmd.name,
                    label: cmd.name,
                    description: cmd.description || '',
                    section: 'slash',
                    isSystem: true,
                });
            }
        }

        // ── Skille (agent.allowed_skills) ──
        const skills = agentManager?.getActiveAgentSkills?.() || [];
        for (const skill of skills) {
            if (skill?.userInvocable === false) continue;
            items.push({
                type: 'skill',
                name: skill.slug || skill.name,
                label: skill.name || (skill.slug as string),
                description: skill.description || '',
                section: 'skills',
                isSystem: false,
            });
        }

        // ── Sub-agenty: custom suby usera dla aktywnego agenta; brak ról systemowych ──
        const subAgentLoader = agentManager?.subAgentLoader;
        const allSubs = (subAgentLoader?.getAllSubAgents?.() || []);
        for (const sa of getVisibleSubAgentsForAgent(activeAgent, allSubs)) {
            items.push({
                type: 'sub-agent',
                name: sa.name,
                label: sa.name,
                description: sa.description || '',
                section: 'sub-agents',
            });
        }

        // ── MCP servery (agent.allowed_servers przez registry.filterByAgent) ──
        const registry = this.plugin?.toolRegistry;
        const visibleTools = registry?.filterByAgent?.(activeAgent) || registry?.getAllTools?.() || [];
        const seenServers = new Set<string>();
        for (const tool of visibleTools) {
            const serverName = tool?.serverName || tool?.server || tool?.serverId || tool?.name;
            if (!serverName || seenServers.has(serverName)) continue;
            seenServers.add(serverName);
            items.push({
                type: 'tool',
                name: serverName,
                label: serverName,
                description: tool?.description || 'MCP tool',
                section: 'mcp',
                isSystem: false,
            });
        }

        return items;
    }

    // ── Internal ────────────────────────────────────────────────────────

    _defaultSelectedIndex(triggerChar: string): number {
        if (triggerChar === '@') {
            const idx = this.items.findIndex(it => it.section === 'sub-agents');
            return idx >= 0 ? idx : 0;
        }
        return 0;
    }

    _applyFilter(): void {
        const f = (this.filter || '').toLowerCase().trim();
        this.filteredItems = !f
            ? this.items.slice()
            : this.items.filter(it => {
                const hay = `${it.name} ${it.label}`.toLowerCase();
                return hay.includes(f);
            });
        if (this.selectedIndex >= this.filteredItems.length) {
            this.selectedIndex = Math.max(0, this.filteredItems.length - 1);
        }
    }

    _renderShell(): void {
        this.popupEl = createDiv();
        this.popupEl.className = `${POPUP_CLASS} cs-root`;

        const header = createDiv();
        header.className = `${POPUP_CLASS}__header`;
        header.textContent = this._headerText();
        this.popupEl.appendChild(header);

        const itemsContainer = createDiv();
        itemsContainer.className = `${POPUP_CLASS}__items`;
        this.popupEl.appendChild(itemsContainer);

        document.body.appendChild(this.popupEl);
    }

    _renderItems(): void {
        if (!this.popupEl) return;
        const itemsContainer = this.popupEl.querySelector(`.${POPUP_CLASS}__items`);
        if (!itemsContainer) return;
        itemsContainer.empty();

        if (!this.filteredItems.length) {
            const empty = createDiv();
            empty.className = `${POPUP_CLASS}__empty`;
            empty.textContent = t('chat.trigger_popup.no_matches');
            itemsContainer.appendChild(empty);
            return;
        }

        let lastSection: TriggerSection | null = null;
        this.filteredItems.forEach((it, idx) => {
            if (it.section !== lastSection) {
                lastSection = it.section;
                const label = createDiv();
                label.className = `${POPUP_CLASS}__section-label`;
                label.textContent = this._sectionLabel(it.section);
                itemsContainer.appendChild(label);
            }
            const itemEl = createDiv();
            itemEl.className = `${POPUP_CLASS}__item`;
            itemEl.dataset.index = String(idx);
            // Static styling in chat_view.css; the selection highlight uses a class (toggled in _refreshHighlight).
            if (idx === this.selectedIndex) itemEl.classList.add('is-selected');

            const top = createDiv();
            top.className = `${POPUP_CLASS}__item-top`;
            const labelSpan = createSpan();
            labelSpan.textContent = it.label;
            top.appendChild(labelSpan);
            if (it.section === 'sub-agents') {
                const badge = createSpan();
                badge.textContent = '[CUSTOM]';
                badge.title = `Custom sub-agent for ${this.agent?.name || 'active agent'}`;
                badge.className = `${POPUP_CLASS}__badge`;
                top.appendChild(badge);
            }
            itemEl.appendChild(top);

            if (it.description) {
                const desc = createDiv();
                desc.className = `${POPUP_CLASS}__desc`;
                desc.textContent = it.description.length > 80 ? it.description.slice(0, 80) + '…' : it.description;
                itemEl.appendChild(desc);
            }

            itemEl.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this._commit(idx);
            });
            itemEl.addEventListener('mouseenter', () => {
                this.selectedIndex = idx;
                this._refreshHighlight();
            });

            itemsContainer.appendChild(itemEl);
        });
    }

    _refreshHighlight(): void {
        if (!this.popupEl) return;
        const items = this.popupEl.querySelectorAll<HTMLElement>(`.${POPUP_CLASS}__item`);
        items.forEach((el) => {
            const idx = Number(el.dataset.index);
            el.classList.toggle('is-selected', idx === this.selectedIndex);
        });
        const current = items[this.selectedIndex];
        if (current) current.scrollIntoView({ block: 'nearest' });
    }

    _move(delta: number): void {
        if (!this.filteredItems.length) return;
        this.selectedIndex = (this.selectedIndex + delta + this.filteredItems.length) % this.filteredItems.length;
        this._refreshHighlight();
    }

    _commit(idx: number): void {
        const item = this.filteredItems[idx];
        if (!item) {
            this.close();
            return;
        }
        // Slash commands insert literal "/cmd " text — user presses Enter to run, so they keep
        // full control (and can edit/cancel before submission). Skille/sub-agenty/MCP use markers.
        const marker = item.type === 'slash'
            ? `${item.name} `
            : makeInlineTriggerMarker(item.type, item.name);
        if (this.onSelect) {
            try { this.onSelect(item, marker); } catch { /* swallow callback errors */ }
        }
        this.close();
    }

    _position(anchorEl: HTMLElement): void {
        if (!this.popupEl || !anchorEl) return;
        const rect = anchorEl.getBoundingClientRect();
        const popupHeight = this.popupEl.offsetHeight || 200;
        const top = rect.top - popupHeight - 4;
        this.popupEl.style.top = `${top < 8 ? rect.bottom + 4 : top}px`;
        this.popupEl.style.left = `${rect.left}px`;
    }

    _attachListeners(): void {
        this._docMouseHandler = (e: MouseEvent) => {
            if (!this.popupEl) return;
            if (this.popupEl.contains(e.target as Node | null)) return;
            if (e.target === this.textarea) return;
            this.close();
        };
        document.addEventListener('mousedown', this._docMouseHandler);
    }

    _detachListeners(): void {
        if (this._docMouseHandler) {
            document.removeEventListener('mousedown', this._docMouseHandler);
            this._docMouseHandler = null;
        }
    }

    _sectionLabel(section: TriggerSection): string {
        if (section === 'slash') return 'Slash commands';
        if (section === 'skills') return 'Skille';
        if (section === 'sub-agents') return 'Sub-agenty';
        if (section === 'mcp') return 'MCP servery';
        return section;
    }

    _headerText(): string {
        return this.filter
            ? `Filtr: ${this.filter}`
            : 'Wpisuj aby filtrować • ↑↓ Enter Esc';
    }
}
