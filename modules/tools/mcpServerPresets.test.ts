import test from 'ava';
import { MCP_SERVER_PRESETS, getMcpServerPreset, PRESET_PATH_PLACEHOLDER } from './mcpServerPresets.js';
import { ExternalMcpManager } from './ExternalMcpManager.js';
import { t as tr } from '../../core/i18n/index.js';

// Nazwy serwerów wbudowanych — preset o kolidującym id byłby auto-wpuszczony każdemu agentowi
// (default agent.mcp_servers = ['vault','memory','core']), więc to jest test BEZPIECZEŃSTWA.
const BUILTIN = ['core', 'artifacts', 'vault', 'memory', 'web', 'multimodal', 'delegation', 'komunikator'];

test('każdy preset ma wymagane pola i sensowny kształt', t => {
    t.true(MCP_SERVER_PRESETS.length >= 5);
    for (const p of MCP_SERVER_PRESETS) {
        t.is(typeof p.id, 'string', `${p.name}: id`);
        t.is(typeof p.name, 'string', `${p.id}: name`);
        t.is(p.transport, 'stdio', `${p.id}: transport`);
        t.true(typeof p.command === 'string' && p.command.length > 0, `${p.id}: command`);
        t.true(Array.isArray(p.args), `${p.id}: args tablica`);
        t.true(p.args.every(a => typeof a === 'string'), `${p.id}: args to same stringi`);
        if (p.env !== undefined) {
            t.is(typeof p.env, 'object', `${p.id}: env obiekt`);
            t.true(Object.values(p.env).every(v => typeof v === 'string'), `${p.id}: env wartości string`);
        }
        t.is(typeof p.hint, 'string', `${p.id}: hint`);
        t.not(tr(p.hint), p.hint, `${p.id}: hint ma tłumaczenie (klucz się rozwiązuje)`);
    }
});

test('id-y presetów są unikalne, zgodne z validateServerId i nie kolidują z built-in', t => {
    const ids = MCP_SERVER_PRESETS.map(p => p.id);
    t.is(new Set(ids).size, ids.length, 'brak duplikatów id');
    for (const id of ids) {
        const check = ExternalMcpManager.validateServerId(id, BUILTIN);
        t.true(check.ok, `${id} przechodzi walidację (reason: ${check.reason})`);
    }
});

test('preset filesystem niesie placeholder ścieżki do podmiany przez usera', t => {
    const fsPreset = getMcpServerPreset('filesystem');
    t.truthy(fsPreset);
    t.true(fsPreset!.args.includes(PRESET_PATH_PLACEHOLDER));
});

test('preset github ma puste miejsce na token w env (user wkleja swój)', t => {
    const gh = getMcpServerPreset('github');
    t.is(gh!.env!.GITHUB_PERSONAL_ACCESS_TOKEN, '');
});

test('getMcpServerPreset zwraca null dla nieznanego id', t => {
    t.is(getMcpServerPreset('nie-ma-takiego'), null);
    t.is(getMcpServerPreset(''), null);
    t.is(getMcpServerPreset(undefined as unknown as string), null);
});
