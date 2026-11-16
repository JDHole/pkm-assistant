import type { App } from 'obsidian';
import { hostWindow } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';
import { AdapterDraftStorage, DRAFT_ROOT, DesktopDraftStorage, DraftPersistence, DraftStore, DraftReview, parseDraftId } from '../vault-drafts/index.js';
import type { DraftStorageIO, DraftHasher, DraftClock, DraftFileSystem, DraftViewIO, DraftReviewIO } from '../vault-drafts/index.js';
import { SubRunDrafts } from '../sub-agents/index.js';
import type { SubTaskRegistry } from '../sub-agents/index.js';
import { createDraftFileIndex } from './draftFileIndex.js';
import { createDraftReviewHost } from './draftReviewHost.js';
import { createSubagentChangesTool } from './SubagentChangesTool.js';

/** Observations of existing boot work only; callbacks must be synchronous and non-throwing. */
export type DraftStartupProgress =
    | { stage: 'presence' }
    | { stage: 'restore'; present: boolean | undefined }
    | { stage: 'cleanup'; present: boolean | undefined; recoveryIssues: number };

/** The same boot entry in production and offline tests. Restore precedes admission. */
export async function initializeVaultDrafts(input: {
    storage: DraftStorageIO; vault: DraftViewIO & DraftReviewIO; hasher: DraftHasher;
    registry: SubTaskRegistry; clock?: DraftClock;
    /** Mobile-only empty namespace probe. Errors must propagate, never mean empty. */
    storagePresent?: () => Promise<boolean>;
    onProgress?: (progress: DraftStartupProgress) => void;
}) {
    const persistence = new DraftPersistence(input.storage, input.hasher);
    const store = new DraftStore(persistence, input.vault, input.clock ?? { now: () => Date.now() }, manifest => {
        const task = input.registry.getTask(manifest.runId);
        const thread = input.registry.getThread(manifest.threadId);
        return !!task && ['waiting', 'running'].includes(task.status) || !!thread && thread.phase !== 'closed';
    });
    input.onProgress?.({ stage: 'presence' });
    const present = input.storagePresent ? await input.storagePresent() : true;
    const observedPresence = input.storagePresent ? present : undefined;
    input.onProgress?.({ stage: 'restore', present: observedPresence });
    const recovered = present ? await store.restore() : { issues: [] };
    input.onProgress?.({ stage: 'cleanup', present: observedPresence, recoveryIssues: recovered.issues.length });
    const drafts = new SubRunDrafts(store, persistence, input.vault, () => parseDraftId(crypto.randomUUID()));
    const registry = input.registry;
    drafts.setRetention(id => {
        const task = registry.getTask(id);
        return !!task?.plan && registry.list().some(other => other.plan?.planId === task.plan?.planId
            && ['waiting', 'running'].includes(other.status));
    }, id => { const thread = registry.getThread(id); return !!thread && thread.phase !== 'closed'; });
    registry.attachDraftStore(store);
    let pending: Promise<void> = Promise.resolve();
    let running = false, requested = false;
    const collect = () => {
        drafts.prune();
        requested = true;
        if (running) return;
        running = true;
        pending = Promise.resolve().then(async () => {
            try {
                while (requested) {
                    requested = false;
                    drafts.prune();
                    try { await store.collectResolved(); }
                    catch (error) { log.warn('VaultDrafts', 'Payload cleanup failed', error); }
                }
            } finally { running = false; }
        });
    };
    const off = ['thread:closed', 'task:finished', 'task:plan', 'draft:changed'].map(event => registry.events.on(event, collect));
    const review = new DraftReview(store, persistence, input.vault);
    if (present) collect();
    await pending;
    return { store, persistence, drafts, review, tool: createSubagentChangesTool(review), issues: recovered.issues, present: observedPresence,
        flush: async () => {
            let observed: Promise<void>;
            do { observed = pending; await observed; } while (observed !== pending);
        }, dispose: () => { for (const unsubscribe of off) unsubscribe(); } };
}

/** Mobile capability boundary; never reads desktop capabilities or falls back to live writes. */
export function mobileDraftPorts(app: App): Pick<Parameters<typeof initializeVaultDrafts>[0], 'storage' | 'vault' | 'hasher' | 'storagePresent'> {
    const adapter = app.vault.adapter;
    const methods = ['list', 'readBinary', 'writeBinary', 'rename', 'remove', 'stat', 'mkdir'] as const;
    if (!adapter || methods.some(name => typeof adapter[name] !== 'function'))
        throw new Error('Adapter draft storage unavailable');
    return {
        storage: new AdapterDraftStorage(adapter),
        storagePresent: async () => (await adapter.stat(DRAFT_ROOT)) !== null,
        vault: { ...createDraftReviewHost(app), index: createDraftFileIndex(app), list: path => adapter.list(path) },
        hasher: { sha256: async bytes => Array.from(new Uint8Array(await hostWindow.crypto.subtle.digest('SHA-256', bytes.slice().buffer)))
            .map(byte => byte.toString(16).padStart(2, '0')).join('') },
    };
}

/** Desktop-only storage capability. The composition root skips this port on mobile. */
export function desktopDraftPorts(app: App): Pick<Parameters<typeof initializeVaultDrafts>[0], 'storage' | 'vault' | 'hasher'> {
    const adapter = app.vault.adapter;
    if (!('getBasePath' in adapter) || typeof adapter.getBasePath !== 'function') throw new Error('Draft storage requires a filesystem vault');
    const win = hostWindow as typeof hostWindow & { require?: (id: string) => unknown };
    const fs = win.require?.('fs');
    const methods = ['mkdirSync', 'lstatSync', 'readdirSync', 'readFileSync', 'openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'linkSync', 'unlinkSync', 'rmdirSync'];
    if (!fs || typeof fs !== 'object' || methods.some(name => !(name in fs) || typeof Reflect.get(fs, name) !== 'function'))
        throw new Error('Atomic draft storage unavailable');
    const getBasePath = adapter.getBasePath as () => unknown; // Function capability checked above.
    const root = getBasePath.call(adapter);
    if (typeof root !== 'string' || !root) throw new Error('Invalid vault root');
    return {
        storage: new DesktopDraftStorage(fs as DraftFileSystem, root), // Capability methods validated above.
        vault: { ...createDraftReviewHost(app), index: createDraftFileIndex(app), list: path => adapter.list(path) },
        hasher: { sha256: async bytes => Array.from(new Uint8Array(await hostWindow.crypto.subtle.digest('SHA-256', bytes.slice().buffer)))
            .map(byte => byte.toString(16).padStart(2, '0')).join('') },
    };
}
