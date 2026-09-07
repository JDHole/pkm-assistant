/**
 * @module chat_streaming
 * Streaming, tool-call handling and generation control methods extracted from ChatView.
 * All functions use `this` — they are mixed into ChatView.prototype via Object.assign.
 *
 * E2.1 krok B (v2.2): mechanika pętli narzędziowej przeniesiona do modules/agent-loop
 * (runAgentLoop). Ten plik jest TWARZĄ tury czatu: przygotowanie tury (send_message),
 * rendering (handle_chunk), placeholdery/UI narzędzi (hooki) i finalizacja (_finalizeTurn).
 * Iteracje, backstop, sanityzacja transkryptu i obcinanie wyników robi pętla.
 */

import { MarkdownRenderer, Notice } from 'obsidian';
import { SkinManager, hexToRgbTriplet, UiIcons, setSvg, setSvgLabel } from '../../crystal-soul/index.js';
import { buildCacheMetadata, isLocalPlatform } from '../../models/index.js';
import { log } from '../../../core/utils/Logger.js';
// AUD-bledy-027/058/025: status narzędzia i warunek linku „otwórz zapisany plik" liczy JEDNA
// czysta funkcja z core (tę samą czyta MCPClient przy normalizacji i runner subów).
import { countTokens, getTokenCount, calibrate, StreamWatchdog, resolveMessageOrigin, machineMeta, toolResultStatus, shouldLinkWrittenFile } from '../../../core/index.js';
import {
    createCompactToolChip,
    createToolCallDisplay,
    createThinkingBlock,
    updateThinkingBlock,
    createSubAgentBlock,
    createPendingSubAgentBlock,
} from '../../ui-components/index.js';
import { getDateLocale, t } from '../../../core/i18n/index.js';
import streamingManager, { shouldUseFreshModel } from './StreamingManager.js';
import { _tabKey } from './chat_tabs.js';
import { buildSubTaskNotificationText, matchTabForOrigin } from './subTaskNotification.js';
import { stripInlineTriggers, buildInlineTriggerInstruction, getInlineTriggerSummary } from './InlineChipPlugin.js';
import { parseTriggersIfHuman, mayRunSlashCommand, registerUrlsIfHuman } from './messagePrivileges.js';
import { queueChatMessage, readQueuedMessage, evaluateQueuedDrain, evaluateStopQueueCancel } from './queuedMessage.js';
import type { QueueOwner } from './queuedMessage.js';
import { evaluateSubTaskDelivery } from './subTaskDelivery.js';
import { safeErrorText } from './safeErrorText.js';
import { registerUrlsFromText } from '../../web/index.js';
import { getCachedToolTokenBreakdown } from './ToolTokenCache.js';
import { getLimits } from '../../../config/limits.js';
import { runAgentLoop } from '../../agent-loop/index.js';
import { RollingWindowMessageStore } from './RollingWindowMessageStore.js';
import { createTurnAbort, collectTurnsToStop, collectSubTaskIdsForOwners } from './turnAbort.js';
import { freezeTurnOwner } from './turnOwner.js';
import { evaluateAutoTurnChain, resetAutoTurnChain } from './autoTurnChain.js';
import { RenderThrottle, shouldPaintFrame } from './renderThrottle.js';
import type { StreamFrame } from './renderThrottle.js';

// TS-any: receiver legacy mixinów składany runtime przez Object.assign.
type ChatViewMixinContext = any;

function dedupeToolDefinitions(definitions: ChatViewMixinContext[]) {
    const seen = new Set();
    const out = [];
    for (const def of definitions || []) {
        const name = def?.function?.name || def?.name;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push(def);
    }
    return out;
}

function getAgentServerFilter(serverManager: ChatViewMixinContext, agent: ChatViewMixinContext) {
    if (serverManager?.getAllowedServerNamesForAgent) {
        return serverManager.getAllowedServerNamesForAgent(agent);
    }
    return agent?.preferredServers || [];
}

/**
 * AUD-code-review-017: `toolCall.arguments` bywa stringiem JSON zależnie od platformy — ten
 * sam wzorzec „string → JSON.parse w try/catch, inaczej obiekt" żył 7× w tym pliku pod 7 różnymi
 * nazwami (`_subArgs`/`_bgArgs`/`_saArgs`/`_saErrArgs`/`_saArgs2`/`readArgs`/`writeArgs`).
 * Jedna kopia zamiast siedmiu — pominięcie jednej przy przyszłej poprawce dawało po cichu `{}`.
 */
function parseToolCallArgs(toolCall: ChatViewMixinContext): ChatViewMixinContext {
    return typeof toolCall.arguments === 'string'
        ? (() => { try { return JSON.parse(toolCall.arguments); } catch { return {}; } })()
        : (toolCall.arguments || {});
}

/** Licznik tur w procesie — tożsamość tury dla strażnika friendly fire (2026-08-15). */
let _turnSeq = 0;

/**
 * @param opts - F2 faza B: `injectedText` = treść tury, która NIE pochodzi z pola wpisywania
 *   (powiadomienie o wyniku suba z tła). Wtedy `input_area` jest NIETYKANE — user może mieć
 *   tam własny szkic — a ścieżki „to pisał człowiek" (historia inputu, wzmianki `@`, załączniki,
 *   komendy `/`) są pominięte. `meta` ląduje na wiadomości w oknie kontekstu (znacznik
 *   pochodzenia). Kolejka `_queuedMessage` jest dla wstrzykniętej tury pomijana z innego
 *   powodu — wynik suba czeka w kolejce notifiera, nie zajmuje slotu usera.
 *
 *   ⚠️ `send_message` bywa wpięte jako listener kliknięcia, więc pierwszym argumentem potrafi
 *   być `MouseEvent`. Dlatego czytamy z `opts` wyłącznie `injectedText` (z jawnym
 *   `typeof === 'string'`) i `meta` — nigdy nie zakładamy, że to NASZ obiekt.
 *
 *   K7 (2026-08-22): `meta.origin` to PROWENIENCJA — kto napisał tekst. `'human'` nadają
 *   wyłącznie ścieżki z pola wpisywania (guzik Wyślij, Enter, kolejka); brak znacznika =
 *   maszyna (fail-closed). To OSOBNA oś od `injectedText`: ta mówi tylko „tekst NIE pochodzi
 *   z pola wpisywania" (mechanika inputu: historia, załączniki, czyszczenie pola). Wysyłki
 *   z kodu, które pole wpisywania WYPEŁNIAJĄ (guzik artefaktu, propozycja delegacji, komentarz
 *   inline), są `isInjected === false`, a mimo to maszynowe. Nie mylić też z `turnOrigin` niżej
 *   — tamto jest adresem zwrotnym delegacji w tle.
 */
