/**
 * dom-shim.ts — minimalna atrapa DOM towarzysząca atrapie `obsidian` (plik obok).
 *
 * Konsumenci ci sami co tam: preload AVA (`register-obsidian-for-ava.mjs`) i harness „Szklane
 * Pudło" z osobnego repo (https://github.com/JDHole/pkm-assistant-harness).
 *
 * PO CO: plugin startuje w czystym Node, gdzie NIE MA `document`/`window`. Bootstrap
 * dotyka DOM w kilku miejscach POZA try/catch (m.in. `showCrystalNotice` w
 * `src/main.js` — woła `document.createDocumentFragment().createEl(...)` PO ustawieniu
 * `_ready=true`), więc bez tego shimu proces wywala się na końcu udanego startu.
 *
 * ZASADA: to NIE jest jsdom. Dostarczamy tylko tyle DOM-u, ile realnie tyka ścieżka
 * `onload()+initialize()`. Element-atrapa (`createMockEl`) implementuje Obsidianowe
 * rozszerzenia prototypu (`createEl`/`createDiv`/`addClass`/`setText`/`empty`…) jako
 * łańcuchowalne no-opy; nieznane właściwości zwracają łańcuchowalny no-op (zamiast
 * `undefined`), żeby uciąć rundy debugowania na „X is not a function".
 *
 * TYPY: atrapa udaje otwarte API przeglądarki, więc kusi, żeby wpisać wszędzie `any` — i tak
 * było do 2026-09-07. Dziś ten plik jedzie razem z pluginem do walidatora katalogu Obsidiana,
 * a `any` zapala mu ~150 błędów `no-unsafe-*`. Zamiast tego: nazwane kształty (`MockEl`,
 * `ElOptions`) plus JEDNA furtka — indeks `[key: string]: unknown` w `MockEl`, który opisuje
 * dokładnie to, co robi Proxy niżej (nieznana nazwa = łańcuchowalny no-op). Zero zmian
 * zachowania: to są SAME adnotacje i rzutowania.
 *
 * Import tego pliku instaluje globale (side-effect). Harness importuje go PIERWSZY w swoich wejściach.
 */

/** Callback w stylu Obsidiana: `createEl('div', {…}, el => …)`. */
type ElCallback = (el: MockEl) => void;

/** Opcje elementu, tak jak przyjmuje je `createEl` Obsidiana. */
interface ElOptions {
  cls?: string | string[];
  text?: string | number | null;
  href?: string;
  type?: string;
  placeholder?: string;
  value?: string;
  title?: string;
  attr?: Record<string, unknown>;
}

/** Drugi argument `createEl`: opcje, sam callback albo goła nazwa klasy. */
type ElOptionsArg = ElOptions | ElCallback | string | undefined;

/** Prostokąt oddawany przez `getBoundingClientRect` — dokładnie tyle, ile atrapa obiecuje. */
interface MockRect {
  top: number; left: number; right: number; bottom: number;
  width: number; height: number; x: number; y: number;
}

/** `style`-atrapa: cokolwiek zapiszesz, przechodzi; czego nie zapisano, czyta się pustym stringiem. */
type MockStyle = Record<string, unknown>;

/** `classList`-atrapa: metody istnieją, ale nic nie pamiętają (atrapa nie renderuje). */
interface MockClassList {
  add(...names: string[]): void;
  remove(...names: string[]): void;
  toggle(name?: string, force?: boolean): boolean;
  contains(name?: string): boolean;
  replace(from?: string, to?: string): void;
}

/**
 * Element-atrapa. Pola i metody niżej to wszystko, czego realnie dotyka bootstrap pluginu;
 * indeks `[key: string]: unknown` jest kontraktem furtki z Proxy (nieznana nazwa → no-op).
 */
interface MockEl {
  tagName: string;
  nodeName: string;
  nodeType: number;
  className: string;
  id: string;
  textContent: string;
  innerHTML: string;
  innerText: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  href: string;
  src: string;
  type: string;
  placeholder: string;
  title: string;
  tabIndex: number;
  scrollTop: number;
  scrollHeight: number;
  scrollWidth: number;
  offsetHeight: number;
  offsetWidth: number;
  clientHeight: number;
  clientWidth: number;
  isConnected: boolean;
  children: MockEl[];
  childNodes: MockEl[];
  parentElement: MockEl | null;
  parentNode: MockEl | null;
  firstChild: MockEl | null;
  lastChild: MockEl | null;
  nextSibling: MockEl | null;
  previousSibling: MockEl | null;
  dataset: Record<string, string>;
  style: MockStyle;
  classList: MockClassList;

