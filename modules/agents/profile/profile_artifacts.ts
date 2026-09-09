/**
 * Artifacts tab (Artefakty).
 *
 * Dwie sekcje:
 *  1. INSTANCJE - artefakty żywe tego agenta (`ArtifactStore.list` po frontmatterze). Akcje per wiersz:
 *     Otwórz (workspace.openLinkText), „Dodaj do Vaulta" (modal ze ścieżką + podpowiedzi folderów →
 *     `store.move`), Usuń (confirm → `store.remove`, do kosza).
 *  2. TYPY - checkboxy z biblioteki typów (`ArtifactTypeLoader.getAllTypes`). Zaznaczenie zapisuje
 *     `artifact_types` przez zwykły flow zapisu profilu (formData → handleSave → Agent.update).
 *     Puste = agent widzi tylko wbudowany typ `plan` (sensowny default).
 *
 * Logika sortowania/wierszy = pure helpery z `modules/artifacts` (node-testowalne). Tu tylko DOM.
 */
import { App, Modal, Notice, AbstractInputSuggest, TFolder } from 'obsidian';
import { UiIcons, setSvg } from '../../crystal-soul/index.js';
import { sortArtifactsForView, buildTypeCheckboxRows, toggleTypeName } from '../../artifacts/index.js';
import { t } from '../../../core/i18n/index.js';
import { log } from '../../../core/utils/Logger.js';

// TS-any: Obsidian's augmented HTMLElement helpers are not represented in this module's UI boundary.
type UiBoundary = any;
type ArtifactEntry = { id: string; path: string; tytul?: string; typ?: string; status?: string; zaktualizowano?: string; utworzono?: string };
type ArtifactStore = { list(filters: { agent?: string }): ArtifactEntry[]; move(id: string, folder: string): Promise<boolean>; remove(id: string): Promise<boolean> };
type ArtifactContext = UiBoundary;

/**
 * @param {Object} ctx - shared context {formData, agent, plugin, agentManager, nav, renderActiveTab}
 * @param {HTMLElement} el
 */
export function renderArtifactsTab(ctx: ArtifactContext, el: UiBoundary) {
    _renderInstances(ctx, el);
    _renderTypes(ctx, el);
}

// ─────────────────────────────────────────────────────────────
// INSTANCJE - artefakty żywe tego agenta
// ─────────────────────────────────────────────────────────────

function _renderInstances(ctx: ArtifactContext, el: UiBoundary) {
    const { agent, plugin } = ctx;

    const head = el.createDiv({ cls: 'cs-section-head' });
    setSvg(head, UiIcons.clipboard(14));
    head.createSpan({ text: t('profile.artifacts.instances_header') });

    const store = plugin?.artifactStore;
    if (!store) {
        el.createDiv({ cls: 'cs-picker__empty', text: t('profile.artifacts.no_store') });
        return;
    }

    let list: ArtifactEntry[] = [];
    try {
        list = sortArtifactsForView(store.list({ agent: agent?.name })) as ArtifactEntry[];
    } catch (e) {
        log.warn('profile_artifacts', 'list failed:', e);
    }

    if (list.length === 0) {
        el.createDiv({ cls: 'cs-picker__empty', text: t('profile.artifacts.no_instances') });
        return;
    }

    for (const entry of list) {
        _renderInstanceRow(ctx, el, store, entry);
    }
}

function _renderInstanceRow(ctx: ArtifactContext, el: UiBoundary, store: ArtifactStore, entry: ArtifactEntry) {
    const row = el.createDiv({ cls: 'cs-artifact-manage-row' });

    row.createSpan({ text: '📄', cls: 'cs-artifact-manage-row__icon' });

    const info = row.createDiv({ cls: 'cs-artifact-manage-row__info' });
    info.createDiv({ cls: 'cs-shard__main-label cs-artifact-manage-row__title', text: entry.tytul || entry.id });
    const meta = [entry.typ || '—', _statusLabel(entry.status), entry.zaktualizowano || entry.utworzono || '—']
        .filter(Boolean).join(' · ');
    info.createDiv({ cls: 'cs-shard__sub-label', text: meta });

    const mkBtn = (iconHtml: string, tip: string, handler: () => void) => {
        const btn = row.createEl('button', { cls: 'clickable-icon' });
        setSvg(btn, iconHtml);
        btn.setAttribute('aria-label', tip);
        btn.title = tip;
        btn.addClass('cs-artifact-manage-row__btn');
        btn.addEventListener('click', (e: Event) => { e.stopPropagation(); handler(); });
        return btn;
    };

    mkBtn(UiIcons.externalLink(14), t('profile.artifacts.open'), () => {
        try { ctx.plugin.app.workspace.openLinkText(entry.path, '', false); } catch { new Notice(t('profile.artifacts.open_error')); }
    });

    mkBtn(UiIcons.folder(14), t('profile.artifacts.move'), () => {
        new MoveArtifactModal(ctx.plugin.app, {
            artifact: entry,
            store,
            onDone: () => ctx.renderActiveTab(),
        }).open();
    });

    mkBtn(UiIcons.trash(14), t('profile.artifacts.remove'), () => {
        new ConfirmRemoveModal(ctx.plugin.app, {
            artifact: entry,
            store,
            onDone: () => ctx.renderActiveTab(),
        }).open();
    });
}

