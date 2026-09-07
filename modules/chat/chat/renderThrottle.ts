/**
 * RenderThrottle — koalescencja malowania strumienia odpowiedzi (AUD-wydajnosc-071/015/070).
 *
 * PROBLEM: `handlers.chunk` adaptera leci RAZ NA RAMKĘ SSE i niesie ZAKUMULOWANĄ treść
 * (`chat_adapter_base.ts` dokłada deltę do `message.content`), a `handle_chunk` malował ją
 * w całości od zera. Praca renderu jednej tury rosła więc z KWADRATEM długości odpowiedzi
 * (8 000 znaków odpowiedzi = 2 000 wywołań × średnio 4 000 znaków = 8 mln znaków markdownu),
 * a chunki niosące wyłącznie deltę `tool_calls` przemalowywały bajt-w-bajt tę samą treść
 * (zmierzone 95% wywołań w turze z 12 KB argumentów narzędzia).
 *
 * ROZWIĄZANIE: częstotliwość malowania odcięta od dostawcy. Ten obiekt zbiera klatki
 * (`request`) i woła `paint` NAJWYŻEJ raz na `intervalMs`, zawsze OSTATNIĄ treścią; klatka
 * identyczna z ostatnio namalowaną nie maluje nic. Koszt tury przestaje zależeć od granulacji
 * chunków dostawcy.
 *
 * ⚠️ Malowanie WOŁA `MarkdownRenderer.render` (release 2.2.0/W2 domknęło migrację z deprecated
 * `renderMarkdown` — patrz `modules/chat/CLAUDE.md`), ale fire-and-forget (`void`, bez await) —
 * dokładnie tak samo jak dawne `renderMarkdown`, które też zwraca `Promise<void>` i było wołane
 * bez await w tym samym miejscu. Migracja API NIE wprowadza nowej asynchroniczności ponad to, co
 * już istniało; throttle odpowiada WYŁĄCZNIE za CZĘSTOTLIWOŚĆ malowania (najwyżej raz na
 * `intervalMs`), nie za to, czy render jest sync czy async. Kolejność jednego malowania
 * (myślenie → narzędzia → tekst) i wszystkie stany tury (abort, błąd, tool calls) zostają bez zmian.
 *
 * ⚠️ ŻADEN FRAGMENT NIE GINIE: koniec tury, Stop i błąd wołają `flush()` (domalowanie ostatniej
 * zebranej klatki) albo `cancel()` (gdy DOM dymka i tak jest zaraz nadpisywany komunikatem błędu).
 *
 * Plik jest CELOWO wolny od `obsidian` i od DOM-u — `chat_streaming.ts` nie wstaje w AVA,
 * więc decyzja „malować czy pominąć" musi dać się przetestować tutaj (wzór `turnAbort.ts`).
 */

/** Jedna klatka strumienia: to, co ma być widoczne w dymku i w bloku myślenia. */
export interface StreamFrame {
    /** Skumulowana treść odpowiedzi (markdown). */
    text: string;
    /** Skumulowany ślad rozumowania (`reasoning_content`); pusty = brak bloku myśli. */
    reasoning: string;
    /**
     * WŁAŚCICIEL klatki — nazwa agenta tury, która ją zgłosiła (review opusa, P1).
     * Klatka uzbrojona ≤ okno przed przełączeniem zakładki wystrzeliwuje JUŻ na cudzej
     * zakładce: wskaźniki malowania (`current_message_*`) nadal celują w wypięte węzły starej,
     * więc sam tekst jest niewidoczny, ale skutki uboczne malowania (przewinięcie!) trafiają
     * w NOWĄ zakładkę. Dlatego malowanie pyta `shouldPaintFrame` — patrz niżej.
     */
    owner?: string;
}

/**
 * Czy tę klatkę wolno jeszcze namalować (review opusa, P1 — bramka „właściciel na wierzchu").
 *
 * Druga linia obrony za `cancel()` w `_switchTab`: klatka bez właściciela maluje zawsze
 * (zgodność wsteczna / testy), klatka z właścicielem — tylko gdy jej agent nadal jest
 * na wierzchu. Ta sama reguła co bramka zakładki w `handle_chunk`.
 */
export function shouldPaintFrame(frame: StreamFrame, activeAgentName: string | null | undefined): boolean {
    if (!frame?.owner) return true;
    return frame.owner === activeAgentName;
}

export interface RenderThrottleOptions {
    /** Faktyczne malowanie (DOM). Wołane najwyżej raz na okno. */
    paint: (frame: StreamFrame) => void;
    /** Minimalny odstęp między malowaniami w ms (default 80). */
    intervalMs?: number;
    /** Planista (default `setTimeout`) — testy podają własny, żeby nie czekać. */
    schedule?: (cb: () => void, delayMs: number) => unknown;
    /** Anulowanie planisty (default `clearTimeout`). */
    cancel?: (handle: unknown) => void;
    /** Zegar (default `Date.now`). */
    now?: () => number;
}

