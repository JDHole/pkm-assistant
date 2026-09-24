import test from 'ava';
import { onMessagesContainerActivity, _scheduleConnectorRedraw } from './connectorActivity.js';
import { _paintStreamFrame, _chatOnToolCallsParsed } from './chat_streaming.js';

/**
 * Recenzja niezalezna (3d3b5fdd, punkt 1, "wazne"): przed tym plikiem `_scheduleConnectorRedraw`
 * byl wolany tylko przy scrollu/finalizacji tury - rozwiniecie/zwiniecie kafelka (`.cs-tile__head`)
 * i pierwsza tresc dymka/wstawienie bloku myslenia/kafelka narzedzia W TRAKCIE streamu zostawialy
 * stary lacznik (konczyl sie w polowie kafelka albo nie dociagal do nowego elementu, az do
 * `_finalizeTurn`).
 *
 * Dwie grupy testow:
 *  1. `onMessagesContainerActivity` - delegowany nasluch na `messages_container`
 *     (`installMessagesContainerActivity`, `chat_ui.ts`). Atrapa DOM harnessu (`dom-shim.ts`) ma
 *     `addEventListener`/`dispatchEvent`/`closest`/`matches` jako CELOWE no-opy [measured, grep
 *     w repo harnessu: `addEventListener() {}`, `dispatchEvent() { return true; }`,
 *     `closest() { return null; }`, `matches() { return false; }`], wiec te testy wolaja
 *     WYDZIELONA funkcje-handler wprost, z `ev.target` ustawionym na fake element z WLASNYM,
 *     dzialajacym `closest()` - nie dispatchuja prawdziwego zdarzenia. Uzywaja PRAWDZIWEGO
 *     `_scheduleConnectorRedraw` (nie mocka) z globalnym `requestAnimationFrame` podmienionym na
 *     synchroniczny, zeby dowiesc calego lancucha klik -> planowanie -> `_drawConnectorLines`,
 *     nie tylko "cos zostalo wywolane". Geometrie linii (pozycje x/y) weryfikuje wylacznie pomiar
 *     na zywo w Obsidianie - atrapa DOM nie ma silnika layoutu (`getBoundingClientRect` zwraca
 *     zera), wiec nie da sie jej odtworzyc tutaj.
 *  2. Wyzwalacze w `chat_streaming.ts` (`_paintStreamFrame`, `_chatOnToolCallsParsed`) - tu
 *     `_scheduleConnectorRedraw` jest STUBOWANY licznikiem, bo cel testu to WYLACZNIE to, KIEDY
 *     (i ile razy) produkcyjny kod go wola - sam scheduler ma juz swoje testy w grupie 1.
 */

type TestDynamic = any;

/** Podmienia globalny `requestAnimationFrame` na synchroniczny na czas testu (harness go
 *  definiuje jako `setTimeout(cb, 0)` - asynchroniczny, patrz `dom-shim.ts`). */
function useSyncRaf(t: TestDynamic): void {
    const orig = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        cb(0);
        return 0;
    }) as typeof requestAnimationFrame;
    t.teardown(() => { globalThis.requestAnimationFrame = orig; });
}

/** `this` minimalny dla PRAWDZIWEGO `_scheduleConnectorRedraw` - `_drawConnectorLines` stubowany
 *  licznikiem (jego wlasna poprawnosc geometryczna jest poza zakresem tego pliku). */
function buildSchedulerFakeThis() {
    let drawCount = 0;
    const fakeThis: TestDynamic = {
        _connectorRedrawCancel: null,
        _drawConnectorLines() { drawCount++; },
    };
    fakeThis._scheduleConnectorRedraw = function (this: TestDynamic) { return _scheduleConnectorRedraw.call(this); };
    return { fakeThis, getDrawCount: () => drawCount };
}

test('onMessagesContainerActivity: klik na wezle wewnatrz .cs-tile__head planuje przerysowanie (przez PRAWDZIWY _scheduleConnectorRedraw -> _drawConnectorLines)', t => {
    useSyncRaf(t);
    const { fakeThis, getDrawCount } = buildSchedulerFakeThis();
    const head = {};
    const target = { closest: (sel: string) => (sel === '.cs-tile__head' ? head : null) };

    onMessagesContainerActivity(fakeThis, { type: 'click', target } as TestDynamic);

    t.is(getDrawCount(), 1, 'klik na naglowku kafelka powinien skutkowac wywolaniem _drawConnectorLines przez scheduler');
});

