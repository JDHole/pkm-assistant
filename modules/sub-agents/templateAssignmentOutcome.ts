/**
 * templateAssignmentOutcome — decyzje stanu wokół „Użyj u agenta" i globalnego suba
 * w Zapleczu.
 *
 * `useTemplateAtAgent` i handler kasowania w `SubAgentsBackstageTab.ts` mieszają I/O
 * (`Notice`, `store.instantiate`, `agentManager.updateAgent`) z regułami STANU:
 * idempotencja przypisania (nie dopisuj tego samego suba drugi raz), „pierwszy sub
 * agenta zostaje domyślny" i „kasujesz szablon będący globalnym → wskaźnik wraca na
 * pkm-sub". `SubAgentsBackstageTab.ts` nie eksportuje tych funkcji jako prywatne, więc
 * te reguły nie dają się przetestować bezpośrednio - zepsucie któregokolwiek warunku
 * dawałoby cichy półstan.
 *
 * Decyzja wychodzi do czystego pliku (zero DOM, zero obsidian, zero i18n) — tak samo
 * jak w `deleteOutcome.ts` i `templateUseOutcome.ts` - widok zostaje wywołaniem i `Notice`.
 */

/**
 * Jedno przypisanie suba u agenta. Kształt bliźniaczy do `AgentSubAgentAssignment`
 * z `modules/agents`, ale zduplikowany LOKALNIE i celowo: `sub-agents` nie wolno
 * importować z `agents` (odwrotna zależność — `modules/agents/AgentManager.js`
 * importuje TEN moduł, nie na odwrót; złota zasada modułów w CLAUDE.md).
 */
export interface SubAgentAssignment {
    name: string;
    // Opcjonalne: zgodnie z realnym `AgentSubAgentAssignment` (modules/agents/Agent.ts) —
    // istniejące przypisanie może nie mieć roli w YAML-u; tylko NOWY wpis niżej ją ustawia.
    role?: string;
    default?: boolean;
    [key: string]: unknown;
}

/** Decyzja: jaki ma być nowy zestaw `sub_agents` agenta po odlaniu kopii szablonu. */
export interface SubAgentsAfterTemplateUse {
    /**
     * `false` = sub o tej nazwie już jest przypisany — wołacz NIE powinien zapisywać.
     * Bez tej flagi drugie kliknięcie tego samego przycisku „Użyj u agenta" dopisywałoby
     * duplikat przypisania przy każdym zapisie.
     */
    changed: boolean;
    subAgents: SubAgentAssignment[];
}

/**
 * Nowy zestaw `sub_agents` po „Użyj u agenta".
 *
 * Idempotencja: sub o nazwie `newName` NIE jest dopisywany drugi raz. Pierwszy sub
 * agenta dostaje `default: true` — agent bez ŻADNEGO przypisanego suba potrzebuje
 * jednego domyślnego (patrz `DelegateTool` aspect resolution).
 *
 * Pure: `existingAssignments` nie jest mutowana — wołacz dostaje NOWĄ tablicę (albo
 * tę samą referencję z powrotem, gdy `changed === false`, do wyświetlenia bez zapisu).
 */
export function computeSubAgentsAfterTemplateUse(
    existingAssignments: SubAgentAssignment[],
    newName: string,
): SubAgentsAfterTemplateUse {
    if (existingAssignments.some(a => a.name === newName)) {
        return { changed: false, subAgents: existingAssignments };
    }
    const subAgents = existingAssignments.map(a => ({ ...a }));
    const entry: SubAgentAssignment = { name: newName, role: 'researcher' };
    if (subAgents.length === 0) entry.default = true;
    subAgents.push(entry);
    return { changed: true, subAgents };
}

/** Decyzja: na co ma wskazywać globalny sub po skasowaniu szablonu. */
export interface GlobalSubAfterTemplateDelete {
    /** `false` = kasowany szablon NIE był globalny — wskaźnik zostaje bez zmian. */
    changed: boolean;
    /**
     * Nowy slug globalnego suba. Zawsze `null` (fabryczny `pkm-sub`) — nie ma czym
     * automatycznie zastąpić wskaźnik, bo skasowany szablon właśnie przestał istnieć.
     */
    slug: null;
}

/**
 * Globalny wskaźnik (`settings.pkmAssistant.globalSubTemplate`) nie może wisieć na
 * nieistniejącym (skasowanym) szablonie. Kasowanie szablonu, który AKURAT jest globalny,
 * musi wrócić wskaźnik na fabryczny `pkm-sub` — bez tego `delegate` bez `aspect` szukałby
 * konfiguracji, która już nie istnieje.
 */
export function computeGlobalSubAfterTemplateDelete(wasGlobal: boolean): GlobalSubAfterTemplateDelete {
    return { changed: wasGlobal, slug: null };
}
