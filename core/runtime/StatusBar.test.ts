/**
 * `StatusBar` (SB-01..SB-04) — pasek statusu nie miał ANI JEDNEGO testu, choć jest jedynym
 * miejscem, w którym user widzi, czy plugin żyje. Weryfikacja clean-room / F1 wskazała tę lukę.
 *
 * Wszystko stoi na atrapie elementu: `createStatusBar` sięga po pomocnicze metody Obsidiana
 * (`empty`, `createSpan`, `addClass`, `setText`) przez opcjonalny widok, więc test nie musi
 * importować `obsidian` ani stawiać DOM-u.
 */
import test from 'ava';

import { createStatusBar } from './StatusBar.js';
import { STATUS_BAR_CSS_CLASSES } from './contracts.js';
import type { LoggerLike, StatusBarRenderer } from './contracts.js';

/**
 * Mutacje F10 (`??` → `||`) na trzech liniach są RÓWNOWAŻNE — żaden test nie może
 * ich legalnie odróżnić, bo typ po lewej stronie nigdy nie niesie wartości fałszywej-
 * -a-nie-nullowej przez publiczny (typowany) interfejs:
 *
 * - `deps.log ?? globalLog` (typ `LoggerLike | undefined`) — obiekt jest zawsze truthy,
 *   więc różni się tylko dla `0`/`''`/`false`, których `LoggerLike` nie potrafi przyjąć.
 * - `tresc ?? kontener` (typ `ElementObsidiana | null`) — ta sama sytuacja: obiekt albo
 *   `null`, nigdy fałszywy-a-nie-null.
 * - `nowy ?? ''` w `setText(nowy: string)` — dowód matematyczny, nie tylko typowy:
 *   fallback JEST jedyną fałszywą wartością typu `string` (pusty string), więc dla
 *   KAŻDEGO możliwego wejścia (`''`, dowolny niepusty string, a nawet `null`/`undefined`
 *   przy wywołaniu z gołego JS) `??` i `||` dają identyczny wynik.
 */

const [CSS_ITEM, CSS_CLICKABLE] = STATUS_BAR_CSS_CLASSES;

// ── atrapy ───────────────────────────────────────────────────────────────────

interface Sluchacz {
    typ: string;
    fn: () => void;
}

interface Span {
    textContent: string | null;
    setText?: (text: string) => void;
}

interface Stan {
    klasy: Set<string>;
    sluchacze: Sluchacz[];
    oproznienia: number;
    dzieci: unknown[];
    span: Span | null;
    textContent: string | null;
}

interface Opcje {
    /** Czy `createSpan()` oddaje span z obsidianową metodą `setText` (druga gałąź `ustawTekst`). */
    spanZeSetText?: boolean;
    /** Element bez `createSpan` — tekst musi wtedy iść wprost na kontener. */
    bezCreateSpan?: boolean;
    /** `empty()` rzuca — pasek ma to przeżyć i tylko zalogować. */
    pekaNaEmpty?: boolean;
}

function makeKontener(opcje: Opcje = {}): { el: HTMLElement; stan: Stan; klik: () => void } {
    const stan: Stan = {
        klasy: new Set<string>(),
        sluchacze: [],
        oproznienia: 0,
        dzieci: [],
        span: null,
        textContent: null,
    };

    const el = {
        get textContent(): string | null { return stan.textContent; },
        set textContent(v: string | null) { stan.textContent = v; },
        empty(): void {
            if (opcje.pekaNaEmpty) throw new Error('empty() padło');
            stan.oproznienia++;
            stan.dzieci.length = 0;
            stan.span = null;
        },
        addClass(...klasy: string[]): void { for (const k of klasy) stan.klasy.add(k); },
        removeClass(...klasy: string[]): void { for (const k of klasy) stan.klasy.delete(k); },
        appendChild(dziecko: unknown): unknown { stan.dzieci.push(dziecko); return dziecko; },
        // Prawdziwy DOM ignoruje POWTÓRNE dodanie tej samej pary (typ, funkcja) — atrapa
        // robi tak samo, inaczej badałaby własną naiwność zamiast zachowania paska.
        addEventListener(typ: string, fn: () => void): void {
            if (stan.sluchacze.some(s => s.typ === typ && s.fn === fn)) return;
            stan.sluchacze.push({ typ, fn });
        },
        removeEventListener(typ: string, fn: () => void): void {
            const i = stan.sluchacze.findIndex(s => s.typ === typ && s.fn === fn);
            if (i >= 0) stan.sluchacze.splice(i, 1);
        },
    } as Record<string, unknown>;

    if (!opcje.bezCreateSpan) {
        el.createSpan = (): Span => {
            const span: Span = { textContent: null };
            if (opcje.spanZeSetText) span.setText = (text: string) => { span.textContent = text; };
            stan.span = span;
            return span;
        };
    }

    /** Odpalenie kliknięcia tak, jak zrobiłby to Obsidian. */
    const klik = (): void => {
        for (const s of [...stan.sluchacze]) if (s.typ === 'click') s.fn();
    };

    return { el: el as unknown as HTMLElement, stan, klik };
}

