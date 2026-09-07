/**
 * modules/memory — publiczne API modułu pamięci agenta.
 *
 * To są JEDYNE drzwi na zewnątrz modułu. Reszta pluginu importuje stąd, nie z bebechów.
 * Szczegóły: CLAUDE.md w tym folderze.
 *
 * S30 Z4 (przycinka powierzchni): 24 symbole bez ANI JEDNEGO konsumenta spoza modułu
 * wypadły z barrela — helpery listujące (`listBrainNotes`/`listActiveSessions`/
 * `listArchiveSessions`), `getSafeAgentName`, `StateManager`, cały `BrainIndex`
 * poza `parseNaTerazSections`/`naTerazSectionKey`, `ConsolidationSnapshot`,
 * `normalizeUsage`/`MAX_STALL_RETRIES`, klasa `MemoryOpsCenter` (singleton `memoryOpsCenter`
 * ZOSTAJE), część etykiet przebiegu (`stepErrorText`/`runDurationMs`/`formatTokens`/
 * `formatCostUsd`), `estimateCostUsd`, `STREAM_ERROR_CODES`, `formatToMarkdown`/
 * `parseSessionFile`. Definicje ŻYJĄ w bebechach — moduł woła je u siebie (`AgentMemory`
 * listuje przez własne metody, `ArchiveWorkflow` czyta kody błędów streamu), a testy
 * deep-importują pliki wprost.
 *
 * Re-eksport `sanitizeToolTranscript` z `modules/agent-loop` też OUT — `chat/RollingWindow`
 * (jedyny wołacz) importuje go teraz wprost z barrela agent-loop, czyli z jego DOMU.
 */

// S30 Z4 + S32: helpery list* wyciete (konsumenci wolaja METODY agentMemory);
// parseBrainLog zostaje — importuje go karta „Log wpisow" (agents/profile/profile_memory.js).
export { AgentMemory, parseBrainLog } from './AgentMemory.js';
import type { ArchiveSessionInfo } from './AgentMemory.js';
/** Sesje z `sessions/archive` bez stempla `covered_by_l1` — materiał na nową paczkę L1. */
export async function listUncoveredArchiveSessions(
    agentMemory: { listUncoveredArchiveSessions?: () => Promise<ArchiveSessionInfo[]> } | null | undefined,
): Promise<ArchiveSessionInfo[]> {
    return agentMemory?.listUncoveredArchiveSessions?.() || [];
}
export {
    MemoryAccessGuard,
    MEMORY_V3_ERROR_CODES,
    isValidNoteType,
    makeMemoryNoteFilename
} from './MemoryAccessGuard.js';
// E2.7 W3 (K4): pure idle-consolidation decision helper (wired in modules/chat).
export { IdleScheduler } from './IdleScheduler.js';
export { SaveSessionWorkflow } from './SaveSessionWorkflow.js';
export { ArchiveWorkflow } from './ArchiveWorkflow.js';
// E2.8 D2 (S22): „Na teraz" short-term brain.md sections — pure helpery czytane przez UI/narzędzia.
export { parseNaTerazSections, naTerazSectionKey } from './BrainIndex.js';
// S29 Z2 (Puls pamięci): stan przebiegu konsolidacji + rejestr jednego aktywnego przebiegu.
// Konsumenci: ArchiveWorkflow (silnik) oraz UI z Z4-Z6 (modal przebiegu, pasek statusu, notice).
export {
    ConsolidationRun,
    buildPlan as buildConsolidationPlan,
    STEP_STATUS,
    STEP_KIND,
    // normalizeUsage wrocil do barrela po merge S30+S32: konsumuje go
    // modules/chat/slash-commands/save_session.js (wpis kosztu Z4.3).
    normalizeUsage,
} from './ConsolidationRun.js';
export { default as memoryOpsCenter, OPS_EVENT } from './MemoryOpsCenter.js';
// S29 Z4-Z5: warstwa OPISOWA przebiegu (etykiety/ikony/czas/koszt/podsumowanie). Czysta, bez DOM.
// Dzielona przez pasek statusu (core/PKMEnv.js) i modal przebiegu (modules/shell) — patrz nagłówek
// pliku: `core/` nie może importować z `modules/shell` (cykl przez barrel chatu), więc wspólnym
// domem jest memory. Silnik (ConsolidationRun/ArchiveWorkflow) pozostaje i18n-free.
export {
    stepLabel,
    stepDetail,
    stepStatusIcon,
    stepStatusLabel,
    stepDurationMs,
    isFallbackStep,
    formatDuration,
    formatUsageLine,
    statusBarLine,
    buildRunSummary,
    summaryToText,
    planToText,
} from './consolidationLabels.js';
export { MigrationV3 } from './MigrationV3.js';
// E2.6: memory_list_summaries + memory_read_summary wchłonięte przez `list`/`read` (scope=memory).
// MemorySearchTools.js skasowany — logika przeniesiona do modules/tools/ListTool.js + ReadTool.js.
export { EmbeddingHelper } from './EmbeddingHelper.js';
// Sprint 03 Z10: cost log (koszt operacji memory / sub-agent).
export { CostLog } from './CostLog.js';
// E2.9 FAZA D (A18): ContextSessionGenerator (artefakt „Kontekst sesji") SKASOWANY — ruch przejęły
// propozycje „Na teraz" w brain.md (E2.8 D3). Slot promptu brief_prompt (razem z DEFAULT_BRIEF_PROMPT)
// WYCIĘTY z Ustawień w AUD-dead-code-124 (2026-09-02) — po tej kasacji nie miał ani jednego
// czytelnika (widmowy, obiecywał działanie w opisie i18n, którego nie było).
// Sprint 03 Z12: 3-warstwowy retrieval (struktura → tekst → semantic).
export { RetrievalEngine } from './RetrievalEngine.js';

