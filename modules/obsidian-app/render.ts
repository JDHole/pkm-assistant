import { maskSensitiveData } from '../../core/index.js';

export type RenderBlock = { language: string; text: string; error: string | null };
export type RenderObservation = { blocks: RenderBlock[]; errors: string[]; errorsTruncated: boolean; stabilized: boolean; elapsedMs: number; mode: string };

/** Only the detailed branch may copy DOM or global error text into the result. */
export function buildRenderResult(observation: RenderObservation, detail: boolean) {
    let remaining = 12000;
    const blocks = observation.blocks.map((block, index) => {
        const status = block.error !== null ? 'error' : !observation.stabilized ? 'timeout' : block.text.trim() ? 'rendered' : 'empty';
        const base = { number: index + 1, language: maskSensitiveData(block.language.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)), status };
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
    return { blocks, block_count: blocks.length, stabilized: observation.stabilized, elapsed_ms: observation.elapsedMs, mode: observation.mode,
        ...(detail ? { global_errors: errors, global_errors_truncated: observation.errorsTruncated || observation.errors.length > 20 } : {}) };
}
