import { t, getDateLocale, getLocale, pluralCategory } from '../../core/i18n/index.js';
import { UiIcons } from '../crystal-soul/index.js';
import type { ToolResultStatus } from '../../core/index.js';
import { createTile } from './Tile.js';
import type { TileSpec, TileStatus } from './Tile.js';

/** Wpis katalogu ikon per typ delegacji (kryształ statusu i kolor idą z `role`/`status` Tile'a -
 *  tu zostaje tylko dobór ikony robot/korona). */
interface TypeConfigEntry {
    iconFn: () => string;
}

const TYPE_CONFIG: Record<string, TypeConfigEntry> = {
    'delegate':         { iconFn: () => UiIcons.robot(14) },
    'delegate_master':  { iconFn: () => UiIcons.crown(14) },
    // Backward compat (old sessions)
    'minion_task':      { iconFn: () => UiIcons.robot(14) },
    'master_task':      { iconFn: () => UiIcons.crown(14) },
};

/** Jeden wpis `opts.toolCallDetails` - narzędzie wołane przez sub-agenta w trakcie zadania.
 *  Kontrakt zostaje (dane z sesji dalej go niosą), ale render kafelka go NIE czyta - spec A2
 *  ("Czat bez ścian"): żadnej listy argumentów wywołań w widoku, tylko w danych. */
export interface SubAgentToolCallDetail {
    name: string;
    args?: unknown;
}

/** Zużycie tokenów zadania sub-agenta (`opts.usage`). */
export interface SubAgentUsage {
    prompt_tokens: number;
    completion_tokens: number;
}

/** Kontrakt `createSubAgentBlock` - kształt, który realnie czyta render niżej. */
export interface SubAgentResultView {
    title: string;
    summary?: string;
    badge?: string;
    status: 'ok' | 'error';
    material?: string;
    error?: string;
    missingTargets: string[];
    effects: Array<{ tool: string; target: string; statusLabel: string }>;
    notes: string[];
    openQuestion?: string;
}

interface SubAgentBlockOptions {
    type: string;
    aspectType?: string;
    agentName?: string;
    query?: string;
    response?: string;
    toolsUsed?: string[];
    toolCallDetails?: SubAgentToolCallDetail[];
    duration?: number;
    usage?: SubAgentUsage | null;
    summary?: string;
    pending?: boolean;
    status?: ToolResultStatus;
    role?: 'agent' | 'system';
    resultView?: SubAgentResultView;
}

function appendResultView(body: HTMLElement, view: SubAgentResultView): void {
    body.classList.add('cs-subresult');
    const section = (heading: string, content: (el: HTMLElement) => void): void => {
        const group = body.createDiv({ cls: 'cs-subresult__section' });
        const title = group.createDiv();
        title.textContent = heading;
        content(group);
    };
    let material = view.material;
    if (material && view.openQuestion !== undefined) {
        for (const locale of ['pl', 'en']) {
            const runnerLine = t('subagent.question_no_answer', { question: view.openQuestion }, locale);
            const notification = t('chat.subagent_notification.question', {
                reason: t('chat.subagent_notification.question_no_answer', undefined, locale), question: view.openQuestion,
            }, locale);
            material = material.split('\n\n').map(part => {
                if (part === notification || part === runnerLine) return '';
                return part.startsWith(`${runnerLine}\n`) ? part.slice(runnerLine.length + 1) : part;
            }).filter(Boolean).join('\n\n').trim();
        }
    }
    if (material) section(t('chat.subresult.heading_created'), el => {
        const text = el.createDiv();
        text.textContent = material!;
    });
    if (view.error) section(t('chat.tile.error.title'), el => {
        const text = el.createDiv({ cls: 'cs-subresult__error' });
        text.textContent = view.error!;
    });
    if (view.missingTargets.length) section(t('chat.subresult.heading_missing'), el => {
        for (const target of view.missingTargets) {
            const line = el.createDiv();
            line.textContent = target;
        }
    });
    if (view.effects.length) section(t('chat.subresult.heading_effects'), el => {
        for (const effect of view.effects) {
            const line = el.createDiv({ cls: 'cs-subresult__effect' });
            for (const value of [effect.tool, effect.target, effect.statusLabel]) {
                const part = line.createSpan();
                part.textContent = value;
            }
        }
    });
    for (const note of view.notes) {
        const line = body.createDiv({ cls: 'cs-subresult__note' });
        line.textContent = note;
    }
    if (view.openQuestion !== undefined) {
        const question = body.createDiv({ cls: 'cs-subresult__question' });
        question.textContent = t('chat.substrip.question_open', { question: view.openQuestion });
        const note = body.createDiv({ cls: 'cs-subresult__note' });
        note.textContent = t('chat.substrip.question_resume');
    }
}

