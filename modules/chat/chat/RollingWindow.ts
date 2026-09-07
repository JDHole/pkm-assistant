import { fenceUntrusted, countTokensFromStats, countNonAsciiChars } from '../../../core/index.js';
import { Summarizer } from './Summarizer.js';
import { t } from '../../../core/i18n/index.js';
// S30 Z4: prosto z DOMU sanitizera (modules/agent-loop). Dawniej szło przez re-eksport
// w barrelu memory — pass-through bez wartości, skasowany razem z tą zmianą.
import { sanitizeToolTranscript } from '../../agent-loop/index.js';
import { parseMemoryCandidates } from './memoryCandidates.js';
import { log } from '../../../core/utils/Logger.js';
import type { LoopMessage } from '../../agent-loop/index.js';
import type { MemoryCandidate } from './memoryCandidates.js';

// TS-any: bloki multimodalne, tool_calls, cache i model są payloadami różnych providerów API.
type Runtime = any;

// AUD-code-review-071 (F04, poprawka po blokadzie mergem): SUFIT na wycenę obrazu w oknie
// kontekstu — realny koszt wizji u providerów to ~85-1600 tokenów/obraz, nie proporcja do
// długości base64. Pełna długość (v1 tej naprawy) wysadzała `maxTokens` produkcyjny (100k)
// w JEDNYM `addMessage` dla obrazu 1,5 MB → hard limit → `_trimToolResultsAggressive` →
// `performSummarization(true)` (sztuczny strzał LLM) → `_trimOldestMessages` wycina obraz
// i całą rozmowę, zanim model je zobaczy. `_contentSize` (character-based, do decyzji "czy
// trimować stary wynik") ZOSTAJE bez zmian — to osobna oś od wyceny tokenów.
const IMAGE_TOKEN_CEILING = 1600;
function estimateImageTokens(url: string): number {
    return Math.min(Math.ceil(url.length / 4 / 1.2), IMAGE_TOKEN_CEILING);
}

/**
 * AUD-wydajnosc-017/048/049: STATYSTYKI TEKSTU zamiast samego tekstu.
 *
 * Estymator (`core/utils/tokenCounter.ts`) potrzebuje z materiału dokładnie dwóch liczb:
 * długości i liczby znaków spoza ASCII. Obie są ADDYTYWNE po konkatenacji, więc okno kontekstu
 * może je trzymać per wiadomość i sumować, zamiast sklejać całą historię w jeden string
 * i skanować go od nowa przy KAŻDYM dopisku (`addMessage` robi to po każdym wyniku narzędzia!)
 * i przy KAŻDYM obrocie pętli awaryjnego przycinania (mierzone 590 ms przy 800 wiadomościach).
 * Wynik jest identyczny co do tokena — patrz `countTokensFromStats`.
 */
interface TextStats {
    chars: number;
    nonAscii: number;
}

/** Statystyki JEDNEJ wiadomości + odciski palca materiału, z którego powstały. */
interface MessageStats extends TextStats {
    imageTokens: number;
    /** Odciski: gdy któryś się zmieni, statystyki tej wiadomości liczymy od nowa. */
    contentRef: unknown;
    contentLen: number;
    toolCallsRef: unknown;
    toolCallsLen: number;
    reasoningRef: unknown;
}

interface ToolCall {
    id?: string;
    function?: { name?: string; arguments?: string };
}

interface RollingMessage extends LoopMessage {
    tool_call_id?: string;
    content?: string | null | Runtime[];
    tool_calls?: ToolCall[];
    reasoning_content?: string;
    cache?: Runtime;
}

interface SummarizerLike {
    triggerThreshold: number;
    summarize(messages: RollingMessage[], previousSummary: string, options: Runtime): Promise<string | null>;
}

interface TrimDetail { toolName: string; originalSize: number }
interface TrimInfo {
    trimmed: number;
    details: TrimDetail[];
    savedChars: number;
    tokensBefore: number;
    tokensAfterTrim: number;
    totalTrimmed: number;
}
interface ContextTokenSources {
    system_tools?: number;
    systemTools?: number;
    mcp_tools_active?: number;
    mcpToolsActive?: number;
}
interface RollingWindowOptions {
    maxTokens?: number;
    systemPrompt?: string;
    summarizer?: SummarizerLike | null;
    modelProvider?: (() => Runtime) | null;
    compressionPrompt?: string | null;
    triggerThreshold?: number;
    toolTrimThreshold?: number;
    onSummarized?: ((summary: string, count: number, messagesKept: number, isEmergency: boolean) => void) | null;
    onToolsTrimmed?: ((info: TrimInfo) => void) | null;
    emergencyContextProvider?: (() => string) | null;
    onMemoryCandidates?: ((candidates: MemoryCandidate[]) => unknown) | null;
    memoryIndexProvider?: (() => Promise<string>) | null;
}

/**
 * Rolling Window — zarządza historią rozmowy z limitem tokenów.
 *
 * DWUFAZOWA KOMPRESJA (jak Claude Code):
 * Faza 1: Skróć stare wyniki narzędzi — DARMOWE, bez API call.
 * Faza 2: Pełna sumaryzacja — DROGIE, API call. Tylko gdy Faza 1 nie wystarczyła.
 *
 * TRZY PROGI:
 * 1. toolTrimThreshold (0.7) — Faza 1: skróć tool results
 * 2. triggerThreshold (0.9) — Faza 2: pełna sumaryzacja
 * 3. HARD (100%) — awaryjna, w addMessage() gdy kontekst pełny
 *
 * LICZENIE TOKENÓW:
 * getCurrentTokenCount() liczy: system prompt + wiadomości + tool_calls + reasoning_content
 * + definicje narzędzi (tools schema) — cache'owane przez setToolDefinitionsTokens().
 * To jest osobny system od TokenTracker (który liczy in/out API usage).
 */
