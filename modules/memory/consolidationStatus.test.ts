import test from 'ava';
import {
    resolveConsolidationThresholds,
    shouldTriggerConsolidation,
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
