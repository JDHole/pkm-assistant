/**
 * Modal generatora promptu startowego (S32 Z1a).
 *
 * Trzy pytania → live podglad → jeden guzik „Wstaw do Persony". Cała logika składania siedzi
 * w czystym `startPromptGenerator.js`; tutaj jest wyłącznie formularz.
 *
 * Nadpisanie NIE pyta o potwierdzenie: `formData.personality` to bufor panelu, który ląduje
 * w YAML-u dopiero po „Zapisz profil" — user może zamknąć panel bez zapisu i nic nie traci.
 * Guzik zmienia tylko NAPIS, żeby było widać, że coś już w Osobowości jest.
 */
import { Modal } from 'obsidian';
import { pickColor } from '../../crystal-soul/index.js';
import { t } from '../../../core/i18n/index.js';
import { buildStartPrompt, TONE_OPTIONS } from './startPromptGenerator.js';
import type { StartPromptAnswers } from './startPromptGenerator.js';

interface StartPromptOptions {
    agentName?: string;
    currentPersonality?: string;
    onInsert?: (text: string) => void;
}

export class StartPromptGeneratorModal extends Modal {
    declare agentName: string;
    declare currentPersonality: string;
    declare onInsert: ((text: string) => void) | null;
    declare answers: Required<StartPromptAnswers>;
    /**
     * @param {import('obsidian').App} app
     * @param {{agentName?: string, currentPersonality?: string, onInsert?: (text: string) => void}} opts
     */
    constructor(app: ConstructorParameters<typeof Modal>[0], opts: StartPromptOptions = {}) {
        super(app);
        this.agentName = opts.agentName || '';
        this.currentPersonality = String(opts.currentPersonality || '').trim();
        this.onInsert = typeof opts.onInsert === 'function' ? opts.onInsert : null;
        this.answers = { role: '', tone: TONE_OPTIONS[0].id, rules: '' };
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('cs-startprompt');

        // Akcent kolorystyczny agenta — subtelny pasek po lewej, ten sam kolor co kryształ.
        // Sam kolor idzie zmienną CSS (reszta stylu w `src/styles.css`), żeby nie ustawiać
        // statycznych właściwości `element.style.*` (reguła katalogu Obsidiana).
        const wrap = contentEl.createDiv({ cls: 'cs-startprompt__wrap' });
        // Fix znaleziska TS-4: `pickColor` zwraca ColorEntry — do CSS szedł cały obiekt
        // („[object Object]"), więc pasek akcentu nigdy nie dostawał koloru. Kolor to `.hex`.
        wrap.style.setProperty('--cs-startprompt-accent', pickColor(this.agentName || 'default').hex);

        wrap.createEl('h3', { text: t('profile.start_prompt.title') });
        wrap.createEl('p', { text: t('profile.start_prompt.modal_desc'), cls: 'setting-item-description' });

        // ── Kim jest agent (rola) ──
        wrap.createEl('label', { text: t('profile.start_prompt.role_label'), cls: 'cs-startprompt__label' });
        const roleInput = wrap.createEl('input', {
            type: 'text',
            attr: { placeholder: t('profile.start_prompt.role_placeholder') },
        });

        // ── Ton wypowiedzi ──
        wrap.createEl('label', { text: t('profile.start_prompt.tone_label'), cls: 'cs-startprompt__label' });
        const toneSelect = wrap.createEl('select', { cls: 'dropdown' });
        for (const opt of TONE_OPTIONS) {
            toneSelect.createEl('option', { value: opt.id, text: t(opt.labelKey) });
        }
        toneSelect.value = this.answers.tone;

        // ── Zasady / czego unikać ──
        wrap.createEl('label', { text: t('profile.start_prompt.rules_label'), cls: 'cs-startprompt__label' });
        const rulesArea = wrap.createEl('textarea', {
            attr: { placeholder: t('profile.start_prompt.rules_placeholder'), rows: '5' },
        });

        // ── Live podgląd ──
        wrap.createEl('label', { text: t('profile.start_prompt.preview_label'), cls: 'cs-startprompt__label' });
        const preview = wrap.createEl('pre', { cls: 'cs-prompt-preview' });

        // ── Guziki ──
        const actions = wrap.createDiv({ cls: 'modal-button-container' });
        const insertBtn = actions.createEl('button', {
            cls: 'mod-cta',
            text: this.currentPersonality
                ? t('profile.start_prompt.overwrite')
                : t('profile.start_prompt.insert'),
        });
        const cancelBtn = actions.createEl('button', { text: t('profile.start_prompt.cancel') });
        cancelBtn.addEventListener('click', () => this.close());

        const refresh = () => {
            this.answers = { role: roleInput.value, tone: toneSelect.value, rules: rulesArea.value };
            const text = buildStartPrompt(this.answers, t);
            preview.textContent = text || t('profile.start_prompt.preview_empty');
            insertBtn.disabled = !text;
        };

        insertBtn.addEventListener('click', () => {
            const text = buildStartPrompt(this.answers, t);
            if (!text) return;
            this.onInsert?.(text);
            this.close();
        });

        roleInput.addEventListener('input', refresh);
        rulesArea.addEventListener('input', refresh);
        toneSelect.addEventListener('change', refresh);
        refresh();
        roleInput.focus();
    }

    onClose() {
        this.contentEl.empty();
    }
}
