/**
 * `ToolCallDisplay` - testy zachowania dla `todo`/`chat_todo` i `ask_user` po spec A2 ("Czat bez
 * ścian"): werdykty właściciela "Lista zadań jest tragiczna. Po kliknięciu powinno się pokazywać
 * co się z nią stało." i "Nie rozumiem co to pokazuje [ask_user]. Ma być czytelne: pytanie i
 * odpowiedź."
 *
 * `formatToolOutput` nie jest eksportowane - test woła REALNY render przez `createToolCallDisplay`
 * (kafelek `.cs-tile` z `Tile.ts`), z tą samą minimalną atrapą `document` co
 * `SubAgentBlock.test.ts`/`Tile.test.ts`/`ToolCallDisplay.truncate.test.ts` w tym module.
 *
 * Locale: domyślne `'en'` (`core/i18n/index.ts`), literalne wartości oczekiwane wprost w tekście
 * testu - ten sam wybór co `ToolCallDisplay.describe.test.ts` i `ToolCallDisplay.truncate.test.ts`
 * w tym module (`setLocale` nigdzie w tym pliku).
 */
import test from 'ava';
import { createToolCallDisplay, createCompactToolChip } from './ToolCallDisplay.js';

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
    fire(type: string, ev?: unknown): void;
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
        set textContent(v: string) { text = v; el.children.forEach(c => { c.parent = null; }); el.children = []; },
        appendText(t) { text += t; },
        empty() { text = ''; el.children.forEach(c => { c.parent = null; }); el.children = []; },
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
        fire(type, ev = {}) { (el.listeners[type] || []).forEach(cb => cb(ev)); },
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

/** Rozwija kafelek (klik w `.cs-tile__head`) i oddaje jego `.cs-tile__details`. */
function expandAndGetDetails(row: FakeEl): FakeEl | null {
    const head = findByClass(row, 'cs-tile__head');
    head?.fire('click');
    return findByClass(row, 'cs-tile__details');
}

test.serial('todo: naglowek "1/3" (done/total), details ma CALA liste z ✓/○', t => {
    withFakeDocument(() => {
        const row = createToolCallDisplay({
            name: 'todo',
            status: 'success',
            output: {
                type: 'todo',
                done: 1,
                total: 3,
                items: [
                    { text: 'Zrobic A', done: true },
                    { text: 'Zrobic B', done: false },
                    { text: 'Zrobic C', checked: false },
                ],
            },
        }) as unknown as FakeEl;

        const summary = findByClass(row, 'cs-tile__summary');
        t.truthy(summary);
        t.is(summary!.textContent, '1/3', 'naglowek TYLKO licznik, bez pelnej listy');

        const details = expandAndGetDetails(row);
        t.truthy(details);
        t.true(details!.textContent.includes('✓ Zrobic A'), details!.textContent);
        t.true(details!.textContent.includes('○ Zrobic B'), details!.textContent);
        t.true(details!.textContent.includes('○ Zrobic C'), details!.textContent);
    });
});

test.serial('todo: tytul listy dopisany do naglowka, gdy agent go podal', t => {
    withFakeDocument(() => {
        const row = createToolCallDisplay({
            name: 'chat_todo',
            status: 'success',
            output: {
                type: 'todo',
                title: 'Refaktor A2',
                done: 0,
                total: 2,
                items: [
                    { text: 'X', done: false },
                    { text: 'Y', done: false },
                ],
            },
        }) as unknown as FakeEl;

        const summary = findByClass(row, 'cs-tile__summary')!;
        t.is(summary.textContent, '0/2 - Refaktor A2');
    });
});

test.serial('ask_user: naglowek pokazuje pytanie, details LITERALNIE "Question: ...\\nAnswer: ..." bez powtorzonego pytania (takze dla krotkiego pytania)', t => {
    withFakeDocument(() => {
        // `createCompactToolChip` (nie `createToolCallDisplay`): `includeRawArgs:false` zostawia
        // `_buildToolDetails` na plain-stringowej galezi (`detailsEl.textContent = d`), ktora ta
        // minimalna atrapa DOM potrafi odczytac - ten sam wzorzec co ask_user w
        // `ToolCallDisplay.truncate.test.ts` (patrz komentarz tam).
        const row = createCompactToolChip({
            name: 'ask_user',
            status: 'success',
            input: { question: 'Kontynuowac?' },
            output: { success: true, question: 'Kontynuowac?', answer: 'Tak', auto: false },
        }) as unknown as FakeEl;

        const summary = findByClass(row, 'cs-tile__summary')!;
        t.is(summary.textContent, 'Kontynuowac?', 'naglowek = pytanie, nie odpowiedz');

        const details = expandAndGetDetails(row);
        t.truthy(details);
        // B1 fix (spec A2-fix): asercja LITERALNA, nie `includes` - dwa osobne `includes` (stan
        // przed naprawa) przepuszczalyby tez zduplikowane pytanie ("Kontynuowac?\n\nQuestion:
        // Kontynuowac?\nAnswer: Tak"), dokladnie tak jak bylo przed B1.
        t.is(details!.textContent, 'Question: Kontynuowac?\nAnswer: Tak');
    });
});

