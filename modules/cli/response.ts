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

/** Koperta odpowiedzi - dyskryminowana unia po `ok`, żeby zły stan (dane + błąd naraz) był niereprezentowalny. */
export type CliResponse<T> =
    | { ok: true; command: string; verified: true; effect: CliEffect; data: T }
    | { ok: false; command: string; verified: false; effect: 'unchanged'; error: { code: CliErrorCode; message: string } };

/** Buduje udaną odpowiedź. `effect` domyślnie `'unchanged'` - fala 1 nie ma innej opcji. */
export function okResponse<T>(command: string, data: T, effect: CliEffect = 'unchanged'): CliResponse<T> {
    return { ok: true, command, verified: true, effect, data };
}

/** Buduje odpowiedź błędu - zawsze `effect:'unchanged'` (błąd niczego nie zmienił). */
export function errorResponse(command: string, code: CliErrorCode, message: string): CliResponse<never> {
    return { ok: false, command, verified: false, effect: 'unchanged', error: { code, message } };
}

/** Jedyne miejsce, które serializuje kopertę - `JSON.stringify(response, null, 2)`, kontrakt CLI. */
export function serializeCliResponse<T>(response: CliResponse<T>): string {
    return JSON.stringify(response, null, 2);
}
