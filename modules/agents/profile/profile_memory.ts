/**
 * Memory tab (Pamięć) — E2.8 C8 (S21/S23 + zgodność z Memory v3). Trzy pod-zakładki:
 *  - Brain: sekcje „Na teraz" (User/Środowisko — edycja inline add/edit/delete przez writer
 *    memory.writeNaTeraz, E2.8 D4) + lista WSZYSTKICH notatek brain/*.md (klik → edytor,
 *    usuwanie ścieżką memory_delete) + audit.log.
 *    OUT: dawny inline CRUD sekcji indeksu (pisanie całego brain.md adapterem — niezgodne z v3;
 *    indeks buduje LLM/rebuildBrainIndex). S32 Z1b: doszedł „Log wpisów" (`brain.log`, read-only).
 *  - Sesje: TYLKO zarchiwizowane (aktywne → Persona, zrobione w S32 Z1c). Usuwanie + „Podsumuj rozmowy".
 *  - Streszczenia: L1/L2/L3 czytelnia + „Sumaryzuj streszczenia" (konsolidacja w górę).
 * Oba guziki konsolidacji idą torem S29 „Puls pamięci" (`startConsolidationRun`, modules/chat) —
 * nieblokująco, z oknem przebiegu i paskiem statusu. Patrz `_runArchiveWorkflow` na dole pliku.
 * Toggles automatów (mem_proactive/ratunek/idle) — NIE tu (są w Zaawansowanych, C9).
 */
import { MarkdownRenderer, Notice, Setting } from 'obsidian';
import { UiIcons, setSvg } from '../../crystal-soul/index.js';
import { openHiddenFile } from './profile_helpers.js';
import { memoryOpsCenter, OPS_EVENT, parseNaTerazSections, parseBrainLog } from '../../memory/index.js';
import { createModelForRole } from '../../models/index.js';
import { t } from '../../../core/i18n/index.js';
import { getAgentSafeName } from '../../../core/index.js';

// TS-any: Obsidian's augmented HTMLElement helpers and memory/plugin UI bridge are untyped runtime boundaries.
type UiBoundary = any;
type MemoryLogEntry = { ts: string; op: string; target?: string };
type MemorySession = { path: string; sessionTime?: string | number; mtime?: string | number; size?: number; covered_by_l1?: boolean };
type SessionsOptions = { sessions: MemorySession[]; headerKey: string; emptyKey: string; showFilter: boolean; pageStateKey: string };

/**
 * @param {Object} ctx - shared context
 * @param {HTMLElement} el
 */
export async function renderMemoryTab(ctx: UiBoundary, el: UiBoundary) {
    const { agent, agentManager, plugin } = ctx;
    if (!agent) return;

    const memory = agentManager.getAgentMemory?.(agent.name);
    if (!memory) {
        el.createEl('p', { text: t('profile.memory.no_data'), cls: 'agent-profile-empty' });
        return;
    }

    const safeName = getAgentSafeName(agent.name);
    const adapter = plugin.app.vault.adapter;
    const basePath = `.pkm-assistant/agents/${safeName}/memory`;

    // Sub-tab bar: Brain | Sesje | Streszczenia
    const subTabBar = el.createDiv({ cls: 'cs-profile-tabs' });
    const brainSubTab = subTabBar.createEl('button', { cls: `cs-profile-tab ${ctx.activeMemorySubTab === 'brain' ? 'cs-profile-tab--active' : ''}` });
    setSvg(brainSubTab.createSpan(), UiIcons.brain(14));
    brainSubTab.createSpan({ text: t('profile.memory.brain_tab') });
    const sessionsSubTab = subTabBar.createEl('button', { cls: `cs-profile-tab ${ctx.activeMemorySubTab === 'sessions' ? 'cs-profile-tab--active' : ''}` });
    setSvg(sessionsSubTab.createSpan(), UiIcons.history(14));
    sessionsSubTab.createSpan({ text: t('profile.memory.sessions_tab') });
    const summariesSubTab = subTabBar.createEl('button', { cls: `cs-profile-tab ${ctx.activeMemorySubTab === 'summaries' ? 'cs-profile-tab--active' : ''}` });
    setSvg(summariesSubTab.createSpan(), UiIcons.layers(14));
    summariesSubTab.createSpan({ text: t('profile.memory.summaries_tab') });

    let subContent = el.createDiv({ cls: 'cs-profile-content' });
    ctx.__memorySubTabRenderSeq = ctx.__memorySubTabRenderSeq || 0;

    async function renderSubContent() {
        const renderSeq = ++ctx.__memorySubTabRenderSeq;
        // Element odłączony: budowany poza DOM, podmieniany przez replaceWith() dopiero po
        // async renderze (bez migotania) — `createDiv()` globalny z obsidiana robi dokładnie
        // to samo co `document.createElement('div')`, bez parenta.
        const nextContent = createDiv();
        nextContent.className = 'cs-profile-content';
        if (ctx.activeMemorySubTab === 'brain') {
            await _renderMemoryBrain(ctx, nextContent, adapter, basePath, memory, () => { void renderSubContent(); });
        } else if (ctx.activeMemorySubTab === 'sessions') {
            await _renderMemorySessions(ctx, nextContent, adapter, memory, () => { void renderSubContent(); });
        } else {
            await _renderMemorySummaries(ctx, nextContent, adapter, basePath);
        }
        if (renderSeq !== ctx.__memorySubTabRenderSeq) return;
        subContent.replaceWith(nextContent);
        subContent = nextContent;
    }

    for (const [tab, key] of [[brainSubTab, 'brain'], [sessionsSubTab, 'sessions'], [summariesSubTab, 'summaries']]) {
        tab.addEventListener('click', () => {
            ctx.activeMemorySubTab = key;
            subTabBar.querySelectorAll('.cs-profile-tab').forEach((t: UiBoundary) => t.classList.remove('cs-profile-tab--active'));
            tab.classList.add('cs-profile-tab--active');
            void renderSubContent();
        });
    }

    await renderSubContent();
}

