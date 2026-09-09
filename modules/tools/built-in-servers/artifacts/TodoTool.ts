/**
 * TodoTool — gatunek 2 (todo): prymitywne, jednorazowe zadania agenta.
 *
 * Osobne narzędzie od rodziny `artifact_*` (gatunek 1). Celowo bezmyślnie prosty kontrakt
 * (lista + odhacz), bo agent używa go non stop — samoorganizacja pracy „na oczach".
 *
 * Plik JEDNORAZOWY: `.pkm-assistant/artifacts/todo/<agent>-<sessionId>.md`. Dotfolder → Vault API go
 * NIE widzi, więc idziemy ADAPTEREM (wzór AgentMemory). Silnik = TEN SAM parser/patcher co gatunek 1
 * (`artifactParser`) — „wspólna mechanika, nie sklejanie gatunków". `finish` (albo nowa sesja)
 * kasuje plik; stan i tak leci do trace.log przez tool.post.
 *
 * `todo` jest default ON dla nowych agentów (wyjątek z grupy `artifacts` w `toolAxis`) — samoorganizacja
 * bez zapisu do widocznego vaulta usera; `artifact_*` zostają OFF konserwatywnie.
 */
import { t } from '../../../../core/i18n/index.js';
import { log } from '../../../../core/utils/Logger.js';
// Self-append: odczyt-najpierw WŁASNEGO pliku listy przed patchem — eksport z barrela, jak
// w modules/memory. Duck-typuje adapter, więc `TodoAdapter` (poniżej) pasuje bez castowania.
import { readIfExists } from '../../../../core/index.js';
// Silnik treści todo = TEN SAM parser/patcher co gatunek 1, przez publiczne
// drzwi modułu artifacts (barrel jest node-safe).
import { parseArtifact, applyPatch } from '../../../artifacts/index.js';

export const TODO_FOLDER = '.pkm-assistant/artifacts/todo';
const TODO_SECTION = 'Zadania';