export class RollingWindow {
    declare maxTokens: number;
    declare baseSystemPrompt: string;
    declare conversationSummary: string;
    declare summarizer: SummarizerLike | null;
    declare _modelProvider: (() => Runtime) | null;
    declare _compressionPrompt: string | null;
    declare _triggerThreshold: number;
    declare _toolTrimThreshold: number;
    declare messages: RollingMessage[];
    declare _summarizationCount: number;
    declare _toolTrimCount: number;
    declare _toolDefinitionsTokens: number;
    declare _contextTokenSources: Required<Pick<ContextTokenSources, 'system_tools' | 'mcp_tools_active'>>;
    declare _lastSummarizationWasEmergency: boolean;
    declare onSummarized: RollingWindowOptions['onSummarized'];
    declare onToolsTrimmed: RollingWindowOptions['onToolsTrimmed'];
    declare emergencyContextProvider: RollingWindowOptions['emergencyContextProvider'];
    declare onMemoryCandidates: RollingWindowOptions['onMemoryCandidates'];
    declare memoryIndexProvider: RollingWindowOptions['memoryIndexProvider'];
    declare sessionPath: string;
    /** AUD-wydajnosc-017: statystyki per wiadomość (klucz = obiekt wiadomości). */
    declare _msgStatsCache: WeakMap<object, MessageStats>;
    /** AUD-wydajnosc-017: statystyki promptu systemowego + odciski, z których powstały. */
    declare _promptStatsCache: (TextStats & { base: string; summary: string; emergency: boolean }) | null;
    /** Diagnostyka/testy: ile ZNAKÓW faktycznie przeskanowano od startu okna (dowód przyrostowości). */
    declare _statsScannedChars: number;
    /**
     * @param {Object} options
     * @param {number} options.maxTokens - Limit tokenów (default: 100000)
     * @param {string} options.systemPrompt - Opcjonalny prompt systemowy
     * @param {Object} options.summarizer - Opcjonalna instancja Summarizer (eager)
     * @param {Function} options.modelProvider - () => chatModel — lazy provider (gdy summarizer nie podany)
     * @param {number} options.triggerThreshold - Próg sumaryzacji Faza 2 (0.9 = 90%)
     * @param {number} options.toolTrimThreshold - Próg trimowania tool results Faza 1 (0.7 = 70%)
     * @param {Function} options.onSummarized - Callback(summary, count, messagesKept, isEmergency)
     * @param {Function} options.onToolsTrimmed - Callback(trimmedCount, totalTrimmed) — po Fazie 1
     * @param {Function} options.emergencyContextProvider - () => string — zwraca kontekst aktywnego taska (todos, plan)
     */
    constructor(options: RollingWindowOptions = {}) {
        this.maxTokens = options.maxTokens || 100000;
        this.baseSystemPrompt = options.systemPrompt || '';
        this.conversationSummary = '';
        this.summarizer = options.summarizer || null;
        this._modelProvider = options.modelProvider || null;
        // E2.8 B3: resolved compression skeleton (agent>global>factory) — passed to the lazily-created
        // Summarizer. null → Summarizer uses its factory default.
        this._compressionPrompt = options.compressionPrompt || null;
        this._triggerThreshold = options.triggerThreshold || 0.9;
        this._toolTrimThreshold = options.toolTrimThreshold || 0.7;
        this.messages = [];
        this._summarizationCount = 0;
        this._toolTrimCount = 0;
        this._toolDefinitionsTokens = 0;
        // L07-6: tylko realnie zasilane źródła. memory_files/skills siedzą w system_prompt
        // (nie osobno), a *_deferred nigdy nie były zasilane — usunięte (nie kłam wierszem 0).
        this._contextTokenSources = {
            system_tools: 0,
            mcp_tools_active: 0,
        };
        this._lastSummarizationWasEmergency = false;
        this.onSummarized = options.onSummarized || null;
        this.onToolsTrimmed = options.onToolsTrimmed || null;
        this.emergencyContextProvider = options.emergencyContextProvider || null;
        // E2.7 W2 (K3): rescue durable facts before compaction. Both injected from chat_session so
        // RollingWindow never reaches into modules/memory to WRITE — the callback does the save.
        this.onMemoryCandidates = options.onMemoryCandidates || null;   // (candidates) => Promise
        this.memoryIndexProvider = options.memoryIndexProvider || null; // () => Promise<string> brain.md index
        this.sessionPath = ''; // Ustawiane przez chat_view — ścieżka do zapisanej sesji
        // AUD-wydajnosc-017/048: pamięć statystyk (patrz `TextStats` na górze pliku).
        this._msgStatsCache = new WeakMap();
        this._promptStatsCache = null;
        this._statsScannedChars = 0;
    }

    // ─── STATYSTYKI TEKSTU (baza licznika tokenów, AUD-wydajnosc-017/048/049) ───

    /** Dolicza tekst do akumulatora statystyk. JEDYNE miejsce, które skanuje znaki. */
    _addTextStats(acc: TextStats, text: string): void {
        if (!text) return;
        acc.chars += text.length;
        acc.nonAscii += countNonAsciiChars(text);
        this._statsScannedChars += text.length;
    }

