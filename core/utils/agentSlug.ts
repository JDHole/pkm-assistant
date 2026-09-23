/**
 * Kanoniczny slug tożsamości agenta (nazwa → bezpieczny fragment ścieżki na dysku).
 *
 * To samo wyrażenie `toLowerCase().replace(/[^a-z0-9]/g,'_')` żyło
 * jako 20 niezależnych kopii w 8 modułach (+ `core/security/AccessGuard`). Format jest
 * ŚWIADOMIE zamrożony — to nie jest miejsce na ulepszenia (Unicode/polskie znaki/limit
 * długości): każda zmiana wyniku przesuwa istniejące foldery `.pkm-assistant/agents/<safeName>/`
 * na dysku usera, czyli wymaga migracji danych. NIE mylić z `slugify()` (kebab-case,
 * polskie znaki, inny alfabet wyjściowy) — to osobny, niezależny format dla notatek/plików,
 * nie dla tożsamości agenta.
 *
 * Dom w `core/utils/`, nie w `modules/agents/`: konsument `core/security/AccessGuard.ts`
 * nie może importować z żadnego modułu (poza dwoma udokumentowanymi wyjątkami w
 * `core/CLAUDE.md`), więc kanoniczny helper musi stać w `core/`, żeby zamknąć WSZYSTKIE
 * kopie, nie tylko te w modułach.
 */
export function getAgentSafeName(name: unknown): string {
    return (name ? _rawToString(name) : '').toLowerCase().replace(/[^a-z0-9]/g, '_');
}

/**
 * `name` przychodzi jako `unknown` z definicji (wołacze mają różne kształty danych usera) —
 * osobna funkcja graniczna, bo dopiero jej wywołanie resetuje zawężenie TS z powrotem do
 * gołego `unknown` (ten sam wzorzec co `_safeStringify` w `core/utils/errorUtils.ts`): guard
 * `name ?` w `getAgentSafeName` MUSI zostać poza tą funkcją, inaczej TS zawęża `name` do typu,
 * który eslint zgłasza jako bazową stringifikację.
 */
function _rawToString(name: unknown): string {
    return String(name);
}
