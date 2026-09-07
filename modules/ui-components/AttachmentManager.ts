import { log } from '../../core/utils/Logger.js';
import { UiIcons, setSvg } from '../crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
// TS-any: granica między DOM, Obsidianem i opcjonalnym PDF.js nie ma stabilnych deklaracji.
type AttachmentDynamic = any;

/**
 * AttachmentManager — manages file attachments in chat input.
 *
 * Supports:
 *   - 📎 button (file picker)
 *   - Drag & drop onto chat
 *   - Clipboard paste (Ctrl+V)
 *
 * File types:
 *   - Images (png, jpg, jpeg, gif, webp, svg, bmp) → base64 content blocks
 *   - Text files (md, txt, js, ts, css, html, json, yaml, yml, xml, csv, py, etc.) → text context
 *   - PDF → text extraction
 *
 * Usage:
 *   const mgr = new AttachmentManager(container, plugin, { onChange });
 *   // Later: mgr.buildMessageContent(text) → content blocks incl. attachments
 *   // After send: mgr.clear()
 *   // Cleanup: mgr.destroy()
 */

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
const TEXT_EXTENSIONS = [
    'md', 'txt', 'js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'html', 'htm',
    'json', 'yaml', 'yml', 'xml', 'csv', 'py', 'rb', 'java', 'c', 'cpp',
    'h', 'rs', 'go', 'sh', 'bat', 'ps1', 'sql', 'r', 'lua', 'toml', 'ini',
    'cfg', 'env', 'log', 'svg',
];
const PDF_EXTENSIONS = ['pdf'];

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_TEXT_SIZE = 100 * 1024;         // 100 KB
const MAX_ATTACHMENTS = 10;

export class AttachmentManager {
    [key: string]: AttachmentDynamic;
    /**
     * @param {HTMLElement} container - Where to render chip bar + attach button
     * @param {Object} plugin - PKM Assistant plugin instance
     * @param {Object} options
     * @param {Function} [options.onChange] - Called when attachments change
     * @param {HTMLElement} [options.dropZone] - Element for drag & drop (default: container)
     * @param {HTMLElement} [options.pasteTarget] - Element for paste events (default: null)
     */
    constructor(container: AttachmentDynamic, plugin: AttachmentDynamic, options: AttachmentDynamic = {}) {
        this.container = container;
        this.plugin = plugin;
        this.onChange = options.onChange || (() => {});
        this.dropZone = options.dropZone || container;
        this.pasteTarget = options.pasteTarget || null;

        /** @type {Array<{type: string, name: string, content: string, mimeType: string, size: number}>} */
        this.attachments = [];

        /** @type {Array<{type: string, name: string, path: string, icon: string}>} */
        this.mentionChips = [];
        /** @type {Function|null} */
        this.onMentionRemove = null;

        // Build UI
        this._buildUI();
        this._setupDragDrop();
        this._setupPaste();
    }

    // ═══════════════════════════════════════════
    // UI
    // ═══════════════════════════════════════════

    _buildUI() {
        // Chip bar (above input, hidden when empty)
        this.chipBar = createDiv();
        this.chipBar.className = 'pkm-attachment-chips is-hidden';
        this.container.prepend(this.chipBar);

        // Attach button (📎)
        this.attachButton = createEl('button');
        this.attachButton.className = 'pkm-attach-button';
        setSvg(this.attachButton, UiIcons.paperclip(16));
        this.attachButton.title = t('attach.add_attachment');
        this.attachButton.addEventListener('click', () => this._openFilePicker());
    }

    /**
     * Returns the 📎 button element for external placement.
     * @returns {HTMLElement}
     */
    getAttachButton() {
        return this.attachButton;
    }

    /**
     * Set mention chips to render alongside attachment chips.
     * @param {Array<{type: string, name: string, path: string, icon: string}>} mentions
     * @param {Function} onRemove - Called with (index) when user removes a mention chip
     */
    setMentionChips(mentions: AttachmentDynamic[], onRemove: AttachmentDynamic) {
        this.mentionChips = mentions || [];
        this.onMentionRemove = onRemove || null;
        this._renderChips();
    }

