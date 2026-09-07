/**
 * Shared slugify utility — Polish-aware, kebab-case output.
 * Single source of truth for folder/file name generation.
 * @param text - Input text
 * @param maxLen - Maximum slug length
 * @returns Slugified text
 */
export function slugify(text: string, maxLen: number = 50): string {
    return text
        .toLowerCase()
        .replace(/[ąàáâã]/g, 'a').replace(/[ćč]/g, 'c')
        .replace(/[ęèéêë]/g, 'e').replace(/[ł]/g, 'l')
        .replace(/[ńñ]/g, 'n').replace(/[óòôõ]/g, 'o')
        .replace(/[śš]/g, 's').replace(/[ź]/g, 'z').replace(/[żž]/g, 'z')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, maxLen);
}
