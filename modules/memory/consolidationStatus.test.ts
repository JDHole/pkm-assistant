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

// ── podłoga limitu brain/ (2.2.6): state NIE ma już bezwarunkowego pierwszeństwa ──────────

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

test('resolveConsolidationThresholds: puste ustawienia -> CONSOLIDATION_DEFAULTS (10/20/5)', t => {
    t.deepEqual(resolveConsolidationThresholds(null, null), {
        sessionThreshold: CONSOLIDATION_DEFAULTS.sessionThreshold,
        brainNotesLimit: CONSOLIDATION_DEFAULTS.brainNotesLimit,
        brainNotesLimitSource: 'default',
        batchSize: CONSOLIDATION_DEFAULTS.batchSize,
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

test('planAutoConsolidation: oba ON, tylko sesje due -> trigger true, include OBA true (dedup to propozycja, nie warunek)', t => {
    const plan = planAutoConsolidation(
        OVER_THRESHOLD_STATE, 0, // brain NIE jest due
        { memoryV3AutoConsolidateSessions: true, memoryV3AutoConsolidateBrain: true },
    );
    t.true(plan.trigger);
    t.deepEqual(plan.include, { sessions: true, dedup: true });
});

test('planAutoConsolidation: oba ON, NIC nie jest due -> trigger false, include nadal oba true', t => {
    const plan = planAutoConsolidation(
        { archived_since_last_consolidation: 0 }, 0,
        { memoryV3AutoConsolidateSessions: true, memoryV3AutoConsolidateBrain: true },
    );
    t.false(plan.trigger);
    t.deepEqual(plan.include, { sessions: true, dedup: true });
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
