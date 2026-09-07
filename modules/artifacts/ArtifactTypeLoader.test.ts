import test from 'ava';
import {
    ArtifactTypeLoader,
    ARTIFACT_TYPES_PATH,
    DEFAULT_STATUSY,
    PLAN_TYPE_CONTENT,
    NOTATKA_TYPE_CONTENT,
    RAPORT_TYPE_CONTENT,
} from './ArtifactTypeLoader.js';
import { computeArtifactButtons } from './artifactButtons.js';
import { applyPatch, parseArtifact } from './artifactParser.js';

// ── In-memory adapter (wzór mocków vaulta) ──
function makeVault(files: Map<string, string> = new Map<string, string>()) {
    const adapter = {
        async exists(path: string) {
            if (files.has(path)) return true;
            // folder istnieje, jeśli jest jakikolwiek plik pod nim
            for (const p of files.keys()) if (p.startsWith(path + '/')) return true;
            return false;
        },
        async list(path: string) {
            const prefix = path.endsWith('/') ? path : path + '/';
            const out = [];
            for (const p of files.keys()) {
                if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) out.push(p);
            }
            return { files: out, folders: [] };
        },
        async read(path: string) {
            if (!files.has(path)) throw new Error('ENOENT ' + path);
            return files.get(path)!;
        },
        async write(path: string, data: string) { files.set(path, data); },
        async mkdir() { /* noop */ },
    };
    return { vault: { adapter }, files };
}

const typePath = (name: string) => `${ARTIFACT_TYPES_PATH}/${name}.md`;

test('ensureBuiltinTypes seeds the plan type when missing', async t => {
    const { vault, files } = makeVault();
    const loader = new ArtifactTypeLoader(vault);
    await loader.ensureBuiltinTypes();
    t.is(files.get(typePath('plan')), PLAN_TYPE_CONTENT);
});

test('ensureBuiltinTypes seeds the notatka type too (E2.9 D — pokrywa idea_review)', async t => {
    const { vault, files } = makeVault();
    const loader = new ArtifactTypeLoader(vault);
    await loader.ensureBuiltinTypes();
    t.is(files.get(typePath('notatka')), NOTATKA_TYPE_CONTENT);
    // notatka jest wbudowana + ma sekcje Treść/Uwagi usera + statusy jak plan.
    await loader.loadAllTypes();
    const notatka = loader.getType('notatka')!;
    t.true(notatka.builtin);
    t.deepEqual(notatka.statusy, ['do-akceptacji', 'uwagi', 'zaakceptowany', 'zamkniety']);
    t.true(notatka.template.includes('## Treść'));
    t.true(notatka.template.includes('## Uwagi usera'));
});

test('ensureBuiltinTypes seeds the raport type (E3.5 Deep Research)', async t => {
    const { vault, files } = makeVault();
    const loader = new ArtifactTypeLoader(vault);
    await loader.ensureBuiltinTypes();
    t.is(files.get(typePath('raport')), RAPORT_TYPE_CONTENT);

    await loader.loadAllTypes();
    const raport = loader.getType('raport')!;
    t.true(raport.builtin);
    t.deepEqual(raport.statusy, ['w-trakcie', 'gotowy', 'zamkniety']);
    // Raporty się nie przedawniają — to wiedza, nie plan roboczy.
    t.is(raport.sprzatanie, 0);
    t.deepEqual(Object.keys(raport.pola), ['pytanie', 'tryb']);
    t.true(raport.template.includes('## TL;DR'));
    t.true(raport.template.includes('## Ustalenia'));
    t.true(raport.template.includes('## Białe plamy'));
    t.true(raport.template.includes('## Źródła'));
    t.true(raport.template.includes('## Uwagi usera'));
});

// ── Poligon F2: przepis deep-research żądał sekcji, której typ nie miał ────────

test('świeżo zaseedowany typ raport przyjmuje set_section na „Białe plamy"', async t => {
    const { vault } = makeVault();
    const loader = new ArtifactTypeLoader(vault);
    await loader.ensureBuiltinTypes();
    await loader.loadAllTypes();

    // Instancja artefaktu = szablon typu (tak buduje ją ArtifactStore.create).
    const instancja = loader.getType('raport')!.template;
    const r = applyPatch(instancja, [{
        op: 'set_section',
        heading: 'Białe plamy',
        text: '- O trybie offline nie ma w vaulcie ani jednej notatki.',
    }]);
    t.is(r.applied, 1, 'set_section na „Białe plamy" nie może wracać not_found');
    t.is(r.errors.length, 0);

    const sekcje = parseArtifact(r.markdown).sections.map(s => s.heading);
    // Kolejność: Białe plamy między Ustaleniami a Źródłami.
    t.deepEqual(sekcje, ['TL;DR', 'Ustalenia', 'Białe plamy', 'Źródła', 'Uwagi usera']);
    t.true(parseArtifact(r.markdown).sections.find(s => s.heading === 'Białe plamy')!.text.includes('trybie offline'));
});

