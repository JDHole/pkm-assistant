import test from 'ava';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { mergeBrainConflict, readBrainContent } from './brainConflict.js';
import { AgentMemory, type MemoryVaultAdapterLike } from './AgentMemory.js';
import { setLocale } from '../../core/i18n/index.js';

test.before(() => { setLocale('pl'); });

const styles = ['merge', 'diff3', 'zdiff3'] as const;
type Style = typeof styles[number];
function gitMerge(dir: string, style: Style, base: string, ours: string, theirs: string) {
    for (const [name, text] of Object.entries({ base, ours, theirs })) writeFileSync(join(dir, name), text);
    const result = spawnSync('git', ['merge-file', '-p', ...(style === 'merge' ? [] : [`--${style}`]),
        '-L', 'ours', '-L', 'base', '-L', 'theirs', join(dir, 'ours'), join(dir, 'base'), join(dir, 'theirs')], { encoding: 'utf8' });
    if (result.error || result.status === null || result.status < 0 || result.status > 127) {
        throw result.error ?? new Error(result.stderr);
    }
    return { conflicts: result.status, text: result.stdout };
}
function setup(content: string) {
    const path = '.pkm-assistant/agents/tester/memory/brain.md';
    const files = new Map([[path, content]]);
    const adapter: MemoryVaultAdapterLike = {
        async read(p) { if (!files.has(p)) throw new Error('missing'); return files.get(p)!; },
        async write(p, text) { files.set(p, text); },
        async exists(p) { return files.has(p) || p === path.slice(0, -3); },
        async list() { return { files: [], folders: [] }; },
        async mkdir() { /* in-memory directories */ },
    };
    const memory = new AgentMemory({ adapter }, 'Tester');
    memory._structureEnsured = true;
    return { memory, path, files };
}

for (const style of styles) {
    test(`D3b ${style}: new current section cannot capture manual User additions; two rebuilds`, async t => {
        const dir = mkdtempSync(join(process.cwd(), '.d3b-git-'));
        try {
            const conflict = gitMerge(dir, style, '# Tester\n', '# Tester\n## User\nRęczny A\n',
                '# Tester\n## Na teraz: User\n- Zadanie\n## User\nRęczny B\n');
            t.is(conflict.conflicts, 1);
            t.deepEqual(mergeBrainConflict(conflict.text), {
                kind: 'merged', text: '# Tester\n## Na teraz: User\n- Zadanie\n## User\nRęczny A\nRęczny B\n',
            });
            const s = setup(conflict.text);
            const expected = '# Tester\n\n## Na teraz: User\n- Zadanie\n\n## Bieżące\n\n## User\nRęczny A\nRęczny B\n\n## Preferencje\n\n## Workflow\n\n## Projekty i referencje\n';
            t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: true, content: expected });
            t.is(s.files.get(s.path), expected);
            t.deepEqual([...s.files].filter(([p]) => p.startsWith('.pkm-assistant/backups/')).map(([, text]) => text), [conflict.text]);
            t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: false, content: expected });
            t.is(s.files.get(s.path), expected);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    for (const eol of ['\n', '\r\n']) {
        test(`D3b ${style} EOL=${JSON.stringify(eol)}: append after bare EOF keeps two lines`, async t => {
            const dir = mkdtempSync(join(process.cwd(), '.d3b-git-'));
            const convert = (text: string) => text.replace(/\n/g, eol);
            try {
                const conflict = gitMerge(dir, style,
                    convert('# Tester\n## Dawna\nIch\n## User\nKońcowy'),
                    convert('# Tester\n## Obca\nNasz\n## User\nKońcowy'),
                    convert('# Tester\n## User\nDodatkowy\n## Dawna\nIch\n## User\nKońcowy'));
                t.is(conflict.conflicts, 1);
                t.deepEqual(mergeBrainConflict(conflict.text), { kind: 'merged',
                    text: convert('# Tester\n## Obca\nNasz\n## User\nKońcowy\nDodatkowy\n## Dawna\nIch\n') });
                const s = setup(conflict.text);
                const expected = '# Tester\n\n## Bieżące\n\n## User\nKońcowy\nDodatkowy\n\n## Preferencje\n\n## Workflow\n\n## Projekty i referencje\n\n## Obca\nNasz\n\n## Dawna\nIch\n';
                t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: true, content: expected });
                t.is(s.files.get(s.path), expected);
                t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: false, content: expected });
            } finally { rmSync(dir, { recursive: true, force: true }); }
        });
    }
}

