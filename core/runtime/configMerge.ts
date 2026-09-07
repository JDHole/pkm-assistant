/** Scalanie i kopiowanie worków konfiguracji — tylko to, czego runtime potrzebuje. */

/** Worek danych: zwykły obiekt o kluczach tekstowych. */
type Worek = Record<string, unknown>;

/** Pojemnik przepisywany strukturalnie — worek albo tablica. */
type Pojemnik = Worek | unknown[];

/**
 * Znacznik `Object.prototype.toString` dla gołego obiektu. Jednym porównaniem
 * odsiewa `null`, tablice, `Date`, `Map` i wartości proste — dlatego nie ma tu
 * osobnej drabinki strażników.
 */
const ZNACZNIK_WORKA = '[object Object]';

/** `true` dla zwykłego obiektu (nie tablica, nie `null`, nie instancja klasy). */
export function isPlainObject(value: unknown): value is Worek {
    if (Object.prototype.toString.call(value) !== ZNACZNIK_WORKA) return false;
    // Zostały: literał `{}`, `Object.create(null)` (np. po parserach YAML) i instancje
    // klas bez `Symbol.toStringTag`. Te ostatnie odróżnia dopiero prototyp.
    const rodzic = Object.getPrototypeOf(value) as unknown;
    return rodzic === Object.prototype || rodzic === null;
}

/** Czy wartość przepisujemy na nowo, czy przenosimy samą referencję. */
function czyPojemnik(wartosc: unknown): wartosc is Pojemnik {
    return Array.isArray(wartosc) || isPlainObject(wartosc);
}

/** Świeży, pusty pojemnik tego samego kształtu co wzorzec. */
function pustyJak(wzorzec: Pojemnik): Pojemnik {
    return Array.isArray(wzorzec) ? [] : {};
}

/**
 * Głęboka kopia worka danych. Kopiowane są WYŁĄCZNIE zwykłe obiekty i tablice;
 * funkcje, klasy, `Date` i cała reszta przechodzi przez referencję — bo `RuntimeConfig`
 * niesie dostawców i klienta HTTP, a te mają zostać TYMI SAMYMI instancjami.
 *
 * Przepisujemy iteracyjnie, po jawnej liście roboczej: głęboko zagnieżdżony worek
 * ustawień nie ma wtedy jak przewrócić stosu wywołań.
 */
export function cloneConfig<T>(value: T): T {
    if (!czyPojemnik(value)) return value;

    const korzen = pustyJak(value);
    /** Pary „skąd przepisać → dokąd wpisać", jeszcze nieobsłużone. */
    const doZrobienia: Array<[Pojemnik, Pojemnik]> = [[value, korzen]];

    while (doZrobienia.length > 0) {
        const zadanie = doZrobienia.pop();
        if (zadanie === undefined) break;
        const zrodlo = zadanie[0] as Worek;
        const cel = zadanie[1] as Worek;

        // Indeksy tablicy też są kluczami tekstowymi, więc oba kształty idą tą samą pętlą —
        // przypisanie pod `'0'` ustawia element i podciąga `length`.
        for (const klucz of Object.keys(zrodlo)) {
            const podwartosc = zrodlo[klucz];
            if (!czyPojemnik(podwartosc)) {
                cel[klucz] = podwartosc;
                continue;
            }
            const swiezy = pustyJak(podwartosc);
            cel[klucz] = swiezy;
            doZrobienia.push([podwartosc, swiezy]);
        }
    }

    return korzen as unknown as T;
}

/**
 * Deep-merge „tylko brakujące": wartości, które CEL już ma, zostają nietknięte —
 * dokładany jest wyłącznie ten kawałek źródła, którego w celu nie ma.
 *
 * Tą drogą fabryczne ustawienia dosztukowują się do worka usera: nowy klucz w wydaniu
 * pojawia się z wartością domyślną, a decyzja usera nigdy nie zostaje nadpisana.
 * Dokładane gałęzie są KOPIOWANE, więc worek nie zaczyna współdzielić obiektów z defaultami.
 */
export function deepMergeMissing<T extends object>(target: T, source: Partial<T>): T {
    if (!isPlainObject(target) || !isPlainObject(source)) return target;
    const cel = target as Worek;
    for (const key of Object.keys(source)) {
        const wartosc = (source as Worek)[key];
        if (!(key in cel) || cel[key] === undefined) {
            cel[key] = cloneConfig(wartosc);
            continue;
        }
        const obecna = cel[key];
        if (isPlainObject(obecna) && isPlainObject(wartosc)) deepMergeMissing(obecna, wartosc);
    }
    return target;
}
