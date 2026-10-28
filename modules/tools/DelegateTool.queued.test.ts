import test from 'ava';
import { createDelegateTool, createSubAgentTool, stopAllDelegations, __test__ } from './DelegateTool.js';
import type { DelegatePlugin } from './DelegateTool.js';
import { SubTaskRegistry, SubTaskNotifier } from '../sub-agents/index.js';
import { __test__ as modelsTest } from '../models/index.js';
import { QuestionTestClock } from '../sub-agents/test-support/questionTestClock.js';

const PROVIDER_IDS = ['openai', 'ollama', 'lm_studio', 'anthropic', 'gemini', 'groq', 'deepseek', 'open_router', 'xai'];

function makeFixture(clock = new QuestionTestClock()) {
    __test__._resetBackground();
    const registry = new SubTaskRegistry({ questionClock: clock });
    const requests: Array<{ payload: unknown; complete(text: string): void; question(): void }> = [];
    class GatedModel {
        modelId = 'worker-model';
        providerId = 'ollama';
        _streamGateLimit() { return 1; }
        stream(payload: unknown, handlers: { done(value: unknown): void }) {
            requests.push({ payload, complete: text => handlers.done({ choices: [{ message: { content: text } }] }),
                question: () => handlers.done({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
                    { id: 'call-q', type: 'function', function: { name: 'ask_parent', arguments: '{"text":"Jaki zakres?"}' } },
                ] } }] }) });
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
    return { registry, requests, plugin, tool, clock };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
}

test.serial('blokująca delegacja oddaje pytanie, zachowuje bieg i przekazuje wynik raz', async t => {
    const { registry, requests, plugin, tool } = makeFixture();
    const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { stopAllDelegations('unload'); notifier.dispose(); registry.dispose(); __test__._resetModuleUnloaded(); });
    const owner = { agentName: 'Jaskier', sessionPath: 's.md', sessionEpoch: 'e1' };
    const receipt = await tool.execute({ task: 'pierwsze', _invocationOrigin: owner }, {}, plugin) as { sub_id: string };
    await waitUntil(() => requests.length === 1);
    requests[0].complete('gotowe');
    await waitUntil(() => registry.getThread(receipt.sub_id)?.phase === 'idle');
    for (const claim of notifier.claimPending(() => true)) claim.ack();
    const subTool = createSubAgentTool({});
    const pending = subTool.execute({ action: 'task', sub_id: receipt.sub_id, task: 'dalej', background: false,
        _invocationOrigin: owner, _invocationTurnKind: 'user' }, {}, plugin);
    await waitUntil(() => requests.length === 2);
    requests[1].question();
    const question = await pending as { kind: string; task_id: string; sub_id: string; question_id: string; question: string; started: boolean };
    t.deepEqual({ kind: question.kind, subId: question.sub_id, question: question.question, started: question.started,
        background: registry.getTask(question.task_id)?.background },
    { kind: 'question', subId: receipt.sub_id, question: 'Jaki zakres?', started: true, background: true });
    t.is(__test__._backgroundCount(), 1);
    const delivered: string[] = [];
    notifier.setNoticeDeliverer(notice => { delivered.push(notice.kind); return true; });
    notifier.drain();
    t.deepEqual(delivered, []);
    t.is(registry.getQuestionState(question.task_id).kind, 'waiting');
    await subTool.execute({ action: 'message', sub_id: receipt.sub_id, question_id: question.question_id,
        text: 'A/', _invocationOrigin: owner }, {}, plugin);
    await waitUntil(() => requests.length === 3);
    requests[2].question();
    await waitUntil(() => delivered.length === 1);
    const next = registry.getQuestionState(question.task_id);
    if (next.kind !== 'waiting') throw new Error('second question missing');
    await subTool.execute({ action: 'message', sub_id: receipt.sub_id, question_id: next.question.id,
        text: 'B/', _invocationOrigin: owner }, {}, plugin);
    await waitUntil(() => requests.length === 4);
    requests[3].complete('wynik');
    await waitUntil(() => __test__._backgroundCount() === 0);
    notifier.drain();
    t.deepEqual(delivered, ['question', 'result']);
});

test.serial('unload nie zostawia czekającego suba', async t => {
    const { registry, requests, plugin, tool, clock } = makeFixture();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    globalThis.setTimeout = ((fn: (...args: never[]) => void, ms?: number, ...args: never[]) => {
        const handle = originalSetTimeout(fn, ms, ...args);
        if ((ms ?? 0) >= 1000) timers.add(handle);
        return handle;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
        timers.delete(handle);
        originalClearTimeout(handle);
    }) as typeof clearTimeout;
    t.teardown(() => {
        for (const handle of timers) originalClearTimeout(handle);
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    });
    const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); __test__._resetModuleUnloaded(); });
    const owner = { agentName: 'Jaskier', sessionPath: 's.md', sessionEpoch: 'e1' };
    const receipt = await tool.execute({ task: 'pytanie', _invocationOrigin: owner }, {}, plugin) as { task_id: string };
    await waitUntil(() => requests.length === 1);
    requests[0].question();
    await waitUntil(() => registry.getQuestionState(receipt.task_id).kind === 'waiting');
    t.is(registry.getQuestionState(receipt.task_id).kind, 'waiting');
    const task = registry.getTask(receipt.task_id)!;
    registry.stopAll('unload');
    stopAllDelegations('unload');
    notifier.dispose();
    registry.dispose();
    await waitUntil(() => __test__._liveAbortCount() === 0);
    await waitUntil(() => timers.size === 0);
    t.deepEqual({ pendingTimers: clock.pending + timers.size, liveDelegations: __test__._liveAbortCount() },
        { pendingTimers: 0, liveDelegations: 0 });
    t.is(requests.length, 1);
    const state = task.questionState;
    t.is(state?.kind, 'closed');
    if (state?.kind !== 'closed' || state.resolution.kind !== 'cancelled') throw new Error('question was not cancelled');
    t.is(state.resolution.reason, 'unload');
});

