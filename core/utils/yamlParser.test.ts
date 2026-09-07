import test from 'ava';
import { parseYaml, validateAgentSchema } from './yamlParser.js';

test('validateAgentSchema: minimalny agent (samo name) przechodzi', t => {
    const result = validateAgentSchema({ name: 'Testowy' });
    t.true(result.valid);
    t.deepEqual(result.errors, []);
});

test('validateAgentSchema: brak name = invalid', t => {
    const result = validateAgentSchema({ personality: 'miły' });
    t.false(result.valid);
    t.true(result.errors.some(e => e.includes('"name"')));
});

// Regresja znaleziska TS-1 #2: puste `models:` w YAML parsuje się do null, a null przechodzi
// `typeof === 'object'` — walidator wchodził w Object.entries(null) i wywalał się TypeError
// zamiast oddać błąd walidacji.
test('validateAgentSchema: models: null (puste pole w YAML) = błąd walidacji, nie crash', t => {
    const parsed = parseYaml('name: Testowy\nmodels:\n') as Record<string, unknown>;
    t.is(parsed.models, null);
    t.notThrows(() => validateAgentSchema(parsed));
    const { valid, errors } = validateAgentSchema(parsed);
    t.false(valid);
    t.true(errors.some(e => e.includes('"models"')));
});

test('validateAgentSchema: models jako tablica = błąd walidacji', t => {
    const { valid, errors } = validateAgentSchema({ name: 'Testowy', models: ['deepseek'] });
    t.false(valid);
    t.true(errors.some(e => e.includes('"models"')));
});

// PIN BEZPIECZEŃSTWA (audyt nocny 2026-08-21, moduł 11 - dead code i zależności).
//
// `parseYaml` woła `yaml.load`, a `js-yaml` NIE JEST zadeklarowany w package.json:
// do drzewa wpada wyłącznie tranzytywnie z devDependencies (`npm ls js-yaml --omit=dev`
// zwraca pustkę). Wersja jest więc wypadkową hoistingu, nie decyzji - dziś w roocie
// leży 3.15.0, wciągnięta przez ava -> supertap. W js-yaml 3.x `load` używa schematu
// DEFAULT_FULL i buduje z treści pliku ŻYWE obiekty JS (`!!js/function`, `!!js/regexp`);
// bezpiecznym wariantem jest tam `safeLoad`. W 4.x jest odwrotnie: `load` jest bezpieczne,
// a `safeLoad` nie istnieje. Czyli o tym, czy parser jest bezpieczny, decyduje dziś
// drzewo zależności testowych.
//
// Przez ten parser idą WSZYSTKIE yamle vaulta: yamle agentów (AgentLoader), subagentów
// i ich szablony, skiny (SkinLoader), frontmattery artefaktów (artifactParser)
// oraz konfiguracja stref (VaultZones).
//
// STAN 2026-09-04 (wciąganie ogonów): `js-yaml` jest już zadeklarowany w `dependencies`
// (`^4.3.1`), a w 4.x `load` jest wariantem bezpiecznym — pin nocy zszedł z `.failing`
// na zwykły test i pilnuje od teraz regresji (np. cofnięcia do 3.x albo własnego schematu).
test('parseYaml: treść pliku NIE MOŻE budować żywych obiektów JS', t => {
    const fn = parseYaml("opis: !!js/function 'function(){ return 42 }'") as Record<string, unknown> | null;
    t.not(typeof fn?.opis, 'function', '!!js/function zbudował wykonywalną funkcję');

    const re = parseYaml('wzorzec: !!js/regexp /abc/') as Record<string, unknown> | null;
    t.false(re?.wzorzec instanceof RegExp, '!!js/regexp zbudował obiekt RegExp');
});
