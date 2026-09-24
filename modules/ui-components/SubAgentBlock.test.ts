/**
 * SubAgentBlock - testy zachowania (nie implementacji), po przejściu na `.cs-tile` (2.3.0, A2
 * "Czat bez ścian" - poprzednio `.cs-action-row`, patrz git history dla starej wersji).
 * `SubAgentBlock.ts` nie importuje `obsidian`, więc testy wołają `createTile` (pod maską) w
 * gołym Node, podstawiając WŁASNĄ, minimalną atrapę `document` - ten sam wzorzec i ta sama
 * atrapa co `Tile.test.ts`/`ToolCallDisplay.truncate.test.ts` w tym module (`test.serial`, bo
 * atrapa siedzi na `globalThis.document`, współdzielonym stanem między testami).
 *
 * Locale: testy asercji tekstowej liczą na domyślnym `'en'` (`core/i18n/index.ts`), literalne
 * wartości oczekiwane wprost w tekście testu - ten sam wybór co `ToolCallDisplay.describe.test.ts`
 * w tym module (`setLocale` nigdzie w tym pliku).
 *
 * Werdykt właściciela zrealizowany tu: "żadnych technicznych spraw w nagłówku" (nazwy narzędzi,
 * liczby tokenów) i "błąd -> ikonka po lewej i kropka po prawej na czerwono jako standard" -
 * drugie idzie DARMO przez `role`/`status` Tile'a (`.cs-tile--error` koloruje ikonę i kropkę
 * jedną zmienną CSS), więc test sprawdza tylko klasę, nie osobną logikę koloru.
 */
import test from 'ava';
import { createSubAgentBlock, createPendingSubAgentBlock, pluralCalls } from './SubAgentBlock.js';