export async function send_message(this: ChatViewMixinContext, opts: ChatViewMixinContext = {}) {
    const injectedText = typeof opts?.injectedText === 'string' ? opts.injectedText.trim() : '';
    const isInjected = injectedText.length > 0;

    // K7: proweniencja liczona RAZ i doklejana do meta wiadomości — dalej pytamy już tylko o nią.
    const messageOrigin = resolveMessageOrigin(opts?.meta);
    const isHuman = messageOrigin === 'human';
    const rawMeta = opts?.meta && typeof opts.meta === 'object' ? opts.meta : {};
    const messageMeta = { ...rawMeta, origin: messageOrigin };

    const rawText = isInjected ? injectedText : this.input_area.value.trim();
    // Markery `@@skill:` parsujemy TYLKO w tekście od człowieka — treść artefaktu, `context_summary`
    // z propozycji delegacji czy wynik suba to cudzy tekst, nie polecenie usera.
    const inlineTriggers = parseTriggersIfHuman(rawText, messageMeta);
    const text = inlineTriggers.length > 0 ? (stripInlineTriggers(rawText) || rawText) : rawText;
    if (!text) return;

    // ── MESSAGE QUEUE: if generating, queue message for after completion ──
    if (this.is_generating) {
        if (isInjected) {
            // Dostawca wyniku sprawdza `is_generating` PRZED wstrzyknięciem, więc tu nie
            // powinniśmy trafić. Jak jednak trafimy — wynik ZOSTAJE w kolejce notifiera
            // (dostawca zwrócił `true` tylko wtedy, gdy tura naprawdę ruszyła), a slotu
            // usera nie wolno zająć powiadomieniem.
            this._subTaskTurnPending = false;
            log.warn('Chat', 'Powiadomienie o subie trafiło na trwającą turę — pomijam wstrzyknięcie');
            return;
        }
        // K19 (AUD-security-117/131): kolejka wozi PROWENIENCJĘ razem z tekstem. Slot NIE bierze
        // się wyłącznie z pola wpisywania — ścieżki, które wypełniają pole z kodu (guzik
        // artefaktu, propozycja delegacji, komentarz inline), trafiają tu tak samo. Bez pieczątki
        // dren nadawał im `human` i treść artefaktu wracała z przywilejami usera.
        // AUD-bledy-015: slot należy do ZAKŁADKI, nie do widoku — zapamiętujemy, kto był na
        // wierzchu. Dren (`set_generating(false)`, wołane też przez `_switchTab`) porówna to
        // z aktualną zakładką i nie wystrzeli wiadomości pisanej do Jaskra w turę Borysa.
        this._queuedMessage = queueChatMessage(rawText, messageMeta, this._queueOwner());
        this.resetInputArea();
        this._showQueuedIndicator(text);
        log.info('Chat', `Wiadomość zakolejkowana (${messageOrigin}): "${text.slice(0, 60)}..."`);
        return;
    }

    // K5 (AUD-security-037): TU stało `this._abortedStream = null` („nowa wiadomość = świeży
    // start"). To była dziura: przerwanie było JEDNYM polem widoku, więc kolejna wiadomość —
    // albo auto-tura z wynikiem suba, albo drain przy przełączeniu zakładki — gasiła przerwanie
    // tury, która WCIĄŻ biegła w narzędziu, i zatrzymana pętla wznawiała iteracje. Od K5
    // przerwanie jest stanem TURY (`turn.abort`, niżej): nowa tura dostaje własny uchwyt
    // i nie ma jak odkręcić przerwania starej. Tu nie ma już czego zerować.

    const sendStart = Date.now();
    // Sprint 03 Z7 hotfix: log.group → log.info (flat) — console.group jest GLOBAL
    // stack, multi-tab parallel send_message powodował że logi Borysa nest-owały
    // się pod grupą Jaskra zamiast osobno. Agent prefix dodany dla czytelności.
    const activeAgentName = this.plugin?.agentManager?.getActiveAgent()?.name || '?';
    log.info('Chat', `[${activeAgentName}] send_message → "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);

    // After long inactivity — just save (session continues, no reset)
    // E2.7 K4 fix: read from settings.pkmAssistant.* (every other pkm setting lives there); the old
    // settings.sessionTimeoutMinutes was the wrong level and always fell back to 30. Now wired to
    // the Settings → Pamięć control (default 30 preserved).
    const timeoutMs = (this.env?.settings?.pkmAssistant?.sessionTimeoutMinutes || 30) * 60 * 1000;
    if (this.lastMessageTimestamp && this.rollingWindow.messages.length > 0) {
        if (Date.now() - this.lastMessageTimestamp > timeoutMs) {
            await this.handleSaveSession();
            log.info('Chat', `Kontynuuję sesję po ${Math.round((Date.now() - this.lastMessageTimestamp) / 60000)} min przerwy`);
        }
    }
    this.lastMessageTimestamp = Date.now();

    // Handle slash commands through registry (Sprint 09 Z8).
    // K7: komenda `/` to polecenie, więc wykonujemy ją WYŁĄCZNIE z tekstu człowieka — tekst
    // maszynowy (wynik suba, treść artefaktu, `context_summary`) może zaczynać się od czegokolwiek.
    if (mayRunSlashCommand(messageMeta) && text.startsWith('/')) {
        if (await this.slashCommands?.execute(text, { view: this, plugin: this.plugin })) {
            return;
        }
    }

    // Add to history (max 20) — historia to pamięć TEGO, co user wpisał (strzałka w górę).
    if (!isInjected) {
        this.inputHistory.push(rawText);
        if (this.inputHistory.length > 20) {
            this.inputHistory.shift();
        }
    }

    // Resolve @ mentions ONCE, before any clearing (fixes bug: mentions lost when no attachments)
    const { displayText: mentionDisplayText, contextText: mentionContextText } = isInjected
        ? { displayText: text, contextText: '' }
        : await this._resolveMentions(text);

    // Capture attachments before clearing.
    // ⚠️ Przy wstrzykniętej turze załączniki usera zostają NIETKNIĘTE — czekają na jego
    // własną wiadomość. Podpięcie ich do powiadomienia zjadłoby mu spinacz bez pytania.
    const hasAttachments = !isInjected && this.attachmentManager?.hasAttachments();
    let attachmentResult = null;
    if (hasAttachments) {
        const textWithMentions = mentionContextText ? mentionContextText + '\n\n' + mentionDisplayText : mentionDisplayText;
        attachmentResult = this.attachmentManager.buildMessageContent(textWithMentions);
        // Warn if sending images to a non-vision model (images will be stripped by adapter)
        const hasImages = Array.isArray(attachmentResult?.content) && attachmentResult.content.some((b: ChatViewMixinContext) => b.type === 'image_url');
        if (hasImages) {
            try {
                if (!this._isCurrentModelVision()) {
                    const modelName = this.get_chat_model()?.modelKey || 'model';
                    new Notice(t('chat.streaming.model_no_vision', { model: modelName }), 6000);
                }
            } catch (e) { /* ignore — adapter will strip anyway */ }
        }
    }

    // Clear input + attachments + mention chips — TYLKO gdy to user wysłał wiadomość.
    // Wstrzyknięta tura nie ma prawa skasować szkicu, który user właśnie pisze.
    if (!isInjected) {
        this.resetInputArea();
        // Z3: szkic przechwycony przez kolejkę wiadomości (patrz `set_generating`) wraca
        // dokładnie tutaj — jednorazowo, po wyczyszczeniu pola przez `resetInputArea`.
        if (this._draftAfterSend) {
            this.input_area.value = this._draftAfterSend;
            this._draftAfterSend = null;
            this.handleInputResize();
        }
        if (hasAttachments) this.attachmentManager.clear();
        if (this.mentionAutocomplete?.hasMentions()) this.mentionAutocomplete.clear();
    }

    let savedUserContent;
    if (hasAttachments && attachmentResult) {
        // Attachments present: content may be array (multimodal) or string
        // Display: user's text with @[Name] badges (no mention metadata)
        await this.append_message('user', attachmentResult.content, mentionDisplayText, messageMeta);
        savedUserContent = mentionDisplayText;
    } else {
        // No attachments: API gets mention context, display shows only user text
        const apiContent = mentionContextText ? mentionContextText + '\n\n' + mentionDisplayText : mentionDisplayText;
        await this.append_message('user', apiContent, mentionContextText ? mentionDisplayText : undefined, messageMeta);
        savedUserContent = apiContent;
    }
    await this.appendToActiveSession?.({
        type: 'user_message',
        agentName: activeAgentName,
        content: savedUserContent,
        timestamp: new Date().toISOString()
    });

    // K18 (AUD-security-112): WŁAŚCICIEL TURY zamrożony DOKŁADNIE TU — razem z zapaleniem
    // guzika Stop i PRZED pierwszym awaitem przygotowania. Za chwilę wchodzimy w budowę promptu
    // z pamięcią (okno „potrafi trwać sekundy", patrz K5 niżej), a `_switchTab` nie jest w tym
    // czasie blokowany i przestawia `agentManager.activeAgent`, `this.rollingWindow`,
    // `this.tokenTracker`. Do K18 tura czytała te lustra PO awaitach, więc rozmowa zaczęta
    // u agenta A — z promptem z JEGO pamięci — kończyła jako tura agenta B (jego model,
    // jego uprawnienia narzędzi, jego plik sesji). Od tej linii wszystko w `send_message`
    // idzie z `owner`; `getActiveAgent()` / `this.rollingWindow` są tu zakazane (pilnuje tego
    // strażnik po źródle w `turnOwner.test.ts`).
    const owner = freezeTurnOwner(this);
    // AUD-code-review-012 (F04, poprawka po blokadzie mergem): klucz `_agentStates` liczony
    // RAZ, TU — zaraz po zamrożeniu właściciela, przed KAŻDYM awaitem tej funkcji — i wożony
    // dalej jako STRING (`turn.origin.tabKey`, `ownerTabKey` w catchu). `_tabKey(turn.owner?.tab)`
    // przeliczany LENIWIE przy sprzątaniu (finalize/error/watchdog, czyli po długich awaitach
    // albo minutach oczekiwania na model) czyta ŻYWE pole `tab.sessionPath` — a `/save session`
    // → „Archiwizuj i nowa sesja" (`archive_new`) podmienia `activeTab.sessionPath` NA MIEJSCU,
    // bez re-keyowania `_agentStates`. Zamrożony klucz sprzed mutacji trafia we wpis, pod którym
    // stan NAPRAWDĘ leży; przeliczony po fakcie — nie.
    const ownerTabKey = _tabKey(owner.tab);
    // Werdykt Kuby 16.08: prawdziwa wiadomość człowieka przerywa ŁAŃCUCH auto-tur PO SUBACH
    // (`_deliverSubTaskResult`, niżej) dla TEGO agenta — inaczej sufit `max_consecutive_auto_turns`
    // liczyłby też tury, które user zaczął sam. `isHuman` to `resolveMessageOrigin(opts?.meta)`
    // policzone na starcie tej funkcji; klucz mapy = `owner.agentName`, ten sam co reszta
    // bookkeepingu per-agent w tym pliku (`_streamCtxMap` / `_agentStates` / `_preparingTurns`).
    // `resetAutoTurnChain()` (zamiast gołego `.delete()`) — reset ma się czytać jako ZDARZENIE,
    // symetryczne do `evaluateAutoTurnChain()` w `_deliverSubTaskResult`, nie jako sprzątanie mapy.
    if (isHuman) this._autoTurnChainCounts?.set(owner.agentName, resetAutoTurnChain());
    // Przechwycone okno + tracker tury: store pętli i cała finalizacja operują na TYM oknie,
    // nawet jeśli user przełączy zakładkę.
    const rw = owner.rollingWindow;
    const tt = owner.tokenTracker;

    // K5: uchwyt przerwania powstaje RAZEM z zapaleniem guzika Stop, nie dopiero przy
    // rejestracji tury w `_streamCtxMap`. Między jednym a drugim jest budowa promptu z pamięcią
    // (potrafi trwać sekundy) — w tym oknie user MOŻE kliknąć Stop, a mapa tur jeszcze nic
    // o tej turze nie wie. `_preparingTurns` to skrzynka kontaktowa na ten czas.
    const turnAbort = createTurnAbort();
    this._preparingTurns.set(owner.agentName, turnAbort);

    // Toggle UI state + show immediate visual feedback
    this.set_generating(true);
    // F2: od tej chwili serializację przejmuje `is_generating` — bezpiecznik „tura powiadomienia
    // już rusza" (ustawiany przez dostawcę PRZED tym awaitem) nie jest już potrzebny.
    this._subTaskTurnPending = false;
    this.showTypingIndicator(t('chat.streaming.preparing'));

    // Get system prompt for the TURN OWNER (includes memory: brain + active context)
    const agentManager = this.plugin?.agentManager;
    if (agentManager) {
        const t1 = Date.now();
        const platform = this.env?.settings?.pkmAssistant?.chat?.platform || '';
        const isLocalModel = isLocalPlatform(platform);
        // Pass artifacts via context → PromptBuilder handles them in build().
        // E2.3 (D21): workMode już nie istnieje — nie ma sekcji trybu w promptcie.
        // K18: drugi argument = agent-WŁAŚCICIEL. Bez niego prompt składałby się z persony
        // i pamięci agenta, który akurat jest na wierzchu (AUD-security-112).
        const basePrompt = await agentManager.getActiveSystemPromptWithMemory({
            isLocalModel,
            // E2.9 FAZA B (B3): aktywny artefakt tej rozmowy (per-tab) → świeży chudy JSON w prompcie.
            // (Stary przepływ artifacts:{todos,plans} z _chatTodoStore/_planStore usunięty w fazie D.)
            activeArtifactId: owner.artifactId,
        }, owner.agent);
        rw.setSystemPrompt(basePrompt);
        if (inlineTriggers.length > 0) {
            // D17 (E2.4): marker @@skill: nie woła już skill_execute (skasowany). Resolwujemy skill
            // TU (async/plugin-zależne) z overridami per-agent — „doczepki nie giną" (prompt_append)
            // — i wstrzykujemy PEŁNY przepis do instrukcji tury. Nieznany skill → krótka nota.
            const resolvedSkills: Record<string, ChatViewMixinContext> = {};
            for (const m of inlineTriggers) {
                if (m.type !== 'skill') continue;
                const cfg = agentManager.resolveSkillConfig?.(m.name, owner.agent);
                if (cfg) resolvedSkills[m.name] = { name: cfg.name, prompt: cfg.prompt };
            }
            const triggerInstruction = buildInlineTriggerInstruction(inlineTriggers, resolvedSkills);
            rw.setSystemPrompt(`${rw.baseSystemPrompt || basePrompt}\n\n${triggerInstruction}`);
            log.info('Chat', `Inline triggers: ${getInlineTriggerSummary(inlineTriggers)}`);
        }
        log.timing('Chat', `System prompt build (${basePrompt.length} znaków, local=${isLocalModel})`, t1);
    }

    // Oczko: inject active note context (if enabled) — still dynamic per-message
    const oczkoEnabled = this.env?.settings?.pkmAssistant?.enableOczko !== false;
    if (oczkoEnabled) {
        try {
            const noteCtx = await this._buildActiveNoteContext();
            if (noteCtx) {
                // Text context → system prompt (always)
                if (noteCtx.text) {
                    const cp = rw.baseSystemPrompt || '';
                    rw.setSystemPrompt(`${cp}\n\n${noteCtx.text}`);
                }
                // Image blocks → inject into last user message
                // Always inject — adapter auto-strips for non-vision models
                if (noteCtx.images?.length > 0) {
                    const msgs = rw.messages;
                    const lastUserIdx = msgs.length - 1;
                    if (lastUserIdx >= 0 && msgs[lastUserIdx].role === 'user') {
                        const msg = msgs[lastUserIdx];
                        // Convert content to array format if it's a plain string
                        if (typeof msg.content === 'string') {
                            msg.content = [{ type: 'text', text: msg.content }];
                        }
                        // Append Oczko image blocks
                        for (const imgBlock of noteCtx.images) {
                            msg.content.push(imgBlock);
                        }
                        // Warn if model likely can't see images
                        if (!this._isCurrentModelVision()) {
                            const modelName = this.get_chat_model()?.modelKey || 'model';
                            new Notice(t('chat.streaming.oczko_no_vision', { model: modelName }), 6000);
                        }
                    }
                }
                log.debug('Chat', `Oczko: "${this.app.workspace.getActiveFile()?.name}" (${noteCtx.images?.length || 0} images)`);
            }
        } catch (e) {
            log.warn('Chat', 'Oczko injection failed:', e);
        }
    }

    // K18: profil i nazwa właściciela — z zamrożenia sprzed budowy promptu, nie z lustra.
    const activeAgent = owner.agent;
    const streamAgentName = owner.agentName;

    // === STREAMING CONTEXT (per-tab) — MINIMALNY wpis ===
    // Po E2.1 krok B mechanika tury żyje w zamknięciu `turn` niżej. _streamCtxMap trzyma tylko
    // to, co czytają INNE metody: handle_chunk (ctx.agent → nagłówek/kolor) oraz needsFreshModel
    // (size > 1 = współbieżny stream w tym ChatView).
    //
    // Friendly fire 2026-08-15: `turnId` = tożsamość TEJ tury. Mapa jest kluczowana nazwą
    // agenta, więc porzucona tura (nowa sesja wystartowała następną) i tura żywa dzielą wpis —
    // watchdog porzuconej tury strzelał „po agencie" i ubijał requesty tury ŻYWEJ. Strażnik
    // w _onStreamStall porównuje turnId zanim komukolwiek przerwie.
    const turnId = ++_turnSeq;
    // K5: uchwyt przerwania TEJ tury (`turnAbort`, założony wyżej razem z guzikiem Stop)
    // wchodzi teraz do wpisu `_streamCtxMap` — stamtąd sięga po niego `stop_generation(agentName)`
    // i zamknięcie widoku. Ten sam obiekt niesie `turn` (czyta go pętla i watchdog) — nie kopia.
    this._streamCtxMap.set(streamAgentName, {
        agentName: streamAgentName,
        agent: activeAgent,
        rollingWindow: rw,
        tokenTracker: tt,
        turnId,
        abort: turnAbort,
    });
    // Tura ma już wpis w mapie — skrzynka kontaktowa na czas przygotowania nie jest potrzebna.
    this._preparingTurns.delete(owner.agentName);

    // === SNAPSHOT for "Pokaż prompt" in Settings ===
    if (this.plugin) {
        this.plugin._lastSentSnapshot = {
            systemPrompt: rw.baseSystemPrompt,
            conversationSummary: rw.conversationSummary || '',
            lastUserMessage: text,
            timestamp: Date.now(),
            agentName: streamAgentName,
            agentEmoji: '',
        };
    }

    try {
        // Get or create chat model — fresh instance if another stream is already active.
        // ChatModel.stream() is NOT concurrent-safe on the same instance.
        //
        // Sprint 03 Z7: pre-Z7 guard `_streamCtxMap.size > 1` był per ChatView —
        // przy 4 tabach każdy widział size=1 i używał shared cache → cross-tab race.
        // Teraz sprawdzamy plugin-globalnie przez StreamingManager — fresh instance gdy
        // jakikolwiek inny stream już leci albo gdy w obrębie tego ChatView jest współbieżność.
        // AUD-testy-027: sama decyzja („lokalna współbieżność ALBO jakikolwiek inny stream")
        // mieszka w `StreamingManager.ts` — pliku bez `obsidian`, z testami obu stron.
        const needsFreshModel = shouldUseFreshModel(this._streamCtxMap.size, streamingManager.getActiveStreams().length);
        // K18: model rozwiązywany dla agenta-WŁAŚCICIELA. Bez `agent` `get_chat_model` czyta
        // `getActiveAgent()`, więc tura zaczęta u A jechałaby modelem (i kluczem) agenta B.
        const chat_model = this.get_chat_model({ skipCache: needsFreshModel, agent: owner.agent });
        if (!chat_model?.stream) {
            throw new Error('Chat model not configured. Please configure API key in Settings → PKM Assistant.');
        }
        const sCtx = this._streamCtxMap.get(streamAgentName);
        if (sCtx) sCtx.chatModel = chat_model;

        log.timing('Chat', `TOTAL send→loop (model: ${chat_model.modelKey || 'unknown'}, parallel: ${needsFreshModel})`, sendStart);

        // Start streaming — closured callbacks know which agent they belong to
        this._agentHeaderShown = false;
        // Ostatnia treść namalowana przez handle_chunk (cykl życia jak current_message_container) —
        // czyta to _finalizeTurn, żeby wiedzieć czy finalna wersja różni się od tego, co widzi user.
        this._lastPaintedContent = null;
        this.showTypingIndicator();

        // Extended thinking: universal flag for all providers that support it.
        // E2.1 krok B: liczony RAZ na turę (dawniej per kontynuację — negligible, user rzadko
        // przełącza w trakcie tury).
        const showThinking = this.env?.settings?.pkmAssistant?.showThinking ?? true;
        const thinkingFlag = showThinking ? true : undefined;

        // ADRES ZWROTNY TURY (F2 faza B): dokąd ma wrócić wynik suba odpalonego w tle.
        // Liczony RAZ na turę (nie per tool call), bo user może w trakcie przełączyć zakładkę
        // albo agent może zacząć nową sesję — powiadomienie ma trafić tam, SKĄD wyszło zlecenie.
        // K18: sesja i zakładka pochodzą z zamrożenia sprzed budowy promptu (dawniej czytane
        // TUTAJ, czyli już po awaitach — po przełączeniu adres zwrotny celował w cudzą zakładkę).
        const turnSessionPath = owner.sessionPath;
        // AUD-code-review-012 (F04): `ownerTabKey` — liczony RAZ, na samym starcie send_message,
        // przed pierwszym awaitem (patrz komentarz przy jego deklaracji). Reużyty tu zamiast
        // ponownego `_tabKey(owner.tab)`, żeby nie było DWÓCH miejsc liczących ten sam klucz
        // w jednej turze.
        const turnOrigin = {
            agentName: streamAgentName,
            ...(turnSessionPath ? { sessionPath: turnSessionPath } : {}),
            ...(ownerTabKey ? { tabKey: ownerTabKey } : {}),
        };

        // Kontekst tury (zamknięcie). Zastępuje dawny bogaty wpis _streamCtxMap.
        const turn: ChatViewMixinContext = {
            agentName: streamAgentName,
            agent: activeAgent,
            owner,                       // K18: zamrożony właściciel tury (AUD-security-112)
            turnId,                      // friendly fire 2026-08-15: tożsamość tury (patrz _streamCtxMap wyżej)
            abort: turnAbort,            // K5: przerwanie TEJ tury (zatrzask, patrz turnAbort.ts)
            origin: turnOrigin,          // F2: adres zwrotny dla delegacji w tle
            rw,
            tt,
            chatModel: chat_model,
            model: chat_model?.modelKey || '',
            platform: this.env?.settings?.pkmAssistant?.chat?.platform || '',
            // E2.3 (D21): tryb PYTAŃ per-czat → egzekutor. K18: z zamrożenia, bo `_switchTab`
            // przestawia `this.currentAutonomy` — zlecenie wydane w `edge` kończyłoby w `yolo`.
            autonomy: owner.autonomy,
            hasUsedDelegate: false,
            // D17 (E2.4): tura z markerem @@skill: startuje z aktywnym skillem (iteracja 0) —
            // przepis wstrzyknięty do promptu, więc nie ma tu wywołania narzędzia do wykrycia.
            skillActiveAt: inlineTriggers.some(m => m.type === 'skill') ? 0 : null,
            skillArtifactCreated: false,         // czy po skillu stworzono todo/plan
            cacheTelemetryEnabled: this.env?.settings?.pkmAssistant?.cacheTelemetryEnabled !== false,
            // per-response stash (nadpisywane per iterację):
            rawResults: new Map(),               // toolCall.id → { result, error } dla onToolResults
            pendingEntries: [],                  // placeholdery UI z onToolCallsParsed (kolejność = tool_calls)
            toolCallsContainer: null,
            lastRoundToolResults: [],            // { id, content } do journala tool_result
            lastApiInput: 0,
            lastApiOutput: 0,
            lastCacheMeta: null,
            responseRecorded: false,             // czy onUsage już zapisał tę odpowiedź do TokenTracker
            // AUD-code-review-014: estymata wejścia PER TURA (_captureInputEstimate), nie per widok —
            // dwie tury naraz w jednym ChatView dzieliłyby dotąd jedno pole `this._lastInputTokens`.
            lastInputTokens: 0,
            lastInputChars: 0,
        };

        // Watchdog martwego streamu (2026-07-29): zdechnięty lokalny most/serwer potrafi trzymać
        // połączenie bez ANI JEDNEGO chunka (log "[ChatAdapter] no chunk") — bez watchdoga tura
        // wisiała aż do ręcznego Stopa (twardy timeout XHR to dopiero 600 s). Zbrojony na start
        // każdego wywołania modelu (onIterationStart/onBackstop), karmiony chunkami, rozbrajany
        // na tool calls i koniec pętli — czas pracy narzędzi się NIE liczy (osobne timeouty w
        // modules/tools/). Platforma xai nie streamuje (PKMXaiAdapter woła chunk raz, po pełnym
        // complete()) — cisza mid-flight jest tam normalna, watchdog wyłączony.
        const stallTimeoutMs = turn.platform === 'xai'
            ? 0
            : getLimits(this.env?.settings).chat_stream_stall_timeout_ms;
        turn.watchdog = new StreamWatchdog({
            timeoutMs: stallTimeoutMs,
            onStall: (silentMs) => this._onStreamStall(turn, silentMs),
        });
        if (sCtx) sCtx.watchdog = turn.watchdog; // stop_generation / onClose rozbrajają przez ctx

        // Sprint 03 Z7: tracking multi-tab (StreamingManager).
        const streamId = `${this.leaf?.id || 'main'}::${streamAgentName}`;
        turn.streamId = streamId; // _onStreamStall wyrejestrowuje stream sam (finally może nie ruszyć)
        const modelId = chat_model?.modelKey || chat_model?.modelId || null;
        streamingManager.startStream(streamId, {
            agent: streamAgentName,
            modelId,
            meta: {}
        });

        // resolveTools jest wołane na START KAŻDEJ iteracji. Asymetria enabledTools zachowana:
        // 1. wywołanie (start tury) BEZ filtra enabledTools (parytet z dawnym send_message),
        // kolejne (kontynuacje) Z filtrem (parytet z dawnym continueWithToolResults).
        let toolIterIdx = 0;
        // E2.2: trace pętli → .pkm-assistant/logs/trace.log. Label chat/<agent>#<8 znaków id sesji>
        // (id sesji z basename activeSessionPath; brak sesji → sam label agenta).
        // Ta sama ścieżka sesji, którą niesie `turn.origin` — liczona raz, wyżej.
        const _sessionId = turnSessionPath ? (turnSessionPath.split('/').pop() || '').replace(/\.md$/, '') : '';
        const _traceLabel = _sessionId
            ? `chat/${streamAgentName || '?'}#${_sessionId.slice(0, 8)}`
            : `chat/${streamAgentName || '?'}`;
        const trace = this.plugin?.traceLog?.scope?.(_traceLabel);
        let result;
        try {
            result = await runAgentLoop({
                model: chat_model,
                store: new RollingWindowMessageStore(rw),
                resolveTools: () => this._chatResolveTools(turn, toolIterIdx++ > 0),
                executeToolCall: (toolCall) => this._chatExecuteToolCall(turn, toolCall),
                trace,
                limits: {
                    // E2.1 krok B: maxIterations liczone RAZ na turę (dawniej per kontynuację).
                    maxIterations: getLimits(this.env?.settings).chat_max_iterations,
                    maxToolResultLength: getLimits(this.env?.settings).max_tool_result_length,
                    // Runda 2 (2026-08-17): wynik suba = deliverable, nie zrzut narzędzia.
                    // Wspólny sufit 15k ucinał deep-research suba w połowie (żywy smoke).
                    maxToolResultLengthPerTool: {
                        delegate: getLimits(this.env?.settings).subagent_result_max_chars,
                        agent_delegate: getLimits(this.env?.settings).subagent_result_max_chars,
                    },
                    // Friendly fire 2026-08-15: pas ostateczny per wywołanie modelu (dawniej:
                    // „czat historycznie nie miał"). Watchdog ciszy łapie brak chunków, ale NIE
                    // łapie promisy ubitej z zewnątrz (xhr.abort nie emituje zdarzenia — await
                    // wisiałby wiecznie). Kolejka bramki mostu się nie liczy (gate_admitted).
                    perCallTimeoutMs: getLimits(this.env?.settings).chat_model_call_timeout_ms,
                },
                // agentName → log pętli; `agent` → payload (adaptery czytają _req.agentName || _req.agent
                // dla prompt_cache_key / x-grok-conv-id; pętla strippuje `agentName` z payloadu, więc
                // klucz cache niesiemy przez `agent` — wartość identyczna).
                modelOptions: { thinking: thinkingFlag, agentName: streamAgentName, agent: streamAgentName },
                hooks: {
                    onIterationStart: () => this._chatOnIterationStart(turn),
                    onToolCallsParsed: (toolCalls) => this._chatOnToolCallsParsed(turn, toolCalls),
                    onToolResults: (results, i) => this._chatOnToolResults(turn, results, i),
                    beforeContinue: (i) => this._chatBeforeContinue(turn, i),
                    onUsage: (usage) => this._chatOnUsage(turn, usage),
                    onBackstop: () => this._chatOnBackstop(turn),
                },
                // K5: chunki przerwanej tury nie malują już nic — bramka stoi PRZED `handle_chunk`,
                // bo wpis `_streamCtxMap` znika przy Stopie (a to on niesie uchwyt dla widoku).
                callbacks: { chunk: (resp) => { if (turnAbort.isAborted()) return; turn.watchdog.feed(); this.handle_chunk(resp, streamAgentName); } },
                // Runda 2 (2026-08-17): watchdog ciszy zbroi się dopiero, gdy request WEJDZIE
                // na slot bramki mostu. Czekanie w kolejce za długą syntezą suba (smoke: 5:39)
                // nie jest ciszą modelu — zbrojenie w onIterationStart ubijało turę usera po
                // 120 s stania w kolejce (incydent 09:15Z). Chmura emituje gate_admitted
                // natychmiast (kontrakt ChatModel), więc tam nic się nie zmienia;
                // pas ostateczny na „sygnał nigdy nie przyszedł" to perCallTimeoutMs wyżej.
                onGateAdmitted: () => turn.watchdog?.arm(),
                shouldAbort: () => turnAbort.isAborted(),
            });
        } finally {
            turn.watchdog.disarm();
            streamingManager.stopStream(streamId);
        }

        if (result.stoppedBy === 'abort') {
            // Przerwane przez usera — stop_generation zrobił już UI cleanup. Nie renderujemy finalnej odpowiedzi.
            this._releaseStreamCtx(streamAgentName, turnId);
            log.info('Chat', `[${streamAgentName}] tura przerwana (abort)`);
        } else {
            await this._finalizeTurn(turn, result);
        }
    } catch (error) {
        // Abort mid-stream (stopStream → XHR abort) potrafi rozjechać stream — traktuj flagę abort
        // jako przerwanie (nie błąd), żeby nie renderować "Error:".
        if (turnAbort.isAborted()) {
            this._releaseStreamCtx(streamAgentName, turnId);
            log.info('Chat', `[${streamAgentName}] stream aborted (mid-request)`);
        } else {
            // K20b: log tury też przez maskę — Logger pisze do pliku w vaultcie.
            log.error('Chat', `[${streamAgentName}] send_message ERROR:`, safeErrorText(error));
            // F04: `ownerTabKey` (string, zamrożony przy starcie tury) — nie obiekt `owner.tab`,
            // żeby `handle_error` nie musiał go sam przeliczać leniwie (patrz sygnatura niżej).
            this.handle_error(error, streamAgentName, turnId, ownerTabKey);
        }
    }
    log.debug('Chat', `[${streamAgentName}] send_message END (${Date.now() - sendStart}ms)`);
}

