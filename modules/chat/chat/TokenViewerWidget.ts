import { Modal, Notice, type App } from 'obsidian';
import { t } from '../../../core/i18n/index.js';
import { UiIcons, setSvg } from '../../crystal-soul/index.js';
import { estimateContextWindow, formatTokenCount, getContextLevel } from './TokenViewerUtils.js';
import { log } from '../../../core/utils/Logger.js';
import type { ChatViewLike } from './chatViewShape.js';
import type { ModelLibraryEntry } from '../../models/index.js';

/** Wpis modelu: skrót `platforma/model` albo rozbity obiekt — oba kształty leżą w ustawieniach. */
type ConfiguredModel = string | { platform?: string; model?: string };

type CompressionPreset = 'delicate' | 'medium' | 'aggressive';
type TokenUsage = { input?: number; output?: number };
type BreakdownItem = { role: string; tokens: number; preview: string };
type TokenBreakdown = {
    total?: number;
    max?: number;
    layer1?: Record<string, number>;
    layer2?: Record<string, number>;
    buffer?: Record<string, number>;
    cache?: { cached_tokens?: number; savings_pct?: number } | null;
    items?: { messages?: BreakdownItem[] };
};
type RoleData = {
    used: number;
    max: number;
    breakdown: TokenBreakdown | null;
    session?: TokenUsage;
};
type ConfirmOptions = { bodyKey: string; onConfirm: () => Promise<void> | void };

class ConfirmCompressionModal extends Modal {
    declare bodyKey: string;
    declare onConfirm: () => Promise<void> | void;

    constructor(app: App, { bodyKey, onConfirm }: ConfirmOptions) {
        super(app);
        this.bodyKey = bodyKey || 'chat.token_viewer.confirm_body';
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: t('chat.token_viewer.confirm_title') });
        contentEl.createEl('p', {
            text: t(this.bodyKey),
        });
        const row = contentEl.createDiv({ cls: 'token-viewer-confirm-row' });
        const cancel = row.createEl('button', { text: t('chat.cancel') });
        cancel.addEventListener('click', () => this.close());
        const confirm = row.createEl('button', { cls: 'mod-cta', text: t('chat.token_viewer.confirm_action') });
        confirm.addEventListener('click', () => {
            this.close();
            void this.onConfirm?.();
        });
    }
}

export class TokenViewerWidget {
    declare view: ChatViewLike;
    declare parent: HTMLElement;
    declare selectedRole: string;
    declare autoUpdate: boolean;
    declare compactView: boolean;
    declare settingsOpen: boolean;
    declare expanded: Set<string>;
    declare button: HTMLButtonElement | null;
    declare refreshButton: HTMLButtonElement | null;
    declare popover: HTMLDivElement | null;
    declare closeHandler: ((event: MouseEvent) => void) | null;

    constructor(view: ChatViewLike, parent: HTMLElement) {
        this.view = view;
        this.parent = parent;
        // Legacy role names may linger in the per-view state from before the rename.
        const LEGACY_ROLES: Record<string, string> = { minion: 'researcher', master: 'researcher', strategist: 'researcher' };
        const storedRole: string = view._tokenViewerRole || 'main';
        this.selectedRole = LEGACY_ROLES[storedRole] || storedRole;
        this.autoUpdate = view._tokenViewerAutoUpdate !== false;
        this.compactView = !!view._tokenViewerCompactView;
        this.settingsOpen = false;
        this.expanded = new Set(['layer1', 'layer2']);
        this.render();
    }

    render(): void {
        this.parent.empty();
        this.parent.addClass('cs-token-viewer');
        this.parent.createDiv({ cls: 'cs-skillbar__label', text: t('chat.token_viewer.context_label') });
        this.button = this.parent.createEl('button', {
            cls: 'cs-token-viewer__button',
            attr: { 'aria-label': t('chat.token_viewer.aria_label') },
        });
        setSvg(this.button, `<svg viewBox="0 0 44 44" class="cs-token-viewer__donut">
            <circle cx="22" cy="22" r="17" class="cs-token-viewer__bg"></circle>
            <circle cx="22" cy="22" r="17" class="cs-token-viewer__fg" pathLength="100"></circle>
            <text x="22" y="25" class="cs-token-viewer__pct">0%</text>
        </svg>`);
        this.button.createSpan({ cls: 'cs-token-viewer__amount', text: '0/0' });
        this.button.addEventListener('click', (event) => {
            event.stopPropagation();
            this.togglePopover();
        });
        this.refreshButton = this.parent.createEl('button', {
            cls: 'cs-token-viewer__refresh',
            text: t('chat.token_viewer.settings.refresh'),
        });
        this.refreshButton.addEventListener('click', (event) => {
            event.stopPropagation();
            this.update(true);
        });
        this.update(true);
    }

