import test from 'ava';
import { runDeviceDiagnostics } from './diagnostics.js';
import type { DiagnosticAdapter, DiagnosticInput } from './diagnostics.js';
import { setLocale } from '../../core/i18n/index.js';
import { FetchStreamTransport } from '../../core/index.js';
import { CHAT_PROVIDERS } from '../models/index.js';
import { log } from '../../core/utils/Logger.js';
import { probeConnection } from './connection.js';

/** Enforces parent existence and file/folder separation, like a vault adapter. */
function memoryAdapter() {
    const files = new Map<string, string>();
    const folders = new Set<string>(['']);
    const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
    function requireParent(path: string) { if (!folders.has(parent(path))) throw new Error('Parent missing'); }
    const adapter: DiagnosticAdapter = {
        exists: async path => files.has(path) || folders.has(path),
        mkdir: async path => { requireParent(path); folders.add(path); },
        write: async (path, value) => { requireParent(path); files.set(path, value); },
        read: async path => { const value = files.get(path); if (value === undefined) throw new Error('File missing'); return value; },
        append: async (path, text) => { if (!files.has(path)) throw new Error('File missing'); files.set(path, files.get(path) + text); },
        stat: async path => files.has(path) ? { type: 'file', size: files.get(path)!.length, mtime: 0, ctime: 0 } : null,
        rename: async (from, to) => { requireParent(to); const value = await adapter.read(from); files.delete(from); files.set(to, value); },
        list: async path => ({ files: [...files.keys()].filter(p => parent(p) === path), folders: [...folders].filter(p => p !== path && parent(p) === path) }),
        remove: async path => { if (!files.delete(path)) throw new Error('File missing'); },
        rmdir: async (path, recursive) => {
            if (!recursive && ([...files.keys(), ...folders].some(p => p.startsWith(path + '/')))) throw new Error('Not empty');
            for (const file of files.keys()) if (file.startsWith(path + '/')) files.delete(file);
            for (const folder of folders) if (folder === path || folder.startsWith(path + '/')) folders.delete(folder);
        },
    };
    return { adapter, files, folders };
}
function fixture() {
    const disk = memoryAdapter();
    let requests = 0;
    const input: DiagnosticInput = {
        adapter: disk.adapter, platform: 'android', settings: {}, facts: { 'plugin.version': '2.4.1', isMobile: true },
        capabilities: { structuredClone: true, MediaRecorder: false },
        consent: async () => false,
        connection: async () => { requests++; return { status: 'ok', httpStatus: 200, chunks: 2, firstChunkMs: 1, totalMs: 2 }; },
        now: () => 10, date: () => new Date('2026-11-13T12:34:56.000Z'),
    };
    return { ...disk, input, requests: () => requests };
}
test.beforeEach(() => setLocale('en'));

test('in-memory diagnostics writes verified results and leaves only its report', async t => {
    const f = fixture();
    const result = await runDeviceDiagnostics(f.input);
    t.deepEqual(result.checks.map(c => [c.name, c.status, c.ms]), [
        ['plugin.version', 'ok', 0], ['isMobile', 'ok', 0], ['structuredClone', 'ok', 0], ['MediaRecorder', 'skipped', 0],
        ['crypto.roundtrip', 'ok', 0], ['fs.mkdir', 'ok', 0], ['fs.write', 'ok', 0], ['fs.read', 'ok', 0],
        ['fs.append', 'ok', 0], ['fs.stat', 'ok', 0], ['fs.rename', 'ok', 0], ['fs.list', 'ok', 0],
        ['fs.remove', 'ok', 0], ['fs.rmdir', 'ok', 0], ['model.connection', 'skipped', 0],
    ]);
    t.is(result.ok, 13); t.is(result.errors, 0);
    const saved = await f.adapter.read(result.path);
    t.regex(saved, /\| crypto.roundtrip \| OK \| 0 \| PBKDF2 \+ AES-GCM round trip verified using disposable test data \|/);
    t.regex(saved, /\| fs.append \| OK \| 0 \| Verified \|/);
    t.regex(result.path, /^\.pkm-assistant\/diagnostics\/2026-11-13T12-34-56-000Z-[a-z0-9]+-android.md$/);
    t.deepEqual([...f.files.keys()], [result.path]);
    t.deepEqual([...f.folders], ['', '.pkm-assistant', '.pkm-assistant/diagnostics']);
});

