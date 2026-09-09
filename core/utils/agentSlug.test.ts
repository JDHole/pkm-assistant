import test from 'ava';
import { getAgentSafeName } from './agentSlug.js';

// Test równoważności — helper MUSI dawać dokładnie ten sam wynik co
// stare, ~20-krotnie skopiowane wyrażenie inline `toLowerCase().replace(/[^a-z0-9]/g, '_')`.
// Zero zmiany formatu = zero migracji folderów `.pkm-assistant/agents/<safeName>/` u usera.
function legacyInline(name: unknown): string {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
}

const SAMPLES = [
    'Jaskier',
    'Klara',
    'Tola-Prime',
    'Dr. Wera',
    'Ala ma kota',
    'Ąę Łódź Żółw',
    'Agent_123',
    'UPPER CASE',
    '  trimme d  ',
    '',
    'a.b.c',
    'test/slash',
    'test\\backslash',
];

test('getAgentSafeName jest bajt-w-bajt zgodny ze starym inline wyrażeniem — próbka nazw z polskimi znakami, spacjami i kropkami', t => {
    for (const sample of SAMPLES) {
        t.is(getAgentSafeName(sample), legacyInline(sample), `rozjazd dla wejścia: ${JSON.stringify(sample)}`);
    }
});

test('getAgentSafeName: undefined/null → pusty string (zgodnie z legacy `String(x || \'\')`)', t => {
    t.is(getAgentSafeName(undefined), '');
    t.is(getAgentSafeName(null), '');
});

test('getAgentSafeName: polskie znaki NIE są transliterowane (świadomie, w odróżnieniu od slugify())', t => {
    // ż/ó/ł nie pasują do [a-z0-9] → padają na `_`, tylko `w` (a-z) zostaje.
    t.is(getAgentSafeName('Żółw'), '___w');
});

test('getAgentSafeName: format jest zamrożony (kanon dla `.pkm-assistant/agents/<safeName>/`)', t => {
    t.is(getAgentSafeName('Jaskier'), 'jaskier');
    t.is(getAgentSafeName('Tola Prime'), 'tola_prime');
});
