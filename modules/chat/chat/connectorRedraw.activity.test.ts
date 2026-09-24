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
 * Dwie grupy testow, OBIE dzis przez PRAWDZIWY `_scheduleConnectorRedraw` (nie stub-licznik na
 * samo wywolanie) - naprawa recenzji niezaleznej COMMITU `caa7affa` (punkty 3/4): stub liczyl
 * TYLKO to, ile razy produkcyjny kod ZAWOLAL schedulera, nie to, czy cokolwiek faktycznie sie
 * przerysowalo - regresja w samym schedulerze (koalescencja, `_connectorRedrawCancel`) przeszlaby
 * bez zgrzytu. Dzis obie grupy licza wywolania `_drawConnectorLines` PRZEZ prawdziwy scheduler.
 *
 *  1. `onMessagesContainerActivity` - delegowany nasluch na `messages_container`
 *     (`installMessagesContainerActivity`, `chat_ui.ts`). Atrapa DOM harnessu (`dom-shim.ts`) ma
 *     `addEventListener`/`dispatchEvent`/`closest`/`matches` jako CELOWE no-opy [measured, grep
 *     w repo harnessu: `addEventListener() {}`, `dispatchEvent() { return true; }`,
 *     `closest() { return null; }`, `matches() { return false; }`], wiec te testy wolaja
 *     WYDZIELONA funkcje-handler wprost, z `ev.target` ustawionym na fake element z WLASNYM,
 *     dzialajacym `closest()` - nie dispatchuja prawdziwego zdarzenia.
 *  2. Wyzwalacze w `chat_streaming.ts` (`_paintStreamFrame`, `_chatOnToolCallsParsed`) - TA SAMA
 *     technika (prawdziwy `_scheduleConnectorRedraw` + `_drawConnectorLines` jako licznik).
 *
 * Geometrie linii (pozycje x/y) weryfikuje wylacznie pomiar na zywo w Obsidianie - atrapa DOM nie
 * ma silnika layoutu (`getBoundingClientRect` zwraca zera), wiec nie da sie jej odtworzyc tutaj.
 */

type TestDynamic = any;

/**
 * Podmienia globalny `requestAnimationFrame`/`cancelAnimationFrame` na atrape z KOLEJKA i
 * recznym `flush()` - naprawa recenzji niezaleznej (BLOKER na wersji poprzedniej, `useSyncRaf`).
 *
 * `useSyncRaf` (poprzednia wersja tego pliku) podmieniala `requestAnimationFrame` na funkcje
 * wolajaca callback SYNCHRONICZNIE, W SRODKU wywolania `window.requestAnimationFrame(run)`. W
 * `_scheduleConnectorRedraw` (`connectorActivity.ts`) przypisanie
 * `this._connectorRedrawCancel = () => cancelAnimationFrame(handle)` stoi PO tym wywolaniu - z
 * synchronicznym mockiem `run()` zdazyl juz ustawic `_connectorRedrawCancel = null` I NAMALOWAC
 * klatke, zanim ta linia nadpisala je z powrotem na NIEPUSTA wartosc. Skutek: po PIERWSZYM
 * udanym zaplanowaniu `_connectorRedrawCancel` zostawal trwale niepusty, wiec KAZDE kolejne
 * planowanie w tym samym tescie bylo dlawione - test przechodzil nawet gdyby kod pod testem
 * (np. rozpoznawanie klawisza Spacja) w ogole nie dzialal (kontrola z CLAUDE.md: "czy test
 * przejdzie, gdy funkcja pod testem nic nie robi" - tu przechodzil).
 *
 * Atrapa z kolejka odzwierciedla PRAWDZIWY (asynchroniczny) rAF: `requestAnimationFrame` tylko
 * REJESTRUJE callback i zwraca id, nic nie wykonuje od razu - `_scheduleConnectorRedraw` konczy
 * przypisanie `_connectorRedrawCancel` PRZED jakimkolwiek wywolaniem `run()`, dokladnie jak w
 * przegladarce. `flush()` odpala zakolejkowane callbacki na zadanie testu (rownowaznik jednej
 * klatki animacji).
 *
 * Kolejnosc w `connectorActivity.ts` (przypisanie `_connectorRedrawCancel` PO wywolaniu rAF) NIE
 * jest wiec wyscigiem w runtime - prawdziwy `requestAnimationFrame` jest zawsze asynchroniczny
 * (nastepna klatka), a `run()` nie ma jak wystartowac przed dokonczeniem biezacego wywolania
 * `_scheduleConnectorRedraw`. Wyscig istnial WYLACZNIE w starym, synchronicznym mocku testowym.
 */
