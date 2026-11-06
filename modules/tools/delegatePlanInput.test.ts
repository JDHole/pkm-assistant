import test from 'ava';
import { parseDelegatePlan } from './delegatePlanInput.js';

test('plan: A/B → C accepts C first and preserves dependency and input order', t => {
    const input = Object.freeze({ tasks: Object.freeze([
        Object.freeze({ id: 'C', depends_on: Object.freeze(['B', 'A']), task: 'Compare', aspect: 'worker',
            context: 'Manual context', context_mode: 'parent_conversation', timeout_ms: 1000 }),
        Object.freeze({ id: 'A', task: 'Arguments' }), Object.freeze({ id: 'B', task: 'Risks', depends_on: Object.freeze([]) }),
    ]) });
    t.deepEqual(parseDelegatePlan(input, 3), { kind: 'plan', graph: [
        { nodeId: 'C', dependsOn: ['B', 'A'] }, { nodeId: 'A', dependsOn: [] }, { nodeId: 'B', dependsOn: [] },
    ] });
    t.deepEqual(input.tasks[0], { id: 'C', depends_on: ['B', 'A'], task: 'Compare', aspect: 'worker',
        context: 'Manual context', context_mode: 'parent_conversation', timeout_ms: 1000 });
});

const invalidGraphs = [
    { name: 'missing id also on an independent root', tasks: [
        { id: 'A', depends_on: ['B'] }, { id: 'B' }, { task: 'Independent' },
    ], error: 'tasks[2].id: required when the plan has dependencies.' },
    { name: 'duplicate id', tasks: [{ id: 'A', depends_on: ['B'] }, { id: 'B' }, { id: 'A' }],
        error: 'tasks[2].id: duplicate id "A".' },
    { name: 'unknown reference', tasks: [{ id: 'A' }, { id: 'C', depends_on: ['B'] }],
        error: 'tasks[1].depends_on: unknown id "B".' },
    { name: 'self edge', tasks: [{ id: 'A', depends_on: ['A'] }],
        error: 'tasks[0].depends_on[0]: task "A" cannot depend on itself.' },
    { name: 'cycle of several nodes reports the path', tasks: [
        { id: 'A', depends_on: ['C'] }, { id: 'B', depends_on: ['A'] }, { id: 'C', depends_on: ['B'] },
    ], error: 'Cycle: A → C → B → A.' },
    { name: 'cycle in a disconnected branch excludes its noncyclic prefix', tasks: [
        { id: 'Root' }, { id: 'D', depends_on: ['A'] },
        { id: 'A', depends_on: ['B'] }, { id: 'B', depends_on: ['A'] },
    ], error: 'Cycle: A → B → A.' },
    { name: 'duplicate dependency', tasks: [{ id: 'A' }, { id: 'B', depends_on: ['A', 'A'] }],
        error: 'tasks[1].depends_on[1]: duplicate dependency "A".' },
    { name: 'case-sensitive reference', tasks: [{ id: 'A' }, { id: 'B', depends_on: ['a'] }],
        error: 'tasks[1].depends_on: unknown id "a".' },
    { name: 'invalid id characters', tasks: [{ id: 'bad id' }, { id: 'B', depends_on: ['bad id'] }],
        error: 'tasks[0].id: expected 1–64 characters matching [A-Za-z0-9_-]+.' },
    { name: 'empty id', tasks: [{ id: '' }, { id: 'B', depends_on: ['A'] }],
        error: 'tasks[0].id: expected 1–64 characters matching [A-Za-z0-9_-]+.' },
    { name: 'id beyond 64 characters', tasks: [{ id: 'A'.repeat(65), depends_on: [] }],
        error: 'tasks[0].id: expected 1–64 characters matching [A-Za-z0-9_-]+.' },
    { name: 'invalid dependency characters', tasks: [{ id: 'A', depends_on: ['bad id'] }],
        error: 'tasks[0].depends_on[0]: expected 1–64 characters matching [A-Za-z0-9_-]+.' },
];
for (const scenario of invalidGraphs) {
    test(`plan rejects ${scenario.name}`, t => {
        t.deepEqual(parseDelegatePlan({ tasks: scenario.tasks }, 5), { kind: 'invalid', error: scenario.error });
    });
}

