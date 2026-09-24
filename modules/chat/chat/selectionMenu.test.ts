/**
 * `quoteText`/`insertAtCursor` - funkcje czyste za menu na zaznaczeniu (spec D, "Czat bez ścian").
 *
 * `installSelectionMenu` (montaż nasłuchów na `messages_container`/`document`, `window.getSelection`)
 * NIE ma tu testu: atrapa DOM-u z repo harnessu (`test-support/dom-shim.ts`) nie implementuje
 * `window.getSelection`/`Selection` - `skip: harness dom-shim nie ma window.getSelection, więc
 * pokazanie/ukrycie menu nie da się zweryfikować bez prawdziwej przeglądarki [measured, grep
 * "getSelection" w pkm-assistant-harness/test-support/dom-shim.ts - zero trafień]`.
 */
import test from 'ava';
import { quoteText, insertAtCursor } from './selectionMenu.js';
import type { CursorTextArea } from './selectionMenu.js';

// ── quoteText ──

test('quoteText: dwie linie dostają prefiks "> " i jedną pustą linię na końcu', t => {
    t.is(quoteText('a\nb'), '> a\n> b\n\n');
});

test('quoteText: pojedyncza linia', t => {
    t.is(quoteText('hello world'), '> hello world\n\n');
});

test('quoteText: pusta linia w środku zaznaczenia zostaje samym prefiksem', t => {
    t.is(quoteText('a\n\nb'), '> a\n> \n> b\n\n');
});

// ── insertAtCursor ──

test('insertAtCursor: wstawia w środku i przesuwa kursor na koniec wstawki (atrapa bez selectionEnd/setSelectionRange)', t => {
    const textarea: CursorTextArea = { value: 'abcdef', selectionStart: 3 };
    insertAtCursor(textarea, 'XYZ');
    t.is(textarea.value, 'abcXYZdef');
    t.is(textarea.selectionStart, 6);
    t.is(textarea.selectionEnd, 6);
});

test('insertAtCursor: kursor na końcu wartości dopisuje na końcu', t => {
    const textarea: CursorTextArea = { value: 'abc', selectionStart: 3 };
    insertAtCursor(textarea, '> quoted\n\n');
    t.is(textarea.value, 'abc> quoted\n\n');
    t.is(textarea.selectionStart, 13);
});

test('insertAtCursor: selectionStart null (pole nigdy nie miało fokusu) wstawia na końcu wartości', t => {
    const textarea: CursorTextArea = { value: 'abc', selectionStart: null };
    insertAtCursor(textarea, 'X');
    t.is(textarea.value, 'abcX');
    t.is(textarea.selectionStart, 4);
});

test('insertAtCursor: niepuste selectionEnd zastępuje zaznaczony fragment pola, nie tylko wstawia', t => {
    const textarea: CursorTextArea = { value: 'abcdef', selectionStart: 1, selectionEnd: 4 };
    insertAtCursor(textarea, 'Z');
    t.is(textarea.value, 'aZef');
    t.is(textarea.selectionStart, 2);
    t.is(textarea.selectionEnd, 2);
});

test('insertAtCursor: woła setSelectionRange na atrapie, gdy jest dostępne', t => {
    const calls: Array<[number, number]> = [];
    const textarea: CursorTextArea = {
        value: 'ab',
        selectionStart: 2,
        setSelectionRange: (start, end) => { calls.push([start, end]); },
    };
    insertAtCursor(textarea, 'c');
    t.deepEqual(calls, [[3, 3]]);
});
