export type StartupPhase = 'layoutWaitMs' | 'runtimeMs' | 'secretsMs' | 'skinMs' | 'agentsMs' | 'toolsMs' | 'finishMs';

/** Sequential boundaries, measured from construction (or the supplied onload timestamp). */
export class StartupTimer {
    private previous: number;
    private readonly durations: Partial<Record<StartupPhase, number>> = {};

    constructor(private readonly now: () => number, startedAt = now()) {
        this.previous = startedAt;
    }

    /** First mark wins. A duplicate changes neither the result nor the next boundary. */
    mark(phase: StartupPhase, at?: number): void {
        if (this.durations[phase] !== undefined) return;
        const end = at ?? this.now();
        this.durations[phase] = Math.max(0, Math.round(end - this.previous));
        this.previous = end;
    }

    snapshot(): Partial<Record<StartupPhase, number>> {
        return { ...this.durations };
    }
}
