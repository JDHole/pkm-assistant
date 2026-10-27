import test from 'ava';
import { setLocale, t as tr } from '../../../core/i18n/index.js';
import { buildSubAgentResultView } from './subAgentResultView.js';

setLocale('pl');

test('wynik z outcome zachowuje dorobek, oddzielny błąd i reusable z sub_id', t => {
    const view = buildSubAgentResultView({
        name: 'badacz',
        outcome: { end: { kind: 'failed', stage: 'work' }, completeness: 'partial', hasAnswer: false, hasMaterial: true,
            effects: [{ tool: 'write', action: 'zapisz', targets: [{ kind: 'vault-file', path: 'Notatki/a.md' }], outcome: 'returned', check: 'matches' }] },
        handoff: 'Zapisano szkic.', error: 'Błąd narzędzia',
        effects: [{ tool: 'write', action: 'zapisz', targets: [{ kind: 'vault-file', path: 'Notatki/a.md' }], outcome: 'returned', check: 'matches' }],
        thread: { kind: 'reusable', sub_id: 'sub/badacz#1' },
    }, tr);
    t.is(view.title, `badacz ${tr('chat.substrip.state_partial_error')}`);
    t.is(view.material, 'Zapisano szkic.');
    t.is(view.error, 'Błąd narzędzia');
    t.deepEqual(view.effects, [{ tool: 'write', target: 'Notatki/a.md', statusLabel: tr('chat.subresult.effect_matches') }]);
    t.true(view.notes.includes(tr('chat.subresult.continue_same_thread')));
});

test('sam task_id lub threadId nie dowodzą reusable, Stop usera bez materiału zachowuje etykietę końca', t => {
    const stopped = buildSubAgentResultView({ name: 'badacz', taskId: 'task-1', threadId: 'sub/badacz#1',
        outcome: { end: { kind: 'stopped', by: 'user' }, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [] },
        thread: { kind: 'unknown' } }, tr);
    t.is(stopped.title, `badacz ${tr('chat.substrip.state_partial_user')}`);
    t.false(stopped.notes.includes(tr('chat.subresult.continue_same_thread')));
    t.false(stopped.notes.includes(tr('chat.subresult.user_stopped_material')));
    t.true(stopped.notes.includes(tr('chat.subresult.user_stopped_next')));
});

test('jawny single nie dodaje notatki kontynuacji; limit pokazuje badge częściowy', t => {
    const view = buildSubAgentResultView({ name: 'badacz', thread: { kind: 'single' },
        outcome: { end: { kind: 'limit', reason: 'iteration-limit' }, completeness: 'partial', hasAnswer: false, hasMaterial: true, effects: [] },
        partialText: 'DOROBEK' }, tr);
    t.is(view.title, `badacz ${tr('chat.substrip.state_partial_limit')}`);
    t.is(view.badge, tr('chat.subresult.completeness.partial'));
    t.is(view.material, 'DOROBEK');
    t.false(view.notes.includes(tr('chat.subresult.continue_same_thread')));
});

test('tytuł bierze każdą przyczynę końca ze wspólnego modelu etykiet', t => {
    const cases = [
        [{ kind: 'finished' }, 'chat.substrip.state_done', 'unconfirmed'],
        [{ kind: 'limit', reason: 'iteration-limit' }, 'chat.substrip.state_partial_limit', 'partial'],
        [{ kind: 'stopped', by: 'user' }, 'chat.substrip.state_partial_user', 'empty'],
        [{ kind: 'stopped', by: 'lead' }, 'chat.substrip.state_partial_lead', 'empty'],
        [{ kind: 'stopped', by: 'system' }, 'chat.substrip.state_partial_system', 'empty'],
        [{ kind: 'timeout' }, 'chat.substrip.state_partial_timeout', 'partial'],
        [{ kind: 'failed', stage: 'work' }, 'chat.substrip.state_partial_error', 'partial'],
        [{ kind: 'uncertain' }, 'chat.substrip.state_partial_uncertain', 'partial'],
        [{ kind: 'finished' }, 'chat.substrip.state_empty', 'empty'],
    ] as const;
    for (const [end, key, completeness] of cases) {
        const view = buildSubAgentResultView({ name: 'sub', outcome: { end, completeness, hasAnswer: false, hasMaterial: false, effects: [] }, thread: { kind: 'unknown' } }, tr);
        t.is(view.title, `sub ${tr(key)}`);
        if (completeness === 'partial') t.is(view.badge, tr('chat.subresult.completeness.partial'));
    }
});
