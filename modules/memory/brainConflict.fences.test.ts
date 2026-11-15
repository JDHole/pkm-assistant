import test from 'ava';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AgentMemory, type MemoryVaultAdapterLike } from './AgentMemory.js';
import { mergeBrainConflict, readBrainContent } from './brainConflict.js';
import { parseNaTerazSections } from './BrainIndex.js';
import { setLocale } from '../../core/i18n/index.js';
import { log } from '../../core/utils/Logger.js';

const root = '.pkm-assistant/agents/tester/memory';
const path = `${root}/brain.md`;
const index = '## Bieżące\n\n## User\n\n## Preferencje\n\n## Workflow\n\n## Projekty i referencje\n';
const example = '```text\n<<<<<<< example\nExample A\n=======\nExample B\n>>>>>>> example\n```\n';
const hunk = (ours: string, theirs: string) => `<<<<<<< ours\n${ours}=======\n${theirs}>>>>>>> theirs\n`;
function setup(input: string) {
    const files = new Map([[path, input]]);
    const operations: unknown[][] = [];
    const adapter: MemoryVaultAdapterLike = {
        async exists(p) { operations.push(['exists', p]); return files.has(p) || p === `${root}/brain`; },
        async read(p) { operations.push(['read', p]); if (!files.has(p)) throw new Error('missing'); return files.get(p)!; },
        async write(p, value) { operations.push(['write', p, value]); files.set(p, value); },
        async list(p) { operations.push(['list', p]); return { files: [], folders: [] }; },
        async mkdir(p) { operations.push(['mkdir', p]); },
    };
    const memory = new AgentMemory({ adapter }, 'Tester');
    memory._structureEnsured = true;
    return { memory, files, operations };
}
const reads = [['exists', path], ['read', path], ['exists', `${root}/brain`], ['list', `${root}/brain`]];
test.before(() => { setLocale('pl'); });

// These literal expectations were also executed against AgentMemory + BrainIndex
// from 5fe75ee. Legacy .bak remains; no D3 repair backup or warning is added.
for (const style of ['merge', 'diff3', 'zdiff3']) for (const eol of ['\n', '\r\n']) for (const bom of ['', '\uFEFF']) {
    for (const shape of ['closed', 'unclosed', 'shared']) {
        test.serial(`D3d baseline ${shape} ${style} CRLF=${eol.length === 2} BOM=${!!bom}`, async t => {
            const dir = mkdtempSync(join(process.cwd(), '.d3d-git-'));
            const warnings: unknown[][] = [];
            const warn = log.warn;
            log.warn = (...args) => { warnings.push(args); };
            try {
                const encode = (text: string) => bom + text.replace(/\n/g, eol);
                const base = shape === 'shared' ? '# Tester\n## Old\n' + example : '# Tester\n## Foreign\nBase\n';
                const ours = shape === 'shared' ? base.replace('## Old', '## Foreign')
                    : '# Tester\n## Foreign\n```text\nOurs\n## Na teraz: User\n- Task\n' + (shape === 'closed' ? '```\n' : '');
                const theirs = shape === 'shared' ? base.replace('## Old', '## User')
                    : '# Tester\n## Foreign\n~~~text\nManual\n## Na teraz: User\n- Task\n' + (shape === 'closed' ? '~~~\n' : '');
                for (const [name, value] of Object.entries({ base, ours, theirs })) writeFileSync(join(dir, name), encode(value));
                const git = spawnSync('git', ['merge-file', '-p', ...(style === 'merge' ? [] : [`--${style}`]),
                    '-L', 'ours', '-L', 'base', '-L', 'theirs', join(dir, 'ours'), join(dir, 'base'), join(dir, 'theirs')], { encoding: 'utf8' });
                t.is(git.status, 1);
                const input = git.stdout;
                t.deepEqual(mergeBrainConflict(input), { kind: 'not-applicable' });
                t.is(readBrainContent(input), input);
                // A BOM H1 has always used the localized fallback on ordinary rebuild.
                const header = bom ? '# Tester - Mózg (Długoterminowa pamięć)\n\n' : '# Tester\n\n';
                const retainsWhole = shape === 'unclosed' && style !== 'diff3';
                let expected: string;
                if (shape === 'shared') {
                    expected = header + '## Bieżące\n\n## User\n>>>>>>> theirs\n' + example +
                        '\n## Preferencje\n\n## Workflow\n\n## Projekty i referencje\n\n## Foreign\n' +
                        (style === 'merge' ? '=======\n' : '||||||| base\n\n## Old\n=======\n');
                } else {
                    expected = header + '## Na teraz: User\n- Task\n\n' + index + '\n## Foreign\n<<<<<<< ours\n```text\nOurs\n' +
                        (retainsWhole ? (style === 'zdiff3' ? '||||||| base\nBase\n' : '') + '=======\n~~~text\nManual\n>>>>>>> theirs\n' : '');
                }
                const s = setup(input);
                t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: true, content: expected });
                t.deepEqual(s.operations, [...reads, ...(!retainsWhole ? [['write', `${path}.bak`, input]] : []), ['write', path, expected]]);
                t.deepEqual([...s.files], [[path, expected], ...(!retainsWhole ? [[`${path}.bak`, input]] : [])]);
                t.deepEqual(warnings, []);
            } finally { log.warn = warn; rmSync(dir, { recursive: true, force: true }); }
        });
    }
}