test('rename failure is red in saved Markdown and cleanup still removes all temporary files', async t => {
    const f = fixture();
    f.adapter.rename = async () => { throw new Error('rename denied'); };
    const result = await runDeviceDiagnostics(f.input);
    t.regex(await f.adapter.read(result.path), /\| fs.rename \| ERROR \| 0 \| Class: Error; code: unknown \|/);
    t.is(result.errors, 1);
    t.deepEqual(result.checks.find(c => c.name === 'fs.rmdir'), { name: 'fs.rmdir', status: 'ok', ms: 0, detail: 'Temporary folder removed' });
    t.deepEqual([...f.files.keys()], [result.path]);
    t.deepEqual([...f.folders], ['', '.pkm-assistant', '.pkm-assistant/diagnostics']);
});

test('declining connection records a skip and sends zero requests', async t => {
    const f = fixture();
    const result = await runDeviceDiagnostics(f.input);
    t.regex(await f.adapter.read(result.path), /\| model.connection \| SKIPPED \| 0 \| No consent; no request sent \|/);
    t.is(result.ok, 13); t.is(f.requests(), 0);
});

test('missing append is skipped but rename, remove and cleanup are still verified', async t => {
    const f = fixture(); delete f.adapter.append;
    const result = await runDeviceDiagnostics(f.input);
    t.regex(await f.adapter.read(result.path), /\| fs.append \| SKIPPED \| 0 \| Unavailable \|/);
    t.deepEqual(result.checks.filter(c => ['fs.rename', 'fs.remove', 'fs.rmdir'].includes(c.name)).map(c => c.status), ['ok', 'ok', 'ok']);
    t.is(result.errors, 0);
});

test('partial mkdir failure cleans its own folder and preserves another run', async t => {
    const f = fixture();
    f.folders.add('.pkm-assistant'); f.folders.add('.pkm-assistant/diagnostics');
    f.folders.add('.pkm-assistant/diagnostics/tmp-other'); f.files.set('.pkm-assistant/diagnostics/tmp-other/keep.txt', 'keep');
    const mkdir = f.adapter.mkdir;
    f.adapter.mkdir = async path => { if (path.endsWith('/nested')) throw new Error('mkdir denied'); await mkdir(path); };
    const result = await runDeviceDiagnostics(f.input);
    t.deepEqual(result.checks.filter(c => ['fs.mkdir', 'fs.write', 'fs.rmdir'].includes(c.name)).map(c => [c.name, c.status]), [['fs.mkdir', 'error'], ['fs.write', 'skipped'], ['fs.rmdir', 'ok']]);
    t.deepEqual([...f.folders], ['', '.pkm-assistant', '.pkm-assistant/diagnostics', '.pkm-assistant/diagnostics/tmp-other']);
    t.is(await f.adapter.read('.pkm-assistant/diagnostics/tmp-other/keep.txt'), 'keep');
});

test('cleanup failure remains visible and does not turn the report green', async t => {
    const f = fixture(); f.adapter.rmdir = async () => { throw new Error('rmdir denied'); };
    const result = await runDeviceDiagnostics(f.input);
    t.is(result.errors, 1);
    t.regex(await f.adapter.read(result.path), /\| fs.rmdir \| ERROR \| 0 \| Class: Error; code: unknown \|/);
});

test('read-back mismatch is an error even if adapter write resolved', async t => {
    const f = fixture();
    f.adapter.append = async () => {};
    const result = await runDeviceDiagnostics(f.input);
    t.is(result.errors, 1);
    t.regex(await f.adapter.read(result.path), /\| fs.append \| ERROR \| 0 \| Read-back verification failed \|/);
});


const privateMessage = 'kuba@example.com /storage/emulated/0/Documents/Mój Vault/prywatna notatka.md '
    + 'content://documents/Mój%20Vault/prywatna%20notatka.md Cookie: session=abc '
    + 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz \\Users\\Kuba\\prywatna.md';

