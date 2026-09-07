/**
 * @module consolidationRunner
 * S29 Z5 (2026-07-29) — KONTROLER PRZEBIEGU konsolidacji pamięci: klej między silnikiem
 * (`ConsolidationRun` + `ArchiveWorkflow`, modules/memory) a widokami (modal przebiegu
 * `ConsolidationProgressModal.js` — od S31 obok, w tym module — pasek statusu w `core/PKMEnv.js`,
 * kryształowe powiadomienia z `main.js`).
 *
 * Dlaczego klej mieszka w `modules/chat`, a nie w shell albo memory:
 *  - `modules/memory` jest bez UI z założenia (czysty node, testowalny) — nie może wołać modali
 *    ani notice'ów,
 *  - `modules/shell` to widoki; import chatu/pluginu stamtąd robi cykl,
 *  - `modules/chat` JUŻ jest właścicielem triggera (`slash-commands/save_session.js` — próg po
 *    zapisie sesji). Klej ląduje po stronie tego, kto konsolidację odpala. S31 dołożył do tego
 *    sam modal przebiegu: skoro jedyny wołacz siedzi tutaj, to i okno mieszka tutaj.
 *
 * Plik siedzi w KORZENIU modułu (nie w `chat/`, gdzie mieszkają mixiny ChatView) z dwóch powodów:
 * to nie jest mixin prototypu, a `slash-commands/save_session.js` musi go zaimportować — specyfikator
 * `../chat/...` wyglądałby dla ESLinta (`no-restricted-imports`) jak deep import w cudzy moduł.
 *
 * Modal jest ładowany LENIWIE (`await import('./ConsolidationProgressModal.js')`
 * w `openConsolidationModal`). Statyczny import ciągnąłby `obsidian` i przez to CAŁY kontroler —
 * najbardziej stanowy kawałek S29 — nie dawałby się zaimportować w AVA (zero testów). Tak się da:
 * `consolidationRunner.test.js` wstrzykuje atrapę modalu przez `_setModalClassForTests`.
 *
 * Co tu się dzieje:
 *  1. `startConsolidationRun()` — liczy plan z liczników, rejestruje przebieg w `MemoryOpsCenter`,
 *     otwiera modal, odpala generację propozycji W TLE (NIE blokuje powrotu do czatu) i pilnuje
 *     notice'ów: start / koniec / pad kroku / awaryjny fallback bez modelu.
 *  2. `RunController` — to, co modal wywołuje na guzikach: zapis decyzji, „Ponów", „Pomiń",
 *     a po każdej decyzji kaskada L2/L3 (`generateGatedSteps`, wołane 2× — patrz komentarz niżej).
 *  3. Subskrypcja `open_modal_requested` — klik w 🧠 na pasku statusu (i drugi trigger
 *     konsolidacji przy zajętym centrum) otwiera modal TEGO przebiegu, który już leci.
 */
import {
    ArchiveWorkflow,
    ConsolidationRun,
    buildConsolidationPlan,
    listUncoveredArchiveSessions,
    memoryOpsCenter,
    OPS_EVENT,
    CostLog,
    stepLabel,
    isFallbackStep,
    buildRunSummary,
    summaryToText,
    planToText,
    formatDuration,
    formatUsageLine,
} from '../memory/index.js';
import { getLimits } from '../../config/limits.js';
import { t } from '../../core/i18n/index.js';
import { log } from '../../core/utils/Logger.js';

import type {
    ArchiveSessionInfo,
    ConsolidationRunLike,
    ConsolidationStepLike,
    GenerateOptions,
    GenerationOutcome,
    GatedOutcome,
    OpsEvent,
    RunSummary,
    StepDecision,
    StreamChatModelLike,
} from '../memory/index.js';

// TS-any: App/plugin/model/modal are assembled by the composition root and test DI at runtime.
type Runtime = any;
type ErrLike = { message?: string };
type WorkflowAgentMemory = ConstructorParameters<typeof ArchiveWorkflow>[0];
type WorkflowOptions = NonNullable<ConstructorParameters<typeof ArchiveWorkflow>[1]>;
type RunnerSettings = NonNullable<WorkflowOptions['settings']> & {
    memoryV3BrainNotesThreshold?: number;
};
type RunnerAgent = NonNullable<WorkflowOptions['agent']>;
type StallInfo = Parameters<NonNullable<GenerateOptions['onStall']>>[0];

