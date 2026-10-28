import test from 'ava';
import { AgentMemory } from '../../memory/index.js';
import { _switchTab } from './chat_tabs.js';
import { appendToActiveSession } from './chat_session.js';
import { RollingWindow } from './RollingWindow.js';

test('zamknięta sesja i nowa zakładka tego samego agenta pozostają aktywne', async t => {
    const files: Record<string, string> = {};
    const folders = new Set<string>();
    const adapter = {
        async exists(path: string) { return path in files || folders.has(path); },
        async mkdir(path: string) { folders.add(path); },
        async read(path: string) { if (!(path in files)) throw new Error(`missing: ${path}`); return files[path]; },
        async write(path: string, content: string) { files[path] = content; },
        async remove(path: string) { delete files[path]; },
        async list(path: string) { return { files: Object.keys(files).filter(p => p.startsWith(`${path}/`)), folders: [...folders].filter(p => p.startsWith(`${path}/`)) }; },
        async stat(path: string) { return path in files ? { mtime: 1 } : null; },
    };
    const memory = new AgentMemory({ adapter } as never, 'Jaskier');
    const agent = { name: 'Jaskier' };
    const manager = { getActiveAgent: () => agent, getAgentMemory: () => memory, switchAgent() {} };
    const ctx: any = {
        plugin: { agentManager: manager }, chatTabs: [{ agentName: 'Inny', sessionId: 'Inny', isActive: true }, { agentName: 'Jaskier', sessionId: 'Jaskier', isActive: false }],
        _agentStates: new Map(), rollingWindow: new RollingWindow(), messages_container: { scrollTop: 0 },
        _createRollingWindow: () => new RollingWindow(), _getDefaultAutonomy: () => 'ask', set_generating() {},
        _updateAutonomyButton() {}, updatePermissionsBadge() {}, renderSkillButtons() {}, updateTokenCounter() {}, _updateTokenPanel() {}, _getAgentRgb: () => '', render_messages() {}, add_welcome_message() {},
    };
    const first = await memory.appendToActiveSession({ type: 'user_message', content: 'Pierwsza rozmowa' });
    await memory.saveSession([{ role: 'user', content: 'Pierwsza rozmowa' }]);
    await _switchTab.call(ctx, 'Jaskier');
    const second = await appendToActiveSession.call(ctx, { type: 'user_message', content: 'Druga rozmowa' });
    const sessions = await memory.listActiveSessions();
    t.not(first, second);
    t.is(sessions.length, 2);
    t.deepEqual(sessions.map(s => files[s.path].includes('Pierwsza rozmowa') ? 'Pierwsza rozmowa' : files[s.path].includes('Druga rozmowa') ? 'Druga rozmowa' : '').sort(), ['Druga rozmowa', 'Pierwsza rozmowa']);
});
