import test from 'ava';
import {
    CORE_RULES,
    EXTENDED_RULES,
    DECISION_TREE_DEFAULTS,
    resolveDecisionTreeInstructions,
    splitDecisionTreeRules,
    ruleTextKey,
} from './decisionTree.js';
import { PromptBuilder } from './PromptBuilder.js';
import { setLocale } from '../../core/i18n/index.js';
// Aliasy, bo testy niżej używają lokalnych `pl`/`en` na rozstrzygnięte reguły.
import { pl as plDict } from '../../core/i18n/pl.js';
import { en as enDict } from '../../core/i18n/en.js';

/**
 * Testy językowe są `serial` i KAŻDY wraca do `'en'` (domyślny locale procesu) - `setLocale()`
 * przestawia stan globalny modułu i18n, więc zostawienie po sobie `'pl'` przewróciłoby inne pliki.
 */
const AGENT = { name: 'Tola', personality: '', disabled_tools: [] };
const CTX = { vaultName: 'Vault', currentDate: '2026-09-13' };

/** Sekcja „JAK PRACUJĘ" tak, jak realnie dostaje ją model (render przez `PromptBuilder`). */
function renderDecisionTree(agentOverrides: Record<string, unknown> = {}): string {
    const builder = new PromptBuilder();
    builder.build({ ...AGENT, promptOverrides: { decisionTreeInstructions: agentOverrides } } as never, CTX as never);
    return builder.getSections().find(s => s.key === 'decision_tree')!.content;
}

test('DECISION_TREE_DEFAULTS = rdzeń (tier core) + rozszerzone (tier extended)', t => {
    t.is(DECISION_TREE_DEFAULTS.length, CORE_RULES.length + EXTENDED_RULES.length);
    t.true(DECISION_TREE_DEFAULTS.filter(r => r.tier === 'core').length === CORE_RULES.length);
    t.true(DECISION_TREE_DEFAULTS.filter(r => r.tier === 'extended').length === EXTENDED_RULES.length);
    // Stare id nie występują już w drzewie.
    const ids = new Set(DECISION_TREE_DEFAULTS.map(r => r.id));
    for (const dead of ['deleg_mandatory', 'deleg_strateg', 'skill_use', 'skill_known', 'file_write', 'file_delete']) {
        t.false(ids.has(dead), `${dead} nie powinno istnieć`);
    }
});

test.serial('mem_proactive w rdzeniu — rdzeń + rozszerzenie ulotne', t => {
    setLocale('pl');
    try {
        const rule = CORE_RULES.find(r => r.id === 'mem_proactive')!;
        t.truthy(rule);
        t.true(rule.text.startsWith('POD KONIEC TURY sam oceń'));
        // Durable-first framing zachowane…
        t.true(rule.text.includes('Lepiej nie zapisać niż zaśmiecić pamięć.'));
        // …a dokłada ścieżkę ulotną „na teraz" (ephemeral + section) na końcu.
        t.true(rule.text.includes('ephemeral:true'));
        t.true(rule.text.includes('„Na teraz"'));
        t.is(rule.tool, 'memory_save');
    } finally {
        setLocale('en');
    }
});

test('resolveDecisionTreeInstructions: override false wyłącza, string podmienia', t => {
    const resolved = resolveDecisionTreeInstructions({ deleg_escalation: false, mem_dedup: 'MÓJ TEKST' }, {});
    t.false(resolved.some(r => r.id === 'deleg_escalation'));
    t.is(resolved.find(r => r.id === 'mem_dedup')!.text, 'MÓJ TEKST');
});

test('resolveDecisionTreeInstructions: custom_ dokłada instrukcję (tier core)', t => {
    const resolved = resolveDecisionTreeInstructions(
        { custom_x: { text: 'reguła usera', group: 'pamiec', tool: 'read' } }, {}
    );
    const custom = resolved.find(r => r.id === 'custom_x')!;
    t.truthy(custom);
    t.is(custom.tier, 'core');
    t.is(custom.text, 'reguła usera');
});

