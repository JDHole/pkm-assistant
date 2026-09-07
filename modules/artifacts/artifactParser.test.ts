import test from 'ava';
import { parseArtifact, applyPatch, PROTECTED_FIELDS } from './artifactParser.js';

const SAMPLE = `---
pkm-artefakt: art-20260723-a1b2
typ: plan
agent: jaskier
status: do-akceptacji
cel: Ogarnąć folder Projekty przed nowym kwartałem
utworzono: 2026-07-23
zaktualizowano: 2026-07-23
---

## Cel
Ogarnąć folder Projekty przed nowym kwartałem.

## Kroki
- [ ] Przejrzeć 12 notatek w Projekty/Stare ^k1
- [ ] Zarchiwizować projekty bez ruchu od 90 dni ^k2
- [ ] Scalić duplikaty „Pomysły" ^k3

## Ryzyka i założenia
- Nie kasuję niczego — tylko przenoszę do Archiwum.

## Uwagi usera

\`\`\`pkm-artefakt
id: art-20260723-a1b2
\`\`\`
`;

// ── parse ──────────────────────────────────────────────────────────────────

test('parseArtifact reads frontmatter, sections, checkboxes and button block', t => {
    const parsed = parseArtifact(SAMPLE);
    t.is(parsed.frontmatter['pkm-artefakt'], 'art-20260723-a1b2');
    t.is(parsed.frontmatter.typ, 'plan');
    t.is(parsed.frontmatter.status, 'do-akceptacji');

    const headings = parsed.sections.map(s => s.heading);
    t.deepEqual(headings, ['Cel', 'Kroki', 'Ryzyka i założenia', 'Uwagi usera']);

    const kroki = parsed.sections.find(s => s.heading === 'Kroki')!;
    t.is(kroki.items.length, 3);
    t.deepEqual(kroki.items.map(i => i.blockId), ['k1', 'k2', 'k3']);
    t.true(kroki.items.every(i => i.checked === false));

    // Prose sekcji „Cel" trafia do text, checkboxy tam nie występują.
    const cel = parsed.sections.find(s => s.heading === 'Cel')!;
    t.true(cel.text.includes('Ogarnąć folder Projekty'));
    t.is(cel.items.length, 0);

    t.true(parsed.buttons);
});

test('parseArtifact tolerates missing frontmatter and empty body', t => {
    const parsed = parseArtifact('## Tylko sekcja\ntreść');
    t.deepEqual(parsed.frontmatter, {});
    t.is(parsed.sections.length, 1);
    t.false(parsed.buttons);
});

// ── roundtrip ────────────────────────────────────────────────────────────────

test('roundtrip: parse → patch (check + add) → parse is stable', t => {
    const r1 = applyPatch(SAMPLE, [{ op: 'check_item', blockId: 'k1' }]);
    t.is(r1.applied, 1);
    t.is(r1.errors.length, 0);

    const r2 = applyPatch(r1.markdown, [{ op: 'add_item', heading: 'Kroki', text: 'Nowy krok' }]);
    t.is(r2.applied, 1);

    const parsed = parseArtifact(r2.markdown);
    const kroki = parsed.sections.find(s => s.heading === 'Kroki')!;
    t.is(kroki.items.find(i => i.blockId === 'k1')!.checked, true);
    t.is(kroki.items.length, 4);
    // Auto blockId = pierwszy wolny (k4).
    t.is(kroki.items[3]!.blockId, 'k4');
    t.is(kroki.items[3]!.text, 'Nowy krok');
});

// ── polskie znaki ────────────────────────────────────────────────────────────

test('polish characters survive parse + patch', t => {
    const r = applyPatch(SAMPLE, [{ op: 'add_item', heading: 'Kroki', text: 'Zażółć gęślą jaźń — ćma' }]);
    const parsed = parseArtifact(r.markdown);
    const kroki = parsed.sections.find(s => s.heading === 'Kroki')!;
    t.is(kroki.items[3]!.text, 'Zażółć gęślą jaźń — ćma');
    t.true(r.markdown.includes('„Pomysły"')); // istniejące znaki nietknięte
});

// ── CRLF ─────────────────────────────────────────────────────────────────────

