/** Durable data only: no transcript, leases, callbacks or executable configuration. */
import { Validator } from '@cfworker/json-schema';
import type { Schema } from '@cfworker/json-schema';
import { maskSensitiveData } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';
import type { Owner, ParentQuestion, QuestionId, QuestionResolution } from './ParentQuestions.js';
import type { ParentConversationMetadata } from './ParentConversationBudget.js';
import type { RunOutcome } from './runOutcome.js';
import type { SubTask, SubTaskRegistry, SubThread } from './SubTaskRegistry.js';

export interface SubTaskHistoryRecord {
    parentConversation?: ParentConversationMetadata;
    version: 1;
    runId: string;
    threadId: string;
    name: string;
    owner: Owner;
    parentId?: string;
    level: number;
    state: 'queued' | SubTask['status'];
    createdAt: number;
    endedAt?: number;
    taskPreview?: string;
    material?: string;
    error?: string;
    outcome?: RunOutcome;
    question?: { id: string; text: string; askedAt: number; resolution?: QuestionResolution };
}
const string: Schema = { type: 'string' };
const id: Schema = { type: 'string', minLength: 1 };
const time: Schema = { type: 'number', minimum: 0 };
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema =>
    ({ type: 'object', properties, required, additionalProperties: false });
const choice = (...values: string[]): Schema => ({ enum: values });
const resolution: Schema = { oneOf: [
    object({ kind: { const: 'answered' }, text: string }),
    object({ kind: { const: 'no-answer' } }),
    object({ kind: { const: 'cancelled' }, by: choice('user', 'lead', 'system'), reason: choice('stop', 'unload', 'run-ended') }),
] };
const outcome: Schema = object({
    end: { oneOf: [
        object({ kind: choice('finished', 'uncertain', 'timeout') }),
        object({ kind: { const: 'limit' }, reason: choice('iteration-limit', 'synthesis-budget') }),
        object({ kind: { const: 'stopped' }, by: choice('user', 'lead', 'system') }),
        object({ kind: { const: 'failed' }, stage: choice('work', 'synthesis') }),
    ] },
    completeness: choice('unconfirmed', 'partial', 'empty'), hasAnswer: { type: 'boolean' }, hasMaterial: { type: 'boolean' },
    effects: { type: 'array', items: object({
        tool: string, action: string, targets: { type: 'array', items: object({ path: string, id: string, kind: choice('vault-file', 'vault-folder', 'memory-file', 'message', 'todo-list') }, ['kind']) },
        outcome: choice('pending', 'returned', 'error', 'unknown'), check: choice('matches', 'mismatch', 'not-checked'),
        cause: choice('natural', 'iteration-limit', 'synthesis-budget', 'tool-uncertain', 'manual-stop', 'superseded', 'task-timeout', 'silence', 'model-timeout', 'transport-error', 'model-error', 'hook-error'),
    }, ['tool', 'action', 'targets', 'outcome', 'check']) },
});
const sourceFields = { mode: { const: 'parent_conversation' }, source: choice('lead', 'sub'),
    sourceId: { anyOf: [id, { type: 'integer', minimum: 0 }] } } satisfies Record<string, Schema>;
const parentConversation: Schema = { oneOf: [
    object({ ...sourceFields, status: { const: 'pending' } }),
    object({ ...sourceFields, status: choice('included', 'omitted'), truncated: { type: 'boolean' },
        keptMessages: time, summarizedMessages: time, omittedMessages: time, estimatedTokens: time,
        inputTokens: time, maxOutputTokens: time, marginTokens: time,
        window: object({ tokens: { type: 'number', minimum: 1 }, estimated: { type: 'boolean' }, source: choice('override', 'catalog', 'fallback') }), note: string,
    }, [...Object.keys(sourceFields), 'status', 'truncated', 'keptMessages', 'summarizedMessages', 'omittedMessages',
        'estimatedTokens', 'inputTokens', 'maxOutputTokens', 'marginTokens', 'window']),
] };
const validator = new Validator(object({
    version: { const: 1 }, runId: id, threadId: id, name: id,
    owner: object({ agentName: id, sessionPath: id, sessionEpoch: { type: 'string', pattern: '^[0-9a-f]{32}$' } }),
    parentId: id, level: { type: 'integer', minimum: 1, maximum: 3 },
    state: choice('queued', 'running', 'done', 'error', 'aborted'), createdAt: time, endedAt: time,
    taskPreview: string, material: string, error: string, outcome, parentConversation,
    question: object({ id, text: string, askedAt: time, resolution }, ['id', 'text', 'askedAt']),
}, ['version', 'runId', 'threadId', 'name', 'owner', 'level', 'state', 'createdAt']));

export function parseSubTaskHistoryRecord(value: unknown): SubTaskHistoryRecord | undefined {
    if (!validator.validate(value).valid) return undefined;
    const record = value as SubTaskHistoryRecord; // schema validates the entire persisted boundary
    if ((record.parentId === undefined) !== (record.level === 1)
        || record.parentId === record.runId || (record.endedAt !== undefined && record.endedAt < record.createdAt)) return undefined;
    return structuredClone(record);
}
const ownerKey = (owner: Owner): string => JSON.stringify([owner.agentName, owner.sessionPath, owner.sessionEpoch]);

