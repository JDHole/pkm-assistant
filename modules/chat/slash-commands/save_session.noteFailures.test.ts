/**
 * save_session.noteFailures — strażnik OKABLOWANIA `result.noteFailures`.
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

// ── konsolidacja opcjonalna: `include` (recenzja #4b, doprecyzowane N4 recenzji rundy 3) ──
//
// Ten plik nie sprawdza już OKABLOWANIA `include: result.consolidationInclude` po źródle
// (usunięty test „przekazuje include" przypinał tekst kodu - regex nad blokiem wywołania
// `startConsolidationRun`, bez odpalenia realnej logiki). `startConsolidationRun` ma OBRONĘ
// W GŁĄB: gdy `source:'auto'` przyjdzie BEZ jawnego `include` (np. dlatego, że ten handler
// zapomniałby go przekazać), runner liczy politykę SAM przez `planAutoConsolidation` - ten sam
// wynik co `SaveSessionWorkflow.applyDecision`. Skutek KOŃCOWY (brain OFF + sesje ON -> plan ma
// L1, BRAK dedup mimo materiału na obie gałęzie) jest więc sprawdzony behawioralnie, bez zależności
// od tego pliku, w `consolidationRunner.test.ts`:
//  - `'include {sessions:true, dedup:false} (symulacja: brain OFF, sesje ON) -> plan ma L1, BRAK
//     dedup mimo materiału'` (include przekazane jawnie - kształt, jaki realnie wysyła
//     `save_session.ts`),
//  - `'source:auto BEZ include, memoryV3AutoConsolidateSessions:true w ustawieniach -> runner
//     liczy include SAM (L1 wchodzi, dedup nie)'` (obrona w głąb - dowodzi, że skutek końcowy
//     zostaje poprawny NAWET gdyby ten handler przestał przekazywać `include`).
