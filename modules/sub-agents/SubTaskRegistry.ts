/**
 * SubTaskRegistry — księga zadań sub-agentów (F1 „Przebudowa subagentów 2026").
 *
 * PO CO: do F1 jedynym śladem po biegu suba była linia w `.pkm-assistant/logs/trace.log`
 * (funkcja `trace` wstrzykiwana do pętli). Nie istniał BYT, którego można zapytać „co ten
 * sub robi teraz", „ile mu zostało budżetu", „czym skończył". Ten plik robi z biegu suba
 * obiekt (`SubTask`: id, status, kroki, wynik, budżet) i wystawia szynę zdarzeń.
 *
 * ODWRÓCENIE ZALEŻNOŚCI: trace.log przestaje być JEDYNYM odbiorcą — staje się PIERWSZYM
 * KONSUMENTEM zdarzeń (`task:step` → `traceLog.scope(task.id)(type, fields)`). Format linii
 * jest BIT W BIT ten sam co dotąd (etykieta = dzisiejsza etykieta trace `sub/<nazwa>#<seq>`,
 * formatowanie robi `TraceLog.scope`), bo scenariusze harnessa parsują ten plik prefiksowo.
 * Panel podglądu subów (F3) podepnie się jako DRUGI konsument, bez dotykania runnera.
 *
 * ZASADY:
 *   - Plik czysty: zero `obsidian`, zero UI, zero I/O. Zależności (traceLog, mask)
 *     WSTRZYKIWANE — barrel modułu musi zostać obsidian-free (wiszą na nim testy AVA).
 *   - Księgowość NIGDY nie zatrzymuje suba: każda metoda jest fail-soft (try/catch + warn).
 *     Rejestr, który się wywala, byłby gorszy od braku rejestru.
 *   - Maskowanie NA WEJŚCIU (`step` przepuszcza stringowe wartości pól przez `mask`),
 *     więc KAŻDY konsument — trace, przyszły panel — dostaje dane już bezpieczne.
 *   - Sufity pamięci: `maxStepsPerTask` (kroki w RAM per task) i `maxDone` (ile zakończonych
 *     tasków trzymamy). Taski `running` nie są usuwane NIGDY.
 *
 * F3 („panel biegów"): rejestr jest też SKRZYNKĄ KONTAKTOWĄ do biegu — `attachAbort`
 * przyjmuje uchwyt „ubij mnie" od tego, kto suba odpalił, a `requestStop` pozwala nim
 * pociągnąć komuś, kto zna wyłącznie `id` (panel w sidebarze). Rejestr dalej nic nie wie
 * o tym, JAK się ubija suba — trzyma cudzą funkcję i tyle.
 *
 * F5 („sterowanie w trakcie"): ta sama skrzynka przyjmuje też WIADOMOŚCI — `postMessage`
 * wrzuca tekst do kolejki biegu, `takeMessages` opróżnia ją po stronie runnera (hak
 * `beforeContinue` pętli, czyli między wywołaniami modelu). Rejestr nie interpretuje
 * treści i nie doręcza jej sam; jest skrzynką, nie listonoszem.
 */
import { EventEmitter } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';

/** Stan biegu suba. `aborted` = ubity z zewnątrz (timeout delegacji), `error` = wyjątek. */
export type SubTaskStatus = 'running' | 'done' | 'error' | 'aborted';

/** Jeden krok pętli (`loop.start`, `tool.pre`, `tool.post`, `backstop`, `loop.end`, …). */
export interface SubTaskStep {
    at: number;
    type: string;
    /** Pola zdarzenia — JUŻ ZMASKOWANE (patrz `SubTaskRegistry.step`). */
    fields: Record<string, unknown>;
}

/** Kagańce, z jakimi sub wystartował (te same liczby, które dostała pętla). */
export interface SubTaskBudget {
    maxIterations?: number;
    perCallTimeoutMs?: number;
    maxToolResultLength?: number;
}

