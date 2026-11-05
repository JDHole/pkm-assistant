import test from 'ava';
import { ParentConversationProjection, captureSubParentConversation } from './ParentConversation.js';
import { ArrayMessageStore } from '../agent-loop/index.js';
import { SubTaskRegistry } from './SubTaskRegistry.js';
import { QuestionTestClock } from './test-support/questionTestClock.js';
import { RollingWindow } from '../chat/chat/RollingWindow.js';

const owner = { agentName: 'Mira', sessionPath: 'a.md', sessionEpoch: 'epoch-a' };

test('P1: osiem pełnych niepustych wiadomości; starsze zdania z rolą i kolejnością', t => {
    const p = new ParentConversationProjection();
    p.append({ role: 'user', content: 'Pierwsze zdanie. Dalsze szczegóły.' });
    p.append({ role: 'assistant', content: 'Druga odpowiedź! Dodatki.' });
    for (const content of ['3', '4', '5', '6', '7', '8', '9', '10']) p.append({ role: 'user', content });
    p.append({ role: 'assistant', content: '  ', reasoning_content: 'ukryte' });
    t.deepEqual(p.snapshot(), {
        messages: [
            { sequence: 3, role: 'user', text: '3' }, { sequence: 4, role: 'user', text: '4' },
            { sequence: 5, role: 'user', text: '5' }, { sequence: 6, role: 'user', text: '6' },
            { sequence: 7, role: 'user', text: '7' }, { sequence: 8, role: 'user', text: '8' },
            { sequence: 9, role: 'user', text: '9' }, { sequence: 10, role: 'user', text: '10' },
        ], summary: '[1 user] Pierwsze zdanie.\n[2 assistant] Druga odpowiedź!',
        keptMessages: 8, summarizedMessages: 2, omittedMessages: 0, truncated: true,
    });
});

