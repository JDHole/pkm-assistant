/**
 * S27 D7 — test routingu Zaplecza.
 *
 * Kontekst: 2026-07-28 na ekranie domowym wisiał wiersz „Narzędzia MCP" celujący w tab
 * `tools`, który nie istniał — Zaplecze po cichu spadało na Skille. Ten plik ma sprawić,
 * że powtórka jest niemożliwa bez czerwonego testu: KAŻDY wiersz Home musi celować
 * w realnie zarejestrowaną zakładkę `BackstageRegistry` albo w realny widok sidebara.
 */
import test from 'ava';
import { BackstageRegistryClass } from '../BackstageRegistry.js';
import { buildZapleczeRows, readZapleczeCounts, SIDEBAR_VIEW_IDS } from './backstage_rows.js';
import { registerBackstage as registerSkills } from '../../skills/BackstageTab.js';
import { registerBackstage as registerSubAgents } from '../../sub-agents/BackstageTab.js';
import { registerBackstage as registerConnectors } from '../../tools/BackstageTab.js';

/** Rejestr zbudowany DOKŁADNIE tak jak w BackstageViews.registerDefaultBackstageTabs(). */
function realRegistry() {
    const registry = new BackstageRegistryClass();
    registerSkills(registry as never);
    registerSubAgents(registry as never);
    registerConnectors(registry as never);
    return registry;
}

test('D7: każdy wiersz Home celuje w ISTNIEJĄCĄ zakładkę Zaplecza albo widok sidebara', t => {
    const registry = realRegistry();
    const rows = buildZapleczeRows({ skillTemplates: 1, subTemplates: 2, connectedServers: 3 });

    t.true(rows.length > 0);
    for (const row of rows) {
        t.true(Boolean(row.tab) !== Boolean(row.viewId), `wiersz ${row.id}: dokładnie jeden cel (tab albo viewId)`);
        if (row.tab) {
            t.true(registry.has(row.tab), `wiersz ${row.id} celuje w nieistniejącą zakładkę "${row.tab}"`);
        } else {
            t.true(SIDEBAR_VIEW_IDS.includes(row.viewId), `wiersz ${row.id} celuje w nieistniejący widok "${row.viewId}"`);
        }
    }
});

test('D7: każda zarejestrowana zakładka Zaplecza ma swój wiersz na Home (nic się nie chowa)', t => {
    const registry = realRegistry();
    const targeted = new Set(buildZapleczeRows().filter(r => r.tab).map(r => r.tab));

    for (const tab of registry.getTabs()) {
        t.true(targeted.has(tab.id), `zakładka "${tab.id}" nie ma wiersza na Home`);
    }
});

test('wiersze mają stabilne id i klucze i18n', t => {
    const rows = buildZapleczeRows();
    t.deepEqual(rows.map(r => r.id), ['skill-templates', 'sub-templates', 'connectors', 'triggers']);
    for (const row of rows) {
        t.truthy(row.labelKey, `wiersz ${row.id} bez labelKey`);
        t.truthy(row.icon, `wiersz ${row.id} bez ikony`);
    }
});

test('liczniki: szablony ze store, konektory tylko PODŁĄCZONE, pkm-sub doliczony do subów', t => {
    const plugin = {
        agentManager: {
            skillTemplateStore: { count: () => 4 },
            subAgentTemplateStore: { count: () => 2 },
        },
        externalMcpManager: {
            listServersForUi: () => ([
                { id: 'a', connected: true },
                { id: 'b', connected: false },
                { id: 'c', connected: true },
            ]),
        },
    };

    const counts = readZapleczeCounts(plugin);

    t.is(counts.skillTemplates, 4);
    t.is(counts.subTemplates, 3, 'szablony + wbudowany pkm-sub');
    t.is(counts.connectedServers, 2, 'liczymy TYLKO podłączone serwery');

    const rows = buildZapleczeRows(counts);
    t.is(rows.find(r => r.id === 'skill-templates')!.count, 4);
    t.is(rows.find(r => r.id === 'sub-templates')!.count, 3);
    t.is(rows.find(r => r.id === 'connectors')!.count, 2);
    t.is(rows.find(r => r.id === 'triggers')!.count, null, 'Triggery bez licznika');
});

test('liczniki są odporne na brak pluginu / rzucający manager', t => {
    const pusto = { skillTemplates: 0, subTemplates: 1, connectedServers: 0 };
    t.deepEqual(readZapleczeCounts(null), pusto);
    t.deepEqual(
        readZapleczeCounts({
            externalMcpManager: { listServersForUi: () => { throw new Error('boom'); } },
        }),
        pusto
    );
});
