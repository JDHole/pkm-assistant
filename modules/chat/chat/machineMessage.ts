/**
 * @module machineMessage
 * Klasyfikator wiadomości maszynowych (spec A3, "Czat bez ścian" 2.3.0).
 *
 * Werdykt właściciela: powiadomienie o wyniku suba z tła i przywołanie agenta po interakcji
 * z artefaktem docierają do rozmowy jako wiadomość `role: 'user'` (`send_message`/`append_message`
 * - ZERO zmian tam, treść dla MODELU zostaje identyczna), ale w OKNIE CZATU mają wyglądać inaczej
 * niż to, co napisał user: kafelek systemowy zwijalny, bez technikaliów, zamiast dymka.
 *
 * Ten plik jest CZYSTY (zero `obsidian`, zero DOM-u, zero I/O) - klasyfikacja i budowa widoku są
 * testowalne w AVA bez atrapy Obsidiana. `chat_messages.ts`/`chat_streaming.ts` wołają go i
 * renderują `createTile` z tego, co tu wraca.
 *
 * KLASYFIKACJA W DWÓCH KROKACH (deterministycznie, testowalnie):
 *   1. Meta na żywo - `addMessage()` rozlewa meta na wierzch wiadomości (`chat_messages.ts`,
 *      `RollingWindow.addMessage`), więc `msg._subTaskNotification === true` /
 *      `msg._artifactSummon === true` wystarczają, gdy wiadomość jeszcze żyje w oknie tej sesji.
 *   2. Treść (fallback) - meta NIE przeżywa zapisu sesji na dysk i restart Obsidiana
 *      (`chat_session.ts`'s `_restoredMessageMeta` niesie dalej WYŁĄCZNIE `tool_call_id`/
 *      `tool_calls`, sprawdzone czytaniem źródła). Po restarcie jedyny dowód to treść: obie
 *      wiadomości zaczynają się od STAŁEGO fragmentu nagłówka (przed pierwszym placeholderem),
 *      identycznego z tym, co naprawdę buduje `buildSubTaskNotificationText`/`buildSummonMessage`
 *      przez i18n. Fragment liczymy Z i18n (obu języków), a nie z zahardkodowanego literału - żeby
 *      zmiana tekstu nagłówka w `pl.ts`/`en.ts` nie rozjechała się cicho z klasyfikatorem.
 */
import { t } from '../../../core/i18n/index.js';
import { artifactStatusLabel } from '../../artifacts/index.js';

export type MachineKind = 'subtask_notification' | 'artifact_summon' | null;

export interface MachineViewOpen {
    label: string;
    artifactId: string;
}

export interface MachineView {
    kind: Exclude<MachineKind, null>;
    /** Po ludzku, i18n. */
    title: string;
    /** Ucinane przez Tile do 80 znaków - tu zostaje pełne, `Tile.ts` sam przycina. */
    summary: string;
    /** Pełna treść dla usera (bez stopki-instrukcji dla modelu / bez bloku JSON). */
    details: string;
    /** Tylko `artifact_summon`, i tylko gdy jest artifactId do przywołania. */
    open?: MachineViewOpen;
    /** Steruje kolorem/domyślnym rozwinięciem kafelka (`createTile`'s `status`). */
    status: 'ok' | 'error';
}

/** Kształt wiadomości, jaki realnie czyta klasyfikator - `RollingMessage` z `chat/RollingWindow.ts`
 *  i surowe transkrypty spełniają go strukturalnie (index signature akceptuje resztę pól). */
export interface MachineMessageLike {
    role: string;
    /** Opcjonalne - `RollingMessage.content` (kształt, jaki realnie przychodzi z `render_messages`/
     *  `append_message`) też jest opcjonalne, więc kontrakt musi to znosić bez rzutowania u wołacza. */
    content?: unknown;
    [key: string]: unknown;
}

