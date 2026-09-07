/**
 * AUD-testy-049 — `classifyToolRisk` (core/security/autonomy.ts:103-180) decyduje, czy user
 * w ogóle zostaje ZAPYTANY przed akcją. Do tego testu tylko 2 z 23 built-in narzędzi
 * (`web_search`/`web_read`) miały pokrycie end-to-end — reszta (create_folder, memory_save,
 * delegate, generate_image, add_text_to_image, artifact_create/update...) dało się cicho
 * przeklasyfikować na GREEN bez ani jednego czerwonego testu (mutacja z findings.json:
 * `if (yellowTools.has(tool)) return YELLOW;` → `return GREEN;` zostawiała 2465/2465 zielono).
 *
 * Dwie warstwy obrony:
 *  1. KOMPLETNOŚĆ — `EXPECTED` jest DIFFOWANE względem `ToolRegistry.getBuiltinServerMap()`
 *     (ta sama SSOT co UI/manifest generation). Nowe narzędzie dodane do katalogu bez
 *     świadomej decyzji o jego kolorze pali ten test, ZANIM ktokolwiek zapyta o jego ryzyko.
 *  2. KLASYFIKACJA — każdy wpis jest wołany przez `classifyToolRisk` i porównany z
 *     PINOWANĄ klasą. Przeklasyfikowanie któregokolwiek narzędzia (w dowolną stronę) pali
 *     dokładnie jeden test nazwany jego imieniem.
 */
import test from 'ava';
import { classifyToolRisk, TOOL_RISK_LEVELS } from './autonomy.js';
import type { ToolRiskLevel } from './autonomy.js';
import { ToolRegistry } from '../../modules/tools/ToolRegistry.js';

// Reprezentatywna klasa ryzyka KAŻDEGO narzędzia z dzisiejszego katalogu (23 wpisy — zgodne
// z modules/tools/CLAUDE.md: "23 built-in narzędzia", zmierzone z 8 manifestów). Wołanie jest
// „gołe" (bez operationMode) — dokładnie to, co dostałby classifyToolRisk od narzędzia, które
// nie niesie trybu. Narzędzia, których klasa ZALEŻY od operationMode (write/todo), mają
// WŁASNY, osobny test niżej — tu pinowana jest wartość DOMYŚLNA (brak trybu).
const EXPECTED: Record<string, ToolRiskLevel> = {
    // core
    ask_user: TOOL_RISK_LEVELS.GREEN,
    // artifacts
    artifact_create: TOOL_RISK_LEVELS.YELLOW,
    artifact_read: TOOL_RISK_LEVELS.GREEN,
    artifact_update: TOOL_RISK_LEVELS.YELLOW,
    artifact_list: TOOL_RISK_LEVELS.GREEN,
    todo: TOOL_RISK_LEVELS.YELLOW, // bez operationMode = zapis; get/list/read = GREEN, patrz test osobny
    // vault
    read: TOOL_RISK_LEVELS.GREEN,
    write: TOOL_RISK_LEVELS.RED, // bez operationMode='create' = RED, patrz test osobny
    list: TOOL_RISK_LEVELS.GREEN,
    delete: TOOL_RISK_LEVELS.RED,
    create_folder: TOOL_RISK_LEVELS.YELLOW,
    search: TOOL_RISK_LEVELS.GREEN,
    // memory
    memory_save: TOOL_RISK_LEVELS.YELLOW,
    memory_delete: TOOL_RISK_LEVELS.RED,
    // web
    web_search: TOOL_RISK_LEVELS.YELLOW,
    web_read: TOOL_RISK_LEVELS.YELLOW,
    // multimodal
    generate_image: TOOL_RISK_LEVELS.YELLOW,
    add_text_to_image: TOOL_RISK_LEVELS.YELLOW,
    // delegation
    delegate: TOOL_RISK_LEVELS.YELLOW,
    agent_delegate: TOOL_RISK_LEVELS.YELLOW,
    // komunikator
    kom_send: TOOL_RISK_LEVELS.YELLOW,
    kom_list: TOOL_RISK_LEVELS.GREEN,
    kom_read: TOOL_RISK_LEVELS.GREEN,
};

test('kompletność: EXPECTED pokrywa DOKŁADNIE zestaw narzędzi z BUILTIN_TOOL_MAP (ani mniej, ani więcej)', t => {
    const registry = new ToolRegistry();
    const live = new Set(Object.values(registry.getBuiltinServerMap()).flat());
    const expected = new Set(Object.keys(EXPECTED));

    const brakWTescie = [...live].filter(name => !expected.has(name));
    const nadmiarWTescie = [...expected].filter(name => !live.has(name));

    t.deepEqual(
        brakWTescie,
        [],
        `narzędzie(a) zarejestrowane w katalogu BEZ pinowanej klasy ryzyka: ${brakWTescie.join(', ')} — ` +
        'dodanie narzędzia bez świadomej decyzji o jego kolorze musi PALIĆ ten test',
    );
    t.deepEqual(
        nadmiarWTescie,
        [],
        `EXPECTED pinuje narzędzie, którego katalog już nie zna: ${nadmiarWTescie.join(', ')} — uprzątnij tabelę`,
    );
});