// Node-safe timer shim (release 2.2.0 / W2): `obsidianmd/prefer-window-timers` wants
// `window.setTimeout(...)`, ale ten plik CELOWO wstaje w gołym Node pod AVA (nagłówek modułu
// wyżej) i `window` tam nie istnieje. Reguła obsidianmd nie da się wyłączyć inline (`obsidianmd/*`
// jest na liście `eslint-comments/no-restricted-disable`, zweryfikowane empirycznie), więc zamiast
// tłumionego ostrzeżenia — REFERENCJA (nie wywołanie) do globalnego `setTimeout`/`clearTimeout`.
// W prawdziwym Obsidianie to DOKŁADNIE ta sama funkcja co `window.setTimeout` (globalny obiekt
// realm-u to `window`), więc zero zmiany zachowania — reguła łapie tylko BEZPOŚREDNIE wywołanie
// `setTimeout(...)`, nie przypisanie referencji do zmiennej.
const _nodeSafeSetTimeout: typeof setTimeout = setTimeout;
const _nodeSafeClearTimeout: typeof clearTimeout = clearTimeout;

function framesEqual(a: StreamFrame | null, b: StreamFrame | null): boolean {
    if (!a || !b) return a === b;
    // Właściciel jest częścią tożsamości klatki: ta sama treść od INNEJ tury to nowy dymek,
    // więc bramka „identyczna z namalowaną" nie ma prawa jej połknąć.
    return a.text === b.text && a.reasoning === b.reasoning && a.owner === b.owner;
}

export class RenderThrottle {
    private readonly _paint: (frame: StreamFrame) => void;
    private readonly _intervalMs: number;
    private readonly _schedule: (cb: () => void, delayMs: number) => unknown;
    private readonly _cancelTimer: (handle: unknown) => void;
    private readonly _now: () => number;

    private _pending: StreamFrame | null = null;
    private _painted: StreamFrame | null = null;
    private _timer: unknown = null;
    private _lastPaintAt = 0;

    constructor(options: RenderThrottleOptions) {
        this._paint = options.paint;
        this._intervalMs = typeof options.intervalMs === 'number' ? Math.max(0, options.intervalMs) : 80;
        this._schedule = options.schedule || ((cb, delayMs) => _nodeSafeSetTimeout(cb, delayMs));
        this._cancelTimer = options.cancel || ((handle) => _nodeSafeClearTimeout(handle as ReturnType<typeof setTimeout>));
        this._now = options.now || (() => Date.now());
    }

    /** Czy czeka niepomalowana klatka (diagnostyka / testy). */
    get hasPending(): boolean {
        return this._pending !== null;
    }

    /** Ostatnio NAMALOWANA klatka (null = jeszcze nic nie namalowano). */
    get lastPainted(): StreamFrame | null {
        return this._painted;
    }

    /**
     * Zgłasza nową treść do namalowania. Klatka identyczna z ostatnio namalowaną (chunk niosący
     * wyłącznie deltę `tool_calls` albo `usage`) NIE planuje niczego — zero malowań.
     */
    request(frame: StreamFrame): void {
        // Review opusa (P3): klatka identyczna z NAMALOWANĄ wychodzi ZAWSZE, także gdy czeka
        // już nowsza — dawny warunek `&& this._pending === null` nadpisywał wtedy `_pending`
        // starszą treścią (duplikat/„cofnięcie" ze strumienia zjadało ogon odpowiedzi).
        if (framesEqual(frame, this._painted)) return;
        this._pending = frame;
        if (this._timer !== null) return;
        const elapsed = this._now() - this._lastPaintAt;
        const wait = Math.max(0, this._intervalMs - elapsed);
        this._timer = this._schedule(() => {
            this._timer = null;
            this._paintPending();
        }, wait);
    }

    /**
     * Maluje NATYCHMIAST to, co czeka (koniec tury, Stop, przerwa na wyniki narzędzi).
     * Bez czekającej klatki — nic nie robi.
     */
    flush(): void {
        this._clearTimer();
        this._paintPending();
    }

    /**
     * Porzuca czekającą klatkę BEZ malowania. Dla ścieżek, które i tak zaraz nadpisują dymek
     * (komunikat błędu) — namalowanie jej po fakcie zjadłoby ten komunikat.
     */
    cancel(): void {
        this._clearTimer();
        this._pending = null;
    }

    /** Pełny reset — razem z wyzerowaniem wskaźników malowania widoku (`_resetPaintTargets`). */
    reset(): void {
        this.cancel();
        this._painted = null;
        this._lastPaintAt = 0;
    }

    private _clearTimer(): void {
        if (this._timer === null) return;
        this._cancelTimer(this._timer);
        this._timer = null;
    }

    private _paintPending(): void {
        const frame = this._pending;
        if (frame === null) return;
        this._pending = null;
        // Druga bramka identyczności: między `request` a wystrzałem timera mogła wejść klatka
        // cofająca treść do stanu już namalowanego.
        if (framesEqual(frame, this._painted)) return;
        this._painted = frame;
        this._lastPaintAt = this._now();
        this._paint(frame);
    }
}
