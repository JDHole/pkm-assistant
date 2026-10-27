import test from 'ava';
import { t as tr, setLocale } from '../../../core/i18n/index.js';
import { createDelegateTool } from '../../tools/index.js';
import { SubTaskRegistry, SubTaskNotifier } from '../../sub-agents/index.js';
import { __test__ as modelsTest } from '../../models/index.js';
import { buildSubTaskNotificationText } from './subTaskNotification.js';

test.serial('odmowa zadania z kolejki dociera do prowadzącego z konkretną przyczyną', async t => {
    setLocale('pl');
    const registry = new SubTaskRegistry();
    const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); setLocale('en'); });
    const delivered: Array<{ id: string; injectedText: string }> = [];
    notifier.setDeliverer(task => { delivered.push({ id: task.id, injectedText: buildSubTaskNotificationText(task) }); return true; });
    const requests: Array<{ complete(text: string): void }> = [];
    class Model {
        modelId = 'worker-model'; providerId = 'ollama';
        _streamGateLimit() { return 1; }
        stream(_payload: unknown, handlers: { done(value: unknown): void }) {
            requests.push({ complete: text => handlers.done({ choices: [{ message: { content: text } }] }) });
        }
        stopStream() {}
    }
    modelsTest.setChatModelFactory(() => new Model() as never);
    let configExists = true;
    const agent = { name: 'Jaskier', activeSubAgents: [{ name: 'badacz' }] };
    const providers = Object.fromEntries(['openai', 'ollama', 'lm_studio', 'anthropic', 'gemini', 'groq', 'deepseek', 'open_router', 'xai'].map(id => [id, { info: { id } }]));
    const plugin = {
        toolRegistry: { filterByAgent: () => [], getTool: () => null }, subTaskRegistry: registry,
        agentManager: { getActiveAgent: () => agent, resolveSubAgentConfig: () => configExists ? { name: 'badacz', tools: [] } : null },
        env: { config: { chat: { providers, http: { send: async () => ({ status: 200, headers: {}, text: '', json: () => ({}) }) }, transport: { open: async () => ({ status: 200, headers: {}, body: '' }) } } },
            settings: { pkmAssistant: { chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } }, modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] }, limits: { max_parallel_delegations: 5 } } } },
    };
    const receipt = await createDelegateTool({}).execute({ tasks: [{ task: 'pierwsze' }, { task: 'drugie', aspect: 'badacz' }] }, {}, plugin as never) as { tasks: Array<{ sub_id: string }> };
    t.is(receipt.tasks.length, 2);
    const [firstId, secondId] = receipt.tasks.map(item => item.sub_id);
    t.is(registry.getThread(firstId)?.phase, 'running');
    t.is(registry.getThread(secondId)?.phase, 'queued');
    configExists = false;
    requests[0].complete('gotowe');
    const deadline = Date.now() + 3000;
    while (!delivered.some(item => item.id === secondId) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    t.deepEqual(registry.getTask(secondId)?.outcome?.end, { kind: 'failed', stage: 'work' });
    t.is(registry.getTask(secondId)?.outcome?.completeness, 'empty');
    t.is(registry.getTask(secondId)?.error, 'Konfiguracja sub-agenta "badacz" nie znaleziona.');
    t.true(delivered.find(item => item.id === secondId)?.injectedText.includes('Konfiguracja sub-agenta "badacz" nie znaleziona.') === true);
    t.true(delivered.find(item => item.id === secondId)?.injectedText.includes(tr('chat.subagent_notification.empty', { reason: tr('chat.subagent_notification.end_failed_work') })) === true);
});
