import test from 'ava';
import {
    CORE_RULES,
    EXTENDED_RULES,
    DECISION_TREE_DEFAULTS,
    resolveDecisionTreeInstructions,
    splitDecisionTreeRules,
} from './decisionTree.js';

test('DECISION_TREE_DEFAULTS = rdzeń (tier core) + rozszerzone (tier extended)', t => {
    t.is(DECISION_TREE_DEFAULTS.length, CORE_RULES.length + EXTENDED_RULES.length);
    t.true(DECISION_TREE_DEFAULTS.filter(r => r.tier === 'core').length === CORE_RULES.length);
    t.true(DECISION_TREE_DEFAULTS.filter(r => r.tier === 'extended').length === EXTENDED_RULES.length);
    // Stare id nie występują już w drzewie (D14).
    const ids = new Set(DECISION_TREE_DEFAULTS.map(r => r.id));
    for (const dead of ['deleg_mandatory', 'deleg_strateg', 'skill_use', 'skill_known', 'file_write', 'file_delete']) {
        t.false(ids.has(dead), `${dead} nie powinno istnieć`);
    }
});

test('mem_proactive w rdzeniu — rdzeń E2.7 + rozszerzenie ulotne E2.8 D2', t => {
    const rule = CORE_RULES.find(r => r.id === 'mem_proactive')!;
    t.truthy(rule);
    t.true(rule.text.startsWith('POD KONIEC TURY sam oceń'));
    // E2.7 durable-first framing zachowane…
    t.true(rule.text.includes('Lepiej nie zapisać niż zaśmiecić pamięć.'));
    // …a E2.8 D2 dokłada ścieżkę ulotną „na teraz" (ephemeral + section) na końcu.
    t.true(rule.text.includes('ephemeral:true'));
    t.true(rule.text.includes('„Na teraz"'));
    t.is(rule.tool, 'memory_save');
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
    // E2.9 FAZA B: agent ma tylko artifact_create — NIE ma delegate/memory_save/todo.
    const available = new Set(['artifact_create']);
    const { core } = splitDecisionTreeRules(resolved, { available, hasSkills: false, extended: false });
    const ids = core.map(r => r.id);
    t.true(ids.includes('art_hierarchy'));         // artifact_create dostępny
    t.false(ids.includes('art_todo_default'));     // todo niedostępny (dochodzi w fazie D — świadome)
    t.false(ids.includes('deleg_core'));           // delegate niedostępny
    t.false(ids.includes('mem_proactive'));        // memory_save niedostępny
    t.true(ids.includes('deleg_escalation'));      // reguła bez narzędzia — zawsze
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
    t.false(onNarrow.extended.some(r => r.id === 'kom_send')); // kom_* niedostępny (S28)
});

test('S28: reguły poczty renderują się TYLKO gdy agent ma narzędzia komunikatora', t => {
    const resolved = resolveDecisionTreeInstructions({}, {});

    // Reakcja na ping = rdzeń (always-on), gatowana dostępnością kom_read.
    const withMail = splitDecisionTreeRules(resolved, { available: new Set(['kom_send', 'kom_read']), hasSkills: false, extended: true });
    t.true(withMail.core.some(r => r.id === 'kom_inbox'));
    // „Kiedy wysłać" siedzi w opisie narzędzia (D14) — w drzewie tylko za furtką.
    t.true(withMail.extended.some(r => r.id === 'kom_send'));

    const withoutMail = splitDecisionTreeRules(resolved, { available: new Set(['read']), hasSkills: false, extended: true });
    t.false(withoutMail.core.some(r => r.id === 'kom_inbox'));
    t.false(withoutMail.extended.some(r => r.id === 'kom_send'));
});
