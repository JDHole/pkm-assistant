import test from 'ava';
import { RollingWindowMessageStore } from './RollingWindowMessageStore.js';
import type { RollingWindowLike } from './RollingWindowMessageStore.js';

/**
 * Mock RollingWindow — rejestruje wywołania addMessage i oddaje surowe wiadomości.
 * Nie importujemy prawdziwego RollingWindow (ciągnie za sobą Summarizer/i18n) — testujemy
 * WYŁĄCZNIE mapowanie adaptera (role + meta 1:1).
 */
function makeMockRW(): RollingWindowLike {
    const messages: RollingWindowLike['messages'] = [];
    return {
        messages,
        addMessage(role, content, meta = {}) {
            messages.push({ role, content, ...meta });
        },
        getMessagesForAPI() {
            return [{ role: 'system', content: 'sys' }, ...messages] as ReturnType<RollingWindowLike['getMessagesForAPI']>;
        }
    };
}

test('appendAssistant: rola assistant + meta tool_calls/reasoning_content/cache 1:1', (t) => {
    const rw = makeMockRW();
    const store = new RollingWindowMessageStore(rw);

    const meta = {
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'vault_read', arguments: '{}' } }],
        reasoning_content: 'bo tak',
        cache: { cached_tokens: 42 }
    };
    store.appendAssistant('treść', meta);

    t.is(rw.messages.length, 1);
    t.is(rw.messages[0].role, 'assistant');
    t.is(rw.messages[0].content, 'treść');
    t.deepEqual(rw.messages[0].tool_calls, meta.tool_calls);
    t.is(rw.messages[0].reasoning_content, 'bo tak');
    t.deepEqual(rw.messages[0].cache, { cached_tokens: 42 });
});

test('appendAssistant: null/undefined content → pusty string (parytet z dawnym addMessage)', (t) => {
    const rw = makeMockRW();
    const store = new RollingWindowMessageStore(rw);

    store.appendAssistant(null, { tool_calls: [{ id: 'c1' }] });

    t.is(rw.messages[0].content, '');
    t.is(rw.messages[0].role, 'assistant');
});

test('appendToolResult: rola tool + tool_call_id; content string i tablica multimodalna', (t) => {
    const rw = makeMockRW();
    const store = new RollingWindowMessageStore(rw);

    store.appendToolResult('wynik', 'call_1');
    const multimodal = [{ type: 'text', text: 'm' }, { type: 'image_url', image_url: { url: 'x' } }];
    store.appendToolResult(multimodal, 'call_2');

    t.is(rw.messages[0].role, 'tool');
    t.is(rw.messages[0].content, 'wynik');
    t.is(rw.messages[0].tool_call_id, 'call_1');

    t.is(rw.messages[1].role, 'tool');
    t.deepEqual(rw.messages[1].content, multimodal);
    t.is(rw.messages[1].tool_call_id, 'call_2');
});

test('appendUser: rola user + meta 1:1 (_systemNudge)', (t) => {
    const rw = makeMockRW();
    const store = new RollingWindowMessageStore(rw);

    store.appendUser('kontynuuj', { _systemNudge: true });

    t.is(rw.messages[0].role, 'user');
    t.is(rw.messages[0].content, 'kontynuuj');
    t.true(rw.messages[0]._systemNudge);
});

test('getMessagesForAPI deleguje do RollingWindow (z system promptem)', (t) => {
    const rw = makeMockRW();
    const store = new RollingWindowMessageStore(rw);
    store.appendUser('hej');

    const api = store.getMessagesForAPI();
    t.is(api[0].role, 'system');
    t.is(api[1].content, 'hej');
});

test('get messages zwraca surową referencję rw.messages', (t) => {
    const rw = makeMockRW();
    const store = new RollingWindowMessageStore(rw);
    store.appendUser('x');
    t.is(store.messages, rw.messages);
});
