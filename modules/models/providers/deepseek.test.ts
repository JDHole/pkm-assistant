/**
 * AUD-testy-052 (HIGH) — DeepSeek rozpoznaje koniec strumienia DOKŁADNYM dopasowaniem
 * sentinela platformy, nie podciągiem w treści. Dawna implementacja łapała substring
 * `'[DONE]'` / `'"done":true'` w CAŁEJ treści zdarzenia SSE (surowa linia `data: ...` razem
 * z treścią odpowiedzi modelu) zamiast dopasowywać sentinel dokładnie. Skutek: model pisze
 * zdanie, w którym dosłownie występuje „[DONE]" (albo `"done":true`) — strumień „kończy się"
 * w połowie, reszta odpowiedzi ginie CICHO, bez błędu i bez logu. (B.8 DS-03/DS-04)
 *
 * Bug ujawnia się tylko przy REALNYM TIMINGU sieci, dlatego testy świadomie robią `await`
 * (makrozadanie) MIĘDZY porcjami — tak jak prawdziwe bajty spływające w osobnych zdarzeniach.
 *
 * Plik jest `test.serial`, bo scenariusze sterują jednym transportem po kolei.
 */
import test from 'ava';
import { deepseekProvider } from './deepseek.js';
import { PROVIDER_INFO } from '../registry.js';
import { ScriptedTransport, makeCtx, makeModel } from '../testing/harness.js';
import type { ChatRequest, OpenAiCompletion } from '../contracts.js';

const REQ: ChatRequest = { messages: [{ role: 'user', content: 'czesc' }], max_tokens: 128 };

