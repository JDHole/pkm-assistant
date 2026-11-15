import test from 'ava';
import { AgentMemory } from './AgentMemory.js';
import { RetrievalEngine } from './RetrievalEngine.js';
import { BrainWriteError } from './brainConflictWrite.js';
import { MigrationV3 } from './MigrationV3.js';
import type { MemoryVaultAdapterLike } from './AgentMemory.js';

const root = '.pkm-assistant/agents/tester/memory';
const path = `${root}/brain.md`;
const healthy = '# Tester\n\n## Na teraz: User\n- Zadanie A\n\n## Na teraz: Środowisko\n\n## Bieżące\nRęczny wpis\n\n## User\n\n## Preferencje\n\n## Workflow\n\n## Projekty i referencje\n\n## Dodatki\nOpis A\n';
const conflict = healthy.replace('- Zadanie A', '<<<<<<< ours\n- Zadanie A\n=======\n- Zadanie B\n>>>>>>> theirs')
    .replace('Ręczny wpis', '<<<<<<< ours\nRęczny wpis\nWspólny\n=======\nRęczny drugi\nWspólny\n>>>>>>> theirs')
    .replace('Opis A', '<<<<<<< ours\nOpis A\n=======\nOpis B\n>>>>>>> theirs');
function setup(content: string) {
    const files = new Map([[path, content]]);
    const operations: string[] = [];
    const adapter: MemoryVaultAdapterLike = {
        async read(p) { operations.push(`read ${p}`); if (!files.has(p)) throw new Error('missing'); return files.get(p)!; },
        async write(p, value) { operations.push(`write ${p}`); files.set(p, value); },
        async exists(p) { operations.push(`exists ${p}`); return files.has(p) || p === `${root}/brain`; },
        async list(p) { operations.push(`list ${p}`); return { files: [...files.keys()].filter(f => f.startsWith(`${p}/`)), folders: [] }; },
        async mkdir(p) { operations.push(`mkdir ${p}`); },
    };
    const memory = new AgentMemory({ adapter }, 'Tester');
    memory._structureEnsured = true;
    return { files, operations, adapter, memory };
}

const clean = '# Tester\n\n## Na teraz: User\n- Zadanie A\n- Zadanie B\n\n## Na teraz: Środowisko\n\n## Bieżące\nRęczny wpis\nWspólny\nRęczny drugi\n\n## User\n\n## Preferencje\n\n## Workflow\n\n## Projekty i referencje\n\n## Dodatki\nOpis A\nOpis B\n';
const rebuilt = '# Tester\n\n## Na teraz: User\n- Zadanie A\n- Zadanie B\n\n## Bieżące\nRęczny wpis\nWspólny\nRęczny drugi\n\n## User\n\n## Preferencje\n\n## Workflow\n\n## Projekty i referencje\n\n## Dodatki\nOpis A\nOpis B\n';

test('D3 prompt read merges three zones without writes', async t => {
    const s = setup(conflict);
    const prompt = await s.memory.getMemoryContext();
    t.is(prompt, '## Long-term memory\n' + clean + '\n\n---\n\n**Notatki w brain/ (możesz wczytać przez memory_read):**\n- brak notatek');
    t.is(s.files.get(path), conflict);
    t.deepEqual(s.operations, [
        `exists ${path}`, `read ${path}`, `exists ${root}/brain`, `list ${root}/brain`,
        `list ${root}/summaries/L1`, `list ${root}/summaries/L2`, `list ${root}/summaries/L3`,
    ]);
});

test('D3 rebuild keeps both sides, verified original backup and clean manual .bak; second is a no-op', async t => {
    const s = setup(conflict);
    t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: true, content: rebuilt });
    t.is(s.files.get(path), rebuilt);
    t.is(s.files.get(`${path}.bak`), clean);
    const backups = [...s.files.keys()].filter(p => p.startsWith('.pkm-assistant/backups/'));
    t.is(backups.length, 1);
    t.regex(backups[0], /^\.pkm-assistant\/backups\/brain-tester-\d+\.md\.bak$/);
    t.is(s.files.get(backups[0]), conflict);
    s.operations.length = 0;
    t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: false, content: rebuilt });
    t.deepEqual(s.operations, [`exists ${path}`, `read ${path}`, `exists ${root}/brain`, `list ${root}/brain`]);
    t.is([...s.files.keys()].filter(p => p.startsWith('.pkm-assistant/backups/')).length, 1);
});

