import test from 'ava';
import { render_messages } from './chat_messages.js';
import { _ensureAgentMessageContainer } from './chat_streaming.js';

/**
 * Spec B ("Czat bez scian 2026-09", dymki usera i agenta, 2.3.0): dymek agenta przestaje
 * renderowac `span.cs-message__agent-name` - krysztal (`.cs-message__agent-crystal`) zostaje
 * jedynym znacznikiem serii, w rynnie po lewej, tylko przy PIERWSZEJ wiadomosci serii.
 *
 * Behawioralny test na realnej atrapie DOM harnessu (dom-shim.ts, wzor:
 * `render_messages.emptyAssistant.test.ts`) - liczy realne wezly drzewa (atrapa nie ma
 * `querySelectorAll`, wiec liczymy rekurencyjnie po `children`), nie sam fakt wywolania.
 */
type TestDynamic = any;

function buildFakeThis(messages: TestDynamic[]): TestDynamic {
    const container: TestDynamic = (globalThis as TestDynamic).createDiv();
    return {
        messages_container: container,
        rollingWindow: { messages },
        plugin: { agentManager: { getActiveAgent: () => ({ name: 'Jaskier', color: '#fff' }) } },
        env: { settings: { pkmAssistant: {} } },
        app: {},
        _drawConnectorLines: () => {},
        scrollToBottom: () => {},
        addMessageActions: () => {},
        _renderMultimodalUserContent: () => {},
        _renderUserText: () => {},
        _renderCacheSavingsBadge: () => {},
        _contentBlocksToText: () => '',
        _agentHeaderShown: false,
        updateTokenCounter: () => {},
        _container: container,
    };
}

/** Liczy wezly o danej klasie w calym poddrzewie - atrapa DOM harnessu nie ma `querySelectorAll`. */
function countByClass(el: TestDynamic, cls: string): number {
    if (!el || !Array.isArray(el.children)) return 0;
    let count = 0;
    for (const child of el.children) {
        if (child.className === cls) count += 1;
        count += countByClass(child, cls);
    }
    return count;
}

test('render_messages: 1 wiadomosc user + 2 assistant w serii - dokladnie 1 krysztal agenta, 0 nazw agenta', async t => {
    const fakeThis = buildFakeThis([
        { role: 'user', content: 'czesc' },
        { role: 'assistant', content: 'Pierwsza odpowiedz.' },
        { role: 'assistant', content: 'Druga odpowiedz w tej samej serii.' },
    ]);

    await render_messages.call(fakeThis);

    t.is(countByClass(fakeThis._container, 'cs-message__agent-crystal'), 1,
        'krysztal pojawia sie raz - tylko przy pierwszej wiadomosci serii assistant, druga z rzedu go nie powtarza');
    t.is(countByClass(fakeThis._container, 'cs-message__agent-name'), 0,
        'nazwa agenta nie renderuje sie juz w naglowku dymka (spec B, "Dymki 2.3.0")');
});

test('render_messages: dwie oddzielne serie assistant (przedzielone user) - 2 krysztaly, 0 nazw agenta', async t => {
    const fakeThis = buildFakeThis([
        { role: 'user', content: 'pytanie 1' },
        { role: 'assistant', content: 'odpowiedz 1' },
        { role: 'user', content: 'pytanie 2' },
        { role: 'assistant', content: 'odpowiedz 2' },
    ]);

    await render_messages.call(fakeThis);

    t.is(countByClass(fakeThis._container, 'cs-message__agent-crystal'), 2,
        'kazda nowa seria assistant (po wiadomosci usera) dostaje wlasny krysztal');
    t.is(countByClass(fakeThis._container, 'cs-message__agent-name'), 0,
        'zadna seria nie renderuje juz nazwy agenta');
});

test('streaming: _ensureAgentMessageContainer dwa razy w serii - 1 krysztal agenta, 0 nazw agenta', t => {
    const fakeThis = buildFakeThis([]);
    const agent = { name: 'Jaskier', color: '#fff' };

    _ensureAgentMessageContainer.call(fakeThis, agent as TestDynamic);
    fakeThis.current_message_container = null;
    _ensureAgentMessageContainer.call(fakeThis, agent as TestDynamic);

    t.is(countByClass(fakeThis._container, 'cs-message__agent-crystal'), 1,
        'naglowek serii przy streamingu rysuje krysztal raz (_agentHeaderShown), druga wiadomosc serii bez naglowka');
    t.is(countByClass(fakeThis._container, 'cs-message__agent-name'), 0,
        'streaming nie renderuje nazwy agenta (spec B), tak samo jak historia i append_message');
});
