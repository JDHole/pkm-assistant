/**
 * AgentPresentationModal - read-only "wizytówka" agenta.
 * Otwierany z HomeView po kliknięciu w kartę agenta.
 * Zawiera hero (kryształ + dane), statystyki, przycisk "Edytuj profil".
 */
import { Modal } from 'obsidian';
import type { App } from 'obsidian';
import { SkinManager, UiIcons, setSvg, setSvgLabel } from '../../modules/crystal-soul/index.js';
import { getColorByHex } from '../../modules/crystal-soul/index.js';
import { hexToRgbTriplet } from '../../modules/crystal-soul/index.js';
import { resolveMainModelForForm } from '../../modules/agents/index.js';
import type { AgentManager } from '../../modules/agents/index.js';
import { t } from '../../core/i18n/index.js';
import type { PluginApi } from '../../core/index.js';

/** Plugin widziany przez ten modal: tylko `agentManager` ponad bazowy `PluginApi`. */
interface AgentPresentationModalPlugin extends PluginApi {
    agentManager?: AgentManager;
}

/** Callbacki nawigacji z modala - wołacz (HomeView) przekazuje TYLKO te dwa. */
interface AgentPresentationCallbacks {
    onEditNavigate?: () => void;
    onChatNavigate?: () => void;
}

export class AgentPresentationModal extends Modal {
    declare private plugin: AgentPresentationModalPlugin;
    declare private agentName: string;
    declare private onEditNavigate: (() => void) | undefined;
    declare private onChatNavigate: (() => void) | undefined;