type RunnerAgentMemory = WorkflowAgentMemory & {
    listUncoveredArchiveSessions(): Promise<ArchiveSessionInfo[]>;
    stateManager: WorkflowAgentMemory['stateManager'] & {
        read(): Promise<{ brain_notes_limit?: number }>;
    };
};

interface NoticeOptions {
    type?: string;
    timeout?: number;
}

interface PluginLike {
    showCrystalNotice?(message: string, options: NoticeOptions): unknown;
}

interface ModelMetadata {
    modelKey?: string;
    modelId?: string;
    model_name?: string;
}

interface LoggedUsage {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
}

interface RunControllerOptions {
    plugin: PluginLike;
    app: Runtime;
    run: ConsolidationRun;
    workflow: ArchiveWorkflow;
    agentMemory: RunnerAgentMemory;
    agentName: string;
    model: Runtime;
    settings: RunnerSettings;
}

interface ConsolidationModalOptions {
    run: ConsolidationRun;
    controller?: RunController;
    agentName: string;
    onClosed(): void;
}

interface ConsolidationModalLike {
    run: ConsolidationRun | null;
    open(): void;
    close(): void;
}

interface ConsolidationModalConstructor {
    new (app: Runtime, options: ConsolidationModalOptions): ConsolidationModalLike;
}

interface StartConsolidationOptions {
    plugin: PluginLike;
    app: Runtime;
    agentMemory?: RunnerAgentMemory | null;
    agent?: RunnerAgent | null;
    model?: Runtime;
    settings?: RunnerSettings;
    source?: 'auto' | 'manual';
}

/** Kontrolery żyjące per przebieg — modal odnajduje swój przez aktywny run z centrum. */
const CONTROLLERS = new WeakMap<ConsolidationRun, RunController>();

/** Jedno okno na raz + jedna subskrypcja „otwórz modal" na cały plugin. */
let openModal: ConsolidationModalLike | null = null;
let openerUnsubscribe: (() => void) | null = null;
/** Obiekt `app`, z którym zasubskrybowano opener (dev-reload pluginu podstawia nowy). */
let openerApp: Runtime = null;
/** Atrapa klasy modalu dla testów — produkcja bierze klasę leniwym importem z shella. */
let modalClassOverride: ConsolidationModalConstructor | null = null;

/**
 * TYLKO DLA TESTÓW: podmienia klasę modalu przebiegu (`null` = powrót do leniwego importu).
 * Produkcyjne API (`startConsolidationRun`) nie zmienia przez to kształtu.
 */
export function _setModalClassForTests(cls: ConsolidationModalConstructor | null): void {
    modalClassOverride = cls || null;
}

/**
 * Pliki L1/L2, które NAPRAWDĘ nadają się na paczkę wyżej — czyli te, których nie wchłonęło
 * jeszcze żadne L2/L3 (backlink `l1_files:`/`l2_files:`, patrz gotcha 17 w `modules/memory`).
 *
 * Ten sam gest co `listUncoveredSessions` niżej i z tego samego powodu: generator
 * (`ArchiveWorkflow._listUncoveredL1/2`) bierze DOKŁADNIE ten materiał, więc plan liczony po
 * gołym listingu folderu obiecywałby kroki, które generator i tak odrzuca jako
 * `not_enough_l1`/`not_enough_l2`. Tu boli to bardziej niż na szczeblu sesji: **L1 nie ubywają
 * po wejściu do L2 (kasuje je dopiero kaskada L3), a L2 nie ubywają nigdy** — gołe liczniki
 * rosłyby w nieskończoność, więc pusty krok wisiałby w KAŻDYM przebiegu.
 *
 * Rzut listowania = pusta lista = 0 kroków. Lepiej nie zaplanować L2/L3 niż zaplanować w ciemno.
 */
