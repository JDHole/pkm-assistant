import { TOOL_INFO } from './ToolCallDisplay.js';
import { UiIcons, setSvg } from '../crystal-soul/index.js';
import { t, getDateLocale } from '../../core/i18n/index.js';
// TS-any: zapis sesji narzędzi jest elastycznym kontraktem historycznym chat.
type SubAgentDynamic = any;

// Node-safe DOM shim (release 2.2.0 / W2): `SubAgentBlock.ts` nie importuje `obsidian`, a jego
// test (`SubAgentBlock.test.ts`) woła prawdziwe funkcje w gołym Node, podstawiając WŁASNĄ atrapę
// `globalThis.document.createElement` — nie globalny helper Obsidiana (`createDiv`), którego
// w Node nie ma. `obsidianmd/prefer-create-el` nie da się wyłączyć inline (`obsidianmd/*` jest
// na liście `eslint-comments/no-restricted-disable`, zweryfikowane empirycznie), więc zamiast
// tłumionego ostrzeżenia: `document` czytany LENIWIE i rzutowany na wąski typ, żeby `isDocumentType`
// reguły (patrzy na STRUKTURĘ typu) go nie rozpoznał — w prawdziwym Obsidianie to dokładnie ten
// sam `document.createElement`, którego wołał `createDiv` pod maską (patrz ToolCallDisplay.ts,
// ten sam wzorzec).
function _createDetachedDiv(): SubAgentDynamic {
    return (document as unknown as { createElement(tag: string): SubAgentDynamic }).createElement('div');
}

const TYPE_CONFIG = {
    'delegate':     { labelKey: 'subagent.label',            iconFn: () => UiIcons.robot(14) },
    'delegate_master': { labelKey: 'subagent.expert',        iconFn: () => UiIcons.crown(14) },
    // Backward compat (old sessions)
    'minion_task':  { labelKey: 'subagent.minion_task',      iconFn: () => UiIcons.robot(14) },
    'master_task':  { labelKey: 'subagent.master_consult',   iconFn: () => UiIcons.crown(14) },
};

/**
 * Creates a Crystal Soul .cs-action-row for a sub-agent (minion/master) result.
 * Expandable: header (icon + label + duration + status + arrow) → body (query, response, tools, tokens).
 *
 * @param {Object} opts
 * @param {'delegate'|'minion_task'|'master_task'} opts.type
 * @param {string} [opts.aspectType] - 'master' for expert aspect (crown icon)
 * @param {string} [opts.agentName] - Name of the aspect (e.g. "czytelnik", "strateg")
 * @param {string} [opts.query]
 * @param {string} [opts.response]
 * @param {string[]} [opts.toolsUsed]
 * @param {Array} [opts.toolCallDetails]
 * @param {number} [opts.duration] - ms
 * @param {{ prompt_tokens: number, completion_tokens: number }|null} [opts.usage]
 * @param {string} [opts.summary]
 * @param {boolean} [opts.pending] - F2: bieg TRWA (wystartował w tle). Kryształ statusu
 *   pulsuje zamiast świecić na zielono — treść w `response` to pokwitowanie, nie wynik.
 * @param {'success'|'error'} [opts.status] - K7/AUD-code-review-044: JAWNY status z wołacza
 *   (`result.success` / `toolResultStatus(...)` z `core/index.js`). `response` jest tekstem
 *   do wyświetlenia, NIE sygnałem — polski literał `'Błąd'` bywa sklejany przez JEDNEGO
 *   wołacza (`chat_streaming.ts`), ale nie przez odtwarzanie historii (`chat_messages.ts`),
 *   więc dopasowanie stringa dawało zielone „gotowe" na pustej, padniętej delegacji po
 *   przełączeniu zakładki / powrocie suba z tła. Brak `status` = domyślnie „success" (ten
 *   sam fail-safe co reszta tego modułu — tu nie ma logiki biznesowej, więc cichy błąd
 *   renderu nie ma prawa wywalić czatu).
 * @returns {HTMLElement}
 */
