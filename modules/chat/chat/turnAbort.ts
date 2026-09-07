/**
 * turnAbort — PRZERWANIE JEST STANEM TURY, nie stanem widoku (K5, AUD-security-037/038/068).
 *
 * Do K5 czat trzymał przerwanie w jednym polu widoku (`ChatView._abortedStream` — nazwa agenta
 * ostatnio zatrzymanej tury), a każde kolejne `send_message` czyściło je na wejściu („nowa
 * wiadomość = świeży start"). Skutek: pętla zaparkowana w długim narzędziu w chwili Stopu
 * nigdy nie widziała flagi, bo zanim doszła do punktu przerwania, gasiła ją albo następna
 * wiadomość usera, albo AUTO-tura z wynikiem suba, albo przełączenie zakładki (drain).
 * Zatrzymana pętla wznawiała iteracje i egzekucję narzędzi.
 *
 * Od K5 każda tura dostaje WŁASNY uchwyt (`createTurnAbort()`): Stop zatrzaskuje flagę na TEJ
 * turze, a nowa tura startuje z nowym uchwytem i nie ma jak „odkręcić" przerwania starej.
 * Pętla (`runAgentLoop`) pyta `shouldAbort: () => turn.abort.isAborted()`, czyli stan SWOJEJ
 * tury — nigdy pole widoku.
 *
 * Ten plik jest CELOWO wolny od `obsidian` i od DOM-u (wzór `turnOwner.ts`) — dzięki temu ma
 * testy jednostkowe, a mixiny `chat_streaming.ts` / `chat_view.ts` tylko go wywołują.
 */

/** Uchwyt przerwania JEDNEJ tury. Zatrzask: raz podniesiona flaga już nie gaśnie. */
// AUD-dead-code-231 (2026-09-02): `export` zdjęty na trzech typach w tym pliku — zero referencji
// spoza pliku; funkcje, które je noszą w sygnaturze (`createTurnAbort`, `collectTurnsToStop`, …),
// zostają publiczne.
interface TurnAbortHandle {
    /** Czy ta tura została przerwana (Stop / watchdog / zamknięcie widoku). */
    isAborted(): boolean;
    /** Powód pierwszego przerwania (`'stop'`, `'stall'`, `'close'`, …) albo `null`. */
    reason(): string | null;
    /** Zatrzaśnij przerwanie. Zwraca `true` TYLKO przy pierwszym wywołaniu (idempotencja). */
    abort(reason?: string): boolean;
}

export function createTurnAbort(): TurnAbortHandle {
    let aborted = false;
    let why: string | null = null;
    return {
        isAborted: () => aborted,
        reason: () => why,
        abort(reason = 'stop') {
            if (aborted) return false;
            aborted = true;
            why = reason || 'stop';
            return true;
        },
    };
}

/** Minimalny widok wpisu `_streamCtxMap`, jakiego potrzebuje zatrzymywanie tur. */
interface AbortableTurnCtx {
    agentName?: string | null;
    abort?: TurnAbortHandle | null;
}

/**
 * 068: nazwy agentów WSZYSTKICH tur w locie — także tych na zakładkach w tle.
 *
 * Do K5 `ChatView.onClose` pytał o jedno pole widoku (`is_generating`), które przełączenie
 * zakładki nadpisuje stanem zakładki DOCELOWEJ — więc tura z zakładki w tle przeżywała
 * zamknięcie panelu (a linia wyżej rozbrajała jej watchdoga, czyli ostatniego strażnika).
 * Zamykamy PO WŁAŚCICIELACH TUR, nie po tym, kto akurat jest na wierzchu.
 *
 * @returns unikalne, niepuste nazwy w kolejności wpisów (kopia — wołacz kasuje wpisy w trakcie)
 */
export function collectTurnsToStop(entries: Iterable<AbortableTurnCtx> | null | undefined): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const ctx of entries || []) {
        const name = typeof ctx?.agentName === 'string' ? ctx.agentName.trim() : '';
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push(name);
    }
    return out;
}

/** Minimalny widok biegu suba (`SubTask`) — tyle, ile trzeba, żeby zdecydować „to nasz bieg". */
interface StoppableSubTask {
    id?: string;
    status?: string;
    stopRequested?: boolean;
    origin?: { agentName?: string; tabKey?: string } | null;
}

/**
 * 068: id biegów subów zleconych Z TEGO WIDOKU — po adresie zwrotnym (`origin`), a nie po
 * agencie, który akurat je wykonuje. Zamknięcie panelu ubija tury, więc ich suby zostają
 * bez adresata: wynik i tak nie miałby dokąd wrócić, a bieg dalej paliłby tokeny i pisał
 * do vaulta.
 *
 * Dopasowanie: `origin.tabKey` w zbiorze zakładek widoku ALBO (gdy bieg nie ma klucza
 * zakładki) `origin.agentName` wśród właścicieli zatrzymywanych tur. Bieg BEZ `origin`
 * (zlecenie spoza czatu) nie jest nasz i zostaje nietknięty.
 */
export function collectSubTaskIdsForOwners(
    tasks: Iterable<StoppableSubTask> | null | undefined,
    owners: { tabKeys?: Iterable<string> | null; agentNames?: Iterable<string> | null } = {},
): string[] {
    const tabKeys = new Set(owners.tabKeys || []);
    const agentNames = new Set(owners.agentNames || []);
    const out: string[] = [];
    for (const task of tasks || []) {
        if (!task?.id || task.status !== 'running' || task.stopRequested) continue;
        const origin = task.origin;
        if (!origin) continue;
        const byTab = typeof origin.tabKey === 'string' && origin.tabKey && tabKeys.has(origin.tabKey);
        const byAgent = !origin.tabKey
            && typeof origin.agentName === 'string'
            && agentNames.has(origin.agentName);
        if (byTab || byAgent) out.push(task.id);
    }
    return out;
}
