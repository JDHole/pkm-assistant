
import { KNOWN_ROLES, escapeActiveText, unescapeActiveText } from './activeSessionFormat.js';
import type { SessionRole } from './activeSessionFormat.js';

// Role granicznych nagłówków + para escape/unescape mieszkają w `activeSessionFormat.js`
// (jedno źródło kontraktu pliku sesji, S36 Faza 1). `KNOWN_ROLES` jest tu tylko UŻYWANE
// (niżej) — re-eksport bez konsumenta skasowany w dead-code sweepie 2026-09-02
// (AUD-dead-code-226): jedyni realni konsumenci, `AgentMemory.ts` i ten plik, biorą stałą
// wprost z `activeSessionFormat.js`.

/**
 * Wiadomość podawana pisarzowi B. `role`/`content` są WIELOKSZTAŁTNE z premedytacją:
 * pisarz broni się przed rolą-nie-stringiem (E1.8: `## [object Object]`) i przyjmuje
 * treść multimodalną (tablica bloków `{text}`/`{content}`), z której wycina sam tekst.
 */
export interface TranscriptMessageInput {
    role?: unknown;
    content?: string | Array<{ text?: string; content?: string }> | null;
}

/** Wiadomość odzyskana z transkryptu (`format B`) — rola zawsze ze znanego zbioru. */
export interface TranscriptMessage {
    role: SessionRole;
    content: string;
}

/**
 * Frontmatter transkryptu. `tokens_used` wraca z parsera jako liczba, reszta jako string —
 * pisarz serializuje wartości zwykłą interpolacją, więc wejście jest wielokształtne.
 */
export type TranscriptMetadata = Record<string, string | number | boolean | null>;

/** Wynik czytania pliku transkryptu (`sessions/archive/*.md`). */
export interface ParsedSessionFile {
    messages: TranscriptMessage[];
    metadata: TranscriptMetadata;
    summary: string | null;
}

/**
 * Formatuje tablicę wiadomości do Markdown
 * @param metadata - {created, agent, tokens_used}
 * @param summary - Opcjonalne podsumowanie
 * @returns Markdown content
 */
export function formatToMarkdown(
    messages: TranscriptMessageInput[],
    metadata: TranscriptMetadata = {},
    summary: string | null = null,
): string {
    const lines: string[] = [];

    // 1. Frontmatter YAML
    if (metadata && Object.keys(metadata).length > 0) {
        lines.push('---');
        for (const [key, value] of Object.entries(metadata)) {
            // Ensure proper serialization of dates or complex objects if needed
            // But for simple metadata (string/number), this suffices
            lines.push(`${key}: ${value}`);
        }
        lines.push('---');
    }

    // 2. Messages
    messages.forEach(msg => {
        if (!msg || typeof msg !== 'object') return;
        // Rola MUSI być prostym stringiem ze znanego zbioru — obiekt dawał nagłówek
        // "## [object Object]", nieznana rola rozjeżdżała restore (E1.8 fix).
        const rawRole = typeof msg.role === 'string' && KNOWN_ROLES.has(msg.role.toLowerCase())
            ? msg.role.toLowerCase()
            : 'system';
        const role = rawRole.charAt(0).toUpperCase() + rawRole.slice(1);
        lines.push(`## ${role}`);
        // content can be string or array (multimodal) — extract text
        const content = Array.isArray(msg.content)
            ? msg.content.map(c => c.text || c.content || '').filter(Boolean).join('\n')
            : (msg.content || '');
        // Escape linii, które wyglądałyby jak granica wiadomości — `\## ` renderuje
        // się w Markdown jako zwykłe "## ", a parseSessionFile robi unescape.
        lines.push(escapeActiveText(content));
    });

    // 3. Summary
    if (summary) {
        lines.push('---');
        lines.push('## Podsumowanie sesji');
        lines.push(summary);
    }

    return lines.join('\n');
}

/**
 * Parsuje Markdown sesji z powrotem do struktury
 * @param content - Zawartość pliku MD
 */
export function parseSessionFile(content: string | null | undefined): ParsedSessionFile {
    const result: ParsedSessionFile = {
        messages: [],
        metadata: {},
        summary: null
    };

    if (!content) return result;

    // Normalize line endings to \n
    let text = content.replace(/\r\n/g, '\n');

    // 1. Extract Frontmatter
    // Looks for --- at the start, content, then ---
    const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
    const fmMatch = text.match(frontmatterRegex);

    if (fmMatch) {
        const rawFm = fmMatch[1];
        rawFm.split('\n').forEach(line => {
            const separatorIndex = line.indexOf(':');
            if (separatorIndex !== -1) {
                const key = line.slice(0, separatorIndex).trim();
                // Wielokształtne z premedytacją: `tokens_used` wraca liczbą, reszta stringiem.
                let value: string | number = line.slice(separatorIndex + 1).trim();

                // Simple type conversion for tokens_used
                if (key === 'tokens_used') {
                    value = parseInt(value, 10) || 0;
                }

                result.metadata[key] = value;
            }
        });

        // Remove frontmatter from text to simplify remaining parsing
        text = text.replace(frontmatterRegex, '').trim();
    }

    // 2. Extract Summary
    // Looks for the specific summary section at the end
    // Pattern: Newline (optional) + --- + Newline + ## Podsumowanie sesji + Newline + Content
    const summaryRegex = /(?:^|\n)---\n## Podsumowanie sesji\n([\s\S]*)$/;
    const summaryMatch = text.match(summaryRegex);

    if (summaryMatch) {
        result.summary = summaryMatch[1].trim();
        // Remove summary from text
        text = text.replace(summaryRegex, '').trim();
    }

    // 3. Parse Messages
    // Split by "## Role" (line start). Header spoza KNOWN_ROLES to NIE granica —
    // to treść poprzedniej wiadomości (np. sekcja "## Wyniki" w odpowiedzi agenta,
    // stare pliki sprzed escapowania) i wraca tam, skąd przyszła (E1.8 fix).
    const unescape = unescapeActiveText;
    const parts = text.split(/(?:^|\n)## /);

    parts.forEach(part => {
        if (!part.trim()) return;

        const splitIndex = part.indexOf('\n');
        const head = (splitIndex === -1 ? part : part.slice(0, splitIndex)).trim();
        const body = splitIndex === -1 ? '' : part.slice(splitIndex + 1).trim();
        const role = head.toLowerCase();

        // `KNOWN_ROLES` to Set<string>, więc `has` nie zawęża typu — asercja
        // przywraca wiedzę, którą właśnie sprawdziliśmy.
        if (KNOWN_ROLES.has(role)) {
            result.messages.push({ role: role as SessionRole, content: unescape(body) });
            return;
        }

        // Nieznany nagłówek → doklej do poprzedniej wiadomości jako jej treść.
        const prev = result.messages[result.messages.length - 1];
        if (prev) {
            const restored = `## ${head}${body ? '\n' + body : ''}`;
            prev.content = prev.content ? `${prev.content}\n${unescape(restored)}` : unescape(restored);
        }
        // Brak poprzedniej wiadomości = śmieć przed pierwszą rolą — pomijamy.
    });

    return result;
}
