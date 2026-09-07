/**
 * Strażnik PO ŹRÓDLE: `runSaveSessionFlow` (`/save session`, 🧠, SessionCloseModal „archive")
 * musi wołać `createModelForRole` z `callerSkipCache=true` (AUD-wydajnosc-079, RR-08-11).
 *
 * DLACZEGO PO ŹRÓDLE, A NIE BEHAWIORALNIE: `save_session.ts` importuje `obsidian` (`Notice`,
 * `App`), więc AVA nie zaimportuje pliku produkcyjnego — ten sam wzór, co
 * `save_session.noteFailures.test.ts` obok i `modules/chat/chat/chatModelSkipCache.test.ts`.
 *
 * CO PILNUJE: bez piątego argumentu ta ścieżka (jedyna kanoniczna droga konsolidacji od E2.7 K4)
 * dostaje instancję main z `modelResolver._cache` — tę samą, na której może właśnie stać
 * `stream()` aktywnej tury czatu tego samego agenta na innej zakładce (Stop trafia w cudzą turę).
 * Zachowanie samego resolvera ma testy behawioralne w `modules/models/modelResolver.test.ts`
 * ("AUD-wydajnosc-079").
 */
import test from 'ava';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./save_session.ts', import.meta.url), 'utf8');

test('AUD-wydajnosc-079: runSaveSessionFlow woła createModelForRole z callerSkipCache=true', t => {
    t.regex(
        source,
        /mainModel\s*=\s*createModelForRole\(\s*plugin,\s*'main',\s*activeAgent,\s*null,\s*true\s*\)/,
        '/save session przestał wymuszać świeżą instancję (callerSkipCache=true) — znów może ' +
        'dzielić instancję main z aktywną turą czatu tego samego agenta w trakcie stream()'
    );
});
