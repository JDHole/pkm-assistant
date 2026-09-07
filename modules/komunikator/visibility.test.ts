/**
 * Niewidzialność per agent (S28 D6) — jedno źródło prawdy dla UI, narzędzi, pingu i paneli.
 */
import test from 'ava';
import {
    isKomunikatorVisible,
    listKomunikatorAgents,
    listKomunikatorAgentNames,
    findKomunikatorAgent,
} from './visibility.js';

const manager = (agents: Array<Record<string, unknown>>) => ({ getAllAgents: () => agents });

test('brak pola = agent uczestniczy (nowe pole nie wyłącza starych profili)', t => {
    t.true(isKomunikatorVisible({ name: 'Stary' }));
    t.true(isKomunikatorVisible({ name: 'Jawny', komunikator_visible: true }));
    t.false(isKomunikatorVisible({ name: 'Duch', komunikator_visible: false }));
    // Tylko jawne `false` wyłącza — śmieć z YAML-a nie robi ducha przez przypadek.
    t.true(isKomunikatorVisible({ name: 'Smiec', komunikator_visible: 'nie' }));
    t.true(isKomunikatorVisible({ name: 'Zero', komunikator_visible: 0 }));
});

test('listy: duch nie pojawia się nigdzie', t => {
    const am = manager([{ name: 'Tola' }, { name: 'Duch', komunikator_visible: false }, { name: 'Sonny' }]);
    t.deepEqual(listKomunikatorAgents(am).map(a => a.name), ['Tola', 'Sonny']);
    t.deepEqual(listKomunikatorAgentNames(am), ['Tola', 'Sonny']);
});

test('findKomunikatorAgent: dokładnie, potem bez wielkości liter; duch = null', t => {
    const am = manager([{ name: 'Tola' }, { name: 'Duch', komunikator_visible: false }]);
    t.is(findKomunikatorAgent(am, 'Tola')?.name, 'Tola');
    t.is(findKomunikatorAgent(am, 'tola')?.name, 'Tola');
    t.is(findKomunikatorAgent(am, '  Tola  ')?.name, 'Tola');
    t.is(findKomunikatorAgent(am, 'Duch'), null, 'duch jest nie do znalezienia');
    t.is(findKomunikatorAgent(am, 'NieMa'), null);
    t.is(findKomunikatorAgent(am, ''), null);
});

test('brak agentManagera / pusta lista nie wybucha', t => {
    t.deepEqual(listKomunikatorAgents(null), []);
    t.deepEqual(listKomunikatorAgentNames(undefined), []);
    t.is(findKomunikatorAgent(null, 'X'), null);
});
