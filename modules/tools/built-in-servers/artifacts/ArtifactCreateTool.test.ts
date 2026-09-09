/**
 * ArtifactCreateTool.test.js — egzekwowanie typów artefaktów per agent.
 *
 * `agent.artifact_types` ogranicza, jaki `typ` wolno podać w `artifact_create`, nie tylko
 * indeks w prompcie. Tu pilnujemy tej bramki i jej OPT-IN natury: pusta lista = wszystko
 * wolno (zero regresji dla profili bez ograniczenia).
 *
 * Fake plugin zamiast prawdziwego ArtifactStore — sprawdzamy granicę narzędzia
 * (czy odmówiło / czy doszło do `store.create`), nie silnik artefaktów (ma własne testy
 * w `artifactTools.test.js`).
 */
import test from 'ava';
import { createArtifactCreateTool } from './ArtifactCreateTool.js';
import type { ArtifactToolAgent, ArtifactToolPlugin } from './ArtifactReadTool.js';

/** Atrapa agenta w mapie `agents` (klucz = nazwa widziana przez agentManager). */
type FakeAgent = ArtifactToolAgent;

/** Zapis wywołania `store.create` — po nim sprawdzamy, czy bramka przepuściła. */
type CreatedRow = { typ: string; tytul: string; agent: string };

/** Wynik `artifact_create` czytany w asercjach (dwie rozłączne gałęzie). */
type CreateRes = { isError?: boolean; error?: string; ok?: boolean; applied?: number; errors?: Array<{ code?: string }> };

/**
 * @param opts.agents - mapa nazwa → obiekt agenta widziany przez agentManager
 * @param opts.patchResult - co silnik zwraca z nałożenia początkowych `sekcje`
 */
function makePlugin({ agents = {}, patchResult }: { agents?: Record<string, FakeAgent>; patchResult?: { applied: number; errors: unknown[] } } = {}) {
    const created: CreatedRow[] = [];
    const store = {
        create: async (typ: string, data: { tytul: string; agent: string }) => {
            created.push({ typ, ...data });
            return {
                // Silnik mówi wprost, czy notatka POWSTAŁA (odmowa bramki pól = `false`).
                created: true,
                id: 'art-20260730-abcd',
                path: `Artefakty/${data.tytul}.md`,
                applied: patchResult?.applied ?? 0,
                errors: patchResult?.errors ?? [],
                artifact: { typ, status: 'do-akceptacji' },
            };
        },
    };
    const plugin = {
        artifactStore: store,
        agentManager: {
            getAgent: (name: string) => agents[name],
            getActiveAgent: () => null,
        },
    } as unknown as ArtifactToolPlugin;
    return { plugin, created };
}

const ARGS = (typ: string) => ({ typ, tytul: 'Tytuł', _invocationAgentName: 'Klara' });

test('agent z podpiętym tylko "plan" dostaje odmowę na "raport"', async t => {
    const { plugin, created } = makePlugin({ agents: { Klara: { name: 'Klara', artifact_types: ['plan'] } } });
    const tool = createArtifactCreateTool();

    const res = await tool.execute(ARGS('raport'), {}, plugin) as CreateRes;

    t.true(res.isError);
    t.regex(res.error!, /raport/, 'komunikat mówi, czego user odmówił');
    t.regex(res.error!, /plan/, 'komunikat wymienia dozwolone typy');
    t.is(created.length, 0, 'nic nie doszło do silnika');
});

test('ten sam agent tworzy "plan" bez przeszkód', async t => {
    const { plugin, created } = makePlugin({ agents: { Klara: { name: 'Klara', artifact_types: ['plan'] } } });
    const tool = createArtifactCreateTool();

    const res = await tool.execute(ARGS('plan'), {}, plugin) as CreateRes;

    t.true(res.ok);
    t.is(created.length, 1);
    t.is(created[0].typ, 'plan');
    t.is(created[0].agent, 'Klara', 'zaufana tożsamość wołającego idzie do silnika');
});

test('pusta lista typów = wszystko wolno (opt-in, zero regresji)', async t => {
    for (const artifact_types of [[] as string[], undefined]) {
        const { plugin, created } = makePlugin({ agents: { Klara: { name: 'Klara', artifact_types } } });
        const tool = createArtifactCreateTool();

        const res = await tool.execute(ARGS('cokolwiek'), {}, plugin) as CreateRes;

        t.true(res.ok, `artifact_types=${JSON.stringify(artifact_types)} nie może blokować`);
        t.is(created.length, 1);
    }
});

test('agent nieznany managerowi przechodzi (nie ma czego egzekwować)', async t => {
    const { plugin, created } = makePlugin({ agents: {} });
    const tool = createArtifactCreateTool();

    const res = await tool.execute(ARGS('raport'), {}, plugin) as CreateRes;

    t.true(res.ok);
    t.is(created.length, 1);
});

test('applied/errors z silnika przechodzą do wyniku narzędzia (model widzi nietrafiony heading)', async t => {
    const { plugin } = makePlugin({
        agents: { Klara: { name: 'Klara' } },
        patchResult: { applied: 1, errors: [{ op: { op: 'set_section', heading: 'Nie ma' }, code: 'not_found', message: 'Section "Nie ma" not found' }] },
    });
    const tool = createArtifactCreateTool();

    const res = await tool.execute(ARGS('plan'), {}, plugin) as CreateRes;

    t.true(res.ok);
    t.is(res.applied, 1);
    t.is(res.errors!.length, 1);
    t.is(res.errors![0].code, 'not_found');
});

test('create bez sekcji → applied 0, errors puste (pola zawsze obecne)', async t => {
    const { plugin } = makePlugin({ agents: { Klara: { name: 'Klara' } } });
    const tool = createArtifactCreateTool();

    const res = await tool.execute(ARGS('plan'), {}, plugin) as CreateRes;

    t.is(res.applied, 0);
    t.deepEqual(res.errors, []);
});

test('lista typów nie jest bramką dla brakujących argumentów ani braku silnika', async t => {
    const { plugin } = makePlugin({ agents: { Klara: { name: 'Klara', artifact_types: ['plan'] } } });
    const tool = createArtifactCreateTool();

    // brak tytułu → odmowa argumentowa, nie typowa
    const missing = await tool.execute({ typ: 'plan', _invocationAgentName: 'Klara' }, {}, plugin) as CreateRes;
    t.true(missing.isError);
    t.notRegex(missing.error!, /plan/, 'to nie komunikat o typach');

    // brak store → guard wcześniej niż bramka typów
    const noStore = await tool.execute(ARGS('raport'), {}, { agentManager: plugin.agentManager }) as CreateRes;
    t.true(noStore.isError);
    t.notRegex(noStore.error!, /raport/);
});
