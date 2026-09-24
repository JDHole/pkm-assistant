import test, { ExecutionContext } from 'ava';
import { render_messages, append_message } from './chat_messages.js';
import { _ensureAgentMessageContainer } from './chat_streaming.js';

/**
 * Kolumna dymkow (2.3.0, kolejna faza "Czat bez scian" - front B->kolumna): naglowek serii
 * (`.cs-message__agent-head` + `.cs-message__agent-crystal`, jeden krysztal na CALA serie) znika
 * calkowicie. Krysztal renderuje sie teraz CSS pseudo-elementem `::after`, sterowanym zmienna
 * `--cs-agent-crystal` (data URL SVG, `chat/agentCrystal.ts`) ustawiona INLINE na KAZDYM
 * kontenerze `.cs-message--agent` - kazda odpowiedz assistant (nawet druga z rzedu w tej samej
 * serii) dostaje wlasny kontener z wlasna wartoscia zmiennej.
 *
 * Atrapa DOM harnessu (`dom-shim.ts`, generyczny `globalThis.createDiv()`) ma
 * `style.setProperty`/`getPropertyValue` jako CELOWY no-op dla kazdej nazwy (`createStyleProxy`)
 * - custom properties NIE przezywaja podrozy przez ten shim, wiec test buduje WLASNA, minimalna
 * atrape elementu z prawdziwym `style` (wzor: `render_messages.delegateError.test.ts`), zeby dalo
 * sie odczytac ustawiona wartosc.
 */
type Listener = (ev: unknown) => void;

type FakeEl = {
    tagName: string;
    children: FakeEl[];
    classList: { add(...c: string[]): void; remove(...c: string[]): void; contains(c: string): boolean };
    className: string;
    textContent: string;
    style: { setProperty(name: string, value: string): void; getPropertyValue(name: string): string };
    listeners: Record<string, Listener[]>;
    appendChild(child: FakeEl): FakeEl;
    addEventListener(type: string, cb: Listener): void;
    createDiv(opts?: { cls?: string | string[] }): FakeEl;
    createSpan(opts?: { cls?: string | string[]; text?: string }): FakeEl;
    createEl(tag: string, opts?: { cls?: string | string[]; text?: string }): FakeEl;
    querySelectorAll(): FakeEl[];
    empty(): FakeEl;
};

function makeFakeEl(tag = 'div'): FakeEl {
    const classes = new Set<string>();
    const styleProps = new Map<string, string>();
    let text = '';
    const el: FakeEl = {
        tagName: tag,
        style: {
            setProperty(name, value) { styleProps.set(name, value); },
            getPropertyValue(name) { return styleProps.get(name) || ''; },
        },
        children: [],
        classList: {
            add: (...c) => { c.forEach(x => classes.add(x)); },
            remove: (...c) => { c.forEach(x => classes.delete(x)); },
            contains: (c) => classes.has(c),
        },
        get className() { return [...classes].join(' '); },
        set className(v: string) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
        get textContent() { return text; },
        set textContent(v: string) { text = v; el.children = []; },
        appendChild(child) { el.children.push(child); return child; },
        listeners: {},
        addEventListener(type, cb) { (el.listeners[type] ||= []).push(cb); },
        createDiv(opts) { const c = makeFakeEl('div'); if (opts?.cls) c.className = Array.isArray(opts.cls) ? opts.cls.join(' ') : opts.cls; el.appendChild(c); return c; },
        createSpan(opts) { const c = makeFakeEl('span'); if (opts?.cls) c.className = Array.isArray(opts.cls) ? opts.cls.join(' ') : opts.cls; if (opts?.text != null) c.textContent = opts.text; el.appendChild(c); return c; },
        createEl(tag2, opts) { const c = makeFakeEl(tag2); if (opts?.cls) c.className = Array.isArray(opts.cls) ? opts.cls.join(' ') : opts.cls; if (opts?.text != null) c.textContent = opts.text; el.appendChild(c); return c; },
        querySelectorAll() { return []; },
        empty() { el.children = []; return el; },
    } as FakeEl;
    return el;
}

type TestDynamic = any;

/** Agent domyślny fixture'ów niżej - `'#fff'` ląduje w SVG kryształu dosłownie, patrz `assertCrystalColor`. */
const DEFAULT_AGENT = { name: 'Jaskier', color: '#fff' };

function buildFakeThis(container: FakeEl, messages: TestDynamic[], agent: TestDynamic = DEFAULT_AGENT): TestDynamic {
    return {
        messages_container: container,
        rollingWindow: { messages, addMessage: async () => {} },
        plugin: { agentManager: { getActiveAgent: () => agent } },
        env: { settings: { pkmAssistant: {} } },
        app: {},
        _drawConnectorLines: () => {},
        scrollToBottom: () => {},
        addMessageActions: () => {},
        _renderMultimodalUserContent: () => {},
        _renderUserText: () => {},
        _renderCacheSavingsBadge: () => {},
        _contentBlocksToText: () => '',
        updateTokenCounter: () => {},
    };
}

