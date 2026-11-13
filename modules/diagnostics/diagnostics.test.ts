import test from 'ava';
import { runDeviceDiagnostics, diagnosticRedactor } from './diagnostics.js';
import type { DiagnosticAdapter, DiagnosticInput } from './diagnostics.js';
import { setLocale } from '../../core/i18n/index.js';

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
        connection: async () => { requests++; return { status: 'ok', detail: 'connected' }; },
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
    t.regex(await f.adapter.read(result.path), /\| fs.rename \| ERROR \| 0 \| rename denied \|/);
    t.is(result.errors, 1);
    t.deepEqual(result.checks.find(c => c.name === 'fs.rmdir'), { name: 'fs.rmdir', status: 'ok', ms: 0, detail: 'Temporary folder removed' });
    t.deepEqual([...f.files.keys()], [result.path]);
    t.deepEqual([...f.folders], ['', '.pkm-assistant', '.pkm-assistant/diagnostics']);
});

test('saved report removes literal, hydrated, encoded and short secrets plus system paths', async t => {
    const f = fixture();
    const keys = { openai: 'diagnostic-SECRET-123456', local: 'xyz' };
    Object.defineProperty(keys, 'anthropic', { value: 'hydrated-SECRET-987654', enumerable: false });
    f.input.settings = { pkmAssistant: { chat: { apiKeys: keys }, externalMcpServers: [{ headers: { Authorization: 'Bearer mcp-secret-777777' } }] } };
    f.input.facts['model.default'] = 'openai/test-model';
    f.input.consent = async () => true;
    f.input.connection = async () => ({ status: 'error', detail: 'bad diagnostic-SECRET-123456 hydrated-SECRET-987654 xyz Authorization: Bearer mcp-secret-777777\nENOENT /home/private/my vault/keys.txt\nFile C:\\Users\\Kuba\\private.txt' });
    const result = await runDeviceDiagnostics(f.input);
    const saved = await f.adapter.read(result.path);
    t.regex(saved, /\| model.default \| OK \| 0 \| openai\/test-model \|/);
    t.regex(saved, /\| model.connection \| ERROR/);
    t.true(saved.includes('[REDACTED]'));
    for (const value of ['diagnostic-SECRET-123456', 'hydrated-SECRET-987654', 'xyz', 'mcp-secret-777777', '/home/private', 'C:\\Users']) t.false(saved.includes(value), value);
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
    t.regex(await f.adapter.read(result.path), /\| fs.rmdir \| ERROR \| 0 \| rmdir denied \|/);
});

test('read-back mismatch is an error even if adapter write resolved', async t => {
    const f = fixture();
    f.adapter.append = async () => {};
    const result = await runDeviceDiagnostics(f.input);
    t.is(result.errors, 1);
    t.regex(await f.adapter.read(result.path), /\| fs.append \| ERROR \| 0 \| Read-back verification failed \|/);
});

test('redaction precedes truncation and covers URL credentials, encodings and UNC paths', t => {
    const redact = diagnosticRedactor({ apiKey: 'odd secret+/value' });
    t.is(redact('failure odd%20secret%2B%2Fvalue'), 'failure [REDACTED]');
    t.is(redact('connect https://user:pass@host.test/?token=hidden'), 'connect [URL]');
    t.is(redact('error \\\\server\\private\\file.txt'), 'error  [PATH]');
});
