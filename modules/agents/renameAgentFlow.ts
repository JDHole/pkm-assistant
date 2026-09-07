/**
 * renameAgentFlow — CAŁA logika dysku (kolizja + YAML + folder pamięci) kroku „zmień nazwę agenta"
 * wołanego z `AgentManager.renameAgent`.
 *
 * K5 (AUD-code-review-024, CRITICAL): nazwa agenta jest kluczem obcym do TRZECH niezależnych
 * bytów — plik YAML, folder pamięci na dysku (`.pkm-assistant/agents/<safeName>/`) i klucze map
 * runtime'u (`agents`/`agentMemories`/`agentHistories`). Zwykły `agent.update({name})` mutował
 * tylko obiekt w pamięci pod STARYM kluczem mapy, `AgentLoader.saveAgent` liczył nową ścieżkę
 * z nowej nazwy i pisał BEZWARUNKOWO (bez sprawdzenia kolizji), a stary plik/folder nigdy nie
 * znikał — literówka w polu nazwy cicho nadpisywała cudzy YAML.
 *
 * Plik jest CZYSTY — zero `obsidian`, zero DOM (wzorzec `subTaskPanelModel.ts` /
 * `migrationReviewFlow.ts`). `AgentManager.renameAgent` transytywnie ciągnie `obsidian` (import
 * `Notice`), więc testy AVA nie mają jego atrapy — wydzielenie tej decyzji do osobnego,
 * obsidian-free pliku jest jedynym sposobem, żeby przetestować ją PRAWDZIWYM wykonaniem
 * (wstrzykiwana atrapa vault adaptera) zamiast testu po źródle. Przekluczowanie map w pamięci
 * (`agents`/`agentMemories`/`agentHistories`) i reinicjalizacja `AgentMemory` zostają w
 * `AgentManager` — potrzebują żywego stanu klasy, nie tylko dysku.
 *
 * Kolejność świadoma: folder pamięci PRZED plikiem YAML. Memory ma więcej plików (większa szansa
 * na częściowy pad kopiowania) — pad na tym etapie przerywa rename z komunikatem i ZERO innych
 * zmian (agent.name/plik YAML nietknięte — zero połowicznego stanu). Pad zapisu nowego YAML
 * (rzadszy — jeden plik) cofa nazwę agenta i sprząta świeżo skopiowany folder pamięci.
 *
 * F02 (AUD-code-review-024/025/030, druga runda 2026-08-30) — trzy dziury udowodnione na atrapie
 * vaulta przez recenzenta, wszystkie tutaj:
 *   (1) **Ten sam slug** (np. „badacz"→„Badacz") ma WŁASNĄ, wcześniejszą gałąź — bez niej ścieżka
 *       kolizji liczy `newFilePath`/`newMemoryDir` identyczne ze starymi, więc `exists()` widzi
 *       WŁASNY plik/folder i albo fałszywie odmawia (self-collision), albo — gdyby ktoś pominął
 *       ten check — `copyFolder(src→src)` + `rmdir(src)` skasowałoby właśnie skopiowaną pamięć.
 *   (2) **Bramka kolizji jest fail-CLOSED.** Dawny `catch {}` przy `exists()` traktował brak
 *       odpowiedzi adaptera jak "pliku nie ma" i PRZEPUSZCZAŁ rename — teraz pad odpowiedzi na
 *       *którymkolwiek* z dwóch sprawdzeń (plik YAML / folder pamięci) to odmowa
 *       (`collision_check_failed`), nigdy ciche domyślenie się braku kolizji.
 *   (3) **Osierocony folder pamięci pod nowym slugiem też jest kolizją.** Rename sprawdzał tylko
 *       plik YAML — folder pamięci po dawno skasowanym agencie (ten sam slug) byłby cicho
 *       wchłonięty przez `copyFolder`, mieszając cudze notatki z nowymi. `newMemoryDirTouched`
 *       pilnuje też, żeby rollback (na pad kopiowania/zapisu) kasował WYŁĄCZNIE folder, który
 *       ta operacja sama założyła.
 * Do tego (6a) skrzynka komunikatora (`.pkm-assistant/komunikator/inbox/<slug>/`) wędruje razem
 * z agentem — BEST-EFFORT, po potwierdzonym sukcesie reszty, bez wpływu na wynik rename'u.
 */

/** Fragment kontraktu vault adaptera, na którym stoi rename (patrz Obsidian `DataAdapter`). */
export interface RenameAgentVaultAdapter {
    exists(path: string): Promise<boolean>;
    remove(path: string): Promise<void>;
    rmdir(path: string, recursive?: boolean): Promise<void>;
}

/** Fragment kontraktu `Agent`, na którym stoi rename (prawdziwy `Agent` go spełnia bez zmian). */
export interface RenameAgentLike {
    name: string;
    isBuiltIn: boolean;
    filePath: string | null;
}

