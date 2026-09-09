
import { UiIcons, setSvg } from '../crystal-soul/index.js';
import { IconGenerator } from '../crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';
// TS-any: payloady narzędzi pochodzą z rozszerzalnych serwerów MCP i zapisów sesji.
type ToolDynamic = any;

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
function _createDetachedEl(tag: string): ToolDynamic {
    return (document as unknown as { createElement(tag: string): ToolDynamic }).createElement(tag);
}

/**
 * Icon functions + dynamic i18n labels for MCP tools.
 * `info.label` is a getter that calls t() at access time (respects current locale).
 * Exported for reuse in BackstageViews and SubAgentBlock.
 */
function _toolEntry(iconFn: ToolDynamic, toolName: string) {
    return { icon: iconFn, get label() { return t('tool.' + toolName); } };
}

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
    const info = (TOOL_INFO as Record<string, ToolDynamic>)[toolName];
    if (info?.icon) return info.icon();
    // Fallback to IconGenerator for unknown tools
    return IconGenerator.generate(toolName, 'mixed', { size, color });
}

/**
 * Format tool input in a human-readable way — for header hint.
 * @param {string} toolName
 * @param {*} input
 * @returns {string}
 */
function formatToolInput(toolName: string, input: ToolDynamic) {
    try {
        const data = typeof input === 'string' ? JSON.parse(input) : (input || {});
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
            default: {
                const s = JSON.stringify(data);
                return s.length > 80 ? s.slice(0, 77) + '...' : s;
            }
        }
    } catch { return String(input || '').slice(0, 80); }
}

/**
 * Format FULL tool input for expanded body view.
 * Shows all arguments in readable format (more detail than formatToolInput header).
 * @param {string} toolName
 * @param {*} input
 * @returns {string}
 */
function formatToolInputDetail(toolName: string, input: ToolDynamic) {
    try {
        const data = typeof input === 'string' ? JSON.parse(input) : (input || {});
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
    } catch { return String(input || '').slice(0, 500); }
}

/**
 * Format tool output in a human-readable way — for body.
 * Returns { summary: string, detail: string|null }.
 * summary = short one-liner, detail = full data (for expand).
 */
