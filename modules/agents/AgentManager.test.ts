/**
 * AgentManager.ts importuje `obsidian` (Notice), więc AVA nie umie go zaimportować wprost -
 * strażnik czyta ŹRÓDŁO regexami. Wzór: `modules/chat/chat/stopSemantics.test.ts`,
 * `modules/chat/chat/turnOwner.test.ts` (sekcja "po źródle").
 *
 * `getPromptInspectorDataForAgent` (Inspektor promptu - Prompt → Podgląd / Kopiuj w profilu
 * agenta) miało fail-OPEN fallback `this.getMemoryForAgent?.(agent) || this.getActiveMemory()`.
 * Gdy `agentMemories` nie miało jeszcze wpisu dla OGLĄDANEGO agenta (np. padnięta inicjalizacja
 * pamięci w `initialize()` - agent jest w `this.agents`, ale bez wpisu w `agentMemories`, `catch`
 * loguje i leci dalej), fallback podstawiał pamięć AKTYWNEGO agenta. Podgląd promptu agenta X
 * pokazywał wtedy brain.md agenta Y - dokładnie ten wzorzec, który naprawiono wcześniej w
 * `getActiveSystemPromptWithMemory` (`getAgentMemory(target.name)`, bez `||`).
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Kod bez komentarzy - strażnik pilnuje WYWOŁAŃ, nie opisów historii (comment może cytować starą wadę). */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Ciało metody klasy `<name>(...) { ... }` - liczy nawiasy klamrowe, żeby złapać CAŁE ciało. */
function methodBodyOf(src: string, name: string): string {
    const head = new RegExp(`\\n\\s*(?:async\\s+)?${name}\\([^)]*\\)[^{]*\\{`).exec(src);
    if (!head) return '';
    let depth = 1;
    let i = head.index + head[0].length;
    const start = i;
    while (depth > 0 && i < src.length) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
    }
    return stripComments(src.slice(start, i - 1));
}

const source = readSource('./AgentManager.ts');

test('getPromptInspectorDataForAgent adresuje pamięć po NAZWIE oglądanego agenta', t => {
    const body = methodBodyOf(source, 'getPromptInspectorDataForAgent');
    t.true(body.length > 0, 'nie znalazłem getPromptInspectorDataForAgent w AgentManager.ts — zmieniła się sygnatura?');

    t.regex(body, /this\.getAgentMemory\(agent\.name\)/,
        'pamięć musi być adresowana po nazwie OGLĄDANEGO agenta (wzór z getActiveSystemPromptWithMemory)');

    t.notRegex(body, /getActiveMemory\(\)/,
        'fail-open fallback na pamięć AKTYWNEGO agenta — inspektor promptu agenta X pokazywałby brain.md agenta Y');

    t.notRegex(body, /getMemoryForAgent/,
        'stara wersja szła przez getMemoryForAgent(agent) || getActiveMemory() — cały fallback ma zniknąć, nie tylko drugą połowę');
});

test('getActiveSystemPromptWithMemory dalej bez fallbacku pamięci', t => {
    const body = methodBodyOf(source, 'getActiveSystemPromptWithMemory');
    t.true(body.length > 0, 'nie znalazłem getActiveSystemPromptWithMemory — kontrolna asercja na sąsiedni wzór');
    t.regex(body, /this\.getAgentMemory\(target\.name\)/);
    t.notRegex(body, /getActiveMemory\(\)/, 'sąsiednia funkcja nie ma i nigdy nie miała tego fallbacku — regresja poszłaby TYLKO w drugiej');
});

