/** Uses the view-close latch introduced with the phone menu, on both platforms. */
export interface SessionViewLifetime {
    _phoneSessionMenuClosed?: boolean;
    env?: { state?: string };
}

export function isSessionViewAlive(view: SessionViewLifetime): boolean {
    return !view._phoneSessionMenuClosed && view.env?.state !== 'disposed';
}

interface DecisionModal<T> {
    prompt(): Promise<T>;
    close(): void;
}

const decisions = new WeakMap<SessionViewLifetime, Set<{ close(): void }>>();

/** Only blocking decisions belong to the chat; consolidation runs own their UI. */
export async function promptSessionDecision<T>(view: SessionViewLifetime, modal: DecisionModal<T>, cancelled: T): Promise<T> {
    if (!isSessionViewAlive(view)) return cancelled;
    let pending = decisions.get(view);
    if (!pending) decisions.set(view, pending = new Set());
    pending.add(modal);
    try {
        return await modal.prompt();
    } finally {
        pending.delete(modal);
        if (!pending.size) decisions.delete(view);
    }
}

export function closeSessionDecisions(view: SessionViewLifetime): void {
    const pending = decisions.get(view);
    decisions.delete(view);
    for (const modal of pending ?? []) modal.close();
}
