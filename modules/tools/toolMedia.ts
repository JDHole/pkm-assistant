/** Obraz zwrócony przez narzędzie. */
export interface ToolMediaImage {
    mime: string;
    base64: string;
    width?: number;
    height?: number;
}

/** Wynik narzędzia zawierający obrazy i opis. */
export interface ToolMediaResult {
    kind: 'media';
    summary: string;
    images: ToolMediaImage[];
    [k: string]: unknown;
}

/** Blok tekstu lub obrazu przekazywany modelowi. */
export type ToolContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isImage(value: unknown): value is ToolMediaImage {
    return isRecord(value) && typeof value.mime === 'string' && /^image\/.+/.test(value.mime)
        && typeof value.base64 === 'string' && value.base64.length > 0
        && (!('width' in value) || (typeof value.width === 'number' && Number.isFinite(value.width) && value.width > 0))
        && (!('height' in value) || (typeof value.height === 'number' && Number.isFinite(value.height) && value.height > 0));
}

/** Rozpoznaje wynik mediów i dostosowuje wynik generatora obrazu. */
export function asToolMedia(toolName: string, raw: unknown): ToolMediaResult | null {
    if (!isRecord(raw)) return null;
    if (raw.kind === 'media') {
        return Array.isArray(raw.images) && raw.images.length > 0 && raw.images.every(isImage)
            ? raw as unknown as ToolMediaResult : null;
    }
    if (toolName === 'generate_image' && typeof raw.base64 === 'string' && raw.base64.length > 0) {
        const { base64, ...rest } = raw;
        return { ...rest, kind: 'media', summary: '', images: [{ mime: `image/${typeof raw.format === 'string' && raw.format ? raw.format : 'png'}`, base64 }] };
    }
    return null;
}

/** Tworzy opis wyniku bez danych binarnych. */
export function mediaTextPart(_toolName: string, raw: unknown): Record<string, unknown> {
    if (!isRecord(raw)) return {};
    const cleaned = JSON.parse(JSON.stringify(raw, (key, value: unknown) => {
        if (key === 'base64') return undefined;
        return typeof value === 'string'
            ? value.replace(/data:(image\/[A-Za-z0-9.+-]+);base64,[A-Za-z0-9+/=]+/g, '[image $1]')
            : value;
    })) as Record<string, unknown>;
    if (raw.kind === 'media' && Array.isArray(raw.images)) {
        cleaned.images = raw.images.filter(isImage).map(({ mime, width, height }) => ({
            mime, ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }),
        }));
    }
    return cleaned;
}

/** Przygotowuje treść wyniku dla modelu z obsługą vision lub bez niej. */
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
