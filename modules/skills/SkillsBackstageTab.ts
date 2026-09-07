/**
 * Zaplecze → zakładka „Szablony skilli" (S27 Z2).
 *
 * Zaplecze to KATALOG ZASOBÓW usera, nie zarządzanie żywymi bytami (D4). Ta zakładka
 * pokazuje wyłącznie SZABLONY z `.pkm-assistant/templates/skills/` — formy odlewnicze.
 * Żywe skille (przypisane agentom) żyją w profilu agenta → Umiejętności.
 *
 * Karta: nazwa · kategoria · opis · `vN`. BEZ „Used by" — szablon nie jest używany, jest
 * kopiowany (D3). Akcje: „+ nowy szablon" · edycja (bump vN) · „Użyj u agenta…" · usuń.
 */
import {
    IconGenerator,
    hexToRgbTriplet,
    getCategoryColor,
    setSvgLabel,
    UiIcons,
} from '../crystal-soul/index.js';
import { SkillEditorModal } from './SkillEditorModal.js';
import {
    renderFilterBar,
    getCategoryLabel,
    renderUseAtAgentButton,
    renderTemplateVersionBadge,
    renderCardAction,
    confirmModal,
} from '../ui-components/index.js';
import { t } from '../../core/i18n/index.js';
// TS-any: Obsidian UI and plugin services expose dynamic runtime contracts.
type UiBoundary = any;

export function renderSkillsTab(content: UiBoundary, plugin: UiBoundary, nav: UiBoundary) {
    const store = plugin.agentManager?.skillTemplateStore;
    const templates = store?.list() || [];
    const agents = plugin.agentManager?.getAllAgents() || [];

    content.createEl('p', { text: t('backstage.skill_templates_intro'), cls: 'cs-backstage-intro' });

    const createBtn = content.createEl('button', { cls: 'cs-create-btn' });
    setSvgLabel(createBtn, UiIcons.plus(11), t('backstage.new_skill_template'));
    createBtn.addEventListener('click', () => {
        new SkillEditorModal(plugin.app, plugin, null, () => nav.refresh(), { template: true }).open();
    });

    if (templates.length === 0) {
        content.createEl('p', { text: t('backstage.no_skill_templates'), cls: 'sidebar-empty-text' });
        return;
    }

    const searchInput = content.createEl('input', {
        type: 'text', placeholder: t('backstage.search_skill_template'), cls: 'cs-search-input'
    });

    const activeFilters = new Set<string>();
    const categories = [...new Set(templates.map((s: UiBoundary) => s.category).filter(Boolean))];
    const filterDefs = categories.map(c => ({
        value: `cat:${c as string}`, label: getCategoryLabel(c as string), iconFn: (s: number) => UiIcons.folder(s),
    }));

    const filterContainer = content.createDiv();
    const list = content.createDiv({ cls: 'cs-item-list' });

    const renderFilters = () => {
        filterContainer.empty();
        if (filterDefs.length > 0) {
            renderFilterBar(filterContainer, filterDefs, activeFilters, (val: string) => {
                if (activeFilters.has(val)) activeFilters.delete(val);
                else activeFilters.add(val);
                renderFilters();
                renderList(searchInput.value.toLowerCase());
            });
        }
    };

    const renderList = (filter = '') => {
        list.empty();
        let filtered = templates;

        if (filter) {
            filtered = filtered.filter((s: UiBoundary) =>
                s.name.toLowerCase().includes(filter) || s.description?.toLowerCase().includes(filter)
            );
        }
        for (const f of activeFilters) {
            if (f.startsWith('cat:')) {
                const cat = f.slice(4);
                filtered = filtered.filter((s: UiBoundary) => s.category === cat);
            }
        }

        for (const tpl of filtered) {
            renderTemplateCard(list, tpl, { plugin, nav, store, agents });
        }
    };

    renderFilters();
    searchInput.addEventListener('input', (e: Event) => renderList((e.target as HTMLInputElement).value.toLowerCase()));
    renderList();
}

