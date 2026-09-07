import test from 'ava';
import { RenderThrottle, shouldPaintFrame } from './renderThrottle.js';
import type { StreamFrame } from './renderThrottle.js';

/**
 * Atrapa planisty i zegara — testy nie czekają na realny czas.
 * `advance(ms)` przesuwa zegar i odpala timery, którym minął termin.
 */
function harness(intervalMs = 80) {
    let now = 1000;
    let seq = 0;
    const timers = new Map<number, { at: number; cb: () => void }>();
    const painted: StreamFrame[] = [];

    const throttle = new RenderThrottle({
        intervalMs,
        paint: (frame) => painted.push(frame),
        now: () => now,
        schedule: (cb, delayMs) => {
            const id = ++seq;
            timers.set(id, { at: now + delayMs, cb });
            return id;
        },
        cancel: (handle) => { timers.delete(handle as number); },
    });

    const advance = (ms: number) => {
        now += ms;
        for (const [id, timer] of [...timers.entries()]) {
            if (timer.at <= now) {
                timers.delete(id);
                timer.cb();
            }
        }
    };

    return { throttle, painted, advance, pendingTimers: () => timers.size };
}

const frame = (text: string, reasoning = ''): StreamFrame => ({ text, reasoning });

test('N chunków w jednym oknie = JEDNO malowanie, z OSTATNIĄ treścią', t => {
    const { throttle, painted, advance } = harness(80);

    // 500 ramek SSE w obrębie jednego okna (zegar nie rusza).
    for (let i = 1; i <= 500; i++) throttle.request(frame('a'.repeat(i)));
    t.is(painted.length, 0, 'nic nie maluje się synchronicznie w handlerze chunka');

    advance(80);
    t.is(painted.length, 1);
    t.is(painted[0].text, 'a'.repeat(500), 'namalowana ostatnia treść, nie pierwsza');
});

test('identyczna treść (chunk z samymi argumentami narzędzia) = ZERO malowań', t => {
    const { throttle, painted, advance, pendingTimers } = harness(80);

    throttle.request(frame('widoczny tekst'));
    advance(80);
    t.is(painted.length, 1);

    // 3000 chunków niosących wyłącznie deltę tool_calls — widoczna treść bez zmian.
    for (let i = 0; i < 3000; i++) throttle.request(frame('widoczny tekst'));
    t.is(pendingTimers(), 0, 'identyczna klatka nie zbroi nawet timera');
    advance(1000);
    t.is(painted.length, 1, 'ani jednego dodatkowego malowania');
});

test('kolejne okna malują kolejne wersje treści (tekst dalej płynie)', t => {
    const { throttle, painted, advance } = harness(80);

    throttle.request(frame('raz'));
    advance(80);
    throttle.request(frame('raz dwa'));
    advance(80);
    throttle.request(frame('raz dwa trzy'));
    advance(80);

    t.deepEqual(painted.map(f => f.text), ['raz', 'raz dwa', 'raz dwa trzy']);
});

test('flush() domalowuje ostatni fragment natychmiast (koniec tury / Stop)', t => {
    const { throttle, painted, advance } = harness(80);

    throttle.request(frame('początek'));
    advance(80);
    throttle.request(frame('początek i ogon'));
    t.is(painted.length, 1, 'ogon jeszcze czeka');

    throttle.flush();
    t.is(painted.length, 2);
    t.is(painted[1].text, 'początek i ogon', 'żaden fragment nie ginie');

    advance(1000);
    t.is(painted.length, 2, 'flush rozbroił timer — brak podwójnego malowania');
});

test('flush() bez czekającej klatki nie maluje nic', t => {
    const { throttle, painted, advance } = harness(80);
    throttle.request(frame('x'));
    advance(80);
    throttle.flush();
    throttle.flush();
    t.is(painted.length, 1);
});