const SUBTASK_HEADER_KEY = 'chat.subagent_notification.header';
const ARTIFACT_HEADER_KEY = 'artifact.summon.header';
const SUBTASK_FOOTER_KEY = 'chat.subagent_notification.footer';
// B3 fix (recenzja A3-fix): stan suba jest wyliczany z ETYKIET linii stanu
// (`status_error`/`status_aborted`), NIGDY z frazy "Zadanie się nie udało: " w treści wyniku -
// patrz `subtaskOutcome` niżej.
const SUBTASK_STATUS_ERROR_KEY = 'chat.subagent_notification.status_error';
const SUBTASK_STATUS_ABORTED_KEY = 'chat.subagent_notification.status_aborted';
// Identyfikator suba jako ostatnia linia details (uwaga 2, spec A3-fix) - reużywa i18n suba w
// tle (`SubAgentBlock.ts`'s `buildBackgroundReceiptText`), ten sam kształt "Identyfikator: {id}".
const SUBTASK_ID_LINE_KEY = 'chat.tile.sub.background_id';
const LOCALES: readonly ('pl' | 'en')[] = ['pl', 'en'];

const SENTINEL_PREFIX = '\u0000MSG_VAR_';

/**
 * Renderuje `key` z `varNames` podmienionymi na znaczniki niekolidujące z realną treścią i tnie
 * wynik na odcinki MIĘDZY kolejnymi zmiennymi (`segments[0]` = tekst przed pierwszą zmienną,
 * `segments[i]` = tekst między zmienną i-1 a i, ostatni = tekst po ostatniej zmiennej). Tak samo
 * dla `pl` i `en` - klasyfikacja/parsowanie nagłówka próbuje OBU, bo treść wiadomości mogła
 * powstać w innym języku niż bieżący `getLocale()`.
 */
function templateSegments(key: string, locale: 'pl' | 'en', varNames: string[]): string[] {
    const marker = (i: number) => `${SENTINEL_PREFIX}${i}\u0000`;
    const params: Record<string, unknown> = {};
    varNames.forEach((name, i) => { params[name] = marker(i); });
    const rendered = t(key, params, locale);

    const segments: string[] = [];
    let rest = rendered;
    for (let i = 0; i < varNames.length; i++) {
        const idx = rest.indexOf(marker(i));
        if (idx < 0) { segments.push(rest); return segments; }
        segments.push(rest.slice(0, idx));
        rest = rest.slice(idx + marker(i).length);
    }
    segments.push(rest);
    return segments;
}

/** Stały fragment nagłówka (tekst PRZED pierwszą zmienną), dla obu języków. Pusty wpis pomijany
 *  przez wołających (szablon bez tekstu przed pierwszą zmienną nie da klasyfikacji po treści). */
function headerPrefixes(key: string, firstVar: string): string[] {
    return LOCALES.map(locale => templateSegments(key, locale, [firstVar])[0] || '').filter(Boolean);
}

const SUBTASK_HEADER_PREFIXES = headerPrefixes(SUBTASK_HEADER_KEY, 'name');
const ARTIFACT_HEADER_PREFIXES = headerPrefixes(ARTIFACT_HEADER_KEY, 'tytul');

function startsWithAny(text: string, prefixes: string[]): boolean {
    return prefixes.some(p => p.length > 0 && text.startsWith(p));
}

/**
 * Klasyfikacja: meta na żywo NAJPIERW, treść (nagłówek) jako fallback po restarcie.
 * Zwykła wiadomość usera (bez meta, bez znanego nagłówka) zawsze daje `null`.
 */
export function classifyMachineMessage(msg: MachineMessageLike | null | undefined): MachineKind {
    if (!msg || msg.role !== 'user') return null;
    if (msg._subTaskNotification === true) return 'subtask_notification';
    if (msg._artifactSummon === true) return 'artifact_summon';
    // Uwaga 1 (spec A3-fix): meta ma pierwszeństwo w OBIE strony - `origin:'human'` zapisany na
    // żywo (`HUMAN_MESSAGE_META`, `chat_ui.ts`) wygrywa z fallbackiem po treści, nawet gdy
    // człowiek pisze tekst zaczynający się od tego samego stałego prefiksu nagłówka co
    // powiadomienie maszynowe (np. cytując "📄 Artefakt" w pytaniu). Fallback po treści zostaje
    // jedyną drogą TYLKO gdy `origin` w ogóle nieobecny (historia po restarcie - meta nie
    // przeżywa zapisu sesji, patrz komentarz modułu).
    if (msg.origin === 'human') return null;

    const text = typeof msg.content === 'string' ? msg.content : '';
    if (!text) return null;
    if (startsWithAny(text, SUBTASK_HEADER_PREFIXES)) return 'subtask_notification';
    if (startsWithAny(text, ARTIFACT_HEADER_PREFIXES)) return 'artifact_summon';
    return null;
}

