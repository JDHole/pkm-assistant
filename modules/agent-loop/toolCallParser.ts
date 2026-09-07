/**
 * toolCallParser — kanoniczny parser tool_calls dla pętli agenta.
 *
 * JEDNO miejsce na parsowanie wywołań narzędzi z odpowiedzi modelu, niezależnie od
 * dostawcy. Wcześniej ta logika żyła w DWÓCH kopiach:
 *   - modules/mcp/MCPClient.js (parseToolCalls + _trySplitConcatenatedToolCall)
 *   - modules/memory/streamHelper.js (_splitConcatenatedToolCalls, pętla sub-agentów)
 * E2.1 wyciąga ją tutaj jako czyste funkcje. Kanonem odsklejania jest wersja z
 * MCPClient (operuje na płaskim kształcie `{id, name, arguments}` — tym samym, który
 * zwraca parser), rozszerzona o wstrzykiwaną listę znanych nazw narzędzi zamiast
 * twardej zależności od `ToolRegistry`.
 *
 * ZERO zależności od modules/mcp, modules/chat, modules/sub-agents — czyste funkcje.
 */

/**
 * Blok treści w odpowiedzi modelu. Anthropic: `{type:'text'|'tool_use', ...}`, OpenAI multimodal:
 * `{type:'text'|'image_url', ...}`. Luźny CELOWO — dostawcy dokładają własne pola.
 */
interface ContentBlock {
    type?: string;
    text?: string;
    /** Anthropic `tool_use`: id + name + input (argumenty JUŻ jako obiekt). */
    id?: string;
    name?: string;
    input?: unknown;
    [key: string]: unknown;
}

/** Usage tak, jak zwraca je dostawca (pola bywają nieobecne — stąd wszystko opcjonalne). */
export interface ProviderUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    [key: string]: unknown;
}

/** Surowe wywołanie narzędzia PRZED spłaszczeniem (kształt OpenAI `function` albo płaski). */
interface RawToolCall {
    id?: string;
    type?: string;
    name?: string;
    /** OpenAI wysyła string JSON, Anthropic obiekt. */
    arguments?: unknown;
    function?: { name?: string; arguments?: unknown };
    [key: string]: unknown;
}

/**
 * Luźny widok odpowiedzi modelu — pokrywa WSZYSTKIE 3 kształty, które parser sprawdza
 * sekwencyjnie (Anthropic content-blocks / root `tool_calls` / `choices[0].message`).
 * Wszystko opcjonalne + index signature: dostawcy dokładają własne pola, a pętla czyta
 * tylko te niżej.
 */
export interface ModelResponse {
    content?: string | ContentBlock[];
    tool_calls?: RawToolCall[];
    choices?: Array<{
        message?: {
            role?: string;
            content?: string | ContentBlock[] | null;
            tool_calls?: RawToolCall[];
            reasoning_content?: unknown;
        };
    }>;
    usage?: ProviderUsage;
    [key: string]: unknown;
}

/**
 * PŁASKIE wywołanie narzędzia — to zwraca parser i tym operuje pętla.
 * `name` jest opcjonalne, bo dostawca potrafi nie podać ani `function.name`, ani `name`
 * (pętla broni się `tc.name || tc.function?.name`). `function` zostaje, bo hooki konsumentów
 * mogą oddać kształt niespłaszczony — kod czyta obie ścieżki.
 */
export interface ParsedToolCall {
    id?: string;
    name?: string;
    /** OpenAI: string JSON. Anthropic: obiekt. */
    arguments?: unknown;
    function?: { name?: string; arguments?: unknown };
}

/** Opcje parsera / odsklejania. */
export interface ParseToolCallsOptions {
    /** Znane nazwy narzędzi (do dekompozycji sklejeń). */
    knownToolNames?: string[];
    /** Predykat „czy nazwa to znane narzędzie" (wygrywa nad listą). */
    isToolKnown?: (name: string) => boolean;
}