async function listUncoveredSummaries(
    agentMemory: RunnerAgentMemory,
    level: 'l1' | 'l2',
): Promise<Array<{ path: string; name: string }>> {
    try {
        return level === 'l1'
            ? await agentMemory.listUncoveredL1s()
            : await agentMemory.listUncoveredL2s();
    } catch (e) {
        log.warn('ConsolidationRunner', `Listowanie niepokrytych ${level.toUpperCase()} padło: ${(e as ErrLike)?.message || String(e)} — plan bez tego szczebla`);
        return [];
    }
}

/**
 * Sesje archiwum, które NAPRAWDĘ nadają się na nową paczkę L1 — czyli te bez stempla
 * `covered_by_l1`. Generator paczek (`ArchiveWorkflow._listSessionsForL1`) bierze dokładnie ten
 * sam materiał; gdyby plan liczył WSZYSTKIE pliki archiwum, obiecywałby paczki, które generator
 * i tak odrzuca jako `not_enough_sessions` (modal z krokami, z których nic nie wynika).
 *
 * Zwracamy LISTĘ, nie licznik: ta sama lista jedzie potem do workflow (`archiveSessions`), żeby
 * stat() + read() frontmattera per plik archiwum nie leciały drugi raz na starcie generacji.
 *
 * Rzut listowania = pusta lista = 0 paczek. Lepiej nie zaplanować L1 niż zaplanować w ciemno —
 * reszta planu (dedup / L2 / L3) i tak powstaje z osobnych liczników.
 */
async function listUncoveredSessions(agentMemory: RunnerAgentMemory): Promise<ArchiveSessionInfo[]> {
    try {
        return await listUncoveredArchiveSessions(agentMemory);
    } catch (e) {
        log.warn('ConsolidationRunner', `Listowanie niepokrytych sesji padło: ${(e as ErrLike)?.message || String(e)} — plan bez paczek L1`);
        return [];
    }
}

/** Timeout zwisu wspólny z czatem (decyzja Kuby 5) — `chat_stream_stall_timeout_ms`. */
function stallTimeoutMs(settings: RunnerSettings): number {
    const full = settings?.pkmAssistant ? settings : { pkmAssistant: settings || {} };
    return getLimits(full).chat_stream_stall_timeout_ms;
}

function modelNameOf(model: Runtime): string | null {
    return (model as ModelMetadata)?.modelKey || (model as ModelMetadata)?.modelId || (model as ModelMetadata)?.model_name || null;
}

function notice(plugin: PluginLike | null | undefined, message: string, opts: NoticeOptions = {}): void {
    try {
        plugin?.showCrystalNotice?.(message, opts);
    } catch (e) {
        log.warn('ConsolidationRunner', `notice failed: ${(e as ErrLike)?.message || String(e)}`);
    }
}

/**
 * Kontroler jednego przebiegu. Modal jest głupi — cała robota (zapis, retry, bramka L2/L3,
 * notice, koszt) jest tutaj.
 */
class RunController {
    declare plugin: PluginLike;
    declare app: Runtime;
    declare run: ConsolidationRun;
    declare workflow: ArchiveWorkflow;
    declare agentMemory: RunnerAgentMemory;
    declare agentName: string;
    declare model: Runtime;
    declare settings: RunnerSettings;
    declare _finished: boolean;
    declare _fallbackNotified: Set<string>;
    declare _failNotified: Set<string>;
    declare _loggedUsage: LoggedUsage;
    declare _llmOptions: GenerateOptions;

    constructor({ plugin, app, run, workflow, agentMemory, agentName, model, settings }: RunControllerOptions) {
        this.plugin = plugin;
        this.app = app;
        this.run = run;
        this.workflow = workflow;
        this.agentMemory = agentMemory;
        this.agentName = agentName;
        this.model = model;
        this.settings = settings || {};
        this._finished = false;
        this._fallbackNotified = new Set();
        this._failNotified = new Set();
        /** Ile tokenów już poszło do CostLog — przebieg może się domknąć kilka razy (Ponów). */
        this._loggedUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
        this._llmOptions = {
            stallTimeoutMs: stallTimeoutMs(this.settings),
            onStall: (info: StallInfo) => this._onStall(info),
        };
    }

    getModelName(): string | null { return modelNameOf(this.model); }

