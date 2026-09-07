import test from 'ava';
import { deepseekProvider } from './deepseek.js';
import { lmStudioProvider } from './lm_studio.js';
import { CapturingHttpClient, makeCtx } from '../testing/harness.js';
import type { ChatRequest, ProviderContext } from '../contracts.js';

/**
 * Odpowiedź BEZ strumienia i katalog modeli wspólnej bazy kształtu OpenAI
 * (mutacje F10 na `parseCompletion` / `parseChoice` / `listModels` / `parseModelList`).
 *
 * DeepSeek jest tu świadkiem GOŁEJ bazy: nie nadpisuje ani jednego haka, więc jego
 * zachowanie JEST zachowaniem klasy bazowej. LM Studio dokłada dwa haki, które trzeba
 * badać osobno — własną ścieżkę listy modeli (`modelsPath`) i filtr wpisów
 * (`acceptsModel`).
 */
const REQ: ChatRequest = { messages: [{ role: 'user', content: 'hej' }] };
const CTX: ProviderContext = makeCtx({ modelId: 'deepseek-chat' });

// ── Odpowiedź bez strumienia ─────────────────────────────────────────────────

test('metryczka odpowiedzi (id, object, created, model) przechodzi do kształtu kanonicznego', t => {
    const out = deepseekProvider.parseCompletion(
        {
            id: 'cmpl-77',
            object: 'chat.completion',
            created: 1700000000,
            model: 'deepseek-chat',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3 },
        },
        REQ,
        CTX,
    );

    t.is(out.id, 'cmpl-77');
    t.is(out.object, 'chat.completion', 'rodzaj odpowiedzi jest faktem od dostawcy, nie ozdobą');
    t.is(out.created, 1700000000);
    t.is(out.model, 'deepseek-chat');
    t.deepEqual(out.usage, { prompt_tokens: 3 });
});

test('pola metryczki w złym typie są POMIJANE, a nie przepisywane', t => {
    const out = deepseekProvider.parseCompletion(
        { id: 42, object: { kind: 'nonsens' }, created: '2026', model: null, choices: [], usage: {} },
        REQ,
        CTX,
    );

    t.is(out.id, undefined);
    t.is(out.object, undefined);
    t.is(out.created, undefined);
    t.is(out.model, undefined);
});

test('rola w wiadomości: napis przechodzi, śmieć spada na `assistant`', t => {
    const przeszla = deepseekProvider.parseCompletion(
        { choices: [{ index: 0, message: { role: 'tool', content: 'wynik' } }], usage: {} },
        REQ,
        CTX,
    );
    t.is(przeszla.choices[0].message.role, 'tool', 'rolę bierzemy od dostawcy, gdy ją podał');

    const zastepcza = deepseekProvider.parseCompletion(
        { choices: [{ index: 0, message: { role: 123, content: 'wynik' } }], usage: {} },
        REQ,
        CTX,
    );
    t.is(zastepcza.choices[0].message.role, 'assistant', 'brak roli w kształcie napisu = domyślny asystent');
});

test('JEDNO wywołanie narzędzia w odpowiedzi bez strumienia nie znika', t => {
    const out = deepseekProvider.parseCompletion(
        {
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: 'call_A',
                        type: 'function',
                        function: { name: 'vault_read', arguments: '{"path":"notatka.md"}' },
                    }],
                },
            }],
            usage: {},
        },
        REQ,
        CTX,
    );

    const calls = out.choices[0].message.tool_calls;
    t.is(calls?.length, 1, 'jedno wywołanie to już wywołanie — pętla agenta ma je zobaczyć');
    t.is(calls?.[0].id, 'call_A');
    t.is(calls?.[0].function.name, 'vault_read');
    t.is(calls?.[0].function.arguments, '{"path":"notatka.md"}',
        'argumenty przyszły NAPISEM — ponowne pakowanie zrobiłoby z nich napis w napisie');
});

