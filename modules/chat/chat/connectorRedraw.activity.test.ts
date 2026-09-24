import test from 'ava';
import { onMessagesContainerActivity, _scheduleConnectorRedraw } from './connectorActivity.js';
import { _paintStreamFrame, _chatOnToolCallsParsed, _chatBeforeContinue, _chatOnToolResults, handle_error, stop_generation } from './chat_streaming.js';

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
 *
 * WSZYSTKIE testy w tym pliku sa `test.serial` (naprawa recenzji niezaleznej, dogrywka): kazdy
 * z nich woła `useQueuedRaf`, ktora podmienia GLOBALNE `requestAnimationFrame`/
 * `cancelAnimationFrame` na wspolna atrape na czas swojego ciala - AVA domyslnie uruchamia testy
 * JEDNEGO pliku wspolbieznie, wiec dwa testy z tego samego pliku rownolegle podmienialyby ten sam
 * globalny stan i nadpisywalyby sobie kolejke/oryginaly nawzajem. Testy synchroniczne mieszcza
 * podmiane i przywrocenie w jednym mikrozadaniu, ale testy czterech wyzwalaczy streamingu sa
 * `async` z `await` w srodku - bez `test.serial` inny test wszedlby miedzy podmiane a przywrocenie.
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

test.serial('onMessagesContainerActivity: klik na wezle wewnatrz .cs-tile__head planuje przerysowanie (przez PRAWDZIWY _scheduleConnectorRedraw -> _drawConnectorLines, po flush)', t => {
    const { flush } = useQueuedRaf(t);
    const { fakeThis, getDrawCount } = buildSchedulerFakeThis();
    const head = {};
    const target = { closest: (sel: string) => (sel === '.cs-tile__head' ? head : null) };

    onMessagesContainerActivity(fakeThis, { type: 'click', target } as TestDynamic);
    flush();

    t.is(getDrawCount(), 1, 'klik na naglowku kafelka powinien skutkowac wywolaniem _drawConnectorLines przez scheduler');
});