/** Wyciąga wartość PIERWSZEJ zmiennej nagłówka (np. `name`/`tytul`) z realnej treści, próbując
 *  obu języków po kolei - zwraca `null`, gdy żaden wzorzec nie pasuje (treść spoza kontraktu). */
function extractFirstVar(text: string, key: string, varNames: string[]): string | null {
    for (const locale of LOCALES) {
        const segments = templateSegments(key, locale, varNames);
        const prefix = segments[0];
        const middle = segments[1];
        if (!prefix || !text.startsWith(prefix)) continue;
        const afterPrefix = text.slice(prefix.length);
        if (middle) {
            const endIdx = afterPrefix.indexOf(middle);
            if (endIdx >= 0) return afterPrefix.slice(0, endIdx);
        } else {
            const nl = afterPrefix.indexOf('\n');
            return nl >= 0 ? afterPrefix.slice(0, nl) : afterPrefix;
        }
    }
    return null;
}

/** Wyciąga wartość DRUGIEJ zmiennej nagłówka (`task_id`) z realnej treści - ten sam wzorzec co
 *  `extractFirstVar`, ale patrzy na odcinek MIĘDZY drugą i trzecią granicą szablonu
 *  (`segments[1]`..`segments[2]`). Używane wyłącznie dla identyfikatora suba w details (uwaga 2,
 *  spec A3-fix) - `extractFirstVar` sam nie rozszerzony, żeby nie zmieniać kontraktu jego
 *  jedynego dotychczasowego użycia (`name`/`tytul`). */
function extractSecondVar(text: string, key: string, varNames: [string, string]): string | null {
    for (const locale of LOCALES) {
        const segments = templateSegments(key, locale, varNames);
        const prefix = segments[0];
        const middle = segments[1];
        const suffix = segments[2];
        if (!prefix || !middle || !text.startsWith(prefix)) continue;
        const afterPrefix = text.slice(prefix.length);
        const midIdx = afterPrefix.indexOf(middle);
        if (midIdx < 0) continue;
        const afterMiddle = afterPrefix.slice(midIdx + middle.length);
        if (suffix) {
            const endIdx = afterMiddle.indexOf(suffix);
            if (endIdx >= 0) return afterMiddle.slice(0, endIdx);
        } else {
            const nl = afterMiddle.indexOf('\n');
            return nl >= 0 ? afterMiddle.slice(0, nl) : afterMiddle;
        }
    }
    return null;
}

/**
 * Wynik suba wg LINII STANU nagłówka (ta, którą `buildSubTaskNotificationText` buduje z
 * `status` przez `chat.subagent_notification.meta`/`meta_with_time` - `statusLine` to dokładnie
 * `firstParagraph(afterHeader)`, czyli to, co widok pokazuje jako `summary`), NIGDY z treści
 * wyniku (B3 fix, recenzja A3-fix). Stare `isSubtaskFailure` szukało frazy
 * `chat.subagent_notification.failed` (`"Zadanie się nie udało: "`) przez `.includes()` w CAŁEJ
 * treści razem z wynikiem suba - sub zakończony sukcesem, którego wynik tylko CYTOWAŁ tę frazę
 * (opisując wcześniejszą, już naprawioną awarię), dostawał fałszywy tytuł "padł w tle" i czerwony
 * kafelek. Porównanie tu jest z etykietami `status_error`/`status_aborted` (i18n, obie wersje
 * językowe) na SAMEJ linii stanu - treść wyniku nigdy nie jest oglądana.
 */
function subtaskOutcome(statusLine: string): 'error' | 'aborted' | 'done' {
    for (const locale of LOCALES) {
        const errorLabel = t(SUBTASK_STATUS_ERROR_KEY, undefined, locale);
        if (errorLabel && statusLine.includes(errorLabel)) return 'error';
    }
    for (const locale of LOCALES) {
        const abortedLabel = t(SUBTASK_STATUS_ABORTED_KEY, undefined, locale);
        if (abortedLabel && statusLine.includes(abortedLabel)) return 'aborted';
    }
    return 'done';
}