/** Wynik biegu suba — mapowanie 1:1 z tym, co zwraca `runAgentLoop`. */
export interface SubTaskResult {
    text: string;
    toolsUsed: string[];
    durationMs: number;
    usage: unknown;
    stoppedBy?: 'natural' | 'backstop' | 'abort';
}

/**
 * Skąd przyszło zlecenie (F2 „delegacja w tle") — adres zwrotny dla wyniku.
 *
 * Rejestr TEGO NIE INTERPRETUJE: przechowuje 1:1 i oddaje konsumentom (`SubTaskNotifier`,
 * a w fazie B czat, który po tych polach trafi z powiadomieniem do właściwej zakładki/sesji).
 */
export interface SubTaskOrigin {
    agentName: string;
    sessionPath?: string;
    tabKey?: string;
}

/** Bieg sub-agenta jako byt. `id` = etykieta trace (`sub/<nazwa>#<seq>`), unikalna w procesie. */
export interface SubTask {
    id: string;
    name: string;
    agentName: string;
    status: SubTaskStatus;
    createdAt: number;
    endedAt?: number;
    steps: SubTaskStep[];
    budget: SubTaskBudget;
    result?: SubTaskResult;
    error?: string;
    /** F2: bieg odpalony W TLE (tura wołającego NIE czeka na wynik). */
    background?: boolean;
    /** F2: adres zwrotny zlecenia — patrz `SubTaskOrigin`. */
    origin?: SubTaskOrigin;
    /**
     * Front B (szyba, 2026-08-17): skrót ZADANIA zleconego przez maina (≤300 znaków,
     * zmaskowany na wejściu). Panel pokazuje go w rozwinięciu chipa — user ma widzieć,
     * PO CO ten bieg w ogóle wystartował, nie tylko co klika.
     */
    taskPreview?: string;
    /**
     * F3: ktoś (panel) poprosił o zatrzymanie tego biegu. To ZNACZNIK PROŚBY, nie status —
     * bieg gaśnie dopiero, gdy pętla suba dojedzie do najbliższego punktu przerwania i
     * domknie się przez `finish`/`fail`. Panel dzięki temu może pokazać „zatrzymywanie…".
     */
    stopRequested?: boolean;
}

/** Funkcja-tee podawana do pętli — ten sam kształt co `TraceLog.scope(label)`. */
export type SubTaskTrace = (type: string, fields?: Record<string, unknown>) => void;

/**
 * Minimalny widok `TraceLog`, jakiego rejestr naprawdę używa (duck-typing, żeby test mógł
 * podstawić atrapę i żeby moduł nie wisiał na klasie z core).
 */
export interface SubTaskTraceLogLike {
    scope?: (label: string) => SubTaskTrace;
}

export interface SubTaskRegistryOptions {
    /** Gdy podany — rejestr sam subskrybuje domyślnego konsumenta piszącego do trace.log. */
    traceLog?: SubTaskTraceLogLike | null;
    /** W produkcji `maskSensitiveData`; brak = zero maskowania (tylko testy/harness). */
    mask?: ((value: string) => string) | null;
    maxDone?: number;
    maxStepsPerTask?: number;
    /** F5: sufit kolejki wiadomości do jednego biegu (patrz `postMessage`). */
    maxMessagesPerTask?: number;
}

/** Ile ZAKOŃCZONYCH biegów trzymamy w pamięci (starsze wypadają). */
const DEFAULT_MAX_DONE = 50;
/** Ile kroków per bieg ląduje w RAM (nadmiar idzie tylko do konsumentów, np. do pliku). */
const DEFAULT_MAX_STEPS_PER_TASK = 500;
/**
 * F5: ile NIEODEBRANYCH wiadomości do biegu trzymamy w kolejce. Sufit jest niski celowo —
 * kolejka opróżnia się przy najbliższej iteracji pętli, więc dziesięć czekających znaczy,
 * że user sypie poleceniami szybciej, niż sub jest w stanie je przeczytać. Nadmiarowe
 * odrzucamy (`postMessage` → `false`), a nie wypychamy najstarsze: przy sterowaniu biegiem
 * cicha utrata polecenia jest gorsza niż odmowa.
 */