for (const [toolName, risk] of Object.entries(EXPECTED)) {
    test(`klasyfikacja: "${toolName}" → ${risk}`, t => {
        t.is(
            classifyToolRisk({ toolName }),
            risk,
            `"${toolName}" zmienił klasę ryzyka wobec pinowanej wartości (${risk})`,
        );
    });
}

// ─── Narzędzia, których klasa zależy od operationMode — pinowana wartość wyżej to tylko DEFAULT ───

test('write: create=YELLOW; replace/patch/append/prepend/brak trybu=RED', t => {
    t.is(classifyToolRisk({ toolName: 'write', operationMode: 'create' }), TOOL_RISK_LEVELS.YELLOW);
    for (const mode of ['replace', 'patch', 'append', 'prepend', undefined]) {
        t.is(classifyToolRisk({ toolName: 'write', operationMode: mode }), TOOL_RISK_LEVELS.RED, `mode=${mode}`);
    }
});

test('todo: get/list/read=GREEN (dowolna wielkość liter); każda inna akcja (i brak)=YELLOW', t => {
    for (const mode of ['get', 'list', 'read', 'GET', 'List']) {
        t.is(classifyToolRisk({ toolName: 'todo', operationMode: mode }), TOOL_RISK_LEVELS.GREEN, `mode=${mode}`);
    }
    for (const mode of ['add', 'check', 'uncheck', 'finish', undefined]) {
        t.is(classifyToolRisk({ toolName: 'todo', operationMode: mode }), TOOL_RISK_LEVELS.YELLOW, `mode=${mode}`);
    }
});

// ─── Aliasy wsteczne `vault_*` — poza dzisiejszym BUILTIN_TOOL_MAP (E2.6 zdjęło prefiks),
// ale WCIĄŻ żywe w classifyToolRisk dla starych configów sub-agentów / przełączników
// approvalu zapisanych przed rename'em. Osobna sekcja, bo kompletność wyżej liczy się
// względem KATALOGU, nie względem tych literałów. ───

test('aliasy vault_*: te same klasy co ich następcy bez prefiksu', t => {
    t.is(classifyToolRisk({ toolName: 'vault_read' }), TOOL_RISK_LEVELS.GREEN);
    t.is(classifyToolRisk({ toolName: 'vault_list' }), TOOL_RISK_LEVELS.GREEN);
    t.is(classifyToolRisk({ toolName: 'vault_search' }), TOOL_RISK_LEVELS.GREEN);
    t.is(classifyToolRisk({ toolName: 'vault_write', operationMode: 'create' }), TOOL_RISK_LEVELS.YELLOW);
    t.is(classifyToolRisk({ toolName: 'vault_write' }), TOOL_RISK_LEVELS.RED);
    t.is(classifyToolRisk({ toolName: 'vault_create_folder' }), TOOL_RISK_LEVELS.YELLOW);
    t.is(classifyToolRisk({ toolName: 'vault_delete' }), TOOL_RISK_LEVELS.RED);
});

// ─── Fail-closed: nieznane narzędzia i narzędzia zewnętrzne — strony, które MUSZĄ zostać RED ───

test('nieznane narzędzie spoza katalogu = RED (fail-closed)', t => {
    t.is(classifyToolRisk({ toolName: 'ktos_nowy_wymyslil_to_wczoraj' }), TOOL_RISK_LEVELS.RED);
    t.is(classifyToolRisk({}), TOOL_RISK_LEVELS.RED, 'brak toolName całkowicie');
});

test('ask_user zostaje GREEN nawet z isExternalTool=true (jedyny wyjątek — kolejność w kodzie)', t => {
    t.is(classifyToolRisk({ toolName: 'ask_user', isExternalTool: true }), TOOL_RISK_LEVELS.GREEN);
});

test('KAŻDE inne narzędzie z katalogu jako narzędzie serwera zewnętrznego = RED, niezależnie od zwykłej klasy', t => {
    for (const toolName of Object.keys(EXPECTED)) {
        if (toolName === 'ask_user') continue; // jedyny udokumentowany wyjątek, patrz test wyżej
        t.is(
            classifyToolRisk({ toolName, isExternalTool: true }),
            TOOL_RISK_LEVELS.RED,
            `"${toolName}" jako narzędzie zewnętrzne musi zostać RED — cudzy kod nie jest przez nas weryfikowalny`,
        );
    }
});
