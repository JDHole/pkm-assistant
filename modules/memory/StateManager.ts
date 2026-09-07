import { probeFile } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';

/** Adapter FS vaulta w zakresie potrzebnym `.state.json` (typowany strukturalnie). */
export interface StateVaultAdapterLike {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
}

export interface StateVaultLike {
    adapter: StateVaultAdapterLike;
}

/**
 * Kształt `.state.json`. Pola z `defaultState()` są zawsze obecne (merge w `_readRaw`),
 * a index signature odwzorowuje FAKT, że plik nosi też klucze spoza schematu — dopisują
 * je wołacze przez `update()` (`brain_notes_limit`, `last_used`, …) i muszą przeżyć spread.
 */
export interface MemoryState {
    active_sessions: string[];
    archived_since_last_consolidation: number;
    last_archive_at: string | null;
    last_used?: string | null;
    [key: string]: unknown;
}

export class StateManager {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3).
    declare vault: StateVaultLike;
    declare statePath: string;
    declare private _writeChain: Promise<void>;

    constructor(vault: StateVaultLike, statePath: string) {
        this.vault = vault;
        this.statePath = statePath;
        // E2.7 K1: serialize every mutation of .state.json. All ops target a single path, so one
        // promise chain is enough. Without it, a read-modify-write (addActiveSession / markArchived
        // / write) racing another writer reads stale JSON and the last write silently drops the
        // other's change. K2/K3 raise write frequency (proactive saves, idle saves), so this lock
        // goes in first (F3). The tail never rejects, so one throwing op does not stall the chain.
        this._writeChain = Promise.resolve();
    }

    defaultState(): MemoryState {
        return {
            active_sessions: [],
            archived_since_last_consolidation: 0,
            last_archive_at: null
        };
    }

    private _enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
        const run = this._writeChain.then(() => fn(), () => fn());
        this._writeChain = run.then(() => {}, () => {});
        return run;
    }

    /**
     * Raw read (no queue) — ścieżka MUTACJI. Awaria odczytu/parsowania leci w górę jako błąd.
     *
     * K4 (AUD-bledy-061/043): „nie da się przeczytać" NIE jest tym samym co „pliku nie ma".
     * Każdy mutator (`update` / `addActiveSession` / `markArchived`) czyta przez tę metodę
     * i NATYCHMIAST zapisuje to, co dostał — więc ciche defaulty kasowały licznik konsolidacji,
     * listę `active_sessions` i klucze spoza schematu (`brain_notes_limit` = decyzja usera),
     * bez jednej linii w logu. Teraz mutacja się po prostu nie odbywa, a plik zostaje nietknięty
     * (do przeczytania przy następnym podejściu albo do ratunku ręcznie).
     *
     * Bootstrap (pierwszy start agenta) robimy WYŁĄCZNIE na POTWIERDZONYM „nie ma"
     * (`probeFile`), nie na gołym `exists() === false` — to ono kłamie na dyskach sieciowych.
     */
    private async _readRaw(): Promise<MemoryState> {
        if (await probeFile(this.vault.adapter, this.statePath) === 'missing') {
            const state = this.defaultState();
            await this._writeRaw(state);
            return state;
        }
        let raw: string;
        try {
            raw = await this.vault.adapter.read(this.statePath);
        } catch (e) {
            log.warn('StateManager', `Nie mogę przeczytać ${this.statePath} — nie ruszam pliku:`, e);
            throw e;
        }
        try {
            return { ...this.defaultState(), ...(JSON.parse(raw || '{}') as Partial<MemoryState>) };
        } catch (e) {
            log.warn('StateManager', `Uszkodzony JSON w ${this.statePath} — nie nadpisuję defaultami:`, e);
            throw e;
        }
    }

    /** Raw write (no queue) — only call inside a serialized block or via write(). */
    private async _writeRaw(state: Partial<MemoryState> | null | undefined): Promise<void> {
        await this.vault.adapter.write(this.statePath, JSON.stringify({
            ...this.defaultState(),
            ...(state || {})
        }, null, 2));
    }

    /**
     * Publiczny odczyt (K4): NIC nie zapisuje, więc awaria może zdegradować się do defaultów
     * W PAMIĘCI — z logiem, nigdy na dysk. Ten kontrakt trzyma `consolidationRunner`:
     * uszkodzony `.state.json` ma spaść na próg z ustawień, a nie wywrócić konsolidacji.
     * Groźna była nie sama degradacja, tylko jej UTRWALENIE przez mutator (patrz `_readRaw`).
     */
    async read(): Promise<MemoryState> {
        try {
            return await this._readRaw();
        } catch (e) {
            log.warn('StateManager', `Defaulty TYLKO w pamięci (nic nie idzie na dysk): ${this.statePath}`, e);
            return this.defaultState();
        }
    }

    async write(state: Partial<MemoryState> | null | undefined): Promise<void> {
        return this._enqueue(() => this._writeRaw(state));
    }

    /**
     * Serializowany read-modify-write dla wołaczy spoza tej klasy.
     *
     * `read()` + mutacja + `write()` po stronie wołacza to była ta sama klasa błędu, przed którą
     * broni `_writeChain` (E2.7 K1): odczyt leci POZA kolejką, a `write()` NADPISUJE cały plik,
     * więc równoległy `markArchived`/`addActiveSession` (autozapis czatu) był po cichu cofany.
     * `_resetArchiveCounter` w konsolidacji woła się raz na KAŻDĄ zaakceptowaną paczkę L1 —
     * 12 paczek = 12 okien wyścigu w czasie, gdy user normalnie pisze.
     *
     * Mutator MUTUJE podany obiekt (nie buduje nowego): `_readRaw` merguje go z `defaultState`,
     * więc spread zachowuje klucze spoza schematu (`brain_notes_limit` = decyzja usera; osierocony
     * `notes_count_at_last_check` z plików sprzed dead-code sweepu 2026-09-02, AUD-dead-code-041/122,
     * też przeżywa merge, tylko już nikt go nie pisze ani nie czyta — pole wypadło ze schematu).
     *
     * @param mutator - mutuje podany obiekt w miejscu
     * @returns stan PO mutacji
     */
    async update(mutator: (state: MemoryState) => void | Promise<void>): Promise<MemoryState> {
        return this._enqueue(async () => {
            const state = await this._readRaw();
            if (typeof mutator === 'function') await mutator(state);
            await this._writeRaw(state);
            return state;
        });
    }

    async addActiveSession(filename: string): Promise<MemoryState> {
        return this._enqueue(async () => {
            const state = await this._readRaw();
            const active = new Set(state.active_sessions || []);
            active.add(filename);
            state.active_sessions = [...active];
            state.last_used = filename;
            await this._writeRaw(state);
            return state;
        });
    }

    async removeActiveSession(filename: string): Promise<MemoryState> {
        return this._enqueue(() => this._removeActiveSessionRaw(filename));
    }

    private async _removeActiveSessionRaw(filename: string): Promise<MemoryState> {
        const state = await this._readRaw();
        state.active_sessions = (state.active_sessions || []).filter(name => name !== filename);
        if (state.last_used === filename) state.last_used = state.active_sessions.at(-1) || null;
        await this._writeRaw(state);
        return state;
    }

    async markArchived(filename: string): Promise<MemoryState> {
        return this._enqueue(async () => {
            const state = await this._removeActiveSessionRaw(filename);
            state.archived_since_last_consolidation = Number(state.archived_since_last_consolidation || 0) + 1;
            state.last_archive_at = new Date().toISOString();
            await this._writeRaw(state);
            return state;
        });
    }
}