test('CRLF file stays CRLF after patch', t => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    const r = applyPatch(crlf, [{ op: 'check_item', blockId: 'k2' }]);
    t.false(/[^\r]\n/.test(r.markdown), 'no lone LF should remain');
    t.true(r.markdown.includes('\r\n'));
    const parsed = parseArtifact(r.markdown);
    t.is(parsed.sections.find(s => s.heading === 'Kroki')!.items.find(i => i.blockId === 'k2')!.checked, true);
});

test('LF file stays LF after patch', t => {
    const r = applyPatch(SAMPLE, [{ op: 'check_item', blockId: 'k2' }]);
    t.false(r.markdown.includes('\r\n'));
});

// ── patch na skasowany blockId ────────────────────────────────────────────────

test('patch on a deleted blockId reports not_found and keeps other ops', t => {
    const removed = applyPatch(SAMPLE, [{ op: 'remove_item', blockId: 'k2' }]).markdown;
    const r = applyPatch(removed, [
        { op: 'check_item', blockId: 'k2' },       // już nie istnieje
        { op: 'check_item', blockId: 'k1' },       // istnieje
    ]);
    t.is(r.applied, 1);
    t.is(r.errors.length, 1);
    t.is(r.errors[0]!.code, 'not_found');
    const parsed = parseArtifact(r.markdown);
    t.is(parsed.sections.find(s => s.heading === 'Kroki')!.items.find(i => i.blockId === 'k1')!.checked, true);
});

// ── code fence reject ─────────────────────────────────────────────────────────

test('code fence in set_section is rejected (code_forbidden)', t => {
    const r = applyPatch(SAMPLE, [{ op: 'set_section', heading: 'Ryzyka i założenia', text: '```js\nalert(1)\n```' }]);
    t.is(r.applied, 0);
    t.is(r.errors[0]!.code, 'code_forbidden');
    // Treść pliku nietknięta.
    t.is(r.markdown, SAMPLE);
});

test('code fence in add_item is rejected (code_forbidden)', t => {
    const r = applyPatch(SAMPLE, [{ op: 'add_item', heading: 'Kroki', text: 'zrób ```rm -rf```' }]);
    t.is(r.applied, 0);
    t.is(r.errors[0]!.code, 'code_forbidden');
});

test('multiline add_item is rejected (multiline_forbidden)', t => {
    const r = applyPatch(SAMPLE, [{ op: 'add_item', heading: 'Kroki', text: 'linia1\nlinia2' }]);
    t.is(r.applied, 0);
    t.is(r.errors[0]!.code, 'multiline_forbidden');
});

// ── nagłówki sekcji (#/##) w treści — Poligon F2 ───────────────────────────────
// Bieg live: model wpisał `## Źródła` do TREŚCI innej sekcji → w pliku powstał DRUGI
// nagłówek o tej nazwie, a `findSection` zwraca PIERWSZE trafienie, więc oryginalna
// sekcja została osierocona i kolejne patche trafiały w podrobioną.

test('set_section z nagłówkiem ## jest odrzucony (heading_forbidden), plik NIETKNIĘTY', t => {
    const r = applyPatch(SAMPLE, [{
        op: 'set_section',
        heading: 'Ryzyka i założenia',
        text: 'Ustalenia są takie.\n\n## Źródła\n- [[Notatka]]',
    }]);
    t.is(r.applied, 0);
    t.is(r.errors[0]!.code, 'heading_forbidden');
    t.is(r.markdown, SAMPLE);
    // Nie powstał drugi nagłówek o tej nazwie.
    t.is(parseArtifact(r.markdown).sections.filter(s => s.heading === 'Źródła').length, 0);
});

test('set_section z nagłówkiem # (poziom 1) też jest odrzucony', t => {
    const r = applyPatch(SAMPLE, [{ op: 'set_section', heading: 'Cel', text: '# Nowy tytuł\ntreść' }]);
    t.is(r.applied, 0);
    t.is(r.errors[0]!.code, 'heading_forbidden');
    t.is(r.markdown, SAMPLE);
});

test('set_section z podtytułem ### PRZECHODZI (legalne wewnątrz sekcji)', t => {
    const r = applyPatch(SAMPLE, [{
        op: 'set_section',
        heading: 'Ryzyka i założenia',
        text: '### Ryzyko techniczne\n- Coś tam.\n\n#### Szczegół\n- Głębiej też wolno.',
    }]);
    t.is(r.applied, 1);
    t.is(r.errors.length, 0);
    const sekcja = parseArtifact(r.markdown).sections.find(s => s.heading === 'Ryzyka i założenia')!;
    t.true(sekcja.text.includes('### Ryzyko techniczne'));
    t.true(sekcja.text.includes('#### Szczegół'));
    // `###` NIE tworzy nowej sekcji — lista sekcji bez zmian.
    t.deepEqual(
        parseArtifact(r.markdown).sections.map(s => s.heading),
        ['Cel', 'Kroki', 'Ryzyka i założenia', 'Uwagi usera'],
    );
});

