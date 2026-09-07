/**
 * AUD-dead-code-256 (2026-09-02) — `render()` painted six `pkm-settings-v2*` class names with
 * zero CSS rule in any of the six stylesheets in the repo. Styling was carried entirely by the
 * live `pkm-settings-*` dublers added alongside them (`src/styles.css:831-847`), except
 * `pkm-settings-v2__subfields`, which had NO dubler at all. Fix: `render()` paints only the
 * live names; `__subfields` lost its class outright (no replacement — no rule existed for it
 * either, and the container is a bare wrapper styled by its children's own `setting-item`
 * markup).
 *
 * `SettingsRegistry.ts` has zero imports (no `obsidian`), so this test drives `render()` with a
 * minimal fake DOM element instead of reading source regexes.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { SettingsRegistryClass } from './SettingsRegistry.js';

class FakeEl {
    tagName: string;
    children: FakeEl[] = [];
    classSet = new Set<string>();
    textContent = '';
    constructor(tagName = 'div') { this.tagName = tagName; }
    get classList() {
        const set = this.classSet;
        return {
            add: (...names: string[]) => { for (const n of names) if (n) set.add(n); },
            contains: (n: string) => set.has(n),
        };
    }
    addClass(name: string): void { if (name) this.classSet.add(name); }
    createDiv(opts: { cls?: string } = {}): FakeEl {
        const el = new FakeEl('div');
        if (opts.cls) for (const c of opts.cls.split(/\s+/).filter(Boolean)) el.classSet.add(c);
        this.children.push(el);
        return el;
    }
    createEl(tag: string, opts: { cls?: string; text?: string } = {}): FakeEl {
        const el = new FakeEl(tag);
        if (opts.cls) for (const c of opts.cls.split(/\s+/).filter(Boolean)) el.classSet.add(c);
        if (opts.text) el.textContent = opts.text;
        this.children.push(el);
        return el;
    }
    empty(): void { this.children = []; }
    addEventListener(): void { /* no-op — nothing in these tests clicks a tab */ }
}

function collectClasses(el: FakeEl, out: Set<string> = new Set()): Set<string> {
    for (const c of el.classSet) out.add(c);
    for (const child of el.children) collectClasses(child, out);
    return out;
}

test('render() never paints a pkm-settings-v2* class (AUD-dead-code-256)', async t => {
    const registry = new SettingsRegistryClass();
    registry.register({ id: 'memory', label: 'Memory', order: 10, render() {} });
    registry.registerSubFields('memory', [{ id: 'sub', order: 10, render() {} }]);

    const containerEl = new FakeEl('div') as unknown as any;
    await registry.render(containerEl, {}, {});

    const classes = collectClasses(containerEl as unknown as FakeEl);
    for (const c of classes) {
        t.false(c.startsWith('pkm-settings-v2'), `unexpected pkm-settings-v2* class painted: ${c}`);
    }
});

test('render() paints the live pkm-settings-* names (layout/nav/content/nav__btn)', async t => {
    const registry = new SettingsRegistryClass();
    registry.register({ id: 'memory', label: 'Memory', order: 10, render() {} });

    const containerEl = new FakeEl('div') as unknown as any;
    await registry.render(containerEl, {}, {});

    const classes = collectClasses(containerEl as unknown as FakeEl);
    t.true(classes.has('pkm-settings-layout'));
    t.true(classes.has('pkm-settings-nav'));
    t.true(classes.has('pkm-settings-content'));
    t.true(classes.has('pkm-settings-nav__btn'));
});

/** Strips /* *‍/ block comments and // line comments — the strażnik pilnuje CODE, not history notes. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Test-pin required by the task: the CODE of SettingsRegistry.ts must never regain the string
// 'pkm-settings-v2' — cheaper than the behavioral test above and catches a regression even if
// someone later reintroduces the string in a branch the behavioral test doesn't exercise. Doc
// comments (including this fix's own changelog note) are allowed to name the retired class.
test('SettingsRegistry.ts code does not contain the string pkm-settings-v2', t => {
    const source = readFileSync(fileURLToPath(new URL('./SettingsRegistry.ts', import.meta.url)), 'utf8');
    t.false(stripComments(source).includes('pkm-settings-v2'));
});
