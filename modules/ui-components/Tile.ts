/**
 * Tile — jeden wspólny komponent kafelka dla wszystkich rzędów akcji w czacie ("Czat bez ścian",
 * 2.3.0). Zamiast osobnych ad-hoc struktur DOM per blok (myślenie, narzędzie, sub-agent, system),
 * każdy blok jest kafelkiem `.cs-tile`: ikona + tytuł po ludzku + skrót + kropka statusu w
 * nagłówku, szczegóły zwijane w ciele. Zero technikaliów w nagłówku - żadnych id wywołań,
 * surowych nazw narzędzi ani JSON-ów.
 *
 * A1 przepina na to ThinkingBlock i ToolCallDisplay. A2/A3 dołożą resztę (sub-agent, todo,
 * ask_user, bloki systemowe) - patrz `CLAUDE.md` tego modułu.
 */
import { setSvg } from '../crystal-soul/index.js';
import { truncatePreview } from './textPreview.js';

export type TileRole = 'system' | 'agent' | 'agent-muted' | 'user';
export type TileStatus = 'ok' | 'error' | 'pending';

export interface TileAction { label: string; onClick: (ev: MouseEvent) => void; }

export interface TileSpec {
    role: TileRole;
    status: TileStatus;
    /** Gotowy SVG (jak dziś `setSvg` w ThinkingBlock/ToolCallDisplay). */
    iconSvg: string;
    /** Tytuł po ludzku, bez id i bez JSON-a. */
    title: string;
    /** Krótki skrót obok tytułu, przycięty przez `truncatePreview` do 80 znaków. */
    summary?: string;
    /** Mały tekst po prawej, przed kropką (czas, licznik). */
    meta?: string;
    /** Szczegóły renderowane LENIWIE przy pierwszym rozwinięciu, raz. */
    details?: string | HTMLElement | ((body: HTMLElement) => void);
    /** Domyślnie false. Gdy status === 'error' i pole nieustawione: true. */
    expanded?: boolean;
    /** Przyciski w ciele kafelka (np. "Otwórz"). */
    actions?: TileAction[];
}

export interface TileHandle {
    el: HTMLElement;
    setStatus(status: TileStatus): void;
    setTitle(title: string): void;
    setSummary(summary?: string): void;
    setMeta(meta?: string): void;
    setDetails(details: TileSpec['details']): void;
    expand(open?: boolean): void;
    isExpanded(): boolean;
}

// Node-safe DOM shim: identyczny wzorzec i uzasadnienie jak w `ToolCallDisplay.ts` (ten sam
// plik nie importuje `obsidian` wprost, a jego test `Tile.test.ts` woła go w gołym Node,
// podstawiając WŁASNĄ atrapę `globalThis.document.createElement`). `document` czytany LENIWIE
// (dopiero przy wywołaniu), rzutowany na wąski typ - w prawdziwym Obsidianie to dokładnie ten
// sam `document.createElement`, którego wołały `createDiv`/`createEl`/`createSpan` pod maską,
// bo Obsidian dokleja swoje rozszerzenia do `HTMLElement.prototype` globalnie (zero zmiany
// zachowania niezależnie od tego, którą drogą element powstał).
function _createDetachedEl(tag: string): HTMLElement {
    return (document as unknown as { createElement(tag: string): HTMLElement }).createElement(tag);
}

/**
 * Buduje kafelek `.cs-tile` wg specyfikacji. DOM (klasy dokładnie takie, CSS i testy na nich
 * polegają):
 *
 * ```
 * div.cs-tile.cs-tile--{role}.cs-tile--{status}[.is-toggleable][.is-expanded]
 *   div.cs-tile__head
 *     span.cs-tile__icon
 *     span.cs-tile__title
 *     span.cs-tile__summary   (tylko gdy summary)
 *     span.cs-tile__meta      (tylko gdy meta)
 *     span.cs-tile__dot
 *   div.cs-tile__body         (atrybut hidden gdy zwinięty)
 *     div.cs-tile__details
 *     div.cs-tile__actions    (tylko gdy actions)
 * ```
 */
