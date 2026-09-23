/**
 * embedTimeoutInput.test.ts — `parseEmbedTimeoutSeconds` (pole „Limit czasu żądania" embeddingu).
 */
import test from 'ava';
import { parseEmbedTimeoutSeconds } from './embedTimeoutInput.js';

const cases: Array<[raw: string, expected: number | null, why: string]> = [
    ['', null, 'puste pole = brak wpisu, usuń klucz'],
    ['0', null, 'zero nie znaczy „bez limitu"'],
    ['abc', null, 'śmieć nieliczbowy odrzucony'],
    ['-5', null, 'ujemna wartość odrzucona'],
    ['2.7', 3, 'zaokrąglenie do pełnej sekundy'],
    ['90', 90, 'liczba całkowita w widełkach przechodzi bez zmian'],
    ['5000', 3600, 'powyżej sufitu przycięte do 3600 s'],
];

for (const [raw, expected, why] of cases) {
    test(`parseEmbedTimeoutSeconds(${JSON.stringify(raw)}) === ${expected} (${why})`, t => {
        t.is(parseEmbedTimeoutSeconds(raw), expected);
    });
}
