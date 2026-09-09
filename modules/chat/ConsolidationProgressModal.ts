import { Modal, Notice, type App } from 'obsidian';
import type {
    ConsolidationRun,
    ConsolidationRunLike,
    ConsolidationStep,
    ConsolidationStepLike,
    StepDecision,
} from '../memory/index.js';
import { t } from '../../core/i18n/index.js';
import {
    STEP_KIND,
    STEP_STATUS,
    stepLabel,
    stepDetail,
    stepStatusIcon,
    stepStatusLabel,
    stepDurationMs,
    isFallbackStep,
    formatDuration,
    formatUsageLine,
    buildRunSummary,
    summaryToText,
    memoryOpsCenter,
} from '../memory/index.js';
import {
    renderDedupReview,
    renderSummaryReview,
    renderReviewBanner,
} from './archiveReviewRenders.js';
import { isRunStuck, resolveStepDraft } from './consolidationRunState.js';

// TS-any: kontroler przebiegu i plugin są składane runtime w consolidationRunner i nie mają publicznego kontraktu.
type Runtime = any;

interface ProgressController {
    plugin?: Runtime;
    applyDecision?(stepId: string, decision: StepDecision): unknown;
    retry?(stepId: string): unknown;
    skip?(stepId: string): unknown;
    getModelName?(): string | undefined;
    finishIfSettled?(): unknown;
}

interface ProgressModalOptions {
    run?: ConsolidationRun | null;
    controller?: ProgressController | null;
    agentName?: string;
    onClosed?: () => void;
}

interface ReviewPanel {
    stepId: string;
    mode: 'review' | 'preview';
    getDecision: (() => StepDecision) | null;
}

type NoticeOptions = { type?: string; timeout?: number };

/**
 * ConsolidationProgressModal - „Puls pamięci": okno, w którym widać CAŁY przebieg
 * konsolidacji pamięci, a nie tylko gotowy wynik ostatniej fazy.
 *
 * Czym różni się od `ArchiveModal` (stary tor):
 *  - NIE BLOKUJE. Zamknięcie okna nie przerywa roboty - przebieg leci dalej w tle, a wraca się
 *    do niego klikiem w 🧠 na pasku statusu (`MemoryOpsCenter.requestOpenModal`).
 *  - Pokazuje CHECKLISTĘ wszystkich kroków (dedup + N paczek L1 + L2 + L3) z ikoną statusu,
 *    czasem i tym, co z kroku wynikło - user od pierwszej sekundy wie, ile jeszcze zostało.
 *  - Review dzieje się W ŚRODKU tego okna (panel pod checklistą), a nie w osobnym modalu.
 *    Można przejrzeć pierwszą paczkę L1, gdy piąta dopiero się liczy.
 *  - Krok, który padł, ma „Ponów" i „Pomiń" - bez tego jedna zdechła paczka blokowała L2.
 *
 * Modal jest GŁUPI: całą robotę (aplikacja decyzji, retry, bramkowanie L2/L3, notice, koszt)
 * robi kontroler przebiegu z `modules/chat/chat/consolidationRunner.js`. Tutaj jest tylko widok.
 */