function useQueuedRaf(t: TestDynamic): { flush: () => void } {
    const origRaf = globalThis.requestAnimationFrame;
    const origCaf = globalThis.cancelAnimationFrame;
    let queue: Array<{ id: number; cb: FrameRequestCallback }> = [];
    let nextId = 1;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        const id = nextId++;
        queue.push({ id, cb });
        return id;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => {
        queue = queue.filter(item => item.id !== id);
    }) as typeof cancelAnimationFrame;
    t.teardown(() => {
        globalThis.requestAnimationFrame = origRaf;
        globalThis.cancelAnimationFrame = origCaf;
    });
    return {
        flush(): void {
            const pending = queue;
            queue = [];
            pending.forEach(item => item.cb(0));
        },
    };
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

test('onMessagesContainerActivity: klik na wezle wewnatrz .cs-tile__head planuje przerysowanie (przez PRAWDZIWY _scheduleConnectorRedraw -> _drawConnectorLines, po flush)', t => {
    const { flush } = useQueuedRaf(t);
    const { fakeThis, getDrawCount } = buildSchedulerFakeThis();
    const head = {};
    const target = { closest: (sel: string) => (sel === '.cs-tile__head' ? head : null) };

    onMessagesContainerActivity(fakeThis, { type: 'click', target } as TestDynamic);
    flush();

    t.is(getDrawCount(), 1, 'klik na naglowku kafelka powinien skutkowac wywolaniem _drawConnectorLines przez scheduler');
});

test('onMessagesContainerActivity: klik POZA .cs-tile__head nie planuje przerysowania; krok pozytywny w tej samej fixturze (klik NA naglowku) potem tak', t => {
    const { flush } = useQueuedRaf(t);
    const { fakeThis, getDrawCount } = buildSchedulerFakeThis();
    const outsideTarget = { closest: () => null };

    onMessagesContainerActivity(fakeThis, { type: 'click', target: outsideTarget } as TestDynamic);
    flush();
    t.is(getDrawCount(), 0, 'klik poza naglowkiem kafelka (np. w tresc dymka) nie powinien ruszac lacznika');

    const head = {};
    const headTarget = { closest: (sel: string) => (sel === '.cs-tile__head' ? head : null) };
    onMessagesContainerActivity(fakeThis, { type: 'click', target: headTarget } as TestDynamic);
    flush();
    t.is(getDrawCount(), 1, 'krok pozytywny: ta sama fixtura, klik NA naglowku powinien jednak zaplanowac przerysowanie');
});

test('onMessagesContainerActivity: Enter/Spacja na .cs-tile__head planuja KAZDE swoje przerysowanie (osobne klatki), inny klawisz nie', t => {
    const { flush } = useQueuedRaf(t);
    const { fakeThis, getDrawCount } = buildSchedulerFakeThis();
    const head = {};
    const target = { closest: (sel: string) => (sel === '.cs-tile__head' ? head : null) };

    onMessagesContainerActivity(fakeThis, { type: 'keydown', key: 'a', target } as TestDynamic);
    flush();
    t.is(getDrawCount(), 0, 'klawisz inny niz Enter/Spacja/Spacebar nie aktywuje kafelka, wiec nie planuje przerysowania');

    onMessagesContainerActivity(fakeThis, { type: 'keydown', key: 'Enter', target } as TestDynamic);
    flush();
    t.is(getDrawCount(), 1, 'Enter na naglowku kafelka aktywuje go (Tile.ts) i powinien planowac przerysowanie');

    onMessagesContainerActivity(fakeThis, { type: 'keydown', key: ' ', target } as TestDynamic);
    flush();
    t.is(getDrawCount(), 2, 'Spacja na naglowku TEZ aktywuje kafelek - osobna klatka (flush po Enterze juz odpalil poprzednie planowanie), wiec dopisuje KOLEJNE przerysowanie, nie zeruje sie do niego');

    onMessagesContainerActivity(fakeThis, { type: 'keydown', key: 'a', target } as TestDynamic);
    flush();
    t.is(getDrawCount(), 2, 'klawisz inny niz aktywujacy po dwoch udanych planowaniach nadal nie dopisuje trzeciego');
});