export function handle_chunk(this: ChatViewMixinContext, response: ChatViewMixinContext, agentName: string) {
    // Look up per-agent streaming context from Map
    const ctx = agentName ? this._streamCtxMap.get(agentName) : null;
    // K5: chunk przerwanej tury nie ma prawa nic namalować. Główną bramką jest domknięcie
    // `callbacks.chunk` w `send_message` (ono ma uchwyt tury nawet po skasowaniu wpisu);
    // to jest pas zapasowy dla dowolnego innego wołacza.
    if (ctx?.abort?.isAborted()) return;
    // If user switched to a different tab, skip rendering (finalization will save full content)
    const currentTabAgent = this.chatTabs.find((t: ChatViewMixinContext) => t.isActive)?.agentName;
    if (agentName && currentTabAgent !== agentName) return;

    this.hideTypingIndicator();
    if (!this.current_message_container) {
        // AUD-code-review-017: budowa kontenera wiadomości agenta to bajt-w-bajt to samo ciało co
        // `_ensureAgentMessageContainer` (poniżej) — jedyna różnica była w SKĄD bierze się agent
        // (tu: kontekst streamu, tam: parametr wołacza). Kontener bez tekstu poprzedzającego
        // (tool calls bez czatu) idzie tą samą drogą przez `_ensureAgentMessageContainer`.
        // Use captured agent, not getActiveAgent()
        const streamAgent = ctx?.agent || this.plugin?.agentManager?.getActiveAgent();
        this._ensureAgentMessageContainer(streamAgent);
    }

    // Get content from response
    const content = response?.choices?.[0]?.message?.content || '';
    const reasoningContent = response?.choices?.[0]?.message?.reasoning_content || '';
    const showThinking = this.env?.settings?.pkmAssistant?.showThinking ?? true;

    // AUD-wydajnosc-071/015/070: NIE malujemy per chunk. `response` niesie treść ZAKUMULOWANĄ
    // (adapter dokłada deltę do `message.content`), więc malowanie na każdą ramkę SSE dawało
    // koszt kwadratowy względem długości odpowiedzi, a chunki z samą deltą `tool_calls`
    // przemalowywały bajt-w-bajt to samo. Zgłaszamy klatkę do throttle'a (`renderThrottle.ts`):
    // maluje najwyżej raz na okno, zawsze OSTATNIĄ treścią, a klatkę identyczną pomija.
    this._streamRenderThrottle().request({
        text: content,
        reasoning: showThinking ? reasoningContent : '',
        // Review opusa (P1): klatka wozi WŁAŚCICIELA. Timer uzbrojony ≤80 ms przed przełączeniem
        // zakładki wystrzeliwuje już na cudzej — bez tego znacznika malowanie nie miało jak
        // poznać, że jego zakładka zeszła z wierzchu.
        owner: agentName || '',
    });
}

/** Okno koalescencji malowania strumienia (ms) — patrz `renderThrottle.ts`. */
const STREAM_PAINT_INTERVAL_MS = 80;

/** Throttle malowania TEGO widoku (leniwy, cykl życia jak `current_message_container`). */
export function _streamRenderThrottle(this: ChatViewMixinContext): RenderThrottle {
    if (!this._renderThrottle) {
        this._renderThrottle = new RenderThrottle({
            intervalMs: STREAM_PAINT_INTERVAL_MS,
            paint: (frame: StreamFrame) => this._paintStreamFrame(frame),
        });
    }
    return this._renderThrottle;
}

/**
 * Jedno malowanie strumienia: blok myśli → dymek tekstu → przewinięcie.
 * Kolejność DOM (thinking → tools → text) i treść są dokładnie te, co przed throttlem —
 * zmienia się wyłącznie CZĘSTOTLIWOŚĆ wywołania.
 *
 * ⚠️ Cel malowania mógł zniknąć między zgłoszeniem klatki a jej wystrzałem (Stop, przełączenie
 * zakładki, `_resetPaintTargets` w przerwie na wyniki narzędzi) — wtedy nie malujemy nic.
 */
export function _paintStreamFrame(this: ChatViewMixinContext, frame: StreamFrame) {
    if (!this.current_message_container || !this.current_message_text) return;
    // Review opusa (P1): sama niepustość wskaźników NIE wystarcza — po `_switchTab` celują one
    // w węzły WYPIĘTE z DOM-u starej zakładki (tekst poszedłby w nicość), ale skutek uboczny
    // malowania — `scrollToBottom` — przewinąłby NOWĄ zakładkę i skasował przywrócony `scrollTop`.
    const activeTabAgent = this.chatTabs?.find((tab: ChatViewMixinContext) => tab.isActive)?.agentName;
    if (!shouldPaintFrame(frame, activeTabAgent)) return;

    // Render thinking block if reasoning_content present
    const reasoningContent = frame.reasoning || '';
    if (reasoningContent.length > 0) {
        if (!this._currentThinkingBlock) {
            this._currentThinkingBlock = createThinkingBlock(reasoningContent, true);
            // Insert thinking row BEFORE tool calls wrapper (correct order: thinking → tools → text)
            this.current_message_container.insertBefore(
                this._currentThinkingBlock,
                this.current_message_bubble
            );
        } else {
            updateThinkingBlock(this._currentThinkingBlock, reasoningContent);
        }
    }

    // Update text (render as markdown)
    // ✅ release 2.2.0/W2 (@typescript-eslint/no-deprecated): `renderMarkdown` → `render`.
    // Dawny TODO v2.1 zakładał, że przejście na `.render()` WPROWADZA asynchroniczność, której
    // dotąd nie było — nieprawda: `renderMarkdown` też zwraca `Promise<void>` (obsidian.d.ts) i był
    // wołany BEZ await, dokładnie jak tu. `.render()` przyjmuje dodatkowo `app` (pierwszy argument);
    // reszta sygnatury i wywołanie fire-and-forget bez zmian — zero nowego ryzyka out-of-order
    // ponad to, co już istniało.
    this.current_message_text.empty();
    void MarkdownRenderer.render(
        this.app,
        frame.text,
        this.current_message_text,
        '',
        this
    );
    this._lastPaintedContent = frame.text;

    // Scroll to bottom. AUD-wydajnosc-072/014: BEZ przerysowania łączników — rosnący tekst
    // ostatniej wiadomości nie przesuwa ani kryształu, ani wierszy akcji, a przerysowanie
    // ciągnęło skan całej listy wiadomości z przeplotem odczytów layoutu.
    this.scrollToBottom(true, { drawConnectors: false });
}

// ─────────────────────────────────────────────────────────────────────────────
// HOOKI PĘTLI (runAgentLoop) — cała UI/side-effect logika dawnego handle_done.
// Każdy dostaje `turn` (kontekst tury z zamknięcia send_message).
// ─────────────────────────────────────────────────────────────────────────────

/** Czy tura dzieje się na aktualnie aktywnej zakładce (może się zmienić w trakcie streamu). */
export function _isTurnActiveTab(this: ChatViewMixinContext, turn: ChatViewMixinContext) {
    const currentTabAgent = this.chatTabs.find((t: ChatViewMixinContext) => t.isActive)?.agentName;
    return currentTabAgent === turn.agentName;
}

/**
 * AUD-bledy-016: JEDNO miejsce prawdy o wskaźnikach malowania.
 *
 * `handle_chunk` maluje do ISTNIEJĄCEGO `current_message_container`, więc każde wyjście z tury
 * musi je wyzerować — inaczej następna odpowiedź trafia do dymka poprzedniej wiadomości (albo,
 * po przerysowaniu listy, do węzła wypiętego z DOM-u, czyli w nicość). Ścieżka sukcesu
 * (`_finalizeTurn`) i Stop robiły to od zawsze; ścieżka BŁĘDU wychodziła bez zerowania.
 *
 * ⚠️ Wołać wyłącznie na ścieżce AKTYWNEJ zakładki. Pola są per-WIDOK, nie per-zakładka, więc
 * zerowanie z tury kończącej się w tle wyrwałoby dymek żywej turze na wierzchu.
 */
export function _resetPaintTargets(this: ChatViewMixinContext) {
    this.current_message_container = null;
    this.current_message_bubble = null;
    this.current_message_text = null;
    this._lastPaintedContent = null;
    // AUD-wydajnosc-071: throttle malowania trzyma WŁASNĄ pamięć ostatniej klatki i potrafi
    // mieć uzbrojony timer. Zerujemy razem ze wskaźnikami — inaczej klatka poprzedniej tury
    // wystrzeliłaby w nieistniejący już dymek. Ścieżki, które chcą ZACHOWAĆ ostatni fragment
    // (koniec tury, Stop, przerwa na wyniki narzędzi), wołają `flush()` PRZED tym helperem.
    this._renderThrottle?.reset();
}