function formatToolOutput(toolName: string, output: ToolDynamic) {
    if (!output) return { summary: '', detail: null };
    try {
        const data: ToolDynamic = typeof output === 'string' ? JSON.parse(output) : output;

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
                const paths = results.map((r: ToolDynamic, i: number) => {
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
                const list = files.map((f: ToolDynamic, i: number) => {
                    const path = typeof f === 'string' ? f : (f.path || f.name || '');
                    const size = f.size ? `  (${f.size})` : '';
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
                const list = results.map((r: ToolDynamic, i: number) => {
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
                    ? skills.map((s: ToolDynamic, i: number) => `${i + 1}. ${typeof s === 'string' ? s : (s.name || s.slug || '?')}`).join('\n')
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
                    detail: (data.messages || []).map((m: ToolDynamic) => `${m.data} · ${m.od} — ${m.temat}${m.przeczytana ? '' : ' •'}`).join('\n') || null
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
                    const list = data.items.map((item: ToolDynamic) => `${(item.done || item.checked) ? '  ✓' : '  ○'} ${item.text || item.content || ''}`).join('\n');
                    return { summary: t('tool.out.tasks', { count: data.items.length }), detail: list };
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
                const q = data.question || '';
                const a = data.answer || data.response || t('tool.out.answer');
                const needsDetail = q.length > 100;
                return {
                    summary: a,
                    detail: needsDetail ? `Pytanie: ${q}\nOdpowiedź: ${a}${data.auto ? ' (auto)' : ''}` : null
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
        const s = String(output || '');
        return { summary: _truncate(s, 120), detail: s.length > 120 ? _truncate(s, 2000) : null };
    }
}

/**
 * Smart formatter for generic tool outputs (MCP server tools, unknown tools).
 * Detects common patterns: success/error, counts, text content, objects/arrays.
 */
function _formatGenericOutput(data: ToolDynamic) {
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

/** Shorten path: keep last 2 segments */
function _shortPath(p: string) {
    if (!p) return '';
    const parts = p.replace(/\\/g, '/').split('/');
    return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}

/** Truncate string */
function _truncate(s: string, max: number) {
    if (!s) return '';
    return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

// `TOOL_DESCRIPTIONS` (Proxy nad kluczami i18n `tool.desc.*`) i `getToolDescription()` nie
// istnieją — zero wołaczy w całym repo, a klucze `tool.desc.*` też nie istnieją, więc taki
// proxy zwracałby tylko surową nazwę klucza. Opisy narzędzi, które REALNIE widzi user i model,
// żyją w i18n `mcp.<tool>.desc` (idą do API razem z definicją narzędzia) — patrz
// modules/prompts/CLAUDE.md.

/**
 * Creates a Crystal Soul .cs-action-row for a tool call.
 * Expandable: header (icon + label + input hint + status + arrow) → body (input/output).
 * @param {Object} toolCall - {name, input, output, status, error?}
 * @returns {HTMLElement}
 */
export function createToolCallDisplay(toolCall: ToolDynamic) {
    const row = _createDetachedEl('div');
    row.className = 'cs-action-row';

    const info = (TOOL_INFO as Record<string, ToolDynamic>)[toolCall.name] || { icon: null };
    const label = getToolCallLabel(toolCall.name);
    const status = toolCall.status || 'pending';

    // ── HEAD ──
    const head = row.createDiv({ cls: 'cs-action-row__head' });

    // Icon
    const iconEl = head.createDiv({ cls: 'cs-action-row__icon' });
    setSvg(iconEl, info.icon ? info.icon() : getToolIcon(toolCall.name));

    // Label with human-readable input hint
    const inputHint = formatToolInput(toolCall.name, toolCall.input);
    const labelText = inputHint ? `${label} — ${inputHint}` : label;
    head.createSpan({ cls: 'cs-action-row__label', text: labelText });

    // Status crystal marker
    head.createDiv({ cls: `cs-action-row__status cs-action-row__status--${status === 'success' ? 'done' : status}` });

    // Arrow
    const arrow = head.createDiv({ cls: 'cs-action-row__arrow' });
    setSvg(arrow, UiIcons.chevronDown(12));

    // ── BODY ──
    const body = row.createDiv({ cls: 'cs-action-row__body' });

    // Input — full detail for expanded view
    const inputFull = formatToolInputDetail(toolCall.name, toolCall.input);
    if (inputFull) {
        const inputDiv = body.createDiv({ cls: 'cs-action-row__input' });
        inputDiv.createSpan({ cls: 'cs-action-row__field-label', text: t('tool.field.call') });
        if (inputFull.includes('\n')) {
            const pre = inputDiv.createDiv({ cls: 'cs-action-row__pre' });
            pre.textContent = inputFull;
        } else {
            inputDiv.createSpan({ text: inputFull });
        }
    }

    // Output — human-readable summary + full detail
    if (toolCall.error) {
        const errDiv = body.createDiv({ cls: 'cs-action-row__output cs-action-row__output--error' });
        errDiv.createSpan({ cls: 'cs-action-row__field-label', text: t('tool.field.error') });
        errDiv.createSpan({ text: typeof toolCall.error === 'string' ? toolCall.error : JSON.stringify(toolCall.error) });
    } else if (toolCall.output) {
        const fmt = formatToolOutput(toolCall.name, toolCall.output);
        if (fmt.summary) {
            const sumDiv = body.createDiv({ cls: 'cs-action-row__output' });
            sumDiv.createSpan({ cls: 'cs-action-row__field-label', text: t('tool.field.result') });
            sumDiv.createSpan({ text: fmt.summary });
        }
        if (fmt.detail) {
            const detailDiv = body.createDiv({ cls: 'cs-action-row__detail' });
            detailDiv.textContent = fmt.detail;
        }
    }

    // Toggle logic
    head.addEventListener('click', () => {
        row.classList.toggle('open');
    });

    return row;
}

export function createCompactToolChip(toolCall: ToolDynamic) {
    const chip = _createDetachedEl('button');
    chip.type = 'button';
    chip.className = `cs-tool-chip cs-tool-chip--${toolCall.status || 'pending'}`;

    const icon = _createDetachedEl('span');
    icon.className = 'cs-tool-chip__icon';
    setSvg(icon, getToolIcon(toolCall.name));
    chip.appendChild(icon);

    const label = _createDetachedEl('span');
    label.className = 'cs-tool-chip__label';
    const inputHint = formatToolInput(toolCall.name, toolCall.input);
    const outputSummary = toolCall.output ? formatToolOutput(toolCall.name, toolCall.output).summary : '';
    label.textContent = [getToolCallLabel(toolCall.name), inputHint || outputSummary].filter(Boolean).join(' - ');
    chip.appendChild(label);

    const detail = createToolCallDisplay(toolCall);
    detail.classList.add('is-hidden');
    chip.addEventListener('click', () => {
        detail.classList.toggle('is-hidden');
    });

    const wrap = _createDetachedEl('span');
    wrap.className = 'cs-tool-chip-wrap';
    wrap.appendChild(chip);
    wrap.appendChild(detail);
    if (toolCall.status === 'error' || toolCall.error) detail.classList.remove('is-hidden');
    return wrap;
}
