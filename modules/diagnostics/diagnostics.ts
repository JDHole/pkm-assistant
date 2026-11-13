import { SecretsStorage, ensureAdapterFolder, maskSensitiveData, redactSecretsDeep, normalizeError } from '../../core/index.js';
import { t } from '../../core/i18n/index.js';
import type { DataAdapter } from 'obsidian';

export type DiagnosticAdapter = Pick<DataAdapter, 'exists' | 'mkdir' | 'write' | 'read' | 'stat' | 'rename' | 'list' | 'remove' | 'rmdir'> & Partial<Pick<DataAdapter, 'append'>>;
export type CheckStatus = 'ok' | 'error' | 'skipped';
export interface DiagnosticCheck { name: string; status: CheckStatus; ms: number; detail: string }
export interface DiagnosticInput {
    adapter: DiagnosticAdapter;
    platform: 'android' | 'ios' | 'mobile' | 'desktop';
    facts: Record<string, string | number | boolean | null>;
    capabilities: Record<string, boolean>;
    /** Used only as a redaction dictionary, never serialized into the report. */
    settings: unknown;
    consent: () => Promise<boolean>;
    connection: () => Promise<{ status: CheckStatus; detail: string }>;
    now?: () => number;
    date?: () => Date;
}
export interface DiagnosticReport {
    path: string;
    markdown: string;
    checks: DiagnosticCheck[];
    ok: number;
    errors: number;
}

/** Includes non-enumerable hydrated API keys. Never reads notes, conversations or log files. */
function secretValues(settings: unknown): string[] {
    const values: string[] = [];
    const seen = new WeakSet<object>();
    function visit(value: unknown, sensitive: boolean): void {
        if (typeof value === 'string') { if (sensitive && value) values.push(value); return; }
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        for (const key of Object.getOwnPropertyNames(value)) {
            visit(Reflect.get(value, key), sensitive || /key|token|secret|password|authorization|cookie|headers|^env$/i.test(key));
        }
    }
    visit(settings, false);
    return values.sort((a, b) => b.length - a.length);
}