    update(force = false): void {
        if (!this.button) return;
        if (!force && !this.autoUpdate) {
            this.showRefreshButton();
            return;
        }
        this.hideRefreshButton();
        const data = this.getRoleData(this.selectedRole);
        const percent = data.max > 0 ? Math.min(100, Math.round((data.used / data.max) * 100)) : 0;
        const level = getContextLevel(percent);
        this.button.dataset.level = level;
        const fg = this.button.querySelector('.cs-token-viewer__fg');
        const pct = this.button.querySelector('.cs-token-viewer__pct');
        const amount = this.button.querySelector('.cs-token-viewer__amount');
        if (fg) fg.setAttribute('stroke-dasharray', `${percent} ${100 - percent}`);
        if (pct) pct.textContent = `${percent}%`;
        // main = okno kontekstu (estymata); researcher/strategist = realne usage z API,
        // ale gdy dane suba przyszły z fallbacku (brak usage) → też oznacz jako przybliżone.
        const isEstimate = this.selectedRole === 'main' || !!this.view.tokenTracker?.hasEstimates?.(this.selectedRole);
        if (amount) amount.textContent = `${isEstimate ? '~' : ''}${formatTokenCount(data.used)}/${formatTokenCount(data.max)}`;
        this.button.title = isEstimate ? t('chat.token_viewer.approx_tooltip') : '';
        // Popover dostaje JUŻ POLICZONE `data`, nie liczy rozbicia okna kontekstu drugi raz -
        // `update()` leci po każdym zdarzeniu usage w turze, czyli kilkanaście razy, dokładnie
        // wtedy, gdy user patrzy na licznik (bo po to go otworzył).
        if (this.popover?.isConnected) this.renderPopover(data);
        if (!this.autoUpdate) this.showRefreshButton();
    }

    showRefreshButton(): void {
        if (this.refreshButton) this.refreshButton.addClass('is-visible');
    }

    hideRefreshButton(): void {
        if (this.refreshButton) this.refreshButton.removeClass('is-visible');
    }

    getRoleData(role: string): RoleData {
        if (role === 'main') {
            const breakdown = this.view.rollingWindow?.getBreakdown?.() || { total: 0, max: 0 };
            return { used: breakdown.total || 0, max: breakdown.max || this.view.rollingWindow?.maxTokens || 0, breakdown };
        }
        const totals = this.view.tokenTracker?.getSessionTotal?.()?.byRole?.[role] || { input: 0, output: 0 };
        const max = this.resolveRoleMax(role);
        return {
            used: (totals.input || 0) + (totals.output || 0),
            max,
            breakdown: null,
            session: totals,
        };
    }

    resolveRoleMax(role: string): number {
        const agent = this.view.plugin?.agentManager?.getActiveAgent?.();
        const pkm = this.view.env?.settings?.pkmAssistant || {};
        // Settings' model library may still hold roles under legacy keys (minion/master) -
        // modelResolver accepts both for one more release. `Agent._normalizeModelOverrides`
        // migrates `models.minion`/`models.master` into `researcher`/`strategist` and DELETES
        // the legacy keys on every construction/update, so `agent.models[legacyKey]` can never
        // be set; only the library-side fallback (`pkm.modelLibrary`) still needs the legacy
        // lookup below.
        const legacyKey = ({ researcher: 'minion', strategist: 'master' } as Record<string, string>)[role];
        const lib = pkm?.modelLibrary?.[role] || (legacyKey ? pkm?.modelLibrary?.[legacyKey] : null);
        const configured = (agent?.models?.[role]
            || lib?.find?.((m: ModelLibraryEntry) => m.isDefault) || lib?.[0] || null) as ConfiguredModel | null;
        // `typeof null === 'object'`, więc gałąź obiektowa łapie też pusty wpis — to ZASTANE
        // zachowanie, typ tylko je opisuje (naprawa = zmiana runtime, poza tą falą).
        const platform = typeof configured === 'object' ? (configured as { platform?: string }).platform : '';
        const model = typeof configured === 'object' ? (configured as { model?: string }).model : String(configured || '');
        return estimateContextWindow({ role, platform, model });
    }

    togglePopover(): void {
        if (this.popover?.isConnected) {
            this.closePopover();
            return;
        }
        this.renderPopover();
    }

    closePopover(): void {
        this.popover?.remove();
        this.popover = null;
        if (this.closeHandler) {
            document.removeEventListener('click', this.closeHandler);
            this.closeHandler = null;
        }
    }