test.serial('ask_user: details LITERALNIE obecne rowniez dla DLUGIEGO pytania (dawniej: tylko wtedy)', t => {
    withFakeDocument(() => {
        const longQuestion = 'Czy chcesz, zebym kontynuowal prace nad tym zadaniem i przeszedl od razu do kolejnego kroku planu, czy raczej wolisz najpierw przejrzec wyniki'; // > 100 znakow
        t.true(longQuestion.length > 100);
        const row = createCompactToolChip({
            name: 'ask_user',
            status: 'success',
            input: { question: longQuestion },
            output: { success: true, question: longQuestion, answer: 'Kontynuuj', auto: false },
        }) as unknown as FakeEl;

        const details = expandAndGetDetails(row);
        t.truthy(details);
        t.is(details!.textContent, `Question: ${longQuestion}\nAnswer: Kontynuuj`);
    });
});

test.serial('ask_user: porazka z HISTORII (chat_messages.ts poda error:tcOutput.error) - "ask_user.timeout" mapowany na tekst po ludzku, nie surowy kod (B1)', t => {
    withFakeDocument(() => {
        // Kanon `AskUserTool.ts`: porazka oddaje `{success:false, error, message, question}` BEZ
        // `answer` - `chat_messages.ts` dokleja `error: tcOutput.error` do `toolCall` przy
        // odtwarzaniu historii (ten sam kod, ktory tu symulujemy wprost).
        const row = createCompactToolChip({
            name: 'ask_user',
            status: 'error',
            input: { question: 'Kontynuowac?' },
            output: { success: false, error: 'ask_user.timeout', message: 'Uplynal czas', question: 'Kontynuowac?' },
            error: 'ask_user.timeout',
        }) as unknown as FakeEl;

        // Kafelek bledu startuje ROZWINIETY (status:'error', kontrakt Tile.ts) - details renderuja
        // sie leniwie PRZY KONSTRUKCJI, nie trzeba (i nie wolno, B3 pkt5) klikac w naglowek.
        const details = findByClass(row, 'cs-tile__details');
        t.truthy(details);
        t.is(details!.textContent, 'Question: Kontynuowac?\nAnswer: no answer within the time limit',
            'kod bledu zmapowany przez chat.tile.ask.timeout, NIE surowy "ask_user.timeout"');
    });
});

test.serial('ask_user: porazka z HISTORII, kod INNY niz timeout - chat.tile.ask.failed (B1)', t => {
    withFakeDocument(() => {
        const row = createCompactToolChip({
            name: 'ask_user',
            status: 'error',
            input: { question: 'Kontynuowac?' },
            output: { success: false, error: 'ask_user.denied', message: 'Odmowa', question: 'Kontynuowac?' },
            error: 'ask_user.denied',
        }) as unknown as FakeEl;

        const details = findByClass(row, 'cs-tile__details');
        t.truthy(details);
        t.is(details!.textContent, 'Question: Kontynuowac?\nAnswer: the question went unanswered');
    });
});

test.serial('todo: po finish (items puste, finished:true) - naglowek "Task list", summary/details "closed", nie "0/0" (uwaga 2)', t => {
    withFakeDocument(() => {
        const row = createToolCallDisplay({
            name: 'todo',
            status: 'success',
            output: { type: 'todo', items: [], done: 0, total: 0, finished: true },
        }) as unknown as FakeEl;

        const title = findByClass(row, 'cs-tile__title')!;
        t.is(title.textContent, 'Task list');

        const summary = findByClass(row, 'cs-tile__summary')!;
        t.is(summary.textContent, 'closed');

        const details = expandAndGetDetails(row);
        t.truthy(details);
        t.is(details!.textContent, 'closed');
    });
});
