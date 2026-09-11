/**
 * Strażnik PO ŹRÓDLE: guzik „Podsumuj rozmowy" (`_runArchiveWorkflow`) musi wołać
 * `createModelForRole` z `callerSkipCache=true`.
 *
 * DLACZEGO PO ŹRÓDLE, A NIE BEHAWIORALNIE: `profile_memory.ts` importuje `obsidian`
 * (`MarkdownRenderer`, `Notice`), więc AVA nie zaimportuje pliku produkcyjnego. Ten sam wzór,
 * co `modules/chat/chat/oczkoAccessGate.test.ts` i `modules/chat/chat/chatModelSkipCache.test.ts`
 * - plik czyta własne źródło zamiast wołać moduł.
 *
 * CO PILNUJE: bez piątego argumentu ten guzik dostaje instancję main z `modelResolver._cache` -
 * dokładnie tę samą, na której może właśnie stać `stream()` aktywnej tury czatu tego samego
 * agenta (Stop w czacie, `_abortSettle` - patrz `modules/models/CLAUDE.md`). Zachowanie samego
 * resolvera (że `callerSkipCache` tworzy świeżą instancję i nie kasuje cache) ma testy
 * behawioralne w `modules/models/modelResolver.test.ts`.
 */
import test from 'ava';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./profile_memory.ts', import.meta.url), 'utf8');

/**
 * Ciało funkcji modułowej (nieeksportowanej) - od otwierającego do domykającego nawiasu
 * klamrowego, liczonego balansem (nie regex zachłanny do `\n}`). Sygnatura
 * `_runArchiveWorkflow(ctx, memory, rerender: () => void)` ma nawiasy okrągłe W ŚRODKU
 * listy parametrów, więc prosty `[^)]*` (wzór z oczkoAccessGate.test.ts) urywa się na nich -
 * a szukanie znacznika przez `indexOf` zamiast `RegExp` omija całą gimnastykę z ucieczką `(`.
 */
function fnBody(name: string): string {
    const marker = `\nasync function ${name}(`;
    const startIdx = source.indexOf(marker);
    if (startIdx < 0) return '';
    const braceStart = source.indexOf('{', startIdx);
    if (braceStart < 0) return '';
    let depth = 0;
    for (let i = braceStart; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(braceStart + 1, i);
        }
    }
    return '';
}

test('_runArchiveWorkflow woła createModelForRole z callerSkipCache=true', t => {
    const body = fnBody('_runArchiveWorkflow');
    t.not(body, '', 'nie znalazłem ciała _runArchiveWorkflow — zmieniła się sygnatura');

    // Bez tej asercji `createModelForRole(plugin, 'main', agent)` (3 argumenty, bez flagi)
    // przechodziłby niezauważony - dokładnie ten sam typ regresu, jaki wcześniej wystąpił w
    // chat_model.ts.
    // `(?:\s+as\s+[^,]+)?` po `plugin`/`agent` toleruje asercje typu (TS-boundary cast do
    // ResolverPluginLike/Parameters<...> w profile_memory.ts) - erased w runtime, nie zmienia
    // liczby ani wartości ani kolejności argumentów, które ten test pilnuje.
    t.regex(
        body,
        /createModelForRole\(\s*plugin(?:\s+as\s+[^,]+)?,\s*'main',\s*agent(?:\s+as\s+[^,]+)?,\s*null,\s*true\s*\)/,
        'guzik „Podsumuj rozmowy" przestał wymuszać świeżą instancję (callerSkipCache=true) — ' +
        'znów może dzielić instancję main z aktywną turą czatu tego samego agenta w trakcie stream()'
    );
});
