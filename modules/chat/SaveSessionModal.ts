import { Modal, type App } from 'obsidian';
import { t } from '../../core/i18n/index.js';

type ModalState = 'loading' | 'proposals';
type SaveAction = 'archive' | 'archive_close' | 'archive_new' | 'cancel';

interface SessionNote {
    name?: string;
    section?: string;
    description?: string;
    content?: string;
    accepted?: boolean;
    /**
     * D8 (2026-08-27, werdykt 27.08) + weryfikacja opusa (nit 2): obecne WYŁĄCZNIE dla
     * propozycji dołożonych z poczekalni `brain/pending_rescue/` (`SaveSessionWorkflow.
     * _proposePendingRescue`). `SaveSessionWorkflow.applyDecision` rozpoznaje po tym polu,
     * czy accept/reject ma iść przez `acceptPendingRescue`/`rejectPendingRescue`, czy zwykłą
     * ścieżkę tworzenia notatki. Dziś przeżywa round-trip przez ten modal tylko dlatego, że
     * `setProposals`/`_resolveWith` operują na SPREADACH (`{...note, accepted: ...}`) — gdyby
     * ktoś kiedyś dopisał tu jawną rekonstrukcję pól (jak `_normalizeUpdate` niżej dla
     * `BrainUpdate`), a zapomniał o tych trzech polach, kandydat zgubiłby `pendingFilename`
     * po cichu: `applyDecision` potraktowałby go jak zwykłą notatkę (utworzyłby DRUGĄ kopię
     * przez `_createBrainNote`), a oryginał zostałby w poczekalni NA ZAWSZE (nic już go stamtąd
     * nie skasuje — dublowałby się przy KAŻDEJ kolejnej rundzie `/save session`). Trzymaj te
     * pola przy każdej zmianie sposobu, w jaki `SessionNote` jest budowany/kopiowany.
     */
    pendingFilename?: string;
    /** Opis BEZ prefiksu pochodzenia „[z kompresji okna, DATA]" — patrz pole niżej i pole wyżej. */
    pendingOriginalDescription?: string;
    /** Dokładnie ta wartość została wstawiona jako startowy `description` w tym modalu. */
    pendingPrefixedDescription?: string;
}

interface BrainUpdate {
    action: string;
    section: string;
    content: string;
    oldContent: string;
    why: string;
    accepted: boolean;
}

interface SaveSessionPayload {
    action: SaveAction;
    notes: SessionNote[];
    brainUpdates: BrainUpdate[];
}

interface SaveSessionModalOptions {
    agentName?: string;
    messageCount?: number;
    state?: ModalState;
    llmDriven?: boolean;
    notes?: SessionNote[];
    brainUpdates?: Array<Partial<BrainUpdate> | null>;
}

/**
 * SaveSessionModal — Memory v3 review modal for `/save session`.
 *
 * State machine:
 *   1. 'loading' — opened immediately, shows spinner while the agent (LLM) analyzes the session.
 *      Caller (slash handler) calls `setProposals(...)` once the workflow returns proposals.
 *   2. 'proposals' — renders 4 columns (NEW NOTES, ADD, UPDATE, DELETE) with per-item Accept,
 *      plus the 4 action buttons (Archiwizuj / Archiwizuj+zamknij / Archiwizuj+nowa / Anuluj).
 *
 * Resolve payload:
 *   { action, notes, brainUpdates }
 *   - notes: only the accepted ones, with possibly user-edited name/description/content
 *   - brainUpdates: legacy entries kept for old payloads; index mode ignores them
 */
export class SaveSessionModal extends Modal {
    declare agentName: string;
    declare messageCount: number;
    declare state: ModalState;
    declare llmDriven: boolean;
    declare notes: SessionNote[];
    declare brainUpdates: BrainUpdate[];
    declare _resolve: ((payload: SaveSessionPayload) => void) | null;
    declare _loadingStartedAt: number | null;
    // release 2.2.0/W2: `window.setInterval`/`window.setTimeout` (obsidianmd/prefer-window-timers)
    // zwracają `number` (typ DOM), nie `NodeJS.Timeout` — `ReturnType<typeof window.setInterval>`
    // sam się myli (typ `window` to `Window & typeof globalThis`, więc przecina się z globalnym
    // `setInterval` z @types/node), więc typy pól wpisane wprost jako `number`.
    declare _loadingTimer: number | null;
    declare _loadingTimerEl: HTMLDivElement | null;
    declare _loadingHintEl: HTMLDivElement | null;
    declare _loadingPulseTimer: number | null;
    declare _loadingError: string | null;
    declare _retryResolve: (() => void) | null;

