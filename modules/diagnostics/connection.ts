import type { StreamTransport } from '../../core/index.js';
import type { ChatProvider, ProviderContext, StreamEvent } from '../models/index.js';
import { field, providerErrorType } from './values.js';

export type ConnectionFailure = 'transport' | 'timeout' | 'aborted' | 'http' | 'provider' | 'empty_stream' | 'invalid_stream';
interface ConnectionMetrics {
    httpStatus: number | null;
    chunks: number;
    firstChunkMs: number | null;
    totalMs: number;
}
export type ConnectionResult =
    | { status: 'skipped'; reason: 'no_abort_controller' | 'no_model' | 'no_key' }
    | (ConnectionMetrics & ({ status: 'ok' } | { status: 'error'; kind: ConnectionFailure; providerErrorType: string | null }));

/** Only metadata fields; never infer a code from a message or serialize an error. */
function errorType(error: unknown): string | null {
    return providerErrorType(field(error, 'type') ?? field(error, 'code'));
}

/** One request, no retries. External text stays inside the decoder/response boundary. */
export async function probeConnection(provider: ChatProvider, context: ProviderContext, transport: StreamTransport,
    signal: AbortSignal): Promise<ConnectionResult> {
    let httpStatus: number | null = null, chunks = 0, firstChunkMs: number | null = null;
    const start = performance.now();
    const request = { messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 16 };
    // Provider logging must not open a second channel for arbitrary response text.
    const note = () => context.log.debug('Diagnostics', 'Provider diagnostic event');
    const ctx = { ...context, maxOutputTokens: 16, log: { debug: note, info: note, warn: note, error: note, model: note } };
    let failure: ConnectionFailure | null = null;
    let type: string | null = null;
    let modelResponse = false;
    const observe = (events: StreamEvent[]) => {
        for (const event of events) {
            if (event.type === 'error') {
                failure = 'provider';
                // Production decoders preserve the source error in details. Read it
                // before the normalized code, whose synthetic UNKNOWN is not a provider type.
                const details = field(event.error, 'details');
                type = errorType(details === undefined ? event.error : details);
            }
            if (event.type === 'done' || ((event.type === 'text' || event.type === 'reasoning') && event.delta.length > 0)) modelResponse = true;
        }
    };
    try {
        const decoder = provider.createStreamDecoder(request, ctx);
        const response = await transport.open({ ...provider.buildRequest(request, ctx, true), timeoutMs: 30000 }, {
            onChunk: text => observe(decoder.feed(text)),
            onActivity: activity => {
                if (activity.kind === 'response') httpStatus = activity.status;
                if (activity.kind === 'chunk') { chunks = activity.chunkIndex; firstChunkMs ??= activity.elapsedMs; }
                if (activity.kind === 'end' && (activity.outcome === 'timeout' || activity.outcome === 'aborted')) failure = activity.outcome;
            },
        }, signal);
        httpStatus = response.status;
        if (httpStatus !== 200) {
            failure = 'http';
            try {
                const body: unknown = JSON.parse(response.body);
                const nested = field(body, 'error');
                type = errorType(nested === undefined ? body : nested);
            } catch { /* Non-JSON error bodies have no usable metadata. */ }
        } else observe(decoder.finish());
    } catch { failure ??= signal.aborted ? 'aborted' : 'transport'; }
    if (!failure && chunks === 0) failure = 'empty_stream';
    if (!failure && !modelResponse) failure = 'invalid_stream';
    const metrics = { httpStatus, chunks, firstChunkMs, totalMs: Math.round(performance.now() - start) };
    return failure ? { ...metrics, status: 'error', kind: failure, providerErrorType: type } : { ...metrics, status: 'ok' };
}
