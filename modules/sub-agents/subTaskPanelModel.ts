/**
 * subTaskPanelModel — co pasek biegów subów ma NARYSOWAĆ.
 *
 * HISTORIA: powstał w F3 dla panelu w sidebarze (`buildPanelModel`, trzy sekcje).
 * 2026-08-15 Kuba zdecydował, że biegi należą do AGENTA i SESJI, więc podgląd przeniósł
 * się do okna czatu — panel sidebara i jego model poszły do kosza, został `buildStripModel`
 * (płaska lista dla JEDNEJ zakładki).
 *
 * PO CO OSOBNY PLIK: rejestr (`SubTaskRegistry`) trzyma byty w kolejności powstania i nic
 * nie wie o kolejności prezentacji ani licznikach; widok (`modules/chat/chat/subTaskStrip.ts`)
 * ma robić DOM i tylko DOM. Cała arytmetyka — filtr zakładki, kolejność, czas trwania,
 * liczba wywołań narzędzi, skróty — siedzi tutaj, bo to jedyna część, którą da się
 * przetestować bez Obsidiana.
 *
 * ZASADY:
 *   - Plik CZYSTY: zero `obsidian`, zero DOM, zero i18n (etykiety dobiera widok).
 *   - Zero mutacji wejścia — czytamy karty rejestru, nie dotykamy ich.
 *   - `now` wstrzykiwane, bo bieg w toku ma czas trwania liczony do TERAZ (testy podają
 *     własny zegar zamiast czekać).
 *   - Treści są już zmaskowane przez rejestr (`step()`/`fail()`), więc tutaj tylko tniemy.
 */
import type { SubTask, SubTaskStatus, SubTaskStep } from './SubTaskRegistry.js';

/** Ile ostatnich kroków pokazuje rozwinięty wiersz. */
const MAX_RECENT_STEPS = 20;
/** Typ kroku, po którym poznajemy wywołanie narzędzia (zliczamy WYNIKI, nie zapowiedzi). */
const TOOL_STEP_TYPE = 'tool.post';
/** Sufit skrótu wyniku/błędu. Pasek ma JEDEN rozwinięty szczegół — pełna treść i tak wraca do rozmowy. */
const MAX_STRIP_OUTCOME_CHARS = 400;
/** Ile ZAKOŃCZONYCH biegów pokazuje pasek. Starsze są w trace.log, nie na oczach usera. */
const MAX_STRIP_FINISHED = 10;

/**
 * Czas trwania po ludzku: sekundy do minuty, potem minuty (+ reszta sekund).
 * Godzin świadomie NIE ma — sub, który biegnie ponad godzinę, i tak jest awarią,
 * a „93 min" czyta się wtedy lepiej niż „1 h 33 min".
 */
