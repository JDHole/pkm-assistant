/**
 * activeSessionFormat.js - JEDNO ŹRÓDŁO kontraktu pliku `sessions/active/<agent>_*.md`.
 *
 * Plik aktywnej sesji ma DWÓCH pisarzy o nieprzystających formatach:
 *
 *  - **format A (event-log)** - `AgentMemory.appendToActiveSession` → `formatSessionEvent()`:
 *    DOPISUJE blok `## <ISO> - <typ zdarzenia>` + pola `**content:**` / `**tool:**` / `**args:**` /
 *    `**result:**` / `**model:**` / `**tokens:**` / `**duration_ms:**` / `**role:**` /
 *    `**prompt:**` / `**seq:**` (pełna lista i kolejność: `EVENT_FIELDS`).
 *    Niesie telemetrię narzędzi, której transkrypt nie ma.
 *  - **format B (transkrypt)** - `sessionParser.formatToMarkdown`: nagłówki `## User` /
 *    `## Assistant` / `## System` / `## Tool`. To format `sessions/archive/`
 *    i draftów, a NIE pliku active.
 *
 * ⚠️ **Pisarzem pliku active jest TYLKO event-log (A).** `saveSession` nie
 * nadpisuje pliku transkryptem - DOPISUJE brakujący ogon jako eventy, a transkrypt powstaje
 * dopiero przy archiwizacji (`archiveActiveSession` konwertuje event-log → format B).
 *
 * Czytnik `parseActiveSession()` mimo to zostaje NA ZAWSZE trójformatowy (A + B + MIESZANY):
 * u userów leżą pliki zrobione starą sekwencją (append × N → autozapis nadpisywał
 * transkryptem → dalsze appendy), a te muszą się czytać do końca świata. Dlatego klasyfikuje
 * KAŻDY blok `## ` osobno, zamiast wybierać jeden parser na cały plik.
 *
 * **Dlaczego ten plik istnieje:** kontrakt był rozsmarowany po trzech miejscach
 * (`AgentMemory._formatSessionEvent`, `sessionParser.formatToMarkdown`,
 * `AgentMemory._parseActiveSessionFile`) i nikt go nie pilnował testem. Brak takiego testu
 * pozwolił przeżyć utratę rozmowy usera przy hotfiksie bez pokrycia testowego.
 *
 * Test kontraktowy: `activeSessionFormat.test.js` (round-trip `formatSessionEvent` →
 * `parseActiveSession`, plik mieszany, wsteczna zgodność z legacy event-logiem bez escapów).
 */

/**
 * Wersja kontraktu event-logu (format A). Bump TYLKO gdy zmienia się kształt bloku
 * (nagłówek, nazwy pól, sposób escapowania) w sposób, którego `parseActiveSession`
 * nie czyta identycznie jak dotąd.
 *
 * v1: nagłówek `## <ISO> - <typ>`, pola `**<label>:**` + pusta linia
 * + treść, treść pól escapowana przez `escapeActiveText`.
 * v2: doszło pole `**seq:**` (numer zdarzenia w pliku) + escapowanie linii
 * treści, które są etykietą znanego pola (`\**result:**`).
 *
 * ⚠️ Nie jest zapisywana do pliku - pliki usera sprzed v2 nie mają żadnego znacznika
 * wersji, a czytnik musi rozumieć je NA ZAWSZE: **v2 czyta v1 i legacy
 * identycznie jak dotąd.** Stała jest jawną kotwicą kontraktu w kodzie.
 */
export const ACTIVE_SESSION_FORMAT_VERSION = 2;

/**
 * Rola wiadomości uznawana przez format sesji za granicę bloku (`## Rola`).
 * Zbiór jest zamknięty CELOWO: parser bez whitelisty brał każdy nagłówek
 * `## X` z treści za nową wiadomość, a API odrzuca nieznane role.
 */
export type SessionRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * Nazwa pola bloku event-logu (format A). Kolejność zapisu trzyma `EVENT_FIELDS`.
 */
export type EventFieldName =
    | 'content'
    | 'tool'
    | 'args'
    | 'result'
    | 'model'
    | 'tokens'
    | 'duration_ms'
    | 'role'
    | 'prompt'
    | 'seq';

