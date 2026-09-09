/**
 * Strażnik PO ŹRÓDLE: `get_chat_model({ skipCache })` musi doprowadzić flagę do
 * `createModelForRole` w gałęzi agenta z WŁASNYM modelem.
 *
 * DLACZEGO PO ŹRÓDLE, A NIE BEHAWIORALNIE: `chat_model.ts` importuje `obsidian` (`Notice`)
 * i całą warstwę UI, więc w AVA nie da się go zaimportować bezpośrednio. Ten sam wzór, co
 * `oczkoAccessGate.test.ts` obok - plik czyta własne źródło zamiast wołać moduł.
 * Zachowanie samego resolvera (że `callerSkipCache` faktycznie tworzy świeżą instancję
 * i nie kasuje istniejącego wpisu cache) jest przetestowane naprawdę w
 * `modules/models/modelResolver.test.ts`.
 *
 * CO PILNUJE: żeby nikt po cichu nie wyciął przekazania `skipCache` jako 5. argumentu.
 * Bez tego dwa taby czatu tego samego agenta z modelem w YAML-u (`models.main`/`model`)
 * dzielą JEDNĄ instancję adaptera w trakcie `stream()` — Stop klikany w jednej zakładce
 * trafia w cudzą turę (`ChatModel.stream()` nie jest concurrent-safe, gotcha 2
 * w `modules/models/CLAUDE.md`).
 */
import test from 'ava';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./chat_model.ts', import.meta.url), 'utf8');
/** Kod bez komentarzy — strażnik pilnuje WYWOŁANIA, nie opisu w komentarzu obok. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** Ciało funkcji najwyższego poziomu — od sygnatury do domknięcia w kolumnie 0. */
function fnBody(name: string): string {
    const re = new RegExp(`export function ${name}\\([\\s\\S]*?\\n\\)[^{]*\\{([\\s\\S]*?)\\n\\}`);
    return source.match(re)?.[1] || '';
}

test('get_chat_model przekazuje skipCache do createModelForRole (gałąź agenta z własnym modelem)', t => {
    const body = fnBody('get_chat_model');
    t.not(body, '', 'nie znalazłem ciała get_chat_model - zmieniła się sygnatura');

    // Bez tej asercji `createModelForRole(this.plugin, 'main', activeAgent)` (3 argumenty,
    // bez flagi) przechodziłby niezauważony.
    t.regex(
        body,
        /createModelForRole\(\s*this\.plugin,\s*'main',\s*activeAgent,\s*null,\s*skipCache\s*\)/,
        'gałąź hasAgentModel przestała przekazywać skipCache jako 5. argument createModelForRole - ' +
        'dwa taby tego samego agenta z modelem w YAML-u znów dzielą jedną instancję z cache resolvera'
    );
});

test('skipCache destrukturyzowany z opcji, nie zaszyty na sztywno', t => {
    // Kod bez komentarzy — pilnujemy że `skipCache` naprawdę jest parametrem funkcji,
    // nie literałem `false`/`true` podstawionym w wywołaniu.
    t.regex(
        code,
        /\{\s*skipCache\s*=\s*false\s*,\s*agent\s*\}/,
        'get_chat_model przestał przyjmować skipCache w opcjach — sygnatura się zmieniła'
    );
});
