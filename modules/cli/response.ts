/**
 * @module response
 * Koperta odpowiedzi CLI Obsidiana + serializacja. Fala 1 = wyłącznie odczyt, więc każda
 * udana odpowiedź niesie `effect: 'unchanged'` - kontrakt zostawia miejsce na przyszłe
 * komendy piszące (`changed`/`created`), ale dziś nikt inny efektu nie produkuje.
 *
 * Handler CLI (`CliHandler` z `obsidian`) NIGDY nie rzuca - każdy wyjątek zamienia się w
 * `ok:false` z `error.code:'internal'` (patrz `commands.ts`). Kod wyjścia procesu CLI bywa 0
 * nawet przy błędzie, więc automat (Claude Code i inni agenci zewnętrzni) czyta TREŚĆ, nie
 * exit code - stąd `ok`/`verified` w samym JSON-ie, nie tylko w kodzie wyjścia powłoki.
 */

/** Fala 1: każda udana odpowiedź jest czystym odczytem. Typ zostaje szerszy niż dzisiejsze użycie
 *  celowo - przyszła komenda piszącą wybierze `changed`/`created`/`unknown` z tej samej puli. */
export type CliEffect = 'unchanged' | 'changed' | 'created' | 'unknown';

/** Kody błędów wszystkich czterech komend fali 1 - jedna wspólna pula, nie po jednej na komendę. */
export type CliErrorCode =
    | 'not_ready'
    | 'bad_flag'
    | 'agent_not_found'
    | 'agent_ambiguous'
    | 'section_not_found'
    | 'internal';

/**
 * Koperta odpowiedzi - dyskryminowana unia po `ok`, żeby zły stan (dane + błąd naraz) był
 * niereprezentowalny. `verified` w gałęzi `ok:true` NIE jest literałem `true` (P4) - trzy z
 * czterech komend (`status`/`selftest`/`memory-status` po naprawie P3) SĄ czyste z konstrukcji i
 * dostają `verified:true` zawsze, ale `agent-prompt` idzie tą samą drogą co budowa promptu tury
 * (`getMemoryContext()` -> `getBrain()` samonaprawia indeks `brain.md` i ZAPISUJE plik) - koperta
 * mierzy to `stat`-em pliku przed/po i mówi PRAWDĘ (`verified:false, effect:'unknown'`, gdy nie
 * dało się nawet sprawdzić), zamiast obiecywać czystość, której silnik nie gwarantuje.
 */
export type CliResponse<T> =
    | { ok: true; command: string; verified: boolean; effect: CliEffect; data: T }
    | { ok: false; command: string; verified: false; effect: 'unchanged'; error: { code: CliErrorCode; message: string } };

/** Buduje udaną odpowiedź. Domyślnie `effect:'unchanged'`/`verified:true` - trzy z czterech
 *  komend fali 1 są czyste z konstrukcji; `agent-prompt` podaje własny, zmierzony `verified`/`effect`. */
export function okResponse<T>(command: string, data: T, effect: CliEffect = 'unchanged', verified = true): CliResponse<T> {
    return { ok: true, command, verified, effect, data };
}

/** Buduje odpowiedź błędu - zawsze `effect:'unchanged'` (błąd niczego nie zmienił). */
export function errorResponse(command: string, code: CliErrorCode, message: string): CliResponse<never> {
    return { ok: false, command, verified: false, effect: 'unchanged', error: { code, message } };
}

/** Jedyne miejsce, które serializuje kopertę - `JSON.stringify(response, null, 2)`, kontrakt CLI. */
export function serializeCliResponse<T>(response: CliResponse<T>): string {
    return JSON.stringify(response, null, 2);
}
