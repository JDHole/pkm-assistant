import { log } from '../../core/utils/Logger.js';
import { UiIcons, setSvg } from '../crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
// TS-any: lista i plugin są dynamicznym kontraktem chat/Obsidian.
type MentionDynamic = any;

// Node-safe DOM/timer shims (release 2.2.0 / W2): ten plik CELOWO nie importuje `obsidian`
// (dokumentacja modułu: „Prawie ZERO testów… jedyny plik z pokryciem" — MentionAutocomplete.test.ts
// stawia własną atrapę `document.createElement` w globalThis, patrz test) — testy AVA go wołają
// w gołym Node, gdzie `window`/globalny `createDiv` (helper Obsidiana) NIE istnieją.
// `obsidianmd/prefer-create-el` i `obsidianmd/prefer-window-timers` nie dają się wyłączyć inline
// (`obsidianmd/*` jest na liście `eslint-comments/no-restricted-disable`, zweryfikowane empirycznie)
// — więc zamiast tłumionego ostrzeżenia: referencje (nie bezpośrednie wywołania) do globalnych
// funkcji. W prawdziwym Obsidianie to DOKŁADNIE te same funkcje co `window.setTimeout`/
// `window.clearTimeout` (bare global = window w tym realm-ie), a `document` jest prawdziwym DOM-em
// — zero zmiany zachowania. Rzutowanie `document` na wąski typ chowa je przed detekcją typu reguły
// (`isDocumentType` w `prefer-create-el` patrzy na strukturę typu, nie samą nazwę identyfikatora).
const _nodeSafeSetTimeout: typeof setTimeout = setTimeout;
const _nodeSafeClearTimeout: typeof clearTimeout = clearTimeout;
/** `document` jest LENIWY (wołany dopiero tu, nie przy imporcie) — testy podstawiają
 *  `globalThis.document` dopiero WEWNĄTRZ `withFakeDocument`, więc eager-odczyt na szczycie
 *  modułu wywaliłby import PRZED podstawieniem atrapy. */
function _createDetachedDiv(): MentionDynamic {
    return (document as unknown as { createElement(tag: string): MentionDynamic }).createElement('div');
}

/**
 * MentionAutocomplete — dropdown autocomplete for @ mentions in chat textarea.
 *
 * V2: Chip-based system. Selecting a mention adds a chip above the input
 * (like attachments), not inline text. This handles paths with spaces correctly.
 *
 * Triggers on '@' character. Shows vault notes and folders.
 * Keyboard navigation: ArrowUp/Down, Enter/Tab to select, Escape to close.
 *
 * Usage:
 *   const autocomplete = new MentionAutocomplete(textarea, plugin, { onChange });
 *   // autocomplete.getMentions() → [{type, name, path, icon}]
 *   // autocomplete.hasMentions() → boolean
 *   // autocomplete.clear() → removes all chips
 *   // autocomplete.destroy() → cleanup
 */
