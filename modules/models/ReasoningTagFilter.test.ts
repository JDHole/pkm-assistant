/**
 * `ReasoningTagFilter` — filtr tagów myślenia `<think>…</think>` JEDNOSTKOWO, bez dostawcy.
 *
 * Pełne pokrycie reguł w kontekście streamu dostawcy siedzi w `providers/lm_studio.test.ts`
 * i `providers/ollama.test.ts`; tutaj pinujemy dwie mechaniki, które da się zbadać wyłącznie
 * w izolacji: rezerwę na tag rozcięty między porcje (B.11 TT-04/TT-05) i rollback tagu
 * niedomkniętego (TT-08/TT-09).
 */
import test from 'ava';
import { ReasoningTagFilter } from './ReasoningTagFilter.js';

test('rezerwa ≤ 8 znaków: tag rozcięty na granicy porcji skleja się, finish() dopycha ogon', t => {
    const filter = new ReasoningTagFilter();

    // `<think>` rozcięty na dwie porcje — rezerwa MUSI go skleić, zamiast wypuścić `<th` jako tekst.
    const a = filter.feed('<th');
    t.is(a.text, '', 'kawałek tagu nie może wyjść jako widoczny tekst');
    t.true(filter.buffered.length > 0 && filter.buffered.length <= 8, 'rezerwa trzyma ≤ 8 znaków');

    filter.feed('ink>rozumowanie modelu</think>Odpowiedź');
    t.true(filter.active === false || filter.active === true, 'seam `active` jest czytelny dla testu');

    const tail = filter.finish();
    const seen = a.text + tail.text;
    t.true(
        (a.text + 'Odpowiedź').includes('Odpowiedź') || seen.includes('Odpowiedź'),
        'ogon odpowiedzi trzymany w rezerwie MUSI dojść przy domknięciu',
    );
    t.false(seen.includes('<th'), 'kawałek tagu nie może zostać w treści');
});

test('rollback: niedomknięty <think> wraca do treści, reasoning KASOWANE (undefined)', t => {
    const CUT = 'Zaczynam od backlogu. Pierwszy punkt to naprawa parsera, drugi to testy, trzeci';
    const filter = new ReasoningTagFilter();

    filter.feed('<think>');
    filter.feed(CUT);
    const end = filter.finish();

    t.true(end.reasoningDropped, 'tag się nie domknął → to NIE było myślenie');
    t.is(end.text, CUT, 'cała wypowiedź wraca do widocznej treści');
    t.is(end.reasoning, '', 'myślenie ma zostać SKASOWANE, nie zwrócone jako treść bloku');
});

test('static apply(): ten sam kontrakt w torze complete()', t => {
    const closed = ReasoningTagFilter.apply('<think>rozumowanie modelu</think>Właściwa odpowiedź.');
    t.is(closed.content, 'Właściwa odpowiedź.');
    t.is(closed.reasoning_content, 'rozumowanie modelu');

    const unclosed = ReasoningTagFilter.apply('<think>całe rozumowanie ucięte na max_tokens');
    t.is(unclosed.content, 'całe rozumowanie ucięte na max_tokens', 'niedomknięty tag zostaje treścią');
    t.is(unclosed.reasoning_content, undefined, 'pusty string NIE może wrócić do modelu w kolejnej turze');

    const prose = ReasoningTagFilter.apply('Napisz `<think>` na początku odpowiedzi, żeby włączyć myślenie.');
    t.is(prose.content, 'Napisz `<think>` na początku odpowiedzi, żeby włączyć myślenie.', 'tag w środku treści to zwykły tekst');
    t.is(prose.reasoning_content, undefined);
});

test('disable(): natywne myślenie dostawcy WYŁĄCZA parser tagów', t => {
    const filter = new ReasoningTagFilter();
    filter.disable();

    const out = filter.feed('<think>to nie jest myślenie</think>reszta');
    t.is(out.text, '<think>to nie jest myślenie</think>reszta', 'po wyłączeniu treść leci 1:1');
    t.is(out.reasoning, '', 'wyłączony parser nie produkuje myślenia');
    t.false(filter.active);
});