test('adapter messages never enter the saved report; class and EACCES survive literally', async t => {
    const f = fixture();
    f.adapter.rename = async () => { throw Object.assign(new Error(privateMessage), { code: 'EACCES' }); };
    const report = await runDeviceDiagnostics(f.input);
    const saved = await f.adapter.read(report.path);
    t.is(saved, report.markdown);
    t.deepEqual(report.checks.find(c => c.name === 'fs.rename'), {
        name: 'fs.rename', status: 'error', ms: 0, detail: 'Class: Error; code: EACCES',
    });
    t.is(report.errors, 1);
    t.true(saved.includes('| fs.rename | ERROR | 0 | Class: Error; code: EACCES |'));
    for (const output of [saved, report.markdown, JSON.stringify(report.checks)]) {
        for (const secret of ['kuba', 'example.com', '/storage', 'content://', 'prywatna', 'Vault', 'session=', 'sk-ant', '\\Users']) t.false(output.includes(secret), secret);
    }
    t.deepEqual([...f.files.keys()], [report.path]);
});

for (const bad of ['Error private', 'x'.repeat(200), 'Error\n', 'Cookie: session=abc']) {
    test(`adapter class and code reject unknown literals: ${JSON.stringify(bad.slice(0, 24))}`, async t => {
        const f = fixture();
        f.adapter.rename = async () => { throw { name: bad, code: bad, message: privateMessage }; };
        const report = await runDeviceDiagnostics(f.input);
        t.is(report.checks.find(c => c.name === 'fs.rename')?.detail, 'Class: unknown; code: unknown');
        t.true((await f.adapter.read(report.path)).includes('| fs.rename | ERROR | 0 | Class: unknown; code: unknown |'));
    });
}

for (const key of ['name', 'code']) for (const getter of [false, true]) {
    test(`adapter rejects token-shaped secret in ${getter ? 'getter' : 'property'} ${key}`, async t => {
        const f = fixture();
        const error = { name: 'Error', code: 'EACCES' };
        Object.defineProperty(error, key, getter ? { get: () => 'reviewsession849201' } : { value: 'reviewsession849201' });
        f.adapter.rename = async () => { throw error; };
        const report = await runDeviceDiagnostics(f.input);
        const expected = key === 'name'
            ? '| fs.rename | ERROR | 0 | Class: unknown; code: EACCES |'
            : '| fs.rename | ERROR | 0 | Class: Error; code: unknown |';
        for (const output of [await f.adapter.read(report.path), report.markdown]) {
            t.is(output.split('\n').find(row => row.startsWith('| fs.rename |')), expected);
            t.false(output.includes('reviewsession849201'));
        }
    });
}

for (const [name, code, expected] of [
    ['TypeError', 'ENOENT', 'Class: TypeError; code: ENOENT'],
    ['DOMException', 0, 'Class: DOMException; code: 0'],
    ['QuotaExceededError', 22, 'Class: QuotaExceededError; code: 22'],
    ['Error', 999, 'Class: Error; code: 999'],
    ['Error', -1, 'Class: Error; code: unknown'],
    ['Error', 1000, 'Class: Error; code: unknown'],
    ['Error', 1.5, 'Class: Error; code: unknown'],
    ['Error', NaN, 'Class: Error; code: unknown'],
    ['Error', Infinity, 'Class: Error; code: unknown'],
    ['Error', '22', 'Class: Error; code: unknown'],
    ['Error', 'enoent', 'Class: Error; code: unknown'],
    ['error', 'EACCES', 'Class: unknown; code: EACCES'],
    ['ENOENT', 'Error', 'Class: unknown; code: unknown'],
    ['HttpTransportError', 'transport', 'Class: HttpTransportError; code: transport'],
    ['HttpTransportError', 'timeout', 'Class: HttpTransportError; code: timeout'],
    ['HttpTransportError', 'aborted', 'Class: HttpTransportError; code: aborted'],
] as const) {
    test(`adapter dictionaries and numeric code boundary: ${name}/${code}`, async t => {
        const f = fixture();
        f.adapter.rename = async () => { throw { name, code }; };
        const report = await runDeviceDiagnostics(f.input);
        for (const output of [await f.adapter.read(report.path), report.markdown]) {
            t.is(output.split('\n').find(row => row.startsWith('| fs.rename |')),
                `| fs.rename | ERROR | 0 | ${expected} |`);
        }
    });
}

