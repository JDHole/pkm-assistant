import type { StreamTransport } from '../../core/index.js';
import type { ChatProvider, ProviderContext } from '../models/index.js';
import { t } from '../../core/i18n/index.js';
import type { CheckStatus } from './diagnostics.js';

/** One request, no retries, no agent prompt, tools, history or response content in the report. */
export async function probeConnection(provider: ChatProvider, context: ProviderContext, transport: StreamTransport,
    redact: (text: string) => string, signal: AbortSignal): Promise<{ status: CheckStatus; detail: string }> {
    let status: number | null = null, chunks = 0, first: number | null = null;
    const start = performance.now();
    const request = { messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 16 };
    const ctx = { ...context, maxOutputTokens: 16 };
    const decoder = provider.createStreamDecoder(request, ctx);
    let providerError = '';
    let failure = '';
    try {
        const response = await transport.open({ ...provider.buildRequest(request, ctx, true), timeoutMs: 30000 }, {
            onChunk: text => {
                for (const event of decoder.feed(text)) if (event.type === 'error') providerError = event.error.message;
            },
            onActivity: activity => {
                if (activity.kind === 'response') status = activity.status;
                if (activity.kind === 'chunk') { chunks = activity.chunkIndex; first ??= activity.elapsedMs; }
            },
        }, signal);
        status = response.status;
        if (status !== 200) failure = response.body || `HTTP ${status}`;
        for (const event of decoder.finish()) if (event.type === 'error') providerError = event.error.message;
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    failure = providerError || failure;
    if (!failure && chunks === 0) failure = t('diagnostics.empty_stream');
    return {
        status: failure ? 'error' : 'ok',
        detail: redact(t('diagnostics.connection_result', {
            status: status ?? t('diagnostics.unavailable'), chunks, first: first ?? t('diagnostics.unavailable'),
            total: Math.round(performance.now() - start), error: failure || t('diagnostics.none'),
        })),
    };
}
