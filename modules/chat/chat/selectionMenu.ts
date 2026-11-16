/**
 * selectionMenu - menu na zaznaczeniu tekstu w dymkach/kafelkach czatu (2.3.0, "Czat bez ścian").
 *
 * Werdykt właściciela (dosłownie): "Nie mogę zaznaczyć tekstu i go np. skopiować, a jak już przy
 * tym jesteśmy to możesz przy okazji zrobić 'dodaj jako kontekst': czyli dodaje się jako
 * załącznik, a druga opcja to cytuj i kopiuje się to do chatu jako cytat."
 *
 * CO TU JEST:
 *  - `quoteText(sel)` / `insertAtCursor(textarea, text)` - funkcje CZYSTE, testowalne w AVA
 *    bez DOM-u/`obsidian` (atrapa `textarea` wystarczy - patrz `selectionMenu.test.ts`).
 *  - `installSelectionMenu(view)` - wołacz z `obsidian` (`window.getSelection`, `document`,
 *    `navigator.clipboard`) - montuje nasłuchy na `view.messages_container` i zwraca funkcję
 *    ODPINAJĄCĄ (patrz gotcha "Sprzątanie" niżej).
 *
 * Sprzątanie: `chat/chat_ui.ts`'s `renderView` woła `installSelectionMenu(this)` i ZAPAMIĘTUJE
 * zwróconą funkcję na `this._selectionMenuDetach` (pole w `ChatViewMixins`,
 * `chat/chatViewShape.ts`), odpinając POPRZEDNI egzemplarz PRZED zamontowaniem nowego -
 * `renderView` potrafi się powtórzyć w cyklu życia jednego widoku (patrz wołacze w
 * `chat_view.ts`), a `messages_container` jest tworzony na nowo za każdym razem, więc bez tego
 * nasłuchy na `document` (klik poza / Escape) zostawałyby wiszące, mnożąc się przy każdym
 * kolejnym renderze.
 * Odpięcie przy ZAMKNIĘCIU widoku jest wpięte w `onClose` (`modules/chat/chat_view.ts`):
 * bez tego każda zamknięta instancja widoku zostawiałaby parę nasłuchów na `document`
 * trzymającą cały widok w pamięci (recenzja D).
 */
import { t } from '../../../core/i18n/index.js';
import { log } from '../../../core/utils/Logger.js';
import type { ChatViewLike } from './chatViewShape.js';

/** Elementy, wewnątrz których zaznaczenie ma pokazać menu (treść, nie nagłówki). */
const SELECTABLE_SELECTOR = '.cs-message__text, .cs-tile__body';

// Przybliżenia: uchwyty zaznaczenia i natywny pasek wymagają pomiaru na urządzeniu.
const MOBILE_HANDLE_GAP = 28;
const MOBILE_TOOLBAR_GAP = 64;
const MOBILE_SETTLE_MS = 250;
type SelectionRect = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;

/** Viewport coordinates; the caller limits menu size to the visible area first. */
export function mobileSelectionPosition(
    rects: readonly SelectionRect[], area: SelectionRect, menu: Pick<DOMRect, 'width' | 'height'>,
): { left: number; top: number; side: 'below' | 'above' } | null {
    const first = rects[0], last = rects[rects.length - 1];
    if (!first || !last) return null;
    const below = last.bottom + MOBILE_HANDLE_GAP;
    const side = below + menu.height <= area.bottom ? 'below' : 'above';
    const anchor = side === 'below' ? last : first;
    return {
        left: Math.max(area.left, Math.min(anchor.left, area.right - menu.width)),
        top: Math.max(area.top, Math.min(
            side === 'below' ? below : first.top - MOBILE_TOOLBAR_GAP - menu.height,
            area.bottom - menu.height,
        )),
        side,
    };
}

interface SelectionMenuOptions {
    isMobile?: boolean;
    timer?: {
        setTimeout: (callback: () => void, delay: number) => number;
        clearTimeout: (id: number) => void;
    };
}

