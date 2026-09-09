/**
 * styleSheets - montaż i DEMONTAŻ konstruowanych arkuszy CSS.
 *
 * WHY: plugin wstrzykuje style przez `document.adoptedStyleSheets` (katalogowa alternatywa
 * dla `<style>`, patrz obsidianmd/no-forbidden-elements). Wiele miejsc dokłada arkusze
 * wzorcem „sprawdź `.includes` → rozwiń tablicę". Bez zdejmowania: wyłączony
 * plugin dalej nadpisywałby zmienne motywu aż do restartu Obsidiana, a każdy cykl wyłącz/włącz
 * dokładałby kolejne arkusze (świeży bundle = świeże obiekty `CSSStyleSheet`, więc `.includes`
 * starych nie widzi i tablica rośnie).
 *
 * RULE: arkusz wchodzi WYŁĄCZNIE przez `adoptSheet()` - wtedy trafia do rejestru modułu
 * i `removeAdoptedSheets()` w `onunload` zdejmuje go bez pytania właściciela o uchwyt.
 * Właściciele z jawnym uchwytem (SkinManager, motyw usera w main) wołają dodatkowo
 * `removeSheet()` w swoim `dispose()`.
 *
 * NOTE: celowo bez importu `obsidian` i bez `document` na sztywno - `host` jest parametrem,
 * więc helper testuje się atrapą, a plik zostaje w node-safe barrelu crystal-soul.
 */

/** Arkusz konstruowany. Luźny typ, żeby helper dało się sprawdzić bez DOM-u. */
export type AdoptableSheet = object;

/** Nosiciel arkuszy: `document` w runtime, atrapa w testach. */
export type SheetHost = { adoptedStyleSheets: AdoptableSheet[] };

/** Arkusze dołożone przez plugin — jedyne, które demontaż ma prawo zdjąć. */
const adopted = new Set<AdoptableSheet>();

function resolveHost(host?: SheetHost | null): SheetHost | null {
    if (host) return host;
    if (host === null) return null;
    if (typeof document === 'undefined') return null;
    return document;
}

/**
 * Dołóż arkusz do dokumentu (raz) i zapamiętaj go na potrzeby demontażu.
 * @returns true, jeśli arkusz jest po wywołaniu podpięty.
 */
export function adoptSheet(sheet: AdoptableSheet | null | undefined, host?: SheetHost | null): boolean {
    const target = resolveHost(host);
    if (!sheet || !target || !Array.isArray(target.adoptedStyleSheets)) return false;
    if (!target.adoptedStyleSheets.includes(sheet)) {
        target.adoptedStyleSheets = [...target.adoptedStyleSheets, sheet];
    }
    adopted.add(sheet);
    return true;
}

/**
 * Zdejmij JEDEN arkusz. Idempotentne — drugie wywołanie oddaje `false`, nie wyjątek.
 * Arkusze cudze (motyw Obsidiana, inne pluginy) zostają nietknięte.
 */
export function removeSheet(sheet: AdoptableSheet | null | undefined, host?: SheetHost | null): boolean {
    if (!sheet) return false;
    adopted.delete(sheet);
    const target = resolveHost(host);
    if (!target || !Array.isArray(target.adoptedStyleSheets)) return false;
    if (!target.adoptedStyleSheets.includes(sheet)) return false;
    target.adoptedStyleSheets = target.adoptedStyleSheets.filter(s => s !== sheet);
    return true;
}

/**
 * Zdejmij wszystkie arkusze pluginu — jedno wywołanie w `onunload`.
 * @returns ile arkuszy faktycznie zeszło z dokumentu.
 */
export function removeAdoptedSheets(host?: SheetHost | null): number {
    let removed = 0;
    for (const sheet of [...adopted]) {
        if (removeSheet(sheet, host)) removed++;
    }
    adopted.clear();
    return removed;
}