    constructor(app: App, opts: SaveSessionModalOptions = {}) {
        super(app);
        this.agentName = opts.agentName || 'Agent';
        this.messageCount = opts.messageCount || 0;
        this.state = opts.state === 'loading' ? 'loading' : 'proposals';
        this.llmDriven = Boolean(opts.llmDriven);

        this.notes = (opts.notes || []).map(note => ({ ...note, accepted: note.accepted !== false }));
        this.brainUpdates = (opts.brainUpdates || []).map(u => this._normalizeUpdate(u));

        this._resolve = null;

        // S29 Z6 — faza loading przestaje być ekranem „coś się dzieje, nie wiadomo co":
        // sekundnik na żywo (koniec obietnicy „zwykle 4-10s"), puls na chunkach modelu
        // i możliwość ponowienia, gdy strzał padnie albo zwiśnie.
        this._loadingStartedAt = null;
        this._loadingTimer = null;
        this._loadingTimerEl = null;
        this._loadingHintEl = null;
        this._loadingPulseTimer = null;
        this._loadingError = null;
        this._retryResolve = null;
    }

    /**
     * Switch from 'loading' state to 'proposals' state. Re-renders the modal body.
     * Called by the slash handler after workflow.prepareProposals() resolves.
     */
    setProposals(payload: SaveSessionModalOptions = {}): void {
        this.agentName = payload.agentName || this.agentName;
        this.messageCount = payload.messageCount ?? this.messageCount;
        this.llmDriven = Boolean(payload.llmDriven);
        this.notes = (payload.notes || []).map(note => ({ ...note, accepted: note.accepted !== false }));
        this.brainUpdates = (payload.brainUpdates || []).map(u => this._normalizeUpdate(u));
        this.state = 'proposals';
        this._stopLoadingTimer();
        if (this.contentEl) this._renderCurrentState();
    }

    // S29 Z6: `setError(message)` USUNIĘTY — jego jedyny wołacz (`save_session.js`) po padzie LLM
    // dorysowywał banner i JECHAŁ DALEJ z pustymi propozycjami, udając, że wszystko gra.
    // Teraz pad zatrzymuje flow w fazie loading: `awaitRetry()` pokazuje przyczynę i guzik „Ponów".

    /**
     * S29 Z6: znak życia z modelu (chunk streamu). Zamienia podpowiedź na „Model pisze…" i mruga —
     * user widzi różnicę między „myśli" a „zdechł".
     */
    noteChunk(): void {
        if (this.state !== 'loading' || !this._loadingHintEl) return;
        this._loadingHintEl.textContent = t('modal.save_session.analyzing_writing');
        this._loadingHintEl.addClass('is-pulsing');
        if (this._loadingPulseTimer) window.clearTimeout(this._loadingPulseTimer);
        this._loadingPulseTimer = window.setTimeout(() => {
            this._loadingHintEl?.removeClass?.('is-pulsing');
        }, 400);
    }

    /**
     * S29 Z6: strzał padł (zwis / błąd modelu). Zostajemy w fazie loading, ale zamiast kręcącego
     * się w nieskończoność diamentu user dostaje przyczynę i guzik „Ponów analizę".
     *
     * @returns {Promise<void>} rozstrzyga się, gdy user kliknie „Ponów" (anulowanie idzie normalną
     *   drogą przez `prompt()` → `{action:'cancel'}`).
     */
    awaitRetry(message: string): Promise<void> {
        this._loadingError = message || '';
        this._stopLoadingTimer();
        if (this.contentEl) this._renderCurrentState();
        return new Promise<void>(resolve => { this._retryResolve = resolve; });
    }

    prompt(): Promise<SaveSessionPayload> {
        return new Promise<SaveSessionPayload>(resolve => {
            this._resolve = resolve;
            this.open();
        });
    }

    onOpen() {
        const { contentEl, modalEl } = this;
        contentEl.empty();
        contentEl.addClass('cs-save-session-modal');
        contentEl.addClass('pkm-review');
        if (modalEl) modalEl.addClass('cs-save-session-modal-wide');
        this._renderCurrentState();
    }

    onClose() {
        this._stopLoadingTimer();
        if (!this._resolve) return;
        const resolve = this._resolve;
        this._resolve = null;
        resolve({ action: 'cancel', notes: this.notes, brainUpdates: this.brainUpdates });
    }

    // ── Internal rendering ──────────────────────────────────────────────