    _renderChips() {
        this.chipBar.empty();

        const hasAny = this.attachments.length > 0 || this.mentionChips.length > 0;
        if (!hasAny) {
            this.chipBar.classList.add('is-hidden');
            return;
        }

        this.chipBar.classList.remove('is-hidden');

        // Render mention chips first (📄/📁 notes/folders)
        for (let i = 0; i < this.mentionChips.length; i++) {
            const m = this.mentionChips[i];
            const chip = createDiv();
            chip.className = 'pkm-attachment-chip pkm-mention-chip';

            const icon = createSpan();
            icon.className = 'attachment-chip-icon';
            setSvg(icon, m.icon);
            chip.appendChild(icon);

            const nameSpan = createSpan();
            nameSpan.className = 'attachment-chip-name';
            nameSpan.textContent = m.name;
            nameSpan.title = m.path;
            chip.appendChild(nameSpan);

            const removeBtn = createEl('button');
            removeBtn.className = 'attachment-chip-remove';
            removeBtn.textContent = '×';
            removeBtn.title = t('attach.remove');
            removeBtn.addEventListener('click', () => {
                if (this.onMentionRemove) this.onMentionRemove(i);
            });
            chip.appendChild(removeBtn);

            this.chipBar.appendChild(chip);
        }

        // Render attachment chips (📎 files/images)
        for (let i = 0; i < this.attachments.length; i++) {
            const att = this.attachments[i];
            const chip = createDiv();
            chip.className = 'pkm-attachment-chip';

            // Icon
            const icon = createSpan();
            icon.className = 'attachment-chip-icon';
            setSvg(icon, att.type === 'image' ? UiIcons.image(14) : att.type === 'pdf' ? UiIcons.pdf(14) : UiIcons.file(14));
            chip.appendChild(icon);

            // Thumbnail for images
            if (att.type === 'image' && att.content) {
                const thumb = createEl('img');
                thumb.className = 'attachment-chip-thumb';
                thumb.src = `data:${att.mimeType};base64,${att.content}`;
                thumb.alt = att.name;
                chip.appendChild(thumb);
            }

            // Name
            const nameSpan = createSpan();
            nameSpan.className = 'attachment-chip-name';
            nameSpan.textContent = att.name;
            nameSpan.title = att.name;
            chip.appendChild(nameSpan);

            // Size
            const sizeSpan = createSpan();
            sizeSpan.className = 'attachment-chip-size';
            sizeSpan.textContent = this._formatSize(att.size);
            chip.appendChild(sizeSpan);

            // Remove button
            const removeBtn = createEl('button');
            removeBtn.className = 'attachment-chip-remove';
            removeBtn.textContent = '×';
            removeBtn.title = t('attach.remove');
            removeBtn.addEventListener('click', () => {
                this.attachments.splice(i, 1);
                this._renderChips();
                this.onChange(this.attachments);
            });
            chip.appendChild(removeBtn);

            this.chipBar.appendChild(chip);
        }
    }

    _formatSize(bytes: number) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    // ═══════════════════════════════════════════
    // FILE PICKER
    // ═══════════════════════════════════════════

    _openFilePicker() {
        const input = createEl('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = [
            ...IMAGE_EXTENSIONS.map(e => `.${e}`),
            ...TEXT_EXTENSIONS.map(e => `.${e}`),
            ...PDF_EXTENSIONS.map(e => `.${e}`),
        ].join(',');

        input.addEventListener('change', () => {
            void (async () => {
                if (input.files) {
                    await this._processFileList(input.files);
                }
            })();
        });

        input.click();
    }

    // ═══════════════════════════════════════════
    // DRAG & DROP
    // ═══════════════════════════════════════════

    /**
     * Check if drag event target is within our drop zone or input container.
     */
    _isInDropZone(e: AttachmentDynamic) {
        if (!this.dropZone) return false;
        const target = e.target;
        return this.dropZone.contains(target) || this.container.contains(target);
    }