function makeLog(): { log: LoggerLike; ostrzezenia: unknown[][] } {
    const ostrzezenia: unknown[][] = [];
    const log: LoggerLike = {
        debug: () => {},
        info: () => {},
        warn: (...args: unknown[]) => { ostrzezenia.push(args); },
        error: () => {},
    };
    return { log, ostrzezenia };
}

// ── SB-01 ────────────────────────────────────────────────────────────────────
test('brak kontenera (goły Node) → null, zero wybuchu', t => {
    t.is(createStatusBar({ container: null }), null);
});

// ── SB-01 ────────────────────────────────────────────────────────────────────
test('postawienie paska: klasa bazowa, opróżnienie kontenera, własny span na treść', t => {
    const { el, stan } = makeKontener();

    const pasek = createStatusBar({ container: el });

    t.truthy(pasek);
    t.true(stan.klasy.has(CSS_ITEM), `pasek nie dostał klasy bazowej „${CSS_ITEM}"`);
    t.is(stan.oproznienia, 1, 'pasek nie posprzątał kontenera przed rysowaniem');
    t.truthy(stan.span, 'treść nie dostała własnego span-a');
});

// ── SB-04 ────────────────────────────────────────────────────────────────────
test('setText: „ładowanie" → „gotowe" ląduje w treści paska', t => {
    const { el, stan } = makeKontener();
    const pasek = createStatusBar({ container: el })!;

    pasek.setText('Ładowanie…');
    t.is(stan.span?.textContent, 'Ładowanie…');

    pasek.setText('Gotowe');
    t.is(stan.span?.textContent, 'Gotowe', 'druga zmiana tekstu nie doszła — pasek zamarł na pierwszym stanie');
});

// ── SB-04 ────────────────────────────────────────────────────────────────────
test('setText woli obsidianowe setText() od podmiany textContent', t => {
    const { el, stan } = makeKontener({ spanZeSetText: true });
    const pasek = createStatusBar({ container: el })!;

    pasek.setText('Gotowe');

    t.is(stan.span?.textContent, 'Gotowe');
});

// ── SB-04 ────────────────────────────────────────────────────────────────────
test('bez createSpan tekst idzie wprost na kontener', t => {
    const { el, stan } = makeKontener({ bezCreateSpan: true });
    const pasek = createStatusBar({ container: el })!;

    pasek.setText('Gotowe');

    t.is(stan.textContent, 'Gotowe', 'element bez pomocników Obsidiana został bez tekstu');
});

// ── SB-04 ────────────────────────────────────────────────────────────────────
test('tekst ustawiony PRZED przerysowaniem przeżywa refresh()', t => {
    const { el, stan } = makeKontener();
    const pasek = createStatusBar({ container: el })!;

    pasek.setText('Gotowe');
    pasek.refresh();

    t.is(stan.oproznienia, 2, 'refresh() nie przerysował paska');
    t.is(stan.span?.textContent, 'Gotowe', 'przerysowanie zgubiło tekst — pasek pustoszeje po pulsie pamięci');
});

// ── SB-02 ────────────────────────────────────────────────────────────────────
test('własny komponent (renderer) wchodzi do kontenera i przejmuje treść', t => {
    const wlasny: Span = { textContent: null };
    const renderer: StatusBarRenderer = { render: () => wlasny as unknown as HTMLElement };
    const { el, stan } = makeKontener();

    const pasek = createStatusBar({ container: el, renderer })!;
    pasek.setText('Gotowe');

    t.deepEqual(stan.dzieci, [wlasny], 'komponent z configu nie trafił do paska (SB-02)');
    t.is(wlasny.textContent, 'Gotowe', 'tekst poszedł obok komponentu z configu');
});

