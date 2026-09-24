/**
 * `_handleTriggerKeyDown`/`_handleTriggerInput` (`chat_ui.ts`) - popup wyzwalaczy (`TriggerPopup`)
 * otwiera się WYŁĄCZNIE po `/`. `@` zostaje dla `MentionAutocomplete` (notatki/foldery,
 * `modules/ui-components/MentionAutocomplete.ts`), który ma WŁASNY nasłuch `input` i nie
 * przechodzi przez ten popup w ogóle.
 *
 * `chat_ui.ts` importuje `../chat_view.css` z asercją `type: 'css'` - Node/AVA nie ma loadera dla
 * tego rozszerzenia (`ERR_UNKNOWN_FILE_EXTENSION`, empirycznie zweryfikowane próbnym importem
 * przed napisaniem tego testu), więc AVA nie może zaimportować pliku wprost, mimo że same
 * funkcje pod testem nie dotykają ani CSS, ani obsidian. Wzór jak `manualCompression.test.ts` w
 * tym samym katalogu: wyciągamy CIAŁO funkcji z tekstu źródła i uruchamiamy je jako prawdziwy JS
 * przez `new Function(...)` - to jest test ZACHOWANIA (prawdziwe rozgałęzienia if/else z pliku
 * produkcyjnego), nie regex po tekście.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const uiSource = readFileSync(fileURLToPath(new URL('./chat_ui.ts', import.meta.url)), 'utf8');

/** Wyciąga ciało `export function <name>(this: ChatViewLike, ...) { ... }` po nazwie sygnatury. */
function extractBody(source: string, signatureNeedle: string): string {
    const start = source.indexOf(signatureNeedle);
    if (start < 0) throw new Error(`nie znaleziono sygnatury: ${signatureNeedle}`);
    const braceStart = source.indexOf('{', source.indexOf(')', start));
    let depth = 1;
    let i = braceStart + 1;
    while (depth > 0 && i < source.length) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') depth--;
        i++;
    }
    return source.slice(braceStart + 1, i - 1);
}

// ── _handleTriggerKeyDown: `/` planuje otwarcie, `@` nie ────────────────────

const keyDownBody = extractBody(uiSource, 'export function _handleTriggerKeyDown(this: ChatViewLike, e: KeyboardEvent) {');

function makeHandleTriggerKeyDown() {
    // `window.setTimeout` jest jedyną zależnością globalną ciała - wstrzykujemy prawdziwy
    // `setTimeout` pod nazwą `window`, żeby zachowanie (planowanie na tick) było realne, nie
    // atrapą syntetyczną.
    const factory = new Function('window', `return function(e) {${keyDownBody}};`);
    return factory({ setTimeout }) as (this: unknown, e: Record<string, unknown>) => void;
}

function makeFakeThisForKeyDown(value: string, selectionStart: number) {
    const openCalls: unknown[][] = [];
    const fakeThis = {
        _triggerPopup: null as { isOpen(): boolean; handleKeyDown(e: unknown): boolean } | null,
        input_area: { value, selectionStart },
        _openTriggerPopup(...args: unknown[]) { openCalls.push(args); },
    };
    return { fakeThis, openCalls };
}

