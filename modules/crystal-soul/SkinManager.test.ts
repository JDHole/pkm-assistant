import test from 'ava';
import { SkinManagerClass } from './SkinManager.js';
import { pickColor } from './ColorPalette.js';
import { crystalSoulSkin } from './skins/crystal-soul.js';
import { defaultSkin } from './skins/default.js';
import { SkinLoader } from './SkinLoader.js';
import type { Vault } from 'obsidian';

test('SkinManager defaults to Crystal Soul and resolves agent_default color', t => {
    const manager = new SkinManagerClass();
    manager.plugin = { settings: {} };

    t.is(manager.getActiveSkin().id, 'crystal-soul');
    t.is(manager.getColor('agent_default'), crystalSoulSkin.colors.agent_default);
});

test('SkinManager can switch to Default skin and render monogram avatar', async t => {
    const manager = new SkinManagerClass();
    manager.plugin = { settings: {} };

    const ok = await manager.setActiveSkin('default', { save: false });

    t.true(ok);
    t.is(manager.getActiveSkin().id, 'default');
    t.true(manager.getCrystal({ name: 'Jaskier Mentor' }).includes('JM'));
});

test('Default skin ignores derived Crystal Soul crystalColor when agent has no explicit color', async t => {
    const manager = new SkinManagerClass();
    manager.plugin = { settings: {} };
    await manager.setActiveSkin('default', { save: false });
    const agent = {
        name: 'No Color Agent',
        color: null,
        get crystalColor() {
            return pickColor(this.name).hex;
        },
    };

    const defaultColor = manager.getAgentColor(agent);

    t.regex(defaultColor, /^#[0-9a-f]{6}$/i);
    t.not(defaultColor, pickColor(agent.name).hex);
});

test('SkinManager custom skin inherits parent and overrides per key', t => {
    const manager = new SkinManagerClass();
    manager.plugin = { settings: { activeSkin: 'custom-rose' } };
    manager.customSkins.set('custom-rose', {
        id: 'custom-rose',
        name: 'Rose',
        parent: 'default',
        colors: {
            agent_default: '#ff6b6b',
        },
    });

    t.is(manager.getActiveSkin().id, 'custom-rose');
    t.is(manager.getColor('agent_default'), '#ff6b6b');
    t.is(manager.getColor('background_chat'), 'var(--background-primary)');
});

/**
 * AUD-code-review-092 — `parent` w YAML usera potrafi wskazywać samego siebie albo cyklicznie
 * dwa custom skiny nawzajem. Bez wykrywania cyklu `resolveSkin` rekurowałby w nieskończoność
 * (`RangeError: Maximum call stack size exceeded`) i wywalał każdy render UI dotykający skina.
 */
test('SkinManager resolveSkin wykrywa self-referencję parent i pada do default zamiast RangeError', t => {
    const manager = new SkinManagerClass();
    manager.plugin = { settings: { activeSkin: 'custom-self' } };
    manager.customSkins.set('custom-self', {
        id: 'custom-self',
        name: 'Self',
        parent: 'custom-self',
        colors: { agent_default: '#111111' },
    });

    const resolved = manager.getActiveSkin();

    // Merge zwycięskiego custom (kolor nadpisany) na fallbacku default (nie crash).
    t.is(resolved.colors.agent_default, '#111111');
});

test('SkinManager resolveSkin wykrywa cykl dwóch skinów wskazujących na siebie nawzajem', t => {
    const manager = new SkinManagerClass();
    manager.plugin = { settings: { activeSkin: 'custom-a' } };
    manager.customSkins.set('custom-a', { id: 'custom-a', name: 'A', parent: 'custom-b' });
    manager.customSkins.set('custom-b', { id: 'custom-b', name: 'B', parent: 'custom-a' });

    t.notThrows(() => manager.getActiveSkin());
});

test('SkinManager emits skin_changed when active skin changes', async t => {
    const manager = new SkinManagerClass();
    manager.plugin = { settings: {} };
    let received = null;
    manager.on('skin_changed', payload => { received = payload; });

    await manager.setActiveSkin('default', { save: false });

    t.is((received as unknown as { skinId: string }).skinId, 'default');
});

/**
 * AUD-bledy-037 — arkusz skina wraca z `document.adoptedStyleSheets` przy demontażu.
 *
 * Przed naprawą `applyCss()` dokładał skonstruowany arkusz i NIC go nie zdejmowało:
 * wyłączony plugin dalej stylizował Obsidiana aż do restartu, a każdy cykl
 * wyłącz/włącz dokładał kolejny arkusz (nowy obiekt nie przechodzi testu `.includes`).
 */
type FakeSheet = { replaceSync(css: string): void; css: string };
type FakeDoc = { adoptedStyleSheets: FakeSheet[]; body: FakeBody };
type FakeBody = {
    classes: Set<string>;
    attrs: Map<string, string>;
    props: Map<string, string>;
    classList: { add(c: string): void; remove(c: string): void };
    setAttribute(k: string, v: string): void;
    removeAttribute(k: string): void;
    style: { setProperty(k: string, v: string): void; removeProperty(k: string): void };
};

function installFakeDom(): { doc: FakeDoc; restore: () => void } {
    const g = globalThis as Record<string, unknown>;
    const prevDoc = g.document;
    const prevSheet = g.CSSStyleSheet;
    const body: FakeBody = {
        classes: new Set<string>(),
        attrs: new Map<string, string>(),
        props: new Map<string, string>(),
        classList: {
            add(c: string) { body.classes.add(c); },
            remove(c: string) { body.classes.delete(c); },
        },
        setAttribute(k: string, v: string) { body.attrs.set(k, v); },
        removeAttribute(k: string) { body.attrs.delete(k); },
        style: {
            setProperty(k: string, v: string) { body.props.set(k, v); },
            removeProperty(k: string) { body.props.delete(k); },
        },
    };
    const doc: FakeDoc = { adoptedStyleSheets: [], body };
    g.document = doc;
    g.CSSStyleSheet = class {
        css = '';
        replaceSync(css: string) { this.css = css; }
    };
    return {
        doc,
        restore: () => {
            if (prevDoc === undefined) delete g.document; else g.document = prevDoc;
            if (prevSheet === undefined) delete g.CSSStyleSheet; else g.CSSStyleSheet = prevSheet;
        },
    };
}

test.serial('AUD-bledy-037: dispose() zdejmuje arkusz skina z adoptedStyleSheets', t => {
    const { doc, restore } = installFakeDom();
    try {
        const manager = new SkinManagerClass();
        manager.plugin = { settings: {} };

        manager.applyCss();
        t.is(doc.adoptedStyleSheets.length, 1, 'applyCss dokłada arkusz');

        manager.dispose();

        t.is(doc.adoptedStyleSheets.length, 0, 'demontaż zdejmuje arkusz — wyłączony plugin nie stylizuje Obsidiana');
        t.false(doc.body.classes.has('pkm-skin-root'), 'znacznik klasy zdjęty z body');
        t.false(doc.body.attrs.has('data-pkm-skin'), 'atrybut skina zdjęty z body');
        t.false(doc.body.props.has('--pkm-skin-accent'), 'zmienne skina zdjęte z body');
    } finally {
        restore();
    }
});

test.serial('AUD-bledy-037: dispose() jest idempotentny, a po nim applyCss dokłada arkusz raz', t => {
    const { doc, restore } = installFakeDom();
    try {
        const manager = new SkinManagerClass();
        manager.plugin = { settings: {} };

        manager.applyCss();
        manager.dispose();
        manager.dispose();
        t.is(doc.adoptedStyleSheets.length, 0, 'drugi dispose nie psuje listy');

        manager.applyCss();
        manager.applyCss();
        t.is(doc.adoptedStyleSheets.length, 1, 'po ponownym montażu dokładnie JEDEN arkusz, nie dwa');
    } finally {
        restore();
    }
});

/**
 * Follow-up AUD-dead-code-198 (2026-09-02) — pole `icons` wycięte z `SkinSpec` (jedynym
 * czytelnikiem był skasowany `getIcon()`). Archiwalny schemat S12 pokazywał `icons:` w YAML
 * usera, więc taki klucz może siedzieć w czyimś pliku. Loader nie ma schematu: nieznany klucz
 * przechodzi przez `...custom` w `mergeSkin()` i nikt go nie czyta — ładowanie i dziedziczenie
 * mają działać dokładnie tak samo jak bez niego.
 */
test('SkinLoader + mergeSkin tolerują obcy klucz `icons:` w YAML usera (pole wycięte ze SkinSpec)', async t => {
    const yaml = [
        'name: "Ikonowy"',
        'parent: "default"',
        'colors:',
        '  agent_default: "#123456"',
        'icons:',
        '  brain: "🧠"',
        '',
    ].join('\n');
    const fakeVault = {
        adapter: {
            exists: async () => true,
            list: async () => ({ files: ['.pkm-assistant/skins/ikonowy.yaml'], folders: [] }),
            read: async () => yaml,
        },
    } as unknown as Vault;

    const manager = new SkinManagerClass();
    manager.plugin = { settings: { activeSkin: 'custom-ikonowy' } };
    manager.loader = new SkinLoader(fakeVault);
    const loaded = await manager.reloadCustomSkins();

    t.is(loaded.length, 1, 'YAML z obcym kluczem ładuje się jak każdy inny');
    const resolved = manager.getActiveSkin();
    t.is(resolved.id, 'custom-ikonowy');
    t.is(manager.getColor('agent_default'), '#123456', 'override koloru z YAML działa');
    t.is(manager.getColor('background_chat'), 'var(--background-primary)', 'dziedziczenie z default działa');
    t.false('icons' in defaultSkin, 'wbudowany skin nie niesie już pola icons');
    t.false('icons' in crystalSoulSkin, 'wbudowany skin nie niesie już pola icons');
});

// ── „boot nie pisze": provisioning idzie do SUROWEGO worka ───────────────────
//
// `ensureSettings()` dosztukowuje domyślny skin przy starcie. Mutacja OBSERWOWANEGO proxy
// planuje wtedy zapis całego `.pkm-assistant/settings.json` (a tam mieszkają klucze API)
// sekundę po boocie — to ta sama klasa co incydent 2026-07-28. Strażnik end-to-end:
// scenariusz harnessa `39_boot_nie_pisze`.

/** Atrapa magazynu: worek `raw` + licznik zaplanowanych zapisów, jak w `SettingsStore`. */
function magazynZProxy() {
    const raw: { pkmAssistant: Record<string, unknown> } = { pkmAssistant: {} };
    const zaplanowane: string[] = [];
    const proxy = new Proxy(raw.pkmAssistant, {
        set(cel, klucz, wartosc) {
            zaplanowane.push(String(klucz));
            return Reflect.set(cel, klucz, wartosc);
        },
    });
    return { raw, proxy, zaplanowane };
}

test('ensureSettings: domyślny skin ląduje w SUROWYM worku, bez planowania zapisu', t => {
    const { raw, proxy, zaplanowane } = magazynZProxy();
    const manager = new SkinManagerClass();
    manager.plugin = {
        env: { settings: { pkmAssistant: proxy }, settingsStore: { raw } },
    };

    manager.ensureSettings();

    t.is(raw.pkmAssistant.activeSkin, 'crystal-soul', 'wartość ma być w worku, żeby czytelnicy ją widzieli');
    t.deepEqual(zaplanowane, [], 'zapis ustawień zaplanowany w ścieżce bootowej — plik z kluczami API zostałby przepisany');
    t.is(manager.getActiveSkin().id, 'crystal-soul', 'czytelnik (przez proxy) widzi tę samą wartość');
});

test('ensureSettings: bez magazynu (goły plugin.settings) dalej dosztukowuje wartość', t => {
    const manager = new SkinManagerClass();
    manager.plugin = { settings: {} };

    const settings = manager.ensureSettings();

    t.is(settings?.activeSkin, 'crystal-soul');
});

test('setActiveSkin: wybór usera idzie DALEJ przez proxy (to nie jest provisioning)', async t => {
    const { raw, proxy, zaplanowane } = magazynZProxy();
    const manager = new SkinManagerClass();
    manager.plugin = {
        env: { settings: { pkmAssistant: proxy }, settingsStore: { raw } },
    };

    await manager.setActiveSkin('default', { save: false });

    t.is(raw.pkmAssistant.activeSkin, 'default');
    t.true(zaplanowane.includes('activeSkin'), 'decyzja usera MUSI planować zapis — inaczej wybór skina nie przeżyje restartu');
});
