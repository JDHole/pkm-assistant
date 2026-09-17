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

/** Czy shard info-grid ma klasę `cs-shard--filled`. */
export function isShardFilled(value: string | number, globalLabel: string): boolean {
    return value !== '0' && value !== globalLabel;
}
