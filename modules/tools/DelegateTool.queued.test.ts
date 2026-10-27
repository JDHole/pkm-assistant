import test from 'ava';
import { createDelegateTool, stopAllDelegations, __test__ } from './DelegateTool.js';
import type { DelegatePlugin } from './DelegateTool.js';
import { SubTaskRegistry, SubTaskNotifier } from '../sub-agents/index.js';
import { __test__ as modelsTest } from '../models/index.js';

const PROVIDER_IDS = ['openai', 'ollama', 'lm_studio', 'anthropic', 'gemini', 'groq', 'deepseek', 'open_router', 'xai'];

function makeFixture() {
    __test__._resetBackground();
    const registry = new SubTaskRegistry();
    const requests: Array<{ payload: unknown; complete(text: string): void }> = [];
    class GatedModel {
        modelId = 'worker-model';
        providerId = 'ollama';
        _streamGateLimit() { return 1; }
        stream(payload: unknown, handlers: { done(value: unknown): void }) {
            requests.push({ payload, complete: text => handlers.done({ choices: [{ message: { content: text } }] }) });
        }
        stopStream() {}
    }
    const providers = Object.fromEntries(PROVIDER_IDS.map(id => [id, {
        info: { id },
        __testModelClass: GatedModel,
    }]));
    modelsTest.setChatModelFactory(deps => {
        const provider = deps.provider as unknown as { __testModelClass: new () => unknown };
        return new provider.__testModelClass() as never;
    });
    const agent = { name: 'Jaskier', activeSubAgents: [] };
    const plugin = {
        toolRegistry: { filterByAgent: () => [], getTool: () => null },
        subTaskRegistry: registry,
        agentManager: { getActiveAgent: () => agent },
        env: {
            config: { chat: {
                providers,
                http: { send: async () => ({ status: 200, headers: {}, text: '', json: () => ({}) }) },
                transport: { open: async () => ({ status: 200, headers: {}, body: '' }) },
            } },
            settings: { pkmAssistant: {
                chat: { platform: 'ollama', hosts: { ollama: 'http://localhost:11434' } },
                modelLibrary: { minion: [{ platform: 'ollama', model: 'worker-model', isDefault: true }] },
                limits: { max_parallel_delegations: 5 },
            } },
        },
    } as unknown as DelegatePlugin;
    const tool = createDelegateTool({});
    return { registry, requests, plugin, tool };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
}

test.serial('pełny demontaż przy kolejce nie uruchamia drugiego zadania ani nie doręcza po dispose', async t => {
    const { registry, requests, plugin, tool } = makeFixture();
    __test__._resetModuleUnloaded();
    t.teardown(() => { __test__._resetModuleUnloaded(); registry.dispose(); });
    const notifier = new SubTaskNotifier({ registry });
    const delivered: string[] = [];
    notifier.setDeliverer(task => { delivered.push(task.id); return true; });
    const receipt = await tool.execute({ tasks: [{ task: 'pierwsze' }, { task: 'drugie' }] }, {}, plugin) as {
        tasks: Array<{ sub_id: string }>;
    };
    t.is(receipt.tasks.length, 2);
    t.is(registry.getThread(receipt.tasks[1].sub_id)?.phase, 'queued');
    t.is(requests.length, 1);
    registry.stopAll('unload');
    registry.closeAll();
    stopAllDelegations('unload');
    notifier.dispose();
    registry.dispose();
    const countAtDispose = delivered.length;
    requests[0].complete('późna odpowiedź');
    await waitUntil(() => __test__._backgroundCount() === 0);
    notifier.drain();
    t.is(__test__._backgroundCount(), 0);
    t.is(requests.length, 1);
    t.is(delivered.length, countAtDispose);
    t.deepEqual(notifier.pending(), []);
});

