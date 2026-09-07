/**
 * AUD-dead-code-124 (2026-09-02) — `DEFAULT_BRIEF_PROMPT` był fabrycznym tekstem dla slotu
 * promptu `brief_prompt`, którego wartości nic w produkcji nie czytało (dawny konsument,
 * `ContextSessionGenerator`, skasowany w E2.9 fazie D). Slot wycięty razem z konsumentem:
 * z `workPrompts.ts` (ta stała), z barrela (`index.ts`) i z listy kluczy resolvera
 * (`core/utils/workPromptResolver.ts` `WORK_PROMPT_KEYS`).
 *
 * `workPrompts.ts` i `modules/memory/index.ts` są node-safe (zero importu `obsidian` — patrz
 * `core/CLAUDE.md` sekcja „Zależności"), więc ten test importuje je BEZPOŚREDNIO zamiast
 * czytać źródło regexem.
 */
import test from 'ava';
import * as workPrompts from './workPrompts.js';
import * as memoryBarrel from './index.js';

test('workPrompts.ts nie eksportuje już DEFAULT_BRIEF_PROMPT', t => {
    t.false('DEFAULT_BRIEF_PROMPT' in workPrompts);
});

test('barrel modules/memory/index.ts nie re-eksportuje DEFAULT_BRIEF_PROMPT', t => {
    t.false('DEFAULT_BRIEF_PROMPT' in memoryBarrel);
});

test('workPrompts.ts zachowuje trzy żywe fabryczne prompty (save_session/archive/summary)', t => {
    t.is(typeof workPrompts.DEFAULT_SAVE_SESSION_PROMPT, 'string');
    t.is(typeof workPrompts.DEFAULT_ARCHIVE_PROMPT, 'string');
    t.is(typeof workPrompts.DEFAULT_SUMMARY_PROMPT, 'string');
    t.true(workPrompts.DEFAULT_SAVE_SESSION_PROMPT.length > 0);
});
