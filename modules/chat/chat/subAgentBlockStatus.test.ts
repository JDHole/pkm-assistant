/**
 * K7/AUD-code-review-044 (drugi kawałek — wołacze) — czyta `chat_streaming.ts` / `chat_messages.ts`
 * PO ŹRÓDLE, bo oba importują `obsidian` i AVA ich nie uniesie (wzór `stopSemantics.test.ts`).
 *
 * Realna logika (status z jawnego pola, nie z dopasowania stringa) jest przetestowana
 * behawioralnie w `modules/ui-components/SubAgentBlock.test.ts`. Ten strażnik pilnuje DRUGIEJ
 * połowy naprawy: żeby WSZYSTKIE pięć wywołań `createSubAgentBlock(...)` w module czatu
 * faktycznie podawało `status:`, a nie tylko `response:` — inaczej `SubAgentBlock` domyślnie
 * pokazuje „gotowe" (fail-open kosmetyczne, świadomy default modułu ui-components), i regresja
 * wróciłaby po cichu, mimo że sama funkcja w ui-components jest już poprawna.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Wszystkie wywołania `createSubAgentBlock({ ... })` w pliku — treść nawiasu klamrowego argumentu. */
function callArgs(src: string): string[] {
    const out: string[] = [];
    const re = /createSubAgentBlock\(\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
        let depth = 1;
        let i = m.index + m[0].length;
        const start = i;
        while (depth > 0 && i < src.length) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            i++;
        }
        out.push(src.slice(start, i - 1));
    }
    return out;
}

const streaming = readSource('./chat_streaming.ts');
const messages = readSource('./chat_messages.ts');

test('chat_streaming.ts: każde z 4 wywołań createSubAgentBlock podaje status: (AUD-code-review-044)', t => {
    const calls = callArgs(streaming);
    t.is(calls.length, 4, `spodziewałem się 4 wywołań createSubAgentBlock w chat_streaming.ts, znalazłem ${calls.length} — zmieniła się liczba gałęzi?`);
    calls.forEach((call, idx) => {
        t.regex(call, /status:\s*(?:'error'|'success'|toolResultStatus\()/,
            `wywołanie #${idx + 1} nie podaje status: — SubAgentBlock wróci do domyślnego „gotowe"\n${call.slice(0, 200)}`);
    });
});

test('chat_streaming.ts: gałąź transportowego błędu i gałąź !result.success mają status:"error"', t => {
    // Dwie gałęzie strukturalnie ZAWSZE oznaczają porażkę (błąd transportu / result.success===false)
    // — literał, nie toolResultStatus(), bo `result` bywa tu undefined/kształtem spoza konwencji.
    const errorCalls = callArgs(streaming).filter(c => /status:\s*'error'/.test(c));
    t.is(errorCalls.length, 2, 'dokładnie dwie gałęzie (błąd transportu + !result.success) mają być na sztywno "error"');
});

test('chat_messages.ts: odtwarzanie historii liczy status TĄ SAMĄ regułą co makeDisplay obok (AUD-code-review-044)', t => {
    const calls = callArgs(messages);
    t.is(calls.length, 1, `spodziewałem się 1 wywołania createSubAgentBlock w chat_messages.ts, znalazłem ${calls.length}`);
    t.regex(calls[0], /status:\s*toolResultStatus\(tcOutput\)/,
        'historia MUSI liczyć status z toolResultStatus(tcOutput) — dokładnie jak sąsiedni makeDisplay() dla narzędzi nie-subowych, inaczej wraca rozjazd 044');
});
