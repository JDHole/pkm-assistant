import test from 'ava';
import { setLocale } from '../../../core/i18n/index.js';
import { SubAgentRunner, SubTaskRegistry, SubTaskNotifier } from '../../sub-agents/index.js';
import { planInput, planOwner, planResult, activatePlanTask } from '../../sub-agents/test-support/planFixture.js';
import { buildSubTaskResultDelivery } from './subTaskResultDelivery.js';

test.serial('P4 notifier: one result per node, immutable full table outside material cap, final transaction only', t => {
    setLocale('en');
    const registry = new SubTaskRegistry(); const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); });
    registry.reservePlan(planInput());
    const a = activatePlanTask(registry, 'A'); const b = activatePlanTask(registry, 'B');
    registry.fail(a, 'A failed'); registry.finish(b, planResult('Independent result'));
    registry.finish(a, planResult('Late answer'));
    const delivered = notifier.claimPending(() => true).map(claim => {
        const result = buildSubTaskResultDelivery(claim.task, registry, 4);
        claim.ack(); return { id: claim.task.id, ...result };
    });
    t.deepEqual(delivered.map(d => d.id), ['A', 'C', 'B']);
    const table = '| ID | State |\n| --- | --- |\n| C | blocked (failed: A) |\n| A | failed |\n| B | working |';
    t.true(delivered[0].text.includes(table));
    t.true(delivered[1].text.includes('task was not started'));
    t.true(delivered[1].text.includes(table));
    t.true(delivered[2].text.includes('| C | blocked (failed: A) |\n| A | failed |\n| B | finished on its own |\nPlan finished'));
    t.true(delivered[2].text.includes('Inde\n'));
    t.false(delivered[2].text.includes('Independent result'));
    t.deepEqual(delivered.map(d => (d.meta._subTaskResult as { plan_complete: boolean }).plan_complete), [false, false, true]);
    t.deepEqual((delivered[1].meta._subTaskResult as { plan: unknown }).plan, { planId: 'plan-p4', nodeId: 'C',
        dependsOn: [{ nodeId: 'A', runId: 'A' }, { nodeId: 'B', runId: 'B' }], state: { kind: 'blocked', causes: [{ nodeId: 'A', runId: 'A' }] } });
    t.deepEqual(notifier.pending(), []);
});

test.serial('P4 parent inbox reaches actual runner prompt once per node with the same plan table', async t => {
    setLocale('en');
    const registry = new SubTaskRegistry(); const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); });
    const runner = new SubAgentRunner({ app: {}, plugin: { subTaskRegistry: registry }, toolRegistry: { getTool: () => null, filterByAgent: () => [] } });
    let calls = 0;
    let payload: Array<{ task_id: string; plan_complete: boolean; plan_summary: string; plan_report: { nodes: Array<{ nodeId: string; state: { kind: string } }> }; result?: { text: string } }> = [];
    const model = { stream(input: { messages: Array<{ content?: string }> }, callbacks: { done(value: unknown): void }) {
        if (++calls === 1) {
            const parent = registry.list()[0];
            registry.reservePlan(planInput(planOwner, parent.id));
            const a = activatePlanTask(registry, 'A'); const b = activatePlanTask(registry, 'B');
            registry.fail(a, 'A failed'); registry.finish(b, planResult('Independent result'));
            registry.finish(b, planResult('Late answer'));
        } else {
            payload = input.messages.filter(m => m.content?.startsWith('Child notices:\n'))
                .flatMap(m => JSON.parse(m.content!.slice('Child notices:\n'.length)));
        }
        callbacks.done({ choices: [{ message: { role: 'assistant', content: calls === 1 ? 'Waiting' : 'Parent decision' } }] });
    } };
    const result = await runner.runTask('Coordinate', { name: planOwner.agentName }, { name: 'parent', tools: [] } as never,
        model as never, { origin: planOwner, modelTimeout: 1000 });
    t.is(result.result, 'Parent decision');
    t.is(calls, 2);
    t.deepEqual(payload.map(n => [n.task_id, n.plan_complete, n.result?.text]), [['A', false, undefined], ['C', false, ''], ['B', true, 'Independent result']]);
    t.deepEqual(payload[2].plan_report.nodes.map(n => [n.nodeId, n.state.kind]), [['C', 'blocked'], ['A', 'failed'], ['B', 'finished']]);
    t.is(payload[2].plan_summary, 'Plan plan-p4\n| ID | State |\n| --- | --- |\n| C | blocked (failed: A) |\n| A | failed |\n| B | finished on its own |\nPlan finished');
    t.deepEqual(notifier.pending(), []);
});

test.serial('P4 final failure transaction marks its blocked results complete without aggregate notice', t => {
    setLocale('pl');
    const registry = new SubTaskRegistry(); const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); setLocale('en'); });
    registry.reservePlan(planInput(planOwner, undefined, [['C', ['A']], ['A', []]]));
    const a = activatePlanTask(registry, 'A');
    // Queue time must not be reported as execution time for a failed run without a result.
    a.createdAt = Date.now() - 100000;
    a.startedAt = Date.now() - 1000;
    registry.fail(a, 'Awaria A');
    a.endedAt = a.startedAt + 1000;
    const deliveries = notifier.pending().map(task => buildSubTaskResultDelivery(task, registry, 1));
    t.deepEqual(notifier.pending().map(task => task.id), ['A', 'C']);
    t.deepEqual(deliveries.map(d => (d.meta._subTaskResult as { plan_complete: boolean }).plan_complete), [true, true]);
    t.true(deliveries[0].text.includes('1.0 s'));
    t.true(deliveries[1].text.includes('| C | zablokowane (niepowodzenie: A) |\n| A | awaria |\nPlan zakończony'));
    t.true(deliveries[1].text.includes('zadanie nie zostało uruchomione'));
});