test('onMessagesContainerActivity: dwa planowania PRZED jednym flush koalescuja sie do JEDNEGO przerysowania', t => {
    const { flush } = useQueuedRaf(t);
    const { fakeThis, getDrawCount } = buildSchedulerFakeThis();
    const head = {};
    const target = { closest: (sel: string) => (sel === '.cs-tile__head' ? head : null) };

    onMessagesContainerActivity(fakeThis, { type: 'click', target } as TestDynamic);
    onMessagesContainerActivity(fakeThis, { type: 'keydown', key: 'Enter', target } as TestDynamic);
    flush();

    t.is(getDrawCount(), 1, 'dwa zdarzenia PRZED flushem to jedna klatka animacji - scheduler dlawi drugie planowanie (_connectorRedrawCancel juz niepusty), wiec wychodzi JEDNO przerysowanie');
});

test('onMessagesContainerActivity: zdarzenia inne niz click/keydown (np. scroll) nie planuja przerysowania; krok pozytywny w tej samej fixturze (klik NA naglowku) potem tak', t => {
    const { flush } = useQueuedRaf(t);
    const { fakeThis, getDrawCount } = buildSchedulerFakeThis();
    const anyTarget = { closest: () => ({}) };

    onMessagesContainerActivity(fakeThis, { type: 'scroll', target: anyTarget } as TestDynamic);
    flush();
    t.is(getDrawCount(), 0, 'scroll nie jest ani click ani keydown - nie powinien ruszac lacznika, niezaleznie od tego, co zwraca closest()');

    const head = {};
    const headTarget = { closest: (sel: string) => (sel === '.cs-tile__head' ? head : null) };
    onMessagesContainerActivity(fakeThis, { type: 'click', target: headTarget } as TestDynamic);
    flush();
    t.is(getDrawCount(), 1, 'krok pozytywny: ta sama fixtura, klik NA naglowku powinien jednak zaplanowac przerysowanie');
});

test('onMessagesContainerActivity: animationend z celem W kontenerze agenta/ask_user planuje przerysowanie (koniec animacji wejscia cs-message-enter), z celem POZA nim nie', t => {
    const { flush } = useQueuedRaf(t);
    const { fakeThis, getDrawCount } = buildSchedulerFakeThis();

    // Negatyw: animationend czegos, co nie jest ani wewnatrz .cs-message--agent, ani .cs-ask-user
    // (np. inny element z wlasna animacja gdzies indziej w drzewie wiadomosci).
    const outsideTarget = { closest: () => null };
    onMessagesContainerActivity(fakeThis, { type: 'animationend', target: outsideTarget } as TestDynamic);
    flush();
    t.is(getDrawCount(), 0, 'animationend spoza kontenera agenta/ask_user nie powinien ruszac lacznika');

    // Pozytyw: cel wewnatrz .cs-message--agent (koniec animacji wejscia calego kontenera agenta).
    const agentEl = {};
    const agentTarget = { closest: (sel: string) => (sel === '.cs-message--agent, .cs-ask-user' ? agentEl : null) };
    onMessagesContainerActivity(fakeThis, { type: 'animationend', target: agentTarget } as TestDynamic);
    flush();
    t.is(getDrawCount(), 1, 'animationend z celem w kontenerze agenta (koniec cs-message-enter, translateY(6px) -> 0) powinien zaplanowac przerysowanie - inaczej lacznik kotwiczy 6px za nisko az do nastepnego przerysowania');
});

