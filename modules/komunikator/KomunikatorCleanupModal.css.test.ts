/**
 * Strażnik przed "żywym DOM bez reguły CSS": arkusz `KomunikatorCleanupModal.css` musi być
 * importowany i adoptowany (`adoptSheet`) w pliku, który realnie rysuje ten DOM, a każda
 * klasa `.komunikator-cleanup-*` malowana w `KomunikatorCleanupModal.ts` musi mieć
 * odpowiadającą regułę w tym arkuszu - inaczej w zbudowanym pluginie te klasy nie dostają
 * ani jednej reguły CSS. Ten test pinuje po ŹRÓDLE (nie po `dist/`), żeby nikt przypadkiem
 * nie odpiął CSS-a od żywego pliku ani nie dodał nowej klasy bez odpowiadającej reguły.
 */
import test from 'ava';
import fs from 'node:fs';

const tsSource = fs.readFileSync(new URL('./KomunikatorCleanupModal.ts', import.meta.url), 'utf8');
const cssSource = fs.readFileSync(new URL('./KomunikatorCleanupModal.css', import.meta.url), 'utf8');

test('KomunikatorCleanupModal.ts importuje własny arkusz CSS z type: css (inaczej esbuild nie zbuduje CSSStyleSheet)', t => {
    t.regex(
        tsSource,
        /import\s+\w+\s+from\s+['"]\.\/KomunikatorCleanupModal\.css['"]\s+with\s*\{\s*type:\s*['"]css['"]\s*\}/,
        'brak importu z atrybutem { type: "css" } — patrz esbuild.js, plugin importu CSS'
    );
});

test('KomunikatorCleanupModal.ts adoptuje arkusz przez adoptSheet (import sam z siebie nic nie montuje w document)', t => {
    t.regex(
        tsSource,
        /adoptSheet\(\s*komunikator_cleanup_styles\s*\)/,
        'zaimportowany arkusz nigdy nie trafia do document.adoptedStyleSheets bez adoptSheet()'
    );
});

test('każda klasa komunikator-cleanup-* malowana w KomunikatorCleanupModal.ts ma regułę w KomunikatorCleanupModal.css', t => {
    // Tylko realne cls:/addClass(...) — nie prozę komentarzy (np. "klasy `.komunikator-cleanup-*`").
    const classAttrPattern = /(?:cls:\s*[`'"]|addClass\(\s*[`'"])([^`'"]*)[`'"]/g;
    const painted = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = classAttrPattern.exec(tsSource))) {
        for (const cls of m[1].split(/\s+/)) {
            if (cls.startsWith('komunikator-cleanup')) painted.add(cls);
        }
    }
    // Jeśli regex się kiedyś zepsuje (np. zmieni się styl kodu), test ma o tym krzyczeć,
    // nie cicho przechodzić z pustym zbiorem.
    t.true(painted.size >= 7, `regex namalował tylko ${painted.size} klas — spodziewano się co najmniej 7 (modal, meta, meta__row, meta__label, meta__value, body, buttons)`);

    const selectorPattern = /\.([a-zA-Z0-9_-]+)\s*\{/g;
    const styled = new Set<string>();
    let s: RegExpExecArray | null;
    while ((s = selectorPattern.exec(cssSource))) {
        styled.add(s[1]);
    }

    // `komunikator-cleanup-modal` jest kontenerem samego Modal — dostaje bazowy layout
    // z klasy rdzenia Obsidiana `.modal`, nigdy nie miał (i nie potrzebuje) własnej
    // reguły. Jedyny świadomy wyjątek od "każda klasa ma regułę".
    const NO_RULE_NEEDED = new Set(['komunikator-cleanup-modal']);

    for (const cls of painted) {
        if (NO_RULE_NEEDED.has(cls)) continue;
        t.true(styled.has(cls), `klasa .${cls} jest malowana w KomunikatorCleanupModal.ts, ale nie ma reguły w KomunikatorCleanupModal.css`);
    }
});
