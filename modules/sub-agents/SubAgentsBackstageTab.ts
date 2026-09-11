/**
 * Zaplecze → zakładka „Szablony subów".
 *
 * Pierwsza karta to zawsze **pkm-sub** — fabryczny worker wpisany w kod (nie na dysku),
 * więc read-only i niezniszczalny. Dalej idą SZABLONY subów z
 * `.pkm-assistant/templates/sub-agents/` (formy odlewnicze).
 *
 * Dokładnie JEDEN byt jest „globalny": konfiguracja, której używa `delegate` wywołane
 * BEZ `aspect`, dla wszystkich agentów (`settings.pkmAssistant.globalSubTemplate`;
 * null = fabryczny pkm-sub, zawsze dostępny jako odwrót).
 */
import {
    IconGenerator,
    UiIcons,
    hexToRgbTriplet,
    getCategoryColor,
    deriveDelegateCategory,
    setSvgLabel,
} from '../crystal-soul/index.js';
import { SubAgentEditorModal } from './SubAgentEditorModal.js';
import {
    TOOL_INFO,
    getToolIcon,
    renderFilterBar,
    getCategoryLabel,
    renderUseAtAgentButton,
    renderTemplateVersionBadge,
    renderCardAction,
    confirmModal,
} from '../ui-components/index.js';
import { DEFAULT_SUB_AGENT_TOOLS, PKM_SUB_NAME } from './SubAgentLoader.js';
import { resolveDeleteOutcome } from './deleteOutcome.js';
import { guardTemplateUse } from './templateUseOutcome.js';
// Decyzje stanu ("Użyj u agenta" + reset globalnego suba po kasacji)
// żyją w czystym pliku obok deleteOutcome.js/templateUseOutcome.js.
import { computeSubAgentsAfterTemplateUse, computeGlobalSubAfterTemplateDelete } from './templateAssignmentOutcome.js';
import { t } from '../../core/i18n/index.js';
import { log } from '../../core/utils/Logger.js';
import type { SidebarNav } from '../shell/index.js';
import type { Agent, AgentSubAgentAssignment } from '../agents/index.js';
import type { SubAgentsPlugin } from './types.js';
import type { SubAgentTemplateStore, SubAgentTemplateRecord } from './SubAgentTemplateStore.js';

