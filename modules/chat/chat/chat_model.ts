/**
 * Chat model resolution, mentions, STT, vision helpers.
 * Methods mixed into ChatView.prototype.
 */
import { Notice } from 'obsidian';
import { SkinManager, hexToRgbTriplet, UiIcons, setSvg } from '../../crystal-soul/index.js';
import { createModelForRole, isVisionModel } from '../../models/index.js';
import { AudioRecorder, buildActiveNoteContext, transcribeAudio } from '../../multimodal/index.js';
import { log } from '../../../core/utils/Logger.js';
import { DEFAULT_AUTONOMY, normalizeAutonomy } from '../../../core/index.js';
import { t } from '../../../core/i18n/index.js';
import { createVaultReadPredicate } from './vaultReadGate.js';

// TS-any: receiver legacy mixinów składany runtime przez Object.assign.
type ChatViewMixinContext = any;

/**
 * Create a crystal SVG avatar element for an agent.
 */
export function _createCrystalAvatar(agent: ChatViewMixinContext, size = 28) {
    const svgStr = SkinManager.getCrystal(agent || 'default', { size, glow: false });
    const wrapper = createDiv();
    wrapper.className = 'cs-crystal-avatar';
    setSvg(wrapper, svgStr);
    return wrapper;
}

/**
 * Get the active agent's color (hex).
 */
export function _getAgentColor(this: ChatViewMixinContext) {
    const agent = this.plugin?.agentManager?.getActiveAgent();
    return SkinManager.getAgentColor(agent || 'default');
}

/**
 * Get the active agent's color as RGB triplet for CSS rgba().
 */
export function _getAgentRgb(this: ChatViewMixinContext) {
    return hexToRgbTriplet(this._getAgentColor());
}

/**
 * Get or create the chat model instance from our settings.
 *
 * K18 (AUD-security-112): `agent` pozwala rozwiązać model dla WŁAŚCICIELA tury zamiast dla
 * agenta, który akurat jest na wierzchu. `send_message` podaje go zawsze; brak argumentu =
 * dotychczasowe zachowanie (aktywny agent), bo tak woła to jeszcze UI (podgląd vision itp.).
 */
export function get_chat_model(
    this: ChatViewMixinContext,
    { skipCache = false, agent }: { skipCache?: boolean; agent?: ChatViewMixinContext } = {},
) {
    const activeAgent = agent || this.plugin?.agentManager?.getActiveAgent?.();
    const hasAgentModel = activeAgent?.models?.main || activeAgent?.model;

    if (hasAgentModel) {
        // AUD-wydajnosc-079/RR-08-11: `skipCache` musi dojść do resolvera, nie tylko decydować
        // czy podmienić `env.chatModel` niżej — inaczej dwie tury roli main (dwa taby tego
        // samego agenta, albo tura + konsolidacja pamięci w tle) zawsze dostają TĘ SAMĄ instancję
        // z cache `modelResolver`, mimo że wołacz jawnie zażądał świeżej.
        const agentModel = createModelForRole(this.plugin, 'main', activeAgent, null, skipCache);
        if (agentModel?.stream) {
            const cached = this.env?.chatModel;
            if (!skipCache && cached?.modelKey !== agentModel.modelKey) {
                this.env.chatModel = agentModel;
            }
            log.debug('Chat', `Agent model ${activeAgent.name}: ${agentModel.modelKey}`);
            return agentModel;
        }
    }

    if (!skipCache && this.env?.chatModel?.stream) {
        log.debug('Chat', `Cached model: ${this.env.chatModel.modelKey || 'unknown'}`);
        return this.env.chatModel;
    }

    // L-21 (clean-room, decyzja R13): DRUGA KOPIA DRABINKI SKASOWANA. Ten blok trzymał własne
    // defaulty modeli per platforma, nie znał LM Studio ani xAI, i budował model
    // ręcznie z mapy DI — czyli rozjeżdżał się z `modelResolver` przy każdej zmianie tam.
    // Dziś jest JEDNA drabinka: `createModelForRole`. Ten mixin tylko przypisuje wynik do
    // wspólnego slotu runtime'u (`env.chatModel`), z którego korzystają Stop i delegacja.
    const model = createModelForRole(this.plugin, 'main', activeAgent, null, skipCache);
    if (!model?.stream) return null;
    if (!skipCache) this.env.chatModel = model;
    return model;
}

/**
 * Get default autonomy for a new chat/tab (E2.3 D21 / F12).
 * Autonomy is a per-chat UI policy (whether to ask) — user zmienia ją w locie w pasku czatu.
 * E2.8 A6 (S5): agent MOŻE mieć własną wartość STARTOWĄ (`agent.default_autonomy`), nadrzędną nad
 * globalnym `settings.pkmAssistant.defaultAutonomy`. Kolejność: agent > global > DEFAULT_AUTONOMY.
 * @param {Object} [agent] - aktywny agent (opcjonalny; brak → tylko global default)
 */
export function _getDefaultAutonomy(this: ChatViewMixinContext, agent: ChatViewMixinContext) {
    return normalizeAutonomy(
        agent?.default_autonomy || this.env?.settings?.pkmAssistant?.defaultAutonomy || DEFAULT_AUTONOMY
    );
}

