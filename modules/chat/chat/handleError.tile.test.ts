/**
 * `handle_error` - test zachowania (spec A2, sekcja 4): błąd streamu ma renderować kafelek
 * systemowy (`.cs-tile--system.cs-tile--error`, rozwinięty) zamiast dawnego dymka agenta.
 *
 * `chat_streaming.ts` importuje `obsidian` (`MarkdownRenderer`, `Notice`) - ale to sama pusta
 * ŚCIEŻKA IMPORTU, nie klasa rozszerzana w tym pliku (`handle_error` to goła funkcja mixina,
 * wołana `.call(fakeThis, ...)` - ten sam wzorzec co `render_messages.emptyAssistant.test.ts`
 * dla `chat_messages.ts`), więc AVA (z atrapą `obsidian` z repo harnessu, patrz
 * `test-support/register-obsidian-for-ava.mjs` w tym repo) importuje ją bez problemu - **empirycznie
 * zweryfikowane** przed napisaniem tego testu (próbny import + wywołanie w REPL AVA), wbrew
 * ogólnej gotchy w `CLAUDE.md` tego modułu, która mówi o `chat_streaming.ts` jako całości
 * niemożliwej do zaimportowania - ta gotcha dotyczy ścieżek, które REALNIE dotykają
 * `MarkdownRenderer`/`Notice` (streaming markdown, powiadomienia), czego `handle_error` nie robi.
 *
 * Atrapa `document` (globalna z harnessu) ma `classList` jako CAŁKOWITY no-op
 * (`contains()` zawsze `false` - patrz `pkm-assistant-harness/test-support/dom-shim.ts`,
 * przeznaczona do smoke-testu bootstrapu, nie do odczytu klas), więc `createTile`
 * (`Tile.ts`'s `el.classList.add(...)`) nie da się zweryfikować przez nią. Test podstawia
 * WŁASNĄ, minimalną atrapę `document` z prawdziwym `classList` - ten sam wzorzec co
 * `Tile.test.ts`/`SubAgentBlock.test.ts`/`ToolCallDisplay.*.test.ts` w `modules/ui-components/`.
 */
import test from 'ava';
import { handle_error } from './chat_streaming.js';

type Listener = (ev: unknown) => void;

type FakeEl = {
    tagName: string;
    children: FakeEl[];
    parent: FakeEl | null;
    classList: { add(...c: string[]): void; remove(...c: string[]): void; toggle(c: string, force?: boolean): void; contains(c: string): boolean };
    className: string;
    textContent: string;
    listeners: Record<string, Listener[]>;
    appendText(t: string): void;
    empty(): void;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    removeAttribute(name: string): void;
    hasAttribute(name: string): boolean;
    appendChild(child: FakeEl): FakeEl;
    insertBefore(child: FakeEl, ref: FakeEl | null): FakeEl;
    addEventListener(type: string, cb: Listener): void;
};

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
        listeners: {},
        addEventListener(type, cb) { (el.listeners[type] ||= []).push(cb); },
    } as FakeEl;
    return el;
}

