import { isValidNoteType } from '../../memory/index.js';

/**
 * E2.7 W2 (K3): parse the MEMORY_CANDIDATES block that the Summarizer appends to its summary.
 *
 * The Summarizer produces ONE LLM call: the structured summary, then (optionally) a sentinel line
 * followed by a fenced ```json block listing 0-3 durable memory candidates. This helper splits the
 * two so the summary stored as conversationSummary stays clean, and the candidates are validated
 * before chat_session writes them to brain/ (create-only + K1 queue).
 *
 * Tolerant by contract: missing sentinel / garbage JSON / wrong shape → zero candidates and the
 * summary is returned unchanged (never blocks compaction).
 */
export const MEMORY_CANDIDATES_SENTINEL = '===MEMORY_CANDIDATES===';
const MAX_CANDIDATES = 3;

// TS-any: wynik JSON.parse jest dynamicznym payloadem LLM walidowanym pole po polu poniżej.
type RuntimeJson = any;

export type MemoryCandidate = {
    name: string;
    description: string;
    type: string;
    content: string;
    why: string;
    how_to_apply: string;
};

/**
 * @param {string} rawText - Full Summarizer response (summary + optional candidate block).
 * @returns {{ summary: string, candidates: Array<{name,description,type,content,why,how_to_apply}> }}
 */
export function parseMemoryCandidates(rawText: unknown): { summary: string; candidates: MemoryCandidate[] } {
    const text = String(rawText || '');
    const idx = text.indexOf(MEMORY_CANDIDATES_SENTINEL);
    if (idx === -1) {
        return { summary: text.trim(), candidates: [] };
    }
    const summary = text.slice(0, idx).trim();
    const tail = text.slice(idx + MEMORY_CANDIDATES_SENTINEL.length);
    return { summary, candidates: extractCandidates(tail) };
}

function extractCandidates(tail: unknown): MemoryCandidate[] {
    const jsonText = String(tail || '').trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    if (!jsonText) return [];

    let parsed: RuntimeJson;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        const match = jsonText.match(/\{[\s\S]*\}/);
        if (!match) return [];
        try { parsed = JSON.parse(match[0]); } catch { return []; }
    }

    const list: RuntimeJson[] = Array.isArray(parsed?.memory_candidates) ? parsed.memory_candidates
        : Array.isArray(parsed) ? parsed
        : [];

    const clean: MemoryCandidate[] = [];
    for (const candidate of list) {
        // Invalid type is rejected outright (not silently coerced) — a mislabeled note pollutes the
        // wrong brain.md section. Spec K3: "zły typ → odrzucony".
        if (!isValidNoteType(candidate?.type)) continue;
        const name = String(candidate?.name || '').trim();
        const content = String(candidate?.content || '').trim();
        if (!name || !content) continue;
        clean.push({
            name,
            description: String(candidate?.description || '').trim(),
            type: candidate.type,
            content,
            why: String(candidate?.why || '').trim(),
            how_to_apply: String(candidate?.how_to_apply || candidate?.howToApply || '').trim(),
        });
        if (clean.length >= MAX_CANDIDATES) break;
    }
    return clean;
}
