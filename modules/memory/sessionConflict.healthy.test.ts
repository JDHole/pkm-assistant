import test, { type ExecutionContext } from 'ava';
import { mock } from 'node:test';
import { AgentMemory, type MemoryVaultAdapterLike } from './AgentMemory.js';
import { parseDeviceId } from './sessionOwnership.js';
import { mergeSessionConflict, SessionConflictError } from './sessionConflict.js';
import { parseSessionFile } from './sessionParser.js';

const now = '2026-11-15T12:00:00.000Z';
const open = '<<<<<<< HEAD', close = '>>>>>>> branch', separator = '=======';
const example = `${open}\nLeft\n${separator}\nRight\n${close}`;
const fence = (text: string) => '```diff\n' + text + '\n```';
// Every row is synthetic: first-turn user, assistant and tool payloads. The last
// eight rows cover D7e refusals; D7f permits the three without a loose close.
const cases: Array<{ name: string; content: [string, string, string]; refuses?: true }> = [
    { name: 'minimal opening', content: ['Co oznacza ta linia?\n' + open, 'Odpowiedź', 'Wynik'] },
    { name: 'fenced opening', content: [fence(open), 'Odpowiedź', 'Wynik'] },
    { name: 'opening in diff', content: ['diff --git a/x b/x\n' + open, 'Odpowiedź', 'Wynik'] },
    { name: 'assistant opening', content: ['Pytanie', open, 'Wynik'] },
    { name: 'tool opening', content: ['Pytanie', 'Odpowiedź', open] },
    { name: 'closing', content: [close, 'Odpowiedź', 'Wynik'] },
    { name: 'fenced closing', content: [fence(close), 'Odpowiedź', 'Wynik'] },
    { name: 'tool closing', content: ['Pytanie', 'Odpowiedź', close] },
    { name: 'separator', content: [separator, 'Odpowiedź', 'Wynik'] },
    { name: 'assistant separator', content: ['Pytanie', separator, 'Wynik'] },
    { name: 'tool separator', content: ['Pytanie', 'Odpowiedź', separator] },
    { name: 'base', content: ['|||||||', 'Odpowiedź', 'Wynik'] },
    { name: 'fenced base', content: [fence('||||||| base'), 'Odpowiedź', 'Wynik'] },
    { name: 'full example', content: [example, 'Odpowiedź', 'Wynik'] },
    { name: 'assistant example', content: ['Pytanie', example, 'Wynik'] },
    { name: 'tool example', content: ['Pytanie', 'Odpowiedź', example] },
    { name: 'fenced example', content: [fence(example), 'Odpowiedź', 'Wynik'] },
    { name: 'ordinary diff', content: ['diff --git a/x b/x\n-old\n+new', 'Odpowiedź', 'Wynik'] },
    { name: 'status output', content: ['git status', 'Odpowiedź', 'On branch test\nnothing to commit'] },
    { name: 'inline opening', content: ['Znacznik <<<<<<< HEAD w zdaniu', 'Odpowiedź', 'Wynik'] },
    { name: 'opening then separator', content: [open, separator, 'Wynik'] },
    { name: 'opening then tool separator', content: [open, 'Odpowiedź', separator] },
    { name: 'opening then example', content: [open, example, 'Wynik'] },
    { name: 'opening then tool example', content: [open, 'Odpowiedź', example] },
    { name: 'opening then closing', content: [open, close, 'Wynik'], refuses: true },
    { name: 'opening then tool closing', content: [open, 'Odpowiedź', close], refuses: true },
    { name: 'three-message pseudo-block', content: [open, separator, close], refuses: true },
    { name: 'separator then new opening', content: [open + '\nLeft\n' + separator, open, 'Wynik'], refuses: true },
    { name: 'fenced pseudo-block', content: [fence(open), fence(separator), fence(close)], refuses: true },
    { name: 'two openings', content: [open, open, 'Wynik'] },
];

// Equal-width control payloads preserve stat sizes and all non-marker bytes.
const neutral = (text: string) => text.replace(/[<>=|]/g, 'x');

