/**
 * TokenTracker — sledzenie zuzycia tokenow per-wiadomosc i per-sesje.
 * Kubelki startowe: main, minion (zgodnosc ze starym UI slim bara, ktore chowa wiersze
 * zerowe). Kazda inna rola przekazana do `record()` (np. `researcher` z sub-agentow) dostaje
 * wlasny kubelek leniwie.
 *
 * Kubelek `master` skasowany w fabryce kasacji martwego kodu S1 (2026-09-02,
 * AUD-dead-code-119) — po E3.6 zaden produkcyjny wolacz `record()` nie podaje roli 'master'
 * (jedyne wolania to literal 'main' i `result.aspect_type || 'researcher'` z DelegateTool),
 * a wiersz w slim barze go pokazujacy byl trwale ukryty (`is-hidden` przy totalu 0).
 */
/** Jeden wpis = jedno wywolanie API. */
export interface TokenEntry {
    role: string;
    input: number;
    output: number;
    estimated: boolean;
    timestamp: number;
}

/** Kubelek sumy tokenow dla jednej roli. */
export interface RoleTotals {
    input: number;
    output: number;
}

/** Podsumowanie sesji zwracane przez `getSessionTotal()`. */
export interface SessionTotal {
    input: number;
    output: number;
    total: number;
    byRole: Record<string, RoleTotals>;
}

export class TokenTracker {
    // `declare` = deklaracja WYLACZNIE typu, zero emitu (patrz kontrakt kampanii TS, §3):
    // przy `useDefineForClassFields: true` zwykla deklaracja wyemitowalaby realne puste pole.
    declare entries: TokenEntry[];
    /** Klucz = rola. Dwa kubelki startowe + kazda rola dolozona leniwie w `record()`. */
    declare totals: Record<string, RoleTotals>;
    declare estimated: Record<string, boolean>;

    constructor() {
        this.entries = [];
        this.totals = {
            main:   { input: 0, output: 0 },
            minion: { input: 0, output: 0 },
        };
        // L07-6: czy DLA DANEJ ROLI jakikolwiek wpis byl estymata (fallback bez usage z API).
        // Token Viewer oznacza wtedy liczby prefiksem `~` + etykieta „przyblizone".
        this.estimated = { main: false, minion: false };
    }

    /**
     * Zapisuje zuzycie tokenow z jednego wywolania API.
     * Rola nieznana z gory (np. `researcher` z sub-agentow) zaklada wlasny kubelek — inaczej
     * jej tokeny lecialy do `entries`, ale ginely w agregacie i Token Viewer pokazywal 0.
     * @param role — 'main' | 'minion' | dowolna rola runtime (np. 'researcher')
     * @param inputTokens  — prompt_tokens
     * @param outputTokens — completion_tokens
     * @param meta — L07-6: estimated=true gdy liczby pochodza z fallbacku
     *   (brak usage z API). Backward-compat: stare wywolania bez meta dzialaja jak dotad.
     */
    record(role: string, inputTokens: number, outputTokens: number, meta: { estimated?: boolean } = {}): void {
        const inp = inputTokens || 0;
        const out = outputTokens || 0;
        this.entries.push({
            role,
            input: inp,
            output: out,
            estimated: !!meta.estimated,
            timestamp: Date.now(),
        });
        if (!this.totals[role]) this.totals[role] = { input: 0, output: 0 };
        this.totals[role].input += inp;
        this.totals[role].output += out;
        if (meta.estimated) {
            this.estimated[role] = true;
        }
    }

    /**
     * Czy dana rola ma JAKIKOLWIEK wpis z estymaty (dane z fallbacku, nie z API usage).
     * @param role
     */
    hasEstimates(role: string): boolean {
        return !!this.estimated[role];
    }

    /**
     * Zwraca podsumowanie sesji. `byRole` obejmuje 2 role startowe + kazda role dolozona
     * w runtime przez `record()`.
     */
    getSessionTotal(): SessionTotal {
        let input = 0;
        let output = 0;
        const byRole: Record<string, RoleTotals> = {};
        for (const [role, r] of Object.entries(this.totals)) {
            input += r.input;
            output += r.output;
            byRole[role] = { ...r };
        }
        return {
            input,
            output,
            total: input + output,
            byRole,
        };
    }

    /**
     * Zwraca tablice wpisow per-wywolanie.
     */
    getBreakdown(): TokenEntry[] {
        return [...this.entries];
    }

    /** Reset na nowa sesje. */
    clear(): void {
        this.entries = [];
        this.totals = {
            main:   { input: 0, output: 0 },
            minion: { input: 0, output: 0 },
        };
        this.estimated = { main: false, minion: false };
    }
}
