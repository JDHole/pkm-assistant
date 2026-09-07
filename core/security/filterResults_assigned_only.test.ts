/**
 * AUD-testy-005 — `AccessGuard.filterResults` gałąź A2 (agent w trybie „Tylko przypisane"
 * z PUSTYMI/undefined `focusFolders`, core/security/AccessGuard.ts:545-554) nie miała ŻADNEGO
 * testu. Mutacja z findings.json (ciało gałęzi zamienione na goły `return results;`) zostawiała
 * PEŁNY pakiet 2465 testów zielony — `search`/`list` oddawały agentowi bez ani jednego
 * przypisanego folderu CAŁY zwykły vault.
 *
 * Kontrakt gałęzi: puste/undefined `focusFolders` (i `guidance_mode !== true`) → wynik
 * zawiera WYŁĄCZNIE wpisy `.pkm-assistant/...`, które przechodzą `_checkPkmPath` (własny
 * folder agenta + obszary współdzielone: komunikator/skills/artifacts/sub-agents). Zero
 * notatek zwykłego vaulta.
 */
import test from 'ava';
import { AccessGuard } from './AccessGuard.js';
import type { GuardedAgent } from './AccessGuard.js';

const VAULT_HITS = () => [
    { path: 'Notatki/dziennik.md' },
    { path: 'Projekty/plan.md' },
    { path: '.pkm-assistant/agents/kuba/memory/brain.md' },
    { path: '.pkm-assistant/agents/inny_agent/memory/brain.md' },
    { path: '.pkm-assistant/skills/przepis.md' },
];

test.before(() => {
    AccessGuard.setNoGoFolders([]);
});

test('A2 blokuje: agent "Tylko przypisane" z PUSTĄ tablicą focusFolders nie dostaje ani jednej notatki zwykłego vaulta', t => {
    const agent: GuardedAgent = { name: 'Kuba', permissions: { guidance_mode: false }, focusFolders: [] };
    const filtered = AccessGuard.filterResults(agent, VAULT_HITS());
    t.deepEqual(
        filtered.map(r => r.path).filter(p => !p.startsWith('.pkm-assistant/')),
        [],
        'zwykła notatka zwykłego vaulta przeciekła agentowi bez żadnego przypisanego folderu',
    );
});

test('A2 blokuje: focusFolders undefined (nie tylko pusta tablica) traktowane identycznie jak pusta lista', t => {
    const agent: GuardedAgent = { name: 'Kuba', permissions: { guidance_mode: false } };
    const filtered = AccessGuard.filterResults(agent, VAULT_HITS());
    t.deepEqual(
        filtered.map(r => r.path).filter(p => !p.startsWith('.pkm-assistant/')),
        [],
    );
});

test('A2 przepuszcza: własna strefa robocza agenta (.pkm-assistant/) przechodzi MIMO pustych focusFolders', t => {
    const agent: GuardedAgent = { name: 'Kuba', permissions: { guidance_mode: false }, focusFolders: [] };
    const filtered = AccessGuard.filterResults(agent, VAULT_HITS());
    t.deepEqual(
        filtered.map(r => r.path),
        [
            '.pkm-assistant/agents/kuba/memory/brain.md',
            '.pkm-assistant/skills/przepis.md',
        ],
        'własny folder agenta i obszar współdzielony (skills) mają przejść; cudzy folder agenta (inny_agent) — nie',
    );
});

test('A2: guidance_mode:true na tym samym agencie zachowuje CAŁY zwykły vault (kontrast — dowód, że A2 to osobna gałąź)', t => {
    const agent: GuardedAgent = { name: 'Kuba', permissions: { guidance_mode: true }, focusFolders: [] };
    const filtered = AccessGuard.filterResults(agent, VAULT_HITS());
    t.true(
        filtered.some(r => r.path === 'Notatki/dziennik.md'),
        'guidance_mode:true musi widzieć zwykły vault — inaczej test A2 wyżej nic nie dowodzi o SWOJEJ gałęzi',
    );
});
