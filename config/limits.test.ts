import test from 'ava';
import { getLimits, DEFAULT_LIMITS, LIMIT_SPECS } from './limits.js';
import type { LimitKey } from './limits.js';

// ── Defaults / no override ─────────────────────────────────────────────

test('getLimits(undefined) returns a full copy of DEFAULT_LIMITS', t => {
    const limits = getLimits(undefined);
    t.deepEqual(limits, DEFAULT_LIMITS);
});

test('getLimits({}) with no pkmAssistant.limits returns defaults', t => {
    t.deepEqual(getLimits({}), DEFAULT_LIMITS);
    t.deepEqual(getLimits({ pkmAssistant: {} }), DEFAULT_LIMITS);
    t.deepEqual(getLimits({ pkmAssistant: { limits: {} } }), DEFAULT_LIMITS);
});

test('DEFAULT_LIMITS carries the harmonized values (E1.5 P3/P4, F4)', t => {
    t.is(DEFAULT_LIMITS.chat_max_iterations, 8);
    // F4: 8 → 12; runda 2 Frontu A (2026-08-17): 12 → 25 (sub ma pracować aż skończy,
    // strażnikami są watchdog ciszy + zegar zadania, nie licznik iteracji).
    t.is(DEFAULT_LIMITS.subagent_max_iterations_worker, 25);
    // Straż regresji: klucz ma NIE istnieć (D18 skasował osobny limit strategist). W TS
    // odpytanie o nieistniejący klucz jest błędem typu, więc patrzymy przez luźny widok.
    t.is((DEFAULT_LIMITS as Record<string, number | undefined>).subagent_max_iterations_strategist, undefined);
    // Front A (2026-08-17): 120000 → 480000, runda 2: → 900000 — zegar ścienny to awaryjny
    // sufit, głównym strażnikiem jest watchdog ciszy (subagent_stall_timeout_ms).
    t.is(DEFAULT_LIMITS.delegation_timeout_ms, 900000);
    t.is(DEFAULT_LIMITS.max_tool_result_length, 15000);
});

// ── Merge: valid overrides win ─────────────────────────────────────────

test('valid override replaces the default', t => {
    const limits = getLimits({ pkmAssistant: { limits: { chat_max_iterations: 6 } } });
    t.is(limits.chat_max_iterations, 6);
    // untouched keys keep defaults
    t.is(limits.subagent_max_iterations_worker, DEFAULT_LIMITS.subagent_max_iterations_worker);
});

test('multiple overrides merge independently', t => {
    const limits = getLimits({ pkmAssistant: { limits: {
        subagent_max_iterations_worker: 12,
        delegation_timeout_ms: 150000,
    } } });
    t.is(limits.subagent_max_iterations_worker, 12);
    t.is(limits.delegation_timeout_ms, 150000);
    t.is(limits.chat_max_iterations, DEFAULT_LIMITS.chat_max_iterations);
});

test('override is floored to an integer', t => {
    const limits = getLimits({ pkmAssistant: { limits: { chat_max_iterations: 7.9 } } });
    t.is(limits.chat_max_iterations, 7);
});

test('numeric string override is accepted and coerced', t => {
    const limits = getLimits({ pkmAssistant: { limits: { chat_max_iterations: '9' } } });
    t.is(limits.chat_max_iterations, 9);
});

// ── Validation: garbage falls back to default ──────────────────────────

test('non-numeric override falls back to default', t => {
    for (const bad of ['abc', null, {}, [], NaN, Infinity, undefined, true]) {
        const limits = getLimits({ pkmAssistant: { limits: { chat_max_iterations: bad } } });
        t.is(limits.chat_max_iterations, DEFAULT_LIMITS.chat_max_iterations, `bad=${String(bad)}`);
    }
});

test('below-min iteration override (0 / negative) falls back to default', t => {
    t.is(getLimits({ pkmAssistant: { limits: { chat_max_iterations: 0 } } }).chat_max_iterations, DEFAULT_LIMITS.chat_max_iterations);
    t.is(getLimits({ pkmAssistant: { limits: { subagent_max_iterations_worker: -3 } } }).subagent_max_iterations_worker, DEFAULT_LIMITS.subagent_max_iterations_worker);
});