/** Uwaga 8 (spec A3-fix, kosmetyka): `details` zaczynał się zawsze od DOKŁADNIE tego samego
 *  tekstu, który już siedzi w `summary` (nagłówek Tile) - powtórzenie zaraz pod nim. Ta sama
 *  reguła kształtu co `_composeTileBody` w `ToolCallDisplay.ts` (nieeksportowana stamtąd - ten
 *  moduł nie importuje bebechów `ui-components`), tu prościej: `details` i `summary` są DWOMA
 *  osobnymi polami `MachineView` (Tile pokazuje oba naraz, summary w nagłówku, details w ciele),
 *  więc wystarczy uciąć wiodący akapit `details`, gdy jest identyczny ze `summary`. */
function stripLeadingDuplicate(details: string, summary: string): string {
    if (!summary) return details;
    const idx = details.indexOf('\n\n');
    const first = idx >= 0 ? details.slice(0, idx) : details;
    if (first !== summary) return details;
    return idx >= 0 ? details.slice(idx + 2) : '';
}

/** Pierwszy akapit tekstu (do pierwszego podwójnego znaku nowej linii - separator akapitów
 *  `buildSubTaskNotificationText`/`buildSummonMessage`). */
function firstParagraph(text: string): string {
    const idx = text.indexOf('\n\n');
    return idx >= 0 ? text.slice(0, idx) : text;
}

/** Treść powiadomienia BEZ pierwszego akapitu (nagłówek - staje się `title`) i BEZ ostatniego
 *  akapitu-instrukcji dla modelu (`chat.subagent_notification.footer`, tekst STAŁY - bez
 *  placeholderów, więc porównanie `.endsWith()` jest dokładne w obu językach). */
function subtaskDetails(text: string): { afterHeader: string; details: string } {
    const firstSplit = text.indexOf('\n\n');
    const afterHeader = firstSplit >= 0 ? text.slice(firstSplit + 2) : text;
    let details = afterHeader;
    for (const locale of LOCALES) {
        const footer = t(SUBTASK_FOOTER_KEY, undefined, locale);
        if (footer && details.endsWith(footer)) {
            details = details.slice(0, details.length - footer.length).replace(/\n\n$/, '');
            break;
        }
    }
    return { afterHeader, details: details.trim() };
}

/** Wynik parsowania bloku ```json``` z `buildSummonMessage` (kształt `formatThinState`, patrz
 *  `modules/artifacts/artifactSummon.ts`) - tylko pola, które ten widok realnie czyta. */
interface ArtifactSlimItem { text?: unknown; checked?: unknown }
interface ArtifactSlimSection { heading?: unknown; text?: unknown; items?: unknown }
interface ArtifactSlim { id?: unknown; typ?: unknown; status?: unknown; sections?: unknown }

