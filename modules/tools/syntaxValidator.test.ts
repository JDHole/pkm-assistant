import test from 'ava';
import { parseDocument } from 'yaml';
import { MCPClient } from './MCPClient.js';
import { ToolRegistry } from './ToolRegistry.js';
import { AccessGuard, PermissionSystem } from '../../core/index.js';
import { checkSyntax } from './syntaxValidator.js';
import { createCheckSyntaxTool } from './CheckSyntaxTool.js';

test('JavaScript: script, module and async function body', t => {
    t.like(checkSyntax('const x = 1;', 'js'), { ok: true, mode: 'script' });
    t.like(checkSyntax('export const x = 1;', 'js'), { ok: true, mode: 'module' });
    t.like(checkSyntax('await work(); return 1;', 'js'), { ok: true, mode: 'async_function' });
    t.like(checkSyntax('const x = 1;\nconst y = ;', 'js'), { ok: false, problems: [{ line: 2, column: 11, type: 'syntax' }] });
});

test('JSON and YAML report nested duplicates and syntax errors', t => {
    t.like(checkSyntax('{"outer": {\n"x": 1,\n"x": 2}}', 'json'), { ok: false, problems: [{ line: 3, column: 1, firstLine: 2, path: 'outer.x', type: 'duplicate_key' }] });
    t.like(checkSyntax('{"x": }', 'json'), { ok: false, problems: [{ line: 1, column: 7, type: 'syntax' }] });
    t.like(checkSyntax('outer:\n  x: 1\n  x: 2', 'yaml'), { ok: false, problems: [{ line: 3, column: 3, type: 'duplicate_key' }] });
    t.is(checkSyntax('1: a\n"1": b', 'yaml').ok, true);
    t.like(checkSyntax('a:\n  x: 1\n y: 2', 'yaml'), { ok: false, problems: [{ type: 'syntax' }] });
});

test('Markdown locations include the full file', t => {
    const input = '---\na: 1\na: 2\n---\n```dataviewjs\nreturn 1;\n```\n```dataviewjs\nconst x = ;\n```';
    t.like(checkSyntax(input, 'markdown'), { ok: false, problems: [{ line: 3, column: 1, type: 'duplicate_key' }, { line: 9, column: 11, type: 'syntax' }] });
});

test('tool reads without executing code and rejects unsupported files', async t => {
    const app = { vault: { getAbstractFileByPath: () => null, cachedRead: async () => '', adapter: { read: async () => 'globalThis.__syntaxSideEffect = 1;' } } };
    const result = await createCheckSyntaxTool().execute({ path: 'x.js' }, app, {});
    t.like(result, { ok: true, kind: 'js', mode: 'script' });
    t.false(Object.hasOwn(globalThis, '__syntaxSideEffect'));
    t.like(await createCheckSyntaxTool().execute({ path: 'x.txt' }, app, {}), { success: false, error: 'Supported extensions: .js, .mjs, .cjs, .json, .yaml, .yml, .md.' });
});

test('MCP refuses a No-Go file before reading it', async t => {
    AccessGuard.setNoGoFolders(['Private']);
    try {
        let reads = 0;
        const app = { vault: { getAbstractFileByPath: () => null, cachedRead: async () => '', adapter: { read: async () => { reads++; return '{}'; } } } };
        const agent = { name: 'Tester', mcp_servers: ['*'], permissions: { guidance_mode: true } };
        const registry = new ToolRegistry(); registry.registerTool(createCheckSyntaxTool());
        const client = new MCPClient(app as never, { agentManager: { getAgent: () => agent, getActiveAgent: () => agent }, permissionSystem: new PermissionSystem(app.vault as never, {}) } as never, registry);
        const result = await client.executeToolCall({ name: 'check_syntax', arguments: { path: 'Private/secret.json' } }, 'Tester', { autonomy: 'yolo' });
        t.like(result, { isError: true });
        t.is(reads, 0);
    } finally { AccessGuard.setNoGoFolders([]); }
});


test('JSON diagnostics, depth, decoded duplicate names and CRLF positions', t => {
    t.like(checkSyntax('{"a":1,"\\u0061":2}', 'json'), { ok: false, problems: [{ type: 'duplicate_key', path: 'a', firstLine: 1 }] });
    t.like(checkSyntax('\r\n'.repeat(9) + '"bad\n"', 'json'), { problems: [{ line: 10, column: 5, message: 'Control character in string' }] });
    t.like(checkSyntax('"\\q"', 'json'), { problems: [{ line: 1, column: 3, message: 'Invalid escape' }] });
    t.like(checkSyntax('[1,]', 'json'), { problems: [{ message: 'Trailing comma' }] });
    t.like(checkSyntax('['.repeat(257) + '0' + ']'.repeat(257), 'json'), { problems: [{ message: 'JSON nesting depth limit exceeded', type: 'limit' }] });
    t.like(checkSyntax(' '.repeat(2097153), 'json'), { problems: [{ message: 'Input exceeds 2 MB limit', type: 'limit' }] });
});