for (const locale of ['pl', 'en'] as const) for (const key of ['type', 'code']) for (const status of [401, 200]) {
    test.serial(`saved ${locale} report rejects provider ${key} secret through production Anthropic HTTP ${status}`, async t => {
        setLocale(locale);
        try {
            const f = fixture();
            const payload = JSON.stringify({ type: 'error', error: { [key]: 'sk-ant-api03-abcdefghijklmnopqrstuvwx' } });
            const transport = new FetchStreamTransport(async () => new Response(
                status === 200 ? `event: error\ndata: ${payload}\n\n` : payload, { status }));
            f.input.consent = async () => true;
            // No key in settings or context: exact-secret redaction cannot hide a dictionary failure.
            f.input.connection = () => probeConnection(CHAT_PROVIDERS.anthropic, { modelId: 'test', log }, transport, new AbortController().signal);
            const report = await runDeviceDiagnostics(f.input);
            t.is(report.errors, 1);
            for (const output of [await f.adapter.read(report.path), report.markdown]) {
                const row = output.split('\n').find(line => line.startsWith('| model.connection |'));
                if (locale === 'pl') {
                    t.regex(row ?? '', /\| model.connection \| BŁĄD \| 0 \| HTTP: (401|200); porcje: 1;/);
                    t.regex(row ?? '', /; Typ błędu dostawcy: inny \|$/);
                } else {
                    t.regex(row ?? '', /\| model.connection \| ERROR \| 0 \| HTTP: (401|200); chunks: 1;/);
                    t.regex(row ?? '', /; Provider error type: other \|$/);
                }
                t.false(output.includes('sk-ant'));
            }
        } finally { setLocale('en'); }
    });
}

test('HTTP 401 through production transport records type and fixed explanation without the message', async t => {
    const f = fixture();
    let requests = 0;
    const transport = new FetchStreamTransport(async () => {
        requests++;
        return new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key sk-ant-SECRET for kuba@example.com"}}', { status: 401 });
    });
    f.input.consent = async () => true;
    f.input.connection = () => probeConnection(CHAT_PROVIDERS.anthropic, { modelId: 'claude-sonnet-5-5', log }, transport, new AbortController().signal);
    const report = await runDeviceDiagnostics(f.input);
    const saved = await f.adapter.read(report.path);
    t.is(saved, report.markdown); t.is(requests, 1); t.is(report.errors, 1);
    t.regex(saved, /\| model.connection \| ERROR \| 0 \| HTTP: 401; chunks: 1; first chunk \(ms\): \d+; total \(ms\): \d+; error: API key rejected; Kind: http; Provider error type: authentication_error \|/);
    for (const output of [saved, report.markdown]) for (const secret of ['sk-ant', 'kuba', 'example.com', 'x-api-key']) t.false(output.includes(secret), secret);
});

for (const model of ['private model for kuba@example.com', 'x'.repeat(101), 'valid\n', 'https://host.test?key=abc']) {
    test(`invalid model ID uses a fixed replacement: ${JSON.stringify(model.slice(0, 24))}`, async t => {
        const f = fixture(); f.input.facts['model.default'] = `anthropic/${model}`;
        const report = await runDeviceDiagnostics(f.input);
        t.is(report.checks.find(c => c.name === 'model.default')?.detail, 'Custom identifier');
        t.true((await f.adapter.read(report.path)).includes('| model.default | OK | 0 | Custom identifier |'));
    });
}

test('facts have a closed set of names and bounded values', async t => {
    const f = fixture();
    f.input.facts = {
        'plugin.version': '2.4.1', 'obsidian.apiVersion': '1.14.5',
        'plugin.build': 'aaa2cd5 2026-11-13T07:40:59.306Z watch',
        'navigator.userAgent': 'Mozilla/5.0\nż' + 'A'.repeat(301),
        'window.size': '412x880', 'vault.configDir': '.obsidian-mobile',
        'model.default': 'lm_studio/org/model:1.0_test-2', 'provider.openai': true,
        'plugin.startupMs': Infinity, 'agents.count': -1, 'tools.count': 'secret',
        'embedding.status': privateMessage, 'isPhone': privateMessage,
        'provider.private': true, 'private row name': privateMessage,
    };
    Object.assign(f.input.capabilities, { 'private capability': true });
    const report = await runDeviceDiagnostics(f.input);
    t.deepEqual(report.checks.slice(0, 13).map(c => [c.name, c.status, c.detail]), [
        ['plugin.version', 'ok', '2.4.1'], ['obsidian.apiVersion', 'ok', '1.14.5'],
        ['plugin.build', 'ok', 'aaa2cd5 2026-11-13T07:40:59.306Z watch'],
        ['navigator.userAgent', 'ok', 'Mozilla/5.0' + 'A'.repeat(287)],
        ['window.size', 'ok', '412x880'], ['vault.configDir', 'ok', '.obsidian-mobile'],
        ['model.default', 'ok', 'lm_studio/org/model:1.0_test-2'], ['provider.openai', 'ok', 'Key set: Yes'],
        ['plugin.startupMs', 'skipped', 'Unavailable'], ['agents.count', 'skipped', 'Unavailable'],
        ['tools.count', 'skipped', 'Unavailable'], ['embedding.status', 'skipped', 'Unavailable'], ['isPhone', 'skipped', 'Unavailable'],
    ]);
    t.false(report.markdown.includes('private')); t.false(report.markdown.includes('kuba'));
});

