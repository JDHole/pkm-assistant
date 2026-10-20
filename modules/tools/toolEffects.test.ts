import test from 'ava';
import { checkEffectTargets, describeToolEffect } from './index.js';
import type { EffectTarget, ToolEffect } from './index.js';

test('write in each mode and vault_write alias describe the same vault target', t => {
    const cases = [
        { mode: 'create', expected: { tool: 'write', action: 'create', targets: [{ kind: 'vault-file', path: 'Notes/a.md' }], check: 'exists' } },
        { mode: 'replace', expected: { tool: 'write', action: 'replace', targets: [{ kind: 'vault-file', path: 'Notes/a.md' }], check: 'exists' } },
        { mode: 'patch', expected: { tool: 'write', action: 'patch', targets: [{ kind: 'vault-file', path: 'Notes/a.md' }], check: 'exists' } },
        { mode: 'append', expected: { tool: 'write', action: 'append', targets: [{ kind: 'vault-file', path: 'Notes/a.md' }], check: 'exists' } },
        { mode: 'prepend', expected: { tool: 'write', action: 'prepend', targets: [{ kind: 'vault-file', path: 'Notes/a.md' }], check: 'exists' } },
    ];
    for (const { mode, expected } of cases) {
        t.deepEqual(describeToolEffect('write', { path: 'Notes/a.md', mode }), expected);
    }
    t.deepEqual(describeToolEffect('vault_write', { path: 'Notes/a.md', mode: 'patch' }),
        describeToolEffect('write', { path: 'Notes/a.md', mode: 'patch' }));
});

test('delete describes an absent vault file', t => {
    t.deepEqual(describeToolEffect('delete', { path: 'Notes/a.md' }), {
        tool: 'delete', action: 'delete', targets: [{ kind: 'vault-file', path: 'Notes/a.md' }], check: 'absent'
    });
});

test('create_folder describes an existing vault folder', t => {
    t.deepEqual(describeToolEffect('create_folder', { path: 'Notes/new' }), {
        tool: 'create_folder', action: 'create_folder', targets: [{ kind: 'vault-folder', path: 'Notes/new' }], check: 'exists'
    });
});

test('memory_save persistent note uses result path', t => {
    t.deepEqual(describeToolEffect('memory_save', { fact: 'f' }, { path: 'brain/notes/f.md' }), {
        tool: 'memory_save', action: 'save', targets: [{ kind: 'memory-file', path: 'brain/notes/f.md' }], check: 'exists'
    });
});

test('ephemeral memory_save points to logical brain.md without checking it', t => {
    t.deepEqual(describeToolEffect('memory_save', { fact: 'f', ephemeral: true }), {
        tool: 'memory_save', action: 'save', targets: [{ kind: 'memory-file', path: 'brain.md' }], check: 'none'
    });
});

test('memory_delete uses only the returned path', t => {
    for (const args of [{ fact: 'gone' }, { fact: 'gone', path: 'wrong.md' }, { fact: 'gone', filename: 'wrong.md' }]) {
        t.deepEqual(describeToolEffect('memory_delete', args), {
            tool: 'memory_delete', action: 'delete', targets: [], check: 'none'
        });
    }
    t.deepEqual(describeToolEffect('memory_delete', { fact: 'gone', path: 'wrong.md', filename: 'wrong.md' },
        { path: 'brain/notes/gone.md' }), {
        tool: 'memory_delete', action: 'delete', targets: [{ kind: 'memory-file', path: 'brain/notes/gone.md' }], check: 'absent'
    });
});

test('artifact_create checks result path when present, otherwise has no checkable target', t => {
    t.deepEqual(describeToolEffect('artifact_create', {}, { id: 'art-1', path: '.pkm-assistant/artifacts/a.md' }), {
        tool: 'artifact_create', action: 'create', targets: [{ kind: 'vault-file', path: '.pkm-assistant/artifacts/a.md' }], check: 'exists'
    });
    t.deepEqual(describeToolEffect('artifact_create', {}, { id: 'art-1' }), {
        tool: 'artifact_create', action: 'create', targets: [], check: 'none'
    });
});