/** Jedna porcja SSE w kształcie DeepSeek/OpenAI, z treścią bezpiecznie zaescapowaną przez JSON. */
function chunkPayload(content: string): string {
    return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

/**
 * Porcja z dodatkowym, NIEFINALNYM polem `done: true` obok `choices` — np. dostawca/proxy,
 * który domiesza pole w stylu Ollamy do kształtu OpenAI. Taka porcja niesie PRAWDZIWY,
 * nieescapowany JSON (`"done":true`) w ramce — inaczej niż w (b), gdzie ten sam tekst
 * WEWNĄTRZ `content` wychodzi z uciekanymi cudzysłowami i nigdy nie mógłby dopasować
 * starego `.includes('"done":true')`.
 */
function chunkPayloadWithDoneField(content: string): string {
    return `data: ${JSON.stringify({ choices: [{ delta: { content } }], done: true })}\n\n`;
}

const delay = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
/** Makrozadanie — porcja „przychodzi" jak z prawdziwej sieci, nie w tym samym ticku co poprzednia. */
const tick = () => new Promise<void>(res => setImmediate(res));
const WISI = Symbol('promisa nie rozstrzygnięta');

/** Czeka na rozstrzygnięcie albo oddaje `WISI` — zamiast wieszać cały bieg testów. */
async function settleOrHang(p: Promise<unknown>, ms = 2000): Promise<unknown> {
    return Promise.race([
        p.then(v => ({ ok: v }), e => ({ err: e })),
        delay(ms).then(() => WISI),
    ]);
}

const contentOf = (resp: unknown): string =>
    String((resp as OpenAiCompletion)?.choices?.[0]?.message?.content || '');

function scripted(): { transport: ScriptedTransport; stream: () => Promise<OpenAiCompletion> } {
    const transport = new ScriptedTransport();
    const model = makeModel(deepseekProvider, {
        transport,
        ctx: makeCtx({ modelId: 'deepseek-chat', apiKey: 'sk-deepseek-test' }),
    });
    return { transport, stream: () => model.stream(REQ, {}) };
}

test.serial('AUD-testy-052(a): prawdziwy sentinel `data: [DONE]` kończy strumień', async t => {
    const { transport, stream } = scripted();
    const p = stream();
    // Otwarcie transportu jest ASYNCHRONICZNE (bilet bramki + łańcuch mikrozadań), więc
    // pierwsza porcja też musi poczekać na swoje makrozadanie — jak każda następna.
    await tick();

    transport.push(chunkPayload('Ala ma kota.'));
    await tick();
    transport.push('data: [DONE]\n\n');
    transport.closeOk();

    const out = await settleOrHang(p);
    t.not(out, WISI, 'promisa ma się rozstrzygnąć na prawdziwym sentinelu');
    t.is(contentOf((out as { ok?: unknown })?.ok), 'Ala ma kota.');
});

test.serial('AUD-testy-052(b): chunk z "[DONE]" w TREŚCI odpowiedzi NIE kończy strumienia — reszta dociera w całości', async t => {
    const { transport, stream } = scripted();
    const p = stream();
    // Otwarcie transportu jest ASYNCHRONICZNE (bilet bramki + łańcuch mikrozadań), więc
    // pierwsza porcja też musi poczekać na swoje makrozadanie — jak każda następna.
    await tick();

    // Model pisze zdanie zawierające dosłownie "[DONE]" — to NIE jest sentinel platformy.
    transport.push(chunkPayload('Zadanie ma status [DONE], ale nie jest ukonczone. '));
    await tick(); // realny timing sieci — druga porcja w OSOBNYM makrozadaniu
    transport.push(chunkPayload('Kontynuuje dalej.'));
    await tick();
    transport.push('data: [DONE]\n\n'); // prawdziwy sentinel dopiero teraz
    transport.closeOk();

    const out = await settleOrHang(p);
    t.not(out, WISI, 'promisa ma się rozstrzygnąć na prawdziwym sentinelu, nie wisieć');
    t.is(
        contentOf((out as { ok?: unknown })?.ok),
        'Zadanie ma status [DONE], ale nie jest ukonczone. Kontynuuje dalej.',
        'substring "[DONE]" w treści NIE jest sentinelem — cała odpowiedź, włącznie z drugą porcją, ma dojść',
    );
});

test.serial('AUD-testy-052(c): porcja z niefinalnym polem `"done":true` obok `choices` NIE kończy strumienia', async t => {
    const { transport, stream } = scripted();
    const p = stream();
    // Otwarcie transportu jest ASYNCHRONICZNE (bilet bramki + łańcuch mikrozadań), więc
    // pierwsza porcja też musi poczekać na swoje makrozadanie — jak każda następna.
    await tick();

    transport.push(chunkPayloadWithDoneField('Raportuje czesciowy wynik. '));
    await tick(); // realny timing sieci — druga porcja w OSOBNYM makrozadaniu
    transport.push(chunkPayload('Dokonczenie zdania.'));
    await tick();
    transport.push('data: [DONE]\n\n'); // prawdziwy sentinel dopiero teraz
    transport.closeOk();

    const out = await settleOrHang(p);
    t.not(out, WISI, 'promisa ma się rozstrzygnąć na prawdziwym sentinelu, nie wisieć');
    t.is(
        contentOf((out as { ok?: unknown })?.ok),
        'Raportuje czesciowy wynik. Dokonczenie zdania.',
        'literał `"done":true` w porcji NIE jest sentinelem — druga porcja ma dojść',
    );
});

/**
 * Flaga `stream_options` jest OPT-IN per dostawca (`ChatProviderInfo.streamUsage`);
 * DeepSeek ją ma, ale TYLKO w torze strumieniowym.
 */
test('DeepSeek: żądanie STREAMINGOWE prosi o usage, non-streaming NIE', t => {
    type ParsedBody = { stream?: boolean; stream_options?: { include_usage?: boolean } };
    const ctx = makeCtx({ modelId: 'deepseek-chat', apiKey: 'sk-deepseek-test' });

    const streaming = JSON.parse(deepseekProvider.buildRequest(REQ, ctx, true).body ?? '{}') as ParsedBody;
    t.true(streaming.stream);
    t.deepEqual(streaming.stream_options, { include_usage: true });

    const complete = JSON.parse(deepseekProvider.buildRequest(REQ, ctx, false).body ?? '{}') as ParsedBody;
    t.is(complete.stream_options, undefined, 'non-streaming i tak dostaje usage — pole byłoby szumem');

    t.is(deepseekProvider.buildRequest(REQ, ctx, true).url, PROVIDER_INFO.deepseek.defaultEndpoint);
});