// ══════════════════════════════════════════════
// BRAIN — „Na teraz" (defensywnie) + notatki brain/ + audit
// ══════════════════════════════════════════════

async function _renderMemoryBrain(ctx: UiBoundary, el: UiBoundary, adapter: UiBoundary, basePath: string, memory: UiBoundary, rerender: () => void) {
    const { agent, plugin } = ctx;

    // ── „Na teraz" (User / Środowisko) — E2.8 D4: edycja inline (add/edit/delete) przez writer
    //    memory.writeNaTeraz, NIGDY przez pisanie całego brain.md adapterem. Obie sekcje zawsze
    //    widoczne, żeby user mógł zasiać wpisy w pustej sekcji.
    let brainContent = '';
    try {
        const brainPath = `${basePath}/brain.md`;
        if (await adapter.exists(brainPath)) brainContent = await adapter.read(brainPath);
    } catch { /* ignore */ }
    const naTeraz = parseNaTerazSections(brainContent);
    const naTerazHead = el.createDiv({ cls: 'cs-section-head' });
    setSvg(naTerazHead, UiIcons.zap(14));
    naTerazHead.createSpan({ text: t('profile.memory.na_teraz_header') });
    const NA_TERAZ_UI = [
        { key: 'user', label: t('profile.memory.na_teraz_user') },
        { key: 'environment', label: t('profile.memory.na_teraz_env') },
    ];
    for (const { key, label } of NA_TERAZ_UI) {
        _renderNaTerazSection(el, memory, key as 'user' | 'environment', label, naTeraz[key as 'user' | 'environment'] || [], rerender);
    }

    // ── Wszystkie notatki brain/*.md (jak lista skilli; klik → edytor, usuwanie) ──
    const notesHead = el.createDiv({ cls: 'cs-section-head' });
    setSvg(notesHead, UiIcons.brain(14));
    notesHead.createSpan({ text: t('profile.memory.brain_notes_header') });

    const brainNotesPath = `${basePath}/brain`;
    let noteFiles = [];
    try {
        const listed = await adapter.list(brainNotesPath);
        noteFiles = (listed?.files || []).filter((f: string) => f.endsWith('.md'));
    } catch { /* brak folderu brain/ */ }

    if (noteFiles.length === 0) {
        el.createEl('p', { text: t('profile.memory.brain_empty'), cls: 'cs-focus-hint' });
    } else {
        const list = el.createDiv({ cls: 'cs-mem-list' });
        for (const notePath of noteFiles) {
            const fileName = notePath.split('/').pop().replace(/\.md$/, '');
            const item = list.createDiv({ cls: 'cs-mem-item' });
            const ico = item.createSpan({ cls: 'cs-mem-item__icon' });
            setSvg(ico, UiIcons.file(12));
            item.createSpan({ cls: 'cs-mem-item__date', text: fileName });

            const actions = item.createDiv({ cls: 'cs-mem-item__actions' });
            const delBtn = actions.createSpan({ cls: 'cs-mem-entry__btn cs-mem-entry__btn--danger', title: t('profile.memory.delete_note') });
            setSvg(delBtn, UiIcons.trash(11));
            delBtn.addEventListener('click', async (e: Event) => {
                e.stopPropagation();
                try {
                    // Ścieżka memory_delete: usuń notatkę + przebuduj indeks brain.md.
                    await adapter.remove(notePath);
                    await memory.rebuildBrainIndex?.();
                    new Notice(t('profile.memory.note_deleted'));
                    rerender();
                } catch (err) { new Notice(t('profile.memory.delete_error') + (err as Error).message); }
            });

            // Klik = pełna treść notatki, edytowalna.
            item.addEventListener('click', () => {
                void openHiddenFile(plugin.app, notePath, fileName, { agentName: agent.name, agentColor: agent.color || '' });
            });
        }
    }

    // ── Log wpisów (S32 Z1b) — kronika zapisów do pamięci trwałej, read-only ──
    await _renderBrainLogCard(el, adapter, `${basePath}/brain.log`);

    // ── Audit log (E2.8 A4: żywy memory-audit z E1.3) ──
    const auditPath = `${basePath}/audit.log`;
    await _renderMemoryFileCard(ctx, el, adapter, auditPath, UiIcons.history(14), t('profile.memory.audit_log'), t('profile.memory.audit_log_desc'));
}