test('too-small delegation timeout falls back to default', t => {
    t.is(getLimits({ pkmAssistant: { limits: { delegation_timeout_ms: 10 } } }).delegation_timeout_ms, DEFAULT_LIMITS.delegation_timeout_ms);
});

// ── Ceilings: hard cap clamps, never falls back ────────────────────────

test('above-ceiling iteration override is clamped to the ceiling', t => {
    const limits = getLimits({ pkmAssistant: { limits: { chat_max_iterations: 9999 } } });
    t.is(limits.chat_max_iterations, LIMIT_SPECS.chat_max_iterations.ceiling);
});

test('above-ceiling delegation timeout is clamped to the ceiling', t => {
    const limits = getLimits({ pkmAssistant: { limits: { delegation_timeout_ms: 99_000_000 } } });
    t.is(limits.delegation_timeout_ms, LIMIT_SPECS.delegation_timeout_ms.ceiling);
});

// ── max_tool_result_length special case: 0 = unlimited is valid ─────────

test('max_tool_result_length accepts 0 (unlimited) as a valid override', t => {
    const limits = getLimits({ pkmAssistant: { limits: { max_tool_result_length: 0 } } });
    t.is(limits.max_tool_result_length, 0);
});

test('max_tool_result_length rejects negative and clamps huge values', t => {
    t.is(getLimits({ pkmAssistant: { limits: { max_tool_result_length: -1 } } }).max_tool_result_length, DEFAULT_LIMITS.max_tool_result_length);
    t.is(getLimits({ pkmAssistant: { limits: { max_tool_result_length: 10_000_000 } } }).max_tool_result_length, LIMIT_SPECS.max_tool_result_length.ceiling);
});

// ── chat_stream_stall_timeout_ms (watchdog streamu czatu, 2026-07-29) ───

test('chat_stream_stall_timeout_ms: default 120s, 0 = off valid, negative → default, ceiling clamps', t => {
    t.is(DEFAULT_LIMITS.chat_stream_stall_timeout_ms, 120000);
    t.is(getLimits({ pkmAssistant: { limits: { chat_stream_stall_timeout_ms: 0 } } }).chat_stream_stall_timeout_ms, 0);
    t.is(getLimits({ pkmAssistant: { limits: { chat_stream_stall_timeout_ms: -5 } } }).chat_stream_stall_timeout_ms, DEFAULT_LIMITS.chat_stream_stall_timeout_ms);
    t.is(getLimits({ pkmAssistant: { limits: { chat_stream_stall_timeout_ms: 99_000_000 } } }).chat_stream_stall_timeout_ms, LIMIT_SPECS.chat_stream_stall_timeout_ms.ceiling);
    t.is(getLimits({ pkmAssistant: { limits: { chat_stream_stall_timeout_ms: 90000 } } }).chat_stream_stall_timeout_ms, 90000);
});

// ── S33 Z1: kagańce delegacji (głębokość + szerokość) ──────────────────

test('S33 Z1: max_delegation_depth default 1, clamped to ceiling 3, min 1', t => {
    t.is(DEFAULT_LIMITS.max_delegation_depth, 1);
    t.is(LIMIT_SPECS.max_delegation_depth.ceiling, 3);
    t.is(LIMIT_SPECS.max_delegation_depth.min, 1);

    // ponad sufit → przycięte do 3 (nigdy nie spada na default)
    t.is(getLimits({ pkmAssistant: { limits: { max_delegation_depth: 99 } } }).max_delegation_depth, 3);
    // 0 / ujemne = próba wyłączenia delegacji tylnymi drzwiami → default
    t.is(getLimits({ pkmAssistant: { limits: { max_delegation_depth: 0 } } }).max_delegation_depth, 1);
    t.is(getLimits({ pkmAssistant: { limits: { max_delegation_depth: -2 } } }).max_delegation_depth, 1);
    // sensowny override przechodzi
    t.is(getLimits({ pkmAssistant: { limits: { max_delegation_depth: 2 } } }).max_delegation_depth, 2);
    // śmieć → default
    t.is(getLimits({ pkmAssistant: { limits: { max_delegation_depth: 'gleboko' } } }).max_delegation_depth, 1);
});

