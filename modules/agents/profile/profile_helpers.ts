/**
 * Shared UI helpers for AgentProfileView tabs.
 * renderShard, renderToggle, utility functions.
 */
import { Notice } from 'obsidian';
import { UiIcons } from '../../crystal-soul/index.js';
import { HiddenFileEditorModal } from './HiddenFileEditorModal.js';
import { t } from '../../../core/i18n/index.js';

// Preserve the legacy Crystal Soul module initialization after TypeScript import elision.
void UiIcons;

// TS-any: Obsidian augments DOM elements and vault nodes at runtime beyond its static declarations.
type UiBoundary = any;
interface ShardOptions {
    big?: boolean;
    placeholder?: string;
    rows?: number;
    options?: Array<{ value: string; label: string }>;
    min?: number;
    max?: number;
    step?: number;
}

/**
 * Render a Crystal Soul shard-style form field.
 */
export function renderShard(container: HTMLElement, label: string, sublabel: string | null, value: UiBoundary, type: string, onChange: (value: UiBoundary) => void, opts: ShardOptions = {}) {
    const shard = container.createDiv({
        cls: `cs-shard ${value ? 'cs-shard--filled' : 'cs-shard--empty'} ${opts.big ? 'cs-shard--big' : ''}`
    });
    const labelDiv = shard.createDiv({ cls: 'cs-shard__label' });
    labelDiv.createDiv({ cls: 'cs-shard__main-label', text: label });
    if (sublabel) labelDiv.createDiv({ cls: 'cs-shard__sub-label', text: sublabel });

    if (type === 'text') {
        const input = shard.createEl('input', {
            cls: 'cs-shard__input', attr: { type: 'text', value: value || '', placeholder: opts.placeholder || '' }
        });
        input.addEventListener('change', (e: Event) => {
            onChange((e.target as HTMLInputElement).value);
            shard.className = `cs-shard ${(e.target as HTMLInputElement).value ? 'cs-shard--filled' : 'cs-shard--empty'} ${opts.big ? 'cs-shard--big' : ''}`;
        });
    } else if (type === 'textarea') {
        const textarea = shard.createEl('textarea', { cls: 'cs-shard__textarea' });
        textarea.value = value || '';
        textarea.rows = opts.rows || 5;
        textarea.placeholder = opts.placeholder || '';
        textarea.addEventListener('change', (e: Event) => onChange((e.target as HTMLTextAreaElement).value));
    } else if (type === 'select') {
        const select = shard.createEl('select', { cls: 'cs-shard__select' });
        for (const opt of (opts.options || [])) {
            select.createEl('option', { value: opt.value, text: opt.label });
        }
        select.value = value || '';
        select.addEventListener('change', (e: Event) => {
            onChange((e.target as HTMLSelectElement).value);
        });
    } else if (type === 'slider') {
        const row = shard.createDiv({ cls: 'cs-shard-inline-row' });
        const slider = row.createEl('input', {
            cls: 'cs-shard__slider', attr: { type: 'range', min: opts.min ?? 0, max: opts.max ?? 1, step: opts.step ?? 0.1, value: value ?? 0.7 }
        });
        const valSpan = row.createSpan({ cls: 'cs-shard__value', text: String(value ?? 0.7) });
        slider.addEventListener('input', (e: Event) => {
            valSpan.textContent = (e.target as HTMLInputElement).value;
            onChange(parseFloat((e.target as HTMLInputElement).value));
        });
    } else if (type === 'display') {
        shard.createDiv({ cls: 'cs-shard__value cs-shard__value--has', text: String(value || '—') });
    }

    return shard;
}

/**
 * Render a Crystal Soul toggle row.
 */
export function renderToggle(container: HTMLElement, label: string, desc: string | null, value: boolean, onChange: (value: boolean) => void) {
    const row = container.createDiv({ cls: `cs-perm-row ${value ? 'cs-perm-row--on' : ''}` });
    const info = row.createDiv({ cls: 'cs-perm-row__info' });
    info.createDiv({ cls: 'cs-perm-row__name', text: label });
    if (desc) info.createDiv({ cls: 'cs-perm-row__desc', text: desc });

    const toggle = row.createDiv({ cls: `cs-toggle ${value ? 'cs-toggle--on' : ''}` });
    toggle.createDiv({ cls: 'cs-toggle__track' });
    toggle.createDiv({ cls: 'cs-toggle__thumb' });
    toggle.addEventListener('click', () => {
        const newVal = !toggle.classList.contains('cs-toggle--on');
        toggle.classList.toggle('cs-toggle--on', newVal);
        row.classList.toggle('cs-perm-row--on', newVal);
        onChange(newVal);
    });
    return row;
}

/**
 * Get all vault folders (non-hidden) for autocomplete.
 * @param {import('obsidian').App} app
 * @returns {string[]}
 */
export function getAllVaultFolders(app: UiBoundary) {
    const folders: string[] = [];
    function traverse(folder: UiBoundary) {
        for (const child of folder.children || []) {
            if (child.children !== undefined) {
                if (child.name.startsWith('.')) continue;
                folders.push(child.path);
                traverse(child);
            }
        }
    }
    traverse(app.vault.getRoot());
    return folders.sort();
}

/**
 * Open a file from .pkm-assistant in an editor modal.
 */
export async function openHiddenFile(app: UiBoundary, hiddenPath: string, title: string, opts: Record<string, unknown> = {}) {
    try {
        const adapter = app.vault.adapter;
        const exists = await adapter.exists(hiddenPath);
        if (!exists) {
            new Notice(t('profile.helpers.file_not_found') + hiddenPath);
            return;
        }
        const content = await adapter.read(hiddenPath);
        new HiddenFileEditorModal(app, hiddenPath, title, content, opts).open();
    } catch (e: unknown) {
        new Notice(t('profile.helpers.cannot_open') + (e as Error).message);
    }
}
