/**
 * `formatToolOutput`'s `catch` branch needs a ceiling on `detail` like every other branch does
 * (read/vault_read 2000, skill_execute 1000, web_read 500, generic strings 1500) — without one
 * it would be the only branch without a cap. A non-JSON tool result — the normal shape for EVERY
 * external MCP server tool, since `normalizeMcpResult` (`modules/tools/ExternalMcpManager.ts`)
 * joins the response into plain text — lands in this `catch` (JSON.parse throws), and the WHOLE
 * string would go into `detail`, which `createToolCallDisplay` puts into the Tile's
 * `.cs-tile__details` node.
 *
 * `formatToolOutput` is not exported, so the test drives it the way a real render does — through
 * `createToolCallDisplay`, which builds a `.cs-tile` via `Tile.ts`'s `createTile`. Node/AVA has
 * neither `document` nor DOM extensions, so this installs the same minimal fake DOM as
 * `SubAgentBlock.test.ts`/`Tile.test.ts`, and calls the REAL function, not a source regex.
 *
 * Tile's `details` render LAZILY on first expansion (2.3.0, Tile.ts) — a `.cs-tile` starts
 * collapsed unless its status is `error`, so these tests fire a click on `.cs-tile__head`
 * before reading `.cs-tile__details` (renamed from the pre-2.3.0 `.cs-action-row__detail`).
 * The behavior under test — the 2000-char ceiling itself — is unchanged; only the DOM class and
 * the need to expand first come from the Tile migration.
 */
import test from 'ava';
import { createCompactToolChip, createToolCallDisplay } from './ToolCallDisplay.js';

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
    createDiv(opts?: { cls?: string }): FakeEl;
    createSpan(opts?: { cls?: string; text?: string }): FakeEl;
    createEl(tag: string, opts?: { cls?: string; text?: string }): FakeEl;
    appendChild(child: FakeEl): FakeEl;
    insertBefore(child: FakeEl, ref: FakeEl | null): FakeEl;
    remove(): void;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    removeAttribute(name: string): void;
    hasAttribute(name: string): boolean;
    addEventListener(type: string, cb: Listener): void;
    fire(type: string, ev?: unknown): void;
    addClass(c: string): void;
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
        createDiv(opts) { const c = makeFakeEl('div'); if (opts?.cls) c.className = opts.cls; el.appendChild(c); return c; },
        createSpan(opts) { const c = makeFakeEl('span'); if (opts?.cls) c.className = opts.cls; if (opts?.text) c.textContent = opts.text; el.appendChild(c); return c; },
        createEl(tag2, opts) { const c = makeFakeEl(tag2); if (opts?.cls) c.className = opts.cls; if (opts?.text) c.textContent = opts.text; el.appendChild(c); return c; },
        appendChild(child) { child.parent = el; el.children.push(child); return child; },
        insertBefore(child, ref) {
            child.parent = el;
            const idx = ref ? el.children.indexOf(ref) : -1;
            if (ref && idx >= 0) el.children.splice(idx, 0, child);
            else el.children.push(child);
            return child;
        },
        remove() { if (el.parent) { el.parent.children = el.parent.children.filter(c => c !== el); el.parent = null; } },
        setAttribute(name, value) { attrs.set(name, value); },
        getAttribute(name) { return attrs.has(name) ? attrs.get(name)! : null; },
        removeAttribute(name) { attrs.delete(name); },
        hasAttribute(name) { return attrs.has(name); },
        listeners: {},
        addEventListener(type, cb) { (el.listeners[type] ||= []).push(cb); },
        fire(type, ev = {}) { (el.listeners[type] || []).forEach(cb => cb(ev)); },
        addClass(c) { classes.add(c); },
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

/**
 * B5 fix (recenzja A1-fix), regula nadrzedna (spec A2-fix): ciało kafelka skleja
 * `_composeTileBody(summaryText, detailText)` - `detailText` w calosci, gdy ZAWIERA
 * `summaryText` (`.includes()`), inaczej oba oddzielone pusta linia. Trzy testy niżej
 * zaktualizowane pod ten kontrakt - sufit 2000 zn. samego `formatToolOutput` (funkcja pod
 * testem w tym pliku) jest bez zmian, zmienia się tylko to, co `_buildToolDetails` z tych
 * dwóch pól SKŁADA do renderu.
 */
