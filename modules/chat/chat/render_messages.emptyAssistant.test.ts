import test from 'ava';
import { render_messages } from './chat_messages.js';

/**
 * Kod review MINOR #4 — restore po BUG C1 potrafi zwrócić `assistant` z pustą treścią i BEZ
 * `tool_calls` (plik ma `**tool_calls:**`, ale JSON się nie sparsował -
 * `parseSessionToolCalls` → `null`, `modules/memory/activeSessionFormat.ts`). Taka wiadomość
 * nie ma czego pokazać poza rzędem akcji (kopiuj/usuń/kciuki) przyczepionym do pustej treści -
 * `render_messages` malował ją mimo to jako pełnoprawną `.cs-message--agent` bez treści.
 *
 * Legalne tool-calling tury (content puste, ale `tool_calls` NIEPUSTE) renderują się jak
 * dotąd - mają chip narzędzia, więc bubla nie jest pusta (dowód: drugi test niżej, budowany
 * na REALNEJ atrapie DOM harnessu, patrz `dom-shim.ts`, żeby liczyć realne dzieci bubla, nie
 * tylko fakt, że coś zostało wywołane).
 */
type TestDynamic = any;

function buildFakeThis(messages: TestDynamic[]): TestDynamic {
    const container: TestDynamic = (globalThis as TestDynamic).createDiv();
    return {
        messages_container: container,
        rollingWindow: { messages },
        plugin: { agentManager: { getActiveAgent: () => ({ name: 'Jaskier', color: '#fff' }) } },
        env: { settings: { pkmAssistant: {} } },
        app: {},
        _drawConnectorLines: () => {},
        scrollToBottom: () => {},
        addMessageActions: () => {},
        _renderMultimodalUserContent: () => {},
        _renderUserText: () => {},
        _renderCacheSavingsBadge: () => {},
        _contentBlocksToText: () => '',
        _container: container,
    };
}

test('MINOR #4: assistant z pustą content i BEZ tool_calls/reasoning nie renderuje pustego bubla', async t => {
    const fakeThis = buildFakeThis([
        { role: 'user', content: 'cześć' },
        { role: 'assistant', content: '' }, // genuinely empty - brak tool_calls, brak reasoning
        { role: 'assistant', content: 'Odpowiedź.' },
    ]);

    await render_messages.call(fakeThis);

    const bubbleClasses = (fakeThis._container.children as TestDynamic[]).map(c => c.className);
    t.deepEqual(bubbleClasses, ['cs-message cs-message--user', 'cs-message cs-message--agent'],
        'pusta wiadomość assistant (bez tool_calls, bez reasoning) NIE dostaje własnego bubla');
});

test('assistant z pustą content ALE z tool_calls dalej renderuje chip narzędzia (brak regresji)', async t => {
    const fakeThis = buildFakeThis([
        { role: 'user', content: 'Przeczytaj notatkę X' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', content: 'treść notatki', tool_call_id: 'call_1' },
        { role: 'assistant', content: 'Notatka mówi tak.' },
    ]);

    await render_messages.call(fakeThis);

    const bubbles = fakeThis._container.children as TestDynamic[];
    t.is(bubbles.length, 3, 'user + tool-calling turn (chip) + finalna odpowiedź - WSZYSTKIE trzy się renderują');
    const toolCallingBubble = bubbles[1];
    t.true(
        toolCallingBubble.children.some((c: TestDynamic) => c.className === 'cs-tool-chip-wrap'),
        'tool-calling tura ma realny chip narzędzia, nie jest pusta',
    );
});

test('assistant z pustą content i BEZ tool_calls, ALE z reasoning_content, dalej renderuje myślenie (brak regresji)', async t => {
    const fakeThis = buildFakeThis([
        { role: 'user', content: 'pomyśl' },
        { role: 'assistant', content: '', reasoning_content: 'rozważam...' },
    ]);

    await render_messages.call(fakeThis);

    const bubbles = fakeThis._container.children as TestDynamic[];
    t.is(bubbles.length, 2, 'blok myślenia liczy się jako treść do pokazania - bubel zostaje');
});
