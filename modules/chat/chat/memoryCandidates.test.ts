import test from 'ava';
import { parseMemoryCandidates, MEMORY_CANDIDATES_SENTINEL } from './memoryCandidates.js';

function withCandidates(summary: string, jsonBody: string): string {
    return `${summary}\n\n${MEMORY_CANDIDATES_SENTINEL}\n\`\`\`json\n${jsonBody}\n\`\`\``;
}

test('parseMemoryCandidates: valid JSON block yields candidates and a clean summary', t => {
    const body = JSON.stringify({
        memory_candidates: [
            { name: 'Kuba prefers direct feedback', description: 'no cheerleading', type: 'user', content: 'Be concrete.', why: 'stated in session', how_to_apply: 'always' },
        ],
    });
    const raw = withCandidates('## 1. Cel\nRozmowa o pamięci.', body);

    const { summary, candidates } = parseMemoryCandidates(raw);

    t.false(summary.includes(MEMORY_CANDIDATES_SENTINEL), 'sentinel stripped from summary');
    t.false(summary.includes('memory_candidates'), 'json stripped from summary');
    t.is(summary, '## 1. Cel\nRozmowa o pamięci.');
    t.is(candidates.length, 1);
    t.is(candidates[0].type, 'user');
    t.is(candidates[0].name, 'Kuba prefers direct feedback');
});

test('parseMemoryCandidates: no sentinel → zero candidates, summary unchanged', t => {
    const raw = '## 1. Cel\nJust a plain summary, nothing durable.';
    const { summary, candidates } = parseMemoryCandidates(raw);
    t.is(candidates.length, 0);
    t.is(summary, raw.trim());
});

test('parseMemoryCandidates: empty candidate list is fine', t => {
    const raw = withCandidates('Summary body.', JSON.stringify({ memory_candidates: [] }));
    const { summary, candidates } = parseMemoryCandidates(raw);
    t.is(candidates.length, 0);
    t.is(summary, 'Summary body.');
});

test('parseMemoryCandidates: garbage JSON after sentinel → zero candidates, summary preserved', t => {
    const raw = `Real summary here.\n\n${MEMORY_CANDIDATES_SENTINEL}\n\`\`\`json\n{ this is not valid json ]\n\`\`\``;
    const { summary, candidates } = parseMemoryCandidates(raw);
    t.is(candidates.length, 0);
    t.is(summary, 'Real summary here.');
});

test('parseMemoryCandidates: invalid note type is rejected', t => {
    const body = JSON.stringify({
        memory_candidates: [
            { name: 'good', type: 'user', content: 'keep' },
            { name: 'bad', type: 'not_a_real_type', content: 'drop' },
        ],
    });
    const { candidates } = parseMemoryCandidates(withCandidates('S', body));
    t.is(candidates.length, 1);
    t.is(candidates[0].name, 'good');
});

test('parseMemoryCandidates: candidate missing name or content is skipped', t => {
    const body = JSON.stringify({
        memory_candidates: [
            { name: '', type: 'user', content: 'no name' },
            { name: 'no content', type: 'user', content: '' },
            { name: 'ok', type: 'reference', content: 'has both' },
        ],
    });
    const { candidates } = parseMemoryCandidates(withCandidates('S', body));
    t.is(candidates.length, 1);
    t.is(candidates[0].name, 'ok');
});

test('parseMemoryCandidates: caps at 3 candidates', t => {
    const body = JSON.stringify({
        memory_candidates: Array.from({ length: 6 }, (_, i) => ({
            name: `n${i}`, type: 'reference', content: `c${i}`,
        })),
    });
    const { candidates } = parseMemoryCandidates(withCandidates('S', body));
    t.is(candidates.length, 3);
});

test('parseMemoryCandidates: tolerates prose-wrapped JSON (extracts first object)', t => {
    const raw = `Summary.\n\n${MEMORY_CANDIDATES_SENTINEL}\nHere you go: {"memory_candidates": [{"name":"x","type":"user","content":"y"}]} done`;
    const { candidates } = parseMemoryCandidates(raw);
    t.is(candidates.length, 1);
    t.is(candidates[0].name, 'x');
});
