/**
 * save_session.noteFailures — strażnik OKABLOWANIA `result.noteFailures` (AUD-code-review-051).
 *
 * Dlaczego test po ŹRÓDLE, a nie po zachowaniu: `save_session.ts` importuje `obsidian`
 * (`Notice`, `App`) na górze modułu, więc AVA nie zaimportuje pliku produkcyjnego — to samo
 * ograniczenie opisane w `modules/chat/chat/chat_streaming.limits.test.ts` i
 * `modules/prompts/PromptBuilder.cache.test.ts`. Ten plik idzie dokładnie tym wzorem.
 *
 * Czego pilnuje: `SaveSessionWorkflow.applyDecision` (modules/memory) nie przerywa się już na
 * padzie jednej notatki i zwraca padnięte pozycje w opcjonalnym `result.noteFailures`. Bez
 * konsumenta po stronie czatu ten fix zamieniałby widoczną awarię w CICHĄ utratę notatki, którą
 * user właśnie zatwierdził — bo handler i tak strzelał bezwarunkowym Notice „gotowe". Ten test
 * pilnuje, żeby `noteFailures` było CZYTANE i renderowane osobnym, widocznym Notice.
 */
import test from 'ava';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./save_session.ts', import.meta.url), 'utf8');
const pl = fs.readFileSync(new URL('../../../core/i18n/pl.ts', import.meta.url), 'utf8');
const en = fs.readFileSync(new URL('../../../core/i18n/en.ts', import.meta.url), 'utf8');

test('runSaveSessionFlow czyta result.noteFailures', t => {
    t.true(
        source.includes('result.noteFailures'),
        '`result.noteFailures` zniknęło z handlera — padnięta notatka znowu ginie po cichu.',
    );
});

test('niepusta lista noteFailures dostaje WŁASNY Notice, nie wspólne „done"', t => {
    const od = source.indexOf('await applyPostArchiveAction(');
    t.true(od >= 0, 'Nie znaleziono `applyPostArchiveAction` — zmienił się kształt handlera.');

    const blok = source.slice(od, source.indexOf('if (result.shouldTriggerArchive)', od));
    t.true(blok.length > 0, 'Pusty blok po applyPostArchiveAction — zmienił się kształt handlera.');

    t.regex(
        blok,
        /result\.noteFailures\s*&&\s*result\.noteFailures\.length\s*>\s*0/,
        'Brak bramki na niepustą listę noteFailures.',
    );
    t.true(
        blok.includes("t('modal.save_session.notes_failed'"),
        'Gałąź niepustej listy nie woła nowego klucza i18n `modal.save_session.notes_failed`.',
    );
    t.true(
        blok.includes("t('modal.save_session.done')"),
        'Zwykła ścieżka (bez padów) straciła stary Notice „done".',
    );

    // Bramka musi POPRZEDZAĆ wywołanie starego `done` — inaczej oba Notice lecą naraz.
    const idxBramka = blok.search(/result\.noteFailures\s*&&\s*result\.noteFailures\.length\s*>\s*0/);
    const idxDone = blok.indexOf("t('modal.save_session.done')");
    t.true(idxBramka >= 0 && idxDone >= 0 && idxBramka < idxDone, 'Kolejność if/else w bloku Notice się zmieniła.');
});

test('modal.save_session.notes_failed istnieje w pl.ts i en.ts (z {{count}} i {{names}})', t => {
    for (const [label, text] of [['pl', pl], ['en', en]] as const) {
        const re = /'modal\.save_session\.notes_failed':\s*'[^']*\{\{count\}\}[^']*\{\{names\}\}[^']*'/;
        t.regex(text, re, `Klucz modal.save_session.notes_failed brakuje albo nie ma {{count}}/{{names}} w ${label}.ts`);
    }
});
