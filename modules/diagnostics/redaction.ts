type Marker = '[REDACTED]' | '[EMAIL]' | '[URL]' | '[PATH]';
interface Redaction { start: number; end: number; marker: Marker }

// Deliberately local: the core log mask retains key fragments, unsuitable for a shared report.
const KEY_TOKEN = /\b(?:sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]+|xai-[A-Za-z0-9_-]+|gsk_[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){0,2})/g;
// Provider decoders may already have applied core's four-character fragment mask.
const PARTIAL_MASK = /[A-Za-z0-9_-]+\*{3}[A-Za-z0-9_-]+/g;
const EMAIL = /(?:"(?:[^"\\\r\n]|\\.)+"|[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+)@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi;
const FIELD = /(^|[^\w-])(?:["']?(?:authorization|proxy-authorization|x-api-key|x-goog-api-key|key|api_key|apikey|api-key|token|access_token|refresh_token|secret|password|signature)["']?[ \t]*[:=][ \t]*)(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|(?:(?:Bearer|Basic|Token)[ \t]+)?[^\s"'<>,;|&}]+)/gi;
const QUERY = /[?&](?:key|api_key|apikey|api-key|token|access_token|refresh_token|secret|password|signature)=([^\s&#"'<>,;|}]*)/gi;
const SCHEME = /\b(?:Bearer|Basic|Token)[ \t]+(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|[^\s"'<>,;|&}]+)/gi;
// Unquoted HTTP authorization headers are line-oriented, including Digest parameters.
const AUTHORIZATION_HEADER = /\b(?:authorization|proxy-authorization)["']?[ \t]*[:=][ \t]*(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|[^\r\n|]+)/gi;
const SYSTEM_ROOT = /(^|[^\w./\\-])(?:\/(?:home|Users|storage|sdcard|data|mnt|var|private|tmp|root|opt|etc|usr|Volumes|media|run)\/|~\/)|\bfile:\/\/|\\\\|(^|[^A-Za-z0-9])([A-Za-z]:[\\/])/g;

function escaped(text: string, index: number): boolean {
    let slashes = 0;
    while (index > 0 && text[--index] === '\\') slashes++;
    return slashes % 2 === 1;
}

/** A rooted path may contain spaces/punctuation; only its enclosing quote or EOL ends it. */
function pathEnd(text: string, start: number): number {
    const lineStart = Math.max(text.lastIndexOf('\n', start - 1), text.lastIndexOf('\r', start - 1)) + 1;
    let quote = '';
    for (let i = lineStart; i < start; i++) {
        const char = text[i];
        if (char === quote && !escaped(text, i)) quote = '';
        else if (!quote && (char === '"' || char === "'") && (i === lineStart || /[\s:=([{]/.test(text[i - 1]))) quote = char;
    }
    let end = start;
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r' && (!quote || text[end] !== quote || escaped(text, end))) end++;
    return end;
}

/** Collect on original text, then replace once: overlapping rules cannot expose fragments
 * or rewrite generated markers (even when a configured secret is one character long). */
export function redactDiagnosticText(text: string, secrets: readonly string[]): string {
    const spans: Redaction[] = [];
    const add = (start: number, end: number, marker: Marker) => { if (end > start) spans.push({ start, end, marker }); };
    for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) add(match.index, match.index + match[0].length, '[URL]');
    for (const match of text.matchAll(SYSTEM_ROOT)) {
        const start = match.index + (match[1]?.length ?? match[2]?.length ?? 0);
        add(start, pathEnd(text, start), '[PATH]');
    }
    for (const match of text.matchAll(EMAIL)) add(match.index, match.index + match[0].length, '[EMAIL]');
    for (const match of text.matchAll(QUERY)) {
        add(match.index + match[0].length - match[1].length, match.index + match[0].length, '[REDACTED]');
    }
    for (const match of text.matchAll(FIELD)) {
        // Query parameters retain their names; the QUERY rule owns their values.
        if (match[1] === '?' || match[1] === '&') continue;
        add(match.index + match[1].length, match.index + match[0].length, '[REDACTED]');
    }
    for (const pattern of [KEY_TOKEN, PARTIAL_MASK, SCHEME, AUTHORIZATION_HEADER]) {
        for (const match of text.matchAll(pattern)) add(match.index, match.index + match[0].length, '[REDACTED]');
    }
    const markers = [...text.matchAll(/\[(?:REDACTED|EMAIL|URL|PATH)\]/g)];
    for (const secret of secrets) {
        for (const variant of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
            for (let start = text.indexOf(variant); start !== -1; start = text.indexOf(variant, start + variant.length)) {
                if (!markers.some(marker => start >= marker.index && start + variant.length <= marker.index + marker[0].length)) {
                    add(start, start + variant.length, '[REDACTED]');
                }
            }
        }
    }
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: Redaction[] = [];
    for (const span of spans) {
        const previous = merged[merged.length - 1];
        if (previous && span.start < previous.end) previous.end = Math.max(previous.end, span.end);
        else merged.push({ ...span });
    }
    let result = '', cursor = 0;
    for (const span of merged) {
        result += text.slice(cursor, span.start) + span.marker;
        cursor = span.end;
    }
    return result + text.slice(cursor);
}
