
import { UiIcons } from '../crystal-soul/index.js';
import { IconGenerator } from '../crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
import type { UiIcon } from '../crystal-soul/index.js';
import { createTile } from './Tile.js';
import type { TileSpec, TileStatus } from './Tile.js';
// Notatki klikalne wszedzie (spec C, 2.3.0, "Czat bez scian") - wewnatrz modulu pliki importuja
// sie swobodnie (zlota zasada dotyczy TYLKO wejscia spoza modulu).
import { createNoteLink, isVaultNotePath } from './noteLink.js';

/** Karta wywołania narzędzia — kształt, który realnie czytają render-funkcje niżej. */
interface ToolCallData {
    name: string;
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
}

/** Pojedynczy wpis wyniku `search`/`vault_search`/`memory_sessions`/`memory_summaries`. */
interface ToolSearchResultItem {
    path?: string;
    score?: number;
    snippet?: string;
}

/** Pojedynczy wpis pliku z `list`/`vault_list` — sam string albo obiekt z metadanymi. */
type ToolFileEntry = string | { path?: string; name?: string; size?: string | number };

/** Pojedynczy wpis wyniku `web_search`. */
interface ToolWebResultItem {
    title?: string;
    url?: string;
    snippet?: string;
    description?: string;
}

/** Pojedynczy wpis katalogu z `skill_list` — sam string albo obiekt z nazwą/sluggiem. */
type ToolSkillEntry = string | { name?: string; slug?: string };

/** Pojedyncza wiadomość z `kom_list`. */
interface ToolKomMessageItem {
    data?: string;
    od?: string;
    temat?: string;
    przeczytana?: boolean;
}

/** Pojedynczy task z `chat_todo`/`todo`. */
interface ToolTodoItem {
    done?: boolean;
    checked?: boolean;
    text?: string;
    content?: string;
}

// Node-safe DOM shim: `ToolCallDisplay.ts` nie importuje `obsidian` i jego
// testy (`ToolCallDisplay.truncate.test.ts`, `ToolCallDisplay.searchCase.test.ts`) go wołają
// w gołym Node, podstawiając WŁASNĄ atrapę `globalThis.document.createElement` — nie globalny
// helper Obsidiana (`createDiv`/`createEl`/`createSpan`), którego w Node nie ma.
// `obsidianmd/prefer-create-el` nie da się wyłączyć inline (`obsidianmd/*` jest na liście
// `eslint-comments/no-restricted-disable`, zweryfikowane empirycznie) — więc zamiast tłumionego
// ostrzeżenia: `document` czytany LENIWIE (dopiero przy wywołaniu, nie przy imporcie modułu —
// atrapa testu podmienia go dopiero wewnątrz danego testu) i rzutowany na wąski typ, żeby
// `isDocumentType` reguły (patrzy na STRUKTURĘ typu) go nie rozpoznał. W prawdziwym Obsidianie
// to dokładnie ten sam `document.createElement`, którego wołały `createDiv`/`createEl`/`createSpan`
// pod maską — zero zmiany zachowania.
function _createDetachedEl(tag: string): HTMLElement {
    return (document as unknown as { createElement(tag: string): HTMLElement }).createElement(tag);
}

/**
 * Icon functions + dynamic i18n labels for MCP tools.
 * `info.label` is a getter that calls t() at access time (respects current locale).
 * Exported for reuse in BackstageViews and SubAgentBlock.
 */
function _toolEntry(iconFn: UiIcon, toolName: string) {
    return { icon: iconFn, get label() { return t('tool.' + toolName); } };
}

/** Kształt wpisu katalogu `TOOL_INFO` — ikona (leniwie wołana) + i18n etykieta-getter.
 *  Eksportowany: `SubAgentBlock.ts` (ten sam moduł, import bezpośredni z pliku) go potrzebuje
 *  do otypowania odczytów `TOOL_INFO[...]` katalogu narzędzi sub-agenta. */
export type ToolInfoEntry = ReturnType<typeof _toolEntry>;

export const TOOL_INFO = {
    // Prymitywy (read/list ze scope vault|memory):
    read:            _toolEntry(() => UiIcons.file(14), 'read'),
    list:            _toolEntry(() => UiIcons.folder(14), 'list'),
    write:           _toolEntry(() => UiIcons.edit(14), 'write'),
    delete:          _toolEntry(() => UiIcons.trash(14), 'delete'),
    create_folder:   _toolEntry(() => UiIcons.folder(14), 'create_folder'),
    search:          _toolEntry(() => UiIcons.search(14), 'search'),
    // Legacy vault_* (modele wołające starą nazwę):
    vault_read:      _toolEntry(() => UiIcons.file(14), 'vault_read'),
    vault_write:     _toolEntry(() => UiIcons.edit(14), 'vault_write'),
    vault_search:    _toolEntry(() => UiIcons.search(14), 'vault_search'),
    vault_list:      _toolEntry(() => UiIcons.folder(14), 'vault_list'),
    vault_delete:    _toolEntry(() => UiIcons.trash(14), 'vault_delete'),
    vault_create_folder: _toolEntry(() => UiIcons.folder(14), 'vault_create_folder'),
    memory_save:     _toolEntry(() => UiIcons.brain(14), 'memory_save'),
    memory_delete:   _toolEntry(() => UiIcons.brain(14), 'memory_delete'),
    memory_sessions: _toolEntry(() => UiIcons.brain(14), 'memory_sessions'),
    memory_summaries:_toolEntry(() => UiIcons.brain(14), 'memory_summaries'),
    memory_list_summaries: _toolEntry(() => UiIcons.brain(14), 'memory_list_summaries'),
    memory_read_summary: _toolEntry(() => UiIcons.brain(14), 'memory_read_summary'),
    skill_list:      _toolEntry(() => UiIcons.zap(14), 'skill_list'),
    skill_execute:   _toolEntry(() => UiIcons.zap(14), 'skill_execute'),
    delegate:        _toolEntry(() => UiIcons.robot(14), 'delegate'),
    connect_to_server: _toolEntry(() => UiIcons.zap(14), 'connect_to_server'),
    // Backward compat
    minion_task:     _toolEntry(() => UiIcons.robot(14), 'minion_task'),
    master_task:     _toolEntry(() => UiIcons.crown(14), 'master_task'),
    agent_message:   _toolEntry(() => UiIcons.send(14), 'agent_message'),
    agent_delegate:  _toolEntry(() => UiIcons.send(14), 'agent_delegate'),
    // Poczta agenta (kom_send/kom_list/kom_read).
    kom_send:        _toolEntry(() => UiIcons.send(14), 'kom_send'),
    kom_list:        _toolEntry(() => UiIcons.chat(14), 'kom_list'),
    kom_read:        _toolEntry(() => UiIcons.chat(14), 'kom_read'),
    chat_todo:       _toolEntry(() => UiIcons.clipboard(14), 'chat_todo'),
    idea_review:     _toolEntry(() => UiIcons.file(14), 'idea_review'),
    plan_review:     _toolEntry(() => UiIcons.file(14), 'plan_review'),
    web_search:      _toolEntry(() => UiIcons.globe(14), 'web_search'),
    web_read:        _toolEntry(() => UiIcons.globe(14), 'web_read'),
    ask_user:        _toolEntry(() => UiIcons.question(14), 'ask_user'),
    generate_image:  _toolEntry(() => UiIcons.image(14), 'generate_image'),
};

