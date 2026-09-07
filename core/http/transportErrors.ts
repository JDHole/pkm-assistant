/**
 * Prywatne narzędzia błędów podklastra `core/http` — JEDNA kopia dla obu klientów
 * i transportu strumienia.
 *
 * DLACZEGO OSOBNY PLIK: K20 („sekret nigdy w komunikacie błędu") to reguła
 * bezpieczeństwa, a nie kosmetyka — trzy kopie tego samego filtra rozjeżdżają się przy
 * pierwszej poprawce. Plik NIE wychodzi przez `core/index.ts`: jest szczegółem
 * wewnętrznym podklastra, konsument widzi tylko zwykły `Error`.
 *
 * ZASADA BUDOWY KOMUNIKATU: nie „bierzemy cudzy tekst i wycinamy z niego sekrety", tylko
 * SKŁADAMY komunikat z części, o których wiadomo, że sekretu nieść nie mogą (metoda, adres
 * bez zapytania, token kodu błędu). Filtr po nagłówkach jest drugą warstwą, na wypadek
 * gdyby dostawca upchnął klucz w miejscu, którego się nie spodziewamy.
 */

/** Kody, po których wołacz odróżnia trzy powody nieudanego żądania. */
export const KOD_PRZERWANE = 'aborted';
/** Twardy limit czasu żądania minął, zanim odpowiedź się domknęła. */
export const KOD_LIMIT_CZASU = 'timeout';
/** Awaria warstwy transportowej: brak sieci, zgaszony demon, zerwane połączenie, DNS. */
export const KOD_TRANSPORT = 'transport';

/** Błąd transportu z krótkim, maszynowym powodem — bez śladu nagłówków żądania. */
export interface HttpTransportError extends Error {
    code: string;
}

/** Znacznik wstawiany w miejsce wartości, która wyglądała na sekret. */
const ZAMIENNIK = '[usunięto]';

/**
 * Adres bez zapytania i fragmentu.
 *
 * Nie jest to kosmetyka: część dostawców przyjmuje klucz API w query stringu, więc pełny
 * adres w komunikacie błędu byłby wyciekiem równie dotkliwym jak nagłówek.
 */
export function adresBezSekretow(url: string): string {
    if (!url) return '<brak adresu>';
    return url.split('#')[0].split('?')[0];
}

/**
 * Token nadający się do komunikatu: krótki identyfikator w rodzaju `ECONNRESET` albo
 * `AbortError`. Wszystko, co ma spacje, cudzysłowy albo długość zdania, odrzucamy —
 * to już mógłby być zrzut czegoś większego.
 */
function tokenKodu(wartosc: unknown): string | null {
    return typeof wartosc === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/.test(wartosc)
        ? wartosc
        : null;
}

/** Odczyt pola z czegoś, co przyszło jako `unknown` — bez zakładania kształtu. */
function pole(obiekt: unknown, nazwa: string): unknown {
    return obiekt && typeof obiekt === 'object'
        ? (obiekt as Record<string, unknown>)[nazwa]
        : undefined;
}

/**
 * Zwięzły powód wyjęty z cudzego błędu — WYŁĄCZNIE tokeny (`name`, `code`, `cause.code`).
 * Treść `message` cudzego błędu NIE wchodzi: to jedyne miejsce, w którym mógłby przyjechać
 * adres z kluczem w zapytaniu albo echo nagłówka.
 */
export function opisPrzyczyny(blad: unknown): string {
    const przyczyna = pole(blad, 'cause');
    const tokeny = [
        tokenKodu(pole(blad, 'name')),
        tokenKodu(pole(blad, 'code')),
        tokenKodu(pole(przyczyna, 'code')),
        tokenKodu(pole(przyczyna, 'name')),
    ].filter((t): t is string => t !== null);
    const bezPowtorzen = [...new Set(tokeny)];
    return bezPowtorzen.length ? bezPowtorzen.join('/') : 'nieznana przyczyna';
}

/**
 * Druga warstwa K20: wycina z gotowego tekstu każdą wartość nagłówka, która wygląda na
 * sekret (od 6 znaków wzwyż — krótsze to `no-cache` czy `gzip`, nie klucze).
 *
 * Podmiana idzie funkcją, a nie łańcuchem: zamiennik z `$` bywa w JS traktowany jak
 * odwołanie do grupy i cicho psuje wynik.
 */
export function bezWartosciNaglowkow(tekst: string, naglowki: Record<string, string>): string {
    let wynik = tekst;
    for (const wartosc of Object.values(naglowki ?? {})) {
        if (typeof wartosc !== 'string' || wartosc.length < 6) continue;
        wynik = wynik.split(wartosc).join(ZAMIENNIK);
        const male = wartosc.toLowerCase();
        if (male !== wartosc) wynik = wynik.split(male).join(ZAMIENNIK);
    }
    return wynik;
}

/** Opis żądania w zakresie, w jakim wolno mu wejść do komunikatu błędu. */
export interface OpisZadania {
    url: string;
    method: string;
    headers: Record<string, string>;
}

/**
 * Buduje błąd transportu: krótkie zdanie po polsku + metoda + adres bez zapytania + token
 * przyczyny. Oryginalny błąd jedzie jako `cause` (pole NIEPRZELICZALNE — nie wchodzi do
 * `JSON.stringify`), żeby diagnostyka miała czego się chwycić.
 */
export function bladTransportu(
    zdanie: string,
    zadanie: OpisZadania,
    kod: string,
    przyczyna?: unknown,
): HttpTransportError {
    const ogon = przyczyna === undefined ? '' : ` [${opisPrzyczyny(przyczyna)}]`;
    const tresc = `${zdanie}: ${zadanie.method} ${adresBezSekretow(zadanie.url)}${ogon}`;
    const blad = new Error(bezWartosciNaglowkow(tresc, zadanie.headers), { cause: przyczyna }) as HttpTransportError;
    blad.name = 'HttpTransportError';
    blad.code = kod;
    return blad;
}
