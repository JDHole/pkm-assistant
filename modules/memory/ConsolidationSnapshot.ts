/**
 * Sprzątaczka snapshotów konsolidacji.
 *
 * **Tworzenie i odtwarzanie snapshotów SKASOWANE (D6, 2026-07-30).** `create()` + `restore()`
 * (+ prywatne `_collect`/`_ensureParent`) obsługiwały wyłącznie stary, blokujący
 * `ArchiveWorkflow.run()`, który tam zapisywał od razu po propozycji. Ten tor nie miał już
 * produkcyjnego wołacza — trzymały go testy. Dzisiejszy przebieg (`runWithRun`) snapshotu
 * ŚWIADOMIE nie robi: powstawałby na starcie generacji, a zapisy dzieją się po decyzjach usera
 * (czasem godziny później), więc odtworzenie cofnęłoby bieżącą rozmowę; do tego operacje
 * konsolidacji są create-before-delete, a kopia CAŁEJ pamięci w jednym JSON-ie to własny punkt
 * awarii. Klasa została po to, żeby posprzątać kopie zostawione przez starą wersję pluginu.
 */

/**
 * Adapter FS vaulta w zakresie, jakiego potrzebuje sprzątaczka. Typowany STRUKTURALNIE —
 * `AgentMemory` jest jeszcze w `.js` (kontrakt kampanii TS: nie czekamy na konwersję).
 */
export interface SnapshotVaultAdapterLike {
    exists(path: string): Promise<boolean>;
    list(path: string): Promise<{ files?: string[]; folders?: string[] } | null>;
    remove?(path: string): Promise<void>;
}

/** Fragment `AgentMemory`, na którym stoi retencja snapshotów. */
export interface SnapshotAgentMemoryLike {
    basePath: string;
    vault: { adapter: SnapshotVaultAdapterLike };
}

export class ConsolidationSnapshot {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3).
    declare agentMemory: SnapshotAgentMemoryLike;
    declare snapshotRoot: string;

    constructor(agentMemory: SnapshotAgentMemoryLike) {
        this.agentMemory = agentMemory;
        this.snapshotRoot = `${agentMemory.basePath}/.consolidation_snapshots`;
    }

    /**
     * Retencja snapshotów: zostawia `keep` najnowszych, resztę kasuje.
     *
     * Nazwa pliku zaczyna się od znacznika czasu ISO (z `:`/`.` zamienionymi na `-`), więc
     * sortowanie leksykalne malejąco = od najnowszego. Bez tego folder `.consolidation_snapshots/`
     * rósł bez końca — każda kopia to CAŁA pamięć agenta wrzucona do jednego JSON-a.
     *
     * Nigdy nie rzuca: sprzątanie nie ma prawa ubić konsolidacji.
     */
    async prune(keep: number = 3): Promise<{ removed: number }> {
        const limit = Math.max(0, Number(keep) || 0);
        const adapter = this.agentMemory.vault.adapter;
        let listed: { files?: string[]; folders?: string[] } | null;
        try {
            if (!(await adapter.exists(this.snapshotRoot))) return { removed: 0 };
            listed = await adapter.list(this.snapshotRoot);
        } catch {
            return { removed: 0 };
        }

        const prefix = `${this.snapshotRoot}/`;
        // Kasujemy WYŁĄCZNIE pliki o nazwie, którą sami nadajemy w create():
        // `<ISO z : i . jako ->_<label>.tar.gz`. Plik wrzucony do tego folderu ręcznie
        // (notatka, własny backup) nie może ani zostać skasowany, ani zająć slotu retencji.
        const SNAPSHOT_NAME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_.+\.tar\.gz$/;
        const snapshots = (listed?.files || [])
            .filter(path => {
                if (!path.startsWith(prefix)) return false;
                const name = path.slice(prefix.length);
                return !name.includes('/') && SNAPSHOT_NAME_RE.test(name);
            })
            .sort((a, b) => b.localeCompare(a));

        let removed = 0;
        for (const path of snapshots.slice(limit)) {
            try {
                if (!adapter.remove) break;
                await adapter.remove(path);
                removed++;
            } catch { /* best-effort per plik */ }
        }
        return { removed };
    }
}