/**
 * AUD-security-116: zwolnij wpis mapy tur TYLKO wtedy, gdy nadal należy do TEJ tury.
 *
 * `_streamCtxMap` jest kluczowana NAZWĄ agenta, a pod jedną nazwą potrafią żyć dwie tury
 * (zakładka dodana ponownie z pickera, wyścig z przygotowaniem promptu). Bezwarunkowy
 * `delete` przy finalizacji STAREJ tury wyrzucał uchwyt przerwania ŻYWEJ — od tej chwili
 * Stop robił sam UI-cleanup, `abort()` nie leciało wcale, a pętla spokojnie wołała model
 * i wykonywała narzędzia. Guzik wyglądał na skuteczny i nie był.
 *
 * Wzór porównania tożsamości jest ten sam, co u watchdoga w `_onStreamStall`.
 */
export function _releaseStreamCtx(this: ChatViewMixinContext, agentName: string, turnId?: number) {
    if (!agentName) return;
    const live = this._streamCtxMap.get(agentName);
    if (!live) return;
    if (typeof turnId === 'number' && typeof live.turnId === 'number' && live.turnId !== turnId) {
        log.warn('Chat', `[${agentName}] tura #${turnId} domyka się, ale w mapie żyje #${live.turnId} — zostawiam jej uchwyt`);
        return;
    }
    this._streamCtxMap.delete(agentName);
}

/** Kto jest na wierzchu — właściciel slotu kolejki i punkt odniesienia dla drenu (AUD-bledy-015). */
export function _queueOwner(this: ChatViewMixinContext): QueueOwner {
    const tab = (this.chatTabs || []).find((t: ChatViewMixinContext) => t.isActive);
    return { agentName: tab?.agentName || '', tabKey: tab ? _tabKey(tab) : '' };
}

/** Rozbraja timer drenu kolejki (Stop / przełączenie zakładki / zamknięcie widoku). */
export function _clearQueuedDrainTimer(this: ChatViewMixinContext) {
    if (this._queuedDrainTimer) {
        window.clearTimeout(this._queuedDrainTimer);
        this._queuedDrainTimer = null;
    }
}

/** Tworzy kontener wiadomości agenta (gdy handle_chunk go nie stworzył — np. tool calls bez tekstu). */
export function _ensureAgentMessageContainer(this: ChatViewMixinContext, streamAgent: ChatViewMixinContext) {
    const streamColor = SkinManager.getAgentColor(streamAgent || 'default');
    const agName = streamAgent?.name || 'Agent';

    this.current_message_container = this.messages_container.createDiv({
        cls: 'cs-message cs-message--agent'
    });
    this.current_message_container.style.setProperty('--cs-agent-color-rgb', hexToRgbTriplet(streamColor));

    if (!this._agentHeaderShown) {
        const head = this.current_message_container.createDiv({ cls: 'cs-message__agent-head' });
        const crystalEl = head.createDiv({ cls: 'cs-message__agent-crystal' });
        setSvg(crystalEl, SkinManager.getCrystal(streamAgent || agName, { size: 18, color: streamColor, glow: false }));
        head.createSpan({ cls: 'cs-message__agent-name', text: agName });
        this._agentHeaderShown = true;
    }

    this.current_message_bubble = this.current_message_container.createDiv({ cls: 'cs-tool-calls-wrapper' });
    this.current_message_text = this.current_message_container.createDiv({ cls: 'cs-message__text' });
}

/**
 * Przelicza estymatę tokenów wejścia (kalibracja + fallback token trackingu) z okna tury.
 *
 * AUD-code-review-014: estymata żyje w OBIEKCIE TURY (`turn.lastInputTokens`/`lastInputChars`),
 * nie na widoku — dwie tury naraz w jednym `ChatView` (`needsFreshModel`, `_streamCtxMap` per
 * agent) dzieliły dotąd `this._lastInputTokens`, więc tura A czytała estymatę nadpisaną przez
 * turę B (`_chatOnUsage`, `_chatBeforeContinue`, `_finalizeTurn`), co psuło zarówno TokenTracker
 * agenta A, jak i globalną kalibrację chars→token (`calibrate`, `core/utils/tokenCounter.ts`).
 */
export function _captureInputEstimate(this: ChatViewMixinContext, turn: ChatViewMixinContext) {
    const messages = turn.rw.getMessagesForAPI();
    const inputText = messages.map((m: ChatViewMixinContext) => {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) return m.content.filter((b: ChatViewMixinContext) => b.type === 'text').map((b: ChatViewMixinContext) => b.text).join('\n');
        return '';
    }).join('\n');
    turn.lastInputTokens = countTokens(inputText);
    turn.lastInputChars = inputText.length;
}

/**
 * resolveTools — świeża whitelista narzędzi na start iteracji + aktualizacja rozbicia tokenów okna.
 * @param {boolean} _applyEnabledFilter - E2.8 C1: IGNOROWANY (dawna oś `enabled_tools` skasowana;
 *   jedyna oś to `disabled_tools` przez filterByAgent). Param zostaje w kontrakcie hooka pętli.
 */
export function _chatResolveTools(this: ChatViewMixinContext, turn: ChatViewMixinContext, _applyEnabledFilter: boolean) {
    const agent = turn.agent;
    let tools: ChatViewMixinContext[] = [];
    let systemTools: ChatViewMixinContext[] = [];
    let mcpActiveTools: ChatViewMixinContext[] = [];

    if (agent && this.plugin?.toolRegistry) {
        // E2.8 C1: JEDNA OŚ NARZĘDZIOWA. filterByAgent = wszystkie built-in − disabled_tools
        // (+ user-serwery wg mcp_servers). Dawny master-gate `permissions.mcp` USUNIĘTY (pole nie
        // istnieje), dawny filtr `enabled_tools` USUNIĘTY, dawny filtr memory-tools po permissions.memory
        // USUNIĘTY (memory_save/delete rządzi disabled_tools; read scope=memory bramkuje sam tool fail-closed).
        const mcpAllowed = this.plugin.toolRegistry.filterByAgent(agent);
        const mcpAllowedNames = new Set(mcpAllowed.map((t: ChatViewMixinContext) => t.name));

        systemTools = this.plugin.toolRegistry.getToolDefinitions()
            .filter((t: ChatViewMixinContext) => mcpAllowedNames.has(t.function?.name || t.name));

        // Layer 2: active user/custom MCP server tools + standalone. Odfiltruj wyłączone (disabled_tools).
        const preferredServers = getAgentServerFilter(this.plugin.serverManager, agent);
        const preferredTools = agent?.preferredTools || [];
        const disabledSet = new Set(Array.isArray(agent.disabled_tools) ? agent.disabled_tools : []);
        mcpActiveTools = (this.plugin.serverManager?.getActiveToolDefinitions(preferredServers, preferredTools) || [])
            .filter((t: ChatViewMixinContext) => !disabledSet.has(t.function?.name || t.name));
        tools = dedupeToolDefinitions([...systemTools, ...mcpActiveTools]);

        log.debug('Chat', `Tools: ${tools.length} narzędzi`);
    }

    // Cache tool definitions token count w RollingWindow (do dokładnego liczenia kontekstu)
    turn.rw.setContextTokenSources(getCachedToolTokenBreakdown(agent, { systemTools, mcpToolsActive: mcpActiveTools }));
    return tools;
}

/** onIterationStart — reset per-response stash + estymata wejścia (przed wywołaniem modelu). */
export function _chatOnIterationStart(this: ChatViewMixinContext, turn: ChatViewMixinContext) {
    // Runda 2 (2026-08-17): watchdog NIE zbroi się już tutaj — zbroi go `onGateAdmitted`
    // pętli (wejście requestu na slot bramki). Zbrojenie przed kolejką liczyło czekanie
    // za subem jako ciszę modelu i ubijało żywą turę usera (incydent 09:15Z).
    turn.responseRecorded = false;
    turn.lastApiInput = 0;
    turn.lastApiOutput = 0;
    turn.lastCacheMeta = null;
    turn.rawResults.clear(); // surowe wyniki poprzedniej iteracji już zużyte (onToolResults)
    this._captureInputEstimate(turn);
}

/** onBackstop — finalna iteracja bez narzędzi. Reset per-response stash (brak onIterationStart). */
export function _chatOnBackstop(this: ChatViewMixinContext, turn: ChatViewMixinContext) {
    // Runda 2: finalne wywołanie też pilnowane, ale zbrojenie robi `onGateAdmitted` (jak wyżej).
    turn.responseRecorded = false;
    turn.lastApiInput = 0;
    turn.lastApiOutput = 0;
    turn.lastCacheMeta = null;
    this._captureInputEstimate(turn);
}

/** onUsage — TokenTracker record (rola main) + cache badge z usage odpowiedzi. */
export function _chatOnUsage(this: ChatViewMixinContext, turn: ChatViewMixinContext, usage: ChatViewMixinContext) {
    const isActiveTab = this._isTurnActiveTab(turn);
    const apiInput = usage?.prompt_tokens || 0;
    const apiOutput = usage?.completion_tokens || 0;

    // Kalibracja estymatora okna kontekstu (E1.7 P2): gdy API zwróciło realne prompt_tokens,
    // ucz chars-per-token per platforma.
    if (apiInput > 0 && turn.lastInputChars > 0) {
        calibrate(turn.platform, apiInput, turn.lastInputChars);
    }
    turn.lastApiInput = apiInput;
    turn.lastApiOutput = apiOutput;
    turn.lastCacheMeta = turn.cacheTelemetryEnabled ? buildCacheMetadata(usage || {}) : null;

    // Token tracking: API values gdy są; input fallback = estymata z kontekstu. Output fallback
    // (countTokens(content)) robimy przy zapisie wiadomości (beforeContinue/_finalizeTurn), bo tu
    // nie mamy treści odpowiedzi.
    const inputTokens = apiInput > 0 ? apiInput : (turn.lastInputTokens || 0);
    const outputTokens = apiOutput;
    if (inputTokens > 0 || outputTokens > 0) {
        // AUD-<risk-register>: gdy API nie oddało prompt_tokens, input jest ESTYMATĄ
        // (turn.lastInputTokens z _captureInputEstimate) — oznacz ją, żeby Token Viewer
        // pokazywał `~` zamiast twierdzić, że to pomiar z API.
        const estimated = apiInput === 0 && inputTokens > 0;
        turn.tt.record('main', inputTokens, outputTokens, { estimated });
        turn.responseRecorded = true;
        if (isActiveTab) this._updateTokenPanel();
    }
}

/**
 * onToolCallsParsed (SYNC względem egzekucji) — Faza 1: placeholdery UI dla wszystkich tool_calls.
 * ask_user WYMAGA tego przed egzekucją (placeholder tworzy plugin._askUserPromise, na który czeka
 * AskUserTool.execute). NIE filtruje (zwraca undefined).
 */