test('nagłówek w ŚRODKU tekstu (nie w pierwszej linii) też jest łapany — także przy CRLF', t => {
    const lf = applyPatch(SAMPLE, [{ op: 'set_section', heading: 'Cel', text: 'a\nb\n## Podszywka\nc' }]);
    t.is(lf.errors[0]!.code, 'heading_forbidden');

    const crlf = applyPatch(SAMPLE.replace(/\n/g, '\r\n'), [
        { op: 'set_section', heading: 'Cel', text: 'a\r\n## Podszywka\r\nc' },
    ]);
    t.is(crlf.applied, 0);
    t.is(crlf.errors[0]!.code, 'heading_forbidden');
});

test('add_item z jednolinijkowym „## X" jest odrzucony (nie prześlizguje się obok multiline)', t => {
    const r = applyPatch(SAMPLE, [{ op: 'add_item', heading: 'Kroki', text: '## Źródła' }]);
    t.is(r.applied, 0);
    t.is(r.errors[0]!.code, 'heading_forbidden');
    t.is(r.markdown, SAMPLE);
});

test('add_item z „###" przechodzi — poziom 3+ nie tworzy sekcji', t => {
    const r = applyPatch(SAMPLE, [{ op: 'add_item', heading: 'Kroki', text: '### to tylko tekst kroku' }]);
    t.is(r.applied, 1);
    t.is(r.errors.length, 0);
});

test('„#hashtag" bez spacji NIE jest nagłówkiem — przechodzi', t => {
    const r = applyPatch(SAMPLE, [{ op: 'set_section', heading: 'Cel', text: '#projekt #plan — tagi, nie nagłówki' }]);
    t.is(r.applied, 1);
    t.is(r.errors.length, 0);
});

// ── protected keys ────────────────────────────────────────────────────────────

test('set_field on protected keys is rejected (protected_key)', t => {
    for (const key of PROTECTED_FIELDS) {
        const r = applyPatch(SAMPLE, [{ op: 'set_field', key, value: 'hacked' }]);
        t.is(r.applied, 0, `${key} must be immutable`);
        t.is(r.errors[0]!.code, 'protected_key');
    }
});

test('set_field on a normal field works and only scalars are accepted', t => {
    const ok = applyPatch(SAMPLE, [{ op: 'set_field', key: 'status', value: 'zaakceptowany' }]);
    t.is(ok.applied, 1);
    t.is(parseArtifact(ok.markdown).frontmatter.status, 'zaakceptowany');

    const bad = applyPatch(SAMPLE, [{ op: 'set_field', key: 'cel', value: { nested: true } }]);
    t.is(bad.applied, 0);
    t.is(bad.errors[0]!.code, 'invalid_value');
});

// ── edycja usera przeżywa patch ───────────────────────────────────────────────

test('user edits to unaddressed sections survive a patch', t => {
    // User dopisał notatkę w „Uwagi usera" między odczytem a patchem agenta.
    const edited = SAMPLE.replace('## Uwagi usera\n', '## Uwagi usera\nProszę zacząć od duplikatów.\n');
    const r = applyPatch(edited, [{ op: 'check_item', blockId: 'k3' }]);
    t.true(r.markdown.includes('Proszę zacząć od duplikatów.'));
    const parsed = parseArtifact(r.markdown);
    t.true(parsed.sections.find(s => s.heading === 'Uwagi usera')!.text.includes('Proszę zacząć od duplikatów.'));
    t.is(parsed.sections.find(s => s.heading === 'Kroki')!.items.find(i => i.blockId === 'k3')!.checked, true);
});

test('set_section replaces only the addressed section body', t => {
    const r = applyPatch(SAMPLE, [{ op: 'set_section', heading: 'Ryzyka i założenia', text: '- Zupełnie nowe ryzyko.' }]);
    t.is(r.applied, 1);
    const parsed = parseArtifact(r.markdown);
    t.true(parsed.sections.find(s => s.heading === 'Ryzyka i założenia')!.text.includes('Zupełnie nowe ryzyko'));
    // Kroki nietknięte.
    t.is(parsed.sections.find(s => s.heading === 'Kroki')!.items.length, 3);
});