/** "12 s" / "2 min 5 s" - czas po ludzku, zaokrąglony do pełnych sekund. Ten sam wzorzec
 *  (`{{min}} min {{sec}} s` / `{{sec}} s`) w obu językach - "min"/"s" to skróty, nie słowa do
 *  tłumaczenia. */
function formatDurationHuman(ms: number): string {
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0
        ? t('chat.tile.sub.duration_min', { min: minutes, sec: seconds })
        : t('chat.tile.sub.duration_sec', { sec: seconds });
}

/** "1523" → "1,5 tys." (pl) / "1.5k" (en) od 1000 tokenów wzwyż; poniżej - liczba wprost.
 *  `toLocaleString` z `getDateLocale()` daje właściwy separator dziesiętny per język. */
function formatTokensHuman(n: number): string {
    if (n >= 1000) {
        const value = (n / 1000).toLocaleString(getDateLocale(), { maximumFractionDigits: 1 });
        return t('chat.tile.sub.tokens_thousands', { value });
    }
    return String(n);
}

/**
 * Liczebnik "wywołań"/"calls" po ludzku (uwaga 1, spec A2-fix) - `chat.tile.sub.footer_used`
 * interpoluje TYLKO gotowy tekst, sam szablon nie zna odmiany. Polska liczba mnoga: 1 ->
 * "wywołanie", 2-4 (poza 12-14) -> "wywołania", reszta -> "wywołań". Angielska: 1 -> "call",
 * reszta -> "calls". `locale` jest jawnym parametrem (nie czyta `getLocale()` sama), żeby
 * funkcja zostala czysta i testowalna tabelarycznie bez `setLocale()` w tescie.
 */
export function pluralCalls(n: number, locale: string): string {
    const keys = { one: 'chat.tile.sub.calls_one', few: 'chat.tile.sub.calls_few', many: 'chat.tile.sub.calls_many', other: 'chat.tile.sub.calls_other' };
    return t(keys[pluralCategory(n, locale)], { n }, locale);
}

/**
 * Jedna linia stopki: "Użył: read, search (3 wywołania), 12 s, 1,5 tys. tokenów" - werdykt
 * właściciela: żadnych technikaliów w NAGŁÓWKU, ale stopka w `details` śmie być techniczna.
 * Narzędzia = nazwy UNIKALNE z `toolsUsed` (surowe, jak je zna model - TOOL_INFO dałoby tu
 * przetłumaczoną etykietę, np. „Odczyt" zamiast „read", czego werdykt właściciela nie chce).
 * Liczba wywołań = `toolsUsed.length` - `AgentLoop.ts` (`modules/agent-loop/AgentLoop.ts:525`)
 * dopisuje jeden wpis PER wywołanie narzędzia, bez dedupu, więc długość tablicy = realna
 * liczba wywołań, nawet gdy to samo narzędzie poleciało kilka razy. Zwraca `undefined`, gdy nie
 * ma czego pokazać (brak narzędzi, brak czasu, brak tokenów).
 */
function buildFooterLine(opts: SubAgentBlockOptions): string | undefined {
    const toolsUsed = opts.toolsUsed || [];
    const uniqueTools = Array.from(new Set(toolsUsed));
    const hasTools = uniqueTools.length > 0;
    const hasTokens = !!(opts.usage && ((opts.usage.prompt_tokens || 0) + (opts.usage.completion_tokens || 0) > 0));
    if (!hasTools && !hasTokens && !opts.duration) return undefined;

    const parts: string[] = [];
    if (hasTools) {
        parts.push(t('chat.tile.sub.footer_used', { tools: uniqueTools.join(', '), calls: pluralCalls(toolsUsed.length, getLocale()) }));
    }
    if (opts.duration) parts.push(formatDurationHuman(opts.duration));
    if (hasTokens) {
        const sum = (opts.usage!.prompt_tokens || 0) + (opts.usage!.completion_tokens || 0);
        parts.push(t('chat.tile.sub.footer_tokens', { tokens: formatTokensHuman(sum) }));
    }
    return parts.join(', ');
}

