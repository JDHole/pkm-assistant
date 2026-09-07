/**
 * autoTurnChain — sufit ŁAŃCUCHA auto-tur po wyniku suba (werdykt Kuby, 2026-08-16).
 *
 * PROBLEM: wynik suba odpalonego w tle wraca do czatu jako AUTO-TURA — `_deliverSubTaskResult`
 * (chat_streaming.ts) woła `send_message({injectedText})` SAM, bez udziału człowieka, gdy wynik
 * trafia na aktywną, bezczynną zakładkę. Bramki wejścia (zakładka istnieje/aktywna, nie trwa
 * inna tura, po Stopie nic nie startuje) pilnują POJEDYNCZEGO strzału, ale nic nie liczyło,
 * ile takich strzałów poszło POD RZĄD: agent w auto-turze może zlecić KOLEJNEGO suba w tle,
 * jego wynik znów odpala auto-turę — i tak w kółko. `max_delegation_depth` (config/limits.ts)
 * NIE chroni przed tym łańcuchem: auto-tura to nowa tura agenta GŁÓWNEGO, więc głębokość
 * delegacji liczy się od zera przy każdym ogniwie.
 *
 * ROZPOZNANIE AUTOMATU VS CZŁOWIEKA stoi na DWÓCH już istniejących mechanizmach
 * (`core/security/messageOrigin.ts`), bez trzeciego wymyślonego tutaj:
 *   - `resolveMessageOrigin(meta) === 'human'` → prawdziwa wiadomość z pola wpisywania.
 *     ZERUJE łańcuch (wołane w `send_message`).
 *   - `meta._subTaskNotification === true` → to KONKRETNIE auto-tura po subie, a nie inna
 *     wysyłka maszynowa (guzik artefaktu, propozycja delegacji, komentarz inline) — tylko ten
 *     typ tury ZWIĘKSZA licznik, bo tylko on jest źródłem opisanej pętli.
 *
 * Plik jest CZYSTĄ arytmetyką — zero `obsidian`, zero DOM, zero I/O (wzór `turnAbort.ts` /
 * `queuedMessage.ts`). Stan (licznik PER AGENT, ten sam klucz co `_streamCtxMap`/`_agentStates`/
 * `_preparingTurns`) trzyma wołający w `Map<string, number>`; tutaj są tylko decyzje na
 * pojedynczej liczbie, więc łańcuch da się przetestować bez Obsidiana.
 */

/** Decyzja o starcie KOLEJNEJ auto-tury w łańcuchu po subie. */
// AUD-dead-code-231 (2026-09-02): `export` zdjęty — zero referencji spoza pliku.
interface AutoTurnChainDecision {
    /** `false` = łańcuch osiągnął sufit; auto-tura NIE MA startować (fallback: zostaw w kolejce). */
    allowed: boolean;
    /** Wartość licznika, którą wołający ma zapisać — niezależnie od `allowed`. */
    nextCount: number;
}

/**
 * Czy wolno odpalić kolejną auto-turę po subie dla tego agenta.
 *
 * @param currentCount - ile auto-tur PO SUBIE pod rząd już poszło (0 = start łańcucha / stan
 *   po resecie). Wartości spoza `[0, ∞)` (ujemne, `NaN`, niedokończone) traktujemy jak 0 — to
 *   ten sam stan, co „agent jeszcze nie zaczął łańcucha" (świeży wpis mapy). To NIE jest bramka
 *   bezpieczeństwa (nie chroni przed ujawnieniem danych ani ominięciem uprawnień) — to kaganiec
 *   na runaway pętlę, więc śmieć spada na SENSOWNY start, tak jak walidacja limitów w
 *   `config/limits.ts` (`sanitizeLimit`), nie na odmowę.
 * @param limit - sufit z `config/limits.ts` (`max_consecutive_auto_turns`). Nie-dodatni /
 *   niedokończony traktowany jak 1 — PIERWSZA auto-tura ma zawsze prawo wystartować, limit
 *   chroni przed ŁAŃCUCHEM, nie przed pojedynczym powrotem wyniku.
 */
export function evaluateAutoTurnChain(currentCount: number, limit: number): AutoTurnChainDecision {
    const safeCurrent = Number.isFinite(currentCount) && currentCount > 0 ? Math.floor(currentCount) : 0;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
    if (safeCurrent >= safeLimit) {
        // Sufit osiągnięty — licznik ZOSTAJE na miejscu (nie rośnie w nieskończoność, żeby
        // jedna prawdziwa wiadomość człowieka zawsze sprowadzała go z powrotem do zera).
        return { allowed: false, nextCount: safeCurrent };
    }
    return { allowed: true, nextCount: safeCurrent + 1 };
}

/**
 * Licznik po prawdziwej wiadomości człowieka — łańcuch automatu jest przerwany, zawsze 0.
 * Nazwany osobno (zamiast gołego `0` u wołającego), żeby miejsce resetu w `send_message`
 * czytało się jako zdarzenie, nie magiczna liczba.
 */
export function resetAutoTurnChain(): number {
    return 0;
}
