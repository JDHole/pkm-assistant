/**
 * Dwie pomocnicze funkcje DOM wyciągnięte z dawnej warstwy renderu (V-09).
 *
 * `fragmentFromHtml` SANITYZUJE: usuwa `javascript:` z atrybutów `href`/`src`
 * oraz wszystkie atrybuty `on*`.
 *
 * DLACZEGO WŁASNY PARSER, A NIE `innerHTML`:
 *   1. Sanityzacja przez DOM jest z definicji spóźniona — żeby wyciąć `onerror`,
 *      trzeba najpierw wkleić markup do dokumentu, a `<img src=x onerror=…>` odpala
 *      się już przy wklejeniu. Tutaj markup jest czyszczony JAKO TEKST i dopiero
 *      czysty trafia do DOM.
 *   2. Plik siedzi w `core/`, które MUSI wstawać w gołym Node (kontrakt K-01/K-03) —
 *      AVA nie ma `document`, `DocumentFragment` ani `DOMParser`. Parser własny działa
 *      w obu światach, więc test naprawdę bada tę samą ścieżkę, którą pójdzie Obsidian.
 *
 * Wynik jest PRAWDZIWYM `DocumentFragment`, gdy w środowisku jest `document`
 * (Obsidian); poza nim — lekką atrapą o tym samym, wąskim kształcie
 * (`childNodes` / `querySelector` / `textContent` / `outerHTML`).
 */

/** Znacznik bez treści — w serializacji nie dostaje pary zamykającej. */
const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Znaczniki kasowane w całości: wykonują kod albo ściągają cudze zasoby. */
const FORBIDDEN_TAGS = new Set([
    'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'meta', 'link',
]);

/** Atrybuty niosące adres — tylko one przechodzą kontrolę schematu. */
const URL_ATTRS = new Set(['href', 'src', 'srcset', 'action', 'formaction', 'poster', 'data', 'xlink:href']);

/** Schematy, których nie wpuszczamy do adresu ani do `style`. */
const FORBIDDEN_SCHEMES = ['javascript:', 'vbscript:', 'data:text/html'];

/** Nazwa znacznika / atrybutu w składni HTML (bez egzotyki, świadomie wąsko). */
const NAME_CHARS = /[A-Za-z0-9:_.-]/;

interface ParsedElement {
    tag: string;
    attrs: Array<{ name: string; value: string }>;
    children: ParsedNode[];
}
type ParsedNode = ParsedElement | { text: string };

const isElement = (node: ParsedNode): node is ParsedElement =>
    (node as ParsedElement).tag !== undefined;

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Tolerancyjny parser podzbioru HTML: znaczniki, atrybuty (w cudzysłowach, apostrofach
 * i gołe), samozamykanie, komentarze i tekst. Nie zna encji ani CDATA — nie musi:
 * treść tekstowa jedzie dalej dosłownie, a przy serializacji jest escape'owana.
 *
 * Niedomknięte znaczniki są domykane na końcu wejścia, a znacznik zamykający, który
 * nie pasuje do wierzchołka stosu, jest ignorowany — nigdy nie rzucamy, bo wołaczem
 * bywa treść, której plugin nie napisał.
 */
function parse(html: string): ParsedNode[] {
    const root: ParsedElement = { tag: '#root', attrs: [], children: [] };
    const stack: ParsedElement[] = [root];
    const top = (): ParsedElement => stack[stack.length - 1];
    let i = 0;

    const pushText = (text: string): void => {
        if (text) top().children.push({ text });
    };

    while (i < html.length) {
        const lt = html.indexOf('<', i);
        if (lt === -1) { pushText(html.slice(i)); break; }
        pushText(html.slice(i, lt));

        // Komentarz / deklaracja — pomijamy w całości.
        if (html.startsWith('<!', lt)) {
            const end = html.startsWith('<!--', lt) ? html.indexOf('-->', lt + 4) : html.indexOf('>', lt);
            if (end === -1) break;
            i = end + (html.startsWith('<!--', lt) ? 3 : 1);
            continue;
        }

        // Znacznik zamykający.
        if (html.startsWith('</', lt)) {
            const end = html.indexOf('>', lt);
            if (end === -1) break;
            const name = html.slice(lt + 2, end).trim().toLowerCase();
            const at = stack.findIndex(el => el.tag === name);
            if (at > 0) stack.length = at;
            i = end + 1;
            continue;
        }

        const parsed = parseOpenTag(html, lt);
        if (!parsed) { pushText(html.slice(lt)); break; }
        const { element, selfClosing, next } = parsed;
        top().children.push(element);
        if (!selfClosing && !VOID_TAGS.has(element.tag)) stack.push(element);
        i = next;
    }

    return root.children;
}