    constructor(app: App, plugin: AgentPresentationModalPlugin, agentName: string, { onEditNavigate, onChatNavigate }: AgentPresentationCallbacks = {}) {
        super(app);
        this.plugin = plugin;
        this.agentName = agentName;
        this.onEditNavigate = onEditNavigate;
        this.onChatNavigate = onChatNavigate;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('cs-root', 'cs-agent-presentation-modal');

        const agent = this.plugin.agentManager?.getAgent(this.agentName);
        if (!agent) {
            contentEl.createEl('p', { text: t('modal.agent_presentation.not_found') });
            return;
        }

        const agentColor = SkinManager.getAgentColor(agent);
        const rgb = hexToRgbTriplet(agentColor);
        contentEl.style.setProperty('--cs-agent-color-rgb', rgb);

        // ── Hero section ──
        const hero = contentEl.createDiv({ cls: 'cs-profile-hero' });
        const heroInfo = hero.createDiv({ cls: 'cs-profile-hero__info' });

        // Name
        heroInfo.createEl('h2', { text: agent.name, cls: 'cs-profile-hero__name' });

        // Description (read-only)
        if (agent.description) {
            heroInfo.createDiv({ cls: 'cs-profile-hero__desc', text: agent.description });
        }

        // Meta: dates
        const heroMeta = heroInfo.createDiv({ cls: 'cs-profile-hero__meta' });
        if (agent.createdAt) {
            heroMeta.createSpan({
                text: new Date(agent.createdAt).toLocaleDateString('pl-PL'),
                cls: 'cs-profile-hero__date'
            });
        }

        // Color swatch (read-only)
        const colorRow = heroInfo.createDiv({ cls: 'cs-profile-hero__color-row' });
        const colorDot = colorRow.createDiv({ cls: 'cs-profile-hero__color-dot cs-profile-hero__color-dot--readonly' });
        colorDot.style.background = agentColor;
        const colorMatch = getColorByHex(agentColor);
        colorRow.createSpan({ text: colorMatch?.name || agentColor, cls: 'cs-profile-hero__color-hex' });

        // Crystal (80px, animated)
        const crystalBox = hero.createDiv({ cls: 'cs-profile__crystal' });
        setSvg(crystalBox, SkinManager.getCrystal(agent, { size: 80, color: agentColor, glow: true }));

        // ── Stats grid (async) ──
        let stats: Awaited<ReturnType<AgentManager['getAgentStats']>> | undefined = null;
        try { stats = await this.plugin.agentManager?.getAgentStats?.(agent.name); } catch { /* ignore */ }

        const statsGrid = contentEl.createDiv({ cls: 'cs-shards' });
        for (const stat of [
            { label: t('profile.overview.sessions'), value: stats?.sessionCount ?? 0 },
            { label: t('profile.overview.skills'), value: agent.skills?.length ?? 0 },
            { label: t('modal.agent_presentation.sub_agents'), value: agent.activeSubAgents?.length ?? 0 },
        ]) {
            const filled = stat.value > 0;
            const shard = statsGrid.createDiv({ cls: `cs-shard ${filled ? 'cs-shard--filled' : 'cs-shard--empty'}` });
            shard.createDiv({ cls: 'cs-shard__value', text: String(stat.value) });
            shard.createDiv({ cls: 'cs-shard__main-label', text: stat.label });
        }

        // ── Info grid ──
        const infoGrid = contentEl.createDiv({ cls: 'cs-shards' });
        const globalLabel = t('profile.overview.global');
        // Kanon to agent.models.main - legacy agent.model gaśnie po pierwszym zapisie
        // profilu (modelFieldSync.ts). Czytanie samego agent.model tu pokazywałoby „globalny"
        // dla KAŻDEGO agenta ze zmigrowanym modelem, mimo że ma jawnie ustawiony.
        const mainModel = resolveMainModelForForm({ model: agent.model, models: agent.models }).selectValue;
        for (const info of [
            { label: t('profile.overview.model'), value: mainModel || globalLabel },
            { label: 'L1', value: String(stats?.l1Count ?? 0) },
            { label: 'L2', value: String(stats?.l2Count ?? 0) },
            { label: 'Brain', value: stats?.brainSize ?? '0' },
        ]) {
            const filled = info.value !== '0' && info.value !== globalLabel;
            const shard = infoGrid.createDiv({ cls: `cs-shard ${filled ? 'cs-shard--filled' : 'cs-shard--empty'}` });
            // TS-boundary: `Brain` (stats.brainSize) jest liczbą, reszta stringiem (`info.value:
            // string | number`) - DOM (createDiv → textContent) i tak konwertuje niejawnie; brak
            // String() w oryginale. Jeden `as` (nie `as unknown as`) - zawężenie unii do jednego
            // członu jest zawsze bezpośrednio dozwolone.
            shard.createDiv({ cls: 'cs-shard__value', text: info.value as string });
            shard.createDiv({ cls: 'cs-shard__main-label', text: info.label });
        }

        // ── Footer: "Czat" + "Edytuj profil" buttons ──
        const footer = contentEl.createDiv({ cls: 'cs-presentation-footer' });

        const chatBtn = footer.createEl('button', { cls: 'cs-presentation-chat-btn' });
        setSvgLabel(chatBtn, UiIcons.chat(14), t('modal.agent_presentation.chat_btn'));
        chatBtn.addEventListener('click', () => {
            this.close();
            if (this.onChatNavigate) this.onChatNavigate();
        });

        const editBtn = footer.createEl('button', { cls: 'cs-presentation-edit-btn' });
        setSvgLabel(editBtn, UiIcons.edit(14), t('modal.agent_presentation.edit_profile_btn'));
        editBtn.addEventListener('click', () => {
            this.close();
            if (this.onEditNavigate) this.onEditNavigate();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Helper: open the presentation modal.
 * @param {Object} plugin
 * @param {string} agentName
 * @param {Object} callbacks - { onEditNavigate, onChatNavigate }
 */
export function openAgentPresentationModal(plugin: AgentPresentationModalPlugin, agentName: string, callbacks: AgentPresentationCallbacks): void {
    new AgentPresentationModal(plugin.app as unknown as App, plugin, agentName, callbacks).open();
}