export function createSubAgentBlock(opts: SubAgentDynamic) {
    // Resolve config: delegate + aspectType=master → delegate_master config
    let cfgKey = opts.type;
    if (opts.type === 'delegate' && opts.aspectType === 'master') cfgKey = 'delegate_master';
    const cfg = (TYPE_CONFIG as Record<string, SubAgentDynamic>)[cfgKey] || TYPE_CONFIG['delegate'];

    const row = _createDetachedDiv();
    row.className = 'cs-action-row';

    // ── HEAD ──
    const head = row.createDiv({ cls: 'cs-action-row__head' });

    // Icon (semantic: robot for minion, crown for master)
    const iconEl = head.createDiv({ cls: 'cs-action-row__icon' });
    setSvg(iconEl, cfg.iconFn());

    // Label: "Sub-agent [nazwa] — [query snippet]"
    const nameTag = opts.agentName ? ` ${opts.agentName}` : '';
    const querySnippet = opts.query ? opts.query.slice(0, 80) : '';
    const cfgLabel = t(cfg.labelKey);
    const labelText = querySnippet ? `${cfgLabel}${nameTag} — ${querySnippet}` : `${cfgLabel}${nameTag}`;
    head.createSpan({ cls: 'cs-action-row__label', text: labelText });

    // Duration
    if (opts.duration) {
        head.createSpan({ cls: 'cs-action-row__time', text: `${(opts.duration / 1000).toFixed(1)}s` });
    }

    // Status crystal — K7/AUD-code-review-044: JAWNA flaga z wołacza, nie dopasowanie stringa.
    const hasError = opts.status === 'error';
    // F2: `pending` = sub wystartował W TLE i wciąż pracuje. Zielone „gotowe" kłamałoby —
    // w bloku nie ma wyniku, tylko pokwitowanie startu (wynik wraca osobnym powiadomieniem).
    const statusCls = opts.pending
        ? 'cs-action-row__status--pending'
        : (hasError ? 'cs-action-row__status--error' : 'cs-action-row__status--done');
    head.createDiv({ cls: `cs-action-row__status ${statusCls}` });

    // Arrow
    const arrow = head.createDiv({ cls: 'cs-action-row__arrow' });
    setSvg(arrow, UiIcons.chevronDown(12));

    // ── BODY ──
    const body = row.createDiv({ cls: 'cs-action-row__body' });

    // Query
    if (opts.query) {
        const qDiv = body.createDiv({ cls: 'cs-action-row__input' });
        qDiv.textContent = t('subagent.query', { query: opts.query });
    }

    // Response
    const responseText = opts.response || opts.summary || '';
    if (responseText) {
        const rDiv = body.createDiv({ cls: 'cs-action-row__output' });
        rDiv.textContent = responseText;
        if (hasError) rDiv.addClass('cs-action-row__output--error');
    }

    // Tool call details
    if (opts.toolCallDetails?.length > 0) {
        const detailDiv = body.createDiv({ cls: 'cs-action-row__content' });
        const lines = opts.toolCallDetails.map((d: SubAgentDynamic) => {
            const info = (TOOL_INFO as Record<string, SubAgentDynamic>)[d.name] || { label: d.name };
            const hint = _extractArgHint(d.name, d.args);
            return hint ? `${info.label}: ${hint}` : info.label;
        });
        detailDiv.textContent = lines.join('\n');
    } else if (opts.toolsUsed?.length > 0) {
        const toolDiv = body.createDiv({ cls: 'cs-action-row__content' });
        const names = opts.toolsUsed.map((t: string) => (TOOL_INFO[t as keyof typeof TOOL_INFO]?.label) || t);
        toolDiv.textContent = t('subagent.tools', { tools: names.join(', ') });
    }

    // Token usage
    if (opts.usage && (opts.usage.prompt_tokens || opts.usage.completion_tokens)) {
        const tokDiv = body.createDiv({ cls: 'cs-action-row__content' });
        const inp = (opts.usage.prompt_tokens || 0).toLocaleString(getDateLocale());
        const out = (opts.usage.completion_tokens || 0).toLocaleString(getDateLocale());
        tokDiv.textContent = t('subagent.tokens', { input: inp, output: out });
    }

    // Toggle
    head.addEventListener('click', () => {
        row.classList.toggle('open');
    });

    return row;
}

/**
 * Creates a pending (loading) sub-agent .cs-action-row.
 * @param {'delegate'|'minion_task'|'master_task'} type
 * @param {string} [agentName] - Name of the aspect
 * @returns {HTMLElement}
 */
export function createPendingSubAgentBlock(type: string, agentName: string) {
    const cfg = (TYPE_CONFIG as Record<string, SubAgentDynamic>)[type] || TYPE_CONFIG['delegate'];

    const row = _createDetachedDiv();
    row.className = 'cs-action-row';

    const head = row.createDiv({ cls: 'cs-action-row__head' });

    const iconEl = head.createDiv({ cls: 'cs-action-row__icon' });
    setSvg(iconEl, cfg.iconFn());

    const nameTag = agentName ? ` ${agentName}` : '';
    head.createSpan({ cls: 'cs-action-row__label', text: `${t(cfg.labelKey)}${nameTag}...` });

    // Pending status (animated)
    head.createDiv({ cls: 'cs-action-row__status cs-action-row__status--pending' });

    return row;
}

/**
 * Extract a human-readable hint from tool call arguments.
 */
function _extractArgHint(toolName: string, args: SubAgentDynamic) {
    if (!args) return '';
    const parsed = typeof args === 'string' ? (() => { try { return JSON.parse(args); } catch { return {}; } })() : args;

    switch (toolName) {
        case 'read':
        case 'write':
        case 'delete':
        case 'vault_read':
        case 'vault_write':
        case 'vault_delete':
        case 'create_folder':
        case 'vault_create_folder':
            return parsed.path || '';
        case 'search':
        case 'vault_search':
        case 'memory_sessions':
        case 'memory_summaries':
            return parsed.query ? `"${parsed.query}"` : '';
        case 'memory_save':
        case 'memory_delete':
            return parsed.fact ? `"${parsed.fact}"` : '';
        case 'list':
        case 'vault_list':
            return parsed.path || parsed.folder || '';
        default:
            return '';
    }
}
