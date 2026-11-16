import test from 'ava';
import { createDraftFileIndex } from './draftFileIndex.js';

test('F2h production index filters hidden get, files and children even when the vault exposes them', t => {
    const file = (path: string) => ({ path, stat: { size: 4, mtime: 7 } });
    const visible = file('Notes/Example.md'), dotted = file('Notes/example.v2.md');
    const hidden = [file('.hidden.md'), file('Notes/.hidden.md'), file('Notes/.hidden/secret.md'),
        file('.pkm-assistant/subagent-drafts/v1/draft-test/manifests/000001.json')];
    const hiddenFolder = { path: 'Notes/.hidden', children: [hidden[2]] };
    const privateFolder = { path: '.pkm-assistant/subagent-drafts', children: [hidden[3]] };
    const notes = { path: 'Notes', children: [visible, hidden[1], hiddenFolder, dotted] };
    const root = { path: '/', children: [hidden[0], notes, privateFolder] };
    const entries = [visible, dotted, ...hidden, hiddenFolder, privateFolder, notes];
    // Deliberately unfiltered: the production port owns all three visibility checks.
    const index = createDraftFileIndex({ vault: {
        getAbstractFileByPath: (path: string) => entries.find(entry => entry.path === path) ?? null,
        getRoot: () => root, getFiles: () => [hidden[0], visible, ...hidden.slice(1), dotted],
    } } as never);
    t.deepEqual(index.get('Notes/Example.md'), { kind: 'file', path: 'Notes/Example.md', bytes: 4, mtime: 7 });
    t.deepEqual(index.get('Notes/example.v2.md'), { kind: 'file', path: 'Notes/example.v2.md', bytes: 4, mtime: 7 });
    t.deepEqual([...hidden, hiddenFolder, privateFolder].map(entry => index.get(entry.path)), [null, null, null, null, null, null]);
    t.deepEqual(index.files(), [
        { kind: 'file', path: 'Notes/Example.md', bytes: 4, mtime: 7 },
        { kind: 'file', path: 'Notes/example.v2.md', bytes: 4, mtime: 7 },
    ]);
    const rootEntry = index.get(''), notesEntry = index.get('Notes');
    if (rootEntry?.kind !== 'folder' || notesEntry?.kind !== 'folder') throw new Error('Expected indexed folders');
    t.deepEqual(rootEntry.children().map(entry => [entry.kind, entry.path]), [['folder', 'Notes']]);
    t.deepEqual(notesEntry.children(), [
        { kind: 'file', path: 'Notes/Example.md', bytes: 4, mtime: 7 },
        { kind: 'file', path: 'Notes/example.v2.md', bytes: 4, mtime: 7 },
    ]);
});
