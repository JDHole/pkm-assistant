import type { SubTask, SubTaskOrigin } from './SubTaskRegistry.js';
import type { StopBy } from './runOutcome.js';
import { log } from '../../core/utils/Logger.js';

export type Owner = Required<Pick<SubTaskOrigin, 'agentName' | 'sessionPath' | 'sessionEpoch'>>;
declare const questionIdBrand: unique symbol;
export type QuestionId = string & { readonly [questionIdBrand]: true };
export type ParentQuestion = Readonly<{ id: QuestionId; taskId: string; subId: string; name: string; text: string; owner: Owner; askedAt: number }>;
export type QuestionClock = { kind: 'ticking'; remainingMs: number; since: number } | { kind: 'paused'; remainingMs: number };
export type QuestionResolution = { kind: 'answered'; text: string } | { kind: 'no-answer' } | { kind: 'cancelled'; by: StopBy; reason: 'stop' | 'unload' | 'run-ended' };
export type QuestionState = { kind: 'none' } | { kind: 'waiting'; question: ParentQuestion; clock: QuestionClock } | { kind: 'closed'; question: ParentQuestion; resolution: QuestionResolution };
export type AnswerResult = { kind: 'accepted' } | { kind: 'rejected'; reason: 'expired' | 'wrong-owner' | 'wrong-question' };
export type RunActivity = { kind: 'working' } | { kind: 'waiting'; questionId: QuestionId } | { kind: 'ending' };
export interface ParentQuestionClock { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
export type OpenParentQuestionResult = { kind: 'opened'; question: ParentQuestion; resolution: Promise<QuestionResolution> } | { kind: 'rejected'; reason: 'already-waiting' | 'unavailable' };
const defaultClock: ParentQuestionClock = { now: () => performance.now(), setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: handle => window.clearTimeout(handle as number) };
const ownerKey = (o: Owner): string => JSON.stringify([o.agentName, o.sessionPath, o.sessionEpoch]);
interface Waiting { task: SubTask; resolve: (value: QuestionResolution) => void; timer?: unknown }

export class ParentQuestions {
    private readonly waiting = new Map<string, Waiting>();
    private readonly channels = new Map<string, Map<object, () => void>>();
    private sequence = 0;
    private disposed = false;
    private readonly prefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    constructor(private readonly notify: (event: string, payload: unknown) => void, private readonly clock: ParentQuestionClock = defaultClock) {}
    private emit(event: string, payload: unknown): void { try { this.notify(event, payload); } catch (e) { log.warn('ParentQuestions', 'observer failed:', e); } }
    open(task: SubTask, text: string): OpenParentQuestionResult {
        const origin = task.origin;
        if (this.disposed || task.status !== 'running' || task.stopRequested || !origin?.agentName || !origin.sessionPath || !origin.sessionEpoch || !task.threadId || !text.trim()) return { kind: 'rejected', reason: 'unavailable' };
        this.check(task);
        if (this.waiting.has(task.id)) return { kind: 'rejected', reason: 'already-waiting' };
        // A timeout is terminal for this run, even before the runner finishes it.
        if (task.questionState?.kind === 'closed' && task.questionState.resolution.kind !== 'answered') return { kind: 'rejected', reason: 'unavailable' };
        const owner: Owner = { agentName: origin.agentName, sessionPath: origin.sessionPath, sessionEpoch: origin.sessionEpoch };
        const question: ParentQuestion = Object.freeze({ id: `${this.prefix}-${++this.sequence}` as QuestionId, taskId: task.id, subId: task.threadId, name: task.name, text, owner: Object.freeze(owner), askedAt: Date.now() });
        let resolve!: (value: QuestionResolution) => void;
        const resolution = new Promise<QuestionResolution>(r => { resolve = r; });
        const entry: Waiting = { task, resolve };
        const paused = (this.channels.get(ownerKey(owner))?.size ?? 0) > 0;
        task.questionState = { kind: 'waiting', question, clock: paused ? { kind: 'paused', remainingMs: 300000 } : { kind: 'ticking', remainingMs: 300000, since: this.clock.now() } };
        this.waiting.set(task.id, entry);
        if (!paused) this.arm(entry, 300000);
        this.emit('question:opened', question);
        return { kind: 'opened', question, resolution };
    }
    private arm(entry: Waiting, ms: number): void {
        entry.timer = this.clock.setTimeout(() => {
            entry.timer = undefined;
            const state = this.check(entry.task);
            if (state.kind === 'waiting' && state.clock.kind === 'ticking' && this.waiting.get(entry.task.id) === entry) {
                this.arm(entry, state.clock.remainingMs);
            }
        }, ms);
    }
    private clear(entry: Waiting): void { if (entry.timer !== undefined) { this.clock.clearTimeout(entry.timer); entry.timer = undefined; } }
    check(task: SubTask): QuestionState {
        const state = task.questionState ?? { kind: 'none' };
        if (state.kind === 'waiting' && state.clock.kind === 'ticking') {
            const remainingMs = Math.max(0, state.clock.remainingMs - Math.max(0, this.clock.now() - state.clock.since));
            if (remainingMs === 0) { this.close(task, { kind: 'no-answer' }, false); return task.questionState ?? { kind: 'none' }; }
            return { ...state, clock: { kind: 'ticking', remainingMs, since: this.clock.now() } };
        }
        return state;
    }
    close(task: SubTask, resolution: QuestionResolution, checkDeadline = true): boolean {
        if (checkDeadline && this.check(task).kind !== 'waiting') return false;
        const entry = this.waiting.get(task.id); const state = task.questionState;
        if (!entry || state?.kind !== 'waiting') return false;
        this.waiting.delete(task.id); this.clear(entry);
        task.questionState = { kind: 'closed', question: state.question, resolution };
        this.emit('question:closed', state.question);
        entry.resolve(resolution);
        return true;
    }
    answer(task: SubTask | undefined, id: QuestionId, owner: Owner, text: string): AnswerResult {
        if (!task) return { kind: 'rejected', reason: 'expired' };
        const state = this.check(task);
        if (state.kind !== 'waiting') return { kind: 'rejected', reason: 'expired' };
        if (state.question.id !== id) return { kind: 'rejected', reason: 'wrong-question' };
        if (ownerKey(state.question.owner) !== ownerKey(owner)) return { kind: 'rejected', reason: 'wrong-owner' };
        return this.close(task, { kind: 'answered', text }) ? { kind: 'accepted' } : { kind: 'rejected', reason: 'expired' };
    }
    registerUserWait(owner: Owner, cancel: () => void): () => void {
        const key = ownerKey(owner); const token = {}; const channels = this.channels.get(key) ?? new Map<object, () => void>();
        const first = channels.size === 0; channels.set(token, cancel); this.channels.set(key, channels);
        if (first) for (const entry of [...this.waiting.values()]) {
            const state = this.check(entry.task);
            if (state.kind !== 'waiting' || ownerKey(state.question.owner) !== key || state.clock.kind !== 'ticking') continue;
            this.clear(entry); entry.task.questionState = { ...state, clock: { kind: 'paused', remainingMs: state.clock.remainingMs } };
        }
        let active = true;
        return () => {
            if (!active) return; active = false; channels.delete(token);
            if (channels.size) return; this.channels.delete(key);
            for (const entry of [...this.waiting.values()]) {
                const state = entry.task.questionState;
                if (state?.kind !== 'waiting' || ownerKey(state.question.owner) !== key || state.clock.kind !== 'paused') continue;
                entry.task.questionState = { ...state, clock: { kind: 'ticking', remainingMs: state.clock.remainingMs, since: this.clock.now() } };
                this.arm(entry, state.clock.remainingMs);
            }
        };
    }
    dispose(): void {
        this.disposed = true;
        for (const entry of [...this.waiting.values()]) this.close(entry.task, { kind: 'cancelled', by: 'system', reason: 'unload' });
        const callbacks = [...this.channels.values()].flatMap(channels => [...channels.values()]);
        this.channels.clear();
        for (const cancel of callbacks) { try { cancel(); } catch (e) { log.warn('ParentQuestions', 'channel cancellation failed:', e); } }
    }
}
