/**
 * K11 (AUD-security-090, twardnienie) — kolor z profilu agenta nie może wpisać markupu,
 * a `_scrub` musi wycinać elementy ściągające cudze zasoby, nie tylko `script`.
 *
 * Znalezisko było OBALONE jako luka (źródło `color` jest dziś zamknięte: `.pkm-assistant/**`
 * fail-closed dla narzędzi bez `admin_access`, a UI zapisuje hex z palety), ale mechanika
 * była prawdziwa. Ten test pilnuje, żeby obie połowy zostały domknięte.
 */
import test from 'ava';
import { sanitizeSvgColor } from './SvgHelper.js';
import { CrystalGenerator } from './CrystalGenerator.js';

test('K11 090: przepuszczamy realne kształty koloru', t => {
    for (const ok of ['#abc', '#7B5EA7', '#7B5EA7FF', 'rgb(10, 20, 30)', 'rgba(1,2,3,0.5)',
        'hsl(120 50% 50%)', 'var(--text-accent)', 'currentColor', 'none', 'transparent', 'tomato']) {
        t.is(sanitizeSvgColor(ok), ok, `odrzucony poprawny kolor: ${ok}`);
    }
});

test('K11 090: wartość z markupem wraca jako currentColor', t => {
    const atak = '#fff" /><image href="https://evil.example/ping.png" x="0" y="0" width="1" height="1"/><polygon points="0,0';
    t.is(sanitizeSvgColor(atak), 'currentColor');
    t.is(sanitizeSvgColor('red;background:url(https://evil.example)'), 'currentColor');
    t.is(sanitizeSvgColor('url(https://evil.example/x.svg)'), 'currentColor');
    t.is(sanitizeSvgColor(null), 'currentColor');
    t.is(sanitizeSvgColor('#'.repeat(80)), 'currentColor');
});

test('K11 090: kryształ agenta nie wpuszcza cudzego elementu do markupu', t => {
    const atak = '#fff" /><image href="https://evil.example/ping.png"/><polygon points="0,0';
    const svg = CrystalGenerator.generate('jaskier', { color: atak });
    t.false(svg.includes('<image'), svg.slice(0, 400));
    t.false(svg.includes('evil.example'), svg.slice(0, 400));
    t.true(svg.includes('currentColor'));

    // Ta sama bramka na drugim wejściu — `generateInner` bywa wołane wprost.
    t.false(CrystalGenerator.generateInner('jaskier', atak).includes('<image'));
});

/**
 * `_scrub` chodzi po drzewie DOM, którego w AVA nie ma — podajemy mu więc drzewo
 * o tym samym kształcie (`attributes` / `children` / `removeAttribute` / `remove`).
 * To NIE jest atrapa testowanej funkcji, tylko jej wejście.
 */
type FakeEl = {
    tagName: string;
    attributes: Array<{ name: string; value: string }>;
    children: FakeEl[];
    removeAttribute(name: string): void;
    remove(): void;
    _parent?: FakeEl;
};
function el(tagName: string, attrs: Record<string, string> = {}, children: FakeEl[] = []): FakeEl {
    const node: FakeEl = {
        tagName,
        attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
        children,
        removeAttribute(name) { node.attributes = node.attributes.filter(a => a.name !== name); },
        remove() {
            const p = node._parent;
            if (p) p.children = p.children.filter(c => c !== node);
        },
    };
    for (const c of children) c._parent = node;
    return node;
}

test('K11 090: _scrub wycina elementy ściągające cudze zasoby, nie tylko script', async t => {
    const { SvgHelper } = await import('./SvgHelper.js');
    const root = el('svg', {}, [
        el('polygon', { points: '0,0', fill: '#fff' }),
        el('image', { href: 'https://evil.example/ping.png' }),
        el('use', { 'xlink:href': 'https://evil.example/x.svg#a' }),
        el('script', {}),
        el('animate', { attributeName: 'href', to: 'https://evil.example/' }),
        el('g', {}, [el('foreignObject', {}), el('circle', { onload: 'alert(1)', r: '3' })]),
    ]);

    (SvgHelper as unknown as { _scrub(e: unknown): void })._scrub(root);

    const tagi = root.children.map(c => c.tagName);
    t.deepEqual(tagi, ['polygon', 'g'], `zostały: ${tagi.join(', ')}`);
    const g = root.children[1];
    t.deepEqual(g.children.map(c => c.tagName), ['circle']);
    t.deepEqual(g.children[0].attributes.map(a => a.name), ['r'], 'onload zdjęty');
});

test('K11 090: _scrub zostawia lokalne odwołanie #id (filtry glow działają dalej)', async t => {
    const { SvgHelper } = await import('./SvgHelper.js');
    const root = el('svg', {}, [el('rect', { href: '#cg-123', fill: 'red' })]);

    (SvgHelper as unknown as { _scrub(e: unknown): void })._scrub(root);

    t.deepEqual(root.children[0].attributes.map(a => a.name).sort(), ['fill', 'href']);
});
