/**
 * AUD-dead-code-124 (2026-09-02) — `brief_prompt` był renderowany w Ustawienia → Prompt jako
 * pełnoprawna kontrolka (Wstaw fabryczny / Przywróć domyślny / textarea + badge „nadpisane"),
 * mimo że jego wartość nie miała ani jednego czytelnika w produkcji (dawny konsument,
 * `ContextSessionGenerator`, skasowany w E2.9 fazie D). Naprawa: slot wycięty z listy
 * `WORK_PROMPTS`, `DEFAULT_BRIEF_PROMPT` skasowany z `modules/memory/workPrompts.ts` i z
 * `WORK_PROMPT_KEYS` (`core/utils/workPromptResolver.ts`). Stara wartość
 * `settings.pkmAssistant.promptDefaults.brief_prompt` u usera ma być IGNOROWANA bez błędu —
 * nikt jej już nie czyta, bo `renderPromptSection` iteruje wyłącznie po `WORK_PROMPTS` (lista
 * stała), nie po kluczach obiektu `promptDefaults`.
 *
 * `prompt_settings.ts` importuje `modules/crystal-soul/index.js`, który re-eksportuje
 * `SkinManager` (importuje `obsidian`) — więc plik nie wstaje w AVA (ten sam problem co
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

test('WORK_PROMPTS nie zawiera brief_prompt (AUD-dead-code-124)', t => {
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
