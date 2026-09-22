/**
 * Strażnik pilnuje, żeby `brief_prompt` nie wrócił do listy `WORK_PROMPTS`: jego wartość nie ma
 * ani jednego czytelnika w produkcji, więc renderowanie dla niego pełnoprawnej kontrolki
 * (Wstaw fabryczny / Przywróć domyślny / textarea + badge „nadpisane") obiecywałoby pracę, która
 * nigdy się nie dzieje. Stara wartość `settings.pkmAssistant.promptDefaults.brief_prompt` u usera
 * jest IGNOROWANA bez błędu - `renderPromptSection` iteruje wyłącznie po `WORK_PROMPTS` (lista
 * stała), nie po kluczach obiektu `promptDefaults`.
 *
 * `prompt_settings.ts` importuje `modules/crystal-soul/index.js`, który re-eksportuje
 * `SkinManager` (importuje `obsidian`) - więc plik nie wstaje w AVA (ten sam problem co
 * `chat_streaming.ts`/`chat_model.ts`, patrz `modules/chat/chat/stopSemantics.test.ts`).
 * Strażnik czyta ŹRÓDŁO regexem.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const source = readSource('./prompt_settings.ts');

/** Wyciąga kluczy `key: 'xxx'` z wnętrza tablicy WORK_PROMPTS. */
function extractWorkPromptKeys(src: string): string[] {
    const arrayMatch = /const WORK_PROMPTS = \[([\s\S]*?)\];/.exec(src);
    if (!arrayMatch) throw new Error('WORK_PROMPTS array not found in prompt_settings.ts');
    const body = arrayMatch[1];
    const keyRe = /key:\s*'([^']+)'/g;
    const keys: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = keyRe.exec(body))) keys.push(m[1]);
    return keys;
}

const workPromptKeys = extractWorkPromptKeys(source);

test('WORK_PROMPTS nie zawiera brief_prompt', t => {
    t.false(workPromptKeys.includes('brief_prompt'));
});

test('WORK_PROMPTS ma pięć żywych slotów (compression/save_session/archive/summary/subagent_frame)', t => {
    t.deepEqual(workPromptKeys, [
        'compression_prompt',
        'save_session_prompt',
        'archive_prompt',
        'summary_prompt',
        'subagent_frame_prompt',
    ]);
});

test('prompt_settings.ts nie importuje już DEFAULT_BRIEF_PROMPT z modules/memory', t => {
    t.false(/DEFAULT_BRIEF_PROMPT/.test(source));
});

// Guzik "Wstaw fabryczny" dla save_session_prompt pisze do GLOBALNEGO nadpisania (dzielonego
// przez wszystkich agentów) - MUSI wstawiać tekst SUROWY (`factoryWorkPromptRaw`, placeholdery
// {{sec_*}}/{{na_teraz_*}} nietknięte), nie wcześnie podstawiony `factoryWorkPrompt` nagłówkami
// języka UI z CHWILI KLIKNIĘCIA. Podstawienie nagłówkami WŁAŚCIWEGO agenta należy do miejsca
// użycia (SaveSessionWorkflow) - inaczej agent z brain.md w drugim języku dostawałby cudze
// nagłówki zamrożone na stałe w globalnym override. Zachowanie samej podmiany jest
// przetestowane behawioralnie w `modules/memory/workPrompts.test.ts` (`factoryWorkPromptRaw`);
// tu pilnujemy WYŁĄCZNIE okablowania - że guzik faktycznie woła TĘ funkcję (recenzja
// niezależna, punkt 8).
test('WORK_PROMPTS: save_session_prompt wstawia RAW (factoryWorkPromptRaw), nie wcześnie podstawiony factoryWorkPrompt', t => {
    const arrayMatch = /const WORK_PROMPTS = \[([\s\S]*?)\];/.exec(source);
    t.truthy(arrayMatch, 'WORK_PROMPTS array not found in prompt_settings.ts');
    const body = arrayMatch![1];
    const lineMatch = /\{\s*key:\s*'save_session_prompt'[\s\S]*?\}/.exec(body);
    t.truthy(lineMatch, 'wpis save_session_prompt nie znaleziony w WORK_PROMPTS');
    const entry = lineMatch![0];

    t.regex(entry, /factoryWorkPromptRaw\('save_session'\)/, 'save_session_prompt ma wołać factoryWorkPromptRaw, nie wcześnie podstawiony factoryWorkPrompt');
    t.notRegex(entry, /factoryWorkPrompt\('save_session'\)/, 'stare wołanie factoryWorkPrompt tu zamrażało nagłówki JEDNEGO agenta w GLOBALNYM nadpisaniu');

    t.regex(source, /import\s*\{[^}]*factoryWorkPromptRaw[^}]*\}\s*from\s*'\.\.\/memory\/index\.js'/, 'factoryWorkPromptRaw musi wejść przez barrel modules/memory/index.js (złota zasada modułów)');
});
