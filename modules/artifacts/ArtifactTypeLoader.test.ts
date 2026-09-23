import test from 'ava';
import {
    ArtifactTypeLoader,
    ARTIFACT_TYPES_PATH,
    defaultStatusy,
    PLAN_TYPE_CONTENT,
    NOTATKA_TYPE_CONTENT,
    RAPORT_TYPE_CONTENT,
    PLAN_TYPE_CONTENT_EN,
    NOTATKA_TYPE_CONTENT_EN,
    RAPORT_TYPE_CONTENT_EN,
} from './ArtifactTypeLoader.js';
import { ARTIFACT_SECTION_NAMES, artifactSection } from './artifactSections.js';
import { computeArtifactButtons } from './artifactButtons.js';
import { applyPatch, parseArtifact } from './artifactParser.js';
import { setLocale } from '../../core/i18n/index.js';

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

/**
 * Testy dotykające języka jadą `test.serial` (AVA puszcza je PRZED współbieżnymi i po jednym),
 * bo `setLocale` to stan globalny procesu testowego. Każdy oddaje 'en' - domyślny locale, na
 * którym stoi reszta pliku.
 */
function useLocale(t: { teardown: (fn: () => void) => void }, locale: string) {
    setLocale(locale);
    t.teardown(() => setLocale('en'));
}

test.serial('ensureBuiltinTypes seeds the plan type when missing (locale pl)', async t => {
    useLocale(t, 'pl');
    const { vault, files } = makeVault();
    const loader = new ArtifactTypeLoader(vault);
    await loader.ensureBuiltinTypes();
    t.is(files.get(typePath('plan')), PLAN_TYPE_CONTENT);
    t.true(files.get(typePath('plan'))!.includes('## Kroki'));
});