test('uncheck_item flips a checked box back', t => {
    const checked = applyPatch(SAMPLE, [{ op: 'check_item', blockId: 'k1' }]).markdown;
    const r = applyPatch(checked, [{ op: 'uncheck_item', blockId: 'k1' }]);
    t.is(parseArtifact(r.markdown).sections.find(s => s.heading === 'Kroki')!.items.find(i => i.blockId === 'k1')!.checked, false);
});

test('add_item picks the first free k-id even with gaps', t => {
    // Usuń k2 → wolny numer to k2, nie k4.
    const removed = applyPatch(SAMPLE, [{ op: 'remove_item', blockId: 'k2' }]).markdown;
    const r = applyPatch(removed, [{ op: 'add_item', heading: 'Kroki', text: 'wypełniacz luki' }]);
    const added = parseArtifact(r.markdown).sections.find(s => s.heading === 'Kroki')!.items.find(i => i.text === 'wypełniacz luki')!;
    t.is(added.blockId, 'k2');
});

test('unknown op is reported, not thrown', t => {
    const r = applyPatch(SAMPLE, [{ op: 'nuke_everything' }]);
    t.is(r.applied, 0);
    t.is(r.errors[0]!.code, 'invalid_op');
});

// ── K10 (AUD-security-089): bramka kodu liczy WSZYSTKIE nośniki kodu, nie sam grawis ──
// Wcześniej `CODE_FENCE_RE = /```/` widziała wyłącznie potrójny grawis, więc ten sam ładunek
// napisany tyldami albo w HTML-u przechodził przez bramkę i lądował w notatce vaulta.

test('K10: fence tyldowy (~~~) w set_section jest odrzucony tak jak grawisy', t => {
    const r = applyPatch(SAMPLE, [{ op: 'set_section', heading: 'Ryzyka i założenia', text: '~~~dataviewjs\nevil()\n~~~' }]);
    t.is(r.applied, 0);
    t.is(r.errors[0]!.code, 'code_forbidden');
    t.is(r.markdown, SAMPLE);
});

test('K10: fence tyldowy w add_item też jest odrzucony', t => {
    const r = applyPatch(SAMPLE, [{ op: 'add_item', heading: 'Kroki', text: 'zrób ~~~js evil() ~~~' }]);
    t.is(r.applied, 0);
    t.is(r.errors[0]!.code, 'code_forbidden');
});

test('K10: HTML <pre> / <code> / <script> w treści jest odrzucony (code_forbidden)', t => {
    for (const payload of ['<pre>evil()</pre>', '<code>evil()</code>', '<script>evil()</script>', '<iframe src="x">']) {
        const r = applyPatch(SAMPLE, [{ op: 'set_section', heading: 'Cel', text: payload }]);
        t.is(r.applied, 0, payload);
        t.is(r.errors[0]!.code, 'code_forbidden', payload);
        t.is(r.markdown, SAMPLE, payload);
    }
});

test('K10: zwykły tekst z tyldą pojedynczą/podwójną PRZECHODZI (bez fałszywek)', t => {
    const r = applyPatch(SAMPLE, [{ op: 'set_section', heading: 'Cel', text: 'około ~5 dni, zakres ~~stary~~ nowy' }]);
    t.is(r.applied, 1);
    t.is(r.errors.length, 0);
});

test('K10: wcięcie 4 spacjami PRZECHODZI — zagnieżdżona lista to nie blok kodu', t => {
    const r = applyPatch(SAMPLE, [{ op: 'set_section', heading: 'Cel', text: '- punkt\n    - podpunkt' }]);
    t.is(r.applied, 1);
    t.is(r.errors.length, 0);
});

test('K10: parseArtifact.buttons widzi blok pkm-artefakt także w wariancie tyldowym', t => {
    t.true(parseArtifact('---\npkm-artefakt: art-1\n---\n\n~~~pkm-artefakt\nid: art-1\n~~~\n').buttons);
    t.true(parseArtifact('---\npkm-artefakt: art-1\n---\n\n```pkm-artefakt\nid: art-1\n```\n').buttons);
});

