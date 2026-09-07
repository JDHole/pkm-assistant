import test from 'ava';
import { Summarizer } from './Summarizer.js';
import { DEFAULT_COMPRESSION_PROMPT } from './compressionPrompt.js';
import { MEMORY_CANDIDATES_SENTINEL, parseMemoryCandidates } from './memoryCandidates.js';

const MESSAGES = [
    { role: 'user', content: 'Zapamiętaj: wolę krótkie raporty.' },
    { role: 'assistant', content: 'Jasne, zapamiętam.' },
];

test('factory compression skeleton keeps the MEMORY_CANDIDATES contract', t => {
    t.true(DEFAULT_COMPRESSION_PROMPT.includes(MEMORY_CANDIDATES_SENTINEL));
    t.true(DEFAULT_COMPRESSION_PROMPT.includes('memory_candidates'));
    // dynamic placeholders the assembler fills
    t.true(DEFAULT_COMPRESSION_PROMPT.includes('{{CONVERSATION}}'));
    t.true(DEFAULT_COMPRESSION_PROMPT.includes('{{DYNAMIC_HEADER}}'));
});

test('getSummaryPrompt on the factory default injects conversation + keeps the sentinel', t => {
    const summarizer = new Summarizer({}); // no chatModel needed for prompt assembly
    const prompt = summarizer.getSummaryPrompt(MESSAGES, '');

    t.true(prompt.includes('Zapamiętaj: wolę krótkie raporty.'), 'conversation injected');
    t.true(prompt.includes(MEMORY_CANDIDATES_SENTINEL), 'sentinel present');
    t.false(prompt.includes('{{CONVERSATION}}'), 'placeholders resolved');
    t.false(prompt.includes('{{DYNAMIC_HEADER}}'), 'placeholders resolved');
});

test('a model response following the factory format is parseable by parseMemoryCandidates', t => {
    // Simulate what the LLM returns when instructed by the factory skeleton.
    const modelResponse = [
        'PODSUMOWANIE: user woli krótkie raporty.',
        '',
        MEMORY_CANDIDATES_SENTINEL,
        '```json',
        '{"memory_candidates": [{"name": "krotkie_raporty", "description": "preferencja", "type": "agent_rule", "content": "User woli krótkie raporty.", "why": "trwała preferencja", "how_to_apply": "gdy raportujesz"}]}',
        '```',
    ].join('\n');

    const { summary, candidates } = parseMemoryCandidates(modelResponse);
    t.false(summary.includes(MEMORY_CANDIDATES_SENTINEL));
    t.is(candidates.length, 1);
    t.is(candidates[0].type, 'agent_rule');
    t.is(candidates[0].name, 'krotkie_raporty');
});

test('a per-agent/global compression override is used verbatim (with placeholders filled)', t => {
    const custom = 'MOJA KOMPRESJA\n{{DYNAMIC_HEADER}}\nROZMOWA:\n{{CONVERSATION}}\nKONIEC{{EMERGENCY_SECTION}}{{SESSION_PATH}}';
    const summarizer = new Summarizer({ compressionPrompt: custom });
    const prompt = summarizer.getSummaryPrompt(MESSAGES, '');

    t.true(prompt.startsWith('MOJA KOMPRESJA'));
    t.true(prompt.includes('Zapamiętaj: wolę krótkie raporty.'));
    t.true(prompt.includes('KONIEC'));
    t.false(prompt.includes('{{CONVERSATION}}'));
});
