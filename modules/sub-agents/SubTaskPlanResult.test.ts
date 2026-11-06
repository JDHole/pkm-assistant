import test from 'ava';
import { SubTaskPlan } from './SubTaskPlan.js';
import { buildPlanResult, formatPlanResult } from './SubTaskPlanResult.js';

test('readable plan notification uses each node mode and keeps complete frozen material', t => {
    const created = SubTaskPlan.create([{ id: 'A' }, { id: 'B', depends_on: ['A'], dependency_results: 'full' }], 5);
    if (created.kind !== 'valid') throw new Error('Invalid fixture');
    for (const id of ['A', 'B']) {
        created.plan.queue(id, { runId: id, threadId: id }); created.plan.start(id);
        created.plan.settle(id, { kind: 'done', material: `First ${id}.\nSecond ${id}.` });
    }
    const result = buildPlanResult({ planId: 'plan-test', nodes: created.plan.nodes, status: created.plan.status });
    t.is(formatPlanResult(result, 0), '[SYSTEM NOTIFICATION] Plan result plan-test\n<vault_content source="plan_result:completed">\ncompleted\n'
        + 'A: finished | result A (summary): First A. | blocked_by: -\n'
        + 'B: finished | result B (full): First B. Second B. | blocked_by: -\n</vault_content>\n'
        + 'Pick the thread back up - use this result to finish the job. If you started more tasks, their results will arrive separately; do not guess their content.');
    t.deepEqual(result.nodes.map(node => node.state.material), ['First A.\nSecond A.', 'First B.\nSecond B.']);
});

test('readable partial notification preserves an unanswered question with configured secrets redacted', t => {
    const created = SubTaskPlan.create([{ id: 'A' }], 5);
    if (created.kind !== 'valid') throw new Error('Invalid fixture');
    created.plan.settle('A', { kind: 'error', error: 'No answer', material: 'Available result.',
        question: { text: 'Use private-crossing-value?', resolution: { kind: 'no-answer' } } });
    const result = buildPlanResult({ planId: 'plan-question', nodes: created.plan.nodes, status: created.plan.status }, 0, ['private-crossing-value']);
    t.is(formatPlanResult(result, 0).split('\n')[3], 'A: failed (No answer) | result A (summary): Available result.'
        + ' | The sub-agent received no answer to the question: Use [REDACTED]? | blocked_by: -');
    t.deepEqual(result.nodes[0].state.question, { text: 'Use [REDACTED]?', resolution: { kind: 'no-answer' } });
});