test('D3 healthy bytes and ordered I/O measured before implementation', async t => {
    const s = setup(healthy);
    t.is(await s.memory.getBrain(), healthy);
    const expected = '# Tester\n\n## Na teraz: User\n- Zadanie A\n\n## Bieżące\nRęczny wpis\n\n## User\n\n## Preferencje\n\n## Workflow\n\n## Projekty i referencje\n\n## Dodatki\nOpis A\n';
    t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: true, content: expected });
    t.is(s.files.get(path), expected);
    t.deepEqual(s.operations, [
        `exists ${path}`, `read ${path}`, `exists ${path}`, `read ${path}`,
        `exists ${root}/brain`, `list ${root}/brain`, `write ${path}.bak`, `write ${path}`,
    ]);
    t.is(s.files.get(`${path}.bak`), healthy);
});

for (const mode of ['throw', 'truncated', 'readback']) {
    test(`D3 backup ${mode} refuses overwrite`, async t => {
        const s = setup(conflict);
        const write = s.adapter.write;
        const read = s.adapter.read;
        s.adapter.write = async (p, data) => {
            if (p.startsWith('.pkm-assistant/backups/')) {
                if (mode === 'throw') throw new Error('synthetic failure');
                if (mode === 'truncated') data = data.slice(0, 10);
            }
            await write(p, data);
        };
        s.adapter.read = async p => {
            if (mode === 'readback' && p.startsWith('.pkm-assistant/backups/') && s.files.has(p)) throw new Error('readback failure');
            return read(p);
        };
        const error = await t.throwsAsync(s.memory.rebuildBrainIndex(), { instanceOf: BrainWriteError, message: 'Save failed' });
        t.is(error?.reason, 'backup-unavailable');
        t.is(s.files.get(path), conflict);
        t.is(s.operations.filter(op => op === `write ${path}`).length, 0);
    });
}

test('D3 pull during backup is preserved', async t => {
    const s = setup(conflict);
    const write = s.adapter.write;
    s.adapter.write = async (p, data) => {
        await write(p, data);
        if (p.startsWith('.pkm-assistant/backups/')) s.files.set(path, '# Tester\nNew external version\n');
    };
    const error = await t.throwsAsync(s.memory.rebuildBrainIndex(), { instanceOf: BrainWriteError, message: 'Save failed' });
        t.is(error?.reason, 'source-changed');
    t.is(s.files.get(path), '# Tester\nNew external version\n');
    t.is([...s.files.entries()].find(([p]) => p.startsWith('.pkm-assistant/backups/'))?.[1], conflict);
});

test('D3 conflicted read with missing headings does not repair at startup', async t => {
    const input = '# Tester\n## User\n<<<<<<< ours\n- A\n=======\n- B\n>>>>>>> theirs\n';
    const s = setup(input);
    t.is(await s.memory.getBrain(), '# Tester\n## User\n- A\n- B\n');
    t.is(s.files.get(path), input);
    t.deepEqual(s.operations, [`exists ${path}`, `read ${path}`]);
});

test('D3 rebuilt links reflect files, not either conflicted catalogue', async t => {
    const s = setup(conflict.replace('Ręczny wpis', 'Ręczny wpis\n- [[brain/missing.md]]'));
    s.files.set(`${root}/brain/reference_example.md`, '---\nname: Example\ntype: reference\ndescription: Example note\n---\nText\n');
    const expected = rebuilt.replace('## Projekty i referencje\n', '## Projekty i referencje\n- [[brain/reference_example.md]] \u2014 Example note\n');
    t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: true, content: expected });
    t.is(s.files.get(path), expected);
});

test('D3 Na teraz mutation preserves both sides before applying requested change', async t => {
    const s = setup(conflict);
    const expected = rebuilt.replace('- Zadanie B\n', '- Zadanie B\n- Zadanie C\n');
    t.deepEqual(await s.memory.writeNaTeraz({ section: 'user', add: 'Zadanie C' }), { changed: true, content: expected, trimmed: 0 });
    t.is(s.files.get(path), expected);
    t.is([...s.files.entries()].find(([p]) => p.startsWith('.pkm-assistant/backups/'))?.[1], conflict);
});

test('D3 RetrievalEngine keyword and listing use clean text without disk writes', async t => {
    const s = setup(conflict);
    const engine = new RetrievalEngine({ vault: { adapter: s.adapter }, agentMemory: s.memory });
    const result = await engine.runSearch({ scope: 'memory', query: 'Ręczny drugi', mode: 'keyword' });
    t.is(result.results[0]?.path, path);
    t.is(result.results[0]?.excerpt.includes('Ręczny drugi'), true);
    t.is(result.results[0]?.excerpt.includes('<<<<<<<'), false);
    const listing = await engine.runSearch({ scope: 'memory' });
    t.is(listing.results[0]?.title, 'brain');
    t.is(listing.results[0]?.excerpt.includes('<<<<<<<'), false);
    t.is(s.files.get(path), conflict);
    t.is(s.operations.filter(op => op.startsWith('write ')).length, 0);
});