/** Minimalny widok DataAdaptera (dotfolder — Vault API go nie widzi). */
export interface TodoAdapter {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    remove(path: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    list(path: string): Promise<{ files?: string[] } | null | undefined>;
}

/** Pojedyncze zadanie w chudym stanie listy (`done` = alias `checked` dla live-widoku). */
export interface TodoItem {
    blockId: string | null;
    text: string;
    checked: boolean;
    done: boolean;
}

/** Chudy stan listy oddawany modelowi i UI. */
interface TodoState {
    title: string | null;
    items: TodoItem[];
    done: number;
    total: number;
    finished?: boolean;
}

/** Zwrotka operacji na pliku: stan + ewentualne błędy patcha. */
interface TodoOpResult {
    state: TodoState;
    errors?: Array<{ code?: string; message?: string }>;
    missing?: boolean;
    /** `finish`: kasowanie pliku PADŁO (komunikat oryginalnego błędu). Brak pola = posprzątane. */
    removeError?: string;
}

/** Argumenty `todo` wg `inputSchema` (+ ukryta akcja `list` dla aliasu `chat_todo`). */
interface TodoToolArgs {
    action?: string;
    items?: unknown;
    text?: unknown;
    blockId?: unknown;
    title?: string;
    _invocationAgentName?: unknown;
    [extra: string]: unknown;
}

/** Minimalny widok pluginu: adapter vaulta, tożsamość agenta i pola cache'u todo. */
export interface TodoToolPlugin {
    app?: { vault?: { adapter?: TodoAdapter } } | null;
    agentManager?: {
        getActiveAgent?(): { name?: string } | null | undefined;
        getActiveMemory?(): { activeSessionPath?: string } | null | undefined;
        getAgentMemory?(name: string): { activeSessionPath?: string } | null | undefined;
    } | null;
    _todoStore?: TodoFileStore;
    _todoUpdatedAt?: number;
}

/** Nazwa pliku bezpieczna dla systemu plików (agent + sessionId). */
function safeSlug(s: unknown): string {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
}

/** Spłaszcz element do jednej linii (todo to prosty tekst, nie akapit). */
function flattenItem(s: unknown): string {
    return String(s ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
}

/** Element wejściowy listy: goły string albo obiekt z tekstem pod jednym z trzech kluczy. */
type TodoItemInput = string | { text?: string; action?: string; label?: string } | null | undefined;

/** Znormalizuj wejściowe elementy (stringi lub {text}) do listy niepustych stringów. */
function normalizeItems(items: unknown): string[] {
    if (!Array.isArray(items)) return [];
    return items
        .map((it: TodoItemInput) => (typeof it === 'string' ? it : (it && (it.text || it.action || it.label)) || ''))
        .map(flattenItem)
        .filter(Boolean);
}

/**
 * Krótki, czytelny opis `cause` z `readIfExists` — do wklejenia w komunikat błędu zamiast
 * suchego „nie mogę odczytać X" bez powodu. Ta sama logika co `causeText` w `AgentMemory.ts` /
 * `CostLog.ts` — świadoma kopia (wzór `_enqueuePathWrite` w tym pliku), nie wspólny moduł:
 * dwa moduły to za mało na promocję do `core/` (ADR 003 — próg to ≥3 moduły).
 */
function causeText(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    if (cause === undefined) return 'brak szczegółów — adapter bez metody read()';
    return String(cause);
}

/**
 * TodoFileStore — CRUD jednorazowego pliku todo przez adapter (dotfolder). Testowalny z mock adapterem.
 * Silnik treści = `artifactParser` (parseArtifact/applyPatch), ten sam co gatunek 1.
 */
export class TodoFileStore {
    declare adapter: TodoAdapter;
    declare _now: () => Date;
    /** Łańcuchy zapisu per ŚCIEŻKA pliku (klucz = ten sam string, który leci do adaptera). */
    declare _writeQueues: Map<string, Promise<void>>;

    /**
     * @param deps.adapter - vault.adapter (exists/read/write/remove/mkdir/list)
     * @param deps.now - () => Date (wstrzykiwalny zegar)
     */
    constructor({ adapter, now }: { adapter?: TodoAdapter; now?: () => Date } = {}) {
        // Asercja, nie guard: `adapter` jest w praktyce zawsze podawany (narzędzie sprawdza go
        // przed konstrukcją), a domyślne `= {}` zostaje 1:1 z JS.
        this.adapter = adapter as TodoAdapter;
        this._now = typeof now === 'function' ? now : () => new Date();
        this._writeQueues = new Map();
    }

    path(agent: string, sessionId: string): string {
        return `${TODO_FOLDER}/${safeSlug(agent)}-${safeSlug(sessionId)}.md`;
    }

    /**
     * Serializuj read-modify-write na JEDNEJ ścieżce (wzór `AgentMemory._enqueuePathWrite` —
     * świadoma kopia, nie wspólny moduł).
     *
     * DLACZEGO: `AgentLoop` puszcza wszystkie tool_calle jednej tury przez `Promise.all`,
     * a dwa `todo` w turze to domyślny tryb pracy modelu. Bez kolejki obie operacje czytają
     * ten sam nieświeży plik i druga kasuje zmianę pierwszej (a `add_item` potrafi nadać
     * ten sam block-id dwóm różnym zadaniom) — bez śladu błędu.
     *
     * Kolejny wołacz startuje dopiero, gdy poprzedni się rozstrzygnie. Ogon NIGDY nie odrzuca,
     * więc wywrotka poprzednika nie zatyka kolejki, a błąd operacji wraca do JEJ wołacza.
     * Wpis mapy znika, gdy łańcuch się opróżni (mapa nie rośnie w nieskończoność).
     * @param path - klucz kolejki = ścieżka pliku
     * @param fn - operacja do wykonania pod lockiem
     * @returns to, co zwróci (albo rzuci) `fn`
     */
    _enqueuePathWrite<T>(path: string, fn: () => Promise<T>): Promise<T> {
        const prev = this._writeQueues.get(path) || Promise.resolve();
        const run = prev.then(() => fn(), () => fn());
        const tail = run.then(() => {}, () => {});
        this._writeQueues.set(path, tail);
        void tail.then(() => {
            if (this._writeQueues.get(path) === tail) this._writeQueues.delete(path);
        });
        return run;
    }

    /**
     * Stan PO zapisie, odczytany z DYSKU — nie z lokalnie policzonej kopii.
     * Model ma widzieć to, co realnie leży w pliku, także gdy dopisał tam coś ktoś spoza
     * naszej kolejki. Padnięty odczyt kontrolny nie wywraca udanego zapisu: wtedy oddajemy
     * to, co właśnie zapisaliśmy.
     * ⚠️ Wołać tylko WEWNĄTRZ `_enqueuePathWrite` (odczyt bez locka = znowu wyścig).
     */
    async _stateAfterWrite(path: string, written: string, title: string | undefined): Promise<TodoState> {
        try {
            const onDisk = await this.adapter.read(path);
            if (typeof onDisk === 'string' && onDisk) return this._toState(onDisk, title);
        } catch { /* odczyt kontrolny padł — zapis i tak przeszedł */ }
        return this._toState(written, title);
    }

    async _ensureFolder(): Promise<void> {
        try {
            if (!(await this.adapter.exists(TODO_FOLDER))) await this.adapter.mkdir(TODO_FOLDER);
        } catch { /* wyścig / już istnieje */ }
    }

    _emptyMarkdown(): string {
        return `---\ntyp: todo\nzaktualizowano: ${this._now().toISOString()}\n---\n\n## ${TODO_SECTION}\n`;
    }

    /** Utwórz świeżą listę (nadpisuje istniejącą) + posprzątaj stare pliki tego agenta. */
    async create(agent: string, sessionId: string, items: unknown, { title }: { title?: string } = {}): Promise<TodoOpResult> {
        const p = this.path(agent, sessionId);
        return this._enqueuePathWrite(p, async () => {
            await this._ensureFolder();
            await this.clearForAgent(agent);
            let md = this._emptyMarkdown();
            const ops = normalizeItems(items).map(text => ({ op: 'add_item', heading: TODO_SECTION, text }));
            const res = applyPatch(md, ops);
            md = res.markdown;
            await this.adapter.write(p, md);
            return { state: await this._stateAfterWrite(p, md, title), errors: res.errors };
        });
    }

    /**
     * Odczytaj stan (null-safe — brak pliku → pusta lista).
     * Czysty odczyt, świadomie POZA kolejką: niczego nie nadpisuje, więc nie ma czego
     * serializować (a `create`/`patch` i tak oddają stan odczytany z dysku po zapisie).
     */
    async read(agent: string, sessionId: string, { title }: { title?: string } = {}): Promise<TodoOpResult> {
        const p = this.path(agent, sessionId);
        if (!(await this.adapter.exists(p))) return { state: this._toState(this._emptyMarkdown(), title), missing: true };
        const md = await this.adapter.read(p);
        return { state: this._toState(md, title), missing: false };
    }

    /**
     * Nałóż opsy patcha na plik (tworzy pusty, jeśli brak). Zwraca stan + błędy patcha.
     * CAŁY read-modify-write siedzi w kolejce per ścieżka — inaczej równoległe wywołania
     * tury czytają ten sam nieświeży plik i kasują sobie zmiany.
     */
    async patch(agent: string, sessionId: string, ops: object[], { title }: { title?: string } = {}): Promise<TodoOpResult> {
        const p = this.path(agent, sessionId);
        return this._enqueuePathWrite(p, async () => {
            await this._ensureFolder();
            // Self-append: wzorzec `(await exists(p)) ? read(p) : emptyMarkdown()` na Dysku
            // Google (exists()===false DLA PLIKU, KTÓRY JEST) zamieniałby CAŁĄ listę todo agenta
            // pustym szkieletem — patch dopisywałby/odznaczał na PUSTYM stanie, więc reszta
            // zadań znikałaby z dysku przy pierwszym patchu po kłamstwie.
            // `readIfExists` czyta NAJPIERW, więc `exists()` nie ma szans przeciąć drogi do treści.
            const probe = await readIfExists(this.adapter, p);
            if (probe.state === 'unreadable') {
                // Sprzeczne sygnały na WŁASNYM pliku listy — nadpisanie skasowałoby zadania,
                // których nie widzimy. Fail-closed: rzut leci istniejącym wzorcem narzędzia —
                // `execute` ma catch, który zamienia go w {isError:true, error} dla modelu —
                // i NIE piszemy pliku.
                throw new Error(`todo: nie mogę odczytać istniejącej listy — nie nadpisuję: ${p} (${causeText(probe.cause)})`);
            }
            let md = probe.state === 'content' ? probe.content : this._emptyMarkdown();
            const res = applyPatch(md, ops);
            md = this._touch(res.markdown);
            await this.adapter.write(p, md);
            return { state: await this._stateAfterWrite(p, md, title), errors: res.errors };
        });
    }

    /**
     * Zamknij listę — skasuj plik. Też przez kolejkę: kasacja nie może wyprzedzić
     * zakolejkowanego zapisu (ani zapis wskrzesić pliku po kasacji).
     *
     * Brak pliku = sukces (idempotencja). Ale realny błąd kasowania NIE jest sukcesem:
     * wraca w `removeError`, bo posprzątanie po sobie jest tu JEDYNYM zadaniem akcji —
     * `catch` nie wolno tu zjeść pod komentarzem „już nie ma".
     */
    async finish(agent: string, sessionId: string): Promise<TodoOpResult> {
        const p = this.path(agent, sessionId);
        return this._enqueuePathWrite(p, async () => {
            const empty = { title: null, items: [] as TodoItem[], done: 0, total: 0 };
            try {
                if (await this.adapter.exists(p)) await this.adapter.remove(p);
            } catch (e) {
                return {
                    state: { ...empty, finished: false },
                    removeError: (e as Error)?.message || String(e),
                };
            }
            return { state: { ...empty, finished: true } };
        });
    }

    /** Skasuj wszystkie pliki todo danego agenta (nowa sesja / higiena). */
    async clearForAgent(agent: string): Promise<void> {
        const prefix = `${safeSlug(agent)}-`;
        try {
            if (!(await this.adapter.exists(TODO_FOLDER))) return;
            const listed = await this.adapter.list(TODO_FOLDER);
            for (const fp of (listed?.files || [])) {
                const name = fp.split('/').pop() as string;
                if (name.startsWith(prefix) && name.endsWith('.md')) {
                    try { await this.adapter.remove(fp); } catch { /* ignore */ }
                }
            }
        } catch { /* brak folderu / nieczytelny — pomiń */ }
    }

    /** Odśwież `zaktualizowano` we frontmatterze (bez ruszania ciała). */
    _touch(md: string): string {
        return String(md).replace(/^(---\n[\s\S]*?zaktualizowano:).*$/m, `$1 ${this._now().toISOString()}`);
    }

    /** Zbuduj chudy stan listy z markdownu (sekcja Zadania → checkboxy). */
    _toState(md: string, title: string | undefined): TodoState {
        const parsed = parseArtifact(md);
        const section = parsed.sections.find(s => s.heading.toLowerCase() === TODO_SECTION.toLowerCase());
        const items = (section?.items || []).map(i => ({
            blockId: i.blockId || null,
            text: i.text,
            checked: !!i.checked,
            done: !!i.checked, // alias dla ToolCallDisplay/live-widoku
        }));
        return {
            title: title || null,
            items,
            done: items.filter(i => i.checked).length,
            total: items.length,
        };
    }
}

/**
 * Rozwiąż sessionId rozmowy WOŁAJĄCEGO agenta (basename aktywnej sesji; fallback stały).
 *
 * Tożsamość bierze się z zaufanego `_invocationAgentName`, nie z globalnego aktywnego —
 * inaczej `todo` wywołane przez suba w tle po przełączeniu zakładki kluczowałoby plik sesją
 * obcego agenta.
 */
function resolveSessionId(plugin: TodoToolPlugin | null | undefined, agentName: string | null): string {
    try {
        const mem = agentName
            ? plugin?.agentManager?.getAgentMemory?.(agentName)
            : plugin?.agentManager?.getActiveMemory?.();
        const p = mem?.activeSessionPath;
        if (p) return (p.split('/').pop() as string).replace(/\.md$/i, '');
    } catch { /* brak pamięci */ }
    return 'current';
}

export function createTodoTool() {
    return {
        name: 'todo',
        serverName: 'artifacts',
        description: t('mcp.todo.desc'),
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['create', 'check', 'uncheck', 'add', 'finish'],
                    description: t('mcp.todo.param.action'),
                },
                items: {
                    type: 'array',
                    items: { type: 'string' },
                    description: t('mcp.todo.param.items'),
                },
                text: { type: 'string', description: t('mcp.todo.param.text') },
                blockId: { type: 'string', description: t('mcp.todo.param.blockId') },
                title: { type: 'string', description: t('mcp.todo.param.title') },
            },
            required: ['action'],
        },
        execute: async (args: TodoToolArgs, _app: unknown, plugin: TodoToolPlugin) => {
            const adapter = plugin?.app?.vault?.adapter;
            if (!adapter) return { isError: true, error: t('mcp.todo.no_adapter') };
            const store = plugin._todoStore || (plugin._todoStore = new TodoFileStore({ adapter }));

            const agent = (args?._invocationAgentName as string) || plugin.agentManager?.getActiveAgent?.()?.name || 'agent';
            const sessionId = resolveSessionId(plugin, (args?._invocationAgentName as string) || null);
            const action = args?.action;
            const title = args?.title;

            try {
                let out: TodoOpResult;
                if (action === 'create') {
                    out = await store.create(agent, sessionId, args.items || [], { title });
                } else if (action === 'add') {
                    if (!flattenItem(args.text)) return { isError: true, error: t('mcp.todo.text_required') };
                    out = await store.patch(agent, sessionId, [{ op: 'add_item', heading: TODO_SECTION, text: flattenItem(args.text) }], { title });
                } else if (action === 'check' || action === 'uncheck') {
                    if (!args.blockId) return { isError: true, error: t('mcp.todo.blockid_required') };
                    const op = action === 'check' ? 'check_item' : 'uncheck_item';
                    out = await store.patch(agent, sessionId, [{ op, blockId: String(args.blockId) }], { title });
                } else if (action === 'finish') {
                    out = await store.finish(agent, sessionId);
                    if (out.removeError) {
                        // Bez `type:'todo'` — live-widok ma ZOSTAĆ na żywej liście, bo ona nadal leży
                        // na dysku. Meldunek „zakończono" byłby tu zwykłym kłamstwem.
                        log.error('TodoTool', `finish: nie udało się skasować ${store.path(agent, sessionId)}`, out.removeError);
                        return {
                            isError: true,
                            success: false,
                            error: t('mcp.todo.finish_failed', { error: out.removeError }),
                            cause: out.removeError,
                        };
                    }
                    plugin._todoUpdatedAt = Date.now();
                    return { type: 'todo', ...out.state };
                } else if (action === 'list') {
                    // Read-only: zwróć bieżący stan (m.in. dla aliasu chat_todo action:"list"/"remove_item").
                    out = await store.read(agent, sessionId, { title });
                    return { type: 'todo', ...out.state };
                } else {
                    return { isError: true, error: t('mcp.plan.unknown_action', { action }) };
                }

                plugin._todoUpdatedAt = Date.now();
                const errors = (out.errors || []).map(e => ({ code: e.code, message: e.message }));
                return { type: 'todo', ...out.state, ...(errors.length ? { errors } : {}) };
            } catch (e) {
                return { isError: true, error: (e as Error).message };
            }
        },
    };
}