/**
 * Surowe zdarzenie podawane pisarzowi A (`formatSessionEvent`).
 *
 * Wartości są WIELOKSZTAŁTNE z premedytacją: wołacze wrzucają stringi (`content`,
 * `result`), obiekty (`args` narzędzia) i liczby (`duration_ms`, `tokens`). Pisarz
 * robi `JSON.stringify` wszystkiemu, co nie jest stringiem - poza `seq`, które MUSI
 * być skończoną liczbą (inaczej pole nie powstaje). Pola spoza `EVENT_FIELDS` są
 * po cichu ignorowane; index signature odwzorowuje to, że wołacze podają całe
 * obiekty zdarzeń (`{ ...event, seq }` w testach kontraktowych).
 */
export type SessionEvent = {
    [K in Exclude<EventFieldName, 'seq'>]?: unknown;
} & {
    seq?: number;
    [key: string]: unknown;
};

/**
 * Jedna wiadomość odzyskana z pliku sesji. `seq` = numer ZDARZENIA z pola `**seq:**`
 * albo `null` (wiadomość transkryptowa / blok legacy sprzed numeracji).
 */
export interface ActiveSessionMessage {
    role: SessionRole;
    content: string;
    seq: number | null;
}

/**
 * Frontmatter pliku sesji po sparsowaniu. Wartości są WIELOKSZTAŁTNE, bo taki jest
 * plik na dysku: skalary (`created`, `agent`, `covered_by_l1`), booleany/null po
 * `JSON.parse`, oraz listy `- item` zbierane do tablicy stringów.
 */
export type SessionFrontmatter = Record<string, string | number | boolean | null | string[]>;

/** Wynik czytania pliku aktywnej sesji (kanon formatu). */
export interface ParsedActiveSession {
    messages: ActiveSessionMessage[];
    metadata: SessionFrontmatter;
    summary: string | null;
}

/**
 * Role, które format sesji traktuje jako granice wiadomości (nagłówki `## Rola`).
 * Wspólne dla OBU czytników (`parseActiveSession` tu, `parseSessionFile` w `sessionParser.js`),
 * żeby nie rozjechały się w czasie.
 *
 * Parser BEZ whitelisty brał KAŻDY nagłówek `## X` z TREŚCI wiadomości
 * (np. sekcję "## Wyniki" w odpowiedzi agenta) za nową wiadomość z rolą "wyniki"
 * - a API odrzuca nieznane role (DeepSeek: "unknown variant 'wyniki'").
 */
export const KNOWN_ROLES = new Set<string>(['system', 'user', 'assistant', 'tool']);

/**
 * Nazwy pól event-logu, w kolejności zapisu. Nagłówek bloku jest granicą wiadomości,
 * pola są jego zawartością.
 *
 * To jest JEDNA lista dla trzech rzeczy: (1) kolejność pól w `formatSessionEvent`,
 * (2) escapowanie linii treści, które udają etykietę pola, (3) lookahead kończący pole
 * w `extractEventField`. Rozjazd między nimi = ucięta treść, więc żadnej kopii.
 */
export const EVENT_FIELDS: EventFieldName[] = [
    'content',
    'tool',
    'args',
    'result',
    'model',
    'tokens',
    'duration_ms',
    'role',
    'prompt',
    'seq',
];

/** Alternatywa regexowa ze znanych etykiet - składana RAZ. */
const FIELD_LABELS_ALT = EVENT_FIELDS.join('|');

/**
 * Linia będąca DOKŁADNIE etykietą znanego pola (`**result:**`, z opcjonalnymi spacjami
 * na końcu). Tylko taka linia jest granicą pola w bloku eventu, więc tylko taką
 * escapujemy - `**result:** coś jeszcze` w treści nic nie psuje.
 */
const FIELD_LABEL_LINE_RE = new RegExp(
    `(^|\\n)(\\*\\*(?:${FIELD_LABELS_ALT}):\\*\\*[ \\t]*)(?=\\n|$)`,
    'g',
);

/** Lustro `FIELD_LABEL_LINE_RE` dla treści już zescapowanej (`\\**result:**`). */
const ESCAPED_FIELD_LABEL_LINE_RE = new RegExp(
    `(^|\\n)\\\\(\\*\\*(?:${FIELD_LABELS_ALT}):\\*\\*[ \\t]*)(?=\\n|$)`,
    'g',
);

/**
 * Lookahead kończący pole: NASTĘPNA etykieta ZNANEGO pola stojąca sama w linii.
 * Zawężenie do znanych etykiet ma skutek uboczny na plikach legacy:
 * nieznana bold-etykieta w treści (np. `**Uwaga:**`) PRZESTAJE ucinać pole. To poprawa.
 */