test('starszy vault (typ bez sekcji) → set_section wraca not_found, fallback „### Białe plamy" przechodzi', t => {
    // Typ sprzed F2 — ensureBuiltinTypes NIE nadpisuje istniejących plików usera.
    const stary = ['## TL;DR', '', '## Ustalenia', '- Coś ustalone.', '', '## Źródła', '', '## Uwagi usera', ''].join('\n');

    const brak = applyPatch(stary, [{ op: 'set_section', heading: 'Białe plamy', text: '- luka' }]);
    t.is(brak.applied, 0);
    t.is(brak.errors[0]!.code, 'not_found');

    const fallback = applyPatch(stary, [{
        op: 'set_section',
        heading: 'Ustalenia',
        text: '- Coś ustalone.\n\n### Białe plamy\n- O trybie offline nie ma nic.',
    }]);
    t.is(fallback.applied, 1, 'fallback z przepisu musi być zgodny z bramką heading_forbidden');
    t.is(fallback.errors.length, 0);
});

test('raport statuses drive the generic button branch (summon while open, none when closed)', t => {
    const statusy = ['w-trakcie', 'gotowy', 'zamkniety'];
    // Statusy niedomknięte ≠ do-akceptacji → sam guzik „Przywołaj agenta" (żywy raport).
    t.deepEqual(computeArtifactButtons('w-trakcie', statusy).map(b => b.action), ['summon']);
    t.deepEqual(computeArtifactButtons('gotowy', statusy).map(b => b.action), ['summon']);
    t.deepEqual(computeArtifactButtons('zamkniety', statusy), []);
});

test('ensureBuiltinTypes is idempotent (does not overwrite user edits)', async t => {
    const { vault, files } = makeVault(new Map([[typePath('plan'), '---\nnazwa: plan\nopis: moja wersja\n---\n']]));
    const loader = new ArtifactTypeLoader(vault);
    await loader.ensureBuiltinTypes();
    t.true(files.get(typePath('plan'))!.includes('moja wersja'));
});

test('loadAllTypes parses the seeded plan type with fields and statuses', async t => {
    const { vault } = makeVault(new Map([[typePath('plan'), PLAN_TYPE_CONTENT]]));
    const loader = new ArtifactTypeLoader(vault);
    await loader.loadAllTypes();

    const plan = loader.getType('plan')!;
    t.truthy(plan);
    t.is(plan.opis, 'Plan działania — agent proponuje, user zatwierdza przed robotą');
    t.deepEqual(plan.statusy, ['do-akceptacji', 'uwagi', 'zaakceptowany', 'zamkniety']);
    t.is(plan.sprzatanie, 30);
    t.is(plan.builtin, true);
    t.deepEqual(Object.keys(plan.pola), ['cel', 'termin']);
    t.is(plan.pola.cel.opis, 'Jedno zdanie — po co ten plan istnieje');
    t.true(plan.template.includes('## Cel'));
    t.true(plan.template.includes('{{cel}}'));
    // Body szablonu NIE zawiera bloku przycisków — store dokleja go przy create.
    t.false(plan.template.includes('pkm-artefakt'));
});

test('validation: type missing nazwa or opis is skipped', async t => {
    const { vault } = makeVault(new Map([
        [typePath('bad'), '---\nnazwa: bad\n---\nbrak opisu'],
        [typePath('good'), '---\nnazwa: good\nopis: dobry typ\n---\ntreść'],
    ]));
    const loader = new ArtifactTypeLoader(vault);
    await loader.loadAllTypes();
    t.is(loader.getType('bad'), null);
    t.truthy(loader.getType('good'));
});

test('defaults: statusy -> [szkic, zamkniety], sprzatanie -> 0 when unspecified', async t => {
    const { vault } = makeVault(new Map([[typePath('notatka'), '---\nnazwa: notatka\nopis: goła notatka\n---\ntreść']]));
    const loader = new ArtifactTypeLoader(vault);
    await loader.loadAllTypes();
    const notatka = loader.getType('notatka')!;
    t.deepEqual(notatka.statusy, DEFAULT_STATUSY);
    t.is(notatka.sprzatanie, 0);
    t.deepEqual(notatka.pola, {});
});

test('getTypesForAgent: empty/missing -> only plan; explicit list -> mapped', async t => {
    const { vault } = makeVault(new Map([
        [typePath('plan'), PLAN_TYPE_CONTENT],
        [typePath('kanban'), '---\nnazwa: kanban\nopis: tablica\n---\ntreść'],
    ]));
    const loader = new ArtifactTypeLoader(vault);
    await loader.loadAllTypes();

    t.deepEqual(loader.getTypesForAgent().map(x => x.name), ['plan']);
    t.deepEqual(loader.getTypesForAgent([]).map(x => x.name), ['plan']);
    t.deepEqual(loader.getTypesForAgent(['kanban']).map(x => x.name), ['kanban']);
    t.deepEqual(loader.getTypesForAgent(['kanban', 'nieistnieje']).map(x => x.name), ['kanban']);
});

test('loadAllTypes on an empty vault yields no types (no crash)', async t => {
    const { vault } = makeVault();
    const loader = new ArtifactTypeLoader(vault);
    await loader.loadAllTypes();
    t.is(loader.getAllTypes().length, 0);
});
