import test from 'ava';
import { setLocale } from '../../../core/i18n/index.js';
import { SubTaskRegistry } from '../../sub-agents/index.js';
import { _deliverSubTaskResult } from './chat_streaming.js';

setLocale('pl');

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