const FIELD_END_LOOKAHEAD = `(?=\\n\\*\\*(?:${FIELD_LABELS_ALT}):\\*\\*[ \\t]*(?:\\n|$)|\\s*$)`;

/**
 * Escapuje linie, które w pliku sesji wyglądałyby jak granica wiadomości.
 * `\## ` renderuje się w Markdown jako zwykłe "## ", a `unescapeActiveText` to odkręca.
 *
 * ⚠️ ZNANA, ŚWIADOMA NIEDOSKONAŁOŚĆ: schemat nie escapuje samego backslasha, więc treść
 * z LITERALNYM `\## ` na początku linii wróci z odczytu jako `## `. Naprawa wymagałaby zmiany
 * formatu po stronie pisarza B (i tym samym odczytu starych plików).
 *
 */
export function escapeActiveText(text: unknown): string {
    return String(text ?? '').replace(/(^|\n)## /g, '$1\\## ');
}

/**
 * Odwrotność `escapeActiveText`. Na treści bez escapów to no-op (dlatego wolno ją
 * puszczać także na LEGACY blokach event-logu, które nigdy nie były escapowane).
 */
export function unescapeActiveText(text: unknown): string {
    return String(text ?? '').replace(/(^|\n)\\## /g, '$1## ');
}

/**
 * Escape treści JEDNEGO pola eventu: najpierw granice bloku (`## `), potem linie, które
 * są dokładnie etykietą znanego pola (`**result:**` → `\**result:**`).
 *
 * Ta druga rzecz to domknięcie dziury bliźniaczej do `## `:
 * wynik narzędzia zawierający linię `**result:**` UCINAŁ pole przy odczycie, bo lookahead
 * `extractEventField` brał ją za początek następnego pola.
 */
export function escapeEventFieldText(text: unknown): string {
    return escapeActiveText(text).replace(FIELD_LABEL_LINE_RE, '$1\\$2');
}

/**
 * Odwrotność części „etykiety pól" z `escapeEventFieldText`. Osobno od
 * `unescapeActiveText`, bo kolejność odkręcania musi być odwrotna do escapowania:
 * pisarz robi (`## ` → etykiety), czytnik (etykiety → `## `).
 * Na treści bez escapów to no-op (legacy bloki), jak cała para.
 */
export function unescapeEventFieldLabels(text: unknown): string {
    return String(text ?? '').replace(ESCAPED_FIELD_LABEL_LINE_RE, '$1$2');
}

/**
 * Formatuje JEDEN blok event-logu (format A).
 *
 * Treść KAŻDEGO pola (po ewentualnym `JSON.stringify`) przechodzi przez
 * `escapeEventFieldText`, więc żadna treść nie może udawać ani granicy bloku (`## `),
 * ani granicy pola (`**result:**`). Bez tego `## User` w cytowanym tekście rozbijał
 * wiadomość na dwie, a linia `**result:**` ucinała pole.
 *
 * Nagłówek (`## <ISO> - <typ>`) NIE jest escapowany - to nasza własna, kontrolowana linia,
 * a `type` pochodzi z kodu (nie od usera ani modelu). `seq` też NIE przechodzi przez escape:
 * to nasza liczba, nie treść.
 *
 * @param type - typ zdarzenia (`user_message`, `agent_message`, `mcp_call`, ...)
 * @param event - surowe zdarzenie (pola wg `EVENT_FIELDS`; `seq` = numer w pliku)
 * @param timestamp - ISO timestamp zdarzenia
 * @returns blok gotowy do dopisania (kończy się `\n`)
 */
export function formatSessionEvent(
    type: string,
    event: SessionEvent | null | undefined,
    timestamp: string,
): string {
    const title = String(type).replace(/_/g, ' ');
    const lines: string[] = [`## ${timestamp} — ${title}`, ''];
    const add = (label: EventFieldName, value: unknown) => {
        if (value === undefined || value === null || value === '') return;
        // `seq` jest liczbą pisarza, nie treścią - bez escape, bez JSON.stringify.
        if (label === 'seq') {
            if (typeof value !== 'number' || !Number.isFinite(value)) return;
            lines.push('**seq:**', '', String(value), '');
            return;
        }
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        lines.push(`**${label}:**`);
        lines.push('');
        lines.push(escapeEventFieldText(text));
        lines.push('');
    };

    for (const field of EVENT_FIELDS) {
        add(field, event?.[field]);
    }
    return `${lines.join('\n')}\n`;
}

/**
 * Największy `**seq:**` w pliku (0 = brak numeracji, np. plik legacy albo świeży).
 *
 * Służy do inicjalizacji licznika numeracji po restarcie Obsidiana - dalej numer
 * idzie z cache w pamięci (`AgentMemory._nextSeq`), bez ponownego skanu.
 *
 * Wymaga BLOKOWEGO kształtu pola (etykieta sama w linii, wartość niżej), więc linia
 * `**seq:** 5` wklejona w treść wiadomości nie podbija licznika, a linia będąca samą
 * etykietą jest w treści zescapowana (`\**seq:**`) i też nie łapie się na `^`.
 *
 * @param text - zawartość pliku sesji
 */
export function maxSeq(text: unknown): number {
    const body = String(text ?? '').replace(/\r\n/g, '\n');
    const re = /^\*\*seq:\*\*[ \t]*\n\s*(\d+)/gm;
    let max = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(body)) !== null) {
        const value = Number(match[1]);
        if (Number.isFinite(value) && value > max) max = value;
    }
    return max;
}

