import test from 'ava';
import {
    resolveConsolidationThresholds,
    shouldTriggerConsolidation,
    planAutoConsolidation,
    resolveAutoConsolidationPolicy,
    CONSOLIDATION_DEFAULTS,
} from './consolidationStatus.js';

// ── resolveConsolidationThresholds — czyste funkcje, te same operatory/fallbacki co
//    dotychczasowe `SaveSessionWorkflow._shouldTriggerArchive`. ────────────────────────────

test('resolveConsolidationThresholds: bez state/settings -> same defaulty', t => {
    t.deepEqual(resolveConsolidationThresholds(null, null), {
        sessionThreshold: 10,
        brainNotesLimit: 20,
        brainNotesLimitSource: 'default',
        batchSize: 5,
    });
});

test('resolveConsolidationThresholds: memoryV3BrainNotesThreshold z ustawień -> limitSource=settings', t => {
    const result = resolveConsolidationThresholds(null, { memoryV3BrainNotesThreshold: 15 });
    t.is(result.brainNotesLimit, 15);
    t.is(result.brainNotesLimitSource, 'settings');
});

test('resolveConsolidationThresholds: archiveBrainNotesThreshold jako fallback ustawień -> limitSource=settings', t => {
    const result = resolveConsolidationThresholds(null, { archiveBrainNotesThreshold: 12 });
    t.is(result.brainNotesLimit, 12);
    t.is(result.brainNotesLimitSource, 'settings');
});

test('resolveConsolidationThresholds: state.brain_notes_limit ma pierwszeństwo nad ustawieniami -> limitSource=agent_state', t => {
    const result = resolveConsolidationThresholds(
        { brain_notes_limit: 30 },
        { memoryV3BrainNotesThreshold: 15 },
    );
    t.is(result.brainNotesLimit, 30);
    t.is(result.brainNotesLimitSource, 'agent_state');
});

test('resolveConsolidationThresholds: sessionThreshold i batchSize z ustawień', t => {
    const result = resolveConsolidationThresholds(null, {
        memoryV3SessionThreshold: 6,
        memoryV3ArchiveBatchSize: 7,
    });
    t.is(result.sessionThreshold, 6);
    t.is(result.batchSize, 7);
});

test('resolveConsolidationThresholds: archiveSessionThreshold jako fallback sessionThreshold', t => {
    const result = resolveConsolidationThresholds(null, { archiveSessionThreshold: 4 });
    t.is(result.sessionThreshold, 4);
});

// ── podłoga limitu brain/ (2.2.9): state NIE ma już bezwarunkowego pierwszeństwa ──────────

test('resolveConsolidationThresholds: podłoga — state 30 + ustawienie 50 -> zwycięża WYŻSZE ustawienie (50)', t => {
    const result = resolveConsolidationThresholds(
        { brain_notes_limit: 30 },
        { memoryV3BrainNotesThreshold: 50 },
    );
    t.is(result.brainNotesLimit, 50);
    t.is(result.brainNotesLimitSource, 'settings');
});

test('resolveConsolidationThresholds: podłoga — state 30 + ustawienie 20 -> zwycięża WYŻSZY state (30)', t => {
    const result = resolveConsolidationThresholds(
        { brain_notes_limit: 30 },
        { memoryV3BrainNotesThreshold: 20 },
    );
    t.is(result.brainNotesLimit, 30);
    t.is(result.brainNotesLimitSource, 'agent_state');
});

// ── bug recenzji #9: ujemne/NaN wartości z ustawień = "nieustawione", nie "zawsze due" ─────

test('resolveConsolidationThresholds: sessionThreshold ujemny (-5) -> spada na domyślną (10), NIE zostaje -5', t => {
    // Przed naprawą: `Number(-5) || default` zwracało dosłownie -5 (liczba ujemna jest truthy w
    // JS) - `archived_since_last_consolidation >= -5` jest ZAWSZE prawdą, więc ręcznie
    // uszkodzony `data.json` dawał "zawsze due" zamiast paść na wartość domyślną.
    const result = resolveConsolidationThresholds(null, { memoryV3SessionThreshold: -5 });
    t.is(result.sessionThreshold, 10);
});

test('resolveConsolidationThresholds: memoryV3BrainNotesThreshold ujemny/NaN -> spada na domyślny limit (20)', t => {
    t.is(resolveConsolidationThresholds(null, { memoryV3BrainNotesThreshold: -5 }).brainNotesLimit, 20);
    t.is(resolveConsolidationThresholds(null, { memoryV3BrainNotesThreshold: Number.NaN }).brainNotesLimit, 20);
});