/**
 * Etykieta chipa/bloku WYWOŁANIA narzędzia (i18n `tool.<name>`), czytana dynamicznie,
 * żeby respektować aktualny język. Fallback = surowa nazwa narzędzia.
 *
 * ⚠️ Nazwa `getToolCallLabel`, nie `getToolLabel` — istnieje druga funkcja o INNEJ semantyce,
 * `getPermissionToolLabel` w `modules/agents/toolAxis.js` (etykieta osi uprawnień,
 * przestrzeń i18n `tools.label.*`). Nie mieszać przestrzeni kluczy.
 *
 * Fallback jest tu KONIECZNY: narzędzie z zewnętrznego serwera MCP (`serwer__tool`) nie ma
 * wpisu w i18n, a bez fallbacku `t()` zwracał sam klucz i czat renderował dosłowne
 * „tool.serwer__tool”. Teraz nieznane narzędzie pokazuje własną nazwę.
 *
 * @param {string} toolName
 * @returns {string}
 */
export function getToolCallLabel(toolName: string) {
    const key = 'tool.' + toolName;
    const label = t(key);
    return label === key ? toolName : label;
}

/**
 * Generate SVG icon markup for a tool (semantic UiIcons).
 * @param {string} toolName
 * @param {string} color - unused, kept for backward compat
 * @param {number} size
 * @returns {string} SVG markup
 */
export function getToolIcon(toolName: string, color = 'currentColor', size = 14) {
    const info = (TOOL_INFO as Record<string, ToolInfoEntry | undefined>)[toolName];
    if (info?.icon) return info.icon();
    // Fallback to IconGenerator for unknown tools
    return IconGenerator.generate(toolName, 'mixed', { size, color });
}

/**
 * Kształt payloadu `input` narzędzia - pola, które realnie czytają formatToolInputHint/-Detail
 * niżej. Narzędzia z zewnętrznych serwerów MCP mogą dosyłać dowolne inne pola (stąd sygnatura
 * indeksowa) — kod czyta je generycznie w gałęziach `default`.
 */
interface ToolInputPayload {
    query?: string;
    url?: string;
    path?: string;
    mode?: string;
    folder?: string;
    recursive?: boolean;
    task?: string;
    description?: string;
    server?: string;
    skill_name?: string;
    name?: string;
    to?: string;
    to_agent?: string;
    target?: string;
    agent?: string;
    id?: string;
    fact?: string;
    action?: string;
    question?: string;
    content?: string;
    limit?: number;
    section?: string;
    old_fact?: string;
    variables?: Record<string, unknown>;
    message?: string;
    reason?: string;
    options?: string[];
    [key: string]: unknown;
}

/**
 * Format tool input in a human-readable way - for header hint (pending state, before there is
 * an output yet). NIGDY nie zwraca surowego JSON-a (B2 fix, recenzja A1-fix): nierozpoznane
 * narzędzie (`generate_image`, `kom_list`, KAŻDE narzędzie z zewnętrznego serwera MCP) dawniej
 * spadało do gałęzi `default`, która zwracała `JSON.stringify(data)` - nagłówek kafelka w
 * stanie pending pokazywał wtedy dosłowny `{...}` przez cały czas wykonywania narzędzia.
 * Nierozpoznane narzędzie dostaje teraz pustą podpowiedź - nagłówek stoi na samej ikonie i
 * tytule, aż przyjdzie wynik.
 * @param {string} toolName
 * @param {*} input
 * @returns {string}
 */