function extractJsonBlock(text: string): ArtifactSlim | null {
    const m = text.match(/```json\n([\s\S]*?)\n```/);
    if (!m) return null;
    try {
        const parsed: unknown = JSON.parse(m[1]);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Sekcje "✓ tekst"/"○ tekst" z `parsed.sections`, BEZ JSON-a - `lines: null` gdy nie da się ich
 * zbudować (JSON uszkodzony/brak w ogóle, ALBO sekcje puste). Wołający (`buildMachineView`)
 * składa wtedy fallback PO LUDZKU z tytułu/typu/statusu (uwaga 3, spec A3-fix) - fallback NIE
 * MOŻE być surowym nagłówkiem: `stripJsonBlock(text)` (stare zachowanie) zwracał
 * `t('artifact.summon.header', ...)` w całości, czyli `id` artefaktu ORAZ frazę akcji DLA MODELU
 * ("user: zatwierdził plan") - obie rzeczy user nie ma prawa zobaczyć w widoku (zmierzone w
 * recenzji A3: `"details":"📄 Artefakt „Plan porządków\" (art-...) - user: przywołał"`).
 */
function artifactSectionLines(text: string): { lines: string | null; artifactId: string | null; typ: string | null; status: string | null } {
    const parsed = extractJsonBlock(text);
    if (!parsed) {
        return { lines: null, artifactId: null, typ: null, status: null };
    }
    const sections = Array.isArray(parsed.sections) ? (parsed.sections as ArtifactSlimSection[]) : [];
    const lines: string[] = [];
    for (const section of sections) {
        if (!section || typeof section !== 'object') continue;
        if (typeof section.heading === 'string' && section.heading) lines.push(section.heading);
        if (typeof section.text === 'string' && section.text) lines.push(section.text);
        const items = Array.isArray(section.items) ? (section.items as ArtifactSlimItem[]) : [];
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const mark = item.checked ? '✓' : '○';
            const itemText = typeof item.text === 'string' ? item.text : '';
            lines.push(`${mark} ${itemText}`);
        }
        lines.push('');
    }
    const joined = lines.join('\n').trim();
    return {
        lines: joined || null,
        artifactId: typeof parsed.id === 'string' && parsed.id ? parsed.id : null,
        typ: typeof parsed.typ === 'string' ? parsed.typ : null,
        status: typeof parsed.status === 'string' ? parsed.status : null,
    };
}

/**
 * Buduje widok kafelka dla wiadomości maszynowej. `null` gdy `msg` nie klasyfikuje się w ogóle
 * (wołający powinien sprawdzić `classifyMachineMessage` pierwej, ale funkcja jest bezpieczna
 * wywołana samodzielnie - nie zakłada, że ktoś już to zrobił).
 */
export function buildMachineView(msg: MachineMessageLike | null | undefined, ctx: { t: typeof t }): MachineView | null {
    const kind = classifyMachineMessage(msg);
    if (!kind) return null;
    const text = typeof msg?.content === 'string' ? msg.content : '';

    if (kind === 'subtask_notification') {
        const name = extractFirstVar(text, SUBTASK_HEADER_KEY, ['name', 'task_id']) || '?';
        const { afterHeader, details } = subtaskDetails(text);
        const statusLine = firstParagraph(afterHeader);
        const outcome = subtaskOutcome(statusLine);
        // B3 fix: tytuł "padł"/"przerwany" wyłącznie z linii stanu (`outcome`), nigdy z treści
        // wyniku. Uwaga 10 (kosmetyka, spec A3-fix): `aborted` dostaje WŁASNY tytuł zamiast
        // dzielić "padł w tle" z `error` - oba nadal kolorują kafelek na czerwono (status_error
        // obu, spec-a3fix.md, blok B3).
        const title = outcome === 'error'
            ? ctx.t('chat.tile.machine.subtask_title_error', { name })
            : outcome === 'aborted'
                ? ctx.t('chat.tile.machine.subtask_aborted', { name })
                : ctx.t('chat.tile.machine.subtask_title', { name });
        // Uwaga 2 (spec A3-fix): identyfikator suba jako OSTATNIA linia details - z meta na żywo
        // (`msg.subTaskId`, dopisane obok `_subTaskNotification:true` w `chat_streaming.ts`)
        // albo, po restarcie, z drugiej zmiennej nagłówka treści.
        const metaSubTaskId = msg?.subTaskId;
        const subTaskId = (typeof metaSubTaskId === 'string' && metaSubTaskId)
            || extractSecondVar(text, SUBTASK_HEADER_KEY, ['name', 'task_id'])
            || null;
        // Uwaga 8 (spec A3-fix): details nie powtarza `summary` (linia stanu) jako swój
        // pierwszy akapit - Tile już pokazuje `summary` w nagłówku.
        const dedupedDetails = stripLeadingDuplicate(details, statusLine);
        const finalDetails = subTaskId
            ? [dedupedDetails, ctx.t(SUBTASK_ID_LINE_KEY, { id: subTaskId })].filter(Boolean).join('\n')
            : dedupedDetails;
        return {
            kind,
            title,
            summary: statusLine,
            details: finalDetails,
            status: outcome === 'done' ? 'ok' : 'error',
        };
    }

    // artifact_summon
    const tytul = extractFirstVar(text, ARTIFACT_HEADER_KEY, ['tytul', 'id']) || '?';
    const title = ctx.t('chat.tile.machine.artifact_title', { tytul });
    const { lines, artifactId, typ, status } = artifactSectionLines(text);
    const statusLabel = status ? artifactStatusLabel(status) : '';
    const summaryParts = [typ, statusLabel].filter(Boolean);
    // Uwaga 3 (spec A3-fix): sekcje puste/JSON uszkodzony -> details po ludzku z tego, co da się
    // ustalić ("{tytul}, {typ}, {status}"), BEZ id i BEZ frazy akcji dla modelu; brak danych poza
    // tytułem -> details = sam tytuł.
    const details = lines ?? [tytul, typ, statusLabel].filter(Boolean).join(', ');
    const open: MachineViewOpen | undefined = artifactId
        ? { label: ctx.t('chat.tile.machine.open'), artifactId }
        : undefined;
    return {
        kind,
        title,
        summary: summaryParts.join(', '),
        details,
        open,
        status: 'ok',
    };
}
