/**
 * `buildBackgroundReceiptText` (uwaga 5, spec A2-fix) - wyciągnięta z `_chatOnToolResults`
 * (`chat_streaming.ts`) czysta funkcja, żeby ta sama kolejność linii ("identyfikator zawsze
 * ostatni", werdykt właściciela: nigdy w nagłówku) obsługiwała zarówno pokwitowanie ŻYWEJ
 * delegacji w tle, jak i jej odtworzenie z HISTORII (`chat_messages.ts`, uwaga 10).
 *
 * Test zachowania na funkcji, nie na źródle - `chat_streaming.ts` importuje `obsidian`, ale
 * `buildBackgroundReceiptText` jest gołą, wołalną funkcją (ten sam wzorzec co `handle_error`,
 * patrz `handleError.tile.test.ts`), więc AVA z atrapą `obsidian` z repo harnessu importuje ją
 * bez problemu.
 */
import test from 'ava';
import { setLocale } from '../../../core/i18n/index.js';
import { buildBackgroundReceiptText } from './chat_streaming.js';

// Plik cały w locale 'pl' (dopasowanie do literalnego "Identyfikator:" ze spec-a2fix.md, uwaga
// 5) - `setLocale` mutuje globalny stan modułu i18n, więc jeden przełącznik na cały plik
// (każdy plik testowy AVA to osobny proces/worker) zamiast per-test teardown.
setLocale('pl');

test('jedno zadanie, bez kolejki: jedna linia - identyfikator', t => {
    t.is(
        buildBackgroundReceiptText([{ task_id: 'task-abc123' }], undefined),
        'Identyfikator: task-abc123',
    );
});

test('wiele zadan, z kolejka: "W kolejce" pierwsza, identyfikatory po niej, KAZDY identyfikator wlasna linia', t => {
    const text = buildBackgroundReceiptText([{ task_id: 't1' }, { task_id: 't2' }], 3);
    const lines = text.split('\n');
    t.is(lines.length, 3);
    t.is(lines[0], 'W kolejce: 3 - ruszą, gdy zwolni się miejsce.');
    t.is(lines[1], 'Identyfikator: t1');
    t.is(lines[2], 'Identyfikator: t2');
});

test('ostatnia linia ZAWSZE zaczyna sie od "Identyfikator:" - z kolejka i bez niej', t => {
    const withQueue = buildBackgroundReceiptText([{ task_id: 'a' }, { task_id: 'b' }, { task_id: 'c' }], 5);
    const withoutQueue = buildBackgroundReceiptText([{ task_id: 'x' }], 0);

    const lastWithQueue = withQueue.split('\n').filter(Boolean).pop()!;
    const lastWithoutQueue = withoutQueue.split('\n').filter(Boolean).pop()!;

    t.true(lastWithQueue.startsWith('Identyfikator:'), lastWithQueue);
    t.true(lastWithoutQueue.startsWith('Identyfikator:'), lastWithoutQueue);
});

test('queued=0 nie dokłada linii "W kolejce" (tylko queued > 0 się liczy)', t => {
    t.is(
        buildBackgroundReceiptText([{ task_id: 't1' }], 0),
        'Identyfikator: t1',
    );
});

test('zadanie bez task_id dostaje placeholder "?", nie pusty string ani wyjątek', t => {
    t.is(
        buildBackgroundReceiptText([{}], undefined),
        'Identyfikator: ?',
    );
});