// streamToCompleteWithTools PRZENIESIONA do modules/agent-loop (runAgentLoop) w E2.1.
// S29 Z1: `streamToComplete` przyjmuje opcjonalne `{onChunk, signal, watchdog}`; kody błędów
// (`stream_stalled`/`aborted`) są kontraktem dla retry-polityki kroku konsolidacji — stała
// `STREAM_ERROR_CODES` żyje w `streamHelper.js` i czyta ją `ArchiveWorkflow` wewnątrz modułu.
export { streamToComplete } from './streamHelper.js';
export { registerSettings } from './SettingsSection.js';
// E2.8 B3: factory work-prompts owned by memory (moved from modules/agents/archetypes/savePrompts.js).
// Consumed by the workflows + Settings→Prompt UI. DEFAULT_BRIEF_PROMPT re-export CUT in
// AUD-dead-code-124 (2026-09-02) — the slot had zero readers since ContextSessionGenerator was
// deleted in E2.9 phase D; the constant itself was deleted from workPrompts.ts too.
export {
    DEFAULT_SAVE_SESSION_PROMPT,
    DEFAULT_ARCHIVE_PROMPT,
    DEFAULT_SUMMARY_PROMPT,
} from './workPrompts.js';

// ── Typy publiczne (TS-2) ─────────────────────────────────────────────────────
//
// Wychodzą tymi samymi drzwiami co wartości, ale przez `export type`, które ZNIKA
// przy transpilacji — zero wpływu na bundle. Typy żyją przy kodzie-właścicielu
// (kontrakt kampanii TS §5); tu są tylko reeksportowane.
//
// ⚠️ Kontrakt pliku `sessions/active/*.md` (`activeSessionFormat.ts`: `SessionRole`,
// `ParsedActiveSession`, `SessionEvent`, …) świadomie NIE wychodzi — ten plik jest
// wewnętrzny (nie ma go nawet wśród eksportów wartości).

/** Pamięć agenta — kontrakty vaulta, ścieżek i kształtów, które oddają listy. */
export type {
    MemoryVaultLike,
    MemoryVaultAdapterLike,
    MemoryPaths,
    ArchiveSessionInfo,
    ActiveSessionInfo,
    BrainNoteInfo,
    BrainNoteInput,
    ActiveSessionEventInput,
    ChatMessageLike,
    LegacyMemoryUpdate,
    BrainSections,
    BrainLogEntry,
} from './AgentMemory.js';

