/**
 * modules/artifacts — public API
 *
 * Artefakty żywe: notatka = źródło prawdy (frontmatter + treść), agent czyta sparsowany JSON
 * i pisze patchami, user zatwierdza w notatce. Silnik: parser + store + typy + guziki + przywołanie.
 * Migrator (`migrate_json_to_notes.ts`) przenosi stare JSONy artefaktów na notatki.
 * Patrz CLAUDE.md.
 *
 * 18 symboli bez konsumenta spoza modułu nie jest eksportowanych z barrela (stałe
 * typów/statusów/ścieżek + `computeArtifactButtons`/`isClosedStatus`/`CLOSED_STATUS`/
 * `buildSummonMessage`/`parseArtifactBlockId`/`PROTECTED_FIELDS`/`ARTIFACT_CONTEXT_MAX_CHARS`).
 * Definicje ŻYJĄ w bebechach - używają ich `artifactBlocks`/`artifactSummon`/`ArtifactStore`
 * u siebie, a testy deep-importują pliki wprost.
 */

// Silnik artefaktów żywych (pure). `TodoTool` z modules/tools bierze go przez TEN barrel.
export { parseArtifact, applyPatch } from './artifactParser.js';
export type { ArtifactFrontmatter, ArtifactItem, ArtifactPatchError, ArtifactPatchOp, ArtifactScalar, ArtifactSection, ArtifactType, ArtifactTypeField, ParsedArtifact, ThinArtifact } from './types.js';
export { ArtifactTypeLoader } from './ArtifactTypeLoader.js';
// DEFAULT_ARTIFACTS_FOLDER eksportowany z barrela: konsumuje go src/main.js
// (komenda generate_artifacts_base).
export { ArtifactStore, DEFAULT_ARTIFACTS_FOLDER } from './ArtifactStore.js';
export { migrateJsonArtifactsToNotes } from './migrate_json_to_notes.js';

// Przywołanie agenta + guziki w notatce (rejestracja code-blocku):
export { summonAgentForArtifact, activateArtifactInChat } from './artifactSummon.js';
export { registerArtifactBlocks } from './artifactBlocks.js';

// Czyste helpery widoku (zakładka panelu + segment slim bara):
export {
    sortArtifactsForView,
    buildArtifactPickerItems,
    toggleTypeName,
    buildTypeCheckboxRows,
} from './artifactViewHelpers.js';

// Generator pliku `.base` (Obsidian Bases) z widokami artefaktów:
export {
    buildArtifactsBaseContent,
    buildArtifactsBasePath,
    ARTIFACTS_BASE_FILENAME,
} from './basesView.js';
