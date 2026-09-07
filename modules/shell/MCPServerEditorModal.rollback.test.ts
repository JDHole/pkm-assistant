/**
 * Strażnik po źródle dla `_handleSave` (AUD-code-review-040).
 *
 * `MCPServerEditorModal.ts` importuje `obsidian` (`Modal`, `Setting`, `Notice`) na samej
 * górze, więc AVA go nie zaimportuje — ten sam powód i wzór, co
 * `modules/chat/chat/stopSemantics.test.ts` i `src/main.test.ts`: czytamy ŹRÓDŁO regexami.
 *
 * Wtopa: `_handleSave` wpisywał `servers[idx] = config` (albo `servers.push(config)`) PRZED
 * zapisem, a przy padzie `await this._save()` tylko pokazywał Notice i robił `return` — bez
 * cofnięcia mutacji. Modal zostawał otwarty, ale konfiguracja w RAM była już podmieniona,
 * choć na dysku dalej leżała poprzednia wersja (repo ma na tę klasę błędu dedykowany wzorzec:
 * `persistOrRollback` w `modules/tools/settingsPersist.ts`, K3-E).
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Ciało metody klasy `_handleSave(...) {` do domykającego `\n    }` na jej poziomie wcięcia. */
function methodBody(src: string, name: string): string {
    const head = new RegExp(`\\n    (?:async )?${name}\\([^)]*\\)[^{]*\\{`).exec(src);
    if (!head) return '';
    const rest = src.slice(head.index + head[0].length);
    const to = rest.indexOf('\n    }');
    return stripComments(to < 0 ? rest : rest.slice(0, to));
}

const source = readSource('./MCPServerEditorModal.ts');

test('_handleSave: mutacja jest cofana, gdy zapis padnie (AUD-code-review-040)', t => {
    const body = methodBody(source, '_handleSave');
    t.true(body.length > 0, 'nie znalazłem _handleSave w MCPServerEditorModal.ts');

    const catchMatch = /catch\s*\(e: Runtime\)\s*\{([\s\S]*?)\n        \}/.exec(body);
    t.truthy(catchMatch, 'brak bloku catch dookoła await this._save()');
    const catchBody = catchMatch![1];

    t.regex(catchBody, /servers\[editedIdx\]\s*=\s*previousAtIdx/,
        'edycja istniejącego serwera musi po padzie zapisu przywrócić poprzedni wpis w RAM');
    t.regex(catchBody, /servers\.pop\(\)/,
        'dodanie nowego serwera musi po padzie zapisu zdjąć dopisany wpis z listy w RAM');
    t.regex(catchBody, /new Notice\(/, 'user musi dostać komunikat o padzie zapisu');
});

test('_handleSave: mutacja w pamięci woła przed zapisem, nie wewnątrz try (kontrola kształtu)', t => {
    const body = methodBody(source, '_handleSave');
    // Zmienne rollbacku muszą powstać PRZED `try { await this._save() }`, inaczej catch nie ma
    // czego czytać (closure nie widziałby ich, gdyby żyły tylko w bloku try).
    const tryIdx = body.indexOf('try {');
    const declIdx = body.indexOf('let editedIdx');
    t.true(declIdx >= 0 && tryIdx >= 0 && declIdx < tryIdx,
        'editedIdx/previousAtIdx muszą być zadeklarowane przed blokiem try/catch zapisu');
});