/** Wyłuskuje jeden znacznik otwierający zaczynający się na `start`. */
function parseOpenTag(
    html: string,
    start: number,
): { element: ParsedElement; selfClosing: boolean; next: number } | null {
    let i = start + 1;
    let tag = '';
    while (i < html.length && NAME_CHARS.test(html[i])) tag += html[i++];
    if (!tag) return null;

    const element: ParsedElement = { tag: tag.toLowerCase(), attrs: [], children: [] };
    let selfClosing = false;

    while (i < html.length) {
        while (i < html.length && /\s/.test(html[i])) i++;
        if (html[i] === '>') { i++; break; }
        if (html[i] === '/' ) { selfClosing = true; i++; continue; }

        let name = '';
        while (i < html.length && NAME_CHARS.test(html[i])) name += html[i++];
        if (!name) { i++; continue; }        // śmieć w środku znacznika — przeskakujemy

        while (i < html.length && /\s/.test(html[i])) i++;
        let value = '';
        if (html[i] === '=') {
            i++;
            while (i < html.length && /\s/.test(html[i])) i++;
            const quote = html[i];
            if (quote === '"' || quote === "'") {
                i++;
                const end = html.indexOf(quote, i);
                value = end === -1 ? html.slice(i) : html.slice(i, end);
                i = end === -1 ? html.length : end + 1;
            } else {
                while (i < html.length && !/[\s>]/.test(html[i])) value += html[i++];
            }
        }
        element.attrs.push({ name: name.toLowerCase(), value });
    }

    return { element, selfClosing, next: i };
}

// ── Sanityzacja ───────────────────────────────────────────────────────────────

/**
 * Sprowadza wartość atrybutu do postaci, w której da się rozpoznać schemat: rozwija
 * encje liczbowe (`&#106;` / `&#x6a;`), zdejmuje białe znaki i znaki sterujące
 * (klasyka obejścia: `java\tscript:`) i schodzi do małych liter.
 */
function normalizeUrlValue(value: string): string {
    const decoded = value.replace(/&#(x?)([0-9a-fA-F]+);?/g, (whole, hex: string, digits: string) => {
        const code = parseInt(digits, hex ? 16 : 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    });
    // Znaki sterujące SĄ tu celem: `java\tscript:` to klasyka obejścia filtra schematu.
    // eslint-disable-next-line no-control-regex -- wycinanie znaków sterujących to CAŁY sens tej funkcji
    return decoded.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
}

/** `true`, gdy wartość niesie schemat wykonujący kod. */
function hasForbiddenScheme(value: string): boolean {
    const normalized = normalizeUrlValue(value);
    return FORBIDDEN_SCHEMES.some(scheme => normalized.startsWith(scheme) || normalized.includes(scheme));
}

/** Zdejmuje z drzewa handlery inline, zabójcze schematy i zakazane znaczniki. */
function sanitize(nodes: ParsedNode[]): ParsedNode[] {
    const clean: ParsedNode[] = [];
    for (const node of nodes) {
        if (!isElement(node)) { clean.push(node); continue; }
        if (FORBIDDEN_TAGS.has(node.tag)) continue;
        clean.push({
            tag: node.tag,
            attrs: node.attrs.filter(attr => keepAttribute(attr.name, attr.value)),
            children: sanitize(node.children),
        });
    }
    return clean;
}

function keepAttribute(name: string, value: string): boolean {
    if (name.startsWith('on')) return false;                       // onclick, onmouseover, onerror…
    if (URL_ATTRS.has(name)) return !hasForbiddenScheme(value);
    if (name === 'style') return !hasForbiddenScheme(value);
    return true;
}

// ── Materializacja ────────────────────────────────────────────────────────────

