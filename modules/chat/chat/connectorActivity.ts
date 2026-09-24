/**
 * @module connectorActivity
 * Łącznik (`.cs-connector-line`, `_drawConnectorLines` w `chat_messages.ts`) rysuje się
 * kosztowną, przeplataną odczytami layoutu funkcją - stąd `_scheduleConnectorRedraw`
 * (koalescencja do jednej klatki animacji) zamiast wołania jej bezpośrednio z każdego miejsca,
 * które zmienia geometrię listy wiadomości.
 *
 * Plik CELOWO wolny od `obsidian` i od importu CSS-modułowego - `chat_ui.ts` importuje
 * `chat_view.css` jako moduł (`import ... with { type: 'css' }`), którego AVA/Node nie potrafi
 * załadować bez dedykowanego loadera (`ERR_UNKNOWN_FILE_EXTENSION`), więc NIC importowanego z
 * `chat_ui.ts` nie da się dziś przetestować bezpośrednim importem. Cztery funkcje niżej nie
 * potrzebują ani `obsidian`, ani tego arkusza - mieszkają więc tutaj (ten sam wzorzec co
 * `renderThrottle.ts`/`turnAbort.ts`: decyzja w czystym pliku, mixin jest cienkim wołaczem),
 * `chat_ui.ts` re-eksportuje `_scheduleConnectorRedraw`/`_cancelConnectorRedraw`
 * (`export { ... } from './connectorActivity.js'`), więc nadal lądują na `ChatView.prototype`
 * przez `Object.assign(ChatView.prototype, uiMethods)` (`chat_view.ts`) - żaden wołacz
 * (`this._scheduleConnectorRedraw()` w `chat_streaming.ts` i w `chat_ui.ts` samym, patrz
 * `scrollToBottom`) nie widzi różnicy. Poprawka nieścisłości (recenzja niezależna): `chat_messages.ts`
 * NIE woła schedulera - jej `_drawConnectorLines` (linia ok. 319, `renderMessages`) skanuje
 * historię i rysuje łącznik WPROST, bez koalescencji do klatki animacji, bo dzieje się raz przy
 * pełnym przerenderowaniu listy, nie w gorącej pętli streamingu.
 */
import type { ChatViewLike } from './chatViewShape.js';

/**
 * JEDNO przerysowanie łączników na klatkę, nie na wywołanie.
 *
 * `_drawConnectorLines` usuwa i wstawia węzły przeplatając to z odczytami geometrii (layout
 * thrashing), a jego koszt rośnie z liczbą wiadomości w oknie. Wołaczy jest kilku i potrafią
 * strzelać seriami (przewijanie, status narzędzia, malowanie strumienia, rozwinięcie kafelka,
 * pierwsza treść dymka streamu) - dlatego zamiast rysować od razu, planujemy jedno rysowanie na
 * klatkę animacji.
 *
 * ⚠️ `requestAnimationFrame` NIE chodzi, gdy okno jest schowane - i dobrze: `getBoundingClientRect`
 * zwraca wtedy zera, więc rysowanie i tak dałoby śmieci. Zaległe rysowanie wykona się, gdy okno
 * wróci. Fallback na `setTimeout` dla środowisk bez rAF (harness/testy).
 */
export function _scheduleConnectorRedraw(this: ChatViewLike) {
    if (this._connectorRedrawCancel) return;
    const run = () => {
        this._connectorRedrawCancel = null;
        this._drawConnectorLines();
    };
    if (typeof requestAnimationFrame === 'function') {
        const handle = window.requestAnimationFrame(run);
        this._connectorRedrawCancel = () => cancelAnimationFrame(handle);
    } else {
        const handle = window.setTimeout(run, 16);
        this._connectorRedrawCancel = () => window.clearTimeout(handle);
    }
}

/** Rozbraja zaplanowane przerysowanie łączników (zamknięcie widoku). */
export function _cancelConnectorRedraw(this: ChatViewLike) {
    if (!this._connectorRedrawCancel) return;
    try { this._connectorRedrawCancel(); } catch { /* best-effort */ }
    this._connectorRedrawCancel = null;
}