for (const dir of ['/storage/Vault/.obsidian', 'C:\\Users\\Kuba', 'a'.repeat(65)]) {
    test(`configDir rejects paths and overlong names: ${dir.slice(0, 24)}`, async t => {
        const f = fixture(); f.input.facts['vault.configDir'] = dir;
        const report = await runDeviceDiagnostics(f.input);
        t.is(report.checks.find(c => c.name === 'vault.configDir')?.detail, 'Unavailable');
        t.true((await f.adapter.read(report.path)).includes('| vault.configDir | SKIPPED | 0 | Unavailable |'));
    });
}

test('short settings secrets preserve report words; long and hydrated secrets are removed exactly', async t => {
    const f = fixture();
    const apiKeys = { short: 'conn', long: 'abcdefghijklmnopqrst' };
    Object.defineProperty(apiKeys, 'hydrated', { value: 'hydrated-secret-12345', enumerable: false });
    f.input.settings = { apiKeys };
    f.input.facts['navigator.userAgent'] = 'Engine abcdefghijklmnopqrst hydrated-secret-12345';
    f.input.facts['model.default'] = 'anthropic/claude-sonnet-5-5';
    const report = await runDeviceDiagnostics(f.input);
    for (const line of [
        '| plugin.version | OK | 0 | 2.4.1 |',
        '| model.default | OK | 0 | anthropic/claude-sonnet-5-5 |',
        '| model.connection | SKIPPED | 0 | No consent; no request sent |',
        '| navigator.userAgent | OK | 0 | Engine [REDACTED] [REDACTED] |',
    ]) t.is(report.markdown.split('\n').find(row => row === line), line);
    t.is(await f.adapter.read(report.path), report.markdown);
});

test('connection exceptions and huge adapter messages cannot become report text', async t => {
    const f = fixture(); f.input.consent = async () => true;
    f.input.connection = async () => { throw new Error(privateMessage); };
    f.adapter.rename = async () => { throw new Error(privateMessage + '/a'.repeat(50000)); };
    const report = await runDeviceDiagnostics(f.input);
    t.is(report.errors, 2);
    t.is(report.checks.find(c => c.name === 'model.connection')?.detail, 'No connection or CORS blocked the request');
    t.is(report.checks.find(c => c.name === 'fs.rename')?.detail, 'Class: Error; code: unknown');
    t.is(await f.adapter.read(report.path), report.markdown);
    t.false(report.markdown.includes('prywatna'));
});

test('report assembly with 30 settings secrets stays below 50 ms with scheduling headroom', async t => {
    const { renderDiagnosticMarkdown, secretFilter } = await import('./report.js');
    const f = fixture();
    const report = await runDeviceDiagnostics(f.input);
    const settings = { apiKeys: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [String(i), `diagnostic-secret-${i}-1234567890`])) };
    const durations: number[] = [];
    let output = '';
    // Median of warmed batches avoids attributing process scheduling/GC to assembly.
    for (let batch = 0; batch < 21; batch++) {
        const start = performance.now();
        for (let i = 0; i < 10; i++) output = renderDiagnosticMarkdown(report.checks, secretFilter(settings));
        if (batch > 0) durations.push((performance.now() - start) / 10);
    }
    const median = durations.sort((a, b) => a - b)[10];
    t.true(median < 50, `Median assembly: ${median.toFixed(3)} ms`);
    t.log(`Median assembly with 30 secrets: ${median.toFixed(3)} ms`);
    t.true(output.includes('| fs.rename | OK | 0 | Verified |'));
    t.true(output.includes('| model.connection | SKIPPED | 0 | No consent; no request sent |'));
});

