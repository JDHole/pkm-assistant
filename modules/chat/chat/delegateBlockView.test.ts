import test from 'ava';
import { setLocale, t as tr } from '../../../core/i18n/index.js';
import { buildDelegateBlockOptions } from './delegateBlockView.js';

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