export function diagnosticRedactor(settings: unknown): (text: string) => string {
    const secrets = secretValues(settings);
    return text => {
        // Existing value redaction precedes pattern masking; short custom secrets need full removal too.
        let safe = String(redactSecretsDeep(text, secrets));
        for (const secret of secrets) {
            for (const variant of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) {
                safe = safe.split(variant).join('[REDACTED]');
            }
        }
        return maskSensitiveData(safe)
            .replace(/(?:https?|file):\/\/[^\s<>"']+/gi, '[URL]')
            .replace(/(?:[A-Za-z]:[\\/]|\\\\|(?:^|[\s("'=])\/)[^\n\r"'<>]*/g, ' [PATH]');
    };
}

export async function runDeviceDiagnostics(input: DiagnosticInput): Promise<DiagnosticReport> {
    const now = input.now ?? (() => performance.now());
    const date = input.date ?? (() => new Date());
    const redact = diagnosticRedactor(input.settings);
    const checks: DiagnosticCheck[] = [];
    async function check(name: string, run: () => Promise<string>): Promise<boolean> {
        const start = now();
        try {
            const detail = await run();
            checks.push({ name, status: 'ok', ms: Math.round(now() - start), detail: redact(detail) });
            return true;
        } catch (error) {
            // Redact before normalizeError truncates the message.
            const message = error instanceof Error ? error.message : normalizeError(redactSecretsDeep(error, secretValues(input.settings))).message;
            checks.push({ name, status: 'error', ms: Math.round(now() - start), detail: redact(message) });
            return false;
        }
    }
    const skipped = (name: string, detail = t('diagnostics.dependency')) => checks.push({ name, status: 'skipped', ms: 0, detail });
    for (const [name, value] of Object.entries(input.facts)) {
        if (value === null) skipped(name, t('diagnostics.unavailable'));
        else await check(name, () => Promise.resolve(String(value)));
    }
    const required = new Set(['structuredClone', 'Array.prototype.at', 'crypto.subtle', 'ReadableStream', 'TextDecoder', 'AbortController']);
    for (const [name, available] of Object.entries(input.capabilities)) {
        checks.push({ name, status: available ? 'ok' : required.has(name) ? 'error' : 'skipped', ms: 0, detail: t(available ? 'diagnostics.present' : 'diagnostics.unavailable') });
    }
    await check('crypto.roundtrip', async () => {
        const vault = new SecretsStorage(null);
        try {
            await vault.unlock('PKM diagnostic test password');
            const encrypted = await vault.encryptWithPassword('PKM diagnostic sample');
            if (await vault.decryptWithPassword(encrypted) !== 'PKM diagnostic sample') throw new Error(t('diagnostics.mismatch'));
            return t('diagnostics.crypto_ok');
        } finally { vault.lock(); }
    });

    const base = '.pkm-assistant/diagnostics';
    const stamp = date().toISOString().replace(/[:.]/g, '-');
    // Independent per run and per device; no user-controlled path segments.
    const id = `${stamp}-${Math.random().toString(36).slice(2, 10)}`;
    const tmp = `${base}/tmp-${id}`;
    const nested = `${tmp}/nested`;
    const original = `${nested}/probe.txt`, renamed = `${nested}/renamed.txt`;
    const adapter = input.adapter;
    const assert = (ok: boolean) => { if (!ok) throw new Error(t('diagnostics.mismatch')); };
    let created = false;
    try {
        created = await check('fs.mkdir', async () => {
            await ensureAdapterFolder(adapter, nested);
            assert(await adapter.exists(nested));
            return t('diagnostics.verified');
        });
        const wrote = created && await check('fs.write', async () => {
            await adapter.write(original, 'PKM'); assert(await adapter.exists(original)); return t('diagnostics.verified');
        });
        if (!created) skipped('fs.write');
        if (wrote) {
            await check('fs.read', async () => { assert(await adapter.read(original) === 'PKM'); return t('diagnostics.verified'); });
            if (adapter.append) await check('fs.append', async () => {
                await adapter.append!(original, '+test'); assert(await adapter.read(original) === 'PKM+test'); return t('diagnostics.verified');
            });
            else skipped('fs.append', t('diagnostics.unavailable'));
            await check('fs.stat', async () => { const stat = await adapter.stat(original); assert(stat?.type === 'file' && stat.size > 0); return t('diagnostics.verified'); });
            const moved = await check('fs.rename', async () => {
                const before = await adapter.read(original);
                await adapter.rename(original, renamed);
                assert(!await adapter.exists(original) && await adapter.read(renamed) === before);
                return t('diagnostics.verified');
            });
            await check('fs.list', async () => {
                const listed = await adapter.list(nested); assert(listed.files.includes(moved ? renamed : original)); return t('diagnostics.verified');
            });
            await check('fs.remove', async () => {
                const path = moved ? renamed : original; await adapter.remove(path); assert(!await adapter.exists(path)); return t('diagnostics.verified');
            });
        } else for (const name of ['read', 'append', 'stat', 'rename', 'list', 'remove']) skipped(`fs.${name}`);
    } finally {
        await check('fs.rmdir', async () => {
            // Recursive removal is required by Obsidian even for an empty folder.
            if (await adapter.exists(tmp)) await adapter.rmdir(tmp, true);
            assert(!await adapter.exists(tmp)); return t('diagnostics.cleaned');
        });
    }
    if (await input.consent()) {
        const start = now();
        try {
            const result = await input.connection();
            checks.push({ name: 'model.connection', ...result, detail: redact(result.detail), ms: Math.round(now() - start) });
        } catch (error) {
            checks.push({ name: 'model.connection', status: 'error', detail: redact(error instanceof Error ? error.message : String(error)), ms: Math.round(now() - start) });
        }
    } else skipped('model.connection', t('diagnostics.declined'));
    const ok = checks.filter(c => c.status === 'ok').length;
    const errors = checks.filter(c => c.status === 'error').length;
    const cell = (value: string) => value.replace(/\|/g, '&#124;').replace(/[\r\n]+/g, ' ').replace(/[<>]/g, '');
    const markdown = redact([
        `# ${t('diagnostics.title')}`, '',
        t('diagnostics.privacy'), '',
        `| ${t('diagnostics.columns')} |`, '| --- | --- | ---: | --- |',
        ...checks.map(c => `| ${cell(c.name)} | ${t(`diagnostics.status.${c.status}`)} | ${c.ms} | ${cell(c.detail)} |`), '',
    ].join('\n'));
    const path = `${base}/${id}-${input.platform}.md`;
    await ensureAdapterFolder(adapter, base);
    await adapter.write(path, markdown);
    return { path, markdown, checks, ok, errors };
}