// ─────────────────────────────────────────────────────────────
// TYPY - biblioteka typów podpinana per agent (jak skille)
// ─────────────────────────────────────────────────────────────

function _renderTypes(ctx: ArtifactContext, el: UiBoundary) {
    const { formData, plugin } = ctx;

    const head = el.createDiv({ cls: 'cs-section-head cs-section-head--spaced' });
    setSvg(head, UiIcons.clipboard(14));
    head.createSpan({ text: t('profile.artifacts.types_header') });
    el.createDiv({ text: t('profile.artifacts.types_desc'), cls: 'setting-item-description' });

    if (!Array.isArray(formData.artifact_types)) formData.artifact_types = [];

    const loader = plugin?.agentManager?.artifactTypeLoader;
    const allTypes = loader?.getAllTypes?.() || [];
    if (allTypes.length === 0) {
        el.createDiv({ cls: 'cs-picker__empty', text: t('profile.artifacts.no_types') });
        return;
    }

    const rows = buildTypeCheckboxRows(allTypes, formData.artifact_types);
    const grid = el.createDiv({ cls: 'cs-shards cs-shards--compact' });
    for (const rowData of rows) {
        const shard = grid.createDiv({ cls: `cs-shard cs-shard--mcp-server ${rowData.checked ? 'cs-shard--filled' : 'cs-shard--empty'}` });

        const iconEl = shard.createDiv({ cls: 'cs-shard__icon' });
        iconEl.textContent = '📄';

        shard.createDiv({ cls: 'cs-shard__main-label', text: rowData.name });
        if (rowData.opis) shard.createDiv({ cls: 'cs-shard__sub-label', text: rowData.opis });

        const toggle = shard.createDiv({ cls: `cs-toggle ${rowData.checked ? 'cs-toggle--on' : ''}` });
        toggle.addClass('cs-shard__corner-toggle');
        toggle.createDiv({ cls: 'cs-toggle__track' });
        toggle.createDiv({ cls: 'cs-toggle__thumb' });
        toggle.addEventListener('click', (e: Event) => {
            e.stopPropagation();
            formData.artifact_types = toggleTypeName(formData.artifact_types, rowData.name);
            ctx.renderActiveTab();
        });
    }

    // Puste podpięcie = agent i tak dostaje wbudowany `plan`. Powiedz to wprost.
    if (formData.artifact_types.length === 0) {
        el.createDiv({ text: t('profile.artifacts.types_default_hint'), cls: 'setting-item-description' });
    }
}

/** Status to semantyczny identyfikator (nietłumaczony w silniku); pokaż go wprost. */
function _statusLabel(status: string | undefined) {
    return status || '—';
}

// ─────────────────────────────────────────────────────────────
// Modale: „Dodaj do Vaulta" (przenieś) + potwierdzenie usunięcia
// ─────────────────────────────────────────────────────────────

/**
 * Dołącz podpowiadacz folderów do pola tekstowego (Obsidian `AbstractInputSuggest`, od 1.4).
 * Definicja klasy jest LENIWA - `extends AbstractInputSuggest` ewaluowane dopiero przy wywołaniu,
 * pod strażą `typeof`. Na starszym Obsidianie (manifest minAppVersion 1.1.0) pole działa bez
 * podpowiedzi (ścieżkę wpisujesz ręcznie) zamiast wywalić ładowanie całego bundla (`class extends undefined`).
 */
