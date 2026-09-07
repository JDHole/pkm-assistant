/**
 * toolAliases — wsteczna kompatybilność nazw narzędzi (E2.5 + E2.6).
 *
 * E2.5: 12 narzędzi retrieval → jedno `search`.
 * E2.6: prymitywy plikowe bez prefixów ze scope w parametrze:
 *   vault_read → read, vault_list → list, vault_write → write, vault_delete → delete,
 *   vault_create_folder → create_folder, memory_read → read{scope:memory},
 *   memory_read_summary → read{scope:memory, path:summaries/…}, memory_list_summaries → list{scope:memory}.
 *
 * Modele mają nawyki (wołają starą nazwę), a userowe YAML-e sub-agentów trzymają stare
 * nazwy w `tools`. Nie łamiemy tego twardo — mapujemy stare wywołanie na kanoniczne
 * narzędzie z przekształceniem argumentów. Wpięte w `MCPClient.executeToolCall`: gdy nazwa
 * nieznana w registry a jest aliasem → przemapuj i wykonaj, do wyniku doklej krótką notę.
 *
 * Czysty moduł-liść (bez zależności od reszty mcp) — jedyny importer to
 * `MCPClient.executeToolCall` (zweryfikowane grepem po całym repo, fabryka kasacji martwego
 * kodu S1, 2026-09-02). `ToolRegistry.ts` i `built-in-servers/artifacts/index.ts` wspominają
 * ten plik tylko w KOMENTARZACH, bez importu — nie mylić z realnym wołaczem.
 * `modules/sub-agents/SubAgentLoader.ts` ma WŁASNY, ODDZIELNY mechanizm rename'u
 * (`DEPRECATED_TOOL_RENAMES`, lokalna stała) — nie importuje stąd nic.
 */

/**
 * Argumenty wywołania narzędzia — worek od modelu / z YAML-a sub-agenta, więc wartości
 * są `unknown` i zawężamy je dopiero tam, gdzie kod faktycznie coś z nimi robi.
 */
type ToolArgs = Record<string, unknown>;

/** Wynik przemapowania starej nazwy na kanoniczne narzędzie. */
interface ToolAliasResult {
    name: string;
    arguments: ToolArgs;
}

/**
 * Element listy w starym `chat_todo` / kroków w `plan_review`: goły string ALBO obiekt
 * z jednym z trzech pól tekstowych (tak wyglądały tamte inputSchema).
 */
interface LegacyLabeledItem {
    text?: string;
    action?: string;
    label?: string;
}

/** Usuwa puste/undefined pola z obiektu `where`. */
function cleanWhere(where: ToolArgs): ToolArgs {
    const out: ToolArgs = {};
    for (const [k, v] of Object.entries(where)) {
        if (v === undefined || v === null || v === '') continue;
        if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
        out[k] = v;
    }
    return out;
}

/**
 * Mapa: stara nazwa narzędzia → funkcja przekształcająca argumenty na wywołanie `search`.
 * Czyta oryginalne nazwy argumentów (pattern/filter/from/to/level) — działa niezależnie
 * od `MCPClient.normalizeArgsAliases` (który tylko DODAJE kanoniczne pola, nie usuwa).
 */
export const SEARCH_ALIASES: Record<string, (a: ToolArgs) => ToolArgs> = {
    vault_search: (a) => ({ query: a.query, ...(a.folder ? { where: { folder: a.folder } } : {}) }),
    vault_grep: (a) => ({ query: a.pattern ?? a.query, mode: 'keyword', where: cleanWhere({ folder: a.folder, glob: a.glob }) }),
    vault_semantic: (a) => ({ query: a.query, mode: 'semantic', where: cleanWhere({ folder: a.folder }) }),
    vault_glob: (a) => ({ where: cleanWhere({ glob: a.pattern ?? a.glob }) }),
    vault_filter_yaml: (a) => ({ where: cleanWhere({ yaml: a.filter, folder: a.folder }) }),
    vault_links: (a) => ({ where: cleanWhere({ links_from: a.from, links_to: a.to }) }),
    memory_filter_yaml: (a) => ({ scope: 'memory', where: cleanWhere({ yaml: a.filter }) }),
    memory_grep: (a) => ({ query: a.pattern ?? a.query, mode: 'keyword', scope: 'memory' }),
    memory_semantic: (a) => ({ query: a.query, mode: 'semantic', scope: 'memory' }),
    memory_links: (a) => ({ scope: 'memory', where: cleanWhere({ links_from: a.from, links_to: a.to }) }),
    memory_sessions: (a) => ({ query: a.query, scope: 'memory', where: { folder: 'sessions' } }),
    memory_summaries: (a) => ({
        query: a.query,
        scope: 'memory',
        where: { folder: (a.level && a.level !== 'all') ? `summaries/${a.level as string}` : 'summaries' }
    }),
};