test('S33 Z1: max_parallel_delegations default 5, ceiling 20, min 1', t => {
    t.is(DEFAULT_LIMITS.max_parallel_delegations, 5);
    t.is(getLimits({ pkmAssistant: { limits: { max_parallel_delegations: 999 } } }).max_parallel_delegations, 20);
    t.is(getLimits({ pkmAssistant: { limits: { max_parallel_delegations: 0 } } }).max_parallel_delegations, 5);
    t.is(getLimits({ pkmAssistant: { limits: { max_parallel_delegations: 8 } } }).max_parallel_delegations, 8);
});

// ── S33 Z2: bezpiecznik poczty agentów ─────────────────────────────────

test('S33 Z2: kom_send_rate_max default 20, ceiling 500, min 1', t => {
    t.is(DEFAULT_LIMITS.kom_send_rate_max, 20);
    t.is(LIMIT_SPECS.kom_send_rate_max.ceiling, 500);
    t.is(LIMIT_SPECS.kom_send_rate_max.min, 1);

    t.is(getLimits({ pkmAssistant: { limits: { kom_send_rate_max: 5000 } } }).kom_send_rate_max, 500);
    // 0 = próba wyłączenia poczty limitem → default (od wyłączania jest kill-switch)
    t.is(getLimits({ pkmAssistant: { limits: { kom_send_rate_max: 0 } } }).kom_send_rate_max, 20);
    t.is(getLimits({ pkmAssistant: { limits: { kom_send_rate_max: 3 } } }).kom_send_rate_max, 3);
    t.is(getLimits({ pkmAssistant: { limits: { kom_send_rate_max: 'duzo' } } }).kom_send_rate_max, 20);
});

// ── Werdykt Kuby 16.08: sufit ŁAŃCUCHA auto-tur po subach z rzędu ───────

test('Werdykt 16.08: max_consecutive_auto_turns default 10, ceiling 20, min 1', t => {
    t.is(DEFAULT_LIMITS.max_consecutive_auto_turns, 10);
    t.is(LIMIT_SPECS.max_consecutive_auto_turns.ceiling, 20);
    t.is(LIMIT_SPECS.max_consecutive_auto_turns.min, 1);

    // ponad sufit → przycięte do 20 (nigdy nie spada na default)
    t.is(getLimits({ pkmAssistant: { limits: { max_consecutive_auto_turns: 50 } } }).max_consecutive_auto_turns, 20);
    // 0 = próba wyłączenia łańcucha tylnymi drzwiami → default
    t.is(getLimits({ pkmAssistant: { limits: { max_consecutive_auto_turns: 0 } } }).max_consecutive_auto_turns, 10);
    // sensowny override przechodzi
    t.is(getLimits({ pkmAssistant: { limits: { max_consecutive_auto_turns: 7 } } }).max_consecutive_auto_turns, 7);
    // śmieć → default
    t.is(getLimits({ pkmAssistant: { limits: { max_consecutive_auto_turns: 'duzo' } } }).max_consecutive_auto_turns, 10);
});

test('K12: kom_send_rate_max_sender default 40, ceiling 2000, min 1', t => {
    t.is(DEFAULT_LIMITS.kom_send_rate_max_sender, 40);
    t.is(LIMIT_SPECS.kom_send_rate_max_sender.ceiling, 2000);
    t.is(LIMIT_SPECS.kom_send_rate_max_sender.min, 1);

    t.is(getLimits({ pkmAssistant: { limits: { kom_send_rate_max_sender: 99999 } } }).kom_send_rate_max_sender, 2000);
    // 0 = próba wyłączenia poczty limitem → default (tak samo jak przy limicie pary)
    t.is(getLimits({ pkmAssistant: { limits: { kom_send_rate_max_sender: 0 } } }).kom_send_rate_max_sender, 40);
    t.is(getLimits({ pkmAssistant: { limits: { kom_send_rate_max_sender: 7 } } }).kom_send_rate_max_sender, 7);
    t.is(getLimits({ pkmAssistant: { limits: { kom_send_rate_max_sender: 'duzo' } } }).kom_send_rate_max_sender, 40);
});