    /** Generacja propozycji dla całego planu — odpalana raz, w tle, po starcie przebiegu. */
    async generate(): Promise<GenerationOutcome> {
        const outcome = await this.workflow.runWithRun(this.run, this._llmOptions);
        this._reportOutcome(outcome); // najpierw pady/fallbacki, dopiero potem ewentualny „gotowe"
        // Gdy WSZYSTKIE paczki L1 odpadły (za mało sesji), nikt nie kliknie decyzji — a bez
        // decyzji nikt nie zdejmie kłódki z L2/L3. Dlatego kaskadę ruszamy też tutaj.
        await this.advance();
        return outcome;
    }

    /**
     * Przebieg wraca do gry po tym, jak raz się już domknął (krok `failed` liczy się jako
     * rozstrzygnięty, więc „Ponów"/decyzja po podsumowaniu wskrzesza robotę). Bez tego wskaźnik
     * na pasku by nie wrócił, a drugie domknięcie nie dałoby ani notice'a, ani wpisu kosztu.
     */
    _resume(): void {
        this._finished = false;
        if (!memoryOpsCenter.getActiveRun()) memoryOpsCenter.startRun(this.run);
    }

    /** Zapis decyzji usera dla jednego kroku, a potem kaskada w górę. */
    async applyDecision(stepId: string, decision: StepDecision): Promise<void> {
        this._resume();
        try {
            await this.workflow.applyStepDecision(this.run, stepId, decision);
        } catch (e) {
            log.error('ConsolidationRunner', `applyStepDecision(${stepId}) padło: ${(e as ErrLike)?.message || String(e)}`);
        }
        await this.advance();
    }

    /**
     * „Ponów" dla kroku, który padł. Dwa różne pady, dwa różne lekarstwa:
     *  - pad przy ZAPISIE (krok ma już decyzję usera) → powtarzamy sam zapis. Inaczej ponowna
     *    generacja spaliłaby kolejny strzał LLM i wyrzuciła edycje usera do kosza.
     *  - pad przy GENEROWANIU propozycji (zwis 2×, błąd modelu) → `retryStep` odpala ten sam
     *    generator z tym samym oknem paczki (`startStep` w środku zeruje budżet auto-ponowień).
     */
    async retry(stepId: string): Promise<void> {
        this._resume();
        this._failNotified.delete(stepId); // pad po ponowieniu ma znowu krzyknąć
        const step = this.run.getStep(stepId);
        try {
            if (step?.decision) {
                await this.workflow.applyStepDecision(this.run, stepId, step.decision);
            } else {
                this._reportOutcome(await this.workflow.retryStep(this.run, stepId, this._llmOptions));
            }
        } catch (e) {
            log.error('ConsolidationRunner', `retry(${stepId}) padło: ${(e as ErrLike)?.message || String(e)}`);
        }
        await this.advance();
    }

    /** „Pomiń" — świadome odpuszczenie kroku (odblokowuje bramkę L2/L3). */
    async skip(stepId: string): Promise<void> {
        this._resume();
        try {
            this.run.skipStep(stepId, 'rejected_by_user');
        } catch (e) {
            log.warn('ConsolidationRunner', `skip(${stepId}): ${(e as ErrLike)?.message || String(e)}`);
        }
        await this.advance();
    }

    /**
     * Zdejmuje kłódkę z najbliższego poziomu, który już na to czeka, i sprawdza, czy przebieg
     * się domknął. **Kaskada L1→L2→L3 NIE dzieje się w jednej pętli** — świeżo odblokowany krok
     * ląduje w `awaiting_review`, a to nie jest „rozstrzygnięty", więc następny poziom wraca
     * z `waiting: true`. Prawdziwa kaskada rozkłada się na OSOBNE wywołania `advance()`, po
     * kolejnych decyzjach usera (`applyDecision` / `retry` / `skip`).
     *
     * Druga iteracja pętli jest więc zawsze pustym przebiegiem — zostaje jako bezpiecznik na
     * przypadek, w którym `generateGatedSteps` rozstrzygnie poziom bez pytania usera (np. skip
     * `not_enough_l1`) i kolejny poziom da się ruszyć od razu.
     */
    async advance(): Promise<void> {
        for (let pass = 0; pass < 2; pass++) {
            try {
                const out = await this.workflow.generateGatedSteps(this.run, this._llmOptions);
                this._reportOutcome(out);
                if (out?.waiting) break;
            } catch (e) {
                log.error('ConsolidationRunner', `generateGatedSteps padło: ${(e as ErrLike)?.message || String(e)}`);
                break;
            }
        }
        this.finishIfSettled();
    }