export function formatDuration(ms: number): string {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return '0 s';
    const totalSec = Math.floor(value / 1000);
    if (totalSec < 60) return `${totalSec} s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return sec === 0 ? `${min} min` : `${min} min ${sec} s`;
}

function truncate(text: string, max: number): string {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Co pokazać jako rezultat biegu: błąd wygrywa z tekstem wyniku (jest ważniejszy). */
function resolveOutcome(task: SubTask): string {
    if (task.status === 'running') return '';
    if (task.error) return truncate(task.error, MAX_STRIP_OUTCOME_CHARS);
    const text = task.result?.text;
    return typeof text === 'string' ? truncate(text.trim(), MAX_STRIP_OUTCOME_CHARS) : '';
}

/**
 * Krok w pasku. Świadomie BEZ skrótu wszystkich pól zdarzenia — pasek ma odpowiedzieć
 * na trzy pytania („co robi", „czego używa", „na czym KONKRETNIE") — a nie wyświetlić
 * log. Pełny ślad jest w `.pkm-assistant/logs/trace.log`.
 */
export interface StripStep {
    at: number;
    type: string;
    /** Nazwa narzędzia, jeśli krok jej dotyczy (`tool.pre` / `tool.post`). */
    tool?: string;
    /**
     * Front B (szyba, 2026-08-17): konkret kroku — dla `tool.pre` najistotniejszy argument
     * (ścieżka / zapytanie / folder / URL), dla `tool.post` rozmiar wyniku albo błąd.
     * Zgłoszenie Kuby: „widać, że wykonuje toole, ale co dokładnie czyta? Nie wiadomo".
     */
    detail?: string;
}

/** Sufit konkretu kroku — jedna linijka w pasku, nie dump argumentów. */
const MAX_STEP_DETAIL_CHARS = 80;
/** Sufit skrótu zadania w rozwinięciu (rejestr i tak tnie do 300 — to drugi pas). */
const MAX_STRIP_TASK_CHARS = 300;

/** Klucze argumentów niosące najwięcej konkretu — pierwszy trafiony wygrywa. */
const DETAIL_ARG_KEYS = ['path', 'query', 'folder', 'url', 'filename', 'task', 'name'] as const;

/**
 * Wyciąga jednolinijkowy konkret z argumentów narzędzia (`tool.pre`). Args przychodzą
 * z pętli jako SUROWE `tc.arguments` — najczęściej string JSON, czasem obiekt. Zły JSON
 * nie jest błędem: pokazujemy przycięty surowiec (lepszy krzywy konkret niż żaden).
 */
function detailFromArgs(rawArgs: unknown): string {
    if (rawArgs == null) return '';
    let parsed: unknown = rawArgs;
    if (typeof rawArgs === 'string') {
        const text = rawArgs.trim();
        if (!text) return '';
        try { parsed = JSON.parse(text); } catch { return truncate(text, MAX_STEP_DETAIL_CHARS); }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return truncate(String(parsed ?? ''), MAX_STEP_DETAIL_CHARS);
    }
    const args = parsed as Record<string, unknown>;
    for (const key of DETAIL_ARG_KEYS) {
        const value = args[key];
        if (typeof value === 'string' && value.trim()) return truncate(value.trim(), MAX_STEP_DETAIL_CHARS);
    }
    // Bez znanego klucza: pierwszy stringowy argument (konkret > nazwa klucza).
    for (const value of Object.values(args)) {
        if (typeof value === 'string' && value.trim()) return truncate(value.trim(), MAX_STEP_DETAIL_CHARS);
    }
    return '';
}

/** Konkret dla `tool.post`: błąd wygrywa, potem rozmiar wyniku (chars/blocks z trace). */
function detailFromPost(fields: Record<string, unknown>): string {
    if (fields.status === 'error') return 'error';
    const chars = Number(fields.chars);
    if (Number.isFinite(chars) && chars > 0) return `${chars} zn.`;
    const blocks = Number(fields.blocks);
    if (Number.isFinite(blocks) && blocks > 0) return `${blocks} blk`;
    return '';
}

/** Jeden bieg w pasku — policzony do końca, widok tylko wypisuje. */
export interface StripRow {
    id: string;
    name: string;
    status: SubTaskStatus;
    /** Poproszono o Stop, bieg jeszcze nie stanął (guzik → „zatrzymywanie…"). */
    stopRequested: boolean;
    /**
     * Bieg SKOŃCZONY, ale jego wynik siedzi jeszcze w kolejce notifiera. Dla usera to
     * osobny stan („zaraz wpadnie do rozmowy"), którego samo `status: done` nie oddaje.
     */
    waiting: boolean;
    /** `endedAt || now` − `createdAt`. Nigdy ujemny. */
    durationMs: number;
    stepCount: number;
    /** Ile razy sub dostał wynik narzędzia (kroki `tool.post`). */
    toolCallCount: number;
    lastStep: StripStep | null;
    /** Skrót wyniku albo błędu (≤400 znaków). Pusty dla biegów w toku. */
    outcome: string;
    /** Ostatnie ≤20 kroków, od najstarszego — do rozwinięcia wiersza. */
    recentSteps: StripStep[];
    /** Front B: skrót zadania zleconego przez maina (≤300 znaków; '' gdy bieg go nie niesie). */
    taskPreview: string;
}

export interface BuildStripModelInput {
    /** `registry.list()` — wszystkie znane biegi (filtr robimy tutaj). */
    tasks?: SubTask[] | null;
    /** `notifier.pending()` — wyniki z tła czekające na dostarczenie do czatu. */
    pending?: SubTask[] | null;
    /** Tożsamość AKTYWNEJ zakładki czatu (`chat_tabs._tabKey`). */
    tabKey?: string | null;
    /** Agent tej zakładki — używany, gdy bieg nie niesie adresu zakładki. */
    agentName?: string | null;
    /** Ścieżka AKTYWNEJ sesji agenta — twardy wyróżnik „per sesja" (patrz belongsToTab). */
    sessionPath?: string | null;
    /** Zegar (wstrzykiwany dla testów). */
    now?: number;
}

/**
 * Czy ten bieg należy do TEJ zakładki czatu.
 *
 * Pierwszeństwo ma `origin.tabKey` — adres zwrotny wystawiony przez czat przy zleceniu
 * (F2). Bieg, który go nie ma (zlecenie spoza czatu, stara karta w pamięci, delegacja
 * bez originu), przypisujemy po AGENCIE: lepiej pokazać go na jednej zakładce tego agenta
 * niż zgubić zupełnie. Gdy nie znamy ani klucza zakładki, ani agenta — nie zgadujemy.
 */
function belongsToTab(task: SubTask, tabKey: string, agentName: string, sessionPath: string): boolean {
    // Twardy wyróżnik SESJI (incydent 2026-08-15 wieczór): klucz zakładki potrafi sprowadzić
    // się do samej nazwy agenta (świeża zakładka przed pierwszą wiadomością nie ma jeszcze
    // sesji), więc stara i nowa sesja tego samego agenta były nierozróżnialne — chipy
    // zakończonych biegów zostawały po archiwizacji. Adres sesji ze zlecenia rozstrzyga:
    // bieg z CUDZEJ/starej sesji pokazujemy wyłącznie, gdy wciąż BIEGNIE (sierota — user
    // musi mieć jak go zobaczyć i ubić Stopem).
    const originSession = task.origin?.sessionPath || '';
    if (originSession) {
        if (sessionPath && originSession === sessionPath) return true;
        if (task.status !== 'running') return false;
        const orphanOwner = task.origin?.agentName || task.agentName || '';
        return Boolean(agentName) && orphanOwner === agentName;
    }
    const originTab = task.origin?.tabKey;
    if (originTab && tabKey) return originTab === tabKey;
    const owner = task.origin?.agentName || task.agentName || '';
    return Boolean(agentName) && owner === agentName;
}

function toStripStep(step: SubTaskStep): StripStep {
    const fields = step.fields || {};
    const tool = fields.tool;
    const out: StripStep = { at: step.at, type: step.type };
    if (typeof tool === 'string' && tool) out.tool = tool;
    // Front B: konkret kroku — args dla zapowiedzi narzędzia, rozmiar/błąd dla wyniku.
    const detail = step.type === 'tool.pre'
        ? detailFromArgs(fields.args)
        : (step.type === 'tool.post' ? detailFromPost(fields) : '');
    if (detail) out.detail = detail;
    return out;
}

function toStripRow(task: SubTask, now: number, waiting: boolean): StripRow {
    const steps = Array.isArray(task.steps) ? task.steps : [];
    const ended = typeof task.endedAt === 'number' ? task.endedAt : now;
    const last = steps.length > 0 ? steps[steps.length - 1] : null;
    return {
        id: task.id,
        name: task.name || task.id,
        status: task.status,
        stopRequested: task.stopRequested === true,
        waiting,
        durationMs: Math.max(0, ended - task.createdAt),
        stepCount: steps.length,
        toolCallCount: steps.filter(s => s.type === TOOL_STEP_TYPE).length,
        lastStep: last ? toStripStep(last) : null,
        outcome: resolveOutcome(task),
        recentSteps: steps.slice(-MAX_RECENT_STEPS).map(toStripStep),
        taskPreview: typeof task.taskPreview === 'string' ? truncate(task.taskPreview, MAX_STRIP_TASK_CHARS) : '',
    };
}

/**
 * Model paska biegów dla JEDNEJ zakładki czatu (decyzja Kuby 2026-08-15: biegi subów
 * należą do agenta i sesji, nie do globalnego sidebara).
 *
 * PŁASKA lista, bo pasek nie ma sekcji — ma kolejność, która odpowiada uwadze usera:
 *   1. **w biegu**, od NAJSTARSZEGO (ten wisi najdłużej i to jego user szuka, gdy chce ubić),
 *   2. **wynik czeka na czat**, w kolejności DOSTARCZANIA (tak, jak czat je weźmie),
 *   3. **zakończone**, od najświeższego, **sufit 10** — pasek to podgląd, nie archiwum.
 *
 * Bieg czekający w kolejce jest tylko w grupie 2 (żadnych duplikatów).
 */
export function buildStripModel({
    tasks,
    pending,
    tabKey = '',
    agentName = '',
    sessionPath = '',
    now = Date.now(),
}: BuildStripModelInput = {}): StripRow[] {
    const key = typeof tabKey === 'string' ? tabKey : '';
    const agent = typeof agentName === 'string' ? agentName : '';
    const session = typeof sessionPath === 'string' ? sessionPath : '';
    const mine = (Array.isArray(tasks) ? tasks : []).filter(task => task && belongsToTab(task, key, agent, session));
    const queue = (Array.isArray(pending) ? pending : []).filter(task => task && belongsToTab(task, key, agent, session));

    const waitingIds = new Set<string>();
    const waiting: StripRow[] = [];
    for (const task of queue) {
        // Bieg w toku nie ma prawa czekać na dostarczenie; jeden id liczymy raz.
        if (!task.id || task.status === 'running' || waitingIds.has(task.id)) continue;
        waitingIds.add(task.id);
        waiting.push(toStripRow(task, now, true));
    }

    const running = mine
        .filter(task => task.status === 'running')
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(task => toStripRow(task, now, false));

    const finished = mine
        .filter(task => task.status !== 'running' && !waitingIds.has(task.id))
        .sort((a, b) => (b.endedAt || b.createdAt) - (a.endedAt || a.createdAt))
        .slice(0, MAX_STRIP_FINISHED)
        .map(task => toStripRow(task, now, false));

    return [...running, ...waiting, ...finished];
}
