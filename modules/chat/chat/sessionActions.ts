import { Notice } from 'obsidian';
import { UiIcons } from '../../crystal-soul/index.js';
import { t } from '../../../core/i18n/index.js';
import { log } from '../../../core/utils/Logger.js';
import type { ChatViewLike } from './chatViewShape.js';
import { isSessionViewAlive } from '../sessionViewLifecycle.js';

/**
 * Rdzeń ręcznej kompresji kontekstu, dzielony przez guzik 🗜️ „Sumaryzuj chat" (`_renderSlimBar`
 * niżej) i komendę `/compress` (`SlashCommandsRegistry.ts`). Oba wołacze MUSZĄ wołać JEDNĄ
 * wspólną gałąź decyzyjną — dwie osobne kopie tej gałęzi mogłyby się rozjechać na dwa różne
 * teksty i18n dla gałęzi „nic się nie zmieniło" tego samego stanu. Kanon: `chat.nothing_to_summarize`.
 *
 * Wołacze zachowują WŁASNE opakowanie: guzik dokłada busy-state + własny catch/Notice błędu
 * (to jest UI dymka, nie logika kompresji), komenda slash dokłada `resetInputArea()`. Wzór
 * eksportu-nie-mixina jak `_tabKey` w `chat_tabs.js` — funkcja przyjmuje `view` jawnie, nie `this`,
 * więc jest bezpieczna do importu wprost z pliku spoza mixinów.
 *
 * @returns `false` gdy za mało wiadomości (kompresja NIE wystartowała), `true` gdy się odbyła.
 */
export async function runManualCompression(view: ChatViewLike): Promise<boolean> {
    if (view.rollingWindow.messages.length < 4) {
        new Notice(t('chat.too_few_messages'));
        return false;
    }
    const result = await view.rollingWindow.performTwoPhaseCompression(false);
    view.updateTokenCounter();
    view._updateTokenPanel();
    if (result.summaryFailed) {
        new Notice(t('chat.summarize_failed'));
    } else if (result.summarized) {
        new Notice(t('chat.summarize_result', { count: view.rollingWindow.summarizationCount, trimmed: result.trimmed }));
    } else if (result.trimmed > 0) {
        new Notice(t('chat.trim_result', { trimmed: result.trimmed }));
    } else {
        new Notice(t('chat.nothing_to_summarize'));
    }
    return true;
}

type SessionActionId = 'new' | 'close' | 'save' | 'consolidate' | 'summarize';
type BusyObserver = (busy: boolean) => void;
interface SessionAction {
    id: SessionActionId;
    label: string;
    icon: string;
    sidebarIcon: (size: number) => string;
    busy: boolean;
    run: (onBusy?: BusyObserver) => Promise<void>;
}

// One action set per view. Busy is an indicator, just as in the original sidebar;
// it must not introduce a new generation/re-entry lock in either presentation.
const actionsByView = new WeakMap<ChatViewLike, SessionAction[]>();

export function getSessionActions(view: ChatViewLike): readonly SessionAction[] {
    const existing = actionsByView.get(view);
    if (existing) return existing;
    const actions: SessionAction[] = [
        {
            id: 'new', label: 'chat.new_chat', icon: 'refresh-cw', sidebarIcon: UiIcons.refresh, busy: false,
            run: async () => {
                try { await view.handleNewSession(); }
                catch (error) {
                    log.error('Chat', 'Nie udało się rozpocząć nowej rozmowy:', error);
                    new Notice(t('chat.session.new_failed'), 6000);
                }
            },
        },
        {
            id: 'close', label: 'chat.close_chat', icon: 'x', sidebarIcon: UiIcons.x, busy: false,
            run: async () => {
                try { await view._closeActiveTab(); }
                catch (error) {
                    log.warn('Chat', `Close tab failed: ${(error as Error)?.message || String(error)}`);
                }
            },
        },
        {
            id: 'save', label: 'chat.save_session', icon: 'save', sidebarIcon: UiIcons.save, busy: false,
            run: async () => { await view.handleSaveSession(); },
        },
        {
            id: 'consolidate', label: 'chat.consolidate', icon: 'brain', sidebarIcon: UiIcons.brain, busy: false,
            run: async (onBusy) => {
                const agentMemory = view.plugin?.agentManager?.getActiveMemory();
                const hasCurrentMessages = view.rollingWindow.messages.length >= 2;
                let hasDiskSessions = false;
                if (agentMemory) {
                    try {
                        const unconsolidated = await agentMemory.getUnconsolidatedSessions();
                        hasDiskSessions = unconsolidated.length >= 1;
                    } catch { /* ignore, as in the sidebar */ }
                }
                if (!isSessionViewAlive(view)) return;
                if (!hasCurrentMessages && !hasDiskSessions) {
                    new Notice(t('chat.no_sessions'));
                    return;
                }
                setBusy('consolidate', true, onBusy);
                try {
                    new Notice(t('chat.consolidating'));
                    await view.consolidateSession();
                    if (!isSessionViewAlive(view)) return;
                    new Notice(t('chat.memory_saved'));
                } catch (error) {
                    log.error('Chat', 'Memory consolidation failed:', error);
                    new Notice(t('chat.consolidate_error'));
                } finally { setBusy('consolidate', false, onBusy); }
            },
        },
        {
            id: 'summarize', label: 'chat.summarize', icon: 'layers', sidebarIcon: UiIcons.layers, busy: false,
            run: async (onBusy) => {
                setBusy('summarize', true, onBusy);
                try { await runManualCompression(view); }
                catch (error) {
                    log.error('Chat', 'Manual compression failed:', error);
                    new Notice(t('chat.summarize_error'));
                } finally { setBusy('summarize', false, onBusy); }
            },
        },
    ];
    function setBusy(id: SessionActionId, busy: boolean, observer?: BusyObserver) {
        actions.find(action => action.id === id)!.busy = busy;
        observer?.(busy);
    }
    actionsByView.set(view, actions);
    return actions;
}
