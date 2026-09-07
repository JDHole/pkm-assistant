import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { estimateContextWindow, formatTokenCount, getContextLevel } from './TokenViewerUtils.js';

test('formatTokenCount keeps slim UI labels short', t => {
    t.is(formatTokenCount(950), '950');
    t.is(formatTokenCount(12500), '12.5k');
    t.is(formatTokenCount(273500), '273.5k');
    t.is(formatTokenCount(1000000), '1.0M');
});

test('getContextLevel follows 50/70/90 thresholds', t => {
    t.is(getContextLevel(49), 'calm');
    t.is(getContextLevel(50), 'warm');
    t.is(getContextLevel(70), 'hot');
    t.is(getContextLevel(90), 'critical');
});

test('estimateContextWindow maps known model families', t => {
    t.is(estimateContextWindow({ platform: 'xai', model: 'grok-4-fast' }), 2000000);
    t.is(estimateContextWindow({ platform: 'gemini', model: 'gemini-2.5-pro' }), 1048576);
    t.is(estimateContextWindow({ platform: 'openai', model: 'gpt-5.2' }), 400000);
    t.is(estimateContextWindow({ platform: 'anthropic', model: 'claude-sonnet-4-5-20250929' }), 200000);
});

// ── AUD-wydajnosc-018: rozbicie okna liczone RAZ na odświeżenie ─────────────
// `TokenViewerWidget.ts` importuje `obsidian` (Modal/Notice) i AVA go nie zaimportuje —
// strażnik po ŹRÓDLE, wzorem `stopSemantics.test.ts` / `ownerScopedState.test.ts`.

const widgetSrc = readFileSync(fileURLToPath(new URL('./TokenViewerWidget.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('update() podaje popoverowi POLICZONE dane, nie każe liczyć drugi raz (AUD-wydajnosc-018)', t => {
    t.regex(widgetSrc, /if\s*\(this\.popover\?\.isConnected\)\s*this\.renderPopover\(data\);/,
        'przy otwartym popoverze `update()` musi PRZEKAZAĆ `data` — inaczej getBreakdown() leci dwa razy na każde zdarzenie usage');
    t.regex(widgetSrc, /renderPopover\(roleData\?: RoleData\): void/,
        'renderPopover musi przyjmować gotowe rozbicie');
    t.regex(widgetSrc, /const data = roleData \|\| this\.getRoleData\(this\.selectedRole\);/,
        'wołacze spoza update() (otwarcie popovera, przełączniki) nadal liczą same — ale to zdarzenia pojedyncze');
});

test('w jednym przebiegu update() jest DOKŁADNIE jedno getRoleData (AUD-wydajnosc-018)', t => {
    const update = /update\(force = false\): void \{([\s\S]*?)\n    \}/.exec(widgetSrc)?.[1] || '';
    t.true(update.length > 0, 'nie znalazłem ciała update()');
    t.is((update.match(/getRoleData\(/g) || []).length, 1);
});