export type RenameAgentFailureReason =
    | 'empty_name'
    | 'built_in'
    | 'name_collision'
    | 'collision_check_failed'
    | 'memory_move_failed'
    | 'save_failed';

export interface RenameAgentResult {
    ok: boolean;
    reason?: RenameAgentFailureReason;
    filePath?: string;
    /**
     * F02 punkt 6a — skrzynka komunikatora (`.pkm-assistant/komunikator/inbox/<slug>/`) to
     * BEST-EFFORT: pad przenosin NIE cofa udanego rename'u agenta (YAML+pamięć już potwierdzone).
     * `true` = próba przenosin była i nie powiodła się w całości — stara skrzynka może zostać
     * osierocona pod dawnym slugiem. Caller loguje to głośno (patrz `AgentManager.renameAgent`).
     */
    inboxMoveFailed?: boolean;
}

export interface RenameAgentDeps {
    vaultAdapter: RenameAgentVaultAdapter;
    /** `.pkm-assistant/agents` (AgentLoader.agentsPath) — baza plików `<safeName>.yaml`. */
    agentsPath: string;
    /** Kolizja w PAMIĘCI (mapa `AgentManager.agents`) — obejmuje built-iny i customy. */
    hasAgentName: (name: string) => boolean;
    /** `AgentLoader.saveAgent` związany z tym agentem — ZAKŁADA agenta custom (nie built-in). */
    saveAgent: (agent: RenameAgentLike) => Promise<string>;
    /** `AgentManager._copyFolderRecursive` — rekurencyjne kopiowanie przez vault adapter. */
    copyFolder: (src: string, dest: string) => Promise<void>;
}

const toSafeName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '_');

const memoryDirFor = (safeName: string): string => `.pkm-assistant/agents/${safeName}`;

/**
 * F02 punkt 6a — skrzynka `KomunikatorManager` liczy slug identycznie (`_getSafeName`, ten sam
 * wzór `toLowerCase().replace(/[^a-z0-9]/g,'_')`), więc ścieżkę odtwarzamy tu wprost zamiast
 * przez zależność modułową (agents→komunikator byłby importem w GÓRĘ drzewa — nielegalny).
 */
const komunikatorInboxDirFor = (safeName: string): string => `.pkm-assistant/komunikator/inbox/${safeName}`;

/**
 * @param agent instancja agenta (MUTOWANA w miejscu przy sukcesie: `name` + `filePath`).
 * @param newName żądana nowa nazwa (surowa — funkcja trimuje).
 * @param deps wstrzyknięte zależności dyskowe/runtime.
 * @returns {Promise<RenameAgentResult>} `ok:false` = ZERO zmian na dysku i na `agent` (poza
 *   przypadkiem `save_failed`, gdzie robimy best-effort rollback skopiowanego folderu pamięci).
 */