test('large JSON remains responsive', t => {
    const input = '{' + Array.from({ length: 80000 }, (_, i) => `"key${i}":${i}`).join(',') + '}';
    const start = performance.now();
    t.true(checkSyntax(input, 'json').ok);
    t.true(performance.now() - start < 5000);
});

test('JS rejects wrapper escape, chooses furthest error and accepts hashbang', t => {
    t.false(checkSyntax('return 1;\n}\nasync function other(){', 'js').ok);
    t.like(checkSyntax('export const one=1;\nexport const two=2;\nexport const bad=;', 'js'), { problems: [{ line: 3, column: 18 }] });
    t.true(checkSyntax('\ufeff#!/usr/bin/env node\nreturn 1;', 'js').ok);
});

test('YAML aliases, multiple documents and merge keys', t => {
    t.like(checkSyntax('one: 1\n---\nkey: *missing', 'yaml'), { problems: [{ message: 'YAML alias resolution failed' }] });
    t.true(checkSyntax('base: &base {x: 1}\nobj:\n  <<: *base\n  <<: *base', 'yaml').ok);
    t.true(checkSyntax('<<: 1', 'yaml').ok);
});

test('Markdown validates container fences and unclosed fences with original columns', t => {
    t.like(checkSyntax('- item\n    ```dataviewjs\n    const a = ;\n    ```\n> > ~~~dataviewjs\n> > const b = ;\n> > ~~~', 'markdown'), { problems: [{ line: 3, column: 15 }, { line: 6, column: 15 }] });
    t.like(checkSyntax('```dataviewjs\nconst a = ;', 'markdown'), { problems: [{ line: 2, column: 11 }, { line: 1, message: 'Unclosed code block' }] });
});

test('tool failure and syntax results have distinct status', async t => {
    const app = { vault: { getAbstractFileByPath: () => null, cachedRead: async () => '', adapter: { read: async (path: string) => { if (path === 'missing.js') throw new Error('missing'); return 'const a = ;'; } } } };
    t.like(await createCheckSyntaxTool().execute({ path: 'missing.js' }, app, {}), { success: false, error: 'File not found: missing.js' });
    t.like(await createCheckSyntaxTool().execute({ path: 'bad.js' }, app, {}), { success: true, ok: false, problems: [{ line: 1, column: 11 }] });
});

test('tool stops between pages and refuses an oversized source after one read', async t => {
    let reads = 0;
    let source = ' '.repeat(30000);
    const app = { vault: { getAbstractFileByPath: () => null, cachedRead: async () => '', adapter: { read: async () => { reads++; return source; } } } };
    const context = { resultBudgetChars: 12000, effectiveResultBudgetChars: 12000, shouldAbort: () => reads > 0, authorizeFileRead: () => ({ allowed: true }), serializeFinalResult: JSON.stringify };
    t.like(await createCheckSyntaxTool().execute({ path: 'a.json' }, app, {}, context), { success: false, error: 'Operation cancelled' });
    t.is(reads, 1);
    reads = 0; source = ' '.repeat(2097153);
    const noAbort = { ...context, shouldAbort: () => false };
    t.like(await createCheckSyntaxTool().execute({ path: 'a.json' }, app, {}, noAbort), { success: false, error: 'Input exceeds 2 MB limit' });
    t.is(reads, 1);
});


test('regressions: parser boundaries and bounded diagnostics', t => {
    t.like(checkSyntax('var await = 1; return 2;', 'js'), { ok: false, problems: [{ line: 1, column: 5, message: "Cannot use 'await' as identifier inside an async function" }] });
    t.true(checkSyntax('return new.target;', 'js').ok);
    t.false(checkSyntax('? [*missing]\n: value', 'yaml').ok);
    t.false(checkSyntax('? {a: 1, a: 2}\n: value', 'yaml').ok);
    t.true(checkSyntax('? ' + '['.repeat(26) + '0' + ']'.repeat(26) + '\n: x', 'yaml').ok);
    const key = 'x'.repeat(170000);
    const result = checkSyntax(`{"${key}":1,"${key}":2}`, 'json');
    t.like(result, { ok: false, problems: [{ path_truncated: true }] });
    t.true(JSON.stringify(result).length < 16000);
    t.true(checkSyntax('- outer\n  - inner\n    > ```dataviewjs\n    > const a = 1;\n    > ```', 'markdown').ok);
    t.like(checkSyntax('- outer\n  - inner\n    > ```dataviewjs\n    > const a = ;\n    > ```', 'markdown'), { problems: [{ line: 4, column: 17 }] });
    t.true(checkSyntax('<!--\n```dataviewjs\nconst a = ;\n```\n-->', 'markdown').ok);
    t.true(checkSyntax('    ```dataviewjs\n    const a = ;\n    ```', 'markdown').ok);
    t.like(checkSyntax('> ```dataviewjs\nconst a = ;\n> ```', 'markdown'), { ok: false, skipped_blocks: 1, problems: [] });
    t.like(checkSyntax('> - outer\n>   - inner\n>     ```dataviewjs\n>     const a = ;\n>     ```', 'markdown'), { ok: false, skipped_blocks: 1, problems: [] });
});