// ── chat_streaming.ts: wyzwalacze w trakcie streamu (bez czekania na _finalizeTurn) ──

/** `StreamFrame`-owe `this` dla `_paintStreamFrame` - PRAWDZIWY `_scheduleConnectorRedraw`
 *  (jak w grupie 1), `_drawConnectorLines` stubowany licznikiem. `MarkdownRenderer.render`
 *  atrapy harnessu jest no-opem [measured, grep `test-support/obsidian.ts` repo harnessu], wiec
 *  DOM tresci i tak sie nie zmieni - trigger w produkcyjnym kodzie musi wiec stac na
 *  `_lastPaintedContent`, nie na odczycie DOM-u (tak jak jest zaimplementowany).
 */
function buildPaintFakeThis() {
    let drawCount = 0;
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
        _connectorRedrawCancel: null,
        _drawConnectorLines() { drawCount++; },
    };
    fakeThis._scheduleConnectorRedraw = function (this: TestDynamic) { return _scheduleConnectorRedraw.call(this); };
    return { fakeThis, getDrawCount: () => drawCount };
}

test('_paintStreamFrame: PIERWSZA niepusta tresc (dymek traci :empty) planuje przerysowanie RAZ (po flush), kolejne rosnace klatki NIE dokladaja kolejnych', t => {
    const { flush } = useQueuedRaf(t);
    const { fakeThis, getDrawCount } = buildPaintFakeThis();

    _paintStreamFrame.call(fakeThis, { text: 'Cze', reasoning: '' } as TestDynamic);
    flush();
    t.is(getDrawCount(), 1, 'pierwsza klatka z tekstem - dymek dopiero teraz przestaje byc :empty, lacznik powinien to zlapac');

    _paintStreamFrame.call(fakeThis, { text: 'Czesc, jak', reasoning: '' } as TestDynamic);
    _paintStreamFrame.call(fakeThis, { text: 'Czesc, jak mozna pomoc?', reasoning: '' } as TestDynamic);
    flush();
    t.is(getDrawCount(), 1, 'rosnacy tekst W TEJ SAMEJ turze nie przesuwa srodka krysztalu (staly offset od gory dymka) - nie powinien hot-loopowac schedulera');
});

test('_paintStreamFrame: klatka z pustym text NIE planuje przerysowania (dymek zostaje :empty); krok pozytywny w tej samej fixturze (klatka z tekstem) potem tak', t => {
    const { flush } = useQueuedRaf(t);
    const { fakeThis, getDrawCount } = buildPaintFakeThis();

    _paintStreamFrame.call(fakeThis, { text: '', reasoning: '' } as TestDynamic);
    flush();
    t.is(getDrawCount(), 0, 'pusta klatka (bez tekstu i bez reasoning) nie powinna ruszac lacznika');

    _paintStreamFrame.call(fakeThis, { text: 'A', reasoning: '' } as TestDynamic);
    flush();
    t.is(getDrawCount(), 1, 'krok pozytywny: ta sama fixtura, pierwsza klatka z niepustym tekstem powinna jednak zaplanowac przerysowanie');
});

test('_paintStreamFrame: WSTAWIENIE bloku myslenia (pierwsza klatka z reasoning) planuje przerysowanie RAZ (po flush), dopisywanie tresci nie doklada kolejnych', t => {
    const { flush } = useQueuedRaf(t);
    const { fakeThis, getDrawCount } = buildPaintFakeThis();

    _paintStreamFrame.call(fakeThis, { text: '', reasoning: 'Zastanawiam sie' } as TestDynamic);
    flush();
    t.is(getDrawCount(), 1, 'nowy kafelek myslenia to nowa kotwica lacznika - powinien planowac przerysowanie od razu, nie czekac do konca tury');
    t.truthy(fakeThis._currentThinkingBlock, 'blok myslenia powinien powstac przy pierwszej klatce z reasoning');

    _paintStreamFrame.call(fakeThis, { text: '', reasoning: 'Zastanawiam sie dalej i dalej' } as TestDynamic);
    flush();
    t.is(getDrawCount(), 1, 'dopisanie tresci do ISTNIEJACEGO bloku myslenia (updateThinkingBlock) nie zmienia zbioru kotwic - nie powinno planowac kolejnego przerysowania');
});