test('_handleTriggerKeyDown: Enter skonsumowany przez popup NIE odpala drugiego nasłuchu klawiatury (stopImmediatePropagation, nie stopPropagation)', t => {
    // Regresja sprzed tej naprawy: `_handleTriggerKeyDown` wołał `e.stopPropagation()`, który
    // zatrzymuje TYLKO bąbelkowanie do przodków - nie inne nasłuchy `keydown` na TYM SAMYM
    // elemencie. `chat_ui.ts`'s `renderView` wiesza na `input_area` DWA nasłuchy `keydown`: ten
    // popupu (linia ~203, PIERWSZY) i `handle_input_keydown` (linia ~320, DRUGI - Enter bez Shift
    // woła `send_message`). Prawdziwy `EventTarget` z Node (nie atrapa) odzwierciedla realną
    // semantykę `stopImmediatePropagation` - drugi nasłuch na TYM SAMYM elemencie, zarejestrowany
    // PO pierwszym, dostaje zdarzenie tylko gdy pierwszy go nie zatrzymał.
    const handleTriggerKeyDown = makeHandleTriggerKeyDown();

    function makeFakeThisForPropagation(popupConsumes: boolean) {
        return {
            _triggerPopup: { isOpen: () => true, handleKeyDown: () => popupConsumes },
            input_area: { value: '', selectionStart: 0 },
            _openTriggerPopup() { /* nieużywane w tym teście - popup już otwarty */ },
        };
    }

    // Enter, popup otwarty i konsumuje klawisz (np. commit wyboru pozycji) -> drugi nasłuch NIE odpala.
    const consumingTarget = new EventTarget();
    let sendCallsConsumed = 0;
    const consumingThis = makeFakeThisForPropagation(true);
    consumingTarget.addEventListener('keydown', (e) => handleTriggerKeyDown.call(consumingThis, e as unknown as Record<string, unknown>));
    consumingTarget.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' && !e.shiftKey) sendCallsConsumed++; });
    const enterEvent = new Event('keydown', { cancelable: true });
    Object.assign(enterEvent, { key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false });
    consumingTarget.dispatchEvent(enterEvent);
    t.is(sendCallsConsumed, 0, 'popup skonsumował Enter (stopImmediatePropagation) - drugi nasłuch (send) nie odpalił się');

    // Kontrola pozytywna: zwykła litera, popup NIE konsumuje (handleKeyDown zwraca false) -> drugi nasłuch odpala normalnie.
    const passthroughTarget = new EventTarget();
    let sendCallsPassthrough = 0;
    const passthroughThis = makeFakeThisForPropagation(false);
    passthroughTarget.addEventListener('keydown', (e) => handleTriggerKeyDown.call(passthroughThis, e as unknown as Record<string, unknown>));
    passthroughTarget.addEventListener('keydown', (e: any) => { if (e.key === 'a') sendCallsPassthrough++; });
    const letterEvent = new Event('keydown', { cancelable: true });
    Object.assign(letterEvent, { key: 'a', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false });
    passthroughTarget.dispatchEvent(letterEvent);
    t.is(sendCallsPassthrough, 1, 'popup nie skonsumował zwykłej litery - drugi nasłuch odpalił się jak dotąd');
});

test('_handleTriggerKeyDown: `/` na początku pola planuje otwarcie popupu, `@` w tej samej sytuacji nie otwiera nic', async t => {
    const handleTriggerKeyDown = makeHandleTriggerKeyDown();

    // Klawisz `/` na pustym polu (cursor 0) → planuje _openTriggerPopup(0) na tick (setTimeout 0).
    const slash = makeFakeThisForKeyDown('', 0);
    handleTriggerKeyDown.call(slash.fakeThis, { key: '/', ctrlKey: false, metaKey: false, altKey: false });
    t.deepEqual(slash.openCalls, [], 'przed tickiem popup jeszcze się nie otworzył (setTimeout 0 jest asynchroniczny)');
    await new Promise(resolve => setTimeout(resolve, 10));
    t.deepEqual(slash.openCalls, [[0]], '`/` w pozycji 0 planuje _openTriggerPopup z triggerPos=0');

    // Klawisz `@` w IDENTYCZNEJ sytuacji → TriggerPopup nie reaguje w ogóle (MentionAutocomplete
    // ma własny, niezależny nasłuch - ten popup ma teraz `if (e.key !== '/') return;`).
    const at = makeFakeThisForKeyDown('', 0);
    handleTriggerKeyDown.call(at.fakeThis, { key: '@', ctrlKey: false, metaKey: false, altKey: false });
    await new Promise(resolve => setTimeout(resolve, 10));
    t.deepEqual(at.openCalls, [], '`@` nie planuje żadnego otwarcia TriggerPopup - popup wyzwalaczy zostaje wyłącznie dla `/`');
});

