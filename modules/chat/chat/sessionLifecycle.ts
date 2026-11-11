import type { ChatTab, ChatViewLike } from './chatViewShape.js';
import { _tabKey } from './chat_tabs.js';
import { sendAdmission } from './sendAdmission.js';
import { resolveOwnerMemory } from './turnOwner.js';

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
    const capturedIdentity = { id: tab?.sessionId, path: tab?.sessionPath, epoch: tab?.sessionEpoch };
    const owner: SessionLifecycleOwner = {
        tab, window, memory, agentName: tab?.agentName ?? memory?.agentName ?? manager?.getActiveAgent?.()?.name,
        path: tab ? tab.sessionPath : memory?.activeSessionPath ?? undefined,
        epoch: tab ? tab.sessionEpoch ?? null : memory?.sessionEpoch ?? null, id: tab?.sessionId,
        ready: Promise.resolve(), tail: Promise.resolve(), requests: new Map(),
        current() {
            if (!tab) return view.rollingWindow === window;
            return view.chatTabs.includes(tab) && tab.sessionId === owner.id
                && (tab.sessionPath || undefined) === (owner.path || undefined)
                && (tab.sessionEpoch ?? null) === owner.epoch
                && (tab.isActive ? view.rollingWindow === window
                    : view._agentStates?.get(_tabKey(tab))?.rollingWindow === window);
        },
    };
    if (admission) {
        owner.ready = admission.done.then(() => {
            // Follow only identities actually published by this admission. A null
            // path/epoch is not permission to adopt an unrelated replacement.
            if (!tab) return;
            const published = admission.resolveIdentity(tab, capturedIdentity);
            if (view.chatTabs.includes(tab) && tab.sessionId === published.id
                && tab.sessionPath === published.path && tab.sessionEpoch === published.epoch
                && (tab.isActive ? view.rollingWindow === window
                    : view._agentStates?.get(_tabKey(tab))?.rollingWindow === window)) {
                owner.id = published.id;
                owner.path = published.path;
                owner.epoch = published.epoch ?? null;
            }
        });
    }
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
