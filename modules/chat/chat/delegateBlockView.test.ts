import test from 'ava';
import { setLocale, t as tr } from '../../../core/i18n/index.js';
import { buildDelegateBlockOptions } from './delegateBlockView.js';
import type { RunOutcome } from '../../sub-agents/index.js';

setLocale('pl');

test('niepełny delegate zachowuje dorobek, metadane i rzeczywisty czas', t => {
    const response = { success: false, error: 'Limit czasu', partial_result: 'Zapisano szkic.', tools_used: ['write'], tool_call_details: [{ name: 'write', args: { path: 'a.md' } }], usage: { prompt_tokens: 4, completion_tokens: 2 }, duration_ms: 12345 };
    t.deepEqual(buildDelegateBlockOptions(response, { type: 'delegate', agentName: 'researcher', query: 'zrób' }), {
        type: 'delegate', status: 'error', agentName: 'researcher', query: 'zrób',
        response: `${tr('chat.streaming.error_prefix', { message: 'Limit czasu' })}\n\n${tr('chat.subagent_notification.partial_heading')}\nZapisano szkic.`,
        toolsUsed: ['write'], toolCallDetails: [{ name: 'write', args: { path: 'a.md' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 }, duration: 12345,
    });
});

test('nazwa aspektu z wyniku i tekstowa zwrotka starszego delegate', t => {
    const options = buildDelegateBlockOptions({ success: false, error: 'Limit czasu', aspect: 'pkm-sub', duration_ms: 321 }, { type: 'delegate', query: 'zadanie' });
    t.deepEqual(options, {
        type: 'delegate', status: 'error', agentName: 'pkm-sub', query: 'zadanie',
        response: tr('chat.streaming.error_prefix', { message: 'Limit czasu' }),
        toolsUsed: [], toolCallDetails: [], duration: 321, usage: undefined,
    });
    t.deepEqual(buildDelegateBlockOptions('STARA ODPOWIEDŹ', { type: 'delegate', query: 'zadanie' }), {
        type: 'delegate', status: 'success', aspectType: 'researcher', agentName: '', query: 'zadanie',
        response: 'STARA ODPOWIEDŹ', toolsUsed: [], toolCallDetails: [], duration: 0, usage: undefined,
    });
    t.is(buildDelegateBlockOptions({ error: 'STARY BŁĄD' }, { type: 'delegate' }).status, 'error');
});

test('adapter przekazuje outcome, dorobek i wyłącznie jawne reusable sub_id do ramki', t => {
    const result = { success: false, aspect: 'badacz', outcome: { end: { kind: 'failed', stage: 'work' }, completeness: 'partial', hasAnswer: false, hasMaterial: true } as Omit<RunOutcome, 'effects'>, effects: [],
        handoff: 'ZACHOWANY DOROBEK', partial_result: 'Wynik częściowy', error: 'AWARIA' };
    const withoutProof = buildDelegateBlockOptions({ ...result, task_id: 'task-1', threadId: 'sub/badacz#1' }, { type: 'delegate' });
    t.is(withoutProof.resultView?.material, 'ZACHOWANY DOROBEK');
    t.is(withoutProof.resultView?.error, 'AWARIA');
    t.false(withoutProof.resultView?.notes.includes(tr('chat.subresult.continue_same_thread')));

    const reusable = buildDelegateBlockOptions({ ...result, sub_id: 'sub/badacz#1' }, { type: 'sub_agent' });
    t.true(reusable.resultView?.notes.includes(tr('chat.subresult.continue_same_thread')));
});

for (const kind of ['single', 'unknown'] as const) {
    test(`jawne thread.kind ${kind} ma pierwszeństwo przed sub_id`, t => {
        const options = buildDelegateBlockOptions({
            aspect: 'badacz',
            result: 'ZAPISANY WYNIK',
            outcome: { end: { kind: 'finished' }, completeness: 'unconfirmed', hasAnswer: true, hasMaterial: true, effects: [] },
            sub_id: 'sub/badacz#1',
            thread: { kind },
        }, { type: 'delegate' });

        t.is(options.resultView?.material, 'ZAPISANY WYNIK');
        t.false(options.resultView?.notes.includes(tr('chat.subresult.continue_same_thread')));
    });
}

test.serial('P5: angielski adapter przekazuje zakres i szacunek do UI błędu', t => {
    setLocale('en'); t.teardown(() => setLocale('pl'));
    const options = buildDelegateBlockOptions({ success: false, error: 'MODEL FAILED', parentConversation: {
        mode: 'parent_conversation', status: 'included', source: 'lead', sourceId: 5,
        truncated: false, keptMessages: 8, summarizedMessages: 2, omittedMessages: 0, estimatedTokens: 210,
        inputTokens: 400, maxOutputTokens: 1024, marginTokens: 461, window: { tokens: 4096, source: 'catalog', estimated: false },
    } }, { type: 'delegate' });
    t.deepEqual(options.conversation, { state: 'included', badge: 'with conversation', details: [
        'Source: lead, turn 5.', 'Messages: kept 8, summarized 2, omitted 0.', 'Estimated conversation size: 210 tokens.',
        'No attachments or reasoning. File and tool permissions remain unchanged.',
    ] });
    t.is(options.response, 'Error: MODEL FAILED');
});
