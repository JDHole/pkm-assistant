/**
 * AUD-dead-code-255 (klaster KL-09) — `OpenSessionModal` malował 8 z 9 klas `cs-open-session*`
 * bez ani jednej reguły CSS w żadnym z sześciu arkuszy repo; jego bliźniak `SessionCloseModal`
 * miał komplet. Naprawa dopisała rodzinę `.cs-open-session__*` w `chat_view.css` (wspólne
 * selektory z `.cs-session-close__*` tam, gdzie wygląd ma być identyczny).
 *
 * Ten strażnik pilnuje, żeby żadna klasa `cs-open-session*` malowana przez `OpenSessionModal.ts`
 * nigdy więcej nie została bez reguły — w KTÓRYMKOLWIEK z dwóch arkuszy, które go stylują
 * (`chat_view.css` lokalnie w module + `src/styles.css`, gdzie mieszka `__cancel-row`).
 *
 * `OpenSessionModal.ts` importuje `obsidian`, więc AVA go nie zaimportuje — strażnik czyta
 * ŹRÓDŁO regexem (wzór: `chat/stopSemantics.test.ts`, `chat/turnOwner.test.ts`).
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const modalSource = readSource('./OpenSessionModal.ts');
const chatViewCss = readSource('./chat_view.css');
const rootStylesCss = readSource('../../src/styles.css');

/** Wyciąga nazwy klas z `cls: '...'` / `cls: "..."` oraz `addClass('...')` / `addClass("...")`. */
function extractPaintedClasses(src: string): string[] {
    const classes = new Set<string>();
    const clsRe = /cls:\s*['"]([^'"]+)['"]/g;
    const addClassRe = /\.addClass\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = clsRe.exec(src))) {
        for (const c of m[1].split(/\s+/).filter(Boolean)) classes.add(c);
    }
    while ((m = addClassRe.exec(src))) {
        classes.add(m[1]);
    }
    return [...classes];
}

/** Czy KTÓRYKOLWIEK arkusz ma selektor `.<className>` (granica: nie jest prefiksem dłuższej klasy). */
function hasCssRule(className: string): boolean {
    const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\.${escaped}(?![\\w-])`);
    return re.test(chatViewCss) || re.test(rootStylesCss);
}

const paintedClasses = extractPaintedClasses(modalSource);
const openSessionClasses = paintedClasses.filter(c => c.startsWith('cs-open-session'));

test('OpenSessionModal maluje przynajmniej te klasy cs-open-session*, na których stoi cały modal', t => {
    // Test-pin na wejście: gdyby ktoś kiedyś rozjechał kod modala tak, że regex źródła nic nie
    // wyłapie, chcemy czerwony test, nie milczące "0/0 sprawdzonych".
    t.true(openSessionClasses.length >= 9, `spodziewano się >=9 klas cs-open-session*, znaleziono: ${openSessionClasses.join(', ')}`);
});

for (const className of openSessionClasses) {
    test(`klasa "${className}" malowana przez OpenSessionModal ma regułę CSS (chat_view.css lub src/styles.css)`, t => {
        t.true(hasCssRule(className), `brak reguły ".${className}" w chat_view.css i src/styles.css`);
    });
}

test('rodzina cs-open-session__btn-- (primary/cancel) ma reguły obok bazowej klasy __btn', t => {
    t.true(hasCssRule('cs-open-session__btn'));
    t.true(hasCssRule('cs-open-session__btn--primary'));
    t.true(hasCssRule('cs-open-session__btn--cancel'));
});