// ── _handleTriggerInput: `@` na pozycji wyzwalacza zamyka otwarty popup ─────

const inputBody = extractBody(uiSource, 'export function _handleTriggerInput(this: ChatViewLike) {');

function makeHandleTriggerInput() {
    const factory = new Function('return function() {' + inputBody + '};');
    return factory() as (this: unknown) => void;
}

function makeFakeThisForInput(value: string, selectionStart: number, triggerPos: number) {
    const closeCalls: number[] = [];
    const setFilterCalls: string[] = [];
    let closeCount = 0;
    const fakeThis = {
        _triggerPopup: {
            isOpen: () => true,
            setFilter: (f: string) => { setFilterCalls.push(f); },
        },
        input_area: { value, selectionStart },
        _triggerPos: triggerPos,
        _closeTriggerPopup() { closeCount++; closeCalls.push(closeCount); },
    };
    return { fakeThis, closeCalls, setFilterCalls };
}

test('_handleTriggerInput: popup otwarty + `@` na pozycji wyzwalacza → zamyka popup zamiast filtrować (dziś `@` przechodził)', t => {
    const handleTriggerInput = makeHandleTriggerInput();

    // Pole: "@foo", trigger był wstawiony na pozycji 0 (jest tam `@`, nie `/`), kursor na końcu.
    const atCase = makeFakeThisForInput('@foo', 4, 0);
    handleTriggerInput.call(atCase.fakeThis);
    t.deepEqual(atCase.closeCalls, [1], 'popup zamyka się, bo znak na pozycji wyzwalacza to `@`, nie `/`');
    t.deepEqual(atCase.setFilterCalls, [], 'filtr nigdy nie jest wołany dla wyzwalacza `@`');

    // Kontrola pozytywna: to samo pole, ale trigger to `/`, dalej filtruje jak dotąd.
    const slashCase = makeFakeThisForInput('/foo', 4, 0);
    handleTriggerInput.call(slashCase.fakeThis);
    t.deepEqual(slashCase.closeCalls, [], '`/` na pozycji wyzwalacza nie zamyka popupu');
    t.deepEqual(slashCase.setFilterCalls, ['foo'], '`/` dalej filtruje po tym, co user dopisał');
});

test('_handleTriggerInput: filtr zawierający `@` zamyka popup zamiast filtrować (`/@` - user wpisał `/`, potem `@`)', t => {
    const handleTriggerInput = makeHandleTriggerInput();

    // Pole "/@": trigger na pozycji 0 to `/` (popup poprawnie otwarty), ale FILTR (to, co user
    // dopisał PO triggerze) to "@" - MentionAutocomplete ma własny, niezależny nasłuch `input` na
    // TYM SAMYM polu i jego regex (`/@(folder:)?([^\s@]*)$/`) też złapie ten znak. Bez tej bramki
    // oba popupy stały otwarte naraz (TriggerPopup z pustą, nieużyteczną listą pod filtrem "@").
    const atInFilterCase = makeFakeThisForInput('/@', 2, 0);
    handleTriggerInput.call(atInFilterCase.fakeThis);
    t.deepEqual(atInFilterCase.closeCalls, [1], 'popup zamyka się, bo filtr zawiera `@` - MentionAutocomplete przejmuje pole');
    t.deepEqual(atInFilterCase.setFilterCalls, [], 'setFilter nie jest wołany, gdy filtr zawiera `@`');

    // Kontrola pozytywna: zwykły filtr bez `@` dalej filtruje jak dotąd.
    const normalCase = makeFakeThisForInput('/sa', 3, 0);
    handleTriggerInput.call(normalCase.fakeThis);
    t.deepEqual(normalCase.closeCalls, [], '`/sa` bez `@` nie zamyka popupu');
    t.deepEqual(normalCase.setFilterCalls, ['sa'], '`/sa` dalej filtruje jak dotąd');
});
