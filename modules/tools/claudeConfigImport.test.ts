import test from 'ava';
import { parseClaudeDesktopConfig, buildImportRows, slugifyServerId } from './claudeConfigImport.js';
import { ExternalMcpManager } from './ExternalMcpManager.js';

const BUILTIN = ['core', 'artifacts', 'vault', 'memory', 'web', 'multimodal', 'delegation', 'komunikator'];

// Realny kształt claude_desktop_config.json z dokumentacji Anthropic (filesystem + github).
const REAL_CONFIG = JSON.stringify({
    mcpServers: {
        filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\anna\\Desktop'],
        },
        github: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_xxx' },
        },
    },
});

test('parsuje realny claude_desktop_config.json na nasz kształt configu', t => {
    const out = parseClaudeDesktopConfig(REAL_CONFIG);
    t.is(out.length, 2);
    t.deepEqual(out[0], {
        id: 'filesystem',
        name: 'filesystem',
        enabled: true,
        autostart: false,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\anna\\Desktop'],
        env: {},
    });
    t.deepEqual(out[1].env, { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_xxx' }, 'env (z tokenem) przechodzi 1:1');
    t.false(out[1].autostart, 'import NIGDY nie włącza autostartu');
    for (const cfg of out) {
        t.true(ExternalMcpManager.validateServerId(cfg.id, BUILTIN).ok, `${cfg.id} przejdzie walidację zapisu`);
    }
});

test('wpis z kluczem url mapuje się na transport http (+ nagłówki)', t => {
    const out = parseClaudeDesktopConfig(JSON.stringify({
        mcpServers: {
            'Remote Thing': { url: 'https://mcp.example.com/sse ', headers: { Authorization: 'Bearer abc' } },
        },
    }));
    t.is(out.length, 1);
    t.is(out[0].transport, 'http');
    t.is(out[0].url, 'https://mcp.example.com/sse', 'url trimowany');
    t.deepEqual(out[0].headers, { Authorization: 'Bearer abc' });
    t.is(out[0].name, 'Remote Thing', 'name = oryginalna nazwa z Claude');
    t.is(out[0].id, 'remote-thing', 'id slugowany');
});

test('odporność na śmieci: zły JSON, brak mcpServers, wpisy bez command/url', t => {
    t.deepEqual(parseClaudeDesktopConfig('to nie jest json'), []);
    t.deepEqual(parseClaudeDesktopConfig(''), []);
    t.deepEqual(parseClaudeDesktopConfig(null), []);
    t.deepEqual(parseClaudeDesktopConfig('{"globalShortcut":"Ctrl+Q"}'), [], 'brak mcpServers');
    t.deepEqual(parseClaudeDesktopConfig('{"mcpServers":[]}'), [], 'mcpServers tablicą, nie obiektem');
    t.deepEqual(parseClaudeDesktopConfig(JSON.stringify({
        mcpServers: {
            ok: { command: 'npx' },
            broken: { description: 'nie wiadomo jak uruchomić' },
            alsoBroken: null,
            '!!': { command: 'npx' }, // slug < 2 znaki → odpada
        },
    })).map(c => c.id), ['ok'], 'niezrozumiałe wpisy pomijane, nie rzuca');
});

test('args/env ze śmieciami są czyszczone (bez wysadzania importu)', t => {
    const out = parseClaudeDesktopConfig(JSON.stringify({
        mcpServers: {
            dirty: { command: ' npx ', args: ['-y', 7, { nope: 1 }, null], env: { A: 'x', B: 3, C: { deep: 1 } } },
        },
    }));
    t.is(out[0].command, 'npx', 'command trimowany');
    t.deepEqual(out[0].args, ['-y', '7'], 'nie-stringi odfiltrowane, liczby zrzutowane');
    t.deepEqual(out[0].env, { A: 'x', B: '3' }, 'obiekty w env odrzucone');
});

test('slugifyServerId: małe litery, myślniki, obcięcie do 32 znaków', t => {
    t.is(slugifyServerId('Filesystem'), 'filesystem');
    t.is(slugifyServerId('My Server_2'), 'my-server-2');
    t.is(slugifyServerId('--dziwne--'), 'dziwne');
    t.is(slugifyServerId('a'.repeat(40)).length, 32);
    t.is(slugifyServerId(''), '');
});

test('buildImportRows: kolizja id = odznaczone i oznaczone jako istniejące', t => {
    const parsed = parseClaudeDesktopConfig(REAL_CONFIG);
    const rows = buildImportRows(parsed, [{ id: 'github', name: 'Mój GitHub' }]);

    const fsRow = rows.find(r => r.config.id === 'filesystem');
    const ghRow = rows.find(r => r.config.id === 'github');
    t.false(fsRow!.exists);
    t.true(fsRow!.selected, 'nowy serwer domyślnie zaznaczony');
    t.true(ghRow!.exists);
    t.false(ghRow!.selected, 'istniejące id nigdy nie nadpisuje konfiguracji usera');
});

test('buildImportRows: odporne na brak/śmieci w argumentach', t => {
    t.deepEqual(buildImportRows([], []), []);
    t.deepEqual(buildImportRows(null, null), []);
    const rows = buildImportRows(
        parseClaudeDesktopConfig(REAL_CONFIG),
        [{ noId: true }, null] as unknown as Parameters<typeof buildImportRows>[1],
    );
    t.is(rows.length, 2);
    t.true(rows.every(r => r.selected && !r.exists));
});

// ─── AUD-code-review-050: import ma TĘ SAMĄ walidację unikalności/rezerwacji id co
// ręczne dodawanie serwera (`MCPServerEditorModal._handleSave` → `validateServerId`) ───

test('050: serwer nazwany jak WBUDOWANY (np. "memory") jest zablokowany — ta sama reguła co connect()/edytor', t => {
    const parsed = parseClaudeDesktopConfig(JSON.stringify({
        mcpServers: { memory: { command: 'npx', args: ['-y', 'server-memory'] } },
    }));
    t.is(parsed[0].id, 'memory', 'warunek wstępny: slug koliduje dosłownie z built-inem');

    const rows = buildImportRows(parsed, [], BUILTIN);

    t.true(rows[0].exists, 'zablokowane jak "już istnieje" — modal (celowo głupi) czyta TYLKO to pole');
    t.false(rows[0].selected, 'nie wolno domyślnie zaznaczyć id zarezerwowanego dla built-ina');
    t.is(rows[0].blockedReason, 'reserved');
});

test('050: bez podania builtinNames zachowanie sprzed naprawy (fail-soft, nic nie krzyczy)', t => {
    const parsed = parseClaudeDesktopConfig(JSON.stringify({
        mcpServers: { memory: { command: 'npx' } },
    }));
    // Trzeci argument pominięty (domyślne []) — kontrakt wołaczy sprzed AUD-code-review-050
    // (SettingsContent bez toolRegistry) dalej działa, tylko bez kontroli built-inów.
    const rows = buildImportRows(parsed, []);

    t.false(rows[0].exists, 'brak listy built-inów = kontrola rezerwacji wyłączona, nie fail-closed');
});

test('050: dwie RÓŻNE nazwy Claude Desktop dające TEN SAM slug — duplikat WEWNĄTRZ paczki zablokowany', t => {
    // "Filesystem" i "filesystem" różnią się tylko wielkością liter — slugifyServerId
    // (lowercase) sprowadza obie do id "filesystem".
    const parsed = parseClaudeDesktopConfig(JSON.stringify({
        mcpServers: {
            Filesystem: { command: 'npx', args: ['-y', 'a'] },
            filesystem: { command: 'npx', args: ['-y', 'b'] },
        },
    }));
    t.is(parsed.length, 2);
    t.deepEqual(parsed.map(c => c.id), ['filesystem', 'filesystem'], 'warunek wstępny: kolizja slugów wewnątrz paczki');

    const rows = buildImportRows(parsed, [], BUILTIN);

    t.false(rows[0].exists, 'PIERWSZY wpis o tym id przechodzi normalnie');
    t.true(rows[0].selected);
    t.true(rows[1].exists, 'DRUGI wpis o TYM SAMYM id jest zablokowany — bez tego oba lądowałyby pod jednym id');
    t.false(rows[1].selected);
    t.is(rows[1].blockedReason, 'duplicate');
});

test('050: duplikat wewnątrz paczki NIE miesza się z "już w ustawieniach" — inny powód, ten sam skutek', t => {
    const parsed = parseClaudeDesktopConfig(JSON.stringify({
        mcpServers: { Foo: { command: 'npx' }, foo: { command: 'npx' } },
    }));
    const rows = buildImportRows(parsed, [], BUILTIN);

    t.is(rows[0].blockedReason, undefined, 'pierwszy wpis nie jest zablokowany z żadnego powodu');
    t.is(rows[1].blockedReason, 'duplicate', 'drugi jest blokowany jako duplikat, nie "already exists"');
});
