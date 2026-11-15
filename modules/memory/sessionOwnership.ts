import { parseFrontmatter } from './activeSessionFormat.js';

/** Device identity is local to one vault on one host, never a vault file. */
declare const deviceIdBrand: unique symbol;
export type DeviceId = string & { readonly [deviceIdBrand]: true };

export function parseDeviceId(value: unknown): DeviceId | null {
    return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value) ? value as DeviceId : null;
}

export type SessionOwnership = 'mine' | 'foreign' | 'unowned' | 'ambiguous';

export type SessionDevice =
    | { kind: 'ambiguous' }
    | { kind: 'marker'; device: unknown; header: string | null };

/** Inspect raw frontmatter before the legacy parser can collapse duplicate keys. */
export function readSessionDevice(content: string): SessionDevice {
    const header = content.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? null;
    if (!header) return /^\uFEFF?---(?:\r?\n|$)/.test(content)
        ? { kind: 'ambiguous' } : { kind: 'marker', device: undefined, header: null };
    const normalized = header.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (/^(?:<{7}|>{7}|\|{7})(?: |$)|^={7}$/m.test(normalized)
        || (normalized.match(/^[ \t]*["']?device["']?[ \t]*:/gm)?.length ?? 0) > 1
        || /^[ \t]+device[ \t]*:|^device[ \t]+:|^["']device["']:/m.test(normalized)) {
        return { kind: 'ambiguous' };
    }
    return { kind: 'marker', device: parseFrontmatter(normalized).device, header };
}

export function ownershipOfSessionDevice(marker: SessionDevice, ownId: DeviceId | null): SessionOwnership {
    if (!ownId) return 'unowned';
    return marker.kind === 'ambiguous' ? 'ambiguous' : sessionOwnership(marker.device, ownId);
}

export function sessionOwnershipFromText(content: string, ownId: DeviceId | null): SessionOwnership {
    return ownId ? ownershipOfSessionDevice(readSessionDevice(content), ownId) : 'unowned';
}

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