/** Nazwa narzędzia zastąpiona przez `search`? (alias wstecznej kompatybilności) */
export function isSearchAlias(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(SEARCH_ALIASES, name);
}

/**
 * Przemapuj wywołanie starego narzędzia na wywołanie `search`.
 * @param name - stara nazwa narzędzia
 * @param args - argumenty starego wywołania
 * @returns null gdy nazwa nie jest aliasem
 */
export function resolveSearchAlias(name: string, args: ToolArgs = {}): ToolAliasResult | null {
    const fn = SEARCH_ALIASES[name];
    if (!fn) return null;
    const mapped = fn(args || {}) || {};
    if (mapped.where && Object.keys(mapped.where).length === 0) delete mapped.where;
    return { name: 'search', arguments: mapped };
}

/**
 * Mapa E2.6: stara nazwa prymitywu plikowego → { name, arguments } dla kanonicznego narzędzia.
 * Renamey vault_* są argumentowo 1:1 (przepuszczamy args). memory_* dostają scope:'memory'
 * i (dla summary) budują ścieżkę pamięci `summaries/<level>/<filename>`.
 */
export const PRIMITIVE_ALIASES: Record<string, (a: ToolArgs) => ToolAliasResult> = {
    vault_read: (a) => ({ name: 'read', arguments: { ...a } }),
    vault_list: (a) => ({ name: 'list', arguments: { ...a } }),
    vault_write: (a) => ({ name: 'write', arguments: { ...a } }),
    vault_delete: (a) => ({ name: 'delete', arguments: { ...a } }),
    vault_create_folder: (a) => ({ name: 'create_folder', arguments: { ...a } }),
    memory_read: (a) => ({ name: 'read', arguments: cleanWhere({ path: a.filename ?? a.path, scope: 'memory' }) }),
    memory_read_summary: (a) => ({ name: 'read', arguments: { path: `summaries/${a.level as string}/${a.filename as string}`, scope: 'memory' } }),
    memory_list_summaries: (a) => ({
        name: 'list',
        arguments: cleanWhere({
            folder: (a.level && a.level !== 'all') ? `summaries/${a.level as string}` : 'summaries',
            scope: 'memory'
        })
    }),
};

/** Nazwa narzędzia przemianowana na prymityw E2.6? */
export function isPrimitiveAlias(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(PRIMITIVE_ALIASES, name);
}

/**
 * Mapa E2.9 FAZA D: stare narzędzia artefaktów → nowy świat.
 *  - `chat_todo` (gatunek 1 stary) → `todo` (gatunek 2), z mapowaniem akcji.
 *  - `plan_review {markdown|steps}` → `artifact_create {typ:'plan'}` (kroki jako add_item na sekcji Kroki).
 *  - `idea_review {markdown}` → `artifact_create {typ:'notatka'}` (treść jako set_section Treść).
 */

/** Wyłuskaj kroki z markdownu (wzór starego extractPlanSteps): numerowane / checkboxy / bullety. */
function splitStepsFromMarkdown(markdown: string = ''): string[] {
    const steps: string[] = [];
    for (const line of String(markdown || '').split('\n')) {
        const trimmed = line.trim();
        const numbered = trimmed.match(/^\d+[.)]\s+(.+)/);
        const checkbox = trimmed.match(/^[-*]\s+\[[ xX]\]\s+(.+)/);
        const bullet = trimmed.match(/^[-*]\s+(.+)/);
        const text = numbered?.[1] || checkbox?.[1] || bullet?.[1];
        if (text) steps.push(text.replace(/\*\*/g, '').trim());
    }
    return steps;
}