/**
 * S32 Z1b: karta „Log wpisów" — ostatnie 50 zdarzeń z `brain.log` (data + operacja + cel).
 *
 * READ-ONLY, świadomie bez guzika kasowania: to jedyny ślad tego, co agent wpisał sobie do
 * pamięci sam. Zwijana jak pozostałe karty (`cs-mem-card`), domyślnie zamknięta — na dole
 * zakładki ma nie zasłaniać notatek.
 *
 * ⚠️ To NIE `audit.log` (osobna karta niżej, legacy mechanizm ignorowanych `brain_update`).
 */
async function _renderBrainLogCard(el: UiBoundary, adapter: UiBoundary, logPath: string) {
    let entries: MemoryLogEntry[] = [];
    try {
        if (await adapter.exists(logPath)) entries = parseBrainLog(await adapter.read(logPath), 50);
    } catch { /* brak logu = pusty stan, nie błąd */ }

    const card = el.createDiv({ cls: `cs-mem-card ${entries.length > 0 ? 'cs-mem-card--has' : ''}` });
    const head = card.createDiv({ cls: 'cs-mem-card__head' });
    setSvg(head.createSpan({ cls: 'cs-mem-card__icon' }), UiIcons.file(14));
    head.createSpan({ cls: 'cs-mem-card__title', text: `${t('profile.memory.brain_log')} (${entries.length})` });
    head.createSpan({ cls: 'cs-mem-card__subtitle', text: t('profile.memory.brain_log_desc') });
    setSvg(head.createSpan({ cls: 'cs-mem-card__arrow' }), UiIcons.chevronDown(10));

    const body = card.createDiv({ cls: 'cs-mem-card__body' });
    if (entries.length === 0) {
        body.createEl('p', { text: t('profile.memory.brain_log_empty'), cls: 'cs-focus-hint cs-focus-hint--padded' });
    } else {
        const list = body.createDiv({ cls: 'cs-mem-list' });
        for (const entry of entries) {
            const row = list.createDiv({ cls: 'cs-mem-item' });
            row.createSpan({ cls: 'cs-mem-item__date', text: _formatLogStamp(entry.ts) });
            row.createSpan({ cls: 'cs-badge cs-badge--auto', text: _brainLogOpLabel(entry.op) });
            row.createSpan({ cls: 'cs-mem-item__size', text: entry.target || '—' });
        }
    }
    head.addEventListener('click', () => { card.classList.toggle('open'); });
}

