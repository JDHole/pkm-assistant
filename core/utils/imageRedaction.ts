/** Shared binary redaction for logs and textual tool consumers. Run BEFORE truncation. */
export function redactImageText(text: string): string {
    return text
        .replace(/data:image(?:\\\/|\/)([A-Za-z0-9.+-]+);base64,(?:[A-Za-z0-9+=]|\\\/|\/)+/gi, '[image image/$1]')
        .replace(/("base64"\s*:\s*")[^"]*(")/g, '$1[image data]$2')
        .replace(/(\\"base64\\"\s*:\s*\\").*?(\\")/g, '$1[image data]$2');
}

export function imageRedactionReplacer(key: string, value: unknown): unknown {
    if (key === 'base64') return undefined;
    return typeof value === 'string' ? redactImageText(value) : value;
}
