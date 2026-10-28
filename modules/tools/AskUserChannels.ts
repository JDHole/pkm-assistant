import type { Owner } from '../sub-agents/index.js';

export type AskUserChannelState =
    | { kind: 'open'; id: string; owner: Owner }
    | { kind: 'closed'; id: string; owner: Owner; reason: 'answered' | 'cancelled' | 'timeout' };

export interface AskUserChannel {
    readonly id: string;
    readonly promise: Promise<string | null>;
    readonly state: AskUserChannelState;
    answer(answer: string): void;
    cancel(): void;
    timeout(): void;
}

export interface AskUserWaitRegistry {
    registerUserWait(owner: Owner, cancel: () => void): () => void;
}

export interface AskUserChannels {
    open(owner: Owner): AskUserChannel;
    get(id: string): AskUserChannel | undefined;
    forget(id: string): void;
}

export function createAskUserChannels(registry: AskUserWaitRegistry): AskUserChannels {
    const channels = new Map<string, AskUserChannel>();
    const claimed = new Set<string>();
    let sequence = 0;
    return {
        open(owner) {
            const id = `ask-user-${++sequence}-${Math.random().toString(36).slice(2)}`;
            const capturedOwner = { ...owner };
            let state: AskUserChannelState = { kind: 'open', id, owner: capturedOwner };
            let resolve!: (answer: string | null) => void;
            const promise = new Promise<string | null>(done => { resolve = done; });
            let release = () => {};
            const close = (reason: 'answered' | 'cancelled' | 'timeout', answer: string | null) => {
                if (state.kind === 'closed') return;
                state = { kind: 'closed', id, owner: capturedOwner, reason };
                if (claimed.delete(id)) channels.delete(id);
                release();
                resolve(answer);
            };
            const channel: AskUserChannel = {
                id,
                promise,
                get state() { return state; },
                answer: answer => close('answered', answer),
                cancel: () => close('cancelled', null),
                timeout: () => close('timeout', null),
            };
            channels.set(id, channel);
            release = registry.registerUserWait(capturedOwner, () => channel.cancel());
            if (channel.state.kind === 'closed') release();
            return channel;
        },
        get(id) {
            const channel = channels.get(id);
            if (channel?.state.kind === 'closed') channels.delete(id);
            else if (channel) claimed.add(id);
            return channel;
        },
        forget(id) {
            channels.get(id)?.cancel();
            channels.delete(id);
            claimed.delete(id);
        },
    };
}