test.serial('formatToolOutput catch branch: non-JSON output longer than 2000 chars - detail capped, sam detail w ciele bo zawiera summary jako sufiks (regula nadrzedna)', t => {
    withFakeDocument(() => {
        // Not valid JSON -> formatToolOutput's JSON.parse throws -> catch branch.
        const longOutput = 'x'.repeat(5000);
        const row = createToolCallDisplay({
            name: 'external_server__some_tool', // unknown to TOOL_INFO - external MCP shape
            status: 'success',
            output: longOutput,
        }) as unknown as FakeEl;

        const expectedDetail = 'x'.repeat(1997) + '...'; // _truncate(s, 2000), same ceiling as read/vault_read
        const expectedSummary = 'x'.repeat(117) + '...'; // summary tnie sie na 120 zn.

        // Fixture zlozony z JEDNEGO powtarzajacego sie znaku, ucietego tym samym sufiksem "..." w
        // obu polach: ostatnie 120 znakow `expectedDetail` sa WIZUALNIE IDENTYCZNE z
        // `expectedSummary` (117 x-ow + "..."), wiec `expectedDetail.includes(expectedSummary)`
        // jest prawdziwe - `_composeTileBody` (regula nadrzedna, `.includes()` zamiast dawnego
        // `.startsWith()`) oddaje wtedy SAM `detailText`, bez powtorzenia summary. To swiadoma
        // zmiana zachowania tego konkretnego, sztucznie skonstruowanego fixture'u (decyzja
        // prowadzacego, spec A2-fix) - realna tresc uzytkownika prawie nigdy nie sklada sie z
        // jednego powtarzajacego sie znaku.
        t.true(expectedDetail.includes(expectedSummary), 'kontrola fixture: detail zawiera summary jako doslowny sufiks');

        const detail = expandAndGetDetails(row);
        t.truthy(detail, 'output dłuższy niż podsumowanie (120 zn.) musi dać węzeł details po rozwinięciu');
        t.is(detail!.textContent, expectedDetail, 'regula nadrzedna: detailText zawiera summaryText (jako sufiks) -> cialo = sam detailText, bez duplikacji');
        t.true(detail!.textContent.endsWith('...'), '_truncate dokleja wielokropek przy obcięciu detail');
    });
});

test.serial('formatToolOutput catch branch: non-JSON output under 2000 chars - cialo to sam pelny detail, uciete summary nie jest dublowane (B5, regula szczegolow)', t => {
    withFakeDocument(() => {
        const mediumOutput = 'y'.repeat(200); // > 120 (summary cap) but < 2000 (detail cap)
        const row = createToolCallDisplay({
            name: 'external_server__some_tool',
            status: 'success',
            output: mediumOutput,
        }) as unknown as FakeEl;


        const detail = expandAndGetDetails(row);
        t.truthy(detail);
        t.is(detail!.textContent, mediumOutput, 'B5: pelny detail bez dublowania ucietego summary (ponizej sufitu, bez zmian)');
    });
});

test.serial('formatToolOutput catch branch: short output (<=120 chars) - B5: pelna tresc w details, kafelek toggleable', t => {
    withFakeDocument(() => {
        const shortOutput = 'krótki wynik narzędzia';
        const row = createToolCallDisplay({
            name: 'external_server__some_tool',
            status: 'success',
            output: shortOutput,
        }) as unknown as FakeEl;

        // PRZED B5: output mieszczący się w podsumowaniu dawał `detail: null`, a
        // `_buildToolDetails` czytało WYŁĄCZNIE `fmt.detail` -> kafelek zostawał
        // nie-toggleable i treść (widoczna tylko w nagłówku) była nieosiągalna przez rozwinięcie.
        // PO B5: ciało zawsze niesie pełne `fmt.summary`, więc kafelek jest toggleable.
        t.true(row.classList.contains('is-toggleable'), 'B5: kazda niepusta tresc details wlacza toggle, nawet krotka');
        const detail = expandAndGetDetails(row);
        t.truthy(detail);
        t.is(detail!.textContent, shortOutput, 'B5: pelne summary trafia do details, nawet gdy miesci sie w naglowku');
    });
});

/**
 * B5, testy dokladnie ze specyfikacji ("Testy" w spec-a1fix.md): ask_user z 97-znakowa
 * odpowiedzia, wynik tekstowy 100 znakow nieznanego narzedzia, {success:false} bez pola error.
 * Locale nietkniety (domyslne 'en', jak w `ToolCallDisplay.describe.test.ts`).
 */
