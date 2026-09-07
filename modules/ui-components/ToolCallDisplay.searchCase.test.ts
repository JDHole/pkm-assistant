/**
 * Strażnik AUD-code-review-039: kanoniczne narzędzie `search` musi mieć `case 'search'`
 * w KAŻDYM z trzech switchy formatujących wywołanie narzędzia w `ToolCallDisplay.ts`.
 *
 * Wtopa: `formatToolInput` i `formatToolOutput` miały tylko `case 'vault_search'` (legacy
 * alias) — `search` (nazwa, którą model dostaje w `inputSchema`, `SearchTool.ts:89`) spadał
 * do gałęzi `default`: nagłówek pokazywał surowy JSON zamiast samego zapytania, a wynik
 * tracił ponumerowaną listę ścieżek na rzecz `results: N elementów`. `formatToolInputDetail`
 * miała `case 'search'` od początku — rozjazd był widoczny w TYM SAMYM pliku.
 *
 * Testujemy PO ŹRÓDLE, nie przez wywołanie funkcji: `createToolCallDisplay`/
 * `createCompactToolChip` budują DOM przez rozszerzenia Obsidiana na `HTMLElement`
 * (`.createDiv`/`.createSpan`), których w gołym Node/AVA nie ma — a `formatToolInput`/
 * `formatToolInputDetail`/`formatToolOutput` (funkcje, które faktycznie miały wadę) nie są
 * eksportowane. Regex pilnuje dokładnie tego, co się rozjechało: kolejności `case` wewnątrz
 * każdego switcha.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const source = readFileSync(fileURLToPath(new URL('./ToolCallDisplay.ts', import.meta.url)), 'utf8');

/** Ciało funkcji `function <name>(` do domykającego `\n}` na poziomie modułu. */
function functionBody(name: string): string {
    const head = new RegExp(`\\nfunction ${name}\\([^)]*\\)[^{]*\\{`).exec(source);
    if (!head) return '';
    const rest = source.slice(head.index + head[0].length);
    const to = rest.indexOf('\n}');
    return to < 0 ? rest : rest.slice(0, to);
}

for (const fnName of ['formatToolInput', 'formatToolInputDetail', 'formatToolOutput']) {
    test(`${fnName}: case 'search' stoi obok case 'vault_search' (AUD-code-review-039)`, t => {
        const body = functionBody(fnName);
        t.true(body.length > 0, `nie znalazłem ${fnName} w ToolCallDisplay.ts`);
        t.regex(body, /case 'search':\s*\n\s*case 'vault_search':/,
            `${fnName} nie rozpoznaje kanonicznego narzędzia 'search' — spada do gałęzi default jak 'vault_search' bez 'search' obok`);
    });
}