function renderTemplateCard(list: UiBoundary, tpl: UiBoundary, { plugin, nav, store, agents }: { plugin: UiBoundary; nav: UiBoundary; store: UiBoundary; agents: UiBoundary }) {
    const category = tpl.category || 'general';
    const catColor = getCategoryColor(category);

    const card = list.createDiv({ cls: 'cs-item-card cs-item-card--categorized' });
    card.style.setProperty('--cs-category-color-rgb', hexToRgbTriplet(catColor));

    const nameDiv = card.createDiv({ cls: 'cs-item-card__name' });
    setSvgLabel(nameDiv, IconGenerator.generate(tpl.name, 'arcane', { size: 13, color: catColor }), tpl.name);

    const meta = card.createDiv({ cls: 'cs-item-card__meta' });
    const badge = meta.createSpan({ cls: 'cs-item-card__badge cs-item-card__badge--category' });
    badge.empty();
    const catDot = badge.createSpan({ cls: 'cs-category-dot cs-dyn-bg' });
    catDot.style.setProperty('--cs-dyn-bg', catColor);
    badge.appendText(' ' + getCategoryLabel(category));
    renderTemplateVersionBadge(meta, tpl.version);

    if (tpl.description) {
        card.createDiv({ cls: 'cs-item-card__desc', text: tpl.description });
    }

    // ── Akcje: „Użyj u agenta…" + edycja + usuń ──
    const actions = card.createDiv({ cls: 'cs-item-card__actions' });
    renderUseAtAgentButton(actions, agents, (agentName: string) => {
        void useTemplateAtAgent(tpl, agentName, { plugin, store, nav });
    });
    renderCardAction(actions, {
        iconFn: UiIcons.edit,
        label: t('generic.edit'),
        onClick: () => {
            new SkillEditorModal(plugin.app, plugin, tpl, () => nav.refresh(), { template: true }).open();
        },
    });
    renderCardAction(actions, {
        iconFn: UiIcons.trash,
        label: t('generic.delete'),
        danger: true,
        onClick: async () => {
            const okToDelete = await confirmModal(plugin.app, {
                title: t('generic.delete'),
                message: t('backstage.confirm_delete_template', { name: tpl.name }),
                destructive: true,
            });
            if (!okToDelete) return;
            await store.delete(tpl.slug);
            nav.refresh();
        },
    });

    card.addEventListener('click', () => {
        nav.push('skill-detail', { skillName: tpl.slug, template: true }, t('sidebar.backstage'));
    });
}

/**
 * „Użyj u agenta…" — odlej kopię szablonu (D3) i dopisz ją do `skills[]` agenta.
 * Zapis profilu agenta idzie przez AgentManager (jedyny owner), żeby YAML nie rozjechał się z cache.
 */
async function useTemplateAtAgent(tpl: UiBoundary, agentName: string, { plugin, store, nav }: { plugin: UiBoundary; store: UiBoundary; nav: UiBoundary }) {
    const { Notice } = await import('obsidian');
    const agentManager = plugin.agentManager;
    const agent = agentManager?.getAgent?.(agentName);
    if (!agent) {
        new Notice(t('backstage.template_use_failed', { error: agentName }));
        return;
    }

    const result = await store.instantiate(tpl.slug, { skillLoader: agentManager.skillLoader });
    if (!result?.success) {
        new Notice(t('backstage.template_use_failed', { error: result?.error || '?' }));
        return;
    }
    if (result.renamed) {
        new Notice(t('backstage.template_slug_taken', { name: result.name }));
    }

    const skills = Array.isArray(agent.skills) ? [...agent.skills] : [];
    if (!skills.some((s: UiBoundary) => (typeof s === 'string' ? s : s?.name) === result.slug)) {
        skills.push(result.slug);
        await agentManager.updateAgent(agentName, { skills });
    }

    new Notice(t('backstage.template_used', { name: result.name, agent: agentName }));
    nav.refresh();
}