/** Liczy wezly o DOKLADNIE tej jednej klasie w calym poddrzewie (wezly starego naglowka mialy zawsze jedna klase). */
function countByClass(el: FakeEl, cls: string): number {
    let count = el.classList.contains(cls) ? 1 : 0;
    for (const child of el.children) count += countByClass(child, cls);
    return count;
}

/** Zbiera w kolejnosci DOM wszystkie wezly niosace `cls` wsrod (ewentualnie) kilku klas naraz. */
function collectByClass(el: FakeEl, cls: string, acc: FakeEl[] = []): FakeEl[] {
    if (el.classList.contains(cls)) acc.push(el);
    for (const child of el.children) collectByClass(child, cls, acc);
    return acc;
}

/**
 * Kontrola: pada, gdy `--cs-agent-crystal` nie jest ustawiane (wartosc pusta) ALBO gdy stary
 * naglowek wraca (element mialby wtedy inny ksztalt, ale ta funkcja mierzy WYLACZNIE wartosc
 * zmiennej - test kompletu sprawdza brak naglowka osobno, patrz `countByClass` wyzej).
 */
function assertHasCrystalVar(t: ExecutionContext, el: FakeEl, label: string): void {
    const raw = el.style.getPropertyValue('--cs-agent-crystal');
    t.true(raw.startsWith('url("data:image/svg+xml,'), `${label}: --cs-agent-crystal ma zaczynac sie od url("data:image/svg+xml,..., dostalem "${raw.slice(0, 50)}"`);
    t.true(raw.includes('%3Csvg'), `${label}: zakodowana wartosc musi zawierac %3Csvg (encodeURIComponent('<svg'))`);
    const match = /^url\("(.+)"\)$/.exec(raw);
    t.truthy(match, `${label}: wartosc powinna miec ksztalt url("...")`);
    const decoded = decodeURIComponent((match?.[1] || '').replace(/^data:image\/svg\+xml,/, ''));
    t.true(decoded.includes('<svg'), `${label}: zdekodowana wartosc powinna zawierac "<svg", dostalem "${decoded.slice(0, 60)}"`);
}

/**
 * Dekoduje `--cs-agent-crystal` i sprawdza, CZYJ to krysztal - literalny `stroke="{hexColor}"`
 * w SVG (`CrystalGenerator.generate` maluje kontur/linie kolorem agenta - `modules/crystal-soul/
 * CrystalGenerator.ts`). `assertHasCrystalVar` wyzej sprawdza tylko KSZTALT wartosci (czy to w
 * ogole jest url() ze svg w srodku) - mutacja, ktora podstawia STALY/ZLY kolor albo cudzego
 * agenta (np. `agentCrystalCssVar('Inny', '#000000')`) przechodzi TEN test bez tej funkcji.
 */
function assertCrystalColor(t: ExecutionContext, el: FakeEl, hexColor: string, label: string): void {
    const raw = el.style.getPropertyValue('--cs-agent-crystal');
    const match = /^url\("(.+)"\)$/.exec(raw);
    const decoded = decodeURIComponent((match?.[1] || '').replace(/^data:image\/svg\+xml,/, ''));
    t.true(decoded.includes(`stroke="${hexColor}"`), `${label}: SVG krysztalu powinien niesc kolor agenta (stroke="${hexColor}"), dostalem "${decoded.slice(0, 160)}"`);
}

test('render_messages: user + 2 assistant w serii - zero naglowkow, OBA kontenery agenta maja wlasny --cs-agent-crystal', async t => {
    const container = makeFakeEl('div');
    const fakeThis = buildFakeThis(container, [
        { role: 'user', content: 'czesc' },
        { role: 'assistant', content: 'Pierwsza odpowiedz.' },
        { role: 'assistant', content: 'Druga odpowiedz w tej samej serii.' },
    ]);

    await render_messages.call(fakeThis);

    t.is(countByClass(container, 'cs-message__agent-head'), 0, 'naglowek serii nie ma juz zadnego producenta');
    t.is(countByClass(container, 'cs-message__agent-crystal'), 0, 'stary wezel krysztalu w naglowku znikl');

    const agentContainers = collectByClass(container, 'cs-message--agent');
    t.is(agentContainers.length, 2, 'kazda odpowiedz assistant dostaje WLASNY kontener - druga z rzedu juz nie znika w naglowku pierwszej');
    agentContainers.forEach((el, i) => {
        assertHasCrystalVar(t, el, `kontener agenta #${i + 1}`);
        assertCrystalColor(t, el, DEFAULT_AGENT.color, `kontener agenta #${i + 1}`);
    });
});