test.serial('ensureBuiltinTypes seeds the notatka type too (locale pl)', async t => {
    useLocale(t, 'pl');
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

test.serial('ensureBuiltinTypes seeds the raport type (locale pl)', async t => {
    useLocale(t, 'pl');
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

// ── przepis deep-research adresuje sekcję, którą typ musi mieć ────────

test.serial('świeżo zaseedowany typ raport przyjmuje set_section na „Białe plamy"', async t => {
    useLocale(t, 'pl');
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
    // Starszy typ (bez tej sekcji) - ensureBuiltinTypes NIE nadpisuje istniejących plików usera.
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

// ── seed idzie za językiem interfejsu (2.2.5) ─────────────────────────

test.serial('locale en + pusty vault → wbudowane typy po angielsku, bez polskich nagłówków', async t => {
    useLocale(t, 'en');
    const { vault, files } = makeVault();
    const loader = new ArtifactTypeLoader(vault);
    await loader.ensureBuiltinTypes();

    const plan = files.get(typePath('plan'))!;
    t.true(plan.includes('## Steps'));
    t.true(plan.includes('## User notes'));
    t.false(plan.includes('Kroki'));
    t.true(files.get(typePath('notatka'))!.includes('## Content'));
    const raport = files.get(typePath('raport'))!;
    t.true(raport.includes('## Findings'));
    t.true(raport.includes('## Blind spots'));

    // Semantyka silnika (id typu, klucze pól) jest wspólna dla obu języków - WARTOŚCI statusów
    // natomiast (od 19.09) idą za językiem seedowania: EN dostaje literały EN, nie PL.
    await loader.loadAllTypes();
    const typ = loader.getType('plan')!;
    t.is(typ.name, 'plan');
    t.deepEqual(typ.statusy, ['pending-approval', 'remarks', 'accepted', 'closed']);
    t.deepEqual(Object.keys(typ.pola), ['cel', 'termin']);
});

test.serial('locale en + NIETKNIĘTY polski plik fabryczny (nawet z CRLF) → podmiana na angielski', async t => {
    useLocale(t, 'en');
    const zCrlf = PLAN_TYPE_CONTENT.replace(/\n/g, '\r\n');
    const { vault, files } = makeVault(new Map([[typePath('plan'), zCrlf]]));
    const loader = new ArtifactTypeLoader(vault);
    await loader.ensureBuiltinTypes();
    t.is(files.get(typePath('plan')), PLAN_TYPE_CONTENT_EN);
});

test.serial('locale pl + NIETKNIĘTY angielski plik fabryczny → podmiana na polski', async t => {
    useLocale(t, 'pl');
    const { vault, files } = makeVault(new Map([
        [typePath('notatka'), NOTATKA_TYPE_CONTENT_EN],
        [typePath('raport'), RAPORT_TYPE_CONTENT_EN],
    ]));
    const loader = new ArtifactTypeLoader(vault);
    await loader.ensureBuiltinTypes();
    t.is(files.get(typePath('notatka')), NOTATKA_TYPE_CONTENT);
    t.is(files.get(typePath('raport')), RAPORT_TYPE_CONTENT);
});

test.serial('locale en + plik RUSZONY przez usera → zostaje bajt w bajt', async t => {
    useLocale(t, 'en');
    const mojaWersja = PLAN_TYPE_CONTENT + '\n## Moja sekcja\n(moje notatki)\n';
    const { vault, files } = makeVault(new Map([[typePath('plan'), mojaWersja]]));
    const loader = new ArtifactTypeLoader(vault);
    await loader.ensureBuiltinTypes();
    t.is(files.get(typePath('plan')), mojaWersja);
});

test.serial('artifactSection wybiera nazwę sekcji po języku', t => {
    useLocale(t, 'en');
    t.is(artifactSection('user_notes'), 'User notes');
    t.is(artifactSection('steps'), 'Steps');
    setLocale('pl');
    t.is(artifactSection('user_notes'), 'Uwagi usera');
    t.is(artifactSection('steps'), 'Kroki');
    // Jawny locale wygrywa nad globalnym; nieznany kod = angielski (jak `t()`).
    t.is(artifactSection('findings', 'en'), 'Findings');
    t.is(artifactSection('findings', 'de'), 'Findings');
});

test('nagłówki tekstów fabrycznych zgadzają się z rejestrem sekcji (oba języki)', t => {
    const naglowki = (content: string) => content
        .split('\n').filter(line => line.startsWith('## ')).map(line => line.slice(3).trim());

    const pl = ARTIFACT_SECTION_NAMES.pl;
    const en = ARTIFACT_SECTION_NAMES.en;
    t.deepEqual(naglowki(PLAN_TYPE_CONTENT), [pl.goal, pl.steps, pl.risks, pl.user_notes]);
    t.deepEqual(naglowki(PLAN_TYPE_CONTENT_EN), [en.goal, en.steps, en.risks, en.user_notes]);
    t.deepEqual(naglowki(NOTATKA_TYPE_CONTENT), [pl.content, pl.user_notes]);
    t.deepEqual(naglowki(NOTATKA_TYPE_CONTENT_EN), [en.content, en.user_notes]);
    t.deepEqual(naglowki(RAPORT_TYPE_CONTENT), [pl.tldr, pl.findings, pl.blind_spots, pl.sources, pl.user_notes]);
    t.deepEqual(naglowki(RAPORT_TYPE_CONTENT_EN), [en.tldr, en.findings, en.blind_spots, en.sources, en.user_notes]);
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

// `defaultStatusy()` jest leniwa (język interfejsu w chwili PARSOWANIA typu bez zadeklarowanych
// statusów) - `test.serial` + `setLocale` przypina, który UI jest aktywny.
test.serial('defaults: statusy -> [szkic, zamkniety] pod PL UI, sprzatanie -> 0 when unspecified', async t => {
    t.teardown(() => setLocale('en'));
    setLocale('pl');
    const { vault } = makeVault(new Map([[typePath('notatka'), '---\nnazwa: notatka\nopis: goła notatka\n---\ntreść']]));
    const loader = new ArtifactTypeLoader(vault);
    await loader.loadAllTypes();
    const notatka = loader.getType('notatka')!;
    t.deepEqual(notatka.statusy, defaultStatusy());
    t.deepEqual(notatka.statusy, ['szkic', 'zamkniety']);
    t.is(notatka.sprzatanie, 0);
    t.deepEqual(notatka.pola, {});
});

test.serial('defaults: statusy -> [draft, closed] pod EN UI (nie [szkic, zamkniety])', async t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    const { vault } = makeVault(new Map([[typePath('notatka'), '---\nnazwa: notatka\nopis: bare note\n---\ncontent']]));
    const loader = new ArtifactTypeLoader(vault);
    await loader.loadAllTypes();
    const notatka = loader.getType('notatka')!;
    t.deepEqual(notatka.statusy, ['draft', 'closed']);
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