test('cancel() porzuca czekającą klatkę (ścieżka błędu nadpisuje dymek)', t => {
    const { throttle, painted, advance } = harness(80);

    throttle.request(frame('połowa odpowiedzi'));
    throttle.cancel();
    advance(1000);
    t.is(painted.length, 0, 'porzucona klatka nie zjada komunikatu błędu');
});

test('reset() zapomina ostatnio namalowaną treść (nowa tura maluje od zera)', t => {
    const { throttle, painted, advance } = harness(80);

    throttle.request(frame('tekst tury A'));
    advance(80);
    t.is(painted.length, 1);

    throttle.reset();
    throttle.request(frame('tekst tury A')); // ta sama treść, ale to NOWY dymek
    advance(80);
    t.is(painted.length, 2, 'po resecie identyczna treść MUSI zostać namalowana ponownie');
});

test('blok myśli jedzie tą samą klatką co dymek (jedno malowanie na okno)', t => {
    const { throttle, painted, advance } = harness(80);

    for (let i = 1; i <= 200; i++) throttle.request(frame('', 'rozumowanie '.repeat(i)));
    advance(80);
    t.is(painted.length, 1);
    t.is(painted[0].reasoning, 'rozumowanie '.repeat(200));
    t.is(painted[0].text, '');

    // Sama zmiana śladu rozumowania (tekst bez zmian) też jest zmianą klatki.
    throttle.request(frame('', 'rozumowanie '.repeat(200) + 'koniec'));
    advance(80);
    t.is(painted.length, 2);
});

test('okno nie wydłuża się przy ciągłym strumieniu (malowanie co intervalMs)', t => {
    const { throttle, painted, advance } = harness(100);

    // Ramka co 10 ms przez 1 s = 100 chunków; malowań ma być ~10, nie 100.
    for (let i = 1; i <= 100; i++) {
        throttle.request(frame('x'.repeat(i)));
        advance(10);
    }
    throttle.flush();
    t.true(painted.length <= 11, `malowań: ${painted.length}`);
    t.true(painted.length >= 9, `malowań: ${painted.length}`);
    t.is(painted[painted.length - 1].text, 'x'.repeat(100), 'finalna treść zawsze na ekranie');
});

// ── Strażnicy PO ŹRÓDLE: okablowanie w mixinach ─────────────────────────────
// `chat_streaming.ts` i `chat_ui.ts` importują `obsidian` i AVA ich nie zaimportuje (wzór
// `stopSemantics.test.ts`). Sama logika throttle'a jest testowana wyżej — tu pilnujemy, że
// monolit jej UŻYWA i że każde wyjście z tury domyka klatkę (flush/reset), a nie gubi ogona.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
function bodyOf(src: string, name: string): string {
    const head = new RegExp(`export (?:async )?function ${name}\\(`).exec(src);
    if (!head) return '';
    const rest = src.slice(head.index + head[0].length);
    const to = rest.indexOf('\nexport ');
    return stripComments(to < 0 ? rest : rest.slice(0, to));
}
const streaming = readSource('./chat_streaming.ts');
const ui = readSource('./chat_ui.ts');

