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

// Regresja: puste `models:` w YAML parsuje się do null, a null przechodzi
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

// `parseYaml` woła `yaml.load` (js-yaml, zadeklarowany w `dependencies` jako `^4.3.1`).
// W js-yaml 4.x `load` jest wariantem bezpiecznym — nie buduje żywych obiektów JS z tagów
// takich jak `!!js/function`/`!!js/regexp`; to zachowanie należy do schematu DEFAULT_FULL
// w 3.x, gdzie niebezpieczny jest `load`, a bezpieczny `safeLoad`. Bezpieczeństwo tego
// parsera zależy więc od tego, jaka wersja js-yaml się rozwiąże — stąd pin pilnujący
// regresji (np. cofnięcia do 3.x albo własnego schematu).
//
// Przez ten parser idą WSZYSTKIE yamle vaulta: yamle agentów (AgentLoader), subagentów
// i ich szablony, skiny (SkinLoader), frontmattery artefaktów (artifactParser)
// oraz konfiguracja stref (VaultZones).
test('parseYaml: treść pliku NIE MOŻE budować żywych obiektów JS', t => {
    const fn = parseYaml("opis: !!js/function 'function(){ return 42 }'") as Record<string, unknown> | null;
    t.not(typeof fn?.opis, 'function', '!!js/function zbudował wykonywalną funkcję');

    const re = parseYaml('wzorzec: !!js/regexp /abc/') as Record<string, unknown> | null;
    t.false(re?.wzorzec instanceof RegExp, '!!js/regexp zbudował obiekt RegExp');
});