export function createTile(spec: TileSpec): TileHandle {
    const role = spec.role;
    let status = spec.status;
    let expanded = spec.expanded !== undefined ? spec.expanded : status === 'error';
    let currentDetails = spec.details;
    let detailsRendered = false;

    const hasDetails = spec.details != null;
    const hasActions = !!(spec.actions && spec.actions.length > 0);
    const isToggleable = hasDetails || hasActions;

    const el = _createDetachedEl('div');
    el.classList.add('cs-tile', `cs-tile--${role}`, `cs-tile--${status}`);
    if (isToggleable) el.classList.add('is-toggleable');
    if (expanded) el.classList.add('is-expanded');

    // ── HEAD ──
    const head = _createDetachedEl('div');
    head.className = 'cs-tile__head';
    el.appendChild(head);

    const iconEl = _createDetachedEl('span');
    iconEl.className = 'cs-tile__icon';
    // `setSvg` żąda `HTMLElement & { empty(); appendText() }` — Obsidian dokleja obie metody do
    // `HTMLElement.prototype` globalnie (`obsidian.d.ts` augmentuje typ), więc gołe `HTMLElement`
    // już je ma w tym projekcie; żaden cast nie jest tu potrzebny (wzór jak w `ThinkingBlock.ts`).
    setSvg(iconEl, spec.iconSvg);
    head.appendChild(iconEl);

    const titleEl = _createDetachedEl('span');
    titleEl.className = 'cs-tile__title';
    titleEl.textContent = spec.title;
    head.appendChild(titleEl);

    let summaryEl: HTMLElement | null = null;
    let metaEl: HTMLElement | null = null;

    const dot = _createDetachedEl('span');
    dot.className = 'cs-tile__dot';

    if (spec.summary) {
        summaryEl = _createDetachedEl('span');
        summaryEl.className = 'cs-tile__summary';
        summaryEl.textContent = truncatePreview(spec.summary, 80);
        head.appendChild(summaryEl);
    }
    if (spec.meta) {
        metaEl = _createDetachedEl('span');
        metaEl.className = 'cs-tile__meta';
        metaEl.textContent = spec.meta;
        head.appendChild(metaEl);
    }
    head.appendChild(dot);

    if (isToggleable) {
        head.setAttribute('tabindex', '0');
        head.setAttribute('role', 'button');
        head.setAttribute('aria-expanded', String(expanded));
        head.addEventListener('click', () => expand());
        head.addEventListener('keydown', (ev: KeyboardEvent) => {
            if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
                ev.preventDefault();
                expand();
            }
        });
    }

    // ── BODY ──
    const body = _createDetachedEl('div');
    body.className = 'cs-tile__body';
    el.appendChild(body);

    const detailsEl = _createDetachedEl('div');
    detailsEl.className = 'cs-tile__details';
    body.appendChild(detailsEl);

    if (hasActions) {
        const actionsEl = _createDetachedEl('div');
        actionsEl.className = 'cs-tile__actions';
        for (const action of spec.actions!) {
            const btn = _createDetachedEl('button') as HTMLButtonElement;
            btn.type = 'button';
            btn.className = 'cs-tile__action';
            btn.textContent = action.label;
            btn.addEventListener('click', (ev: MouseEvent) => action.onClick(ev));
            actionsEl.appendChild(btn);
        }
        body.appendChild(actionsEl);
    }

    function renderDetailsNow(): void {
        if (detailsRendered) return;
        detailsRendered = true;
        const d = currentDetails;
        if (d == null) return;
        if (typeof d === 'string') {
            detailsEl.textContent = d;
        } else if (typeof d === 'function') {
            d(detailsEl);
        } else {
            detailsEl.appendChild(d);
        }
    }

    function syncBodyVisibility(): void {
        if (expanded) {
            body.removeAttribute('hidden');
            renderDetailsNow();
        } else {
            body.setAttribute('hidden', '');
        }
    }
    syncBodyVisibility();

    function setStatus(newStatus: TileStatus): void {
        el.classList.remove(`cs-tile--${status}`);
        status = newStatus;
        el.classList.add(`cs-tile--${status}`);
        if (status === 'error') expand(true);
    }

    function setTitle(title: string): void {
        titleEl.textContent = title;
    }

    function setSummary(summary?: string): void {
        if (!summary) {
            if (summaryEl) { summaryEl.remove(); summaryEl = null; }
            return;
        }
        if (!summaryEl) {
            summaryEl = _createDetachedEl('span');
            summaryEl.className = 'cs-tile__summary';
            head.insertBefore(summaryEl, metaEl || dot);
        }
        summaryEl.textContent = truncatePreview(summary, 80);
    }

    function setMeta(meta?: string): void {
        if (!meta) {
            if (metaEl) { metaEl.remove(); metaEl = null; }
            return;
        }
        if (!metaEl) {
            metaEl = _createDetachedEl('span');
            metaEl.className = 'cs-tile__meta';
            head.insertBefore(metaEl, dot);
        }
        metaEl.textContent = meta;
    }

    function setDetails(details: TileSpec['details']): void {
        currentDetails = details;
        if (detailsRendered) {
            detailsEl.textContent = '';
            detailsRendered = false;
            renderDetailsNow();
        }
    }

    function expand(open?: boolean): void {
        const next = open === undefined ? !expanded : !!open;
        if (next === expanded) return;
        expanded = next;
        el.classList.toggle('is-expanded', expanded);
        if (isToggleable) head.setAttribute('aria-expanded', String(expanded));
        syncBodyVisibility();
    }

    function isExpanded(): boolean {
        return expanded;
    }

    return { el, setStatus, setTitle, setSummary, setMeta, setDetails, expand, isExpanded };
}