  createEl(tag: string, opts?: ElOptionsArg, cb?: ElCallback): MockEl;
  createDiv(opts?: ElOptionsArg, cb?: ElCallback): MockEl;
  createSpan(opts?: ElOptionsArg, cb?: ElCallback): MockEl;
  createSvg(tag?: string): MockEl;
  appendChild(c: MockEl): MockEl;
  append(...cs: unknown[]): void;
  prepend(...cs: unknown[]): void;
  removeChild(c: MockEl): MockEl;
  insertBefore(c: MockEl): MockEl;
  replaceChild(n: MockEl): MockEl;
  empty(): MockEl;
  detach(): MockEl;
  remove(): void;
  setText(txt: unknown): MockEl;
  getText(): string;
  setAttr(): MockEl;
  setAttrs(): MockEl;
  setAttribute(): void;
  removeAttribute(): void;
  getAttribute(): string | null;
  hasAttribute(): boolean;
  addClass(...names: string[]): MockEl;
  removeClass(...names: string[]): MockEl;
  toggleClass(names?: string | string[], force?: boolean): MockEl;
  setClass(names?: string): MockEl;
  hasClass(name?: string): boolean;
  addEventListener(): void;
  removeEventListener(): void;
  on(): MockEl;
  off(): MockEl;
  onClickEvent(): MockEl;
  trigger(): void;
  dispatchEvent(): boolean;
  querySelector(): MockEl | null;
  querySelectorAll(): MockEl[];
  find(): MockEl | null;
  findAll(): MockEl[];
  findAllSelf(): MockEl[];
  closest(): MockEl | null;
  matches(): boolean;
  contains(): boolean;
  focus(): void;
  blur(): void;
  click(): void;
  scrollIntoView(): void;
  scrollTo(): void;
  select(): void;
  getBoundingClientRect(): MockRect;
  getBoundingRect(): Omit<MockRect, 'x' | 'y'>;
  cloneNode(): MockEl;
  setCssStyles(): void;
  setCssProps(): void;
  show(): void;
  hide(): void;
  toggle(): void;
  toggleVisibility(): void;
  insertAdjacentElement(): MockEl | null;
  insertAdjacentHTML(): void;
  insertAdjacentText(): void;
  replaceWith(): void;
  before(): void;
  after(): void;
  getAttrs(): Record<string, string>;

  /** Furtka Proxy: każda inna nazwa oddaje łańcuchowalny no-op, nie `undefined`. */
  [key: string]: unknown;
}

/** Węzeł tekstowy/komentarz — jedyne, co atrapa dokumentu robi poza elementami. */
interface MockTextNode { textContent: unknown; nodeType: number }

/** `document`-atrapa: tyle metod, ile tyka bootstrap. */
interface MockDocument {
  body: MockEl;
  head: MockEl;
  documentElement: MockEl;
  adoptedStyleSheets: unknown[];
  createElement(tag: string): MockEl;
  createElementNS(ns: string, tag: string): MockEl;
  createDocumentFragment(): MockEl;
  createTextNode(txt: unknown): MockTextNode;
  createComment(txt: unknown): MockTextNode;
  querySelector(): MockEl | null;
  querySelectorAll(): MockEl[];
  getElementById(): MockEl | null;
  getElementsByClassName(): MockEl[];
  getElementsByTagName(): MockEl[];
  addEventListener(): void;
  removeEventListener(): void;
  createRange(): {
    selectNodeContents(): void;
    setStart(): void;
    setEnd(): void;
    getBoundingClientRect(): { top: number; left: number; width: number; height: number };
    getClientRects(): unknown[];
  };
}

/** Timer Node'a przebrany za DOM-owy: `unref()` jest tu, żeby proces mógł się zamknąć. */
type TimerLike = { unref?: () => void };

/** Globalny obiekt widziany jako otwarty worek — instalujemy do niego atrapy. */
type GlobalBag = Record<string, unknown>;

/** `style`-atrapa: `setProperty`/`removeProperty` no-op, dowolny `el.style.x = v` przechodzi. */
function createStyleProxy(): MockStyle {
  const s: MockStyle = {};
  return new Proxy(s, {
    get(t, p) {
      if (p === 'setProperty' || p === 'removeProperty') return () => {};
      if (p === 'getPropertyValue') return () => '';
      const v = t[p as string];
      return v === undefined ? '' : v;
    },
    set(t, p, v: unknown) { t[p as string] = v; return true; },
  });
}

/**
 * Tworzy atrapę elementu DOM z Obsidianowymi rozszerzeniami.
 */