test('plan limit counts all nodes, not wave width; exact configured limit is accepted', t => {
    const input = { tasks: [{ id: 'A' }, { id: 'B', depends_on: ['A'] }, { id: 'C', depends_on: ['B'] }] };
    t.deepEqual(parseDelegatePlan(input, 2), { kind: 'invalid', error: 'tasks: 3 tasks exceed the configured limit 2.' });
    t.deepEqual(parseDelegatePlan(input, 3), { kind: 'plan', graph: [
        { nodeId: 'A', dependsOn: [] }, { nodeId: 'B', dependsOn: ['A'] }, { nodeId: 'C', dependsOn: ['B'] },
    ] });
});

test('single task, ordinary lists and explicit empty dependencies use legacy', t => {
    for (const input of [
        { task: 'Single', context_mode: 'parent_conversation' },
        { tasks: [{ task: 'One' }, { task: 'Two' }] },
        { tasks: [{ task: 'One', depends_on: [] }, { task: 'Two', id: 'B', depends_on: [] }] },
        { tasks: [] },
    ]) t.deepEqual(parseDelegatePlan(input, 5), { kind: 'legacy' });
    t.deepEqual(parseDelegatePlan({ tasks: [{ task: 'One' }, { task: 'Two' }] }, 1),
        { kind: 'invalid', error: 'tasks: 2 tasks exceed the configured limit 1.' });
});

test('plan accepts distinct case-sensitive IDs, maximum length and object property names', t => {
    const longId = 'A'.repeat(64);
    t.deepEqual(parseDelegatePlan({ tasks: [
        { id: longId, depends_on: ['__proto__', 'constructor', 'a'] },
        { id: '__proto__' }, { id: 'constructor' }, { id: 'a' }, { id: 'A' },
    ] }, 5), { kind: 'plan', graph: [
        { nodeId: longId, dependsOn: ['__proto__', 'constructor', 'a'] },
        { nodeId: '__proto__', dependsOn: [] }, { nodeId: 'constructor', dependsOn: [] },
        { nodeId: 'a', dependsOn: [] }, { nodeId: 'A', dependsOn: [] },
    ] });
});

test('plan rejects an invalid configured limit', t => {
    for (const limit of [0, -1, 1.5, NaN, Infinity]) {
        t.deepEqual(parseDelegatePlan({ tasks: [{ id: 'A' }] }, limit),
            { kind: 'invalid', error: 'maxTasks: expected a positive integer.' });
    }
});

test('plan graph is detached from subsequent changes to model arguments', t => {
    const input = { tasks: [{ id: 'B', depends_on: ['A'] }, { id: 'A', depends_on: [] }] };
    const result = parseDelegatePlan(input, 5);
    input.tasks[0].id = 'Changed';
    input.tasks[0].depends_on.push('Changed');
    t.deepEqual(result, { kind: 'plan', graph: [{ nodeId: 'B', dependsOn: ['A'] }, { nodeId: 'A', dependsOn: [] }] });
});

const malformedInputs = [
    { name: 'null input', input: null, error: '#: Instance type "null" is invalid. Expected "object".' },
    { name: 'array input', input: [], error: '#: Instance type "array" is invalid. Expected "object".' },
    { name: 'null tasks', input: { tasks: null }, error: '#/tasks: Instance type "null" is invalid. Expected "array".' },
    { name: 'null task', input: { tasks: [null] }, error: '#/tasks/0: Instance type "null" is invalid. Expected "object".' },
    { name: 'numeric id', input: { tasks: [{ id: 5 }] }, error: '#/tasks/0/id: Instance type "number" is invalid. Expected "string".' },
    { name: 'null dependencies', input: { tasks: [{ id: 'A', depends_on: null }] },
        error: '#/tasks/0/depends_on: Instance type "null" is invalid. Expected "array".' },
    { name: 'string dependencies', input: { tasks: [{ id: 'A', depends_on: 'B' }] },
        error: '#/tasks/0/depends_on: Instance type "string" is invalid. Expected "array".' },
    { name: 'numeric dependency', input: { tasks: [{ id: 'A', depends_on: [42] }] },
        error: '#/tasks/0/depends_on/0: Instance type "number" is invalid. Expected "string".' },
];
for (const scenario of malformedInputs) {
    test(`plan schema rejects ${scenario.name} with the exact field path`, t => {
        t.deepEqual(parseDelegatePlan(scenario.input, 5), { kind: 'invalid', error: scenario.error });
    });
}
