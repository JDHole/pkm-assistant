import test from 'ava';
import { send_message, _releaseStreamCtx } from './chat_streaming.js';
import { _isCurrentModelVision } from './chat_model.js';
import streamingManager from './StreamingManager.js';
import { RollingWindow } from './RollingWindow.js';
import type { RollingMessage } from './RollingWindow.js';
import type { ChatModel } from '../../models/index.js';
import type { HttpRequestSpec } from '../../../core/index.js';
import { lmStudioProvider } from '../../models/providers/lm_studio.js';
import { makeCtx, makeModel } from '../../models/testing/harness.js';

for (const vision of [true, false]) {
    test.serial(`załącznik i Oczko używają katalogu instancji tury, vision=${vision}`, async t => {
        const modelId = vision ? 'moj-lokalny-model' : 'gpt-4o';
        const sent: HttpRequestSpec[] = [];
        const model = makeModel(lmStudioProvider, {
            ctx: makeCtx({ modelId, models: [{ id: modelId, multimodal: vision }] }),
            transport: { open: async (spec, sink) => {
                sent.push(spec);
                sink.onChunk('data: {"choices":[{"delta":{"content":"Opis"},"finish_reason":"stop"}]}\n\n');
                return { status: 200, headers: {}, body: '' };
            } },
        });
        const cached = makeModel(lmStudioProvider, { ctx: makeCtx({ modelId }) });
        const owner = { name: 'A' };
        const memory = { activeSessionPath: 'a.md', sessionEpoch: 'epoch-a' };
        const rw = new RollingWindow();
        const checks: Array<{ agent: unknown; model: ChatModel | undefined; decision: boolean }> = [];
        const attachment = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } };
        const note = { type: 'image_url', image_url: { url: 'data:image/png;base64,REVG' } };
        const view = {
            leaf: { id: 'vision' }, input_area: { value: 'Opisz' }, inputHistory: [], rollingWindow: rw,
            tokenTracker: { record() {} }, chatTabs: [{ agentName: 'A', sessionId: 'a', isActive: true }],
            _streamCtxMap: new Map(), _preparingTurns: new Map(), _agentStates: new Map(),
            plugin: { agentManager: { getActiveAgent: () => owner, getAgentMemory: () => memory,
                getActiveSystemPromptWithMemory: async () => 'system' } },
            env: { settings: { pkmAssistant: { enableOczko: true, limits: { chat_max_iterations: 1, chat_stream_stall_timeout_ms: 0 } } } },
            app: { workspace: { getActiveFile: () => ({ name: 'note.md' }) } },
            attachmentManager: { hasAttachments: () => true, snapshotAttachments: () => [], clear() {},
                buildMessageContent: (text: string) => ({ content: [{ type: 'text', text }, attachment] }) },
            _buildActiveNoteContext: async () => ({ text: 'Aktywna notatka', images: [note] }),
            _isCurrentModelVision(agent: unknown, instance?: ChatModel) {
                const decision = _isCurrentModelVision.call(this as never, agent as never, instance);
                checks.push({ agent, model: instance, decision });
                return decision;
            },
            get_chat_model: ({ skipCache, agent }: { skipCache?: boolean; agent?: unknown }) => {
                t.is(agent, owner);
                return skipCache ? model : cached;
            },
            is_generating: false, set_generating(value: boolean) { this.is_generating = value; },
            resetInputArea() { this.input_area.value = ''; }, showTypingIndicator() {}, hideTypingIndicator() {},
            _resolveMentions: async (text: string) => ({ displayText: text, contextText: '' }),
            async append_message(role: 'user', content: RollingMessage['content'], _display: unknown, meta: Partial<RollingMessage>) {
                await rw.addMessage(role, content, meta);
            },
            async appendToActiveSession() {}, _chatResolveTools: () => [],
            _chatOnIterationStart() {}, _chatOnToolCallsParsed() {}, _chatOnToolResults() {},
            _chatBeforeContinue() {}, _chatOnUsage() {}, _chatOnBackstop() {},
            _isTurnActiveTab: () => false, _releaseStreamCtx,
            _finalizeTurn() { this.is_generating = false; }, handle_error(error: unknown) { throw error; },
        };
        streamingManager.startStream('other-vision-turn', { agent: 'B' });
        try {
            await send_message.call(view as never, { meta: { origin: 'human', messageTime: '[message time: 2026-11-20 06:00, Friday, UTC+00:00]' } });
            t.deepEqual(checks.map(check => check.decision), [vision, vision]);
            for (const check of checks) { t.is(check.agent, owner); t.is(check.model, model); }
            t.is(sent.length, 1);
            const messages = JSON.parse(sent[0].body!).messages as RollingMessage[];
            t.deepEqual(messages.find(message => message.role === 'user')?.content, [
                { type: 'text', text: '[message time: 2026-11-20 06:00, Friday, UTC+00:00]\nOpisz' },
                ...(vision ? [attachment, note] : [
                    { type: 'text', text: 'Image skipped - the model does not support vision.' },
                    { type: 'text', text: 'Image skipped - the model does not support vision.' },
                ]),
            ]);
            if (!vision) { t.false(sent[0].body!.includes('QUJD')); t.false(sent[0].body!.includes('REVG')); }
        } finally {
            streamingManager.stopStream('other-vision-turn');
            model.stopStream();
        }
    });
}