export function _chatOnToolCallsParsed(this: ChatViewMixinContext, turn: ChatViewMixinContext, toolCalls: ChatViewMixinContext[]) {
    turn.watchdog?.disarm(); // model skończył mówić — narzędzia mogą trwać minuty, cisza legalna
    const isActiveTab = this._isTurnActiveTab(turn);
    const streamAgent = turn.agent;

    // Ensure container (CS agent message) — only if on active tab (tool calls bez poprzedzającego tekstu)
    if (isActiveTab && !this.current_message_container) {
        this._ensureAgentMessageContainer(streamAgent);
    }

    const toolCallsContainer = isActiveTab
        ? (this.current_message_bubble || this.current_message_container?.createDiv({ cls: 'cs-tool-calls-wrapper' }))
        : null;

    // Tool status messages (i18n)
    const TOOL_STATUS = {
        vault_search: t('chat.tool_status.vault_search'),
        vault_read: t('chat.tool_status.vault_read'),
        vault_list: t('chat.tool_status.vault_list'),
        vault_write: t('chat.tool_status.vault_write'),
        vault_delete: t('chat.tool_status.vault_delete'),
        vault_create_folder: t('chat.tool_status.vault_create_folder'),
        memory_save: t('chat.tool_status.memory_save'),
        memory_read: t('chat.tool_status.memory_read'),
        memory_delete: t('chat.tool_status.memory_delete'),
        memory_sessions: t('chat.tool_status.memory_sessions'),
        memory_summaries: t('chat.tool_status.memory_summaries'),
        memory_list_summaries: t('chat.tool_status.memory_summaries'),
        memory_read_summary: t('chat.tool_status.memory_read'),
        // AUD-dead-code-054 (2026-09-02): `skill_list`/`skill_execute` skasowane — oba narzędzia
        // nie istnieją (skill_execute skasowany w D17/E2.4, skill_list nigdy nie miał odpowiednika
        // w modules/tools) i żaden alias nie mapuje na nie żywego narzędzia.
        delegate: t('chat.tool_status.delegate'),
        todo: t('chat.tool_status.todo'),
        generate_image: t('chat.tool_status.generate_image'),
        web_search: t('chat.tool_status.web_search'),
        web_read: t('chat.tool_status.web_read'),
        ask_user: t('chat.tool_status.ask_user'),
        agent_message: t('chat.tool_status.agent_message'),
        agent_delegate: t('chat.tool_status.agent_delegate'),
        connect_to_server: t('chat.tool_status.connect_to_server'),
    };

    // Faza 1: Create ALL pending UI blocks (sync) — only on active tab
    turn.pendingEntries = toolCalls.map(toolCall => {
        const isSubAgent = toolCall.name === 'delegate';
        const isAskUser = toolCall.name === 'ask_user';
        let toolDisplay = null;
        if (isActiveTab && toolCallsContainer) {
            if (isAskUser) {
                this.hideTypingIndicator();
                toolDisplay = this._renderAskUserBlock(toolCall, toolCallsContainer);
            } else if (isSubAgent) {
                this.hideTypingIndicator();
                const _subArgs = parseToolCallArgs(toolCall);
                const _subName = _subArgs.aspect || '';
                toolDisplay = createPendingSubAgentBlock(toolCall.name, _subName);
            } else {
                const statusMsg = (TOOL_STATUS as Record<string, string>)[toolCall.name] || `${toolCall.name}...`;
                this.showTypingIndicator(statusMsg);
                const makeDisplay = this.env?.settings?.pkmAssistant?.compactToolChips === false ? createToolCallDisplay : createCompactToolChip;
                toolDisplay = makeDisplay({
                    name: toolCall.name,
                    input: toolCall.arguments,
                    status: 'pending'
                });
            }
            toolCallsContainer.appendChild(toolDisplay);
            if (isSubAgent || isAskUser) toolDisplay.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        return { toolCall, toolDisplay, isSubAgent };
    });
    turn.toolCallsContainer = toolCallsContainer;
    // brak return → pętla nie filtruje
}

/**
 * executeToolCall — egzekucja jednego narzędzia (Faza 2). Zwraca wartość do zapisania w store
 * (string albo tablica multimodalna dla generate_image+vision). Surowy wynik + błąd stashuje w
 * turn.rawResults (id → {result, error}) dla onToolResults (UI + side effects).
 */
export async function _chatExecuteToolCall(this: ChatViewMixinContext, turn: ChatViewMixinContext, toolCall: ChatViewMixinContext) {
    let raw;
    let error = null;
    try {
        // E2.3 (D21): read limiter 1x/turę (tryb gadaj) USUNIĘTY wraz z trybami pracy —
        // narzędzia = uprawnienia agenta, nie tryb. Odczyt nie jest już racjonowany.
        log.debug('Chat', `Wykonuję tool (parallel): ${toolCall.name}`, toolCall.arguments);
        // F2: `origin` = adres zwrotny tury (policzony raz w send_message). MCPClient wstrzykuje
        // go jako zaufany znacznik `_invocationOrigin`, a `delegate` przenosi do rejestru biegów —
        // dzięki temu wynik suba z tła wie, do której zakładki/sesji ma wrócić.
        raw = await this.plugin.mcpClient.executeToolCall(toolCall, turn.agentName, { autonomy: turn.autonomy, origin: turn.origin });
    } catch (err: ChatViewMixinContext) {
        raw = { isError: true, error: err.message };
        error = err;
    }
    turn.rawResults.set(toolCall.id, { result: raw, error });

    // Kształt dla store (parytet z dawnym build toolResultContent):
    // generate_image + vision → tablica multimodalna (pętla przepuszcza bez zmian, model widzi obraz);
    // generate_image + non-vision → JSON bez base64 (żeby nie wysadzić kontekstu);
    // reszta → JSON.stringify. Nie mutujemy `raw` (onToolResults renderuje z niego obraz).
    if (toolCall.name === 'generate_image' && raw?.base64) {
        // AUD-code-review-073: model WŁAŚCICIELA tury, nie globalnie aktywnego agenta — user mógł
        // przełączyć zakładkę, gdy ta tura generowała obraz w tle (K18, tura ma własny `turn.agent`).
        if (this._isCurrentModelVision(turn.agent)) {
            const textPart = Object.assign({}, raw);
            delete textPart.base64;
            return [
                { type: 'text', text: JSON.stringify(textPart) },
                { type: 'image_url', image_url: { url: `data:image/${raw.format || 'png'};base64,${raw.base64}` } }
            ];
        }
        const copy = Object.assign({}, raw);
        delete copy.base64;
        return JSON.stringify(copy);
    }
    return JSON.stringify(raw);
}

/**
 * onToolResults (Faza 3, w kolejności tool_calls) — journal mcp_call, aktualizacja UI, token tracking
 * sub-agentów, side effects (delegate/skill/artefakty/reactory/vault_write/kom). NIE zapisuje wiadomości
 * do store (robi to pętla) i NIE journaluje agent_message/tool_result (to beforeContinue).
 * @param {number} i - indeks iteracji (dla skillActiveAt).
 */
export async function _chatOnToolResults(this: ChatViewMixinContext, turn: ChatViewMixinContext, results: ChatViewMixinContext[], i: number) {
    const isActiveTab = this._isTurnActiveTab(turn);
    const toolCallsContainer = turn.toolCallsContainer;
    const agentName = turn.agentName;

    // Zapamiętaj wyniki do journala tool_result (beforeContinue). r.result = finalna zawartość store.
    turn.lastRoundToolResults = results.map(r => ({ id: r.toolCall.id, content: r.result }));

    for (let ti = 0; ti < results.length; ti++) {
        const r = results[ti];
        const toolCall = r.toolCall;
        const pending = turn.pendingEntries?.[ti] || {};
        const toolDisplay = pending.toolDisplay;
        const isSubAgent = pending.isSubAgent ?? (toolCall.name === 'delegate');
        const stash = turn.rawResults.get(toolCall.id) || { result: undefined, error: null };
        const result = stash.result;
        const error = stash.error;

        await this.appendToActiveSession?.({
            type: error ? 'mcp_error' : 'mcp_call',
            agentName,
            tool: toolCall.name,
            args: toolCall.arguments,
            result: error ? error.message : result,
            timestamp: new Date().toISOString()
        });

        // --- UI updates (only on active tab) ---
        if (isActiveTab && toolDisplay) {
            if (error) {
                if (isSubAgent) {
                    toolDisplay.replaceWith(createSubAgentBlock({
                        type: toolCall.name,
                        status: 'error',
                        response: t('chat.streaming.error_prefix', { message: error.message }),
                    }));
                } else {
                    const makeDisplay = this.env?.settings?.pkmAssistant?.compactToolChips === false ? createToolCallDisplay : createCompactToolChip;
                    toolDisplay.replaceWith(makeDisplay({
                        name: toolCall.name,
                        input: toolCall.arguments,
                        status: 'error',
                        error: error.message
                    }));
                }
            } else if (isSubAgent && result?.started === true) {
                // F2: delegacja W TLE. Nie ma wyniku do pokazania — jest pokwitowanie startu.
                // Bez tej gałęzi leciała gałąź „success" niżej i rysowała PUSTĄ ramkę
                // (brak `result.result`, `tools_used`, `duration_ms`) z zielonym „gotowe".
                const _bgArgs = parseToolCallArgs(toolCall);
                const startedList = Array.isArray(result.tasks)
                    ? result.tasks
                    : [{ task_id: result.task_id, name: result.name }];
                const lines = startedList.map((task: ChatViewMixinContext) => t('chat.subagent_background_task', {
                    name: task?.name || _bgArgs.aspect || '?',
                    task_id: task?.task_id || '?',
                }));
                if (result.queued > 0) lines.push(t('chat.subagent_background_queued', { count: result.queued }));
                lines.push(t('chat.subagent_background_note'));
                const bgBlock = createSubAgentBlock({
                    type: toolCall.name,
                    pending: true,
                    status: 'success',
                    agentName: startedList.length > 1 ? '' : (startedList[0]?.name || _bgArgs.aspect || ''),
                    query: _bgArgs.task || '',
                    response: lines.join('\n'),
                });
                toolDisplay.replaceWith(bgBlock);
                bgBlock.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } else if (isSubAgent && result?.success) {
                const _saArgs = parseToolCallArgs(toolCall);
                const fullBlock = createSubAgentBlock({
                    type: toolCall.name,
                    status: toolResultStatus(result),
                    aspectType: result.aspect_type || 'researcher',
                    agentName: _saArgs.aspect || result.aspect || '',
                    query: _saArgs.task || '',
                    response: typeof result.result === 'string' ? result.result : '',
                    toolsUsed: result.tools_used || [],
                    toolCallDetails: result.tool_call_details || [],
                    duration: result.duration_ms || 0,
                    usage: result.usage,
                });
                toolDisplay.replaceWith(fullBlock);
                fullBlock.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } else if (isSubAgent && !result?.success) {
                const _saErrArgs = parseToolCallArgs(toolCall);
                const errorBlock = createSubAgentBlock({
                    type: toolCall.name,
                    status: 'error',
                    agentName: _saErrArgs.aspect || '',
                    query: _saErrArgs.task || '',
                    response: t('chat.streaming.error_prefix', { message: result?.error || t('chat.subagent_notification.unknown_error') }),
                    duration: 0,
                });
                toolDisplay.replaceWith(errorBlock);
                errorBlock.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } else {
                const makeDisplay = this.env?.settings?.pkmAssistant?.compactToolChips === false ? createToolCallDisplay : createCompactToolChip;
                toolDisplay.replaceWith(makeDisplay({
                    name: toolCall.name,
                    input: toolCall.arguments,
                    output: result,
                    // AUD-bledy-027/058/025: status z JEDNEJ reguły. Sam `result.isError` znał
                    // wyłącznie konwencję artefaktów i MCPClienta, więc odmowa `write`/`kom_send`/
                    // `memory_save` (`{success:false}`) dostawała zielony kryształ „zrobione".
                    status: toolResultStatus(result),
                    error: result.error
                }));
            }

            // Render generated image inline
            if (toolCall.name === 'generate_image' && result?.success && result?.base64 && toolCallsContainer) {
                const imgContainer = createDiv();
                imgContainer.className = 'pkm-generated-image-container';
                const img = createEl('img');
                img.className = 'pkm-generated-image';
                img.src = `data:image/${result.format || 'png'};base64,${result.base64}`;
                img.alt = result.revised_prompt || t('chat.streaming.generated_image');
                img.addEventListener('click', () => this._showImageOverlay(img.src));
                imgContainer.appendChild(img);
                if (result.path) {
                    const link = createEl('a');
                    link.className = 'pkm-generated-image-link';
                    link.textContent = `📁 ${result.path}`;
                    link.href = '#';
                    link.addEventListener('click', (e) => {
                        e.preventDefault();
                        this.app.workspace.openLinkText(result.path, '');
                    });
                    imgContainer.appendChild(link);
                }
                toolCallsContainer.appendChild(imgContainer);
            }
        }

        // --- Sub-agent token tracking (always, using captured tracker) ---
        // F2: bieg w tle (`started`) NIE ma tu czego liczyć — zwrotka to pokwitowanie, więc
        // fallback estymaty policzyłby tokeny samego pokwitowania i wpisał je jako pracę suba
        // (śmieciowy słupek w Token Viewerze). Prawdziwe zużycie przyjdzie z wynikiem biegu.
        if (!error && isSubAgent && result?.success && result?.started !== true) {
            const role = result.aspect_type || 'researcher';
            let subInput = result.usage?.prompt_tokens || 0;
            let subOutput = result.usage?.completion_tokens || 0;
            // Fallback: estymuj z task + toolCallDetails + wynik (gdy usage=null, np. error path).
            // L07-6: oficjalny estymator getTokenCount zamiast ad-hoc znaki/4; wpis oznaczony estimated.
            let estimated = false;
            if (subInput === 0) {
                const _saArgs2 = parseToolCallArgs(toolCall);
                let estText = _saArgs2.task || '';
                // AUD-dead-code-127 (2026-09-02): alias camelCase skasowany — `DelegateTool`
                // zawsze zwraca `tool_call_details` (snake_case), lewa strona `||` była zawsze
                // co najmniej pustą tablicą (truthy), więc prawa nigdy nie była osiągalna.
                const tcd = result.tool_call_details;
                if (tcd?.length) {
                    for (const td of tcd) {
                        estText += (td.resultPreview || '');
                    }
                }
                subInput = getTokenCount(estText);
                estimated = true;
            }
            if (subOutput === 0) {
                subOutput = countTokens(typeof result.result === 'string' ? result.result : '');
                estimated = true;
            }
            if (subInput > 0 || subOutput > 0) {
                turn.tt.record(role, subInput, subOutput, { estimated });
                if (isActiveTab) this._updateTokenPanel();
            }
        }

        // --- Side effects (always run, regardless of tab) ---
        if (toolCall.name === 'agent_delegate') {
            try {
                const parsed = typeof result === 'object' ? result : JSON.parse(JSON.stringify(result));
                if (parsed.delegation === true) this._pendingDelegation = parsed;
            } catch (e) {
                // AUD-bledy-018: `_pendingDelegation` to JEDYNE wejście do `_renderDelegationButton`
                // — po cichym `catch {}` guzik „przekaż rozmowę agentowi X" po prostu nie powstawał
                // i nie było o tym śladu ani w UI, ani w logu. Tekst przez maskę: w wyniku narzędzia
                // potrafi siedzieć cudza treść.
                log.warn('Chat', 'Nie udało się odczytać propozycji delegacji:', safeErrorText(e));
            }
        }
        // Track skill activation for todo/plan enforcement.
        // D17 (E2.4): skill_execute skasowany — skill uruchamia się przez read przepisu
        // (.pkm-assistant/skills/**). Wykrywamy udany read pod tą ścieżką jako aktywację skilla
        // (marker @@skill: ustawia skillActiveAt=0 osobno, na starcie tury).
        if (toolCall.name === 'read' && !error) {
            const readArgs = parseToolCallArgs(toolCall);
            const readPath = String(readArgs.path || '');
            if (readPath.startsWith('.pkm-assistant/skills/')) {
                turn.skillActiveAt = i;
                turn.skillArtifactCreated = false;
            }
        }
        // Track todo/artifact creation after skill (E2.9 FAZA D: nowe nazwy — todo/artifact_*).
        if (['artifact_create', 'todo'].includes(toolCall.name)) {
            turn.skillArtifactCreated = true;
        }
        await this.toolReactors?.run(toolCall.name, result, {
            view: this,
            plugin: this.plugin,
            toolCall,
            agentName,
            toolCallsContainer,
            isActiveTab
        });
        // D6d: warunek na DZISIEJSZĄ nazwę (E2.6 przemianował vault_write → write) — do tej pory
        // gałąź nie odpalała się dla `write`, więc przeładowanie skilli po zapisie przepisu
        // i link do zapisanego pliku były martwe.
        // ⚠️ `toolCall.name` to nazwa, którą wypisał MODEL: alias vault_write→write remapuje
        // LOKALNIE w `MCPClient.executeToolCall` (`toolCall = {...toolCall, name}` — rebind, nie
        // mutacja), a `results[].toolCall` z pętli niesie oryginał. Stara nazwa nadal tu dociera,
        // więc sprawdzamy obie.
        if (toolCall.name === 'write' || toolCall.name === 'vault_write') {
            // `arguments` bywa stringiem JSON (zależnie od platformy) — jak przy `read` wyżej.
            const writeArgs = parseToolCallArgs(toolCall);
            const writePath = String(writeArgs.path || '');
            if (writePath.includes('/skills/')) {
                await this.plugin?.agentManager?.reloadSkills();
                if (isActiveTab) this.renderSkillButtons();
            }
            // D6d: dwie martwe gałęzie wycięte razem z ożywieniem tej:
            //  - `/minions/` → `agentManager.reloadMinions()` — TAKIEJ METODY NIE MA w repo
            //    (`?.` stoi na agentManager, nie na metodzie), więc po ożywieniu rzucałaby
            //    TypeError w środku _chatOnToolResults. „Minions" to nazwa sprzed E2.4;
            //    sub-agenci mieszkają w `.pkm-assistant/sub-agents/` i nie mają hot-reloadu.
            //  - `playbook.md`/`vault_map.md` → `this._playbookDirty = true` — flaga write-only,
            //    zero czytelników w repo (Playbook Builder skasowany w E2.8 A4).
            // AUD-bledy-027: link wisi na POWODZENIU zapisu, nie na braku jednej flagi —
            // `writePath` pochodzi z argumentów wywołania, czyli z tego, co model CHCIAŁ zapisać.
            if (isActiveTab && shouldLinkWrittenFile(result, writePath) && toolCallsContainer) {
                const linkDiv = createDiv();
                linkDiv.addClass('cs-vault-link');
                const link = createEl('a');
                setSvgLabel(link, UiIcons.file(14), writePath);
                link.href = '#';
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.app.workspace.openLinkText(writePath, '');
                });
                linkDiv.appendChild(link);
                toolCallsContainer.appendChild(linkDiv);
            }
        }

        // S28 (D1): auto-ping po `kom_create_project` skasowany razem z Project Hubem.
    }
}

/**
 * beforeContinue — po dopisaniu przez pętlę assistant+tool do store, przed kolejnym wywołaniem modelu.
 * Journal agent_message + tool_result (kolejność: mcp_call z onToolResults, potem tu agent_message,
 * potem tool_result — parytet z dawnym handle_done), token economy (nudges + mid-loop compression),
 * reset kontenera, wstrzyknięcie zakolejkowanej wiadomości.
 */