test.serial('onMessagesContainerActivity: klik POZA .cs-tile__head nie planuje przerysowania; krok pozytywny w tej samej fixturze (klik NA naglowku) potem tak', t => {
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

test.serial('onMessagesContainerActivity: Enter/Spacja na .cs-tile__head planuja KAZDE swoje przerysowanie (osobne klatki), inny klawisz nie', t => {
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

test.serial('onMessagesContainerActivity: dwa planowania PRZED jednym flush koalescuja sie do JEDNEGO przerysowania', t => {
    const { flush } = useQueuedRaf(t);
    const { fakeThis, getDrawCount } = buildSchedulerFakeThis();
    const head = {};
    const target = { closest: (sel: string) => (sel === '.cs-tile__head' ? head : null) };

    onMessagesContainerActivity(fakeThis, { type: 'click', target } as TestDynamic);
    onMessagesContainerActivity(fakeThis, { type: 'keydown', key: 'Enter', target } as TestDynamic);
    flush();

    t.is(getDrawCount(), 1, 'dwa zdarzenia PRZED flushem to jedna klatka animacji - scheduler dlawi drugie planowanie (_connectorRedrawCancel juz niepusty), wiec wychodzi JEDNO przerysowanie');
});

test.serial('onMessagesContainerActivity: zdarzenia inne niz click/keydown (np. scroll) nie planuja przerysowania; krok pozytywny w tej samej fixturze (klik NA naglowku) potem tak', t => {
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

test.serial('onMessagesContainerActivity: animationend z celem W kontenerze agenta/ask_user planuje przerysowanie (koniec animacji wejscia cs-message-enter), z celem POZA nim nie', t => {
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

test.serial('_paintStreamFrame: PIERWSZA niepusta tresc (dymek traci :empty) planuje przerysowanie RAZ (po flush), kolejne rosnace klatki NIE dokladaja kolejnych', t => {
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

test.serial('_paintStreamFrame: klatka z pustym text NIE planuje przerysowania (dymek zostaje :empty); krok pozytywny w tej samej fixturze (klatka z tekstem) potem tak', t => {
    const { flush } = useQueuedRaf(t);
    const { fakeThis, getDrawCount } = buildPaintFakeThis();

    _paintStreamFrame.call(fakeThis, { text: '', reasoning: '' } as TestDynamic);
    flush();
    t.is(getDrawCount(), 0, 'pusta klatka (bez tekstu i bez reasoning) nie powinna ruszac lacznika');

    _paintStreamFrame.call(fakeThis, { text: 'A', reasoning: '' } as TestDynamic);
    flush();
    t.is(getDrawCount(), 1, 'krok pozytywny: ta sama fixtura, pierwsza klatka z niepustym tekstem powinna jednak zaplanowac przerysowanie');
});

test.serial('_paintStreamFrame: WSTAWIENIE bloku myslenia (pierwsza klatka z reasoning) planuje przerysowanie RAZ (po flush), dopisywanie tresci nie doklada kolejnych', t => {
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

test.serial('_chatOnToolCallsParsed: nowy kafelek narzedzia (Faza 1, aktywna zakladka) planuje przerysowanie lacznika (po flush)', t => {
    const { flush } = useQueuedRaf(t);
    const { fakeThis, getDrawCount } = buildToolCallsFakeThis();
    const turn: TestDynamic = { watchdog: null, agent: null, agentName: 'Test' };
    const toolCalls: TestDynamic[] = [{ id: 'tc1', name: 'vault_read', arguments: {} }];

    _chatOnToolCallsParsed.call(fakeThis, turn, toolCalls);
    flush();

    t.is(getDrawCount(), 1, 'kafelek narzedzia wstawiony mid-stream to nowa kotwica lacznika - powinien planowac przerysowanie, nie czekac do konca tury');
    t.truthy(turn.toolCallsContainer, 'kontrola: kafelek faktycznie powinien wyladowac w kontenerze narzedzi');
});

test.serial('_chatOnToolCallsParsed: zakladka w tle (nieaktywna) nie planuje przerysowania widoku, ktorego user nie widzi; krok pozytywny w tej samej fixturze (ta sama zakladka, teraz aktywna) potem tak', t => {
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

// ── chat_streaming.ts: wyzwalacze POZA streamingiem (dogrywka recenzji niezaleznej - karta
// zada testow czterech konkretnych wyzwalaczy dopisanych w poprzedniej rundzie bez pokrycia:
// _chatBeforeContinue/_chatOnToolResults/handle_error/stop_generation). Ta sama technika -
// PRAWDZIWY _scheduleConnectorRedraw + _drawConnectorLines jako licznik, nigdy stub samego
// wywolania schedulera. ──

/** Minimalny `this`+`turn` dla `_chatBeforeContinue` na SCIEZCE bez zakolejkowanej wiadomosci,
 *  bez kompresji i bez nudge'y delegacji/skilla (rw.messages puste, getCompressionNeeded:'none',
 *  pendingEntries/agent puste, responseRecorded:true) - izoluje WYLACZNIE galaz "reset kontenera
 *  przed kontynuacja petli", w ktorej siedzi wyzwalacz po zwinieciu bloku myslenia. */
function buildBeforeContinueFakeThis() {
    let drawCount = 0;
    const fakeThis: TestDynamic = {
        _isTurnActiveTab: () => true,
        appendToActiveSession: async () => { /* no-op fake */ },
        _renderThrottle: null,
        current_message_bubble: null,
        _currentThinkingBlock: null,
        _resetPaintTargets() { /* no-op fake */ },
        showTypingIndicator() { /* no-op fake */ },
        _queuedMessage: null,
        _connectorRedrawCancel: null,
        _drawConnectorLines() { drawCount++; },
    };
    fakeThis._scheduleConnectorRedraw = function (this: TestDynamic) { return _scheduleConnectorRedraw.call(this); };
    const turn: TestDynamic = {
        watchdog: null,
        rw: {
            messages: [] as TestDynamic[],
            getCompressionNeeded: () => 'none',
        },
        agentName: 'Test',
        agent: null,
        responseRecorded: true,
        lastRoundToolResults: [] as TestDynamic[],
        pendingEntries: [] as TestDynamic[],
        skillActiveAt: null,
    };
    return { fakeThis, turn, getDrawCount: () => drawCount };
}

test.serial('_chatBeforeContinue: reset kontenera ZE zwinietym blokiem myslenia planuje przerysowanie (flush -> 1); bez bloku i bez innych zmian nie doklada kolejnego', async t => {
    const { flush } = useQueuedRaf(t);
    const { fakeThis, turn, getDrawCount } = buildBeforeContinueFakeThis();

    fakeThis._currentThinkingBlock = { classList: { remove() { /* no-op fake */ } } };
    await _chatBeforeContinue.call(fakeThis, turn, 0);
    flush();
    t.is(getDrawCount(), 1, 'zwiniecie bloku myslenia w galezi resetu kontenera powinno zaplanowac przerysowanie');
    t.falsy(fakeThis._currentThinkingBlock, 'kontrola: blok myslenia powinien zostac wyzerowany po zwinieciu');

    await _chatBeforeContinue.call(fakeThis, turn, 1);
    flush();
    t.is(getDrawCount(), 1, 'bez bloku myslenia w locie i bez innych zmian geometrii kolejne wejscie w reset nie powinno dokladac przerysowania');
});

/** Minimalny `this`+`turn` dla `_chatOnToolResults` z PUSTA lista wynikow - izoluje wylacznie
 *  przerysowanie NA KONCU funkcji (podmiana kafelka w petli per-wynik jest poza zakresem tego
 *  pliku - zero elementow w `results` omija cale cialo petli bez ryzyka niezamierzonych efektow). */
function buildToolResultsFakeThis(isActiveTab: boolean) {
    let drawCount = 0;
    const fakeThis: TestDynamic = {
        _isTurnActiveTab: () => isActiveTab,
        _connectorRedrawCancel: null,
        _drawConnectorLines() { drawCount++; },
    };
    fakeThis._scheduleConnectorRedraw = function (this: TestDynamic) { return _scheduleConnectorRedraw.call(this); };
    return { fakeThis, getDrawCount: () => drawCount };
}

test.serial('_chatOnToolResults: koniec rundy planuje przerysowanie TYLKO na aktywnej zakladce', async t => {
    const { flush } = useQueuedRaf(t);
    const turn: TestDynamic = { agentName: 'Test', toolCallsContainer: null };
    const results: TestDynamic[] = [];

    const { fakeThis: activeThis, getDrawCount: activeCount } = buildToolResultsFakeThis(true);
    await _chatOnToolResults.call(activeThis, turn, results, 0);
    flush();
    t.is(activeCount(), 1, 'koniec rundy na aktywnej zakladce powinien przerysowac lacznik');

    const { fakeThis: bgThis, getDrawCount: bgCount } = buildToolResultsFakeThis(false);
    await _chatOnToolResults.call(bgThis, turn, results, 0);
    flush();
    t.is(bgCount(), 0, 'runda w tle nie powinna ruszac lacznika widoku, ktorego user nie widzi');
});

// ── handle_error: fake `document` (ten sam wzorzec co handleError.tile.test.ts, zdublowany tu
// bo `createTile` (`_buildStreamErrorTile`) potrzebuje dzialajacego document.createElement) -
// TEN plik nie weryfikuje KLAS wyrenderowanego kafelka (to robi handleError.tile.test.ts), tylko
// to, ze funkcja dochodzi do konca i planuje przerysowanie lacznika przez PRAWDZIWY scheduler. ──

type FakeEl = {
    tagName: string;
    children: FakeEl[];
    parent: FakeEl | null;
    classList: { add(...c: string[]): void; remove(...c: string[]): void; toggle(c: string, force?: boolean): void; contains(c: string): boolean };
    className: string;
    textContent: string;
    appendText(t: string): void;
    empty(): void;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    removeAttribute(name: string): void;
    hasAttribute(name: string): boolean;
    appendChild(child: FakeEl): FakeEl;
    insertBefore(child: FakeEl, ref: FakeEl | null): FakeEl;
    remove(): void;
    addEventListener(type: string, cb: (...a: unknown[]) => void): void;
};

// Zdublowany wzor `handleError.tile.test.ts`'s `makeFakeEl` (dowod: `createTile` (`Tile.ts`)
// potrzebuje wszystkich tych metod - `syncBodyVisibility` wola `removeAttribute`/`setAttribute`,
// `setSummary` wola `.remove()` - proba minimalnej wersji bez nich rzucala tu realny wyjatek).
function makeFakeEl(tag = 'div'): FakeEl {
    const classes = new Set<string>();
    const attrs = new Map<string, string>();
    let text = '';
    const el: FakeEl = {
        tagName: tag,
        children: [],
        parent: null,
        classList: {
            add: (...c) => { c.forEach(x => classes.add(x)); },
            remove: (...c) => { c.forEach(x => classes.delete(x)); },
            toggle: (c, force) => { const next = force === undefined ? !classes.has(c) : force; if (next) classes.add(c); else classes.delete(c); },
            contains: (c) => classes.has(c),
        },
        get className() { return [...classes].join(' '); },
        set className(v: string) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
        get textContent() { return text; },
        set textContent(v: string) { text = v; el.children = []; },
        appendText(t) { text += t; },
        empty() { text = ''; el.children = []; },
        setAttribute(name, value) { attrs.set(name, value); },
        getAttribute(name) { return attrs.has(name) ? attrs.get(name)! : null; },
        removeAttribute(name) { attrs.delete(name); },
        hasAttribute(name) { return attrs.has(name); },
        appendChild(child) { child.parent = el; el.children.push(child); return child; },
        insertBefore(child, ref) {
            child.parent = el;
            const idx = ref ? el.children.indexOf(ref) : -1;
            if (ref && idx >= 0) el.children.splice(idx, 0, child);
            else el.children.push(child);
            return child;
        },
        remove() { if (el.parent) el.parent.children = el.parent.children.filter(c => c !== el); },
        addEventListener() { /* no-op fake */ },
    } as FakeEl;
    return el;
}

function withFakeDocument<T>(fn: () => T): T {
    const prevDoc = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { createElement: (tag: string) => makeFakeEl(tag) };
    try {
        return fn();
    } finally {
        (globalThis as Record<string, unknown>).document = prevDoc;
    }
}

/** Minimalny `this` dla `handle_error` na sciezce "aktywna zakladka, brak agentName" (wzor
 *  `handleError.tile.test.ts`'s `buildFakeThis`) PLUS okablowanie PRAWDZIWEGO
 *  `_scheduleConnectorRedraw`. */
function buildHandleErrorFakeThis(container: FakeEl) {
    let drawCount = 0;
    const fakeThis: TestDynamic = {
        messages_container: container,
        current_message_container: null,
        current_message_text: null,
        _currentThinkingBlock: null,
        chatTabs: [] as TestDynamic[],
        _streamCtxMap: new Map(),
        _agentStates: new Map(),
        hideTypingIndicator() { /* no-op fake */ },
        _resetPaintTargets() { /* no-op fake */ },
        set_generating() { /* no-op fake */ },
        _cleanupAskUser() { /* no-op fake */ },
        _releaseStreamCtx() { /* no-op fake */ },
        _connectorRedrawCancel: null,
        _drawConnectorLines() { drawCount++; },
    };
    fakeThis._scheduleConnectorRedraw = function (this: TestDynamic) { return _scheduleConnectorRedraw.call(this); };
    return { fakeThis, getDrawCount: () => drawCount };
}

test.serial('handle_error: aktywna zakladka planuje przerysowanie lacznika NAWET BEZ bloku myslenia w locie (naprawa recenzji niezaleznej, dogrywka pkt 3 - wywolanie przeniesione poza `if (_currentThinkingBlock)`); zakladka w tle nie', t => {
    const { flush } = useQueuedRaf(t);
    withFakeDocument(() => {
        const { fakeThis, getDrawCount } = buildHandleErrorFakeThis(makeFakeEl('div'));
        handle_error.call(fakeThis, new Error('siec padla'));
        flush();
        t.is(getDrawCount(), 1, 'blad na aktywnej zakladce czysci dymek i wstawia kafelek NAWET bez bloku myslenia w locie - lacznik powinien to zlapac');

        const { fakeThis: bgThis, getDrawCount: bgCount } = buildHandleErrorFakeThis(makeFakeEl('div'));
        bgThis.chatTabs = [{ isActive: true, agentName: 'Inny' }];
        handle_error.call(bgThis, new Error('siec padla w tle'), 'TestAgent');
        flush();
        t.is(bgCount(), 0, 'blad w tle nie powinien ruszac lacznika widoku, ktorego user nie widzi');
    });
});

/** Minimalny `this` dla `stop_generation` na sciezce "jawny agentName" (pomija lancuch
 *  `this.plugin.agentManager.getActiveAgent()` na starcie) i "bez sCtx we `_streamCtxMap`"/"bez
 *  zakolejkowanej wiadomosci" (najprostszy, "goly Stop" przypadek) - izoluje wylacznie zwiniecie
 *  bloku myslenia i przerysowanie lacznika na koncu funkcji (galaz BEZWARUNKOWA - `stop_generation`
 *  sama nie liczy `isActiveTab`, patrz CLAUDE.md tego modulu). */
function buildStopGenerationFakeThis() {
    let drawCount = 0;
    const fakeThis: TestDynamic = {
        _streamCtxMap: new Map(),
        _preparingTurns: new Map(),
        _drainSuppressed: false,
        _clearQueuedDrainTimer() { /* no-op fake */ },
        _queuedMessage: null,
        _hideQueuedIndicator() { /* no-op fake */ },
        env: {},
        _releaseStreamCtx() { /* no-op fake */ },
        _renderThrottle: null,
        current_message_bubble: null,
        _currentThinkingBlock: null,
        _resetPaintTargets() { /* no-op fake */ },
        hideTypingIndicator() { /* no-op fake */ },
        set_generating() { /* no-op fake */ },
        _connectorRedrawCancel: null,
        _drawConnectorLines() { drawCount++; },
    };
    fakeThis._scheduleConnectorRedraw = function (this: TestDynamic) { return _scheduleConnectorRedraw.call(this); };
    return { fakeThis, getDrawCount: () => drawCount };
}

test.serial('stop_generation: Stop ZE zwinietym blokiem myslenia planuje przerysowanie (flush -> 1); kolejny Stop bez bloku nie doklada kolejnego', t => {
    const { flush } = useQueuedRaf(t);
    const { fakeThis, getDrawCount } = buildStopGenerationFakeThis();

    fakeThis._currentThinkingBlock = { classList: { remove() { /* no-op fake */ } } };
    stop_generation.call(fakeThis, 'TestAgent');
    flush();
    t.is(getDrawCount(), 1, 'Stop ze zwinieciem bloku myslenia w locie powinien przerysowac lacznik');

    stop_generation.call(fakeThis, 'TestAgent');
    flush();
    t.is(getDrawCount(), 1, 'kolejny Stop bez bloku myslenia w locie nie powinien dokladac kolejnego przerysowania');
});