/** chat_todo{action,...} → todo{action,...}: update→check/uncheck (blockId z item_index), list/remove→list. */
function chatTodoToTodo(a: ToolArgs = {}): ToolAliasResult {
    const action = a.action;
    if (action === 'create') {
        const items = (Array.isArray(a.items) ? a.items as Array<string | LegacyLabeledItem | null> : [])
            .map(it => (typeof it === 'string' ? it : (it && (it.text || it.action || it.label)) || ''))
            .filter(Boolean);
        return { name: 'todo', arguments: cleanWhere({ action: 'create', items, title: a.title }) };
    }
    if (action === 'add_item') {
        return { name: 'todo', arguments: cleanWhere({ action: 'add', text: a.text }) };
    }
    if (action === 'update') {
        const idx = Number(a.item_index);
        const blockId = Number.isFinite(idx) ? `k${idx + 1}` : undefined;
        const checked = a.done === true || a.status === 'done';
        return { name: 'todo', arguments: cleanWhere({ action: checked ? 'check' : 'uncheck', blockId }) };
    }
    // remove_item / list — todo nie ma remove; zwracamy bieżący stan (read-only 'list').
    return { name: 'todo', arguments: { action: 'list' } };
}

/** plan_review → artifact_create{typ:'plan'} — kroki z steps albo z markdownu. */
function planReviewToArtifact(a: ToolArgs = {}): ToolAliasResult {
    const steps = (Array.isArray(a.steps) && a.steps.length)
        ? (a.steps as Array<string | LegacyLabeledItem | null>).map(s => (typeof s === 'string' ? s : (s && (s.action || s.text || s.label)) || '')).filter(Boolean)
        : splitStepsFromMarkdown((a.markdown as string) || '');
    const sekcje = steps.map(text => ({ op: 'add_item', heading: 'Kroki', text }));
    return { name: 'artifact_create', arguments: cleanWhere({ typ: 'plan', tytul: a.title || 'Plan', sekcje }) };
}

/** idea_review → artifact_create{typ:'notatka'} — treść jako set_section „Treść". */
function ideaReviewToArtifact(a: ToolArgs = {}): ToolAliasResult {
    const md = (a.markdown as string) || '';
    const sekcje = md ? [{ op: 'set_section', heading: 'Treść', text: md }] : [];
    return { name: 'artifact_create', arguments: cleanWhere({ typ: 'notatka', tytul: a.title || 'Notatka', sekcje }) };
}

export const ARTIFACT_ALIASES: Record<string, (a: ToolArgs) => ToolAliasResult> = {
    chat_todo: chatTodoToTodo,
    plan_review: planReviewToArtifact,
    idea_review: ideaReviewToArtifact,
};

/** Nazwa narzędzia zastąpiona w E2.9 FAZA D (chat_todo/plan_review/idea_review)? */
export function isArtifactAlias(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(ARTIFACT_ALIASES, name);
}

/** Dowolny alias wstecznej kompatybilności (search E2.5 / prymityw E2.6 / artefakt E2.9 D). */
export function isToolAlias(name: string): boolean {
    return isSearchAlias(name) || isPrimitiveAlias(name) || isArtifactAlias(name);
}

/**
 * Przemapuj wywołanie starej nazwy na kanoniczne narzędzie (search / read / list / write / …).
 * @param name - stara nazwa narzędzia
 * @param args - argumenty starego wywołania
 * @returns null gdy nazwa nie jest aliasem
 */
export function resolveToolAlias(name: string, args: ToolArgs = {}): ToolAliasResult | null {
    if (isSearchAlias(name)) return resolveSearchAlias(name, args);
    if (isArtifactAlias(name)) return ARTIFACT_ALIASES[name](args || {});
    const fn = PRIMITIVE_ALIASES[name];
    if (!fn) return null;
    return fn(args || {});
}
