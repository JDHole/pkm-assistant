/**
 * Shared binary conversion utilities.
 */

/**
 * Convert ArrayBuffer to base64 string — chunk-based for performance.
 * Avoids O(n²) string concatenation for large buffers.
 * @param buffer
 * @returns base64-encoded string
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const CHUNK = 0x8000; // 32KB chunks
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
        // `apply(null, …)` na Uint8Array: TS chce `number[]`, runtime bierze array-like.
        // Asercja zamiast Array.from — kopiowanie chunka byłoby zmianą wykonania.
        parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]));
    }
    return btoa(parts.join(''));
}

/**
 * Convert Blob to base64 string.
 * @param blob
 * @returns base64-encoded string
 */
export async function blobToBase64(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer();
    return arrayBufferToBase64(buffer);
}