export function createMockEl(tag: string = 'div'): MockEl {
  // Kształt budujemy w dwóch krokach (dane, potem metody), więc literał nie spełnia `MockEl`
  // od razu — stąd JEDNO rzutowanie tutaj, zamiast `any` w całym pliku.
  const base = {
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    nodeType: 1,
    className: '',
    id: '',
    textContent: '',
    innerHTML: '',
    innerText: '',
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    href: '',
    src: '',
    type: '',
    placeholder: '',
    title: '',
    tabIndex: 0,
    scrollTop: 0,
    scrollHeight: 0,
    scrollWidth: 0,
    offsetHeight: 0,
    offsetWidth: 0,
    clientHeight: 0,
    clientWidth: 0,
    isConnected: false,
    children: [] as MockEl[],
    childNodes: [] as MockEl[],
    parentElement: null,
    parentNode: null,
    firstChild: null,
    lastChild: null,
    nextSibling: null,
    previousSibling: null,
    dataset: {} as Record<string, string>,
    style: createStyleProxy(),
    classList: {
      add() {}, remove() {}, toggle() { return false; },
      contains() { return false; }, replace() {},
    } as MockClassList,
  } as unknown as MockEl;

  const applyOpts = (el: MockEl, opts: ElOptionsArg): void => {
    if (!opts || typeof opts !== 'object') {
      if (typeof opts === 'string') el.className = opts;
      return;
    }
    if (opts.cls) el.className = Array.isArray(opts.cls) ? opts.cls.join(' ') : opts.cls;
    if (opts.text != null) el.textContent = String(opts.text);
    if (opts.href != null) el.href = opts.href;
    if (opts.type != null) el.type = opts.type;
    if (opts.placeholder != null) el.placeholder = opts.placeholder;
    if (opts.value != null) el.value = opts.value;
    if (opts.title != null) el.title = opts.title;
    if (opts.attr && typeof opts.attr === 'object') Object.assign(el.dataset, {});
  };

  let proxy!: MockEl; // forward ref — metody zwracają `proxy` dla łańcuchowania

  const methods = {
    createEl(t: string, opts?: ElOptionsArg, cb?: ElCallback) {
      const child = createMockEl(t);
      applyOpts(child, opts);
      base.children.push(child);
      if (typeof opts === 'function') opts(child);
      if (typeof cb === 'function') cb(child);
      return child;
    },
    createDiv(opts?: ElOptionsArg, cb?: ElCallback) { return methods.createEl('div', opts, cb); },
    createSpan(opts?: ElOptionsArg, cb?: ElCallback) { return methods.createEl('span', opts, cb); },
    createSvg(t?: string) { return createMockEl(t || 'svg'); },
    appendChild(c: MockEl) { base.children.push(c); return c; },
    append(...cs: unknown[]) { for (const c of cs) if (c && typeof c === 'object') base.children.push(c as MockEl); },
    prepend(...cs: unknown[]) { for (const c of cs) if (c && typeof c === 'object') base.children.unshift(c as MockEl); },
    removeChild(c: MockEl) { const i = base.children.indexOf(c); if (i >= 0) base.children.splice(i, 1); return c; },
    insertBefore(c: MockEl) { base.children.push(c); return c; },
    replaceChild(n: MockEl) { return n; },
    empty() { base.children = []; return proxy; },
    detach() { return proxy; },
    remove() {},
    setText(txt: unknown) { base.textContent = txt == null ? '' : String(txt); return proxy; },
    getText() { return base.textContent; },
    setAttr() { return proxy; },
    setAttrs() { return proxy; },
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null; },
    hasAttribute() { return false; },
    addClass() { return proxy; },
    removeClass() { return proxy; },
    toggleClass() { return proxy; },
    setClass() { return proxy; },
    hasClass() { return false; },
    addEventListener() {},
    removeEventListener() {},
    on() { return proxy; },
    off() { return proxy; },
    onClickEvent() { return proxy; },
    trigger() {},
    dispatchEvent() { return true; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    find() { return null; },
    findAll() { return []; },
    findAllSelf() { return []; },
    closest() { return null; },
    matches() { return false; },
    contains() { return false; },
    focus() {}, blur() {}, click() {}, scrollIntoView() {}, scrollTo() {}, select() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; },
    getBoundingRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    cloneNode() { return createMockEl(tag); },
    setCssStyles() {}, setCssProps() {},
    show() {}, hide() {}, toggle() {}, toggleVisibility() {},
    insertAdjacentElement() { return null; },
    insertAdjacentHTML() {},
    insertAdjacentText() {},
    replaceWith() {}, before() {}, after() {},
    getAttrs() { return {}; },
  };

  Object.assign(base, methods);

  proxy = new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p as string];
      if (typeof p === 'symbol') return undefined;
      // Nieznana właściwość → łańcuchowalny no-op (ucina crash „X is not a function").
      return function () { return proxy; };
    },
    set(t, p, v: unknown) { t[p as string] = v; return true; },
    has() { return true; },
  });

  return proxy;
}