    _renderCurrentState(): void {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: t('modal.save_session.title') || 'Zapisz sesję' });
        contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: t('modal.save_session.info', { agent: this.agentName, count: this.messageCount })
                || `Sesja ${this.agentName}: ${this.messageCount} wiadomości.`
        });

        if (this.state === 'loading') {
            this._renderLoading(contentEl);
        } else {
            this._renderProposals(contentEl);
        }
    }

    _renderLoading(parent: HTMLElement): void {
        const wrap = parent.createDiv({ cls: 'cs-save-session__loading' });
        wrap.createDiv({ cls: 'cs-breathing cs-save-session__spinner', text: '◆' });
        wrap.createDiv({
            cls: 'cs-save-session__loading-text',
            text: t('modal.save_session.analyzing', { agent: this.agentName })
        });
        this._loadingHintEl = wrap.createDiv({
            cls: 'cs-save-session__loading-hint',
            text: t('modal.save_session.analyzing_hint')
        });

        if (this._loadingError) {
            this._loadingTimerEl = null; // stary sekundnik odszedł razem z poprzednim renderem
            wrap.createDiv({
                cls: 'cs-save-session__error',
                text: t('modal.save_session.analyzing_failed', { reason: this._loadingError }),
            });
        } else {
            // Sekundnik zamiast obietnicy — kaskada potrafi trwać minuty (S29 Z6).
            this._loadingTimerEl = wrap.createDiv({ cls: 'cs-save-session__loading-timer' });
            this._startLoadingTimer();
        }

        const actions = parent.createDiv({ cls: 'cs-save-session__loading-actions' });
        if (this._loadingError) {
            const retry = actions.createEl('button', { text: t('modal.save_session.analyzing_retry') });
            retry.addClass('mod-cta');
            retry.addEventListener('click', () => this._triggerRetry());
        }
        const cancel = actions.createEl('button', { text: t('generic.cancel') });
        cancel.addEventListener('click', () => this._resolveWith('cancel'));
    }

    _triggerRetry(): void {
        const resolve = this._retryResolve;
        this._retryResolve = null;
        this._loadingError = null;
        this._loadingStartedAt = null; // licznik startuje od zera przy ponowieniu
        this._renderCurrentState();
        resolve?.();
    }

    _startLoadingTimer(): void {
        this._stopLoadingTimer();
        if (!this._loadingStartedAt) this._loadingStartedAt = Date.now();
        const tick = () => {
            if (!this._loadingTimerEl) return;
            const seconds = Math.max(0, Math.round((Date.now() - this._loadingStartedAt!) / 1000));
            this._loadingTimerEl.textContent = t('modal.save_session.analyzing_timer', { seconds });
        };
        tick();
        this._loadingTimer = window.setInterval(tick, 1000);
    }

    _stopLoadingTimer(): void {
        if (this._loadingTimer) window.clearInterval(this._loadingTimer);
        this._loadingTimer = null;
        if (this._loadingPulseTimer) window.clearTimeout(this._loadingPulseTimer);
        this._loadingPulseTimer = null;
    }

    _renderProposals(parent: HTMLElement): void {
        if (this.llmDriven) {
            const banner = parent.createDiv({ cls: 'cs-save-session__llm-banner pkm-review__banner' });
            banner.textContent = t('modal.save_session.llm_driven', { agent: this.agentName })
                || `Propozycje wygenerowane przez ${this.agentName} na bazie transcriptu + brain.md.`;
        }

        this._renderNotesColumn(parent, this.notes);
        this._renderNaTerazColumn(parent, this.brainUpdates);

        const actions = parent.createDiv({ cls: 'cs-save-session__actions pkm-review__actions' });
        this._button(actions, t('modal.save_session.archive') || 'Archiwizuj sesję', 'archive');
        this._button(actions, t('modal.save_session.archive_close') || 'Archiwizuj i zamknij chat', 'archive_close');
        this._button(actions, t('modal.save_session.archive_new') || 'Archiwizuj i nowa sesja', 'archive_new');
        this._button(actions, t('generic.cancel') || 'Anuluj', 'cancel');
    }

    _renderNotesColumn(parent: HTMLElement, notes: SessionNote[]): void {
        const wrap = this._columnWrap(parent, '📒', t('modal.save_session.col_notes') || 'Nowe notatki w brain/', notes.length);
        if (notes.length === 0) {
            this._emptyState(wrap, t('modal.save_session.no_notes') || 'Brak nowych notatek do brain/.');
            return;
        }
        for (const note of notes) {
            const item = this._itemBox(wrap);
            this._itemHeader(item, note.name || 'Notatka', note.section || '## Bieżące', (checked) => {
                note.accepted = checked;
            }, note.accepted !== false);

            const desc = item.createEl('input', { type: 'text', value: note.description || '', cls: 'cs-save-session__note-field' });
            desc.placeholder = t('modal.save_session.note_description_placeholder') || 'Opis (jednolinijkowy)';
            desc.addEventListener('input', () => { note.description = desc.value; });

            const body = item.createEl('textarea', { cls: 'cs-save-session__note-field' });
            body.value = note.content || '';
            body.rows = 4;
            body.addEventListener('input', () => { note.content = body.value; });
        }
    }

    /**
     * E2.8 D3: render the proposed „Na teraz" short-term updates as an accept-able diff
     * (− removed / + added, editable), one item per section. Empty = a friendly no-op state.
     */
    _renderNaTerazColumn(parent: HTMLElement, updates: BrainUpdate[]): void {
        const wrap = this._columnWrap(parent, '🕒', t('modal.save_session.col_na_teraz') || '„Na teraz" — pamięć krótkotrwała', updates.length);
        if (updates.length === 0) {
            this._emptyState(wrap, t('modal.save_session.no_na_teraz') || 'Brak zmian w „Na teraz".');
            return;
        }
        for (const update of updates) {
            const item = this._itemBox(wrap);
            const label = item.createEl('label', { cls: 'pkm-review__row' });
            const checkbox = label.createEl('input', { type: 'checkbox' });
            checkbox.checked = update.accepted !== false;
            checkbox.addEventListener('change', () => { update.accepted = checkbox.checked; });
            label.createSpan({ text: this._naTerazLabel(update.section), cls: 'cs-save-session__na-teraz-badge' });

            const diff = item.createDiv({ cls: 'cs-save-session__diff' });
            const action = String(update.action || 'ADD').toUpperCase();
            if ((action === 'DELETE' || action === 'UPDATE') && update.oldContent) {
                diff.createDiv({ text: `− ${update.oldContent}`, cls: 'cs-save-session__diff-del' });
            }
            if (action === 'ADD' || action === 'UPDATE') {
                const row = diff.createDiv({ cls: 'cs-save-session__diff-row' });
                row.createSpan({ text: '+', cls: 'cs-save-session__diff-plus' });
                const input = row.createEl('input', { type: 'text', value: update.content || '', cls: 'cs-save-session__diff-input' });
                input.addEventListener('input', () => { update.content = input.value; });
            }
        }
    }

    _naTerazLabel(section: string): string {
        if (section === 'environment') return t('modal.save_session.na_teraz_env') || 'Na teraz: Środowisko';
        return t('modal.save_session.na_teraz_user') || 'Na teraz: User';
    }

    _columnWrap(parent: HTMLElement, icon: string, label: string, count: number): HTMLDivElement {
        const wrap = parent.createDiv({ cls: 'cs-save-session__col pkm-review__group' });
        const header = wrap.createDiv({ cls: 'pkm-review__group-header' });
        header.createSpan({ text: icon });
        header.createSpan({ text: label });
        header.createSpan({ text: `(${count})`, cls: 'pkm-review__counter' });
        return wrap;
    }

    _itemBox(parent: HTMLElement): HTMLDivElement {
        return parent.createDiv({ cls: 'pkm-review__item' });
    }

    _itemHeader(
        parent: HTMLElement,
        name: string,
        sectionLabel: string,
        onCheckedChange: (checked: boolean) => void,
        initialChecked: boolean,
    ): HTMLLabelElement {
        const label = parent.createEl('label', { cls: 'pkm-review__item-header' });
        const checkbox = label.createEl('input', { type: 'checkbox' });
        checkbox.checked = initialChecked !== false;
        label.createSpan({ text: name });
        if (sectionLabel) {
            label.createSpan({ text: `→ ${sectionLabel}`, cls: 'cs-save-session__section-badge' });
        }
        checkbox.addEventListener('change', () => onCheckedChange(checkbox.checked));
        return label;
    }

    _emptyState(parent: HTMLElement, message: string): void {
        parent.createDiv({ text: message, cls: 'pkm-review__empty' });
    }

    _button(parent: HTMLElement, label: string, action: SaveAction): HTMLButtonElement {
        const button = parent.createEl('button', { text: label });
        if (action === 'archive') button.addClass('mod-cta');
        button.addEventListener('click', () => this._resolveWith(action));
        return button;
    }

    _resolveWith(action: SaveAction): void {
        if (!this._resolve) return;
        const resolve = this._resolve;
        this._resolve = null;
        resolve({
            action,
            notes: this.notes,
            brainUpdates: this.brainUpdates
        });
        this.close();
    }

    _normalizeUpdate(u: Partial<BrainUpdate> | null): BrainUpdate {
        const action = String(u?.action || 'ADD').toUpperCase();
        return {
            action,
            section: u?.section || '## Bieżące',
            content: u?.content || '',
            oldContent: u?.oldContent || '',
            why: u?.why || '',
            accepted: u?.accepted !== false
        };
    }
}