test.serial('wynik runnera po wygaśnięciu pytania zachowuje pytanie w rejestrze i zwrotce', async t => {
    const { registry, requests, plugin, tool, clock } = makeFixture();
    t.teardown(() => { stopAllDelegations('unload'); registry.dispose(); __test__._resetModuleUnloaded(); });
    const owner = { agentName: 'Jaskier', sessionPath: 's.md', sessionEpoch: 'e1' };
    const initial = await tool.execute({ task: 'pierwsze', _invocationOrigin: owner }, {}, plugin) as { sub_id: string };
    await waitUntil(() => requests.length === 1);
    requests[0].complete('gotowe');
    await waitUntil(() => registry.getThread(initial.sub_id)?.phase === 'idle');
    registry.events.on('question:opened', () => clock.advance(300000));
    const subTool = createSubAgentTool({});
    const pending = subTool.execute({ action: 'task', sub_id: initial.sub_id, task: 'dalej', background: false,
        _invocationOrigin: owner, _invocationTurnKind: 'user' }, {}, plugin);
    await waitUntil(() => requests.length === 2);
    requests[1].question();
    const result = await pending as { question?: unknown };
    t.deepEqual(result.question, { text: 'Jaki zakres?', resolution: { kind: 'no-answer' }, note: 'The sub-agent received no answer to the question: Jaki zakres?' });
    const task = registry.list().find(item => item.result?.question?.resolution.kind === 'no-answer');
    t.deepEqual(task?.result?.question, result.question);
});

test.serial('pauza działa w pojedynczym tle, liście i blokującej kontynuacji', async t => {
    const originalNow = performance.now;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let now = 0;
    const durations: number[] = [];
    const timers = new Map<ReturnType<typeof setTimeout>, number>();
    Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
    globalThis.setTimeout = ((fn: (...args: never[]) => void, ms?: number, ...args: never[]) => {
        if (ms === 1000 || ms === 600) {
            const handle = originalSetTimeout(fn, 60000, ...args);
            timers.set(handle, ms);
            durations.push(ms);
            return handle;
        }
        return originalSetTimeout(fn, ms, ...args);
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
        timers.delete(handle);
        originalClearTimeout(handle);
    }) as typeof clearTimeout;
    t.teardown(() => {
        for (const handle of timers.keys()) originalClearTimeout(handle);
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
        Object.defineProperty(performance, 'now', { configurable: true, value: originalNow });
    });
    const remaining: number[] = [];
    for (const mode of ['single', 'list', 'blocking'] as const) {
        const { registry, requests, plugin, tool } = makeFixture();
        t.teardown(() => registry.dispose());
        const owner = { agentName: 'Jaskier', sessionPath: 's.md', sessionEpoch: 'e1' };
        const settings = plugin.env!.settings!.pkmAssistant!;
        settings.limits = { max_parallel_delegations: 5, delegation_timeout_ms: 1000 };
        const subTool = createSubAgentTool({});
        let taskId: string;
        let subId: string;
        if (mode === 'blocking') {
            const initial = await tool.execute({ task: 'pierwsze', _invocationOrigin: owner }, {}, plugin) as { sub_id: string };
            await waitUntil(() => requests.length === 1);
            requests[0].complete('gotowe');
            await waitUntil(() => registry.getThread(initial.sub_id)?.phase === 'idle');
            const pending = subTool.execute({ action: 'task', sub_id: initial.sub_id, task: 'dalej', background: false,
                _invocationOrigin: owner, _invocationTurnKind: 'user' }, {}, plugin);
            await waitUntil(() => requests.length === 2);
            now += 400;
            requests[1].question();
            const question = await pending as { task_id: string; sub_id: string };
            taskId = question.task_id;
            subId = question.sub_id;
        } else {
            const args = mode === 'single' ? { task: 'pytanie' } : { tasks: [{ task: 'pytanie' }] };
            const receipt = await tool.execute({ ...args, _invocationOrigin: owner }, {}, plugin) as {
                task_id: string; sub_id: string; tasks: Array<{ task_id: string; sub_id: string }>;
            };
            const item = mode === 'single' ? receipt : receipt.tasks[0];
            taskId = item.task_id;
            subId = item.sub_id;
            await waitUntil(() => requests.length === 1);
            now += 400;
            requests[0].question();
        }
        await waitUntil(() => registry.getQuestionState(taskId).kind === 'waiting');
        now += 1100;
        const state = registry.getQuestionState(taskId);
        t.is(state.kind, 'waiting', mode);
        if (state.kind !== 'waiting') throw new Error(`question expired: ${mode}`);
        await subTool.execute({ action: 'message', sub_id: subId, question_id: state.question.id,
            text: 'A/', _invocationOrigin: owner }, {}, plugin);
        remaining.push(durations[durations.length - 1]);
        const expectedCalls = mode === 'blocking' ? 3 : 2;
        await waitUntil(() => requests.length === expectedCalls);
        requests[expectedCalls - 1].complete('wynik');
        await waitUntil(() => registry.getTask(taskId)?.status === 'done');
        t.is(registry.getTask(taskId)?.outcome?.end.kind, 'finished', mode);
        await waitUntil(() => __test__._backgroundCount() === 0);
        registry.dispose();
    }
    t.deepEqual(remaining, [600, 600, 600]);
});

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
