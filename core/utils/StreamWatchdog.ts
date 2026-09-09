/**
 * @module StreamWatchdog
 * Watchdog martwego streamu czatu. Obserwowany przypadek: lokalne proxy
 * (zgodne z API LM Studio) przyjmuje request i trzyma połączenie, ale nie oddaje
 * ANI JEDNEGO chunka (log `[ChatAdapter] no chunk`) — twardy timeout XHR w adapterze
 * to dopiero 600 s, więc tura wisiała w nieskończoność aż do ręcznego Stopa.
 *
 * Jeden timer: zbrojony na start wywołania modelu (`arm`), resetowany każdym chunkiem
 * (`feed`), rozbrajany gdy model skończył albo tura się kończy (`disarm`). Łapie więc
 * zarówno brak pierwszego chunka, jak i stall w środku streamu. NIE biegnie podczas
 * wykonywania narzędzi — to osobna warstwa timeoutów (modules/tools/server_timeout.js).
 *
 * Zero importów z `obsidian` — testowalny node'em (StreamWatchdog.test.js). Timery
 * i zegar wstrzykiwalne (testy podają fake'i); w produkcie timer jest zawsze czyszczony
 * deterministycznie (disarm w finally pętli + ręczny Stop + onClose widoku).
 *
 * Watchdog żyje w `core/utils/`, nie w `modules/chat/chat/`, bo potrzebuje go też
 * `modules/memory/streamHelper.js` (konsolidacja pamięci), a memory NIE MOŻE importować
 * z modules/chat — złota zasada (tylko barrel) plus realny cykl (chat już importuje
 * z memory). Klasa nie ma zależności, więc jej miejsce jest w rdzeniu.
 */
/**
 * Uchwyt timera. Świadomie NIEPRZEZROCZYSTY: w Obsidianie to `number`, w Node
 * `NodeJS.Timeout`, a w testach zwykły licznik z fake'owego zegara. Watchdog nigdy
 * nie zagląda do środka — tylko oddaje go temu samemu `clearTimeoutFn`.
 */
import { hostWindow, type HostTimer } from './hostWindow.js';

type TimerId = unknown;

export interface StreamWatchdogOptions {
    /** tolerowana cisza w ms; <=0 = watchdog wyłączony (arm() to no-op) */
    timeoutMs?: number;
    /**
     * wołany RAZ po przekroczeniu ciszy; watchdog rozbraja się sam PRZED wywołaniem
     * (nie strzeli drugi raz bez ponownego arm)
     */
    onStall?: (silentMs: number) => void;
    /** wstrzykiwane dla testów */
    setTimeoutFn?: (fn: () => void, ms: number) => TimerId;
    /** wstrzykiwane dla testów */
    clearTimeoutFn?: (id: TimerId) => void;
    /** wstrzykiwane dla testów */
    now?: () => number;
}

export class StreamWatchdog {
    // `declare` = sama deklaracja typu, zero emitu.
    declare timeoutMs: number;
    declare onStall: (silentMs: number) => void;
    declare private _setTimeout: (fn: () => void, ms: number) => TimerId;
    declare private _clearTimeout: (id: TimerId) => void;
    declare private _now: () => number;
    declare private _timerId: TimerId;
    declare private _lastActivityAt: number;

    constructor({ timeoutMs, onStall, setTimeoutFn, clearTimeoutFn, now }: StreamWatchdogOptions = {}) {
        this.timeoutMs = timeoutMs || 0;
        this.onStall = typeof onStall === 'function' ? onStall : () => {};
        // Timery przez `hostWindow` (Obsidian: window, Node: globalThis) — plik node-safe (testy AVA / harness,
        // zero `window`).
        this._setTimeout = setTimeoutFn || ((fn, ms) => hostWindow.setTimeout(fn, ms));
        // Domyślna ścieżka dostaje z powrotem dokładnie to, co zwrócił globalny `setTimeout`,
        // więc asercja tylko przywraca tę wiedzę utraconą przez nieprzezroczysty `TimerId`.
        // Timery przez `hostWindow` (Obsidian: window, Node: globalThis) — plik node-safe (testy AVA / harness,
        // zero `window`).
        this._clearTimeout = clearTimeoutFn || ((id) => hostWindow.clearTimeout(id as HostTimer | undefined));
        this._now = now || (() => Date.now());
        this._timerId = null;
        this._lastActivityAt = 0;
    }

    get isArmed(): boolean { return this._timerId !== null; }

    /** Start odliczania — model za chwilę zostanie wywołany. Ponowny arm = reset (nowa iteracja). */
    arm(): void {
        if (this.timeoutMs <= 0) return;
        this._restart();
    }

    /** Chunk przyszedł — stream żyje, resetuj odliczanie. No-op gdy nieuzbrojony. */
    feed(): void {
        if (!this.isArmed) return;
        this._restart();
    }

    /** Model skończył / koniec tury / ręczny Stop — wyłącz odliczanie. Idempotentny. */
    disarm(): void {
        if (this._timerId !== null) {
            this._clearTimeout(this._timerId);
            this._timerId = null;
        }
    }

    private _restart(): void {
        this.disarm();
        this._lastActivityAt = this._now();
        this._timerId = this._setTimeout(() => {
            this._timerId = null;
            this.onStall(this._now() - this._lastActivityAt);
        }, this.timeoutMs);
    }
}
