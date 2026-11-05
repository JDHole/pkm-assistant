import { log } from '../../core/utils/Logger.js';

/** A stopped executor pins its lease until settlement or the bounded abort grace. */
export function retainExecutor(signal: AbortSignal, graceMs: number, runId: string, tool: string, release?: () => void) {
    let state: 'working' | 'settled' | 'detached' = 'working';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline = 0;
    const clean = () => {
        signal.removeEventListener('abort', abort);
        if (timer !== undefined) {
            // Dynamic references also work in the Node runner and with its injected clock.
            const clear = clearTimeout;
            clear(timer);
            timer = undefined;
        }
        const done = release;
        release = undefined;
        done?.();
    };
    const expire = () => {
        timer = undefined;
        if (state !== 'working') return;
        const remaining = deadline - performance.now();
        if (remaining > 0) { arm(remaining); return; }
        state = 'detached';
        log.warn('SubAgent', 'Executor detached after abort grace', { runId, tool });
        clean();
    };
    const arm = (ms: number) => {
        const schedule = setTimeout;
        timer = schedule(expire, ms);
    };
    const abort = () => {
        if (state !== 'working' || timer !== undefined) return;
        deadline = performance.now() + graceMs;
        arm(graceMs);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return {
        get detached() { return state === 'detached'; },
        settle() {
            if (state !== 'working') return;
            state = 'settled';
            clean();
        },
    };
}