test('D3 migration plans both sides and backs up raw conflict on write', async t => {
    const input = '# Tester\n## User\n<<<<<<< ours\n- Preferuje herbatę\n=======\n- Preferuje wodę\n>>>>>>> theirs\n';
    const s = setup(input);
    const migration = new MigrationV3(s.memory, { now: () => '2026-01-01' });
    const plan = migration.buildPlan(input);
    t.deepEqual(plan.notes.map(n => n.content), ['Preferuje herbatę', 'Preferuje wodę']);
    const result = await migration.applyPlan(plan, input);
    t.is(result.notesCreated.length, 2);
    t.is(s.files.get(result.notesCreated[0])?.includes('Preferuje herbatę'), true);
    t.is(s.files.get(result.notesCreated[1])?.includes('Preferuje wodę'), true);
    t.is(s.files.get(path)?.includes('<<<<<<<'), false);
    t.is([...s.files.entries()].find(([p]) => p.startsWith('.pkm-assistant/backups/'))?.[1], input);
});

for (const failure of ['throw', 'short', 'readback']) {
    test(`D3 repair write ${failure} restores original from verified copy`, async t => {
        const s = setup(conflict);
        const write = s.adapter.write;
        const read = s.adapter.read;
        let attempted = false;
        let failRead = false;
        s.adapter.write = async (p, data) => {
            if (p === path && !attempted) {
                attempted = true;
                await write(p, failure === 'readback' ? data : data.slice(0, 10));
                if (failure === 'throw') throw new Error('partial write');
                failRead = failure === 'readback';
                return;
            }
            await write(p, data);
        };
        s.adapter.read = async p => {
            if (p === path && failRead) { failRead = false; throw new Error('readback'); }
            return read(p);
        };
        const error = await t.throwsAsync(s.memory.rebuildBrainIndex(), { instanceOf: BrainWriteError, message: 'Save failed' });
        t.is(error?.reason, 'write-restored');
        t.is(s.files.get(path), conflict);
        t.is([...s.files.entries()].find(([p]) => p.startsWith('.pkm-assistant/backups/'))?.[1], conflict);
        t.is(s.operations.filter(op => op === `write ${path}`).length, 2);
    });
}

test.serial('D3 collision preserves older backup, including lying exists', async t => {
    const originalNow = Date.now;
    Date.now = () => 123456789;
    try {
        const s = setup(conflict);
        const older = '.pkm-assistant/backups/brain-tester-123456789.md.bak';
        s.files.set(older, 'Older synthetic backup');
        const exists = s.adapter.exists;
        s.adapter.exists = p => p === older ? Promise.resolve(false) : exists(p);
        t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: true, content: rebuilt });
        t.is(s.files.get(older), 'Older synthetic backup');
        t.is(s.files.get('.pkm-assistant/backups/brain-tester-123456789-1.md.bak'), conflict);
    } finally { Date.now = originalNow; }
});

test('D3 shared queue serializes repair and a second Na teraz writer', async t => {
    const s = setup(conflict);
    const second = new AgentMemory({ adapter: s.adapter }, 'Tester');
    second._structureEnsured = true;
    const results = await Promise.all([
        s.memory.writeNaTeraz({ section: 'user', add: 'Zadanie C' }),
        second.writeNaTeraz({ section: 'user', add: 'Zadanie D' }),
    ]);
    t.is(results[0].changed, true);
    t.is(results[1].changed, true);
    t.is(s.files.get(path), rebuilt.replace('- Zadanie B\n', '- Zadanie B\n- Zadanie C\n- Zadanie D\n'));
    t.deepEqual([...s.files.entries()].filter(([p]) => p.startsWith('.pkm-assistant/backups/')).map(([, data]) => data), [conflict]);
});

test('D3 conflict read preserves BOM/CRLF; rebuild uses existing index format and is idempotent', async t => {
    const input = '\uFEFF' + conflict.replace(/\n/g, '\r\n');
    const s = setup(input);
    t.is(await s.memory.getBrain(), '\uFEFF' + clean.replace(/\n/g, '\r\n'));
    t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: true, content: rebuilt });
    t.is([...s.files.entries()].find(([p]) => p.startsWith('.pkm-assistant/backups/'))?.[1], input);
    t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: false, content: rebuilt });
});

