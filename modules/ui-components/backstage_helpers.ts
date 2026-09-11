/**
 * Shared helpers for per-module Backstage tabs.
 * Tab implementations live in their owning module (skills, sub-agents) and reuse these
 * common UI primitives (filter chips, agent links, card actions).
 *
 * Wołają je WYŁĄCZNIE zakładki z modułów niższych (skills, sub-agents) — trzymanie ich
 * w shellu zmuszałoby te moduły do importu z barrela shella. Klocek współdzielony
 * przez ≥2 moduły = `modules/ui-components`.
 */
import { getToolIcon } from './ToolCallDisplay.js';
import { t } from '../../core/i18n/index.js';
import { setSvg, setSvgLabel, UiIcons } from '../crystal-soul/index.js';

/** Wpis paska filtrów. Dokładnie jedno z `iconFn` (kategoria, `SkillsBackstageTab`) /
 *  `toolName` (narzędzie z katalogu `TOOL_INFO`, `SubAgentsBackstageTab`) bywa ustawione —
 *  bez żadnego z nich chip dostaje sam tekst etykiety. */
interface FilterBarEntry {
    value: string;
    label: string;
    iconFn?: (size: number) => string;
    toolName?: string;
}

/** Render a horizontal filter chip bar. `onToggle(value)` toggles the filter. */
export function renderFilterBar(container: HTMLElement, filters: FilterBarEntry[], activeFilters: Set<string>, onToggle: (value: string) => void): HTMLElement {
    const bar = container.createDiv({ cls: 'cs-filter-bar' });
    for (const f of filters) {
        const chip = bar.createSpan({
            cls: `cs-filter-chip ${activeFilters.has(f.value) ? 'active' : ''}`
        });
        if (f.iconFn) {
            setSvgLabel(chip, f.iconFn(11), f.label);
        } else if (f.toolName) {
            setSvgLabel(chip, getToolIcon(f.toolName, 'currentColor', 11), f.label);
        } else {
            chip.textContent = f.label;
        }
        chip.addEventListener('click', () => onToggle(f.value));
    }
    return bar;
}

/** Resolve i18n label for a category (tries `backstage.cat.<name>`, falls back to raw). */
export function getCategoryLabel(category: string): string {
    const key = `backstage.cat.${category}`;
    const translated = t(key, {});
    return translated !== key ? translated : category;
}

/** Agent, do którego można „odlać kopię" szablonu — tylko pole, które ten guzik czyta. */
interface BackstageAgentRef {
    name: string;
}

/**
 * Guzik „Użyj u agenta…" — rozwijana lista agentów, klik = odlanie kopii.
 * Szablon nie ma „Used by" (nie jest używany, jest kopiowany), więc to JEDYNA akcja
 * łącząca kartę Zaplecza z konkretnym agentem.
 *
 * @param {HTMLElement} container
 * @param {Object[]} agents - lista agentów (obiekty z polem `name`)
 * @param {(agentName: string) => void} onPick
 * @param {string} [label] - etykieta guzika
 * @returns {HTMLElement} wrapper
 */
export function renderUseAtAgentButton(container: HTMLElement, agents: BackstageAgentRef[], onPick: (agentName: string) => void, label = t('backstage.use_at_agent')): HTMLElement {
    const wrap = container.createDiv({ cls: 'cs-template-use' });
    const btn = wrap.createEl('button', { cls: 'cs-template-use__btn' });
    setSvgLabel(btn, UiIcons.users(11), label);

    const menu = wrap.createDiv({ cls: 'cs-template-use__menu cs-collapsed' });

    if (agents.length === 0) {
        menu.createDiv({ cls: 'cs-picker__no-results', text: t('backstage.use_at_agent_none') });
    }
    for (const agent of agents) {
        const option = menu.createDiv({ cls: 'cs-picker__option', text: agent.name });
        option.addEventListener('click', (e: Event) => {
            e.stopPropagation();
            menu.classList.add('cs-collapsed');
            onPick(agent.name);
        });
    }

    btn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        menu.classList.toggle('cs-collapsed');
    });
    return wrap;
}

/**
 * Badge wersji szablonu („v3"). Szablon jest formą odlewniczą — wersja mówi
 * userowi, że forma poszła do przodu względem odlanych wcześniej kopii.
 * @param {HTMLElement} container
 * @param {number} version
 */
export function renderTemplateVersionBadge(container: HTMLElement, version: number): HTMLElement {
    return container.createSpan({
        cls: 'cs-item-card__badge cs-item-card__badge--version',
        text: `v${Number(version) || 1}`,
    });
}

/** Opcje małego guzika akcji na karcie szablonu (edycja / kasowanie / ustaw globalny). */
interface CardActionOptions {
    iconFn: (size: number) => string;
    label: string;
    danger?: boolean;
    onClick: () => void | Promise<void>;
}

/**
 * Mały guzik akcji na karcie szablonu (edycja / kasowanie).
 * @param {HTMLElement} container
 * @param {Object} opts - { iconFn, label, danger?, onClick }
 */
export function renderCardAction(container: HTMLElement, { iconFn, label, danger = false, onClick }: CardActionOptions): HTMLElement {
    const btn = container.createEl('button', {
        cls: `cs-template-action ${danger ? 'cs-template-action--danger' : ''}`,
        attr: { 'aria-label': label, title: label },
    });
    setSvg(btn, iconFn(11));
    btn.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        void onClick();
    });
    return btn;
}
