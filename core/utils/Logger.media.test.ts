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