test.serial('B5/B1: ask_user - odpowiedz 97 znakow, details LITERALNIE "Question: ...\\nAnswer: ...", pytanie bez duplikacji', t => {
    withFakeDocument(() => {
        const answer = 'Tak, kontynuuj, ale najpierw zapisz notatke o spotkaniu i dodaj link do projektu w sekcji Zrodla.';
        t.is(answer.length, 97, 'kontrola dlugosci fixture (repro.log recenzji: answer length 97)');
        // createCompactToolChip (nie createToolCallDisplay): `includeRawArgs:false` zostawia
        // `_buildToolDetails` na plain-stringowej gałęzi (`detailsEl.textContent = d`), co ta
        // atrapa DOM potrafi odczytać. `createToolCallDisplay` z niepustym `input` dokłada
        // sekcję techniczną jako DZIECI węzła (funkcja `(body) => {...}`) - realny render to
        // obsługuje (`textContent` prawdziwego `HTMLElement`-u jest rekurencyjny), ale ta
        // MINIMALNA atrapa (`get textContent() { return text; }`, patrz góra pliku) nie agreguje
        // dzieci - to ograniczenie atrapy, nie zachowanie produkcyjne.
        const row = createCompactToolChip({
            name: 'ask_user',
            input: { question: 'Kontynuowac?' },
            output: { question: 'Kontynuowac?', answer },
            status: 'success',
        }) as unknown as FakeEl;

        const detail = expandAndGetDetails(row);
        t.truthy(detail);
        // B1 fix (spec A2-fix): asercja LITERALNA - dwa osobne `includes` (stan przed naprawa)
        // przepuszczaly zduplikowane pytanie ("Kontynuowac?\n\nQuestion: Kontynuowac?\nAnswer:
        // ..."), dokladnie tak jak bylo przed B1. Regula nadrzedna (`detailText.includes(summaryText)`)
        // sama usuwa duplikat, bo `q`="Kontynuowac?" jest summaryText, a detailText go zawiera.
        t.is(detail!.textContent, `Question: Kontynuowac?\nAnswer: ${answer}`);
    });
});

test.serial('B5: wynik tekstowy 100 znakow nieznanego narzedzia - details zawiera caly tekst', t => {
    withFakeDocument(() => {
        const output = 'z'.repeat(100);
        const row = createToolCallDisplay({
            name: 'external_server__another_tool',
            status: 'success',
            output,
        }) as unknown as FakeEl;

        const detail = expandAndGetDetails(row);
        t.truthy(detail);
        t.is(detail!.textContent, output, 'B5: caly tekst (100 zn., ponizej sufitu 120 summary) w details');
    });
});

test.serial('B5: {success:false} bez pola error (kom_send) - naglowek zostaje przy summary z wyniku, details = literalny tekst i18n', t => {
    withFakeDocument(() => {
        // createCompactToolChip: patrz komentarz w tescie ask_user wyzej - `input` niepuste +
        // `createToolCallDisplay` dokladaloby sekcje techniczna jako DZIECI (funkcja), ktorej ta
        // minimalna atrapa `textContent` nie agreguje.
        const row = createCompactToolChip({
            name: 'kom_send',
            input: { to: 'Ezra' },
            output: { success: false },
            status: 'error',
        }) as unknown as FakeEl;

        const summary = findByClass(row, 'cs-tile__summary');
        t.truthy(summary, 'B5: naglowek NIE gasnie do pustki, gdy brak pola error (toolCall.error) - zostaje summary z formatToolOutput');
        t.is(summary!.textContent, 'Send error', "tool.out.msg_error (en) - dokladnie to, co pokazuje formatToolOutput('kom_send', ...)");

        // B3 pkt5 (spec A2-fix): kafelek bledu (status:'error') startuje ROZWINIETY (kontrakt
        // Tile.ts) - details renderuja sie leniwie PRZY KONSTRUKCJI. `expandAndGetDetails`
        // klikalby w naglowek i ZWIJALBY juz rozwiniety kafelek (asercja sprawdzalaby stan PO
        // kliknieciu, nie stan poczatkowy) - czytamy `.cs-tile__details` wprost, bez klikania.
        const detail = findByClass(row, 'cs-tile__details');
        t.truthy(detail);
        t.is(detail!.textContent, 'Tool reported an error without details', 'B5: literalny tekst i18n chat.tile.tool.error_no_details (en) - fmt.detail jest null, wiec pada fallback');
    });
});

