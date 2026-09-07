/**
 * `core/ui/safeHtml` — dwie funkcje, które zostały po dawnej warstwie renderu (V-09).
 *
 * Sanityzacja jest tu jedynym powodem istnienia `fragmentFromHtml`: fragment bywa budowany
 * z treści, której plugin nie napisał (odpowiedź modelu, notatka usera), więc `javascript:`
 * i atrybuty `on*` muszą zniknąć ZANIM trafi do DOM.
 */
import test from 'ava';

import { clearElement, fragmentFromHtml } from './safeHtml.js';

const html = (frag: DocumentFragment): string =>
    [...frag.childNodes].map(n => (n as HTMLElement).outerHTML ?? n.textContent ?? '').join('');

/**
 * Poza przeglądarką (AVA nie ma `document`) `fragmentFromHtml` oddaje atrapę `PlainNode`
 * o wąskim, udokumentowanym kształcie — ten interfejs opisuje dokładnie te pola, żeby
 * testy F10 mogły sprawdzać strukturę drzewa bez castowania do `HTMLElement` na siłę.
 */
interface PlainLike {
    readonly tagName: string;
    readonly textContent: string;
    readonly childNodes: PlainLike[];
    readonly outerHTML: string | undefined;
    readonly isText: boolean;
    querySelector(selector: string): PlainLike | null;
}

const asPlain = (frag: DocumentFragment): PlainLike => frag as unknown as PlainLike;

// ── C11.1 ────────────────────────────────────────────────────────────────────
test('fragmentFromHtml usuwa href/src z javascript:', t => {
    const frag = fragmentFromHtml(
        '<a href="javascript:alert(1)">klik</a><img src="JavaScript:alert(2)">',
    );
    const wynik = html(frag).toLowerCase();

    t.false(wynik.includes('javascript:'), 'schemat `javascript:` przeszedł do DOM');
    t.true(wynik.includes('klik'), 'sanityzacja zjadła treść, nie tylko atrybut');
});

// ── C11.2 ────────────────────────────────────────────────────────────────────
test('fragmentFromHtml usuwa atrybuty on*', t => {
    const frag = fragmentFromHtml('<div onclick="alert(1)" onmouseover="alert(2)">tekst</div>');
    const wynik = html(frag).toLowerCase();

    t.false(wynik.includes('onclick'), 'handler inline przeszedł do DOM');
    t.false(wynik.includes('onmouseover'));
    t.true(wynik.includes('tekst'));
});

// ── C11.3 ────────────────────────────────────────────────────────────────────
test('clearElement czyści dzieci', t => {
    const frag = fragmentFromHtml('<div id="cel"><span>a</span><span>b</span></div>');
    const el = (frag as unknown as { querySelector(sel: string): HTMLElement }).querySelector('#cel');

    clearElement(el);

    t.is(el.childNodes.length, 0);
});

// ═══ F10 — mutacje parsera i sanityzacji (core/ui/safeHtml.ts) ═══════════════

// ── F10.1 (NAME_CHARS musi łapać WSZYSTKIE cyfry, nie tylko 0-1) ──────────────
test('fragmentFromHtml zachowuje wszystkie cyfry w nazwie znacznika (np. h2)', t => {
    const frag = asPlain(fragmentFromHtml('<h2>Tytul</h2>'));
    const el = frag.querySelector('h2');

    t.truthy(el, 'znacznik "h2" zgubił cyfrę przy odczycie nazwy');
    t.is(el?.textContent, 'Tytul');
});

// ── F10.2 (wejście bez ŻADNEGO znacznika kończy parser normalnie) ────────────
test('fragmentFromHtml zwraca cały tekst bez zniekształceń, gdy wejście nie ma znaczników', t => {
    const frag = asPlain(fragmentFromHtml('hello world'));

    t.is(frag.childNodes.length, 1);
    t.true(frag.childNodes[0].isText);
    t.is(frag.textContent, 'hello world');
});

// ── F10.3 (niedomknięty komentarz nie przecieka treści) ──────────────────────
test('fragmentFromHtml nie przecieka treści niedomkniętego komentarza', t => {
    const frag = asPlain(fragmentFromHtml('<!-- oops'));

    t.is(frag.childNodes.length, 0);
    t.is(frag.textContent, '');
});

