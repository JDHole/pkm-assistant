/**
 * Stop i przełączenie zakładki mają PIERWSZEŃSTWO przed każdym „domknij turę".
 *
 * Mechanizmy, które domykają turę „po fakcie" (dren kolejki na `setTimeout`, dostawca wyniku
 * suba, kasowanie wpisu mapy tur, wskaźniki malowania) muszą pytać, czy w międzyczasie user
 * nie kliknął Stopu i czy nadal patrzy na TĘ zakładkę - inaczej efekt uboczny trafia w cudzą
 * zakładkę albo w turę, która już nie istnieje.
 *
 * `chat_streaming.ts` importuje `obsidian` (i maluje DOM), więc AVA go nie zaimportuje -
 * decyzje siedzą albo w pure helperach (`queuedMessage.ts`), albo są pilnowane PO ŹRÓDLE.
 * Wzór: `turnOwner.test.ts`, `queuedMessage.test.ts`, `safeErrorText.test.ts`.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Kod bez komentarzy — strażnik pilnuje WYWOŁAŃ, nie opisów historii. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Ciało funkcji od jej `export [async] function <name>` do następnego `\nexport `. */
function bodyOf(src: string, name: string): string {
    const head = new RegExp(`export (?:async )?function ${name}\\(`).exec(src);
    if (!head) return '';
    const rest = src.slice(head.index + head[0].length);
    const to = rest.indexOf('\nexport ');
    return stripComments(to < 0 ? rest : rest.slice(0, to));
}

const streaming = readSource('./chat_streaming.ts');
const streamingCode = stripComments(streaming);
const tabs = readSource('./chat_tabs.ts');

// ── Stop anuluje zakolejkowaną wiadomość ────────────────────────────────────

test('stop_generation kasuje slot kolejki i gasi wskaźnik', t => {
    const body = bodyOf(streaming, 'stop_generation');
    t.true(body.length > 0, 'nie znalazłem stop_generation w chat_streaming.ts');
    t.regex(body, /this\._queuedMessage\s*=\s*null/,
        'Stop bez kasowania kolejki = wiadomość leci do modelu 100 ms po kliknięciu Stop');
    t.regex(body, /_hideQueuedIndicator\(\)/, 'wskaźnik ⏳ musi zgasnąć razem z kolejką');
});

// SAMA DECYZJA („kasować slot?", „oddać tekst do pola?") mieszka w
// `queuedMessage.evaluateStopQueueCancel` i ma tam testy obu stron. Tutaj pilnujemy już tylko
// OKABLOWANIA - że monolit tę decyzję woła i wykonuje jej werdykt w niezmienionym kształcie.
// Regex nie może być luźniejszy niż kształt gałęzi: `if (cancel.clearSlot)` bez negacji,
// z kasowaniem slotu w środku (odwrócenie warunku ma dawać CZERWONY test).