export async function _chatBeforeContinue(this: ChatViewMixinContext, turn: ChatViewMixinContext, i: number) {
    turn.watchdog?.disarm(); // defensywnie: kompresja mid-loop może chwilę trwać, nie pilnujemy jej
    const isActiveTab = this._isTurnActiveTab(turn);
    const rw = turn.rw;
    const agentName = turn.agentName;
    const streamAgent = turn.agent;

    // Treść ostatnio dopisanej wiadomości assistant (pętla dopisała ją tuż przed tym hookiem).
    let asstMsg = null;
    for (let k = rw.messages.length - 1; k >= 0; k--) {
        if (rw.messages[k].role === 'assistant') { asstMsg = rw.messages[k]; break; }
    }
    const assistantContent = (asstMsg && typeof asstMsg.content === 'string') ? asstMsg.content : '';

    // Cache telemetry na wiadomości pośredniej (tool-call) — parytet z dawnym toolMsgMeta.cache.
    // Historia (chat_messages) renderuje badge z msg.cache przy re-renderze, więc musi być zapisane.
    if (asstMsg && turn.lastCacheMeta?.cached_tokens > 0) {
        asstMsg.cache = turn.lastCacheMeta;
    }

    // Token tracking dla tej odpowiedzi, jeśli onUsage nie zapisał (modele bez usage) — parytet
    // z per-response record w dawnym handle_done. Ta gałąź to ZAWSZE fallback (input z estymaty
    // kontekstu, output z countTokens lokalnie) — oznacz jako estimated, żeby Token Viewer nie
    // pokazywał tych liczb jako pomiaru z API.
    if (!turn.responseRecorded) {
        const inp = turn.lastInputTokens || 0;
        const out = countTokens(assistantContent);
        if (inp > 0 || out > 0) {
            turn.tt.record('main', inp, out, { estimated: true });
            if (isActiveTab) this._updateTokenPanel();
        }
    }

    const inputTokens = turn.lastApiInput > 0 ? turn.lastApiInput : (turn.lastInputTokens || 0);
    const outputTokens = turn.lastApiOutput > 0 ? turn.lastApiOutput : countTokens(assistantContent);

    await this.appendToActiveSession?.({
        type: 'agent_message',
        agentName,
        content: assistantContent,
        model: turn.model || '',
        tokens: { input: inputTokens, output: outputTokens },
        timestamp: new Date().toISOString()
    });
    for (const tr of (turn.lastRoundToolResults || [])) {
        await this.appendToActiveSession?.({
            type: 'tool_result',
            agentName,
            tool: tr.id,
            result: tr.content,
            timestamp: new Date().toISOString()
        });
    }

    // ── TOKEN ECONOMY: Track iterations + delegation nudge + skill nudge ──
    const iterCount = i + 1;
    const usedDelegate = (turn.pendingEntries || []).some((p: ChatViewMixinContext) => p.toolCall.name === 'delegate');
    if (usedDelegate) turn.hasUsedDelegate = true;

    const hasDelegates = turn.agent?.getActiveDelegates?.()?.length > 0;

    // Delegation nudge — agent has delegates, must delegate
    if (hasDelegates && !turn.hasUsedDelegate && iterCount >= 2) {
        const nudgeLevel = iterCount >= 4 ? 'strong' : 'soft';
        const nudgeMsg = nudgeLevel === 'strong'
            ? t('chat.streaming.delegation_nudge_strong', { count: iterCount })
            : t('chat.streaming.delegation_nudge_soft', { count: iterCount });
        // AUD-dead-code-156 (2026-09-02): znacznik `_systemNudge: true` skasowany — nikt w
        // repo go nie czytał (dopisywany do KAŻDEJ wiadomości-szturchańca, bez odsiewu w
        // render_messages/getMessagesForAPI).
        await rw.addMessage('user', nudgeMsg);
        log.info('Chat', `Delegation nudge (${nudgeLevel}) po ${iterCount} iteracjach`);
    }

    // Skill → todo/plan enforcement nudge
    if (turn.skillActiveAt != null && !turn.skillArtifactCreated) {
        const sinceSkill = iterCount - turn.skillActiveAt;
        if (sinceSkill >= 2) {
            await rw.addMessage('user', t('chat.streaming.skill_todo_nudge'));
            log.info('Chat', `Skill todo nudge po ${sinceSkill} iteracjach od aktywacji skilla`);
        }
    }

    // Opcja 4: Mid-loop compression — proactive, not just on hard limit
    const compressionNeeded = rw.getCompressionNeeded();
    if (compressionNeeded !== 'none') {
        log.info('Chat', `Token Economy: mid-loop compression (${compressionNeeded}) po iteracji ${iterCount}`);
        if (isActiveTab) this.showTypingIndicator(t('chat.streaming.compressing_context'));
        if (compressionNeeded === 'summarize') {
            // AUD-code-review-052: sama ścieżka co end-of-turn (_finalizeTurn) — bez tego pierwsze
            // przekroczenie progu 90% wypadające W ŚRODKU pętli (przed jakąkolwiek kompresją
            // end-of-turn w tym oknie) leciało z `rw.sessionPath === ''`, a Summarizer.getSummaryPrompt
            // gubił podpowiedź „📂 Pełna rozmowa zapisana w: …". Zdarzenia tury są już dopisane na
            // bieżąco przez `appendToActiveSession`, więc `activeSessionPath` jest tu żywy bez
            // dodatkowego zapisu.
            rw.sessionPath = this.plugin?.agentManager?.getAgentMemory?.(turn.agentName)?.activeSessionPath || rw.sessionPath || '';
        }
        await rw.performTwoPhaseCompression(false);
    }

    // Reset current container before continuing
    if (isActiveTab) {
        // AUD-wydajnosc-071: ostatnia zebrana klatka MUSI trafić na ekran, zanim zerujemy
        // wskaźniki malowania — inaczej ogon tekstu sprzed wywołania narzędzia by zniknął.
        this._renderThrottle?.flush();
        if (this.current_message_bubble) {
            this.current_message_bubble.classList.remove('streaming');
        }
        if (this._currentThinkingBlock) {
            this._currentThinkingBlock.classList.remove('streaming');
            this._currentThinkingBlock = null;
        }
        this._resetPaintTargets();

        // Show thinking indicator while model processes tool results
        this.showTypingIndicator(t('chat.streaming.analyzing_results'));
    }

    // ── QUEUE INJECT: If a message was queued, inject it into context before continuing ──
    const queued = readQueuedMessage(this._queuedMessage);
    if (queued) {
        const injectedText = queued.text;
        this._queuedMessage = null;
        log.info('Chat', `Injecting queued message into context (${queued.meta.origin}): "${injectedText.slice(0, 60)}..."`);

        // K7 (AUD-security-003, druga strona wady): ta ścieżka omija `append_message`, więc do
        // K7 tekst WPISANY przez usera nie zasilał rejestru adresów — `web_read` odrzucał link,
        // który user sam wkleił.
        // K19 (AUD-security-117/131): proweniencja NIE jest tu jednoznaczna — do kolejki wpada
        // też tekst maszynowy (guzik artefaktu i spółka wypełniają pole wpisywania z kodu).
        // Oddajemy ZAPAMIĘTANĄ pieczątkę; twarde `human` w tym miejscu cofało K7.
        registerUrlsIfHuman(queued.text, queued.meta, registerUrlsFromText);
        await rw.addMessage('user', injectedText, {
            timestamp: new Date().toLocaleTimeString(getDateLocale(), { hour: '2-digit', minute: '2-digit' }),
            origin: queued.meta.origin,
        });
        await this.appendToActiveSession?.({
            type: 'user_message',
            agentName,
            content: injectedText,
            timestamp: new Date().toISOString()
        });

        // Render in UI (only on active tab)
        if (isActiveTab) {
            this._hideQueuedIndicator();
            const userDiv = this.messages_container.createDiv({ cls: 'cs-message cs-message--user' });
            const agentColor = SkinManager.getAgentColor(streamAgent || 'default');
            userDiv.style.setProperty('--cs-agent-color-rgb', hexToRgbTriplet(agentColor));
            const textDiv = userDiv.createDiv({ cls: 'cs-message__text' });
            this._renderUserText(textDiv, injectedText);
            this.scrollToBottom();
            this._agentHeaderShown = false; // Next agent message gets header
        }
    }
}

/**
 * _finalizeTurn — po zakończeniu pętli (natural / backstop). Odtwarza „no tool calls" branch dawnego
 * handle_done: crystal notice, zapis finalnej wiadomości + journal, timestamp/akcje, restore mode,
 * cleanup, dwufazowa kompresja end-of-turn.
 */
export async function _finalizeTurn(this: ChatViewMixinContext, turn: ChatViewMixinContext, result: ChatViewMixinContext) {
    const isActiveTab = this._isTurnActiveTab(turn);
    const rw = turn.rw;
    const streamAgent = turn.agent;
    const streamAgentName = turn.agentName;
    const content = result.finalText || '';

    if (isActiveTab) this.hideTypingIndicator();
    // AUD-wydajnosc-071: domalowanie ostatniej zebranej klatki PRZED porównaniem finalnej treści
    // z `_lastPaintedContent` niżej. Bez tego throttle zostawałby z niepomalowanym ogonem, a
    // porównanie widziałoby treść starszą niż to, co user faktycznie ma na ekranie.
    if (isActiveTab) this._renderThrottle?.flush();

    // Token tracking dla finalnej odpowiedzi, jeśli onUsage nie zapisał (modele bez usage).
    // Zawsze fallback (patrz komentarz w _chatBeforeContinue) — estimated: true.
    if (!turn.responseRecorded) {
        const inp = turn.lastInputTokens || 0;
        const out = countTokens(content);
        if (inp > 0 || out > 0) {
            turn.tt.record('main', inp, out, { estimated: true });
            if (isActiveTab) this._updateTokenPanel();
        }
    }
    const cacheMeta = turn.lastCacheMeta;
    const inputTokens = turn.lastApiInput > 0 ? turn.lastApiInput : (turn.lastInputTokens || 0);
    const outputTokens = turn.lastApiOutput > 0 ? turn.lastApiOutput : countTokens(content);

    log.info('Chat', `Odpowiedź GOTOWA: ${content.length} znaków (stop: ${result.stoppedBy})`);

    // Notify user when agent finishes on background tab or window not focused
    if (!isActiveTab || !document.hasFocus()) {
        const agentColor = SkinManager.getAgentColor(streamAgent || 'default');
        this.plugin.showCrystalNotice(
            t('chat.streaming.agent_finished', { emoji: streamAgent?.emoji || '◆', name: streamAgentName }),
            { type: 'agent', timeout: 5000, agentColor }
        );
    }
    const timestamp = new Date().toLocaleTimeString(getDateLocale(), { hour: '2-digit', minute: '2-digit' });
    const idx = rw.messages.length; // Will be the index after adding
    await rw.addMessage('assistant', content, { timestamp, ...(cacheMeta?.cached_tokens > 0 ? { cache: cacheMeta } : {}) });
    await this.appendToActiveSession?.({
        type: 'agent_message',
        agentName: streamAgentName,
        content,
        model: turn.model || '',
        tokens: { input: inputTokens, output: outputTokens },
        timestamp: new Date().toISOString()
    });
    if (isActiveTab) this.updateTokenCounter();

    // Dorysowujemy gdy final ≠ ostatnio namalowane: albo stream w ogóle nie miał chunków, albo
    // finalna treść przyszła dopiero w zwrotce `done` (rollback niedomkniętego <think>, strip
    // halucynowanych tagów) — a `done` nie leci przez handlers.chunk, więc DOM został stary.
    if (isActiveTab && content && content !== this._lastPaintedContent) {
        // _ensureAgentMessageContainer NIE jest idempotentny (zawsze tworzy nowy node) — tylko gdy brak.
        if (!this.current_message_container) this._ensureAgentMessageContainer(streamAgent);
        this.current_message_text.empty();
        // release 2.2.0/W2 (@typescript-eslint/no-deprecated): renderMarkdown → render, patrz
        // komentarz przy analogicznym wywołaniu w _paintStreamFrame wyżej — sama sygnatura zyskuje
        // `app`, fire-and-forget bez zmian (renderMarkdown też był Promise<void> bez await).
        void MarkdownRenderer.render(this.app, content, this.current_message_text, '', this);
        this._lastPaintedContent = content;
    }

    // Add timestamp and actions to the streamed message (only if on active tab)
    if (isActiveTab && this.current_message_container) {
        const meta = this.current_message_container.createDiv({ cls: 'cs-message__meta' });
        meta.createSpan({ text: timestamp });
        this._renderCacheSavingsBadge(meta, cacheMeta);
        this.addMessageActions(meta, content, 'assistant', idx);

        if (this._pendingDelegation) {
            this._renderDelegationButton(this.current_message_container, this._pendingDelegation);
            this._pendingDelegation = null;
        }
    }

    // Finalize streaming state
    if (isActiveTab) {
        if (this.current_message_bubble) {
            this.current_message_bubble.classList.remove('streaming');
        }
        if (this._currentThinkingBlock) {
            this._currentThinkingBlock.classList.remove('streaming');
            this._currentThinkingBlock = null;
        }
        this._resetPaintTargets();
        this.set_generating(false);
        this.scrollToFinalMessage();
        // AUD-wydajnosc-072/014: malowanie strumienia świadomie NIE rysowało łączników — tu,
        // po dołożeniu wiersza meta i akcji, przerysowujemy je raz, na koniec tury.
        this._scheduleConnectorRedraw();
    } else {
        // Background tab finished — mark as not generating in saved state.
        // AUD-code-review-012: `_agentStates` jest kluczowana `_tabKey(tab)` (patrz `_switchTab`
        // / `_restoreActiveSession`), NIE nazwą agenta — po restarcie z sesji na dysku klucz
        // zakładki to ścieżka sesji, więc `.get(streamAgentName)` chybiał i flaga `isGenerating`
        // zostawała `true` na zawsze (zakładka wisiała na „generuję").
        // F04: klucz z `turn.origin.tabKey` — ZAMROŻONY na starcie tury (`ownerTabKey` w
        // `send_message`), NIE `_tabKey(turn.owner?.tab)` przeliczony TU, godziny później.
        // `/save session` → „Archiwizuj i nowa sesja" podmienia `tab.sessionPath` NA MIEJSCU
        // bez re-keyowania `_agentStates` — przeliczony klucz czyta już nową wartość i chybia
        // wpis zapisany pod starą.
        const savedState = this._agentStates.get(turn.origin?.tabKey ?? '');
        if (savedState) savedState.isGenerating = false;
        const tab = this.chatTabs.find((t: ChatViewMixinContext) => t.agentName === streamAgentName);
        if (tab) tab._needsRefresh = true;
    }

    // Clear streaming context for this agent — this stream is complete.
    // AUD-security-116: warunkowo, po `turnId` — pod tą samą nazwą agenta może już żyć NOWSZA
    // tura, a skasowanie jej wpisu odebrałoby Stopowi uchwyt przerwania.
    this._releaseStreamCtx(streamAgentName, turn.turnId);

    // DWUFAZOWA KOMPRESJA PO zakończeniu taska (jak Claude Code):
    // Use captured `rw` — even if user switched tabs, compress the right conversation
    const autoCompression = this.env?.settings?.pkmAssistant?.enableAutoSummarization !== false;
    const compressionNeeded = autoCompression ? rw.getCompressionNeeded() : 'none';
    if (compressionNeeded !== 'none') {
        log.info('Chat', `Kompresja (${compressionNeeded}) — kontekst: ${rw.getCurrentTokenCount()} / ${rw.maxTokens} tokenów`);

        if (compressionNeeded === 'summarize') {
            // K4 (AUD-security-064/065): kompresja końca tury leci TAKŻE dla zakładki w tle,
            // więc i zapis transkryptu, i ścieżka sesji w prompcie kompresji muszą celować
            // w agenta TEJ tury, a nie w tego, który akurat jest globalnie aktywny.
            await this.handleSaveSession(turn.agentName, rw);
            const sessionPath = this.plugin?.agentManager?.getAgentMemory?.(turn.agentName)?.activeSessionPath || '';
            rw.sessionPath = sessionPath;
        }

        const compResult = await rw.performTwoPhaseCompression(false);

        if (compResult.trimmed > 0 && !compResult.summarized) {
            log.info('Chat', `Faza 1 wystarczyła: skrócono ${compResult.trimmed} wyników, bez API call`);
        }

        if (isActiveTab) {
            this.updateTokenCounter();
            this._updateTokenPanel();
        }
    }

    // If stream finished on a background tab, mark the tab for refresh
    if (!isActiveTab && streamAgentName) {
        const tab = this.chatTabs.find((t: ChatViewMixinContext) => t.agentName === streamAgentName);
        if (tab) tab._needsRefresh = true;
    }
}

