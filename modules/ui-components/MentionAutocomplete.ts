import { log } from '../../core/utils/Logger.js';
import { UiIcons, setSvg } from '../crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
import type { PluginApi } from '../../core/index.js';
import type { App, TFile, TFolder, EventRef } from 'obsidian';

/** Kontrakt pluginu widziany przez ten moduł — `app` zawężony do realnego Obsidian `App`
 *  (moduł realnie woła `app.vault.*`, których minimalny `AppLike` z `PluginApi` nie modeluje).
 *  Intersection zamiast `extends PluginApi { app: App }`: `DataAdapter` (prawdziwy typ) nie ma
 *  sygnatury indeksowej `AppLike.vault.adapter`, a `extends` na interfejsie to sprawdza.
 *  `Omit<PluginApi,'app'>` też nie działa — `PluginApi` ma `[key:string]: unknown`, więc
 *  `keyof PluginApi` zwija się do `string` i `Omit`/`Pick` gubią konkretne sygnatury metod. */
type MentionAutocompletePlugin = PluginApi & { app: App };

interface MentionAutocompleteOptions {
    onChange?: (mentions: MentionChip[]) => void;
}

/** Chip dodany nad polem czatu (`getMentions()`). */
interface MentionChip {
    type: string;
    name: string;
    path: string;
    icon: string;
}

/** Wiersz podpowiedzi w dropdownie (`this.items`). */
interface MentionSuggestionItem {
    type: 'note' | 'folder';
    name: string;
    path: string;
    icon: string;
}

/** Wpis cache'u notatek — patrz `_ensureCaches`. */
interface NoteCacheEntry {
    file: TFile;
    basenameLower: string;
    pathLower: string;
}

/** Wpis cache'u folderów — patrz `_ensureCaches`. */
interface FolderCacheEntry {
    folder: TFolder;
    nameLower: string;
    pathLower: string;
}

