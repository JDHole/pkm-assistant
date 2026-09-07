/**
 * migrationReviewFlow — CAŁA logika decyzyjna kroku „przegląd migracji Memory v2→v3"
 * wołanego z `AgentManager._initializeMemoryForAgent`.
 *
 * WERDYKT WŁAŚCICIELA (2026-08-27, AUD-docs-051): „Cancel ma naprawdę anulować". Do tej
 * naprawy `AgentManager` wołał `migration.run()` DRUGI RAZ z `{interactive:false}`, gdy user
 * odrzucił modal review (Cancel ALBO zamknięcie przez X/Esc — `MigrationModal` oddaje dla
 * obu dokładnie ten sam `{action:'cancel'}`) — czyli plan migracji i tak był stosowany, mimo
 * jawnej odmowy. Funkcja niżej jest tym krokiem w całości: sprawdza potrzebę migracji, woła
 * `run()` DOKŁADNIE RAZ, i przy odrzuceniu wyłącznie informuje wołacza przez `onCancelled` —
 * bez żadnego automatycznego powtórzenia, w żadnym trybie.
 *
 * Plik jest CZYSTY — zero `obsidian`, zero DOM, zero i18n (wzorzec `subTaskPanelModel.ts`
 * z `modules/sub-agents/`). Powód jest identyczny: `AgentManager.ts` transytywnie ciągnie
 * `obsidian` przez `MigrationModal.js` (bazowa klasa `Modal`), a testy AVA nie mają jego
 * atrapy poza harnessem (esbuild alias) — `AgentManager` nie wstaje w gołym Node. Wydzielenie
 * tej decyzji do osobnego, obsidian-free pliku jest jedynym sposobem, żeby przetestować ją
 * PRAWDZIWYM wykonaniem (wstrzykiwana atrapa silnika migracji) zamiast testu po źródle albo
 * DOM-a. `migration` jest typowany STRUKTURALNIE — prawdziwy `MigrationV3` go spełnia bez
 * żadnej zmiany, testy wstrzykują lekką atrapę.
 */

/** Fragment kontraktu `MigrationV3`, na którym stoi ten krok (patrz `modules/memory/MigrationV3.ts`). */
export interface MigrationReviewEngine {
    needsMigration(): Promise<boolean>;
    run(options?: { interactive?: boolean }): Promise<{ cancelled?: boolean } | null | undefined>;
}

/**
 * @param migration silnik migracji (prawdziwy `MigrationV3` albo atrapa w testach).
 * @param agentName nazwa agenta, dla którego trwa inicjalizacja pamięci — czysto informacyjna,
 *   nie wpływa na decyzję.
 * @param interactive czy pokazać modal review (`Boolean(plugin?.app)` u wołacza; `false` =
 *   review headless, np. w harnessie/testach — wtedy `MigrationV3._reviewPlan` w ogóle nie
 *   pyta i `cancelled` nigdy nie wraca `true`).
 * @param onCancelled wołane DOKŁADNIE wtedy, gdy user odrzucił modal (Cancel ALBO X/Esc).
 *   Migracja NIE jest wtedy stosowana w ŻADNYM trybie — `needsMigration()` zostanie `true`
 *   przy najbliższym starcie (`brain/` nigdy nie powstał), więc user zobaczy modal ponownie
 *   przy kolejnym uruchomieniu Obsidiana. Stan na dysku poza jednorazowym backupem
 *   (`memory.v2.backup/`, robionym PRZED pokazaniem modala — `MigrationV3.run`) zostaje
 *   nietknięty: brak `applyPlan()`, brak nowego `brain/`, `brain.md` bez zmian.
 */
export async function runMigrationReview(
    migration: MigrationReviewEngine,
    agentName: string,
    interactive: boolean,
    onCancelled: (agentName: string) => void,
): Promise<void> {
    if (!(await migration.needsMigration())) return;
    const result = await migration.run({ interactive });
    if (result?.cancelled) {
        onCancelled(agentName);
    }
}