function disk(native: boolean, identified: boolean, crlf: boolean, frozen: boolean) {
    const path = '.pkm-assistant/agents/tester/memory/sessions/active/healthy.md';
    const header = '---\nagent: Tester\ntype: active_session\n---\n\n'.replace(/\n/g, crlf ? '\r\n' : '\n');
    const files = new Map([[path, header]]);
    const folders = new Set<string>();
    const mtimes = new Map<string, number>();
    const calls: unknown[][] = [];
    const adapter: MemoryVaultAdapterLike = {
        async read(p) {
            calls.push(['read', p]);
            if (!files.has(p)) throw new Error('missing');
            return files.get(p)!;
        },
        async write(p, text) { calls.push(['write', p, text]); files.set(p, text); mtimes.set(p, Date.now()); },
        async exists(p) { calls.push(['exists', p]); return files.has(p) || folders.has(p); },
        async mkdir(p) { calls.push(['mkdir', p]); folders.add(p); },
        async list(p) { calls.push(['list', p]); return { files: [], folders: [] }; },
        async remove(p) { calls.push(['remove', p]); files.delete(p); },
        async stat(p) {
            calls.push(['stat', p]);
            return files.has(p) ? { size: new TextEncoder().encode(files.get(p)!).length, mtime: mtimes.get(p) ?? 1 } : null;
        },
        ...(native ? { async append(p: string, text: string, options?: { mtime?: number }) {
            calls.push(['append', p, text, options]);
            files.set(p, files.get(p)! + text); mtimes.set(p, options?.mtime ?? Date.now());
        } } : {}),
    };
    const memory = new AgentMemory({ adapter }, 'Tester', {}, identified ? parseDeviceId('aaaaaaaaaaaaaaaa') : null);
    memory._structureEnsured = true;
    memory.setActiveSessionIdentity(path, null);
    const writer = frozen ? memory.createSessionWriter(path, null) : memory;
    return { files, path, header, calls, writer };
}

type Disk = ReturnType<typeof disk>;
function compare(t: ExecutionContext, actual: Disk, control: Disk): void {
    t.deepEqual([...actual.files].map(([p, text]) => [p, neutral(text)]), [...control.files]);
    t.deepEqual(actual.calls.map(call => call.map(value => typeof value === 'string' ? neutral(value) : value)), control.calls);
}

// Additional D7f reproductions: the assistant/tool puts the later full example in code.
const fencedExamples: typeof cases = [
    { name: 'opening then fenced example', content: [open, fence(example), 'Wynik'] },
    { name: 'opening then fenced tool example', content: [open, 'Odpowiedź', fence(example)] },
];

for (const native of [true, false]) for (const identified of [false, true])
for (const crlf of [false, true]) for (const frozen of [false, true]) for (const scenario of [...cases, ...fencedExamples]) {
    test.serial(`D7f healthy ${scenario.name}, native=${native}, id=${identified}, CRLF=${crlf}, frozen=${frozen}`, async t => {
        mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
        t.teardown(() => mock.timers.reset());
        const actual = disk(native, identified, crlf, frozen), control = disk(native, identified, crlf, frozen);
        const inputs = scenario.content.map((content, i) => ({
            type: ['user_message', 'agent_message', 'tool_result'][i],
            role: ['user', 'assistant', 'tool'][i],
            content: crlf ? content.replace(/\n/g, '\r\n') : content,
        })).concat([
            { type: 'user_message', role: 'user', content: 'Pytanie 2' },
            { type: 'agent_message', role: 'assistant', content: 'Odpowiedź 2' },
            { type: 'user_message', role: 'user', content: 'Pytanie 3' },
            { type: 'agent_message', role: 'assistant', content: 'Odpowiedź 3' },
        ]);
        let expected = actual.header;
        const messages: Array<{ role: string; content: string }> = [];
        let refused = false;
        for (const [index, input] of inputs.entries()) {
            const field = input.type === 'tool_result' ? 'result' : 'content';
            await actual.writer.appendToActiveSession({ type: input.type, [field]: input.content, timestamp: now });
            await control.writer.appendToActiveSession({ type: input.type, [field]: neutral(input.content), timestamp: now });
            // Independent literal oracle for persisted active event bytes.
            expected += `## ${now} — ${input.type.replaceAll('_', ' ')}\n\n**${field}:**\n\n${input.content}\n\n**seq:**\n\n${index + 1}\n\n`;
            t.is(actual.files.get(actual.path), expected);
            compare(t, actual, control);
            messages.push({ role: input.role, content: input.content.replace(/\r\n/g, '\n') });
            const kind = mergeSessionConflict(expected).kind;
            if (kind === 'unresolved') {
                t.is(scenario.refuses, true);
                const snapshot = [...actual.files];
                for (const write of [
                    () => actual.writer.appendToActiveSession({ type: 'user_message', content: 'Next', timestamp: now }),
                    () => actual.writer.saveSession(messages),
                    () => actual.writer.archiveActiveSession(actual.path),
                ]) {
                    // load mirrors the reader in the UI and invalidates a warm writer.
                    const loaded = await actual.writer.loadActiveSession(actual.path);
                    t.deepEqual(loaded.messages.map(m => ({ role: m.role, content: m.content })), messages);
                    await t.throwsAsync(write, { instanceOf: SessionConflictError });
                    t.deepEqual([...actual.files], snapshot);
                }
                refused = true;
                break;
            }
            t.is(kind, 'not-applicable');
            const loaded = await actual.writer.loadActiveSession(actual.path);
            await control.writer.loadActiveSession(control.path);
            t.deepEqual(loaded.messages.map(m => ({ role: m.role, content: m.content })), messages);
            compare(t, actual, control);
        }
        t.is(refused, scenario.refuses === true);
        if (refused) return;
        t.is(await actual.writer.saveSession(messages), actual.path);
        await control.writer.saveSession(messages.map(m => ({ ...m, content: neutral(m.content) })));
        t.deepEqual(mergeSessionConflict(actual.files.get(actual.path)!), { kind: 'not-applicable' });
        compare(t, actual, control);
        const archive = await actual.writer.archiveActiveSession(actual.path);
        const controlArchive = await control.writer.archiveActiveSession(control.path);
        t.is(archive, '.pkm-assistant/agents/tester/memory/sessions/archive/healthy.md');
        t.is(archive, controlArchive);
        const archived = actual.files.get(archive!)!;
        t.deepEqual(parseSessionFile(archived).messages, messages);
        // Archive is the existing LF transcript format, with literal payloads.
        t.is(archived.slice(archived.indexOf('## User')), messages.map(m =>
            `## ${m.role[0].toUpperCase() + m.role.slice(1)}\n${m.content}`).join('\n'));
        compare(t, actual, control);
    });
}

