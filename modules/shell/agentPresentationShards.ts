/**
 * agentPresentationShards.ts — PURE decyzja "czy shard info-grid jest wypełniony" dla
 * `AgentPresentationModal`.
 *
 * Wyciągnięte z modala, bo `AgentPresentationModal.ts` importuje `obsidian` (transytywnie też
 * `.css` przez `modules/komunikator/`), więc AVA (goły Node) nie potrafi go zaimportować
 * (`ERR_UNKNOWN_FILE_EXTENSION` na pierwszym napotkanym arkuszu stylów w łańcuchu importów) -
 * wzór "prototype mixin" z `modules/chat/CLAUDE.md`: decyzja idzie do czystej funkcji obok,
 * modal zostaje cienkim wołaczem.
 */

/**
 * Czy shard info-grid ma klasę `cs-shard--filled`.
 *
 * `info.value` bywa liczbą (`stats.brainSize`) albo stringiem (reszta pól, już `String(...)`
 * u wołacza) - porównanie idzie po Stringu, bo `0 !== '0'` (liczba vs string) jest zawsze
 * `true`, więc pusty Brain (liczba `0`) renderowałby się jako wypełniony niezależnie od
 * realnej wartości.
 */
export function isShardFilled(value: string | number, globalLabel: string): boolean {
    const s = String(value);
    return s !== '0' && s !== globalLabel;
}