test.serial('lista przyjęta przez delegate tworzy od razu wątki running i queued z pokwitowaniem obu sub_id', async t => {
    const { registry, requests, plugin, tool } = makeFixture();
    t.teardown(() => registry.dispose());

    const receipt = await tool.execute({ tasks: [{ task: 'pierwsze' }, { task: 'drugie' }] }, {}, plugin) as {
        started?: boolean;
        tasks?: Array<{ task_id: string; sub_id?: string; queued?: boolean }>;
        queued?: number;
    };

    const threads = registry.listThreads({ agentName: 'Jaskier' });
    t.deepEqual(threads.map(thread => thread.phase), ['running', 'queued']);
    t.is(threads.length, 2);
    t.is(receipt.started, true);
    t.deepEqual(receipt.tasks?.map(task => task.task_id), threads.map(thread => thread.threadId));
    t.deepEqual(receipt.tasks?.map(task => task.sub_id), threads.map(thread => thread.threadId));
    t.deepEqual(receipt.tasks?.map(task => task.queued), [false, true]);
    t.is(receipt.queued, 1);
    t.is(requests.length, 1);
    const ids = threads.map(thread => thread.threadId);
    requests[0].complete('pierwszy gotowy');
    await waitUntil(() => requests.length === 2);
    t.is(requests.length, 2, 'drugi model rusza dopiero po zwolnieniu slotu');
    t.is(registry.getThread(ids[1])?.phase, 'running');
    requests[1].complete('drugi gotowy');
    await waitUntil(() => registry.getTask(ids[1])?.status === 'done');
    t.is(registry.getTask(ids[0])?.status, 'done');
    t.is(registry.getTask(ids[0])?.outcome?.end.kind, 'finished');
    t.is(registry.getTask(ids[1])?.threadId, ids[1], 'zadanie runnera używa ID z rezerwacji');
});

test.serial('zamknięcie wątku queued przed startem nie pyta modelu i zapisuje stopped by user empty', async t => {
    const { registry, requests, plugin, tool } = makeFixture();
    t.teardown(() => registry.dispose());
    const origin = { agentName: 'Jaskier', sessionPath: 'Chats/jaskier.md', sessionEpoch: 'epoch-1', tabKey: 'tab-1' };
    const receipt = await tool.execute({ tasks: [{ task: 'pierwsze' }, { task: 'drugie' }], _invocationOrigin: origin }, {}, plugin) as {
        tasks: Array<{ sub_id: string }>;
    };
    const [firstId, secondId] = receipt.tasks.map(task => task.sub_id);
    t.true(registry.closeThread(secondId, 'user'));

    requests[0].complete('pierwszy gotowy');
    await waitUntil(() => registry.getTask(secondId)?.status === 'done');

    t.is(requests.length, 1, 'drugie zadanie nie wysyła zapytania do modelu');
    t.is(registry.getTask(firstId)?.status, 'done');
    t.deepEqual(registry.getTask(secondId)?.outcome, {
        end: { kind: 'stopped', by: 'user' }, completeness: 'empty', hasAnswer: false, hasMaterial: false, effects: [],
    });
});

test.serial('sub_agent close zamyka rezerwację z nadawcą lead', async t => {
    const { registry, requests, plugin, tool } = makeFixture();
    t.teardown(() => registry.dispose());
    const origin = { agentName: 'Jaskier', sessionPath: 'Chats/jaskier.md', sessionEpoch: 'epoch-2', tabKey: 'tab-2' };
    const receipt = await tool.execute({ tasks: [{ task: 'pierwsze' }, { task: 'drugie' }], _invocationOrigin: origin }, {}, plugin) as {
        tasks: Array<{ sub_id: string }>;
    };
    const secondId = receipt.tasks[1].sub_id;
    const closeTool = (await import('./DelegateTool.js')).createSubAgentTool({});
    const closed = await closeTool.execute({ action: 'close', sub_id: secondId, _invocationOrigin: origin }, {}, plugin) as { success: boolean };
    t.is(closed.success, true);

    requests[0].complete('pierwszy gotowy');
    await waitUntil(() => registry.getTask(secondId)?.status === 'done');
    t.is(requests.length, 1);
    t.deepEqual(registry.getTask(secondId)?.outcome?.end, { kind: 'stopped', by: 'lead' });
});

