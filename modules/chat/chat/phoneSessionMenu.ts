import { Menu } from 'obsidian';
import { t } from '../../../core/i18n/index.js';
import { getSessionActions } from './sessionActions.js';
import type { ChatViewLike } from './chatViewShape.js';

/** Temporary phone entry point until the sidebar redesign. Native Obsidian sheet. */
export function showPhoneSessionMenu(view: ChatViewLike, event: MouseEvent): void {
    const menu = new Menu();
    const actions = getSessionActions(view);
    for (const id of ['new', 'save', 'close', 'summarize', 'consolidate'] as const) {
        if (id === 'summarize') menu.addSeparator();
        const action = actions.find(action => action.id === id)!;
        menu.addItem(item => item.setTitle(t(action.label)).setIcon(action.busy ? 'loader' : action.icon)
            .onClick(() => action.run()));
    }
    menu.addSeparator();
    if (view.plugin?.agentManager?.getActiveAgent?.()) {
        menu.addItem(item => item.setTitle(t('chat.artifacts')).setIcon('clipboard')
            .setDisabled(view.is_generating).onClick(() => {
                if (!view.is_generating) view._showArtifactPicker(null);
            }));
    }
    // Topbar counters have no click handler; the actual viewer lives in the hidden sidebar.
    menu.addItem(item => item.setTitle(t('chat.token_viewer.title')).setIcon('chart-pie')
        .onClick(() => view._tokenViewer?.togglePopover()));
    menu.showAtMouseEvent(event);
}
