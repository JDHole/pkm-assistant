import type { RollingWindow } from './RollingWindow.js';

type AdmissionState =
    | { kind: 'committing'; stop?: () => void }
    | { kind: 'settled' };

/** Only the durable admission, never the subsequent model turn, blocks lifecycle work. */
export class SendAdmission {
    private state: AdmissionState = { kind: 'committing' };
    private resolve!: () => void;
    readonly done = new Promise<void>(resolve => { this.resolve = resolve; });

    get pending(): boolean { return this.state.kind === 'committing'; }

    deferStop(stop: () => void): boolean {
        if (this.state.kind !== 'committing') return false;
        this.state.stop ??= stop;
        return true;
    }

    finish(): void {
        if (this.state.kind === 'settled') return;
        const stop = this.state.stop;
        this.state = { kind: 'settled' };
        try { stop?.(); } finally { this.resolve(); }
    }
}

const admissions = new WeakMap<RollingWindow, SendAdmission>();

export function beginSendAdmission(window: RollingWindow): SendAdmission {
    const admission = new SendAdmission();
    admissions.set(window, admission);
    return admission;
}

export function sendAdmission(window: RollingWindow | undefined | null): SendAdmission | undefined {
    const admission = window ? admissions.get(window) : undefined;
    return admission?.pending ? admission : undefined;
}

export class SendIdentityConflictError extends Error {
    readonly kind = 'identity-conflict';
    constructor() { super('Session identity conflict'); }
}
