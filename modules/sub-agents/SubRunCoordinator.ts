import type { SubTaskRegistry, SubTask } from './SubTaskRegistry.js';
import type { RunActivity, QuestionId } from './ParentQuestions.js';
import type { SubTaskNotice } from './SubTaskNotifier.js';

/** Runner work lease; FIFO resume preserves the run identity and admission group. */
export interface RunAdmission { release(): void; resume(): Promise<void> }

/** One runner, one model loop. Sleeps only at batch-safe boundaries. */
export class SubRunCoordinator {
    private activeTools = 0;
    private waitingQuestions = new Set<QuestionId>();
    private resuming?: Promise<void>;
    private closed = false;
    private working = true;

    constructor(
        private readonly registry: SubTaskRegistry,
        private readonly task: SubTask,
        private readonly signal: AbortSignal,
        private readonly activity: (value: RunActivity) => void,
        private readonly deliver: (notices: SubTaskNotice[]) => void,
        private readonly admission?: RunAdmission,
    ) {}

    startBatch(count: number): void { this.activeTools = count; }
    toolDone(): void { this.activeTools--; this.sleepIfIdle(); }
    private sleepIfIdle(): void {
        if (this.closed || this.activeTools !== 0 || !this.waitingQuestions.size) return;
        this.working = false;
        const [questionId] = this.waitingQuestions;
        this.activity({ kind: 'waiting', questionId });
        this.admission?.release();
    }
    async question<T>(id: QuestionId, resolution: Promise<T>): Promise<T> {
        this.activeTools--;
        this.waitingQuestions.add(id);
        this.sleepIfIdle();
        try {
            const result = await resolution;
            if (!this.working) await this.resume();
            return result;
        } finally {
            this.waitingQuestions.delete(id);
            this.activeTools++;
        }
    }
    private async resume(): Promise<void> {
        if (this.closed || this.signal.aborted) return;
        if (!this.resuming) {
            this.resuming = (async () => {
                try { await this.admission?.resume(); }
                catch (error) { if (!this.signal.aborted && !this.closed) throw error; }
                if (!this.closed && !this.signal.aborted) { this.working = true; this.activity({ kind: 'working' }); }
            })().finally(() => { this.resuming = undefined; });
        }
        await this.resuming;
    }
    private children(): string[] {
        const ids = this.registry.list().filter(child => child.parentId === this.task.id && child.status === 'running').map(child => child.id);
        for (const thread of this.registry.listThreads(this.task.origin ?? { agentName: this.task.agentName })) {
            if (thread.parentId === this.task.id && thread.phase === 'queued') ids.push(thread.queuedRunId ?? thread.threadId);
        }
        return ids;
    }
    async iterationStart(): Promise<void> {
        if (!this.working) await this.resume();
        if (!this.closed && !this.signal.aborted) this.deliver(this.registry.takeChildNotices(this.task.id));
    }
    async beforeFinish(): Promise<'finish' | 'continue'> {
        const notices = this.registry.takeChildNotices(this.task.id);
        if (!notices.length && this.children().length && !this.signal.aborted) {
            this.working = false;
            this.activity({ kind: 'waiting-children' });
            this.admission?.release();
            const notice = await this.registry.waitChildNotice(this.task.id, this.signal);
            if (notice) notices.push(notice);
        }
        if (!notices.length) return 'finish';
        if (!this.working) {
            this.activity({ kind: 'queued' });
            await this.resume();
        }
        if (!this.closed && !this.signal.aborted) this.deliver([...notices, ...this.registry.takeChildNotices(this.task.id)]
            .filter(notice => notice.kind === 'result' || this.registry.isQuestionOpen(notice.question.taskId, notice.question.id)));
        return 'continue';
    }
    stopChildren(): void {
        for (const id of this.children()) this.registry.requestStop(id, 'system');
    }
    close(): void { this.closed = true; this.stopChildren(); }
}
