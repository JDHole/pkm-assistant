export interface ToolMediaImage {
    mime: string;
    base64: string;
    width?: number;
    height?: number;
}

export interface ToolMediaResult {
    kind: 'media';
    summary: string;
    images: ToolMediaImage[];
    [k: string]: unknown;
}

export type ToolContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isImage(value: unknown): value is ToolMediaImage {
    return isRecord(value) && typeof value.mime === 'string' && /^image\/.+/.test(value.mime)
        && typeof value.base64 === 'string' && value.base64.length > 0;
}

export function asToolMedia(toolName: string, raw: unknown): ToolMediaResult | null {
    if (!isRecord(raw)) return null;
    if (raw.kind === 'media' && Array.isArray(raw.images)
        && raw.images.length > 0 && raw.images.every(isImage)) {
        return raw as unknown as ToolMediaResult;
    }
    if (toolName === 'generate_image' && typeof raw.base64 === 'string' && raw.base64.length > 0) {
        const { base64, ...rest } = raw;
        return { ...rest, kind: 'media', summary: '', images: [{ mime: `image/${String(raw.format || 'png')}`, base64 }] };
    }
    return null;
}

export function mediaTextPart(toolName: string, raw: unknown): Record<string, unknown> {
    if (!isRecord(raw)) return {};
    if (raw.kind === 'media' && Array.isArray(raw.images)) {
        return { ...raw, images: raw.images.filter(isImage).map(({ mime, width, height }) => ({
            mime, ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }),
        })) };
    }
    if (toolName === 'generate_image') {
        const { base64: _base64, ...rest } = raw;
        return rest;
    }
    return { ...raw };
}

export function toToolMessageContent(
    media: ToolMediaResult,
    opts: { vision: boolean; textPart: Record<string, unknown> },
): string | ToolContentBlock[] {
    if (!opts.vision) return JSON.stringify({ ...opts.textPart, image_delivery: 'not delivered: model without vision' });
    return [
        { type: 'text', text: JSON.stringify(opts.textPart) },
        ...media.images.map(image => ({ type: 'image_url' as const, image_url: { url: `data:${image.mime};base64,${image.base64}` } })),
    ];
}
