/**
 * Filtr domen dla dostępu do sieci (E3.3, DEC L13-5c / L13-13).
 *
 * Dwie listy w `settings.pkmAssistant.webSearch`:
 * - `blockedDomains[]` — czarna lista, ma ZAWSZE pierwszeństwo,
 * - `allowedDomains[]` — biała lista; PUSTA = wszystko dozwolone (domyślnie),
 *   NIEPUSTA = tryb whitelisty (wszystko spoza listy odpada).
 *
 * Dopasowanie po HOŚCIE, z subdomenami: wpis `example.com` łapie `example.com`
 * ORAZ `sub.example.com` (ale nie `notexample.com`).
 *
 * Konsumenci: `web_search` odsiewa wyniki PO pobraniu (odfiltrowane nie trafiają
 * ani do wyniku, ani do rejestru znanych URL-i), `web_read` odmawia PRZED
 * requestem — fail-closed, tak jak bramka provenance.
 *
 * Pure: zero importów, zero I/O.
 */

/** Jedno pole listy domen: tablica hostów z dysku albo surowy tekst z Ustawień. */
export type DomainListInput = string | string[] | undefined;

/** Werdykt filtra dla jednego adresu. */
export type DomainVerdict = 'allowed' | 'blocked' | 'not_allowed';

/** Slice `settings.pkmAssistant.webSearch` w zakresie, który czyta filtr domen. */
export interface DomainFilterSettings {
    blockedDomains?: DomainListInput;
    allowedDomains?: DomainListInput;
}

/**
 * Normalizuje listę domen do samych hostów (lowercase, bez schematu/portu/ścieżki).
 * Przyjmuje tablicę albo tekst z pola w Ustawieniach (przecinki / średniki / nowe linie).
 *
 * Strażnik `typeof item !== 'string'` ZOSTAJE: elementy przychodzą z `data.json` usera,
 * gdzie deklarowany kształt jest kontraktem, a nie gwarancją.
 * @returns unikalne hosty
 */
export function parseDomainList(input: DomainListInput): string[] {
    const raw = Array.isArray(input)
        ? input
        : (typeof input === 'string' ? input.split(/[\n,;]+/) : []);

    const out: string[] = [];
    for (const item of raw) {
        if (typeof item !== 'string') continue;
        let host = item.trim().toLowerCase();
        if (!host) continue;

        host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // schemat
        host = host.split('/')[0];                          // ścieżka
        // `split` zawsze oddaje co najmniej jeden element, więc `pop()` nie jest tu `undefined`.
        host = host.split('@').pop() as string;              // user:pass@
        host = host.split(':')[0];                          // port
        host = host.replace(/^\*\./, '');                   // wildcard *.example.com
        host = host.replace(/^\.+/, '').replace(/\.+$/, '');// kropki brzegowe
        if (!host) continue;

        if (!out.includes(host)) out.push(host);
    }
    return out;
}

/** Host z URL-a, albo null gdy adres jest nieparsowalny. */
function hostOf(url: string): string | null {
    try {
        const host = new URL(String(url)).hostname.toLowerCase();
        return host.replace(/\.$/, '') || null;
    } catch {
        return null;
    }
}

function matchesList(host: string, list: string[]): boolean {
    return list.some(entry => host === entry || host.endsWith(`.${entry}`));
}

/**
 * Werdykt dla pojedynczego adresu.
 *
 * Gdy OBIE listy są puste (domyślna konfiguracja) → `'allowed'` natychmiast, bez
 * parsowania URL-a: filtr wyłączony = zero zmiany zachowania względem stanu przed E3.3.
 * Gdy filtr JEST skonfigurowany, adres nieparsowalny → `'blocked'` (fail-closed).
 *
 * @param url - adres do sprawdzenia (nieparsowalny = `'blocked'`, patrz wyżej)
 * @param ws - obiekt `settings.pkmAssistant.webSearch`
 */
export function checkDomain(url: string, ws: DomainFilterSettings = {}): DomainVerdict {
    const blocked = parseDomainList(ws?.blockedDomains);
    const allowed = parseDomainList(ws?.allowedDomains);
    if (blocked.length === 0 && allowed.length === 0) return 'allowed';

    const host = hostOf(url);
    if (!host) return 'blocked';

    if (matchesList(host, blocked)) return 'blocked';
    if (allowed.length > 0 && !matchesList(host, allowed)) return 'not_allowed';
    return 'allowed';
}