/**
 * Czyta plik aktywnej sesji JEDNYM przebiegiem, klasyfikując KAŻDY blok `## ...` osobno.
 *
 * Dlaczego jeden przebieg, a nie „dwa parsery i sklej": produkcyjna sekwencja to
 * append × N → autozapis NADPISUJE plik transkryptem → dalsze appendy doklejają eventy,
 * czyli plik jest MIESZANY (B + ogon A). Parser samego formatu A na takim pliku zwróciłby
 * sam ogon eventów (na format B spada dopiero przy ZERZE wiadomości), a pierwszy autozapis
 * po restore nadpisałby plik tą okrojoną wersją = TRWAŁA UTRATA rozmowy. Sklejanie dwóch
 * parserów też nie działa: parser B wciąga bloki eventowe do treści ostatniej wiadomości,
 * więc te same zdania wracałyby podwójnie.
 *
 * Kolejność klasyfikacji bloku:
 *  a) SUROWY nagłówek jest znaną rolą (`user`/`assistant`/`system`/`tool`) → wiadomość
 *     transkryptowa (z unescape `\## ` → `## `). Sprawdzane PRZED `_eventTypeFromHeader`,
 *     bo jego regex ucina w nagłówku wszystko do myślnika włącznie.
 *  b) blok niesie pole eventowe (`**content:**` / `**result:**` / `**prompt:**`) → wiadomość
 *     eventowa (rola z typu eventu albo z pola `**role:**`), treść przez unescape -
 *     lustro escapowania z `formatSessionEvent`. Na legacy blokach (nigdy nie escapowanych)
 *     unescape jest no-opem.
 *  c) ani rola, ani pole eventowe → to NIE jest granica wiadomości, tylko nagłówek w treści
 *     poprzedniej (np. `## Wyniki` w odpowiedzi agenta). Doklejamy go tam z powrotem -
 *     zasada „nic nie ginie".
 *
 * Plik pusty / sam frontmatter daje 0 wiadomości - na tym stoi pruning naprawdę pustych
 * wpisów (`_pruneEmptyActiveSessionFromState` w modules/chat). Kontrakt nietykalny.
 *
 * Każda wiadomość niesie DODATKOWO `seq`: numer zdarzenia z pola `**seq:**`
 * albo `null` (wiadomość transkryptowa, blok legacy bez numeracji). Rozszerzenie jest
 * ADDYTYWNE - konsument `{role, content}` (`_restoreActiveSession` → `addMessage`) nie
 * wymagał zmian.
 *
 * @param text - zawartość pliku
 */