    /**
     * @param roleData - gotowe rozbicie od wołacza (`update()` już je policzył).
     *   Wołacze spoza `update()` (otwarcie popovera, przełączniki ustawień) go nie mają i wtedy
     *   liczymy jak dotąd — ale to zdarzenia pojedyncze, nie kilkanaście na turę.
     */
    renderPopover(roleData?: RoleData): void {
        const host = this.view._chatBody || this.view.container;
        if (!host) return;
        if (!this.popover?.isConnected) {
            this.popover = createDiv();
            this.popover.className = 'cs-token-popover';
            host.appendChild(this.popover);
            this.closeHandler = (event: MouseEvent) => {
                if (!this.popover?.contains(event.target as Node | null) && !this.button?.contains(event.target as Node | null)) this.closePopover();
            };
            window.setTimeout(() => document.addEventListener('click', this.closeHandler as EventListener), 0);
        }

        const data = roleData || this.getRoleData(this.selectedRole);
        const percent = data.max > 0 ? Math.min(100, Math.round((data.used / data.max) * 100)) : 0;
        this.popover.empty();
        this.popover.classList.toggle('cs-token-popover--compact', this.compactView);

        const header = this.popover.createDiv({ cls: 'cs-token-popover__header' });
        header.createDiv({ cls: 'cs-token-popover__title', text: t('chat.token_viewer.title') });
        const select = header.createEl('select', { cls: 'cs-token-popover__select' });
        for (const role of ['main', 'researcher']) {
            const option = select.createEl('option', { value: role, text: t(`chat.token_viewer.role.${role}`) });
            option.selected = role === this.selectedRole;
        }
        select.addEventListener('change', () => {
            this.selectedRole = select.value;
            this.view._tokenViewerRole = this.selectedRole;
            this.update(true);
        });

        // main = szacunek okna kontekstu → oznacz jako przybliżony; role = realne usage
        // (albo fallback → hasEstimates).
        const meterIsEstimate = this.selectedRole === 'main' || !!this.view.tokenTracker?.hasEstimates?.(this.selectedRole);
        const meter = this.popover.createDiv({
            cls: `cs-token-popover__meter cs-token-popover__meter--${getContextLevel(percent)}`,
            text: `${meterIsEstimate ? '~' : ''}${formatTokenCount(data.used)} / ${formatTokenCount(data.max)} (${percent}%)`,
        });
        if (meterIsEstimate) {
            meter.title = t('chat.token_viewer.approx_tooltip');
            meter.createSpan({ cls: 'cs-token-popover__approx', text: ` ${t('chat.token_viewer.approx_label')}` });
        }

        if (this.selectedRole === 'main') {
            this.renderMainBreakdown(data.breakdown);
        } else {
            this.renderRoleSession(data.session);
        }

        const footer = this.popover.createDiv({ cls: 'cs-token-popover__footer' });
        const presets = footer.createDiv({ cls: 'cs-token-popover__presets' });
        for (const preset of ['delicate', 'medium', 'aggressive'] as CompressionPreset[]) {
            const button = presets.createEl('button', {
                cls: `cs-token-popover__preset cs-token-popover__preset--${preset}`,
                text: t(`chat.token_viewer.preset.${preset}`),
            });
            button.addEventListener('click', () => this.confirmCompression(preset));
        }
        const settings = footer.createEl('button', {
            cls: 'cs-token-popover__icon-btn',
            attr: { 'aria-label': t('chat.token_viewer.settings.title') },
        });
        setSvg(settings, UiIcons.settings(14));
        settings.addEventListener('click', (event) => {
            event.stopPropagation();
            this.settingsOpen = !this.settingsOpen;
            this.renderPopover();
        });
        this.renderSettingsPanel();
    }

    renderMainBreakdown(breakdown: TokenBreakdown | null): void {
        if (!breakdown) return;
        // Sekcja „Odroczone" (layer3) usunięta — mcp_tools_deferred/system_tools_deferred
        // były zawsze 0. Zostają tylko realnie zasilane warstwy + bufor.
        this.renderGroup('layer1', t('chat.token_viewer.layer1'), breakdown.layer1, breakdown.items?.messages || []);
        this.renderGroup('layer2', t('chat.token_viewer.layer2'), breakdown.layer2);
        this.renderGroup('buffer', t('chat.token_viewer.buffer'), breakdown.buffer, [], t('chat.token_viewer.buffer_estimate_note'));
        // Cache nie wchodzi do licznika okna (to wymiar kosztu) — mówimy to wprost.
        if ((breakdown.cache?.cached_tokens as number) > 0) {
            this.popover!.createDiv({
                cls: 'cs-token-popover__row cs-token-popover__row--note',
                text: t('chat.token_viewer.cache_note', {
                    tokens: formatTokenCount(breakdown.cache!.cached_tokens),
                    pct: breakdown.cache!.savings_pct || 0,
                }),
            });
        }
    }