/**
 * B3 pkt 1, druga czesc (spec A2-fix): "komunikat 'bez opisu' TYLKO gdy naprawde nie ma zadnej
 * tresci" - zewnetrzne narzedzie z bledem i KROTKIM (<=120 zn., ponizej sufitu summary) opisem
 * tekstem (catch branch `formatToolOutput`, non-JSON output, jak w `probe5.mts` recenzji).
 * PRZED naprawa: `detail` zostawal `null`, bo `s.length > 120` bylo `false` - cialo padalo na
 * "bez opisu", mimo ze naglowek mial REALNY, krotki opis. PO naprawie: `detail` populowany
 * ZAWSZE, gdy jest jakikolwiek tekst - naglowek i cialo pokazuja TEN SAM krotki opis.
 */
test.serial('B3 pkt1: zewnetrzne narzedzie, blad, KROTKI opis tekstem (<=120 zn.) - cialo = ten opis, NIE "bez opisu"', t => {
    withFakeDocument(() => {
        const row = createCompactToolChip({
            name: 'srv__tool',
            status: 'error',
            output: 'Plik nie istnieje',
        }) as unknown as FakeEl;

        const summary = findByClass(row, 'cs-tile__summary')!;
        t.is(summary.textContent, 'Plik nie istnieje');

        // Kafelek bledu startuje rozwiniety - bez klikania (B3 pkt5, jak w testach wyzej).
        const detail = findByClass(row, 'cs-tile__details');
        t.truthy(detail);
        t.is(detail!.textContent, 'Plik nie istnieje', 'B3 pkt1: cialo = krotki, REALNY opis - nie literalny fallback "bez opisu"');
    });
});

/**
 * B2 (spec A2-fix): `TypeError` na nie-stringowym `fmt.detail`/`fmt.summary` - regresja
 * wzgledem HEAD zmierzona w recenzji (`detailText.startsWith is not a function` /
 * `appendChild: parameter 1 is not of type 'Node'`). Trzy wejscia z tabeli recenzenta,
 * dokladnie jak w `probe3.mts`.
 */
test.serial('B2: kom_send sukces z message OBIEKTEM - bez wyjatku, cialo czytelne (literalnie)', t => {
    withFakeDocument(() => {
        const row = createCompactToolChip({
            name: 'kom_send',
            input: {},
            output: { success: true, message: { a: 1 } },
            status: 'success',
        }) as unknown as FakeEl;

        const detail = expandAndGetDetails(row);
        t.truthy(detail);
        t.is(detail!.textContent, 'Message sent\n\n{"a":1}',
            'B2: summaryText ("Message sent") + detailText ustringowiony z obiektu przez JSON.stringify, bez wyjatku');
    });
});

test.serial('B2: idea_review z comments TABLICA - bez wyjatku', t => {
    withFakeDocument(() => {
        let row!: FakeEl;
        t.notThrows(() => {
            row = createCompactToolChip({
                name: 'idea_review',
                input: {},
                output: { comments: ['a', 'b'] },
                status: 'success',
            }) as unknown as FakeEl;
        });

        const detail = expandAndGetDetails(row);
        t.truthy(detail);
        t.is(detail!.textContent, 'Review\n\na\nb', 'B2: tablica ustringowiona przez join("\\n"), bez wyjatku');
    });
});

test.serial('B2: todo z action OBIEKTEM {length:100}, status error - bez wyjatku (regresja B2, dawniej appendChild na obiekcie)', t => {
    withFakeDocument(() => {
        let row!: FakeEl;
        t.notThrows(() => {
            row = createCompactToolChip({
                name: 'todo',
                input: {},
                output: { action: { length: 100 } },
                status: 'error',
            }) as unknown as FakeEl;
        });

        // Kafelek bledu startuje rozwiniety (jak w tescie kom_send wyzej) - bez klikania.
        const detail = findByClass(row, 'cs-tile__details');
        t.truthy(detail);
        t.is(detail!.textContent, 'Tool reported an error without details',
            'B2: summaryText ustringowiony ({"length":100}, <=80 zn.) bez detailText realnego - pada fallback error_no_details, nie wyjatek');
    });
});