/** Krótki lokalny stempel („2026-07-30 14:05"); nieparsowalny ISO wraca surowy. */
function _formatLogStamp(iso: string) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso || '—');
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}  ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Etykieta operacji. Nieznana (log z innej wersji pluginu) → surowa nazwa, nie „undefined". */
function _brainLogOpLabel(op: string) {
    const key = `profile.memory.brain_log_op_${String(op || '').replace(/-/g, '_')}`;
    const label = t(key);
    return label === key ? (op || '?') : label;
}

/**
 * E2.8 D4: render one editable „Na teraz" section (add / edit / delete per entry). Every mutation
 * goes through `memory.writeNaTeraz` (add/remove ops), NEVER by writing the whole brain.md — the
 * index + short-term sections are rebuilt by the writer, consistent with Memory v3.
 */
function _renderNaTerazSection(el: UiBoundary, memory: UiBoundary, sectionKey: 'user' | 'environment', label: string, entries: string[], rerender: () => void) {
    const card = el.createDiv({ cls: 'cs-mem-card cs-mem-card--has open' });
    const cHead = card.createDiv({ cls: 'cs-mem-card__head' });
    cHead.createSpan({ cls: 'cs-mem-card__title', text: `${label} (${entries.length})` });
    const body = card.createDiv({ cls: 'cs-mem-card__body' });
    const list = body.createDiv({ cls: 'cs-mem-entries' });

    if (entries.length === 0) {
        list.createEl('p', { text: t('profile.memory.na_teraz_empty'), cls: 'cs-focus-hint' });
    }
    for (const entry of entries) {
        const row = list.createDiv({ cls: 'cs-mem-entry' });
        const textSpan = row.createSpan({ cls: 'cs-mem-entry__text', text: entry });
        const actions = row.createDiv({ cls: 'cs-mem-entry__actions' });

        const editBtn = actions.createSpan({ cls: 'cs-mem-entry__btn', title: t('profile.memory.na_teraz_edit') });
        setSvg(editBtn, UiIcons.edit(11));
        editBtn.addEventListener('click', () => {
            // Swap the text span for an inline input; Enter/blur commits via remove-old + add-new.
            // Element odłączony: budowany przed textSpan.replaceWith(input), brak parenta w tym
            // momencie — `createEl` globalny z obsidiana robi to samo co
            // `document.createElement('input')`, bez parenta.
            const input = createEl('input');
            input.type = 'text';
            input.className = 'cs-mem-entry__edit-input';
            input.value = entry;
            input.addClass('cs-mem-input');
            textSpan.replaceWith(input);
            input.focus();
            let committed = false;
            const commit = async () => {
                if (committed) return;
                committed = true;
                const next = input.value.trim();
                if (!next || next === entry) { rerender(); return; }
                try {
                    await memory.writeNaTeraz([{ section: sectionKey, remove: entry, add: next }]);
                    new Notice(t('profile.memory.na_teraz_entry_saved'));
                } catch (err) { new Notice(t('profile.memory.delete_error') + (err as Error).message); }
                rerender();
            };
            input.addEventListener('keydown', (e: KeyboardEvent) => {
                if (e.key === 'Enter') { e.preventDefault(); void commit(); }
                else if (e.key === 'Escape') { committed = true; rerender(); }
            });
            input.addEventListener('blur', () => { void commit(); });
        });

        const delBtn = actions.createSpan({ cls: 'cs-mem-entry__btn cs-mem-entry__btn--danger', title: t('profile.memory.na_teraz_delete') });
        setSvg(delBtn, UiIcons.trash(11));
        delBtn.addEventListener('click', async () => {
            try {
                await memory.writeNaTeraz([{ section: sectionKey, remove: entry }]);
                new Notice(t('profile.memory.na_teraz_entry_deleted'));
            } catch (err) { new Notice(t('profile.memory.delete_error') + (err as Error).message); }
            rerender();
        });
    }

    // Add-entry row.
    const addRow = body.createDiv({ cls: 'cs-mem-entry-add' });
    addRow.addClass('cs-mem-add-row');
    const addInput = addRow.createEl('input', { type: 'text', attr: { placeholder: t('profile.memory.na_teraz_add_placeholder') } });
    addInput.addClass('cs-mem-input');
    const addBtn = addRow.createEl('button', { cls: 'cs-mem-entry-add__btn', text: t('profile.memory.na_teraz_add') });
    const submit = async () => {
        const value = addInput.value.trim();
        if (!value) return;
        try {
            await memory.writeNaTeraz([{ section: sectionKey, add: value }]);
            new Notice(t('profile.memory.na_teraz_entry_saved'));
        } catch (err) { new Notice(t('profile.memory.delete_error') + (err as Error).message); }
        rerender();
    };
    addBtn.addEventListener('click', submit);
    addInput.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } });
}