/**
 * Parsuje wywołania narzędzi z odpowiedzi modelu. Obsługuje 3 kształty:
 *   1. Anthropic content-blocks — `response.content[]` z blokami `type: 'tool_use'`.
 *   2. root `response.tool_calls[]` (OpenAI wariant bez `choices`).
 *   3. `response.choices[0].message.tool_calls[]` (najczęstsza ścieżka OpenAI/Gemini).
 * Wszystkie trzy są sprawdzane sekwencyjnie (nie else-if) — zachowanie z MCPClient.
 *
 * Zwraca PŁASKI kształt `{id, name, arguments}` i na końcu woła odsklejanie
 * (DeepSeek Reasoner potrafi skleić kilka wywołań w jedno).
 *
 * @param response - surowa odpowiedź modelu
 * @param options - `knownToolNames` (lista do dekompozycji sklejeń) + `isToolKnown` (predykat
 *   „czy nazwa to znane narzędzie"; domyślnie `knownToolNames.includes(name)`). MCPClient podaje
 *   predykat oparty o registry, żeby zachować dokładnie dotychczasowe zachowanie.
 */
export function parseToolCalls(
    response: ModelResponse | null | undefined,
    options: ParseToolCallsOptions = {},
): ParsedToolCall[] {
    const toolCalls: ParsedToolCall[] = [];

    // 1) Anthropic: response.content to tablica bloków; bierzemy `type: 'tool_use'`.
    if (response && Array.isArray(response.content)) {
        for (const block of response.content) {
            if (block && block.type === 'tool_use') {
                toolCalls.push({
                    id: block.id,
                    name: block.name,
                    arguments: block.input // Anthropic zwykle daje `input` już jako obiekt
                });
            }
        }
    }

    // 2) root response.tool_calls (wariant OpenAI bez choices)
    if (response && response.tool_calls) {
        for (const call of response.tool_calls) {
            toolCalls.push({
                id: call.id,
                name: call.function?.name ?? call.name,
                arguments: call.function?.arguments ?? call.arguments // OpenAI wysyła string
            });
        }
    }

    // 3) OpenAI/Gemini przez choices[0].message.tool_calls (najczęstsza ścieżka)
    if (response?.choices?.[0]?.message?.tool_calls) {
        const rawCalls = response.choices[0].message.tool_calls;
        for (let i = 0; i < rawCalls.length; i++) {
            const call = rawCalls[i];
            toolCalls.push({
                // AUD-testy-053: goły `Date.now()` nie wystarcza — dostawca OpenAI-shape z
                // indeksami, ale bez id (typowy artefakt mostu LM Studio/Ollama), potrafi
                // oddać 2+ tool_calls bez id w JEDNEJ odpowiedzi; pętla synchroniczna liczy
                // je w tej samej milisekundzie, więc wszystkie dostawały IDENTYCZNY fallback
                // i kolidowały ze sobą (dwa różne wyniki narzędzi pod tym samym
                // tool_call_id). Suffiks indeksu pozycji w tej odpowiedzi wystarcza do
                // unikalności w obrębie tury — format bazowy `call_<ts>` zostaje.
                id: call.id || `call_${Date.now()}_${i}`,
                name: call.function?.name || call.name,
                arguments: call.function?.arguments || call.arguments
            });
        }
    }

    // Wejście jest zawsze tablicą, więc pass-through `null|undefined` z odsklejacza nie zajdzie.
    return splitConcatenatedToolCalls(toolCalls, options.knownToolNames || [], {
        isToolKnown: options.isToolKnown
    }) as ParsedToolCall[];
}

/**
 * Rozdziela sklejone wywołania narzędzi (bug DeepSeek Reasoner):
 *   name: "minion_taskminion_task" → 2× "minion_task"
 *   args: '{"a":1}{"b":2}' → 2 osobne obiekty JSON
 *
 * Operuje na PŁASKIM kształcie `{id, name, arguments}`. Gdy nie da się rozłożyć nazwy
 * na ≥2 znane narzędzia — przepuszcza wywołanie bez zmian (fail-safe). Bez listy
 * znanych nazw (lub gdy nazwa jest znana) po prostu przepuszcza.
 *
 * Zwracany typ dopuszcza `null`/`undefined`, bo dla nie-tablicy i pustej tablicy funkcja
 * przepuszcza WEJŚCIE bez zmian (fail-safe) — a wołacze podają czasem surowe dane.
 *
 * @param toolCalls - płaskie wywołania `{id, name, arguments}`
 * @param knownToolNames - znane nazwy narzędzi (do dekompozycji)
 * @param options - `isToolKnown`: predykat „nazwa jest znana"
 */