const DEFAULT_MAX_MESSAGES_PER_TASK = 10;

export class SubTaskRegistry {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS §3).
    /** Szyna zdarzeń: `task:created` (task), `task:step` ({task, step}), `task:finished` (task). */
    declare events: EventEmitter;
    declare private _tasks: Map<string, SubTask>;
    declare private _traceLog: SubTaskTraceLogLike | null;
    /** Cache funkcji `scope` per id taska — jedna na bieg, kasowana przy `task:finished`. */
    declare private _traceScopes: Map<string, SubTaskTrace>;
    /**
     * F3: uchwyty „ubij ten bieg" per id taska (side-channel abortów). Rejestr NIE WIE,
     * jak się ubija suba — zna tylko funkcję, którą wstrzyknął ten, kto bieg odpalił
     * (`DelegateTool`). Wpis żyje dokładnie tyle co bieg (kasowany przy `task:finished`).
     */
    declare private _aborts: Map<string, () => void>;
    /**
     * F5: kolejka wiadomości od usera do KONKRETNEGO biegu (side-channel sterowania).
     * Rejestr nie wie, co się z nimi stanie — zdejmuje je runner w haku `beforeContinue`
     * i dopisuje do transkryptu suba. Wpis żyje dokładnie tyle co bieg.
     */
    declare private _messages: Map<string, string[]>;
    declare private _mask: ((value: string) => string) | null;
    declare private _maxDone: number;
    declare private _maxStepsPerTask: number;
    declare private _maxMessagesPerTask: number;

    constructor({
        traceLog = null,
        mask = null,
        maxDone = DEFAULT_MAX_DONE,
        maxStepsPerTask = DEFAULT_MAX_STEPS_PER_TASK,
        maxMessagesPerTask = DEFAULT_MAX_MESSAGES_PER_TASK,
    }: SubTaskRegistryOptions = {}) {
        this.events = new EventEmitter();
        this._tasks = new Map();
        this._traceScopes = new Map();
        this._aborts = new Map();
        this._messages = new Map();
        this._traceLog = traceLog || null;
        this._mask = typeof mask === 'function' ? mask : null;
        this._maxDone = Number(maxDone) > 0 ? Number(maxDone) : DEFAULT_MAX_DONE;
        this._maxStepsPerTask = Number(maxStepsPerTask) > 0 ? Number(maxStepsPerTask) : DEFAULT_MAX_STEPS_PER_TASK;
        this._maxMessagesPerTask = Number(maxMessagesPerTask) > 0 ? Number(maxMessagesPerTask) : DEFAULT_MAX_MESSAGES_PER_TASK;
        this._subscribeHousekeeping();
        if (this._traceLog) this._subscribeTraceConsumer();
    }

    /**
     * Sprzątanie własnych map — subskrypcja BEZWARUNKOWA (w odróżnieniu od konsumenta
     * trace, który wisi na obecności `traceLog`). Bieg skończony → jego uchwyt abortu
     * nie ma już czego ubijać, a trzymanie go byłoby wyciekiem domknięcia.
     */
    private _subscribeHousekeeping(): void {
        this.events.on('task:finished', (payload: unknown) => {
            const task = payload as SubTask | undefined;
            if (!task?.id) return;
            this._aborts.delete(task.id);
            // F5: niedoręczone wiadomości do zakończonego biegu nie mają już adresata.
            this._messages.delete(task.id);
        });
    }

    /**
     * Domyślny konsument zdarzeń: zapis do trace.log. Sedno F1 — plik jest ODBIORCĄ,
     * nie właścicielem śladu. Formatowanie linii (`label | type | k=v`) i maskowanie
     * całej linii robi `TraceLog.scope`, więc format nie zmienia się ani o bajt.
     */
    private _subscribeTraceConsumer(): void {
        this.events.on('task:step', (payload: unknown) => {
            const { task, step } = (payload || {}) as { task?: SubTask; step?: SubTaskStep };
            if (!task?.id || !step) return;
            this._scopeFor(task.id)?.(step.type, step.fields);
        });
        // Bieg skończony → etykieta nigdy więcej nie wróci, więc puszczamy jej funkcję scope.
        this.events.on('task:finished', (payload: unknown) => {
            const task = payload as SubTask | undefined;
            if (task?.id) this._traceScopes.delete(task.id);
        });
    }

    /** Funkcja trace związana z etykietą taska (leniwie tworzona, cache'owana per id). */
    private _scopeFor(id: string): SubTaskTrace | null {
        const cached = this._traceScopes.get(id);
        if (cached) return cached;
        const fn = this._traceLog?.scope?.(id);
        if (typeof fn !== 'function') return null;
        this._traceScopes.set(id, fn);
        return fn;
    }

    /** Maskuje stringowe wartości pól; nie-stringi (liczby, obiekty) przechodzą bez zmian. */
    private _maskFields(fields: Record<string, unknown> | null | undefined): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        if (!fields || typeof fields !== 'object') return out;
        for (const [key, value] of Object.entries(fields)) {
            out[key] = (typeof value === 'string' && this._mask) ? this._mask(value) : value;
        }
        return out;
    }

    /**
     * Zakłada byt dla nowego biegu suba i ogłasza `task:created`.
     * @param id - etykieta trace tego wywołania (`sub/<nazwa>#<seq>`) — jednocześnie klucz rejestru.
     * @param background - F2: bieg w tle (wołający nie czeka). Rejestr tylko przechowuje flagę.
     * @param origin - F2: adres zwrotny zlecenia. Rejestr go NIE interpretuje (patrz `SubTaskOrigin`).
     */
    create({ id, name, agentName, budget, background, origin, taskPreview }: {
        id: string;
        name?: string;
        agentName?: string;
        budget?: SubTaskBudget;
        background?: boolean;
        origin?: SubTaskOrigin;
        taskPreview?: string;
    }): SubTask {
        const task: SubTask = {
            id,
            name: name || 'sub',
            agentName: agentName || '',
            status: 'running',
            createdAt: Date.now(),
            steps: [],
            budget: budget ? { ...budget } : {},
        };
        // Pola opcjonalne dokładamy tylko gdy podane — kształt bytu bez delegacji w tle
        // zostaje bit w bit taki jak po F1 (konsumenci sprawdzają obecność pola).
        if (background !== undefined) task.background = background;
        if (origin) task.origin = { ...origin };
        // Front B: skrót zadania przechodzi przez tę samą maskę co kroki (zadanie potrafi
        // nieść sekret z kontekstu rodzica) i ma twardy sufit — to podgląd, nie transkrypt.
        if (typeof taskPreview === 'string' && taskPreview.trim()) {
            const trimmed = taskPreview.trim().slice(0, 300);
            task.taskPreview = this._mask ? this._mask(trimmed) : trimmed;
        }
        this._tasks.set(task.id, task);
        this.events.emit('task:created', task);
        return task;
    }

    /**
     * Dopisuje krok pętli i ogłasza `task:step`.
     *
     * ⚠️ Po przekroczeniu `maxStepsPerTask` krok NIE ląduje w tablicy, ale zdarzenie leci
     * dalej — plik trace ma pełny ślad biegu, RAM ma sufit. Metoda NIGDY nie rzuca:
     * księgowość nie ma prawa ubić sub-agenta w połowie roboty.
     */
    step(task: SubTask, type: string, fields: Record<string, unknown> = {}): void {
        try {
            if (!task) return;
            const step: SubTaskStep = { at: Date.now(), type: String(type), fields: this._maskFields(fields) };
            if (Array.isArray(task.steps) && task.steps.length < this._maxStepsPerTask) {
                task.steps.push(step);
            }
            this.events.emit('task:step', { task, step });
        } catch (e) {
            log.warn('SubTaskRegistry', 'step() padł (bieg suba leci dalej):', e);
        }
    }

    /** Domyka bieg wynikiem. `stoppedBy: 'abort'` → status `aborted`, reszta → `done`. */
    finish(task: SubTask, result: SubTaskResult): void {
        try {
            if (!task) return;
            task.result = result;
            task.status = result?.stoppedBy === 'abort' ? 'aborted' : 'done';
            task.endedAt = Date.now();
            this.events.emit('task:finished', task);
            this._evictOldDone();
        } catch (e) {
            log.warn('SubTaskRegistry', 'finish() padł (bieg suba leci dalej):', e);
        }
    }

    /** Domyka bieg błędem. Tekst błędu maskujemy — API zwraca w nim czasem klucz. */
    fail(task: SubTask, error: string): void {
        try {
            if (!task) return;
            const message = typeof error === 'string' ? error : String(error);
            task.status = 'error';
            task.error = this._mask ? this._mask(message) : message;
            task.endedAt = Date.now();
            this.events.emit('task:finished', task);
            this._evictOldDone();
        } catch (e) {
            log.warn('SubTaskRegistry', 'fail() padł (bieg suba leci dalej):', e);
        }
    }

    /**
     * Funkcja-tee dla pętli agenta — kształt identyczny z `TraceLog.scope(label)`, więc
     * `runAgentLoop` nie wie, że pisze do rejestru zamiast wprost do pliku.
     */
    traceFor(task: SubTask): SubTaskTrace {
        return (type: string, fields: Record<string, unknown> = {}) => this.step(task, type, fields);
    }

    /**
     * F3: podepnij uchwyt „zatrzymaj ten bieg". Woła to ten, kto suba odpalił
     * (`DelegateTool`) — tylko on ma jednocześnie `task.id` i domkniętą kontrolkę abortu.
     * Rejestr uchwytu nie interpretuje; jest tylko skrzynką kontaktową dla panelu.
     */
    attachAbort(id: string, fn: () => void): void {
        try {
            if (!id || typeof fn !== 'function') return;
            this._aborts.set(id, fn);
        } catch (e) {
            log.warn('SubTaskRegistry', 'attachAbort() padł (bieg suba leci dalej):', e);
        }
    }

    /**
     * F3: poproś o zatrzymanie biegu. Zwraca `true` TYLKO gdy prośba miała dokąd pójść —
     * czyli bieg istnieje, jeszcze biegnie i ma podpięty uchwyt.
     *
     * ⚠️ To jest PROŚBA, nie egzekucja: znacznik `stopRequested` i ślad `stop.requested`
     * lądują od razu (panel może pokazać „zatrzymywanie…"), ale status zmieni się dopiero,
     * gdy pętla suba naprawdę stanie i domknie byt przez `finish`/`fail`.
     */
    requestStop(id: string): boolean {
        try {
            const task = this._tasks.get(id);
            const stop = this._aborts.get(id);
            if (!task || !stop || task.status !== 'running') return false;
            task.stopRequested = true;
            // Ślad idzie tą samą drogą co reszta kroków — także do trace.log. Harness liczy
            // KONKRETNE typy zdarzeń, więc dodatkowy typ go nie rusza.
            this.step(task, 'stop.requested', { by: 'panel' });
            try {
                stop();
            } catch (e) {
                log.warn('SubTaskRegistry', `uchwyt stop dla ${id} rzucił (prośba i tak zapisana):`, e);
            }
            return true;
        } catch (e) {
            log.warn('SubTaskRegistry', 'requestStop() padł:', e);
            return false;
        }
    }

    /**
     * Z7 (AUD-bledy-054/056): zatrzymaj WSZYSTKIE żywe biegi — demontaż pluginu.
     *
     * PO CO: `dispose()` czyścił mapę uchwytów BEZ ich wywołania, więc wyłączenie pluginu
     * zrywało kanały raportowania, ale nie zatrzymywało egzekucji: sub odpalony w tle mielił
     * dalej na wciąż żywym `mcpClient` (realny zapis do vaulta) i znikał z trace.log, bo szyna
     * zdarzeń była już odpięta. Demontaż ma NAJPIERW zatrzymać, POTEM odpiąć — stąd osobna
     * metoda, wołana z `onunload` PRZED `dispose()`.
     *
     * ⚠️ To zbiorcza PROŚBA, nie egzekucja (jak `requestStop`): uchwyt podnosi flagę abortu
     * i przerywa stream modelu, a bieg gaśnie przy najbliższym punkcie przerwania swojej
     * pętli. `onunload` NIE CZEKA na zejście biegów (Obsidian nie czeka na obietnice).
     *
     * @param reason - powód lądujący w śladzie `stop.requested` i w logu (`'unload'`, …)
     * @returns ile uchwytów wykonało się bez wyjątku (uchwyt, który rzucił, nie blokuje reszty)
     */
    stopAll(reason = 'stopAll'): number {
        let stopped = 0;
        try {
            // Kopia: uchwyt potrafi domknąć bieg synchronicznie, a housekeeping kasuje wtedy
            // wpis z `_aborts` w trakcie iteracji.
            for (const [id, stop] of [...this._aborts]) {
                const task = this._tasks.get(id);
                try {
                    if (task && task.status === 'running' && !task.stopRequested) {
                        task.stopRequested = true;
                        // Ślad tą samą drogą co `requestStop` — trace.log jeszcze żyje (zamykamy
                        // go po rejestrze), więc w logu zostaje dowód, że bieg dostał sygnał.
                        this.step(task, 'stop.requested', { by: reason });
                    }
                    stop();
                    stopped++;
                    log.info('SubTaskRegistry', `stopAll(${reason}): zatrzymuję bieg ${id} (agent ${task?.agentName || '?'})`);
                } catch (e) {
                    log.warn('SubTaskRegistry', `stopAll(${reason}): uchwyt ${id} (agent ${task?.agentName || '?'}) rzucił — lecę dalej:`, e);
                }
            }
        } catch (e) {
            log.warn('SubTaskRegistry', 'stopAll() padł:', e);
        }
        return stopped;
    }

    /**
     * F5: wrzuć wiadomość od usera do biegu, który TRWA (side-channel sterowania).
     *
     * Zwraca `true` tylko wtedy, gdy wiadomość ma dokąd pójść: bieg istnieje, ma status
     * `running` i kolejka nie jest pełna. Sam rejestr jej NIE DORĘCZA — leży w kolejce,
     * dopóki runner nie zdejmie jej przez `takeMessages` w haku `beforeContinue` pętli.
     *
     * ⚠️ To jest DORĘCZENIE PRZY NAJBLIŻSZEJ ITERACJI, nie przerwanie. Sub w środku
     * długiego strumienia przeczyta ją dopiero po nim, a sub, który właśnie wszedł
     * w ostatnią iterację (backstop), może jej nie przeczytać wcale — kolejka zniknie
     * razem z biegiem. Od twardego zatrzymania jest `requestStop`.
     *
     * Treść maskujemy tak samo jak pola kroków — user potrafi wkleić w polecenie klucz.
     */
    postMessage(id: string, text: string): boolean {
        try {
            const task = this._tasks.get(id);
            if (!task || task.status !== 'running') return false;
            const raw = typeof text === 'string' ? text.trim() : '';
            if (!raw) return false;
            const queue = this._messages.get(id) || [];
            // Sufit: odmawiamy zamiast wypychać najstarsze — cicha utrata polecenia
            // sterującego byłaby gorsza od uczciwego „nie zmieściło się".
            if (queue.length >= this._maxMessagesPerTask) return false;
            const message = this._mask ? this._mask(raw) : raw;
            queue.push(message);
            this._messages.set(id, queue);
            // Ślad idzie tą samą drogą co reszta kroków (także do trace.log) — NOWY TYP
            // zdarzenia, nie zmiana formatu linii. Do śladu wchodzi sama DŁUGOŚĆ:
            // treść polecenia jest już w transkrypcie suba, w logu nie musi być drugi raz.
            this.step(task, 'user.message', { chars: message.length });
            return true;
        } catch (e) {
            log.warn('SubTaskRegistry', 'postMessage() padł:', e);
            return false;
        }
    }

    /**
     * F5: zdejmij wszystkie czekające wiadomości do biegu (woła runner między iteracjami).
     * Zabiera je z kolejki — druga próba na tym samym biegu odda pustą tablicę.
     */
    takeMessages(id: string): string[] {
        try {
            const queue = this._messages.get(id);
            if (!queue || queue.length === 0) return [];
            this._messages.delete(id);
            return queue;
        } catch (e) {
            log.warn('SubTaskRegistry', 'takeMessages() padł:', e);
            return [];
        }
    }

    getTask(id: string): SubTask | undefined {
        return this._tasks.get(id);
    }

    /**
     * Zamknięcie/archiwizacja sesji czatu (decyzja Kuby 2026-08-15: biegi subów należą do
     * SESJI): wymiata z rejestru ZAKOŃCZONE biegi tej sesji — nie mają już czego pokazywać
     * w nowej rozmowie. Biegi `running` zostają (sieroty widać na pasku i da się je ubić).
     * Zwraca liczbę usuniętych. Fail-soft jak reszta metod.
     */
    pruneSession(sessionPath: string): number {
        try {
            if (!sessionPath) return 0;
            let removed = 0;
            for (const [id, task] of [...this._tasks]) {
                if (task.status === 'running') continue;
                if ((task.origin?.sessionPath || '') !== sessionPath) continue;
                this._tasks.delete(id);
                this._traceScopes.delete(id);
                this._aborts.delete(id);
                this._messages?.delete?.(id);
                removed++;
            }
            return removed;
        } catch (e) {
            log.warn('SubTaskRegistry', 'pruneSession() padł (nieszkodliwie):', e);
            return 0;
        }
    }

    /** Wszystkie znane biegi w kolejności powstania (Map trzyma kolejność wstawienia). */
    list(): SubTask[] {
        return [...this._tasks.values()];
    }

    /** Retencja: nadmiarowe ZAKOŃCZONE biegi wylatują od najstarszego; `running` zostaje. */
    private _evictOldDone(): void {
        let done = 0;
        for (const task of this._tasks.values()) {
            if (task.status !== 'running') done++;
        }
        let toDrop = done - this._maxDone;
        if (toDrop <= 0) return;
        for (const [id, task] of this._tasks) {
            if (toDrop <= 0) break;
            if (task.status === 'running') continue;
            this._tasks.delete(id);
            this._traceScopes.delete(id);
            this._aborts.delete(id);
            this._messages.delete(id);
            toDrop--;
        }
    }

    /**
     * Sprzątanie przy `onunload` pluginu — odpina konsumentów i puszcza pamięć.
     *
     * ⚠️ Z7: `dispose()` NICZEGO NIE ZATRZYMUJE — puszcza uchwyty, nie woła ich. Zatrzymanie
     * biegów to `stopAll()`, wołane PRZED tą metodą (patrz `PKMPlugin.onunload`). Sama metoda
     * zostaje best-effort i idempotentna: wolno ją zawołać dwa razy i nie ma prawa rzucić.
     */
    dispose(): void {
        try {
            this.events.removeAllListeners();
            this._tasks.clear();
            this._traceScopes.clear();
            this._aborts.clear();
            this._messages.clear();
        } catch (e) {
            log.warn('SubTaskRegistry', 'dispose() padł:', e);
        }
    }
}