test('stop_generation woła czystą decyzję kolejki i wykonuje jej werdykt', t => {
    const body = bodyOf(streaming, 'stop_generation');
    t.regex(body, /\bevaluateStopQueueCancel\(\s*this\._queuedMessage\s*,\s*this\.input_area\?\.value\s*\)/,
        'Stop musi pytać czystej decyzji o kolejkę, nie liczyć jej inline w mixinie');
    t.regex(body, /if\s*\(cancel\.clearSlot\)\s*\{[\s\S]{0,160}?this\._queuedMessage\s*=\s*null/,
        'gałąź kasowania slotu musi stać na `cancel.clearSlot` BEZ negacji i kasować slot w środku');
    t.regex(body, /if\s*\(cancel\.restoreText\s*!==\s*null\)\s*\{[\s\S]{0,120}?this\.input_area\.value\s*=\s*cancel\.restoreText/,
        'tekst wraca do pola wpisywania TYLKO gdy decyzja go oddała (inaczej Stop zjada szkic usera)');
});

test('każda ścieżka Stopu rozbraja timer drenu', t => {
    for (const fn of ['stop_generation', 'stop_all_turns']) {
        t.regex(bodyOf(streaming, fn), /_clearQueuedDrainTimer\(\)/,
            `${fn} zostawia uzbrojony setTimeout - wybudzi się w zamkniętym/przerwanym widoku`);
    }
});

// ── timer drenu ma właściciela i sprawdza zakładkę ──────────────────────────

test('timer drenu ma UCHWYT (nie goły setTimeout) - da się go anulować', t => {
    const body = bodyOf(streaming, 'set_generating');
    // `obsidianmd/prefer-window-timers` wymaga `window.setTimeout(...)` zamiast gołego
    // `setTimeout(...)`; sens strażnika (timer ma uchwyt, nie goły call) zostaje bez zmian.
    t.regex(body, /this\._queuedDrainTimer\s*=\s*window\.setTimeout\(/,
        'goły setTimeout bez uchwytu = timer, którego nikt nie zatrzyma (zamknięcie widoku, Stop)');
});

test('dren PRZED wysyłką sprawdza, czy zakładka/agent się nie zmienił', t => {
    const body = bodyOf(streaming, 'set_generating');
    // Samo porównanie właściciela (i cała trójka pytań drenu) mieszka w
    // `queuedMessage.evaluateQueuedDrain` - z testami obu stron każdej gałęzi. Strażnik
    // po źródle pilnuje OKABLOWANIA: że dren o to pyta i że wykonuje werdykt w tym kształcie
    // (`!== 'send'` = czekamy; odwrócenie warunku ma dawać CZERWONY test).
    t.regex(body, /\bevaluateQueuedDrain\(\s*this\._queuedMessage\s*,\s*this\._queueOwner\(\)/,
        'bez porównania właściciela wiadomość pisana do Jaskra jedzie modelem Borysa');
    t.regex(body, /evaluateQueuedDrain\([\s\S]{0,160}?isGenerating:\s*this\.is_generating/,
        'dren musi znać stan generowania — inaczej wystrzeli w środek trwającej tury');
    t.regex(body, /if\s*\(drain\.action\s*!==\s*'send'\)\s*\{[\s\S]{0,400}?return;/,
        'każdy werdykt inny niż `send` MUSI zatrzymać dren (return), nie tylko zapalić wskaźnik');
    t.regex(body, /if\s*\(drain\.action\s*===\s*'empty'\s*\|\|\s*!queued\)\s*return;/,
        'pusty slot (Stop zdążył anulować) musi kończyć dren bez wysyłki');
});

test('slot kolejki zapamiętuje właściciela przy kolejkowaniu', t => {
    t.regex(streamingCode, /queueChatMessage\([\s\S]{0,160}?_queueOwner\(\)/,
        'bez zapisu właściciela nie ma czego porównać przy drenie');
});

test('_switchTab rozbraja timer drenu poprzedniej zakładki', t => {
    t.regex(stripComments(tabs), /_clearQueuedDrainTimer/,
        'przełączenie zakładki zostawiało uzbrojony dren poprzedniego widoku');
});

// ── po Stopie czat nie startuje tury z wynikiem suba ────────────────────────

test('_deliverSubTaskResult pyta o _drainSuppressed', t => {
    const body = bodyOf(streaming, '_deliverSubTaskResult');
    t.true(body.length > 0, 'nie znalazłem _deliverSubTaskResult');
    // Bramka nie jest gołym `if (this._drainSuppressed) return false;` - stan Stopu jedzie
    // do czystej `evaluateSubTaskDelivery`, która ma test obu stron. Strażnik pilnuje, że
    // wartość naprawdę tam WCHODZI (nie `false`, nie zanegowana) - a nie że słowo
    // `_drainSuppressed` gdziekolwiek w funkcji pada.
    t.regex(body, /drainSuppressed:\s*this\._drainSuppressed\s*,/,
        'notifier woła dostawcę WPROST (task:finished), z pominięciem set_generating - stan Stopu musi wejść do bramki tutaj');
});

test('_deliverSubTaskResult wykonuje werdykt bramek: `if (!delivery.allowed)` → return false', t => {
    const body = bodyOf(streaming, '_deliverSubTaskResult');
    t.regex(body, /\bconst delivery = evaluateSubTaskDelivery\(\{/,
        'komplet bramek dostarczenia musi liczyć czysta funkcja, nie ciąg ifów w mixinie z `obsidian`');
    // Negacja jest tu całą treścią naprawy: bez `!` dostawca startowałby auto-turę DOKŁADNIE
    // wtedy, gdy któraś bramka odmawia (Stop, tło, trwająca tura).
    t.regex(body, /if\s*\(!delivery\.allowed\)\s*\{[\s\S]{0,700}?return false;/,
        'werdykt musi być odczytany z negacją i kończyć dostarczanie `return false` (wynik zostaje w kolejce notifiera)');
    // Wszystkie cztery pozostałe wejścia bramki naprawdę pochodzą ze stanu widoku.
    for (const wiring of [
        /\btab,\s*$/m,
        /isGenerating:\s*this\.is_generating\s*,/,
        /subTaskTurnPending:\s*this\._subTaskTurnPending\s*,/,
        /chainAllowed:\s*chain\.allowed\s*,/,
    ]) {
        t.regex(body, wiring, `wejście bramki dostarczenia rozjechało się ze stanem widoku: ${wiring}`);
    }
});

// ── finalizacja starej tury nie kasuje wpisu żywej ──────────────────────────

test('wpis mapy tur kasuje się TYLKO po tożsamości tury', t => {
    // `_streamCtxMap` jest kluczowana NAZWĄ agenta. Gdy dla jednej nazwy istnieją dwie tury,
    // bezwarunkowy `delete` starej wyrzucałby uchwyt ŻYWEJ - Stop nie miałby już czego zatrzasnąć.
    const naked = streamingCode.match(/this\._streamCtxMap\.delete\(/g) || [];
    t.is(naked.length, 1,
        `goły delete wpisu mapy tur poza _releaseStreamCtx (${naked.length}) usuwałby też żywą turę`);
    t.regex(streamingCode, /function _releaseStreamCtx\(/, 'brak wspólnego zwalniania wpisu mapy tur');
    t.regex(bodyOf(streaming, '_finalizeTurn'), /_releaseStreamCtx/,
        'finalizacja tury musi zwalniać wpis warunkowo (turnId)');
});

// ── ścieżka błędu zeruje wskaźniki malowania ────────────────────────────────

test('handle_error zeruje wskaźniki malowania jak ścieżka sukcesu', t => {
    const body = bodyOf(streaming, 'handle_error');
    t.true(body.length > 0, 'nie znalazłem handle_error');
    t.regex(body, /_resetPaintTargets\(\)/,
        'bez zerowania następna odpowiedź maluje się do dymka poprzedniej (często wypiętego z DOM)');
});

test('_resetPaintTargets to JEDNO miejsce prawdy o wskaźnikach malowania', t => {
    t.regex(streamingCode, /function _resetPaintTargets\(/, 'brak wspólnego resetu wskaźników');
    for (const fn of ['_finalizeTurn', 'stop_generation', '_chatBeforeContinue']) {
        t.regex(bodyOf(streaming, fn), /_resetPaintTargets\(\)/, `${fn} zeruje wskaźniki po staremu`);
    }
});

// ── żadnego pustego catch ────────────────────────────────────────────────────

test('parsowanie wyniku agent_delegate nie łyka wyjątku po cichu', t => {
    t.notRegex(streamingCode, /catch\s*\{\s*\}/,
        'pusty catch {} = diagnoza „czemu nie ma guzika delegacji" jest ślepa');
    t.regex(streamingCode, /_pendingDelegation\s*=\s*parsed;[\s\S]{0,200}?catch\s*\([\s\S]{0,120}?log\.warn\(/,
        'wyjątek przy odczycie propozycji delegacji musi trafić do loga');
});
