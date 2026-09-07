/**
 * Testy arytmetyki łańcucha auto-tur po subach (werdykt Kuby, 2026-08-16; domknięcie po
 * weryfikacji opus, 2026-08-27).
 *
 * Druga połowa (testy „po źródle") pilnuje, że `chat_streaming.ts` NAPRAWDĘ używa tego modułu
 * tam, gdzie licznik ma rosnąć/zerować się/pokazać Notice — plik importuje `obsidian` i AVA go
 * nie zaimportuje wprost (wzór `stopSemantics.test.ts`). Dwa z nich pilnują KONKRETNIE regresji
 * z pierwszego przebiegu: `resetAutoTurnChain()` był martwym eksportem (okablowanie robiło
 * goły `.delete()`), a `getLimits()` było wołane dwa razy na jedno doręczenie.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { evaluateAutoTurnChain, resetAutoTurnChain } from './autoTurnChain.js';

// ── Minimum z werdyktu: rośnie / zeruje się / blokuje na limicie / znowu jedzie ──

test('licznik rośnie o 1 przy każdej dozwolonej auto-turze', t => {
    let d = evaluateAutoTurnChain(0, 5);
    t.true(d.allowed);
    t.is(d.nextCount, 1);

    d = evaluateAutoTurnChain(d.nextCount, 5);
    t.true(d.allowed);
    t.is(d.nextCount, 2);

    d = evaluateAutoTurnChain(d.nextCount, 5);
    t.true(d.allowed);
    t.is(d.nextCount, 3);
});

test('na limicie kolejna auto-tura NIE startuje — idzie fallbackiem (zostaje w kolejce)', t => {
    const d = evaluateAutoTurnChain(5, 5);
    t.false(d.allowed);
    t.is(d.nextCount, 5, 'licznik nie rośnie dalej ponad sufit');
});

test('powyżej limitu (stan zastany) też blokuje, bez wywrócenia się', t => {
    const d = evaluateAutoTurnChain(9, 5);
    t.false(d.allowed);
    t.is(d.nextCount, 9, 'nie oszukujemy stanu zastanego w dół');
});

test('po zresetowaniu (tura usera) łańcuch znowu może jechać do tego samego limitu', t => {
    const blocked = evaluateAutoTurnChain(5, 5);
    t.false(blocked.allowed);

    const afterHuman = resetAutoTurnChain();
    const resumed = evaluateAutoTurnChain(afterHuman, 5);
    t.true(resumed.allowed);
    t.is(resumed.nextCount, 1);
});

test('limit 1: dokładnie JEDNA auto-tura z rzędu, druga blokuje', t => {
    const first = evaluateAutoTurnChain(0, 1);
    t.true(first.allowed);
    t.is(first.nextCount, 1);

    const second = evaluateAutoTurnChain(first.nextCount, 1);
    t.false(second.allowed);
});

// ── Defensywność: śmieci na wejściu spadają na sensowny start, nie wywracają decyzji ──

test('ujemny / NaN / niedokończony licznik traktowany jak start łańcucha (0)', t => {
    t.deepEqual(evaluateAutoTurnChain(-3, 5), { allowed: true, nextCount: 1 });
    t.deepEqual(evaluateAutoTurnChain(NaN, 5), { allowed: true, nextCount: 1 });
    t.deepEqual(evaluateAutoTurnChain(Infinity, 5), { allowed: true, nextCount: 1 });
    t.deepEqual(evaluateAutoTurnChain(undefined as unknown as number, 5), { allowed: true, nextCount: 1 });
});

test('ułamkowy licznik ucinany w dół przed porównaniem z limitem', t => {
    // 4.9 < 5 → jeszcze wolno; wynik i tak jest całkowity.
    t.deepEqual(evaluateAutoTurnChain(4.9, 5), { allowed: true, nextCount: 5 });
});

test('niedodatni / śmieciowy limit traktowany jak 1 (pierwsza auto-tura zawsze może wystartować)', t => {
    t.true(evaluateAutoTurnChain(0, 0).allowed);
    t.true(evaluateAutoTurnChain(0, -5).allowed);
    t.true(evaluateAutoTurnChain(0, NaN).allowed);
    t.false(evaluateAutoTurnChain(1, 0).allowed, 'ale DRUGA już nie, gdy limit spadł na 1');
});

// ── Po źródle: chat_streaming.ts naprawdę woła ten moduł tam, gdzie ma ──

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function bodyOf(src: string, name: string): string {
    const head = new RegExp(`export (?:async )?function ${name}\\(`).exec(src);
    if (!head) return '';
    const rest = src.slice(head.index + head[0].length);
    const to = rest.indexOf('\nexport ');
    return stripComments(to < 0 ? rest : rest.slice(0, to));
}

const streaming = readSource('./chat_streaming.ts');
const streamingCode = stripComments(streaming);

test('_deliverSubTaskResult sprawdza limit PRZED wysłaniem auto-tury i NIE woła send_message gdy zablokowane', t => {
    const body = bodyOf(streaming, '_deliverSubTaskResult');
    t.true(body.length > 0, 'nie znalazłem _deliverSubTaskResult');
    t.regex(body, /evaluateAutoTurnChain\(/, 'bramka łańcucha musi tu stać, obok reszty bramek dostarczenia');
    // Bramka musi paść PRZED wywołaniem send_message w tej samej funkcji.
    const gateIdx = body.search(/evaluateAutoTurnChain\(/);
    const sendIdx = body.search(/\.send_message\(/);
    t.true(gateIdx >= 0 && sendIdx > gateIdx, 'limit musi być sprawdzony ZANIM poleci send_message');
    t.regex(body, /chain\.allowed/, 'wynik decyzji musi być faktycznie odczytany');
});

// AUD-testy-046: sam FAKT odczytu `chain.allowed` nie wystarcza — dawny strażnik przechodził
// na zielono także po dokładnym ODWRÓCENIU warunku (`if (chainDecision.allowed)` zamiast
// `if (!chainDecision.allowed)`), bo mierzył obecność podciągu, nie kierunek bramki.
// Po AUD-testy-024 polaryzacja mieszka w czystej `evaluateSubTaskDelivery` (test obu stron:
// `chainAllowed: false` → `chain_limit`), a tutaj pilnujemy DWÓCH rzeczy w okablowaniu:
// wynik łańcucha wchodzi do bramki NIEZANEGOWANY, a werdykt bramki jest odczytany Z NEGACJĄ.

test('AUD-testy-046: kierunek bramki łańcucha jest pilnowany, nie tylko jej obecność', t => {
    const body = bodyOf(streaming, '_deliverSubTaskResult');

    // 1. Do bramki wchodzi `chain.allowed` — bez `!`, bez `false`, bez zamiany na `nextCount`.
    t.regex(body, /chainAllowed:\s*chain\.allowed\s*,/,
        'sufit łańcucha musi wchodzić do bramki dokładnie tak, jak go policzył evaluateAutoTurnChain');
    t.notRegex(body, /chainAllowed:\s*!/,
        'zanegowane wejście = auto-tura startuje DOKŁADNIE po osiągnięciu sufitu (odwrócony werdykt Kuby 16.08)');

    // 2. Werdykt bramek czytany z negacją i kończący dostarczanie.
    const guard = /if\s*\(!delivery\.allowed\)\s*\{/;
    t.regex(body, guard, 'brak `!` przy odczycie werdyktu = odwrócona bramka (mutacja z AUD-testy-046)');
    const branchStart = body.search(guard);
    const branch = body.slice(branchStart);
    const returnIdx = branch.indexOf('return false;');
    t.true(returnIdx > 0, 'gałąź odmowy musi zwracać `false` — inaczej wynik wypada z kolejki notifiera');
    t.notRegex(branch.slice(0, returnIdx), /_autoTurnChainCounts\.set\(/,
        'inkrementacja licznika nie może się wykonać w gałęzi odmowy');

    // 3. Licznik rośnie DOPIERO po przejściu bramek (poza gałęzią odmowy).
    const setIdx = body.search(/this\._autoTurnChainCounts\.set\(/);
    t.true(setIdx > branchStart, 'zapis licznika musi stać PO bramce, nie przed nią');
});

test('send_message zeruje łańcuch przez resetAutoTurnChain(), warunkowo na isHuman — nie goły .delete()', t => {
    const body = bodyOf(streaming, 'send_message');
    t.true(body.length > 0, 'nie znalazłem send_message');
    // Weryfikacja opus (2. commit): `resetAutoTurnChain()` był martwym eksportem, okablowanie
    // robiło goły `.delete()`. Test wymaga TEGO WYWOŁANIA wprost, żeby druga cicha regresja
    // na `.delete()` nie przeszła bez czerwonego testu.
    t.regex(body, /if\s*\(isHuman\)\s*this\._autoTurnChainCounts\?\.set\(owner\.agentName,\s*resetAutoTurnChain\(\)\)/,
        'reset musi być warunkowany `isHuman` (resolveMessageOrigin) i wołać resetAutoTurnChain() — nie `.delete()`');
    t.notRegex(body, /_autoTurnChainCounts\?\.delete\(/,
        'goły `.delete()` zamiast resetAutoTurnChain() = powrót martwego eksportu (weryfikacja opus)');
});

test('chat_streaming.ts importuje resetAutoTurnChain (nie tylko evaluateAutoTurnChain)', t => {
    t.regex(streamingCode, /import\s*\{\s*evaluateAutoTurnChain,\s*resetAutoTurnChain\s*\}\s*from\s*'\.\/autoTurnChain\.js'/,
        'resetAutoTurnChain musi być realnie importowany, nie tylko eksportowany z autoTurnChain.ts');
});

test('config/limits.ts ma nowy sufit i _deliverSubTaskResult czyta go przez getLimits (jedno wywołanie)', t => {
    const limits = readSource('../../../config/limits.ts');
    t.regex(limits, /max_consecutive_auto_turns/, 'brak nowej stałej limitu w config/limits.ts');

    const body = bodyOf(streaming, '_deliverSubTaskResult');
    t.regex(body, /getLimits\(/, '_deliverSubTaskResult musi czytać sufit przez getLimits, nie hardcode');
    t.regex(body, /\.max_consecutive_auto_turns\b/, 'wynik getLimits musi być odczytany pod tym kluczem');
    // Kosmetyka z weryfikacji opus: JEDNO wywołanie getLimits() na doręczenie (chain limit +
    // subagent_result_max_chars dzielą tę samą zmienną), nie dwa osobne odczyty ustawień.
    const calls = body.match(/getLimits\(/g) || [];
    t.is(calls.length, 1, `_deliverSubTaskResult woła getLimits() ${calls.length} razy — ma dzielić jedną zmienną`);
});

test('_deliverSubTaskResult pokazuje Notice przy zaparkowaniu wyniku (cisza wobec usera = FAIL wg opus)', t => {
    const body = bodyOf(streaming, '_deliverSubTaskResult');
    const gateIdx = body.search(/chain\.allowed/);
    const noticeIdx = body.search(/new Notice\(t\('chat\.streaming\.auto_turn_chain_limit'\)/);
    t.true(gateIdx >= 0, 'nie znalazłem odczytu chain.allowed');
    t.true(noticeIdx > gateIdx, 'Notice musi stać w gałęzi zablokowanej auto-tury, po odczycie chain.allowed');
    // Notice TYLKO dla sufitu łańcucha — pozostałe odmowy (tło, trwająca tura, Stop) są ciche
    // z definicji; gdyby warunek zniknął, user dostawałby popup po każdym Stopie.
    t.regex(body, /delivery\.reason\s*===\s*'chain_limit'/,
        'Notice o suficie łańcucha musi być warunkowany POWODEM odmowy, nie samą odmową');
});
