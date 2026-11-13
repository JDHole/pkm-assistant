import type { ChatTab, ChatViewLike } from './chatViewShape.js';
import { _tabKey } from './chat_tabs.js';
import { sendAdmission } from './sendAdmission.js';
import { resolveOwnerMemory } from './turnOwner.js';
import { isSessionViewAlive } from '../sessionViewLifecycle.js';

type LifecycleOperation = 'close' | 'new' | 'restore' | `load:${string}`;

/** One queue per captured conversation. Dialogs release the queue while awaiting a choice. */
export interface SessionLifecycleOwner {
    tab: ChatTab | undefined;
    window: ChatViewLike['rollingWindow'];
    memory: ReturnType<typeof resolveOwnerMemory>;
    agentName: string | undefined;
    path: string | undefined;
    epoch: string | null;
    id: string | undefined;
    ready: Promise<void>;
    tail: Promise<void>;
    requests: Map<LifecycleOperation, Promise<void>>;
    current(): boolean;
    adoptSavedIdentity(path: string, epoch: string | null): boolean;
}

const owners = new WeakMap<ChatViewLike['rollingWindow'], SessionLifecycleOwner>();

export function captureSessionLifecycle(view: ChatViewLike): SessionLifecycleOwner {
    const window = view.rollingWindow;
    const previous = owners.get(window);
    if (previous?.requests.size && previous.current()) return previous;
    const tab = view.chatTabs?.find(tab => tab.isActive);
    const manager = view.plugin?.agentManager;
    const memory = manager?.getActiveMemory?.() ?? resolveOwnerMemory(manager, tab?.agentName);
    const admission = sendAdmission(window);
    let capturedIdentity = { id: tab?.sessionId, path: tab?.sessionPath, epoch: tab?.sessionEpoch };
    const owner: SessionLifecycleOwner = {
        tab, window, memory, agentName: tab?.agentName ?? memory?.agentName ?? manager?.getActiveAgent?.()?.name,
        path: tab ? tab.sessionPath : memory?.activeSessionPath ?? undefined,
        epoch: tab ? tab.sessionEpoch ?? null : memory?.sessionEpoch ?? null, id: tab?.sessionId,
        ready: Promise.resolve(), tail: Promise.resolve(), requests: new Map(),
        current() {
            if (!isSessionViewAlive(view)) return false;
            if (!tab) return view.rollingWindow === window;
            // Publication happens before admission.done (pointer I/O and compression
            // can still be pending). Reconcile before deduplicating another click.
            const published = admission?.resolveIdentity(tab, capturedIdentity) ?? capturedIdentity;
            const current = view.chatTabs.includes(tab) && tab.sessionId === published.id
                && (tab.sessionPath || undefined) === (published.path || undefined)
                && (tab.sessionEpoch ?? null) === (published.epoch ?? null)
                && (tab.isActive ? view.rollingWindow === window
                    : view._agentStates?.get(_tabKey(tab))?.rollingWindow === window);
            if (current) {
                capturedIdentity = published;
                owner.id = published.id;
                owner.path = published.path;
                owner.epoch = published.epoch ?? null;
            }
            return current;
        },
        adoptSavedIdentity(path, epoch) {
            // Only the caller's private writer may supply this identity, after a
            // successful save. Never infer it from the shared memory cursor.
            if (!owner.current()) return false;
            if (tab) {
                const previousKey = _tabKey(tab);
                const state = view._agentStates?.get(previousKey);
                tab.sessionPath = path;
                tab.sessionEpoch = epoch;
                capturedIdentity = { id: tab.sessionId, path, epoch };
                if (state && previousKey !== _tabKey(tab)) {
                    view._agentStates.delete(previousKey);
                    view._agentStates.set(_tabKey(tab), state);
                }
            }
            owner.path = path;
            owner.epoch = epoch;
            return true;
        },
    };
    owner.ready = admission?.done ?? Promise.resolve();
    owners.set(window, owner);
    return owner;
}

/** Deduplicate the whole request, including its dialog, but allow a later explicit retry. */
export function requestSessionLifecycle(owner: SessionLifecycleOwner, operation: LifecycleOperation, work: () => Promise<void>): Promise<void> {
    const pending = owner.requests.get(operation);
    if (pending) return pending;
    const request = work().finally(() => { owner.requests.delete(operation); });
    owner.requests.set(operation, request);
    return request;
}

export function serializeSessionLifecycle<T>(owner: SessionLifecycleOwner, work: () => Promise<T>): Promise<T | undefined> {
    const run = owner.tail.then(async () => {
        await owner.ready;
        if (!owner.current()) return;
        const admission = sendAdmission(owner.window);
        if (admission) {
            await admission.done;
            if (!owner.current()) return;
        }
        return work();
    });
    owner.tail = run.then(() => {}, () => {});
    return run;
}

/** Existing modal workflows require their owner to be selected before entry. */
export async function selectSessionLifecycle(view: ChatViewLike, owner: SessionLifecycleOwner): Promise<boolean> {
    if (!owner.current()) return false;
    if (owner.tab && !owner.tab.isActive) await view._switchTab(_tabKey(owner.tab));
    return owner.current() && view.rollingWindow === owner.window;
}