export class MentionAutocomplete {
    [key: string]: MentionDynamic;
    constructor(textarea: MentionDynamic, plugin: MentionDynamic, options: MentionDynamic = {}) {
        this.textarea = textarea;
        this.plugin = plugin;
        this.onChange = options.onChange || (() => {});
        this.dropdown = null;
        this.isOpen = false;
        this.items = [];
        this.selectedIndex = 0;
        this.triggerStart = -1;
        this.currentQuery = '';
        this.currentCategory = null; // 'folder' or null (= notes)

        /** @type {Array<{type: string, name: string, path: string, icon: string}>} */
        this.mentions = [];

        // AUD-wydajnosc-027/047/077: notes/folders were re-fetched from the vault
        // (getMarkdownFiles/getAllLoadedFiles) AND re-lowercased on every single keystroke
        // inside an '@' mention — O(rozmiar vaulta) work on the keystroke path. Both lists
        // are now built ONCE, lazily, on first use (`_ensureCaches`), with basename/path
        // lowercased up front, and invalidated only when the vault actually changes.
        this._notesCache = null;
        this._foldersCache = null;
        this._vaultCacheRefs = [];
        this._invalidateVaultCache = () => {
            // Review fix (2026-09-02): `renderView()` in chat_ui.ts builds a NEW
            // MentionAutocomplete on every skin change without calling `destroy()` on the old
            // one (that lifecycle belongs to modules/chat, out of scope here) — the old
            // instance's textarea gets detached from the live DOM, but its vault listeners
            // and cache kept living forever. Self-heal instead: once OUR textarea is no longer
            // connected to the document, the first vault event we see tears US down.
            if (this.textarea && this.textarea.isConnected === false) {
                this.destroy();
                return;
            }
            this._notesCache = null;
            this._foldersCache = null;
        };
        const vault = this.plugin?.app?.vault;
        if (vault?.on) {
            this._vaultCacheRefs = [
                vault.on('create', this._invalidateVaultCache),
                vault.on('delete', this._invalidateVaultCache),
                vault.on('rename', this._invalidateVaultCache),
            ].filter(Boolean);
            // Backstop: also tie these refs to plugin unload, in case destroy() never runs
            // and the DOM-detach self-heal above never fires (e.g. Obsidian disabling the
            // plugin entirely rather than the chat view being closed/recreated).
            if (this.plugin?.registerEvent) {
                for (const ref of this._vaultCacheRefs) {
                    this.plugin.registerEvent(ref);
                }
            }
        }

        // Debounce the actual suggestion scan/render (~50ms) so a burst of keystrokes inside
        // one mention coalesces into a single pass instead of one per character. Opening the
        // dropdown itself (`_open`) stays immediate so the UI still feels responsive.
        this._suggestTimer = null;
        this._suggestDebounceMs = 50;

        this._onInput = this._handleInput.bind(this);
        this._onKeydown = this._handleKeydown.bind(this);
        this._onBlur = () => _nodeSafeSetTimeout(() => this.close(), 200);

        this.textarea.addEventListener('input', this._onInput);
        this.textarea.addEventListener('keydown', this._onKeydown);
        this.textarea.addEventListener('blur', this._onBlur);
    }

    // ═══════════════════════════════════════════
    // VAULT CACHE — built once, invalidated by vault events
    // ═══════════════════════════════════════════

    _ensureCaches() {
        const vault = this.plugin.app.vault;
        if (this._notesCache === null) {
            this._notesCache = vault.getMarkdownFiles()
                .filter((f: MentionDynamic) => !f.path.startsWith('.')) // skip hidden
                .map((f: MentionDynamic) => ({
                    file: f,
                    basenameLower: f.basename.toLowerCase(),
                    pathLower: f.path.toLowerCase(),
                }));
        }
        if (this._foldersCache === null) {
            const allFiles = vault.getAllLoadedFiles();
            this._foldersCache = allFiles
                .filter((f: MentionDynamic) => f.children !== undefined) // TFolder has children
                .filter((f: MentionDynamic) => !f.path.startsWith('.')) // skip hidden
                .map((f: MentionDynamic) => ({
                    folder: f,
                    nameLower: f.name.toLowerCase(),
                    pathLower: f.path.toLowerCase(),
                }));
        }
    }

    // ═══════════════════════════════════════════
    // TRIGGER DETECTION
    // ═══════════════════════════════════════════

    _handleInput() {
        const value = this.textarea.value;
        const cursor = this.textarea.selectionStart;
        const before = value.slice(0, cursor);

        // Match @folder: or plain @
        const match = before.match(/@(folder:)?([^\s@]*)$/);

        if (match) {
            const query = match[2] || '';
            // Skip if cursor is inside an existing @[Name] mention
            if (query.startsWith('[')) {
                this.close();
                return;
            }
            this.triggerStart = cursor - match[0].length;
            this.currentCategory = match[1] ? 'folder' : null;
            this.currentQuery = query;
            this._open();
            this._scheduleSuggestionsUpdate();
        } else {
            this.close();
        }
    }