// ── F4: capy jakościowe subów jako konfigurowalne budżety ──────────────

test('F4: subagent_prompt_max_chars default 24000, min 1000, ceiling 100000', t => {
    t.is(DEFAULT_LIMITS.subagent_prompt_max_chars, 24000);
    t.is(LIMIT_SPECS.subagent_prompt_max_chars.min, 1000);
    t.is(LIMIT_SPECS.subagent_prompt_max_chars.ceiling, 100000);

    t.is(getLimits({ pkmAssistant: { limits: { subagent_prompt_max_chars: 40000 } } }).subagent_prompt_max_chars, 40000);
    // ponad sufit → przycięte; poniżej podłogi (próba wykastrowania instrukcji) → default
    t.is(getLimits({ pkmAssistant: { limits: { subagent_prompt_max_chars: 999_999 } } }).subagent_prompt_max_chars, 100000);
    t.is(getLimits({ pkmAssistant: { limits: { subagent_prompt_max_chars: 10 } } }).subagent_prompt_max_chars, 24000);
    t.is(getLimits({ pkmAssistant: { limits: { subagent_prompt_max_chars: 'duzo' } } }).subagent_prompt_max_chars, 24000);
});

test('F4: delegation_context_max_chars default 48000, min 1000, ceiling 200000', t => {
    t.is(DEFAULT_LIMITS.delegation_context_max_chars, 48000);
    t.is(LIMIT_SPECS.delegation_context_max_chars.min, 1000);
    t.is(LIMIT_SPECS.delegation_context_max_chars.ceiling, 200000);

    t.is(getLimits({ pkmAssistant: { limits: { delegation_context_max_chars: 16000 } } }).delegation_context_max_chars, 16000);
    t.is(getLimits({ pkmAssistant: { limits: { delegation_context_max_chars: 9_000_000 } } }).delegation_context_max_chars, 200000);
    t.is(getLimits({ pkmAssistant: { limits: { delegation_context_max_chars: 0 } } }).delegation_context_max_chars, 48000);
});

test('F5/Front A: subagent_final_grace_ms default 120000, min 5000, ceiling 240000', t => {
    t.is(DEFAULT_LIMITS.subagent_final_grace_ms, 120000);
    t.is(LIMIT_SPECS.subagent_final_grace_ms.min, 5000);
    t.is(LIMIT_SPECS.subagent_final_grace_ms.ceiling, 240000);

    t.is(getLimits({ pkmAssistant: { limits: { subagent_final_grace_ms: 20000 } } }).subagent_final_grace_ms, 20000);
    // ponad sufit → przycięte do sufitu; poniżej podłogi (grace-okno na niby) → default
    t.is(getLimits({ pkmAssistant: { limits: { subagent_final_grace_ms: 999_999 } } }).subagent_final_grace_ms, 240000);
    t.is(getLimits({ pkmAssistant: { limits: { subagent_final_grace_ms: 500 } } }).subagent_final_grace_ms, 120000);
    t.is(getLimits({ pkmAssistant: { limits: { subagent_final_grace_ms: 0 } } }).subagent_final_grace_ms, 120000);
});

// ── Front A (2026-08-17): watchdog ciszy + ratowanie dorobku subów ──────

test('Front A: subagent_stall_timeout_ms default 180000, 0 = off valid, ceiling clamps', t => {
    t.is(DEFAULT_LIMITS.subagent_stall_timeout_ms, 180000);
    t.is(LIMIT_SPECS.subagent_stall_timeout_ms.min, 0);
    t.is(LIMIT_SPECS.subagent_stall_timeout_ms.ceiling, 600000);

    t.is(getLimits({ pkmAssistant: { limits: { subagent_stall_timeout_ms: 0 } } }).subagent_stall_timeout_ms, 0);
    t.is(getLimits({ pkmAssistant: { limits: { subagent_stall_timeout_ms: -5 } } }).subagent_stall_timeout_ms, 180000);
    t.is(getLimits({ pkmAssistant: { limits: { subagent_stall_timeout_ms: 99_000_000 } } }).subagent_stall_timeout_ms, 600000);
    t.is(getLimits({ pkmAssistant: { limits: { subagent_stall_timeout_ms: 240000 } } }).subagent_stall_timeout_ms, 240000);
});