for (const withExample of [false, true]) for (const eol of ['\n', '\r\n']) for (const bom of ['', '\uFEFF']) {
    test.serial(`D3d healthy fenced code baseline example=${withExample} CRLF=${eol.length === 2} BOM=${!!bom}`, async t => {
        const block = withExample ? example : '~~~text\nPlain example\n~~~\n';
        const input = bom + ('# Tester\n\n' + index + '\n## Foreign\n' + block).replace(/\n/g, eol);
        const expected = (bom ? '# Tester - Mózg (Długoterminowa pamięć)\n\n' : '# Tester\n\n') + index + '\n## Foreign\n' + block;
        const s = setup(input);
        const warnings: unknown[][] = [];
        const warn = log.warn;
        log.warn = (...args) => { warnings.push(args); };
        try {
            t.deepEqual(mergeBrainConflict(input), { kind: 'not-applicable' });
            t.is(readBrainContent(input), input);
            t.is(await s.memory.getBrain(), input);
            t.deepEqual(s.operations, [['exists', path], ['read', path]]);
            s.operations.length = 0;
            t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: input !== expected, content: expected });
            t.deepEqual(s.operations, [...reads, ...(input === expected ? [] : [['write', path, expected]])]);
            t.deepEqual([...s.files], [[path, expected]]);
            t.deepEqual(warnings, []);
        } finally { log.warn = warn; }
    });
}

test.serial('D3d pathological 160 KiB fence rows: below 100 ms, original read and legacy rebuild', async t => {
    const repeated = '```text `\n'.repeat(Math.ceil(160 * 1024 / 10));
    const input = '# Tester\n\n' + index + '\n## Foreign\n' + repeated + hunk('A\n', 'B\n');
    const s = setup(input);
    const warnings: unknown[][] = [];
    const warn = log.warn;
    log.warn = (...args) => { warnings.push(args); };
    try {
        const start = performance.now();
        t.deepEqual(mergeBrainConflict(input), { kind: 'not-applicable' });
        const elapsed = performance.now() - start;
        t.log(`${input.length} ASCII bytes, ${elapsed.toFixed(3)} ms`);
        t.true(elapsed < 100);
        t.is(readBrainContent(input), input);
        t.is(await s.memory.getBrain(), input);
        t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: false, content: input });
        t.deepEqual([...s.files], [[path, input]]);
        t.deepEqual(s.operations, [['exists', path], ['read', path], ...reads]);
        t.deepEqual(warnings, []);
    } finally { log.warn = warn; }
});

