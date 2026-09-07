/**
 * `core/http/transportErrors.ts` — budowa komunikatu błędu transportu i filtr sekretów.
 *
 * Testy przypinają zachowanie na granicach, które mutacje próbowały przesunąć: pusty adres,
 * granica długości sekretu (6 znaków), różnica wielkości liter przy maskowaniu i obecność/brak
 * ogona `[przyczyna]` w gotowym komunikacie.
 */
import test from 'ava';

import {
    adresBezSekretow,
    bezWartosciNaglowkow,
    bladTransportu,
    opisPrzyczyny,
    type OpisZadania,
} from './transportErrors.js';

// ── adresBezSekretow — L38/L39 ──────────────────────────────────────────────
test('adresBezSekretow: pusty adres daje czytelny placeholder, nie pusty string', t => {
    t.is(adresBezSekretow(''), '<brak adresu>');
});

test('adresBezSekretow: obcina zapytanie i fragment, zostaje sama ścieżka', t => {
    // Zapytanie bywa nośnikiem klucza API u części dostawców — to sedno funkcji, nie tylko
    // czyszczenie kosmetyczne. Wynik musi być prawdziwym stringiem (nie `undefined`), inaczej
    // komunikat błędu wyżej w łańcuchu wybuchłby przy konkatenacji.
    t.is(
        adresBezSekretow('https://api.example.test/v1/chat?key=sk-abcdef#anchor'),
        'https://api.example.test/v1/chat',
    );
});

// ── opisPrzyczyny — L48/L55/L74 ─────────────────────────────────────────────
test('opisPrzyczyny: obiekt bez name/code/cause daje "nieznana przyczyna", nie pusty string', t => {
    t.is(opisPrzyczyny({}), 'nieznana przyczyna');
});

test('opisPrzyczyny: prawdziwe pole `code` na obiekcie daje ten token', t => {
    t.is(opisPrzyczyny({ code: 'ECONNRESET' }), 'ECONNRESET');
});

test('opisPrzyczyny: wartość nie-obiektowa (null) nie wywala się i nie podaje fałszywego tokenu', t => {
    t.notThrows(() => opisPrzyczyny(null));
    t.is(opisPrzyczyny(null), 'nieznana przyczyna');
});

// ── bezWartosciNaglowkow — L86 (równoważność), L87, L90, L92 ────────────────
test('bezWartosciNaglowkow: wartość nagłówka od 6 znaków wzwyż jest maskowana', t => {
    const wynik = bezWartosciNaglowkow('Bearer abcdefgh w nagłówku', { 'x-api-key': 'abcdefgh' });
    t.is(wynik, 'Bearer [usunięto] w nagłówku');
});

test('bezWartosciNaglowkow: dokładnie 6 znaków to już próg maskowania (granica)', t => {
    const wynik = bezWartosciNaglowkow('token abcdef koniec', { 'x-tag': 'abcdef' });
    t.is(wynik, 'token [usunięto] koniec');
});

test('bezWartosciNaglowkow: 5 znaków to za mało — to już `no-cache`/`gzip`, nie sekret', t => {
    const wynik = bezWartosciNaglowkow('nagłówek abcde koniec', { 'x-tag': 'abcde' });
    t.is(wynik, 'nagłówek abcde koniec');
});

test('bezWartosciNaglowkow: maskuje TAKŻE wariant małymi literami, gdy różni się od oryginału', t => {
    const wynik = bezWartosciNaglowkow(
        'Wartość MySecretKEY123 oraz mysecretkey123 koniec',
        { 'x-secret': 'MySecretKEY123' },
    );
    t.is(wynik, 'Wartość [usunięto] oraz [usunięto] koniec');
});

test('bezWartosciNaglowkow: bez nagłówków tekst wraca bez zmian (prawdziwy string, nie undefined)', t => {
    t.is(bezWartosciNaglowkow('zwykły tekst bez sekretów', {}), 'zwykły tekst bez sekretów');
});

// ── bladTransportu — L113 ───────────────────────────────────────────────────
const zadanie: OpisZadania = {
    url: 'https://api.example.test/v1/chat',
    method: 'POST',
    headers: {},
};

test('bladTransportu: bez przyczyny komunikat nie ma ogona `[...]`', t => {
    const blad = bladTransportu('Nie udało się', zadanie, 'transport');
    t.is(blad.message, 'Nie udało się: POST https://api.example.test/v1/chat');
});

test('bladTransportu: z przyczyną komunikat kończy się tokenem w nawiasach', t => {
    const blad = bladTransportu('Nie udało się', zadanie, 'transport', { code: 'ECONNRESET' });
    t.is(blad.message, 'Nie udało się: POST https://api.example.test/v1/chat [ECONNRESET]');
});
