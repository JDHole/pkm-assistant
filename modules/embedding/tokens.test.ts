/**
 * tokens.test.ts — C-25 (AUTOR): estymata tokenów (znaki/3,7) i przycinanie do budżetu.
 * Napisany przed implementacją (czerwony na stubie — `estimateTokens`/`trimToTokenBudget`
 * rzucały `not implemented`), dziś zielony.
 */
import test from 'ava';
import { estimateTokens, trimToTokenBudget } from './tokens.js';
import { TOKEN_CHARS_PER_TOKEN } from './contracts.js';

test('estimateTokens: pusty tekst -> 0', t => {
    t.is(estimateTokens(''), 0);
});

test('estimateTokens: znaki / TOKEN_CHARS_PER_TOKEN, zaokrąglenie w górę', t => {
    const tekst = 'a'.repeat(10);
    t.is(estimateTokens(tekst), Math.ceil(10 / TOKEN_CHARS_PER_TOKEN));
});

test('trimToTokenBudget: tekst poniżej budżetu wraca bez zmian', t => {
    const tekst = 'krotki tekst';
    t.is(trimToTokenBudget(tekst, 1000), tekst);
});

test('trimToTokenBudget: nigdy nie tnie do zera', t => {
    const dlugiTekst = 'a'.repeat(6000);
    const przyciety = trimToTokenBudget(dlugiTekst, 1);
    t.true(przyciety.length > 0);
});

test('trimToTokenBudget: wynik mieści się w budżecie tokenów', t => {
    const dlugiTekst = 'a'.repeat(6000);
    const maxTokens = 100;
    const przyciety = trimToTokenBudget(dlugiTekst, maxTokens);
    t.true(estimateTokens(przyciety) <= maxTokens);
});

test('estimateTokens: tekst 1-znakowy -> 1 token, nie 0 (L20 - granica pustego tekstu)', t => {
    t.is(estimateTokens('a'), 1);
});

test('trimToTokenBudget: wejście nie-tekstowe (null) wraca bez zmian, bez rzutu (L31 - krótkie spięcie warunku)', t => {
    // typeof text !== 'string' MUSI zwrócić od razu, zanim ktokolwiek dotknie `.length`
    // (na null/undefined `.length` rzuca TypeError) - to jest test na kolejność warunku ||.
    const wejscie = null as unknown as string;
    t.is(trimToTokenBudget(wejscie, 10), wejscie);
});

test('trimToTokenBudget: maxTokens=0 -> budżet zapasowy 1, nie 0 (L33 - granica > 0)', t => {
    const dlugiTekst = 'a'.repeat(6000);
    const przyciety = trimToTokenBudget(dlugiTekst, 0);
    // budget=1 (bo 0 > 0 jest fałszem) -> maxChars = floor(1 * TOKEN_CHARS_PER_TOKEN)
    t.is(przyciety.length, Math.floor(1 * TOKEN_CHARS_PER_TOKEN));
    t.is(przyciety, dlugiTekst.slice(0, Math.floor(1 * TOKEN_CHARS_PER_TOKEN)));
});

test('trimToTokenBudget: maxTokens ułamkowy (0.5) -> budżet 0, minimum 1 znak (L33 num, L38 minimum)', t => {
    const dlugiTekst = 'a'.repeat(6000);
    const przyciety = trimToTokenBudget(dlugiTekst, 0.5);
    // budget = floor(0.5) = 0 (bo 0.5 > 0 jest prawdą) -> maxChars = max(1, floor(0*T)) = 1
    t.is(przyciety.length, 1);
    t.is(przyciety, dlugiTekst.slice(0, 1));
});

test('trimToTokenBudget: przycięty tekst zaczyna się od pierwszego znaku (L39 - offset slice)', t => {
    const tekst = 'ABCDEFGHIJ'.repeat(1000);
    const przyciety = trimToTokenBudget(tekst, 1);
    // budget=1 -> maxChars = floor(1 * TOKEN_CHARS_PER_TOKEN) = 3 -> pierwsze 3 znaki oryginału
    const oczekiwaneMaxChars = Math.floor(1 * TOKEN_CHARS_PER_TOKEN);
    t.is(przyciety, tekst.slice(0, oczekiwaneMaxChars));
    t.is(przyciety[0], tekst[0]);
});