test.serial('D7e minimal reproduction: opening, answer, two more turns, save and archive', async t => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
    t.teardown(() => mock.timers.reset());
    const actual = disk(true, false, false, false), control = disk(true, false, false, false);
    const messages = [
        { role: 'user', content: 'Co oznacza ta linia?\n<<<<<<< HEAD' },
        { role: 'assistant', content: 'Odpowiedź 1' },
        { role: 'user', content: 'Pytanie 2' },
        { role: 'assistant', content: 'Odpowiedź 2' },
        { role: 'user', content: 'Pytanie 3' },
        { role: 'assistant', content: 'Odpowiedź 3' },
    ];
    for (const message of messages) {
        const type = message.role === 'user' ? 'user_message' : 'agent_message';
        await actual.writer.appendToActiveSession({ type, content: message.content, timestamp: now });
        await control.writer.appendToActiveSession({ type, content: neutral(message.content), timestamp: now });
        t.deepEqual(mergeSessionConflict(actual.files.get(actual.path)!), { kind: 'not-applicable' });
        compare(t, actual, control);
    }
    await actual.writer.saveSession(messages);
    await control.writer.saveSession(messages.map(m => ({ ...m, content: neutral(m.content) })));
    t.deepEqual((await actual.writer.loadActiveSession(actual.path)).messages.map(m => ({ role: m.role, content: m.content })), messages);
    await control.writer.loadActiveSession(control.path);
    compare(t, actual, control);
    const archive = await actual.writer.archiveActiveSession();
    await control.writer.archiveActiveSession();
    t.is(archive, '.pkm-assistant/agents/tester/memory/sessions/archive/healthy.md');
    t.deepEqual(parseSessionFile(actual.files.get(archive!)!).messages, messages);
    compare(t, actual, control);
});

for (const [name, body, kind] of [
    ['single example', '## User\n\n' + example + '\n\n## Assistant\n\nReply\n', 'not-applicable'],
    ['opening at EOF', '## User\n\n' + open + '\n\n## Assistant\n\nReply\n', 'not-applicable'],
    ['cross-message close', '## User\n\n' + open + '\n\n## Assistant\n\n' + close + '\n', 'unresolved'],
] as const) test(`D7e legacy without seq: ${name}`, async t => {
    const d = disk(true, false, false, false);
    const raw = d.header + body;
    d.files.set(d.path, raw);
    t.deepEqual(mergeSessionConflict(raw), { kind });
    if (kind === 'unresolved') {
        await t.throwsAsync(d.writer.appendToActiveSession({ type: 'user_message', content: 'NEXT', timestamp: now }),
            { instanceOf: SessionConflictError });
        t.is(d.files.get(d.path), raw);
    } else {
        await d.writer.appendToActiveSession({ type: 'user_message', content: 'NEXT', timestamp: now });
        t.is(d.files.get(d.path), raw + `## ${now} — user message\n\n**content:**\n\nNEXT\n\n**seq:**\n\n1\n\n`);
    }
});