export function splitConcatenatedToolCalls(
    toolCalls: ParsedToolCall[] | null | undefined,
    knownToolNames: string[] = [],
    options: { isToolKnown?: (name: string) => boolean } = {},
): ParsedToolCall[] | null | undefined {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return toolCalls;

    const names = Array.isArray(knownToolNames) ? knownToolNames : [];
    const isKnown = typeof options.isToolKnown === 'function'
        ? options.isToolKnown
        : (name: string) => names.includes(name);
    const sortedNames = [...names].sort((a, b) => b.length - a.length); // najdłuższe najpierw (greedy)

    const result: ParsedToolCall[] = [];
    for (const tc of toolCalls) {
        // Dostawca potrafi nie podać nazwy w ogóle — predykat i tak dostaje wtedy `undefined`
        // (zachowanie runtime bez zmian; asercja jest wyłącznie po to, żeby publiczny typ
        // predykatu został ergonomiczny dla wołaczy: `(name: string) => boolean`).
        const name = tc.name ?? tc.function?.name;

        // Nazwa jest znana → przepuść bez zmian.
        if (isKnown(name as string)) {
            result.push(tc);
            continue;
        }

        // Spróbuj rozłożyć na ≥2 znane nazwy.
        const decomposed = _decomposeToolName(name, sortedNames);
        if (!decomposed || decomposed.length < 2) {
            result.push(tc); // nie da się — przepuść (zawiedzie łagodnie przy egzekucji)
            continue;
        }

        // Rozdziel argumenty (N obiektów JSON sklejonych w jeden string).
        const argsStr = typeof tc.arguments === 'string'
            ? tc.arguments
            : JSON.stringify(tc.arguments ?? {});
        const splitArgs = _splitConcatenatedJSON(argsStr);

        for (let i = 0; i < decomposed.length; i++) {
            result.push({
                id: i === 0 ? (tc.id || `call_${Date.now()}`) : `${tc.id || 'call'}_split${i}`,
                name: decomposed[i],
                arguments: splitArgs[i] || '{}'
            });
        }
    }

    return result;
}

/**
 * Rozkłada "tool1tool2tool3" na ["tool1", "tool2", "tool3"] przez backtracking.
 * `str` jest `unknown`, bo nazwa bywa nieobecna — funkcja sama to odsiewa (`typeof`).
 *
 * @param str - sklejona nazwa
 * @param sortedNames - znane nazwy posortowane od najdłuższej (greedy match)
 * @returns tablica nazw lub null gdy brak poprawnej dekompozycji
 */
function _decomposeToolName(str: unknown, sortedNames: string[]): string[] | null {
    if (typeof str !== 'string') return null;
    if (str.length === 0) return [];
    for (const name of sortedNames) {
        if (name && str.startsWith(name)) {
            const rest = _decomposeToolName(str.slice(name.length), sortedNames);
            if (rest !== null) return [name, ...rest];
        }
    }
    return null;
}

/**
 * Rozdziela sklejone obiekty JSON: '{"a":1}{"b":2}' → ['{"a":1}', '{"b":2}'].
 * @param str - potencjalnie sklejony string JSON
 */
function _splitConcatenatedJSON(str: string): string[] {
    if (!str || typeof str !== 'string') return [str];
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < str.length; i++) {
        if (str[i] === '{') depth++;
        if (str[i] === '}') {
            depth--;
            if (depth === 0) {
                parts.push(str.slice(start, i + 1));
                start = i + 1;
            }
        }
    }
    return parts.length > 0 ? parts : [str];
}
