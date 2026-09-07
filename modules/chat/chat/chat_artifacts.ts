/**
 * @module chat_artifacts
 * Delegation proposal button extracted from ChatView.
 *
 * E2.9 FAZA D: stary świat artefaktów (panel `_toggleArtifactPanel` + `ArtifactProgressModal` +
 * `IdeaReviewModal` + auto-save do `_planStore`/`_chatTodoStore`) SKASOWANY. Artefakty żywe mają
 * własne UI (zakładka panelu agenta + segment slim bara + chip B4), a `todo` — live-widok nad inputem
 * (`_renderTodoPanel`). Został tu tylko przycisk propozycji delegacji (nie-artefaktowy, wołany z
 * `chat_streaming._pendingDelegation`).
 */
import { t } from '../../../core/i18n/index.js';
import { MACHINE_MESSAGE_META } from '../../../core/index.js';

// TS-any: receiver legacy mixina jest składany runtime przez Object.assign(ChatView.prototype, ...).
type ChatViewMixinContext = any;
type DelegationProposal = {
    reason?: string;
    to_name: string;
    to_agent: unknown;
    context_summary?: string;
};

export function _renderDelegationButton(
    this: ChatViewMixinContext,
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
            // K7 (AUD-security-088): `context_summary` pisze MODEL — ta wysyłka jest maszynowa, choć
            // klika ją user. Bez tego znacznika marker `@@skill:` z tekstu modelu wjeżdżałby do promptu
            // systemowego nowego agenta z ramką „użytkownik uruchomił skill".
            window.setTimeout(() => this.send_message({ meta: MACHINE_MESSAGE_META }), 200);
        })();
    });
}

// E2.3 (D21): _renderModeChangeButton usunięty wraz z trybami pracy.
// E2.9 FAZA D: _toggleArtifactPanel/_refreshArtifactPanel/openProgressModal/_autoSaveArtifact usunięte
// (stary świat artefaktów) — patrz nagłówek modułu.