const escapeText = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const escapeAttr = (value: string): string => escapeText(value).replace(/"/g, '&quot;');

/** Węzeł atrapy poza przeglądarką — dokładnie ten kształt, którego dotykają wołacze. */
class PlainNode {
    readonly tagName: string;
    readonly attributes: Array<{ name: string; value: string }>;
    childNodes: PlainNode[] = [];
    private text: string;

    constructor(tagName: string, text = '', attributes: Array<{ name: string; value: string }> = []) {
        this.tagName = tagName;
        this.text = text;
        this.attributes = attributes;
    }

    get isText(): boolean { return this.tagName === '#text'; }

    get textContent(): string {
        return this.isText ? this.text : this.childNodes.map(child => child.textContent).join('');
    }

    set textContent(value: string) {
        this.text = value;
        this.childNodes = [];
    }

    get outerHTML(): string | undefined {
        if (this.isText) return undefined;
        const attrs = this.attributes.map(a => ` ${a.name}="${escapeAttr(a.value)}"`).join('');
        const inner = this.childNodes.map(c => c.outerHTML ?? escapeText(c.textContent)).join('');
        return VOID_TAGS.has(this.tagName)
            ? `<${this.tagName}${attrs}>`
            : `<${this.tagName}${attrs}>${inner}</${this.tagName}>`;
    }

    get firstChild(): PlainNode | null { return this.childNodes[0] ?? null; }

    removeChild(child: PlainNode): PlainNode {
        this.childNodes = this.childNodes.filter(c => c !== child);
        return child;
    }

    /** Wąski selektor: `#id`, `.klasa`, `znacznik`. Tyle, ile potrzebują wołacze. */
    querySelector(selector: string): PlainNode | null {
        const match = (node: PlainNode): boolean => {
            if (node.isText) return false;
            if (selector.startsWith('#')) return node.attr('id') === selector.slice(1);
            if (selector.startsWith('.')) return (node.attr('class') ?? '').split(/\s+/).includes(selector.slice(1));
            return node.tagName === selector.toLowerCase();
        };
        for (const child of this.childNodes) {
            if (match(child)) return child;
            const deeper = child.querySelector(selector);
            if (deeper) return deeper;
        }
        return null;
    }

    private attr(name: string): string | undefined {
        return this.attributes.find(a => a.name === name)?.value;
    }
}

/** Czy w tym środowisku jest prawdziwy DOM (Obsidian) — czy gołe Node (testy, harness). */
function browserDocument(): Document | null {
    // `typeof` zamiast `globalThis.document`: w gołym Node zmienna po prostu nie istnieje,
    // a `window` nie ma tu prawa wystąpić — ten plik musi wstawać poza Obsidianem.
    if (typeof document === 'undefined') return null;
    return typeof document.createDocumentFragment === 'function' ? document : null;
}

function toDom(doc: Document, nodes: ParsedNode[], parent: Node): void {
    for (const node of nodes) {
        if (!isElement(node)) { parent.appendChild(doc.createTextNode(node.text)); continue; }
        let el: HTMLElement;
        try {
            el = doc.createElement(node.tag);
        } catch {
            // Nazwa, której przeglądarka nie przyjmuje — wpuszczamy samą treść.
            toDom(doc, node.children, parent);
            continue;
        }
        for (const attr of node.attrs) {
            try { el.setAttribute(attr.name, attr.value); } catch { /* nazwa nie do przyjęcia */ }
        }
        toDom(doc, node.children, el);
        parent.appendChild(el);
    }
}

function toPlain(nodes: ParsedNode[], parent: PlainNode): void {
    for (const node of nodes) {
        if (!isElement(node)) { parent.childNodes.push(new PlainNode('#text', node.text)); continue; }
        const el = new PlainNode(node.tag, '', node.attrs);
        toPlain(node.children, el);
        parent.childNodes.push(el);
    }
}

/**
 * Buduje fragment z kawałka HTML, po drodze go czyszcząc: leci każdy atrybut `on*`
 * i każdy adres ze schematem wykonującym kod (`javascript:`, `vbscript:`,
 * `data:text/html`), a znaczniki wykonujące kod albo ściągające cudze zasoby
 * (`script`, `iframe`, `object`, …) znikają w całości. Treść tekstowa zostaje.
 */
export function fragmentFromHtml(html: string): DocumentFragment {
    const clean = sanitize(parse(typeof html === 'string' ? html : String(html ?? '')));

    const doc = browserDocument();
    if (doc) {
        const fragment = doc.createDocumentFragment();
        toDom(doc, clean, fragment);
        return fragment;
    }

    const fragment = new PlainNode('#fragment');
    toPlain(clean, fragment);
    return fragment as unknown as DocumentFragment;
}

/** Czyści zawartość elementu. */
export function clearElement(el: HTMLElement): void {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
}
