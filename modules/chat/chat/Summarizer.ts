/**
 * Progressive Summarizer — kompresuje rozmowę w trakcie sesji.
 *
 * Produkuje STRUKTURALNE podsumowanie (jak Claude Code compaction):
 * - Sekcje: Cel, Przebieg, Wiadomości usera, Pliki/narzędzia, Problemy, Ustalenia, Stan pracy, Otwarte wątki
 * - Progressive: nowe streszczenie buduje na poprzednim (nie nadpisuje)
 * - Po polsku, maks ~800 słów
 */
import { streamToComplete } from '../../memory/index.js';
import { t } from '../../../core/i18n/index.js';
import { DEFAULT_COMPRESSION_PROMPT } from './compressionPrompt.js';
import { log } from '../../../core/utils/Logger.js';

// TS-any: adapter modelu i bloków narzędziowych mają rozszerzalny payload runtime.
type RuntimePayload = any;
type ContentBlock = { type?: string; text?: string; [key: string]: RuntimePayload };
type ChatMessage = { role: string; content?: string | ContentBlock[]; tool_calls?: RuntimePayload[]; tool_call_id?: string };
type SummarizerOptions = { triggerThreshold?: number; chatModel?: RuntimePayload; compressionPrompt?: string };
type SummaryOptions = { isEmergency?: boolean; activeTaskContext?: string; sessionPath?: string; memoryIndex?: string };

export class Summarizer {
    declare triggerThreshold: number;
    declare chatModel: RuntimePayload;
    declare compressionPrompt: string;
    /**
     * @param {Object} options
     * @param {number} options.triggerThreshold - % limitu (0.9 = 90%)
     * @param {Object} options.chatModel - ChatModel instance
     * @param {string} [options.compressionPrompt] - E2.8 B3: resolved compression skeleton
     *   (agent>global>factory). Defaults to the factory skeleton. chat_session resolves it
     *   (Summarizer doesn't know the active agent).
     */
    constructor(options: SummarizerOptions = {}) {
        this.triggerThreshold = options.triggerThreshold || 0.9;
        this.chatModel = options.chatModel;
        this.compressionPrompt = options.compressionPrompt || DEFAULT_COMPRESSION_PROMPT;
    }

    /**
     * Generuje progressive summary: łączy stare streszczenie z nowymi wiadomościami.
     * @param {Array} messages - [{role, content, tool_calls?, tool_call_id?}...]
     * @param {string} previousSummary - Dotychczasowe streszczenie (puste przy pierwszej sumaryzacji)
     * @param {Object} options - Opcje: { isEmergency, activeTaskContext }
     * @returns {Promise<string|null>} Nowe streszczenie lub null przy błędzie
     */
    async summarize(messages: ChatMessage[], previousSummary = '', options: SummaryOptions = {}) {
        if (!this.chatModel) {
            log.warn('Summarizer', 'No chat model provided.');
            return null;
        }

        try {
            const summaryPrompt = this.getSummaryPrompt(messages, previousSummary, options);
            const apiMessages = [
                { role: 'user', content: summaryPrompt }
            ];

            const mode = options.isEmergency ? 'EMERGENCY structured' : 'structured';
            log.debug('Summarizer', `Generating ${mode} summary from`, messages.length, 'messages...');
            const response = await streamToComplete(this.chatModel, apiMessages);
            const text = response.text || null;
            if (text) {
                log.debug('Summarizer', 'Summary generated:', text.length, 'chars');
            }
            return text;
        } catch (error) {
            log.error('Summarizer', 'Error generating summary:', error);
            return null;
        }
    }

    /**
     * Wyciąga tekst z wiadomości (obsługa string / Array multimodal).
     * @param {Object} msg - Message object {role, content, tool_calls?...}
     * @returns {string}
     */
    _extractContent(msg: ChatMessage) {
        if (!msg.content) return '';
        if (typeof msg.content === 'string') return msg.content;
        if (Array.isArray(msg.content)) {
            return msg.content
                .filter((b: ContentBlock) => b.type === 'text')
                .map((b: ContentBlock) => b.text)
                .join('\n');
        }
        return String(msg.content || '');
    }