test('resolveConsolidationThresholds: state.brain_notes_limit ujemny -> NIE wygrywa z dodatnim ustawieniem globalnym', t => {
    const result = resolveConsolidationThresholds({ brain_notes_limit: -5 }, { memoryV3BrainNotesThreshold: 30 });
    t.is(result.brainNotesLimit, 30);
    t.is(result.brainNotesLimitSource, 'settings');
});

test('resolveConsolidationThresholds: memoryV3ArchiveBatchSize ujemny -> spada na domyślny (5)', t => {
    t.is(resolveConsolidationThresholds(null, { memoryV3ArchiveBatchSize: -5 }).batchSize, 5);
});

// N3(b) recenzji rundy 3: `firstPositive` na jawnym 0 i na zapisie "0x10" (`Number("0x10")`
// parsuje hex jako 16) - oba mają spaść na domyślną, nie zostać przepuszczone jako próg.

test('resolveConsolidationThresholds: sessionThreshold jawne 0 -> spada na domyślną (10), NIE zostaje 0', t => {
    t.is(resolveConsolidationThresholds(null, { memoryV3SessionThreshold: 0 }).sessionThreshold, 10);
});

test('resolveConsolidationThresholds: memoryV3BrainNotesThreshold jawne 0 -> spada na domyślny limit (20)', t => {
    t.is(resolveConsolidationThresholds(null, { memoryV3BrainNotesThreshold: 0 }).brainNotesLimit, 20);
});

test('resolveConsolidationThresholds: memoryV3ArchiveBatchSize jawne 0 -> spada na domyślny (5)', t => {
    t.is(resolveConsolidationThresholds(null, { memoryV3ArchiveBatchSize: 0 }).batchSize, 5);
});

test('resolveConsolidationThresholds: sessionThreshold jako string "0x10" -> spada na domyślną (10), NIE 16', t => {
    // Number("0x10") === 16 (parsing hex) - bez bramki /^\d+$/ string "0x10" z ręcznie
    // edytowanego data.json przechodziłby jako prawidłowy próg 16.
    t.is(resolveConsolidationThresholds(null, { memoryV3SessionThreshold: '0x10' }).sessionThreshold, 10);
});

test('resolveConsolidationThresholds: memoryV3BrainNotesThreshold jako string "0x10" -> spada na domyślny limit (20), NIE 16', t => {
    t.is(resolveConsolidationThresholds(null, { memoryV3BrainNotesThreshold: '0x10' }).brainNotesLimit, 20);
});

test('resolveConsolidationThresholds: string liczbowy poprawny ("25") po trim nadal działa - bramka /^\\d+$/ nie psuje zwykłego wejścia', t => {
    t.is(resolveConsolidationThresholds(null, { memoryV3SessionThreshold: ' 25 ' }).sessionThreshold, 25);
});

test('resolveConsolidationThresholds: puste ustawienia -> CONSOLIDATION_DEFAULTS (10/20/5)', t => {
    // Literalnie 10/20/5 (nie `CONSOLIDATION_DEFAULTS.x`) - test ma łapać PRZYPADKOWĄ zmianę
    // samej stałej, nie tylko potwierdzać, że funkcja czyta to, co stała akurat mówi (recenzja #11:
    // porównanie względem tej samej stałej jest samoodnoszące się i przechodzi nawet po regresji).
    t.deepEqual(resolveConsolidationThresholds(null, null), {
        sessionThreshold: 10,
        brainNotesLimit: 20,
        brainNotesLimitSource: 'default',
        batchSize: 5,
    });
    t.is(CONSOLIDATION_DEFAULTS.sessionThreshold, 10);
    t.is(CONSOLIDATION_DEFAULTS.brainNotesLimit, 20);
    t.is(CONSOLIDATION_DEFAULTS.batchSize, 5);
});

// ── resolveAutoConsolidationPolicy — oba wyłączniki domyślnie OFF ──────────────────────────

test('resolveAutoConsolidationPolicy: brak ustawień -> oba wyłączniki false', t => {
    t.deepEqual(resolveAutoConsolidationPolicy(null), { sessions: false, brain: false });
    t.false(CONSOLIDATION_DEFAULTS.autoSessions);
    t.false(CONSOLIDATION_DEFAULTS.autoBrain);
});

test('resolveAutoConsolidationPolicy: tylko truthy `=== true` liczy się jako włączone', t => {
    t.deepEqual(resolveAutoConsolidationPolicy({ memoryV3AutoConsolidateSessions: 1 }), { sessions: false, brain: false });
    t.deepEqual(resolveAutoConsolidationPolicy({ memoryV3AutoConsolidateSessions: true }), { sessions: true, brain: false });
    t.deepEqual(resolveAutoConsolidationPolicy({ memoryV3AutoConsolidateBrain: true }), { sessions: false, brain: true });
});

