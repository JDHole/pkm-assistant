/**
 * @module chat_artifacts
 * Delegation proposal button extracted from ChatView.
 *
 * Artefakty mają własne UI (zakładka panelu agenta + segment slim bara + chip aktywnego
 * artefaktu), a `todo` - live-widok nad inputem (`_renderTodoPanel`). Ten moduł trzyma tylko
 * przycisk propozycji delegacji (nie-artefaktowy, wołany z `chat_streaming._pendingDelegation`).
 */
import { t } from '../../../core/i18n/index.js';
import { MACHINE_MESSAGE_META } from '../../../core/index.js';
// Receiver mixina = ZŁOŻONY widok (`ChatViewLike`: klasa + osiem paczek mixinów).
// interfejs). Cykl typów chat_view ↔ mixin jest legalny i znika w buildzie (`import type`).
import type { ChatViewLike } from './chatViewShape.js';

/** Propozycja delegacji z wyniku narzędzia `agent_delegate` (czyta ją `chat_streaming`). */
export type DelegationProposal = {
    reason?: string;
    to_name: string;
    /** Nazwa agenta-adresata — jedzie wprost do `handleAgentChange`. */
    to_agent: string;
    context_summary?: string;
};

export function _renderDelegationButton(
    this: ChatViewLike,
    container: HTMLElement,
    data: DelegationProposal,
): void {
    const div = container.createDiv({ cls: 'pkm-delegation-proposal' });
    div.createEl('p', {
        text: data.reason || t('chat.artifact.delegation_proposal', { agent: data.to_name }),
        cls: 'pkm-delegation-reason'
    });
    const btn = div.createEl('button', {
        text: t('chat.artifact.go_to_agent', { agent: data.to_name }),
        cls: 'pkm-delegation-btn'
    });
    btn.addEventListener('click', () => {
        void (async () => {
            btn.disabled = true;
            btn.textContent = t('chat.artifact.switching');
            if (this.rollingWindow.messages.length > 0) {
                await this.handleSaveSession();
            }
            await this.handleAgentChange(data.to_agent);
            const switched = !!this.plugin.agentManager?.getActiveAgent();
            if (!switched) return;

            const delegationMsg = data.context_summary || data.reason || t('chat.artifact.delegation_from');
            this.input_area.value = t('chat.artifact.delegation_msg', { message: delegationMsg, artifacts: '' });
            // `context_summary` pisze MODEL - ta wysyłka jest maszynowa, choć klika ją user. Bez
            // tego znacznika marker `@@skill:` z tekstu modelu wjeżdżałby do promptu systemowego
            // nowego agenta z ramką „użytkownik uruchomił skill".
            window.setTimeout(() => this.send_message({ meta: MACHINE_MESSAGE_META }), 200);
        })();
    });
}
