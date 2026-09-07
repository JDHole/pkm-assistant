/**
 * modules/artifacts — public API
 *
 * Artefakty żywe (E2.9): notatka = źródło prawdy (frontmatter + treść), agent czyta sparsowany JSON
 * i pisze patchami, user zatwierdza w notatce. Silnik: parser + store + typy + guziki + przywołanie.
 * Stary świat (ArtifactManager/PlanReviewModal/ProgressModal + JSON w .pkm-assistant/artifacts/*.json)
 * SKASOWANY w fazie D — migrator przenosi stare JSONy na notatki.
 * Patrz CLAUDE.md.
 *
 * S30 Z4 (przycinka powierzchni): 18 symboli bez konsumenta spoza modułu wypadło z barrela
 * (stałe typów/statusów/ścieżek + `computeArtifactButtons`/`isClosedStatus`/`CLOSED_STATUS`/
 * `buildSummonMessage`/`parseArtifactBlockId`/`PROTECTED_FIELDS`/`ARTIFACT_CONTEXT_MAX_CHARS`).
 * Definicje ŻYJĄ w bebechach — używają ich `artifactBlocks`/`artifactSummon`/`ArtifactStore`
 * u siebie, a testy deep-importują pliki wprost.
 */

// E2.9 (Artefakty żywe) — silnik (pure). `TodoTool` z modules/tools bierze go przez TEN barrel.
export { parseArtifact, applyPatch } from './artifactParser.js';
export type { ArtifactFrontmatter, ArtifactItem, ArtifactPatchError, ArtifactPatchOp, ArtifactScalar, ArtifactSection, ArtifactType, ArtifactTypeField, ParsedArtifact, ThinArtifact } from './types.js';
export { ArtifactTypeLoader } from './ArtifactTypeLoader.js';
// DEFAULT_ARTIFACTS_FOLDER wrocil do barrela po merge S30+S32: konsumuje go
// src/main.js (komenda generate_artifacts_base, S32 Z7).
export { ArtifactStore, DEFAULT_ARTIFACTS_FOLDER } from './ArtifactStore.js';
export { migrateJsonArtifactsToNotes } from './migrate_json_to_notes.js';

// E2.9 FAZA B — przywołanie agenta + guziki w notatce (rejestracja code-blocku):
export { summonAgentForArtifact, activateArtifactInChat } from './artifactSummon.js';
export { registerArtifactBlocks } from './artifactBlocks.js';

// E2.9 FAZA C — czyste helpery widoku (zakładka panelu + segment slim bara):
export {
    sortArtifactsForView,
    buildArtifactPickerItems,
    toggleTypeName,
    buildTypeCheckboxRows,
} from './artifactViewHelpers.js';

// S32 Z7 — generator pliku `.base` (Obsidian Bases) z widokami artefaktów:
export {
    buildArtifactsBaseContent,
    buildArtifactsBasePath,
    ARTIFACTS_BASE_FILENAME,
} from './basesView.js';
