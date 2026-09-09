import { ConsolidationSnapshot } from './ConsolidationSnapshot.js';
import { makeMemoryNoteFilename } from './MemoryAccessGuard.js';
import { streamToComplete, STREAM_ERROR_CODES } from './streamHelper.js';
import { STEP_KIND, STEP_STATUS } from './ConsolidationRun.js';
import { resolveWorkPrompt, probeFile } from '../../core/index.js';
import { DEFAULT_ARCHIVE_PROMPT, DEFAULT_SUMMARY_PROMPT } from './workPrompts.js';
import { getLimits } from '../../config/limits.js';
import { log } from '../../core/utils/Logger.js';

import type { StreamChatModelLike, StreamToCompleteOptions } from './streamHelper.js';
import type {
    ConsolidationRun,
    ConsolidationStep,
    ConsolidationStepApplied,
    ConsolidationStepResult,
} from './ConsolidationRun.js';
// Wynik stemplowania sesji po zapisie L1 jedzie do zwrotki kroku.
import type { L1StampOutcome, L1StampSkip } from './AgentMemory.js';

const VALID_NOTE_TYPES = new Set(['user', 'agent_rule', 'skill_hint', 'project_context', 'reference']);

/** Błąd w catch — czytamy z niego tylko te pola. */
type ErrLike = { message?: string; code?: string; silentMs?: number };

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Kontrakty otoczenia, typowane STRUKTURALNIE
//  (`AgentMemory.js` jest jeszcze w JavaScripcie — nie czekamy na
//  konwersję właściciela; odwzorowujemy TO, co ten plik realnie woła, i nic ponadto.)
// ═══════════════════════════════════════════════════════════════════════════════════════

/** Adapter FS vaulta w zakresie potrzebnym konsolidacji. */
export interface ArchiveVaultAdapterLike {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    remove?(path: string): Promise<void>;
    list(path: string): Promise<{ files?: string[]; folders?: string[] } | null>;
}

/** Notatka `brain/*.md` widziana przez dedup. */
export interface BrainNoteLike {
    filename: string;
    name?: string;
    description?: string;
    type?: string;
}

/** Plik w `sessions/archive` / `summaries/LN` — tylko to, czym operują okna paczek. */
export interface ArchiveFileRef {
    path: string;
    name: string;
}

/** `.state.json` w zakresie, który rusza konsolidacja. */
export interface MemoryStateLike {
    archived_since_last_consolidation?: number;
    brain_notes_limit?: number;
    [key: string]: unknown;
}

