/**
 * Etykieta UI dla typu notatki pamięci (`user`/`agent_rule`/`skill_hint`/`project_context`/
 * `reference`) pokazywana jako badge w review konsolidacji (`archiveReviewRenders.ts`).
 * Czysty plik (zero `obsidian`/DOM), wzór: `modules/chat/saveSessionSectionLabel.ts`.
 */
import test from 'ava';

import { setLocale } from '../../core/i18n/index.js';
import { memoryNoteTypeLabel } from './memoryNoteTypeLabel.js';

test.serial('en: każdy z pięciu typów dostaje angielską etykietę', t => {
    setLocale('en');
    t.teardown(() => setLocale('en'));

    t.is(memoryNoteTypeLabel('user'), 'User');
    t.is(memoryNoteTypeLabel('agent_rule'), 'Preference');
    t.is(memoryNoteTypeLabel('skill_hint'), 'Workflow');
    t.is(memoryNoteTypeLabel('project_context'), 'Project context');
    t.is(memoryNoteTypeLabel('reference'), 'Reference');
});

test.serial('pl: każdy z pięciu typów dostaje polską etykietę', t => {
    setLocale('pl');
    t.teardown(() => setLocale('en'));

    t.is(memoryNoteTypeLabel('user'), 'User');
    t.is(memoryNoteTypeLabel('agent_rule'), 'Preferencja');
    t.is(memoryNoteTypeLabel('skill_hint'), 'Workflow');
    t.is(memoryNoteTypeLabel('project_context'), 'Kontekst projektu');
    t.is(memoryNoteTypeLabel('reference'), 'Referencja');
});

test.serial('pusty typ dostaje etykietę reference (dopasowuje domyślną wartość ArchiveWorkflow)', t => {
    setLocale('en');
    t.teardown(() => setLocale('en'));

    t.is(memoryNoteTypeLabel(undefined), 'Reference');
    t.is(memoryNoteTypeLabel(''), 'Reference');
});

test.serial('nieznany typ wraca dosłownie (lepszy surowy napis niż etykieta, która kłamie)', t => {
    setLocale('en');
    t.teardown(() => setLocale('en'));

    t.is(memoryNoteTypeLabel('future_type_v4'), 'future_type_v4');
});