    _setupDragDrop() {
        this._onDragEnter = (e: AttachmentDynamic) => {
            if (!this._isInDropZone(e)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            this.dropZone.classList.add('pkm-drag-over');
        };

        this._onDragOver = (e: AttachmentDynamic) => {
            if (!this._isInDropZone(e)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            e.dataTransfer.dropEffect = 'copy';
            this.dropZone.classList.add('pkm-drag-over');
        };

        this._onDragLeave = (e: AttachmentDynamic) => {
            if (!this.dropZone) return;
            // Only remove highlight if pointer left the drop zone entirely
            const related = e.relatedTarget;
            if (!related || (!this.dropZone.contains(related) && !this.container.contains(related))) {
                this.dropZone.classList.remove('pkm-drag-over');
            }
        };

        this._onDrop = async (e: AttachmentDynamic) => {
            if (!this._isInDropZone(e)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            this.dropZone.classList.remove('pkm-drag-over');

            if (e.dataTransfer?.files?.length > 0) {
                await this._processFileList(e.dataTransfer.files);
            }
        };

        // Register on DOCUMENT with capture: true — intercepts BEFORE Obsidian/Electron handlers
        document.addEventListener('dragenter', this._onDragEnter, true);
        document.addEventListener('dragover', this._onDragOver, true);
        document.addEventListener('dragleave', this._onDragLeave, true);
        document.addEventListener('drop', this._onDrop, true);
    }

    // ═══════════════════════════════════════════
    // PASTE
    // ═══════════════════════════════════════════

    _setupPaste() {
        if (!this.pasteTarget) return;

        this._onPaste = async (e: AttachmentDynamic) => {
            const items = e.clipboardData?.items;
            if (!items) return;

            const files = [];
            for (const item of items) {
                if (item.kind === 'file') {
                    const file = item.getAsFile();
                    if (file) files.push(file);
                }
            }

            if (files.length > 0) {
                e.preventDefault();
                e.stopImmediatePropagation();
                await this._processFileList(files);
            }
            // If no files, let normal text paste through
        };

        // capture: true — fire BEFORE Obsidian's own paste handlers
        this.pasteTarget.addEventListener('paste', this._onPaste, true);
    }

    // ═══════════════════════════════════════════
    // FILE PROCESSING
    // ═══════════════════════════════════════════

    async _processFileList(files: AttachmentDynamic) {
        for (const file of files) {
            if (this.attachments.length >= MAX_ATTACHMENTS) {
                log.warn('Attachments', t('attach.limit_reached', { max: MAX_ATTACHMENTS }));
                break;
            }

            try {
                await this._processFile(file);
            } catch (err) {
                log.error('Attachments', `Error processing ${file.name}:`, err);
            }
        }

        this._renderChips();
        this.onChange(this.attachments);
    }

    async _processFile(file: AttachmentDynamic) {
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        const name = file.name;
        const mime = (file.type || '').toLowerCase();

        // Detect type: extension first, MIME fallback (clipboard pastes may lack extension)
        const isImage = IMAGE_EXTENSIONS.includes(ext) || mime.startsWith('image/');
        const isPdf = PDF_EXTENSIONS.includes(ext) || mime === 'application/pdf';
        const isText = TEXT_EXTENSIONS.includes(ext) || mime.startsWith('text/');

        if (isImage) {
            if (file.size > MAX_IMAGE_SIZE) {
                log.warn('Attachments', t('attach.image_too_large', { name, size: this._formatSize(file.size) }));
                return;
            }
            // Optimize large images (>1MB) before encoding — resize to max 1568px, compress as JPEG
            const optimized = await this._optimizeImage(file);
            const base64 = await this._fileToBase64(optimized.file);
            const mimeType = optimized.mimeType || mime || `image/${ext === 'jpg' ? 'jpeg' : ext}`;
            this.attachments.push({
                type: 'image',
                name: name || `image.${this._mimeToExt(mimeType)}`,
                content: base64,
                mimeType,
                size: optimized.file.size,
            });
        } else if (isPdf) {
            const text = await this._extractPdfText(file);
            this.attachments.push({
                type: 'pdf',
                name,
                content: text,
                mimeType: 'application/pdf',
                size: file.size,
            });
        } else if (isText) {
            if (file.size > MAX_TEXT_SIZE) {
                log.warn('Attachments', t('attach.file_too_large', { name, size: this._formatSize(file.size) }));
                return;
            }
            const text = await file.text();
            this.attachments.push({
                type: 'text',
                name,
                content: text,
                mimeType: mime || 'text/plain',
                size: file.size,
            });
        } else {
            log.warn('Attachments', t('attach.unsupported_type', { name, ext, mime }));
        }
    }

    _mimeToExt(mime: string) {
        const map: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp' };
        return map[mime] || 'png';
    }

    /**
     * Optimize image if >1MB: resize to max 1568px longest side, compress as JPEG 0.85.
     * Returns { file: File|Blob, mimeType: string }.
     */
    async _optimizeImage(file: AttachmentDynamic) {
        const ONE_MB = 1024 * 1024;
        const MAX_DIM = 1568; // Claude's optimal image dimension
        if (file.size <= ONE_MB) return { file, mimeType: null }; // pass-through
        try {
            const bitmap = await createImageBitmap(file);
            const { width, height } = bitmap;
            // Calculate scale — fit longest side to MAX_DIM
            const scale = Math.min(1, MAX_DIM / Math.max(width, height));
            const newW = Math.round(width * scale);
            const newH = Math.round(height * scale);
            // Draw on canvas
            const canvas = createEl('canvas');
            canvas.width = newW;
            canvas.height = newH;
            const ctx = canvas.getContext('2d');
            ctx!.drawImage(bitmap, 0, 0, newW, newH);
            bitmap.close();
            // Export as JPEG, then release canvas pixel buffer
            const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value as Blob), 'image/jpeg', 0.85));
            canvas.width = 0;
            canvas.height = 0;
            log.debug('Attachments', t('attach.optimize_result', { oldW: width, oldH: height, newW, newH, oldSize: this._formatSize(file.size), newSize: this._formatSize(blob.size) }));
            if (blob.size > 10 * ONE_MB) {
                log.warn('Attachments', t('attach.still_large', { size: this._formatSize(blob.size) }));
            }
            return { file: blob, mimeType: 'image/jpeg' };
        } catch (e) {
            log.warn('Attachments', t('attach.optimize_failed'), e);
            return { file, mimeType: null };
        }
    }

