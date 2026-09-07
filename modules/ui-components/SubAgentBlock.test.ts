/**
 * SubAgentBlock — pierwszy test w module (K7/AUD-code-review-044).
 *
 * `SubAgentBlock.ts` NIE importuje `obsidian`, ale woła `document.createElement(...).createDiv()`
 * — metody, które Obsidian dokleja do `HTMLElement.prototype` w runtime. Node/AVA nie ma ani
 * `document`, ani tych metod, więc test stawia MINIMALNĄ atrapę DOM-u (wzór
 * `modules/crystal-soul/SkinManager.test.ts` → `installFakeDom`), żeby wywołać PRAWDZIWĄ funkcję,
 * a nie tylko sprawdzić źródło regexem. `setSvg` (z `modules/crystal-soul/domUtils.ts`) sam
 * spada na `appendText` gdy `DOMParser` nie istnieje w globalu — atrapa nie musi go dawać.
 *
 * Sedno naprawy: `createSubAgentBlock` liczyło błąd z `opts.response?.startsWith('Błąd')` —
 * dopasowanie stringa, które sklejał WYŁĄCZNIE `chat_streaming.ts`. Odtwarzanie historii
 * (`chat_messages.ts`) nigdy tego prefiksu nie produkowało, więc padnięta delegacja po
 * przełączeniu zakładki albo powrocie suba z tła wracała jako zielone „gotowe" bez treści.
 * Dziś status jest JAWNYM polem `opts.status` ustawianym przez wołacza.
 */
import test from 'ava';
import { createSubAgentBlock } from './SubAgentBlock.js';

type FakeEl = {
    tagName: string;
    children: FakeEl[];
    classList: { add(c: string): void; remove(c: string): void; toggle(c: string): void; contains(c: string): boolean };
    className: string;
    textContent: string;
    appendText(t: string): void;
    empty(): void;
    createDiv(opts?: { cls?: string }): FakeEl;
    createSpan(opts?: { cls?: string; text?: string }): FakeEl;
    appendChild(child: FakeEl): FakeEl;
    addEventListener(ev: string, cb: () => void): void;
    addClass(c: string): void;
};

function makeFakeEl(tag = 'div'): FakeEl {
    const classes = new Set<string>();
    let text = '';
    const el: FakeEl = {
        tagName: tag,
        children: [],
        classList: {
            add: (c) => { classes.add(c); },
            remove: (c) => { classes.delete(c); },
            toggle: (c) => { classes.has(c) ? classes.delete(c) : classes.add(c); },
            contains: (c) => classes.has(c),
        },
        get className() { return [...classes].join(' '); },
        set className(v: string) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
        get textContent() { return text; },
        set textContent(v: string) { text = v; el.children = []; },
        appendText(t) { text += t; },
        empty() { text = ''; el.children = []; },
        createDiv(opts) { const c = makeFakeEl('div'); if (opts?.cls) c.className = opts.cls; el.children.push(c); return c; },
        createSpan(opts) { const c = makeFakeEl('span'); if (opts?.cls) c.className = opts.cls; if (opts?.text) c.textContent = opts.text; el.children.push(c); return c; },
        appendChild(child) { el.children.push(child); return child; },
        addEventListener() { /* noop — test nie klika w nagłówek */ },
        addClass(c) { classes.add(c); },
    } as FakeEl;
    return el;
}

/** Szuka pierwszego węzła (DFS) z klasą `cls` w drzewie zbudowanym przez `createSubAgentBlock`. */
function findByClass(root: FakeEl, cls: string): FakeEl | null {
    if (root.classList.contains(cls)) return root;
    for (const child of root.children) {
        const found = findByClass(child, cls);
        if (found) return found;
    }
    return null;
}

test.serial('createSubAgentBlock: status="error" świeci na czerwono, niezależnie od treści response', t => {
    const prevDoc = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { createElement: (tag: string) => makeFakeEl(tag) };
    try {
        // Treść BEZ polskiego literału „Błąd" — dawny string-match by to przepuścił jako sukces.
        const row = createSubAgentBlock({ type: 'delegate', status: 'error', response: 'Task failed: connection reset' }) as unknown as FakeEl;

        const status = findByClass(row, 'cs-action-row__status');
        t.truthy(status, 'nie znalazłem węzła statusu');
        t.true(status!.classList.contains('cs-action-row__status--error'));
        t.false(status!.classList.contains('cs-action-row__status--done'));

        const output = findByClass(row, 'cs-action-row__output');
        t.truthy(output, 'response niepuste — musi być węzeł wyjścia');
        t.true(output!.classList.contains('cs-action-row__output--error'));
    } finally {
        (globalThis as Record<string, unknown>).document = prevDoc;
    }
});

test.serial('createSubAgentBlock: status="success" świeci na zielono mimo polskiego słowa „Błąd" w treści', t => {
    const prevDoc = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { createElement: (tag: string) => makeFakeEl(tag) };
    try {
        // Treść ZAWIERA „Błąd" (np. agent cytuje własny błąd jako część udanej analizy) —
        // dawny string-match sprawdzał TYLKO prefiks, ale to pokazuje, że sygnałem jest pole,
        // nie zgadywanie po tekście.
        const row = createSubAgentBlock({ type: 'delegate', status: 'success', response: 'Znalazłem sekcję „Błąd" w dokumentacji i ją podsumowałem.' }) as unknown as FakeEl;

        const status = findByClass(row, 'cs-action-row__status');
        t.true(status!.classList.contains('cs-action-row__status--done'));
        t.false(status!.classList.contains('cs-action-row__status--error'));

        const output = findByClass(row, 'cs-action-row__output');
        t.false(output!.classList.contains('cs-action-row__output--error'));
    } finally {
        (globalThis as Record<string, unknown>).document = prevDoc;
    }
});

test.serial('createSubAgentBlock: response PUSTY + status="error" (odtworzone z historii) dalej świeci na czerwono', t => {
    const prevDoc = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { createElement: (tag: string) => makeFakeEl(tag) };
    try {
        // Reprodukcja sedna 044: chat_messages.ts (historia) nigdy nie sklejał prefiksu 'Błąd:' —
        // dopasowanie stringa dawało tu zawsze "success" na pustym wyniku. Dziś status stoi.
        const row = createSubAgentBlock({ type: 'delegate', status: 'error', response: '' }) as unknown as FakeEl;

        const status = findByClass(row, 'cs-action-row__status');
        t.true(status!.classList.contains('cs-action-row__status--error'), 'pusty response nie może udawać sukcesu');
    } finally {
        (globalThis as Record<string, unknown>).document = prevDoc;
    }
});

test.serial('createSubAgentBlock: pending=true wygrywa z status niezależnie od jego wartości', t => {
    const prevDoc = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { createElement: (tag: string) => makeFakeEl(tag) };
    try {
        const row = createSubAgentBlock({ type: 'delegate', pending: true, status: 'error', response: 'w toku' }) as unknown as FakeEl;

        const status = findByClass(row, 'cs-action-row__status');
        t.true(status!.classList.contains('cs-action-row__status--pending'));
        t.false(status!.classList.contains('cs-action-row__status--error'));
    } finally {
        (globalThis as Record<string, unknown>).document = prevDoc;
    }
});