for (const failAfterCreate of [false, true]) {
    test.serial(`błąd rezerwacji ${failAfterCreate ? 'po zapisie' : 'przed zapisem'} nie uruchamia zadania i zachowuje kompletne pokwitowanie`, async t => {
        const { registry, requests, plugin, tool } = makeFixture();
        t.teardown(() => registry.dispose());
        const createThread = registry.createThread.bind(registry);
        let reservations = 0;
        let failedId = '';
        registry.createThread = input => {
            if (++reservations === 2) {
                failedId = input.threadId;
                if (failAfterCreate) createThread(input);
                throw new Error('reservation failed');
            }
            return createThread(input);
        };

        const receipt = await tool.execute({ tasks: [
            { task: 'pierwsze' }, { task: 'odrzucone' }, { task: 'trzecie' },
        ] }, {}, plugin) as {
            started: boolean;
            tasks: Array<{ task_id: string; sub_id: string; queued: boolean }>;
            queued: number;
            rejected: Array<{ task: string; error: string }>;
        };
        const threads = registry.listThreads({ agentName: 'Jaskier' });
        const accepted = threads.filter(thread => thread.threadId !== failedId);
        const phases = accepted.map(thread => thread.phase);
        const failedPhase = registry.getThread(failedId)?.phase;
        const failedOutcome = registry.getTask(failedId)?.outcome;

        // Rozliczamy pulę także przed asercjami, aby czerwony test nie zostawiał timerów.
        let completed = 0;
        await waitUntil(() => {
            while (completed < requests.length) requests[completed++].complete('gotowy');
            return __test__._backgroundCount() === 0;
        });

        t.is(receipt.started, true);
        t.deepEqual(phases, ['running', 'queued']);
        t.deepEqual(receipt.tasks, accepted.map((thread, i) => ({
            task_id: thread.threadId, name: 'pkm-sub', sub_id: thread.threadId, queued: i === 1,
        })));
        t.is(receipt.queued, 1);
        t.deepEqual(receipt.rejected, [{ task: 'odrzucone', aspect: undefined, error: 'reservation failed' }]);
        t.is(requests.length, 2);
        t.true(JSON.stringify(requests[1]?.payload).includes('trzecie'));
        t.is(registry.getTask(accepted[1].threadId)?.status, 'done');
        t.is(__test__._backgroundCount(), 0);
        if (failAfterCreate) {
            t.is(failedPhase, 'closed');
            t.deepEqual(failedOutcome?.end, { kind: 'failed', stage: 'work' });
            t.is(registry.getTask(failedId)?.status, 'error');
            t.is(registry.getTask(failedId)?.error, 'reservation failed');
        } else {
            t.is(failedPhase, undefined);
        }
    });
}

test.serial('odrzucona pierwsza rezerwacja szybko zwraca błąd wywołującemu', async t => {
    const { registry, requests, plugin, tool } = makeFixture();
    t.teardown(() => registry.dispose());
    registry.createThread = () => { throw new Error('reservation failed'); };

    const receipt = await tool.execute({ tasks: [{ task: 'odrzucone' }] }, {}, plugin) as {
        success: boolean; results: Array<{ success?: boolean; error?: string }>; rejected?: Array<{ task: string; error: string }>;
    };

    t.is(receipt.success, false);
    t.deepEqual(receipt.results, [{ success: false, error: 'reservation failed' }]);
    t.deepEqual(receipt.rejected, [{ task: 'odrzucone', aspect: undefined, error: 'reservation failed' }]);
    t.is(requests.length, 0);
    t.is(__test__._backgroundCount(), 0);
});

test.serial('awaria konfiguracji przed startem zapisuje i doręcza bieg jako błąd', async t => {
    const { registry, requests, plugin, tool } = makeFixture();
    t.teardown(() => registry.dispose());
    (plugin.env!.config!.chat as unknown as { providers: Record<string, unknown> }).providers = {};

    const receipt = await tool.execute({ tasks: [{ task: 'uruchom worker' }] }, {}, plugin) as {
        success: boolean; results: Array<{ success?: boolean; error?: string }>;
    };
    await waitUntil(() => registry.list().some(task => task.status === 'error'));
    const task = registry.list()[0];

    t.is(receipt.success, false);
    t.is(receipt.results[0]?.success, false);
    t.is(receipt.results[0]?.error, task.error);
    t.is(task.status, 'error');
    t.deepEqual(task.outcome?.end, { kind: 'failed', stage: 'work' });
    t.is(registry.getThread(task.threadId!)?.phase, 'closed');
    t.deepEqual(registry.getThread(task.threadId!)?.runIds, [task.id]);
    t.is(requests.length, 0);
});