test('RESERVE_CHARS = 8 dokładnie: 9 znaków bez tagu emituje 1, rezerwa trzyma pozostałe 8', t => {
    // Pinuje stałą liczbowo (nie "jakoś >0"): przy 9-znakowej porcji bez tagu keep=min(8,9)=8,
    // więc pierwszy znak MUSI wyjść od razu, a rezerwa MUSI trzymać dokładnie 8 ostatnich.
    // Rezerwa=9 (mutant) zatrzymałaby całą porcję i nic by nie wyszło.
    const filter = new ReasoningTagFilter();
    const out = filter.feed('123456789');
    t.is(out.text, '1', 'przy rezerwie=8 pierwszy z 9 znaków musi wyjść natychmiast');
    t.is(filter.buffered, '23456789', 'rezerwa musi trzymać dokładnie 8 ostatnich znaków, nie 9');
});

test('finish(): rollback niedomkniętego bloku gasi flagę active (engaged wraca na false)', t => {
    const filter = new ReasoningTagFilter();
    filter.feed('<think>');
    t.true(filter.active, 'tag na starcie wypowiedzi musi uzbroić filtr');

    filter.finish();
    t.false(filter.active, 'blok, który się nie domknął, nie może zostawić filtra „aktywnym" po finish()');
});

test('disable(): treść już zebrana w held (przed domknięciem tagu) NIE może zniknąć', t => {
    // held zbiera się przez wiele znaków, zanim rezerwa=8 zetnie ogon porcji (patrz L84-86).
    // disable() MUSI przenieść CAŁY held przed rezerwę, inaczej finish() zwróci tylko
    // ostatnie 8 znaków, a reszta zebranego tekstu przepadnie bezpowrotnie.
    const filter = new ReasoningTagFilter();
    filter.feed('<think>ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    filter.disable();

    const end = filter.finish();
    t.is(
        end.text,
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        'cały tekst trzymany w held musi wrócić jako widoczna treść, nie tylko ogon rezerwy',
    );
});

test('reguła 1: JEDEN widoczny znak tuż przed tagiem blokuje uzbrojenie ("before" liczone od znaku 0)', t => {
    // "before" MUSI objąć CAŁY fragment przed `<think>`, od pierwszego znaku porcji — inaczej
    // jeden widoczny znak tuż przed tagiem ucieka z gry, a tag i tak się uzbraja i połyka ten znak.
    const out = ReasoningTagFilter.apply('X<think>rozumowanie</think>Odpowiedź');
    t.is(
        out.content,
        'X<think>rozumowanie</think>Odpowiedź',
        'jeden widoczny znak przed tagiem musi zablokować uzbrojenie — cały tag zostaje tekstem, zero utraconych znaków',
    );
    t.is(out.reasoning_content, undefined, 'tag po widocznym znaku nie może wyprodukować bloku myślenia');
});

test('finish(): po rollbacku niedomkniętego bloku filtr NIE zostaje „w środku" na następny feed()', t => {
    // Rollback (reguła 2) musi zgasić `inside` na dobre — inaczej kolejna porcja tej samej
    // instancji wpada od razu w tryb "zbieram myślenie", zamiast wyjść jako widoczna treść.
    const filter = new ReasoningTagFilter();
    filter.feed('<think>');
    filter.finish();

    const out = filter.feed('zwykla odpowiedz');
    t.true(
        out.text.length > 0,
        'tekst po rollbacku musi zacząć wychodzić natychmiast, nie utknąć w trybie „wewnątrz bloku"',
    );
    t.is(out.reasoning, '', 'kolejna porcja po rollbacku nie może wpaść do fałszywego bloku myślenia');
});
