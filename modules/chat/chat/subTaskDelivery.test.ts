/**
 * AUD-testy-024: bramki dostarczenia wyniku suba mają test ZACHOWANIA, nie napisu.
 *
 * Do tej naprawy trzy decyzje z `_deliverSubTaskResult` pilnował wyłącznie regex po tekście
 * `chat_streaming.ts` (`stopSemantics.test.ts`), więc mutacja typu
 * `if (this._drainSuppressed) { }` — czyli bramka bez skutku, ale z zachowanym napisem —
 * zostawiała cały pakiet zielony. Tutaj każda gałąź ma OBIE strony: raz przepuszcza,
 * raz odmawia, z jawnym powodem.
 */
import test from 'ava';
import { evaluateSubTaskDelivery } from './subTaskDelivery.js';

/** Stan, w którym auto-tura MA wystartować — każdy test psuje z niego jedną rzecz. */
const zielone = {
    tab: { isActive: true },
    isGenerating: false,
    subTaskTurnPending: false,
    drainSuppressed: false,
    chainAllowed: true,
};

test('aktywna, bezczynna zakładka pod sufitem łańcucha DOSTAJE auto-turę', t => {
    t.deepEqual(evaluateSubTaskDelivery(zielone), { allowed: true, reason: 'ok' });
});

// ── Bramka 1: zakładka adresata ────────────────────────────────────────────

test('brak zakładki adresata → odmowa (wynik czeka na otwarcie agenta)', t => {
    t.deepEqual(evaluateSubTaskDelivery({ ...zielone, tab: null }), { allowed: false, reason: 'no_tab' });
    t.deepEqual(evaluateSubTaskDelivery({ ...zielone, tab: undefined }), { allowed: false, reason: 'no_tab' });
});

// ── Bramka 2: zakładka na wierzchu ─────────────────────────────────────────

test('zakładka w tle → odmowa (auto-tura za plecami usera)', t => {
    t.deepEqual(evaluateSubTaskDelivery({ ...zielone, tab: { isActive: false } }), { allowed: false, reason: 'tab_inactive' });
});

test('zakładka bez pola isActive traktowana jak w tle (fail-closed)', t => {
    t.deepEqual(evaluateSubTaskDelivery({ ...zielone, tab: {} }), { allowed: false, reason: 'tab_inactive' });
});

// ── Bramka 3: trwająca tura ────────────────────────────────────────────────

test('trwa tura na tej zakładce → odmowa', t => {
    t.deepEqual(evaluateSubTaskDelivery({ ...zielone, isGenerating: true }), { allowed: false, reason: 'turn_in_flight' });
});

test('auto-tura już wstrzyknięta (_subTaskTurnPending) → odmowa, bo inaczej dwie tury naraz', t => {
    t.deepEqual(evaluateSubTaskDelivery({ ...zielone, subTaskTurnPending: true }), { allowed: false, reason: 'turn_in_flight' });
});

// ── Bramka 4: Stop (AUD-security-115) ──────────────────────────────────────

test('po Stopie czat NIE startuje tury sam (AUD-security-115)', t => {
    t.deepEqual(evaluateSubTaskDelivery({ ...zielone, drainSuppressed: true }), { allowed: false, reason: 'stopped' });
});

test('Stop wygrywa nawet gdy wszystko inne zielone — to nie jest ostatnia bramka po drodze', t => {
    // Regresja, którą łapie ten test: przesunięcie bramki Stopu ZA sufit łańcucha (albo jej
    // wycięcie „bo przecież jest w set_generating") — dostawcę woła też `SubTaskNotifier`
    // wprost na `task:finished` i `_switchTab`, z pominięciem `set_generating`.
    const d = evaluateSubTaskDelivery({ ...zielone, drainSuppressed: true, chainAllowed: true });
    t.false(d.allowed);
    t.is(d.reason, 'stopped');
});

// ── Bramka 5: sufit łańcucha auto-tur (werdykt Kuby 16.08) ─────────────────

test('sufit łańcucha auto-tur osiągnięty → odmowa z powodem chain_limit (Notice dla usera)', t => {
    t.deepEqual(evaluateSubTaskDelivery({ ...zielone, chainAllowed: false }), { allowed: false, reason: 'chain_limit' });
});

test('brak informacji o łańcuchu nie blokuje pierwszej auto-tury', t => {
    const { chainAllowed: _pominiete, ...bezLancucha } = zielone;
    t.deepEqual(evaluateSubTaskDelivery(bezLancucha), { allowed: true, reason: 'ok' });
});

// ── Kolejność bramek jest częścią kontraktu (powód trafia do logu / Notice) ──

test('powód odmowy pochodzi od PIERWSZEJ niespełnionej bramki', t => {
    const wszystkoZle = { tab: null, isGenerating: true, subTaskTurnPending: true, drainSuppressed: true, chainAllowed: false };
    t.is(evaluateSubTaskDelivery(wszystkoZle).reason, 'no_tab');
    t.is(evaluateSubTaskDelivery({ ...wszystkoZle, tab: { isActive: false } }).reason, 'tab_inactive');
    t.is(evaluateSubTaskDelivery({ ...wszystkoZle, tab: { isActive: true } }).reason, 'turn_in_flight');
    t.is(evaluateSubTaskDelivery({ ...wszystkoZle, tab: { isActive: true }, isGenerating: false, subTaskTurnPending: false }).reason, 'stopped');
});

test('pusty obiekt wejścia → odmowa, nie wywrotka (dostawca nigdy nie rzuca)', t => {
    t.deepEqual(evaluateSubTaskDelivery({}), { allowed: false, reason: 'no_tab' });
});