export class ConsolidationProgressModal extends Modal {
    declare run: ConsolidationRun | null;
    declare controller: ProgressController | null;
    declare agentName: string;
    declare _onClosed: (() => void) | null;
    declare _unsubRun: (() => void) | null;
    // `window.setInterval` (obsidianmd/prefer-window-timers) zwraca `number`
    // (typ DOM), nie `NodeJS.Timeout` - `ReturnType<typeof window.setInterval>` sam się myli
    // (typ `window` to `Window & typeof globalThis`, więc przecina się z globalnym `setInterval`
    // z @types/node), więc typ pola wpisany wprost jako `number`.
    declare _tickTimer: number | null;
    declare _panel: ReviewPanel | null;
    declare _busyStepId: string | null;
    declare _checklistEl: HTMLDivElement | null;
    declare _costEl: HTMLDivElement | null;
    declare _panelEl: HTMLDivElement | null;
    declare _footerEl: HTMLDivElement | null;
    /** stepId → element „· 38s" (sekundnik zamiast pełnej przebudowy listy). */
    declare _stepTimeEls: Map<string, HTMLElement>;
    /**
     * @param {Object} app - Obsidian App
     * @param {Object} opts
     * @param {Object} opts.run - ConsolidationRun (źródło prawdy widoku)
     * @param {Object} opts.controller - `{ applyDecision, retry, skip, getModelName, finishIfSettled }`
     * @param {string} [opts.agentName]
     * @param {() => void} [opts.onClosed] - żeby opener wiedział, że okna już nie ma
     */
    constructor(app: App, opts: ProgressModalOptions = {}) {
        super(app);
        this.run = opts.run || null;
        this.controller = opts.controller || null;
        this.agentName = opts.agentName || this.run?.agentName || '';
        this._onClosed = typeof opts.onClosed === 'function' ? opts.onClosed : null;

        this._unsubRun = null;
        this._tickTimer = null;
        /** Otwarty panel: `{ stepId, mode: 'review'|'preview', getDecision }`. */
        this._panel = null;
        this._busyStepId = null;

        this._checklistEl = null;
        this._costEl = null;
        this._panelEl = null;
        this._footerEl = null;
        // stepId → element z czasem kroku (sekundnik podmienia sam tekst).
        this._stepTimeEls = new Map();
    }