test('splitDecisionTreeRules: available=null → nie filtruje po narzędziu (podgląd/test)', t => {
    const resolved = resolveDecisionTreeInstructions({}, {});
    const { core } = splitDecisionTreeRules(resolved, { available: null, hasSkills: true, extended: false });
    // deleg_core (tool delegate) renderuje się mimo braku listy dostępnych.
    t.true(core.some(r => r.id === 'deleg_core'));
});

test('splitDecisionTreeRules: instrukcja narzędzia NIEdostępnego NIE renderuje się', t => {
    const resolved = resolveDecisionTreeInstructions({}, {});
    // Agent ma tylko artifact_create - NIE ma delegate/memory_save/todo.
    const available = new Set(['artifact_create']);
    const { core } = splitDecisionTreeRules(resolved, { available, hasSkills: false, extended: false });
    const ids = core.map(r => r.id);
    t.true(ids.includes('art_hierarchy'));         // artifact_create dostępny
    t.false(ids.includes('art_todo_default'));     // todo niedostępny (dochodzi w fazie D - świadome)
    t.false(ids.includes('deleg_core'));           // delegate niedostępny
    t.false(ids.includes('mem_proactive'));        // memory_save niedostępny
    t.true(ids.includes('deleg_escalation'));      // reguła bez narzędzia - zawsze
});

test('splitDecisionTreeRules: reguła requiresSkills tylko gdy agent ma skille', t => {
    const resolved = resolveDecisionTreeInstructions({}, {});
    const noSkills = splitDecisionTreeRules(resolved, { available: null, hasSkills: false, extended: false });
    const withSkills = splitDecisionTreeRules(resolved, { available: null, hasSkills: true, extended: false });
    t.false(noSkills.core.some(r => r.id === 'skille'));
    t.true(withSkills.core.some(r => r.id === 'skille'));
});

test('splitDecisionTreeRules: furtka OFF → brak rozszerzonych; ON → są (filtrowane po narzędziu)', t => {
    const resolved = resolveDecisionTreeInstructions({}, {});
    const off = splitDecisionTreeRules(resolved, { available: null, hasSkills: true, extended: false });
    t.is(off.extended.length, 0);

    const on = splitDecisionTreeRules(resolved, { available: null, hasSkills: true, extended: true });
    t.true(on.extended.length > 0);
    t.true(on.extended.some(r => r.id === 'mem_save'));

    // Filtrowanie po narzędziu obowiązuje też w furtce.
    const onNarrow = splitDecisionTreeRules(resolved, { available: new Set(['read']), hasSkills: true, extended: true });
    t.true(onNarrow.extended.some(r => r.id === 'mem_read')); // tool read dostępny
    t.false(onNarrow.extended.some(r => r.id === 'kom_send')); // kom_* niedostępny
});

test('reguły poczty renderują się TYLKO gdy agent ma narzędzia komunikatora', t => {
    const resolved = resolveDecisionTreeInstructions({}, {});

    // Reakcja na ping = rdzeń (always-on), gatowana dostępnością kom_read.
    const withMail = splitDecisionTreeRules(resolved, { available: new Set(['kom_send', 'kom_read']), hasSkills: false, extended: true });
    t.true(withMail.core.some(r => r.id === 'kom_inbox'));
    // „Kiedy wysłać" siedzi w opisie narzędzia - w drzewie tylko za furtką.
    t.true(withMail.extended.some(r => r.id === 'kom_send'));

    const withoutMail = splitDecisionTreeRules(resolved, { available: new Set(['read']), hasSkills: false, extended: true });
    t.false(withoutMail.core.some(r => r.id === 'kom_inbox'));
    t.false(withoutMail.extended.some(r => r.id === 'kom_send'));
});