test('render_messages: dwie serie assistant przedzielone userem - OBA kontenery maja --cs-agent-crystal, zero naglowkow', async t => {
    const container = makeFakeEl('div');
    const fakeThis = buildFakeThis(container, [
        { role: 'user', content: 'pytanie 1' },
        { role: 'assistant', content: 'odpowiedz 1' },
        { role: 'user', content: 'pytanie 2' },
        { role: 'assistant', content: 'odpowiedz 2' },
    ]);

    await render_messages.call(fakeThis);

    t.is(countByClass(container, 'cs-message__agent-head'), 0, 'zadna seria nie renderuje juz naglowka');
    t.is(countByClass(container, 'cs-message__agent-crystal'), 0, 'zaden stary wezel krysztalu nie zostal');

    const agentContainers = collectByClass(container, 'cs-message--agent');
    t.is(agentContainers.length, 2, 'kazda z dwoch serii ma jeden kontener assistant');
    agentContainers.forEach((el, i) => {
        assertHasCrystalVar(t, el, `kontener agenta #${i + 1}`);
        assertCrystalColor(t, el, DEFAULT_AGENT.color, `kontener agenta #${i + 1}`);
    });
});

test('streaming: _ensureAgentMessageContainer dwa razy w serii - OBA kontenery maja wlasny --cs-agent-crystal, zero naglowkow', t => {
    const container = makeFakeEl('div');
    const fakeThis = buildFakeThis(container, []);
    const agent = { name: 'Jaskier', color: '#fff' };

    _ensureAgentMessageContainer.call(fakeThis, agent as TestDynamic);
    const first = fakeThis.current_message_container as FakeEl;
    fakeThis.current_message_container = null;
    _ensureAgentMessageContainer.call(fakeThis, agent as TestDynamic);
    const second = fakeThis.current_message_container as FakeEl;

    t.is(countByClass(container, 'cs-message__agent-head'), 0, 'streaming nie rysuje juz naglowka serii');
    t.is(countByClass(container, 'cs-message__agent-crystal'), 0, 'streaming nie rysuje juz starego wezla krysztalu');
    t.not(first, second, 'kazde wywolanie tworzy NOWY kontener (tak jak dzis)');
    assertHasCrystalVar(t, first, 'pierwszy kontener streamu');
    assertHasCrystalVar(t, second, 'drugi kontener streamu (ten sam agent, ta sama seria)');
    assertCrystalColor(t, first, agent.color, 'pierwszy kontener streamu');
    assertCrystalColor(t, second, agent.color, 'drugi kontener streamu (ten sam agent, ta sama seria)');
});

test('streaming: _ensureAgentMessageContainer dla DWOCH ROZNYCH agentow - kazdy kontener niesie kolor SWOJEGO agenta, nie cudzy/staly', t => {
    const container = makeFakeEl('div');
    const fakeThis = buildFakeThis(container, []);
    const agentA = { name: 'Jaskier', color: '#fff' };
    const agentB = { name: 'Inny', color: '#123456' };

    _ensureAgentMessageContainer.call(fakeThis, agentA as TestDynamic);
    const forA = fakeThis.current_message_container as FakeEl;
    fakeThis.current_message_container = null;
    _ensureAgentMessageContainer.call(fakeThis, agentB as TestDynamic);
    const forB = fakeThis.current_message_container as FakeEl;

    // Asercja na TO, CZYJ to krysztal - gdyby producent trzymal/uzywal koloru z poprzedniego
    // wywolania (bug: stara wartosc zamiast swiezej), ten test by to zlapal, a
    // `assertHasCrystalVar` sam nie (sprawdza tylko ksztalt).
    assertCrystalColor(t, forA, agentA.color, 'kontener agenta Jaskier');
    assertCrystalColor(t, forB, agentB.color, 'kontener agenta Inny');
});

test('append_message: assistant tekst ustawia --cs-agent-crystal z KOLOREM agenta na nowym kontenerze (trzeci producent)', async t => {
    const container = makeFakeEl('div');
    const fakeThis = buildFakeThis(container, []);

    await append_message.call(fakeThis, 'assistant', 'Nowa odpowiedz agenta.');

    t.is(countByClass(container, 'cs-message__agent-head'), 0, 'append_message nie rysuje juz naglowka serii');
    const agentContainers = collectByClass(container, 'cs-message--agent');
    t.is(agentContainers.length, 1, 'append_message assistant tworzy jeden kontener agenta');
    assertHasCrystalVar(t, agentContainers[0], 'kontener agenta append_message');
    assertCrystalColor(t, agentContainers[0], DEFAULT_AGENT.color, 'kontener agenta append_message');
});