for (const [kind, status, explanation] of [
    ['http', 401, 'API key rejected'], ['http', 403, 'API key rejected'],
    ['http', 404, 'Unknown model or address'], ['http', 429, 'Rate limit reached'],
    ['http', 500, 'Provider unavailable'], ['http', 503, 'Provider unavailable'],
    ['http', 400, 'HTTP request failed'], ['transport', null, 'No connection or CORS blocked the request'],
    ['timeout', null, 'Connection timed out'], ['aborted', null, 'Connection aborted'],
    ['invalid_stream', 200, 'The response is not a model stream'], ['empty_stream', 200, 'No stream chunks received'],
] as const) {
    test(`saved connection explanation: ${kind}/${status}`, async t => {
        const f = fixture(); f.input.consent = async () => true;
        f.input.connection = async () => ({ status: 'error', kind, httpStatus: status, providerErrorType: null, chunks: 0, firstChunkMs: null, totalMs: 12 });
        const report = await runDeviceDiagnostics(f.input);
        const expected = `HTTP: ${status ?? 'Unavailable'}; chunks: 0; first chunk (ms): Unavailable; total (ms): 12; error: ${explanation}; Kind: ${kind}`;
        t.is(report.checks.find(c => c.name === 'model.connection')?.detail, expected);
        t.true((await f.adapter.read(report.path)).includes(`| model.connection | ERROR | 0 | ${expected} |`));
    });
}

for (const bad of ['contains spaces', 'a'.repeat(200), 'Authentication_Error']) test(`unknown provider type has a fixed replacement in the complete report: ${bad.slice(0, 20)}`, async t => {
    const f = fixture(); f.input.consent = async () => true;
    f.input.connection = async () => ({ status: 'error', kind: 'http', httpStatus: 401, providerErrorType: bad, chunks: 1, firstChunkMs: 2, totalMs: 3 });
    const report = await runDeviceDiagnostics(f.input);
    t.is(report.checks.find(c => c.name === 'model.connection')?.detail,
        'HTTP: 401; chunks: 1; first chunk (ms): 2; total (ms): 3; error: API key rejected; Kind: http; Provider error type: other');
    t.is(await f.adapter.read(report.path), report.markdown);
    t.false(report.markdown.includes(bad));
});

test.serial('Polish report uses fixed localized errors and the custom identifier replacement', async t => {
    setLocale('pl');
    try {
        const f = fixture();
        f.input.facts['model.default'] = 'anthropic/private model';
        f.adapter.rename = async () => { throw Object.assign(new Error(privateMessage), { code: 'EACCES' }); };
        f.input.consent = async () => true;
        f.input.connection = async () => ({ status: 'error', kind: 'http', httpStatus: 401, providerErrorType: 'authentication_error', chunks: 1, firstChunkMs: 2, totalMs: 3 });
        const report = await runDeviceDiagnostics(f.input);
        t.is(await f.adapter.read(report.path), report.markdown);
        for (const expected of [
            '| model.default | OK | 0 | niestandardowy identyfikator |',
            '| fs.rename | BŁĄD | 0 | Klasa: Error; kod: EACCES |',
            '| model.connection | BŁĄD | 0 | HTTP: 401; porcje: 1; pierwsza porcja (ms): 2; razem (ms): 3; błąd: Klucz API odrzucony; Rodzaj: http; Typ błędu dostawcy: authentication_error |',
        ]) t.is(report.markdown.split('\n').find(line => line === expected), expected);
    } finally { setLocale('en'); }
});

test('invalid version, build, window and provider cannot introduce free text', async t => {
    const f = fixture();
    f.input.facts = {
        'plugin.version': privateMessage, 'obsidian.apiVersion': '1.14.5\n',
        'plugin.build': privateMessage, 'window.size': '412x880 secret',
        'model.default': 'unknown/test', 'provider.openai': privateMessage,
    };
    const report = await runDeviceDiagnostics(f.input);
    t.deepEqual(report.checks.slice(0, 6).map(c => [c.name, c.status, c.detail]), [
        ['plugin.version', 'skipped', 'Unavailable'], ['obsidian.apiVersion', 'skipped', 'Unavailable'],
        ['plugin.build', 'skipped', 'Unavailable'], ['window.size', 'skipped', 'Unavailable'],
        ['model.default', 'ok', 'Custom identifier'], ['provider.openai', 'skipped', 'Unavailable'],
    ]);
    t.is(await f.adapter.read(report.path), report.markdown);
    t.false(report.markdown.includes('kuba'));
});