    /**
     * Statystyki JEDNEJ wiadomości — z pamięci, gdy materiał się nie zmienił.
     *
     * Ważność sprawdzamy po TOŻSAMOŚCI pól (`content`, `tool_calls`, `reasoning_content`) plus
     * długości tablic: `content` bywa mutowany W MIEJSCU (Oczko dokłada blok obrazu do ostatniej
     * wiadomości usera przez `push`), a wtedy referencja zostaje ta sama, ale długość rośnie.
     * Podmiana treści (trim wyników narzędzi) daje nową referencję i też unieważnia wpis.
     */
    _messageStats(msg: RollingMessage): MessageStats {
        const contentLen = Array.isArray(msg.content) ? msg.content.length : -1;
        const toolCallsLen = Array.isArray(msg.tool_calls) ? msg.tool_calls.length : -1;
        const cached = this._msgStatsCache.get(msg);
        if (cached
            && cached.contentRef === msg.content
            && cached.contentLen === contentLen
            && cached.toolCallsRef === msg.tool_calls
            && cached.toolCallsLen === toolCallsLen
            && cached.reasoningRef === msg.reasoning_content) {
            return cached;
        }

        const stats: MessageStats = {
            chars: 0,
            nonAscii: 0,
            imageTokens: this._contentImageTokens(msg.content),
            contentRef: msg.content,
            contentLen,
            toolCallsRef: msg.tool_calls,
            toolCallsLen,
            reasoningRef: msg.reasoning_content,
        };
        this._addTextStats(stats, this._contentToTokenText(msg.content));
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                if (tc.function?.arguments) this._addTextStats(stats, tc.function.arguments);
                if (tc.function?.name) this._addTextStats(stats, tc.function.name);
            }
        }
        if (msg.reasoning_content) this._addTextStats(stats, msg.reasoning_content);
        this._msgStatsCache.set(msg, stats);
        return stats;
    }

    /**
     * Statystyki promptu systemowego — z pamięci, dopóki nie zmienił się ani prompt bazowy,
     * ani streszczenie, ani tryb (te trzy składają `get systemPrompt`).
     * ⚠️ Zmiana JĘZYKA w trakcie sesji nie unieważnia wpisu (nagłówek `t()` to kilka tokenów) —
     * sam PROMPT liczy się dalej na żywo w getterze, więc do modelu idzie zawsze aktualny.
     */
    _promptStats(): TextStats {
        const cached = this._promptStatsCache;
        if (cached
            && cached.base === this.baseSystemPrompt
            && cached.summary === this.conversationSummary
            && cached.emergency === this._lastSummarizationWasEmergency) {
            return cached;
        }
        const stats: TextStats = { chars: 0, nonAscii: 0 };
        this._addTextStats(stats, this.systemPrompt || '');
        this._promptStatsCache = {
            ...stats,
            base: this.baseSystemPrompt,
            summary: this.conversationSummary,
            emergency: this._lastSummarizationWasEmergency,
        };
        return this._promptStatsCache;
    }

    /**
     * Pełny system prompt = base + summary.
     * Po awaryjnej sumaryzacji: specjalny nagłówek mówiący agentowi żeby kontynuował.
     *
     * M (AUD-security-118): podsumowanie idzie przez `fenceUntrusted` — to CZWARTY kanał
     * niezaufanej treści w prompcie systemowym, którego K9 nie objął. `Summarizer` streszcza
     * CAŁĄ rozmowę razem z wiadomościami `role:'tool'` (wyniki `read`/`web_read`), a wynik stoi
     * potem w `role:'system'` do końca sesji i wraca na wejście kolejnych sumaryzacji. Nagłówek
     * (`header`) zostaje NA ZEWNĄTRZ ogrodzenia jako etykieta sekcji — dokładnie jak
     * „## Długoterminowa pamięć" przy pamięci (`PromptBuilder.addDynamicSection`).
     * @returns {string}
     */
    get systemPrompt() {
        if (!this.conversationSummary) return this.baseSystemPrompt;

        const header = this._lastSummarizationWasEmergency
            ? t('memory.emergency_context_header')
            : t('memory.soft_summary_header');

        const fenced = fenceUntrusted(this.conversationSummary, 'conversation_summary');
        if (!fenced) return this.baseSystemPrompt;

        return `${this.baseSystemPrompt}\n\n---\n${header}\n${fenced}`;
    }

    /**
     * Dodaje wiadomość. Sprawdza hard limit (100% maxTokens).
     * Przy hard limit: najpierw Faza 1 (aggressive trim), potem Faza 2 (summarize).
     *
     * Invariant: tool message MUSI mieć tool_call_id dopasowany do tool_calls[]
     * w poprzedzającej assistant message (smoke-02 finding 04). Naruszenie =
     * warning, ale wiadomość zostaje dodana — sanitizeForAPI() i tak ją odfiltruje.
     */
    async addMessage(role: LoopMessage['role'], content: RollingMessage['content'], metadata: Partial<RollingMessage> = {}): Promise<void> {
        if (role === 'tool') {
            const toolCallId = metadata?.tool_call_id;
            if (!toolCallId) {
                log.warn('RollingWindow', 'INVARIANT: tool message without tool_call_id — orphan');
            } else if (!this._findParentToolCall(toolCallId)) {
                log.warn('RollingWindow', `INVARIANT: tool message tool_call_id="${toolCallId}" has no matching parent assistant tool_calls[] — orphan`);
            }
        }

        this.messages.push({ role, content, ...metadata });

        // HARD LIMIT — dwufazowa kompresja awaryjna
        try {
            const currentTokens = this.getCurrentTokenCount();
            if (currentTokens > this.maxTokens) {
                log.warn('RollingWindow', `HARD LIMIT: ${currentTokens} > ${this.maxTokens}`);

                // Faza 1: agresywne skracanie tool results (darmowe)
                this._trimToolResultsAggressive(4);

                // Sprawdź czy Faza 1 wystarczyła
                if (this.getCurrentTokenCount() > this.maxTokens) {
                    // Faza 2: pełna sumaryzacja
                    if (this._ensureSummarizer()) {
                        await this.performSummarization(true); // isEmergency = true
                    }
                }

                // Force-trim jeśli NADAL za dużo (np. summarizer zwrócił null)
                if (this.getCurrentTokenCount() > this.maxTokens) {
                    this._trimOldestMessages();
                }
            }
        } catch (e) {
            log.warn('RollingWindow', 'Hard limit check failed:', e);
        }
    }

    /**
     * Lazy init: tworzy Summarizer gdy model jest dostępny.
     * Przy init ChatView model może jeszcze nie być załadowany — dlatego lazy.
     * @returns {boolean} true jeśli summarizer jest gotowy
     */
    _ensureSummarizer(): boolean {
        if (this.summarizer) return true;
        if (!this._modelProvider) return false;
        try {
            const chatModel = this._modelProvider();
            if (chatModel?.stream) {
                this.summarizer = new Summarizer({ chatModel, triggerThreshold: this._triggerThreshold, compressionPrompt: this._compressionPrompt as string }) as unknown as SummarizerLike;
                log.debug('RollingWindow', 'Summarizer lazy-init OK');
                return true;
            }
        } catch {
            // Model not ready yet — will retry next time
        }
        return false;
    }

    // ─── FAZA 1: Tool Output Trimming (DARMOWE) ───

    /**
     * Skraca stare wyniki narzędzi — DARMOWE, bez wywołania API.
     * Zastępuje content starych wiadomości tool krótkim placeholderem.
     * NIE usuwa wiadomości (OpenAI wymaga tool_call_id match).
     * Zachowuje ostatnie recentKeep wiadomości bez zmian.
     *
     * @param {number} recentKeep - Ile ostatnich wiadomości chronić (default 10)
     * @returns {{count: number, details: Array<{toolName: string, originalSize: number}>, savedChars: number}}
     */
    trimOldToolResults(recentKeep = 10): { count: number; details: TrimDetail[]; savedChars: number } {
        const safeZone = Math.max(0, this.messages.length - recentKeep);
        const details: TrimDetail[] = [];
        let savedChars = 0;

        for (let i = 0; i < safeZone; i++) {
            const msg = this.messages[i];
            if (msg.role !== 'tool' || !msg.content) continue;
            // AUD-code-review-071: rozmiar TREŚCI, nie rozmiar tablicy bloków. `msg.content.length`
            // dla content-array (generate_image + vision: [{text},{image_url}]) to LICZBA BLOKÓW
            // (zawsze 2) — wielomegabajtowy base64 nigdy nie przekraczał progu 200 i był
            // strukturalnie nietrimowalny.
            const originalSize = this._contentSize(msg.content);
            if (originalSize <= 200) continue;

            // Znajdź nazwę narzędzia z powiązanego assistant message
            const toolName = this._findToolNameForResult(i, msg.tool_call_id);

            const preview = this._contentToTokenText(msg.content).slice(0, 150);
            msg.content = t('memory.trimmed_result', { preview, original: originalSize });
            savedChars += originalSize - msg.content.length;
            details.push({ toolName, originalSize });
        }

        if (details.length > 0) {
            this._toolTrimCount += details.length;
            log.debug('RollingWindow', `Faza 1: skrócono ${details.length} starych wyników narzędzi (łącznie w sesji: ${this._toolTrimCount}), zaoszczędzono ~${savedChars} zn.`);
        }

        return { count: details.length, details, savedChars };
    }

    /**
     * Szuka nazwy narzędzia dla danego tool result (po tool_call_id).
     * @param {number} toolMsgIndex - Index wiadomości tool w messages[]
     * @param {string} toolCallId - tool_call_id do dopasowania
     * @returns {string} Nazwa narzędzia lub 'narzędzie'
     */
    _findToolNameForResult(toolMsgIndex: number, toolCallId: string | undefined): string {
        if (!toolCallId) return t('memory.tool_default_name');
        // Szukaj wstecz assistant message z pasującym tool_call
        for (let j = toolMsgIndex - 1; j >= 0; j--) {
            const m = this.messages[j];
            if (m.role === 'assistant' && m.tool_calls) {
                for (const tc of m.tool_calls) {
                    if (tc.id === toolCallId) return tc.function?.name || t('memory.tool_default_name');
                }
            }
        }
        return t('memory.tool_default_name');
    }

    /**
     * Agresywne skracanie — zamienia ALL stare tool results na minimum.
     * Używane w ścieżce HARD gdy zwykłe trimming nie wystarczyło.
     * @param {number} recentKeep
     * @returns {number}
     */
    _trimToolResultsAggressive(recentKeep = 4): number {
        const safeZone = Math.max(0, this.messages.length - recentKeep);
        let trimmed = 0;

        for (let i = 0; i < safeZone; i++) {
            const msg = this.messages[i];
            // AUD-code-review-071: patrz `trimOldToolResults` — `.length` na content-array liczy
            // BLOKI, nie znaki/bajty.
            if (msg.role === 'tool' && msg.content && this._contentSize(msg.content) > 50) {
                msg.content = t('memory.trimmed_aggressive');
                trimmed++;
            }
        }

        if (trimmed > 0) {
            log.debug('RollingWindow', `Faza 1 (aggressive): ${trimmed} wyników zminimalizowanych`);
        }
        return trimmed;
    }

    // ─── OCENA POTRZEBY KOMPRESJI ───

    /**
     * Sprawdza jaki typ kompresji jest potrzebny.
     * @returns {'none'|'trim'|'summarize'}
     * - 'none': poniżej progu trim (70%) — nic nie rób
     * - 'trim': między progami (70-90%) — Faza 1 wystarczy
     * - 'summarize': powyżej progu sumaryzacji (90%) — Faza 1 + Faza 2
     */
    getCompressionNeeded(): 'none' | 'trim' | 'summarize' {
        const currentTokens = this.getCurrentTokenCount();
        const summaryThreshold = this._ensureSummarizer()
            ? this.maxTokens * this.summarizer!.triggerThreshold
            : this.maxTokens * this._triggerThreshold;
        const trimThreshold = this.maxTokens * this._toolTrimThreshold;

        if (currentTokens >= summaryThreshold) return 'summarize';
        if (currentTokens >= trimThreshold) return 'trim';
        return 'none';
    }

    // ─── DWUFAZOWA KOMPRESJA ───

    /**
     * Dwufazowa kompresja kontekstu (jak Claude Code):
     * Faza 1: Skróć stare wyniki narzędzi (DARMOWE — bez API call)
     * Faza 2: Pełna sumaryzacja (DROGIE — API call) — tylko jeśli Faza 1 nie wystarczyła
     *
     * @param {boolean} isEmergency - Czy to awaryjna kompresja (hard limit)
     * @returns {Promise<{phase: number, trimmed: number, summarized: boolean}>}
     */
    async performTwoPhaseCompression(isEmergency = false): Promise<{ phase: number; trimmed: number; trimDetails: TrimDetail[]; savedChars: number; summarized: boolean }> {
        const result: { phase: number; trimmed: number; trimDetails: TrimDetail[]; savedChars: number; summarized: boolean } = { phase: 0, trimmed: 0, trimDetails: [], savedChars: 0, summarized: false };
        const tokensBefore = this.getCurrentTokenCount();

        // === FAZA 1: Trim tool results (darmowe) ===
        const trimResult = this.trimOldToolResults(isEmergency ? 4 : 10);
        result.phase = 1;
        result.trimmed = trimResult.count;
        result.trimDetails = trimResult.details;
        result.savedChars = trimResult.savedChars;

        const tokensAfterTrim = this.getCurrentTokenCount();

        // Notify UI o Fazie 1
        if (trimResult.count > 0 && this.onToolsTrimmed) {
            try {
                this.onToolsTrimmed({
                    trimmed: trimResult.count,
                    details: trimResult.details,
                    savedChars: trimResult.savedChars,
                    tokensBefore,
                    tokensAfterTrim,
                    totalTrimmed: this._toolTrimCount
                });
            } catch (e) {
                log.warn('RollingWindow', 'onToolsTrimmed callback error:', e);
            }
        }

        // Sprawdź czy Faza 1 wystarczyła
        const summaryThreshold = this._ensureSummarizer()
            ? this.maxTokens * this.summarizer!.triggerThreshold
            : this.maxTokens * this._triggerThreshold;

        if (!isEmergency && tokensAfterTrim < summaryThreshold) {
            log.debug('RollingWindow', `Faza 1 wystarczyła: ${tokensAfterTrim} < ${Math.round(summaryThreshold)} (skrócono ${trimResult.count} wyników)`);
            return result;
        }

        // === FAZA 2: Pełna sumaryzacja (drogie) ===
        if (this._ensureSummarizer()) {
            result.phase = 2;
            log.debug('RollingWindow', `Faza 1 nie wystarczyła (${tokensAfterTrim} >= ${Math.round(summaryThreshold)}) — uruchamiam Fazę 2`);
            await this.performSummarization(isEmergency);
            result.summarized = true;
        }

        return result;
    }

    /**
     * Wykonuje progressive summarization (Faza 2).
     * Nowe streszczenie = stare streszczenie + nowe wiadomości.
     * W trybie emergency: zbiera kontekst aktywnego taska (todos, plan) i przekazuje do Summarizera.
     * @param {boolean} isEmergency - Czy to awaryjna sumaryzacja (hard limit)
     */
    async performSummarization(isEmergency = false): Promise<void> {
        try {
            // Zbierz kontekst aktywnego zadania (tylko przy emergency)
            let activeTaskContext = '';
            if (isEmergency && this.emergencyContextProvider) {
                try {
                    activeTaskContext = this.emergencyContextProvider();
                    if (activeTaskContext) {
                        log.debug('RollingWindow', `Emergency context collected: ${activeTaskContext.length} chars`);
                    }
                } catch (e) {
                    log.warn('RollingWindow', 'Emergency context provider failed:', e);
                }
            }

            // E2.7 W2 (K3): brain.md index for dedup (pointers only — tight budget). Provider is
            // injected from chat_session; RollingWindow stays decoupled from modules/memory writes.
            let memoryIndex = '';
            if (this.memoryIndexProvider) {
                try {
                    memoryIndex = await this.memoryIndexProvider();
                } catch (e) {
                    log.warn('RollingWindow', 'memoryIndexProvider failed:', e);
                }
            }

            const rawSummary = await this.summarizer!.summarize(
                this.messages,
                this.conversationSummary,
                { isEmergency, activeTaskContext, sessionPath: this.sessionPath, memoryIndex }
            );

            if (rawSummary) {
                // Split the summary from the optional MEMORY_CANDIDATES block so conversationSummary
                // stays clean; candidates are saved out-of-band (does NOT block compaction).
                const { summary, candidates } = parseMemoryCandidates(rawSummary);
                const recentMessages = this._safeSliceRecent(4);
                this.messages = recentMessages;
                this.conversationSummary = summary;
                this._summarizationCount++;
                this._lastSummarizationWasEmergency = isEmergency;

                const mode = isEmergency ? 'EMERGENCY' : 'soft';
                log.debug('RollingWindow', `Summarization #${this._summarizationCount} (${mode}) done. Summary: ${summary.length} chars. Messages kept: ${recentMessages.length}. Memory candidates: ${candidates.length}`);

                // Notify chat_view to render compression block
                if (this.onSummarized) {
                    try {
                        this.onSummarized(summary, this._summarizationCount, recentMessages.length, isEmergency);
                    } catch (cbErr) {
                        log.warn('RollingWindow', 'onSummarized callback error:', cbErr);
                    }
                }

                // W2: fire-and-forget durable memory save. Compaction already happened above; the
                // save runs through the K1 write queue in chat_session and never blocks the turn.
                if (candidates.length > 0 && this.onMemoryCandidates) {
                    try {
                        Promise.resolve(this.onMemoryCandidates(candidates)).catch(err =>
                            log.warn('RollingWindow', 'onMemoryCandidates rejected:', err));
                    } catch (cbErr) {
                        log.warn('RollingWindow', 'onMemoryCandidates threw:', cbErr);
                    }
                }
            } else {
                log.warn('RollingWindow', 'Summarizer returned null — summarization skipped');
            }
        } catch (e) {
            log.error('RollingWindow', 'Summarization failed:', e);
        }
    }

    // ─── TOKEN COUNTING ───

    /**
     * Returns context usage as percentage (0-100).
     * @returns {number}
     */
    getUsagePercent(): number {
        if (!this.maxTokens) return 0;
        return Math.min(100, Math.round((this.getCurrentTokenCount() / this.maxTokens) * 100));
    }

    /**
     * Ile razy sumaryzacja się odbyła w tej sesji
     * @returns {number}
     */
    get summarizationCount(): number {
        return this._summarizationCount;
    }

    /**
     * Zwraca wiadomości gotowe do wysłania do API.
     * ZAWSZE dodaje systemPrompt jako pierwszą wiadomość (role: 'system').
     * reasoning_content: DeepSeek Reasoner WYMAGA tego pola w assistant messages
     * z tool_calls. Odsyłamy je gdy istnieją na wiadomości.
     * @returns {Array<{role: string, content: string}>}
     */
    getMessagesForAPI(): LoopMessage[] {
        const apiMessages: LoopMessage[] = [];
        const fullPrompt = this.systemPrompt;

        if (fullPrompt) {
            apiMessages.push({ role: 'system', content: fullPrompt });
        }

        const logger = {
            warn: (_tag: string, message: string) => log.warn('RollingWindow', message),
        };
        apiMessages.push(...sanitizeToolTranscript(this.messages, { logger, tag: 'RollingWindow' }).messages);

        return apiMessages;
    }

    /**
     * Szuka assistant message z tool_calls[] zawierającym dane tool_call_id.
     * @param {string} toolCallId
     * @returns {Object|null}
     */
    /**
     * Zwraca slice ostatnich ~keepCount wiadomości, ale NIE rozcina pary
     * assistant(tool_calls) ↔ tool(tool_call_id). Jeśli boundary wypada
     * w środku grupy, cofa się do początku assistant message.
     * Smoke-02 finding 04: slice(-4) potrafił zostawić orphan tool messages
     * po sumaryzacji → 400 z API.
     * @param {number} keepCount
     * @returns {Array}
     * @private
     */
    _safeSliceRecent(keepCount: number): RollingMessage[] {
        if (this.messages.length <= keepCount) return [...this.messages];
        let startIdx = this.messages.length - keepCount;

        // Jeśli zaczynamy od tool message — cofnij do parent assistant
        while (startIdx > 0 && this.messages[startIdx]?.role === 'tool') {
            startIdx--;
        }

        // Jeśli weszliśmy w środek assistant→tool grupy bo poprzednik ma tool_calls
        // — boundary już jest OK po cofnięciu się wyżej. Dodatkowo: jeśli pierwszy
        // zachowany jest assistant z tool_calls, a któryś tool z tej grupy został
        // odcięty (przed startIdx), tool_call IDs są nadal poprawne (parent w środku).
        // sanitizeForAPI odfiltruje ewentualne orphany.
        return this.messages.slice(startIdx);
    }

    _findParentToolCall(toolCallId: string): ToolCall | null {
        if (!toolCallId) return null;
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const m = this.messages[i];
            if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
                for (const tc of m.tool_calls) {
                    if (tc?.id === toolCallId) return tc;
                }
            }
        }
        return null;
    }

    /**
     * Zwraca aktualną liczbę tokenów w oknie kontekstowym.
     * Liczy: system prompt + wiadomości + tool_calls + reasoning_content + definicje narzędzi.
     * UWAGA: To NIE jest TokenTracker (in/out API usage). To jest pomiar kontekstu do kompresji.
     * @returns {number}
     */
    getCurrentTokenCount(): number {
        // AUD-wydajnosc-017/048: sumujemy STATYSTYKI (długość + non-ASCII), nie sklejamy materiału.
        // Wynik jest identyczny co do tokena z dawnym `getTokenCount(cały sklejony tekst)`, bo obie
        // liczby są addytywne po konkatenacji (patrz `countTokensFromStats` w core), ale koszt
        // wywołania spada z „przeskanuj całe okno" do „przeskanuj to, co się zmieniło".
        const prompt = this._promptStats();
        let chars = prompt.chars;
        let nonAscii = prompt.nonAscii;
        let imageTokens = 0;

        for (const msg of this.messages) {
            // AUD-code-review-071: JEDNA funkcja liczy treść wiadomości na tekst — dawniej ten
            // sam placeholder '[image:85tokens]' był tu zduplikowany osobno od `_contentToTokenText`
            // (getBreakdown), więc obraz miał WYCENIONY na sztywno koszt bez względu na realny
            // rozmiar base64 — okno kontekstu nie widziało wielomegabajtowego payloadu i próg
            // kompresji nigdy się od niego nie zapalał. F04: obraz NIE wchodzi do statystyk tekstu
            // (patrz `estimateImageTokens` przy górze pliku) — liczony osobno, z sufitem.
            // Statystyki wiadomości obejmują też `tool_calls` (nazwa + argumenty) i
            // `reasoning_content` — jedno miejsce prawdy, patrz `_messageStats`.
            const stats = this._messageStats(msg);
            chars += stats.chars;
            nonAscii += stats.nonAscii;
            imageTokens += stats.imageTokens;
        }

        const messageTokens = countTokensFromStats(chars, nonAscii) + imageTokens;
        // Dodaj cache'owane tokeny definicji narzędzi (tools schema lecą z każdym requestem)
        return messageTokens + this._toolDefinitionsTokens;
    }

    /**
     * Rozbicie bieżącego okna kontekstu per kategoria.
     * `total` to DOKŁADNIE ta liczba, którą widzi kompresja i wskaźnik pod inputem
     * (`getCurrentTokenCount()`) — jeden licznik, jedna prawda.
     * ⚠️ Podgrupy `layer1`/`layer2` liczone są per wiadomość (kumulacja zaokrągleń), więc ich
     * suma może różnić się od `total` o kilka tokenów. Świadomy kompromis: nagłówek nie kłamie.
     * @returns {Object}
     */
    getBreakdown() {
        // AUD-wydajnosc-049: prompt liczony z tej samej pamięci statystyk co reszta okna —
        // dawniej `getTokenCount(this.systemPrompt)` skanował go tu jeszcze raz, a `systemPrompt`
        // jest getterem SKLEJAJĄCYM prompt bazowy ze streszczeniem przy każdym odczycie.
        const promptStats = this._promptStats();
        const systemPromptTokens = countTokensFromStats(promptStats.chars, promptStats.nonAscii);
        // AUD-wydajnosc-049: JEDEN przebieg po historii zamiast dwóch. Dawniej `getBreakdown`
        // liczył wycenę per wiadomość, a potem wołał `getCurrentTokenCount()`, który przechodził
        // po tych samych wiadomościach drugi raz (a `updateTokenCounter` dokładał trzeci).
        let totalChars = promptStats.chars;
        let totalNonAscii = promptStats.nonAscii;
        let totalImageTokens = 0;
        const messageItems = this.messages.map((msg, index) => {
            const stats = this._messageStats(msg);
            totalChars += stats.chars;
            totalNonAscii += stats.nonAscii;
            totalImageTokens += stats.imageTokens;
            return {
                index,
                role: msg.role || 'unknown',
                tokens: countTokensFromStats(stats.chars, stats.nonAscii) + stats.imageTokens,
                preview: this._previewMessage(msg),
            };
        });
        const messagesTokens = messageItems.reduce((sum, item) => sum + item.tokens, 0);
        const sources = this._contextTokenSources || {};
        const layer1 = {
            messages: messagesTokens,
            system_prompt: systemPromptTokens,
        };
        // L07-6: tylko realnie zasilane źródła (system_tools + mcp_tools_active). Dawne
        // memory_files/skills/*_deferred były zawsze 0 → usunięte (kłamały wierszem w Viewerze).
        const layer2 = {
            mcp_tools_active: Number(sources.mcp_tools_active) || 0,
            system_tools: Number(sources.system_tools) || 0,
        };
        // Ten sam wynik co `getCurrentTokenCount()` (ta sama suma statystyk, ta sama formuła) —
        // strażnikiem jest test „getBreakdown().total == getCurrentTokenCount()".
        const activeTotal = countTokensFromStats(totalChars, totalNonAscii) + totalImageTokens + this._toolDefinitionsTokens;
        const autocompact = Math.max(0, Math.round(this.maxTokens * 0.05));
        const free = Math.max(0, this.maxTokens - activeTotal - autocompact);

        return {
            layer1,
            layer2,
            buffer: { autocompact, free },
            // poza total — wymiar kosztu, nie rozmiaru okna
            cache: this._lastCacheMetadata(),
            total: activeTotal,
            max: this.maxTokens,
            percent: this.maxTokens > 0 ? Math.min(100, Math.round((activeTotal / this.maxTokens) * 100)) : 0,
            items: {
                messages: messageItems.filter(item => item.tokens > 0),
            },
        };
    }

    /**
     * Ustawia liczbę tokenów zajmowanych przez definicje narzędzi (tools schema).
     * Wywoływane przez chat_view przed każdym API call.
     * @param {number} count
     */
    setToolDefinitionsTokens(count: number): void {
        this._toolDefinitionsTokens = count || 0;
        this._contextTokenSources = {
            system_tools: this._toolDefinitionsTokens,
            mcp_tools_active: 0,
        };
    }

    /**
     * Ustawia rozbicie kosztu definicji narzędzi na dwa realnie zasilane źródła.
     * L07-6: przyjmuje TYLKO system_tools + mcp_tools_active (jedyne, które produkcyjny
     * caller `getCachedToolTokenBreakdown` zwraca). Dawne memory_files/skills/*_deferred
     * były zawsze 0 i kłamały wierszem w Token Viewerze — usunięte z sygnatury.
     * @param {{system_tools?:number, systemTools?:number, mcp_tools_active?:number, mcpToolsActive?:number}} sources
     */
    setContextTokenSources(sources: ContextTokenSources = {}): void {
        const normalized = {
            system_tools: Number(sources.system_tools ?? sources.systemTools ?? 0) || 0,
            mcp_tools_active: Number(sources.mcp_tools_active ?? sources.mcpToolsActive ?? 0) || 0,
        };
        this._contextTokenSources = normalized;
        this._toolDefinitionsTokens = normalized.system_tools + normalized.mcp_tools_active;
    }

    /**
     * Ustawia nowy bazowy system prompt (brain + agent context)
     * @param {string} prompt
     */
    setSystemPrompt(prompt: string): void {
        this.baseSystemPrompt = prompt || '';
    }

    /**
     * Czyści historię i summary (ale zachowuje base system prompt)
     */
    clear(): void {
        this.messages = [];
        this.conversationSummary = '';
        this._summarizationCount = 0;
        this._toolTrimCount = 0;
        this._toolDefinitionsTokens = 0;
        // L07-6: tylko realnie zasilane źródła. memory_files/skills siedzą w system_prompt
        // (nie osobno), a *_deferred nigdy nie były zasilane — usunięte (nie kłam wierszem 0).
        this._contextTokenSources = {
            system_tools: 0,
            mcp_tools_active: 0,
        };
        this._lastSummarizationWasEmergency = false;
    }

    /**
     * Metadane cache z NAJNOWSZEJ wiadomości, która je ma (kształt z `buildCacheMetadata`).
     * Dokłada je `chat_streaming` do wiadomości assistant, gdy platforma zwróciła cached_tokens.
     * @returns {Object|null}
     * @private
     */
    _lastCacheMetadata(): Runtime {
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const cache = this.messages[i]?.cache;
            if (cache) return cache;
        }
        return null;
    }

    _countMessageTokens(msg: Partial<RollingMessage> = {}): number {
        // AUD-wydajnosc-049: te same statystyki co `getCurrentTokenCount` (jedna pamięć,
        // jedno skanowanie) — Token Viewer przestaje przemiatać historię drugi i trzeci raz.
        const stats = this._messageStats(msg as RollingMessage);
        return countTokensFromStats(stats.chars, stats.nonAscii) + stats.imageTokens;
    }

    _contentToTokenText(content: RollingMessage['content']): string {
        if (!content) return '';
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return '';
        let text = '';
        for (const block of content) {
            if (block.type === 'text') text += block.text || '';
            // F04 (korekta AUD-code-review-071 v1): obraz NIE wchodzi tu jako surowy base64 —
            // pełna długość url w tym samym stringu co reszta transkryptu wysadzała `maxTokens`
            // produkcyjny w JEDNYM `addMessage` (patrz komentarz przy `estimateImageTokens`,
            // góra pliku). Wyceniany osobno, z sufitem, w `_contentImageTokens`.
        }
        return text;
    }

    /**
     * F04 (korekta AUD-code-review-071 v1): suma tokenów obrazów (`image_url`) w wiadomości,
     * każdy z SUFITEM `estimateImageTokens`. Osobna od `_contentToTokenText`, bo base64 obrazu
     * nie może wpaść do wspólnego stringa liczonego przez `getTokenCount` — tam licz-po-znakach
     * skalowałby się z długością base64 bez ograniczenia.
     */
    _contentImageTokens(content: RollingMessage['content']): number {
        if (!content || typeof content === 'string' || !Array.isArray(content)) return 0;
        let tokens = 0;
        for (const block of content) {
            if (block?.type === 'image_url' && block.image_url?.url) {
                tokens += estimateImageTokens(block.image_url.url);
            }
        }
        return tokens;
    }

    /**
     * AUD-code-review-071: rozmiar TREŚCI wiadomości (znaki), nie rozmiar tablicy bloków. Fazę 1
     * kompresji (`trimOldToolResults`/`_trimToolResultsAggressive`) pytała dawniej `msg.content.length`
     * wprost — dla content-array (generate_image + vision: `[{text},{image_url}]`) to zawsze LICZBA
     * BLOKÓW (2), niezależnie od tego, ile waży base64 w środku, więc taka wiadomość nigdy nie
     * przekraczała progu i nigdy nie była kwalifikowana do skrócenia.
     */
    _contentSize(content: RollingMessage['content']): number {
        if (!content) return 0;
        if (typeof content === 'string') return content.length;
        if (!Array.isArray(content)) return 0;
        let size = 0;
        for (const block of content) {
            if (block?.type === 'text') size += (block.text || '').length;
            else if (block?.type === 'image_url') size += (block.image_url?.url || '').length;
        }
        return size;
    }

    _previewMessage(msg: Partial<RollingMessage> = {}): string {
        // AUD-wydajnosc-049: podgląd ma 96 znaków, więc normalizujemy TYLKO początek treści.
        // Dawniej `replace(/\s+/g,' ')` przemiatał CAŁĄ wiadomość (przy 800 wiadomościach ×
        // wielokilobajtowych wynikach narzędzi to drugi, ukryty przebieg po całej historii przy
        // każdym otwarciu Token Viewera). Zapas 400 znaków pokrywa nawet treść zaczynającą się
        // od długiego ciągu białych znaków.
        const raw = this._contentToTokenText(msg.content);
        const text = (raw.length > 400 ? raw.slice(0, 400) : raw).replace(/\s+/g, ' ').trim();
        if (!text) return msg.tool_calls?.length ? '[tool calls]' : '';
        return text.length > 96 ? `${text.slice(0, 93)}...` : text;
    }

    /**
     * Przycina najstarsze wiadomości, zachowując:
     * - pary User↔Assistant
     * - grupy Assistant(tool_calls) ↔ Tool(tool_call_id) — rozdzielenie tych par
     *   powoduje błąd API (model dostaje tool result bez matchującego tool_call)
     * @private
     */
    _trimOldestMessages(): void {
        // AUD-wydajnosc-048: pętla przelicza okno po KAŻDEJ usuniętej grupie. Do naprawy każdy
        // obrót sklejał całą historię i skanował ją znak po znaku (zmierzone 590 ms zamrożonego
        // UI przy 800 wiadomościach, kwadratowo). Dziś `getCurrentTokenCount` sumuje zapamiętane
        // statystyki per wiadomość — obrót kosztuje odczyt z pamięci, a nie ponowny skan tekstu.
        while (this.getCurrentTokenCount() > this.maxTokens && this.messages.length > 1) {
            if (this.messages.length <= 1) break;

            // Calculate how many messages to remove as a group
            const removeCount = this._getRemovableGroupSize(0);
            if (removeCount <= 0) break; // Safety: can't trim anything
            this.messages.splice(0, removeCount);
        }
    }

    /**
     * Determine how many consecutive messages form a removable group starting at index.
     * Ensures tool_call/tool_result pairs are always removed together.
     * @param {number} idx - Starting index
     * @returns {number} Number of messages to remove (0 = can't remove safely)
     * @private
     */
    _getRemovableGroupSize(idx: number): number {
        if (idx >= this.messages.length) return 0;
        const msg = this.messages[idx];

        // Case 1: orphaned tool result (no parent assistant) — safe to remove alone
        if (msg.role === 'tool') return 1;

        // Case 2: assistant with tool_calls — remove it + ALL following tool results
        if (msg.role === 'assistant' && (msg.tool_calls?.length as number) > 0) {
            const tcIds = new Set(msg.tool_calls!.map(tc => tc.id));
            let count = 1; // the assistant message itself
            while (idx + count < this.messages.length) {
                const next = this.messages[idx + count];
                if (next.role === 'tool' && tcIds.has(next.tool_call_id)) {
                    count++;
                } else {
                    break;
                }
            }
            return count;
        }

        // Case 3: user → remove user + assistant reply (if next is assistant)
        if (msg.role === 'user') {
            if (idx + 1 < this.messages.length && this.messages[idx + 1].role === 'assistant') {
                // If that assistant has tool_calls, include its tool results too
                const assistantGroup = this._getRemovableGroupSize(idx + 1);
                return 1 + assistantGroup; // user + assistant group
            }
            return 1;
        }

        // Case 4: plain assistant (no tool_calls) — safe to remove alone
        return 1;
    }
}