/** `this` dla `_chatOnToolCallsParsed` - PRAWDZIWY `_scheduleConnectorRedraw` (jak wyzej),
 *  aktywna zakladka domyslnie, kontener/bubble juz istnieja (`current_message_container`/
 *  `current_message_bubble` niepuste, wiec `_ensureAgentMessageContainer` sie nie wywoluje). */
function buildToolCallsFakeThis() {
    let drawCount = 0;
    const bubble: TestDynamic = { children: [] as TestDynamic[], appendChild(child: TestDynamic) { this.children.push(child); return child; } };
    const container: TestDynamic = { children: [bubble] };
    const fakeThis: TestDynamic = {
        _isTurnActiveTab: () => true,
        current_message_container: container,
        current_message_bubble: bubble,
        hideTypingIndicator() {},
        showTypingIndicator() {},
        _connectorRedrawCancel: null,
        _drawConnectorLines() { drawCount++; },
    };
    fakeThis._scheduleConnectorRedraw = function (this: TestDynamic) { return _scheduleConnectorRedraw.call(this); };
    return { fakeThis, getDrawCount: () => drawCount };
}

test('_chatOnToolCallsParsed: nowy kafelek narzedzia (Faza 1, aktywna zakladka) planuje przerysowanie lacznika (po flush)', t => {
    const { flush } = useQueuedRaf(t);
    const { fakeThis, getDrawCount } = buildToolCallsFakeThis();
    const turn: TestDynamic = { watchdog: null, agent: null, agentName: 'Test' };
    const toolCalls: TestDynamic[] = [{ id: 'tc1', name: 'vault_read', arguments: {} }];

    _chatOnToolCallsParsed.call(fakeThis, turn, toolCalls);
    flush();

    t.is(getDrawCount(), 1, 'kafelek narzedzia wstawiony mid-stream to nowa kotwica lacznika - powinien planowac przerysowanie, nie czekac do konca tury');
    t.truthy(turn.toolCallsContainer, 'kontrola: kafelek faktycznie powinien wyladowac w kontenerze narzedzi');
});

test('_chatOnToolCallsParsed: zakladka w tle (nieaktywna) nie planuje przerysowania widoku, ktorego user nie widzi; krok pozytywny w tej samej fixturze (ta sama zakladka, teraz aktywna) potem tak', t => {
    const { flush } = useQueuedRaf(t);
    const { fakeThis, getDrawCount } = buildToolCallsFakeThis();
    fakeThis._isTurnActiveTab = () => false;
    const turn: TestDynamic = { watchdog: null, agent: null, agentName: 'Test' };
    const toolCalls: TestDynamic[] = [{ id: 'tc1', name: 'vault_read', arguments: {} }];

    _chatOnToolCallsParsed.call(fakeThis, turn, toolCalls);
    flush();
    t.is(getDrawCount(), 0, 'lacznik zywy na EKRANIE usera nalezy do aktywnej zakladki - tura w tle nie powinna go ruszac');

    fakeThis._isTurnActiveTab = () => true;
    const turn2: TestDynamic = { watchdog: null, agent: null, agentName: 'Test' };
    const toolCalls2: TestDynamic[] = [{ id: 'tc2', name: 'vault_read', arguments: {} }];
    _chatOnToolCallsParsed.call(fakeThis, turn2, toolCalls2);
    flush();
    t.is(getDrawCount(), 1, 'krok pozytywny: ta sama fixtura, ta sama funkcja na AKTYWNEJ zakladce powinna jednak zaplanowac przerysowanie');
});
