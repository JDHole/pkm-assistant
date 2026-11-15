import type { App } from 'obsidian';
import type { PluginApi } from '../../core/index.js';
import { ChatView } from './chat_view.js';
import { CHAT_VIEW_TYPE } from './chatViewType.js';
import type { ChatViewLike } from './chat/chatViewShape.js';

/** Profile entry uses the same lifecycle and confirmation as opening in chat. */
export async function openProfileSession(plugin: Pick<PluginApi, 'app' | 'openChatView'>, agentName: string, path: string): Promise<void> {
    const workspace = plugin.app.workspace as unknown as Pick<App['workspace'], 'getLeavesOfType' | 'getRightLeaf'>;
    if (typeof workspace.getLeavesOfType !== 'function') throw new Error('Chat workspace unavailable');
    let leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    if (!leaf) {
        const created = workspace.getRightLeaf(false);
        if (!created) throw new Error('Chat leaf unavailable');
        // openChatView reveals existing views but does not await creation of a new one.
        await created.setViewState({ type: CHAT_VIEW_TYPE, active: true });
        leaf = created;
    }
    await plugin.openChatView();
    const view = leaf.view;
    if (!(view instanceof ChatView)) throw new Error('Chat view unavailable');
    const chat = view as ChatViewLike;
    await chat.handleAgentChange(agentName);
    if (chat.chatTabs.find(tab => tab.isActive)?.agentName !== agentName) return;
    await chat.handleLoadSession(path);
}