/**
 * Cytat markdown: każda linia zaznaczenia dostaje prefiks `> `, na końcu jedna pusta linia
 * (miejsce na dopisanie własnego komentarza usera nad cytatem po wstawieniu do pola).
 *
 * `"a\nb"` => `"> a\n> b\n\n"` (literalnie - patrz `selectionMenu.test.ts`).
 */
export function quoteText(sel: string): string {
    const lines = sel.split('\n');
    return lines.map((line) => `> ${line}`).join('\n') + '\n\n';
}

/**
 * Kontrakt textarei w zakresie, jakiego `insertAtCursor` naprawdę używa - atrapa w testach
 * podaje tylko `value`/`selectionStart` (patrz `selectionMenu.test.ts`), realny
 * `HTMLTextAreaElement` ma resztę.
 */
export interface CursorTextArea {
    value: string;
    selectionStart: number | null;
    selectionEnd?: number | null;
    setSelectionRange?: (start: number, end: number) => void;
}

/**
 * Wstawia `text` w miejscu kursora (albo zamiast zaznaczenia pola, jeśli `selectionEnd` różni
 * się od `selectionStart`), kursor ląduje na KOŃCU wstawki. Brak `selectionEnd` w atrapie
 * (mock bez tego pola) liczy się jako punkt wstawienia bez własnego zaznaczenia - `?? start`.
 */
export function insertAtCursor(textarea: CursorTextArea, text: string): void {
    const value = textarea.value || '';
    const start = textarea.selectionStart ?? value.length;
    const end = textarea.selectionEnd ?? start;
    const before = value.slice(0, start);
    const after = value.slice(end);
    textarea.value = before + text + after;
    const caret = before.length + text.length;
    textarea.selectionStart = caret;
    textarea.selectionEnd = caret;
    textarea.setSelectionRange?.(caret, caret);
}