type FakeEl = {
    tagName: string;
    children: FakeEl[];
    parent: FakeEl | null;
    classList: { add(...c: string[]): void; remove(...c: string[]): void; toggle(c: string, force?: boolean): void; contains(c: string): boolean };
    className: string;
    textContent: string;
    listeners: Record<string, Array<(ev: unknown) => void>>;
    appendText(t: string): void;
    empty(): void;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    removeAttribute(name: string): void;
    hasAttribute(name: string): boolean;
    appendChild(child: FakeEl): FakeEl;
    insertBefore(child: FakeEl, ref: FakeEl | null): FakeEl;
    addEventListener(ev: string, cb: (ev: unknown) => void): void;
    fire(ev: string, data?: unknown): void;
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
            toggle: (c, force) => {
                const next = force === undefined ? !classes.has(c) : force;
                if (next) classes.add(c); else classes.delete(c);
            },
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
        addEventListener(evName, cb) { (el.listeners[evName] ||= []).push(cb); },
        fire(evName, data = {}) { (el.listeners[evName] || []).forEach(cb => cb(data)); },
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

test.serial('wynik: naglowek (tytul/skrot/meta) nie zawiera nazw narzedzi ani liczb tokenow', t => {
    withFakeDocument(() => {
        const row = createSubAgentBlock({
            type: 'delegate',
            status: 'success',
            agentName: 'czytelnik',
            query: 'Podsumuj notatki z tego tygodnia',
            response: 'Gotowe, oto podsumowanie.',
            toolsUsed: ['read', 'search'],
            duration: 12000,
            usage: { prompt_tokens: 1000, completion_tokens: 500 },
        }) as unknown as FakeEl;

        const title = findByClass(row, 'cs-tile__title')!;
        const summary = findByClass(row, 'cs-tile__summary')!;
        const meta = findByClass(row, 'cs-tile__meta')!;

        t.is(title.textContent, 'Sub-agent czytelnik');
        t.is(summary.textContent, 'Podsumuj notatki z tego tygodnia');
        t.is(meta.textContent, '12 s');

        for (const el of [title, summary, meta]) {
            t.false(el.textContent.includes('read'), `naglowek (${el.className}) nie ma prawa pokazac nazwy narzedzia`);
            t.false(el.textContent.includes('search'), `naglowek (${el.className}) nie ma prawa pokazac nazwy narzedzia`);
            t.false(/\d{3,}/.test(el.textContent), `naglowek (${el.className}) nie ma prawa pokazac liczby tokenow`);
        }
    });
});

test.serial('wynik: details ma akapity Task/Result i stopke Used: read, search', t => {
    withFakeDocument(() => {
        const row = createSubAgentBlock({
            type: 'delegate',
            status: 'success',
            agentName: 'czytelnik',
            query: 'Podsumuj notatki z tego tygodnia',
            response: 'Gotowe, oto podsumowanie.',
            toolsUsed: ['read', 'search', 'read'],
            duration: 12000,
        }) as unknown as FakeEl;

        // Wynik startuje ZWINIETY (status 'ok') - details renderuja sie leniwie przy PIERWSZYM
        // rozwinieciu (kontrakt Tile.ts), wiec test klika w naglowek jak realny user.
        findByClass(row, 'cs-tile__head')!.fire('click');

        const details = findByClass(row, 'cs-tile__details')!;
        t.true(details.textContent.includes('Task: Podsumuj notatki z tego tygodnia'), details.textContent);
        t.true(details.textContent.includes('Result: Gotowe, oto podsumowanie.'), details.textContent);
        t.true(details.textContent.includes('Used: read, search'), details.textContent);
        t.true(details.textContent.includes('(3 calls)'), 'liczba wywolan liczy KAZDE wywolanie, nie unikalne narzedzia');
    });
});

test.serial('blad: status error => cs-tile--error, kafelek startuje rozwiniety, details = komunikat + Task', t => {
    withFakeDocument(() => {
        const row = createSubAgentBlock({
            type: 'delegate',
            status: 'error',
            agentName: 'strateg',
            query: 'Zaplanuj tydzien',
            response: 'Blad: connection reset',
        }) as unknown as FakeEl;

        t.true(row.classList.contains('cs-tile--error'));
        t.true(row.classList.contains('is-expanded'), 'blad ma startowac rozwiniety');

        const details = findByClass(row, 'cs-tile__details')!;
        t.true(details.textContent.includes('Task: Zaplanuj tydzien'));
        t.true(details.textContent.includes('Blad: connection reset'));
        t.false(details.textContent.includes('Used:'), 'blad nie dostaje stopki narzedzi/tokenow');
    });
});

test.serial('pokwitowanie w tle: pending=true => cs-tile--pending, naglowek bez identyfikatora, identyfikator TYLKO w details jako ostatnia linia', t => {
    withFakeDocument(() => {
        const row = createSubAgentBlock({
            type: 'delegate',
            pending: true,
            status: 'success',
            agentName: 'badacz',
            query: 'Zbadaj temat X',
            response: 'Identyfikator: sub/pkm-sub#7',
        }) as unknown as FakeEl;

        t.true(row.classList.contains('cs-tile--pending'));
        t.false(row.classList.contains('cs-tile--error'));

        const title = findByClass(row, 'cs-tile__title')!;
        const summary = findByClass(row, 'cs-tile__summary')!;
        t.is(title.textContent, 'Sent to background: badacz');
        t.false(title.textContent.includes('sub/pkm-sub#7'), 'identyfikator nigdy w naglowku');
        t.is(summary.textContent, 'result will arrive as a notification');

        // Pokwitowanie w tle startuje ZWINIETE (status 'pending', nie 'error') - details
        // renderuja sie leniwie przy PIERWSZYM rozwinieciu.
        findByClass(row, 'cs-tile__head')!.fire('click');
        const details = findByClass(row, 'cs-tile__details')!;
        const detailLines = details.textContent.split('\n').filter(Boolean);
        t.is(detailLines[detailLines.length - 1], 'Identyfikator: sub/pkm-sub#7', 'ostatnia linia details = identyfikator');
    });
});

test.serial('blad suba bez tresci: "Sub-agent reported an error without details" (uwaga 7 - wlasny klucz, nie tekst narzedzia)', t => {
    withFakeDocument(() => {
        const row = createSubAgentBlock({
            type: 'delegate',
            status: 'error',
            agentName: 'strateg',
            query: 'Zaplanuj tydzien',
            response: '',
        }) as unknown as FakeEl;

        const details = findByClass(row, 'cs-tile__details')!;
        t.true(details.textContent.includes('Sub-agent reported an error without details'), details.textContent);
    });
});

test.serial('query jako OBIEKT (task z historii, ksztalt spoza kontraktu): naglowek bez [object Object] (uwaga 3)', t => {
    withFakeDocument(() => {
        const row = createSubAgentBlock({
            type: 'delegate',
            status: 'success',
            agentName: 'x',
            query: { a: 1 } as unknown as string,
            response: 'r',
        }) as unknown as FakeEl;

        const summary = findByClass(row, 'cs-tile__summary');
        t.falsy(summary, 'query nie-string pomijany calkowicie (typeof guard), zero [object Object] w naglowku');
    });
});

test.serial('createPendingSubAgentBlock: status pending, bez details (nie jest jeszcze toggleable)', t => {
    withFakeDocument(() => {
        const row = createPendingSubAgentBlock('delegate', 'czytelnik') as unknown as FakeEl;

        t.true(row.classList.contains('cs-tile--pending'));
        t.false(row.classList.contains('is-toggleable'), 'brak details/actions - kafelek jeszcze nic nie rozwija');

        const title = findByClass(row, 'cs-tile__title')!;
        t.is(title.textContent, 'Sub-agent czytelnik is working');
    });
});

// ── Uwaga 1 (spec A2-fix): pluralCalls - liczebnik "wywolan"/"calls" po ludzku ──

test('pluralCalls: odmiana polska (1 wywolanie, 2-4 wywolania poza 12-14, reszta wywolan)', t => {
    t.is(pluralCalls(1, 'pl'), '1 wywołanie');
    t.is(pluralCalls(2, 'pl'), '2 wywołania');
    t.is(pluralCalls(5, 'pl'), '5 wywołań');
    t.is(pluralCalls(12, 'pl'), '12 wywołań', 'wyjatek 12-14 - "wywolania" NIE pasuje mimo koncowki 2');
    t.is(pluralCalls(22, 'pl'), '22 wywołania', '22 konczy sie na 2, poza zakresem 12-14 - wraca "wywolania"');
    t.is(pluralCalls(25, 'pl'), '25 wywołań');
});

test('pluralCalls: odmiana angielska (1 call, reszta calls)', t => {
    t.is(pluralCalls(1, 'en'), '1 call');
    t.is(pluralCalls(2, 'en'), '2 calls');
    t.is(pluralCalls(5, 'en'), '5 calls');
    t.is(pluralCalls(12, 'en'), '12 calls');
    t.is(pluralCalls(22, 'en'), '22 calls');
    t.is(pluralCalls(25, 'en'), '25 calls');
});

test.serial('stopka suba uzywa pluralCalls - "Used: read, search (3 calls)" (en, bez zmian szablonu)', t => {
    withFakeDocument(() => {
        const row = createSubAgentBlock({
            type: 'delegate',
            status: 'success',
            agentName: 'czytelnik',
            query: 'q',
            response: 'r',
            toolsUsed: ['read', 'search', 'read'],
            duration: 12000,
        }) as unknown as FakeEl;

        findByClass(row, 'cs-tile__head')!.fire('click');
        const details = findByClass(row, 'cs-tile__details')!;
        t.true(details.textContent.includes('Used: read, search (3 calls)'), details.textContent);
    });
});

test.serial('czas po ludzku: 125000 ms => "2 min 5 s" (literalnie, ten sam wzorzec w obu jezykach)', t => {
    withFakeDocument(() => {
        const row = createSubAgentBlock({
            type: 'delegate',
            status: 'success',
            query: 'x',
            response: 'y',
            duration: 125000,
        }) as unknown as FakeEl;

        const meta = findByClass(row, 'cs-tile__meta')!;
        t.is(meta.textContent, '2 min 5 s');
    });
});