test('onMessagesContainerActivity: klik POZA .cs-tile__head nie planuje przerysowania', t => {
    useSyncRaf(t);
    const { fakeThis, getDrawCount } = buildSchedulerFakeThis();
    const target = { closest: () => null };

    onMessagesContainerActivity(fakeThis, { type: 'click', target } as TestDynamic);

    t.is(getDrawCount(), 0, 'klik poza naglowkiem kafelka (np. w tresc dymka) nie powinien ruszac lacznika');
});

test('onMessagesContainerActivity: Enter/Spacja na .cs-tile__head planuje przerysowanie, inny klawisz nie', t => {
    useSyncRaf(t);
    const { fakeThis, getDrawCount } = buildSchedulerFakeThis();
    const head = {};
    const target = { closest: (sel: string) => (sel === '.cs-tile__head' ? head : null) };

    onMessagesContainerActivity(fakeThis, { type: 'keydown', key: 'a', target } as TestDynamic);
    t.is(getDrawCount(), 0, 'klawisz inny niz Enter/Spacja/Spacebar nie aktywuje kafelka, wiec nie planuje przerysowania');

    onMessagesContainerActivity(fakeThis, { type: 'keydown', key: 'Enter', target } as TestDynamic);
    t.is(getDrawCount(), 1, 'Enter na naglowku kafelka aktywuje go (Tile.ts) i powinien planowac przerysowanie');

    onMessagesContainerActivity(fakeThis, { type: 'keydown', key: ' ', target } as TestDynamic);
    t.is(getDrawCount(), 1, 'scheduler dlawi kolejne planowanie, dopoki poprzednie nie odpalilo (Spacja tu nie dokłada drugiego rysowania w tej samej klatce)');
});

test('onMessagesContainerActivity: zdarzenia inne niz click/keydown (np. scroll) nie planuja przerysowania', t => {
    useSyncRaf(t);
    const { fakeThis, getDrawCount } = buildSchedulerFakeThis();
    const target = { closest: () => ({}) };

    onMessagesContainerActivity(fakeThis, { type: 'scroll', target } as TestDynamic);

    t.is(getDrawCount(), 0);
});

// ── chat_streaming.ts: wyzwalacze w trakcie streamu (bez czekania na _finalizeTurn) ──

/** `StreamFrame`-owe `this` dla `_paintStreamFrame` - `_scheduleConnectorRedraw` stubowany
 *  licznikiem (jego wlasny lancuch jest zweryfikowany wyzej), `MarkdownRenderer.render`
 *  atrapy harnessu jest no-opem [measured, grep `test-support/obsidian.ts` repo harnessu], wiec
 *  DOM tresci i tak sie nie zmieni - trigger w produkcyjnym kodzie musi wiec stac na `_lastPaintedContent`,
 *  nie na odczycie DOM-u (tak jak jest zaimplementowany).
 */
function buildPaintFakeThis() {
    let scheduleCount = 0;
    const bubble: TestDynamic = { children: [] as TestDynamic[], insertBefore(node: TestDynamic, ref: TestDynamic) {
        const idx = ref ? this.children.indexOf(ref) : -1;
        if (idx === -1) this.children.push(node); else this.children.splice(idx, 0, node);
        return node;
    } };
    const textEl: TestDynamic = { empty() { /* no-op fake */ } };
    const fakeThis: TestDynamic = {
        current_message_container: bubble,
        current_message_bubble: null,
        current_message_text: textEl,
        chatTabs: [],
        app: {},
        _currentThinkingBlock: null,
        _lastPaintedContent: null,
        scrollToBottom() {},
        _scheduleConnectorRedraw() { scheduleCount++; },
    };
    return { fakeThis, getScheduleCount: () => scheduleCount };
}

test('_paintStreamFrame: PIERWSZA niepusta tresc (dymek traci :empty) planuje przerysowanie RAZ, kolejne rosnace klatki NIE dokladaja kolejnych', t => {
    const { fakeThis, getScheduleCount } = buildPaintFakeThis();

    _paintStreamFrame.call(fakeThis, { text: 'Cze', reasoning: '' } as TestDynamic);
    t.is(getScheduleCount(), 1, 'pierwsza klatka z tekstem - dymek dopiero teraz przestaje byc :empty, lacznik powinien to zlapac');

    _paintStreamFrame.call(fakeThis, { text: 'Czesc, jak', reasoning: '' } as TestDynamic);
    _paintStreamFrame.call(fakeThis, { text: 'Czesc, jak mozna pomoc?', reasoning: '' } as TestDynamic);
    t.is(getScheduleCount(), 1, 'rosnacy tekst W TEJ SAMEJ turze nie przesuwa srodka krysztalu (staly offset od gory dymka) - nie powinien hot-loopowac schedulera');
});