// resolveSkillConfig/resolveSubAgentConfig kopiowały bajt-w-bajt ten sam
// blok merge'a `ovr.prompt_append` (łącznie z literałem separatora). Oba mają dziś wołać
// wspólny `_applyPromptAppend` zamiast powielać string.
test('resolveSkillConfig i resolveSubAgentConfig wołają wspólny _applyPromptAppend, nie powielają literału separatora', t => {
    const skillBody = methodBodyOf(source, 'resolveSkillConfig');
    const subBody = methodBodyOf(source, 'resolveSubAgentConfig');
    t.true(skillBody.length > 0, 'nie znalazłem resolveSkillConfig — zmieniła się sygnatura?');
    t.true(subBody.length > 0, 'nie znalazłem resolveSubAgentConfig — zmieniła się sygnatura?');

    const callRe = /this\._applyPromptAppend\(base\.prompt, agent\.name, ovr\.prompt_append\)/;
    t.regex(skillBody, callRe, 'resolveSkillConfig ma delegować do _applyPromptAppend');
    t.regex(subBody, callRe, 'resolveSubAgentConfig ma delegować do _applyPromptAppend');

    const inlineSeparatorRe = /---\s*Instrukcje per-agent/;
    t.notRegex(skillBody, inlineSeparatorRe, 'separator nie powinien być wklejony inline w resolveSkillConfig — to ma być w _applyPromptAppend');
    t.notRegex(subBody, inlineSeparatorRe, 'separator nie powinien być wklejony inline w resolveSubAgentConfig — to ma być w _applyPromptAppend');

    const helperBody = methodBodyOf(source, '_applyPromptAppend');
    t.true(helperBody.length > 0, '_applyPromptAppend musi istnieć jako jedyne miejsce, które zna separator');
    t.regex(helperBody, inlineSeparatorRe);
});

