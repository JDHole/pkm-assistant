import test from 'ava';
import { resolveWorkPrompt, WORK_PROMPT_KEYS } from './workPromptResolver.js';

const FACTORY = 'FACTORY-DEFAULT';

test('agent override wins over global and factory', t => {
    const agent = { compression_prompt: 'AGENT' };
    const settings = { pkmAssistant: { promptDefaults: { compression_prompt: 'GLOBAL' } } };
    t.is(resolveWorkPrompt(agent, 'compression_prompt', settings, FACTORY), 'AGENT');
});

test('global default wins when agent value is empty', t => {
    const agent = { compression_prompt: '' };
    const settings = { pkmAssistant: { promptDefaults: { compression_prompt: 'GLOBAL' } } };
    t.is(resolveWorkPrompt(agent, 'compression_prompt', settings, FACTORY), 'GLOBAL');
});

test('factory default when neither agent nor global set', t => {
    t.is(resolveWorkPrompt({ compression_prompt: '' }, 'compression_prompt', { pkmAssistant: { promptDefaults: {} } }, FACTORY), FACTORY);
    t.is(resolveWorkPrompt(null, 'compression_prompt', null, FACTORY), FACTORY);
});

test('whitespace-only values are treated as unset', t => {
    const agent = { archive_prompt: '   \n  ' };
    const settings = { pkmAssistant: { promptDefaults: { archive_prompt: '  ' } } };
    t.is(resolveWorkPrompt(agent, 'archive_prompt', settings, FACTORY), FACTORY);
});

test('accepts the pkmAssistant slice directly as settings (not only full settings)', t => {
    const pkm = { promptDefaults: { summary_prompt: 'GLOBAL-SUMMARY' } };
    t.is(resolveWorkPrompt(null, 'summary_prompt', pkm, FACTORY), 'GLOBAL-SUMMARY');
});

test('missing promptDefaults / missing settings → factory', t => {
    t.is(resolveWorkPrompt(null, 'subagent_frame_prompt', {}, FACTORY), FACTORY);
    t.is(resolveWorkPrompt(null, 'subagent_frame_prompt', undefined, FACTORY), FACTORY);
    t.is(resolveWorkPrompt({}, 'subagent_frame_prompt', { pkmAssistant: {} }, FACTORY), FACTORY);
});

// AUD-dead-code-124 (2026-09-02): brief_prompt WYCIĘTY — zero czytelników od skasowania
// ContextSessionGenerator w E2.9 D. Test-pin: lista kluczy resolvera NIE zawiera brief_prompt.
test('WORK_PROMPT_KEYS lists the five live work prompts (brief_prompt cut, AUD-dead-code-124)', t => {
    t.deepEqual([...WORK_PROMPT_KEYS].sort(), [
        'archive_prompt', 'compression_prompt',
        'save_session_prompt', 'subagent_frame_prompt', 'summary_prompt',
    ]);
    t.false(WORK_PROMPT_KEYS.includes('brief_prompt'));
});
