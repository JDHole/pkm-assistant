/**
 * interpolation.test.ts — strażnik gałęzi interpolacji `t()` (audyt nocny 2026-08-31, moduł 13).
 *
 * DLACZEGO ten plik powstał w module WYDAJNOŚCI: doba 30.08 (fabryka F10 i18n) przepięła
 * kilkadziesiąt twardych napisów na `t()`, więc gałąź interpolacji jest dziś wołana z 471
 * miejsc. Zmierzone tej nocy: `t()` bez parametrów kosztuje 0,018 µs, z jednym parametrem
 * 0,398 µs — 22× więcej, bo pętla po parametrach kompiluje NOWY `RegExp` na każdy parametr
 * i każde wywołanie (`core/i18n/index.ts`). W liczbach bezwzględnych to setne milisekundy
 * przy realnym renderze, więc to NIE jest powód do optymalizacji — i ta uwaga jest tu
 * zapisana właśnie po to, żeby nikt nie zaczynał od niej.
 *
 * Powodem tego pliku jest to, co pomiar odsłonił po drodze: `String.prototype.replace`
 * z tekstowym zamiennikiem interpretuje w NIM wzorce `$&`, `$'`, `` $` `` i `$$`. Wartości
 * parametrów `t()` to nazwy plików, nazwy agentów i komunikaty błędów — czyli dane z vaulta
 * i z API, nie literały programisty. Dolar w takiej wartości nie ląduje w napisie dosłownie,
 * tylko rozwija się we fragment wzorca albo w otaczający tekst słownika.
 *
 * Zasięg: same inwarianty `t()`. Parytet PL/EN i istnienie kluczy pilnują `parity.test.ts`
 * i `parity_repo.test.ts` — tu nie duplikuję.
 */
import test from 'ava';
import { t, setLocale } from './index.js';
import { pl } from './pl.js';

/**
 * Klucz brany ze SŁOWNIKA, nie zapisany na sztywno: dokładna nazwa klucza z placeholderem
 * to nie jest inwariant, o który walczy ten plik, a wpis może zniknąć przy sprzątaniu i18n.
 * Szukam wpisu z DOKŁADNIE jednym placeholderem, żeby asercje miały jedno miejsce podmiany.
 */
function keyWithSinglePlaceholder(): { key: string; placeholder: string; text: string } | null {
    for (const [key, text] of Object.entries(pl)) {
        const hits = String(text).match(/\{\{[a-z0-9_]+\}\}/gi);
        if (hits && hits.length === 1) {
            return { key, placeholder: hits[0]!.slice(2, -2), text: String(text) };
        }
    }
    return null;
}

const SAMPLE = keyWithSinglePlaceholder();

// ── T1 ──────────────────────────────────────────────────────────────────────
test('i18n: bez `params` gałąź interpolacji w ogóle nie rusza — tekst słownika wraca nietknięty', t2 => {
    t2.truthy(SAMPLE, 'w słowniku PL nie ma ani jednego wpisu z jednym placeholderem — zmienił się kształt słownika');
    setLocale('pl');
    const { key, text } = SAMPLE!;
    t2.is(t(key), text, 'wywołanie bez parametrów podmieniło coś w tekście — to ma być czysty odczyt z mapy');
    t2.regex(t(key), /\{\{[a-z0-9_]+\}\}/i, 'placeholder zniknął mimo braku parametrów');
});

// ── T2 ──────────────────────────────────────────────────────────────────────
test('i18n: `params` podmienia KAŻDE wystąpienie placeholdera, nie tylko pierwsze', t2 => {
    setLocale('pl');
    // Klucz nieznany wraca sam do siebie (udokumentowane w parity_repo.test.ts), więc buduję
    // z niego tekst z dwoma tymi samymi placeholderami bez dotykania słownika.
    const out = t('{{x}} i {{x}}', { x: 'A' });
    t2.is(out, 'A i A', 'flaga `g` w regexie zamiany zniknęła — drugie wystąpienie nie zostało podmienione');
});

// ── T3 ──────────────────────────────────────────────────────────────────────
test('i18n: placeholder bez odpowiadającego parametru zostaje SUROWY, nie znika', t2 => {
    setLocale('pl');
    const out = t('{{a}} i {{b}}', { a: 'A' });
    t2.is(out, 'A i {{b}}', 'brakujący parametr przestał zostawiać placeholder — user zobaczy dziurę zamiast sygnału');
});

// ── T4 ──────────────────────────────────────────────────────────────────────
// Pin z nocy 2026-08-31 (czerwony na `replace(new RegExp(...), String(v))`), zdjęty naprawą
// `t()` 2026-09-02: `split(ph).join(String(v))` — wartość idzie do napisu dosłownie.
test('i18n: PIN — wartość parametru trafia do napisu DOSŁOWNIE, także gdy zawiera `$`', t2 => {
    setLocale('pl');
    // Wszystkie cztery formy są wzorcami zamiany w `String.prototype.replace`:
    // `$&` = całe dopasowanie, `$'` = tekst PO dopasowaniu, `` $` `` = tekst PRZED, `$$` = dolar.
    t2.is(t('[{{v}}]', { v: "a$&b" }), '[a$&b]', '`$&` rozwinął się w dopasowany placeholder');
    t2.is(t('[{{v}}] ogon', { v: "x$'y" }), "[x$'y] ogon", '`$\\u0027` wciągnął tekst po dopasowaniu');
    t2.is(t('czolo [{{v}}]', { v: 'p$`q' }), 'czolo [p$`q]', '`$`` wciągnął tekst przed dopasowaniem');
    t2.is(t('[{{v}}]', { v: 'd$$e' }), '[d$$e]', '`$$` zjadł jednego dolara');
});
