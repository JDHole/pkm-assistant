import { PROVIDER_INFO } from '../models/index.js';
import { t } from '../../core/i18n/index.js';

/** Full-string validation: unlike `$`, this also rejects a final newline. */
function shaped(value: unknown, pattern: RegExp, limit: number): string | null {
    return typeof value === 'string' && value.length <= limit && pattern.exec(value)?.[0] === value ? value : null;
}
export function errorField(value: unknown): string {
    return shaped(value, /^[A-Za-z][A-Za-z0-9_]{0,39}$/, 40) ?? 'unknown';
}
export function providerErrorType(value: unknown): string | null {
    return shaped(value, /^[a-z][a-z0-9_.-]{0,59}$/, 60);
}
export function field(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object') return undefined;
    try { return Reflect.get(value, key); } catch { return undefined; }
}
export function count(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}
const booleanFact = (value: unknown) => typeof value === 'boolean' ? String(value) : null;
const numberFact = (value: unknown) => { const n = count(value); return n === null ? null : String(n); };
const versionFact = (value: unknown) => shaped(value, /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:[-+][A-Za-z0-9.-]{1,32})?$/, 64);
const providers = new Set(Object.keys(PROVIDER_INFO));
const factFormats: Record<string, (value: unknown) => string | null> = {
    'plugin.version': versionFact,
    'plugin.build': value => shaped(value, /^(?:dev|[a-f0-9]{7,40})(?: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(?: watch)?)?$/, 71),
    'obsidian.apiVersion': versionFact,
    isMobile: booleanFact, isPhone: booleanFact, isTablet: booleanFact,
    isAndroidApp: booleanFact, isIosApp: booleanFact, isDesktopApp: booleanFact,
    'navigator.userAgent': value => typeof value === 'string' ? Array.from(value.slice(0, 300)).filter(c => c >= ' ' && c <= '~').join('') : null,
    'window.size': value => shaped(value, /^\d{1,6}x\d{1,6}$/, 13),
    // A folder name only. Reject paths rather than salvaging a private basename.
    'vault.configDir': value => shaped(value, /^[A-Za-z0-9._ -]{1,64}$/, 64),
    'plugin.ready': booleanFact, 'plugin.startupMs': numberFact,
    'agents.count': numberFact, 'tools.count': numberFact,
    'mcp.total': numberFact, 'mcp.stdio': numberFact, 'mcp.http': numberFact,
    'embedding.status': value => typeof value === 'string' && ['idle', 'disabled_mobile', 'no_provider', 'building', 'ready', 'error'].includes(value) ? value : null,
    'drafts.available': booleanFact, 'vault.markdownCount': numberFact,
    'model.default': value => {
        if (typeof value !== 'string') return null;
        const slash = value.indexOf('/');
        if (slash < 1) return t('diagnostics.custom_identifier');
        const provider = value.slice(0, slash);
        if (!providers.has(provider)) return t('diagnostics.custom_identifier');
        const model = shaped(value.slice(slash + 1), /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/, 100);
        return model === null ? t('diagnostics.custom_identifier') : `${provider}/${model}`;
    },
    'model.useDeviceModels': booleanFact,
};

/** Unknown row names never become report text. Values are validated at this boundary. */
export function diagnosticFacts(facts: Record<string, unknown>): Array<[string, string | null]> {
    const rows: Array<[string, string | null]> = [];
    for (const [name, value] of Object.entries(facts)) {
        if (Object.hasOwn(factFormats, name)) rows.push([name, factFormats[name](value)]);
        else if (name.startsWith('provider.') && providers.has(name.slice(9))) {
            rows.push([name, typeof value === 'boolean' ? t('diagnostics.key_set', { value: t(value ? 'diagnostics.yes' : 'diagnostics.no') }) : null]);
        }
    }
    return rows;
}
export const capabilities = new Map([
    ['structuredClone', true], ['Array.prototype.at', true], ['crypto.subtle', true],
    ['ReadableStream', true], ['TextDecoder', true], ['AbortController', true],
    ['visualViewport', false], ['MediaRecorder', false], ['navigator.mediaDevices', false],
    ['navigator.clipboard', false], ['window.require', false],
]);
