/** Header-only raster inspection: no browser decoder, allocation proportional to file bytes only. */
export interface ImageHeader { mime: string; width: number; height: number }
export const MAX_IMAGE_PIXELS = 40_000_000; // RGBA alone can require 160 MB; reject before decoder allocations.

export function readImageHeader(buffer: ArrayBuffer): ImageHeader | null {
    const b = new Uint8Array(buffer);
    const v = new DataView(buffer);
    const text = (offset: number, length: number) => String.fromCharCode(...b.subarray(offset, offset + length));
    const result = (mime: string, width: number, height: number): ImageHeader | null =>
        width > 0 && height > 0 ? { mime, width, height } : null;
    if (b.length >= 33 && b[0] === 137 && text(1, 7) === 'PNG\r\n\x1a\n'
        && v.getUint32(8) === 13 && text(12, 4) === 'IHDR') {
        return result('image/png', v.getUint32(16), v.getUint32(20));
    }
    if (b.length >= 13 && ['GIF87a', 'GIF89a'].includes(text(0, 6))) {
        return result('image/gif', v.getUint16(6, true), v.getUint16(8, true));
    }
    if (b.length >= 4 && b[0] === 255 && b[1] === 216) {
        let p = 2;
        while (p < b.length) {
            if (b[p++] !== 255) return null;
            while (b[p] === 255) p++;
            const marker = b[p++];
            if (marker === 217 || marker === 218 || marker === undefined) return null;
            if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
            if (p + 2 > b.length) return null;
            const length = v.getUint16(p);
            if (length < 2 || p + length > b.length) return null;
            if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
                if (length < 8) return null;
                return result('image/jpeg', v.getUint16(p + 5), v.getUint16(p + 3));
            }
            p += length;
        }
    }
    if (b.length >= 20 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
        const end = v.getUint32(4, true) + 8;
        if (end > b.length || end < 20) return null;
        const u24 = (p: number) => b[p] + b[p + 1] * 256 + b[p + 2] * 65536;
        for (let p = 12; p + 8 <= end;) {
            const kind = text(p, 4), length = v.getUint32(p + 4, true), start = p + 8;
            if (start + length > end) return null;
            if (kind === 'VP8X' && length >= 10) return result('image/webp', u24(start + 4) + 1, u24(start + 7) + 1);
            if (kind === 'VP8L' && length >= 5 && b[start] === 47) {
                const packed = v.getUint32(start + 1, true);
                return result('image/webp', (packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
            }
            if (kind === 'VP8 ' && length >= 10 && !(b[start] & 1)
                && b[start + 3] === 157 && b[start + 4] === 1 && b[start + 5] === 42) {
                return result('image/webp', v.getUint16(start + 6, true) & 0x3fff, v.getUint16(start + 8, true) & 0x3fff);
            }
            p = start + length + (length % 2);
        }
    }
    return null;
}
