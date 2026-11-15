import test from 'ava';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mergeBrainConflict, readBrainContent } from './brainConflict.js';
import { log } from '../../core/utils/Logger.js';

const hunk = (ours: string, theirs: string, base?: string) =>
    `<<<<<<< ours\n${ours}${base === undefined ? '' : `||||||| base\n${base}`}=======\n${theirs}>>>>>>> theirs\n`;
for (const heading of ['## Na teraz: User', '## Bieżące', '## Dodatki']) {
    test(`D3 union in ${heading}, trailing whitespace and section-local dedup`, t => {
        const input = `# Tester\n${heading}\nWspólny\n` + hunk('- A\nWspólny  \n', '- B\nWspólny\n- A\t\n') + '## Inna\n- B\n';
        t.deepEqual(mergeBrainConflict(input), { kind: 'merged', text: `# Tester\n${heading}\nWspólny\n- A\nWspólny  \n- B\n## Inna\n- B\n` });
    });
}

test('D3 repeated H1/H2 and multiple sections keep additions in their own section', t => {
    const input = hunk('# Tester\n## User\n- A\n## Dodatki\nOpis A\n', '# Tester\n## User\n- B\n## Dodatki\nOpis B\n');
    t.deepEqual(mergeBrainConflict(input), { kind: 'merged', text: '# Tester\n## User\n- A\n- B\n## Dodatki\nOpis A\nOpis B\n' });
});

test('D3 dedup also sees common lines following a hunk and other hunks', t => {
    const input = '# Tester\n## User\n' + hunk('- A\n', '- B\n- C\n') + '- C\n' + hunk('- D\n', '- B\n- E\n');
    t.deepEqual(mergeBrainConflict(input), { kind: 'merged', text: '# Tester\n## User\n- A\n- C\n- D\n- B\n- E\n' });
});
for (const newline of ['\n', '\r\n']) for (const bom of ['', '\uFEFF']) {
    test(`D3 diff3 preserves BOM=${!!bom}, CRLF=${newline.length === 2}`, t => {
        const input = bom + ('# Tester\n## User\n' + hunk('- A\n', '- B\n', '- Stare\n')).replace(/\n/g, newline);
        t.deepEqual(mergeBrainConflict(input), { kind: 'merged', text: bom + '# Tester\n## User\n- A\n- B\n'.replace(/\n/g, newline) });
    });
}
for (const fence of ['```', '~~~~']) for (const heading of ['## Przykład', '##\tPrzykład', '  ## Przykład']) {
    test(`D3 foreign ${JSON.stringify(heading)} ${fence} example and mixed file bypass repair`, t => {
        const example = `${heading}\n${fence}text\n` + hunk('## User\n- A\n', '## User\n- B\n') + `${fence}\n`;
        t.deepEqual(mergeBrainConflict(example), { kind: 'not-applicable' });
        const mixed = '# Tester\n## User\n' + hunk('- A\n', '- B\n') + example;
        t.deepEqual(mergeBrainConflict(mixed), { kind: 'not-applicable' });
        t.is(readBrainContent(mixed), mixed);
        t.is(readBrainContent(example), example);
    });
}
for (const input of [
    '# Tester\n## User\n<<<<<<< ours\n- A\n',
    hunk(hunk('- A\n', '- B\n'), '- C\n'),
    hunk('- A\n', '- B\n') + '>>>>>>> stray\n',
]) {
    test(`D3 malformed ${JSON.stringify(input)} is not guessed`, t => {
        t.deepEqual(mergeBrainConflict(input), { kind: 'not-applicable', malformed: true });
    });
}

test.serial('D3 malformed read logs one content-free warning', t => {
    const warnings: unknown[][] = [];
    const warn = log.warn;
    log.warn = (...args) => { warnings.push(args); };
    try {
        const input = '## User\n<<<<<<< ours\nPrivate synthetic line\n';
        t.is(readBrainContent(input), input);
        t.deepEqual(warnings, [['AgentMemory', 'Brain conflict is incomplete or nested; keeping original text']]);
    } finally { log.warn = warn; }
});

test('D3 healthy and inline marker text are unchanged', t => {
    for (const input of ['\uFEFF# Tester\r\n## User\r\n- A  \r\n', '## User\nAn inline <<<<<<< example\n']) {
        t.deepEqual(mergeBrainConflict(input), { kind: 'not-applicable' });
        t.is(readBrainContent(input), input);
    }
});

for (const style of ['merge', 'diff3', 'zdiff3']) {
    test(`D3 real git merge-file ${style}: header, current, managed and foreign sections`, t => {
        const dir = mkdtempSync(join(process.cwd(), '.d3-git-'));
        try {
            const template = '# Tester\n\n## Na teraz: User\n- TASK\n\n## Bieżące\nMANUAL\n- [[brain/LINK.md]]\n\n## Dodatki\nDESCRIPTION\n';
            for (const side of ['ours', 'base', 'theirs']) {
                const suffix = side === 'ours' ? 'A' : side === 'theirs' ? 'B' : 'Old';
                writeFileSync(join(dir, side), template.replace('TASK', `Zadanie ${suffix}`).replace('MANUAL', `Ręczny ${suffix}`).replace('LINK', suffix).replace('DESCRIPTION', `Opis ${suffix}`));
            }
            const result = spawnSync('git', ['merge-file', '-p', ...(style === 'merge' ? [] : [`--${style}`]), '-L', 'ours', '-L', 'base', '-L', 'theirs', join(dir, 'ours'), join(dir, 'base'), join(dir, 'theirs')], { encoding: 'utf8' });
            t.is(result.status, style === 'merge' ? 1 : 3);
            t.deepEqual(mergeBrainConflict(result.stdout), { kind: 'merged', text: '# Tester\n\n## Na teraz: User\n- Zadanie A\n- Zadanie B\n\n## Bieżące\nRęczny A\n- [[brain/A.md]]\nRęczny B\n- [[brain/B.md]]\n\n## Dodatki\nOpis A\nOpis B\n' });
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
}

test('D3b an empty ours side appends at the end of its section', t => {
    t.deepEqual(mergeBrainConflict('# Tester\n## User\n' + hunk('', '- B\n') + '- C\n'), {
        kind: 'merged', text: '# Tester\n## User\n- C\n- B\n',
    });
});