// Node-safe DOM/timer shims: ten plik CELOWO nie importuje `obsidian`
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
function _createDetachedDiv(): HTMLElement {
    return (document as unknown as { createElement(tag: string): HTMLElement }).createElement('div');
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
    declare textarea: HTMLTextAreaElement;
    declare plugin: MentionAutocompletePlugin;
    declare onChange: (mentions: MentionChip[]) => void;
    declare dropdown: HTMLElement | null;
    declare isOpen: boolean;
    declare items: MentionSuggestionItem[];
    declare selectedIndex: number;
    declare triggerStart: number;
    declare currentQuery: string;
    declare currentCategory: 'folder' | null;
    declare mentions: MentionChip[];
    declare _notesCache: NoteCacheEntry[] | null;
    declare _foldersCache: FolderCacheEntry[] | null;
    declare _vaultCacheRefs: EventRef[];
    declare _invalidateVaultCache: () => void;
    declare _suggestTimer: ReturnType<typeof setTimeout> | null;
    declare _suggestDebounceMs: number;
    declare _onInput: () => void;
    declare _onKeydown: (e: KeyboardEvent) => void;
    declare _onBlur: () => void;

    constructor(textarea: HTMLTextAreaElement, plugin: MentionAutocompletePlugin, options: MentionAutocompleteOptions = {}) {
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

        // Without this cache, notes/folders would be re-fetched from the vault
        // (getMarkdownFiles/getAllLoadedFiles) AND re-lowercased on every single keystroke
        // inside an '@' mention — O(rozmiar vaulta) work on the keystroke path. Both lists
        // are built ONCE, lazily, on first use (`_ensureCaches`), with basename/path
        // lowercased up front, and invalidated only when the vault actually changes.
        this._notesCache = null;
        this._foldersCache = null;
        this._vaultCacheRefs = [];
        this._invalidateVaultCache = () => {
            // `renderView()` in chat_ui.ts builds a NEW
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
                .filter((f) => !f.path.startsWith('.')) // skip hidden
                .map((f) => ({
                    file: f,
                    basenameLower: f.basename.toLowerCase(),
                    pathLower: f.path.toLowerCase(),
                }));
        }
        if (this._foldersCache === null) {
            const allFiles = vault.getAllLoadedFiles();
            this._foldersCache = allFiles
                // TS-boundary: TFolder ma `children`, TFile nie — to samo zawężenie po strukturze,
                // które kod robił jako `any`; `f is TFolder` tylko nazywa istniejący warunek.
                .filter((f): f is TFolder => (f as TFolder).children !== undefined) // TFolder has children
                .filter((f) => !f.path.startsWith('.')) // skip hidden
                .map((f) => ({
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
        // `selectionStart` jest `number | null` w typach DOM (dzielony z inputami bez
        // selekcji), ale dla <textarea> zawsze zwraca liczbę — gwarancja z kształtu pola.
        const cursor = this.textarea.selectionStart!;
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

    /** Debounce the vault scan itself, not just its rendering. */
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
     * The debounce suppresses the SCAN, but selection/navigation must NOT read `this.items`
     * while a scan for the LATEST query is still pending — otherwise: type "@da" (debounced
     * scan for "da" schedules), keep typing "ilyp" within the same 50ms window (query is now
     * "dailyp", scan still pending for it), hit Enter before the timer fires — Enter would pick
     * `this.items[selectedIndex]` from the STALE "da" results and insert "daniel" instead of
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
            // instead of picking the (about to exist) top suggestion.
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
            // `_ensureCaches()` powyżej gwarantuje niepustą (nie-null) wartość obu cache'y.
            const folders = this._foldersCache!
                .filter((entry) => entry.pathLower.includes(query))
                .slice(0, 10)
                .map((entry): MentionSuggestionItem => ({ type: 'folder', name: entry.folder.name, path: entry.folder.path, icon: UiIcons.folder(14) }));
            this.items = folders;
        } else {
            // Search notes (cached list, lowercase pre-computed)
            const notes = this._notesCache!
                .filter((entry) => entry.basenameLower.includes(query) || entry.pathLower.includes(query))
                .sort((a, b) => {
                    // Prioritize basename match over path match
                    const aBase = a.basenameLower.includes(query) ? 0 : 1;
                    const bBase = b.basenameLower.includes(query) ? 0 : 1;
                    if (aBase !== bBase) return aBase - bBase;
                    // Then by modification time (newest first)
                    return (b.file.stat?.mtime || 0) - (a.file.stat?.mtime || 0);
                })
                .slice(0, 10)
                .map((entry): MentionSuggestionItem => ({ type: 'note', name: entry.file.basename, path: entry.file.path, icon: UiIcons.file(14) }));

            // Also show folders if no category filter and few notes
            if (notes.length < 5 && query.length > 0) {
                const folders = this._foldersCache!
                    .filter((entry) => entry.nameLower.includes(query))
                    .slice(0, 3)
                    .map((entry): MentionSuggestionItem => ({ type: 'folder', name: entry.folder.name, path: entry.folder.path, icon: UiIcons.folder(14) }));
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

    _selectItem(item: MentionSuggestionItem) {
        // Replace @query with @[Name] inline in textarea
        const value = this.textarea.value;
        // Patrz komentarz w `_handleInput` — <textarea> zawsze ma selekcję, więc nigdy `null`.
        const cursor = this.textarea.selectionStart!;
        const before = value.slice(0, this.triggerStart);
        const after = value.slice(cursor);
        const mentionTag = `@[${item.name}] `;
        this.textarea.value = before + mentionTag + after;
        const newCursor = before.length + mentionTag.length;
        this.textarea.setSelectionRange(newCursor, newCursor);
        this.textarea.focus();

        // Check for duplicates
        if (this.mentions.some((m) => m.path === item.path)) {
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
            // Position relative to textarea wrapper — textarea czatu jest zawsze owinięta w
            // wrapper (dokumentacja modułu), więc parentElement jest tu zagwarantowany.
            this.textarea.parentElement!.addClass('pkm-mention-anchor');
            this.textarea.parentElement!.appendChild(this.dropdown);
        }
        // `isNewDropdown` wyżej gwarantuje przypisanie; gdy `false`, `this.dropdown` było już
        // truthy PRZED wejściem do metody (`isNewDropdown = !this.dropdown`).
        this.dropdown!.addClass('is-open');
        this.isOpen = true;
        // The debounced `_updateSuggestions()` (scheduled right before this call, see
        // `_handleInput`) renders once it fires — rendering again here on every keystroke would
        // be a second full DOM rebuild for nothing. But render IMMEDIATELY when there's nothing
        // debounced left to show yet: a brand-new dropdown, or reopening after `close()` reset
        // `items` to `[]` — otherwise the OLD rendered rows from the PREVIOUS mention (dropdown
        // DOM persists across close()/reopen; only `destroy()` removes it) would stay visible,
        // stale, until the debounce fires ~50ms later. Mid-mention
        // keystrokes, where `items` is already populated from the last render, skip this and
        // wait for the debounce — that's the actual perf fix.
        if (isNewDropdown || this.items.length === 0) {
            this._renderItems();
        }
    }

    close() {
        // A pending debounced scan must not fire AFTER close() — it
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
        let lastType: 'note' | 'folder' | null = null;
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
                // `mouseover` bubbles from the icon/name/path spans inside the row, so moving
                // the mouse across ONE row fires this multiple times — without the guard below,
                // each one would rebuild the whole dropdown DOM. Skip the rebuild when the row
                // is already selected.
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