function createMockDocument(): MockDocument {
  const doc: MockDocument = {
    body: createMockEl('body'),
    head: createMockEl('head'),
    documentElement: createMockEl('html'),
    adoptedStyleSheets: [],
    createElement: (t: string) => createMockEl(t),
    createElementNS: (_ns: string, t: string) => createMockEl(t),
    createDocumentFragment: () => createMockEl('#fragment'),
    createTextNode: (txt: unknown) => ({ textContent: txt, nodeType: 3 }),
    createComment: (txt: unknown) => ({ textContent: txt, nodeType: 8 }),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    getElementsByClassName: () => [],
    getElementsByTagName: () => [],
    addEventListener() {},
    removeEventListener() {},
    createRange: () => ({
      selectNodeContents() {}, setStart() {}, setEnd() {},
      getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
      getClientRects() { return []; },
    }),
  };
  return doc;
}

// ── Globale Obsidiana (`createEl`/`createDiv`/`createSpan`/`createFragment`) ──
//
// PO CO: `obsidianmd/prefer-create-el` (walidator katalogu) chce, żeby kod pluginu wołał
// te GLOBALNE pomocnicze zamiast `document.createElement(...)`/`document.createDocumentFragment()`
// — one istnieją naprawdę w oknie renderera Obsidiana (wstrzyknięte przez `enhance.js` z
// pakietu aplikacji, zweryfikowane bezpośrednio w zainstalowanym Obsidianie 1.12.7: `window.createEl`
// = `document.createElement(tag)` + nałożenie opcji (`cls`/`text`/`attr`/...) + wywołanie
// callbacku; `window.createDiv`/`createSpan` = cienkie owijki `createEl('div'|'span', o, cb)`;
// `window.createFragment(cb)` = `document.createDocumentFragment()` + wywołanie callbacku).
// Harness (goły Node) ich nie miał — stąd `document.createElement`/`createDocumentFragment`
// w `src/main.ts` przed naprawą (ogony-ogA, fala 3, 2026-09-04). Implementacja niżej
// deleguje do `createMockEl`, które już umie nałożyć te same opcje (`applyOpts` w jego
// metodzie `createEl`) — jeden throwaway rodzic, zwracamy sam utworzony element/fragment.
function globalCreateEl(tag: string, opts?: ElOptionsArg, cb?: ElCallback): MockEl {
  const scratch = createMockEl('div');
  return scratch.createEl(tag, opts, cb);
}

function globalCreateFragment(cb?: ElCallback): MockEl {
  const frag = createMockEl('#fragment');
  if (typeof cb === 'function') cb(frag);
  return frag;
}

/**
 * Instaluje minimalne globale DOM/przeglądarki potrzebne bootstrapowi.
 * Idempotentne — nie nadpisuje istniejących (np. gdyby Node kiedyś dostał `document`).
 */
export function installDomShim() {
  const g = globalThis as unknown as GlobalBag;
  if (typeof g.document === 'undefined') {
    g.document = createMockDocument();
  }
  if (typeof g.window === 'undefined') {
    g.window = globalThis;
  }
  if (typeof g.open === 'undefined') {
    g.open = () => null;
  }
  if (typeof g.createEl === 'undefined') {
    g.createEl = globalCreateEl;
  }
  if (typeof g.createDiv === 'undefined') {
    g.createDiv = (o?: ElOptionsArg, cb?: ElCallback) => globalCreateEl('div', o, cb);
  }
  if (typeof g.createSpan === 'undefined') {
    g.createSpan = (o?: ElOptionsArg, cb?: ElCallback) => globalCreateEl('span', o, cb);
  }
  if (typeof g.createFragment === 'undefined') {
    g.createFragment = globalCreateFragment;
  }
  if (typeof g.navigator === 'undefined') {
    g.navigator = { userAgent: 'pkm-harness', clipboard: { writeText: async () => {}, readText: async () => '' }, language: 'en' };
  }
  if (typeof g.CSSStyleSheet === 'undefined') {
    g.CSSStyleSheet = class CSSStyleSheet {
      replaceSync() {}
      async replace() {}
      insertRule() { return 0; }
      deleteRule() {}
    };
  }
  if (typeof g.getComputedStyle === 'undefined') {
    g.getComputedStyle = () => createStyleProxy();
  }
  if (typeof g.requestAnimationFrame === 'undefined') {
    g.requestAnimationFrame = (cb: (t: number) => void) => {
      const id = setTimeout(() => cb(Date.now()), 0) as unknown as TimerLike;
      id?.unref?.();
      return id;
    };
    g.cancelAnimationFrame = (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>);
  }
  if (typeof g.CustomEvent === 'undefined') {
    g.CustomEvent = class CustomEvent {
      [key: string]: unknown;
      constructor(type: string, opts: { detail?: unknown } = {}) { this.type = type; this.detail = opts.detail; }
    };
  }
}

// Side-effect: instaluj globale przy imporcie.
installDomShim();
