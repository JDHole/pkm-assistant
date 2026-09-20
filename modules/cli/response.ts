/**
 * @module response
 * Koperta odpowiedzi CLI Obsidiana + serializacja. Fala 1 = komendy odczytowe: trzy z czterech
 * są czyste z konstrukcji (`effect: 'unchanged'`), a `agent-prompt` MIERZY, czy silnik po drodze
 * czegoś nie samonaprawił, i podaje `unchanged`/`changed`/`unknown` zgodnie z pomiarem. Kontrakt
 * zostawia miejsce na przyszłe komendy piszące (`created`), dziś nikt tego efektu nie produkuje.
 *
 * Handler CLI (`CliHandler` z `obsidian`) NIGDY nie rzuca - każdy wyjątek zamienia się w
 * `ok:false` z `error.code:'internal'` (patrz `commands.ts`). Kod wyjścia procesu CLI bywa 0
 * nawet przy błędzie, więc automat (Claude Code i inni agenci zewnętrzni) czyta TREŚĆ, nie
 * exit code - stąd `ok`/`verified` w samym JSON-ie, nie tylko w kodzie wyjścia powłoki.
 */

/** Co komenda zrobiła z dyskiem: `unchanged` (nic), `changed` (coś istniejącego zmienione albo
 *  zmaterializowane przez silnik po drodze), `created` (przyszłe komendy piszące), `unknown`
 *  (nie dało się zmierzyć albo wyjątek padł w połowie drogi). */
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
 *
 * Gałąź `ok:false` niesie TEN SAM zmierzony `verified`/`effect`, nie literał `unchanged`: błąd
 * potrafi paść PO przejściu silnika (`section_not_found` znamy dopiero z listy sekcji, którą
 * oddaje `getPromptInspectorDataForAgent`, a ten mógł już samonaprawić `brain.md`), więc
 * „błąd niczego nie zmienił" byłoby tą samą obietnicą na wiarę, tylko w drugiej gałęzi.
 */
export type CliResponse<T> =
    | { ok: true; command: string; verified: boolean; effect: CliEffect; data: T }
    | { ok: false; command: string; verified: boolean; effect: CliEffect; error: { code: CliErrorCode; message: string } };

/** Buduje udaną odpowiedź. Domyślnie `effect:'unchanged'`/`verified:true` - trzy z czterech
 *  komend fali 1 są czyste z konstrukcji; `agent-prompt` podaje własny, zmierzony `verified`/`effect`. */
export function okResponse<T>(command: string, data: T, effect: CliEffect = 'unchanged', verified = true): CliResponse<T> {
    return { ok: true, command, verified, effect, data };
}

/**
 * Buduje odpowiedź błędu. Domyślne `effect:'unchanged'`/`verified:false` jest PRAWDĄ tylko dla
 * błędów wykrytych, ZANIM cokolwiek ruszyło (`bad_flag`, `not_ready`, `agent_not_found`) - tam
 * nic nie miało szansy się zmienić. Błąd PO przejściu silnika podaje własny, zmierzony werdykt,
 * a złapany wyjątek (`internal`) dostaje `effect:'unknown'`: nie wiadomo, w którym miejscu padło.
 */
export function errorResponse(
    command: string,
    code: CliErrorCode,
    message: string,
    effect: CliEffect = 'unchanged',
    verified = false,
): CliResponse<never> {
    return { ok: false, command, verified, effect, error: { code, message } };
}

/** Jedyne miejsce, które serializuje kopertę - `JSON.stringify(response, null, 2)`, kontrakt CLI. */
export function serializeCliResponse<T>(response: CliResponse<T>): string {
    return JSON.stringify(response, null, 2);
}