    /**
     * Wyciąga nazwy narzędzi użytych w rozmowie (z tool_calls).
     * @param {Array} messages
     * @returns {string[]} Unikalne nazwy tooli
     */
    _extractToolNames(messages: ChatMessage[]) {
        const tools = new Set();
        for (const msg of messages) {
            if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    if (tc.function?.name) tools.add(tc.function.name);
                }
            }
        }
        return [...tools];
    }

    /**
     * Wyciąga wiadomości usera (do zachowania w podsumowaniu).
     * @param {Array} messages
     * @returns {string[]} Treści wiadomości usera
     */
    _extractUserMessages(messages: ChatMessage[]) {
        return messages
            .filter((m: ChatMessage) => m.role === 'user' && !m.tool_call_id)
            .map((m: ChatMessage) => {
                const text = this._extractContent(m);
                // Skracaj bardzo długie wiadomości (np. wklejony kod) ale zachowaj sens
                if (text.length > 300) {
                    return text.slice(0, 300) + '...';
                }
                return text;
            })
            .filter((t: string) => t.length > 0);
    }

    /**
     * Buduje prompt do progressive summarization.
     * Produkuje STRUKTURALNE podsumowanie z sekcjami — jak Claude Code compaction.
     * W trybie emergency: dodaje sekcję "ZADANIE W TOKU" z aktywnym todo/planem.
     * @param {Array} messages
     * @param {string} previousSummary
     * @param {Object} options - { isEmergency, activeTaskContext }
     */
    getSummaryPrompt(messages: ChatMessage[], previousSummary = '', options: SummaryOptions = {}) {
        const { isEmergency = false, activeTaskContext = '', sessionPath = '', memoryIndex = '' } = options;

        // Buduj tekst rozmowy
        const conversationText = messages
            .filter((m: ChatMessage) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
            .map((m: ChatMessage) => {
                let content = this._extractContent(m);

                // Skracaj bardzo długie wyniki tooli (zachowaj esencję)
                if (m.role === 'tool' && content.length > 800) {
                    content = content.slice(0, 800) + t('summarizer.truncated');
                }

                // Oznacz tool_calls w assistant messages
                let toolCallInfo = '';
                if (m.tool_calls) {
                    const names = m.tool_calls.map((tc: RuntimePayload) => tc.function?.name).filter(Boolean);
                    if (names.length > 0) {
                        toolCallInfo = t('summarizer.called', { names: names.join(', ') });
                    }
                }

                const label = m.role === 'tool' ? 'TOOL_RESULT' : m.role.toUpperCase();
                return `${label}${toolCallInfo}: ${content}`;
            })
            .join('\n\n');

        // Wyciągnij wiadomości usera osobno
        const userMessages = this._extractUserMessages(messages);
        const userMessagesSection = userMessages.length > 0
            ? `\nWIADOMOŚCI USERA (zachowaj ich treść — ważne dla kontynuacji):\n${userMessages.map((m, i) => `${i + 1}. "${m}"`).join('\n')}\n`
            : '';

        // Wyciągnij użyte narzędzia
        const toolNames = this._extractToolNames(messages);
        const toolsSection = toolNames.length > 0
            ? `\nUŻYTE NARZĘDZIA: ${toolNames.join(', ')}\n`
            : '';

        const previousSection = previousSummary
            ? `\nPOPRZEDNIE PODSUMOWANIE (buduj na nim — rozszerzaj, nie zastępuj):\n---\n${previousSummary}\n---\n`
            : '';

        // E2.7 W2 (K3): dedup context for MEMORY_CANDIDATES — pass only the brain.md index
        // (pointers), never full note bodies, to keep the token budget tight.
        const memoryIndexSection = memoryIndex
            ? `\nAKTUALNA PAMIĘĆ DŁUGOTERMINOWA (indeks brain.md — NIE proponuj kandydatów, które już tu są):\n---\n${memoryIndex}\n---\n`
            : '';

        // Emergency: kontekst aktywnego zadania (todos, plany)
        const taskContextSection = (isEmergency && activeTaskContext)
            ? `\n⚠️ AKTYWNE ZADANIE W MOMENCIE KOMPRESJI (KRYTYCZNE — agent MUSI to kontynuować):\n---\n${activeTaskContext}\n---\n`
            : '';

        // Emergency: dodatkowa sekcja w formacie
        const emergencySection = isEmergency
            ? `\n## 9. ⚠️ ZADANIE W TOKU (KRYTYCZNE)
Co DOKŁADNIE agent robił w momencie kompresji? Jaki był następny krok? Jakie narzędzia miał zamiar wywołać?
Agent MUSI wiedzieć od czego zacząć po wznowieniu — opisz to tak szczegółowo jak to możliwe. Uwzględnij aktywne TODO/PLAN jeśli są.\n`
            : '';

        const emergencyWarning = isEmergency
            ? `\n⚠️ TO JEST AWARYJNA KOMPRESJA — agent był W TRAKCIE ZADANIA. Sekcja "Zadanie w toku" jest NAJWAŻNIEJSZA. Agent po wznowieniu musi wiedzieć DOKŁADNIE co robić dalej.\n`
            : '';

        const sessionPathSuffix = sessionPath
            ? `\n\n📂 Pełna rozmowa zapisana w: ${sessionPath} — agent może ją przeczytać żeby zweryfikować szczegóły.`
            : '';

        // E2.8 B3: the fixed skeleton (intro + sekcje 1-8 + ZASADY + blok MEMORY_CANDIDATES) lives in
        // compressionPrompt.js and is overridable (agent>global>factory, resolved by chat_session).
        // The dynamic pieces below are still composed here and injected into the placeholders.
        // Function replacers avoid `$`-sequence interpretation from user-provided content.
        const dynamicHeader = `${emergencyWarning}${previousSection}${memoryIndexSection}${userMessagesSection}${toolsSection}${taskContextSection}`;
        const skeleton = this.compressionPrompt || DEFAULT_COMPRESSION_PROMPT;
        return skeleton
            .replace('{{DYNAMIC_HEADER}}', () => dynamicHeader)
            .replace('{{CONVERSATION}}', () => conversationText)
            .replace('{{EMERGENCY_SECTION}}', () => emergencySection)
            .replace('{{SESSION_PATH}}', () => sessionPathSuffix);
    }
}