/**
 * Get the researcher model for an agent.
 */
export function _getMinionModel(this: ChatViewMixinContext, agent: ChatViewMixinContext, minionConfig: ChatViewMixinContext) {
    const targetAgent = agent || this.plugin?.agentManager?.getActiveAgent();
    if (targetAgent?.minionEnabled === false) return null;
    return createModelForRole(this.plugin, 'researcher', targetAgent, minionConfig);
}

/**
 * K23 (AUD-security-119): predykat „czy agent TEJ TURY może CZYTAĆ tę ścieżkę".
 *
 * Jedna bramka dla dwóch kanałów, które wciągają pliki vaulta do promptu bez wołania
 * narzędzia: Oczko (osadzenia `![[…]]` z aktywnej notatki) i @-wzmianki. Stoi na TYM SAMYM
 * `checkPermission('vault.read', …)`, co narzędzie `read` — czyli No-Go, pliki chronione,
 * whitelista `focusFolders` i `admin_access`, a nie samo No-Go.
 *
 * Tożsamość agenta bierzemy raz, na starcie tury (`getActiveAgent()` — ten sam, którego
 * chwilę później łapie `chat_streaming` jako właściciela tury), więc przełączenie zakładki
 * w trakcie nie podmienia bramki pod ręką.
 *
 * AUD-testy-025: SAMA DECYZJA (łącznie z fail-closed przy braku `permissionSystem` i przy
 * rzucie bramki) mieszka w czystym `vaultReadGate.ts` i ma tam testy zachowania — ten plik
 * importuje `obsidian`, więc dopóki predykat był tutaj, pilnował go wyłącznie regex po tekście
 * źródła, który nie odróżniał `return …allowed === true;` od `…; return true;`.
 * Tutaj zostaje wyłącznie PODANIE trzech rzeczy z pluginu: systemu uprawnień, tożsamości
 * agenta i logu ostrzeżenia.
 */
function _vaultReadPredicate(view: ChatViewMixinContext): (vaultPath: string) => boolean {
    return createVaultReadPredicate({
        permissionSystem: view?.plugin?.permissionSystem,
        resolveAgent: () => view?.plugin?.agentManager?.getActiveAgent?.(),
        onError: (e) => log.warn('Chat', 'vault.read gate threw — fail-closed deny:', e),
    });
}

/**
 * Oczko: build active note context for system prompt injection.
 * Returns { text, images } where images is an array of image_url content blocks.
 * - Pure image file → text label + image block
 * - Markdown note with embedded images → text content + image blocks for embeds
 * - Plain markdown → text only (images = [])
 *
 * K23: osadzone obrazy przechodzą przez bramkę uprawnień agenta — bez `canReadImage`
 * producent nie wczyta ŻADNEGO (fail-closed, patrz `modules/multimodal/active_note.ts`).
 */
export async function _buildActiveNoteContext(this: ChatViewMixinContext) {
    return buildActiveNoteContext(this.app, { canReadImage: _vaultReadPredicate(this) });
}

/**
 * Check if a model supports vision.
 *
 * AUD-code-review-073: `agent` opcjonalny, z tym samym uzasadnieniem co przy `get_chat_model`
 * (K18) — decyzja o KSZTAŁCIE treści wpisywanej do store w trwającej turze (`_chatExecuteToolCall`)
 * musi pytać o model WŁAŚCICIELA tury, nie o agenta, który akurat jest na wierzchu (user mógł
 * przełączyć zakładkę, gdy tura X w tle generowała obraz). Wołania czysto UI-owe (podgląd
 * ostrzeżenia przed wysyłką, jeszcze przed zamrożeniem właściciela) zostają bez argumentu —
 * tam „aktywny agent" jest właściwym pytaniem.
 */
export function _isCurrentModelVision(this: ChatViewMixinContext, agent?: ChatViewMixinContext) {
    try {
        return isVisionModel(this.get_chat_model({ agent }));
    } catch { return false; }
}

/**
 * Show full-size image overlay.
 */
export function _showImageOverlay(this: ChatViewMixinContext, src: string) {
    const overlay = createDiv();
    overlay.className = 'pkm-image-overlay';
    const fullImg = createEl('img');
    fullImg.src = src;
    overlay.appendChild(fullImg);
    overlay.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
}

/**
 * Toggle audio recording for STT.
 */
