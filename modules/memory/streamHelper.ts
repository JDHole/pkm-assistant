/**
 * Stream Helper - wraps ChatModel's .stream() as a Promise
 * Used by memory subsystem (extraction, summarization, consolidation).
 *
 * Problem: ChatModel has ONLY .stream() (callback-based).
 * Solution: Wrap it so callers can do: const text = await streamToComplete(model, msgs)
 *
 * E2.1: `streamToCompleteWithTools` (pętla tool-callingu sub-agentów) PRZENIESIONA do
 * modules/agent-loop (`runAgentLoop`) — jedyny konsument (SubAgentRunner) przepięty, więc
 * funkcja + jej prywatne helpery (odsklejanie DeepSeek, estymacja usage) zostały usunięte.
 * Tu zostaje tylko `streamToComplete` (bez narzędzi): Summarizer, ArchiveWorkflow,
 * SaveSessionWorkflow, web/summarize.
 *
 * S29 Z1 (2026-07-29): trzeci, opcjonalny argument `options`. Bez niego funkcja zachowuje się
 * DOKŁADNIE jak wcześniej (wszystkie stare wywołania są nietknięte). Z nim strzał w tle
 * przestaje być czarną skrzynką:
 *   - `onChunk(delta, response)` — znak życia dla UI (dotąd chunki były jawnie ignorowane),
 *   - `watchdog: { timeoutMs, onStall }` — cisza dłuższa niż timeout przerywa stream i
 *     odrzuca Promise błędem `code === 'stream_stalled'` (bez tego zdechły serwer wisiał
 *     do twardego timeoutu XHR = 600 s, a workflow po cichu spadał na fallback regex),
 *   - `signal` (AbortSignal) — przerwanie z zewnątrz; Promise odrzuca się `code === 'aborted'`.
 * Przerwanie idzie TĄ SAMĄ ścieżką co Stop w czacie: `chatModel.stopStream()`
 * (ChatModel → adapter → `active_stream.end()`).
 */
import { log } from '../../core/utils/Logger.js';
import { StreamWatchdog } from '../../core/index.js';

/** Kody błędów rozróżnialne przez callera (retry-polityka kroku konsolidacji stoi na nich). */
export const STREAM_ERROR_CODES = {
    STALLED: 'stream_stalled',
    ABORTED: 'aborted',
} as const;

export type StreamErrorCode = (typeof STREAM_ERROR_CODES)[keyof typeof STREAM_ERROR_CODES];

/** Błąd streamu z kodem — `err.code` jest jedynym kontraktem dla callerów. */
export interface StreamError extends Error {
    code?: StreamErrorCode;
    /** ile ms ciszy wykrył watchdog (tylko przy `stream_stalled`) */
    silentMs?: number;
}

/** Kształt jednej odpowiedzi/chunka z adaptera (OpenAI-like; wszystko opcjonalne). */
export interface StreamResponse {
    choices?: Array<{ message?: { content?: string | null } | null } | null> | null;
    usage?: unknown;
}

/** Wiadomość podawana modelowi. Treść bywa multimodalna (tablica bloków). */
export interface StreamMessage {
    role: string;
    content: string | unknown[];
}

/** Handlery, które helper podaje adapterowi. */
export interface StreamHandlers {
    chunk: (response: StreamResponse) => void;
    done: (response: StreamResponse) => void;
    error: (err: unknown) => void;
}

/**
 * Model czatu widziany przez helper — typowany STRUKTURALNIE (adaptery żyją
 * w `modules/models`, jeszcze w `.js`). `stream` bywa synchroniczne albo oddaje
 * Promise, która potrafi odrzucić się BEZ wołania `handlers.error`.
 */
export interface StreamChatModelLike {
    stream(req: { messages: StreamMessage[] }, handlers: StreamHandlers): unknown;
    stopStream?: () => void;
    stop?: () => void;
}

/** Opcje watchdoga zwisu (`timeoutMs <= 0` = wyłączony). */
export interface StreamWatchdogOpts {
    timeoutMs?: number;
    onStall?: (silentMs: number) => void;
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn?: (id: unknown) => void;
    now?: () => number;
}

/** Wszystkie pola opcjonalne; bez `options` zachowanie jak przed S29. */
export interface StreamToCompleteOptions {
    /** nowy fragment tekstu (różnica treści skumulowanej) + surowy chunk */
    onChunk?: (delta: string, response: StreamResponse) => void;
    /** przerwanie z zewnątrz → reject z `code: 'aborted'` */
    signal?: AbortSignal;
    watchdog?: StreamWatchdogOpts;
}

/** Wynik zakończonego strzału: treść + surowe `usage` z adaptera (kształt zależny od platformy). */
export interface StreamToCompleteResult {
    text: string;
    usage: unknown;
}

type ErrLike = { message?: string };

/** Buduje błąd z kodem — `err.code` jest jedynym kontraktem dla callerów. */
function makeStreamError(
    code: StreamErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
): StreamError {
    const err: StreamError = new Error(message);
    err.code = code;
    Object.assign(err, extra);
    return err;
}

/** Przerywa stream tą samą drogą co przycisk Stop w czacie. Best-effort — nigdy nie rzuca. */
function stopModelStream(chatModel: StreamChatModelLike | null | undefined): void {
    try {
        if (typeof chatModel?.stopStream === 'function') chatModel.stopStream();
        else if (typeof chatModel?.stop === 'function') chatModel.stop();
    } catch (e) {
        log.warn('StreamHelper', `stopStream() failed: ${((e as ErrLike)?.message || e) as string}`);
    }
}

