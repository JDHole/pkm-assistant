/**
 * ClaudeImportModal — S32 Z2.3: potwierdzenie importu serwerów MCP z Claude Desktop.
 *
 * Modal jest GŁUPI: dostaje gotowe wiersze (`buildImportRows` z `modules/tools/claudeConfigImport.js`)
 * i callback `onConfirm`. Nie parsuje pliku, nie zna ustawień, nie zapisuje — cała logika
 * (wczytanie configu, selekcja, zapis do `settings.pkmAssistant.externalMcpServers`) siedzi u wołającego
 * (`modules/tools/SettingsContent.js`), żeby dała się testować w Node bez obsidiana.
 *
 * Serwer, którego `id` już mamy w ustawieniach, ma checkbox odznaczony i zablokowany — import
 * NIGDY nie nadpisuje istniejącej konfiguracji (mogła nieść ręcznie wpisany token).
 */
import { Modal } from 'obsidian';
import type { App } from 'obsidian';
import { t } from '../../core/i18n/index.js';

interface ClaudeMcpConfig {
    id?: string;
    name?: string;
    transport?: string;
    url?: string;
    command?: string;
    args?: unknown[];
    [key: string]: unknown;
}

interface ClaudeImportRow {
    config: ClaudeMcpConfig;
    exists: boolean;
    selected: boolean;
    /**
     * AUD-code-review-050: `exists:true` dziś znaczy „nie wolno zaznaczyć/zapisać", nie tylko
     * „ten id już jest w ustawieniach" — `blockedReason` niesie POWÓD, żeby modal (celowo GŁUPI,
     * bez własnej logiki) mógł pokazać zdanie dopasowane do sytuacji zamiast jednego uniwersalnego
     * „już istnieje" dla trzech różnych rzeczy (patrz `buildImportRows` w `claudeConfigImport.ts`).
     */
    blockedReason?: 'duplicate' | 'reserved' | 'format';
}

interface ClaudeImportOptions {
    rows?: ClaudeImportRow[];
    onConfirm?: (configs: ClaudeMcpConfig[]) => void | Promise<void>;
}

export class ClaudeImportModal extends Modal {
    declare private rows: ClaudeImportRow[];
    declare private onConfirm: ClaudeImportOptions['onConfirm'] | null;
    /**
     * @param {Object} app - Obsidian App
     * @param {Object} [options]
     * @param {Array<{config:Object, exists:boolean, selected:boolean}>} [options.rows] - wiersze z `buildImportRows`
     * @param {Function} [options.onConfirm] - async (configs[]) => void; woła się z ZAZNACZONYMI configami
     */
    constructor(app: App, options: ClaudeImportOptions = {}) {
        super(app);
        this.rows = Array.isArray(options.rows) ? options.rows : [];
        this.onConfirm = options.onConfirm || null;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('mcp-server-editor-modal');

        contentEl.createEl('h3', { text: t('modal.claude_import.title') });
        contentEl.createEl('p', { text: t('modal.claude_import.desc'), cls: 'setting-item-description' });

        if (this.rows.length === 0) {
            contentEl.createEl('em', { text: t('modal.claude_import.empty'), cls: 'setting-item-description' });
            const actions = contentEl.createDiv({ cls: 'pkm-editor-actions' });
            const closeBtn = actions.createEl('button', { text: t('generic.cancel') });
            closeBtn.addEventListener('click', () => this.close());
            return;
        }

        const list = contentEl.createDiv({ cls: 'claude-import-list' });
        for (const row of this.rows) {
            const item = list.createDiv({ cls: 'claude-import-row' });

            const cb = item.createEl('input', { attr: { type: 'checkbox' } });
            cb.checked = !!row.selected && !row.exists;
            if (row.exists) cb.disabled = true;
            cb.addEventListener('change', () => { row.selected = cb.checked; });

            const info = item.createDiv({ cls: 'pkm-tools-info' });
            info.createEl('strong', { text: row.config?.name || row.config?.id || '?' });

            const meta = [row.config?.id];
            meta.push(row.config?.transport === 'http'
                ? String(row.config?.url || '')
                : [row.config?.command, ...(row.config?.args || [])].filter(Boolean).join(' '));
            // AUD-code-review-050: `exists:true` niesie TRZY różne powody blokady (już w
            // ustawieniach / duplikat wewnątrz importowanego pliku / nazwa zarezerwowana albo
            // format id odrzucony przez validateServerId) — `blockedReason` mówi który, żeby
            // serwer o nazwie `"memory"` nie dostał kłamliwego „już istnieje".
            if (row.exists) {
                const reasonKey = row.blockedReason === 'duplicate' ? 'modal.claude_import.duplicate_in_batch'
                    : row.blockedReason === 'reserved' ? 'modal.claude_import.reserved_name'
                    : row.blockedReason === 'format' ? 'modal.claude_import.invalid_format'
                    : 'modal.claude_import.already_exists';
                meta.push(t(reasonKey));
            }
            info.createDiv({ text: meta.filter(Boolean).join(' · '), cls: 'setting-item-description' });
        }

        const actions = contentEl.createDiv({ cls: 'pkm-editor-actions' });
        const cancelBtn = actions.createEl('button', { text: t('generic.cancel') });
        cancelBtn.addEventListener('click', () => this.close());

        const addBtn = actions.createEl('button', { text: t('modal.claude_import.add_selected'), cls: 'mod-cta' });
        addBtn.addEventListener('click', () => {
            void (async () => {
                addBtn.disabled = true;
                const chosen = this.rows.filter(r => r.selected && !r.exists).map(r => r.config);
                this.close();
                if (this.onConfirm) await this.onConfirm(chosen);
            })();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}
