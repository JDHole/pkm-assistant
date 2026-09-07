/**
 * SubTaskNotifier — skrzynka wyników sub-agentów odpalonych W TLE (F2 „delegacja w tle").
 *
 * PO CO: od F2 `delegate` domyślnie nie blokuje tury — model dostaje `started:true` +
 * `task_id`, a bieg suba toczy się dalej po tym, jak tura się skończyła. Ktoś musi
 * przechować gotowy wynik do chwili, w której będzie komu go oddać. Tym „kimś" jest ten
 * plik: siedzi na zdarzeniu `task:finished` rejestru i trzyma zakończone biegi w kolejce,
 * dopóki dostawca (w fazie B: czat) ich nie skonsumuje.
 *
 * DLACZEGO NIE OD RAZU DO CZATU: czat może nie istnieć (zakładka zamknięta, plugin
 * w trakcie startu, harness bez UI w ogóle). Notifier jest pure — zero `obsidian`, zero
 * I/O, zero wiedzy o tym, jak wygląda dostarczenie. Dostawcę wstrzykuje się przez
 * `setDeliverer(fn)`; `fn` zwraca `true` = „skonsumowane", `false`/wyjątek = „zostaw
 * w kolejce, spróbujemy później" (`drain()`).
 *
 * ZASADY (te same co w `SubTaskRegistry`):
 *   - Interesują nas WYŁĄCZNIE biegi z `background === true`. Zwykła (blokująca)
 *     delegacja oddaje wynik wprost do tury i nie ma czego dostarczać.
 *   - NIGDY nie rzuca. Powiadomienia nie mają prawa wywrócić pluginu ani biegu suba.
 *   - Sufit bezpieczeństwa `MAX_PENDING` — kolejka nie może rosnąć w nieskończoność,
 *     gdy nikt nigdy nie odbiera (np. user nie otworzył czatu przez tydzień).
 */
import { log } from '../../core/utils/Logger.js';
import type { SubTask } from './SubTaskRegistry.js';

/** Dostawca wyniku. `true` = skonsumowane (wypada z kolejki); `false`/wyjątek = zostaje. */
export type SubTaskDeliverer = (task: SubTask) => boolean;

/** Minimalny widok rejestru, jakiego notifier używa (duck-typing — testy podstawiają atrapę). */
export interface SubTaskNotifierRegistryLike {
    events?: {
        on(event: string, handler: (payload: unknown) => void): (() => void) | void;
        off?(event: string, handler: (payload: unknown) => void): void;
    } | null;
}

export interface SubTaskNotifierOptions {
    registry: SubTaskNotifierRegistryLike | null | undefined;
    /** Sufit kolejki (najstarsze wypadają z ostrzeżeniem). Default `MAX_PENDING`. */
    maxPending?: number;
}

/** Ile zakończonych biegów w tle trzymamy, zanim zaczniemy gubić najstarsze. */
const MAX_PENDING = 200;

export class SubTaskNotifier {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3).
    declare private _pending: SubTask[];
    declare private _deliverer: SubTaskDeliverer | null;
    declare private _maxPending: number;
    declare private _unsubscribe: (() => void) | null;

    constructor({ registry, maxPending = MAX_PENDING }: SubTaskNotifierOptions) {
        this._pending = [];
        this._deliverer = null;
        this._maxPending = Number(maxPending) > 0 ? Number(maxPending) : MAX_PENDING;
        this._unsubscribe = null;
        this._subscribe(registry);
    }

    private _subscribe(registry: SubTaskNotifierRegistryLike | null | undefined): void {
        try {
            const events = registry?.events;
            if (!events?.on) return;
            const handler = (payload: unknown) => this._onFinished(payload);
            const off = events.on('task:finished', handler);
            this._unsubscribe = typeof off === 'function'
                ? off
                : () => { try { events.off?.('task:finished', handler); } catch { /* best-effort */ } };
        } catch (e) {
            log.warn('SubTaskNotifier', 'subskrypcja rejestru padła (powiadomienia OFF):', e);
        }
    }

    /** Zakończony bieg W TLE → próba dostarczenia od ręki, a jak się nie da — do kolejki. */
    private _onFinished(payload: unknown): void {
        try {
            const task = payload as SubTask | undefined;
            if (!task?.id || task.background !== true) return;
            if (this._tryDeliver(task)) return;
            this._enqueue(task);
        } catch (e) {
            log.warn('SubTaskNotifier', 'obsługa task:finished padła (ignorowane):', e);
        }
    }

    /** Jedno miejsce, w którym wołamy dostawcę. Wyjątek = „nie skonsumowano". */
    private _tryDeliver(task: SubTask): boolean {
        const deliver = this._deliverer;
        if (!deliver) return false;
        try {
            return deliver(task) === true;
        } catch (e) {
            log.warn('SubTaskNotifier', `dostawca odbił wynik ${task.id} (zostaje w kolejce):`, e);
            return false;
        }
    }

    /** Dopisz do kolejki z sufitem — nadmiar wypada od NAJSTARSZEGO, głośno. */
    private _enqueue(task: SubTask): void {
        this._pending.push(task);
        while (this._pending.length > this._maxPending) {
            const dropped = this._pending.shift();
            log.warn('SubTaskNotifier',
                `kolejka powiadomień pełna (${this._maxPending}) — gubię najstarszy wynik ${dropped?.id || '(?)'}`);
        }
    }

    /**
     * Podłącz/odłącz dostawcę. Sam w sobie NIC nie dostarcza — świadomie, żeby wołacz
     * decydował o momencie (najpierw podłącz UI, potem `drain()`).
     */
    setDeliverer(fn: SubTaskDeliverer | null): void {
        this._deliverer = typeof fn === 'function' ? fn : null;
    }

    /** Ponów próbę dla wszystkiego, co czeka — w kolejności FIFO. Nieskonsumowane zostaje. */
    drain(): void {
        if (this._pending.length === 0) return;
        const queue = this._pending;
        this._pending = [];
        const left: SubTask[] = [];
        for (const task of queue) {
            if (!this._tryDeliver(task)) left.push(task);
        }
        // Nowe wyniki mogły dojść W TRAKCIE dostarczania (dostawca bywa reentrantny) —
        // nieskonsumowane wracają NA POCZĄTEK, żeby FIFO całości zostało zachowane.
        this._pending = left.concat(this._pending);
    }

    /** Wszystko, co czeka na dostarczenie (kopia — kolejka jest prywatna). */
    pending(): SubTask[] {
        return [...this._pending];
    }

    /**
     * Czekające wyniki zlecone przez danego agenta. Bierzemy `origin.agentName`
     * (kto zlecił), a gdy zlecenie przyszło bez adresu zwrotnego — `task.agentName`
     * (właściciel biegu; w praktyce ten sam agent).
     */
    pendingFor(agentName: string): SubTask[] {
        return this._pending.filter((task) => (task.origin?.agentName || task.agentName) === agentName);
    }

    /** Sprzątanie przy `onunload` pluginu — odpina subskrypcję i puszcza kolejkę. */
    dispose(): void {
        try {
            this._unsubscribe?.();
        } catch (e) {
            log.warn('SubTaskNotifier', 'dispose() padł:', e);
        }
        this._unsubscribe = null;
        this._deliverer = null;
        this._pending = [];
    }
}
