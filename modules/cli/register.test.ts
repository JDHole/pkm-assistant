import test from 'ava';
import { registerCliCommands } from './register.js';

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

/**
 * P1 [BLOKER]: prawdziwa implementacja Obsidiana (`Plugin#registerCliHandler`) jest metodą
 * PROTOTYPU, która czyta `this` (`this.app.cli...`, `this.manifest.name`, `this.register(...)`).
 * Fejkowy host jako STRZAŁKA (jak w pozostałych testach tego pliku) nie widziałby błędu, gdyby
 * `register.ts` odpiął referencję od hosta (`const f = host.registerCliHandler; f(...)`) - strzałki
 * i tak nie mają własnego `this`. Ten host jest KLASĄ z metodą, żeby odróżnić "wołane jako
 * `host.registerCliHandler(...)`" od "wołane jako goła funkcja" - dokładnie tę różnicę, którą
 * zmierzył recenzent (odpięta referencja -> TypeError na `this.manifest` -> `registered: []`,
 * `failed: 4`, cała fala martwa w prawdziwym Obsidianie).
 */
class RealisticObsidianHost {
    manifest = { name: 'PKM Assistant' };
    calls: Array<{ command: string; manifestName: string }> = [];

    registerCliHandler(command: string, description: string, flags: CliFlags | null, handler: CliHandler): void {
        void description; void flags; void handler;
        // Odpięcie tej metody od instancji (goła referencja wołana bez `.call`/`.bind`/`obj.method()`)
        // rzuci tu TypeError na `this.manifest` - dokładnie tak, jak prawdziwy `Plugin#registerCliHandler`
        // rzuciłby na `this.app`/`this.register(...)`.
        this.calls.push({ command, manifestName: this.manifest.name });
    }
}

test('P1: registerCliHandler wołany NA hoście (this działa) - realistyczna implementacja Obsidiana czyta `this.manifest`', t => {
    const host = new RealisticObsidianHost();
    const deps = makeDeps();
    const result = registerCliCommands(host, deps);

    t.deepEqual(result.registered, [
        'pkm-assistant:status',
        'pkm-assistant:selftest',
        'pkm-assistant:agent-prompt',
        'pkm-assistant:memory-status',
    ]);
    t.deepEqual(result.failed, []);
    t.is(result.skipped, null);
    t.is(host.calls.length, 4);
    t.true(host.calls.every(call => call.manifestName === 'PKM Assistant'));
});

test('rejestruje wszystkie cztery komendy z LITERALNYMI id/flagami przekazanymi do hosta (nie liczonymi przez buildCliCommands)', t => {
    const calls: Array<{ command: string; description: string; flags: CliFlags | null; handler: CliHandler }> = [];
    const host: CliHost = {
        registerCliHandler: (command, description, flags, handler) => {
            calls.push({ command, description, flags, handler });
        },
    };
    const deps = makeDeps();
    const result = registerCliCommands(host, deps);

    const expectedIds = [
        'pkm-assistant:status',
        'pkm-assistant:selftest',
        'pkm-assistant:agent-prompt',
        'pkm-assistant:memory-status',
    ];
    t.deepEqual(result, { registered: expectedIds, skipped: null, failed: [] });
    t.deepEqual(calls.map(c => c.command), expectedIds);

    // Opisów NIE pinujemy co do znaku (P2) - tylko że są niepustym stringiem.
    for (const call of calls) {
        t.true(typeof call.description === 'string' && call.description.length > 0, call.command);
        t.is(typeof call.handler, 'function', call.command);
    }

    const flagNames = (flags: CliFlags | null): string[] => (flags ? Object.keys(flags) : []);
    t.deepEqual(flagNames(calls[0].flags), ['format'], 'status');
    t.deepEqual(flagNames(calls[1].flags), ['format'], 'selftest');
    t.deepEqual(flagNames(calls[2].flags), ['agent', 'section', 'format'], 'agent-prompt');
    t.deepEqual(flagNames(calls[3].flags), ['agent', 'format'], 'memory-status');

    // Jedyne flagi wymagane (`required: true`) to `agent` na agent-prompt i memory-status.
    t.is(calls[2].flags?.agent.required, true, 'agent-prompt: agent required');
    t.falsy(calls[2].flags?.section?.required, 'agent-prompt: section NIE required');
    t.falsy(calls[2].flags?.format?.required, 'agent-prompt: format NIE required');
    t.is(calls[3].flags?.agent.required, true, 'memory-status: agent required');
    t.falsy(calls[3].flags?.format?.required, 'memory-status: format NIE required');
    t.falsy(calls[0].flags?.format?.required, 'status: format NIE required');
    t.falsy(calls[1].flags?.format?.required, 'selftest: format NIE required');
});

test('host rzucajacy przy DRUGIEJ komendzie (duplikat) -> pozostale trzy zarejestrowane, jedna w failed', t => {
    let callIndex = 0;
    const host: CliHost = {
        registerCliHandler: () => {
            callIndex++;
            if (callIndex === 2) throw new Error('command already registered');
        },
    };
    const result = registerCliCommands(host, makeDeps());

    // Literały, nie `buildCliCommands(deps)` - oczekiwanie liczone funkcją spod testu
    // przeszłoby zielono także wtedy, gdy ta funkcja nie zwraca nic.
    t.deepEqual(result.registered, ['pkm-assistant:status', 'pkm-assistant:agent-prompt', 'pkm-assistant:memory-status']);
    t.deepEqual(result.failed, [{ id: 'pkm-assistant:selftest', message: 'command already registered' }]);
    t.is(result.skipped, null);
});
