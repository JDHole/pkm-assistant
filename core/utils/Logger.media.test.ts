import test from 'ava';
import { log } from './Logger.js';

test.serial('all logger levels redact media objects, serialized JSON and data URLs before console/file truncation', async t => {
    const output: unknown[] = [], files = new Map<string, string>();
    const original = { debug: console.debug, warn: console.warn, error: console.error, enabled: log._debug };
    console.debug = console.warn = console.error = (...args) => { output.push(args); };
    log._debug = true;
    log.initFileSink({ adapter: {
        exists: async path => files.has(path), mkdir: async () => {},
        write: async (path, text) => { files.set(path, text); },
        read: async path => files.get(path) ?? '',
    }, level: 'debug' });
    t.teardown(async () => { await log.disposeFileSink(); console.debug = original.debug; console.warn = original.warn; console.error = original.error; log._debug = original.enabled; });
    const bytes = 'U0VDUkVUSU1BR0U'.repeat(200);
    const raw = { kind: 'media', summary: 'safe summary', images: [{ mime: 'image/png', base64: bytes }], nested: { url: `data:image/png;base64,${bytes}` } };
    log.tool('future_media', {}, raw);
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        log[level]('media', JSON.stringify(raw), raw, JSON.stringify(raw), `data:image/png;base64,${bytes}`);
    }
    await log.disposeFileSink();
    const consoleText = JSON.stringify(output), fileText = [...files.values()].join('\n');
    for (const text of [consoleText, fileText]) {
        t.true(text.includes('safe summary'));
        t.false(text.includes('U0VDUkVU'), 'no truncated image prefix');
        t.false(text.includes('data:image/'));
    }
});

const bytes = 'U0VDUkVUSU1BR0U'.repeat(50);
const secret = 'SECRET1234567890XYZ';
const media = () => ({ summary: 'safe summary', nested: { base64: bytes, url: `data:image/png;base64,${bytes}`, api_key: secret } });
const cyclic = media() as ReturnType<typeof media> & { self?: unknown };
cyclic.self = cyclic;
const cases: Array<[string, unknown]> = [
    ['object', { summary: 'plain object', api_key: secret }], ['cycle', cyclic],
    ['undefined', undefined], ['null', null], ['number', 42],
    ['Error', new Error(`safe error data:image/png;base64,${bytes} api_key=${secret}`)],
    ['base64', media()], ['bigint', 123n], ['symbol', Symbol('symbol')],
    ['throwing hooks', { summary: 'safe summary', base64: bytes, toJSON() { throw new Error('no'); }, toString() { throw new Error('no'); } }],
    ['throwing getter', Object.defineProperty(media(), 'broken', { enumerable: true, get() { throw new Error('no'); } })],
    ['revoked proxy', (() => { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy; })()],
];
const methods: Record<string, (value: unknown) => void> = {
    debug: value => log.debug('test', value as string, value),
    info: value => log.info('test', value as string, value),
    warn: value => log.warn('test', value as string, value),
    error: value => log.error('test', value as string, value),
    tool: value => log.tool(value as string, value, value),
    model: value => log.model(value as string, value as string, value as string),
    timing: value => log.timing(value as string, value as string, value as number),
    group: value => log.group(value as string, value as string),
};
for (const [method, invoke] of Object.entries(methods)) {
    for (const [kind, value] of cases) {
        test.serial(`${method}: bezpieczne argumenty ${kind} na konsoli i w pliku`, async t => {
            const output: unknown[][] = [], files = new Map<string, string>();
            const original = { debug: console.debug, warn: console.warn, error: console.error, enabled: log._debug };
            console.debug = console.warn = console.error = (...args) => { output.push(args); };
            log._debug = true;
            log.initFileSink({ adapter: {
                exists: async path => files.has(path), mkdir: async () => {},
                write: async (path, text) => { files.set(path, text); }, read: async path => files.get(path) ?? '',
            }, level: 'debug' });
            t.teardown(async () => { await log.disposeFileSink(); Object.assign(console, { debug: original.debug, warn: original.warn, error: original.error }); log._debug = original.enabled; });
            t.notThrows(() => invoke(value));
            await log.disposeFileSink();
            const texts = [JSON.stringify(output)];
            if (['debug', 'info', 'warn', 'error'].includes(method)) {
                t.true(files.size > 0, 'wiadomość naprawdę zapisana');
                texts.push([...files.values()].join('\n'));
            }
            t.true(output.length > 0, 'wiadomość naprawdę zalogowana');
            for (const text of texts) {
                t.false(text.includes('U0VDUkVU'), 'redakcja przed skróceniem');
                t.false(text.includes('data:image/'));
                t.false(text.includes(secret));
                if (['base64', 'cycle'].includes(kind)) t.true(text.includes('safe summary'), 'obiekt opisany tekstem');
                if (kind === 'Error') t.true(text.includes('safe error'));
                if (kind === 'number') t.true(text.includes('42'));
            }
        });
    }
}

test.serial('dane nie uruchamiają hooków, a awaria konsoli/sinka nie wychodzi do wołającego', async t => {
    const original = { debug: console.debug, warn: console.warn, error: console.error, enabled: log._debug };
    t.teardown(async () => { await log.disposeFileSink(); Object.assign(console, { debug: original.debug, warn: original.warn, error: original.error }); log._debug = original.enabled; });
    log._debug = true;
    let hooks = 0;
    const hostile = { base64: bytes, toString() { hooks++; throw new Error('no'); }, toJSON() { hooks++; throw new Error('no'); } };
    const array = [hostile];
    array.map = () => { hooks++; throw new Error('no'); };
    console.debug = console.warn = console.error = () => { throw new Error('console unavailable'); };
    log.initFileSink({ adapter: {
        exists: () => { throw new Error('no'); }, read: async () => { throw new Error('no'); },
        write: () => { throw new Error('no'); },
    }, level: 'debug' });
    for (const invoke of Object.values(methods)) t.notThrows(() => invoke(array));
    await t.notThrowsAsync(() => log.disposeFileSink());
    t.is(hooks, 0);
});
