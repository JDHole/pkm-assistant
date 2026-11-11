import type { ChatTab } from './chatViewShape.js';
import type { RollingWindow } from './RollingWindow.js';

type SessionIdentity = { id: ChatTab['sessionId']; path: ChatTab['sessionPath']; epoch: ChatTab['sessionEpoch'] };

function sameIdentity(a: SessionIdentity, b: SessionIdentity): boolean {
    return a.id === b.id && a.path === b.path && a.epoch === b.epoch;
}

type AdmissionState =
    | { kind: 'committing'; stop?: () => void }
    | { kind: 'settled' };

/** Only the durable admission, never the subsequent model turn, blocks lifecycle work. */
export class SendAdmission {
    private state: AdmissionState = { kind: 'committing' };
    private resolve!: () => void;
    private readonly publications: Array<{ tab: ChatTab; before: SessionIdentity; after: SessionIdentity }> = [];
    readonly done = new Promise<void>(resolve => { this.resolve = resolve; });

    get pending(): boolean { return this.state.kind === 'committing'; }

    /** Only the send's validated publisher can advance an empty/legacy identity. */
    recordIdentity(tab: ChatTab, before: SessionIdentity, after: SessionIdentity): void {
        this.publications.push({ tab, before: { ...before }, after: { ...after } });
    }

    resolveIdentity(tab: ChatTab, captured: SessionIdentity): SessionIdentity {
        let identity = captured;
        for (const publication of this.publications) {
            if (publication.tab === tab && sameIdentity(identity, publication.before)) identity = publication.after;
        }
        return identity;
    }

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