    /** Domknięcie przebiegu: notice podsumowania + wpis do CostLog + zwolnienie centrum. */
    finishIfSettled(): boolean {
        if (this._finished || !this.run.isSettled()) return false;
        this._finished = true;

        const summary = buildRunSummary(this.run as unknown as ConsolidationRunLike);
        notice(this.plugin, t('memory.consolidation.notice_done', {
            summary: summaryToText(summary),
            duration: formatDuration(summary.durationMs),
            usage: formatUsageLine(summary.usage, this.getModelName()),
        }), { type: 'success', timeout: 9000 });

        this._writeCostLog(summary).catch((e: unknown) =>
            log.warn('ConsolidationRunner', `CostLog append padło: ${(e as ErrLike)?.message || String(e)}`));

        if (memoryOpsCenter.getActiveRun() === this.run) memoryOpsCenter.finishRun();
        return true;
    }

    /**
     * Jeden wpis kosztu na domknięcie przebiegu — ale liczony jako PRZYROST względem tego, co już
     * zaksięgowane. `run.totalUsage()` jest skumulowane, a przebieg potrafi domknąć się drugi raz
     * (po „Ponów"); bez delty ten sam koszt trafiłby do dziennika dwa razy.
     *
     * ⚠️ Do S29 `CostLog.append` nie miał w produkcji ANI JEDNEGO wołacza — `CostTrackingModal`
     * czytał plik, którego nikt nie pisał.
     */
    async _writeCostLog(summary: RunSummary): Promise<void> {
        const usage = summary.usage || {};
        const delta = {
            input_tokens: Math.max(0, (usage.inputTokens || 0) - this._loggedUsage.inputTokens),
            output_tokens: Math.max(0, (usage.outputTokens || 0) - this._loggedUsage.outputTokens),
            cached_tokens: Math.max(0, (usage.cachedTokens || 0) - this._loggedUsage.cachedTokens),
        };
        if (delta.input_tokens === 0 && delta.output_tokens === 0) return; // zero strzałów = nie ma czego księgować
        this._loggedUsage = {
            inputTokens: usage.inputTokens || 0,
            outputTokens: usage.outputTokens || 0,
            cachedTokens: usage.cachedTokens || 0,
        };
        const costLog = new CostLog(this.agentMemory.vault);
        await costLog.append({
            agent: this.agentName,
            role: 'memory-consolidation',
            model: this.getModelName() || 'unknown',
            ...delta,
            status: summary.failed > 0 ? 'error' : 'ok',
        });
    }

    _onStall({ stepId, willRetry }: StallInfo): void {
        if (willRetry) return; // pierwsze zwisnięcie ponawiamy po cichu (polityka J ze specu)
        this._notifyFailed([stepId]);
    }

    /** Notice'y wynikające z jednej rundy generacji: pady kroków + awaryjny fallback bez modelu. */
    _reportOutcome(outcome: GenerationOutcome | GatedOutcome | null | undefined): void {
        if (!outcome) return;
        this._notifyFailed(outcome.failed || []);

        const fresh = (outcome.generated || []).filter((stepId: string) => {
            if (this._fallbackNotified.has(stepId)) return false;
            return isFallbackStep(this.run.getStep(stepId) as unknown as ConsolidationStepLike);
        });
        if (fresh.length > 0) {
            for (const stepId of fresh) this._fallbackNotified.add(stepId);
            // Spec H: awaryjne sklejenie treści (bez LLM) przestaje być ciche.
            notice(this.plugin, t('memory.consolidation.notice_fallback', { count: fresh.length }), {
                type: 'warning',
                timeout: 10000,
            });
        }
    }