/**
 * Details dla wyniku (sukces) albo błędu delegacji - akapit "Zadanie" (pełny `query`, bez
 * obcinania - limit żyje w danych, nie w UI), potem akapit "Wynik" (sukces) albo komunikat błędu
 * (błąd), na końcu stopka (tylko przy sukcesie - werdykt właściciela mówi o błędzie "komunikat +
 * Zadanie", bez stopki narzędzi/tokenów). `Tile.ts`'s `.cs-tile__body` jest `white-space:pre-wrap`,
 * więc podwójny `\n` między akapitami daje pustą linię separującą bez dodatkowych elementów DOM.
 */
function _buildResultDetails(opts: SubAgentBlockOptions, isError: boolean): string | undefined {
    const lines: string[] = [];
    if (opts.query) lines.push(`${t('chat.tile.sub.task_label')}: ${opts.query}`);
    if (isError) {
        // Uwaga 7 (spec A2-fix): tekst byl kluczem NARZEDZIA ("Narzedzie zglosilo blad bez
        // opisu"), myllacym dla bledu SUB-AGENTA - wlasny klucz, ta sama tresc po ludzku.
        lines.push(opts.response || t('chat.tile.sub.error_no_details'));
    } else {
        const responseText = opts.response || opts.summary || '';
        if (responseText) lines.push(`${t('chat.tile.sub.result_label')}: ${responseText}`);
        const footer = buildFooterLine(opts);
        if (footer) lines.push(footer);
    }
    return lines.length > 0 ? lines.join('\n\n') : undefined;
}

/**
 * Details dla pokwitowania delegacji w tle - skrót zadania, potem TEKST OD WOŁACZA
 * (`opts.response`), który dziś niesie ewentualną linię "W kolejce: N" i kończy się zawsze
 * linią/liniami "Identyfikator: ..." (budowane w `chat_streaming.ts`, klucz
 * `chat.tile.sub.background_id`) - identyfikator zadania idzie WYŁĄCZNIE tu, nigdy w nagłówku
 * (werdykt właściciela).
 */
function _buildBackgroundDetails(opts: SubAgentBlockOptions): string | undefined {
    const lines: string[] = [];
    if (opts.query) lines.push(`${t('chat.tile.sub.task_label')}: ${opts.query}`);
    if (opts.response) lines.push(opts.response);
    return lines.length > 0 ? lines.join('\n\n') : undefined;
}

/**
 * Buduje kafelek `.cs-tile` (rola `agent`) sub-agenta - wynik zakończonej delegacji, błąd
 * delegacji, ALBO pokwitowanie delegacji zleconej w tle (`opts.pending === true`, patrz
 * dokumentacja pola niżej). Sygnatura BEZ ZMIAN względem wersji `.cs-action-row` sprzed 2.3.0 -
 * `chat_messages.ts`/`chat_streaming.ts` wołają ją identycznie.
 *
 * @param opts.type - `'delegate'`|`'minion_task'`|`'master_task'` (aliasy wsteczne starych sesji)
 * @param opts.aspectType - `'master'` dla aspektu eksperckiego (ikona korony)
 * @param opts.agentName - nazwa aspektu/agenta (np. "czytelnik", "strateg")
 * @param opts.query - pełne zadanie zlecone subowi
 * @param opts.response - pełna odpowiedź suba (albo, przy `pending:true`, dodatkowe linie
 *   pokwitowania w tle - patrz `_buildBackgroundDetails`)
 * @param opts.toolsUsed - nazwy narzędzi użytych przez suba (NIE dedup - jeden wpis per wywołanie)
 * @param opts.toolCallDetails - log wywołań z argumentami; przyjmowany, ale NIE renderowany (dane)
 * @param opts.duration - czas trwania w ms
 * @param opts.usage - `{prompt_tokens, completion_tokens}` albo `null`
 * @param opts.pending - `true` = to NIE jest wynik, tylko pokwitowanie startu delegacji w tle
 *   (kryształ statusu pulsuje, treść w `response` to lista identyfikatorów, nie odpowiedź suba)
 * @param opts.status - `'success'|'error'` JAWNY status z wołacza (`result.success` /
 *   `toolResultStatus(...)`) - nigdy dopasowanie stringa w `response`
 */