// ── F10.4 (parser idzie dalej po prawidłowo zamkniętym znaczniku) ────────────
test('fragmentFromHtml parsuje kolejny element po prawidłowo zamkniętym poprzednim', t => {
    const frag = asPlain(fragmentFromHtml('<div>hi</div><p>world</p>'));

    t.is(frag.childNodes.length, 2);
    t.true(frag.textContent.includes('hi'));
    t.true(frag.textContent.includes('world'));
});

// ── F10.5 (nazwa znacznika zamykającego musi pasować DOKŁADNIE) ──────────────
test('fragmentFromHtml domyka zagnieżdżony znacznik, tekst po nim trafia do rodzica jako rodzeństwo', t => {
    const frag = fragmentFromHtml('<div>a<span>b</span>c</div>');
    const wynik = html(frag);

    t.is(wynik, '<div>a<span>b</span>c</div>');
});

// ── F10.6 (domknięcie elementu NAJWYŻSZEGO poziomu, nie tylko zagnieżdżonego) ─
test('fragmentFromHtml domyka element najwyższego poziomu, kolejny tekst trafia do korzenia', t => {
    const frag = fragmentFromHtml('<div>a</div>b');
    const wynik = html(frag);

    t.is(wynik, '<div>a</div>b');
});

// ── F10.7 (niedomknięty cudzysłów atrybutu konsumuje resztę wejścia RAZ) ─────
// Realna właściwość parsera "tolerancyjnego": wartość bez zamykającego cudzysłowu
// leci do końca łańcucha w JEDNYM przebiegu, parser się kończy. (Bug bliźniaczy:
// zła arytmetyka tu potrafi cofnąć `i` do 0 i wejść w nieskończoną pętlę.)
test('fragmentFromHtml domyka niedomknięty cudzysłów atrybutu do końca wejścia', t => {
    const frag = fragmentFromHtml('<div attr="never closes');
    const wynik = html(frag);

    t.is(wynik, '<div attr="never closes"></div>');
});

// ── F10.8 (niedomknięta GOŁA wartość atrybutu na końcu wejścia) ──────────────
test('fragmentFromHtml domyka niedomkniętą, gołą (bez cudzysłowu) wartość atrybutu na końcu wejścia', t => {
    const frag = fragmentFromHtml('<div class=foo');
    const wynik = html(frag);

    t.is(wynik, '<div class="foo"></div>');
});

// ── F10.9 (encja liczbowa z cyfrą 0 musi dekodować się w CAŁOŚCI) ────────────
// `&#106;` = 'j' — pierwsza litera "javascript:" zaszyta jako encja HTML. Realny
// wektor obejścia filtra schematu, jeśli dekoder gubi cyfrę '0' w numerze encji.
test('fragmentFromHtml wykrywa javascript: gdy pierwsza litera jest encją liczbową (&#106;)', t => {
    const frag = fragmentFromHtml('<a href="&#106;avascript:alert(1)">klik</a>');
    const wynik = html(frag).toLowerCase();

    t.false(wynik.includes('href'), 'atrybut href z zakodowanym schematem javascript: przeszedł do DOM');
    t.true(wynik.includes('klik'), 'sanityzacja zjadła treść, nie tylko atrybut');
});

// ── F10.10 (granica Unicode 0x10FFFF/0x110000 nie może wywalić parsera) ──────
test('fragmentFromHtml nie rzuca na encji liczbowej dokładnie na granicy Unicode (0x110000)', t => {
    t.notThrows(() => {
        const frag = fragmentFromHtml('<a href="&#1114112;test">link</a>');
        html(frag);
    });
});

// ── F10.11 (schemat javascript: w ŚRODKU wartości stylu, nie tylko na początku) ─
test('fragmentFromHtml usuwa styl, gdy javascript: występuje w środku wartości', t => {
    const frag = fragmentFromHtml('<div style="background: url(javascript:alert(1))">x</div>');
    const wynik = html(frag).toLowerCase();

    t.false(wynik.includes('javascript:'), 'schemat javascript: w środku stylu przeszedł do DOM');
});

// ── F10.12 (outerHTML jest TYLKO dla elementów, nie dla węzłów tekstowych) ───
test('fragmentFromHtml udostępnia outerHTML na elemencie, nie tylko textContent', t => {
    const frag = asPlain(fragmentFromHtml('<div>hi</div>'));
    const el = frag.childNodes[0];

    t.is(el.outerHTML, '<div>hi</div>');
});