// ── M (AUD-security-122/124): bramka i zlew widzą TEN SAM zbiór nagłówków ───────
// Do fali M `heading_forbidden` mierzył `<=2`, a `findSection` szukał po `1-6` i łamał
// linie tylko po `\r?\n`. Trzy dziury: podrobiony `###` przejmował patch adresowany do
// prawdziwej sekcji, setext (`Tytul` + `===`/`---`) i samotny `\r` przechodziły bramkę.

test('M122: patch celujący w „## Uwagi usera" NIE trafia w podrobiony „### Uwagi usera"', t => {
    // Notatka, w której ktoś (user albo model przed naprawą) zostawił `###` o nazwie sekcji.
    const withFake = SAMPLE.replace(
        '## Ryzyka i założenia\n- Nie kasuję niczego — tylko przenoszę do Archiwum.',
        '## Ryzyka i założenia\n- Nie kasuję niczego — tylko przenoszę do Archiwum.\n\n### Uwagi usera\nnic tu nie ma',
    );
    const r = applyPatch(withFake, [{ op: 'set_section', heading: 'Uwagi usera', text: 'zatwierdzam' }]);
    t.is(r.applied, 1);
    t.is(r.errors.length, 0);

    const sections = parseArtifact(r.markdown).sections;
    // Sekcja „Ryzyka i założenia" NIETKNIĘTA — patch nie zjadł jej razem z podszywką.
    const ryzyka = sections.find(s => s.heading === 'Ryzyka i założenia')!;
    t.true(ryzyka.text.includes('Nie kasuję niczego'));
    t.true(ryzyka.text.includes('### Uwagi usera'), 'podrobiony podtytuł zostaje w swojej sekcji');
    // Tekst wylądował w PRAWDZIWEJ sekcji poziomu 2.
    t.is(sections.find(s => s.heading === 'Uwagi usera')!.text, 'zatwierdzam');
});

test('M124: setext (`Tytul` + `===` / `---`) jest łapany przez heading_forbidden', t => {
    for (const payload of ['Podrobiony H1\n===', 'Podrobiony H2\n---', 'Podrobiony H2\r\n----']) {
        const r = applyPatch(SAMPLE, [{ op: 'set_section', heading: 'Cel', text: payload }]);
        t.is(r.applied, 0, payload);
        t.is(r.errors[0]!.code, 'heading_forbidden', payload);
        t.is(r.markdown, SAMPLE, payload);
    }
});

test('M124: samotny `\r` łamie linię tak jak renderer — nagłówek za nim jest łapany', t => {
    const r = applyPatch(SAMPLE, [{ op: 'set_section', heading: 'Cel', text: 'zwykly tekst\r## Podrobiona sekcja' }]);
    t.is(r.applied, 0);
    t.is(r.errors[0]!.code, 'heading_forbidden');
    t.is(r.markdown, SAMPLE);
});

test('M124: add_item z samotnym `\r` to wielolinijkowiec (multiline_forbidden)', t => {
    const r = applyPatch(SAMPLE, [{ op: 'add_item', heading: 'Kroki', text: 'punkt\rdrugie zdanie' }]);
    t.is(r.applied, 0);
    t.is(r.errors[0]!.code, 'multiline_forbidden');
    t.is(r.markdown, SAMPLE);
});

test('M124: separator `---` po pustej linii PRZECHODZI (to hr, nie setext)', t => {
    const r = applyPatch(SAMPLE, [{ op: 'set_section', heading: 'Cel', text: 'akapit\n\n---\n\ndrugi akapit' }]);
    t.is(r.applied, 1);
    t.is(r.errors.length, 0);
});

test('M124: kreska pod punktem listy PRZECHODZI (setext nie przerywa listy)', t => {
    const r = applyPatch(SAMPLE, [{ op: 'set_section', heading: 'Cel', text: '- punkt\n---' }]);
    t.is(r.applied, 1);
    t.is(r.errors.length, 0);
});

test('AUD-code-review-104: kreska pod NUMEROWANYM punktem listy PRZECHODZI (setext nie przerywa listy)', t => {
    for (const payload of ['1. krok\n---', '1) krok\n---', '12. krok\n---']) {
        const r = applyPatch(SAMPLE, [{ op: 'set_section', heading: 'Cel', text: payload }]);
        t.is(r.applied, 1, payload);
        t.is(r.errors.length, 0, payload);
    }
});
