/**
 * Notatki klikalne wszedzie (spec C, "Czat bez scian" 2.3.0). Werdykt wlasciciela: "jak jest
 * odczyt jakiejs notatki to musi byc mozliwosc otwarcia jej w nowym oknie w Obsidianie (...)
 * przy wyszukiwaniu i w ogole w kazdym momencie jak sie gdziekolwiek pokazuja notatki z vaulta
 * to mozna kliknac nazwe i otwiera sie ona w osobnym glownym oknie".
 *
 * `ui-components` nie zna `app`/`obsidian` (zlota zasada tego modulu - patrz CLAUDE.md, "same
 * funkcje budujace DOM + klasy sterujace widgetem"), wiec otwieranie realizuje WOLACZ przez
 * rejestr openera: widok czatu ustawia go w `renderView` (`setNoteOpener`); jeden opener na
 * plugin, kazdy kolejny render nadpisuje poprzedni. Fabryka openera jest ZDEFINIOWANA poza
 * `renderView` (wolana z niego), wiec jej callback nie dzieli kontekstu ze strzalkami widoku
 * i trzyma tylko `app`, nie widok.
 * Opener zalezy wylacznie od globalnego `app`
 * (`workspace.openLinkText`), wiec zamkniecie widoku go nie uniewaznia i NIE ma sprzatania w
 * `onClose` - swiadomie: dwa otwarte widoki czatu dziela jeden rejestr, a `null` z jednego z nich
 * odbieralby klikalnosc drugiemu (recenzja C). Bez
 * zarejestrowanego openera (test, render poza czatem) link jest zwyklym, NIEKLIKALNYM `span`
 * z tym samym tekstem - nigdy nie wybucha i nigdy nie sugeruje klikalnosci, ktorej nie ma.
 */

/** Lazy odczyt `document` (wzor `_createDetachedEl` w `Tile.ts`/`ToolCallDisplay.ts` tego
 *  modulu) - `obsidianmd/prefer-create-el` patrzy na STRUKTURE typu golego
 *  `document.createElement`, wiec czytamy go dopiero przy wywolaniu, rzutowanego na wazki typ.
 *  W prawdziwym Obsidianie to dokladnie ten sam `document.createElement`, ktorego woluja
 *  `createDiv`/`createEl`/`createSpan` pod maska - zero zmiany zachowania. */
function _createDetachedEl(tag: string): HTMLElement {
    return (document as unknown as { createElement(tag: string): HTMLElement }).createElement(tag);
}

export type NoteOpener = (path: string, ev: MouseEvent) => void;

let _opener: NoteOpener | null = null;

/**
 * Rejestr openera modulu - JEDEN aktywny naraz (ostatni `setNoteOpener` wygrywa). Widok czatu
 * jest jedynym miejscem w repo, ktore zna `app` i wie, jak otworzyc notatke w glownym oknie -
 * ustawia opener w `renderView`; sprzatania w `onClose` nie ma (patrz naglowek pliku).
 */
export function setNoteOpener(opener: NoteOpener | null): void {
    _opener = opener;
}

/**
 * Otwiera notatke przez zarejestrowany opener (ten sam mechanizm co linki `createNoteLink`).
 * Zwraca `false`, gdy openera nie ma - wolacz decyduje o fallbacku (np. karta artefaktu w
 * `modules/chat/chat/machineTile.ts` spada na `plugin.openNote`).
 */
export function openNoteWithRegistry(path: string, ev: MouseEvent): boolean {
    if (!_opener) return false;
    _opener(path, ev);
    return true;
}

const NOTE_EXTENSIONS = /\.(md|canvas|base)$/;

/**
 * Sciezka notatki/pliku vaulta, jaki dzis umie otworzyc Obsidian: `.md`/`.canvas`/`.base`, bez
 * protokolu (`https://`, `obsidian://`...) i bez bialych znakow na koncach (ucieta/dopisana
 * spacja z modelu albo z markdown-parsera) i bez ukrytego segmentu (`.pkm-assistant/...`,
 * `.obsidian/...`: Obsidian nie otwiera ich jako notatek - klik dawalby pusta karte, recenzja C).
 * Tabela literalow w tescie (`noteLink.test.ts`).
 */
export function isVaultNotePath(s: string): boolean {
    if (typeof s !== 'string' || s.length === 0) return false;
    if (s !== s.trim()) return false;
    if (s.includes('://')) return false;
    if (s.split(/[\\/]/).some(seg => seg.startsWith('.'))) return false;
    // Schemat bez `//` (`obsidian:`, `mailto:`...) - wiodacy identyfikator + dwukropek.
    if (/^[a-zA-Z][\w+.-]*:/.test(s)) return false;
    return NOTE_EXTENSIONS.test(s);
}

/** Nazwa pliku bez folderow i bez rozszerzenia - domyslny tekst linku, gdy wolacz nie poda `label`. */
function _basenameNoExt(path: string): string {
    const base = path.replace(/\\/g, '/').split('/').pop() || path;
    const idx = base.lastIndexOf('.');
    return idx > 0 ? base.slice(0, idx) : base;
}

/**
 * `a.cs-note-link[data-path]` klikalny przez zarejestrowany opener (`setNoteOpener`); klik woła
 * `opener(path, ev)` z DOKLADNA sciezka, `preventDefault` zeby `href="#"` nie skoczyl po
 * stronie. Bez openera - zwykly `span.cs-note-link[data-path]`, bez `href`, bez listenera
 * (nieklikalny, ale wizualnie ten sam tekst).
 */
export function createNoteLink(parent: HTMLElement, path: string, label?: string): HTMLElement {
    const text = label || _basenameNoExt(path);
    const opener = _opener;
    const el = _createDetachedEl(opener ? 'a' : 'span');
    el.className = 'cs-note-link';
    el.textContent = text;
    el.setAttribute('data-path', path);
    if (opener) {
        (el as unknown as { href: string }).href = '#';
        el.addEventListener('click', (ev: Event) => {
            ev.preventDefault();
            opener(path, ev as MouseEvent);
        });
    }
    parent.appendChild(el);
    return el;
}