function formatToolInputHint(toolName: string, input: unknown): string {
    try {
        // TS-boundary: input narzędzia to JSON zbudowany przez wołający kod (model/UI) - bez
        // walidacji schematem, dokładnie jak w wersji `any` sprzed tej fali.
        const data = (typeof input === 'string' ? JSON.parse(input) : (input || {})) as ToolInputPayload;
        switch (toolName) {
            case 'search':
            case 'vault_search':
            case 'memory_sessions':
            case 'memory_summaries':
            case 'web_search':
                return data.query || '';
            case 'web_read':
                return data.url ? data.url.replace(/^https?:\/\//, '').slice(0, 50) : '';
            case 'read':
            case 'vault_read':
                return data.path ? _shortPath(data.path) : '';
            case 'write':
            case 'vault_write':
                return data.path ? `${_shortPath(data.path)} (${data.mode || 'write'})` : '';
            case 'list':
            case 'vault_list':
                return data.path || data.folder || '/';
            case 'delete':
            case 'vault_delete':
                return data.path ? _shortPath(data.path) : '';
            case 'create_folder':
            case 'vault_create_folder':
                return data.path || '';
            case 'delegate':
                return _truncate(data.task || data.description || '', 80);
            case 'connect_to_server':
                return data.server || t('tool.in.catalog');
            case 'minion_task':
            case 'master_task':
                return _truncate(data.task || data.description || '', 80);
            case 'skill_execute':
                return data.skill_name || data.name || '';
            case 'agent_message':
            case 'agent_delegate':
            case 'kom_send':
                return data.to || data.to_agent || data.target || data.agent || '';
            case 'kom_read':
                return data.id || '';
            case 'memory_save':
                return _truncate(data.fact || '', 60);
            case 'memory_delete':
                return _truncate(data.fact || '', 60);
            case 'skill_list':
                return '';
            case 'chat_todo':
            case 'idea_review':
            case 'plan_review':
                return data.action || '';
            case 'ask_user':
                return _truncate(data.question || '', 100);
            default:
                // Nierozpoznane narzędzie - brak wzorca po ludzku, a nagłówek NIGDY nie pokazuje
                // surowego JSON-a (B2). Pusta podpowiedź, nie `JSON.stringify(data)`.
                return '';
        }
    } catch { return ''; }
}

/**
 * Format FULL tool input for expanded body view.
 * Shows all arguments in readable format (more detail than formatToolInputHint header).
 * @param {string} toolName
 * @param {*} input
 * @returns {string}
 */
function formatToolInputDetail(toolName: string, input: unknown) {
    try {
        // TS-boundary: jak w formatToolInputHint - JSON od wołającego, bez walidacji schematem.
        const data = (typeof input === 'string' ? JSON.parse(input) : (input || {})) as ToolInputPayload;
        switch (toolName) {
            case 'read':
            case 'vault_read':
                return data.path || '';
            case 'write':
            case 'vault_write': {
                let s = t('tool.in.path', { path: data.path || '?', mode: data.mode || 'write' });
                if (data.content) s += '\n' + t('tool.in.content', { content: _truncate(data.content, 800) });
                return s;
            }
            case 'search':
            case 'vault_search':
            case 'memory_sessions':
            case 'memory_summaries':
                return `"${data.query || '?'}"${data.limit ? `  (limit: ${data.limit})` : ''}`;
            case 'list':
            case 'vault_list':
                return `${data.path || data.folder || '/'}${data.recursive ? t('tool.in.recursive') : ''}`;
            case 'delete':
            case 'vault_delete':
                return data.path || '';
            case 'create_folder':
            case 'vault_create_folder':
                return t('tool.in.folder', { path: data.path || '?' });
            case 'web_search':
                return `"${data.query || '?'}"`;
            case 'web_read':
                return data.url || '?';
            case 'memory_save': {
                let s = `"${_truncate(data.fact || '?', 200)}"`;
                if (data.section) s += ` → ${data.section}`;
                if (data.old_fact) s += ` (${t('tool.in.replaces')}: "${_truncate(data.old_fact, 100)}")`;
                return s;
            }
            case 'memory_delete':
                return `"${_truncate(data.fact || '?', 200)}"`;
            case 'skill_execute': {
                let s = data.skill_name || data.name || '?';
                if (data.variables && Object.keys(data.variables).length > 0) {
                    s += t('tool.in.params', { params: Object.entries(data.variables).map(([k, v]) => `${k} = ${String(v)}`).join(', ') });
                }
                return s;
            }
            case 'delegate':
                return data.task || data.description || '';
            case 'connect_to_server':
                return data.server || t('tool.in.server_catalog');
            case 'minion_task':
            case 'master_task':
                return data.task || data.description || '';
            case 'agent_message':
            case 'kom_send':
                return t('tool.in.to', { target: data.to || data.to_agent || data.target || data.agent || '?', message: _truncate(data.message || data.content || '', 500) });
            case 'kom_read':
                return data.id || '';
            case 'agent_delegate':
                return t('tool.in.agent', { target: data.to_agent || data.target || data.agent || data.to || '?' }) + (data.reason ? t('tool.in.reason', { reason: data.reason }) : '');
            case 'chat_todo':
            case 'idea_review':
            case 'plan_review': {
                const action = data.action || '?';
                const raw = JSON.stringify(data, null, 2);
                return raw.length > 60 ? `${t('tool.out.action', { action })}\n${_truncate(raw, 500)}` : t('tool.out.action', { action });
            }
            case 'ask_user':
                return `${data.question || '?'}${data.options?.length ? `\nOpcje: ${data.options.join(', ')}` : ''}`;
            default: {
                const parts = Object.entries(data)
                    .filter(([, v]) => v !== null && v !== undefined && v !== '')
                    .map(([k, v]) => {
                        if (typeof v === 'string') return `${_friendlyKey(k)}: ${_truncate(v, 120)}`;
                        if (typeof v === 'number' || typeof v === 'boolean') return `${_friendlyKey(k)}: ${v}`;
                        return `${_friendlyKey(k)}: ${_truncate(JSON.stringify(v), 80)}`;
                    });
                return parts.join('  |  ') || JSON.stringify(data).slice(0, 120);
            }
        }
    } catch { return _fallbackToolText(input).slice(0, 500); }
}

/**
 * Kształt payloadu `output` narzędzia — pola, które realnie czytają formatToolOutput /
 * _formatGenericOutput niżej. Jak przy input: sygnatura indeksowa, bo gałęzie `default`
 * czytają pola generycznie (dowolny serwer MCP, dowolny kształt).
 */
interface ToolOutputPayload {
    success?: boolean;
    error?: string;
    message?: string;
    path?: string;
    results?: Array<ToolSearchResultItem & ToolWebResultItem>;
    count?: number;
    totalCount?: number;
    searchType?: string;
    content?: string;
    files?: ToolFileEntry[];
    entries?: ToolFileEntry[];
    already_existed?: boolean;
    title?: string;
    charCount?: number | string;
    warning?: string;
    skills?: ToolSkillEntry[];
    result?: string;
    output?: string;
    delegation?: boolean;
    target?: string;
    reason?: string;
    comments?: string;
    approved?: boolean;
    cancelled?: boolean;
    type?: string;
    userComments?: string;
    answer?: string;
    response?: string;
    auto?: boolean;
    messages?: ToolKomMessageItem[];
    unread?: number;
    od?: string;
    tresc?: string;
    items?: ToolTodoItem[];
    done?: number;
    total?: number;
    finished?: boolean;
    action?: string;
    question?: string;
    [key: string]: unknown;
}

/**
 * Format tool output in a human-readable way — for body.
 * Returns { summary: string, detail: string|null }.
 * summary = short one-liner, detail = full data (for expand).
 */
function formatToolOutput(toolName: string, output: unknown) {
    if (!output) return { summary: '', detail: null };
    try {
        // TS-boundary: wynik narzędzia to JSON zwrócony przez serwer MCP / narzędzie lokalne —
        // bez walidacji schematem, dokładnie jak w wersji `any` sprzed tej fali.
        const data = (typeof output === 'string' ? JSON.parse(output) : output) as ToolOutputPayload;

        // Handle arrays (some tools return raw arrays)
        if (Array.isArray(data)) {
            return {
                summary: t('tool.out.results', { count: data.length }),
                detail: JSON.stringify(data, null, 2)
            };
        }

        switch (toolName) {
            case 'search':
            case 'vault_search':
            case 'memory_sessions':
            case 'memory_summaries': {
                const results = data.results || [];
                const count = data.count || data.totalCount || results.length;
                const type = data.searchType || '';
                const paths = results.map((r, i) => {
                    let line = `${i + 1}. ${r.path || _shortPath(r.path)}`;
                    if (r.score != null) line += `  [${(r.score * 100).toFixed(0)}%]`;
                    if (r.snippet) line += `\n   ${_truncate(r.snippet, 200)}`;
                    return line;
                }).join('\n');
                return {
                    summary: t('tool.out.results', { count }) + (type ? ` (${type})` : ''),
                    detail: paths || null
                };
            }
            case 'read':
            case 'vault_read': {
                const content = data.content || (typeof data === 'string' ? data : '');
                const lines = content.split('\n').length;
                const chars = content.length;
                return {
                    summary: t('tool.out.lines_chars', { lines, chars }),
                    detail: _truncate(content, 2000)
                };
            }
            case 'write':
            case 'vault_write': {
                const ok = data.success !== false;
                return {
                    summary: ok ? t('tool.out.saved', { path: _shortPath(data.path || '') }) : t('tool.out.write_error'),
                    detail: data.error ? t('tool.out.error', { error: data.error }) : (data.message || null)
                };
            }
            case 'list':
            case 'vault_list': {
                const files = data.files || data.entries || [];
                const count = files.length;
                const list = files.map((f, i) => {
                    const path = typeof f === 'string' ? f : (f.path || f.name || '');
                    // TS-boundary: `.size` czytany niezależnie od kształtu (string vs obiekt) —
                    // jak w wersji `any` sprzed tej fali; rzut lokalny zamiast nowej zmiennej,
                    // żeby bundle zostały bajt-w-bajt identyczne (asercje `as` są wycinane).
                    const size = (f as { size?: string | number }).size ? `  (${(f as { size?: string | number }).size})` : '';
                    return `${i + 1}. ${path}${size}`;
                }).join('\n');
                return {
                    summary: t('tool.out.files', { count }),
                    detail: list || null
                };
            }
            case 'delete':
            case 'vault_delete':
                return {
                    summary: data.success !== false ? t('tool.out.deleted') : t('tool.out.delete_error', { error: data.error || 'usuwania' }),
                    detail: data.error || null
                };
            case 'create_folder':
            case 'vault_create_folder':
                return {
                    summary: data.success !== false
                        ? (data.already_existed ? t('tool.out.folder_exists', { path: _shortPath(data.path || '') }) : t('tool.out.created', { path: _shortPath(data.path || '') }))
                        : t('tool.out.folder_error', { error: data.error || 'tworzenia folderu' }),
                    detail: data.error || data.message || null
                };
            case 'web_search': {
                const results = data.results || [];
                const list = results.map((r, i) => {
                    let line = `${i + 1}. ${r.title || '?'}`;
                    if (r.url) line += `\n   ${r.url}`;
                    if (r.snippet || r.description) line += `\n   ${_truncate(r.snippet || r.description, 200)}`;
                    return line;
                }).join('\n');
                return {
                    summary: t('tool.out.web_results', { count: results.length }),
                    detail: list || null
                };
            }
            case 'web_read':
                return {
                    summary: data.success !== false
                        ? t('tool.out.page_chars', { title: data.title || 'Strona', count: data.charCount || '?' })
                        : t('tool.out.page_error', { error: data.error || 'odczytu strony' }),
                    detail: data.content ? _truncate(data.content, 500) : null
                };
            case 'memory_save':
                return {
                    summary: data.success !== false ? t('tool.out.memory_saved') : t('tool.out.memory_save_error'),
                    detail: data.message || data.warning || null
                };
            case 'memory_delete':
                return {
                    summary: data.success !== false ? t('tool.out.memory_deleted') : t('tool.out.memory_delete_error'),
                    detail: data.message || null
                };
            case 'skill_list': {
                const skills = data.skills || data || [];
                const list = Array.isArray(skills)
                    ? skills.map((s, i) => `${i + 1}. ${typeof s === 'string' ? s : (s.name || s.slug || '?')}`).join('\n')
                    : null;
                return {
                    summary: t('tool.out.skills', { count: Array.isArray(skills) ? skills.length : '?' }),
                    detail: list
                };
            }
            case 'skill_execute':
                return {
                    summary: data.success !== false ? t('tool.out.skill_done') : t('tool.out.skill_error'),
                    detail: _truncate(data.result || data.output || '', 1000)
                };
            case 'agent_message':
            case 'kom_send':
                return {
                    summary: data.success !== false ? t('tool.out.msg_sent') : t('tool.out.msg_error'),
                    detail: data.message || data.error || null
                };
            case 'kom_list':
                return {
                    summary: t('tool.out.kom_list', { count: data.count ?? 0, unread: data.unread ?? 0 }),
                    detail: (data.messages || []).map((m) => `${m.data} · ${m.od} — ${m.temat}${m.przeczytana ? '' : ' •'}`).join('\n') || null
                };
            case 'kom_read':
                return {
                    summary: data.success !== false ? t('tool.out.kom_read', { from: data.od || '?' }) : t('tool.out.msg_error'),
                    detail: _truncate(data.tresc || '', 1000) || null
                };
            case 'agent_delegate':
                return {
                    summary: data.delegation ? t('tool.out.delegation_to', { target: data.target || '?' }) : t('tool.out.delegation_proposal'),
                    detail: data.reason || null
                };
            case 'todo':
            case 'chat_todo': {
                if (data.items && Array.isArray(data.items)) {
                    // Uwaga 2 (spec A2-fix): `TodoTool.finish()` oddaje liste PUSTA razem z
                    // `finished:true` - licznik "0/0" nic nie mowi userowi o tym, co sie z lista
                    // stalo (werdykt wlasciciela: "po kliknieciu powinno sie pokazywac, co sie z
                    // nia stalo"). Ten przypadek dostaje wlasny, czytelny tekst zamiast "0/0" i
                    // ZANIM policzy sie total/done na pustej tablicy.
                    if (data.items.length === 0 && data.finished === true) {
                        const finishedText = t('chat.tile.todo.finished');
                        return { summary: finishedText, detail: finishedText };
                    }
                    // Naglowek = licznik "{done}/{total}" (+ tytul listy, jesli agent go podal) -
                    // spec A2 "Czat bez scian": klik ma pokazac, co sie z lista stalo (werdykt
                    // wlasciciela "Lista zadan jest tragiczna"), a CALA tresc idzie do details, nie
                    // do naglowka. `done`/`total` licz z pol wyniku narzedzia (TodoTool.ts juz je
                    // liczy z dysku), z zapasowym przeliczeniem z `items`, gdyby ktos wywolal to na
                    // starszym ksztalcie danych bez tych pol.
                    const total = typeof data.total === 'number' ? data.total : data.items.length;
                    const done = typeof data.done === 'number' ? data.done : data.items.filter((item) => item.done || item.checked).length;
                    const summary = data.title
                        ? t('chat.tile.tool.todo_summary_titled', { done, total, title: data.title })
                        : t('chat.tile.tool.todo_summary', { done, total });
                    const list = data.items.map((item) => `${(item.done || item.checked) ? '✓' : '○'} ${item.text || item.content || ''}`).join('\n');
                    return { summary, detail: list };
                }
                return { summary: data.action || t('tool.out.task_list'), detail: null };
            }
            case 'plan_review': {
                if (data.type === 'plan_review_result') {
                    if (data.approved) return { summary: t('tool.out.plan_approved'), detail: null };
                    if (data.cancelled) return { summary: t('tool.out.plan_cancelled'), detail: null };
                    return { summary: data.comments ? t('tool.out.plan_comments') : t('tool.out.plan_revision'), detail: data.comments || null };
                }
                if (data.type === 'plan_review') {
                    return { summary: t('tool.out.plan_for_review'), detail: null };
                }
                return { summary: data.action || t('tool.out.review'), detail: null };
            }
            case 'idea_review':
                return { summary: data.approved ? t('tool.out.idea_approved') : (data.action || t('tool.out.review')), detail: data.userComments || data.comments || null };
            case 'ask_user': {
                // Spec A2 ("Czat bez scian"), sekcja 3 - werdykt wlasciciela "nie rozumiem co to
                // pokazuje": naglowek pokazuje PYTANIE (summary, ucinane do 80 zn. przez Tile.ts,
                // tytul kafelka to staly tekst "Pytanie do Ciebie" z `describeToolCall`), a details
                // ZAWSZE niesie pytanie I odpowiedz razem, niezaleznie od dlugosci pytania (dawniej:
                // detail tylko gdy pytanie > 100 znakow - usuniete). Kanon ksztaltu wyniku
                // (`AskUserTool.ts`): sukces oddaje `{success:true, question, answer, auto}`,
                // porazka (odmowa/timeout/brak UI w zakladce w tle) `{success:false, error,
                // message, question}` BEZ pola `answer`.
                const q = data.question || '';
                if (data.success === false) {
                    const reason = data.message || data.error || t('tool.out.msg_error');
                    return {
                        summary: q || reason,
                        detail: q ? t('chat.tile.ask.body', { question: q, answer: reason }) : null,
                    };
                }
                const a = data.answer || data.response || t('tool.out.answer');
                return {
                    summary: q,
                    detail: t('chat.tile.ask.body', { question: q, answer: a }),
                };
            }
            default: {
                return _formatGenericOutput(data);
            }
        }
    } catch {
        // This branch needs a ceiling on `detail` too — every other branch caps its detail
        // (read/vault_read 2000, skill_execute 1000, web_read 500, generic strings 1500).
        // A non-JSON tool result (the normal shape for every external MCP server tool, via
        // normalizeMcpResult) lands here; without a cap it would put the WHOLE response into
        // the DOM node, even in the default compact-chip mode where the node is built eagerly
        // and then immediately hidden. Same cap as the read branch.
        // B3 pkt 1 (spec A2-fix): `detail` used to stay `null` whenever `s` fit inside the
        // 120-char summary cap, so a SHORT real error text (e.g. "Plik nie istnieje", an
        // external tool's own message) never reached `_buildToolDetails` - the body fell back
        // to the generic "no description" text even though there WAS a description, just a
        // short one. `detail` is now populated whenever there is ANY text at all, regardless
        // of length; `_buildToolDetails`'s error branch already prefers `detailText` over the
        // summary, so a short catch-branch message now echoes correctly in the body too.
        const s = _fallbackToolText(output);
        return { summary: _truncate(s, 120), detail: s ? _truncate(s, 2000) : null };
    }
}

/**
 * Smart formatter for generic tool outputs (MCP server tools, unknown tools).
 * Detects common patterns: success/error, counts, text content, objects/arrays.
 */
function _formatGenericOutput(data: ToolOutputPayload) {
    const isSuccess = data.success !== undefined ? data.success !== false : null;
    const error = data.error;

    // Error case
    if (error) {
        return { summary: t('tool.out.error', { error: _truncate(String(error), 100) }), detail: null };
    }

    // Build summary from key data points
    const summaryParts = [];
    if (isSuccess !== null) summaryParts.push(isSuccess ? 'OK' : t('generic.error'));

    // Detect counts
    for (const [k, v] of Object.entries(data)) {
        if (k === 'success' || k === 'error') continue;
        if (typeof v === 'number' && (k.includes('count') || k.includes('length') || k.includes('total'))) {
            summaryParts.push(`${_friendlyKey(k)}: ${v}`);
        }
        if (Array.isArray(v)) {
            summaryParts.push(`${_friendlyKey(k)}: ${v.length}`);
        }
    }

    const summary = summaryParts.length > 0 ? summaryParts.join(' · ') : t('tool.out.result');

    // Build readable detail
    const detailLines = [];
    for (const [k, v] of Object.entries(data)) {
        if (k === 'success') continue;
        if (v === null || v === undefined || v === '') continue;

        if (typeof v === 'string') {
            if (v.length > 200 || v.includes('\n')) {
                detailLines.push(`── ${_friendlyKey(k)} ──\n${_truncate(v, 1500)}`);
            } else {
                detailLines.push(`${_friendlyKey(k)}: ${v}`);
            }
        } else if (typeof v === 'number' || typeof v === 'boolean') {
            detailLines.push(`${_friendlyKey(k)}: ${v}`);
        } else if (Array.isArray(v)) {
            if (v.length === 0) {
                detailLines.push(`${_friendlyKey(k)}: ${t('tool.out.empty_list')}`);
            } else if (typeof v[0] === 'string') {
                detailLines.push(`${_friendlyKey(k)}:\n${v.map((item, i) => `  ${i + 1}. ${item}`).join('\n')}`);
            } else {
                detailLines.push(`${_friendlyKey(k)}: ${t('tool.out.elements', { count: v.length })}`);
            }
        } else if (typeof v === 'object') {
            const entries = Object.entries(v);
            if (entries.length <= 8) {
                const lines = entries.map(([sk, sv]) =>
                    `  ${_friendlyKey(sk)}: ${typeof sv === 'string' ? _truncate(sv, 120) : sv}`
                );
                detailLines.push(`${_friendlyKey(k)}:\n${lines.join('\n')}`);
            } else {
                detailLines.push(`${_friendlyKey(k)}: ${t('tool.out.fields', { count: entries.length })}`);
            }
        }
    }

    return {
        summary,
        detail: detailLines.length > 0 ? detailLines.join('\n\n') : null
    };
}

/** Convert snake_case/camelCase key to friendly label */
function _friendlyKey(key: string) {
    return key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/**
 * Ostatnia deska ratunku, gdy `input`/`output` narzędzia (JSON od modelu/UI, bez walidacji
 * schematem) nie da się rozebrać w `try` - pokazujemy surowiec zamiast pustki. Osobna funkcja
 * graniczna: dopiero jej wywołanie resetuje zawężenie TS z powrotem do gołego `unknown`, więc
 * `String()` tutaj nie zgłasza no-base-to-string (ten sam wzorzec co `_safeStringify`
 * w `core/utils/errorUtils.ts`).
 */
function _fallbackToolText(value: unknown): string {
    return value ? _rawToString(value) : '';
}

function _rawToString(value: unknown): string {
    return String(value);
}

/** Shorten path: keep last 2 segments */
function _shortPath(p: string | undefined) {
    if (!p) return '';
    const parts = p.replace(/\\/g, '/').split('/');
    return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}

/** Truncate string */
function _truncate(s: string | undefined, max: number) {
    if (!s) return '';
    return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

// `TOOL_DESCRIPTIONS` (Proxy nad kluczami i18n `tool.desc.*`) i `getToolDescription()` nie
// istnieją — zero wołaczy w całym repo, a klucze `tool.desc.*` też nie istnieją, więc taki
// proxy zwracałby tylko surową nazwę klucza. Opisy narzędzi, które REALNIE widzi user i model,
// żyją w i18n `mcp.<tool>.desc` (idą do API razem z definicją narzędzia) — patrz
// modules/prompts/CLAUDE.md.

/**
 * Tytuł kafelka narzędzia PO LUDZKU — bez id wywołania, bez surowej nazwy narzędzia (poza
 * gałęzią `default`, gdzie surowa nazwa jest jedyną informacją, jaką w ogóle mamy) i bez JSON-a.
 * Teksty przez i18n (`chat.tile.tool.*`, pl+en, bez em/en dash) — `describeToolCall` sam tylko
 * rozpoznaje narzędzie i wyciąga z inputu pojedyncze pole do interpolacji.
 *
 * Nazwy narzędzi tu użyte są PRAWDZIWYMI nazwami z `modules/tools/` (rejestr + `toolAliases.ts`):
 * `read`/`vault_read`, `search`/`vault_search` (+ `memory_sessions`/`memory_summaries` - search-owe
 * aliasy pamięci, ta sama grupa co w `formatToolInputHint` niżej), `write`/`vault_write`,
 * `list`/`vault_list`, `web_search`, `web_read`, `todo`/`chat_todo`, `ask_user`. Nie ma w repo
 * narzędzi `ls`/`list_files`/`memory_search` - nie wymyślamy nazw, których rejestr nie zna.
 *
 * TOTALNA funkcja (B1 fix, recenzja A1-fix): input narzędzia to JSON od modelu/UI bez walidacji
 * schematem, więc pole może przyjść w dowolnym kształcie (`path` jako tablica, `url` jako liczba,
 * cały input jako string `"null"` - `JSON.parse('null') === null`, więc `data` samo bywa `null`,
 * nie tylko `{}`). Każde pole przechodzi przez `typeof === 'string'` (inaczej pomijane - tytuł
 * wraca bez tej wartości, nigdy nie wybucha), a zewnętrzny `try/catch` jest pasem zapasowym: PRZED
 * naprawą crashowała tu cała tura czatu (`AgentLoop.ts`, brak try) i render historii
 * (`chat_messages.ts`, pętla bez try) na dokładnie takim wejściu.
 * @param {string} name
 * @param {*} input
 * @returns {string}
 */
export function describeToolCall(name: string, input: unknown): string {
    try {
        let data: ToolInputPayload | null;
        try {
            data = (typeof input === 'string' ? JSON.parse(input) : (input || {})) as ToolInputPayload;
        } catch {
            data = {};
        }
        const path = typeof data?.path === 'string' ? data.path : undefined;
        const query = typeof data?.query === 'string' ? data.query : undefined;
        const folder = typeof data?.folder === 'string' ? data.folder : undefined;
        const url = typeof data?.url === 'string' ? data.url : undefined;
        switch (name) {
            case 'read':
            case 'vault_read':
                return t('chat.tile.tool.read', { path: path ? _shortPath(path) : '' });
            case 'search':
            case 'vault_search':
            case 'memory_sessions':
            case 'memory_summaries':
                return t('chat.tile.tool.search', { query: query || '' });
            case 'write':
            case 'vault_write':
                return t('chat.tile.tool.write', { path: path ? _shortPath(path) : '' });
            case 'list':
            case 'vault_list':
                return t('chat.tile.tool.list', { folder: path || folder || '/' });
            case 'web_search':
                return t('chat.tile.tool.web_search', { query: query || '' });
            case 'web_read':
                return t('chat.tile.tool.web_read', { url: url ? url.replace(/^https?:\/\//, '') : '' });
            case 'todo':
            case 'chat_todo':
                return t('chat.tile.tool.todo');
            case 'ask_user':
                return t('chat.tile.tool.ask_user');
            default:
                return t('chat.tile.tool.generic', { name: getToolCallLabel(name) });
        }
    } catch {
        return t('chat.tile.tool.generic', { name: getToolCallLabel(name) });
    }
}

/** Dzisiejsze statusy wołaczy (`'pending'|'success'|'error'`, patrz `toolResultStatus` w `core/`)
 *  na trójkę `TileStatus` Tile'a. Nierozpoznana/pusta wartość = `pending` (fail-soft, nigdy
 *  nie wybucha na nieznanym stringu z zewnętrznego serwera MCP). */
function _toTileStatus(rawStatus: string | undefined): TileStatus {
    if (rawStatus === 'success' || rawStatus === 'ok') return 'ok';
    if (rawStatus === 'error') return 'error';
    return 'pending';
}

/**
 * `JSON.stringify` bezpieczny na wejściach, na których goły `JSON.stringify` rzuca (B1 fix,
 * recenzja A3-fix - `_coerceToText` obiecywał "nigdy wyjątek", ale nie dotrzymywał tego na
 * cyklu ani na BigIncie w obiekcie): replacer zamienia `bigint` na `String(v)` (JSON nie zna
 * tego typu - rzuca `TypeError: Do not know how to serialize a BigInt` bez tego) i wykrywa
 * cykl przez `WeakSet` (`'[cykl]'` zamiast `TypeError: Converting circular structure to
 * JSON`). Całość w `try/catch` - gdyby coś inne w łańcuchu i tak rzuciło, fallback jest lista
 * kluczy obiektu (a nie samego obiektu - `Object.keys` też może rzucić na egzotycznym Proxy,
 * stąd DRUGI, wewnętrzny `try/catch`), nigdy pusty string na milczącym wyjątku. Wzór jak
 * `_safeStringify` w `core/utils/errorUtils.ts` (ten sam kształt, tu dodatkowo replacer
 * BigInt - errorUtils go nie potrzebuje, bo błędy API nie niosą BigIntów).
 */
function _safeStringify(value: unknown, limit: number): string {
    const seen = new WeakSet<object>();
    try {
        const json = JSON.stringify(value, (_key, v: unknown) => {
            if (typeof v === 'bigint') return String(v);
            if (v && typeof v === 'object') {
                if (seen.has(v)) return '[cykl]';
                seen.add(v);
            }
            return v;
        });
        return _truncate(json ?? _rawToString(value), limit);
    } catch {
        try {
            return _truncate(Object.keys(value as object).join(', '), limit);
        } catch {
            return '';
        }
    }
}

/**
 * Ujednolica pole na string, ZANIM cokolwiek je skleja (regula nadrzedna szczegolow kafelka,
 * spec A2-fix - decyzja prowadzacego, zastepuje "details zawsze zaczynaja sie od summary"; B2
 * fix: `TypeError` na nie-stringowym `fmt.detail`/`fmt.summary`, np. `kom_send` z `message`
 * obiektem, `idea_review` z `comments` tablica, `todo` z polem-obiektem). String bez zmian;
 * `null`/`undefined` -> `''`; tablica -> KAŻDY element rekurencyjnie przez `_coerceToText`,
 * `join('\n')` (B1 fix, recenzja A3-fix: dawne `value.join('\n')` gołe wołało `String(obj)` na
 * elementach-obiektach, czyli dokładnie `[object Object]` - tablica obiektów, np. `idea_review`'s
 * `comments: [{text:'...'}]` z zewnętrznego serwera MCP albo modelu, jest realna); obiekt ->
 * `_safeStringify` (nigdy wyjątek, patrz wyżej); reszta (liczba, bool, bigint, symbol...) ->
 * `String(x)`. Nigdy `[object Object]`, nigdy wyjątek.
 */
function _coerceToText(value: unknown, limit = 2000): string {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    if (Array.isArray(value)) return value.map(v => _coerceToText(v, limit)).join('\n');
    if (typeof value === 'object') return _safeStringify(value, limit);
    // `_rawToString` (definiowana nizej w tym pliku dla `_fallbackToolText`) resetuje zawezenie
    // TS z powrotem do golego `unknown` - `no-base-to-string` nie umie wywnioskowac, ze w tym
    // miejscu `value` jest juz PRYMITYWEM (liczba/bool/bigint/symbol), nie obiektem.
    return _rawToString(value);
}

/**
 * Sklada cialo kafelka z JUZ ustringowionych `summaryText`/`detailText` (regula nadrzedna,
 * spec A2-fix). `detailText` w calosci, gdy ZAWIERA `summaryText` (`.includes()`, nie
 * `.startsWith()` - decyzja prowadzacego: B1 fix, `ask_user`'s detail ZAWSZE niesie pytanie w
 * srodku szablonu "Pytanie: {q}\nOdpowiedz: {a}", wiec ten jeden generyczny check usuwa
 * podwojne pytanie bez kodu specyficznego dla `ask_user`) albo gdy `summaryText` jest puste;
 * inaczej oba, oddzielone pusta linia; gdy `detailText` puste: samo `summaryText`.
 */
function _composeTileBody(summaryText: string, detailText: string): string {
    if (!detailText) return summaryText;
    // Uciete summary ("..." albo "&" na koncu) porownujemy po rdzeniu, inaczej detail dublowalby tresc.
    const core = summaryText.replace(/(\.\.\.|\u2026)$/u, '');
    if (!summaryText || detailText.includes(core)) return detailText;
    return `${summaryText}\n\n${detailText}`;
}

/**
 * Ciało kafelka - sukces: `_composeTileBody(summaryText, detailText)` wyzej (regula nadrzedna).
 * Ciało - błąd Z polem `toolCall.error` (już zamaskowany u źródła): komunikat wprost, bez zmian
 * - Z WYJĄTKIEM `ask_user` (B1 fix, sciezka HISTORII): `chat_messages.ts` odtwarza nieudane
 * `ask_user` z historii jako `error: tcOutput.error` (kod typu "ask_user.timeout") - dawniej ten
 * surowy kod leciał wprost do usera. `toolCall.output` w tej gałęzi nadal niesie `question`
 * (kanon `AskUserTool.ts`: porażka oddaje `{success:false, error, message, question}`), więc
 * kafelek dostaje ten sam szablon "Pytanie/Odpowiedz" co żywa ścieżka, z kodem błędu zmapowanym
 * przez i18n na tekst po ludzku (`ask_user.timeout` -> `chat.tile.ask.timeout`, inny kod ->
 * `chat.tile.ask.failed`).
 * Błąd BEZ pola `toolCall.error` (np. `{success:false}`): `detailText` w całości, jeśli jest;
 * inaczej `summaryText` W CAŁOŚCI, ale TYLKO gdy DŁUŻSZE niż 80 znaków (nagłówek go i tak ucina,
 * `Tile.ts`) - krótki, GENERYCZNY label bez realnej treści (np. "Send error" z `kom_send`, gdzie
 * `data.message`/`data.error` są oba puste) zostaje przy `error_no_details` niżej. Krótka, ale
 * REALNA treść (np. "Plik nie istnieje" z zewnętrznego narzędzia, złapana w
 * `formatToolOutput`'s catch branch) trafia tu jako `detailText` już od źródła - ten branch
 * populuje `detail` ZAWSZE, gdy jest jakikolwiek tekst (B3 pkt 1, spec A2-fix - patrz komentarz
 * tam), więc próg 80 znaków dotyczy dziś WYŁĄCZNIE syntetycznych etykiet bez realnej treści.
 * Surowe argumenty wejścia (`formatToolInputDetail`) dokładane WYŁĄCZNIE gdy `includeRawArgs`
 * (pełna karta, nie chip kompaktowy) - jako sekcja „Szczegóły techniczne" w natywnym `<details>`,
 * domyślnie zwinięta niezależnie od stanu kafelka. Pusty wejściowy `input` (brak pola w ogóle) NIE
 * dostaje sekcji technicznej - `toolCall.input != null` jest bramką; `formatToolInputDetail`'s
 * gałąź `default` zwraca `'{}'` dla PUSTEGO OBIEKTU (`input:{}`), co jest innym przypadkiem -
 * `input:{}` DOSTAJE sekcję techniczną (niepusty argument, po prostu bez pól).
 */
/** `JSON.parse` bezpieczny (string albo juz-obiekt) do samego celu wyciagania sciezek notatek -
 *  osobny, malutki parser zamiast reuzywania wnetrza `formatToolOutput` (ktora nie eksponuje
 *  sparsowanych danych na zewnatrz), zeby nie ruszac jej dobrze przetestowanej sciezki. */
function _parseOutputForLinks(output: unknown): Record<string, unknown> | null {
    try {
        const data = (typeof output === 'string' ? JSON.parse(output) : output) as Record<string, unknown>;
        return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch {
        return null;
    }
}

/**
 * Sciezki notatek do pokazania jako klikalne linki NAD dotychczasowa trescia kafelka (spec C,
 * "Czat bez scian" 2.3.0): `read`/`vault_read` (jeden plik - sciezka z wyniku, zapasowo z
 * argumentow wejscia), `search`/`vault_search`/`memory_sessions`/`memory_summaries` (kazdy
 * wynik z polem `path`), `list`/`vault_list` (pozycje bedace notatkami - foldery i pliki spoza
 * `isVaultNotePath` zostaja WYLACZNIE tekstem w dotychczasowej liscie, bez linku). Blad narzedzia
 * -> pusta tablica (wolacz nie dokleja sekcji linkow do komunikatu bledu).
 */
function _extractNoteLinkPaths(toolCall: ToolCallData): string[] {
    if (toolCall.error) return [];
    const data = _parseOutputForLinks(toolCall.output);
    switch (toolCall.name) {
        case 'read':
        case 'vault_read': {
            const outPath = data && typeof data.path === 'string' ? data.path : '';
            const inp = toolCall.input as { path?: unknown } | undefined;
            const inPath = typeof inp?.path === 'string' ? inp.path : '';
            const path = outPath || inPath;
            return path && isVaultNotePath(path) ? [path] : [];
        }
        case 'search':
        case 'vault_search':
        case 'memory_sessions':
        case 'memory_summaries': {
            const results = data && Array.isArray(data.results) ? (data.results as Array<{ path?: unknown }>) : [];
            return results
                .map(r => (typeof r?.path === 'string' ? r.path : ''))
                .filter((p): p is string => !!p && isVaultNotePath(p));
        }
        case 'list':
        case 'vault_list': {
            const rawFiles = data ? (data.files ?? data.entries) : undefined;
            const files = Array.isArray(rawFiles) ? (rawFiles as ToolFileEntry[]) : [];
            return files
                .map(f => (typeof f === 'string' ? f : (f?.path || f?.name || '')))
                .filter((p): p is string => typeof p === 'string' && isVaultNotePath(p));
        }
        default:
            return [];
    }
}

/** Sekcja linkow notatek NAD dotychczasowa trescia kafelka - jedna linia na sciezke, przez
 *  `createNoteLink` (jeden mechanizm otwierania w calym repo, spec C). */
function _appendNoteLinksSection(body: HTMLElement, paths: string[]): void {
    const wrap = _createDetachedEl('div');
    wrap.className = 'cs-tile__note-links';
    for (const path of paths) {
        const line = _createDetachedEl('div');
        line.className = 'cs-tile__note-link-line';
        createNoteLink(line, path);
        wrap.appendChild(line);
    }
    body.appendChild(wrap);
}

function _buildToolDetails(toolCall: ToolCallData, includeRawArgs: boolean): TileSpec['details'] {
    if (toolCall.error) {
        if (toolCall.name === 'ask_user') {
            const out = toolCall.output as { question?: unknown } | undefined;
            const q = typeof out?.question === 'string' ? out.question : '';
            if (q) {
                const code = typeof toolCall.error === 'string' ? toolCall.error : '';
                const reason = code === 'ask_user.timeout' ? t('chat.tile.ask.timeout') : t('chat.tile.ask.failed');
                return t('chat.tile.ask.body', { question: q, answer: reason });
            }
        }
        return typeof toolCall.error === 'string' ? toolCall.error : JSON.stringify(toolCall.error);
    }
    const isError = toolCall.status === 'error';
    const fmt = toolCall.output ? formatToolOutput(toolCall.name, toolCall.output) : null;
    const summaryText = _coerceToText(fmt?.summary);
    const detailText = _coerceToText(fmt?.detail);
    let bodyText: string;
    if (isError) {
        bodyText = detailText || (summaryText.length > 80 ? summaryText : '');
    } else {
        bodyText = _composeTileBody(summaryText, detailText);
    }
    if (!bodyText && isError) {
        bodyText = t('chat.tile.tool.error_no_details');
    }
    const rawArgsText = (includeRawArgs && toolCall.input != null)
        ? (formatToolInputDetail(toolCall.name, toolCall.input) || '')
        : '';
    const notePaths = isError ? [] : _extractNoteLinkPaths(toolCall);

    if (!bodyText && !rawArgsText && notePaths.length === 0) return undefined;
    if (!rawArgsText && notePaths.length === 0) return bodyText || undefined;

    return (body: HTMLElement) => {
        if (notePaths.length > 0) {
            _appendNoteLinksSection(body, notePaths);
        }
        if (bodyText) {
            const pre = _createDetachedEl('div');
            pre.className = 'cs-tile__pre';
            pre.textContent = bodyText;
            body.appendChild(pre);
        }
        if (!rawArgsText) return;
        const rawBlock = _createDetachedEl('details');
        rawBlock.className = 'cs-tile__raw-args';
        const summaryEl = _createDetachedEl('summary');
        summaryEl.textContent = t('chat.tile.raw_args');
        rawBlock.appendChild(summaryEl);
        const pre2 = _createDetachedEl('pre');
        pre2.textContent = rawArgsText;
        rawBlock.appendChild(pre2);
        body.appendChild(rawBlock);
    };
}

/**
 * Kafelek `agent-muted` wspólny dla `createToolCallDisplay` i `createCompactToolChip` — jedyna
 * różnica między pełną kartą i chipem kompaktowym jest `includeRawArgs` (patrz `_buildToolDetails`).
 * Aktualizacje w trakcie streamingu (pending → ok/error) idą przez PEŁNE PRZEBUDOWANIE:
 * `chat_streaming.ts` woła `toolDisplay.replaceWith(createCompactToolChip({...nowy status}))` —
 * nie ma tu mutacji istniejącego `TileHandle` w locie, więc `createToolCallDisplay`/
 * `createCompactToolChip` świadomie zwracają goły `HTMLElement`, nie `TileHandle` (wybór opisany
 * w `CLAUDE.md` tego modułu, sekcja Tile).
 */
function _buildToolTile(toolCall: ToolCallData, opts: { includeRawArgs: boolean }): HTMLElement {
    const isError = !!toolCall.error || toolCall.status === 'error';
    const status: TileStatus = isError ? 'error' : _toTileStatus(toolCall.status);
    // Skrót obok tytułu: wynik, gdy już jest (po ludzku, przez formatToolOutput); w trakcie
    // wykonywania (jeszcze bez output) - hint wejścia (formatToolInputHint), żeby kafelek w
    // stanie pending nie stał pusty. Zero surowych argumentów JSON w żadnej z dwóch gałęzi -
    // naprawione (B2, recenzja A1-fix): `formatToolInputHint` dla nierozpoznanego narzędzia
    // zwraca '', nigdy `JSON.stringify` jak dawny `formatToolInput`.
    // Błąd BEZ pola `toolCall.error` (np. `{success:false}`): nagłówek zostaje przy summary z
    // wyniku zamiast gasnąć do pustki (B5) - błąd Z polem `error` blankuje summary, bo jego
    // treść i tak trafia w całości do `_buildToolDetails` niżej.
    const rawSummary = (isError && toolCall.error)
        ? undefined
        : (toolCall.output
            ? formatToolOutput(toolCall.name, toolCall.output).summary
            : (formatToolInputHint(toolCall.name, toolCall.input) || undefined));
    // Porzadki po A1, punkt 3: kilka galezi `formatToolInputHint`/`formatToolOutput` oddaje pole
    // wprost jako `data.xxx || ''` bez `typeof` (np. `search`'s `data.query || ''`) - narzedzie z
    // zewnetrznego serwera MCP moze podac to pole jako obiekt (`{length:100}`), nie string. Bez
    // tej bramki taki obiekt lecialby do `createTile`'s `summary`, a `Tile.ts`'s
    // `truncatePreview`/`textContent` przypisanie zamienialoby go w doslowne `[object Object]` w
    // naglowku. JEDNA linia typeof na wyjsciu `_buildToolTile` chroni WSZYSTKIE galezie naraz,
    // zamiast utwardzac kazdy `switch` z osobna.
    const summary = typeof rawSummary === 'string' ? rawSummary : undefined;

    const handle = createTile({
        role: 'agent-muted',
        status,
        iconSvg: getToolIcon(toolCall.name),
        title: describeToolCall(toolCall.name, toolCall.input),
        summary: summary || undefined,
        details: _buildToolDetails(toolCall, opts.includeRawArgs),
    });
    return handle.el;
}

/**
 * Pełna karta wywołania narzędzia — kafelek `.cs-tile` przez `createTile` (rola `agent-muted`).
 * Nagłówek: ikona + tytuł po ludzku (`describeToolCall`) + skrót wyniku + kropka statusu.
 * Ciało (rozwijane): sformatowany wynik + (tylko tu, nie w chipie) surowe argumenty w
 * zwiniętej sekcji „Szczegóły techniczne".
 * @param {Object} toolCall - {name, input, output, status, error?}
 * @returns {HTMLElement}
 */
export function createToolCallDisplay(toolCall: ToolCallData): HTMLElement {
    return _buildToolTile(toolCall, { includeRawArgs: true });
}

/**
 * Chip kompaktowy — TEN SAM kafelek co `createToolCallDisplay`, bez surowych argumentów wejścia
 * w ciele, opakowany w `span.cs-tool-chip-wrap` (zgodność wsteczna: TYLKO jego test,
 * `render_messages.emptyAssistant.test.ts`, szuka tej klasy - `chat_messages.ts` sam jej nie
 * czyta; poprawka nieścisłości, B3 pkt 4 spec A2-fix).
 * @param {Object} toolCall - {name, input, output, status, error?}
 * @returns {HTMLElement}
 */
export function createCompactToolChip(toolCall: ToolCallData): HTMLElement {
    const tile = _buildToolTile(toolCall, { includeRawArgs: false });
    const wrap = _createDetachedEl('span');
    wrap.className = 'cs-tool-chip-wrap';
    wrap.appendChild(tile);
    return wrap;
}