test('artifact_update preserves id and checks path only when result includes it', t => {
    t.deepEqual(describeToolEffect('artifact_update', { id: 'art-1' }), {
        tool: 'artifact_update', action: 'update', targets: [{ kind: 'vault-file', id: 'art-1' }], check: 'none'
    });
    t.deepEqual(describeToolEffect('artifact_update', { id: 'art-1' }, { artifact: { path: '.pkm-assistant/artifacts/a.md' } }), {
        tool: 'artifact_update', action: 'update', targets: [{ kind: 'vault-file', id: 'art-1', path: '.pkm-assistant/artifacts/a.md' }], check: 'exists'
    });
});

test('todo state-changing action targets the session todo list without checking', t => {
    t.deepEqual(describeToolEffect('todo', { action: 'check', blockId: 'k1' }), {
        tool: 'todo', action: 'check', targets: [{ kind: 'todo-list' }], check: 'none'
    });
});

test('todo list has no effect', t => {
    t.is(describeToolEffect('todo', { action: 'list' }), null);
    t.is(describeToolEffect('todo', { action: 'not-a-todo-action' }), null);
});

test('generate_image checks output image and note paths', t => {
    t.deepEqual(describeToolEffect('generate_image', {}, { path: 'Images/a.png', note_path: 'Images/a.md' }), {
        tool: 'generate_image', action: 'generate', targets: [
            { kind: 'vault-file', path: 'Images/a.png' }, { kind: 'vault-file', path: 'Images/a.md' }
        ], check: 'exists'
    });
});

test('add_text_to_image always uses args.output_path', t => {
    t.deepEqual(describeToolEffect('add_text_to_image', { output_path: 'Images/out.png' }, { path: 'Images/other.png' }), {
        tool: 'add_text_to_image', action: 'add_text', targets: [{ kind: 'vault-file', path: 'Images/out.png' }], check: 'exists'
    });
});

test('kom_send and agent_delegate expose returned message id when available', t => {
    t.deepEqual(describeToolEffect('kom_send', { to: 'A' }, { id: 'msg-1' }), {
        tool: 'kom_send', action: 'send', targets: [{ kind: 'message', id: 'msg-1' }], check: 'none'
    });
    t.deepEqual(describeToolEffect('agent_delegate', { to_agent: 'A' }, { id: 'msg-2' }), {
        tool: 'agent_delegate', action: 'delegate', targets: [{ kind: 'message', id: 'msg-2' }], check: 'none'
    });
});

test('external MCP tools and unknown names get an unknown, unchecked effect', t => {
    for (const name of ['server__tool', 'not_registered', '__proto__', 'hasOwnProperty']) {
        const expected: ToolEffect = { tool: name, action: 'unknown', targets: [], check: 'none' };
        t.deepEqual(describeToolEffect(name, {}), expected, name);
    }
});

test('delegate has no direct effect of its own', t => {
    t.is(describeToolEffect('delegate', { task: 'x' }), null);
});

test('read-only tools have no effect', t => {
    for (const name of ['read', 'list', 'search', 'web_search', 'web_read', 'ask_user', 'kom_list', 'kom_read', 'artifact_read', 'artifact_list']) {
        t.is(describeToolEffect(name, {}), null, `${name} is read-only`);
    }
});

test('checkEffectTargets requires every target to match and skips unchecked effects', async t => {
    const calls: Array<[string, EffectTarget['kind']]> = [];
    const io = { exists: async (path: string, kind: EffectTarget['kind']) => { calls.push([path, kind]); return path !== 'missing.md'; } };
    const existing: ToolEffect = { tool: 'write', action: 'replace', targets: [
        { kind: 'vault-file', path: 'a.md' }, { kind: 'memory-file', path: 'b.md' }
    ], check: 'exists' };
    const absent: ToolEffect = { tool: 'delete', action: 'delete', targets: [{ kind: 'vault-file', path: 'missing.md' }], check: 'absent' };
    t.is(await checkEffectTargets(existing, io), 'matches');
    t.is(await checkEffectTargets({ ...existing, targets: [...existing.targets, { kind: 'vault-file', path: 'missing.md' }] }, io), 'mismatch');
    t.is(await checkEffectTargets(absent, io), 'matches');
    t.is(await checkEffectTargets({ ...absent, targets: [{ kind: 'vault-file', path: 'a.md' }] }, io), 'mismatch');
    t.is(await checkEffectTargets({ ...existing, check: 'none' }, io), 'not-checked');
    t.is(await checkEffectTargets(existing, { exists: async () => { throw new Error('offline'); } }), 'not-checked');
    t.is(calls.length, 7);
});