export function createSubAgentBlock(opts: SubAgentBlockOptions): HTMLElement {
    let cfgKey = opts.type;
    if (opts.type === 'delegate' && opts.aspectType === 'master') cfgKey = 'delegate_master';
    const cfg = TYPE_CONFIG[cfgKey] || TYPE_CONFIG['delegate'];

    const name = opts.agentName || '';
    // Pokwitowanie delegacji w tle: `pending: true` jest jedynym sygnałem (dokumentowane od
    // dawna w tym module) - `response` tam niesie informację o STARCIE, nie wynik, więc traktuj
    // `status` (zawsze 'success' z wołacza w tej gałęzi) jako nieistotny dla koloru kafelka.
    const isBackground = opts.pending === true;
    const resultView = opts.resultView;
    const isError = !isBackground && (resultView?.status === 'error' || opts.status === 'error');
    const status: TileStatus = isBackground ? 'pending' : resultView?.openQuestion !== undefined ? 'attention' : (isError ? 'error' : 'ok');

    let title: string;
    let summary: string | undefined;
    let details: TileSpec['details'];

    if (resultView) {
        title = resultView.title;
        if (resultView.openQuestion !== undefined) {
            for (const locale of ['pl', 'en']) {
                const suffix = ` ${t('chat.substrip.question_no_answer_partial', undefined, locale)}`;
                if (title.endsWith(suffix)) title = title.slice(0, -suffix.length);
            }
            title = t('chat.subresult.question_result_title', { name: title });
        }
        summary = resultView.summary;
        details = (body) => appendResultView(body, resultView);
    } else if (isBackground) {
        title = t('chat.tile.sub.background', { name: name || t('subagent.label') });
        summary = t('chat.tile.sub.background_summary');
        details = _buildBackgroundDetails(opts);
    } else {
        const nameSuffix = name ? ` ${name}` : '';
        title = t('chat.tile.sub.title', { name: nameSuffix });
        // Uwaga 3 (spec A2-fix): `opts.query` odtworzony z historii bywa obiektem (task jako
        // model), nie stringiem - bez `typeof` naglowek dostawalby doslowne `[object Object]`
        // (Tile.ts's `truncatePreview`/`textContent`), ta sama bramka co reszta modulu.
        summary = typeof opts.query === 'string' ? opts.query : undefined; // Tile.ts tnie do 80 zn. sam (truncatePreview)
        details = _buildResultDetails(opts, isError);
    }

    const handle = createTile({
        role: opts.role || 'agent',
        status,
        iconSvg: cfg.iconFn(),
        title,
        summary,
        badge: resultView?.openQuestion !== undefined ? t('chat.substrip.question_no_answer') : resultView?.badge,
        expanded: resultView ? false : undefined,
        // Meta = czas po ludzku, TYLKO gdy jest i TYLKO dla wyniku (nie dla pokwitowania w tle,
        // które nie ma jeszcze żadnego czasu trwania do pokazania) - nic więcej w nagłówku,
        // tokeny NIGDY w nagłówku (werdykt właściciela).
        meta: (!isBackground && opts.duration) ? formatDurationHuman(opts.duration) : undefined,
        details,
    });
    if (resultView) handle.el.classList.add('cs-tile--subresult');
    return handle.el;
}

/**
 * Kafelek „w toku" (Faza 1, sync - zanim przyjdzie jakikolwiek wynik) - podmieniany przez
 * `chat_streaming.ts` na finalny kafelek `createSubAgentBlock(...)` po powrocie suba
 * (`toolDisplay.replaceWith(...)`, pełne przebudowanie DOM-u, ten sam wzorzec co
 * `ToolCallDisplay.ts` - `SubAgentBlock.ts` świadomie NIE trzyma `TileHandle` między wywołaniami).
 * Bez `details`/`actions` - kafelek nie jest toggleable, nic nie ma jeszcze do rozwinięcia.
 * Sygnatura BEZ ZMIAN.
 * @param type - `'delegate'`|`'minion_task'`|`'master_task'`
 * @param agentName - nazwa aspektu (może być pusta)
 */
export function createPendingSubAgentBlock(type: string, agentName: string): HTMLElement {
    const cfg = TYPE_CONFIG[type] || TYPE_CONFIG['delegate'];
    const nameSuffix = agentName ? ` ${agentName}` : '';
    const handle = createTile({
        role: 'agent',
        status: 'pending',
        iconSvg: cfg.iconFn(),
        title: t('chat.tile.sub.pending', { name: nameSuffix }),
    });
    return handle.el;
}
