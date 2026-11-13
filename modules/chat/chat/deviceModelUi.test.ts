import test from 'ava';
import { addDeviceModelHint } from './deviceModelUi.js';
import { getLocale, setLocale } from '../../../core/i18n/index.js';
import { render_messages } from './chat_messages.js';
import { _ensureAgentMessageContainer } from './chat_streaming.js';

test.serial('device model label uses the resolved instance in live chat and after redraw', async t => {
    const locale = getLocale(); setLocale('en'); t.teardown(() => setLocale(locale));
    const agent = { name: 'Mira', models: { main: 'lm_studio/agent-main' } };
    const window = { messages: [] };
    const model = { providerId: 'openai', modelId: 'device-main' };
    const view = { messages_container: createDiv(), rollingWindow: window,
        env: { settings: { pkmAssistant: { useDeviceModels: true } } },
        plugin: { agentManager: { getActiveAgent: () => agent } },
        get_chat_model: () => model, _drawConnectorLines() {},
        _streamCtxMap: new Map([['tab', { rollingWindow: window, agent, chatModel: model }]]),
    };
    _ensureAgentMessageContainer.call(view as never, agent as never);
    t.is(view.messages_container.children[0].children[0].textContent, 'Device model: openai/device-main');
    await render_messages.call(view as never);
    t.is(view.messages_container.children[0].textContent, 'Device model: openai/device-main');
});

test.serial('device hint preserves the original error and names the setting for missing keys and network failures', t => {
    const locale = getLocale(); setLocale('en'); t.teardown(() => setLocale(locale));
    const hint = '\n\nIf the agent’s model is unavailable on this device, configure the library in Settings > PKM Assistant > Models and enable “Use this device’s models”.';
    t.is(addDeviceModelHint('Chat model not configured', {}, { models: { main: 'openai/agent-model' } }),
        'Chat model not configured' + hint);
    t.is(addDeviceModelHint('Failed to fetch', {}, { models: { main: 'lm_studio/local' } },
        { providerId: 'lm_studio', modelId: 'local' }), 'Failed to fetch' + hint);
    t.is(addDeviceModelHint('Network error', {}, { models: { main: { platform: 'openai', model: 'agent-model' } } },
        { providerId: 'openai', modelId: 'agent-model' }), 'Network error' + hint);
});

test('device hint leaves unrelated errors, overridden selections and enabled policy unchanged', t => {
    const agent = { models: { main: 'lm_studio/local' } };
    const selected = { providerId: 'lm_studio', modelId: 'local' } as const;
    t.is(addDeviceModelHint('Context window exceeded', {}, agent, selected), 'Context window exceeded');
    t.is(addDeviceModelHint('Failed to fetch', { useDeviceModels: true }, agent, selected), 'Failed to fetch');
    t.is(addDeviceModelHint('Failed to fetch', {}, agent, { providerId: 'openai', modelId: 'device-main' }), 'Failed to fetch');
    t.is(addDeviceModelHint('Failed to fetch', {}, null, selected), 'Failed to fetch');
});