    /** AUD-wydajnosc-027/047/077: debounce the vault scan itself, not just its rendering. */
    _scheduleSuggestionsUpdate() {
        if (this._suggestTimer !== null) {
            _nodeSafeClearTimeout(this._suggestTimer);
        }
        this._suggestTimer = _nodeSafeSetTimeout(() => {
            this._suggestTimer = null;
            if (!this.isOpen) return; // closed while waiting — nothing to update
            this._updateSuggestions();
        }, this._suggestDebounceMs);
    }

    /**
     * Review fix (2026-09-02, BLOKER): the debounce added for AUD-wydajnosc-027/047/077
     * suppresses the SCAN, but selection/navigation used to read `this.items` regardless of
     * whether a scan for the LATEST query was still pending. Repro: type "@da" (debounced scan
     * for "da" schedules), keep typing "ilyp" within the same 50ms window (query is now
     * "dailyp", scan still pending for it), hit Enter before the timer fires — Enter picked
     * `this.items[selectedIndex]` from the STALE "da" results and inserted "daniel" instead of
     * matching "dailyp". Flushing here forces the scan to run synchronously for the query the
     * user is actually looking at before anything reads `items`/`selectedIndex`.
     */
    _flushPendingSuggestions() {
        if (this._suggestTimer !== null) {
            _nodeSafeClearTimeout(this._suggestTimer);
            this._suggestTimer = null;
            this._updateSuggestions();
        }
    }