export function parseActiveSession(text: unknown): ParsedActiveSession {
    const result: ParsedActiveSession = {
        messages: [],
        metadata: {},
        summary: null
    };
    if (!text) return result;

    // Normalizacja końców linii RAZ - dalej cały parser pracuje wyłącznie na `\n`.
    let body = String(text).replace(/\r\n/g, '\n');
    result.metadata = parseFrontmatter(body);
    body = body.replace(/^---\n[\s\S]*?\n---\n*/, '');

    const parts = body.split(/(?:^|\n)## /);
    // Ostatnia wiadomość była transkryptowa? (decyduje, czy doklejka idzie przez unescape)
    let lastWasTranscript = false;

    // parts[0] to treść PRZED pierwszym `## ` (nagłówek H1 pliku sesji) - nigdy nie jest blokiem.
    for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        if (!part.trim()) continue;
        const splitIndex = part.indexOf('\n');
        const rawHeader = splitIndex === -1 ? part : part.slice(0, splitIndex);
        const rawBody = splitIndex === -1 ? '' : part.slice(splitIndex + 1);

        // (a) transkrypt
        const role = rawHeader.trim().toLowerCase();
        // `KNOWN_ROLES` to Set<string> (zbiór dzielony z sessionParser), więc `has`
        // nie zawęża typu - asercja przywraca wiedzę, którą właśnie sprawdziliśmy.
        if (KNOWN_ROLES.has(role)) {
            result.messages.push({ role: role as SessionRole, content: unescapeActiveText(rawBody.trim()), seq: null });
            lastWasTranscript = true;
            continue;
        }

        // (b) event-log
        const contentValue = extractEventField(rawBody, 'content')
            || extractEventField(rawBody, 'result')
            || extractEventField(rawBody, 'prompt');
        if (contentValue) {
            const eventRole = roleFromEvent(eventTypeFromHeader(rawHeader), rawBody);
            // Event o nierozpoznanej roli pomijamy jak dotąd, ale NIE doklejamy go do
            // poprzedniej wiadomości - blok z polem eventowym nigdy nie jest treścią.
            if (eventRole) {
                result.messages.push({
                    role: eventRole,
                    content: unescapeActiveText(contentValue.trim()),
                    seq: seqFromEvent(rawBody),
                });
                lastWasTranscript = false;
            }
            continue;
        }

        // (c) nagłówek z treści wiadomości - wraca tam, skąd przyszedł
        // Wyjątek: nagłówek z ISO-timestampem to EVENT bez pola treści (np. `mcp call`,
        // którego narzędzie zwróciło pustkę - `formatSessionEvent` pomija puste pola).
        // Taki blok pomijamy jak dotąd - doklejka zaśmieciłaby poprzednią wiadomość.
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(rawHeader.trim())) continue;
        const prev = result.messages[result.messages.length - 1];
        if (!prev) continue; // śmieć przed pierwszą wiadomością - pomijamy jak dotąd
        const head = rawHeader.trim();
        const tail = rawBody.trim();
        const restored = `## ${head}${tail ? `\n${tail}` : ''}`;
        const addition = lastWasTranscript ? unescapeActiveText(restored) : restored;
        prev.content = prev.content ? `${prev.content}\n${addition}` : addition;
    }

    return result;
}

/**
 * Typ zdarzenia z nagłówka bloku: `## 2026-07-30T10:32:41.240Z - user message` → `user_message`.
 */
function eventTypeFromHeader(header: unknown): string {
    const normalized = String(header)
        .replace(/^.*\s[—-]\s*/, '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_');
    return normalized || 'event';
}

/**
 * Wyciąga jedno pole `**<field>:**` z ciała bloku event-logu.
 *
 * Zwraca treść po odkręceniu escapów ETYKIET (`\**result:**` → `**result:**`), ale BEZ
 * odkręcania `## ` - to robi `parseActiveSession` na końcu (kolejność odwrotna do pisarza).
 * Koniec pola wyznacza wyłącznie ZNANA etykieta stojąca sama w linii (`FIELD_END_LOOKAHEAD`).
 *
 * Początek pola jest zakotwiczony na początku linii (`(?:^|\n)`, bez flagi `i`) - DOKŁADNIE
 * tak samo jak `FIELD_LABEL_LINE_RE`, którego używa pisarz (`escapeEventFieldText`) do
 * escapowania linii-etykiet w treści. Bez tej kotwicy i tej samej wielkości liter etykieta
 * pola WCZEŚNIEJSZEGO w `EVENT_FIELDS` osadzona w środku treści pola PÓŹNIEJSZEGO (np. wynik
 * narzędzia niosący linię `**Content:**`) była brana za prawdziwy początek pola - i to nawet
 * gdy pisarz linię zescapował, bo escape sam nie blokował dopasowania bez kotwicy.
 *
 * @returns treść pola albo ''
 */
function extractEventField(body: unknown, field: string): string {
    const pattern = new RegExp(`(?:^|\\n)\\*\\*${field}:\\*\\*\\n\\n([\\s\\S]*?)${FIELD_END_LOOKAHEAD}`);
    const match = String(body || '').match(pattern);
    if (!match) return '';
    return unescapeEventFieldLabels(match[1]).trim();
}

