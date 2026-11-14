/** Device identity is local to one vault on one host, never a vault file. */
declare const deviceIdBrand: unique symbol;
export type DeviceId = string & { readonly [deviceIdBrand]: true };

export function parseDeviceId(value: unknown): DeviceId | null {
    return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value) ? value as DeviceId : null;
}

export type SessionOwnership = 'mine' | 'foreign' | 'unowned';

/** An invalid but present field is foreign: never silently adopt another writer's marker. */
export function sessionOwnership(device: unknown, ownId: DeviceId | null): SessionOwnership {
    if (!ownId || device === undefined) return 'unowned';
    return device === ownId ? 'mine' : 'foreign';
}

export class ForeignSessionError extends Error {
    constructor() {
        super('Active session belongs to another device');
        this.name = 'ForeignSessionError';
    }
}
