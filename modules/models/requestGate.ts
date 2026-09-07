/**
 * requestGate — bramka równoległości requestów do modelu, per platforma.
 *
 * Powód (Zwis subagentow, lokalny most, 2026, incydent 2026-08-11): lokalny most
 * (proxy zgodne z API LM Studio) przy KILKU połączeniach otwartych naraz potrafi
 * przyjąć request i nie oddać ani bajta — bez błędu, w nieskończoność. Delegate
 * z listą tasków strzela wszystkie suby w tej samej milisekundzie, więc każda
 * delegacja wielozadaniowa była ruletką. Most i tak przerabia requesty po kolei
 * (zmierzone: 2 równoległe = 2x czas pojedynczego), więc kolejka po naszej
 * stronie nic nie kosztuje, a eliminuje jedyny scenariusz, który go kładzie.
 *
 * Chmurowe API bramki NIE dostają (limit 0 = bez bramki) — tam równoległość
 * jest stanem normalnym, a przeciążenie kończy się głośnym 429, nie cichym
 * zwisem. Decyzja Kuby 2026-08-11: mechanizm generyczny, domyślki różne.
 *
 * ZERO importów z `obsidian` i innych modułów — czysty stan w pamięci procesu,
 * w pełni testowalny node'em. Konsument: `ChatModel.stream` (bramka wokół wywołania
 * dostawcy) + `ChatModel.stopStream` (anulowanie biletu czekającego w kolejce).
 */

/** Bilet z bramki. Kontrakt użycia:
 *  1. `await admitted` — true = jedziesz (slot zajęty), false = anulowano w kolejce.
 *  2. Po skończonej robocie (sukces LUB błąd) — `release()`, zawsze, np. w `finally`.
 *  3. `cancel()` działa tylko na bilet CZEKAJĄCY w kolejce (biegnącego nie dotyka —
 *     biegnący request ubija się przez abort strumienia, a `release()` zwalnia slot).
 */
export interface GateTicket {
    admitted: Promise<boolean>;
    /** true = bilet trafił do kolejki (ktoś już trzyma slot) — przydatne do logów. */
    queued: boolean;
    cancel(): void;
    release(): void;
}

/** Opcje biletu. `priority`: wyższa liczba = wcześniejszy wjazd z kolejki (default 0). */
export interface GateOptions {
    priority?: number;
}

type Waiter = {
    cancelled: boolean;
    /** Klasa pierwszeństwa w kolejce (F2: główny czat 1, sub-agent 0). */
    priority: number;
    admit: () => void;
    reject: () => void;
};

type GateState = { active: number; waiters: Waiter[] };

const _gates = new Map<string, GateState>();

/**
 * Zajmij slot w bramce `key` (np. nazwa platformy) o pojemności `limit`.
 * `limit <= 0` = bramka wyłączona: bilet od ręki, release jest no-opem.
 *
 * `opts.priority` (F2 „delegacja w tle"): przy zwalnianiu slotu pierwszeństwo ma bilet
 * o NAJWYŻSZYM priorytecie, a w ramach jednej klasy — kolejność zgłoszeń (FIFO).
 * Po co: sub-agent odpalony w tle nie może kazać użytkownikowi czekać na własną
 * odpowiedź w czacie. Główny czat wchodzi z priorytetem 1, sub z 0 — patrz
 * `ChatModel._gatePriority` i `DelegateTool._executeSubAgent`.
 */
export function acquireSlot(key: string, limit: number, opts: GateOptions = {}): GateTicket {
    if (!Number.isFinite(limit) || limit <= 0) {
        return { admitted: Promise.resolve(true), queued: false, cancel() {}, release() {} };
    }

    let state = _gates.get(key);
    if (!state) {
        state = { active: 0, waiters: [] };
        _gates.set(key, state);
    }
    const s = state;

    let holdsSlot = false;  // bilet aktualnie trzyma slot
    let finished = false;   // released albo cancelled — stan terminalny

    const releaseSlot = () => {
        if (finished) return;
        finished = true;
        if (!holdsSlot) return;
        holdsSlot = false;
        s.active = Math.max(0, s.active - 1);
        _admitNext(s);
    };

    // Wolny slot — wjazd od ręki.
    if (s.active < limit) {
        s.active++;
        holdsSlot = true;
        return {
            admitted: Promise.resolve(true),
            queued: false,
            // Biegnącego requestu cancel nie dotyka — patrz kontrakt w nagłówku.
            cancel() {},
            release: releaseSlot,
        };
    }

    // Kolejka.
    const priority = Number.isFinite(opts.priority) ? Number(opts.priority) : 0;
    let resolveAdmitted!: (ok: boolean) => void;
    const admitted = new Promise<boolean>(res => { resolveAdmitted = res; });
    const waiter: Waiter = {
        cancelled: false,
        priority,
        admit: () => { holdsSlot = true; resolveAdmitted(true); },
        reject: () => { resolveAdmitted(false); },
    };
    _enqueue(s, waiter);

    return {
        admitted,
        queued: true,
        cancel() {
            if (finished || holdsSlot) return;
            finished = true;
            waiter.cancelled = true;
            waiter.reject();
        },
        release: releaseSlot,
    };
}

/**
 * Wstaw bilet do kolejki wg priorytetu — ZA wszystkimi o priorytecie >= jego własnego.
 *
 * Porządkujemy PRZY WSTAWIANIU, a nie przy zdejmowaniu: `_admitNext` zostaje najprostszym
 * możliwym `shift()`, a stabilność (FIFO w ramach jednej klasy) wynika z konstrukcji,
 * nie z własności sortowania.
 */
function _enqueue(s: GateState, waiter: Waiter): void {
    let i = s.waiters.length;
    while (i > 0 && s.waiters[i - 1].priority < waiter.priority) i--;
    s.waiters.splice(i, 0, waiter);
}

function _admitNext(s: GateState): void {
    while (s.waiters.length > 0) {
        const w = s.waiters.shift()!;
        if (w.cancelled) continue;
        s.active++;
        w.admit();
        return;
    }
}

/** Podgląd stanu bramki (logi/diagnostyka). */
export function gateSnapshot(key: string): { active: number; queued: number } {
    const s = _gates.get(key);
    return s ? { active: s.active, queued: s.waiters.length } : { active: 0, queued: 0 };
}

export const __test__ = {
    reset(): void { _gates.clear(); },
};
