import test from 'ava';
import { classifyRunEnd } from './index.js';
import type { RunEnd } from './index.js';
import type { AgentLoopStopReason } from '../agent-loop/index.js';

const empty = { completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] } as const;
const reasons: Array<[string, AgentLoopStopReason, RunEnd]> = [
    ['natural', { kind: 'natural' }, { kind: 'finished' }],
    ['iteration-limit', { kind: 'iteration-limit' }, { kind: 'limit', reason: 'iteration-limit' }],
    ['synthesis-budget', { kind: 'synthesis-budget', budgetMs: 1, after: 'iteration-limit' }, { kind: 'limit', reason: 'synthesis-budget' }],
    ['tool-uncertain', { kind: 'tool-uncertain' }, { kind: 'uncertain' }],
    ['manual-stop user', { kind: 'manual-stop' }, { kind: 'stopped', by: 'user' }],
    ['superseded', { kind: 'superseded' }, { kind: 'stopped', by: 'system' }],
    ['task-timeout', { kind: 'task-timeout' }, { kind: 'timeout' }],
    ...(['silence', 'model-timeout', 'transport-error', 'model-error', 'hook-error'] as const).flatMap((kind): Array<[string, AgentLoopStopReason, RunEnd]> => [
        [`${kind} work`, { kind, stage: 'work' }, { kind: 'failed', stage: 'work' }],
        [`${kind} synthesis`, { kind, stage: 'synthesis' }, { kind: 'failed', stage: 'synthesis' }],
    ]),
];
for (const [name, stopReason, end] of reasons) {
    test(`${name} maps to literal outcome`, t => {
        t.deepEqual(classifyRunEnd({ stopReason }), { end, ...empty });
    });
}

for (const by of ['lead', 'system'] as const) {
    test(`manual-stop ${by}`, t => {
        t.deepEqual(classifyRunEnd({ stopReason: { kind: 'manual-stop' }, stoppedByActor: by }), {
            end: { kind: 'stopped', by }, ...empty,
        });
    });
}

test('superseded overrides stop sender', t => {
    t.deepEqual(classifyRunEnd({ stopReason: { kind: 'superseded' }, stoppedByActor: 'lead' }), {
        end: { kind: 'stopped', by: 'system' }, ...empty,
    });
});

test('runner exception is failed work even with error text', t => {
    t.deepEqual(classifyRunEnd({ failed: true, stoppedBy: 'error', finalText: 'error' }), {
        end: { kind: 'failed', stage: 'work' }, ...empty,
    });
});

for (const [stoppedBy, end] of [
    ['natural', { kind: 'finished' }],
    ['backstop', { kind: 'limit', reason: 'iteration-limit' }],
    ['abort', { kind: 'stopped', by: 'user' }],
    ['error', { kind: 'failed', stage: 'work' }],
] as const) {
    test(`legacy ${stoppedBy}`, t => {
        t.deepEqual(classifyRunEnd({ stoppedBy }), { end, ...empty });
    });
}

test('natural end with returned effect is partial', t => {
    const effects = [{ tool: 'write', action: 'replace', targets: [{ kind: 'vault-file' as const, path: 'Notes/a.md' }], outcome: 'returned' as const, check: 'matches' as const }];
    t.deepEqual(classifyRunEnd({ stopReason: { kind: 'natural' }, effects }), {
        end: { kind: 'finished' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects,
    });
});

test('limit with successful read result is partial', t => {
    t.deepEqual(classifyRunEnd({ stopReason: { kind: 'iteration-limit' }, successfulToolResults: 1 }), {
        end: { kind: 'limit', reason: 'iteration-limit' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [],
    });
});

test('no material is empty', t => {
    t.deepEqual(classifyRunEnd({ stopReason: { kind: 'natural' }, finalText: '  ' }), {
        end: { kind: 'finished' }, ...empty,
    });
});

test('natural answer is unconfirmed', (t) => {
    t.deepEqual(classifyRunEnd({ stopReason: { kind: 'natural' }, finalText: 'Done', effects: [] }), {
        end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [],
    });
});

test('limit salvage is not an answer', (t) => {
    t.deepEqual(classifyRunEnd({ stopReason: { kind: 'iteration-limit' }, finalText: 'salvage' }), {
        end: { kind: 'limit', reason: 'iteration-limit' }, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [],
    });
});

test('completed synthesis after limit is partial', (t) => {
    t.deepEqual(classifyRunEnd({ stopReason: { kind: 'iteration-limit' }, finalText: 'Answer', partial: { synthesis: 'completed' } }), {
        end: { kind: 'limit', reason: 'iteration-limit' }, completeness: 'partial', hasAnswer: true, hasMaterial: true, effects: [],
    });
});

test('failed tool calls are not material', (t) => {
    t.deepEqual(classifyRunEnd({ stopReason: { kind: 'natural' }, effects: [{ tool: 'write', action: 'replace', targets: [], outcome: 'error', check: 'not-checked' }], successfulToolResults: 0 }), {
        end: { kind: 'finished' }, completeness: 'empty', hasAnswer: false, hasMaterial: false,
        effects: [{ tool: 'write', action: 'replace', targets: [], outcome: 'error', check: 'not-checked' }],
    });
});
