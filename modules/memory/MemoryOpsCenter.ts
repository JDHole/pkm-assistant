/**
 * @module MemoryOpsCenter
 * Rejestr JEDNEGO aktywnego przebiegu konsolidacji (wzorzec
 * `StreamingManager` z modules/chat: jedna instancja per plugin, wszyscy pytają ją o stan).
 *
 * Po co: pasek statusu Obsidiana, modal przebiegu i notice muszą patrzeć na TEN SAM przebieg.
 * Bez wspólnego rejestru każdy z nich musiałby dostać referencję z osobna, a drugi trigger
 * konsolidacji odpaliłby równoległy przebieg mielący te same pliki.
 *
 * Decyzja: **jedno aktywne run na raz**. `startRun()` przy zajętym centrum NIE rzuca -
 * zwraca run, który już leci, i prosi UI o pokazanie modalu (focus zamiast drugiego przebiegu).
 * Caller rozpoznaje sytuację po tożsamości: `center.startRun(mine) === mine` znaczy „ruszył mój".
 *
 * Stan żyje w pamięci - restart Obsidiana ubija przebieg. To bezpieczne: progi konsolidacji są
 * idempotentne (kolejny start zaproponuje resztę), a zaaplikowane kroki są trwałe od razu.
 *
 * ZERO UI, ZERO Obsidiana - czysty node (`MemoryOpsCenter.test.js`). Instancję per plugin
 * tworzy pasek statusu; tu jest tylko klasa.
 */
import { log } from '../../core/utils/Logger.js';

type ErrLike = { message?: string };

/** Typy zdarzeń rozsyłanych do subskrybentów. */
export const OPS_EVENT = {
    RUN_STARTED: 'run_started',
    RUN_CHANGED: 'run_changed',
    RUN_FINISHED: 'run_finished',
    OPEN_MODAL_REQUESTED: 'open_modal_requested',
};

/** Nazwa zdarzenia centrum operacji. */
export type OpsEventType = (typeof OPS_EVENT)[keyof typeof OPS_EVENT];

/**
 * Przebieg widziany przez centrum - strukturalnie, nie przez import `ConsolidationRun`.
 * Centrum trzyma go wyłącznie jako nieprzezroczystą referencję (tożsamość + `addChangeListener`),
 * a rozsyła dalej do UI, które zna go już po swojemu.
 */
export interface OpsRunLike {
    addChangeListener?(cb: () => void): (() => void) | undefined;
}

/** Zdarzenie rozsyłane do subskrybentów. */
export interface OpsEvent {
    type: OpsEventType;
    run: OpsRunLike | null;
}

export type OpsListener = (event: OpsEvent) => void;

export class MemoryOpsCenter {
    declare private _activeRun: OpsRunLike | null;
    declare private _unsubscribeRun: (() => void) | null;
    declare private _listeners: Set<OpsListener>;

    constructor() {
        this._activeRun = null;
        this._unsubscribeRun = null;
        this._listeners = new Set();
    }

    // ── subskrypcja ────────────────────────────────────────────────────────────

    /**
     * @returns funkcja odpinająca (wygodniejsza niż pamiętanie referencji)
     */
    subscribe(cb: OpsListener): () => void {
        if (typeof cb !== 'function') return () => {};
        this._listeners.add(cb);
        return () => this.unsubscribe(cb);
    }

    unsubscribe(cb: OpsListener): void {
        this._listeners.delete(cb);
    }

    private _emit(type: OpsEventType, run: OpsRunLike | null = this._activeRun): void {
        for (const cb of [...this._listeners]) {
            // Padnięty widok nie może ubić przebiegu ani pozostałych subskrybentów.
            try { cb({ type, run }); } catch (e) {
                log.warn('MemoryOpsCenter', `subskrybent rzucił na "${type}": ${((e as ErrLike)?.message || e) as string}`);
            }
        }
    }

    // ── przebieg ───────────────────────────────────────────────────────────────

    /** Czy coś aktualnie mieli. */
    isBusy(): boolean { return this._activeRun !== null; }

    getActiveRun(): OpsRunLike | null { return this._activeRun; }

    /**
     * Rejestruje przebieg jako aktywny i podpina się pod jego `onChange`.
     * Gdy inny przebieg już leci - NIE startuje drugiego: zwraca ten aktywny i prosi o modal.
     *
     * @param run - instancja ConsolidationRun
     * @returns run, który jest aktywny po tym wywołaniu (Twój albo ten, który już leciał)
     */
    startRun(run: OpsRunLike): OpsRunLike {
        if (!run) throw new Error('MemoryOpsCenter.startRun: brak przebiegu');
        if (this._activeRun && this._activeRun !== run) {
            log.info('MemoryOpsCenter', 'Konsolidacja już trwa — pokazuję bieżący przebieg zamiast startować drugi');
            this.requestOpenModal();
            return this._activeRun;
        }
        if (this._activeRun === run) return run;

        this._activeRun = run;
        this._unsubscribeRun = run.addChangeListener?.(() => this._emit(OPS_EVENT.RUN_CHANGED)) || null;
        this._emit(OPS_EVENT.RUN_STARTED);
        return run;
    }

    /**
     * Zamyka przebieg (pasek statusu znika, modal może zostać otwarty do przeglądania wyniku).
     * @returns przebieg, który właśnie się skończył
     */
    finishRun(): OpsRunLike | null {
        const finished = this._activeRun;
        if (!finished) return null;
        try { this._unsubscribeRun?.(); } catch { /* best-effort */ }
        this._unsubscribeRun = null;
        this._activeRun = null;
        this._emit(OPS_EVENT.RUN_FINISHED, finished);
        return finished;
    }

    /**
     * Prośba o otwarcie modalu przebiegu (klik w 🧠 na pasku statusu, drugi trigger konsolidacji,
     * akcja z notice'a o błędzie). Tu tylko zdarzenie - widok podpina się osobno.
     */
    requestOpenModal(): void {
        this._emit(OPS_EVENT.OPEN_MODAL_REQUESTED);
    }
}

/** Singleton dla pluginu (jak `streamingManager`). Testy tworzą własne instancje. */
export default new MemoryOpsCenter();