    onOpen() {
        const { contentEl, modalEl } = this;
        contentEl.empty();
        contentEl.addClass('cs-consolidation-modal');
        if (modalEl) modalEl.addClass('cs-archive-modal-wide');

        contentEl.createEl('h2', { text: t('modal.consolidation.title', { agent: this.agentName }) });
        contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: t('modal.consolidation.subtitle'),
        });

        if (!this.run) {
            contentEl.createDiv({ cls: 'pkm-review__empty', text: t('modal.consolidation.no_run') });
            return;
        }

        this._checklistEl = contentEl.createDiv({ cls: 'cs-consolidation__checklist' });
        this._costEl = contentEl.createDiv({ cls: 'cs-consolidation__cost' });
        this._panelEl = contentEl.createDiv({ cls: 'cs-consolidation__panel pkm-review' });
        this._footerEl = contentEl.createDiv({ cls: 'cs-consolidation__footer' });

        // Jedyny kanał odświeżania: zmiany samego przebiegu. Działa też PO `finishRun()`
        // (user może ponowić padnięty krok z sekcji podsumowania, gdy centrum już nie nadaje).
        this._unsubRun = this.run.addChangeListener?.(() => this._refresh()) || null;
        // Sekundnik dla kroku w biegu („· 38s"). Chodzi tylko wtedy, gdy naprawdę coś mieli.
        // Tyknięcie podmienia TEKST CZASU aktywnego kroku, nie przebudowuje
        // całej checklisty. Pełny `_renderChecklist` zostaje dla zdarzeń zmiany przebiegu
        // (`addChangeListener` → `_refresh`, linia wyżej) - tylko one zmieniają cokolwiek poza
        // sekundnikiem. Pełny render co sekundę oznaczałby `parent.empty()` + budowę WSZYSTKICH
        // wierszy (a każdy wiersz to kilka `createDiv`/`createSpan`, `t()` i nowe guziki
        // z nowymi listenerami) - przez cały czas mielenia przebiegu, czyli minuty.
        this._tickTimer = window.setInterval(() => this._tickActiveStep(), 1000);

        this._refresh();
    }

    onClose() {
        if (this._tickTimer) window.clearInterval(this._tickTimer);
        this._tickTimer = null;
        this._stepTimeEls.clear(); // uchwyty do węzłów zamkniętego okna
        try { this._unsubRun?.(); } catch { /* best-effort */ }
        this._unsubRun = null;
        // Rozstrzygnięty przebieg zwalnia centrum (pasek statusu gaśnie) - zamknięcie okna to
        // naturalny moment. Gdy przebieg jeszcze leci, NIC nie przerywamy.
        try { this.controller?.finishIfSettled?.(); } catch { /* best-effort */ }
        try { this._releaseIfStuck(); } catch { /* best-effort */ }
        this._onClosed?.();
    }

    /**
     * Awaryjne zwolnienie centrum operacji, gdy przebieg UTKNĄŁ (patrz `isRunStuck`).
     *
     * Scenariusz: paczka L1 padła, L2/L3 wiszą pod kłódką, user zamyka okno. Nikt już nie kliknie
     * „Ponów"/„Pomiń", więc `isSettled()` nigdy nie będzie prawdą - a bez tego `MemoryOpsCenter`
     * zostaje zajęty aż do restartu Obsidiana (🧠 świeci wiecznie, kolejny zapis sesji nie może
     * ruszyć konsolidacji). Zamknięcie okna przy kroku `awaiting_review` NIC nie zwalnia - to
     * normalna przerwa, pasek ma świecić i pozwalać wrócić.
     *
     * Nic nie ginie: niedokończone paczki wrócą przy następnym zapisie sesji, a sesje pokryte
     * przez zaakceptowane L1 mają stempel `covered_by_l1` i nie policzą się drugi raz.
     */
    _releaseIfStuck(): void {
        if (!this.run || !isRunStuck(this.run)) return;
        if (memoryOpsCenter.getActiveRun() !== this.run) return;
        memoryOpsCenter.finishRun();
        this._notice(t('memory.consolidation.notice_postponed'), { type: 'warning', timeout: 9000 });
    }

    /** Notice pluginu (kryształowy, jak reszta komunikatów konsolidacji) z awaryjnym fallbackiem. */
    _notice(message: string, opts: NoticeOptions = {}): void {
        const plugin = this.controller?.plugin;
        try {
            if (typeof plugin?.showCrystalNotice === 'function') {
                plugin.showCrystalNotice(message, opts);
                return;
            }
        } catch { /* spadamy na zwykły Notice */ }
        try { new Notice(message, opts.timeout || 8000); } catch { /* best-effort */ }
    }

    // ── Odświeżanie ────────────────────────────────────────────────────

    _refresh(): void {
        if (!this._checklistEl) return;
        // Panel review zamykamy, gdy jego krok przestał czekać na decyzję (np. sami go właśnie
        // zaaplikowaliśmy albo user kliknął „Pomiń" na liście).
        if (this._panel?.mode === 'review') {
            const step = this.run!.getStep(this._panel.stepId);
            if (!step || step.status !== STEP_STATUS.AWAITING_REVIEW) this._closePanel();
        }
        this._renderChecklist();
        this._renderFooter();
    }

    /**
     * Jedno tyknięcie sekundnika = jedna podmiana `textContent`.
     *
     * Uchwyt do elementu czasu bierzemy z mapy zbudowanej przy renderze checklisty. Gdy kroku
     * nie ma w mapie (wiersz powstał ZANIM czas przekroczył zero, więc `_renderStepRow` nie
     * stworzył elementu), robimy jednorazowo pełny render — od następnego tyknięcia jedzie już
     * tania ścieżka.
     */
    _tickActiveStep(): void {
        const step = this.run?.getActiveStep?.();
        if (!step) return;
        const duration = stepDurationMs(step as unknown as ConsolidationStepLike);
        if (duration <= 0) return;
        const el = this._stepTimeEls.get(step.id);
        if (!el) {
            this._renderChecklist();
            return;
        }
        el.textContent = `· ${formatDuration(duration)}`;
    }

    _renderChecklist(): void {
        const parent = this._checklistEl;
        if (!parent) return;
        parent.empty();
        this._stepTimeEls.clear();

        for (const step of this.run!.getSteps()) {
            this._renderStepRow(parent, step);
        }

        if (this._costEl) {
            this._costEl.empty();
            this._costEl.createSpan({
                text: formatUsageLine(this.run!.totalUsage(), this.controller?.getModelName?.()),
            });
        }
    }

    _renderStepRow(parent: HTMLElement, step: ConsolidationStep): void {
        const row = parent.createDiv({ cls: `cs-consolidation__step cs-consolidation__step--${step.status}` });
        if (this._panel?.stepId === step.id) row.addClass('is-open');

        const head = row.createDiv({ cls: 'cs-consolidation__step-head' });
        head.createSpan({ text: stepStatusIcon(step.status), cls: 'cs-consolidation__step-icon' });
        const label = head.createSpan({ text: stepLabel(step as unknown as ConsolidationStepLike), cls: 'cs-consolidation__step-label' });
        label.setAttr?.('title', stepStatusLabel(step.status));

        const duration = stepDurationMs(step as unknown as ConsolidationStepLike);
        if (duration > 0) {
            // Uchwyt zapamiętany — sekundnik podmienia w nim sam tekst.
            this._stepTimeEls.set(step.id, head.createSpan({ text: `· ${formatDuration(duration)}`, cls: 'cs-consolidation__step-time' }));
        }

        this._renderStepActions(head, step);

        const detail = stepDetail(step as unknown as ConsolidationStepLike);
        if (detail) row.createDiv({ text: detail, cls: 'cs-consolidation__step-detail' });
        if (isFallbackStep(step as unknown as ConsolidationStepLike)) {
            row.createDiv({ text: t('modal.consolidation.fallback_warning'), cls: 'cs-consolidation__step-warning' });
        }
        if (step.status === STEP_STATUS.APPLYING || this._busyStepId === step.id) {
            row.createDiv({ text: t('modal.consolidation.applying'), cls: 'cs-consolidation__step-detail' });
        }
    }

    _renderStepActions(parent: HTMLElement, step: ConsolidationStep): void {
        const actions = parent.createDiv({ cls: 'cs-consolidation__step-actions' });
        const busy = this._busyStepId === step.id;

        if (step.status === STEP_STATUS.AWAITING_REVIEW) {
            this._smallButton(actions, t('modal.consolidation.review_cta'), busy, () => this._openReview(step.id));
            return;
        }
        if (step.status === STEP_STATUS.FAILED) {
            this._smallButton(actions, t('modal.consolidation.retry_cta'), busy, () => { void this._retry(step.id); });
            this._smallButton(actions, t('modal.consolidation.skip_cta'), busy, () => { void this._skip(step.id); });
            return;
        }
        if (step.status === STEP_STATUS.DONE && (step.result || step.applied)) {
            this._smallButton(actions, t('modal.consolidation.preview_cta'), busy, () => this._openPreview(step.id));
        }
    }

    _smallButton(parent: HTMLElement, label: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
        const button = parent.createEl('button', { text: label, cls: 'cs-consolidation__step-btn' });
        button.disabled = Boolean(disabled);
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            onClick();
        });
        return button;
    }

    _renderFooter(): void {
        const parent = this._footerEl;
        if (!parent) return;
        parent.empty();

        if (this.run!.isSettled()) {
            const summary = buildRunSummary(this.run as unknown as ConsolidationRunLike);
            const box = parent.createDiv({ cls: 'cs-consolidation__summary' });
            box.createEl('h3', { text: t('modal.consolidation.summary_header') });
            box.createDiv({
                text: t('modal.consolidation.summary_line', {
                    summary: summaryToText(summary),
                    duration: formatDuration(summary.durationMs),
                    usage: formatUsageLine(summary.usage, this.controller?.getModelName?.()),
                }),
            });
            if (summary.failed > 0) {
                box.createDiv({
                    text: t('modal.consolidation.summary_failed', { count: summary.failed }),
                    cls: 'cs-consolidation__step-warning',
                });
            }
        }

        const actions = parent.createDiv({ cls: 'pkm-review__actions' });
        const close = actions.createEl('button', { text: t('modal.consolidation.close') });
        close.addClass('mod-cta');
        close.addEventListener('click', () => this.close());
    }

    // ── Panel review / podglądu ────────────────────────────────────────

    _closePanel(): void {
        this._panel = null;
        this._panelEl?.empty();
    }

    _openReview(stepId: string): void {
        const step = this.run!.getStep(stepId);
        if (!step || step.status !== STEP_STATUS.AWAITING_REVIEW) return;

        this._panelEl!.empty();
        this._panel = { stepId, mode: 'review', getDecision: null };

        this._panelEl!.createEl('h3', { text: t('modal.consolidation.review_title', { step: stepLabel(step as unknown as ConsolidationStepLike) }) });
        if (isFallbackStep(step as unknown as ConsolidationStepLike)) {
            renderReviewBanner(this._panelEl!, t('modal.consolidation.fallback_warning'));
        }

        // Szkic żyje na KROKU, nie w panelu: zwinięcie panelu (albo zamknięcie i ponowne otwarcie
        // okna) nie może wyrzucić poprawek usera i wrócić do wersji modelu.
        const proposal = step.result || {};
        const isDedup = step.kind === STEP_KIND.DEDUP;
        const draft: Runtime = resolveStepDraft(step as Runtime, { dedup: isDedup });
        if (isDedup) {
            renderDedupReview(this._panelEl!, {
                merges: draft.merges,
                deletions: draft.deletions,
                llmDriven: proposal.llmDriven,
            });
            this._panel.getDecision = () => ({ accepted: true, merges: draft.merges, deletions: draft.deletions });
        } else {
            const review = renderSummaryReview(this._panelEl!, {
                sources: proposal.sessions || proposal.l1_files || proposal.l2_files || [],
                body: draft.body,
                onChange: (value) => { draft.body = value; },
            });
            this._panel.getDecision = () => ({ accepted: true, body: review.getBody() });
        }

        const actions = this._panelEl!.createDiv({ cls: 'pkm-review__actions' });
        const reject = actions.createEl('button', { text: t('modal.consolidation.reject') });
        reject.addEventListener('click', () => { void this._decide(stepId, { accepted: false }); });
        const save = actions.createEl('button', { text: t('modal.consolidation.save') });
        save.addClass('mod-cta');
        save.addEventListener('click', () => { void this._decide(stepId, this._panel?.getDecision?.() || { accepted: true }); });
        const collapse = actions.createEl('button', { text: t('modal.consolidation.panel_close') });
        collapse.addEventListener('click', () => { this._closePanel(); this._renderChecklist(); });

        this._renderChecklist();
    }

    /** Podgląd zamkniętego kroku — read-only, żeby user mógł sprawdzić co poszło na dysk. */
    _openPreview(stepId: string): void {
        const step = this.run!.getStep(stepId);
        if (!step) return;

        this._panelEl!.empty();
        this._panel = { stepId, mode: 'preview', getDecision: null };
        this._panelEl!.createEl('h3', { text: t('modal.consolidation.preview_title', { step: stepLabel(step as unknown as ConsolidationStepLike) }) });

        const proposal = step.result || {};
        // To, co NAPRAWDĘ poszło na dysk = treść z decyzji usera (po jego edycjach), a dopiero
        // w jej braku propozycja modelu. Wcześniej podgląd po zapisie pokazywał wersję modelu.
        const savedBody = (step.decision as StepDecision | null)?.body ?? proposal.body;
        if (step.kind === STEP_KIND.DEDUP) {
            this._panelEl!.createDiv({
                text: t('modal.consolidation.preview_dedup_applied', {
                    merged: step.applied?.merged || 0,
                    deleted: step.applied?.deleted || 0,
                }),
            });
        } else if (savedBody) {
            if (step.applied?.name) {
                this._panelEl!.createDiv({ text: t('modal.consolidation.preview_applied', { name: step.applied.name }) });
            }
            renderSummaryReview(this._panelEl!, {
                sources: proposal.sessions || proposal.l1_files || proposal.l2_files || [],
                body: savedBody,
                rows: 10,
                readOnly: true,
            });
        } else {
            this._panelEl!.createDiv({ cls: 'pkm-review__empty', text: t('modal.consolidation.preview_empty') });
        }

        const actions = this._panelEl!.createDiv({ cls: 'pkm-review__actions' });
        const collapse = actions.createEl('button', { text: t('modal.consolidation.panel_close') });
        collapse.addEventListener('click', () => { this._closePanel(); this._renderChecklist(); });

        this._renderChecklist();
    }

    // ── Akcje (delegowane do kontrolera przebiegu) ─────────────────────

    async _decide(stepId: string, decision: StepDecision): Promise<void> {
        await this._withBusy(stepId, () => this.controller?.applyDecision?.(stepId, decision));
    }

    async _retry(stepId: string): Promise<void> {
        await this._withBusy(stepId, () => this.controller?.retry?.(stepId));
    }

    async _skip(stepId: string): Promise<void> {
        await this._withBusy(stepId, () => this.controller?.skip?.(stepId));
    }

    async _withBusy(stepId: string, fn: () => unknown): Promise<void> {
        this._busyStepId = stepId;
        this._renderChecklist();
        try {
            await fn();
        } finally {
            this._busyStepId = null;
            // Modal mógł zostać zamknięty w trakcie zapisu — wtedy nie ma czego odświeżać.
            if (this._checklistEl) this._refresh();
        }
    }
}