    _fileToBase64(file: AttachmentDynamic) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                // reader.result = "data:image/png;base64,ABC..." → extract just base64 part
                const result = reader.result as string;
                const base64 = result.split(',')[1] || result;
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    /**
     * Extract text from PDF using pdf.js (lazy-loaded).
     * Falls back to a placeholder message if pdf.js is not available.
     */
    async _extractPdfText(file: AttachmentDynamic) {
        try {
            // Try to use Obsidian's built-in PDF support or pdf.js
            const arrayBuffer = await file.arrayBuffer();

            // Attempt to load pdf.js from Obsidian's bundled copy
            const pdfjsLib = (window as AttachmentDynamic).pdfjsLib || await this._loadPdfJs();

            if (!pdfjsLib) {
                return t('attach.pdf_attached', { name: file.name, size: this._formatSize(file.size) });
            }

            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            const pages = [];
            const maxPages = Math.min(pdf.numPages, 50); // limit to 50 pages

            for (let i = 1; i <= maxPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                const pageText = textContent.items.map((item: AttachmentDynamic) => item.str).join(' ');
                if (pageText.trim()) {
                    pages.push(`--- ${t('attach.pdf_page', { num: i })} ---\n${pageText}`);
                }
            }

            if (pdf.numPages > maxPages) {
                pages.push(`\n${t('attach.pdf_skipped', { count: pdf.numPages - maxPages })}`);
            }

            return pages.length > 0
                ? pages.join('\n\n')
                : t('attach.pdf_no_text', { name: file.name });
        } catch (err) {
            log.warn('Attachments', `PDF extraction failed for ${file.name}:`, err);
            return t('attach.pdf_extract_failed', { name: file.name, size: this._formatSize(file.size) });
        }
    }