// Independent oracle: reconstruct both complete sides with git's labels, then
// track headings separately. No production parser or dedup helper is used here.
function conflictRows(text: string): { section: string; text: string }[] {
    let mode = 'common';
    let oursSection = '';
    let theirsSection = '';
    const required: { section: string; text: string }[] = [];
    for (const raw of text.replace(/^\uFEFF/, '').split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (line === '<<<<<<< ours') { mode = 'ours'; continue; }
        if (line === '||||||| base') { mode = 'base'; continue; }
        if (line === '=======') { mode = 'theirs'; continue; }
        if (line === '>>>>>>> theirs') { mode = 'common'; continue; }
        if (mode === 'base') continue;
        const heading = /^ {0,3}##[ \t]+/.test(line);
        if ((mode === 'ours' || mode === 'common') && heading) oursSection = line.trimEnd();
        if ((mode === 'theirs' || mode === 'common') && heading) theirsSection = line.trimEnd();
        if (line.trimEnd()) {
            if (mode === 'ours' || mode === 'common') required.push({ section: oursSection, text: line.trimEnd() });
            if (mode === 'theirs' || mode === 'common') required.push({ section: theirsSection, text: line.trimEnd() });
        }
    }
    return required;
}
function sectionRows(text: string): Set<string> {
    let section = '';
    const entries = new Set<string>();
    for (const raw of text.replace(/^\uFEFF/, '').split('\n')) {
        const line = raw.trimEnd();
        if (/^ {0,3}##[ \t]+/.test(line)) section = line;
        if (line) entries.add(JSON.stringify([section, line]));
    }
    return entries;
}

for (let batch = 0; batch < 3; batch++) test.serial(`D3c seeded edits batch ${batch + 1}: full section membership and row boundaries`, async t => {
    const dir = mkdtempSync(join(process.cwd(), '.d3b-property-'));
    let seed = 0x51ec710;
    const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
    const baseSections = [
        ['## User', 'Bazowy user', 'Wspólny'],
        ['## Na teraz: User', '- Zadanie bazowe'],
        ['## Obca', 'Opis bazowy', 'Wspólny'],
        ['## Workflow', 'Krok bazowy'],
    ];
    let conflicts = 0;
    let malformed = 0;
    let merged = 0;
    try {
        for (let pair = 0; pair < (batch + 1) * 240; pair++) {
            const eol = pair % 2 ? '\r\n' : '\n';
            const encode = (sections: string[][], finalEol: boolean) =>
                ['# Tester', ...sections.flat()].join(eol) + (finalEol ? eol : '');
            const edit = (side: string) => {
                const sections = baseSections.map(rows => [...rows]);
                const count = 1 + random(6);
                for (let operation = 0; operation < count; operation++) {
                    const at = random(sections.length);
                    switch (random(11)) {
                        case 0: sections[at].push(`Wpis ${side} ${pair} ${operation}`); break;
                        case 1: if (sections[at].length > 1) sections[at].splice(1 + random(sections[at].length - 1), 1); break;
                        case 2: sections.splice(at, 0, [
                            ['## Preferencje', '## Na teraz: Środowisko', '## Dodana'][random(3)],
                            `- Dodatek ${side} ${pair} ${operation}`,
                        ]); break;
                        case 3: sections.splice(random(sections.length), 0, ...sections.splice(at, 1)); break;
                        case 4: sections[at].push('Wspólny  '); break;
                        case 5: if (sections.length > 1) sections.splice(at, 1); break;
                        case 6: sections[at][0] = ['## User', '## Na teraz: User', '## Zmieniona'][random(3)]; break;
                        case 7: if (sections[at].length > 1) sections[random(sections.length)].push(...sections[at].splice(1, 1)); break;
                        case 8: sections[at].push(...sections[at].slice(1)); break;
                        case 9: sections[at] = sections[at].map(line => line + ' \t'); break;
                        case 10: sections.splice(at, 0, ['## Pusta']); break;
                    }
                }
                return encode(sections, random(2) === 0);
            };
            const base = encode(baseSections, pair % 3 !== 0);
            const ours = edit('A');
            const theirs = edit('B');
            if (pair < batch * 240) continue;
            for (const style of styles) {
                const result = gitMerge(dir, style, base, ours, theirs);
                if (!result.conflicts) continue;
                conflicts++;
                const actual = mergeBrainConflict(result.text);
                if (actual.kind === 'not-applicable') {
                    t.deepEqual(actual, { kind: 'not-applicable', malformed: true }, `pair ${pair} ${style}`);
                    malformed++;
                    t.fail(`valid conflict refused: pair ${pair} ${style}`);
                    continue;
                }
                merged++;
                const entries = sectionRows(actual.text);
                for (const entry of conflictRows(result.text)) {
                    t.is(entries.has(JSON.stringify([entry.section, entry.text])), true, `pair ${pair} ${style}: ${JSON.stringify(entry)}`);
                }
                // Every output row must be a whole input-side row, never two joined rows.
                const allowed = new Set(['', ...(ours + '\n' + theirs).split(/\r?\n/).map(line => line.trimEnd())]);
                for (const line of actual.text.split(/\r?\n/)) t.is(allowed.has(line.trimEnd()), true, `pair ${pair} ${style}: ${line}`);
                t.is(/^(?:<<<<<<<|=======|>>>>>>>|\|{7})(?: |\r?$)/m.test(actual.text), false);
            }
        }
        t.log(`240 pairs, 720 git merges, ${conflicts} conflicts, ${merged} merged, ${malformed} malformed`);
        t.is(conflicts > 500, true);
        t.is(merged, conflicts);
        t.is(malformed, 0); // No H1 edits or malformed syntax in this generator.
        await setImmediate(); // Let AVA report this batch before the next git batch.
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('D3c preserves both memberships of shared continuation instead of refusing', t => {
    const input = '# Tester\n## User\n<<<<<<< ours\nRęczny A\n=======\n## Dodana\nDodatek\n>>>>>>> theirs\nWspólny ogon\n';
    const expected = '# Tester\n## User\nRęczny A\nWspólny ogon\n## Dodana\nDodatek\nWspólny ogon\n';
    t.deepEqual(mergeBrainConflict(input), { kind: 'merged', text: expected });
    t.is(readBrainContent(input), expected);
});

for (const style of styles) for (const eol of ['\n', '\r\n']) {
    test(`D3c ${style} EOL=${JSON.stringify(eol)}: renamed heading preserves shared manual row through two rebuilds`, async t => {
        const dir = mkdtempSync(join(process.cwd(), '.d3c-git-'));
        const base = '# Tester\n## Old\nRęczny\n## User\nProfil\n'.replace(/\n/g, eol);
        try {
            const conflict = gitMerge(dir, style, base, base.replace('## Old', '## Na teraz: User'), base.replace('## Old', '## User'));
            t.is(conflict.conflicts, 1);
            t.deepEqual(mergeBrainConflict(conflict.text), { kind: 'merged',
                text: '# Tester\n## Na teraz: User\nRęczny\n## User\nProfil\nRęczny\n'.replace(/\n/g, eol) });
            const s = setup(conflict.text);
            const expected = '# Tester\n\n## Bieżące\n\n## User\nProfil\nRęczny\n\n## Preferencje\n\n## Workflow\n\n## Projekty i referencje\n';
            t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: true, content: expected });
            t.is(s.files.get(s.path), expected);
            t.deepEqual([...s.files].filter(([p]) => p.startsWith('.pkm-assistant/backups/')).map(([, text]) => text), [conflict.text]);
            t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: false, content: expected });
            t.is(s.files.get(s.path), expected);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
}

const hunk = (ours: string, theirs: string) => `<<<<<<< ours\n${ours}=======\n${theirs}>>>>>>> theirs\n`;

test('D3c last repeated section receives additions after its nonempty tail, with section-local dedup', t => {
    const ours = '# Tester  \nIntro A\n\n## User\nOne\nOne\n\n## Other\nTwo\n## User  \nLast\n\n';
    const theirs = '# Tester\nIntro B\n## User\nOne \t\nTwo\nTwo\n## Other\nThree\n';
    t.deepEqual(mergeBrainConflict(hunk(ours, theirs)), { kind: 'merged',
        text: '# Tester  \nIntro A\nIntro B\n\n## User\nOne\nOne\n\n## Other\nTwo\nThree\n## User  \nLast\nTwo\n\n' });
});

test('D3c whole new sections keep duplicate rows, repeated headers and empty sections after their predecessors', t => {
    const ours = '# Tester\n## User\nA\n## End\nZ\n';
    const theirs = '# Tester\n## User\nB\n## New  \n C  \n C  \n\n## Empty\n\n## New\nD\n## End\nZ\n';
    t.deepEqual(mergeBrainConflict(hunk(ours, theirs)), { kind: 'merged',
        text: '# Tester\n## User\nA\nB\n## New  \n C  \n C  \n\n## Empty\n\n## New\nD\n## End\nZ\n' });
});

for (const style of styles) {
    test(`D3c ${style}: differing H1 is malformed, matching H1 keeps preamble additions`, t => {
        const dir = mkdtempSync(join(process.cwd(), '.d3c-title-'));
        try {
            const conflict = gitMerge(dir, style, '# Tester\nIntro\n## User\nA\n',
                '# Tester A\nIntro A\n## User\nA\n', '# Tester B\nIntro B\n## User\nA\n');
            t.is(conflict.conflicts, 1);
            t.deepEqual(mergeBrainConflict(conflict.text), { kind: 'not-applicable', malformed: true });
            const matching = conflict.text.replace(/# Tester [AB]/g, '# Tester');
            t.deepEqual(mergeBrainConflict(matching), { kind: 'merged', text: '# Tester\nIntro A\nIntro B\n## User\nA\n' });
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
}

test('D3c independently tracks fences on full sides including a shared heading', t => {
    const input = '# Tester\n## Foreign\n' + hunk('```text\n', '') +
        '## User\nShared\n' + hunk('```\n', '') + '## End\nDone\n';
    t.deepEqual(mergeBrainConflict(input), { kind: 'merged',
        text: '# Tester\n## Foreign\n```text\n## User\nShared\n```\n## User\nShared\n## End\nDone\n' });
});

for (const eol of ['\n', '\r\n']) for (const finalEol of ['', eol]) {
    test(`D3c protected example retains BOM and exact fence bytes EOL=${JSON.stringify(eol)} final=${!!finalEol}`, t => {
        const example = ('## Foreign\n```text\n' + hunk('## Example\nA\n', '## Example\nB\n') + '```').replace(/\n/g, eol) + finalEol;
        const input = '\uFEFF' + ('# Tester\n## User\n' + hunk('A\n', 'B\n')).replace(/\n/g, eol) + example;
        t.deepEqual(mergeBrainConflict(input), { kind: 'merged',
            text: '\uFEFF' + '# Tester\n## User\nA\nB\n'.replace(/\n/g, eol) + example });
        t.deepEqual(mergeBrainConflict('\uFEFF# Tester' + eol + example), { kind: 'not-applicable' });
    });
}

test('D3c self-check refuses residual markers and fence-induced membership loss', t => {
    for (const input of [
        '# Tester\n## User\n' + hunk('A\n', 'B\n') + '=======\n',
        '# Tester\n## Foreign\n' + hunk('A\n', '```\nB\n') + '## End\nDone\n',
        '<<<<<<<\r\nA\r\n',
    ]) t.deepEqual(mergeBrainConflict(input), { kind: 'not-applicable', malformed: true });
});