/**
 * Numer zdarzenia z pola `**seq:**` bloku event-logu. `null` = brak numeracji
 * (blok legacy sprzed v2 albo pole w nieznanym kształcie).
 */
function seqFromEvent(body: unknown): number | null {
    const raw = extractEventField(body, 'seq');
    if (!/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

/**
 * Rola wiadomości dla bloku event-logu: z typu zdarzenia, a w ostatniej instancji
 * z jawnego pola `**role:**`. `null` = rola nierozpoznana (blok pomijany).
 *
 * ⚠️ **`subagent_error` MUSI mieć mapowanie z typu.** Oba zdarzenia biegu suba
 * niosą w polu `**role:**` ETYKIETĘ suba (`researcher`, `strategist`, czasem `system` z YAML-a),
 * a nie rolę wiadomości. Dla `subagent_call` typ rozstrzygał wcześniej niż pole, więc kolizja
 * była niewidoczna - `subagent_error` mapowania NIE MIAŁ, spadał do gałęzi `**role:**` i przy
 * etykiecie spoza `KNOWN_ROLES` dawał `null`, czyli parser POMIJAŁ cały blok: padnięty bieg
 * suba znikał z odtworzonej rozmowy, z konsolidacji, a przez `archiveActiveSession`
 * (transkrypt z `parsed.messages` + kasacja oryginału) także z dysku. Przy etykiecie `system`
 * było jeszcze gorzej - treść błędu wracała jako wiadomość SYSTEMOWA.
 */
function roleFromEvent(type: string, body: unknown): SessionRole | null {
    if (type === 'user_message') return 'user';
    if (type === 'agent_message') return 'assistant';
    if (type === 'tool_result' || type === 'mcp_call') return 'tool';
    if (type === 'subagent_call' || type === 'subagent_error') return 'assistant';
    const explicit = extractEventField(body, 'role').toLowerCase();
    if (KNOWN_ROLES.has(explicit)) return explicit as SessionRole;
    return null;
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns an object with frontmatter fields, or {} if none.
 *
 * Mieszka tu, bo blok frontmattera jest częścią kontraktu pliku sesji (`created`/`updated`/
 * `messageCount`/`covered_by_l1`), a `parseActiveSession` musi go czytać bez `this`.
 * `AgentMemory._parseFrontmatter` DELEGUJE tutaj - jedno źródło, zero kopii
 * (metoda zostaje, bo wołają ją też `ArchiveWorkflow`, `chat_session` i `ReadTool`).
 *
 * @param content - File content
 */
export function parseFrontmatter(content: unknown): SessionFrontmatter {
    const match = String(content ?? '').match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    // `_lastKey` to pole ROBOCZE parsera (kotwica dla list `- item`), kasowane na końcu -
    // stąd osobny wariant typu, a nie zanieczyszczanie kontraktu `SessionFrontmatter`.
    const result: SessionFrontmatter & { _lastKey?: string } = {};
    for (const line of match[1].split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('- ')) {
            // Array item - append to last key
            if (result._lastKey) {
                if (!Array.isArray(result[result._lastKey])) {
                    result[result._lastKey] = [];
                }
                (result[result._lastKey] as string[]).push(trimmed.slice(2).trim());
            }
        } else if (trimmed.includes(':')) {
            const idx = trimmed.indexOf(':');
            const key = trimmed.slice(0, idx).trim();
            const val = trimmed.slice(idx + 1).trim();
            result[key] = val ? parseFrontmatterScalar(val) : [];
            result._lastKey = key;
        }
    }
    delete result._lastKey;
    return result;
}

/**
 * Skalar frontmattera: zdejmuje cudzysłowy, rozumie `true`/`false`/`null`.
 */
function parseFrontmatterScalar(value: unknown): string | boolean | null {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'")) ||
        raw === 'true' ||
        raw === 'false' ||
        raw === 'null'
    ) {
        try {
            // `JSON.parse` oddaje `any` - zawężamy do kształtów, które ta gałąź
            // realnie produkuje (cudzysłowy → string, `true`/`false` → boolean, `null`).
            return JSON.parse(raw) as string | boolean | null;
        } catch {
            return raw.replace(/^['"]|['"]$/g, '');
        }
    }
    return raw;
}
