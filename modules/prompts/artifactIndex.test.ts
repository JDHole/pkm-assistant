import test from 'ava';
import { setLocale } from '../../core/i18n/index.js';
import { buildArtifactIndex, buildActiveArtifactBlock } from './artifactIndex.js';

setLocale('pl');

const type = (over = {}) => ({ name: 'plan', opis: 'Plan działania — agent proponuje, user zatwierdza', ...over });
const art = (over = {}) => ({ id: 'art-1', tytul: 'Plan porządków', typ: 'plan', status: 'do-akceptacji', ...over });

test('brak typów i artefaktów → pusty string', t => {
    t.is(buildArtifactIndex([], []), '');
    t.is(buildArtifactIndex(), '');
});

test('indeks typów: „📄 nazwa: opis"', t => {
    const out = buildArtifactIndex([type()], []);
    t.true(out.includes('📄 plan:'));
    t.true(out.includes('Plan działania'));
});

test('typ bez opisu → fallback „brak opisu" (bez wybuchu)', t => {
    const out = buildArtifactIndex([{ name: 'kanban' }], []);
    t.true(out.includes('kanban'));
    t.true(out.includes('brak opisu'));
});

test('typ z szablonem → linia z nagłówkami sekcji (dokładne nazwy dla `heading`)', t => {
    const out = buildArtifactIndex([type({
        template: '## Cel\n{{cel}}\n\n## Kroki\n(agent wstawia kroki)\n\n## Ryzyka i założenia\n\n## Uwagi usera\n',
    })], []);
    t.true(out.includes('Cel · Kroki · Ryzyka i założenia · Uwagi usera'));
});

test('nagłówki `###` to podtytuły treści, nie sekcje — nie wchodzą do indeksu', t => {
    const out = buildArtifactIndex([type({ template: '## Ustalenia\n### Białe plamy\ntreść\n' })], []);
    t.true(out.includes('Ustalenia'));
    t.false(out.includes('Białe plamy'));
});

test('szablon bez nagłówków / brak szablonu → żadnej linii sekcji', t => {
    const bez = buildArtifactIndex([type({ template: 'goła treść bez nagłówków\n' })], []);
    t.false(bez.includes('sekcje'));
    const brak = buildArtifactIndex([type()], []);
    t.false(brak.includes('sekcje'));
});

test('BUDŻET: linia sekcji nie wypycha indeksu ponad limit', t => {
    const out = buildArtifactIndex([type({ template: '## Bardzo długi nagłówek sekcji numer jeden\n## I drugi równie długi\n' })], [], 120);
    t.true(out.length <= 120);
});

test('lista artefaktów w toku: tytuł, id, typ, status', t => {
    const out = buildArtifactIndex([type()], [art()]);
    t.true(out.includes('Plan porządków'));
    t.true(out.includes('art-1'));
    t.true(out.includes('do-akceptacji'));
});

test('BUDŻET: dużo artefaktów → część wypada + linia „…i N kolejnych"', t => {
    const many = Array.from({ length: 40 }, (_, i) => art({ id: `art-${i}`, tytul: `Artefakt numer ${i} z długim tytułem` }));
    const out = buildArtifactIndex([type()], many, 300);
    t.true(out.includes('art-0'));
    t.false(out.includes('art-39'));
    t.regex(out, /kolejnych|artifact_list/);
});

test('buildActiveArtifactBlock: pełny chudy JSON z nagłówkiem', t => {
    const thin = {
        id: 'art-1', typ: 'plan', status: 'zaakceptowany',
        frontmatter: { 'pkm-artefakt': 'art-1', cel: 'Ogarnąć Projekty' },
        sections: [{ heading: 'Kroki', text: '', items: [{ blockId: 'k1', text: 'Zrobić X', checked: false }] }],
    };
    const out = buildActiveArtifactBlock(thin);
    t.true(out.includes('art-1'));
    t.true(out.includes('Kroki'));
    t.true(out.includes('k1'));
    t.true(out.includes('```json'));
});

test('buildActiveArtifactBlock: brak artefaktu → pusty string', t => {
    t.is(buildActiveArtifactBlock(null), '');
    t.is(buildActiveArtifactBlock(undefined), '');
});

test('buildActiveArtifactBlock: przekroczony limit → przycięcie', t => {
    const bigText = 'x'.repeat(6000);
    const thin = { id: 'art-1', typ: 'plan', status: 'szkic', frontmatter: {}, sections: [{ heading: 'Duża', text: bigText, items: [] }] };
    const out = buildActiveArtifactBlock(thin, 1000);
    t.true(out.length < 1300); // nagłówek + fence + ~1000 zn
    t.true(out.includes('przycięte'));
});