test('_paintStreamFrame: klatka z pustym text NIE planuje przerysowania (dymek zostaje :empty)', t => {
    const { fakeThis, getScheduleCount } = buildPaintFakeThis();

    _paintStreamFrame.call(fakeThis, { text: '', reasoning: '' } as TestDynamic);

    t.is(getScheduleCount(), 0);
});

test('_paintStreamFrame: WSTAWIENIE bloku myslenia (pierwsza klatka z reasoning) planuje przerysowanie RAZ, dopisywanie tresci (kolejne klatki) nie doklada kolejnych', t => {
    const { fakeThis, getScheduleCount } = buildPaintFakeThis();

    _paintStreamFrame.call(fakeThis, { text: '', reasoning: 'Zastanawiam sie' } as TestDynamic);
    t.is(getScheduleCount(), 1, 'nowy kafelek myslenia to nowa kotwica lacznika - powinien planowac przerysowanie od razu, nie czekac do konca tury');
    t.truthy(fakeThis._currentThinkingBlock, 'blok myslenia powinien powstac przy pierwszej klatce z reasoning');

    _paintStreamFrame.call(fakeThis, { text: '', reasoning: 'Zastanawiam sie dalej i dalej' } as TestDynamic);
    t.is(getScheduleCount(), 1, 'dopisanie tresci do ISTNIEJACEGO bloku myslenia (updateThinkingBlock) nie zmienia zbioru kotwic - nie powinno planowac kolejnego przerysowania');
});

/** `this` dla `_chatOnToolCallsParsed` - aktywna zakladka, kontener/bubble juz istnieja
 *  (`current_message_container`/`current_message_bubble` niepuste, wiec `_ensureAgentMessageContainer`
 *  sie nie wywoluje). */
function buildToolCallsFakeThis() {
    let scheduleCount = 0;
    const bubble: TestDynamic = { children: [] as TestDynamic[], appendChild(child: TestDynamic) { this.children.push(child); return child; } };
    const container: TestDynamic = { children: [bubble] };
    const fakeThis: TestDynamic = {
        _isTurnActiveTab: () => true,
        current_message_container: container,
        current_message_bubble: bubble,
        hideTypingIndicator() {},
        showTypingIndicator() {},
        _scheduleConnectorRedraw() { scheduleCount++; },
    };
    return { fakeThis, getScheduleCount: () => scheduleCount };
}

test('_chatOnToolCallsParsed: nowy kafelek narzedzia (Faza 1, aktywna zakladka) planuje przerysowanie lacznika', t => {
    const { fakeThis, getScheduleCount } = buildToolCallsFakeThis();
    const turn: TestDynamic = { watchdog: null, agent: null, agentName: 'Test' };
    const toolCalls: TestDynamic[] = [{ id: 'tc1', name: 'vault_read', arguments: {} }];

    _chatOnToolCallsParsed.call(fakeThis, turn, toolCalls);

    t.is(getScheduleCount(), 1, 'kafelek narzedzia wstawiony mid-stream to nowa kotwica lacznika - powinien planowac przerysowanie, nie czekac do konca tury');
    t.truthy(turn.toolCallsContainer, 'kontrola: kafelek faktycznie powinien wyladowac w kontenerze narzedzi');
});

test('_chatOnToolCallsParsed: zakladka w tle (nieaktywna) nie planuje przerysowania widoku, ktorego user nie widzi', t => {
    const { fakeThis, getScheduleCount } = buildToolCallsFakeThis();
    fakeThis._isTurnActiveTab = () => false;
    const turn: TestDynamic = { watchdog: null, agent: null, agentName: 'Test' };
    const toolCalls: TestDynamic[] = [{ id: 'tc1', name: 'vault_read', arguments: {} }];

    _chatOnToolCallsParsed.call(fakeThis, turn, toolCalls);

    t.is(getScheduleCount(), 0, 'lacznik zywy na EKRANIE usera nalezy do aktywnej zakladki - tura w tle nie powinna go ruszac');
});