/** Wyciąga skumulowaną treść z kształtu OpenAI (chunk niesie CAŁOŚĆ dotychczasową, nie deltę). */
function contentOf(response: StreamResponse | null | undefined): string {
    return String(response?.choices?.[0]?.message?.content || '');
}

/**
 * Call a ChatModel in non-streaming mode.
 *
 * `options.onChunk` — wyjątki z callbacku są łykane. `options.watchdog` — po ciszy:
 * `onStall` (jeśli podany) → stop streamu → reject z `code: 'stream_stalled'`
 * i polem `silentMs`.
 *
 * @returns Response text + token usage
 */
export function streamToComplete(
    chatModel: StreamChatModelLike,
    messages: StreamMessage[],
    options: StreamToCompleteOptions = {},
): Promise<StreamToCompleteResult> {
    const { onChunk, signal, watchdog: watchdogOpts } = options || {};
    log.debug('StreamHelper', `streamToComplete: ${messages.length} wiadomości`);

    return new Promise<StreamToCompleteResult>((resolve, reject) => {
        let settled = false;
        let lastContent = '';
        let watchdog: StreamWatchdog | null = null;
        let abortListener: (() => void) | null = null;

        const cleanup = () => {
            watchdog?.disarm();
            if (abortListener && signal?.removeEventListener) {
                signal.removeEventListener('abort', abortListener);
            }
        };
        const finish = <T>(fn: (value: T) => void) => (value: T) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn(value);
        };
        const settleOk = finish<StreamToCompleteResult>(resolve);
        const settleErr = finish<unknown>(reject);

        // Przerwanie z zewnątrz — sprawdzone PRZED wystartowaniem streamu (abort sprzed wywołania
        // nie może odpalić modelu i spalić tokenów).
        if (signal?.aborted) {
            settleErr(makeStreamError(STREAM_ERROR_CODES.ABORTED, 'Stream aborted before start'));
            return;
        }
        if (signal?.addEventListener) {
            abortListener = () => {
                if (settled) return;
                stopModelStream(chatModel);
                settleErr(makeStreamError(STREAM_ERROR_CODES.ABORTED, 'Stream aborted'));
            };
            signal.addEventListener('abort', abortListener, { once: true });
        }

        if (watchdogOpts && Number(watchdogOpts.timeoutMs) > 0) {
            watchdog = new StreamWatchdog({
                timeoutMs: Number(watchdogOpts.timeoutMs),
                setTimeoutFn: watchdogOpts.setTimeoutFn,
                clearTimeoutFn: watchdogOpts.clearTimeoutFn,
                now: watchdogOpts.now,
                onStall: (silentMs) => {
                    if (settled) return;
                    log.warn('StreamHelper', `Stream stalled — ${silentMs}ms bez chunka, przerywam`);
                    try { watchdogOpts.onStall?.(silentMs); } catch { /* callback UI nie może wywalić streamu */ }
                    stopModelStream(chatModel);
                    settleErr(makeStreamError(
                        STREAM_ERROR_CODES.STALLED,
                        `Stream stalled: ${silentMs}ms without a chunk`,
                        { silentMs }
                    ));
                },
            });
        }

        // Adapter oddaje albo nic, albo Promise — `stream()` jest typowany `unknown`,
        // bo tylko tyle wolno o nim założyć. Asercja poniżej odwzorowuje tę dwoistość,
        // a `typeof .then === 'function'` i tak sprawdza ją w runtime.
        let streaming: PromiseLike<unknown> | undefined;
        try {
            watchdog?.arm();
            streaming = chatModel.stream(
                { messages },
                {
                    chunk: (response) => {
                        if (settled) return;
                        watchdog?.feed();
                        if (typeof onChunk !== 'function') return;
                        // Chunk niesie CAŁOŚĆ skumulowaną — deltę liczymy sami. Gdy treść się
                        // skurczy (reset adaptera), oddajemy pusty string zamiast ujemnego wycinka.
                        const accumulated = contentOf(response);
                        const delta = accumulated.startsWith(lastContent)
                            ? accumulated.slice(lastContent.length)
                            : accumulated;
                        lastContent = accumulated;
                        try { onChunk(delta, response); } catch { /* UI nie może wywalić streamu */ }
                    },
                    done: (response) => {
                        // Extract text from standard OpenAI/Anthropic response format
                        const content = contentOf(response);
                        const usage = response?.usage || null;
                        log.debug('StreamHelper', `streamToComplete DONE: ${content.length} znaków`);
                        settleOk({ text: content, usage });
                    },
                    error: (err) => {
                        if (settled) return; // stall/abort już rozstrzygnął — nie nadpisujemy kodu
                        log.error('StreamHelper', 'streamToComplete ERROR:', err);
                        settleErr(err);
                    }
                }
            ) as PromiseLike<unknown> | undefined;
        } catch (err) {
            // Synchroniczny wybuch .stream() (zły model / brak adaptera).
            settleErr(err);
            return;
        }

        // Adapter zwraca Promise, która potrafi odrzucić się BEZ wołania handlers.error
        // (retry-pętla `stream()` w chat_adapter_base). Dotąd taka odmowa była porzucona
        // (unhandled rejection + wisząca Promise). Guard `settled` gwarantuje, że nie
        // nadpiszemy kodu stall/abort, jeśli to my przerwaliśmy stream.
        if (streaming && typeof streaming.then === 'function') {
            streaming.then(undefined, (err: unknown) => settleErr(err));
        }
    });
}
