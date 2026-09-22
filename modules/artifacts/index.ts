/**
 * modules/artifacts — public API
 *
 * Artefakty żywe: notatka = źródło prawdy (frontmatter + treść), agent czyta sparsowany JSON
 * i pisze patchami, user zatwierdza w notatce. Silnik: parser + store + typy + guziki + przywołanie.
 * Migrator (`migrate_json_to_notes.ts`) przenosi stare JSONy artefaktów na notatki.
 * Patrz CLAUDE.md.
 *
 * Sporo symboli bez konsumenta spoza modułu nie jest eksportowanych z barrela (stałe
 * typów/statusów/ścieżek + `computeArtifactButtons`/`CLOSED_STATUS`/
 * `buildSummonMessage`/`parseArtifactBlockId`/`PROTECTED_FIELDS`/`ARTIFACT_CONTEXT_MAX_CHARS`/
 * cały `artifactStatuses.ts` - `statusRole`/`statusLiteral`/`statusLocaleOf`/`pendingStatusOf`/
 * `closedStatusOf`/`acceptedStatusOf`/`remarksStatusOf`, rejestr statusów bilingwalnych PL/EN).
 * Definicje ŻYJĄ w bebechach - używają ich `artifactBlocks`/`artifactSummon`/`ArtifactStore`/
 * `artifactButtons`/`basesView`/`artifactStatusLabel`/`ArtifactTypeLoader` u siebie, a testy
 * deep-importują pliki wprost. Wyjątek: `isClosedStatus` JEST w barrelu (patrz niżej) - jedyny
 * konsument spoza modułu to `modules/agents/AgentManager.ts` (filtr „artefakty w toku" dla
 * indeksu promptu musi rozpoznawać oba języki + typ własny, nie hardkodowany literał PL).
 */

// Silnik artefaktów żywych (pure). `TodoTool` z modules/tools bierze go przez TEN barrel.
export { parseArtifact, applyPatch } from './artifactParser.js';
export type { ArtifactFrontmatter, ArtifactItem, ArtifactPatchError, ArtifactPatchOp, ArtifactScalar, ArtifactSection, ArtifactType, ArtifactTypeField, ParsedArtifact, ThinArtifact } from './types.js';
export { ArtifactTypeLoader } from './ArtifactTypeLoader.js';
// Domknięcie artefaktu wg statusu, oba języki + fallback pozycyjny typu własnego - jedyny
// konsument spoza modułu: `modules/agents/AgentManager.ts` (indeks „artefakty w toku" w prompcie).
export { isClosedStatus } from './artifactButtons.js';
// Nazwy sekcji artefaktów: rejestr + selektor po języku. W barrelu, bo wypisują je TAKŻE
// `modules/tools/toolAliases.ts` (aliasy `plan_review`/`idea_review`) oraz `modules/prompts`
// (`decisionTree.ts` - placeholdery w regułach, `artifactIndex.ts` - blok aktywnego artefaktu).
// Rozjazd nagłówka z szablonem typu daje ciche `not_found` przy patchu.
export { ARTIFACT_SECTION_NAMES, artifactSection } from './artifactSections.js';
export type { ArtifactSectionKey } from './artifactSections.js';
// Etykieta statusu DLA OCZU usera (blok w notatce + panel profilu agenta + picker `@` w czacie) — status w pliku/
// prompcie zostaje surowym identyfikatorem silnika. Patrz artifactStatusLabel.ts.
export { artifactStatusLabel } from './artifactStatusLabel.js';
// DEFAULT_ARTIFACTS_FOLDER eksportowany z barrela: konsumuje go src/main.js
// (komenda generate_artifacts_base).
export { ArtifactStore, DEFAULT_ARTIFACTS_FOLDER } from './ArtifactStore.js';
export { migrateJsonArtifactsToNotes } from './migrate_json_to_notes.js';

// Przywołanie agenta + guziki w notatce (rejestracja code-blocku):
export { summonAgentForArtifact, activateArtifactInChat } from './artifactSummon.js';
// Powierzchnia pluginu, jakiej żądają oba wejścia przywołania (wołacz spoza modułu
// nazywa nią swój cast na granicy `AppLike` vs `App`).
export type { SummonPlugin } from './artifactSummon.js';
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
