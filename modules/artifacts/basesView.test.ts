import test from 'ava';
// `js-yaml` OUT (katalog Obsidiana go wytyka, module-replacements) — testy tego pliku parsują
// samodzielnie przez `yaml` (devDependency), NIE przez `core/utils/yamlParser.ts`: dwa testy
// niżej sprawdzają `t.notThrows`, czyli że parsowanie NIE RZUCA na dziwnym folderze (apostrof/
// cudzysłów/backslash) — `parseYaml` z core łyka błędy składni po cichu (`catch` → `null`),
// więc `t.notThrows` na nim byłoby zawsze zielone, nawet na złamanym YAML-u.
import * as YAML from 'yaml';
import {
    buildArtifactsBaseContent,
    buildArtifactsBasePath,
    ARTIFACTS_BASE_FILENAME,
} from './basesView.js';
import { DEFAULT_ARTIFACTS_FOLDER } from './ArtifactStore.js';

interface BaseView { type: string; name: string; filters: { and: string[] }; order: string[]; sort: Array<{ property: string; direction: string }>; }
interface BaseDocument { views: BaseView[]; }
const loadBase = (content: string): BaseDocument => YAML.parse(content) as unknown as BaseDocument;

// ── struktura: dwa widoki table ───────────────────────────────────────

test('buildArtifactsBaseContent: dwa widoki table „Wszystkie" + „Otwarte"', t => {
    const parsed = loadBase(buildArtifactsBaseContent('PKM Assistant/Artefakty'));
    t.is(parsed.views.length, 2);
    t.deepEqual(parsed.views.map((v: BaseView) => v.type), ['table', 'table']);
    t.deepEqual(parsed.views.map((v: BaseView) => v.name), ['Wszystkie', 'Otwarte']);
});

test('buildArtifactsBaseContent: kolumny (order) w obu widokach = bazowe klucze artefaktu', t => {
    const parsed = loadBase(buildArtifactsBaseContent('PKM Assistant/Artefakty'));
    const expected = ['file.name', 'typ', 'agent', 'status', 'utworzono', 'zaktualizowano'];
    for (const view of parsed.views) t.deepEqual(view.order, expected);
});

test('buildArtifactsBaseContent: sort po zaktualizowano DESC w obu widokach', t => {
    const parsed = loadBase(buildArtifactsBaseContent('PKM Assistant/Artefakty'));
    for (const view of parsed.views) {
        t.deepEqual(view.sort, [{ property: 'zaktualizowano', direction: 'DESC' }]);
    }
});

// ── filtry ────────────────────────────────────────────────────────────

test('buildArtifactsBaseContent: oba widoki filtrują po frontmatterze pkm-artefakt', t => {
    const parsed = loadBase(buildArtifactsBaseContent('PKM Assistant/Artefakty'));
    for (const view of parsed.views) {
        t.true(view.filters.and.includes('!note["pkm-artefakt"].isEmpty()'));
    }
});

test('buildArtifactsBaseContent: „Otwarte" dokłada filtr odcinający status zamkniety', t => {
    const parsed = loadBase(buildArtifactsBaseContent('PKM Assistant/Artefakty'));
    const [wszystkie, otwarte] = parsed.views;
    t.is(wszystkie.filters.and.length, 2);
    t.is(otwarte.filters.and.length, 3);
    t.false(wszystkie.filters.and.some((f: string) => f.includes('status')));
    t.true(otwarte.filters.and.includes('note["status"] != "zamkniety"'));
});

// ── escapowanie folderu ───────────────────────────────────────────────

test('buildArtifactsBaseContent: folder ze spacją trafia w cudzysłowach do file.inFolder', t => {
    const parsed = loadBase(buildArtifactsBaseContent('PKM Assistant/Artefakty'));
    for (const view of parsed.views) {
        t.true(view.filters.and.includes('file.inFolder("PKM Assistant/Artefakty")'));
    }
});

test('buildArtifactsBaseContent: apostrof w folderze nie psuje YAML-a', t => {
    const content = buildArtifactsBaseContent("Kuba's Artefakty");
    t.notThrows(() => YAML.parse(content));
    const parsed = loadBase(content);
    t.true(parsed.views[0].filters.and.includes('file.inFolder("Kuba\'s Artefakty")'));
});

test('buildArtifactsBaseContent: cudzysłów i backslash w folderze są zescapowane', t => {
    const content = buildArtifactsBaseContent('dziw\\ny "folder"');
    t.notThrows(() => YAML.parse(content));
    const parsed = loadBase(content);
    t.true(parsed.views[0].filters.and.includes('file.inFolder("dziw\\\\ny \\"folder\\"")'));
});

test('buildArtifactsBaseContent: pusty/brakujący folder → default', t => {
    const expected = `file.inFolder("${DEFAULT_ARTIFACTS_FOLDER}")`;
    for (const input of [undefined, null, '', '   ']) {
        const parsed = loadBase(buildArtifactsBaseContent(input || undefined));
        t.true(parsed.views[0].filters.and.includes(expected));
    }
});

test('buildArtifactsBaseContent: ukośniki na brzegach folderu obcięte', t => {
    const parsed = loadBase(buildArtifactsBaseContent('/Moje/Artefakty/'));
    t.true(parsed.views[0].filters.and.includes('file.inFolder("Moje/Artefakty")'));
});

// ── ścieżka pliku ─────────────────────────────────────────────────────

test('buildArtifactsBasePath: <folder>/Artefakty.base z tą samą normalizacją', t => {
    t.is(buildArtifactsBasePath('Moje/Artefakty'), 'Moje/Artefakty/Artefakty.base');
    t.is(buildArtifactsBasePath('/Moje/Artefakty/'), 'Moje/Artefakty/Artefakty.base');
    t.is(buildArtifactsBasePath(''), `${DEFAULT_ARTIFACTS_FOLDER}/${ARTIFACTS_BASE_FILENAME}`);
});

// ── snapshot pełnej struktury (KONTRAKT) ──────────────────────────────

test('buildArtifactsBaseContent: snapshot pełnej treści .base (kontrakt formatu)', t => {
    const expected = `properties:
  file.name:
    displayName: Notatka
views:
  - type: table
    name: Wszystkie
    filters:
      and:
        - 'file.inFolder("PKM Assistant/Artefakty")'
        - '!note["pkm-artefakt"].isEmpty()'
    order:
      - file.name
      - typ
      - agent
      - status
      - utworzono
      - zaktualizowano
    sort:
      - property: zaktualizowano
        direction: DESC
  - type: table
    name: Otwarte
    filters:
      and:
        - 'file.inFolder("PKM Assistant/Artefakty")'
        - '!note["pkm-artefakt"].isEmpty()'
        - 'note["status"] != "zamkniety"'
    order:
      - file.name
      - typ
      - agent
      - status
      - utworzono
      - zaktualizowano
    sort:
      - property: zaktualizowano
        direction: DESC
`;
    t.is(buildArtifactsBaseContent('PKM Assistant/Artefakty'), expected);
});