/** Fragment `AgentMemory`, na którym stoi `ArchiveWorkflow`. */
export interface ArchiveAgentMemoryLike {
    agentName?: string;
    /** korzeń folderu pamięci — potrzebny `ConsolidationSnapshot` */
    basePath: string;
    vault: { adapter: ArchiveVaultAdapterLike };
    paths: {
        l1: string;
        l2: string;
        l3: string;
        brainNotes: string;
        sessionsArchive: string;
    };
    stateManager: { update(mutate: (state: MemoryStateLike) => void): Promise<unknown> };
    ensureMemoryStructure(): Promise<unknown>;
    listBrainNotes(): Promise<BrainNoteLike[]>;
    listUncoveredArchiveSessions(): Promise<ArchiveFileRef[]>;
    /** L1 nie wchłonięte jeszcze przez żadne L2 (backlink `l1_files:`) — materiał na paczkę L2 */
    listUncoveredL1s(): Promise<ArchiveFileRef[]>;
    /** L2 nie wchłonięte jeszcze przez żadne L3 (backlink `l2_files:`) — materiał na paczkę L3 */
    listUncoveredL2s(): Promise<ArchiveFileRef[]>;
    _parseFrontmatter(content: string): Record<string, unknown>;
    _cleanupAfterL1(sessions: string[], l1Name: string): Promise<unknown>;
    _cleanupAfterL3(l2Files: string[]): Promise<unknown>;
    /** opcjonalne — stare atrapy w testach ich nie mają */
    pruneArchive?(config: { days?: number; maxFiles?: number }): Promise<unknown>;
    rebuildBrainIndex?(): Promise<unknown>;
    appendBrainLog?(op: string, target: string, detail?: string): Promise<unknown>;
    archiveBrainNote?(filename: string, options: Record<string, unknown>): Promise<unknown>;
    _enqueuePathWrite?<T>(path: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Settings widziane przez workflow. Callerzy wstrzykują RÓŻNE kształty — pełny obiekt
 * albo podgałąź `settings.pkmAssistant` — stąd `pkmAssistant` rekurencyjnie i index signature.
 */
export interface ArchiveSettingsLike {
    memoryV3ArchiveBatchSize?: number;
    archiveRetentionDays?: number;
    archiveRetentionMaxFiles?: number;
    limits?: Record<string, unknown>;
    promptDefaults?: Record<string, unknown>;
    pkmAssistant?: ArchiveSettingsLike;
    [key: string]: unknown;
}

/** Agent (profil YAML) w zakresie, którego dotyka konsolidacja. */
export interface WorkflowAgentLike {
    name?: string;
    [key: string]: unknown;
}

export interface ArchiveWorkflowOptions {
    settings?: ArchiveSettingsLike | null;
    snapshot?: ConsolidationSnapshot;
    batchSize?: number;
    model?: StreamChatModelLike | null;
    agent?: WorkflowAgentLike | null;
    /** przedpobrana (JEDNORAZOWA) lista niepokrytych sesji od runnera */
    archiveSessions?: ArchiveFileRef[] | null;
}

// ── kontrakty propozycji dedupu ────────────────────────────────────────────────────────

/** Scalenie zaproponowane przez model albo heurystykę prefiksów (komplet pól). */
export interface DedupMerge {
    sources: string[];
    target_name: string;
    target_type: string;
    target_description: string;
    target_why: string;
    target_how_to_apply: string;
    merged_content: string;
    why: string;
    accepted: boolean;
}

/** Usunięcie notatki zaproponowane przez model (komplet pól). */
export interface DedupDeletion {
    filename: string;
    why: string;
    lessons_extracted: boolean;
    accepted: boolean;
}

/** To samo PO przejściu przez ręce usera (odznaczenia, edycje) — wszystko opcjonalne. */
export type DedupMergeInput = Partial<DedupMerge>;
export type DedupDeletionInput = Partial<DedupDeletion>;

export interface DedupProposal {
    merges: DedupMerge[];
    deletions: DedupDeletion[];
    llmDriven: boolean;
    /** propozycja ląduje w `step.result` (`ConsolidationStepResult`), który jest workiem */
    [key: string]: unknown;
}

/** Decyzja usera dla jednego kroku (kształt jak dotąd w modalu review). */
export interface StepDecision {
    accepted?: boolean;
    body?: string;
    merges?: unknown[];
    deletions?: unknown[];
}

/** Wynik generacji: które kroki dostały propozycję, które odpadły, które padły. */
export interface GenerationOutcome {
    generated: string[];
    skipped: string[];
    failed: string[];
}

/** To samo dla kroków bramkowanych; `waiting: true` = jeszcze nie pora. */
export interface GatedOutcome extends GenerationOutcome {
    waiting: boolean;
}

/** Opcje generacji (identyczne dla `runWithRun`, `generateGatedSteps` i `retryStep`). */
export interface GenerateOptions {
    onStall?: (info: { stepId: string; silentMs: number | null; willRetry: boolean; retryCount: number }) => void;
    /** znak życia dla UI */
    onChunk?: (info: { stepId: string; delta: string }) => void;
    /** override timeoutu watchdoga (domyślnie z `config/limits.js`) */
    stallTimeoutMs?: number;
    signal?: AbortSignal;
}

/** Opcje strzału LLM składane przez `_llmOptions` i konsumowane przez `proposeDedup`/`_summaryFromFiles`. */
export interface LlmCallOptions {
    /** zwis/abort ma polecieć w górę zamiast cicho spaść na fallback */
    rethrowStreamErrors?: boolean;
    onUsage?: (usage: unknown) => void;
    onFallback?: (error: unknown) => void;
    stream?: StreamToCompleteOptions;
}

/** Wynik `applyStepDecision`. */
export interface ApplyStepResult {
    applied: boolean;
    skipped?: boolean;
    result?: ConsolidationStepApplied;
    error?: unknown;
}

/**
 * ArchiveWorkflow — konsolidacja pamięci: dedup `brain/` + podsumowania L1/L2/L3.
 *
 * **Jeden tor, nieblokujący**: `runWithRun(consolidationRun)` generuje
 * propozycje WSZYSTKICH paczek po kolei i wkłada je do `ConsolidationRun` jako kroki
 * `awaiting_review`. NIC nie zapisuje. Zapis dzieje się osobno, po decyzji usera:
 * `applyStepDecision(run, stepId, decision)`. Hierarchia (L2/L3) jest zabramkowana —
 * `generateGatedSteps(run)` rusza dopiero, gdy wszystkie L1 są rozstrzygnięte, bo L2 syntetyzuje
 * TREŚĆ L1 (nie może powstać z wersji, którą user właśnie edytuje).
 *
 * Z podsystemu snapshotów (`ConsolidationSnapshot`) w użyciu jest wyłącznie `prune()` —
 * sprząta stare kopie na starcie `runWithRun`.
 */
export class ArchiveWorkflow {
    // `declare` = sama deklaracja typu, zero emitu.
    declare agentMemory: ArchiveAgentMemoryLike;
    declare settings: ArchiveSettingsLike;
    declare snapshot: ConsolidationSnapshot;
    declare batchSize: number;
    declare model: StreamChatModelLike | null;
    declare agent: WorkflowAgentLike | null;
    declare private _archiveSessionsCache: ArchiveFileRef[] | null;

    constructor(agentMemory: ArchiveAgentMemoryLike, options: ArchiveWorkflowOptions = {}) {
        this.agentMemory = agentMemory;
        this.settings = options.settings || {};
        this.snapshot = options.snapshot || new ConsolidationSnapshot(agentMemory);
        this.batchSize = options.batchSize || this.settings.memoryV3ArchiveBatchSize || 5;
        // Memory v3: LLM-driven dedup proposals (analog SaveSessionWorkflow). Without both fields
        // the workflow falls back to deterministic prefix-grouping (legacy).
        this.model = options.model || null;
        this.agent = options.agent || null;
        // Opcjonalna przedpobrana lista niepokrytych sesji od runnera (ten sam materiał, którym
        // liczył plan) — omija drugi komplet stat()+read() per plik archiwum na starcie generacji.
        // JEDNORAZOWA: `_listSessionsForL1` zjada ją przy pierwszym użyciu — patrz komentarz tam.
        this._archiveSessionsCache = Array.isArray(options.archiveSessions) ? options.archiveSessions : null;
    }

    /**
     * Limity retencji archiwum z ustawień (Z6). `0` / brak = limit wyłączony.
     *
     * Callerzy wstrzykują tu RÓŻNE kształty: `consolidationRunner`/`save_session` podają podgałąź
     * `settings.pkmAssistant` (płasko), a testy potrafią podać pełny obiekt. Rozumiemy oba — dokładnie
     * jak `_stallTimeoutMs()` niżej.
     */
    private _retentionConfig(): { days: number; maxFiles: number } {
        const flat = this.settings?.pkmAssistant || this.settings || {};
        return {
            days: Number(flat.archiveRetentionDays) || 0,
            maxFiles: Number(flat.archiveRetentionMaxFiles) || 0,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    //  Generacja ≠ aplikacja
    // ═══════════════════════════════════════════════════════════════════════════════════════

    /**
     * Generuje propozycje wszystkich kroków przebiegu, NIC nie zapisując na dysk.
     *
     * Co się dzieje po kolei:
     *  1. sprzątanie starych snapshotów (przebieg sam ŻADNEGO nie robi — patrz niżej),
     *  2. dedup `brain/` → propozycja do kroku,
     *  3. PĘTLA paczek L1 — kolejne okna po `batchSize` w posortowanym `sessions/archive`
     *     (60 sesji = 12 paczek w JEDNYM przebiegu; skasowany stary tor robił jedną na przebieg),
     *  4. L2/L3 zostają z kłódką — odblokowuje je `generateGatedSteps()` po rozstrzygnięciu L1.
     *
     * **Dlaczego przebieg NIE robi snapshotu.** Zapisy dzieją się dopiero po decyzjach usera —
     * czasem godziny po starcie generacji. Snapshot zrobiony na starcie i tak nie dawałby
     * bezpiecznego rollbacku: odtworzenie z niego cofnęłoby bieżącą rozmowę (pliki sesji też są
     * w środku), a same operacje konsolidacji są create-before-delete, więc pad w połowie i tak
     * nie gubi danych. Do tego kopia CAŁEGO folderu pamięci w JSON-ie to własny punkt awarii
     * (RAM + Dysk Google).
     *
     * Padnięty krok NIE zatrzymuje przebiegu: leci dalej do następnej paczki (fail jednej paczki
     * L1 nie może zablokować pozostałych jedenastu). Zwis streamu jest ponawiany raz, potem krok
     * ląduje jako `failed` z przyciskiem „Ponów" w UI.
     *
     */
    async runWithRun(run: ConsolidationRun | null | undefined, options: GenerateOptions = {}): Promise<GenerationOutcome> {
        if (!run) throw new Error('ArchiveWorkflow.runWithRun: brak przebiegu (ConsolidationRun)');
        await this.agentMemory.ensureMemoryStructure();
        // Sprzątanie po starym torze — nigdy nie może ubić przebiegu.
        try { await this.snapshot.prune(); } catch { /* best-effort */ }
        // Z6: retencja archiwum sesji. Kasuje WYŁĄCZNIE sesje ze stemplem `covered_by_l1`
        // (materiał na przyszłe paczki L1 jest nietykalny), oba limity domyślnie wyłączone.
        try { await this.agentMemory.pruneArchive?.(this._retentionConfig()); } catch { /* best-effort */ }

        const outcome: GenerationOutcome = { generated: [], skipped: [], failed: [] };
        // Lista archiwum czytana RAZ: w fazie generacji nic nie kasuje ani nie dopisuje plików,
        // więc okna paczek są stabilne i nie zachodzą na siebie.
        const archive = await this._listSessionsForL1();

        for (const step of run.getSteps()) {
            if (step.status !== STEP_STATUS.PENDING) continue; // gated L2/L3 + już rozstrzygnięte
            if (step.kind === STEP_KIND.DEDUP) await this._generateDedupStep(run, step, options, outcome);
            else if (step.kind === STEP_KIND.L1) await this._generateL1Step(run, step, archive, options, outcome);
        }

        return outcome;
    }

    /**
     * Zdejmuje kłódkę z L2 (a potem z L3) i generuje ich propozycje — ale dopiero, gdy niższy
     * poziom jest rozstrzygnięty. Woła to UI po każdej decyzji usera; jest idempotentne.
     *
     * Gating: L2 syntetyzuje TREŚĆ L1, więc nie może powstać z wersji, którą user
     * właśnie edytuje albo którą za chwilę odrzuci. Jeśli po odrzuceniach na dysku jest mniej
     * niż `batchSize` NIEPOKRYTYCH plików L1 — L2 (i zależny od niego L3) lecą jako `skipped`.
     *
     * ⚠️ „Niepokrytych", nie „wszystkich": L1 nie ubywają po wchłonięciu do L2
     * (kasuje je dopiero kaskada L3), a L2 nie ubywają nigdy — liczenie po gołym listingu
     * folderu produkowało w kółko podsumowania tego samego materiału. Patrz `_listUncoveredL1`.
     *
     * `waiting: true` = jeszcze nie pora (niższy poziom nierozstrzygnięty).
     */
    async generateGatedSteps(run: ConsolidationRun | null | undefined, options: GenerateOptions = {}): Promise<GatedOutcome> {
        const out: GatedOutcome = { generated: [], skipped: [], failed: [], waiting: false };
        if (!run) return out;

        const l2 = run.getStep(STEP_KIND.L2);
        if (l2 && l2.status === STEP_STATUS.GATED) {
            if (!run.allL1Resolved()) {
                out.waiting = true;
                return out;
            }
            // Ungate PRZED pierwszym await: w oknie między „wszystkie L1 terminalne" a startem
            // generacji L2 wszystkie kroki wyglądały na rozstrzygnięte/gated — zamknięcie modalu
            // w tym momencie uznawało przebieg za utknięty i zwalniało centrum przy ŻYWEJ robocie.
            // `pending` sygnalizuje: robota przed nami.
            run.ungate(l2.id);
            const l1s = await this._listUncoveredL1();
            if (l1s.length < this.batchSize) {
                run.skipStep(l2.id, 'not_enough_l1');
                out.skipped.push(l2.id);
                const gatedL3 = run.getStep(STEP_KIND.L3);
                if (gatedL3 && gatedL3.status === STEP_STATUS.GATED) {
                    run.skipStep(gatedL3.id, 'not_enough_l2');
                    out.skipped.push(gatedL3.id);
                }
                return out;
            }
            await this._generateL2Step(run, l2, l1s, options, out);
            return out; // L3 czeka na rozstrzygnięcie L2 — kolejne wywołanie go ruszy
        }

        const l3 = run.getStep(STEP_KIND.L3);
        if (l3 && l3.status === STEP_STATUS.GATED) {
            const l2Step = run.getStep(STEP_KIND.L2);
            if (l2Step && !run.isResolved(l2Step.id)) {
                out.waiting = true;
                return out;
            }
            if (!run.allL1Resolved()) {
                out.waiting = true;
                return out;
            }
            // Ungate przed await — ten sam pancerz co przy L2.
            run.ungate(l3.id);
            const l2s = await this._listUncoveredL2();
            if (l2s.length < this.batchSize) {
                run.skipStep(l3.id, 'not_enough_l2');
                out.skipped.push(l3.id);
                return out;
            }
            await this._generateL3Step(run, l3, l2s, options, out);
        }

        return out;
    }

    /**
     * Aplikuje decyzję usera dla JEDNEGO kroku — to jedyne miejsce, gdzie nowy tor pisze na dysk.
     * Odrzucenie (`decision.accepted === false`) oznacza `skipped`, nie błąd.
     *
     * @param decision - kształt jak dotąd w modalu review: `{accepted, body?, merges?, deletions?}`
     */
    async applyStepDecision(
        run: ConsolidationRun | null | undefined,
        stepId: string,
        decision: StepDecision = {},
    ): Promise<ApplyStepResult> {
        if (!run) throw new Error('ArchiveWorkflow.applyStepDecision: brak przebiegu');
        const step = run.getStep(stepId);
        if (!step) throw new Error(`ArchiveWorkflow.applyStepDecision: nieznany krok "${stepId}"`);

        if (decision?.accepted === false) {
            run.skipStep(stepId, 'rejected_by_user');
            return { applied: false, skipped: true };
        }

        run.beginApply(stepId, decision);
        try {
            const result = await this._applyStep(step, decision);
            run.completeStep(stepId, result);
            return { applied: true, result };
        } catch (error) {
            // Padnięta aplikacja jednego kroku nie wywala przebiegu — user ma „Ponów" w modalu.
            log.error('ArchiveWorkflow', `Aplikacja kroku ${stepId} padła: ${((error as ErrLike)?.message || error) as string}`);
            run.failStep(stepId, error);
            return { applied: false, error };
        }
    }

    /**
     * Ręczne „Ponów" dla kroku, który padł na etapie GENEROWANIA propozycji (zwis 2×, błąd LLM,
     * padnięty zapis). Odpala DOKŁADNIE ten sam generator co przebieg, z tym samym oknem paczki —
     * `ConsolidationRun.startStep` zeruje przy tym licznik auto-ponowień, więc krok znów ma prawo
     * do jednego automatycznego retry po zwisie.
     *
     */
    async retryStep(
        run: ConsolidationRun | null | undefined,
        stepId: string,
        options: GenerateOptions = {},
    ): Promise<GenerationOutcome> {
        if (!run) throw new Error('ArchiveWorkflow.retryStep: brak przebiegu');
        const step = run.getStep(stepId);
        if (!step) throw new Error(`ArchiveWorkflow.retryStep: nieznany krok "${stepId}"`);
        if (step.status !== STEP_STATUS.FAILED) {
            throw new Error(`ArchiveWorkflow.retryStep: krok "${stepId}" nie jest w stanie failed (jest: ${step.status})`);
        }

        const outcome: GenerationOutcome = { generated: [], skipped: [], failed: [] };
        if (step.kind === STEP_KIND.DEDUP) {
            await this._generateDedupStep(run, step, options, outcome);
        } else if (step.kind === STEP_KIND.L1) {
            const archive = await this._listSessionsForL1();
            await this._generateL1Step(run, step, archive, options, outcome);
        } else if (step.kind === STEP_KIND.L2) {
            const l1s = await this._listUncoveredL1();
            if (l1s.length < this.batchSize) {
                run.skipStep(step.id, 'not_enough_l1');
                outcome.skipped.push(step.id);
            } else {
                await this._generateL2Step(run, step, l1s, options, outcome);
            }
        } else if (step.kind === STEP_KIND.L3) {
            const l2s = await this._listUncoveredL2();
            if (l2s.length < this.batchSize) {
                run.skipStep(step.id, 'not_enough_l2');
                outcome.skipped.push(step.id);
            } else {
                await this._generateL3Step(run, step, l2s, options, outcome);
            }
        } else {
            throw new Error(`ArchiveWorkflow.retryStep: nie wiem jak ponowić krok rodzaju "${step.kind}"`);
        }
        return outcome;
    }

    private async _applyStep(step: ConsolidationStep, decision: StepDecision = {}): Promise<ConsolidationStepApplied> {
        const proposal: ConsolidationStepResult = step.result || {};
        if (step.kind === STEP_KIND.DEDUP) {
            const merges = (decision?.merges || proposal.merges || []) as DedupMergeInput[];
            const deletions = (decision?.deletions || proposal.deletions || []) as DedupDeletionInput[];
            const applied = await this.applyDedup({ merges, deletions });
            // Ten sam gest co w starym torze: user odrzucił WSZYSTKIE scalenia → podnosimy próg,
            // żeby nie zaczepiać go o to samo przy każdym zapisie sesji.
            const autoBumped = ((proposal.merges?.length as number) > 0 && applied.merged === 0 && applied.deleted === 0)
                ? await this._autoBumpBrainNoteLimit()
                : false;
            return { ...applied, autoBumpedBrainNoteLimit: autoBumped };
        }
        if (step.kind === STEP_KIND.L1) {
            return this._writeLevel1({
                name: proposal.name,
                sessions: proposal.sessions || [],
                body: decision?.body || proposal.body || '',
            });
        }
        if (step.kind === STEP_KIND.L2) {
            return this._writeLevel2({
                name: proposal.name,
                l1_files: proposal.l1_files || [],
                sessions: proposal.sessions || [],
                body: decision?.body || proposal.body || '',
            });
        }
        if (step.kind === STEP_KIND.L3) {
            return this._writeLevel3({
                name: proposal.name,
                l2_files: proposal.l2_files || [],
                l1_files: proposal.l1_files || [],
                body: decision?.body || proposal.body || '',
            });
        }
        throw new Error(`ArchiveWorkflow: nie wiem jak zaaplikować krok rodzaju "${step.kind}"`);
    }

    // ── generatory pojedynczych kroków ────────────────────────────────────────────────────

    private async _generateDedupStep(run: ConsolidationRun, step: ConsolidationStep, options: GenerateOptions, outcome: GenerationOutcome): Promise<void> {
        run.startStep(step.id);
        const attempt = await this._attemptWithStallRetry(
            run, step.id,
            () => this.proposeDedup(this._llmOptions(run, step.id, options)),
            options
        );
        if (!attempt.ok) {
            outcome.failed.push(step.id);
            return;
        }
        const proposal = attempt.value;
        if (!proposal.merges.length && !proposal.deletions.length) {
            // Nie ma czego przeglądać — nie zawracamy userowi głowy pustym ekranem.
            run.skipStep(step.id, 'nothing_to_merge');
            outcome.skipped.push(step.id);
            return;
        }
        run.stepProposalReady(step.id, proposal);
        outcome.generated.push(step.id);
    }

    private async _generateL1Step(run: ConsolidationRun, step: ConsolidationStep, archive: ArchiveFileRef[], options: GenerateOptions, outcome: GenerationOutcome): Promise<void> {
        // Okno paczki jest ZAMRAŻANE przy pierwszej generacji (`step.meta.sessions`).
        // Lista niepokrytych sesji KURCZY SIĘ po każdej zaakceptowanej paczce (stemple
        // covered_by_l1), więc `slice(offset)` liczony od nowa przy „Ponów" brałby okno
        // INNEJ paczki — duplikat L1 na cudzych sesjach wracałby tylnymi drzwiami.
        const frozenNames = Array.isArray(step.meta?.sessions) && step.meta.sessions.length > 0
            ? step.meta.sessions
            : null;
        let batch;
        if (frozenNames) {
            const wanted = new Set(frozenNames);
            batch = archive.filter(item => wanted.has(item.name));
            if (batch.length < frozenNames.length) {
                // Część zamrożonego okna zniknęła z dysku (ręczna kasacja / cudzy przebieg) —
                // paczka odpada, zamiast po cichu dobrać cudze sesje.
                run.skipStep(step.id, 'not_enough_sessions');
                outcome.skipped.push(step.id);
                return;
            }
        } else {
            const offset = Number.isFinite(step.meta?.offset) ? (step.meta.offset as number) : ((step.index || 1) - 1) * this.batchSize;
            batch = archive.slice(offset, offset + this.batchSize);
            if (batch.length < this.batchSize) {
                // Plan powstał z liczników; jeśli archiwum w międzyczasie schudło — paczka odpada.
                run.skipStep(step.id, 'not_enough_sessions');
                outcome.skipped.push(step.id);
                return;
            }
            step.meta = { ...(step.meta || {}), sessions: batch.map(item => item.name) };
        }

        run.startStep(step.id);
        let usedFallback = false;
        const attempt = await this._attemptWithStallRetry(
            run, step.id,
            () => this._summaryFromFiles(batch.map(item => item.path), 'L1', {
                ...this._llmOptions(run, step.id, options),
                onFallback: () => { usedFallback = true; },
            }),
            options
        );
        if (!attempt.ok) {
            outcome.failed.push(step.id);
            return;
        }
        run.stepProposalReady(step.id, {
            level: 'L1',
            name: this._summaryName('L1'),
            body: attempt.value,
            sessions: batch.map(item => item.name),
            llmDriven: !usedFallback,
        });
        outcome.generated.push(step.id);
    }

    private async _generateL2Step(run: ConsolidationRun, step: ConsolidationStep, l1s: ArchiveFileRef[], options: GenerateOptions, outcome: GenerationOutcome): Promise<void> {
        const batch = l1s.slice(0, this.batchSize);
        // Cały korpus w try/catch, nie tylko strzał do LLM: `_collectFrontmatterList` czyta pliki
        // z dysku (kaskada `_cleanupAfterL3` potrafi skasować L1 między listingiem a odczytem)
        // i rzuca poza polityką zwisu. Bez tego krok zostawał na wieki w `running`, a
        // `memoryOpsCenter` był „zajęty" aż do restartu Obsidiana. Obejmujemy WSZYSTKO do
        // `stepProposalReady`, żeby dołożone za pół roku `await` nie przywróciło buga.
        try {
            run.startStep(step.id);
            let usedFallback = false;
            const sessions = await this._collectFrontmatterList(batch, 'sessions');
            const attempt = await this._attemptWithStallRetry(
                run, step.id,
                () => this._summaryFromFiles(batch.map(item => item.path), 'L2', {
                    ...this._llmOptions(run, step.id, options),
                    onFallback: () => { usedFallback = true; },
                }),
                options
            );
            if (!attempt.ok) {
                outcome.failed.push(step.id);
                return;
            }
            run.stepProposalReady(step.id, {
                level: 'L2',
                name: this._summaryName('L2'),
                body: attempt.value,
                l1_files: batch.map(item => item.name),
                sessions,
                llmDriven: !usedFallback,
            });
            outcome.generated.push(step.id);
        } catch (error) {
            this._failGeneration(run, step, error, outcome);
        }
    }

    private async _generateL3Step(run: ConsolidationRun, step: ConsolidationStep, l2s: ArchiveFileRef[], options: GenerateOptions, outcome: GenerationOutcome): Promise<void> {
        const batch = l2s.slice(0, this.batchSize);
        // Ten sam pancerz co w L2 — patrz komentarz wyżej.
        try {
            run.startStep(step.id);
            let usedFallback = false;
            const l1Files = await this._collectFrontmatterList(batch, 'l1_files');
            const attempt = await this._attemptWithStallRetry(
                run, step.id,
                () => this._summaryFromFiles(batch.map(item => item.path), 'L3', {
                    ...this._llmOptions(run, step.id, options),
                    onFallback: () => { usedFallback = true; },
                }),
                options
            );
            if (!attempt.ok) {
                outcome.failed.push(step.id);
                return;
            }
            run.stepProposalReady(step.id, {
                level: 'L3',
                name: this._summaryName('L3'),
                body: attempt.value,
                l2_files: batch.map(item => item.name),
                l1_files: l1Files,
                llmDriven: !usedFallback,
            });
            outcome.generated.push(step.id);
        } catch (error) {
            this._failGeneration(run, step, error, outcome);
        }
    }

    /**
     * Domyka krok, który wywalił się POZA polityką zwisu (odczyt pliku, nielegalne przejście).
     * `failStep` sam potrafi rzucić przy nielegalnym przejściu — stąd wewnętrzny try/catch.
     * Krok ma skończyć jako `failed` (z „Ponów" w modalu), nigdy nie zostać w `running`.
     */
    private _failGeneration(run: ConsolidationRun, step: ConsolidationStep, error: unknown, outcome: GenerationOutcome): void {
        log.error('ArchiveWorkflow', `Generacja kroku ${step.id} padła: ${((error as ErrLike)?.message || error) as string}`);
        try { run.failStep(step.id, error); } catch { /* stan już domknięty */ }
        outcome.failed.push(step.id);
    }

    /**
     * Odpala strzał LLM z polityką zwisu: pierwszy stall = ponowienie TEGO SAMEGO strzału,
     * drugi = krok `failed` (już ustawiony przez `markStalled`). Błędy inne niż zwis kończą
     * krok od razu (bez auto-retry). Abort (user „Anuluj") to NIE zwis:
     * pada od razu z własnym kodem — inaczej wchodził w politykę ponowień i modal raportował
     * „stream zwisł dwa razy" po własnoręcznym anulowaniu.
     */
    private async _attemptWithStallRetry<T>(
        run: ConsolidationRun,
        stepId: string,
        produce: () => Promise<T>,
        options: GenerateOptions = {},
    ): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
        for (;;) {
            try {
                return { ok: true, value: await produce() };
            } catch (error) {
                if ((error as ErrLike)?.code === STREAM_ERROR_CODES.STALLED) {
                    const { retry, retryCount } = run.markStalled(stepId);
                    try {
                        options.onStall?.({
                            stepId,
                            silentMs: Number.isFinite((error as ErrLike)?.silentMs) ? (error as ErrLike).silentMs as number : null,
                            willRetry: retry,
                            retryCount,
                        });
                    } catch { /* callback UI nie może wywalić przebiegu */ }
                    if (retry) continue;
                    return { ok: false, error };
                }
                run.failStep(stepId, error);
                return { ok: false, error };
            }
        }
    }

    /** Opcje dla `streamToComplete` + spięcie kosztu i znaku życia z krokiem przebiegu. */
    private _llmOptions(run: ConsolidationRun, stepId: string, options: GenerateOptions = {}): LlmCallOptions {
        const timeoutMs = Number.isFinite(options.stallTimeoutMs)
            ? options.stallTimeoutMs
            : this._stallTimeoutMs();
        return {
            rethrowStreamErrors: true,
            onUsage: (usage) => { if (usage) run.addUsage(stepId, usage); },
            stream: {
                onChunk: options.onChunk ? (delta: string) => options.onChunk!({ stepId, delta }) : undefined,
                watchdog: (timeoutMs as number) > 0 ? { timeoutMs } : undefined,
                signal: options.signal,
            },
        };
    }

    /**
     * Timeout zwisu WSPÓLNY z czatem: `chat_stream_stall_timeout_ms`
     * z `config/limits.js`, nadpisywalny w Settings → Limity.
     *
     * Uwaga na kształt: `getLimits()` czeka na PEŁNY obiekt settings (czyta `settings.pkmAssistant.limits`),
     * a ArchiveWorkflow dostaje z callerów już podgałąź `settings.pkmAssistant` (`save_session.js`,
     * `profile_memory.js`). Rozpoznajemy oba kształty, żeby override usera działał w obu.
     */
    _stallTimeoutMs(): number {
        const s: ArchiveSettingsLike = this.settings || {};
        const full = s.pkmAssistant ? s : { pkmAssistant: s };
        return getLimits(full).chat_stream_stall_timeout_ms;
    }

    /**
     * Memory v3 LLM-driven proposal. When model+agent+archive_prompt are present, ask the agent
     * to semantically group notes and propose CLEAN merged content. Falls back to the v1 prefix
     * heuristic when LLM is unavailable or throws.
     *
     * @param opts - używane tylko przez nowy tor (stare wywołania bez zmian):
     *   `stream` (opcje `streamToComplete`: onChunk/watchdog/signal), `onUsage(usage)` (koszt kroku),
     *   `rethrowStreamErrors` (zwis/abort ma polecieć w górę zamiast cicho spaść na fallback).
     */
    async proposeDedup(opts: LlmCallOptions = {}): Promise<DedupProposal> {
        const notes = await this.agentMemory.listBrainNotes();
        if (notes.length < 2) {
            return { merges: [], deletions: [], llmDriven: false };
        }

        const llm = await this._tryProposeDedupViaAgent(notes, opts);
        if (llm) return { ...llm, llmDriven: true };

        // Legacy fallback: prefix-2 grouping (kept for tests + no-API users).
        return { ...this._legacyProposeDedup(notes), llmDriven: false };
    }

    private async _tryProposeDedupViaAgent(notes: BrainNoteLike[], opts: LlmCallOptions = {}): Promise<{ merges: DedupMerge[]; deletions: DedupDeletion[] } | null> {
        // Resolver (agent>global>factory) — LLM path as soon as a model is present.
        if (!this.model) return null;
        const archivePrompt = resolveWorkPrompt(this.agent, 'archive_prompt', this.settings, DEFAULT_ARCHIVE_PROMPT);
        if (!archivePrompt) return null;
        try {
            // Read full body per note so the LLM sees content, not just frontmatter.
            const enriched = await Promise.all(notes.map(async (n) => {
                const path = `${this.agentMemory.paths.brainNotes}/${n.filename}`;
                let body = '';
                try {
                    const raw = await this.agentMemory.vault.adapter.read(path);
                    body = raw.replace(/^---[\s\S]*?---\n*/, '').trim();
                } catch { /* unreadable → skip body */ }
                return {
                    filename: n.filename,
                    name: n.name || n.filename.replace(/\.md$/, ''),
                    description: n.description || '',
                    type: n.type || 'reference',
                    body: body.slice(0, 1500) // budget cap per note
                };
            }));

            const payload = {
                // `this.agent` bywa null (legalne wg konstruktora), a bramka
                // wyżej sprawdza tylko `this.model` — asercja `!` dawała TypeError połykany przez
                // catch niżej (LLM-dedup po cichu przepadał). Fallback `||` istniał dokładnie na to.
                agent: this.agent?.name || this.agentMemory.agentName,
                note_count: enriched.length,
                notes: enriched
            };
            const messages = [
                { role: 'system', content: archivePrompt },
                { role: 'user', content: JSON.stringify(payload) }
            ];
            const { text, usage } = await streamToComplete(this.model, messages, opts.stream);
            opts.onUsage?.(usage);
            return this._parseDedupResponse(text);
        } catch (e) {
            // Zwis streamu / abort NIE MOŻE po cichu spaść na heurystykę prefiksów —
            // nowy tor prosi o rzut zamiast cichego fallbacku.
            if (opts.rethrowStreamErrors && this._isStreamControlError(e)) throw e;
            log.warn('ArchiveWorkflow', `LLM dedup proposal failed, falling back: ${(e as ErrLike).message as string}`);
            return null;
        }
    }

    /** Czy to błąd „my przerwaliśmy stream" (zwis / abort), a nie zwykła awaria LLM-a. */
    private _isStreamControlError(error: unknown): boolean {
        return (error as ErrLike)?.code === STREAM_ERROR_CODES.STALLED || (error as ErrLike)?.code === STREAM_ERROR_CODES.ABORTED;
    }

    _parseDedupResponse(text: unknown): { merges: DedupMerge[]; deletions: DedupDeletion[] } {
        const raw = String(text || '').trim();
        if (!raw) throw new Error('Empty LLM response');
        const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        let parsed: { merges?: unknown; deletions?: unknown };
        try {
            parsed = JSON.parse(stripped) as { merges?: unknown; deletions?: unknown };
        } catch {
            const match = stripped.match(/\{[\s\S]*\}/);
            if (!match) throw new Error('No JSON object in LLM response');
            parsed = JSON.parse(match[0]) as { merges?: unknown; deletions?: unknown };
        }

        const merges: DedupMerge[] = (Array.isArray(parsed?.merges) ? parsed.merges : [])
            .map((m: Record<string, unknown>): DedupMerge | null => {
                const sources = Array.isArray(m?.sources) ? m.sources.filter(Boolean).map(String) : [];
                if (sources.length < 2) return null;
                const type = VALID_NOTE_TYPES.has(m?.target_type as string) ? (m.target_type as string) : 'reference';
                const targetName = String(m?.target_name || '').trim();
                if (!targetName) return null;
                const mergedContent = String(m?.merged_content || '').trim();
                if (!mergedContent) return null;
                return {
                    sources,
                    target_name: targetName,
                    target_type: type,
                    target_description: String(m?.target_description || '').trim(),
                    target_why: String(m?.target_why || '').trim(),
                    target_how_to_apply: String(m?.target_how_to_apply || '').trim(),
                    merged_content: mergedContent,
                    why: String(m?.why || '').trim(),
                    accepted: true
                };
            })
            .filter(Boolean) as DedupMerge[];

        const deletions: DedupDeletion[] = (Array.isArray(parsed?.deletions) ? parsed.deletions : [])
            .map((d: Record<string, unknown>): DedupDeletion | null => {
                const filename = String(d?.filename || '').trim();
                if (!filename || !filename.endsWith('.md')) return null;
                const lessonsRaw = d?.lessons_extracted;
                const lessonsExtracted = lessonsRaw === true || String(lessonsRaw).toLowerCase() === 'true';
                return {
                    filename,
                    why: String(d?.why || '').trim(),
                    lessons_extracted: lessonsExtracted,
                    accepted: true
                };
            })
            .filter(Boolean) as DedupDeletion[];

        return { merges, deletions };
    }

    private _legacyProposeDedup(notes: BrainNoteLike[]): { merges: DedupMerge[]; deletions: DedupDeletion[] } {
        const groups = new Map<string, BrainNoteLike[]>();
        for (const note of notes) {
            const stem = note.filename.replace(/\.md$/, '');
            const parts = stem.split('_');
            const key = parts.length >= 3 ? `${parts[0]}_${parts[1]}` : stem;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(note);
        }

        const merges = [...groups.values()]
            .filter(group => group.length > 1)
            .map(group => ({
                sources: group.map(note => note.filename),
                target_name: group[0].name || group[0].filename.replace(/\.md$/, '').replace(/^[a-z_]+_/, ''),
                target_type: group[0].type || 'reference',
                target_description: '',
                target_why: '',
                target_how_to_apply: '',
                merged_content: '', // legacy path leaves content empty → applyDedup falls back to raw concat
                why: 'Grupowanie po prefix filename (legacy)',
                accepted: true
            }));

        return { merges, deletions: [] };
    }

    /**
     * Apply user-confirmed merges + deletions. LLM-driven proposals come with clean
     * `merged_content` → we write a fresh note with proper frontmatter and remove sources.
     * Legacy proposals (no merged_content) fall back to raw concat for backwards-compat.
     */
    async applyDedup(
        decisions: { merges?: DedupMergeInput[]; deletions?: DedupDeletionInput[] } = {},
    ): Promise<{ merged: number; deleted: number }> {
        const merges = Array.isArray(decisions.merges) ? decisions.merges : [];
        const deletions = Array.isArray(decisions.deletions) ? decisions.deletions : [];
        let merged = 0;
        let deleted = 0;

        for (const proposal of merges) {
            if (proposal.accepted === false || !proposal.sources?.length) continue;
            if (proposal.sources.length < 2) continue;

            const baseTargetFilename = makeMemoryNoteFilename(proposal.target_type || 'reference', proposal.target_name);
            const baseTargetPath = `${this.agentMemory.paths.brainNotes}/${baseTargetFilename}`;
            const sourceSet = new Set(proposal.sources);
            const targetStem = baseTargetFilename.replace(/\.md$/, '');

            let content: string;
            if (proposal.merged_content && proposal.merged_content.trim()) {
                // LLM-driven: build clean frontmatter + merged body
                content = this._buildNoteContent({
                    name: proposal.target_name,
                    description: proposal.target_description || '',
                    type: proposal.target_type || 'reference',
                    body: proposal.merged_content,
                    why: proposal.target_why || '',
                    how_to_apply: proposal.target_how_to_apply || ''
                });
            } else {
                // Legacy fallback: raw concat (kept so existing prefix-grouping path still works)
                const chunks: string[] = [];
                for (const filename of proposal.sources) {
                    const path = `${this.agentMemory.paths.brainNotes}/${filename}`;
                    if (await this.agentMemory.vault.adapter.exists(path)) {
                        chunks.push(await this.agentMemory.vault.adapter.read(path));
                    }
                }
                if (chunks.length < 2) continue;
                content = chunks.join('\n\n---\n\n');
            }

            // Probe+sufiks I zapis żyją W JEDNYM wpisie kolejki, kluczowanym BAZOWĄ
            // (nie-sufiksowaną) ścieżką — wzorzec `AgentMemory.writeBrainNote`. Kluczowanie na
            // `baseTargetPath` (zamiast na finalnym, już-z-sufiksem `targetPath`) jest celowe:
            // gdyby pętla `probeFile`+sufiks biegła PRZED `enqueue()`, na gołym `targetPath` spoza
            // kolejki, otwierałoby się okno między „nazwa wolna" a realnym zapisem (wewnątrz
            // `enqueue`) na równoległy `memory_save` piszący POD TĄ SAMĄ nazwą — dwa zapisy tej
            // samej bazowej nazwy scalałyby się w wyścig, bo tylko JEDEN trzymałby się klucza
            // kolejki. `writeBrainNote` woła TĘ SAMĄ kolejkę pod TYM SAMYM bazowym kluczem, więc
            // oba zapisy tej samej nazwy serializują się względem siebie, nie tylko względem
            // samych siebie.
            //
            // `target_name` jest wejściem NIEZAUFANYM (LLM albo user edytujący pole w modalu
            // przeglądu), nie gotową ścieżką zapisu. Bez pętli sufiksów kolizja z notatką SPOZA
            // `sources` (identyczna nazwa albo ucięty do 80 znaków wspólny slug —
            // `MemoryAccessGuard.makeMemoryNoteFilename`) kończyłaby się cichym nadpisaniem:
            // notatka usera znikałaby bez `.bak` i bez wpisu `delete` w `brain.log` (log dostawałby
            // tylko `merge`). Plik NIE jest kolizją, gdy jest jednym ze scalanych `sources` (wtedy
            // scalenie legalnie zajmuje jego miejsce — kod niżej pomija `remove()` dla
            // `path === targetPath`).
            //
            // Wyczerpanie prób (suffix > 50) POMIJA scalenie z `log.warn`, zamiast `break`-iem
            // zostawiać `targetFilename` na `_50` — nazwie, o której ta sama pętla WŁAŚNIE orzekła,
            // że ISTNIEJE (`probeFile(...) !== 'missing'` było warunkiem wejścia w tę iterację) — i
            // pisać tam mimo to. Ta sama klasa błędu: cichy zapis nad cudzą notatką.
            const enqueue = this.agentMemory._enqueuePathWrite
                ? this.agentMemory._enqueuePathWrite.bind(this.agentMemory)
                : (_p: string, fn: () => Promise<{ filename: string; path: string } | null>) => fn();
            const applied = await enqueue(baseTargetPath, async (): Promise<{ filename: string; path: string } | null> => {
                let targetFilename = baseTargetFilename;
                let targetPath = baseTargetPath;
                for (
                    let suffix = 2;
                    !sourceSet.has(targetFilename) && (await probeFile(this.agentMemory.vault.adapter, targetPath)) !== 'missing';
                    suffix++
                ) {
                    if (suffix > 50) {
                        log.warn('ArchiveWorkflow', `applyDedup: brak wolnej nazwy dla scalenia "${proposal.target_name || baseTargetFilename}" po 50 próbach, pomijam ten merge (źródła zostają nietknięte)`);
                        return null;
                    }
                    targetFilename = `${targetStem}_${suffix}.md`;
                    targetPath = `${this.agentMemory.paths.brainNotes}/${targetFilename}`;
                }

                await this.agentMemory.vault.adapter.write(targetPath, content);

                // Remove every source file (including one that happens to share the new target name —
                // we just wrote our merged content over it, so the source body is gone but the file
                // path was preserved).
                for (const filename of proposal.sources!) {
                    const path = `${this.agentMemory.paths.brainNotes}/${filename}`;
                    if (path === targetPath) continue;
                    if (this.agentMemory.vault.adapter.remove && await this.agentMemory.vault.adapter.exists(path)) {
                        await this.agentMemory.vault.adapter.remove(path);
                    }
                }
                return { filename: targetFilename, path: targetPath };
            });

            if (!applied) continue;

            // Kronika `brain.log`. Dedup pisze TU, bezpośrednio adapterem (nie przez
            // metodę AgentMemory), więc wpis musi powstać tutaj — inaczej scalenie kilku notatek
            // w jedną byłoby dla usera niewidzialne.
            await this.agentMemory.appendBrainLog?.('merge', applied.filename, proposal.sources.join(' + '));
            merged++;
        }

        for (const d of deletions) {
            if (d.accepted === false || !d.filename) continue;
            const path = `${this.agentMemory.paths.brainNotes}/${d.filename}`;
            if (!(await this.agentMemory.vault.adapter.exists(path))) continue;
            const content = await this.agentMemory.vault.adapter.read(path);
            const fm = this.agentMemory._parseFrontmatter(content);
            if (fm.type === 'project_context' && this.agentMemory.archiveBrainNote) {
                if (d.lessons_extracted !== true) continue;
                await this.agentMemory.archiveBrainNote(d.filename, {
                    reason: d.why || 'ArchiveWorkflow project cleanup',
                    lessonsReviewed: true,
                    lessonsExtracted: true
                });
                deleted++;
                continue;
            }
            if (this.agentMemory.vault.adapter.remove) {
                // Serialize the delete against the note path.
                const enqueueDel = this.agentMemory._enqueuePathWrite
                    ? this.agentMemory._enqueuePathWrite.bind(this.agentMemory)
                    : (_p: string, fn: () => Promise<void>) => fn();
                await enqueueDel(path, async () => {
                    await this.agentMemory.vault.adapter.remove!(path);
                });
                // Gałąź `project_context` loguje się sama w `archiveBrainNote` (op `archive`).
                await this.agentMemory.appendBrainLog?.('delete', d.filename, d.why || '');
                deleted++;
            }
        }

        if (merged > 0 || deleted > 0) {
            await this.agentMemory.rebuildBrainIndex?.();
        }

        return { merged, deleted };
    }

    private _buildNoteContent({ name, description, type, body, why, how_to_apply }: {
        name?: string; description?: string; type?: string; body?: string; why?: string; how_to_apply?: string;
    }): string {
        const safe = (v: unknown) => JSON.stringify(String(v || '').slice(0, 1000));
        const date = new Date().toISOString().slice(0, 10);
        const whyLine = why || 'Merged from multiple notes via ArchiveWorkflow.';
        const howLine = how_to_apply || 'Use this when the topic comes up in conversation.';
        return `---
name: ${safe(name)}
description: ${safe(description)}
type: ${type}
created: ${date}
source: archive_workflow_merge
---
${String(body || '').trim()}

**Why:** ${whyLine}

**How to apply:** ${howLine}
`;
    }

    // ── zapisywacze podsumowań ────────────────────────────────────────────────────────────
    //
    // Jedyna droga zapisu podsumowań L1/L2/L3. Każdy zapis idzie przez kolejkę
    // per-ścieżka, a nazwa pliku jest odkolizjonowana — 12 paczek L1 zaakceptowanych
    // w tej samej sekundzie miałoby inaczej tę samą nazwę `RRRR-MM-DD_GG-mm-ss_l1.md`
    // i zjadłoby się nawzajem.

    /**
     * @returns faktyczna nazwa pliku (po odkolizjonowaniu) + `unstamped`, gdy któraś sesja
     *   NIE dostała stempla `covered_by_l1`. Paczka L1 jest wtedy zapisana,
     *   ale te sesje wrócą do następnej paczki — krok nie ma prawa meldować czystego sukcesu.
     */
    async _writeLevel1({ name, sessions = [], body = '' }: {
        name?: string; sessions?: string[]; body?: string;
    }): Promise<{ created: number; name: string; unstamped?: L1StampSkip[] }> {
        const folder = this.agentMemory.paths.l1;
        const finalName = await this._uniqueSummaryName(folder, name || this._summaryName('L1'));
        const path = `${folder}/${finalName}`;
        await this._enqueueWrite(path, async () => {
            await this.agentMemory.vault.adapter.write(path, [
                '---',
                `level: L1`,
                'sessions:',
                ...sessions.map(session => `  - ${session}`),
                `created: ${new Date().toISOString()}`,
                '---',
                '',
                body
            ].join('\n'));
        });
        const stamping = await this.agentMemory._cleanupAfterL1(sessions, finalName) as L1StampOutcome | undefined;
        await this._resetArchiveCounter();
        const unstamped = stamping?.skipped || [];
        return { created: 1, name: finalName, ...(unstamped.length > 0 ? { unstamped } : {}) };
    }

    async _writeLevel2({ name, l1_files = [], sessions = [], body = '' }: {
        name?: string; l1_files?: string[]; sessions?: string[]; body?: string;
    }): Promise<{ created: number; name: string }> {
        const folder = this.agentMemory.paths.l2;
        const finalName = await this._uniqueSummaryName(folder, name || this._summaryName('L2'));
        const path = `${folder}/${finalName}`;
        await this._enqueueWrite(path, async () => {
            await this.agentMemory.vault.adapter.write(path, [
                '---',
                `level: L2`,
                'l1_files:',
                ...l1_files.map(item => `  - ${item}`),
                'sessions:',
                ...sessions.map(session => `  - ${session}`),
                `created: ${new Date().toISOString()}`,
                '---',
                '',
                body
            ].join('\n'));
        });
        await this._deleteArchivedSessions(sessions);
        return { created: 1, name: finalName };
    }

    async _writeLevel3({ name, l2_files = [], l1_files = [], body = '' }: {
        name?: string; l2_files?: string[]; l1_files?: string[]; body?: string;
    }): Promise<{ created: number; name: string }> {
        const folder = this.agentMemory.paths.l3;
        const finalName = await this._uniqueSummaryName(folder, name || this._summaryName('L3'));
        const path = `${folder}/${finalName}`;
        await this._enqueueWrite(path, async () => {
            await this.agentMemory.vault.adapter.write(path, [
                '---',
                `level: L3`,
                'l2_files:',
                ...l2_files.map(item => `  - ${item}`),
                'l1_files:',
                ...l1_files.map(item => `  - ${item}`),
                `created: ${new Date().toISOString()}`,
                '---',
                '',
                body
            ].join('\n'));
        });
        await this.agentMemory._cleanupAfterL3(l2_files);
        return { created: 1, name: finalName };
    }

    /** Kolejka zapisu per-ścieżka; bez niej (stare atrapy) po prostu odpala funkcję. */
    private _enqueueWrite(path: string, fn: () => Promise<void>): Promise<void> {
        return this.agentMemory._enqueuePathWrite
            ? this.agentMemory._enqueuePathWrite(path, fn)
            : fn();
    }

    /** `..._l1.md` → `..._l1_2.md`, gdy nazwa zajęta (12 paczek w jednej sekundzie). */
    private async _uniqueSummaryName(folder: string, name: string): Promise<string> {
        const adapter = this.agentMemory.vault.adapter;
        const stem = String(name).replace(/\.md$/, '');
        // Adapter bez exists() w ogóle → nie blokujemy zapisu (probeFile na takim adapterze i tak
        // zwróci wyłącznie 'unknown', więc pętla niżej przemieliłaby bez sensu wszystkie 100
        // sufiksów).
        if (typeof adapter?.exists !== 'function') return `${stem}.md`;
        let candidate = `${stem}.md`;
        // Ta sama pętla co w AgentMemory — „nie wiem" (probeFile) liczy się
        // jako ZAJĘTA, żeby kłamiący exists() nie dał dwóm paczkom zaakceptowanym w tej samej
        // sekundzie tej samej nazwy (dokładnie ryzyko opisane w komentarzu nad wołaczami niżej).
        for (let n = 2; n <= 100; n++) {
            if ((await probeFile(adapter, `${folder}/${candidate}`)) === 'missing') return candidate;
            candidate = `${stem}_${n}.md`;
        }
        return candidate;
    }

    /**
     * Sesje kandydujące do paczki L1 — WYŁĄCZNIE te bez stempla `covered_by_l1`.
     *
     * Kształt wyniku ({path, name}) zostaje ten sam co `_listMarkdown` — okna paczek liczą się
     * dalej przez `slice(offset, offset + batchSize)`.
     *
     * Runner może wstrzyknąć gotową listę konstruktorem (`archiveSessions`) — to samo listowanie
     * robi plan przebiegu, a każde jest kompletem stat() + read() frontmattera per plik archiwum.
     *
     * Wstrzyknięta lista jest JEDNORAZOWA, nie memoizowana na stałe: `retryStep` woła to samo
     * wiele minut później i MUSI zobaczyć aktualny dysk (paczka zaakceptowana w międzyczasie
     * ostemplowała sesje, user mógł skasować plik z zamrożonego okna). Cache na całe życie
     * workflow pomijał te zmiany.
     */
    async _listSessionsForL1(): Promise<ArchiveFileRef[]> {
        const prefetched = this._archiveSessionsCache;
        this._archiveSessionsCache = null;
        const sessions = prefetched || await this.agentMemory.listUncoveredArchiveSessions();
        return sessions.map(item => ({ path: item.path, name: item.name }));
    }

    /**
     * Materiał na paczkę L2 — WYŁĄCZNIE pliki L1, których nie wchłonęło jeszcze żadne L2.
     *
     * Znacznikiem pokrycia jest sam plik L2 (jego frontmatter `l1_files:`) — patrz
     * `AgentMemory.listUncoveredL1s()` po uzasadnienie, dlaczego backlink, a nie stempel.
     */
    async _listUncoveredL1(): Promise<ArchiveFileRef[]> {
        return this.agentMemory.listUncoveredL1s();
    }

    /** Materiał na paczkę L3 — L2 nie wchłonięte jeszcze przez żadne L3. Bliźniak `_listUncoveredL1`. */
    async _listUncoveredL2(): Promise<ArchiveFileRef[]> {
        return this.agentMemory.listUncoveredL2s();
    }

    async _listMarkdown(folder: string): Promise<ArchiveFileRef[]> {
        try {
            const listed = await this.agentMemory.vault.adapter.list(folder);
            return (listed?.files || [])
                .filter(path => path.endsWith('.md'))
                .map(path => ({ path, name: path.split('/').pop() as string }))
                .sort((a, b) => a.name.localeCompare(b.name));
        } catch {
            return [];
        }
    }

    /**
     * Memory v3 LLM-driven synthesis for L1/L2/L3. When a model is present (summary prompt
     * resolved agent>global>factory), the agent receives N documents (stripped frontmatter, truncated to 5kB each) and writes a
     * single synthetic summary scaled to the target level. Without LLM we fall back to the v1
     * raw concatenation so deterministic tests still pass.
     */
    async _summaryFromFiles(paths: string[], level: string, opts: LlmCallOptions = {}): Promise<string> {
        // Resolver provides the summary prompt (agent>global>factory) — LLM synthesis runs
        // whenever a model is present; without a model we keep the deterministic raw-concat fallback.
        if (this.model) {
            try {
                return await this._summaryFromFilesViaAgent(paths, level, opts);
            } catch (e) {
                // Zwis/abort leci w górę (nowy tor robi z tego retry albo krok failed);
                // zwykła awaria LLM-a nadal spada na deterministyczny fallback jak dotąd.
                if (opts.rethrowStreamErrors && this._isStreamControlError(e)) throw e;
                log.warn('ArchiveWorkflow', `LLM summary failed (${level}), falling back: ${(e as ErrLike).message as string}`);
                opts.onFallback?.(e);
            }
        } else {
            opts.onFallback?.(new Error('no model'));
        }
        return this._summaryFromFilesRaw(paths, level);
    }

    private async _summaryFromFilesViaAgent(paths: string[], level: string, opts: LlmCallOptions = {}): Promise<string> {
        const documents = await Promise.all(paths.map(async (path) => {
            const content = await this.agentMemory.vault.adapter.read(path);
            const stripped = content.replace(/^---[\s\S]*?---\n*/, '').trim();
            return {
                filename: path.split('/').pop() as string,
                content: stripped.slice(0, 5000)
            };
        }));
        const resolved = resolveWorkPrompt(this.agent, 'summary_prompt', this.settings, DEFAULT_SUMMARY_PROMPT);
        const prompt = String(resolved || '').replace(/\{\{LEVEL\}\}/g, level);
        const payload = {
            level,
            count: documents.length,
            documents
        };
        const messages = [
            { role: 'system', content: prompt },
            { role: 'user', content: JSON.stringify(payload) }
        ];
        const { text, usage } = await streamToComplete(this.model!, messages, opts.stream);
        opts.onUsage?.(usage);
        const clean = String(text || '')
            .trim()
            .replace(/^```(?:markdown|md)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();
        if (!clean) throw new Error('Empty LLM summary');
        return clean;
    }

    private async _summaryFromFilesRaw(paths: string[], level: string): Promise<string> {
        // Deterministic fallback — kept for backwards-compat with tests and no-API users. Output
        // is a labelled cat of the source documents; nobody should mistake it for a real summary.
        const chunks = await Promise.all(paths.map(async (path) => {
            const content = await this.agentMemory.vault.adapter.read(path);
            return `## ${path.split('/').pop()}\n${content.replace(/^---[\s\S]*?---\n*/, '').trim()}`;
        }));
        return `# ${level} raw concat (no LLM available)\n\n${chunks.join('\n\n')}`;
    }

    async _collectFrontmatterList(items: ArchiveFileRef[], key: string): Promise<string[]> {
        const values: string[] = [];
        for (const item of items) {
            const content = await this.agentMemory.vault.adapter.read(item.path);
            const fm = this.agentMemory._parseFrontmatter(content);
            const raw = fm[key];
            if (Array.isArray(raw)) values.push(...(raw as string[]));
        }
        return [...new Set(values)];
    }

    /** Zerowanie licznika przez kolejkę RMW — inaczej cofa równoległy `markArchived` z czatu. */
    async _resetArchiveCounter(): Promise<void> {
        await this.agentMemory.stateManager.update((state) => {
            state.archived_since_last_consolidation = 0;
        });
    }

    private async _deleteArchivedSessions(sessionNames: string[] = []): Promise<void> {
        for (const sessionName of sessionNames) {
            const path = `${this.agentMemory.paths.sessionsArchive}/${sessionName}`;
            try {
                if (await this.agentMemory.vault.adapter.exists(path)) {
                    await this.agentMemory.vault.adapter.remove!(path);
                }
            } catch { /* best-effort per file */ }
        }
    }

    async _autoBumpBrainNoteLimit(): Promise<boolean> {
        // Bump current limit by +10 (cap at 100) so users who reject merges don't get badgered
        // every save. Scales relative to whatever the user already has.
        // Read-modify-write przez kolejkę `.state.json` — patrz `_resetArchiveCounter`.
        let bumped = false;
        await this.agentMemory.stateManager.update((state) => {
            const current = Number(state.brain_notes_limit || 20);
            if (current >= 100) return;
            state.brain_notes_limit = Math.min(100, current + 10);
            bumped = true;
        });
        return bumped;
    }

    _summaryName(level: string): string {
        const date = new Date().toISOString().slice(0, 10);
        const time = new Date().toISOString().slice(11, 19).replace(/:/g, '-');
        return `${date}_${time}_${level.toLowerCase()}.md`;
    }
}
