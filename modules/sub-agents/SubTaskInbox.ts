import type { ParentQuestion, QuestionId } from './ParentQuestions.js';
import type { SubTaskNotice } from './SubTaskNotifier.js';

/** Run-addressed FIFO. Waiting wakes on events; only take consumes a notice. */
export class SubTaskInbox {
    private readonly queues = new Map<string, SubTaskNotice[]>();
    private readonly waiters = new Map<string, Set<() => void>>();
    private disposed = false;

    constructor(
        private readonly isLive: (parentId: string) => boolean,
        private readonly isQuestionOpen: (taskId: string, id: QuestionId) => boolean,
    ) {}

    push(parentId: string, notice: SubTaskNotice): void {
        if (this.disposed || !this.isLive(parentId)) return;
        const queue = this.queues.get(parentId) ?? [];
        queue.push(notice);
        this.queues.set(parentId, queue);
        this.wake(parentId);
    }

    removeQuestion(question: ParentQuestion): void {
        if (question.recipient.kind !== 'sub') return;
        const parentId = question.recipient.runId;
        const queue = this.queues.get(parentId)?.filter(notice => notice.kind !== 'question' || notice.question.id !== question.id);
        if (queue?.length) this.queues.set(parentId, queue);
        else this.queues.delete(parentId);
    }

    private takeOne(parentId: string): SubTaskNotice | undefined {
        if (this.disposed || !this.isLive(parentId)) { this.close(parentId); return undefined; }
        // Shift before checking: checking a deadline can synchronously remove other entries.
        let queue = this.queues.get(parentId);
        while (queue?.length) {
            const notice = queue.shift()!;
            if (!queue.length) this.queues.delete(parentId);
            if (notice.kind !== 'question' || this.isQuestionOpen(notice.question.taskId, notice.question.id)) return notice;
            queue = this.queues.get(parentId);
        }
        return undefined;
    }

    take(parentId: string): SubTaskNotice[] {
        const notices: SubTaskNotice[] = [];
        let notice: SubTaskNotice | undefined;
        while ((notice = this.takeOne(parentId))) notices.push(notice);
        return notices;
    }

    async wait(parentId: string, signal: AbortSignal): Promise<SubTaskNotice | undefined> {
        while (!this.disposed && !signal.aborted && this.isLive(parentId)) {
            const notice = this.takeOne(parentId);
            if (notice) return notice;
            // Check and registration are synchronous: no event can slip between them.
            await new Promise<void>(resolve => {
                const listeners = this.waiters.get(parentId) ?? new Set<() => void>();
                const wake = () => {
                    listeners.delete(wake);
                    if (!listeners.size) this.waiters.delete(parentId);
                    signal.removeEventListener('abort', wake);
                    resolve();
                };
                listeners.add(wake);
                this.waiters.set(parentId, listeners);
                signal.addEventListener('abort', wake, { once: true });
                if (signal.aborted || this.disposed || !this.isLive(parentId)) wake();
            });
        }
        return undefined;
    }

    private wake(parentId: string): void {
        for (const wake of [...this.waiters.get(parentId) ?? []]) wake();
    }

    close(parentId: string): void {
        this.queues.delete(parentId);
        this.wake(parentId);
    }

    dispose(): void {
        this.disposed = true;
        this.queues.clear();
        for (const parentId of this.waiters.keys()) this.wake(parentId);
    }
}