/** Snapshot at emission, append in emission order. An I/O failure cannot stop a run or later writes. */
export class SubTaskHistory {
    private pending: Promise<void> = Promise.resolve();
    private readonly unsubscribe: Array<() => void> = [];
    constructor(registry: SubTaskRegistry, append: (record: SubTaskHistoryRecord) => Promise<unknown>) {
        const save = (input: unknown) => {
            const record = parseSubTaskHistoryRecord(JSON.parse(JSON.stringify(input)));
            if (!record) return; // Legacy calls without a full frozen owner do not acquire persistence rights.
            this.pending = this.pending.then(() => append(record)).then(() => {}, error => {
                log.warn('SubTaskHistory', 'Session history append failed:', error);
            });
        };
        const taskRecord = (task: SubTask) => {
            const state = task.questionState;
            const question = state && state.kind !== 'none' ? {
                id: state.question.id, text: maskSensitiveData(state.question.text), askedAt: state.question.askedAt,
                ...(state.kind === 'closed' ? { resolution: state.resolution.kind === 'answered' ? { ...state.resolution, text: maskSensitiveData(state.resolution.text) } : state.resolution } : {}),
            } : undefined;
            save({ version: 1, runId: task.id, threadId: task.threadId ?? task.id, name: task.name,
                owner: task.origin && { agentName: task.origin.agentName, sessionPath: task.origin.sessionPath, sessionEpoch: task.origin.sessionEpoch },
                parentId: task.parentId, level: task.level ?? 1, state: task.status, createdAt: task.createdAt, endedAt: task.endedAt,
                taskPreview: task.taskPreview, material: maskSensitiveData(task.result?.handoff || task.result?.text || task.partial?.text || ''),
                error: task.error, outcome: task.outcome, question, parentConversation: task.parentConversation,
            });
        };
        for (const event of ['task:created', 'task:partial', 'task:finished', 'task:context']) {
            this.unsubscribe.push(registry.events.on(event, value => {
                const task = value as SubTask;
                if (event === 'task:finished' || task.status === 'running') taskRecord(task);
            }));
        }
        for (const event of ['question:opened', 'question:closed']) {
            this.unsubscribe.push(registry.events.on(event, value => {
                const task = registry.getTask((value as ParentQuestion).taskId);
                if (task?.status === 'running') taskRecord(task);
            }));
        }
        for (const event of ['thread:created', 'thread:queued']) {
            this.unsubscribe.push(registry.events.on(event, value => {
                const thread = value as SubThread;
                if (thread.phase !== 'queued') return;
                save({ version: 1, runId: thread.queuedRunId ?? thread.threadId, threadId: thread.threadId, name: thread.name,
                    owner: { agentName: thread.owner.agentName, sessionPath: thread.owner.sessionPath, sessionEpoch: thread.owner.sessionEpoch },
                    parentId: thread.parentId, level: thread.level ?? 1, state: 'queued', createdAt: thread.lastActiveAt, parentConversation: thread.parentConversation });
            }));
        }
    }
    flush(): Promise<void> { return this.pending; }
    dispose(): void { for (const off of this.unsubscribe.splice(0)) off(); }
}

/** Validate the whole graph before importing; input order need not be parent-first. */
export function restoreSubTaskHistory(input: readonly unknown[], owner: Owner): Array<SubTask & { threadId: string; endedAt: number }> {
    const records = new Map<string, SubTaskHistoryRecord>();
    const invalid = new Set<string>();
    const identity = (r: SubTaskHistoryRecord) => JSON.stringify([r.threadId, r.name, r.parentId, r.level]);
    const rank = (r: SubTaskHistoryRecord) => r.state === 'queued' ? 0 : r.state === 'running' ? 1 : 2;
    for (const value of input) {
        const record = parseSubTaskHistoryRecord(value);
        if (!record || ownerKey(record.owner) !== ownerKey(owner)) continue;
        const old = records.get(record.runId);
        if (old && identity(old) !== identity(record)) invalid.add(record.runId);
        if (!old || rank(record) >= rank(old)) records.set(record.runId, record);
    }
    const valid = (record: SubTaskHistoryRecord): boolean => {
        if (invalid.has(record.runId)) return false;
        if (!record.parentId) return record.level === 1;
        const parent = records.get(record.parentId);
        return !!parent && parent.level === record.level - 1 && valid(parent);
    };
    return [...records.values()].filter(valid).sort((a, b) => a.createdAt - b.createdAt).map(record => {
        const interrupted = record.state === 'queued' || record.state === 'running';
        const hasMaterial = !!record.material || !!record.outcome?.hasMaterial;
        const task: SubTask & { threadId: string; endedAt: number } = {
            id: record.runId, threadId: record.threadId, name: record.name, agentName: owner.agentName,
            origin: { ...owner }, parentId: record.parentId, level: record.level,
            status: interrupted ? 'aborted' : record.state as SubTask['status'], createdAt: record.createdAt,
            endedAt: record.endedAt ?? record.createdAt, steps: [], budget: {}, taskPreview: record.taskPreview,
            error: interrupted ? 'Sub-agent interrupted by restart' : record.error,
            outcome: interrupted ? { end: { kind: 'stopped', by: 'system' }, completeness: hasMaterial ? 'partial' : 'empty',
                hasAnswer: false, hasMaterial, effects: record.outcome?.effects ?? [] } : record.outcome,
            questionState: { kind: 'none' }, interruptedByRestart: interrupted,
            ...(record.parentConversation ? { parentConversation: record.parentConversation } : {}),
        };
        if (record.material !== undefined) task.result = { text: record.material, toolsUsed: [], durationMs: 0, usage: null, ...(record.parentConversation ? { parentConversation: record.parentConversation } : {}) };
        if (record.question) task.questionState = { kind: 'closed', question: {
            id: record.question.id as QuestionId, taskId: record.runId, subId: record.threadId, name: record.name,
            text: record.question.text, askedAt: record.question.askedAt, owner: { ...owner },
            recipient: record.parentId ? { kind: 'sub', runId: record.parentId } : { kind: 'lead' },
        }, resolution: record.question.resolution ?? { kind: 'cancelled', by: 'system', reason: 'run-ended' } };
        return task;
    });
}