test('tool checks metadata before reading and Stop interrupts a pending read', async t => {
    let reads = 0;
    const app = { vault: { getAbstractFileByPath: () => null, cachedRead: async () => '', adapter: {
        stat: async () => ({ size: 10 * 1024 * 1024 }), read: async () => { reads++; return '{}'; },
    } } };
    t.like(await createCheckSyntaxTool().execute({ path: 'large.json' }, app, {}), { success: false, error: 'Input exceeds 2 MB limit' });
    t.is(reads, 0);
    const controller = new AbortController();
    let rejectRead: (reason: Error) => void = () => {};
    const pendingApp = { vault: { getAbstractFileByPath: () => null, cachedRead: async () => '', adapter: {
        read: () => new Promise<string>((_resolve, reject) => { rejectRead = reject; }),
    } } };
    const task = createCheckSyntaxTool().execute({ path: 'a.json' }, pendingApp, {}, { abortSignal: controller.signal, authorizeFileRead: () => ({ allowed: true }) } as never);
    await Promise.resolve(); controller.abort();
    t.like(await task, { success: false, error: 'Operation cancelled' });
    rejectRead(new Error('late failure'));
});


test('YAML agrees with parser on 1000 deterministic mutations', t => {
    let seed = 1234567;
    const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    const bases = ['a: 1\nb: [one, two]\n', 'items:\n  - name: test\n  - name: other\n', 'root: {x: true, y: null}\n'];
    const chars = 'abc012 []{}:,-*&#\n';
    for (let i = 0; i < 1000; i++) {
        let value = bases[random(bases.length)];
        const at = random(value.length + 1);
        if (random(2)) value = value.slice(0, at) + chars[random(chars.length)] + value.slice(at);
        else value = value.slice(0, at) + value.slice(at + 1);
        const doc = parseDocument(value);
        let expected = doc.errors.length === 0;
        try { doc.toJS({ maxAliasCount: 100 }); } catch { expected = false; }
        t.is(checkSyntax(value, 'yaml').ok, expected, `mutation ${i}: ${JSON.stringify(value)}`);
    }
});


test('Markdown only checks dataviewjs and always reports counts', t => {
    t.like(checkSyntax('```js\nconst x = ;\n```\n```javascript\nconst y = ;\n```', 'markdown'), { ok: true, checked_blocks: 0, skipped_blocks: 0, problems: [] });
    t.like(checkSyntax('```js\nconst x = ;', 'markdown'), { ok: true, checked_blocks: 0, skipped_blocks: 0, problems: [] });
    t.like(checkSyntax('```dataviewjs\nreturn 1;\n```', 'markdown'), { ok: true, checked_blocks: 1, skipped_blocks: 0 });
    t.like(checkSyntax('> ```dataviewjs\nreturn 1;\n> ```', 'markdown'), { ok: false, checked_blocks: 0, skipped_blocks: 1, note: '1 blocks not checked due to ambiguous nesting' });
    t.like(checkSyntax(' '.repeat(2097153), 'markdown'), { checked_blocks: 0, skipped_blocks: 0 });
});

test.serial('YAML complex keys do not warn and duplicate messages omit locations', t => {
    const originalEmit = process.emitWarning, originalWarn = console.warn;
    let warnings = 0;
    process.emitWarning = (() => { warnings++; }) as typeof process.emitWarning;
    console.warn = () => { warnings++; };
    try {
        t.true(checkSyntax('? [a, b]\n: x', 'yaml').ok);
        t.true(checkSyntax('? {a: 1}\n: x', 'yaml').ok);
        t.is(warnings, 0);
    } finally { process.emitWarning = originalEmit; console.warn = originalWarn; }
    t.like(checkSyntax('a: 1\na: 2', 'yaml'), { problems: [{ line: 2, column: 1, message: 'Map keys must be unique', type: 'duplicate_key' }] });
});

test('valid dataviewjs survives deterministic container prefixes', t => {
    let seed = 8192;
    const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 4294967296 * n); };
    const parts = ['>', ' ', '-', '*', '1.', '\t'];
    for (let i = 0; i < 500; i++) {
        let prefix = ' '.repeat(random(9));
        for (let j = 0, n = random(5); j < n; j++) prefix += parts[random(parts.length)] + ' '.repeat(random(3));
        const result = checkSyntax(`${prefix}\`\`\`dataviewjs\n${prefix}return 1;\n${prefix}\`\`\``, 'markdown');
        t.false(result.problems.some(problem => problem.type === 'syntax'), `case ${i}: ${JSON.stringify(prefix)}`);
    }
    for (const prefix of ['', '> ', '> > ', '  ', '> \t']) {
        const result = checkSyntax(`${prefix}\`\`\`dataviewjs\n${prefix}return 1;\n${prefix}\`\`\``, 'markdown');
        t.is((result.checked_blocks ?? 0) + (result.skipped_blocks ?? 0), 1, JSON.stringify(prefix));
        t.deepEqual(result.problems, []);
    }
});