function attachFolderSuggest(app: App, inputEl: HTMLInputElement) {
    if (typeof AbstractInputSuggest !== 'function') return;
    class FolderInputSuggest extends AbstractInputSuggest<string> {
        declare _inputEl: HTMLInputElement;
        constructor(a: App, el: HTMLInputElement) { super(a, el); this._inputEl = el; }
        getSuggestions(query: string): string[] {
            const q = (query || '').toLowerCase();
            return app.vault.getAllLoadedFiles()
                .filter((f): f is TFolder => f instanceof TFolder)
                .map(f => f.path)
                .filter((p: string) => p && p !== '/' && p.toLowerCase().includes(q))
                .sort()
                .slice(0, 50);
        }
        renderSuggestion(path: string, el: HTMLElement) { el.setText(path); }
        selectSuggestion(path: string) {
            this._inputEl.value = path;
            this._inputEl.dispatchEvent(new Event('input'));
            this.close();
        }
    }
    new FolderInputSuggest(app, inputEl);
}

class MoveArtifactModal extends Modal {
    declare artifact: ArtifactEntry;
    declare store: ArtifactStore;
    declare onDone?: () => void;
    declare defaultFolder: string;
    constructor(app: App, { artifact, store, onDone }: { artifact: ArtifactEntry; store: ArtifactStore; onDone?: () => void }) {
        super(app);
        this.artifact = artifact;
        this.store = store;
        this.onDone = onDone;
        const p = artifact?.path || '';
        this.defaultFolder = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    }
    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText(t('profile.artifacts.move_title'));
        contentEl.createEl('p', { text: t('profile.artifacts.move_desc'), cls: 'setting-item-description' });

        const input = contentEl.createEl('input', {
            attr: { type: 'text', placeholder: t('profile.artifacts.move_placeholder') },
        });
        input.value = this.defaultFolder;
        input.addClass('cs-artifact-name-input');
        attachFolderSuggest(this.app, input);

        const btnRow = contentEl.createDiv();
        btnRow.addClass('cs-artifact-btn-row');
        const cancelBtn = btnRow.createEl('button', { text: t('profile.cancel') });
        cancelBtn.addEventListener('click', () => this.close());
        const confirmBtn = btnRow.createEl('button', { text: t('profile.artifacts.move_confirm'), cls: 'mod-cta' });
        confirmBtn.addEventListener('click', () => {
            void (async () => {
                const folder = (input.value || '').trim();
                if (!folder) { new Notice(t('profile.artifacts.move_empty')); return; }
                confirmBtn.disabled = true;
                try {
                    const ok = await this.store.move(this.artifact.id, folder);
                    if (ok) {
                        new Notice(t('profile.artifacts.moved', { folder }));
                        this.onDone?.();
                        this.close();
                    } else {
                        new Notice(t('profile.artifacts.move_error'));
                        confirmBtn.disabled = false;
                    }
                } catch (e) {
                    new Notice(`${t('profile.artifacts.move_error')} ${(e as Error).message}`);
                    confirmBtn.disabled = false;
                }
            })();
        });
        input.focus();
    }
    onClose() { this.contentEl.empty(); }
}

class ConfirmRemoveModal extends Modal {
    declare artifact: ArtifactEntry;
    declare store: ArtifactStore;
    declare onDone?: () => void;
    constructor(app: App, { artifact, store, onDone }: { artifact: ArtifactEntry; store: ArtifactStore; onDone?: () => void }) {
        super(app);
        this.artifact = artifact;
        this.store = store;
        this.onDone = onDone;
    }
    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText(t('profile.artifacts.remove_title'));
        contentEl.createEl('p', { text: t('profile.artifacts.remove_confirm', { tytul: this.artifact?.tytul || this.artifact?.id }) });

        const btnRow = contentEl.createDiv();
        btnRow.addClass('cs-artifact-btn-row');
        const cancelBtn = btnRow.createEl('button', { text: t('profile.cancel') });
        cancelBtn.addEventListener('click', () => this.close());
        const confirmBtn = btnRow.createEl('button', { text: t('profile.delete'), cls: 'mod-warning' });
        confirmBtn.addEventListener('click', () => {
            void (async () => {
                confirmBtn.disabled = true;
                try {
                    const ok = await this.store.remove(this.artifact.id);
                    new Notice(ok ? t('profile.artifacts.removed') : t('profile.artifacts.remove_error'));
                    if (ok) this.onDone?.();
                    this.close();
                } catch (e) {
                    new Notice(`${t('profile.artifacts.remove_error')} ${(e as Error).message}`);
                    confirmBtn.disabled = false;
                }
            })();
        });
    }
    onClose() { this.contentEl.empty(); }
}