/** Walidacja ścieżek Memory v3 + kanoniczne nazwy notatek. */
export type { MemoryV3ErrorCode, MemoryNoteType, NoteFilenameDecision } from './MemoryAccessGuard.js';

/** Sekcje „Na teraz" w brain.md. */
export type { NaTerazSections, NaTerazKey, NaTerazOp } from './BrainIndex.js';

/** Decyzja „czy zapisać po bezczynności". */
export type { IdleSchedulerOptions, IdleSnapshot } from './IdleScheduler.js';

/** Stream → complete: opcje, wynik, kontrakt modelu i kody błędów przerwania. */
export type {
    StreamToCompleteOptions,
    StreamToCompleteResult,
    StreamChatModelLike,
    StreamMessage,
    StreamError,
    StreamErrorCode,
} from './streamHelper.js';

/** Przebieg konsolidacji: plan, krok, statusy, koszt. */
export type {
    ConsolidationStep,
    ConsolidationStepSpec,
    ConsolidationStepResult,
    ConsolidationStepApplied,
    StepStatus,
    StepKind,
    StepUsage,
    BuildPlanCounts,
} from './ConsolidationRun.js';

/** Rejestr jednego aktywnego przebiegu (zdarzenia dla paska statusu i modalu). */
export type { OpsEvent, OpsEventType, OpsListener, OpsRunLike } from './MemoryOpsCenter.js';

/**
 * Warstwa OPISOWA przebiegu. `ConsolidationStepLike`/`ConsolidationRunLike` to widoki
 * strukturalne na te same obiekty co `ConsolidationStep`/`ConsolidationRun` — etykiety
 * czyta też UI trzymające własne, uboższe kopie.
 */
export type { ConsolidationStepLike, ConsolidationRunLike, RunSummary, ConsolidationUsage } from './consolidationLabels.js';

/** Konsolidacja: generacja propozycji, decyzje usera, dedup `brain/`. */
export type {
    GenerateOptions,
    GenerationOutcome,
    GatedOutcome,
    StepDecision,
    ApplyStepResult,
    DedupProposal,
    DedupMerge,
    DedupDeletion,
} from './ArchiveWorkflow.js';

/**
 * `/save session`: przygotowanie, decyzja usera, wynik.
 * `SessionMessageLike` to wiadomość WEJŚCIOWA workflow — osobna od `ChatMessageLike`
 * (ta druga opisuje okno czatu, które `AgentMemory.saveSession` dopisuje do pliku sesji).
 */
export type {
    SaveSessionPrep,
    SaveSessionDecision,
    SaveSessionOutcome,
    NoteProposal,
    NaTerazUpdate,
    SessionMessageLike,
} from './SaveSessionWorkflow.js';

/** Migracja v2 → v3. */
export type { MigrationPlan, MigrationResult } from './MigrationV3.js';

/** Koszt operacji pamięci / sub-agenta. */
export type { CostLogEntryInput, CostLogRecord, CostEstimateInput, CostLogVaultLike } from './CostLog.js';

/** Helper wektoryzacji. */
export type { EmbeddingRuntimeLike } from './EmbeddingHelper.js';

/** Silnik narzędzia `search` — wejście, wynik i wstrzykiwane zależności. */
export type {
    RunSearchParams,
    SearchWhere,
    SearchResult,
    SearchOutcome,
    RetrievalEngineDeps,
    RetrievalVaultLike,
    RetrievalVaultAdapterLike,
    RetrievalAppLike,
    RetrievalAgentMemoryLike,
    RetrievalEmbeddingHelperLike,
    VectorSearchFn,
    VectorHitLike,
    FrontmatterParser,
    VaultFileLike,
} from './RetrievalEngine.js';

/** Sekcja „Pamięć i kontekst" w Settings — worek DI, którego oczekuje renderer. */
export type { MemorySettingsCtx, MemoryPkmSlice } from './SettingsContent.js';