async function _renderMemoryFileCard(ctx: UiBoundary, el: UiBoundary, adapter: UiBoundary, filePath: string, icon: string, title: string, subtitle: string) {
    const { agent, plugin } = ctx;
    let fileContent = '';
    let exists = false;
    try {
        exists = await adapter.exists(filePath);
        if (exists) fileContent = await adapter.read(filePath);
    } catch { /* ignore */ }

    const card = el.createDiv({ cls: `cs-mem-card ${exists && fileContent.trim() ? 'cs-mem-card--has' : ''}` });
    const head = card.createDiv({ cls: 'cs-mem-card__head' });
    setSvg(head.createSpan({ cls: 'cs-mem-card__icon' }), icon);
    head.createSpan({ cls: 'cs-mem-card__title', text: title });
    if (subtitle) head.createSpan({ cls: 'cs-mem-card__subtitle', text: subtitle });
    setSvg(head.createSpan({ cls: 'cs-mem-card__arrow' }), UiIcons.chevronDown(10));

    const body = card.createDiv({ cls: 'cs-mem-card__body' });
    const content = body.createDiv({ cls: 'cs-mem-card__content' });
    if (!exists || !fileContent.trim()) {
        content.createEl('p', { text: t('profile.memory.no_file_data'), cls: 'cs-focus-hint' });
    } else {
        await MarkdownRenderer.render(plugin.app, fileContent, content, '', plugin);
        const actionsEl = body.createDiv({ cls: 'cs-mem-card__actions' });
        const viewBtn = actionsEl.createEl('button');
        setSvg(viewBtn, UiIcons.eye(11));
        viewBtn.appendText(t('profile.memory.open_in_editor'));
        viewBtn.addEventListener('click', () => {
            void openHiddenFile(plugin.app, filePath, title, { agentName: agent.name, agentColor: agent.color || '' });
        });
    }
    head.addEventListener('click', () => { card.classList.toggle('open'); });
}

// ══════════════════════════════════════════════
// SESJE — TYLKO zarchiwizowane (aktywne → Persona/faza E)
// ══════════════════════════════════════════════

async function _renderMemorySessions(ctx: UiBoundary, el: UiBoundary, adapter: UiBoundary, memory: UiBoundary, rerender: () => void) {
    let archiveSessions: MemorySession[] = [];
    try {
        archiveSessions = await memory.listArchiveSessions?.() || [];
    } catch (e) {
        el.createEl('p', { text: t('profile.memory.sessions_read_error') + (e as Error).message, cls: 'cs-focus-hint' });
        return;
    }

    el.createDiv({ text: t('profile.memory.sessions_archive_hint'), cls: 'setting-item-description' });

    _renderSessionsSection(ctx, el, adapter, {
        sessions: archiveSessions,
        headerKey: 'profile.memory.sessions_archive_header',
        emptyKey: 'profile.memory.no_archive_sessions',
        showFilter: archiveSessions.length > 8,
        pageStateKey: 'memorySessionPage',
    });

    // Guzik „Podsumuj rozmowy" — przebieg konsolidacji z oknem review (nie blokuje pracy).
    const btn = el.createEl('button', { cls: 'cs-preset-btn', text: `▶ ${t('profile.memory.summarize_sessions')}` });
    btn.addEventListener('click', () => _runArchiveWorkflow(ctx, memory, rerender));
    el.createDiv({ text: t('profile.memory.summarize_sessions_desc'), cls: 'setting-item-description' });
}