    renderRoleSession(session: TokenUsage = {}): void {
        const list = this.popover!.createDiv({ cls: 'cs-token-popover__group is-open' });
        list.createDiv({ cls: 'cs-token-popover__group-head', text: t('chat.token_viewer.session_usage') });
        list.createDiv({ cls: 'cs-token-popover__row', text: t('chat.token_viewer.input', { tokens: formatTokenCount(session.input || 0) }) });
        list.createDiv({ cls: 'cs-token-popover__row', text: t('chat.token_viewer.output', { tokens: formatTokenCount(session.output || 0) }) });
    }

    renderGroup(id: string, label: string, values: Record<string, number> = {}, details: BreakdownItem[] = [], note = ''): void {
        const total = Object.values(values).reduce((sum, value) => sum + (Number(value) || 0), 0);
        const group = this.popover!.createDiv({ cls: `cs-token-popover__group ${this.expanded.has(id) ? 'is-open' : ''}` });
        const head = group.createDiv({ cls: 'cs-token-popover__group-head' });
        head.createSpan({ text: label });
        head.createSpan({ text: formatTokenCount(total) });
        head.addEventListener('click', () => {
            if (this.expanded.has(id)) this.expanded.delete(id);
            else this.expanded.add(id);
            this.renderPopover();
        });
        // Nota siedzi POZA group-body — widoczna też przy zwiniętej grupie (bufor jest zwinięty domyślnie).
        if (note) group.createDiv({ cls: 'cs-token-popover__row cs-token-popover__row--note', text: note });
        const body = group.createDiv({ cls: 'cs-token-popover__group-body' });
        for (const [key, value] of Object.entries(values)) {
            body.createDiv({ cls: 'cs-token-popover__row', text: `${this.rowLabel(key)} ${formatTokenCount(value)}` });
        }
        if (details.length > 0) {
            const top = details.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 8);
            for (const item of top) {
                body.createDiv({ cls: 'cs-token-popover__row cs-token-popover__row--detail', text: `${item.role}: ${formatTokenCount(item.tokens)} ${item.preview}` });
            }
        }
    }

    /**
     * Etykieta wiersza podrzędnego. Klucz techniczny (`mcp_tools_active`) → tłumaczenie,
     * a gdy tłumaczenia nie ma — dotychczasowe zachowanie (`mcp tools active`).
     * @param {string} key
     * @returns {string}
     */
    rowLabel(key: string): string {
        const i18nKey = `chat.token_viewer.row.${key}`;
        const label = t(i18nKey);
        return label === i18nKey ? key.replaceAll('_', ' ') : label;
    }

    renderSettingsPanel(): void {
        if (!this.settingsOpen) return;
        const panel = this.popover!.createDiv({ cls: 'cs-token-popover__settings' });
        this.renderToggle(panel, 'autoUpdate', t('chat.token_viewer.settings.auto_update'), this.autoUpdate, (checked) => {
            this.autoUpdate = checked;
            this.view._tokenViewerAutoUpdate = checked;
            if (checked) this.update(true);
            else this.showRefreshButton();
        });
        this.renderToggle(panel, 'compactView', t('chat.token_viewer.settings.compact_view'), this.compactView, (checked) => {
            this.compactView = checked;
            this.view._tokenViewerCompactView = checked;
            this.popover?.classList.toggle('cs-token-popover--compact', checked);
        });
    }

    renderToggle(parent: HTMLElement, id: string, label: string, checked: boolean, onChange: (checked: boolean) => void): void {
        const row = parent.createEl('label', { cls: 'cs-token-popover__toggle' });
        const input = row.createEl('input', { attr: { type: 'checkbox', id: `cs-token-${id}` } });
        input.checked = checked;
        input.addEventListener('change', () => onChange(input.checked));
        row.createSpan({ text: label });
    }

    confirmCompression(preset: CompressionPreset = 'medium'): void {
        const bodyKeys: Record<CompressionPreset, string> = {
            delicate: 'chat.token_viewer.confirm_body_delicate',
            medium: 'chat.token_viewer.confirm_body_medium',
            aggressive: 'chat.token_viewer.confirm_body_aggressive',
        };
        new ConfirmCompressionModal(this.view.app, {
            bodyKey: bodyKeys[preset] || bodyKeys.medium,
            onConfirm: async () => {
                try {
                    await this.runCompressionPreset(preset);
                    this.view.updateTokenCounter?.();
                    this.update(true);
                    new Notice(t('chat.token_viewer.compression_done'));
                } catch (error) {
                    new Notice(t('chat.token_viewer.compression_failed'));
                    log.error('TokenViewer', 'compression failed:', error);
                }
            },
        }).open();
    }

    async runCompressionPreset(preset: CompressionPreset): Promise<unknown> {
        if (preset === 'delicate') {
            return this.view.rollingWindow.trimOldToolResults(10);
        }
        return this.view.rollingWindow.performTwoPhaseCompression(preset === 'aggressive');
    }
}
