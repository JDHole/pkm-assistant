import test from 'ava';
import { clearModelCache, createModelForRole } from './modelResolver.js';
import { CHAT_PROVIDERS } from './registry.js';
import { CapturingHttpClient, ScriptedTransport } from './testing/harness.js';
import type { ModelRole } from './contracts.js';
import { get_chat_model } from '../chat/chat/chat_model.js';
import { prepareDelegateExecution } from '../tools/DelegateTool.js';

function fixture(useDeviceModels = false) {
    const agent = { name: 'Mira', model: 'lm_studio/legacy-agent',
        models: { main: 'lm_studio/agent-main', researcher: 'lm_studio/agent-research' } };
    const pkm = { useDeviceModels,
        chat: { platform: 'openai', apiKeys: { openai: 'test-key' } },
        modelLibrary: {
            main: [{ platform: 'openai', model: 'device-main', isDefault: true }],
            minion: [{ platform: 'openai', model: 'device-sub', isDefault: true }],
        } };
    const env = { settings: { pkmAssistant: pkm }, config: { chat: {
        providers: CHAT_PROVIDERS, http: new CapturingHttpClient(), transport: new ScriptedTransport(),
    } }, chatModel: createModelForRole(null, 'main') };
    const config = { name: 'helper', description: '', tools: [], role: 'worker', model: 'lm_studio/own-sub' };
    const manager = { getActiveAgent: () => agent, resolveSubAgentConfig: () => config };
    const plugin = { env, agentManager: manager };
    return { agent, pkm, env, config, manager, plugin, view: { env, plugin } };
}

test.beforeEach(() => clearModelCache());

for (const enabled of [false, true]) {
    for (const [role, expected] of [
        ['main', 'agent-main'], ['researcher', 'agent-research'], ['sub_worker', 'agent-main'],
    ] satisfies Array<[ModelRole, string]>) {
        test(`device models ${enabled}: ${role} resolves agent overrides`, t => {
            const f = fixture(enabled);
            const model = createModelForRole(f.plugin, role, f.agent);
            t.is(model?.modelId, enabled ? role === 'researcher' ? 'device-sub' : 'device-main' : expected);
            t.is(model?.providerId, enabled ? 'openai' : 'lm_studio');
            t.is(f.agent.models.main, 'lm_studio/agent-main');
        });
    }
    test(`device models ${enabled}: worker YAML and real delegation preparation`, t => {
        const f = fixture(enabled);
        const result = prepareDelegateExecution({ task: 'Read a note' }, { delegate: { name: 'helper' } },
            f.agent, f.manager, f.plugin);
        if (!result.success) { t.fail(result.error); return; }
        t.is(result.finalModel.modelId, enabled ? 'device-main' : 'own-sub');
        t.is(result.finalModel.providerId, enabled ? 'openai' : 'lm_studio');
        t.is(f.config.model, 'lm_studio/own-sub');
    });
    test(`device models ${enabled}: researcher with its own YAML model`, t => {
        const f = fixture(enabled);
        const model = createModelForRole(f.plugin, 'researcher', { name: 'Mira' }, { model: 'own-researcher' });
        t.is(model?.modelId, enabled ? 'device-sub' : 'own-researcher');
        t.is(model?.providerId, 'openai');
    });
}

test('device models: toggling in a live chat cannot reuse the agent singleton', t => {
    const f = fixture();
    t.is(get_chat_model.call(f.view as never)?.modelId, 'agent-main');
    f.pkm.useDeviceModels = true;
    t.is(get_chat_model.call(f.view as never)?.modelId, 'device-main');
    t.is(get_chat_model.call(f.view as never, { skipCache: true })?.modelId, 'device-main');
    f.pkm.useDeviceModels = false;
    t.is(get_chat_model.call(f.view as never)?.modelId, 'agent-main');
});

test('device models: an unavailable device model does not fall back to the cached agent', t => {
    const f = fixture();
    t.is(get_chat_model.call(f.view as never)?.modelId, 'agent-main');
    f.pkm.useDeviceModels = true;
    f.pkm.chat.apiKeys.openai = '';
    t.is(get_chat_model.call(f.view as never), null);
    f.pkm.chat.apiKeys.openai = 'restored-key';
    t.is(get_chat_model.call(f.view as never)?.modelId, 'device-main');
});

test('device models: legacy agent fallback is also ignored when sub library is empty', t => {
    const f = fixture(true);
    f.pkm.modelLibrary.minion = [];
    t.is(createModelForRole(f.plugin, 'researcher', f.agent), null);
    f.pkm.useDeviceModels = false;
    t.is(createModelForRole(f.plugin, 'researcher', { models: { main: 'lm_studio/canon-main' } })?.modelId, 'canon-main');
});

test('device models: a frozen thread keeps its chosen model when defaults change', t => {
    const f = fixture(true);
    const selected = createModelForRole(f.plugin, 'sub_worker', f.agent, f.config);
    t.is(selected?.modelId, 'device-main');
    f.pkm.modelLibrary.main[0].model = 'new-device-default';
    const next = createModelForRole(f.plugin, 'sub_worker', f.agent, null, false,
        { platform: 'openai', model: 'device-main' });
    t.is(next?.modelId, 'device-main');
    t.is(next?.providerId, 'openai');
});