// ── SB-03 ────────────────────────────────────────────────────────────────────
test('setClickable: wariant klikalny + działający handler', t => {
    const { el, stan, klik } = makeKontener();
    const pasek = createStatusBar({ container: el })!;
    let kliki = 0;

    pasek.setClickable(() => { kliki++; });

    t.true(stan.klasy.has(CSS_CLICKABLE), `klikalny pasek nie dostał klasy „${CSS_CLICKABLE}"`);
    t.is(stan.sluchacze.length, 1, 'pasek nie podpiął słuchacza kliknięcia');

    klik();
    t.is(kliki, 1, 'kliknięcie nie doszło do handlera');
});

// ── SB-03 ────────────────────────────────────────────────────────────────────
test('setClickable(null) zdejmuje klasę i słuchacza', t => {
    const { el, stan, klik } = makeKontener();
    const pasek = createStatusBar({ container: el })!;
    let kliki = 0;

    pasek.setClickable(() => { kliki++; });
    pasek.setClickable(null);
    klik();

    t.false(stan.klasy.has(CSS_CLICKABLE));
    t.is(stan.sluchacze.length, 0, 'słuchacz kliknięcia został na wyłączonym pasku');
    t.is(kliki, 0, 'martwy handler dalej odpalał');
});

// ── SB-03 ────────────────────────────────────────────────────────────────────
test('podmiana handlera nie mnoży kliknięć', t => {
    const { el, klik } = makeKontener();
    const pasek = createStatusBar({ container: el })!;
    const wolane: string[] = [];

    pasek.setClickable(() => { wolane.push('pierwszy'); });
    pasek.setClickable(() => { wolane.push('drugi'); });
    klik();

    t.deepEqual(wolane, ['drugi'], 'stary handler przeżył podmianę albo kliknięcie poszło dwa razy');
});

// ── SB-03 ────────────────────────────────────────────────────────────────────
test('klikalność przeżywa przerysowanie', t => {
    const { el, stan, klik } = makeKontener();
    const pasek = createStatusBar({ container: el })!;
    let kliki = 0;

    pasek.setClickable(() => { kliki++; });
    pasek.refresh();
    klik();

    t.true(stan.klasy.has(CSS_CLICKABLE));
    t.is(kliki, 1, 'po przerysowaniu pasek przestał być klikalny');
});

// ── SB-01 ────────────────────────────────────────────────────────────────────
test('dispose: słuchacz zdjęty, kontener pusty, dalsze wołania to no-op', t => {
    const { el, stan, klik } = makeKontener();
    const pasek = createStatusBar({ container: el })!;
    let kliki = 0;

    pasek.setClickable(() => { kliki++; });
    pasek.setText('Gotowe');
    pasek.dispose();

    t.is(stan.sluchacze.length, 0, 'demontaż zostawił słuchacza kliknięcia — wyciek na cudzym elemencie');
    t.is(stan.oproznienia, 2, 'demontaż nie posprzątał kontenera');

    const oproznieniaPoDemontazu = stan.oproznienia;
    klik();
    pasek.setText('Zombie');
    pasek.setClickable(() => { kliki++; });
    pasek.refresh();
    pasek.dispose();

    t.is(kliki, 0, 'kliknięcie po demontażu dalej wołało handlera');
    t.is(stan.oproznienia, oproznieniaPoDemontazu, 'refresh() po demontażu wskrzesił pasek');
    t.is(stan.sluchacze.length, 0, 'setClickable() po demontażu podpiął nowego słuchacza — wyciek');
    // Klasa `CSS_CLICKABLE` po demontażu ZOSTAJE na elemencie i tak ma być: kontener należy
    // do Obsidiana (`addStatusBarItem()`), który usuwa go w całości przy wyłączeniu pluginu.
});

// ── SB-01 (pasek jest ozdobą, nie funkcją krytyczną) ─────────────────────────
test('pad elementu przy rysowaniu tylko loguje — nikt nie wybucha', t => {
    const { el } = makeKontener({ pekaNaEmpty: true });
    const { log, ostrzezenia } = makeLog();

    const pasek = createStatusBar({ container: el, log });

    t.truthy(pasek, 'pad ozdobnego paska zabrał ze sobą cały start');
    t.is(ostrzezenia.length, 1, 'pad paska przeszedł po cichu');
    t.notThrows(() => { pasek!.setText('Gotowe'); });
    t.notThrows(() => { pasek!.dispose(); });
});
