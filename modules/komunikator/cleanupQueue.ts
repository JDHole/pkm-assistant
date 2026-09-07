/**
 * cleanupQueue.js — kolejka modali sprzątania (S28 D5, mikro-decyzja Kuby).
 *
 * Gdy kilka wiadomości naraz dostaje DRUGI ptaszek (np. „oznacz wszystkie jako
 * przeczytane" albo agent czyta hurtem), user nie może dostać pięciu modali na raz.
 * Kolejka wypuszcza JEDEN modal, czeka aż się zamknie, dopiero wtedy bierze następny.
 *
 * Moduł jest PURE (zero obsidian) — `runner` jest wstrzykiwany, więc logika kolejki
 * ma testy node'owe, a modal jest tylko jej konsumentem.
 */

import type { CleanupItem } from './types.js';

export class CleanupQueue {
    declare _runner: (item: CleanupItem) => Promise<unknown>;
    declare _pending: CleanupItem[];
    declare _keys: Set<string>;
    declare _running: boolean;
    /**
     * @param {(item: Object) => Promise<any>} runner - obsługa JEDNEJ pozycji (np. otwarcie modala);
     *   promise rozwiązuje się, gdy user zamknie modal.
     */
    constructor(runner: (item: CleanupItem) => Promise<unknown>) {
        this._runner = runner;
        this._pending = [];
        this._keys = new Set();
        this._running = false;
    }

    /** @returns {number} ile pozycji czeka (bez tej aktualnie obsługiwanej) */
    get size() { return this._pending.length; }

    /** @returns {boolean} czy modal jest właśnie otwarty */
    get isRunning() { return this._running; }

    /**
     * Klucz dedupu — ta sama wiadomość nie może wpaść do kolejki dwa razy
     * (event potrafi przyjść i z UI, i z narzędzia agenta).
     * @param {{agent: string, id: string}} item
     */
    static keyOf(item: CleanupItem | null | undefined): string {
        return `${item?.agent || ''}::${item?.id || ''}`;
    }

    /**
     * Dołóż pozycję (albo listę) i uruchom przetwarzanie, jeśli nic nie leci.
     * @param {Object|Object[]} itemOrItems
     */
    enqueue(itemOrItems: CleanupItem | CleanupItem[]) {
        const items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];
        for (const item of items) {
            if (!item?.agent || !item?.id) continue;
            const key = CleanupQueue.keyOf(item);
            if (this._keys.has(key)) continue;
            this._keys.add(key);
            this._pending.push(item);
        }
        void this._drain();
    }

    /** Wyrzuć wszystko, co czeka (np. przy unload pluginu). */
    clear() {
        this._pending = [];
        this._keys.clear();
    }

    async _drain() {
        if (this._running) return;
        this._running = true;
        try {
            while (this._pending.length > 0) {
                const item = this._pending.shift()!;
                try {
                    await this._runner(item);
                } catch {
                    // Wywrotka jednego modala nie może zatkać kolejki.
                }
                this._keys.delete(CleanupQueue.keyOf(item));
            }
        } finally {
            this._running = false;
        }
    }
}