// ── planAutoConsolidation — polityka × progi ───────────────────────────────────────────────

const OVER_THRESHOLD_STATE = { archived_since_last_consolidation: 99 };
const OVER_THRESHOLD_BRAIN_COUNT = 999;

test('planAutoConsolidation: oba wyłączniki OFF + liczniki NAD progami -> trigger false', t => {
    const plan = planAutoConsolidation(OVER_THRESHOLD_STATE, OVER_THRESHOLD_BRAIN_COUNT, {});
    t.deepEqual(plan, { trigger: false, include: { sessions: false, dedup: false } });
});

test('planAutoConsolidation: tylko sesje ON + sesje due -> trigger true, include {sessions:true, dedup:false}', t => {
    const plan = planAutoConsolidation(
        OVER_THRESHOLD_STATE, 0,
        { memoryV3AutoConsolidateSessions: true },
    );
    t.true(plan.trigger);
    t.deepEqual(plan.include, { sessions: true, dedup: false });
});

test('planAutoConsolidation: tylko brain ON + brain due -> trigger true, include {sessions:false, dedup:true}', t => {
    const plan = planAutoConsolidation(
        { archived_since_last_consolidation: 0 }, OVER_THRESHOLD_BRAIN_COUNT,
        { memoryV3AutoConsolidateBrain: true },
    );
    t.true(plan.trigger);
    t.deepEqual(plan.include, { sessions: false, dedup: true });
});

test('planAutoConsolidation: oba ON, tylko sesje due -> trigger true, include {sessions:true, dedup:false} (DECYZJA recenzji: dedup wymaga też „due")', t => {
    const plan = planAutoConsolidation(
        OVER_THRESHOLD_STATE, 0, // brain NIE jest due
        { memoryV3AutoConsolidateSessions: true, memoryV3AutoConsolidateBrain: true },
    );
    t.true(plan.trigger);
    t.deepEqual(plan.include, { sessions: true, dedup: false });
});

test('planAutoConsolidation: oba ON, NIC nie jest due -> trigger false, include oba false', t => {
    const plan = planAutoConsolidation(
        { archived_since_last_consolidation: 0 }, 0,
        { memoryV3AutoConsolidateSessions: true, memoryV3AutoConsolidateBrain: true },
    );
    t.false(plan.trigger);
    t.deepEqual(plan.include, { sessions: false, dedup: false });
});

// ── regresja recenzji: odrzucone L1 NIE wraca na cudzym triggerze (brain) ──────────────────

test('planAutoConsolidation: oba ON, L1 świeżo odrzucony (licznik 0) + brain due (25 notatek) -> include BEZ sesji', t => {
    // Scenariusz z recenzji: user odrzucił propozycję L1 (licznik wyzerowany przez wyciszenie),
    // ale próg notatek brain/ jest przebity (25 > 20 domyślne). Przed DECYZJĄ recenzji `include`
    // odzwierciedlało samą politykę (`policy.sessions === true`), więc odrzucone L1 wracało do
    // planu razem z dedup - łamiąc obietnicę „odrzucona propozycja nie wraca przy następnym
    // zapisie". Teraz sesje wchodzą do `include` TYLKO gdy są też `due`.
    const plan = planAutoConsolidation(
        { archived_since_last_consolidation: 0 }, 25,
        { memoryV3AutoConsolidateSessions: true, memoryV3AutoConsolidateBrain: true },
    );
    t.true(plan.trigger, 'brain jest due - automat i tak odpala się dla TEJ gałęzi');
    t.deepEqual(plan.include, { sessions: false, dedup: true }, 'sesje NIE wracają - nie są due, mimo że wyłącznik jest ON');
});

// ── shouldTriggerConsolidation — granice: sesje `>=`, notatki `>`. ─────────────────────────

test('shouldTriggerConsolidation: sesje DOKŁADNIE na progu (>=) -> true', t => {
    t.true(shouldTriggerConsolidation({ archived_since_last_consolidation: 10 }, 0, null));
});

test('shouldTriggerConsolidation: sesje tuż pod progiem, notatki na limicie (nie NAD) -> false', t => {
    t.false(shouldTriggerConsolidation({ archived_since_last_consolidation: 9 }, 20, null));
});

test('shouldTriggerConsolidation: notatki NAD limitem (limit+1) -> true', t => {
    t.true(shouldTriggerConsolidation({ archived_since_last_consolidation: 9 }, 21, null));
});
