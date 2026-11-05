import type { SubThreadOwner } from './SubTaskRegistry.js';

export interface Lease { release(): void }
export type AdmissionGroup = Readonly<{ limit: number }>;
export type SubRunActivity = 'queued' | 'working' | 'inactive';
type Entry = { state: 'queued' | 'working'; cancel(): void };
type Lane = { active: number; queue: Array<{ admit(): void; ready(): boolean }> };

/** Conversation FIFO. Enqueue and admission are synchronous; no timers or task statuses. */
export class SubTaskScheduler {
    private readonly lanes = new Map<string, Lane>();
    private readonly runs = new Map<string, Entry>();
    private disposed = false;
    private suspended = 0;
    private readonly groups = new Map<AdmissionGroup, number>();

    acquire(owner: Readonly<SubThreadOwner>, runId: string, signal: AbortSignal, group?: AdmissionGroup): Promise<Lease> {
        if (this.disposed || signal.aborted) return Promise.reject(new Error('Sub-agent admission cancelled'));
        if (this.runs.has(runId)) return Promise.reject(new Error('Sub-agent already owns an admission'));
        // Missing owner never merges unrelated legacy invocations. tabKey is not identity.
        const key = owner.agentName && owner.sessionPath && owner.sessionEpoch
            ? JSON.stringify([owner.agentName, owner.sessionPath, owner.sessionEpoch]) : JSON.stringify([runId]);
        const lane = this.lanes.get(key) ?? { active: 0, queue: [] };
        this.lanes.set(key, lane);
        return new Promise<Lease>((resolve, reject) => {
            const clean = () => {
                signal.removeEventListener('abort', cancel);
                this.runs.delete(runId);
            };
            const cancel = () => {
                if (entry.state !== 'queued') return;
                const index = lane.queue.indexOf(ticket);
                if (index >= 0) lane.queue.splice(index, 1);
                clean();
                reject(new Error('Sub-agent admission cancelled'));
                this.drain(key, lane);
            };
            const entry: Entry = { state: 'queued', cancel };
            const admit = () => {
                entry.state = 'working';
                lane.active++;
                if (group) this.groups.set(group, (this.groups.get(group) ?? 0) + 1);
                // Abort after admission belongs to the worker; only release frees its slot.
                signal.removeEventListener('abort', cancel);
                let released = false;
                resolve({ release: () => {
                    if (released) return;
                    released = true;
                    clean();
                    lane.active--;
                    if (group) {
                        const remaining = (this.groups.get(group) ?? 1) - 1;
                        if (remaining) this.groups.set(group, remaining); else this.groups.delete(group);
                    }
                    for (const [otherKey, otherLane] of this.lanes) this.drain(otherKey, otherLane);
                } });
            };
            const ticket = { admit, ready: () => !group || (this.groups.get(group) ?? 0) < Math.max(1, group.limit) };
            this.runs.set(runId, entry);
            signal.addEventListener('abort', cancel, { once: true });
            lane.queue.push(ticket);
            this.drain(key, lane);
        });
    }

    getActivity(runId: string): SubRunActivity { return this.runs.get(runId)?.state ?? 'inactive'; }

    /** Stop marks and cancels every member before any released slot can be reassigned. */
    transaction<T>(work: () => T): T {
        this.suspended++;
        try { return work(); }
        finally {
            this.suspended--;
            if (!this.suspended) for (const [key, lane] of this.lanes) this.drain(key, lane);
        }
    }

    cancel(runId: string): void { this.runs.get(runId)?.cancel(); }

    private drain(key: string, lane: Lane): void {
        while (!this.disposed && !this.suspended && lane.active < 5 && lane.queue.length && lane.queue[0].ready()) lane.queue.shift()!.admit();
        if (lane.active === 0 && lane.queue.length === 0) this.lanes.delete(key);
    }

    dispose(): void {
        this.disposed = true;
        for (const entry of [...this.runs.values()]) entry.cancel();
    }
}
