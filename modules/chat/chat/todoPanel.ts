/**
 * todoPanel.js — pure model dla live-widoku listy `todo` w czacie (E2.9 FAZA D / D2).
 *
 * Zastępuje dawny `ArtifactProgressModal` (polling 1s): odhaczana lista W SLOCIE inputu (N4 — pasek
 * dolny ma dwa widoki w tym samym obrysie), wzorzec Claude Code, aktualizowana po każdym tool-callu
 * `todo`. DOM render w `chat_ui.js`; tu żyje pure logika (co pokazać i który widok) → node-testowalne
 * bez obsidiana.
 */

/**
 * Zbuduj model widoku z surowego stanu narzędzia `todo` (result `{items, done, total, title, finished}`).
 * @param {Object|null} state
 * @returns {{visible:boolean, title:string|null, items:Array<{text:string, checked:boolean}>, done:number, total:number, allDone:boolean}}
 */
type TodoItemInput = { text?: unknown; checked?: unknown; done?: unknown };
type TodoState = { items?: TodoItemInput[]; title?: string; finished?: boolean };
// AUD-dead-code-231 (2026-09-02): `export` zdjęty (tu i na `BottomBarMode` niżej) — zero
// referencji spoza tego pliku; funkcje/stałe, których sygnatury je noszą (`buildTodoPanelModel`,
// `resolveBottomBarMode`, `DEFAULT_BOTTOM_BAR_MODE`), zostają publiczne.
type TodoPanelModel = {
    visible: boolean;
    title: string | null;
    items: Array<{ text: string; checked: boolean }>;
    done: number;
    total: number;
    allDone: boolean;
};

export function buildTodoPanelModel(state: TodoState | null | undefined): TodoPanelModel {
    const items: TodoItemInput[] = Array.isArray(state?.items) ? state.items : [];
    const normalized = items.map(i => ({ text: String(i?.text ?? ''), checked: !!(i?.checked ?? i?.done) }));
    const total = normalized.length;
    const done = normalized.filter(i => i.checked).length;
    // Panel znika, gdy lista zamknięta (`finished`) lub pusta — nic nie zaśmieca UI.
    const visible = !state?.finished && total > 0;
    return {
        visible,
        title: state?.title || null,
        items: normalized,
        done,
        total,
        allDone: total > 0 && done === total,
    };
}

/** Który widok pokazuje pasek dolny: pole tekstowe czy lista `todo`. */
type BottomBarMode = 'input' | 'todo';

/** Startowy widok paska (i ten, do którego wracamy, gdy nie ma czego pokazać). */
export const DEFAULT_BOTTOM_BAR_MODE: BottomBarMode = 'input';

/**
 * Rozstrzygnij widok paska po odświeżeniu stanu `todo` (N4).
 *
 * Reguły:
 *  - lista pojawia się (brak/finished → aktywna) → AUTO-PRZESKOK na 'todo',
 *    **chyba że user ma niewysłany szkic** — wtedy zostaje pole tekstowe (patrz `hasDraft`),
 *  - lista znika (finish/pusta) → powrót na 'input' (nie ma czego pokazywać w slocie),
 *  - update itemów w trakcie życia listy → BEZ zmiany: ręczny wybór usera jest respektowany.
 *
 * @param {Object|null} prev - model z poprzedniego renderu (null = pierwszy render)
 * @param {Object} next - świeży model
 * @param {'input'|'todo'} current - widok pokazywany w tej chwili
 * @param {boolean} hasDraft - czy w polu tekstowym siedzi niewysłany szkic usera
 * @returns {'input'|'todo'}
 */
export function resolveBottomBarMode(
    prev: TodoPanelModel | null | undefined,
    next: TodoPanelModel,
    current: BottomBarMode = DEFAULT_BOTTOM_BAR_MODE,
    hasDraft = false,
): BottomBarMode {
    if (!next?.visible) return 'input';
    // Śledztwo Z3 (FAIL 6 smoke'a 2026-08-15): auto-przeskok chował CAŁY wiersz inputu
    // (`display:none`), więc szkic pisany w trakcie tury po prostu ZNIKAŁ userowi z oczu
    // przy tool-callu `todo` — mimo że wartość textarea była nietknięta. Lista i tak jest
    // o jedno kliknięcie chipa `📋`, a niewysłany tekst usera jest ważniejszy.
    if (!prev?.visible) return hasDraft ? 'input' : 'todo';
    return current === 'todo' ? 'todo' : 'input';
}