export function handle_error(this: ChatViewMixinContext, error: ChatViewMixinContext, agentName: string, turnId?: number, ownerTabKey?: string) {
    this.hideTypingIndicator();
    // K20b (AUD-security-132, ZLEW): tekst błędu idzie do DOM-u czatu i do loga (który pisze
    // też do pliku). Na sieciowym padzie strumienia `error.message` bywa zrzutem całego
    // zdarzenia streamera razem z `source.headers.Authorization` — czyli SUROWYM kluczem API.
    // Źródło domyka osobna naprawa; tu stoi obrona w głąb: normalizacja → maska → sufit.
    const safeText = safeErrorText(error) || 'Unknown error occurred';
    log.error('Chat', 'Chat error:', safeErrorText(error));

    // Determine which tab this error belongs to
    const ctx = agentName ? this._streamCtxMap.get(agentName) : null;
    const streamAgentName = agentName || ctx?.agentName || '';
    const currentTabAgent = this.chatTabs.find((t: ChatViewMixinContext) => t.isActive)?.agentName;
    const isActiveTab = !agentName || currentTabAgent === agentName;

    if (isActiveTab) {
        if (this.current_message_container) {
            this.current_message_text.empty();
            this.current_message_text.createEl('p', {
                text: t('chat.streaming.error_prefix', { message: safeText }),
                cls: 'pkm-chat-error'
            });
        } else {
            const error_msg = this.messages_container.createDiv({
                cls: 'cs-message cs-message--agent'
            });
            error_msg.style.setProperty('--cs-agent-color-rgb', this._getAgentRgb());
            const textDiv = error_msg.createDiv({ cls: 'cs-message__text' });
            textDiv.createEl('p', { text: t('chat.streaming.error_prefix', { message: safeText }), cls: 'pkm-chat-error' });
        }
        // AUD-bledy-016: ścieżka błędu zeruje wskaźniki malowania DOKŁADNIE tak, jak ścieżka
        // sukcesu (`_finalizeTurn`) i Stop. Bez tego `handle_chunk` następnej tury widział
        // niepusty `current_message_container` i malował odpowiedź do dymka poprzedniej
        // wiadomości — fizycznie NAD nowym pytaniem, bez nagłówka agenta; a po przerysowaniu
        // listy (przełączenie zakładki) do węzła wypiętego z drzewa, czyli w nicość.
        // Review opusa (bonus): ścieżka błędu zerowała wskaźniki malowania, ale NIE
        // `_currentThinkingBlock` — blok myśli następnej tury wpadał wtedy do dymka poprzedniej
        // wiadomości (`insertBefore` w `_paintStreamFrame` celuje w stary kontener). Zerujemy
        // tak samo jak `_finalizeTurn`, `_chatBeforeContinue` i `stop_generation`.
        if (this._currentThinkingBlock) {
            this._currentThinkingBlock.classList.remove('streaming');
            this._currentThinkingBlock = null;
        }
        this._resetPaintTargets();
        this.set_generating(false);
    } else {
        // Background tab errored — mark as not generating in saved state.
        // AUD-code-review-012: klucz `_agentStates` to `_tabKey(tab)`, nie nazwa agenta —
        // `ownerTabKey` przychodzi od wołacza (`ownerTabKey` policzony RAZ na starcie
        // `send_message`, patrz jej catch), bo `handle_error` sam nie ma dostępu do
        // zamrożonego właściciela tury. F04: STRING zamrożony na starcie tury, nie obiekt
        // `tab` przeliczany tu leniwie (ten sam powód co w `_finalizeTurn` — `archive_new`
        // podmienia `tab.sessionPath` bez re-keyowania `_agentStates`).
        const savedState = this._agentStates.get(ownerTabKey ?? '');
        if (savedState) savedState.isGenerating = false;
        const tab = this.chatTabs.find((t: ChatViewMixinContext) => t.agentName === streamAgentName);
        if (tab) tab._needsRefresh = true;
    }

    // Resolve hanging ask_user promise to unblock tool execution
    this._cleanupAskUser();

    // Always clear streaming context on error — ale wyłącznie wpis TEJ tury (AUD-security-116).
    if (agentName) this._releaseStreamCtx(agentName, turnId);
}

/**
 * _onStreamStall — watchdog wystrzelił: model milczy (zero chunków) dłużej niż
 * `chat_stream_stall_timeout_ms`. Przerywa turę TĄ SAMĄ ścieżką co ręczny Stop
 * (stop_generation z agentem tury) + pisze uczciwy komunikat w czacie. Tura na
 * zakładce w tle dostaje cleanup stanu jak w handle_error + crystal notice.
 *
 * Wiszący XHR po abort NIE rozstrzyga promisy pętli (transport strumienia nie emituje
 * zdarzenia na abort), więc finally w send_message może nigdy nie ruszyć — dlatego
 * stream jest wyrejestrowywany ze StreamingManagera tutaj.
 */
export function _onStreamStall(this: ChatViewMixinContext, turn: ChatViewMixinContext, silentMs: number) {
    const agentName = turn.agentName;
    // Tura już zatrzymana (ręczny Stop) albo zakończona/wyczyszczona — watchdog milczy.
    // K5: pytamy o stan TEJ tury, nie o pole widoku (które po Stopie innej tury kłamało).
    if (turn.abort?.isAborted()) return;
    if (!this._streamCtxMap.has(agentName)) return;

    // Friendly fire 2026-08-15: mapa kontekstów jest kluczowana NAZWĄ agenta, więc watchdog
    // PORZUCONEJ tury (user wystartował nową sesję, stara wisiała w tle) widział wpis żywej
    // tury tego samego agenta i strzelał do niej: stop_generation ubijał świeży request
    // wspólnej instancji modelu i rozbrajał CUDZY watchdog — żywa tura zostawała bez
    // strażnika, z promisą, która nigdy się nie rozstrzygnie (incydent 2026-08-15 17:13).
    // Przeterminowany watchdog sprząta wyłącznie po sobie i NIE dotyka żywej tury.
    const liveCtx = this._streamCtxMap.get(agentName);
    if (typeof turn.turnId === 'number' && typeof liveCtx?.turnId === 'number' && liveCtx.turnId !== turn.turnId) {
        log.warn('Chat', `[${agentName}] Watchdog porzuconej tury #${turn.turnId} (żywa: #${liveCtx.turnId}) — sprzątam bez strzelania`);
        if (turn.streamId) streamingManager.stopStream(turn.streamId);
        return;
    }

    const seconds = Math.round(silentMs / 1000);
    log.warn('Chat', `[${agentName}] Watchdog: model milczy od ${seconds}s — przerywam turę jak ręczny Stop`);

    const isActiveTab = this._isTurnActiveTab(turn);
    if (isActiveTab) {
        this.stop_generation(agentName);
    } else {
        // Tura w tle: przerwanie TEJ tury + przerwanie XHR właściwej instancji + cleanup stanu
        // zakładki (wzór handle_error) — bez dotykania UI aktywnej zakładki.
        turn.abort?.abort('stall');
        // Parytet z ręcznym Stopem: po przerwaniu nie sięgamy sami po zaległe wyniki subów
        // (auto-tura poleciałaby w ten sam martwy serwer).
        this._drainSuppressed = true;
        const bgModel = this._streamCtxMap.get(agentName)?.chatModel || this.env.chatModel;
        bgModel?.stopStream?.();
        this._releaseStreamCtx(agentName, turn.turnId);
        // AUD-code-review-012: klucz `_agentStates` to `_tabKey(tab)`, nie nazwa agenta —
        // patrz uzasadnienie w `_finalizeTurn`. F04: `turn.origin.tabKey` (zamrożony na starcie
        // tury) zamiast `_tabKey(turn.owner?.tab)` — watchdog strzela nawet PO KILKU MINUTACH
        // ciszy modelu, czyli z największym oknem na to, żeby `/save session` → „Archiwizuj
        // i nowa sesja" zdążył podmienić `tab.sessionPath` pod nogami tej tury.
        const savedState = this._agentStates.get(turn.origin?.tabKey ?? '');
        if (savedState) savedState.isGenerating = false;
        const bgTab = this.chatTabs.find((tab: ChatViewMixinContext) => tab.agentName === agentName);
        if (bgTab) bgTab._needsRefresh = true;
    }
    if (turn.streamId) streamingManager.stopStream(turn.streamId);

    const msg = t('chat.streaming.stall_aborted', { seconds });
    if (isActiveTab) {
        const errDiv = this.messages_container.createDiv({ cls: 'cs-message cs-message--agent' });
        errDiv.style.setProperty('--cs-agent-color-rgb', this._getAgentRgb());
        errDiv.createDiv({ cls: 'cs-message__text' }).createEl('p', { text: msg, cls: 'pkm-chat-error' });
        this.scrollToBottom();
    } else {
        const agentColor = SkinManager.getAgentColor(turn.agent || 'default');
        this.plugin?.showCrystalNotice?.(msg, { type: 'agent', timeout: 8000, agentColor });
    }
}

export function stop_generation(this: ChatViewMixinContext, agentName: string, reason = 'stop') {
    // K5 (AUD-security-037): przerwanie ZATRZASKUJEMY na uchwycie TEJ tury — pętla
    // (`shouldAbort`) i bramka chunków czytają stan swojej tury, nie pole widoku. Nowa tura
    // dostaje własny uchwyt, więc kolejna wiadomość usera (ani auto-tura z wynikiem suba,
    // ani drain przy przełączeniu zakładki) nie ma jak odkręcić tego przerwania.
    // agentName opcjonalny: watchdog (_onStreamStall) podaje agenta SWOJEJ tury;
    // przycisk Stop woła bez argumentu = aktywny agent (zachowanie bez zmian).
    // Pas zapasowy na wołaczy z UI: `stop_generation` bywa wpinane jako listener kliknięcia,
    // więc pierwszym argumentem potrafi być MouseEvent (wzór ostrzeżenia przy `send_message`).
    // Nie-string traktujemy jak brak nazwy — czyli „tura aktywnego agenta".
    const requested = typeof agentName === 'string' ? agentName : '';
    const activeAgent = requested || this.plugin?.agentManager?.getActiveAgent()?.name || '';
    log.info('Chat', `Stop: aborting stream for agent "${activeAgent}" (${reason})`);

    const sCtx = this._streamCtxMap.get(activeAgent);
    // Tura w locie ma uchwyt we wpisie mapy; tura w przygotowaniu (prompt się jeszcze buduje) —
    // w `_preparingTurns`. Bez tej drugiej gałęzi Stop kliknięty w oknie przygotowania trafiałby
    // w próżnię i tura ruszyłaby mimo niego.
    (sCtx?.abort || this._preparingTurns?.get(activeAgent))?.abort(reason);
    // Po Stopie nie sięgamy sami po zaległe wyniki subów (patrz `_deliverSubTaskResult`) — to
    // była rola dawnej flagi widoku, dziś osobny, jawny bezpiecznik na czas do następnej tury.
    this._drainSuppressed = true;

    // AUD-bledy-055: Stop kasuje TEŻ zakolejkowaną wiadomość. Bez tego `set_generating(false)`
    // na końcu tej funkcji planował jej wysyłkę na 100 ms po kliknięciu Stop — user przerywał
    // WSZYSTKO, a chwilę później ruszała pełna tura (przy autonomii `yolo` razem z zapisami
    // i delegacjami, na które nie miał jak się zgodzić). Tekst nie ginie: jeśli pole wpisywania
    // jest puste, wraca do niego, więc user widzi, co przerwał, i decyduje sam.
    // AUD-testy-024: decyzję („czy kasować slot" + „czy oddać tekst do pola") liczy czysta
    // `evaluateStopQueueCancel` (`queuedMessage.ts`) — tutaj zostaje samo wykonanie.
    this._clearQueuedDrainTimer();
    const cancel = evaluateStopQueueCancel(this._queuedMessage, this.input_area?.value);
    if (cancel.clearSlot) {
        this._queuedMessage = null;
        if (cancel.restoreText !== null) {
            this.input_area.value = cancel.restoreText;
            this.handleInputResize?.();
        }
        log.info('Chat', `Stop anulował zakolejkowaną wiadomość: "${cancel.cancelled?.text.slice(0, 60)}..."`);
    }
    this._hideQueuedIndicator();
    // Watchdog tej tury nie może już wystrzelić po Stopie.
    sCtx?.watchdog?.disarm();

    // Przerwij XHR WŁAŚCIWEJ instancji modelu — równoległa tura (needsFreshModel) używa
    // świeżej instancji, której env.chatModel nie zna.
    if (sCtx?.chatModel?.stopStream) {
        sCtx.chatModel.stopStream();
    } else if (this.env.chatModel?.stopStream) {
        this.env.chatModel.stopStream();
    }

    // Clean up streaming state (natychmiastowy feedback — pętla może jeszcze wisieć na przerwanym XHR;
    // finalizacja jest pominięta bo shouldAbort → stoppedBy='abort' albo catch łapie flagę).
    this._releaseStreamCtx(activeAgent, sCtx?.turnId);
    // AUD-wydajnosc-071: Stop zatrzymuje strumień, ale NIE kasuje tego, co user już dostał —
    // ostatnia zebrana klatka jest domalowana przed wyzerowaniem wskaźników (żaden fragment
    // odpowiedzi sprzed kliknięcia nie ginie).
    this._renderThrottle?.flush();
    if (this.current_message_bubble) {
        this.current_message_bubble.classList.remove('streaming');
    }
    if (this._currentThinkingBlock) {
        this._currentThinkingBlock.classList.remove('streaming');
        this._currentThinkingBlock = null;
    }
    this._resetPaintTargets();
    this.hideTypingIndicator();

    this.set_generating(false);
}

/**
 * K5 (AUD-security-068): zatrzymaj WSZYSTKO, co ten widok trzyma w locie — tury na zakładkach
 * w tle też, plus suby zlecone z tych zakładek.
 *
 * Po co: `onClose` warunkował zatrzymanie generowania polem `is_generating`, które przełączenie
 * zakładki nadpisuje stanem zakładki DOCELOWEJ. Tura agenta z zakładki w tle przeżywała więc
 * zamknięcie panelu — bez flagi przerwania, bez watchdoga (linia wyżej rozbrajała watchdogi
 * WSZYSTKICH tur) — i leciała do końca budżetu iteracji, wykonując narzędzia i dopisując
 * odpowiedź do pliku sesji z zamkniętego widoku.
 *
 * Zamykamy PO WŁAŚCICIELACH TUR (K4): każdy wpis `_streamCtxMap` dostaje ten sam Stop co guzik.
 * Watchdogów NIE rozbrajamy wcześniej — robi to `stop_generation` dla tury, którą właśnie ubija.
 *
 * @param reason - powód zapisywany na uchwycie tury (`'close'` z `onClose`)
 * @returns nazwy agentów, których tury zatrzymano
 */