/** Godzina:minuta dla nazwy załącznika ("Cytat z czatu HH:MM.md"). */
function currentHm(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** Czy węzeł (albo jego przodek do `boundary`) pasuje do `SELECTABLE_SELECTOR`. */
function isInsideSelectable(node: Node | null, boundary: HTMLElement): boolean {
    let el: HTMLElement | null = node instanceof HTMLElement ? node : node?.parentElement || null;
    while (el && el !== boundary) {
        if (el.matches(SELECTABLE_SELECTOR)) return true;
        el = el.parentElement;
    }
    return false;
}

/**
 * Montuje menu na zaznaczeniu w `view.messages_container`. Jeden egzemplarz na widok
 * (poprzedni menu-element jest zawsze usuwany przed pokazaniem nowego).
 *
 * @returns funkcja odpinająca wszystkie nasłuchy zamontowane tym wywołaniem - patrz gotcha
 *   "Sprzątanie" w nagłówku pliku.
 */
export function installSelectionMenu(view: ChatViewLike, options: SelectionMenuOptions = {}): () => void {
    const container = view.messages_container;
    const isMobile = options.isMobile ?? false;
    const timer = options.timer ?? window;
    let menuEl: HTMLDivElement | null = null;
    let disposed = false;
    let pressingMenu = false;
    let settleTimer: number | null = null;
    const mouseTimers = new Set<number>();

    function cancelSettle(): void {
        if (settleTimer !== null) timer.clearTimeout(settleTimer);
        settleTimer = null;
    }

    function settleSelection(): void {
        cancelSettle();
        if (disposed) return;
        settleTimer = timer.setTimeout(() => {
            settleTimer = null;
            if (!disposed && !pressingMenu) showMenu();
        }, MOBILE_SETTLE_MS);
    }

    function removeMenu(): void {
        pressingMenu = false;
        if (!menuEl) return;
        menuEl.remove();
        menuEl = null;
    }

    /** Zaznaczenie niepuste, zakotwiczone wewnątrz treści dymka/kafelka - albo `null`. */
    function readSelection(): { text: string; range: Range } | null {
        const sel = window.getSelection?.();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
        const text = sel.toString();
        if (!text.trim()) return null;
        const range = sel.getRangeAt(0);
        // Mobile listens on document: another chat view must not adopt this selection.
        if (isMobile && !container.contains(range.commonAncestorContainer)) return null;
        if (!isInsideSelectable(range.commonAncestorContainer, container)) return null;
        return { text, range };
    }

    function afterAction(): void {
        if (isMobile) cancelSettle();
        removeMenu();
        window.getSelection?.()?.removeAllRanges();
    }

    function handleCopy(text: string): void {
        afterAction();
        void navigator.clipboard.writeText(text).then(
            () => {
                view.plugin?.showCrystalNotice?.(t('chat.selection.copied'), { type: 'success', timeout: 2000 });
            },
            (e: unknown) => {
                log.warn('Chat', `Selection copy failed: ${(e as Error)?.message || String(e)}`);
                view.plugin?.showCrystalNotice?.(t('chat.selection.copy_failed'), { type: 'error', timeout: 4000 });
            },
        );
    }

    function handleAddContext(text: string): void {
        view.attachmentManager?.addTextAttachment({ name: `Cytat z czatu ${currentHm()}.md`, text });
        afterAction();
    }

    function handleQuote(text: string): void {
        // Kolejnosc jest istotna [measured w Obsidianie 24.09, log stosu na setterach kursora]:
        // removeAllRanges() na polu, ktore MA fokus, cofa kursor na 0 (zaznaczenie z klawiatury
        // przy aktywnym polu). Dlatego sprzatanie zaznaczenia idzie PRZED wstawieniem cytatu,
        // a fokus na koncu - kursor zostaje za wstawionym cytatem niezaleznie od tego, czy pole
        // mialo fokus (przy zaznaczeniu myszka w dymku pole go nie ma i tak).
        afterAction();
        insertAtCursor(view.input_area, quoteText(text));
        view.handleInputResize?.();
        view.input_area?.focus();
    }

    function buildButton(labelKey: string, onClick: (text: string) => void, text: string): HTMLButtonElement {
        const btn = createEl('button', { cls: 'cs-selection-menu__btn', text: t(labelKey), attr: { type: 'button' } });
        btn.addEventListener('click', () => onClick(text));
        return btn;
    }

    function showMenu(): void {
        if (disposed) return;
        const found = readSelection();
        removeMenu();
        if (!found) return;

        if (isMobile) {
            showMobileMenu(found);
            return;
        }

        const rect = found.range.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        const menu = createDiv({ cls: 'cs-selection-menu' });
        menu.style.left = `${rect.left - containerRect.left + container.scrollLeft}px`;
        menu.style.top = `${rect.top - containerRect.top + container.scrollTop - 36}px`;

        menu.appendChild(buildButton('chat.selection.copy', handleCopy, found.text));
        menu.appendChild(buildButton('chat.selection.context', handleAddContext, found.text));
        menu.appendChild(buildButton('chat.selection.quote', handleQuote, found.text));

        container.appendChild(menu);
        menuEl = menu;
    }

    function showMobileMenu(found: { text: string; range: Range }): void {
        const rects = Array.from(found.range.getClientRects());
        const bounds = container.getBoundingClientRect();
        // U7 already shrinks the phone list above the keyboard. Tablets retain an
        // absolute input panel, so intersect with its top as well; no keyboard probe.
        const panel = view.input_area.closest('.cs-input-panel');
        const area = {
            left: bounds.left + container.clientLeft,
            right: bounds.left + container.clientLeft + container.clientWidth,
            top: bounds.top + container.clientTop,
            bottom: Math.min(bounds.top + container.clientTop + container.clientHeight,
                panel?.getBoundingClientRect().top ?? bounds.bottom),
        };
        if (area.right <= area.left || area.bottom <= area.top || !rects.some(rect =>
            rect.bottom > area.top && rect.top < area.bottom && rect.right > area.left && rect.left < area.right)) return;

        const menu = createDiv({ cls: 'cs-selection-menu' });
        menu.style.maxWidth = `${area.right - area.left}px`;
        menu.style.maxHeight = `${area.bottom - area.top}px`;
        menu.style.left = `${container.scrollLeft}px`;
        menu.style.top = `${container.scrollTop}px`;
        menu.appendChild(buildButton('chat.selection.quote', handleQuote, found.text));
        menu.appendChild(buildButton('chat.selection.context', handleAddContext, found.text));
        // Pointer/mouse defaults move focus. Cancelling touchstart can suppress click,
        // so touchstart only locks the snapshot; pointerdown/mousedown prevent focus.
        const press = (event: Event) => {
            pressingMenu = true;
            cancelSettle();
            if (event.type !== 'touchstart') event.preventDefault();
        };
        menu.addEventListener('pointerdown', press);
        menu.addEventListener('mousedown', press);
        menu.addEventListener('touchstart', press, { passive: true });
        container.appendChild(menu);
        menuEl = menu;
        const position = mobileSelectionPosition(rects, area, menu.getBoundingClientRect());
        if (!position) { removeMenu(); return; }
        menu.style.left = `${position.left - area.left + container.scrollLeft}px`;
        menu.style.top = `${position.top - area.top + container.scrollTop}px`;
    }

    function onMouseUp(): void {
        // `window.getSelection()` w `mouseup` bywa jeszcze niezaktualizowany w części
        // przeglądarek - jedna mikro/makro-tura kolejki wystarcza, bez sztucznego czekania.
        const id = timer.setTimeout(() => { mouseTimers.delete(id); showMenu(); }, 0);
        mouseTimers.add(id);
    }

    function onKeyUp(e: KeyboardEvent): void {
        if (!e.shiftKey || !e.key.startsWith('Arrow')) return;
        showMenu();
    }

    function onDocMouseDown(e: MouseEvent): void {
        if (!menuEl) return;
        const target = e.target as Node | null;
        if (target && menuEl.contains(target)) return;
        if (isMobile) cancelSettle();
        removeMenu();
    }

    function onDocKeyDown(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            if (isMobile) cancelSettle();
            removeMenu();
        }
    }

    function onMobilePress(e: Event): void {
        if (menuEl && e.target instanceof Node && menuEl.contains(e.target)) return;
        cancelSettle();
        removeMenu();
    }

    function onMobileCancel(): void {
        pressingMenu = false;
        settleSelection();
    }

    function onMobileRelease(e: Event): void {
        if (pressingMenu && !(e.target instanceof Node && menuEl?.contains(e.target))) onMobileCancel();
    }

    function onContainerScroll(): void {
        removeMenu();
        if (isMobile) settleSelection();
    }

    if (isMobile) {
        document.addEventListener('selectionchange', settleSelection);
        document.addEventListener('pointerdown', onMobilePress, true);
        document.addEventListener('touchstart', onMobilePress, true);
        document.addEventListener('pointerup', onMobileRelease);
        document.addEventListener('pointercancel', onMobileCancel);
        document.addEventListener('touchcancel', onMobileCancel);
    } else {
        container.addEventListener('mouseup', onMouseUp);
        container.addEventListener('keyup', onKeyUp);
    }
    // Capture na `document`: musi zdążyć ocenić klik PRZED tym, jak menu ewentualnie zniknie
    // z innego powodu (np. `blur` pola tekstowego wywołany tym samym klikiem).
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onDocKeyDown);
    container.addEventListener('scroll', onContainerScroll);

    return function uninstallSelectionMenu(): void {
        disposed = true;
        cancelSettle();
        for (const id of mouseTimers) timer.clearTimeout(id);
        mouseTimers.clear();
        removeMenu();
        document.removeEventListener('selectionchange', settleSelection);
        document.removeEventListener('pointerdown', onMobilePress, true);
        document.removeEventListener('touchstart', onMobilePress, true);
        document.removeEventListener('pointerup', onMobileRelease);
        document.removeEventListener('pointercancel', onMobileCancel);
        document.removeEventListener('touchcancel', onMobileCancel);
        container.removeEventListener('mouseup', onMouseUp);
        container.removeEventListener('keyup', onKeyUp);
        document.removeEventListener('mousedown', onDocMouseDown, true);
        document.removeEventListener('keydown', onDocKeyDown);
        container.removeEventListener('scroll', onContainerScroll);
    };
}
