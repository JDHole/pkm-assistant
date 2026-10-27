import test from 'ava';
import { setLocale, t as tr } from '../../../core/i18n/index.js';
import { SubTaskRegistry, SubTaskNotifier } from '../../sub-agents/index.js';
import { _deliverSubTaskResult } from './chat_streaming.js';

setLocale('pl');

test('wynik z A czeka podczas B i jest przekazany po powrocie do A', async t => {
    const registry = new SubTaskRegistry();
    const notifier = new SubTaskNotifier({ registry });
    t.teardown(() => { notifier.dispose(); registry.dispose(); });
    const origin = { agentName: 'A', sessionPath: 'a.md', sessionEpoch: 'epoch-a', tabKey: 'tab-a' };
    const tabs = [
        { ...origin, sessionId: 'tab-a', isActive: false },
        { agentName: 'B', sessionPath: 'b.md', sessionEpoch: 'epoch-b', sessionId: 'tab-b', isActive: true },
    ];
    const sent: Array<{ tab: string; text: string }> = [];
    const view = {
        chatTabs: tabs, _autoTurnChainCounts: new Map(), _subTaskTurnPending: false, is_generating: false, _drainSuppressed: false,
        env: { settings: { pkmAssistant: { limits: {} } } }, plugin: { subTaskRegistry: registry },
        send_message: (opts: { injectedText: string }) => { sent.push({ tab: tabs.find(tab => tab.isActive)!.sessionId, text: opts.injectedText }); },
    };
    notifier.setDeliverer(task => _deliverSubTaskResult.call(view as never, task));
    const task = registry.create({ id: 'run-a', name: 'worker', agentName: 'A', origin, background: true });
    registry.finish(task, { text: 'Wynik dla A', toolsUsed: [], durationMs: 1000, usage: null });
    t.deepEqual(notifier.pending().map(item => item.id), ['run-a']);
    t.deepEqual(sent, []);
    tabs[1].isActive = false;
    tabs[0].isActive = true;
    notifier.drain();
    await Promise.resolve();
    t.deepEqual(sent, [{ tab: 'tab-a', text: [tr('chat.subagent_notification.header', { name: 'worker', task_id: 'run-a' }), tr('chat.subagent_notification.meta_with_time', { status: tr('chat.subagent_notification.status_done'), seconds: '1.0' }), 'Wynik dla A', tr('chat.subagent_notification.footer')].join('\n\n') }]);
    t.deepEqual(notifier.pending().map(item => item.id), []);
});

function readyTask(registry: SubTaskRegistry, threadId?: string) {
    const owner = { agentName: 'Jaskier', sessionPath: 'sessions/active/main.md', sessionEpoch: 'main-epoch', tabKey: 'main-tab' };
    let thread;
    if (threadId) {
        thread = registry.createThread({ threadId, name: 'pkm-sub', owner, origin: owner, config: {} });
    }
    const task = registry.create({ id: `sub/pkm-sub#${threadId || 'none'}`, name: 'pkm-sub', agentName: owner.agentName,
        background: true, origin: owner, ...(threadId ? { threadId } : {}) });
    registry.finish(task, { text: 'gotowe', toolsUsed: [], durationMs: 1000, usage: null, stoppedBy: 'natural' });
    if (thread) registry.endRun(thread.threadId, { successful: true, transcript: [{ role: 'assistant', content: 'gotowe' }] });
    return { task, thread };
}

test('dostarczenie dodaje subId tylko dla bieżącego wątku idle reusable', async t => {
    for (const mode of ['idle', 'closed', 'missing'] as const) {
        const registry = new SubTaskRegistry();
        const { task, thread } = readyTask(registry, mode === 'missing' ? undefined : `thread-${mode}`);
        if (mode === 'closed') registry.closeThread(thread!.threadId);
        let sentText = '';
        const view = {
            chatTabs: [{ agentName: 'Jaskier', sessionPath: 'sessions/active/main.md', sessionEpoch: 'main-epoch', sessionId: 'main-tab', isActive: true }],
            _autoTurnChainCounts: new Map(), _subTaskTurnPending: false, is_generating: false, _drainSuppressed: false,
            env: { settings: { pkmAssistant: { limits: {} } } },
            plugin: { subTaskRegistry: registry },
            send_message: (opts: { injectedText: string }) => { sentText = opts.injectedText; },
        };
        t.true(_deliverSubTaskResult.call(view as never, task));
        await Promise.resolve();
        const hasInstruction = sentText.includes('narzędzie sub_agent');
        t.is(hasInstruction, mode === 'idle');
        if (mode === 'idle') t.true(sentText.includes(`sub_id=${thread!.threadId}`));
    }
});
