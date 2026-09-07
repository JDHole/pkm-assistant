/**
 * EventEmitter — lekki publish/subscribe bus.
 *
 * Bez zależności od starego frameworka, bez wildcards, bez payload freezing — minimum potrzebne
 * dla decouplingu adapter→model. Używane w modules/embedding/adapter_base.js (Z6) +
 * przyszłych modułach (Settings v2, Backstage v2).
 *
 * API:
 *   const ee = new EventEmitter();
 *   const off = ee.on('config_changed', payload => { ... });
 *   ee.emit('config_changed', { provider: 'ollama' });
 *   off(); // unsubscribe
 *   ee.removeAllListeners();
 */
import { log } from './Logger.js';

/**
 * Handler zdarzenia. Payload jest `unknown` — szyna świadomie NIE zna kształtu zdarzeń
 * (zawężaj u siebie). `...args`, bo `once()` przepuszcza całą listę argumentów dalej.
 */
export type EventHandler = (...args: unknown[]) => void;

/** Funkcja odsubskrybowania zwracana przez `on()` / `once()`. */
export type Unsubscribe = () => void;

export class EventEmitter {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3).
    declare private _handlers: Map<string, Set<EventHandler>>;

    constructor() {
        this._handlers = new Map();
    }

    on(event: string, handler: EventHandler | null | undefined): Unsubscribe {
        if (typeof handler !== 'function') return () => {};
        let list = this._handlers.get(event);
        if (!list) {
            list = new Set();
            this._handlers.set(event, list);
        }
        list.add(handler);
        return () => this.off(event, handler);
    }

    once(event: string, handler: EventHandler | null | undefined): Unsubscribe {
        if (typeof handler !== 'function') return () => {};
        const wrapper: EventHandler = (...args) => {
            this.off(event, wrapper);
            handler(...args);
        };
        return this.on(event, wrapper);
    }

    off(event: string, handler: EventHandler | null | undefined): void {
        const list = this._handlers.get(event);
        if (!list) return;
        // `handler` bywa nullem (publiczne API + domknięcie z `on()`), a `Set.delete(null)`
        // to legalny no-op w runtime — asercja tylko domyka sygnaturę Seta.
        list.delete(handler as EventHandler);
        if (list.size === 0) this._handlers.delete(event);
    }

    emit(event: string, payload?: unknown): void {
        const list = this._handlers.get(event);
        if (!list) return;
        for (const handler of [...list]) {
            try {
                handler(payload);
            } catch (e) {
                log.error('EventEmitter', `handler for '${event}' threw:`, e);
            }
        }
    }

    listenerCount(event: string): number {
        const list = this._handlers.get(event);
        return list ? list.size : 0;
    }

    removeAllListeners(event?: string): void {
        if (event === undefined) {
            this._handlers.clear();
        } else {
            this._handlers.delete(event);
        }
    }
}