// ── F10.13 (querySelector nigdy nie dopasowuje węzła tekstowego) ─────────────
test('fragmentFromHtml querySelector nigdy nie dopasowuje węzła tekstowego do selektora', t => {
    const frag = asPlain(fragmentFromHtml('before<div id="cel">x</div>'));
    const el = frag.querySelector('#cel');

    t.truthy(el);
    t.is(el?.tagName, 'div');
});

// ── F10.14 (selektor klasy ".x" ≠ selektor znacznika "x") ────────────────────
test('fragmentFromHtml querySelector rozróżnia selektor klasy od selektora znacznika', t => {
    const frag = asPlain(fragmentFromHtml('<div class="foo">a</div><span>b</span>'));

    const byClass = frag.querySelector('.foo');
    t.truthy(byClass, 'selektor .foo powinien znaleźć element z tą klasą');
    t.is(byClass?.tagName, 'div');

    const byTag = frag.querySelector('span');
    t.truthy(byTag, 'selektor znacznika powinien znaleźć element po nazwie');
    t.is(byTag?.tagName, 'span');
});

// ── F10.15 (pierwsze NIEDOPASOWANE dziecko nie może zostać zwrócone) ─────────
test('fragmentFromHtml querySelector nie zwraca przypadkowego pierwszego dziecka, gdy ono nie pasuje', t => {
    const frag = asPlain(fragmentFromHtml('<span>x</span><div id="cel">y</div>'));
    const el = frag.querySelector('#cel');

    t.truthy(el);
    t.is(el?.tagName, 'div');
    t.is(el?.textContent, 'y');
});

// ── F10.16 (ścieżka PRAWDZIWEGO DOM, gdy `document` istnieje w środowisku) ───
// AVA nie ma `document` — ta ścieżka (browserDocument + toDom) inaczej nigdy się
// nie wykona. Podstawiamy minimalną atrapę `Document`, żeby przejść przez nią naprawdę.
interface FakeDomNode {
    kind: 'fragment' | 'element' | 'text';
    tagName?: string;
    text?: string;
    children: FakeDomNode[];
    attrs: Record<string, string>;
    appendChild(child: FakeDomNode): FakeDomNode;
    setAttribute(name: string, value: string): void;
}

const makeFakeDomNode = (kind: FakeDomNode['kind'], tagName?: string, text?: string): FakeDomNode => {
    const node: FakeDomNode = {
        kind,
        tagName,
        text,
        children: [],
        attrs: {},
        appendChild(child) { node.children.push(child); return child; },
        setAttribute(name, value) { node.attrs[name] = value; },
    };
    return node;
};

const fakeDocument = {
    createDocumentFragment: () => makeFakeDomNode('fragment'),
    createElement: (tag: string) => makeFakeDomNode('element', tag),
    createTextNode: (text: string) => makeFakeDomNode('text', undefined, text),
};

test('fragmentFromHtml buduje prawdziwe drzewo DOM, gdy document.createDocumentFragment istnieje', t => {
    const globalWithDocument = globalThis as unknown as { document?: unknown };
    const previous = globalWithDocument.document;
    globalWithDocument.document = fakeDocument;

    try {
        const frag = fragmentFromHtml('<div>tekst</div>') as unknown as FakeDomNode;

        t.is(frag.kind, 'fragment', 'browserDocument() nie rozpoznał atrapy Document jako prawdziwego DOM');
        t.is(frag.children.length, 1);

        const div = frag.children[0];
        t.is(div.kind, 'element', 'toDom pomylił gałąź elementu z gałęzią tekstu');
        t.is(div.tagName, 'div');
        t.is(div.children.length, 1);
        t.is(div.children[0].kind, 'text');
        t.is(div.children[0].text, 'tekst');
    } finally {
        if (previous === undefined) delete globalWithDocument.document;
        else globalWithDocument.document = previous;
    }
});

// ── F10.17 (wejście nie-stringowe, ale FAŁSZYWE-nie-nullish, np. `0`) ────────
// `String(html ?? '')` musi zostać nullish-coalescingiem: `0`, `false` to wartości,
// nie brak wartości — `||` zamieniłby je po cichu na pusty ciąg.
test('fragmentFromHtml dla nie-stringowego, fałszywego wejścia (0) oddaje jego tekst, nie pusty ciąg', t => {
    const wywolajZWartoscia = fragmentFromHtml as unknown as (input: unknown) => DocumentFragment;
    const frag = asPlain(wywolajZWartoscia(0));

    t.is(frag.textContent, '0');
});
