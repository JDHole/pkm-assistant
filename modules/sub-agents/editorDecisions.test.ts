import test from 'ava';
import {
    editorModelOptions,
    initialAdvancedOpen,
    modelListRoleForEditorRole,
    validateMaxIterations,
} from './editorDecisions.js';
import { getModelsForRole } from '../models/index.js';

test('źródło listy modeli zależy od roli edytora', t => {
    t.is(modelListRoleForEditorRole('worker'), 'sub_worker');
    t.is(modelListRoleForEditorRole('researcher'), 'researcher');
    t.is(modelListRoleForEditorRole('explorer'), 'researcher');
    const settings = { modelLibrary: {
        main: [{ platform: 'openai', model: 'main-model' }],
        sub_worker: [{ platform: 'openai', model: 'worker-model' }],
        minion: [{ platform: 'openai', model: 'research-model' }],
    } };
    t.deepEqual(getModelsForRole(settings, modelListRoleForEditorRole('worker')).map(entry => entry.model), ['worker-model']);
    t.deepEqual(getModelsForRole(settings, modelListRoleForEditorRole('researcher')).map(entry => entry.model), ['research-model']);
});

test('otwarcie edytora zachowuje wybrany model spoza bieżącej biblioteki', t => {
    const available = [{ platform: 'openai', model: 'new-model' }];
    const options = editorModelOptions(available, 'legacy-model');
    t.deepEqual(options.map(option => option.model), ['new-model', 'legacy-model']);
    t.is(options.find(option => option.model === 'legacy-model')?.model, 'legacy-model');
});

test('walidacja max_iterations odrzuca wartości poza zakresem i tekst', t => {
    for (const value of ['0', '101', '-1', '', 'abc']) {
        const result = validateMaxIterations(value);
        t.deepEqual(result, { ok: false, errorKey: 'modal.sub_agent.max_iter_invalid', params: { min: 1, max: 100 } }, value);
    }
    for (const value of ['1', '25', '100']) {
        const result = validateMaxIterations(value);
        t.deepEqual(result, { ok: true, value: Number(value) }, value);
    }
});

test('Zaawansowane otwiera się przy niestandardowych wartościach', t => {
    const defaults = {
        tools: ['search', 'read', 'list'],
        scope: null,
        max_iterations: 25,
        min_iterations: 1,
        max_tool_result_length: 15000,
        enabled: true,
    };
    t.false(initialAdvancedOpen(null));
    t.false(initialAdvancedOpen(defaults));
    t.true(initialAdvancedOpen({ ...defaults, tools: ['search', 'read'] }), 'narzędzia');
    t.true(initialAdvancedOpen({ ...defaults, scope: { folders: ['A'], frontmatter: {}, sections: [], pinned_notes: [] } }), 'zakres');
    t.true(initialAdvancedOpen({ ...defaults, max_iterations: 30 }), 'maksymalna liczba kroków');
    t.true(initialAdvancedOpen({ ...defaults, min_iterations: 2 }), 'minimalna liczba kroków');
    t.true(initialAdvancedOpen({ ...defaults, max_tool_result_length: 20000 }), 'limit wyniku narzędzia');
    t.true(initialAdvancedOpen({ ...defaults, enabled: false }), 'wyłączony szablon');
});
