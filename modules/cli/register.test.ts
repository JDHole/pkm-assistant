import test from 'ava';
import { registerCliCommands } from './register.js';
import { buildCliCommands } from './commands.js';

import type { CliHandler, CliFlags } from 'obsidian';
import type { CliDeps } from './commands.js';
import type { CliHost } from './register.js';

function makeDeps(): CliDeps {
    return {
        pluginId: 'pkm-assistant',
        version: () => '2.2.8',
        isReady: () => true,
        agentManager: () => undefined,
        indexStatus: () => undefined,
        selfTest: async () => ({ ok: true }),
        consolidationStatus: async () => {
            throw new Error('not used in this test file');
        },
        now: () => new Date('2026-09-20T00:00:00.000Z'),
    };
}

test('host bez registerCliHandler -> skipped=unsupported, nic nie rejestruje, nie rzuca', t => {
    const host: CliHost = {};
    const result = registerCliCommands(host, makeDeps());

    t.deepEqual(result, { registered: [], skipped: 'unsupported', failed: [] });
});

test('rejestruje wszystkie cztery komendy z id/description/flags zgodnymi z buildCliCommands', async t => {
    const calls: Array<{ command: string; description: string; flags: CliFlags | null; handler: CliHandler }> = [];
    const host: CliHost = {
        registerCliHandler: (command, description, flags, handler) => {
            calls.push({ command, description, flags, handler });
        },
    };
    const deps = makeDeps();
    const result = registerCliCommands(host, deps);

    const expected = buildCliCommands(deps);
    t.deepEqual(result, { registered: expected.map(spec => spec.id), skipped: null, failed: [] });
    t.deepEqual(
        calls.map(c => ({ command: c.command, description: c.description, flags: c.flags })),
        expected.map(spec => ({ command: spec.id, description: spec.description, flags: spec.flags })),
    );
    // Handler przekazany do hosta realnie DZIAŁA jak `run` odpowiadającej specyfikacji
    // (osobne wołanie `buildCliCommands` daje nowe domknięcia `run`, więc porównujemy
    // zachowanie, nie referencję funkcji).
    for (let i = 0; i < expected.length; i++) {
        const viaHost = JSON.parse(await calls[i].handler({}));
        const viaSpec = JSON.parse(await expected[i].run({}));
        t.deepEqual(viaHost, viaSpec, expected[i].id);
    }
});

test('host rzucajacy przy DRUGIEJ komendzie (duplikat) -> pozostale trzy zarejestrowane, jedna w failed', t => {
    let callIndex = 0;
    const host: CliHost = {
        registerCliHandler: () => {
            callIndex++;
            if (callIndex === 2) throw new Error('command already registered');
        },
    };
    const deps = makeDeps();
    const result = registerCliCommands(host, deps);
    const expectedIds = buildCliCommands(deps).map(spec => spec.id);

    t.deepEqual(result.registered, [expectedIds[0], expectedIds[2], expectedIds[3]]);
    t.deepEqual(result.failed, [{ id: expectedIds[1], message: 'command already registered' }]);
    t.is(result.skipped, null);
});
