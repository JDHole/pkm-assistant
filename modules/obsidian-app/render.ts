import { maskSensitiveData } from '../../core/index.js';

export type RenderBlock = { language: string; text: string; error: string | null };
export type RenderObservation = { blocks: RenderBlock[]; errors: string[]; errorsTruncated: boolean; stabilized: boolean; elapsedMs: number; mode: string; verify?: () => boolean };

/** Only the detailed branch may copy DOM or global error text into the result. */
export function sourceBlocks(source: string) {
    const result: { dataview: number[]; dataviewjs: number[] } = { dataview: [], dataviewjs: [] };
    let fence: { char: string; length: number } | null = null;
    source.split(/\r?\n/).forEach((line, index) => {
        const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (!match) return;
        if (fence) {
            if (match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) fence = null;
        } else {
            fence = { char: match[1][0], length: match[1].length };
            const language = match[2].trim().split(/\s+/)[0].toLowerCase();
            if (language === 'dataview' || language === 'dataviewjs') result[language].push(index + 1);
        }
    });
    return result;
}

export function buildRenderResult(observation: RenderObservation, detail: boolean, source = '') {
    const lines = sourceBlocks(source);
    const observed = { dataview: 0, dataviewjs: 0 };
    for (const block of observation.blocks) if (block.language === 'dataview' || block.language === 'dataviewjs') observed[block.language]++;
    const coverage = lines.dataview.length === observed.dataview && lines.dataviewjs.length === observed.dataviewjs ? 'complete' : 'partial';
    let remaining = 12000;
    const blocks = observation.blocks.map((block, index) => {
        const status = block.error !== null ? 'error' : !observation.stabilized ? 'timeout' : block.text.trim() ? 'rendered' : 'empty';
        const base = { number: index + 1, language: block.language === 'dataview' || block.language === 'dataviewjs' ? block.language : 'other', status };
        if (!detail) return base;
        const text = maskSensitiveData(block.text.replace(/\s+/g, ' ').trim());
        const limit = Math.min(2000, remaining);
        const value = text.slice(0, limit);
        remaining -= value.length;
        const error = block.error === null ? null : maskSensitiveData(block.error.replace(/\s+/g, ' ').trim());
        const errorLimit = Math.min(1000, remaining);
        const errorValue = error?.slice(0, errorLimit) ?? null;
        remaining -= errorValue?.length ?? 0;
        return { ...base, text: value, text_truncated: value.length < text.length, ...(error !== null ? { error: errorValue, error_truncated: (errorValue?.length ?? 0) < error.length } : {}) };
    });
    const errors = detail ? observation.errors.slice(0, 20).map(error => {
        const masked = maskSensitiveData(error.replace(/\s+/g, ' ').trim());
        const value = masked.slice(0, Math.min(1000, remaining));
        remaining -= value.length;
        return { text: value, truncated: value.length < masked.length, attribution: 'unassigned' as const };
    }) : undefined;
    return { blocks, block_count: blocks.length, stabilized: observation.stabilized, elapsed_ms: observation.elapsedMs, mode: 'preview' as const, source_blocks: { count: lines.dataview.length + lines.dataviewjs.length, dataview: lines.dataview, dataviewjs: lines.dataviewjs }, observed_blocks: { count: blocks.length, ...observed }, coverage, block_numbering: 'observed_order' as const, ...(coverage === 'partial' ? { coverage_note: 'Some blocks were not rendered by Obsidian (lazy rendering or collapsed headings) and were not checked.' as const } : {}),
        ...(detail ? { global_errors: errors, global_errors_truncated: observation.errorsTruncated || observation.errors.length > 20 } : {}) };
}
