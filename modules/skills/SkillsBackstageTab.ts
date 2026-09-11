/**
 * Zaplecze → zakładka „Szablony skilli".
 *
 * Zaplecze to KATALOG ZASOBÓW usera, nie zarządzanie żywymi bytami. Ta zakładka
 * pokazuje wyłącznie SZABLONY z `.pkm-assistant/templates/skills/` — formy odlewnicze.
 * Żywe skille (przypisane agentom) żyją w profilu agenta → Umiejętności.
 *
 * Karta: nazwa · kategoria · opis · `vN`. BEZ „Used by" — szablon nie jest używany, jest
 * kopiowany. Akcje: „+ nowy szablon" · edycja (bump vN) · „Użyj u agenta…" · usuń.
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
import type { SidebarNav } from '../shell/index.js';
import type { Agent } from '../agents/index.js';
import type { SkillsPlugin } from './types.js';
import type { SkillTemplateStore, SkillTemplateRecord } from './SkillTemplateStore.js';

export function renderSkillsTab(content: HTMLElement, plugin: SkillsPlugin, nav: SidebarNav): void {
    const store = plugin.agentManager?.skillTemplateStore;
    const templates = store?.list() || [];
    const agents = plugin.agentManager?.getAllAgents() || [];

    content.createEl('p', { text: t('backstage.skill_templates_intro'), cls: 'cs-backstage-intro' });

    const createBtn = content.createEl('button', { cls: 'cs-create-btn' });
    setSvgLabel(createBtn, UiIcons.plus(11), t('backstage.new_skill_template'));
    createBtn.addEventListener('click', () => {
        // `plugin.app as never`: patrz komentarz w SkillDetailView.ts (most AppLike→App).
        new SkillEditorModal(plugin.app as never, plugin, null, () => nav.refresh(), { template: true }).open();
    });

    if (templates.length === 0) {
        content.createEl('p', { text: t('backstage.no_skill_templates'), cls: 'sidebar-empty-text' });
        return;
    }

    const searchInput = content.createEl('input', {
        type: 'text', placeholder: t('backstage.search_skill_template'), cls: 'cs-search-input'
    });

    const activeFilters = new Set<string>();
    const categories = [...new Set(templates.map((s) => s.category).filter(Boolean))];
    const filterDefs = categories.map(c => ({
        value: `cat:${c}`, label: getCategoryLabel(c), iconFn: (s: number) => UiIcons.folder(s),
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
            filtered = filtered.filter((s) =>
                s.name.toLowerCase().includes(filter) || s.description?.toLowerCase().includes(filter)
            );
        }
        for (const f of activeFilters) {
            if (f.startsWith('cat:')) {
                const cat = f.slice(4);
                filtered = filtered.filter((s) => s.category === cat);
            }
        }

        for (const tpl of filtered) {
            // `!`: templates.length > 0 (guard wyżej) wymaga, że `store?.list()` naprawdę
            // zwrócił dane — więc `store` musiało być zdefiniowane (`store?.list() || []`
            // daje [] gdy store jest undefined).
            renderTemplateCard(list, tpl, { plugin, nav, store: store!, agents });
        }
    };

    renderFilters();
    searchInput.addEventListener('input', (e: Event) => renderList((e.target as HTMLInputElement).value.toLowerCase()));
    renderList();
}

function renderTemplateCard(list: HTMLElement, tpl: SkillTemplateRecord, { plugin, nav, store, agents }: { plugin: SkillsPlugin; nav: SidebarNav; store: SkillTemplateStore; agents: Agent[] }): void {
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
            // `plugin.app as never`: patrz komentarz w SkillDetailView.ts (most AppLike→App).
            new SkillEditorModal(plugin.app as never, plugin, tpl, () => nav.refresh(), { template: true }).open();
        },
    });
    renderCardAction(actions, {
        iconFn: UiIcons.trash,
        label: t('generic.delete'),
        danger: true,
        onClick: async () => {
            const okToDelete = await confirmModal(plugin.app as never, {
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
 * „Użyj u agenta…" — odlej kopię szablonu i dopisz ją do `skills[]` agenta.
 * Zapis profilu agenta idzie przez AgentManager (jedyny owner), żeby YAML nie rozjechał się z cache.
 */
async function useTemplateAtAgent(tpl: SkillTemplateRecord, agentName: string, { plugin, store, nav }: { plugin: SkillsPlugin; store: SkillTemplateStore; nav: SidebarNav }): Promise<void> {
    const { Notice } = await import('obsidian');
    const agentManager = plugin.agentManager;
    const agent = agentManager?.getAgent?.(agentName);
    if (!agent) {
        new Notice(t('backstage.template_use_failed', { error: agentName }));
        return;
    }
    // `agentManager!`: `agent` doszedł z `agentManager?.getAgent?.(...)` — skoro jest prawdziwy
    // (guard wyżej), `agentManager` musiało być zdefiniowane (optional chaining inaczej dałoby
    // undefined).
    const result = await store.instantiate(tpl.slug, { skillLoader: agentManager!.skillLoader });
    if (!result?.success) {
        new Notice(t('backstage.template_use_failed', { error: result?.error || '?' }));
        return;
    }
    if (result.renamed) {
        new Notice(t('backstage.template_slug_taken', { name: result.name }));
    }

    const skills = Array.isArray(agent.skills) ? [...agent.skills] : [];
    // `s: string | { name?: string }`: realny `Agent.skills` jest dziś zawsze `string[]`, ale
    // ternary niżej broni się defensywnie przed starszym kształtem (obiekt z `name`) — adnotacja
    // (czysto typowa) trzyma obie gałęzie bez zmiany warunku.
    if (!skills.some((s: string | { name?: string }) => (typeof s === 'string' ? s : s?.name) === result.slug)) {
        // `!`: `store.instantiate` zawsze ustawia `slug` w gałęzi sukcesu (`result.success` wyżej).
        skills.push(result.slug!);
        await agentManager!.updateAgent(agentName, { skills });
    }

    new Notice(t('backstage.template_used', { name: result.name, agent: agentName }));
    nav.refresh();
}
