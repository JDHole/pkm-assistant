import test from 'ava';
import { Summarizer } from './Summarizer.js';
import { defaultCompressionPrompt } from './compressionPrompt.js';
import { MEMORY_CANDIDATES_SENTINEL, parseMemoryCandidates } from './memoryCandidates.js';
import { setLocale } from '../../../core/i18n/index.js';

const MESSAGES = [
    { role: 'user', content: 'Zapamiętaj: wolę krótkie raporty.' },
    { role: 'assistant', content: 'Jasne, zapamiętam.' },
];

/** Wszystkie `{{TOKENY}}` szkieletu, posortowane - to, co `getSummaryPrompt` musi umieć wypełnić. */
function placeholders(text: string): string[] {
    return [...new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]))].sort();
}

test('factory compression skeleton keeps the MEMORY_CANDIDATES contract in BOTH languages', t => {
    for (const locale of ['pl', 'en']) {
        const skeleton = defaultCompressionPrompt(locale);
        t.true(skeleton.includes(MEMORY_CANDIDATES_SENTINEL), locale);
        t.true(skeleton.includes('memory_candidates'), locale);
        // Blok kandydatów musi zostać ogrodzony ```json - parser tnie po sentinelu i czyta fence.
        t.true(skeleton.includes('```json'), locale);
    }
});

test('placeholdery szkieletu są IDENTYCZNE w obu językach', t => {
    // Lista literalna: token zgubiony w tłumaczeniu = dziura w prompcie, której nikt nie wypełni.
    const expected = ['CONVERSATION', 'DYNAMIC_HEADER', 'EMERGENCY_SECTION', 'SESSION_PATH'];
    t.deepEqual(placeholders(defaultCompressionPrompt('pl')), expected);
    t.deepEqual(placeholders(defaultCompressionPrompt('en')), expected);
});

test('szkielet i główka dynamiczna idą za językiem interfejsu', t => {
    t.teardown(() => setLocale('en'));

    setLocale('en');
    const en = new Summarizer({}).getSummaryPrompt(MESSAGES, 'Poprzednie streszczenie.');
    t.true(en.includes('CREATE A STRUCTURAL SUMMARY'), 'szkielet EN');
    t.true(en.includes('## 1. Goal of the conversation'), 'sekcje EN');
    t.true(en.includes('PREVIOUS SUMMARY'), 'główka dynamiczna EN (summarizer.previous_summary_header)');
    t.true(en.includes('USER MESSAGES'), 'główka dynamiczna EN (summarizer.user_messages_header)');

    setLocale('pl');
    const pl = new Summarizer({}).getSummaryPrompt(MESSAGES, 'Poprzednie streszczenie.');
    t.true(pl.includes('STWÓRZ STRUKTURALNE PODSUMOWANIE'), 'szkielet PL');
    t.true(pl.includes('## 1. Cel rozmowy'), 'sekcje PL');
    t.true(pl.includes('POPRZEDNIE PODSUMOWANIE'), 'główka dynamiczna PL');
    t.true(pl.includes('WIADOMOŚCI USERA'), 'główka dynamiczna PL');

    t.not(en, pl);
});

test('sekcja awaryjna trzyma numer „## 9" po numeracji szkieletu 1-8 w obu językach', t => {
    t.teardown(() => setLocale('en'));

    for (const locale of ['pl', 'en']) {
        setLocale(locale);
        const prompt = new Summarizer({}).getSummaryPrompt(MESSAGES, '', { isEmergency: true });
        t.true(prompt.includes('## 8.'), `${locale}: ostatnia sekcja szkieletu`);
        t.true(prompt.includes('## 9.'), `${locale}: sekcja awaryjna wpina się jako dziewiąta`);
        t.false(prompt.includes('{{EMERGENCY_SECTION}}'), `${locale}: placeholder wypełniony`);
    }
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
