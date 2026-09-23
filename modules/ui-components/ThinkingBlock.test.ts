/**
 * Blok myśli dopisuje DELTĘ zamiast podmieniać całość.
 *
 * `updateThinkingBlock` dostaje ślad rozumowania ZAKUMULOWANY od początku tury (adapter
 * dokłada deltę do `message.reasoning_content`), więc `content.textContent = text` przy każdym
 * wywołaniu przepisywałoby O(K × długość) znaków i przy rozwiniętym bloku wymuszało przeliczenie
 * układu (`scrollHeight`) - także wtedy, gdy nic się nie zmieniło.
 *
 * Atrapa `querySelector` niżej ROZRÓŻNIA `.cs-tile__details` (tekst) od `.cs-tile__body`
 * (kontener przewijany - B3 fix, recenzja A1-fix: przed naprawą oba selektory zwracały TEN SAM
 * obiekt, więc test „dojeżdża na dół" nie łapał, że kod przewijał zły element; `scrollTop`
 * jest teraz asercją na `.cs-tile__body`, dokładnie jak w prawdziwym CSS `chat_view.css`).
 *
 * `createThinkingBlock`/`finalizeThinkingBlock` budują/mutują DOM przez `Tile.ts`, który używa
 * gołego `document.createElement` + `el.empty()`/`el.appendText()` (NIE Obsidianowych
 * `createDiv`/`createSpan`) - więc idą do testu na tej samej minimalnej atrapie `document` co
 * `Tile.test.ts`/`ToolCallDisplay.truncate.test.ts`, `test.serial` bo atrapa siedzi na
 * `globalThis.document`, współdzielonym stanem między testami.
 */
import test from 'ava';
import { createThinkingBlock, finalizeThinkingBlock, updateThinkingBlock } from './ThinkingBlock.js';

// TS-any: atrapa węzła DOM - liczy zapisy, nie udaje pełnego Elementu.
type FakeAny = any;

function fakeBlock(open = false) {
    const content: FakeAny = {
        _text: '',
        appends: 0,
        appendedChars: 0,
        fullWrites: 0,
        writtenChars: 0,
        get textContent() { return this._text; },
        set textContent(value: string) { this._text = value; this.fullWrites++; this.writtenChars += value.length; },
        append(chunk: string) { this._text += chunk; this.appends++; this.appendedChars += chunk.length; },
    };
    const body: FakeAny = {
        scrollTop: 0,
        layoutReads: 0,
        get scrollHeight() { this.layoutReads++; return 1000; },
    };
    const selectors: Record<string, FakeAny> = {
        '.cs-tile__details': content,
        '.cs-tile__body': body,
    };
    const block: FakeAny = {
        classList: { contains: (cls: string) => cls === 'is-expanded' && open },
        querySelector: (sel: string) => selectors[sel] ?? null,
    };
    return { block, content, body };
}

/** Minimalna atrapa `document` dla `createThinkingBlock`/`finalizeThinkingBlock` (wołają
 *  `Tile.ts`'s `createTile`) - wzór identyczny z `Tile.test.ts`. */