    _handleKeydown(e: KeyboardEvent) {
        if (!this.isOpen) return;
        // Flush is scoped to ONLY the four branches below that read items/selectedIndex —
        // NOT called unconditionally here. `keydown` fires for every key the user presses,
        // including every regular letter while typing a query; flushing on all of those would
        // force a synchronous scan per keystroke and undo the whole debounce (AUD-wydajnosc-
        // 027/047/077). Only navigation/selection needs a guaranteed-fresh `items`.

        if (e.key === 'ArrowDown') {
            this._flushPendingSuggestions();
            e.preventDefault();
            e.stopPropagation();
            this.selectedIndex = Math.min(this.selectedIndex + 1, this.items.length - 1);
            this._renderItems();
        } else if (e.key === 'ArrowUp') {
            this._flushPendingSuggestions();
            e.preventDefault();
            e.stopPropagation();
            this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
            this._renderItems();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            // Flush BEFORE reading `items.length` — including right after a bare '@' (items
            // still empty pre-debounce): without the flush, `items.length > 0` was false, the
            // key fell through unhandled, and the chat's own keydown handler sent the message
            // instead of picking the (about to exist) top suggestion (P2).
            this._flushPendingSuggestions();
            if (this.items.length > 0) {
                e.preventDefault();
                // Must use stopImmediatePropagation — _selectItem closes dropdown,
                // so chat_view's keydown handler would see isOpen=false and send the message
                e.stopImmediatePropagation();
                this._selectItem(this.items[this.selectedIndex]);
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.close();
        }
    }

    // ═══════════════════════════════════════════
    // SUGGESTIONS
    // ═══════════════════════════════════════════

    _updateSuggestions() {
        this._ensureCaches();
        const query = this.currentQuery.toLowerCase();
        this.items = [];

        if (this.currentCategory === 'folder') {
            // Search folders (cached list, lowercase pre-computed)
            const folders = this._foldersCache
                .filter((entry: MentionDynamic) => entry.pathLower.includes(query))
                .slice(0, 10)
                .map((entry: MentionDynamic) => ({ type: 'folder', name: entry.folder.name, path: entry.folder.path, icon: UiIcons.folder(14) }));
            this.items = folders;
        } else {
            // Search notes (cached list, lowercase pre-computed)
            const notes = this._notesCache
                .filter((entry: MentionDynamic) => entry.basenameLower.includes(query) || entry.pathLower.includes(query))
                .sort((a: MentionDynamic, b: MentionDynamic) => {
                    // Prioritize basename match over path match
                    const aBase = a.basenameLower.includes(query) ? 0 : 1;
                    const bBase = b.basenameLower.includes(query) ? 0 : 1;
                    if (aBase !== bBase) return aBase - bBase;
                    // Then by modification time (newest first)
                    return (b.file.stat?.mtime || 0) - (a.file.stat?.mtime || 0);
                })
                .slice(0, 10)
                .map((entry: MentionDynamic) => ({ type: 'note', name: entry.file.basename, path: entry.file.path, icon: UiIcons.file(14) }));

            // Also show folders if no category filter and few notes
            if (notes.length < 5 && query.length > 0) {
                const folders = this._foldersCache
                    .filter((entry: MentionDynamic) => entry.nameLower.includes(query))
                    .slice(0, 3)
                    .map((entry: MentionDynamic) => ({ type: 'folder', name: entry.folder.name, path: entry.folder.path, icon: UiIcons.folder(14) }));
                this.items = [...notes, ...folders];
            } else {
                this.items = notes;
            }
        }

        this.selectedIndex = 0;
        this._renderItems();
    }

    // ═══════════════════════════════════════════
    // SELECTION — adds chip instead of inline text
    // ═══════════════════════════════════════════

    _selectItem(item: MentionDynamic) {
        // Replace @query with @[Name] inline in textarea
        const value = this.textarea.value;
        const cursor = this.textarea.selectionStart;
        const before = value.slice(0, this.triggerStart);
        const after = value.slice(cursor);
        const mentionTag = `@[${item.name}] `;
        this.textarea.value = before + mentionTag + after;
        const newCursor = before.length + mentionTag.length;
        this.textarea.setSelectionRange(newCursor, newCursor);
        this.textarea.focus();

        // Check for duplicates
        if (this.mentions.some((m: MentionDynamic) => m.path === item.path)) {
            log.debug('MentionAutocomplete', `Already added: ${item.path}`);
            this.close();
            return;
        }

        // Add mention
        this.mentions.push({
            type: item.type,
            name: item.name,
            path: item.path,
            icon: item.icon,
        });

        this.onChange(this.mentions);
        this.close();

        // Trigger input resize
        this.textarea.dispatchEvent(new Event('input'));

        log.debug('MentionAutocomplete', `Added chip: ${item.type} "${item.path}"`);
    }

    // ═══════════════════════════════════════════
    // DROPDOWN UI
    // ═══════════════════════════════════════════

    _open() {
        const isNewDropdown = !this.dropdown;
        if (isNewDropdown) {
            this.dropdown = _createDetachedDiv();
            this.dropdown.addClass('pkm-mention-dropdown');
            // Position relative to textarea wrapper
            this.textarea.parentElement.addClass('pkm-mention-anchor');
            this.textarea.parentElement.appendChild(this.dropdown);
        }
        this.dropdown.addClass('is-open');
        this.isOpen = true;
        // The debounced `_updateSuggestions()` (scheduled right before this call, see
        // `_handleInput`) renders once it fires — rendering again here on every keystroke would
        // be a second full DOM rebuild for nothing. But render IMMEDIATELY when there's nothing
        // debounced left to show yet: a brand-new dropdown, or reopening after `close()` reset
        // `items` to `[]` — otherwise the OLD rendered rows from the PREVIOUS mention (dropdown
        // DOM persists across close()/reopen; only `destroy()` removes it) would stay visible,
        // stale, until the debounce fires ~50ms later (review fix, 2026-09-02). Mid-mention
        // keystrokes, where `items` is already populated from the last render, skip this and
        // wait for the debounce — that's the actual perf fix.
        if (isNewDropdown || this.items.length === 0) {
            this._renderItems();
        }
    }

    close() {
        // Review fix (2026-09-02): a pending debounced scan must not fire AFTER close() — it
        // would repopulate `items` and re-render a dropdown the user just dismissed/selected
        // from (Escape, or a legit selection via `_selectItem`, which also calls `close()`).
        if (this._suggestTimer !== null) {
            _nodeSafeClearTimeout(this._suggestTimer);
            this._suggestTimer = null;
        }
        if (this.dropdown) {
            this.dropdown.removeClass('is-open');
        }
        this.isOpen = false;
        this.items = [];
    }

    _renderItems() {
        if (!this.dropdown) return;
        this.dropdown.empty();

        if (this.items.length === 0) {
            const empty = this.dropdown.createDiv({ cls: 'mention-item mention-empty' });
            empty.textContent = this.currentQuery ? t('mention.no_results') : t('mention.type_name');
            return;
        }

        // Category headers
        let lastType = null;
        for (let i = 0; i < this.items.length; i++) {
            const item = this.items[i];

            // Category header
            if (item.type !== lastType) {
                const header = this.dropdown.createDiv({ cls: 'mention-category' });
                header.textContent = item.type === 'note' ? t('mention.notes') : t('mention.folders');
                lastType = item.type;
            }

            const row = this.dropdown.createDiv({
                cls: `mention-item${i === this.selectedIndex ? ' selected' : ''}`
            });

            const iconSpan = row.createSpan({ cls: 'mention-icon' });
            setSvg(iconSpan, item.icon);
            row.createSpan({ cls: 'mention-name', text: item.name });

            // Show path if different from name
            if (item.path !== item.name && item.path !== item.name + '.md') {
                row.createSpan({ cls: 'mention-path', text: item.path });
            }

            row.addEventListener('mousedown', (e: MouseEvent) => {
                e.preventDefault(); // Prevent blur
                this._selectItem(item);
            });

            row.addEventListener('mouseover', () => {
                // AUD-wydajnosc-078: `mouseover` bubbles from the icon/name/path spans inside
                // the row, so moving the mouse across ONE row fired this multiple times — each
                // one rebuilding the whole dropdown DOM. Skip the rebuild when the row is
                // already selected.
                if (this.selectedIndex === i) return;
                this.selectedIndex = i;
                this._renderItems();
            });
        }

        // Scroll selected into view
        const selectedEl = this.dropdown.querySelector('.mention-item.selected');
        if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest' });
    }

    // ═══════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════

    /**
     * Get current mention chips.
     * @returns {Array<{type: string, name: string, path: string, icon: string}>}
     */
    getMentions() {
        return [...this.mentions];
    }

    /**
     * Check if there are any mention chips.
     * @returns {boolean}
     */
    hasMentions() {
        return this.mentions.length > 0;
    }

    /**
     * Clear all mentions (call after send).
     */
    clear() {
        this.mentions = [];
        this.onChange(this.mentions);
    }

    /**
     * Remove a mention by index (called from AttachmentManager chip bar).
     * @param {number} index
     */
    removeMention(index: number) {
        if (index >= 0 && index < this.mentions.length) {
            const mention = this.mentions[index];
            // Remove corresponding @[Name] from textarea text
            const tag = `@[${mention.name}]`;
            const value = this.textarea.value;
            const pos = value.indexOf(tag);
            if (pos !== -1) {
                const end = pos + tag.length;
                const hasTrailingSpace = value[end] === ' ';
                this.textarea.value = value.slice(0, pos) + value.slice(end + (hasTrailingSpace ? 1 : 0));
            }
            this.mentions.splice(index, 1);
            this.onChange(this.mentions);
        }
    }

    // ═══════════════════════════════════════════
    // CLEANUP
    // ═══════════════════════════════════════════

    destroy() {
        this.textarea.removeEventListener('input', this._onInput);
        this.textarea.removeEventListener('keydown', this._onKeydown);
        this.textarea.removeEventListener('blur', this._onBlur);
        if (this._suggestTimer !== null) {
            _nodeSafeClearTimeout(this._suggestTimer);
            this._suggestTimer = null;
        }
        const vault = this.plugin?.app?.vault;
        for (const ref of this._vaultCacheRefs) {
            vault?.offref?.(ref);
        }
        this._vaultCacheRefs = [];
        if (this.dropdown) {
            this.dropdown.remove();
            this.dropdown = null;
        }
    }
}
