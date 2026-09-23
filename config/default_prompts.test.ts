/**
 * Strażnik: fabryczny szkielet kompresji (`defaultCompressionPrompt`) nie niesie em dash
 * (U+2014 „—") ani en dash (U+2013 „–") - to tekst, który trafia wprost do promptu modelu.
 * Zwykły dywiz „-" zastępuje oba. Komentarze w pliku źródłowym mogą dalej nosić te znaki -
 * ten test woła funkcję (widzi to, co naprawdę trafia do modelu), nie czyta źródła.
 */
import test from 'ava';
import { defaultCompressionPrompt } from './default_prompts.js';

const EM_DASH = '—';
const EN_DASH = '–';

function dashOccurrences(text: string): number {
    return [...text].filter(ch => ch === EM_DASH || ch === EN_DASH).length;
}

test('defaultCompressionPrompt(pl): zero em/en dash', t => {
    t.is(dashOccurrences(defaultCompressionPrompt('pl')), 0);
});

test('defaultCompressionPrompt(en): zero em/en dash', t => {
    t.is(dashOccurrences(defaultCompressionPrompt('en')), 0);
});

test('defaultCompressionPrompt(nieznany kod): fallback en, zero em/en dash', t => {
    t.is(dashOccurrences(defaultCompressionPrompt('xx')), 0);
});