function makeFakeEl(tag = 'div'): FakeAny {
    const classes = new Set<string>();
    const attrs = new Map<string, string>();
    let text = '';
    const el: FakeAny = {
        tagName: tag,
        children: [] as FakeAny[],
        parent: null as FakeAny,
        classList: {
            add: (...c: string[]) => c.forEach(x => classes.add(x)),
            remove: (...c: string[]) => c.forEach(x => classes.delete(x)),
            toggle: (c: string, force?: boolean) => {
                const next = force === undefined ? !classes.has(c) : force;
                if (next) classes.add(c); else classes.delete(c);
            },
            contains: (c: string) => classes.has(c),
        },
        get className() { return [...classes].join(' '); },
        set className(v: string) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
        get textContent(): string { return text + el.children.map((c: FakeAny) => c.textContent).join(''); },
        set textContent(v: string) { text = v; el.children = []; },
        empty() { text = ''; el.children = []; },
        appendText(t: string) { text += t; },
        append(t: string) { text += t; },
        setAttribute(n: string, v: string) { attrs.set(n, v); },
        getAttribute(n: string) { return attrs.has(n) ? attrs.get(n) : null; },
        removeAttribute(n: string) { attrs.delete(n); },
        hasAttribute(n: string) { return attrs.has(n); },
        appendChild(ch: FakeAny) { ch.parent = el; el.children.push(ch); return ch; },
        insertBefore(ch: FakeAny, ref: FakeAny) {
            ch.parent = el;
            const i = ref ? el.children.indexOf(ref) : -1;
            if (i >= 0) el.children.splice(i, 0, ch); else el.children.push(ch);
            return ch;
        },
        remove() { if (el.parent) { el.parent.children = el.parent.children.filter((c: FakeAny) => c !== el); el.parent = null; } },
        listeners: {} as Record<string, FakeAny[]>,
        addEventListener(type: string, cb: FakeAny) { (el.listeners[type] ||= []).push(cb); },
        fire(type: string, ev: FakeAny = {}) { (el.listeners[type] || []).forEach((cb: FakeAny) => cb(ev)); },
    };
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

test('rosnący ślad rozumowania dopisuje deltę, nie przepisuje całości', t => {
    const { block, content } = fakeBlock();

    let text = '';
    for (let i = 0; i < 200; i++) {
        text += 'rozumowanie ';
        updateThinkingBlock(block, text);
    }

    t.is(content.textContent, text, 'treść na ekranie musi być identyczna z zakumulowanym śladem');
    t.is(content.fullWrites, 1, 'pełne przepisanie tylko raz — przy pierwszym wywołaniu');
    t.is(content.appends, 199);
    // Liniowo, nie kwadratowo: przepisane znaki ≈ długość finalnego tekstu, a nie K × długość.
    const total = content.writtenChars + content.appendedChars;
    t.is(total, text.length);
    t.true(total < 200 * text.length / 10, `przepisano ${total} znaków — to nadal kwadrat`);
});

test('identyczny tekst = zero zapisów i zero wymuszonych przeliczeń układu', t => {
    const { block, content, body } = fakeBlock(true); // blok ROZWINIĘTY - tu boli `scrollHeight`
    updateThinkingBlock(block, 'ślad rozumowania');
    const writesAfterFirst = content.fullWrites + content.appends;
    const layoutAfterFirst = body.layoutReads;

    for (let i = 0; i < 3000; i++) updateThinkingBlock(block, 'ślad rozumowania');

    t.is(content.fullWrites + content.appends, writesAfterFirst, 'żadnego dodatkowego zapisu');
    t.is(body.layoutReads, layoutAfterFirst, 'żadnego dodatkowego odczytu scrollHeight');
});

test('rollback / podmiana treści = pełne przepisanie (nie doklejamy śmieci)', t => {
    const { block, content } = fakeBlock();
    updateThinkingBlock(block, 'pierwsza wersja rozumowania');
    updateThinkingBlock(block, 'zupełnie inna treść');

    t.is(content.textContent, 'zupełnie inna treść');
    t.is(content.fullWrites, 2);
    t.is(content.appends, 0);
});

test('rozwinięty blok nadal dojeżdża na dół po REALNEJ zmianie (przewija .cs-tile__body, nie .cs-tile__details)', t => {
    const { block, body } = fakeBlock(true);
    updateThinkingBlock(block, 'a');
    updateThinkingBlock(block, 'ab');
    t.is(body.layoutReads, 2, 'auto-scroll zachowany dla każdej zmiany treści');
    t.is(body.scrollTop, 1000);
});

test('zwinięty blok nie czyta scrollHeight w ogóle', t => {
    const { block, body } = fakeBlock(false);
    updateThinkingBlock(block, 'a');
    updateThinkingBlock(block, 'ab');
    t.is(body.layoutReads, 0);
});

test.serial('finalizeThinkingBlock: po wywolaniu blok ma status ok, jest zwiniety, bez is-streaming', t => {
    withFakeDocument(() => {
        const el = createThinkingBlock('abc', true, Date.now() - 1500) as unknown as FakeAny;
        t.true(el.classList.contains('is-streaming'), 'w trakcie streamingu blok ma is-streaming');
        t.true(el.classList.contains('cs-tile--pending'), 'w trakcie streamingu status jest pending');
        t.true(el.classList.contains('is-expanded'), 'w trakcie streamingu blok jest rozwiniety');

        finalizeThinkingBlock(el as unknown as HTMLElement);

        t.false(el.classList.contains('is-streaming'), 'is-streaming zdjete po finalize');
        t.true(el.classList.contains('cs-tile--ok'), 'status ok po finalize');
        t.false(el.classList.contains('cs-tile--pending'), 'pending zdjete po finalize');
        t.false(el.classList.contains('is-expanded'), 'kafelek zwiniety po finalize');
    });
});

test.serial('finalizeThinkingBlock na nieznanym elemencie (brak uchwytu w WeakMap): is-streaming schodzi zawsze, ALE status/rozwiniecie zostaja nietkniete; null/undefined nie wybuchaja', t => {
    withFakeDocument(() => {
        // B3 pkt5 (spec A2-fix): same `notThrows` nic nie sprawdzaly. Realna implementacja
        // (`ThinkingBlock.ts`) NIE jest calkowitym no-opem na obcym elemencie: `classList.remove
        // ('is-streaming')` leci BEZWARUNKOWO (sprzatanie kosmetycznej klasy, tanie i bezpieczne
        // nawet bez uchwytu), a WYLACZNIE trojka `setStatus`/`setTitle`/`expand` jest gated przez
        // `_tileHandles.get(block)` - element spoza WeakMap (nie powstal przez
        // `createThinkingBlock`) NIE dostaje zamiany statusu ani zwiniecia, bo Tile'owy uchwyt do
        // tego po prostu nie istnieje.
        const foreignEl = makeFakeEl('div') as unknown as FakeAny;
        foreignEl.classList.add('is-streaming', 'cs-tile--pending');
        const body = makeFakeEl('div') as unknown as FakeAny;
        body.className = 'cs-tile__body';
        body.setAttribute('hidden', '');
        foreignEl.appendChild(body);

        finalizeThinkingBlock(foreignEl as unknown as HTMLElement);

        t.false(foreignEl.classList.contains('is-streaming'), 'is-streaming schodzi zawsze, niezaleznie od WeakMap');
        t.true(foreignEl.classList.contains('cs-tile--pending'), 'brak uchwytu w WeakMap - status pending zostaje (NIE zamieniony na ok)');
        t.true(body.hasAttribute('hidden'), 'brak uchwytu w WeakMap - body zostaje ukryte (expand(false) sie nie wykonal)');

        t.notThrows(() => finalizeThinkingBlock(null));
        t.notThrows(() => finalizeThinkingBlock(undefined));
    });
});
