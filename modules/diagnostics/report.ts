import { t } from '../../core/i18n/index.js';
import { count, providerErrorType } from './values.js';
import type { ConnectionResult } from './connection.js';
import type { DiagnosticCheck } from './diagnostics.js';

/** Exact known values only, including non-enumerable hydrated keys. No text patterns. */
export function secretFilter(settings: unknown): (text: string) => string {
    const values = new Set<string>();
    const seenPublic = new WeakSet<object>();
    const seenSensitive = new WeakSet<object>();
    function visit(value: unknown, sensitive: boolean): void {
        if (typeof value === 'string') { if (sensitive && value.length >= 8) values.add(value); return; }
        if (!value || typeof value !== 'object') return;
        const seen = sensitive ? seenSensitive : seenPublic;
        if (seen.has(value)) return;
        seen.add(value);
        for (const key of Object.getOwnPropertyNames(value)) {
            visit(Reflect.get(value, key), sensitive || /key|token|secret|password|authorization|cookie|headers|^env$/i.test(key));
        }
    }
    visit(settings, false);
    const secrets = [...values].sort((a, b) => b.length - a.length);
    return text => {
        for (const secret of secrets) {
            text = text.split('[REDACTED]').map(part => part.split(secret).join('[REDACTED]')).join('[REDACTED]');
        }
        return text;
    };
}

export function connectionDetail(result: ConnectionResult): string {
    if (result.status === 'skipped') return t(`diagnostics.${result.reason}`);
    let explanation = t('diagnostics.none');
    if (result.status === 'error') {
        let reason: string = result.kind;
        if (result.kind === 'http' || result.kind === 'provider') {
            const status = result.httpStatus;
            reason = status === 401 || status === 403 ? 'authentication'
                : status === 404 ? 'not_found' : status === 429 ? 'rate_limit'
                : status !== null && status >= 500 && status <= 599 ? 'server' : result.kind;
        }
        explanation = t(`diagnostics.connection.${reason}`);
    }
    const detail = t('diagnostics.connection_result', {
        status: count(result.httpStatus) ?? t('diagnostics.unavailable'),
        chunks: count(result.chunks) ?? 0,
        first: count(result.firstChunkMs) ?? t('diagnostics.unavailable'),
        total: count(result.totalMs) ?? 0,
        error: explanation,
    });
    if (result.status === 'ok') return detail;
    const type = providerErrorType(result.providerErrorType);
    return `${detail}; ${t('diagnostics.connection_kind', { kind: result.kind })}${type === null ? '' : `; ${t('diagnostics.provider_error_type', { type })}`}`;
}

/** Called only after constructing rows from fixed labels and validated values. */
export function renderDiagnosticMarkdown(checks: DiagnosticCheck[], redact: (text: string) => string): string {
    const cell = (value: string) => value.replace(/\|/g, '&#124;').replace(/[\r\n]+/g, ' ').replace(/[<>]/g, '');
    // Filter before Markdown escaping too, so escaping cannot split a known secret.
    return redact([
        `# ${t('diagnostics.title')}`, '', t('diagnostics.privacy'), '',
        `| ${t('diagnostics.columns')} |`, '| --- | --- | ---: | --- |',
        ...checks.map(c => `| ${cell(redact(c.name))} | ${t(`diagnostics.status.${c.status}`)} | ${count(c.ms) ?? 0} | ${cell(redact(c.detail))} |`), '',
    ].join('\n'));
}
