import type { ParentQuestionClock } from '../ParentQuestions.js';

export class QuestionTestClock implements ParentQuestionClock {
    time = 0;
    private next = 0;
    private timers = new Map<number, { at: number; fn: () => void }>();
    now(): number { return this.time; }
    setTimeout(fn: () => void, ms: number): number { const id = ++this.next; this.timers.set(id, { at: this.time + ms, fn }); return id; }
    clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
    advance(ms: number, fire = true): void {
        this.time += ms;
        if (!fire) return;
        for (const [id, timer] of [...this.timers]) if (timer.at <= this.time && this.timers.delete(id)) timer.fn();
    }
    get pending(): number { return this.timers.size; }
}