    async _loadPdfJs() {
        // Obsidian bundles pdf.js internally — try to access it
        if ((window as AttachmentDynamic).pdfjsLib) return (window as AttachmentDynamic).pdfjsLib;

        // Try dynamic import (may not work in all environments)
        try {
            // Obsidian exposes pdf.js as a global when PDF viewer is used
            // Trigger a dummy operation to load it
            return (window as AttachmentDynamic).pdfjsLib || null;
        } catch {
            return null;
        }
    }

    // ═══════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════

    /**
     * Check if there are any attachments.
     * @returns {boolean}
     */
    hasAttachments() {
        return this.attachments.length > 0;
    }

    /**
     * Build content blocks for API message (OpenAI format).
     * Text/PDF attachments → text context prepended.
     * Images → image_url content blocks.
     *
     * @param {string} userText - The user's text message
     * @returns {{ content: string|Array, displayText: string }}
     */
    buildMessageContent(userText: string) {
        const textAttachments = this.attachments.filter((a: AttachmentDynamic) => a.type === 'text' || a.type === 'pdf');
        const imageAttachments = this.attachments.filter((a: AttachmentDynamic) => a.type === 'image');

        // Build text context from text/PDF attachments
        let contextParts = [];
        for (const att of textAttachments) {
            contextParts.push(`📎 ${t('attach.attachment_label')}: ${att.name}\n\`\`\`\n${att.content}\n\`\`\``);
        }

        // Display text (what user sees in chat)
        const chipLabels = this.attachments.map((a: AttachmentDynamic) => {
            const icon = a.type === 'image' ? '🖼️' : a.type === 'pdf' ? '📕' : '📄';
            return `${icon} ${a.name}`;
        });
        const displayText = chipLabels.length > 0
            ? `[${chipLabels.join(', ')}]\n${userText}`
            : userText;

        // If only text/PDF (no images) → return as string (works with ALL models)
        if (imageAttachments.length === 0) {
            const fullText = contextParts.length > 0
                ? contextParts.join('\n\n') + '\n\n' + userText
                : userText;
            return { content: fullText, displayText };
        }

        // Has images → build content blocks array (multimodal)
        const contentBlocks = [];

        // Text context first
        if (contextParts.length > 0) {
            contentBlocks.push({ type: 'text', text: contextParts.join('\n\n') });
        }

        // User text
        contentBlocks.push({ type: 'text', text: userText });

        // Image blocks
        for (const img of imageAttachments) {
            contentBlocks.push({
                type: 'image_url',
                image_url: {
                    url: `data:${img.mimeType};base64,${img.content}`,
                },
            });
        }

        return { content: contentBlocks, displayText };
    }

    /**
     * Clear all attachments (call after send).
     */
    clear() {
        this.attachments = [];
        this._renderChips();
    }

    /**
     * Cleanup listeners and DOM.
     */
    destroy() {
        // Drag & drop — registered on document with capture: true
        document.removeEventListener('dragenter', this._onDragEnter, true);
        document.removeEventListener('dragover', this._onDragOver, true);
        document.removeEventListener('dragleave', this._onDragLeave, true);
        document.removeEventListener('drop', this._onDrop, true);

        // Paste (capture: true must match addEventListener)
        if (this.pasteTarget && this._onPaste) {
            this.pasteTarget.removeEventListener('paste', this._onPaste, true);
        }

        // DOM
        if (this.chipBar) {
            this.chipBar.remove();
            this.chipBar = null;
        }
        if (this.attachButton) {
            this.attachButton.remove();
            this.attachButton = null;
        }
    }
}