export function _toggleRecording(this: ChatViewMixinContext) {
    if (this._audioRecorder?.recording) {
        this._audioRecorder.stop();
        return;
    }

    this._audioRecorder = new AudioRecorder({
        onComplete: async (blob) => {
            this._micBtn.classList.remove('recording');
            setSvg(this._micBtn, UiIcons.microphone(12));

            this._micBtn.empty();
            this._micBtn.createSpan({ cls: 'pkm-stt-spinner', text: '⏳' });
            try {
                const sttSettings = this.env?.settings?.pkmAssistant?.stt || {};
                // Klucze czatu żyją w JEDNEJ puli `pkmAssistant.chat.apiKeys.<platforma>` (ta sama,
                // z której czyta modelResolver i GenerateImageTool). Płaskie `groq_api_key` to kształt
                // sprzed migracji ustawień — migrator przenosi je do puli, więc tu było ZAWSZE puste
                // i mikrofon meldował „brak klucza" mimo wpisanego klucza (bug Kuby 2026-09-06).
                const chatKeys = this.env?.settings?.pkmAssistant?.chat?.apiKeys || {};
                const keys = {
                    openai: chatKeys.openai,
                    groq: chatKeys.groq,
                    gemini: chatKeys.gemini,
                    deepgram: sttSettings.deepgram_api_key,
                    assemblyai: sttSettings.assemblyai_api_key,
                };
                const result = await transcribeAudio(
                    sttSettings.platform,
                    keys,
                    blob,
                    sttSettings.language || 'pl'
                );
                if (result.text) {
                    const current = this.input_area.value;
                    this.input_area.value = current ? current + ' ' + result.text : result.text;
                    this.input_area.focus();
                    this.handleInputResize();
                } else {
                    new Notice(t('chat.model.stt_empty'), 3000);
                }
            } catch (e: ChatViewMixinContext) {
                new Notice(t('chat.model.stt_error', { error: e.message }), 5000);
            } finally {
                setSvg(this._micBtn, UiIcons.microphone(12));
            }
        },
        onError: (e: ChatViewMixinContext) => {
            this._micBtn.classList.remove('recording');
            setSvg(this._micBtn, UiIcons.microphone(12));
            new Notice(t('chat.model.recording_error', { error: e.message }), 4000);
        },
        onTick: (seconds) => {
            this._micBtn.empty();
            this._micBtn.createSpan({ cls: 'pkm-rec-timer', text: `${seconds}s` });
        },
    });

    this._audioRecorder.start();
    this._micBtn.classList.add('recording');
    this._micBtn.empty();
    this._micBtn.createSpan({ cls: 'pkm-rec-timer', text: '0s' });
}

/**
 * Resolve @ mentions in user text.
 */
export async function _resolveMentions(this: ChatViewMixinContext, text: string) {
    const mentionChips = this.mentionAutocomplete?.getMentions() || [];

    if (mentionChips.length === 0) {
        return { displayText: text, contextText: '' };
    }

    const refs = [];
    // K23: ten sam predykat, co Oczko — do tej pory stało tu samo `AccessGuard._isNoGo`,
    // więc wzmianka spoza whitelisty agenta i tak wchodziła do promptu.
    const canRead = _vaultReadPredicate(this);

    for (const m of mentionChips) {
        try {
            if (!canRead(m.path)) {
                log.warn('MentionResolve', `Access denied: ${m.path}`);
                continue;
            }

            if (m.type === 'folder') {
                const folder = this.app.vault.getAbstractFileByPath(m.path);
                const fileCount = folder?.children?.filter((f: ChatViewMixinContext) => f.extension === 'md').length || 0;
                refs.push(`- 📁 Folder: "${m.path}" (${t('chat.model.folder_notes', { count: fileCount })})`);
            } else {
                let file = this.app.vault.getAbstractFileByPath(m.path);
                if (!file) file = this.app.vault.getAbstractFileByPath(m.path + '.md');
                const size = file?.stat?.size ? `${Math.round(file.stat.size / 1024)}KB` : '?';
                refs.push(`- 📄 ${t('chat.model.note_label')}: "${file?.path || m.path}" (${size})`);
            }
        } catch (err) {
            log.error('MentionResolve', `Error for ${m.path}:`, err);
        }
    }

    const displayText = text;
    const contextText = refs.length > 0
        ? `${t('chat.model.mention_context')}\n${refs.join('\n')}`
        : '';

    return { displayText, contextText };
}

/**
 * Extract text from multimodal content blocks array.
 */
export function _contentBlocksToText(blocks: ChatViewMixinContext[]) {
    if (!Array.isArray(blocks)) return String(blocks || '');
    return blocks
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
}

/**
 * Render multimodal user content (text + image thumbnails).
 */
export function _renderMultimodalUserContent(this: ChatViewMixinContext, container: ChatViewMixinContext, contentBlocks: ChatViewMixinContext[], displayText: string) {
    container.createEl('p', { text: displayText });

    const images = contentBlocks.filter(b => b.type === 'image_url');
    if (images.length > 0) {
        const thumbRow = container.createDiv({ cls: 'pkm-attachment-thumbs' });
        for (const img of images) {
            const thumbEl = thumbRow.createEl('img', {
                cls: 'pkm-attachment-thumb',
                attr: {
                    src: img.image_url.url,
                    alt: t('chat.model.attached_image'),
                },
            });
            thumbEl.addEventListener('click', () => this._showImageOverlay(img.image_url.url));
        }
    }
}

/**
 * Cleanup any pending ask_user promise.
 */
export function _cleanupAskUser(this: ChatViewMixinContext) {
    if (this.plugin?._askUserResolve) {
        this.plugin._askUserResolve(null);
    }
    if (this.plugin) {
        this.plugin._askUserPromise = null;
        this.plugin._askUserResolve = null;
        this.plugin._askUserPending = null;
    }
}