export async function renameAgentOnDisk(
    agent: RenameAgentLike,
    newName: string,
    deps: RenameAgentDeps,
): Promise<RenameAgentResult> {
    if (agent.isBuiltIn) return { ok: false, reason: 'built_in' };

    const trimmed = (newName || '').trim();
    if (!trimmed) return { ok: false, reason: 'empty_name' };
    if (trimmed === agent.name) return { ok: true, filePath: agent.filePath || undefined };

    const oldName = agent.name;
    const oldSafeName = toSafeName(oldName);
    const newSafeName = toSafeName(trimmed);

    // (a) Ten sam slug — np. „badacz" → „Badacz" (tylko wielkość liter, albo znak, który
    // `toSafeName` i tak odrzuca). To JEDEN byt na dysku pod NIEZMIENIONĄ ścieżką: zero
    // przenosin folderu pamięci (to dosłownie ten sam folder) i zero bramki kolizji z SAMYM
    // SOBĄ — `newFilePath`/`newMemoryDir` policzone niżej byłyby identyczne ze starymi, więc
    // `exists()` zawsze zwróciłby `true` i fałszywie zablokował rename (albo — gdyby ktoś
    // pominął ten check — copyFolder(src→src) + rmdir(src) skasowałoby właśnie skopiowaną
    // pamięć, bo źródło i cel to ta sama ścieżka).
    if (newSafeName === oldSafeName) {
        agent.name = trimmed;
        try {
            const savedPath = await deps.saveAgent(agent);
            agent.filePath = savedPath;
            return { ok: true, filePath: savedPath };
        } catch {
            agent.name = oldName;
            return { ok: false, reason: 'save_failed' };
        }
    }

    const oldMemoryDir = memoryDirFor(oldSafeName);
    const newMemoryDir = memoryDirFor(newSafeName);
    const oldFilePath = agent.filePath;

    // Kolizja: nazwa zajęta w pamięci (built-in LUB custom), plik pod nowym slugiem już istnieje
    // na dysku (osierocony plik), ALBO osierocony folder pamięci po skasowanym agencie pod tym
    // samym slugiem (cudze notatki — ciche wchłonięcie byłoby gorsze niż odmowa). Fail-CLOSED:
    // brak odpowiedzi adaptera na KTÓREKOLWIEK z dwóch sprawdzeń dyskowych = odmowa, NIGDY ciche
    // przepuszczenie (dawniej catch = "nie ma pliku", czyli fail-OPEN).
    const newFilePath = `${deps.agentsPath}/${newSafeName}.yaml`;
    let fileCollision: boolean;
    let memoryDirCollision: boolean;
    try {
        fileCollision = await deps.vaultAdapter.exists(newFilePath);
        memoryDirCollision = await deps.vaultAdapter.exists(newMemoryDir);
    } catch {
        return { ok: false, reason: 'collision_check_failed' };
    }
    if (deps.hasAgentName(trimmed) || fileCollision || memoryDirCollision) {
        return { ok: false, reason: 'name_collision' };
    }

    // (d) Folder pamięci: create-before-delete. Pad przenosin = przerwij, zero połowicznego stanu.
    // `newMemoryDirTouched` pilnuje, żeby rollback kasował WYŁĄCZNIE folder, który sam założył —
    // kolizja powyżej już wykluczyła osierocony `newMemoryDir` sprzed tej operacji, ale flaga
    // zostaje jako druga warstwa (np. gdyby ktoś kiedyś złagodził bramkę kolizji).
    let memoryDirExisted = false;
    let newMemoryDirTouched = false;
    try {
        memoryDirExisted = await deps.vaultAdapter.exists(oldMemoryDir);
        if (memoryDirExisted) {
            newMemoryDirTouched = true;
            await deps.copyFolder(oldMemoryDir, newMemoryDir);
        }
    } catch {
        if (newMemoryDirTouched) {
            try {
                await deps.vaultAdapter.rmdir(newMemoryDir, true);
            } catch {
                // best-effort sprzątanie częściowej kopii.
            }
        }
        return { ok: false, reason: 'memory_move_failed' };
    }

    // (c) YAML: zapis pod NOWĄ ścieżką, kasacja starego DOPIERO po potwierdzonym zapisie.
    agent.name = trimmed;
    let savedPath: string;
    try {
        savedPath = await deps.saveAgent(agent);
    } catch {
        agent.name = oldName;
        if (newMemoryDirTouched) {
            try {
                await deps.vaultAdapter.rmdir(newMemoryDir, true);
            } catch {
                // best-effort — stara pamięć (oldMemoryDir) nigdy nie została ruszona.
            }
        }
        return { ok: false, reason: 'save_failed' };
    }
    agent.filePath = savedPath;

    if (oldFilePath && oldFilePath !== savedPath) {
        try {
            await deps.vaultAdapter.remove(oldFilePath);
        } catch {
            // Best-effort: stary plik może zostać osierocony (rzadki pad I/O). Rename jest już
            // uznawany za udany (nowa tożsamość + pamięć potwierdzone) — caller loguje to głośno.
        }
    }
    if (memoryDirExisted) {
        try {
            await deps.vaultAdapter.rmdir(oldMemoryDir, true);
        } catch {
            // stary folder może zostać osierocony (nieszkodliwe — nic już go nie czyta).
        }
    }

    // (e) Skrzynka komunikatora — F02 punkt 6a, BEST-EFFORT. Rename agenta jest już policzony
    // jako udany (YAML + pamięć potwierdzone); pad tutaj NIE cofa niczego powyżej, tylko
    // zgłasza się w zwrotce (`inboxMoveFailed`), żeby caller mógł zalogować to głośno.
    let inboxMoveFailed = false;
    try {
        const oldInboxDir = komunikatorInboxDirFor(oldSafeName);
        const inboxExisted = await deps.vaultAdapter.exists(oldInboxDir);
        if (inboxExisted) {
            const newInboxDir = komunikatorInboxDirFor(newSafeName);
            // Re-review F02: bramka na CEL — skrzynka po skasowanym agencie pod nowym slugiem
            // (deleteAgent kasuje tylko YAML) nie może zostać wchłonięta: kopiowanie do
            // istniejącego celu wlałoby cudzą pocztę do skrzynki przemianowanego agenta.
            // Best-effort jak cała sekcja: zgłaszamy inboxMoveFailed, obie skrzynki nietknięte.
            if (await deps.vaultAdapter.exists(newInboxDir)) {
                inboxMoveFailed = true;
            } else {
                await deps.copyFolder(oldInboxDir, newInboxDir);
                await deps.vaultAdapter.rmdir(oldInboxDir, true);
            }
        }
    } catch {
        inboxMoveFailed = true;
    }

    return { ok: true, filePath: savedPath, ...(inboxMoveFailed ? { inboxMoveFailed: true } : {}) };
}
