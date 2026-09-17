import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { estimateContextWindow, formatTokenCount, getContextLevel } from './TokenViewerUtils.js';
import { TokenViewerWidget } from './TokenViewerWidget.js';
import type { ChatViewLike } from './chatViewShape.js';

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

// ── rozbicie okna liczone RAZ na odświeżenie ─────────────
// `TokenViewerWidget.ts` importuje `obsidian` (Modal/Notice) - atrapa `obsidian` + DOM shim z
// `pkm-assistant-harness` dziś to udźwiga (patrz test behawioralny `resolveRoleMax` niżej), ale
// TE testy zostają po ŹRÓDLE (wzorem `stopSemantics.test.ts` / `ownerScopedState.test.ts`), bo
// mierzą OKABLOWANIE `update()` (kolejność wywołań), nie samą wartość zwrotki.

const widgetSrc = readFileSync(fileURLToPath(new URL('./TokenViewerWidget.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('update() podaje popoverowi POLICZONE dane, nie każe liczyć drugi raz', t => {
    t.regex(widgetSrc, /if\s*\(this\.popover\?\.isConnected\)\s*this\.renderPopover\(data\);/,
        'przy otwartym popoverze `update()` musi PRZEKAZAĆ `data` — inaczej getBreakdown() leci dwa razy na każde zdarzenie usage');
    t.regex(widgetSrc, /renderPopover\(roleData\?: RoleData\): void/,
        'renderPopover musi przyjmować gotowe rozbicie');
    t.regex(widgetSrc, /const data = roleData \|\| this\.getRoleData\(this\.selectedRole\);/,
        'wołacze spoza update() (otwarcie popovera, przełączniki) nadal liczą same — ale to zdarzenia pojedyncze');
});

test('w jednym przebiegu update() jest DOKŁADNIE jedno getRoleData', t => {
    const update = /update\(force = false\): void \{([\s\S]*?)\n    \}/.exec(widgetSrc)?.[1] || '';
    t.true(update.length > 0, 'nie znalazłem ciała update()');
    t.is((update.match(/getRoleData\(/g) || []).length, 1);
});

// ── resolveRoleMax na agencie BEZ modelu (bug B2) ─────────────
//
// `configured` bywa `null` (agent bez modelu dla tej roli I pusty `modelLibrary` w
// ustawieniach) - `typeof null === 'object'` wysyłał `null` w gałąź obiektową i
// `null.platform` rzucało `TypeError`. Wołacz (`getRoleData`) nie łapie tego wyjątku,
// więc Token Viewer całego czatu padał przy pierwszym odświeżeniu dla takiej roli.
//
// Instancja jest realna (nie atrapa) - `obsidian` (Modal/Notice) i DOM (`createDiv`/`createEl`)
// dostaje z atrapy `pkm-assistant-harness`, `getRoleData`/`resolveRoleMax` woła się dokładnie
// tak, jak robi to `update()`.

function makeFakeView(overrides: { agent?: unknown; modelLibrary?: Record<string, unknown> } = {}): ChatViewLike {
    return {
        plugin: {
            agentManager: {
                getActiveAgent: () => overrides.agent ?? null,
            },
        },
        env: {
            settings: {
                pkmAssistant: {
                    modelLibrary: overrides.modelLibrary ?? {},
                },
            },
        },
        tokenTracker: {
            getSessionTotal: () => ({ byRole: {} }),
            hasEstimates: () => false,
        },
        rollingWindow: null,
    } as unknown as ChatViewLike;
}

test('resolveRoleMax: agent bez modelu i pusty modelLibrary -> fallback okna, nie TypeError', t => {
    const view = makeFakeView({ agent: { name: 'sin-modelo', models: {} } });
    const widget = new TokenViewerWidget(view, document.createElement('div') as unknown as HTMLElement);
    t.notThrows(() => widget.resolveRoleMax('researcher'));
    // Ten sam fallback, którego `estimateContextWindow` używa dla KAŻDEGO nierozpoznanego
    // modelu (platform/model puste -> żaden klucz się nie łapie) - "brak modelu" dostaje
    // dokładnie tę samą, już istniejącą, sensowną wartość domyślną, a nie 0 ani wyjątek.
    t.is(widget.resolveRoleMax('researcher'), 200000);
});

test('getRoleData (caller resolveRoleMax): agent bez modelu -> max=200000, used liczone normalnie', t => {
    const view = makeFakeView({ agent: { name: 'sin-modelo', models: {} } });
    const widget = new TokenViewerWidget(view, document.createElement('div') as unknown as HTMLElement);
    const data = widget.getRoleData('researcher');
    t.deepEqual(data, { used: 0, max: 200000, breakdown: null, session: { input: 0, output: 0 } });
});

test('resolveRoleMax: agent null (brak agenta aktywnego) też dostaje fallback, nie TypeError', t => {
    const view = makeFakeView({ agent: null });
    const widget = new TokenViewerWidget(view, document.createElement('div') as unknown as HTMLElement);
    t.is(widget.resolveRoleMax('researcher'), 200000);
});