test('Runda 2: subagent_result_max_chars default 60000, 0 = bez limitu, ceiling clamps', t => {
    t.is(DEFAULT_LIMITS.subagent_result_max_chars, 60000);
    t.is(LIMIT_SPECS.subagent_result_max_chars.min, 0);
    t.is(LIMIT_SPECS.subagent_result_max_chars.ceiling, 200000);

    t.is(getLimits({ pkmAssistant: { limits: { subagent_result_max_chars: 0 } } }).subagent_result_max_chars, 0);
    t.is(getLimits({ pkmAssistant: { limits: { subagent_result_max_chars: -1 } } }).subagent_result_max_chars, 60000);
    t.is(getLimits({ pkmAssistant: { limits: { subagent_result_max_chars: 9_000_000 } } }).subagent_result_max_chars, 200000);
});

test('Runda 2: sufity podniesione — iteracje workera 100, zegar zadania 30 min', t => {
    t.is(LIMIT_SPECS.subagent_max_iterations_worker.ceiling, 100);
    t.is(LIMIT_SPECS.delegation_timeout_ms.ceiling, 1800000);
    t.is(DEFAULT_LIMITS.chat_model_call_timeout_ms, 600000);
});

// ── AUD-testy-031/004: chat_model_call_timeout_ms (friendly fire 2026-08-15) ────
//
// Do dziś jedyna asercja na ten klucz był pin defaultu wyżej — zero testu widełek:
// mutacja sufitu 900000 → 1 (albo podłogi 0 → 100000) zostawiała 28/28 zielonych,
// mimo że sanitizeLimit ma dla tego klucza dokładnie te same gałęzie co sąsiedzi.
// Wzorem `chat_stream_stall_timeout_ms` (identyczny kształt: min 0 / 0 = watchdog
// wyłączony / ceiling twardy sufit XHR adaptera).

test('AUD-testy-031: chat_model_call_timeout_ms default 600000, 0 = off valid, negative → default, ceiling clamps', t => {
    t.is(DEFAULT_LIMITS.chat_model_call_timeout_ms, 600000);
    t.is(LIMIT_SPECS.chat_model_call_timeout_ms.min, 0);
    t.is(LIMIT_SPECS.chat_model_call_timeout_ms.ceiling, 900000);

    t.is(getLimits({ pkmAssistant: { limits: { chat_model_call_timeout_ms: 0 } } }).chat_model_call_timeout_ms, 0);
    t.is(getLimits({ pkmAssistant: { limits: { chat_model_call_timeout_ms: -5 } } }).chat_model_call_timeout_ms, DEFAULT_LIMITS.chat_model_call_timeout_ms);
    t.is(getLimits({ pkmAssistant: { limits: { chat_model_call_timeout_ms: 99_000_000 } } }).chat_model_call_timeout_ms, LIMIT_SPECS.chat_model_call_timeout_ms.ceiling);
    t.is(getLimits({ pkmAssistant: { limits: { chat_model_call_timeout_ms: 300000 } } }).chat_model_call_timeout_ms, 300000);
    t.is(getLimits({ pkmAssistant: { limits: { chat_model_call_timeout_ms: 'duzo' } } }).chat_model_call_timeout_ms, DEFAULT_LIMITS.chat_model_call_timeout_ms);
});

test('Front A: subagent_salvage_max_chars default 12000, 0 = off valid, ceiling clamps', t => {
    t.is(DEFAULT_LIMITS.subagent_salvage_max_chars, 12000);
    t.is(LIMIT_SPECS.subagent_salvage_max_chars.min, 0);
    t.is(LIMIT_SPECS.subagent_salvage_max_chars.ceiling, 200000);

    t.is(getLimits({ pkmAssistant: { limits: { subagent_salvage_max_chars: 0 } } }).subagent_salvage_max_chars, 0);
    t.is(getLimits({ pkmAssistant: { limits: { subagent_salvage_max_chars: -1 } } }).subagent_salvage_max_chars, 12000);
    t.is(getLimits({ pkmAssistant: { limits: { subagent_salvage_max_chars: 9_000_000 } } }).subagent_salvage_max_chars, 200000);
    t.is(getLimits({ pkmAssistant: { limits: { subagent_salvage_max_chars: 20000 } } }).subagent_salvage_max_chars, 20000);
});