test('P1: PDF/string/image i legacy bez źródła; narzędzia po ID bez argumentów i reasoning', async t => {
    const rw = new RollingWindow();
    await rw.addMessage('user', 'Pytanie + TAJNY PDF', { parentConversationText: 'Pytanie' });
    await rw.addMessage('user', [{ type: 'text', text: 'Zawartość pliku' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,SEKRET' } }], { parentConversationText: '' });
    await rw.addMessage('user', 'Stary nierozdzielalny załącznik');
    await rw.addMessage('assistant', 'Sprawdzam.', { reasoning_content: 'MYŚLENIE', tool_calls: [
        { id: 'a', function: { name: 'read', arguments: '{"secret":"ARGUMENT"}' } },
        { id: 'b', function: { name: 'search', arguments: '{}' } },
        { id: 'never', function: { name: 'write', arguments: '{}' } },
    ] });
    await rw.addMessage('tool', '{"text":"Znaleziono plik.","reasoning":"TAJNE","base64":"BINARIA","args":{"text":"ARGUMENT"}}', { tool_call_id: 'b' });
    await rw.addMessage('tool', [{ type: 'text', text: 'Treść notatki.' }, { type: 'image_url', image_url: { url: 'BINARIA' } }], { tool_call_id: 'a' });
    await rw.addMessage('tool', 'Osierocony.', { tool_call_id: 'orphan' });
    t.deepEqual(rw.parentConversation.snapshot('Deleguję.'), {
        messages: [
            { sequence: 1, role: 'user', text: 'Pytanie' },
            { sequence: 2, role: 'assistant', text: 'Sprawdzam.' },
            { sequence: 3, role: 'tool', text: '[narzędzie: search; wynik: Znaleziono plik.]' },
            { sequence: 4, role: 'tool', text: '[narzędzie: read; wynik: Treść notatki.]' },
            { sequence: 5, role: 'tool', text: '[narzędzie: niedopasowane; wynik: Osierocony.]' },
            { sequence: 6, role: 'assistant', text: 'Deleguję.' },
        ], summary: '', keptMessages: 3, summarizedMessages: 0, omittedMessages: 1, truncated: true,
    });
});

test('P1: kompresja okna nie używa jego skażonego summary; snapshot nie zmienia się po clear', async t => {
    const rw = new RollingWindow({ summarizer: { triggerThreshold: 0.9, summarize: async () => 'PDF i MYŚLENIE w summary' } });
    await rw.addMessage('user', 'PDF', { parentConversationText: 'Moje pytanie' });
    await rw.addMessage('assistant', 'Odpowiedź');
    for (const content of ['3', '4', '5', '6', '7', '8', '9', '10']) await rw.addMessage('assistant', content);
    await rw.performSummarization(true);
    t.is(rw.messages.length, 4);
    t.is(rw.conversationSummary, 'PDF i MYŚLENIE w summary');
    const frozen = rw.parentConversation.snapshot();
    rw.clear();
    await rw.addMessage('user', 'Inna epoka', { parentConversationText: 'Inna epoka' });
    t.deepEqual(frozen, { messages: [
        { sequence: 3, role: 'assistant', text: '3' }, { sequence: 4, role: 'assistant', text: '4' },
        { sequence: 5, role: 'assistant', text: '5' }, { sequence: 6, role: 'assistant', text: '6' },
        { sequence: 7, role: 'assistant', text: '7' }, { sequence: 8, role: 'assistant', text: '8' },
        { sequence: 9, role: 'assistant', text: '9' }, { sequence: 10, role: 'assistant', text: '10' },
    ], summary: '[1 user] Moje pytanie\n[2 assistant] Odpowiedź', keptMessages: 8, summarizedMessages: 2, omittedMessages: 0, truncated: true });
    t.deepEqual(rw.parentConversation.snapshot().messages, [{ sequence: 1, role: 'user', text: 'Inna epoka' }]);
});

test('P1: skrót starszych ma ograniczony łączny rozmiar i jawne pominięcia', t => {
    const p = new ParentConversationProjection();
    for (let i = 0; i < 100; i++) p.append({ role: 'user', content: 'x'.repeat(200) });
    const snapshot = p.snapshot();
    t.deepEqual({ kept: snapshot.keptMessages, summarized: snapshot.summarizedMessages, omitted: snapshot.omittedMessages,
        size: snapshot.summary.length, truncated: snapshot.truncated }, { kept: 8, summarized: 23, omitted: 69, size: 3932, truncated: true });
});

test('P1: wnuk widzi żywy store rodzica; proweniencja przeżywa endRun i kontynuację', t => {
    const registry = new SubTaskRegistry({ questionClock: new QuestionTestClock() });
    t.teardown(() => registry.dispose());
    const thread = registry.createThread({ threadId: 'thread', name: 'worker', owner, origin: owner, config: {} });
    const run = registry.create({ id: 'run', agentName: 'Mira', name: 'worker', taskPreview: 'Zadanie', origin: owner, threadId: thread.threadId, level: 1 });
    const store = new ArrayMessageStore([
        { role: 'system', content: 'System' },
        { role: 'user', content: 'CZAT PROWADZĄCEGO', parentConversationInherited: true },
        { role: 'user', content: 'Zadanie rodzica' },
    ]);
    store.appendAssistant('Własna odpowiedź');
    registry.endRun(thread.threadId, { successful: true, transcript: store.messages });
    registry.finish(run, { text: 'Własna odpowiedź', toolsUsed: [], durationMs: 0, usage: null });
    t.is(registry.beginRun(thread.threadId, owner), true);
    const nextRun = registry.create({ id: 'run-2', agentName: 'Mira', name: 'worker', origin: owner, threadId: thread.threadId, level: 1 });
    const continued = new ArrayMessageStore(thread.transcript);
    continued.appendUser('Kolejne zadanie');
    const context = { runId: nextRun.id, level: 1, origin: owner };
    t.deepEqual(captureSubParentConversation(registry, context, continued.messages, 'ollama', 'Deleguję wnuka'), {
        source: 'sub', owner, turnId: 'run-2', providerId: 'ollama', snapshot: {
            messages: [{ sequence: 1, role: 'user', text: 'Zadanie rodzica' },
                { sequence: 2, role: 'assistant', text: 'Własna odpowiedź' },
                { sequence: 3, role: 'user', text: 'Kolejne zadanie' },
                { sequence: 4, role: 'assistant', text: 'Deleguję wnuka' }],
            summary: '', keptMessages: 4, summarizedMessages: 0, omittedMessages: 0, truncated: false,
        },
    });
    t.is(captureSubParentConversation(registry, { ...context, origin: { ...owner, sessionEpoch: 'new' } }, continued.messages, 'ollama'), undefined);
    t.is(captureSubParentConversation(undefined, context, continued.messages, 'ollama'), undefined);
});

test('P1: tekstowe bloki wyników MCP przechodzą ten sam filtr JSON i binariów co string', t => {
    const projection = new ParentConversationProjection();
    projection.append({ role: 'user', content: 'Zadanie' });
    projection.append({ role: 'tool', content: [
        { type: 'text', text: '{"text":"Wynik","reasoning":"PRYWATNE MYŚLENIE","args":{"secret":"ARGUMENTY"}}' },
        { type: 'text', text: 'data:image/png;base64,TAJNEBINARIA' },
        { type: 'image_url', image_url: { url: 'TAJNY_OBRAZ' } },
    ] });
    t.deepEqual(projection.snapshot().messages, [
        { sequence: 1, role: 'user', text: 'Zadanie' },
        { sequence: 2, role: 'tool', text: '[narzędzie: niedopasowane; wynik: Wynik [pominięte dane]]' },
    ]);
});

test('P1: wyniki search/list/web pozostają tekstowe; nieznany payload nie oznacza skrócenia rozmowy', t => {
    const p = new ParentConversationProjection();
    p.append({ role: 'assistant', content: 'Szukam', tool_calls: [
        { id: 's', function: { name: 'search' } }, { id: 'l', function: { name: 'list' } }, { id: 'w', function: { name: 'web_search' } },
    ] });
    p.append({ role: 'tool', tool_call_id: 's', content: '{"success":true,"results":[{"path":"Plan.md","title":"Plan","excerpt":"Termin: jutro"}]}' });
    p.append({ role: 'tool', tool_call_id: 'l', content: '{"files":[{"name":"Plan.md","path":"Notes/Plan.md"}]}' });
    p.append({ role: 'tool', tool_call_id: 'w', content: '{"results":[{"title":"Źródło","url":"https://example.org","fragment":"Ważny fakt"}]}' });
    p.append({ role: 'tool', content: '{"unknown":"Nieznane pole"}' });
    t.deepEqual(p.snapshot(), { messages: [
        { sequence: 1, role: 'assistant', text: 'Szukam' },
        { sequence: 2, role: 'tool', text: '[narzędzie: search; wynik: Plan.md Plan Termin: jutro]' },
        { sequence: 3, role: 'tool', text: '[narzędzie: list; wynik: Plan.md Notes/Plan.md]' },
        { sequence: 4, role: 'tool', text: '[narzędzie: web_search; wynik: Źródło https://example.org Ważny fakt]' },
        { sequence: 5, role: 'tool', text: '[narzędzie: niedopasowane; wynik: [pominięta treść nietekstowa]]' },
    ], summary: '', keptMessages: 1, summarizedMessages: 0, omittedMessages: 0, truncated: false });
});

test('P1: ucięty JSON nie staje się surowym tekstem z argumentami; tagi myślenia są pomijane', t => {
    const p = new ParentConversationProjection();
    p.append({ role: 'tool', content: '{"args":{"text":"TAJNY ARGUMENT"},"text":"Ucięty wynik' });
    p.append({ role: 'tool', content: 'Wynik <think>TAJNE</think> DATA:image/png;base64,OBRAZ' });
    p.append({ role: 'tool', content: 'Wynik <think>URWANE TAJNE MYŚLENIE' });
    t.deepEqual(p.snapshot(), { messages: [
        { sequence: 1, role: 'tool', text: '[narzędzie: niedopasowane; wynik: [pominięta treść nietekstowa]]' },
        { sequence: 2, role: 'tool', text: '[narzędzie: niedopasowane; wynik: Wynik [pominięte rozumowanie] [pominięte dane]]' },
        { sequence: 3, role: 'tool', text: '[narzędzie: niedopasowane; wynik: Wynik [pominięte rozumowanie]]' },
    ], summary: '', keptMessages: 0, summarizedMessages: 0, omittedMessages: 0, truncated: false });
});

test('powiadomienia subów zachowują treść i własną etykietę, cytat człowieka pozostaje userem', t => {
    const p = new ParentConversationProjection();
    p.append({ role: 'user', content: '[SYSTEM NOTIFICATION] Sub-agent Ada finished task 1.\n\nWynik: las.' });
    p.append({ role: 'user', content: '[SYSTEM NOTIFICATION] Sub-agent Ada asks about task 2: Kiedy?' });
    p.append({ role: 'user', content: '[SYSTEM NOTIFICATION] Co to znaczy?', origin: 'human' });
    t.deepEqual(p.snapshot(), { messages: [
        { sequence: 1, role: 'powiadomienie pluginu', text: '[SYSTEM NOTIFICATION] Sub-agent Ada finished task 1.\n\nWynik: las.' },
        { sequence: 2, role: 'powiadomienie pluginu', text: '[SYSTEM NOTIFICATION] Sub-agent Ada asks about task 2: Kiedy?' },
        { sequence: 3, role: 'user', text: '[SYSTEM NOTIFICATION] Co to znaczy?' },
    ], summary: '', keptMessages: 3, summarizedMessages: 0, omittedMessages: 0, truncated: false });
});