    _notifyFailed(stepIds: string[] = []): void {
        const fresh = stepIds.filter((id: string) => !this._failNotified.has(id));
        if (fresh.length === 0) return;
        for (const id of fresh) this._failNotified.add(id);
        log.warn('ConsolidationRunner', `Kroki padły: ${fresh.map(id => stepLabel(this.run.getStep(id) as unknown as ConsolidationStepLike)).join(', ')}`);
        notice(this.plugin, t('memory.consolidation.notice_failed', { count: fresh.length }), {
            type: 'error',
            timeout: 12000,
        });
    }
}

/**
 * Otwiera (albo przywraca) modal przebiegu. Jedno okno na raz.
 *
 * Klasa modalu jest ładowana LENIWIE — i po S31 (modal mieszka tuż obok, w tym samym module)
 * powód został JEDEN: modal statycznie importuje `obsidian`, a statyczny import stąd zaciągnąłby
 * go do całego tego pliku — najbardziej stanowego kawałka S29 — i wywalił jego testowalność
 * w AVA (node nie rozwiąże `obsidian`). Dynamiczny import siedzi w jedynym miejscu, które
 * modalu naprawdę potrzebuje.
 */
export async function openConsolidationModal(app: Runtime, run: ConsolidationRun | null): Promise<ConsolidationModalLike | null> {
    if (!run) return null;
    if (openModal && openModal.run === run) return openModal; // szybka ścieżka: bez importu

    const ModalClass: ConsolidationModalConstructor = modalClassOverride
        || (await import('./ConsolidationProgressModal.js')).ConsolidationProgressModal as unknown as ConsolidationModalConstructor;

    // Po awaicie stan modułu mógł się zmienić (drugi klik w 🧠) — sprawdzamy jeszcze raz.
    if (openModal) {
        if (openModal.run === run) return openModal;
        openModal.close();
        openModal = null;
    }
    const controller = CONTROLLERS.get(run);
    const modal = new ModalClass(app, {
        run,
        controller,
        agentName: controller?.agentName || run.agentName || '',
        onClosed: () => { if (openModal === modal) openModal = null; },
    });
    openModal = modal;
    modal.open();
    return modal;
}

/**
 * Klik w 🧠 na pasku statusu → `MemoryOpsCenter.requestOpenModal()` → to tutaj.
 * Idempotentne dla TEGO SAMEGO `app`: subskrypcja zakładana raz, przy pierwszym przebiegu.
 *
 * ⚠️ Dev-reload pluginu buduje NOWY obiekt `app`, a stara subskrypcja trzyma poprzedni w domknięciu
 * — modal otwierałby się w martwym workspace (albo wcale). Dlatego zmiana `app` odpina starą
 * subskrypcję i zakłada świeżą, zamiast po cichu zwrócić zombie.
 *
 * AUD-dead-code-231 (2026-09-02): `export` zdjęty — jedyny wołacz jest w tym pliku
 * (`startConsolidationRun`); poza modułem nikt tej funkcji nie importował.
 */
function registerConsolidationModalOpener(app: Runtime): (() => void) | null {
    if (openerUnsubscribe && openerApp === app) return openerUnsubscribe;
    if (openerUnsubscribe) {
        try { openerUnsubscribe(); } catch { /* best-effort */ }
        openerUnsubscribe = null;
    }
    openerApp = app;
    openerUnsubscribe = memoryOpsCenter.subscribe(({ type, run }: OpsEvent) => {
        if (type !== OPS_EVENT.OPEN_MODAL_REQUESTED) return;
        const target = run || memoryOpsCenter.getActiveRun();
        if (!target) return;
        openConsolidationModal(app, target as ConsolidationRun).catch((e: unknown) =>
            log.error('ConsolidationRunner', `Otwarcie modalu przebiegu padło: ${(e as ErrLike)?.message || String(e)}`));
    });
    return openerUnsubscribe;
}