// ── agent_delegate uśpione (2.3.0, "Czat bez ścian" jednostka E) ────────────────────────────
// `comms_delegate` (tool: 'agent_delegate') nigdy się nie renderuje, bo `availableToolNames`
// realnie liczone jest z `ToolRegistry.filterByAgent(agent)` (patrz `AgentManager.ts`,
// `_buildBaseContext`), a ten już nie oferuje `agent_delegate` ŻADNEMU agentowi (ToolRegistry.ts,
// `DORMANT_TOOLS`) - `splitDecisionTreeRules` gatuje regułę po `instr.tool`, więc brak narzędzia
// w `available` wystarcza. Osobny problem: `kom_send` (tool DALEJ dostępne) miał w SWOIM
// tekście literalną wzmiankę "→ agent_delegate" jako poradę - to trzeba było wyciąć z i18n.

test('reguła comms_delegate (furtka) nie renderuje się, gdy agent_delegate nie jest dostępne (realny stan po uśpieniu)', t => {
    const resolved = resolveDecisionTreeInstructions({}, {});
    const available = new Set(['kom_send', 'kom_list', 'kom_read', 'delegate', 'read']); // BEZ agent_delegate
    const { extended } = splitDecisionTreeRules(resolved, { available, hasSkills: false, extended: true });
    t.false(extended.some(r => r.id === 'comms_delegate'));
    t.true(extended.some(r => r.id === 'kom_send'), 'kom_send samo zostaje dostępne');
});

test.serial('wyrenderowany prompt (furtka ON, agent_delegate NIEDOSTĘPNE) nie zawiera literału agent_delegate, w obu językach', t => {
    for (const locale of ['pl', 'en'] as const) {
        setLocale(locale);
        try {
            const builder = new PromptBuilder();
            builder.build({ ...AGENT } as never, {
                ...CTX,
                extendedPromptRules: true,
                availableToolNames: ['kom_send', 'kom_list', 'kom_read', 'delegate', 'read', 'memory_save'],
            } as never);
            const tree = builder.getSections().find(s => s.key === 'decision_tree')!.content;
            t.false(tree.includes('agent_delegate'),
                `${locale}: drzewo (furtka ON, agent bez agent_delegate) nie może wspominać uśpionego narzędzia - offending text: ${tree}`);
        } finally {
            setLocale('en');
        }
    }
});

// ── nazwy sekcji artefaktu idą za językiem interfejsu ───────────────────

/**
 * Reguła `art_existing` trafia do promptu DOSŁOWNIE (`PromptBuilder` wypycha `instr.text`),
 * a nazwa sekcji jest ADRESEM patcha: w angielskim vaultcie szablon typu ma „## User notes",
 * w polskim „## Uwagi usera". Napis wpisany w regułę na sztywno chroniłby sekcję, której
 * w notatce nie ma - stąd placeholder wypełniany z rejestru `modules/artifacts`.
 */
test.serial('art_existing: rozstrzygnięta reguła nazywa sekcję w języku interfejsu', t => {
    t.teardown(() => setLocale('en'));

    setLocale('en');
    const en = resolveDecisionTreeInstructions().find(r => r.id === 'art_existing')!;
    t.true(en.text.includes('User notes'), en.text);
    t.false(en.text.includes('Uwagi usera'));
    t.false(en.text.includes('{{user_notes}}'), 'placeholder nie może wyciec do promptu');

    setLocale('pl');
    const pl = resolveDecisionTreeInstructions().find(r => r.id === 'art_existing')!;
    t.true(pl.text.includes('Uwagi usera'), pl.text);
    t.false(pl.text.includes('{{user_notes}}'));
});

test.serial('placeholder działa też w regule NADPISANEJ i WŁASNEJ usera', t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');

    const resolved = resolveDecisionTreeInstructions(
        { art_existing: 'Nie dotykaj sekcji {{user_notes}}; kroki dopisuj do {{steps}}.' },
        { custom_moja: { text: 'Cel planu trzymaj w {{goal}}.', group: 'artefakty' } },
    );

    t.is(resolved.find(r => r.id === 'art_existing')!.text,
        'Nie dotykaj sekcji User notes; kroki dopisuj do Steps.');
    t.is(resolved.find(r => r.id === 'custom_moja')!.text,
        'Cel planu trzymaj w Goal.');
});