for (const fence of ['```bad`info', '   ~~~text', ' ```', '  ~~~~', '````unclosed']) {
    test(`D3d broad fence guard ${JSON.stringify(fence)} ignores validity, order and section`, t => {
        for (const input of [fence + '\n' + hunk('A\n', 'B\n'), hunk('A\n', 'B\n') + fence,
            '## User\n' + fence + '\n<<<<<<< incomplete\n']) {
            t.deepEqual(mergeBrainConflict(input), { kind: 'not-applicable' });
            t.is(readBrainContent(input), input);
        }
    });
}
for (const nonFence of ['    ```text', '\t~~~', '``text', 'prefix ```']) {
    test(`D3d fence guard boundary ${JSON.stringify(nonFence)}`, t => {
        const input = '# Tester\n## Foreign\n' + nonFence + '\n' + hunk('A\n', 'B\n');
        t.deepEqual(mergeBrainConflict(input), { kind: 'merged', text: '# Tester\n## Foreign\n' + nonFence + '\nA\nB\n' });
    });
}

for (const heading of ['\t## User', '    ## User', '##\u00a0Foreign', '\u00a0## Foreign']) {
    test(`D3d rebuild H2 boundary ${JSON.stringify(heading)} places additions in that section`, t => {
        const ours = '# Tester\n## Na teraz: User\n- Task\n' + heading + '\nManual A\n';
        const theirs = '# Tester\n' + heading + '\nManual B\n';
        t.deepEqual(mergeBrainConflict(hunk(ours, theirs)), { kind: 'merged', text: ours + 'Manual B\n' });
    });
}

test.serial('D3d second invariant refuses Na teraz loss hidden by section-row membership', t => {
    // U+2028 is allowed inside the foreign/manual H2 boundary, but not by the
    // existing Na teraz parser's dot capture. It therefore retains the prior key.
    const input = hunk('# Tester\n## Na teraz: User\n- A\n## Odd\u2028title\n- Shared\n',
        '# Tester\n## Na teraz: Środowisko\n- B\n## Odd\u2028title\n- Shared\n');
    const warnings: unknown[][] = [];
    const warn = log.warn;
    log.warn = (...args) => { warnings.push(args); };
    try {
        t.deepEqual(mergeBrainConflict(input), { kind: 'not-applicable', malformed: true });
        t.is(readBrainContent(input), input);
        t.deepEqual(warnings, [['AgentMemory', 'Brain conflict is incomplete or nested; keeping original text']]);
    } finally { log.warn = warn; }
});

test('D3d ordinary rebuild keeps more than ten Na teraz entries; explicit mutation still caps at ten', async t => {
    const ours = '# Tester\n## Na teraz: User\n' + Array.from({ length: 8 }, (_, i) => `- Task ${i + 1}\n`).join('');
    const theirs = '# Tester\n## Na teraz: User\n' + Array.from({ length: 8 }, (_, i) => `- Task ${i + 5}\n`).join('');
    const input = hunk(ours, theirs);
    const expected = ours + '- Task 9\n- Task 10\n- Task 11\n- Task 12\n';
    t.deepEqual(mergeBrainConflict(input), { kind: 'merged', text: expected });
    const s = setup(input);
    const first = await s.memory.rebuildBrainIndex();
    t.deepEqual(parseNaTerazSections(first.content), { user: ['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5', 'Task 6', 'Task 7', 'Task 8', 'Task 9', 'Task 10', 'Task 11', 'Task 12'], environment: [] });
    t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: false, content: first.content });
    const mutation = await s.memory.writeNaTeraz({ section: 'user', add: 'Task 13' });
    t.is(mutation.trimmed, 3);
    t.deepEqual(parseNaTerazSections(s.files.get(path)), { user: ['Task 4', 'Task 5', 'Task 6', 'Task 7', 'Task 8', 'Task 9', 'Task 10', 'Task 11', 'Task 12', 'Task 13'], environment: [] });
});