test('D3 healthy missing headings retains previous append order and I/O', async t => {
    const s = setup('# Tester\n## User\n- A\n');
    const expected = '# Tester\n## User\n- A\n\n## Current\n\n\n## Preferences\n\n\n## Workflow\n\n\n## Projects and references\n\n';
    t.is(await s.memory.getBrain(), expected);
    t.is(s.files.get(path), expected);
    t.deepEqual(s.operations, [`exists ${path}`, `read ${path}`, `write ${path}`]);
});

test('D3 legacy updateBrain repairs supplied conflict after verified backup', async t => {
    const s = setup(conflict);
    await s.memory.updateBrain(conflict);
    t.is(s.files.get(path), clean);
    t.is([...s.files.entries()].find(([p]) => p.startsWith('.pkm-assistant/backups/'))?.[1], conflict);
});

test('D3 healthy legacy updateBrain keeps one write and exact supplied bytes', async t => {
    const s = setup(healthy);
    await s.memory.updateBrain(healthy);
    t.is(s.files.get(path), healthy);
    t.deepEqual(s.operations, [`write ${path}`]);
});

test('D3 healthy direct applyPlan without original keeps previous bytes and ordered I/O', async t => {
    const s = setup(healthy);
    const statePath = `${root}/.state.json`;
    s.files.set(statePath, '{}\n');
    const migration = new MigrationV3(s.memory);
    const plan = migration.buildPlan('# Tester\n## User\n');
    t.deepEqual(await migration.applyPlan(plan), { notesCreated: [], deletedSections: ['User'] });
    t.is(s.files.get(path), '# Tester brain\n\n## Bieżące\n\n## User\n\n## Preferencje\n\n## Workflow\n\n## Projekty i referencje\n');
    t.deepEqual(s.operations, [`write ${path}`, `exists ${statePath}`, `read ${statePath}`]);
    t.is(s.files.get(statePath), '{}\n');
});

test('D3 rebuild preserves a foreign fenced example with fake managed headings byte for byte', async t => {
    const example = '## Przykład\n```text\n<<<<<<< ours\n## User\n- Example A\n=======\n## User\n- Example B\n>>>>>>> theirs\n```\n';
    const s = setup(conflict + '\n' + example);
    const expected = rebuilt + '\n' + example;
    t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: true, content: expected });
    t.is(s.files.get(path), expected);
    t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: false, content: expected });
    t.is([...s.files.entries()].find(([p]) => p.startsWith('.pkm-assistant/backups/'))?.[1], conflict + '\n' + example);
});

test('D3 failure to restore still leaves the verified original backup', async t => {
    const s = setup(conflict);
    const write = s.adapter.write;
    s.adapter.write = async (p, data) => {
        if (p === path) { await write(p, 'Partial'); throw new Error('disk full'); }
        await write(p, data);
    };
    const error = await t.throwsAsync(s.memory.rebuildBrainIndex(), { instanceOf: BrainWriteError });
    t.is(error?.reason, 'restore-failed');
    t.is(s.files.get(path), 'Partial');
    t.is([...s.files.entries()].find(([p]) => p.startsWith('.pkm-assistant/backups/'))?.[1], conflict);
});

test('D3 legacy sections parser receives both sides without marker items', t => {
    const s = setup(conflict);
    const result = s.memory._parseBrainSections(conflict);
    t.is(result.header, '# Tester');
    t.deepEqual(result.sections.get('## Bieżące'), ['Ręczny wpis', 'Wspólny', 'Ręczny drugi']);
    t.deepEqual(result.sections.get('## Dodatki'), ['Opis A', 'Opis B']);
    t.deepEqual(result.sections.get('## Na teraz: User'), ['- Zadanie A', '- Zadanie B']);
});

test('D3 generated descriptions cannot be mistaken for protected code placeholders', async t => {
    const example = '## Przykład\n```\n<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n```\n';
    const s = setup(conflict + '\n' + example);
    s.files.set(`${root}/brain/reference_example.md`, '---\nname: Example\ntype: reference\ndescription: PKM_BRAIN_FENCE_0\n---\nText\n');
    const expected = rebuilt.replace('## Projekty i referencje\n', '## Projekty i referencje\n- [[brain/reference_example.md]] \u2014 PKM_BRAIN_FENCE_0\n') + '\n' + example;
    t.deepEqual(await s.memory.rebuildBrainIndex(), { changed: true, content: expected });
    t.is(s.files.get(path), expected);
});
