/**
 * AgentManager.ts importuje `obsidian` (Notice), więc AVA nie umie go zaimportować wprost —
 * strażnik czyta ŹRÓDŁO regexami. Wzór: `modules/chat/chat/stopSemantics.test.ts`,
 * `modules/chat/chat/turnOwner.test.ts` (sekcja „po źródle").
 *
 * K18/AUD-code-review-028: `getPromptInspectorDataForAgent` (Inspektor promptu — Prompt →
 * Podgląd / Kopiuj w profilu agenta) miało fail-OPEN fallback `this.getMemoryForAgent?.(agent)
 * || this.getActiveMemory()`. Gdy `agentMemories` nie miało jeszcze wpisu dla OGLĄDANEGO agenta
 * (np. padnięta inicjalizacja pamięci w `initialize()` — agent jest w `this.agents`, ale bez
 * wpisu w `agentMemories`, `catch` w linii ~126 loguje i leci dalej), fallback podstawiał pamięć
 * AKTYWNEGO agenta. Podgląd promptu agenta X pokazywał wtedy brain.md agenta Y — dokładnie ten
 * wzorzec, który K18 zamknął dwadzieścia linii wyżej w `getActiveSystemPromptWithMemory`
 * (`getAgentMemory(target.name)`, bez `||`).
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Kod bez komentarzy — strażnik pilnuje WYWOŁAŃ, nie opisów historii (comment może cytować starą wadę). */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Ciało metody klasy `<name>(...) { ... }` — liczy nawiasy klamrowe, żeby złapać CAŁE ciało. */
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

test('getPromptInspectorDataForAgent adresuje pamięć po NAZWIE oglądanego agenta (AUD-code-review-028)', t => {
    const body = methodBodyOf(source, 'getPromptInspectorDataForAgent');
    t.true(body.length > 0, 'nie znalazłem getPromptInspectorDataForAgent w AgentManager.ts — zmieniła się sygnatura?');

    t.regex(body, /this\.getAgentMemory\(agent\.name\)/,
        'pamięć musi być adresowana po nazwie OGLĄDANEGO agenta (wzór K18 z getActiveSystemPromptWithMemory)');

    t.notRegex(body, /getActiveMemory\(\)/,
        'fail-open fallback na pamięć AKTYWNEGO agenta — inspektor promptu agenta X pokazywałby brain.md agenta Y');

    t.notRegex(body, /getMemoryForAgent/,
        'stara wersja szła przez getMemoryForAgent(agent) || getActiveMemory() — cały fallback ma zniknąć, nie tylko drugą połowę');
});

test('getActiveSystemPromptWithMemory (K18, wzór który 028 miało naśladować) dalej bez fallbacku', t => {
    const body = methodBodyOf(source, 'getActiveSystemPromptWithMemory');
    t.true(body.length > 0, 'nie znalazłem getActiveSystemPromptWithMemory — kontrolna asercja na sąsiedni wzór');
    t.regex(body, /this\.getAgentMemory\(target\.name\)/);
    t.notRegex(body, /getActiveMemory\(\)/, 'sąsiednia funkcja nie ma i nigdy nie miała tego fallbacku — regresja poszłaby TYLKO w drugiej');
});

// AUD-code-review-088: resolveSkillConfig/resolveSubAgentConfig kopiowały bajt-w-bajt ten sam
// blok merge'a `ovr.prompt_append` (łącznie z literałem separatora). Oba mają dziś wołać
// wspólny `_applyPromptAppend` zamiast powielać string.
test('resolveSkillConfig i resolveSubAgentConfig wołają wspólny _applyPromptAppend, nie powielają literału separatora (AUD-code-review-088)', t => {
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

// W8 follow-up (review koordynatora, 2026-09-02): kesz nagłówków skrzynki w KomunikatorManager
// (AUD-wydajnosc-028/058/101) widzi TYLKO mutacje przez metody managera. Zapisy Z ZEWNĄTRZ
// (sesja Claude Code piszącą wprost na dysk przez kontrakt /agent, sync Google Drive, obsidian-git
// pull) go omijają — bez nasłuchu zdarzeń vaulta kesz zamrażałby liczniki do najbliższej mutacji
// PRZEZ PLUGIN. `AgentManager` jest jedynym miejscem, które ma `plugin.registerEvent` (Obsidian
// Component — właściwe sprzątanie przy unload), więc wołanie `attachVaultEvents` musi stać TUTAJ,
// nie w `KomunikatorManager` samym (ten nie ma dostępu do `plugin`). `AgentManager.ts` importuje
// `obsidian` (Notice), więc test czyta ŹRÓDŁO regexami — wzór całego tego pliku.
test('W8: konstruktor podpina attachVaultEvents komunikatora z plugin.registerEvent (AUD-wydajnosc-028/058/101)', t => {
    const body = methodBodyOf(source, 'constructor');
    t.true(body.length > 0, 'nie znalazłem constructor w AgentManager.ts — zmieniła się sygnatura?');

    t.regex(body, /this\.komunikatorManager\?\.attachVaultEvents\?\.\(/,
        'konstruktor ma wołać attachVaultEvents na komunikatorManager (optional chaining — komunikator bywa null, E1.2 kill-switch)');

    t.regex(body, /this\.plugin\?\.registerEvent/,
        'wołanie ma przekazywać plugin.registerEvent — bez niego Obsidian nie sprząta nasłuchu przy unload pluginu (wzór VaultIndexer._registerHooks)');

    // Kolejność: komunikatorManager musi być JUŻ przypisany (`this.komunikatorManager = ...`)
    // ZANIM leci attachVaultEvents — inaczej wołanie trafiłoby w `undefined`.
    const assignIdx = body.indexOf('this.komunikatorManager =');
    const attachIdx = body.indexOf('this.komunikatorManager?.attachVaultEvents');
    t.true(assignIdx >= 0 && attachIdx > assignIdx,
        'attachVaultEvents musi iść PO przypisaniu this.komunikatorManager, nie przed');
});