// Kesz nagłówków skrzynki w KomunikatorManager widzi TYLKO mutacje przez metody managera.
// Zapisy Z ZEWNĄTRZ (sesja Claude Code piszącą wprost na dysk przez kontrakt /agent, sync
// Google Drive, obsidian-git pull) go omijają - bez nasłuchu zdarzeń vaulta kesz zamrażałby
// liczniki do najbliższej mutacji PRZEZ PLUGIN. `AgentManager` jest jedynym miejscem, które
// ma `plugin.registerEvent` (Obsidian Component - właściwe sprzątanie przy unload), więc
// wołanie `attachVaultEvents` musi stać TUTAJ, nie w `KomunikatorManager` samym (ten nie ma
// dostępu do `plugin`). `AgentManager.ts` importuje `obsidian` (Notice), więc test czyta
// ŹRÓDŁO regexami - wzór całego tego pliku.
test('konstruktor podpina attachVaultEvents komunikatora z plugin.registerEvent', t => {
    const body = methodBodyOf(source, 'constructor');
    t.true(body.length > 0, 'nie znalazłem constructor w AgentManager.ts — zmieniła się sygnatura?');

    t.regex(body, /this\.komunikatorManager\?\.attachVaultEvents\?\.\(/,
        'konstruktor ma wołać attachVaultEvents na komunikatorManager (optional chaining - komunikator bywa null, kill-switch)');

    t.regex(body, /this\.plugin\?\.registerEvent/,
        'wołanie ma przekazywać plugin.registerEvent — bez niego Obsidian nie sprząta nasłuchu przy unload pluginu (wzór VaultIndexer._registerHooks)');

    // Kolejność: komunikatorManager musi być JUŻ przypisany (`this.komunikatorManager = ...`)
    // ZANIM leci attachVaultEvents - inaczej wołanie trafiłoby w `undefined`.
    const assignIdx = body.indexOf('this.komunikatorManager =');
    const attachIdx = body.indexOf('this.komunikatorManager?.attachVaultEvents');
    t.true(assignIdx >= 0 && attachIdx > assignIdx,
        'attachVaultEvents musi iść PO przypisaniu this.komunikatorManager, nie przed');
});

// `createAgent` gubił zwrotkę `saveAgent` (ścieżka zapisanego YAML-a), więc agent utworzony
// guzikiem „+" chodził z `filePath: null` aż do restartu pluginu. Konsekwencje w tej samej
// sesji: rename zostawiał stary `agent1.yaml` obok nowego (`renameAgentOnDisk` kasuje stary plik
// po `agent.filePath`), a `AgentLoader.deleteAgent` wracał `false` bez kasowania czegokolwiek
// (`if (!agent.filePath) return false`). Zachowanie dyskowe rename'u pokrywa
// `renameAgentFlow.test.ts` (czysty moduł, realne wywołanie) - tutaj, jak w całym tym pliku,
// zostaje strażnik po ŹRÓDLE, bo `AgentManager.ts` nie daje się zaimportować w AVA.
test('createAgent zapisuje ścieżkę pliku na agencie (bez tego rename osierocał stary YAML)', t => {
    const body = methodBodyOf(source, 'createAgent');
    t.true(body.length > 0, 'nie znalazłem createAgent w AgentManager.ts — zmieniła się sygnatura?');

    t.regex(body, /agent\.filePath\s*=\s*await\s+this\.loader\.saveAgent\(agent\)/,
        'zwrotka saveAgent (ścieżka YAML-a) musi wylądować na agencie, nie w koszu');

    t.notRegex(body, /(?<!filePath = )await this\.loader\.saveAgent\(agent\)/,
        'drugie, „gołe" wywołanie saveAgent w createAgent znowu gubiłoby ścieżkę');
});

// Guzik „+" zawsze nadawał nazwę Agent1, a rename nie przenosił `agent1-prep` na nowy slug -
// więc kolejny Agent1 (po zmianie nazwy poprzedniego) dostawał TEGO SAMEGO suba, dzielonego
// przez dwóch agentów. Decyzja: nowy agent startuje z PUSTĄ Ekipą (`_subAgents = []`), zero
// auto-tworzenia suba na dysku - delegacja ad-hoc i tak działa przez generycznego workera
// (`pkm-sub`), a własne suby user odlewa z szablonów (Zaplecze).
test('createAgent nie tworzy automatycznie prep sub-agenta', t => {
    const body = methodBodyOf(source, 'createAgent');
    t.true(body.length > 0, 'nie znalazłem createAgent w AgentManager.ts — zmieniła się sygnatura?');

    t.notRegex(body, /createPrepSubAgent/,
        'createAgent nie może wołać createPrepSubAgent — nowy agent startuje bez subów');
    t.notRegex(body, /_subAgents\.push\(/,
        'createAgent nie może dopisywać niczego do _subAgents — Ekipa świeżego agenta zostaje pusta');
});

// Decyzja właściciela 2026-09: plugin nie dostarcza już ŻADNYCH fabrycznych skilli.
// `SkillLoader.ensureStarterSkills()` (i cały siew starterów) zostały skasowane; `initialize()`
// nie ma prawa ich wołać z powrotem. `AgentManager.ts` importuje `obsidian` przez `Notice`,
// więc `initialize()` nie da się bezpiecznie odpalić w AVA (nie ma jak podstawić prawdziwego
// vaulta bez pociągnięcia całego runtime'u Obsidiana) — jak w całym tym pliku, zostaje strażnik
// po ŹRÓDLE. Zachowanie "boot nie zakłada folderu .pkm-assistant/skills/" pokrywa
// `SkillLoader.test.ts` (`loadAllSkills bez folderu .pkm-assistant/skills/ nie rzuca...`) -
// wywołaniem PRAWDZIWEGO kodu na atrapie vaulta, nie regexem.
test('initialize() nie sieje fabrycznych skilli (ensureStarterSkills skasowane)', t => {
    const body = methodBodyOf(source, 'initialize');
    t.true(body.length > 0, 'nie znalazłem initialize w AgentManager.ts — zmieniła się sygnatura?');

    // Komplet wywołań na skillLoaderze, nie nieobecność jednej nazwy: siew przywrócony pod
    // INNĄ nazwą (seedDefaultSkills, ensureFactorySkills...) też musi tu paść.
    const calls = [...body.matchAll(/this\.skillLoader\.(\w+)\(/g)].map(m => m[1]);
    t.deepEqual(calls, ['loadAllSkills'],
        'initialize() ma na skillLoaderze wołać WYŁĄCZNIE loadAllSkills — każde inne wywołanie to kandydat na siew');
});