export function stop_all_turns(this: ChatViewMixinContext, reason = 'close'): string[] {
    // Kopia nazw PRZED pętlą — `stop_generation` kasuje wpisy z mapy w trakcie. Bierzemy też
    // tury W PRZYGOTOWANIU (prompt się buduje, wpisu w mapie jeszcze nie ma).
    const preparing = Array.from<string>(this._preparingTurns?.keys?.() || [])
        .map((agentName) => ({ agentName }));
    const names = collectTurnsToStop([...(this._streamCtxMap?.values?.() || []), ...preparing]);

    // Zakolejkowana wiadomość nie ma dokąd polecieć: `set_generating(false)` wystrzeliłby ją
    // w zamykany widok (setTimeout 100 ms). Kasujemy PRZED zatrzymaniem tur.
    // AUD-bledy-015: sam pusty slot nie wystarczał — timer mógł być JUŻ uzbrojony (tura
    // skończyła się do 100 ms przed zamknięciem), a wtedy budził się w zamkniętym widoku
    // i odpalał pełną turę: model, narzędzia, zapis do pliku sesji. Rozbrajamy go jawnie.
    this._clearQueuedDrainTimer();
    this._queuedMessage = null;
    this._drainSuppressed = true;

    for (const name of names) {
        try {
            this.stop_generation(name, reason);
        } catch (e: ChatViewMixinContext) {
            log.warn('Chat', `Zatrzymanie tury [${name}] padło (zamykamy dalej): ${e?.message || e}`);
        }
    }

    // Suby zlecone z tego widoku — po adresie zwrotnym (origin), nie po tym, kto je wykonuje.
    // `requestStop` to PROŚBA: bieg gaśnie przy najbliższym punkcie przerwania swojej pętli.
    const registry = this.plugin?.subTaskRegistry;
    if (registry?.list && registry.requestStop) {
        try {
            const tabKeys = (this.chatTabs || []).map((tab: ChatViewMixinContext) => _tabKey(tab));
            const ids = collectSubTaskIdsForOwners(registry.list(), { tabKeys, agentNames: names });
            for (const id of ids) {
                log.info('Chat', `Zamknięcie czatu → zatrzymuję bieg suba ${id}`);
                registry.requestStop(id);
            }
        } catch (e: ChatViewMixinContext) {
            log.warn('Chat', `Zatrzymanie subów przy zamknięciu padło: ${e?.message || e}`);
        }
    }

    return names;
}

/**
 * F2 faza B: podłącz czat jako DOSTAWCĘ wyników subów odpalonych w tle i odbierz to,
 * co już czeka. Wołane z `ChatView.onOpen` PO odtworzeniu sesji — wcześniej nie byłoby
 * do czego dopasować originu (zakładki jeszcze nie istnieją).
 *
 * ⚠️ Notifier trzyma JEDNEGO dostawcę. Przy dwóch otwartych widokach czatu wygrywa ten
 * otwarty jako ostatni, a jego zamknięcie odpina dostarczanie dla obu (`setDeliverer(null)`).
 * Wyniki nie giną — zostają w kolejce do następnego otwarcia czatu.
 */
export function _wireSubTaskDeliverer(this: ChatViewMixinContext) {
    const notifier = this.plugin?.subTaskNotifier;
    if (!notifier?.setDeliverer) return;
    notifier.setDeliverer((task: ChatViewMixinContext) => this._deliverSubTaskResult(task));
    // `setDeliverer` świadomie NIC nie dostarcza — moment wybiera wołacz. Teraz.
    this._drainSubTasks();
}

/** Ponów próbę dostarczenia zaległych wyników. Nigdy nie rzuca (powiadomienia nie wywracają czatu). */
export function _drainSubTasks(this: ChatViewMixinContext) {
    try {
        this.plugin?.subTaskNotifier?.drain?.();
    } catch (e: ChatViewMixinContext) {
        log.warn('Chat', `Drain wyników subów padł (nieszkodliwie): ${e?.message || e}`);
    }
}

/**
 * Dostawca wyniku suba z tła. Kontrakt notifiera: `true` = skonsumowane (wypada z kolejki),
 * `false` = zostaw na później (ponowi `drain`).
 *
 * Bramki liczy czysta `evaluateSubTaskDelivery` (`subTaskDelivery.ts` — ma testy obu stron
 * każdej gałęzi, AUD-testy-024). Tu zostaje tylko wykonanie werdyktu. Kolejność:
 *   1. brak zakładki adresata → `false` (agent nieotwarty — wynik czeka);
 *   2. zakładka NIEAKTYWNA → `false` (auto-tura w tle byłaby robotą za plecami usera;
 *      dowiezie ją `drain` przy przełączeniu zakładki);
 *   3. trwa tura (własna albo już wstrzyknięta) → `false` (dowiezie `drain` po finalizacji);
 *   4. po Stopie / watchdogu (`_drainSuppressed`) → `false` (AUD-security-115);
 *   5. sufit łańcucha auto-tur po subach → `false` + `Notice` (werdykt Kuby 16.08).
 * Dopiero zakładka aktywna i bezczynna dostaje AUTO-TURĘ z treścią powiadomienia.
 *
 * Poza bramką (i celowo PRZED nią) zostaje jedno pytanie: zadanie bez `id` odpada od razu,
 * bo to ono chroni wyliczenie adresu zwrotnego niżej przed wywrotką na pustym zadaniu.
 */
export function _deliverSubTaskResult(this: ChatViewMixinContext, task: ChatViewMixinContext) {
    try {
        if (!task?.id) return false;

        const origin = {
            ...(task.origin || {}),
            // Bez adresu zwrotnego (zlecenie spoza czatu) zostaje właściciel biegu.
            agentName: task.origin?.agentName || task.agentName,
        };
        const tab = matchTabForOrigin(this.chatTabs, origin, _tabKey);

        // Werdykt Kuby 16.08: sufit ŁAŃCUCHA auto-tur po subach z rzędu. Bez tego agent
        // w auto-turze może zlecić kolejnego suba, jego wynik znów odpala auto-turę — i tak
        // w kółko (`max_delegation_depth` NIE chroni: auto-tura to nowa tura agenta GŁÓWNEGO,
        // głębokość delegacji liczy się od zera). Licznik żyje per agent (ten sam klucz co
        // `_streamCtxMap`), zerowany w `send_message` prawdziwą wiadomością człowieka.
        // Jedno wywołanie `getLimits` na doręczenie — czytany niżej też dla `subagent_result_max_chars`.
        // Sam odczyt licznika NIE zakłada mapy (`?.get`) — mapa powstaje dopiero przy zapisie,
        // czyli tylko na ścieżce, która naprawdę startuje auto-turę.
        const limits = getLimits(this.env?.settings);
        const chain = evaluateAutoTurnChain(this._autoTurnChainCounts?.get(tab?.agentName) || 0, limits.max_consecutive_auto_turns);

        // AUD-testy-024: KOMPLET bramek dostarczenia liczy czysta `evaluateSubTaskDelivery`
        // (`subTaskDelivery.ts`) — zakładka → aktywność → trwająca tura → Stop → sufit łańcucha.
        // Tutaj zostaje wyłącznie wykonanie werdyktu, bo `chat_streaming.ts` wisi na `obsidian`
        // i w AVA nie wstaje: dopóki decyzje siedziały w tym pliku, pilnował ich wyłącznie regex
        // po tekście źródła, który nie odróżniał `if (x) return false;` od `if (x) { }`.
        // Bramka „po Stopie nie startujemy tury sami" (AUD-security-115) jest tam czwarta w
        // kolejności i stoi TUTAJ, a nie tylko w `set_generating`, bo to jedyne wspólne wąskie
        // gardło dostarczania: `SubTaskNotifier._onFinished` woła dostawcę WPROST na
        // `task:finished`, a `_switchTab` drenuje w kroku 11.
        // Fail-soft na całej linii: KAŻDA odmowa zwraca `false`, więc wynik nie ginie — zostaje
        // w kolejce notifiera do najbliższego `drain()` po następnej turze usera.
        const delivery = evaluateSubTaskDelivery({
            tab,
            isGenerating: this.is_generating,
            subTaskTurnPending: this._subTaskTurnPending,
            drainSuppressed: this._drainSuppressed,
            chainAllowed: chain.allowed,
        });
        if (!delivery.allowed) {
            if (delivery.reason === 'chain_limit') {
                log.warn('Chat', `[${tab.agentName}] limit łańcucha auto-tur po subach (${limits.max_consecutive_auto_turns}) osiągnięty — wynik ${task.id} zostaje w kolejce do tury usera`);
                // Cisza wobec usera byłaby myląca — z jego perspektywy rozmowa po prostu przestała
                // reagować. Zdarzenie z definicji rzadkie (trzeba max_consecutive_auto_turns auto-tur
                // z rzędu), więc jeden Notice na zaparkowanie nie spamuje (aktywność zakładki jest
                // wcześniejszą bramką — user naprawdę na to patrzy).
                new Notice(t('chat.streaming.auto_turn_chain_limit'), 8000);
            }
            return false;
        }
        if (!this._autoTurnChainCounts) this._autoTurnChainCounts = new Map();
        this._autoTurnChainCounts.set(tab.agentName, chain.nextCount);

        const text = buildSubTaskNotificationText(task, {
            // Runda 2 (2026-08-17): wynik suba ma WŁASNY sufit (60k default, 0 = bez limitu) —
            // wspólne 15k z surowymi zrzutami narzędzi ucinało deep-research w połowie.
            maxResultChars: limits.subagent_result_max_chars,
        });

        // Bezpiecznik ustawiany SYNCHRONICZNIE: `drain()` woła dostawcę w pętli, a `send_message`
        // dochodzi do `set_generating(true)` dopiero po kilku awaitach — bez tej flagi drugi
        // czekający wynik wystartowałby RÓWNOLEGŁĄ turę na tej samej zakładce.
        this._subTaskTurnPending = true;
        log.info('Chat', `[${tab.agentName}] wynik suba z tła → auto-tura (${task.id}, ${task.status})`);
        void Promise.resolve()
            // K7: wynik suba to tekst MASZYNY — żadnych przywilejów człowieka (rejestr adresów,
            // markery `@@skill:`, komendy `/`).
            .then(() => this.send_message({ injectedText: text, meta: machineMeta({ _subTaskNotification: true, subTaskId: task.id }) }))
            .catch((e: ChatViewMixinContext) => log.warn('Chat', `Auto-tura po subie padła: ${e?.message || e}`))
            .finally(() => { this._subTaskTurnPending = false; });
        return true;
    } catch (e: ChatViewMixinContext) {
        log.warn('Chat', `Dostarczenie wyniku suba padło (zostaje w kolejce): ${e?.message || e}`);
        return false;
    }
}

export function set_generating(this: ChatViewMixinContext, is_generating: boolean) {
    this.is_generating = is_generating;

    if (is_generating) {
        // Nowa tura ruszyła — bezpiecznik „po Stopie nie drenujemy" wygasa (dawniej gasiło go
        // zerowanie `_abortedStream` w `send_message`, które przy okazji gasiło przerwanie
        // wciąż biegnącej tury — patrz K5).
        this._drainSuppressed = false;
        this.send_button.addClass('hidden');
        this.stop_button.removeClass('hidden');
        // Input stays ENABLED — user can queue a message while agent works
        this.input_area.placeholder = t('chat.streaming.write_while_generating');
    } else {
        this.send_button.removeClass('hidden');
        this.stop_button.addClass('hidden');
        this.input_area.placeholder = '';
        this.input_area.focus();
        this._hideQueuedIndicator();

        // ── PROCESS QUEUED MESSAGE after generation completes ──
        // AUD-bledy-015: slot opróżniamy DOPIERO w timerze, po sprawdzeniu warunków. Do tej
        // zmiany leciało tu `this._queuedMessage = null` i goły `setTimeout` — timer bez
        // właściciela, którego nikt nie umiał anulować, a wiadomość była już „w powietrzu".
        if (readQueuedMessage(this._queuedMessage)) {
            this._clearQueuedDrainTimer();
            // Use setTimeout to let current stack unwind before sending
            this._queuedDrainTimer = window.setTimeout(() => {
                this._queuedDrainTimer = null;
                // AUD-testy-024: trzy pytania drenu liczy czysta `evaluateQueuedDrain`
                // (`queuedMessage.ts`), tutaj zostaje wykonanie werdyktu.
                //  - `empty`: Stop / zamknięcie widoku zdążyły anulować (AUD-bledy-055);
                //  - `wait_owner` (AUD-bledy-015): `set_generating(false)` woła też `_switchTab`
                //    (krok 5) przy każdym przejściu na niegenerującą zakładkę. Bez tego pytania
                //    wybudzony timer wklejał tekst pisany do Jaskra w pole Borysa i startował
                //    turę JEGO modelem, promptem, pamięcią i uprawnieniami narzędzi
                //    (`freezeTurnOwner` zamrażał już cudzego właściciela). Wiadomość zostaje
                //    w slocie i czeka na swoją zakładkę;
                //  - `wait_generating`: w oknie 100 ms user mógł wysłać własną wiadomość.
                const drain = evaluateQueuedDrain(this._queuedMessage, this._queueOwner(), { isGenerating: this.is_generating });
                const queued = drain.queued;
                if (drain.action === 'empty' || !queued) return;
                if (drain.action !== 'send') {
                    this._showQueuedIndicator(queued.text);
                    if (drain.action === 'wait_owner') {
                        log.info('Chat', `Kolejka czeka na swoją zakładkę (${queued.owner?.agentName || '?'}) — dren wstrzymany`);
                    }
                    return;
                }

                this._queuedMessage = null;
                log.info('Chat', `Wysyłam zakolejkowaną wiadomość (${queued.meta.origin}): "${queued.text.slice(0, 60)}..."`);
                // Z3 (FAIL 6, 2026-08-15): pole mogło NIE być puste — user zakolejkował
                // wiadomość, a potem zaczął pisać kolejną. Podmiana na `queued` kasowała mu
                // ten szkic bez śladu. Odkładamy go i oddajemy w `send_message` zaraz po
                // `resetInputArea()` (tam, gdzie pole jest czyszczone — czyli PO awaitach
                // send_message, więc restore „od ręki" tutaj i tak by nie przetrwał).
                const draft = this.input_area.value;
                if (draft.trim() && draft.trim() !== queued.text.trim()) this._draftAfterSend = draft;
                this.input_area.value = queued.text;
                this.handleInputResize();
                // K19 (AUD-security-117/131): oddajemy pieczątkę, z którą wiadomość weszła do
                // kolejki. Stało tu twarde `HUMAN_MESSAGE_META` — a slot zajmuje też tekst
                // maszynowy (guzik artefaktu wypełnia pole wpisywania z kodu), więc treść
                // artefaktu wracała z przywilejami człowieka i cofała K7.
                this.send_message({ meta: queued.meta });
            }, 100);
        } else if (!this._drainSuppressed) {
            // F2: wiadomość USERA ma pierwszeństwo — po wyniki subów z tła sięgamy dopiero,
            // gdy nikt nie czeka w kolejce. `setTimeout` tym samym wzorem co wyżej: pozwala
            // rozwinąć się stosowi bieżącej tury (drain woła send_message re-entrantnie).
            //
            // ⚠️ NIE po przerwaniu (`_drainSuppressed`): ręczny Stop i watchdog też przechodzą
            // tędy, a „nacisnąłem Stop i po 100 ms samo zaczęło gadać" byłoby złamaniem
            // obietnicy tego guzika (przy watchdogu doszłaby jeszcze tura w martwy serwer).
            // Wynik NIE ginie — czeka w kolejce do końca następnej tury albo do przełączenia
            // zakładki; flagę czyści pierwsza wiadomość usera.
            window.setTimeout(() => this._drainSubTasks(), 100);
        }
    }
}

/**
 * Show visual indicator that a message is queued
 */
export function _showQueuedIndicator(this: ChatViewMixinContext, text: string) {
    this._hideQueuedIndicator();
    const indicator = createDiv();
    indicator.className = 'cs-queued-indicator';
    // The i18n value is plain text with a {{text}} placeholder — the user's message
    // must land in a text node, never in markup.
    const preview = text.length > 50 ? text.slice(0, 50) + '...' : text;
    indicator.createSpan({ cls: 'cs-queued-indicator__icon', text: '⏳' });
    indicator.appendText(' ');
    indicator.createSpan({
        cls: 'cs-queued-indicator__text',
        text: t('chat.streaming.queued_indicator', { text: preview }),
    });
    // Insert after input area
    this.input_area.parentElement?.appendChild(indicator);
    this._queuedIndicatorEl = indicator;
}

export function _hideQueuedIndicator(this: ChatViewMixinContext) {
    if (this._queuedIndicatorEl) {
        this._queuedIndicatorEl.remove();
        this._queuedIndicatorEl = null;
    }
}
