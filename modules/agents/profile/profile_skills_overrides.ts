import { Setting } from 'obsidian';
import { UiIcons, setSvgLabel, setSvg } from '../../crystal-soul/index.js';
import { t } from '../../../core/i18n/index.js';

// TS-any: skill editor data is an open-ended persisted user schema.
type UiBoundary = any;

export function showSkillOverrideForm(container: HTMLElement, baseSkill: UiBoundary, assignment: UiBoundary, onDone: (() => void) | null) {
    container.querySelector('.skill-override-form')?.remove();

    const ovr = assignment.overrides || {};
    const form = container.createDiv({ cls: 'skill-override-form cs-skill-override' });

    const ovrHeading = new Setting(form).setHeading();
    setSvgLabel(ovrHeading.nameEl, UiIcons.info(14), `Overrides: ${baseSkill.name}`);
    form.createEl('p', {
        text: t('profile.skills.override_desc'),
        cls: 'setting-item-description'
    });

    new Setting(form)
        .setName(t('profile.skills.extra_instructions'))
        .setDesc(t('profile.skills.extra_instructions_desc'))
        .addTextArea(text => {
            text.setPlaceholder(t('profile.skills.extra_instructions_placeholder'))
                .setValue(ovr.prompt_append || '')
                .onChange(v => {
                    if (!assignment.overrides) assignment.overrides = {};
                    if (v.trim()) { assignment.overrides.prompt_append = v.trim(); }
                    else { delete assignment.overrides.prompt_append; }
                });
            text.inputEl.rows = 3;
            text.inputEl.addClass('pkm-editor-input-full');
        });

    new Setting(form)
        .setName('Model override')
        .setDesc(t('profile.skills.model_override_desc'))
        .addText(text => {
            text.setPlaceholder(t('profile.skills.model_override_placeholder'))
                .setValue(ovr.model || '')
                .onChange(v => {
                    if (!assignment.overrides) assignment.overrides = {};
                    if (v.trim()) { assignment.overrides.model = v.trim(); }
                    else { delete assignment.overrides.model; }
                });
        });

    if (baseSkill.preQuestions?.length > 0) {
        const preqHeading = new Setting(form).setHeading();
        setSvg(preqHeading.nameEl, UiIcons.question(12));
        preqHeading.nameEl.appendText(t('profile.skills.default_answers'));
        for (const pq of baseSkill.preQuestions) {
            new Setting(form)
                .setName(`{{${pq.key}}} — ${pq.question}`)
                .addText(text => {
                    text.setPlaceholder(pq.default || t('profile.skills.no_default'))
                        .setValue(ovr.pre_question_defaults?.[pq.key] || '')
                        .onChange(v => {
                            if (!assignment.overrides) assignment.overrides = {};
                            if (!assignment.overrides.pre_question_defaults) assignment.overrides.pre_question_defaults = {};
                            if (v.trim()) { assignment.overrides.pre_question_defaults[pq.key] = v.trim(); }
                            else {
                                delete assignment.overrides.pre_question_defaults[pq.key];
                                if (Object.keys(assignment.overrides.pre_question_defaults).length === 0) {
                                    delete assignment.overrides.pre_question_defaults;
                                }
                            }
                        });
                });
        }
    }

    const btnRow = form.createDiv({ cls: 'skill-override-buttons cs-skill-override__buttons' });
    const clearBtn = btnRow.createEl('button', { text: t('profile.skills.clear_overrides'), cls: 'cs-btn--danger' });
    clearBtn.addEventListener('click', () => {
        delete assignment.overrides;
        form.remove();
        if (onDone) onDone();
    });
    const closeBtn = btnRow.createEl('button', { text: t('generic.close'), cls: 'cs-btn--agent' });
    closeBtn.addEventListener('click', () => {
        if (assignment.overrides && Object.keys(assignment.overrides).length === 0) {
            delete assignment.overrides;
        }
        form.remove();
        if (onDone) onDone();
    });
}

