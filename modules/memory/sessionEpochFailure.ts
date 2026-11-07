import { Validator } from '@cfworker/json-schema';
import { maskSensitiveData, normalizeError } from '../../core/index.js';
import { t } from '../../core/i18n/index.js';

export type SessionEpochFailure =
    | { kind: 'append-unavailable' }
    | { kind: 'read-failed'; detail: string }
    | { kind: 'append-failed'; detail: string }
    | { kind: 'readback-failed'; detail: string }
    | { kind: 'verification-failed' };

const validator = new Validator({ oneOf: [
    { type: 'object', required: ['kind'], additionalProperties: false,
        properties: { kind: { enum: ['append-unavailable', 'verification-failed'] } } },
    { type: 'object', required: ['kind', 'detail'], additionalProperties: false,
        properties: { kind: { enum: ['read-failed', 'append-failed', 'readback-failed'] }, detail: { type: 'string' } } },
] });

/** Tool context is an unknown boundary; retain a masked, immutable copy only. */
export function parseSessionEpochFailure(value: unknown): Readonly<SessionEpochFailure> | null {
    // The schema library throws for non-JSON values (including undefined).
    try { if (!validator.validate(value).valid) return null; }
    catch { return null; }
    const failure = value as SessionEpochFailure; // Complete union validated above.
    return Object.freeze('detail' in failure
        ? { kind: failure.kind, detail: maskSensitiveData(failure.detail) } : { kind: failure.kind });
}

export class SessionEpochPersistenceError extends Error {
    readonly failure: Readonly<SessionEpochFailure>;
    constructor(failure: SessionEpochFailure) {
        const masked = parseSessionEpochFailure(failure)!;
        super('detail' in masked ? masked.detail : `Session epoch: ${masked.kind}`);
        this.name = 'SessionEpochPersistenceError';
        this.failure = masked;
    }
}

/** Wrap only the I/O stage, never owner or identity validation. */
export async function persistSessionEpoch<T>(kind: 'read-failed' | 'append-failed' | 'readback-failed', io: () => Promise<T>): Promise<T> {
    try { return await io(); }
    catch (error: unknown) {
        throw new SessionEpochPersistenceError({ kind, detail: normalizeError(error).message });
    }
}

export function sessionEpochFailureReason(failure: Readonly<SessionEpochFailure>): string {
    switch (failure.kind) {
        case 'append-unavailable': return t('memory.epoch.append_unavailable');
        case 'read-failed': return t('memory.epoch.read_failed', { detail: failure.detail });
        case 'append-failed': return t('memory.epoch.append_failed', { detail: failure.detail });
        case 'readback-failed': return t('memory.epoch.readback_failed', { detail: failure.detail });
        case 'verification-failed': return t('memory.epoch.verification_failed');
        default: { const exhaustive: never = failure; throw new Error(String(exhaustive)); }
    }
}