test('argumenty narzędzia podane obiektem zostają zapakowane w napis JSON', t => {
    const out = deepseekProvider.parseCompletion(
        {
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{ id: 'call_B', function: { name: 'web_search', arguments: { q: 'pogoda' } } }],
                },
            }],
            usage: {},
        },
        REQ,
        CTX,
    );

    const call = out.choices[0].message.tool_calls?.[0];
    t.is(call?.function.arguments, '{"q":"pogoda"}', 'kontrakt kanoniczny: argumenty to zawsze NAPIS');
    t.is(call?.function.name, 'web_search');
});

test('brak alternatyw w odpowiedzi daje pustą wiadomość asystenta, nie wyjątek', t => {
    const out = deepseekProvider.parseCompletion({ choices: [], usage: {} }, REQ, CTX);
    t.is(out.choices.length, 1);
    t.is(out.choices[0].message.content, '');
    t.is(out.choices[0].finish_reason, null);
});

// ── Katalog modeli ───────────────────────────────────────────────────────────

const CATALOG = {
    object: 'list',
    data: [
        { id: 'deepseek-chat', object: 'model' },
        { id: 'deepseek-reasoner', object: 'model' },
    ],
};

test('katalog modeli: odpowiedź 200 oddaje WSZYSTKIE wiersze, gdy dostawca nie filtruje', async t => {
    const http = new CapturingHttpClient({ status: 200, body: CATALOG });
    const models = await deepseekProvider.listModels(CTX, http);

    t.deepEqual(models.map(m => m.id), ['deepseek-chat', 'deepseek-reasoner'],
        'baza bez filtra przepuszcza każdy wiersz z identyfikatorem');
    t.is(models[0].object, 'model', 'reszta pól wiersza jedzie razem z identyfikatorem');
    t.is(http.lastSpec?.method, 'GET');
    t.is(http.lastSpec?.url, 'https://api.deepseek.com/models', 'adres z metryczki, gdy platforma nie ma własnej ścieżki');
});

test('katalog modeli: goła tablica od serwera jest równie dobra jak koperta `data`', async t => {
    const http = new CapturingHttpClient({ status: 200, body: [{ id: 'a' }, { id: 'b' }] });
    t.deepEqual((await deepseekProvider.listModels(CTX, http)).map(m => m.id), ['a', 'b']);
});

test('katalog modeli: wiersz bez identyfikatora i śmieć zamiast wiersza wypadają', async t => {
    const http = new CapturingHttpClient({
        status: 200,
        body: { data: [{ id: 'dobry' }, { object: 'model' }, { id: '' }, 'nie-wiersz', { name: 'z-nazwy' }] },
    });

    t.deepEqual((await deepseekProvider.listModels(CTX, http)).map(m => m.id), ['dobry', 'z-nazwy'],
        'identyfikator bierzemy z `id`, a gdy go nie ma — z `name`');
});

test('katalog modeli: zły status i padnięta sieć oddają PUSTĄ listę zamiast rzucać', async t => {
    const zly = new CapturingHttpClient({ status: 404, body: CATALOG });
    t.deepEqual(await deepseekProvider.listModels(CTX, zly), [], 'rozwijane pole Ustawień ma się narysować także wtedy');

    const padniety = new CapturingHttpClient().throwOn(new Error('network down'));
    t.deepEqual(await deepseekProvider.listModels(CTX, padniety), []);
});

test('katalog modeli: LM Studio pyta HOST Z USTAWIEŃ, nie adres z metryczki', async t => {
    const http = new CapturingHttpClient({ status: 200, body: { data: [{ id: 'qwen3' }] } });
    const models = await lmStudioProvider.listModels(makeCtx({ endpoint: 'http://localhost:9999' }), http);

    t.is(http.lastSpec?.url, 'http://localhost:9999/v1/models',
        'demon stoi tam, gdzie user go wskazał — metryczka zna tylko adres domyślny');
    t.deepEqual(models.map(m => m.id), ['qwen3']);
});

test('katalog modeli: filtr dostawcy wycina wiersze spoza czatu', async t => {
    const http = new CapturingHttpClient({
        status: 200,
        body: { data: [{ id: 'qwen3', type: 'llm' }, { id: 'nomic-embed', type: 'embeddings' }] },
    });

    t.deepEqual((await lmStudioProvider.listModels(makeCtx(), http)).map(m => m.id), ['qwen3'],
        'ten sam serwer wystawia obok modeli czatu także wektoryzujące');
});