// ── AUD-testy-001/048: local_platform_max_concurrent (bramka mostu lokalnego) ───
//
// Jedyny z 18 limitów bez ANI JEDNEGO testu — klucz nie występował w tym pliku ani razu.
// Mutacja widełek (ceiling 10 → 999999) nie zapalała nic w config/limits.test.ts (obalacz
// potwierdził: efekt DOMYŚLNEJ wartości 1 jest osobno pilnowany zachowaniem w
// modules/models/ChatModel.concurrent.test.ts, ale ŚCIEŻKA OVERRIDE/WIDEŁEK była naga).

test('AUD-testy-001: local_platform_max_concurrent default 1, ceiling 10, min 1', t => {
    t.is(DEFAULT_LIMITS.local_platform_max_concurrent, 1);
    t.is(LIMIT_SPECS.local_platform_max_concurrent.ceiling, 10);
    t.is(LIMIT_SPECS.local_platform_max_concurrent.min, 1);

    // ponad sufit → przycięte do 10 (nigdy nie spada na default)
    t.is(getLimits({ pkmAssistant: { limits: { local_platform_max_concurrent: 99 } } }).local_platform_max_concurrent, 10);
    // 0 / ujemne = próba wyłączenia bramki mostu lokalnego tylnymi drzwiami → default
    t.is(getLimits({ pkmAssistant: { limits: { local_platform_max_concurrent: 0 } } }).local_platform_max_concurrent, 1);
    t.is(getLimits({ pkmAssistant: { limits: { local_platform_max_concurrent: -1 } } }).local_platform_max_concurrent, 1);
    // sensowny override przechodzi
    t.is(getLimits({ pkmAssistant: { limits: { local_platform_max_concurrent: 5 } } }).local_platform_max_concurrent, 5);
    // śmieć → default
    t.is(getLimits({ pkmAssistant: { limits: { local_platform_max_concurrent: 'duzo' } } }).local_platform_max_concurrent, 1);
});

// ── AUD-testy-001: inwariant widełek — domyka też PRZYSZŁE klucze ───────────────
//
// Defaulty w DEFAULT_LIMITS NIE przechodzą przez sanitizeLimit (getLimits() bez override
// zwraca defaulty 1:1) — więc żaden pojedynczy blok testowy wyżej nie gwarantuje, że
// fabryczna wartość mieści się we własnych widełkach LIMIT_SPECS. Ten test sprawdza to
// dla WSZYSTKICH kluczy naraz, iterując po Object.keys — nowy limit dziedziczy pokrycie
// od razu, bez dopisywania kolejnego bloku.

test('invariant: every DEFAULT_LIMITS value fits inside its own LIMIT_SPECS (min/ceiling)', t => {
    const klucze = Object.keys(DEFAULT_LIMITS) as LimitKey[];
    t.true(klucze.length > 0, 'DEFAULT_LIMITS jest puste — coś poszło nie tak z importem.');

    for (const key of klucze) {
        const value = DEFAULT_LIMITS[key];
        const spec = LIMIT_SPECS[key];
        t.true(value >= spec.min, `${key}: default ${value} spada poniżej własnego min ${spec.min}`);
        t.true(value <= spec.ceiling, `${key}: default ${value} przekracza własny ceiling ${spec.ceiling}`);
    }
});

// ── Purity: getLimits must not mutate DEFAULT_LIMITS ────────────────────

test('getLimits does not mutate DEFAULT_LIMITS', t => {
    const before = { ...DEFAULT_LIMITS };
    getLimits({ pkmAssistant: { limits: { chat_max_iterations: 3 } } });
    t.deepEqual(DEFAULT_LIMITS, before);
});