function _formatSessionDate(session: MemorySession) {
    const d = new Date(session.sessionTime || session.mtime || 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}  ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function _renderSessionsSection(ctx: UiBoundary, parentEl: UiBoundary, adapter: UiBoundary, opts: SessionsOptions) {
    const { agent, plugin } = ctx;
    const PER_PAGE = 25;
    let { sessions, headerKey, emptyKey, showFilter, pageStateKey } = opts;

    const sectionEl = parentEl.createDiv({ cls: 'cs-mem-sessions-section' });
    const headerEl = sectionEl.createDiv({ cls: 'cs-mem-sessions-header' });
    const sessionsHeading = new Setting(headerEl).setName(t(headerKey, { count: sessions.length })).setHeading();
    sessionsHeading.nameEl.addClass('cs-mem-sessions-header__title');

    if (sessions.length === 0) {
        sectionEl.createEl('p', { text: t(emptyKey), cls: 'cs-focus-hint' });
        return;
    }

    let filterValue = '';
    if (showFilter) {
        const filterBar = sectionEl.createDiv({ cls: 'cs-mem-filter' });
        setSvg(filterBar.createSpan({ cls: 'cs-mem-filter__icon' }), UiIcons.search(13));
        const filterInput = filterBar.createEl('input', {
            type: 'text', cls: 'cs-mem-filter__input',
            attr: { placeholder: t('profile.memory.filter_placeholder', { count: sessions.length }) },
            value: ctx.memorySessionFilter || ''
        });
        filterValue = ctx.memorySessionFilter || '';
        filterInput.addEventListener('input', () => {
            ctx.memorySessionFilter = filterInput.value;
            filterValue = filterInput.value;
            ctx[pageStateKey] = 0;
            renderList();
        });
    }

    const listEl = sectionEl.createDiv({ cls: 'cs-mem-list' });
    const paginationEl = sectionEl.createDiv({ cls: 'cs-mem-pagination' });

    function renderList() {
        listEl.empty();
        paginationEl.empty();
        const filtered = filterValue ? sessions.filter((s: MemorySession) => _formatSessionDate(s).includes(filterValue)) : sessions;
        if (filtered.length === 0) {
            listEl.createEl('p', { text: t('profile.memory.no_filter_results'), cls: 'cs-focus-hint' });
            return;
        }
        const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
        if ((ctx[pageStateKey] || 0) >= totalPages) ctx[pageStateKey] = totalPages - 1;
        const pageIdx = ctx[pageStateKey] || 0;
        const start = pageIdx * PER_PAGE;
        const page = filtered.slice(start, start + PER_PAGE);

        for (const session of page) {
            const dateStr = _formatSessionDate(session);
            const size = session.size || 0;
            const covered = !!session.covered_by_l1;
            const item = listEl.createDiv({ cls: 'cs-mem-item' });
            setSvg(item.createSpan({ cls: 'cs-mem-item__icon' }), UiIcons.file(12));
            item.createSpan({ cls: 'cs-mem-item__date', text: dateStr });
            if (covered) item.createSpan({ cls: 'cs-badge cs-badge--auto', text: t('profile.memory.covered_l1') });
            const sizeStr = size === 0 ? '0 B' : size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;
            item.createSpan({ cls: 'cs-mem-item__size', text: sizeStr });

            const itemActions = item.createDiv({ cls: 'cs-mem-item__actions' });
            const delBtn = itemActions.createSpan({ cls: 'cs-mem-entry__btn cs-mem-entry__btn--danger', title: t('profile.memory.delete_session') });
            setSvg(delBtn, UiIcons.trash(11));
            delBtn.addEventListener('click', async (e: Event) => {
                e.stopPropagation();
                try {
                    await adapter.remove(session.path);
                    sessions = sessions.filter((s: MemorySession) => s.path !== session.path);
                    renderList();
                    new Notice(t('profile.memory.session_deleted'));
                } catch (err) { new Notice(t('profile.memory.delete_error') + (err as Error).message); }
            });

            item.addEventListener('click', async () => {
                await openHiddenFile(plugin.app, session.path, t('profile.memory.session_prefix') + dateStr, {
                    agentName: agent.name, agentColor: agent.color || '', readOnly: true
                });
            });
        }

        if (totalPages > 1) {
            paginationEl.createSpan({ cls: 'cs-mem-pagination__info', text: `${start + 1}–${Math.min(start + PER_PAGE, filtered.length)} / ${filtered.length}` });
            const btnGroup = paginationEl.createDiv({ cls: 'cs-mem-pagination__btns' });
            const prevBtn = btnGroup.createEl('button', { cls: 'cs-mem-pagination__btn' });
            setSvg(prevBtn, UiIcons.chevronDown(10)); prevBtn.addClass('cs-mem-pagination__btn--prev');
            prevBtn.disabled = pageIdx === 0;
            prevBtn.addEventListener('click', () => { ctx[pageStateKey] = pageIdx - 1; renderList(); });
            const nextBtn = btnGroup.createEl('button', { cls: 'cs-mem-pagination__btn' });
            setSvg(nextBtn, UiIcons.chevronDown(10)); nextBtn.addClass('cs-mem-pagination__btn--next');
            nextBtn.disabled = pageIdx >= totalPages - 1;
            nextBtn.addEventListener('click', () => { ctx[pageStateKey] = pageIdx + 1; renderList(); });
        }
    }
    renderList();
}

// ══════════════════════════════════════════════
// STRESZCZENIA — L1/L2/L3 (podgląd; konsolidację odpala guzik w sekcji Sesje)
// ══════════════════════════════════════════════

async function _renderMemorySummaries(ctx: UiBoundary, el: UiBoundary, adapter: UiBoundary, basePath: string) {
    const { agent, plugin } = ctx;
    const levels = [
        { key: 'L1', path: `${basePath}/summaries/L1`, desc: t('profile.memory.every_5_sessions') },
        { key: 'L2', path: `${basePath}/summaries/L2`, desc: t('profile.memory.every_5_l1') },
        { key: 'L3', path: `${basePath}/summaries/L3`, desc: t('profile.memory.every_10_l2') },
    ];

    for (const level of levels) {
        let files = [];
        try {
            const listed = await adapter.list(level.path);
            files = (listed?.files || []).filter((f: string) => f.endsWith('.md')).reverse();
        } catch { /* folder may not exist */ }

        const card = el.createDiv({ cls: `cs-mem-card ${files.length > 0 ? 'cs-mem-card--has' : ''}` });
        const head = card.createDiv({ cls: 'cs-mem-card__head' });
        setSvg(head.createSpan({ cls: 'cs-mem-card__icon' }), UiIcons.layers(14));
        head.createSpan({ cls: 'cs-mem-card__title', text: `${level.key} (${files.length})` });
        head.createSpan({ cls: 'cs-mem-card__subtitle', text: level.desc });
        setSvg(head.createSpan({ cls: 'cs-mem-card__arrow' }), UiIcons.chevronDown(10));

        const body = card.createDiv({ cls: 'cs-mem-card__body' });
        if (files.length === 0) {
            body.createEl('p', { text: t('profile.memory.no_summaries', { level: level.key }), cls: 'cs-focus-hint cs-focus-hint--padded' });
        } else {
            const listEl = body.createDiv({ cls: 'cs-mem-list' });
            for (const filePath of files) {
                const fileName = filePath.split('/').pop().replace('.md', '');
                const dateParts = fileName.match(/(\d{4}-\d{2}-\d{2})/);
                const dateStr = dateParts ? dateParts[1] : fileName;
                const item = listEl.createDiv({ cls: 'cs-mem-item' });
                setSvg(item.createSpan({ cls: 'cs-mem-item__icon' }), UiIcons.file(12));
                item.createSpan({ cls: 'cs-mem-item__date', text: `${level.key}: ${dateStr}` });
                item.addEventListener('click', async () => {
                    await openHiddenFile(plugin.app, filePath, `${level.key}: ${dateStr}`, {
                        agentName: agent.name, agentColor: agent.color || '', readOnly: true
                    });
                });
            }
        }
        head.addEventListener('click', () => { card.classList.toggle('open'); });
    }
    // D6 (2026-07-30): drugi guzik („Sumaryzuj streszczenia") WYCIĘTY. Wołał DOKŁADNIE tę samą
    // akcję co „Podsumuj rozmowy" w sekcji Sesje — pełny plan konsolidacji, w którym L2/L3 i tak
    // ruszają dopiero po rozstrzygnięciu paczek L1 (bramka `generateGatedSteps`). Dwa guziki
    // obiecywały wybór, którego nie było. Zostaje jeden, ten ogólniejszy.
}

/**
 * Ręczne odpalenie konsolidacji spod guzika „Podsumuj rozmowy" (sekcja Sesje).
 *
 * Kubełek 2 (2026-07-29): przepięte ze STAREGO, blokującego `ArchiveWorkflow.run()` na tor S29
 * „Puls pamięci" (`startConsolidationRun`). Stary tor mielił bez paska statusu, bez kosztu
 * w CostLog i bez „Ponów", a przede wszystkim NIE PILNOWAŁ RÓWNOLEGŁOŚCI: user mógł kliknąć guzik
 * w trakcie trwającego przebiegu S29 i dwa procesy mieliły te same pliki. `MemoryOpsCenter`
 * przepuszcza teraz jeden przebieg na raz (drugi trigger tylko otwiera okno tego, który leci).
 *
 * Import chatu jest LENIWY: statycznej krawędzi agents→chat dziś nie ma i nie dokładamy jej do
 * i tak splątanego trójkąta shell↔chat↔agents. Dynamiczne `import()` jest poza regułą ESLinta.
 */
async function _runArchiveWorkflow(ctx: UiBoundary, memory: UiBoundary, rerender: () => void) {
    const { plugin, agent } = ctx;
    let model = null;
    // AUD-wydajnosc-079/RR-08-11: operacja W TLE (guzik "Podsumuj rozmowy") nie zna
    // lokalnego/globalnego licznika streamow (StreamingManager.shouldUseFreshModel zyje w
    // modules/chat, a agents->chat to swiadomie tylko leniwy import(), nie statyczna
    // krawedz - patrz komentarz nad ta funkcja). Najprostsza bezpieczna semantyka: zawsze
    // callerSkipCache=true. Koszt to jedna konstrukcja adaptera na klikniecie guzika, nie per
    // request do API (klucze biora sie z tej samej globalnej puli) - i tak nie dzieli
    // instancji z aktywna tura czatu tego samego agenta w trakcie stream().
    try { model = createModelForRole(plugin, 'main', agent, null, true); } catch { model = null; }
    const settings = plugin?.settings?.pkmAssistant || plugin?.env?.settings?.pkmAssistant || {};
    try {
        const { startConsolidationRun } = await import('../../chat/index.js');
        // P3-2 (review kubełka 2): przy zajętym centrum `startConsolidationRun` zwraca CUDZY,
        // już trwający przebieg — wtedy NIE zakładamy kolejnej subskrypcji. Bez tego N klików
        // w guzik podczas jednego przebiegu = N wiszących subskrypcji + N × rerender na koniec.
        const alreadyRunning = memoryOpsCenter.getActiveRun();
        const run = await (startConsolidationRun as UiBoundary)({
            plugin,
            app: plugin.app,
            agentMemory: memory,
            agent,
            model,
            settings,
            // Z4.4: user kliknął sam — pusty plan MUSI dać odpowiedź („nie ma czego konsolidować"),
            // inaczej guzik wygląda na zepsuty. Cisza jest tylko dla triggerów automatycznych.
            source: 'manual',
        });
        // Pusty plan → kontroler sam powiedział „nie ma czego konsolidować". Nie ma na co czekać.
        if (run && run !== alreadyRunning) _rerenderWhenRunFinishes(run, rerender);
    } catch (e) {
        new Notice(t('profile.memory.consolidation_error') + ((e as Error | null | undefined)?.message || (e as string)));
    }
}

/**
 * Nowy tor jest ASYNCHRONICZNY — dawne `await workflow.run(); rerender()` nie ma już sensu
 * (guzik wraca od razu, przebieg mieli w tle). Panel odświeżamy dopiero, gdy przebieg się domknie:
 * wtedy nowe L1/L2/L3 są naprawdę na dysku i listy mają co pokazać.
 */
function _rerenderWhenRunFinishes(run: UiBoundary, rerender: () => void) {
    if (typeof rerender !== 'function') return;
    let unsubscribe: (() => void) | null = null;
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        try { unsubscribe?.(); } catch { /* best-effort */ }
        try { rerender(); } catch { /* panel mógł już zniknąć */ }
    };
    unsubscribe = memoryOpsCenter.subscribe(({ type, run: finished }) => {
        if (type !== OPS_EVENT.RUN_FINISHED) return;
        if (finished && finished !== run) return; // cudzy przebieg — nie nasz sygnał
        finish();
    });
    // Wyścig: gdyby przebieg zdążył się domknąć, zanim zdążyliśmy się podpiąć.
    if (memoryOpsCenter.getActiveRun() !== run) finish();
}