/**
 * Decyzja delegowanego nasłuchu na `messages_container` (patrz `installMessagesContainerActivity`
 * niżej): rozwinięcie/zwinięcie kafelka (`.cs-tile__head`, klik albo Enter/Spacja - `Tile.ts`'s
 * `expand()`) zmienia wysokość SYNCHRONICZNIE w tym samym zdarzeniu, ale `_drawConnectorLines`
 * dotąd przerysowywał się tylko przy scrollu/streamingu/finalizacji tury - łącznik zostawał starą
 * geometrią (kończył się w połowie rozwiniętego kafelka albo wystawał w dół po zwinięciu).
 * Nasłuch kafelka (`Tile.ts`) odpala się PIERWSZY (bubbling), więc samo zaplanowanie
 * przerysowania tutaj - PO fakcie zmiany layoutu - wystarcza.
 *
 * Trzeci typ zdarzenia, `animationend` (naprawa recenzji niezależnej): `.cs-message--agent` i
 * `.cs-ask-user` wjeżdżają animacją wejścia (`cs-message-enter`, `translateY(6px) -> 0`,
 * `chat_view.css`) - nowy wyzwalacz (kliknięcie kafelka, pierwsza treść dymka, wstawienie bloku
 * myślenia…) strzela w PIERWSZEJ klatce animacji, gdy `getBoundingClientRect` liczy jeszcze
 * transform w trakcie animacji, nie pozycję końcową - kotwica wychodzi do 6px za nisko, aż do
 * KOLEJNEGO przerysowania (scroll, następny kafelek…). `animationend` bąbelkuje (CSS Animations
 * bąbelkują z definicji, w odróżnieniu od niektórych zdarzeń UI) z elementu animowanego do
 * `messages_container`, więc ten sam delegowany nasłuch łapie koniec animacji obu elementów bez
 * osobnego montowania per wiadomość.
 *
 * Wydzielona jako osobna funkcja (nie inline w instalatorze), żeby dało się testować bez
 * prawdziwego DOM-owego bubblingu: atrapa DOM harnessu (`dom-shim.ts`) ma
 * `addEventListener`/`dispatchEvent`/`closest`/`matches` jako CELOWE no-opy [measured, grep w
 * repo harnessu - `addEventListener() {}`, `dispatchEvent() { return true; }`,
 * `closest() { return null; }`, `matches() { return false; }`], więc test buduje WŁASNY fake
 * `target` z działającym `closest()` i woła tę funkcję wprost, z `ev.target` ustawionym na węzeł
 * w nagłówku kafelka (albo w kontenerze agenta/`.cs-ask-user`, dla `animationend`).
 */
export function onMessagesContainerActivity(view: ChatViewLike, ev: Event): void {
    // Adnotacja typu (nie `as` - `EventTarget` już strukturalnie spełnia `{closest?: ...}`,
    // rzutowanie byłoby zbędne dla TS, `@typescript-eslint/no-unnecessary-type-assertion`).
    const target: (EventTarget & { closest?: (selector: string) => Element | null }) | null = ev.target;
    if (ev.type === 'animationend') {
        if (!target?.closest?.('.cs-message--agent, .cs-ask-user')) return;
        view._scheduleConnectorRedraw();
        return;
    }
    let isActivateKey = false;
    if (ev.type !== 'click') {
        if (ev.type !== 'keydown') return;
        // Zawężenie `in` przed `as` (kolejność z CLAUDE.md „TypeScript i testy") - `Event` bazowy
        // nie deklaruje `key`, `in` sam nie zwęża TS-owo do `KeyboardEvent` (nie jest predykatem
        // typu), ale to on decyduje w RUNTIME, czy rzutowanie niżej jest bezpieczne.
        if (!('key' in ev)) return;
        const key = (ev as KeyboardEvent).key;
        isActivateKey = key === 'Enter' || key === ' ' || key === 'Spacebar';
        if (!isActivateKey) return;
    }
    if (!target?.closest?.('.cs-tile__head')) return;
    view._scheduleConnectorRedraw();
}

/**
 * JEDEN delegowany nasłuch na `messages_container` (`click` + `keydown` + `animationend`)
 * zamiast osobnego nasłuchu per kafelek - `messages_container` jest tworzony na nowo przy każdym
 * `renderView` (patrz gotcha „Sprzątanie" w `selectionMenu.ts`, ten sam wzorzec: `renderView`
 * odpina POPRZEDNI egzemplarz przed zamontowaniem nowego, `onClose` sprząta ostatni).
 *
 * @returns funkcja odpinająca wszystkie trzy nasłuchy.
 */
export function installMessagesContainerActivity(view: ChatViewLike): () => void {
    const container = view.messages_container;
    const onActivity = (ev: Event) => onMessagesContainerActivity(view, ev);
    container.addEventListener('click', onActivity);
    container.addEventListener('keydown', onActivity);
    container.addEventListener('animationend', onActivity);
    return function uninstallMessagesContainerActivity(): void {
        container.removeEventListener('click', onActivity);
        container.removeEventListener('keydown', onActivity);
        container.removeEventListener('animationend', onActivity);
    };
}