test.serial('nieznany placeholder przechodzi nietknięty (to nie jest silnik szablonów)', t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    const resolved = resolveDecisionTreeInstructions({ art_existing: 'Zostaw {{cokolwiek_innego}} w spokoju.' });
    t.is(resolved.find(r => r.id === 'art_existing')!.text, 'Zostaw {{cokolwiek_innego}} w spokoju.');
});

// ─── Drzewo idzie za językiem interfejsu (2.2.5) ───

test.serial('drzewo renderuje się PO ANGIELSKU dla locale en - zero polszczyzny', t => {
    setLocale('en');
    try {
        const tree = renderDecisionTree();
        t.true(tree.includes('ESCALATION: you know → answer'), 'reguła eskalacji po angielsku');
        t.true(tree.includes('"User notes"'), 'nazwa sekcji artefaktu z rejestru EN');
        t.regex(tree, /A ping about unread messages/, 'reguła skrzynki po angielsku');
        // Najtwardsza asercja: w całej sekcji nie ma ani jednej polskiej litery.
        const polskie = tree.match(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g);
        t.is(polskie, null, `polskie znaki w angielskim drzewie: ${polskie?.join('')}`);
    } finally {
        setLocale('en');
    }
});

test.serial('drzewo renderuje się PO POLSKU dla locale pl', t => {
    setLocale('pl');
    try {
        const tree = renderDecisionTree();
        t.true(tree.includes('ESKALACJA: wiesz → odpowiadaj'), 'reguła eskalacji po polsku');
        t.true(tree.includes('„Uwagi usera"'), 'nazwa sekcji artefaktu z rejestru PL');
        t.false(tree.includes('ESCALATION'), 'ani śladu wersji angielskiej');
    } finally {
        setLocale('en');
    }
});

test.serial('treść reguły liczy się przy ODCZYCIE, nie przy imporcie modułu', t => {
    // Sedno zmiany: `DECISION_TREE_DEFAULTS` powstaje przed `setLocale()` z `src/main.ts`.
    // Gdyby `text` był zwykłym napisem, oba odczyty oddałyby ten sam język.
    const rule = DECISION_TREE_DEFAULTS.find(r => r.id === 'deleg_escalation')!;
    setLocale('pl');
    const poPolsku = rule.text;
    setLocale('en');
    const poAngielsku = rule.text;
    setLocale('en');

    t.true(poPolsku.startsWith('ESKALACJA'));
    t.true(poAngielsku.startsWith('ESCALATION'));
    t.not(poPolsku, poAngielsku);
});

test.serial('override po id wygrywa nad fabryką w OBU językach', t => {
    try {
        for (const locale of ['pl', 'en']) {
            setLocale(locale);
            const tree = renderDecisionTree({ deleg_escalation: 'MOJA WLASNA REGULA ESKALACJI' });
            t.true(tree.includes('MOJA WLASNA REGULA ESKALACJI'), `${locale}: override w prompcie`);
            t.false(tree.includes('ESKALACJA: wiesz'), `${locale}: fabryczny PL zniknął`);
            t.false(tree.includes('ESCALATION: you know'), `${locale}: fabryczny EN zniknął`);
        }
    } finally {
        setLocale('en');
    }
});

test('każda reguła ma treść w OBU słownikach', t => {
    // Klucz jest SKŁADANY (`'prompt.dt.rule.' + id`), więc skaner literałów `t('...')`
    // w `core/i18n/parity.test.ts` go nie widzi - literówka w `id` dałaby modelowi goły klucz.
    const braki: string[] = [];
    for (const rule of DECISION_TREE_DEFAULTS) {
        const key = ruleTextKey(rule.id);
        if (!(key in plDict)) braki.push(`pl: ${key}`);
        if (!(key in enDict)) braki.push(`en: ${key}`);
    }
    t.deepEqual(braki, []);
    t.is(DECISION_TREE_DEFAULTS.length, 17, 'pin liczby reguł - nowa reguła = nowy klucz w obu słownikach');
});
