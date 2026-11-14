import { probeFile } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';
import { splitGitConflict } from './gitConflict.js';
import { mergeStateConflict } from './stateConflict.js';
import { StateCorruptionError } from './StateCorruptionError.js';

/** Adapter FS vaulta w zakresie potrzebnym `.state.json` (typowany strukturalnie). */
export interface StateVaultAdapterLike {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    // Already supplied by AgentMemory's vault. Only recovery needs these operations.
    list?(path: string): Promise<{ files?: string[]; folders?: string[] } | null>;
    mkdir?(path: string): Promise<void>;
}

export interface StateVaultLike {
    adapter: StateVaultAdapterLike;
}

/**
 * Kształt `.state.json`. Pola z `defaultState()` są zawsze obecne (merge w `_readRaw`),
 * a index signature odwzorowuje FAKT, że plik nosi też klucze spoza schematu - dopisują
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
    // `declare` = sama deklaracja typu, zero emitu.
    declare vault: StateVaultLike;
    declare statePath: string;
    declare private _writeChain: Promise<void>;

    constructor(vault: StateVaultLike, statePath: string) {
        this.vault = vault;
        this.statePath = statePath;
        // Serialize every mutation of .state.json. All ops target a single path, so one
        // promise chain is enough. Without it, a read-modify-write (addActiveSession / markArchived
        // / write) racing another writer reads stale JSON and the last write silently drops the
        // other's change. Proactive and idle saves raise write frequency, so this lock matters.
        // The tail never rejects, so one throwing op does not stall the chain.
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
     * Raw read (no queue) - ścieżka MUTACJI. Awaria odczytu/parsowania leci w górę jako błąd.
     *
     * „Nie da się przeczytać" NIE jest tym samym co „pliku nie ma".
     * Każdy mutator (`update` / `addActiveSession` / `markArchived`) czyta przez tę metodę
     * i NATYCHMIAST zapisuje to, co dostał - więc ciche defaulty kasowały licznik konsolidacji,
     * listę `active_sessions` i klucze spoza schematu (`brain_notes_limit` = decyzja usera),
     * bez jednej linii w logu. Wyjątek: pełne strony konfliktu gita można scalić po kopii
     * oryginału. Inne uszkodzenia nadal blokują mutację, bez zapisu defaultów.
     *
     * Bootstrap (pierwszy start agenta) robimy WYŁĄCZNIE na POTWIERDZONYM „nie ma"
     * (`probeFile`), nie na gołym `exists() === false` - to ono kłamie na dyskach sieciowych.
     */
    private async _readRaw(repairOnDisk = true): Promise<MemoryState> {
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
            const recovered = await this._recoverConflict(raw, repairOnDisk);
            if (recovered) return recovered;
            log.warn('StateManager', `Uszkodzony JSON w ${this.statePath} — nie nadpisuję defaultami:`, e);
            throw new StateCorruptionError(this._agentName());
        }
    }

    private _agentName(): string {
        return this.statePath.split('/').at(-3) || 'agent';
    }

    /** Called under the mutation queue, or read-only by read(). Never caches recovery. */
    private async _recoverConflict(raw: string, repairOnDisk: boolean): Promise<MemoryState | null> {
        const sides = splitGitConflict(raw);
        if (!sides || !mergeStateConflict(sides.ours, sides.theirs)) return null;
        const adapter = this.vault.adapter;
        const activeDir = this.statePath.slice(0, this.statePath.lastIndexOf('/')) + '/sessions/active';
        let existing: string[] | undefined;
        try {
            const listing = await adapter.list?.(activeDir);
            if (listing?.files) existing = listing.files
                .map(path => path.startsWith(activeDir + '/') ? path.slice(activeDir.length + 1) : path)
                .filter(name => !name.includes('/'));
        } catch { /* Unknown listing means union only, never an empty directory. */ }
        const state = mergeStateConflict(sides.ours, sides.theirs, existing)!;
        if (!repairOnDisk) return { ...this.defaultState(), ...state };
        try {
            // Same backup-first, verbatim-copy pattern as core/runtime/settingsArmor.
            // Unlike daily settings snapshots, conflict copies are never rotated here.
            const dir = '.pkm-assistant/backups';
            if (!await adapter.exists(dir)) {
                if (!adapter.mkdir) return null;
                await adapter.mkdir(dir);
            }
            const agent = this._agentName().replace(/[^a-zA-Z0-9_-]/g, '_');
            const stamp = Date.now();
            let backupPath: string | null = null;
            for (let suffix = 0; suffix < 50; suffix++) {
                const candidate = `${dir}/state-${agent}-${stamp}${suffix ? `-${suffix}` : ''}.json.bak`;
                if (await probeFile(adapter, candidate) === 'missing') { backupPath = candidate; break; }
            }
            if (!backupPath) return null;
            await adapter.write(backupPath, raw);
            if (await adapter.read(backupPath) !== raw) return null;
            // A pull during the backup must not be overwritten by our stale reconstruction.
            if (await adapter.read(this.statePath) !== raw || !await this._writeRaw(state, raw)) {
                // One fresh mutation read only: no bootstrap or recursive conflict repair.
                const latest = await adapter.read(this.statePath);
                return { ...this.defaultState(), ...(JSON.parse(latest) as Partial<MemoryState>) };
            }
            log.warn('StateManager', `Naprawiono konflikt: ${this.statePath}; kopia: ${backupPath}`);
            return { ...this.defaultState(), ...state };
        } catch { return null; }
    }

    /** Raw write (no queue). Recovery additionally requires the exact backed-up source. */
    private async _writeRaw(state: Partial<MemoryState> | null | undefined, expectedRaw?: string): Promise<boolean> {
        const content = JSON.stringify({
            ...this.defaultState(),
            ...(state || {})
        }, null, 2) + '\n';
        if (expectedRaw !== undefined) {
            // Fail closed on a changed source or read error. No further read before write.
            // The adapter has no compare-and-swap; the remaining read/write gap is unavoidable.
            if (await this.vault.adapter.read(this.statePath) !== expectedRaw) return false;
        } else {
            // This read only avoids redundant writes. The caller already supplied the state;
            // uncertainty here must not turn a successful mutation into a failed operation.
            try {
                const previous: unknown = JSON.parse(await this.vault.adapter.read(this.statePath));
                if (equalJson(previous, JSON.parse(content))) return true;
            } catch {
                // Missing/unreadable/corrupt comparison input: retain the original write contract.
                // Mutation reads remain fail-closed in _readRaw, before any state is changed.
            }
        }
        await this.vault.adapter.write(this.statePath, content);
        return true;
    }

    /**
     * Publiczny odczyt istniejącego pliku NIC nie zapisuje. Konflikt scala tylko W PAMIĘCI;
     * inne uszkodzenia degradują się do defaultów z logiem. Bootstrap brakującego pliku
     * zachowuje historyczny zapis defaultów. Ten kontrakt trzyma `consolidationRunner`:
     * uszkodzony `.state.json` ma spaść na próg z ustawień, a nie wywrócić konsolidacji.
     * Groźna była nie sama degradacja, tylko jej UTRWALENIE przez mutator (patrz `_readRaw`).
     */
    async read(): Promise<MemoryState> {
        try {
            return await this._readRaw(false);
        } catch (e) {
            log.warn('StateManager', `Defaulty TYLKO w pamięci (nic nie idzie na dysk): ${this.statePath}`, e);
            return this.defaultState();
        }
    }

    async write(state: Partial<MemoryState> | null | undefined): Promise<void> {
        await this._enqueue(() => this._writeRaw(state));
    }

    /**
     * Serializowany read-modify-write dla wołaczy spoza tej klasy.
     *
     * `read()` + mutacja + `write()` po stronie wołacza to była ta sama klasa błędu, przed którą
     * broni `_writeChain`: odczyt leci POZA kolejką, a `write()` NADPISUJE cały plik,
     * więc równoległy `markArchived`/`addActiveSession` (autozapis czatu) był po cichu cofany.
     * `_resetArchiveCounter` w konsolidacji woła się raz na KAŻDĄ zaakceptowaną paczkę L1 -
     * 12 paczek = 12 okien wyścigu w czasie, gdy user normalnie pisze.
     *
     * Mutator MUTUJE podany obiekt (nie buduje nowego): `_readRaw` merguje go z `defaultState`,
     * więc spread zachowuje klucze spoza schematu (`brain_notes_limit` = decyzja usera; osierocony
     * `notes_count_at_last_check` z starszych plików też przeżywa merge, tylko już nikt go nie
     * pisze ani nie czyta - pole wypadło ze schematu).
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

/** JSON objects ignore key order; arrays retain order. Includes unknown state fields. */
function equalJson(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b)
            && a.length === b.length && a.every((value: unknown, i: number) => equalJson(value, b[i]));
    }
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
        && keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && equalJson(left[key], right[key]));
}
