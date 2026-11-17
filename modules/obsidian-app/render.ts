import { maskSensitiveData } from '../../core/index.js';

export type RenderBlock = { language: string; text: string; error: string | null; nonempty?: boolean; textClipped?: boolean; errorClipped?: boolean };
export type RenderObservation = { blocks: RenderBlock[]; errors: { text: string; truncated: boolean }[]; errorsTruncated: boolean; stabilized: boolean; elapsedMs: number; mode: string; verify?: () => boolean };

export type SourceBlocks = { dataview: number[]; dataviewjs: number[] };

/** Only the detailed branch may copy DOM or global error text into the result. */
export function buildRenderResult(observation: RenderObservation, detail: boolean, lines: SourceBlocks = { dataview: [], dataviewjs: [] }) {
    const observed = { dataview: 0, dataviewjs: 0 };
    for (const block of observation.blocks) if (block.language === 'dataview' || block.language === 'dataviewjs') observed[block.language]++;
    const coverage = lines.dataview.length === observed.dataview && lines.dataviewjs.length === observed.dataviewjs ? 'counts_match' : 'partial';
    let remaining = 12000;
    const blocks = observation.blocks.map((block, index) => {
        const status = block.error !== null ? 'error' : !observation.stabilized ? 'timeout' : (block.nonempty ?? !!block.text.trim()) ? 'rendered' : 'empty';
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
        return { ...base, text: value, text_truncated: block.textClipped === true || value.length < text.length, ...(error !== null ? { error: errorValue, error_truncated: block.errorClipped === true || (errorValue?.length ?? 0) < error.length } : {}) };
    });
    const errors = detail ? observation.errors.slice(0, 20).map(error => {
        const masked = maskSensitiveData(error.text.replace(/\s+/g, ' ').trim());
        const value = masked.slice(0, Math.min(1000, remaining));
        remaining -= value.length;
        return { text: value, truncated: error.truncated || value.length < masked.length, attribution: 'unassigned' as const };
    }) : undefined;
    return { blocks, block_count: blocks.length, stabilized: observation.stabilized, elapsed_ms: observation.elapsedMs, mode: 'preview' as const, source_blocks: { count: lines.dataview.length + lines.dataviewjs.length, dataview: lines.dataview, dataviewjs: lines.dataviewjs }, observed_blocks: { count: blocks.length, ...observed }, coverage, block_numbering: 'observed_order' as const, ...(coverage === 'partial' ? { coverage_note: 'Some blocks were not rendered by Obsidian (lazy rendering or collapsed headings) and were not checked.' as const } : {}),
        ...(detail ? { global_errors: errors, global_errors_truncated: observation.errorsTruncated || observation.errors.length > 20 } : {}) };
}
