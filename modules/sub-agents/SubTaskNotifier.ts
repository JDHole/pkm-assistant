/**
 * SubTaskNotifier — skrzynka wyników sub-agentów odpalonych W TLE („delegacja w tle").
 *
 * PO CO: `delegate` domyślnie nie blokuje tury — model dostaje `started:true` +
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
import type { ParentQuestion } from './ParentQuestions.js';
export type SubTaskNotice = { kind: 'result'; task: SubTask } | { kind: 'question'; question: ParentQuestion };
export type SubTaskNoticeDeliverer = (notice: SubTaskNotice) => boolean;
export interface SubTaskNoticeClaim { notice: SubTaskNotice; ack(): void; release(): void }

/** Dostawca wyniku. `true` = skonsumowane (wypada z kolejki); `false`/wyjątek = zostaje. */
export type SubTaskDeliverer = (task: SubTask) => boolean;

/** Wyłączne, tymczasowe pobranie wyniku; uchwyt można rozliczyć tylko raz. */
export interface SubTaskClaim {
    task: SubTask;
    ack(): void;
    release(): void;
}

interface PendingEntry {
    notice: SubTaskNotice;
    claimed: boolean;
    delivering: boolean;
}

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
    // `declare` = sama deklaracja typu, zero emitu.
    declare private _pending: PendingEntry[];
    declare private _deliverer: SubTaskDeliverer | null;
    declare private _noticeDeliverer: SubTaskNoticeDeliverer | null;
    declare private _maxPending: number;
    declare private _unsubscribe: (() => void) | null;

    constructor({ registry, maxPending = MAX_PENDING }: SubTaskNotifierOptions) {
        this._pending = [];
        this._deliverer = null;
        this._noticeDeliverer = null;
        this._maxPending = Number(maxPending) > 0 ? Number(maxPending) : MAX_PENDING;
        this._unsubscribe = null;
        this._subscribe(registry);
    }

    private _subscribe(registry: SubTaskNotifierRegistryLike | null | undefined): void {
        try {
            const events = registry?.events;
            if (!events?.on) return;
            const handlers: Array<[string, (payload: unknown) => void]> = [
                ['task:finished', payload => this._onFinished(payload)],
                ['question:opened', payload => this._onQuestion(payload)],
                ['question:closed', payload => this._removeQuestion(payload)],
            ];
            const unsubs = handlers.map(([name, handler]) => {
                const off = events.on(name, handler);
                return typeof off === 'function' ? off : () => events.off?.(name, handler);
            });
            this._unsubscribe = () => { for (const off of unsubs) off(); };
        } catch (e) {
            log.warn('SubTaskNotifier', 'subskrypcja rejestru padła (powiadomienia OFF):', e);
        }
    }

    /** Zakończony bieg W TLE → próba dostarczenia od ręki, a jak się nie da — do kolejki. */
    private _onFinished(payload: unknown): void {
        try {
            const task = payload as SubTask | undefined;
            if (!task?.id || task.background !== true) return;
            this._removeTaskQuestions(task.id);
            const entry: PendingEntry = { notice: { kind: 'result', task }, claimed: false, delivering: false };
            this._pending.push(entry);
            this._tryDeliver(entry);
            this._trimPending();
        } catch (e) {
            log.warn('SubTaskNotifier', 'obsługa task:finished padła (ignorowane):', e);
        }
    }

    private _onQuestion(payload: unknown): void {
        const question = payload as ParentQuestion;
        if (!question?.id) return;
        const entry: PendingEntry = { notice: { kind: 'question', question }, claimed: false, delivering: false };
        this._pending.push(entry); this._tryDeliver(entry); this._trimPending();
    }
    private _removeQuestion(payload: unknown): void {
        const question = payload as ParentQuestion;
        this._pending = this._pending.filter(entry => entry.notice.kind !== 'question' || entry.notice.question.id !== question?.id);
    }
    private _removeTaskQuestions(taskId: string): void {
        this._pending = this._pending.filter(entry => entry.notice.kind !== 'question' || entry.notice.question.taskId !== taskId);
    }

    /** Jedno miejsce, w którym wołamy dostawcę. Wyjątek = „nie skonsumowano". */
    private _tryDeliver(entry: PendingEntry): void {
        const deliver = this._noticeDeliverer ?? (entry.notice.kind === 'result' && this._deliverer ? (notice: SubTaskNotice) => notice.kind === 'result' && this._deliverer?.(notice.task) === true : null);
        if (!deliver || entry.claimed || entry.delivering || !this._pending.includes(entry)) return;
        entry.delivering = true;
        try {
            if (deliver(entry.notice) === true) this._remove(entry);
        } catch (e) {
            log.warn('SubTaskNotifier', 'dostawca odbił powiadomienie (zostaje w kolejce):', e);
        } finally {
            entry.delivering = false;
        }
    }

    private _remove(entry: PendingEntry): void {
        const index = this._pending.indexOf(entry);
        if (index !== -1) this._pending.splice(index, 1);
    }

    /** Nadmiar wypada od najstarszego wolnego wpisu, nigdy z aktywnym uchwytem. */
    private _trimPending(): void {
        while (this._pending.length > this._maxPending) {
            const index = this._pending.findIndex(entry => !entry.claimed && !entry.delivering);
            if (index === -1) break;
            const [dropped] = this._pending.splice(index, 1);
            log.warn('SubTaskNotifier',
                `kolejka powiadomień pełna (${this._maxPending}) — gubię najstarsze powiadomienie ${dropped?.notice.kind || '(?)'}`);
        }
    }

    /**
     * Podłącz/odłącz dostawcę. Sam w sobie NIC nie dostarcza — świadomie, żeby wołacz
     * decydował o momencie (najpierw podłącz UI, potem `drain()`).
     */
    setDeliverer(fn: SubTaskDeliverer | null): void {
        this._deliverer = typeof fn === 'function' ? fn : null;
    }
    setNoticeDeliverer(fn: SubTaskNoticeDeliverer | null): void { this._noticeDeliverer = typeof fn === 'function' ? fn : null; }

    /** Ponów próbę dla wszystkiego, co czeka — w kolejności FIFO. Nieskonsumowane zostaje. */
    drain(): void {
        for (const entry of [...this._pending]) this._tryDeliver(entry);
        this._trimPending();
    }

    /** Zajmij pasujące wolne wyniki synchronicznie, bez usuwania ich z kolejki. */
    claimPending(predicate: (task: SubTask) => boolean): SubTaskClaim[] {
        return this.claimNotices(notice => notice.kind === 'result' && predicate(notice.task)).map(claim => ({ task: (claim.notice as { kind: 'result'; task: SubTask }).task, ack: () => claim.ack(), release: () => claim.release() }));
    }
    claimNotices(predicate: (notice: SubTaskNotice) => boolean): SubTaskNoticeClaim[] {
        const claims: SubTaskNoticeClaim[] = [];
        for (const entry of [...this._pending]) {
            if (entry.claimed || entry.delivering || !this._pending.includes(entry)) continue;
            let matches: boolean;
            try {
                matches = predicate(entry.notice);
            } catch (e) {
                log.warn('SubTaskNotifier', 'filtr claim padł (ignorowane):', e);
                continue;
            }
            if (!matches || entry.claimed || entry.delivering || !this._pending.includes(entry)) continue;
            entry.claimed = true;
            let active = true;
            const finish = (ack: boolean): void => {
                if (!active) return;
                active = false;
                if (!this._pending.includes(entry)) return;
                entry.claimed = false;
                if (ack) this._remove(entry);
            };
            claims.push({ notice: entry.notice, ack: () => finish(true), release: () => finish(false) });
        }
        return claims;
    }

    /** Wszystko, co czeka na dostarczenie (kopia — kolejka jest prywatna). */
    pending(): SubTask[] {
        return this._pending.flatMap(entry => entry.notice.kind === 'result' ? [entry.notice.task] : []);
    }
    pendingNotices(): SubTaskNotice[] { return this._pending.map(entry => entry.notice); }

    /**
     * Czekające wyniki zlecone przez danego agenta. Bierzemy `origin.agentName`
     * (kto zlecił), a gdy zlecenie przyszło bez adresu zwrotnego — `task.agentName`
     * (właściciel biegu; w praktyce ten sam agent).
     */
    pendingFor(agentName: string): SubTask[] {
        return this.pending().filter((task) => (task.origin?.agentName || task.agentName) === agentName);
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
        this._noticeDeliverer = null;
        this._pending = [];
    }
}