function findByClass(root: FakeEl, cls: string): FakeEl | null {
    if (root.classList.contains(cls)) return root;
    for (const child of root.children) {
        const found = findByClass(child, cls);
        if (found) return found;
    }
    return null;
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

/** Minimalny `this` mixina - tylko pola/metody, które `handle_error` realnie czyta/woła na
 *  ścieżce "aktywna zakładka, brak agentName" (najprostszy, najczęstszy przypadek). */
type TestDynamic = any;

function buildFakeThis(container: FakeEl): TestDynamic {
    return {
        messages_container: container,
        current_message_container: null,
        current_message_text: null,
        _currentThinkingBlock: null,
        chatTabs: [] as unknown[],
        _streamCtxMap: new Map(),
        _agentStates: new Map(),
        hideTypingIndicator: () => {},
        _resetPaintTargets: () => {},
        set_generating: () => {},
        _cleanupAskUser: () => {},
        // Wołane bezwarunkowo na końcu gałęzi aktywnej zakładki (naprawa recenzji niezależnej,
        // dogrywka - przeniesione poza `if (_currentThinkingBlock)`, patrz
        // `connectorRedraw.activity.test.ts` dla testu, który REALNIE liczy przerysowania przez
        // prawdziwy scheduler; ten plik testuje tylko kształt kafelka, więc stub wystarcza).
        _scheduleConnectorRedraw: () => {},
    };
}

test.serial('handle_error: krotki tekst (<=80 zn.) - kafelek .cs-tile--system.cs-tile--error, cala tresc w naglowku, BEZ details/is-toggleable', t => {
    withFakeDocument(() => {
        const container = makeFakeEl('div');
        const fakeThis = buildFakeThis(container);

        handle_error.call(fakeThis, new Error('connection reset'));

        const tile = findByClass(container, 'cs-tile--system');
        t.truthy(tile, 'brak kafelka .cs-tile--system w messages_container');
        t.true(tile!.classList.contains('cs-tile--error'), 'kafelek bledu ma byc .cs-tile--error');
        t.true(tile!.classList.contains('is-expanded'), 'kafelek bledu ma startowac rozwiniety');
        // Regula nadrzedna szczegolow kafelka (spec A2-fix): tekst ponizej 80 zn. miesci sie w
        // calosci w naglowku - details/is-toggleable nie mialyby nic do dodania.
        t.false(tile!.classList.contains('is-toggleable'), 'krotki tekst nie dostaje details - kafelek nie jest toggleable');

        const title = findByClass(tile!, 'cs-tile__title')!;
        t.is(title.textContent, 'Response error');

        const summary = findByClass(tile!, 'cs-tile__summary')!;
        t.is(summary.textContent, 'Error: connection reset', 'cala tresc bledu widoczna w naglowku');

        const details = findByClass(tile!, 'cs-tile__details')!;
        t.is(details.textContent, '', 'bez details dla krotkiego tekstu (regula nadrzedna)');
    });
});

test.serial('handle_error: dlugi tekst (>80 zn.) - details ma pelna tresc, kafelek jest toggleable', t => {
    withFakeDocument(() => {
        const container = makeFakeEl('div');
        const fakeThis = buildFakeThis(container);
        const longMessage = 'x'.repeat(120);

        handle_error.call(fakeThis, new Error(longMessage));

        const tile = findByClass(container, 'cs-tile--system')!;
        t.true(tile.classList.contains('is-toggleable'), 'tekst dluzszy niz 80 zn. musi dac details/is-toggleable');

        const details = findByClass(tile, 'cs-tile__details')!;
        t.true(details.textContent.includes(longMessage), details.textContent);
    });
});

test.serial('handle_error: gdy tura mialy juz czesciowy strumien (current_message_container), kafelek ladu do niego, nie duplikuje pustego dymka', t => {
    withFakeDocument(() => {
        const container = makeFakeEl('div');
        const partialBubble = makeFakeEl('div');
        partialBubble.className = 'cs-message cs-message--agent';
        container.appendChild(partialBubble);
        const partialText = makeFakeEl('div');
        partialText.className = 'cs-message__text';
        partialBubble.appendChild(partialText);
        partialText.textContent = 'Zaczela sie odpowiedz...';

        const fakeThis = buildFakeThis(container);
        fakeThis.current_message_container = partialBubble;
        fakeThis.current_message_text = partialText;

        handle_error.call(fakeThis, new Error('padlo w polowie'));

        // Kafelek bledu ladu W ISTNIEJACY kontener strumienia, nie jako DRUGI, osobny element
        // obok - `container` (messages_container) ma dalej TYLKO jedno dziecko (partialBubble).
        t.is(container.children.length, 1, 'zaden nowy element NIE ladowal wprost do messages_container');
        const tile = findByClass(partialBubble, 'cs-tile--system');
        t.truthy(tile, 'kafelek bledu musi wladowac do current_message_container');
        t.true(tile!.classList.contains('cs-tile--error'));
        // Czesciowy tekst strumienia zostal wyczyszczony (current_message_text.empty()).
        // Uwaga 4 (spec A2-fix): asercja na `children.length` niczego nie sprawdzala - ten
        // wezel nigdy nie mial dzieci (tekst szedl przez `textContent`, nie `appendChild`), wiec
        // przeszlaby tez bez `empty()`. Realny dowod czyszczenia to pusty `textContent`.
        t.is(partialText.textContent, '', 'stary czesciowy tekst zostal wyczyszczony przed dolozeniem kafelka');
    });
});