/**
 * Startuje przebieg konsolidacji NOWYM torem (generacja ≠ aplikacja, wszystkie paczki L1
 * w jednym przebiegu). Nie blokuje wołającego — generacja leci w tle.
 *
 * @param {'auto'|'manual'} [params.source='manual'] - kto odpalił. `manual` (guzik w profilu,
 *   `/memory`) przy pustym planie mówi „nie ma czego konsolidować"; `auto` (próg po zapisie sesji,
 *   idle-scheduler) MILCZY — patrz komentarz przy pustym planie niżej.
 * @returns {Promise<Object|null>} przebieg (własny albo ten, który już leciał) lub null,
 *   gdy nie ma czego konsolidować.
 */
export async function startConsolidationRun({ plugin, app, agentMemory, agent, model, settings = {}, source = 'manual' }: StartConsolidationOptions): Promise<ConsolidationRun | null> {
    if (!agentMemory) return null;
    const agentName = agent?.name || agentMemory.agentName || '';
    const batchSize = Number(settings.memoryV3ArchiveBatchSize) || 5;

    const [uncoveredSessions, brainNotes, l1s, l2s] = await Promise.all([
        listUncoveredSessions(agentMemory),
        agentMemory.listBrainNotes ? agentMemory.listBrainNotes() : [],
        listUncoveredSummaries(agentMemory, 'l1'),
        listUncoveredSummaries(agentMemory, 'l2'),
    ]);

    let dedupThreshold = Number(settings.memoryV3BrainNotesThreshold) || 20;
    try {
        const state = await agentMemory.stateManager.read();
        dedupThreshold = Number(state?.brain_notes_limit) || dedupThreshold;
    } catch { /* brak .state.json → zostaje default */ }

    const steps = buildConsolidationPlan({
        archiveCount: uncoveredSessions.length,
        batchSize,
        brainNotesCount: brainNotes.length,
        dedupThreshold,
        l1Count: l1s.length,
        l2Count: l2s.length,
    });

    if (steps.length === 0) {
        // Z4.4 (2026-07-30): automat MILCZY na pusty plan. Licznik
        // `archived_since_last_consolidation` zeruje się dopiero przy realnym zapisie paczki L1,
        // więc gdy niepokrytych sesji jest MNIEJ niż `batchSize`, a licznik już przebił próg,
        // KAŻDY kolejny zapis sesji trafiał tutaj — i user dostawał „nie ma czego konsolidować"
        // po każdym `/save session`, w nieskończoność. Licznika świadomie NIE zerujemy: materiał
        // wciąż rośnie do pełnej paczki, próg ma zostać przebity.
        if (source === 'auto') {
            log.debug('ConsolidationRunner', 'Auto-trigger: pusty plan (za mało materiału) — bez notice');
        } else {
            notice(plugin, t('memory.consolidation.notice_nothing'), { timeout: 4000 });
        }
        return null;
    }

    const run = new ConsolidationRun({ steps, agentName });
    registerConsolidationModalOpener(app);

    const active = memoryOpsCenter.startRun(run) as ConsolidationRun;
    if (active !== run) {
        // Centrum było zajęte — `startRun` samo poprosiło o modal bieżącego przebiegu.
        notice(plugin, t('memory.consolidation.notice_busy'), { timeout: 4000 });
        return active;
    }

    const workflow = new ArchiveWorkflow(agentMemory, {
        settings, agent, model: model as StreamChatModelLike | null, batchSize,
        archiveSessions: uncoveredSessions, // ta sama lista, którą policzył plan — bez drugiego czytania
    });
    const controller = new RunController({ plugin, app, run, workflow, agentMemory, agentName, model, settings });
    CONTROLLERS.set(run, controller);

    notice(plugin, t('memory.consolidation.notice_start', { plan: planToText(run as unknown as ConsolidationRunLike) }), { timeout: 8000 });
    await openConsolidationModal(app, run);

    // Fire-and-forget: user wraca do czatu, przebieg mieli w tle.
    controller.generate().catch((e: unknown) => {
        log.error('ConsolidationRunner', `Przebieg konsolidacji padł: ${(e as ErrLike)?.message || String(e)}`);
        notice(plugin, t('memory.consolidation.notice_error', { reason: (e as ErrLike)?.message || String(e) }), {
            type: 'error',
            timeout: 10000,
        });
        if (memoryOpsCenter.getActiveRun() === run) memoryOpsCenter.finishRun();
    });

    return run;
}
