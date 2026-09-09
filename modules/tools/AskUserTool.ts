/**
 * ask_user — MCP tool that lets the agent ask the user a question and WAIT for an answer.
 *
 * Unlike regular chat (where agent just writes text and hopes user responds),
 * this tool creates a structured question block with clickable options.
 * The tool execution PAUSES until the user responds.
 *
 * Promise lifecycle:
 *   1. chat_view._renderAskUserBlock() creates plugin._askUserPromise + _askUserResolve (Phase 1, sync)
 *   2. AskUserTool.execute() awaits that promise (Phase 2, async)
 *   3. User clicks submit → chat_view calls plugin._askUserResolve(answer)
 *   4. Cleanup happens in finally{} block
 *
 * Safeguards:
 *   - 5 min timeout (user forgot, navigated away) — honest failure, NEVER a fabricated
 *     "first option" answer (same class of bug as the no-UI branch fixed below)
 *   - null answer = cancelled (handle_error, onClose, timeout)
 *   - chat_view is the ONLY creator of the promise
 */

import { t } from '../../core/i18n/index.js';
import { log } from '../../core/utils/Logger.js';

const ASK_USER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// obsidianmd/prefer-window-timers: ten plik wstaje w gołym Node (testy AVA), gdzie `window`
// nie istnieje — `window.setTimeout` byłby ReferenceError. Inline `eslint-disable` jest
// zablokowany dla `obsidianmd/*` (`eslint-comments/no-restricted-disable` w configu pluginu
// recenzenta katalogu). Owijamy globalny timer FUNKCJĄ zamiast zamrażać referencję raz przy
// imporcie — `fn` czyta `setTimeout`/`clearTimeout` DYNAMICZNIE przy każdym wywołaniu, więc
// zachowanie (w tym testowe podmiany `globalThis.setTimeout`) jest 1:1 jak bezpośrednie
// wywołanie globala. Reguła pomija wywołanie, bo `fn` jest lokalną zmienną, nie globalną
// referencją.
function _nodeSafeSetTimeout(...args: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> {
    const fn = setTimeout;
    return fn(...args);
}
function _nodeSafeClearTimeout(...args: Parameters<typeof clearTimeout>): void {
    const fn = clearTimeout;
    fn(...args);
}

/** Opcje `createAskUserTool` — WYŁĄCZNIE do testów (budzik 5 min nie jest inaczej
 *  osiągalny bez czekania naprawdę 5 minut). */
interface AskUserToolOptions {
    /** Nadpisanie budzika. Produkcja zawsze dostaje `ASK_USER_TIMEOUT_MS`. */
    timeoutMs?: number;
}

/** Argumenty `ask_user` wg `inputSchema`. */
interface AskUserToolArgs {
    question?: unknown;
    options?: string[];
    context?: string;
    [extra: string]: unknown;
}

/**
 * Minimalny widok pluginu — kanał `ask_user`. Promise tworzy WYŁĄCZNIE
 * `chat_view._renderAskUserBlock()` (Faza 1, sync); tu go tylko czekamy i sprzątamy.
 */
export interface AskUserPlugin {
    _askUserPending?: { question: string; options: string[]; context: string } | null;
    _askUserPromise?: Promise<string | null> | null;
    _askUserResolve?: ((answer: string | null) => void) | null;
    /**
     * Obsidian `Plugin.registerInterval` — czyści uchwyt przy unload.
     * Opcjonalne: host bez tej metody (testy, starszy adapter) po prostu jej nie dostaje.
     */
    registerInterval?: (handle: unknown) => number;
}

export function createAskUserTool(options: AskUserToolOptions = {}) {
    const timeoutMs = options.timeoutMs ?? ASK_USER_TIMEOUT_MS;
    return {
        name: 'ask_user',
        description: t('mcp.ask_user.desc'),
        inputSchema: {
            type: 'object',
            properties: {
                question: {
                    type: 'string',
                    description: t('mcp.ask_user.param.question')
                },
                options: {
                    type: 'array',
                    items: { type: 'string' },
                    description: t('mcp.ask_user.param.options')
                },
                context: {
                    type: 'string',
                    description: t('mcp.ask_user.param.context')
                }
            },
            required: ['question']
        },
        /**
         * Execute is special — it awaits plugin._askUserPromise created by chat_view.
         * chat_view._renderAskUserBlock() is the ONLY promise creator (Phase 1, sync).
         */
        execute: async (args: AskUserToolArgs, _app: unknown, plugin: AskUserPlugin | null | undefined) => {
            const { question, options, context } = args;

            if (!question || typeof question !== 'string') {
                return { success: false, error: 'question jest wymagane' };
            }

            // ask_user ZAWSZE czeka na usera — nawet w autonomii yolo (zero pytań o
            // approval). Cały sens tego toola to "MUSZĘ zapytać usera"; tryb autonomii
            // znosi bramki approval, ale nie samo pytanie tego narzędzia.

            // Signal to chat_view what question to render (used if _renderAskUserBlock
            // hasn't fired yet, e.g. background tab auto-answer path)
            if (plugin) {
                plugin._askUserPending = { question, options: options || [], context: context || '' };
            }

            // Wait for chat_view to create and resolve the promise.
            // chat_view._renderAskUserBlock() creates plugin._askUserPromise in Phase 1 (sync),
            // which runs BEFORE Phase 2 (this execute). So the promise should already exist.
            if (!plugin?._askUserPromise) {
                // Brak kanału pytania (tura leci w zakładce W TLE, blok pytania nigdy nie
                // powstał) = NIE MA KOGO ZAPYTAĆ. Pierwsza opcja z listy jako "odpowiedź
                // użytkownika" (success:true, auto:true) byłaby sfabrykowaną ZGODĄ na operację,
                // której user nie widział — dlatego to rozpoznawalna porażka: pętla i model
                // mają pójść ścieżką błędu, a nie zgadywać za człowieka.
                log.warn('AskUserTool', 'Brak kanału pytania (zakładka w tle?) - zwracam ask_user.no_ui');
                // Bramka jak u sąsiadów (linia wyżej i finally) — do tej gałęzi wchodzi się
                // TAKŻE gdy plugin jest null, więc jej brak byłby uśpionym NPE.
                if (plugin) plugin._askUserPending = null;
                return {
                    success: false,
                    error: 'ask_user.no_ui',
                    message: t('mcp.ask_user.no_ui'),
                    question
                };
            }

            // Bez tego uchwytu budzik trzymałby proces przy życiu jeszcze 5 minut po odpowiedzi
            // usera — uchwyt jest po to, żeby `finally` go zdjął.
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            try {
                // Race between user response and timeout
                const timeoutPromise = new Promise<never>((_, reject) => {
                    timeoutHandle = _nodeSafeSetTimeout(() => reject(new Error('ask_user_timeout')), timeoutMs);
                });
                // `finally` zdejmuje budzik po ROZSTRZYGNIĘCIU wyścigu. W oknie oczekiwania
                // (user jeszcze nie odpowiedział) obietnica nie rozstrzyga się nigdy, więc bez
                // rejestracji budzik tykałby dalej na martwym pluginie po `onunload`. Uchwyt
                // idzie więc dodatkowo do cyklu życia hosta — kanon z src/main.ts (`clearInterval`
                // w JS kasuje uchwyty obu rodzajów, więc `registerInterval` obsługuje też `setTimeout`).
                try { plugin.registerInterval?.(timeoutHandle); } catch { /* host bez rejestru */ }

                const answer = await Promise.race([
                    plugin._askUserPromise,
                    timeoutPromise
                ]);

                // null answer = cancelled (handle_error, onClose cleanup)
                if (answer === null || answer === undefined) {
                    return {
                        success: false,
                        error: 'Użytkownik anulował pytanie.',
                        question
                    };
                }

                return {
                    success: true,
                    question,
                    answer,
                    auto: false
                };
            } catch (err) {
                if ((err as Error).message === 'ask_user_timeout') {
                    // Budzik NIE zmyśla zgody: pierwsza opcja jako "odpowiedź usera"
                    // (success:true, auto:true) byłaby sfabrykowaną zgodą na operację, której
                    // user nigdy nie widział — ten sam błąd, który naprawia gałąź „brak UI"
                    // wyżej w pliku. Timeout ma iść tą samą drogą co reszta braku odpowiedzi:
                    // porażka, rozpoznawalny kod, zdanie dla modelu. NIE przywracaj
                    // auto-odpowiedzi tutaj.
                    log.warn('AskUserTool', 'Timeout (5 min) - brak odpowiedzi usera, zwracam ask_user.timeout');
                    return {
                        success: false,
                        error: 'ask_user.timeout',
                        message: t('mcp.ask_user.timeout'),
                        question
                    };
                }
                return { success: false, error: (err as Error).message, question };
            } finally {
                if (timeoutHandle !== undefined) _nodeSafeClearTimeout(timeoutHandle);
                // Always cleanup — regardless of success, error, or timeout
                if (plugin) {
                    plugin._askUserPending = null;
                    plugin._askUserPromise = null;
                    plugin._askUserResolve = null;
                }
            }
        }
    };
}