export function renderSubAgentsTab(content: HTMLElement, plugin: SubAgentsPlugin, nav: SidebarNav): void {
    const store = plugin.agentManager?.subAgentTemplateStore;
    const templates = store?.list() || [];
    const agents = plugin.agentManager?.getAllAgents() || [];
    // TS-boundary: `globalSubTemplate` wisi w `PkmAssistantSettings` na indeksie
    // `[key: string]: unknown` (kontrakt core nie zna nazw pól, które dokłada ten moduł).
    const globalSlug = (plugin?.env?.settings?.pkmAssistant?.globalSubTemplate as string | null | undefined) || null;

    content.createEl('p', { text: t('backstage.sub_templates_intro'), cls: 'cs-backstage-intro' });

    const createBtn = content.createEl('button', { cls: 'cs-create-btn' });
    setSvgLabel(createBtn, UiIcons.plus(11), t('backstage.new_sub_template'));
    createBtn.addEventListener('click', () => {
        // `plugin.app as never`: patrz komentarz w SubAgentDetailView.ts (most AppLike→App).
        new SubAgentEditorModal(plugin.app as never, plugin, null, () => nav.refresh(), { template: true }).open();
    });

    if (templates.length === 0) {
        // Bez szablonów zostaje sam pkm-sub — user i tak widzi, czym delegacja jedzie.
        const onlyList = content.createDiv({ cls: 'cs-item-list' });
        renderPkmSubCard(onlyList, plugin, nav, globalSlug);
        content.createEl('p', { text: t('backstage.no_sub_templates'), cls: 'sidebar-empty-text' });
        return;
    }
    const searchInput = content.createEl('input', {
        type: 'text', placeholder: t('backstage.search_sub_template'), cls: 'cs-search-input'
    });

    const activeFilters = new Set<string>();
    const toolsInTemplates = [...new Set<string>(templates.flatMap((tpl) => tpl.tools || []))];
    const filterDefs = toolsInTemplates.slice(0, 6).map(toolName => ({
        value: `tool:${toolName}`, label: (TOOL_INFO as Record<string, { label: string }>)[toolName]?.label || toolName, toolName,
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
        // TS-boundary: patrz komentarz przy `globalSlug` wyżej.
        renderPkmSubCard(list, plugin, nav, (plugin?.env?.settings?.pkmAssistant?.globalSubTemplate as string | null | undefined) || null);

        let filtered = templates;
        if (filter) {
            filtered = filtered.filter((s) =>
                s.name.toLowerCase().includes(filter) || s.description?.toLowerCase().includes(filter)
            );
        }
        for (const f of activeFilters) {
            if (f.startsWith('tool:')) {
                const tool = f.slice(5);
                filtered = filtered.filter((s) => s.tools?.includes(tool));
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

/**
 * Fabryczny pkm-sub — syntetyczny byt, więc bez edycji i bez kosza (nie ma czego kasować).
 * Gwiazdka wraca na niego, gdy user chce się wycofać ze złego wyboru globalnego szablonu.
 */
function renderPkmSubCard(list: HTMLElement, plugin: SubAgentsPlugin, nav: SidebarNav, globalSlug: string | null): void {
    const catColor = getCategoryColor(deriveDelegateCategory(DEFAULT_SUB_AGENT_TOOLS));
    const card = list.createDiv({ cls: 'cs-item-card cs-item-card--categorized cs-item-card--builtin' });
    card.style.setProperty('--cs-category-color-rgb', hexToRgbTriplet(catColor));

    const nameDiv = card.createDiv({ cls: 'cs-item-card__name' });
    setSvgLabel(nameDiv, UiIcons.robot(13), PKM_SUB_NAME);

    const meta = card.createDiv({ cls: 'cs-item-card__meta' });
    meta.createSpan({ cls: 'cs-item-card__badge', text: t('backstage.pkm_sub_builtin') });
    if (!globalSlug) {
        meta.createSpan({
            cls: 'cs-item-card__badge cs-item-card__badge--category',
            text: t('backstage.global_sub_factory'),
        });
    }
    for (const toolName of DEFAULT_SUB_AGENT_TOOLS) {
        const info = (TOOL_INFO as Record<string, { label: string }>)[toolName] || { label: toolName };
        const badge = meta.createSpan({ cls: 'cs-item-card__badge' });
        setSvgLabel(badge, getToolIcon(toolName, 'currentColor', 10), info.label);
    }

    card.createDiv({ cls: 'cs-item-card__desc', text: t('backstage.pkm_sub_desc') });

    if (globalSlug) {
        const actions = card.createDiv({ cls: 'cs-item-card__actions' });
        renderCardAction(actions, {
            iconFn: UiIcons.sparkle,
            label: t('backstage.set_global_sub'),
            onClick: () => setGlobalSub(plugin, nav, null, PKM_SUB_NAME),
        });
    }
}

function renderTemplateCard(list: HTMLElement, tpl: SubAgentTemplateRecord, { plugin, nav, store, agents }: { plugin: SubAgentsPlugin; nav: SidebarNav; store: SubAgentTemplateStore; agents: Agent[] }): void {
    // TS-boundary: patrz komentarz przy `globalSlug` w `renderSubAgentsTab`.
    const globalSlug = (plugin?.env?.settings?.pkmAssistant?.globalSubTemplate as string | null | undefined) || null;
    const isGlobal = globalSlug === tpl.slug;
    const category = deriveDelegateCategory(tpl.tools);
    const catColor = getCategoryColor(category);

    const card = list.createDiv({ cls: 'cs-item-card cs-item-card--categorized' });
    card.style.setProperty('--cs-category-color-rgb', hexToRgbTriplet(catColor));

    const nameDiv = card.createDiv({ cls: 'cs-item-card__name' });
    setSvgLabel(nameDiv, IconGenerator.generate(tpl.name, 'connect', { size: 13, color: catColor }), tpl.name);

    const meta = card.createDiv({ cls: 'cs-item-card__meta' });
    renderTemplateVersionBadge(meta, tpl.version);
    if (isGlobal) {
        meta.createSpan({
            cls: 'cs-item-card__badge cs-item-card__badge--category',
            text: t('backstage.global_sub_badge'),
        });
    }
    const catBadge = meta.createSpan({ cls: 'cs-item-card__badge cs-item-card__badge--category' });
    catBadge.empty();
    const catDot = catBadge.createSpan({ cls: 'cs-category-dot cs-dyn-bg' });
    catDot.style.setProperty('--cs-dyn-bg', catColor);
    catBadge.appendText(' ' + getCategoryLabel(category));
    if (tpl.model) meta.createSpan({ cls: 'cs-item-card__badge', text: tpl.model });
    for (const toolName of tpl.tools || []) {
        const info = (TOOL_INFO as Record<string, { label: string }>)[toolName] || { label: toolName };
        const badge = meta.createSpan({ cls: 'cs-item-card__badge' });
        setSvgLabel(badge, getToolIcon(toolName, 'currentColor', 10), info.label);
    }

    if (tpl.description) {
        card.createDiv({ cls: 'cs-item-card__desc', text: tpl.description });
    }

    const actions = card.createDiv({ cls: 'cs-item-card__actions' });
    renderUseAtAgentButton(actions, agents, (agentName: string) => {
        // `renderUseAtAgentButton` PORZUCA zwróconą obietnicę (`onPick(name)`
        // bez `await`/`.catch`), a `useTemplateAtAgent` robi dwa zapisy pod rząd. Bez tego
        // bezpiecznika rzut z któregokolwiek leciałby w próżnię: zero komunikatu, lista bez
        // odświeżenia, a kopia suba mogłaby już leżeć na dysku bez przypisania do agenta
        // (drugie kliknięcie odlałoby kolejną, z sufiksem `-2`). Ta sama operacja z
        // `SubAgentEditorModal` ma `catch` - tu bezpiecznik jest lokalny, nie konwencja globalna.
        void (async () => {
            const outcome = await guardTemplateUse(() => useTemplateAtAgent(tpl, agentName, { plugin, store, nav }));
            if (outcome.ok) return;
            log.error('SubAgentsBackstageTab', `useTemplateAtAgent(${tpl.slug} → ${agentName}) padło:`, outcome.error);
            const { Notice } = await import('obsidian');
            new Notice(t(outcome.messageKey as string, outcome.params));
        })();
    });
    if (!isGlobal) {
        renderCardAction(actions, {
            iconFn: UiIcons.sparkle,
            label: t('backstage.set_global_sub'),
            onClick: () => setGlobalSub(plugin, nav, tpl.slug, tpl.name),
        });
    }
    renderCardAction(actions, {
        iconFn: UiIcons.edit,
        label: t('generic.edit'),
        onClick: () => {
            // `plugin.app as never`: patrz komentarz w SubAgentDetailView.ts (most AppLike→App).
            new SubAgentEditorModal(plugin.app as never, plugin, tpl, () => nav.refresh(), { template: true }).open();
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
            // `store.delete` zwraca `false`, gdy kasowanie padnie - bez sprawdzenia tego
            // kafel znikałby z widoku po `nav.refresh()`, a szablon zostawałby na dysku.
            const outcome = resolveDeleteOutcome(await store.delete(tpl.slug), tpl.name);
            if (!outcome.ok) {
                const { Notice } = await import('obsidian');
                new Notice(t(outcome.messageKey, outcome.params));
                return;
            }
            // Ta sama reguła, z testem w computeGlobalSubAfterTemplateDelete:
            // globalny wskaźnik nie może wisieć na skasowanym szablonie — wracamy na pkm-sub.
            const globalReset = computeGlobalSubAfterTemplateDelete(isGlobal);
            if (globalReset.changed) await setGlobalSub(plugin, null, globalReset.slug, PKM_SUB_NAME, { silent: true });
            nav.refresh();
        },
    });

    card.addEventListener('click', () => {
        nav.push('sub-agent-detail', { subAgentName: tpl.slug, template: true }, t('sidebar.backstage'));
    });
}

/**
 * Zawsze dokładnie jeden globalny. `null` = fabryczny pkm-sub.
 */
async function setGlobalSub(plugin: SubAgentsPlugin, nav: SidebarNav | null, slug: string | null, label: string, { silent = false }: { silent?: boolean } = {}): Promise<void> {
    const pkm = plugin?.env?.settings?.pkmAssistant;
    if (!pkm) return;
    pkm.globalSubTemplate = slug;
    await plugin.env?.settingsStore?.save?.();
    if (!silent) {
        const { Notice } = await import('obsidian');
        new Notice(t('backstage.global_sub_set', { name: label }));
    }
    nav?.refresh?.();
}

/** Odlej kopię szablonu suba do Ekipy wybranego agenta. */
async function useTemplateAtAgent(tpl: SubAgentTemplateRecord, agentName: string, { plugin, store, nav }: { plugin: SubAgentsPlugin; store: SubAgentTemplateStore; nav: SidebarNav }): Promise<void> {
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
    const result = await store.instantiate(tpl.slug, agentName, { subAgentLoader: agentManager!.subAgentLoader });
    if (!result?.success) {
        new Notice(t('backstage.template_use_failed', { error: result?.error || '?' }));
        return;
    }
    if (result.renamed) {
        new Notice(t('backstage.template_slug_taken', { name: result.name }));
    }

    const existingNames = agent.getAllSubAgentNames?.() || [];
    // `as AgentSubAgentAssignment[]`: TS 5.4 nie zwęża `.filter(Boolean)` — cast na wyniku,
    // nie zmieniony warunek ani nowy statement (zero-kosztowy, zero różnicy w emitowanym JS).
    const existingAssignments = (existingNames
        .map((name) => agent.getSubAgentAssignment?.(name))
        .filter(Boolean) as AgentSubAgentAssignment[])
        .map((s) => ({ ...s }));
    // Decyzja (idempotencja + „pierwszy sub = domyślny") żyje w czystej
    // funkcji z testami — widok zostaje z wywołaniem i zapisem.
    const decision = computeSubAgentsAfterTemplateUse(existingAssignments, result.name!);
    if (decision.changed) {
        await agentManager!.updateAgent(agentName, { sub_agents: decision.subAgents });
    }

    new Notice(t('backstage.template_used', { name: result.name, agent: agentName }));
    nav.refresh();
}
