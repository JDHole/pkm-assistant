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
export function installSelectionMenu(view: ChatViewLike): () => void {
    const container = view.messages_container;
    let menuEl: HTMLDivElement | null = null;

    function removeMenu(): void {
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
        if (!isInsideSelectable(range.commonAncestorContainer, container)) return null;
        return { text, range };
    }

    function afterAction(): void {
        removeMenu();
        window.getSelection?.()?.removeAllRanges();
    }

    function handleCopy(text: string): void {
        void navigator.clipboard.writeText(text).then(
            () => {
                view.plugin?.showCrystalNotice?.(t('chat.selection.copied'), { type: 'success', timeout: 2000 });
            },
            (e: unknown) => {
                log.warn('Chat', `Selection copy failed: ${(e as Error)?.message || String(e)}`);
            },
        );
        afterAction();
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
        const found = readSelection();
        removeMenu();
        if (!found) return;

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

    function onMouseUp(): void {
        // `window.getSelection()` w `mouseup` bywa jeszcze niezaktualizowany w części
        // przeglądarek - jedna mikro/makro-tura kolejki wystarcza, bez sztucznego czekania.
        window.setTimeout(showMenu, 0);
    }

    function onKeyUp(e: KeyboardEvent): void {
        if (!e.shiftKey || !e.key.startsWith('Arrow')) return;
        showMenu();
    }

    function onDocMouseDown(e: MouseEvent): void {
        if (!menuEl) return;
        const target = e.target as Node | null;
        if (target && menuEl.contains(target)) return;
        removeMenu();
    }

    function onDocKeyDown(e: KeyboardEvent): void {
        if (e.key === 'Escape') removeMenu();
    }

    function onContainerScroll(): void {
        removeMenu();
    }

    container.addEventListener('mouseup', onMouseUp);
    container.addEventListener('keyup', onKeyUp);
    // Capture na `document`: musi zdążyć ocenić klik PRZED tym, jak menu ewentualnie zniknie
    // z innego powodu (np. `blur` pola tekstowego wywołany tym samym klikiem).
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onDocKeyDown);
    container.addEventListener('scroll', onContainerScroll);

    return function uninstallSelectionMenu(): void {
        removeMenu();
        container.removeEventListener('mouseup', onMouseUp);
        container.removeEventListener('keyup', onKeyUp);
        document.removeEventListener('mousedown', onDocMouseDown, true);
        document.removeEventListener('keydown', onDocKeyDown);
        container.removeEventListener('scroll', onContainerScroll);
    };
}