test('handle_chunk NIE maluje sam — zgłasza klatkę do throttle\'a (AUD-wydajnosc-071)', t => {
    const body = bodyOf(streaming, 'handle_chunk');
    t.true(body.length > 0, 'nie znalazłem handle_chunk w chat_streaming.ts');
    t.regex(body, /this\._streamRenderThrottle\(\)\.request\(/,
        'handle_chunk musi oddawać klatkę throttle\'owi, inaczej wraca malowanie per ramka SSE');
    t.notRegex(body, /MarkdownRenderer\.renderMarkdown/,
        'render markdownu w handle_chunk = koszt kwadratowy względem długości odpowiedzi');
    t.notRegex(body, /this\.scrollToBottom\(/,
        'przewijanie per chunk ciągnęło _drawConnectorLines po całej liście wiadomości');
});

test('malowanie klatki przewija BEZ przerysowania łączników (AUD-wydajnosc-072/014)', t => {
    const body = bodyOf(streaming, '_paintStreamFrame');
    t.regex(body, /scrollToBottom\(\s*true\s*,\s*\{\s*drawConnectors:\s*false\s*\}\s*\)/,
        'malowanie strumienia musi wołać tryb „tylko przewiń"');
});

test('każde wyjście z tury domyka klatkę: flush przed zerowaniem wskaźników', t => {
    for (const fn of ['_finalizeTurn', 'stop_generation', '_chatBeforeContinue']) {
        const body = bodyOf(streaming, fn);
        t.regex(body, /this\._renderThrottle\?\.flush\(\)/,
            `${fn} bez flush() gubi ostatni fragment odpowiedzi`);
        const flushAt = body.indexOf('_renderThrottle?.flush()');
        const resetAt = body.indexOf('_resetPaintTargets()');
        t.true(resetAt < 0 || flushAt < resetAt,
            `${fn}: flush MUSI stać przed _resetPaintTargets — po zerowaniu nie ma już gdzie malować`);
    }
});

test('_resetPaintTargets zeruje też throttle (klatka starej tury nie wpada w nową)', t => {
    const body = bodyOf(streaming, '_resetPaintTargets');
    t.regex(body, /this\._renderThrottle\?\.reset\(\)/);
});

test('scrollToBottom koalescuje łączniki i umie „tylko przewinąć" (AUD-wydajnosc-072/014)', t => {
    const body = bodyOf(ui, 'scrollToBottom');
    t.regex(body, /if\s*\(opts\.drawConnectors\s*===\s*false\)\s*return;/,
        'tryb „tylko przewiń" musi wychodzić PRZED rysowaniem łączników');
    t.regex(body, /this\._scheduleConnectorRedraw\(\)/);
    t.notRegex(body, /this\._drawConnectorLines\(\)/,
        'bezpośrednie rysowanie z scrollToBottom = przerysowanie na każde wywołanie, bez koalescencji');
});

// ─────────────────────────────────────────────────────────────────────────────
// Review opusa (P1 + P3) — klatka nie ma prawa uderzyć w CUDZĄ zakładkę
// ─────────────────────────────────────────────────────────────────────────────

test('P3: klatka identyczna z NAMALOWANĄ nie nadpisuje czekającej nowszej', t => {
    const { throttle, painted, advance } = harness(80);

    throttle.request(frame('pierwsza wersja'));
    advance(80);
    t.is(painted.length, 1);

    throttle.request(frame('pierwsza wersja i ogon'));   // nowsza treść czeka w kolejce
    throttle.request(frame('pierwsza wersja'));          // duplikat już namalowanej
    advance(80);

    t.is(painted.length, 2);
    t.is(painted[1].text, 'pierwsza wersja i ogon', 'duplikat zjadł ogon odpowiedzi');
});

test('P1: przełączenie zakładki (cancel) = ZERO malowań i zero przewinięć', t => {
    const { throttle, painted, advance, pendingTimers } = harness(80);

    // Chunk wpada ≤80 ms przed przełączeniem — timer jest uzbrojony.
    throttle.request({ text: 'odpowiedź Jaskra', reasoning: '', owner: 'Jaskier' });
    t.is(pendingTimers(), 1);

    throttle.cancel();          // dokładnie to robi `_switchTab` (krok 0b)
    advance(1000);

    t.is(painted.length, 0, 'klatka starej zakładki nie ma prawa nic namalować ani przewinąć');
    t.is(pendingTimers(), 0);
});

test('P1: bramka właściciela — klatka cudzej tury NIE maluje po zmianie zakładki', t => {
    // Druga linia obrony: gdyby ktoś dołożył `await` przed `cancel()` w `_switchTab`, malowanie
    // i tak musi odmówić. Symulujemy `_paintStreamFrame`: paint pyta `shouldPaintFrame`.
    let activeTab = 'Jaskier';
    const scrolled: string[] = [];
    const paintedFrames: StreamFrame[] = [];
    let now = 0;
    const timers: { at: number; cb: () => void }[] = [];
    const throttle = new RenderThrottle({
        intervalMs: 80,
        now: () => now,
        schedule: (cb, delayMs) => { timers.push({ at: now + delayMs, cb }); return timers.length; },
        cancel: () => { /* w tym teście celowo NIE anulujemy */ },
        paint: (f) => {
            if (!shouldPaintFrame(f, activeTab)) return;   // wzór z `_paintStreamFrame`
            paintedFrames.push(f);
            scrolled.push(activeTab);                      // skutek uboczny: scrollToBottom
        },
    });

    throttle.request({ text: 'odpowiedź Jaskra', reasoning: '', owner: 'Jaskier' });
    activeTab = 'Borys';                                  // user przełącza zakładkę
    now += 80;
    for (const timer of timers.splice(0)) timer.cb();

    t.is(paintedFrames.length, 0, 'malowanie w cudzej zakładce = przewinięcie CUDZEJ listy na dół');
    t.deepEqual(scrolled, []);
});

test('P1: klatka bez właściciela maluje zawsze (zgodność wsteczna)', t => {
    t.true(shouldPaintFrame(frame('x'), 'Jaskier'));
    t.true(shouldPaintFrame(frame('x'), null));
    t.true(shouldPaintFrame({ text: 'x', reasoning: '', owner: 'Jaskier' }, 'Jaskier'));
    t.false(shouldPaintFrame({ text: 'x', reasoning: '', owner: 'Jaskier' }, 'Borys'));
    t.false(shouldPaintFrame({ text: 'x', reasoning: '', owner: 'Jaskier' }, undefined));
});

test('P1: ta sama treść od INNEJ tury nie jest połykana jako „identyczna"', t => {
    const { throttle, painted, advance } = harness(80);
    throttle.request({ text: 'gotowe', reasoning: '', owner: 'Jaskier' });
    advance(80);
    throttle.request({ text: 'gotowe', reasoning: '', owner: 'Borys' });
    advance(80);
    t.is(painted.length, 2);
    t.is(painted[1].owner, 'Borys');
});

test('P1: _switchTab rozbraja throttle, a malowanie pyta o właściciela (strażnik po źródle)', t => {
    const tabs = stripComments(readSource('./chat_tabs.ts'));
    t.regex(tabs, /this\._renderThrottle\?\.cancel\(\)/,
        '_switchTab bez cancel() = klatka starej zakładki przewija nową po przywróceniu scrollTop');
    const switchBody = tabs.slice(tabs.indexOf('export async function _switchTab'));
    const cancelAt = switchBody.indexOf('_renderThrottle?.cancel()');
    const renderAt = switchBody.indexOf('this.render_messages()');
    t.true(cancelAt > 0 && renderAt > 0 && cancelAt < renderAt,
        'cancel MUSI stać przed przerysowaniem listy (krok 7) i przywróceniem scrollTop (krok 9)');

    const paint = bodyOf(streaming, '_paintStreamFrame');
    t.regex(paint, /shouldPaintFrame\(frame, activeTabAgent\)/,
        'malowanie musi pytać, czy właściciel klatki nadal jest na wierzchu');
    const chunk = bodyOf(streaming, 'handle_chunk');
    t.regex(chunk, /owner: agentName/,
        'klatka musi wozić właściciela, inaczej bramka nie ma czego sprawdzić');
});

test('bonus: handle_error zeruje blok myśli jak pozostałe trzy ścieżki', t => {
    const body = bodyOf(streaming, 'handle_error');
    t.regex(body, /this\._currentThinkingBlock = null/,
        'bez zerowania blok myśli następnej tury wleci w dymek poprzedniej wiadomości');
    const nullAt = body.indexOf('_currentThinkingBlock = null');
    const resetAt = body.indexOf('_resetPaintTargets()');
    t.true(nullAt > 0 && resetAt > 0 && nullAt < resetAt,
        'zerowanie musi stać przed _resetPaintTargets (tak jak na trzech pozostałych ścieżkach)');
});
