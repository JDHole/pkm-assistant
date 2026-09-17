/**
 * agentExportYaml — eksport profilu do schowka (bug B3).
 *
 * `renderAdvancedTab` (`profile_advanced.ts`) importuje `obsidian` i, transitywnie przez
 * `profile_helpers.js` -> `HiddenFileEditorModal.js`, `import ... with { type: 'css' }` na
 * `HiddenFileEditorModal.css` - kształt, którego loader AVA/tsx nie wstaje
 * (`ERR_UNKNOWN_FILE_EXTENSION`, sprawdzone: `npx ava` na plik importujący `profile_advanced.js`
 * pada na starcie, zanim dojdzie do jakiegokolwiek testu). Dlatego logika transformacji "agent
 * -> tekst do schowka" żyje w `agentExportYaml.ts`, bez tego łańcucha - `profile_advanced.ts`
 * jest cienkim wołaczem (`buildAgentExportYaml(ag)` -> `navigator.clipboard.writeText(...)`),
 * więc ten test mierzy DOKŁADNIE tę funkcję, którą klik guzika "Eksportuj" wywołuje.
 *
 * Sedno buga: `Agent.serialize()` oddaje OBIEKT (kontrakt zapisu YAML - patrz `AgentLoader.ts`:
 * `stringifyYaml(agent.serialize())`), a stary kod robił `yaml as unknown as string` na tym
 * obiekcie zamiast serializować go - rzutowanie zdejmuje TYP, nie zamienia obiektu w string.
 *
 * ⚠️ Wynik `stringifyYaml` tutaj idzie przez silnik `yaml` (devDependency), którym harness
 * AVA wypełnia `setYamlEngine()` w testach - produkcja wstrzykuje Obsidianowy `stringifyYaml`
 * (`src/main.ts`). Oba serializują ten sam obiekt do czytelnego YAML-a, ale bajt w bajt
 * formatowanie (kolejność spacji, cudzysłowy) jest szczegółem SILNIKA, nie kontraktem tej
 * funkcji - dlatego asercje niżej sprawdzają POCZĄTEK i OBECNOŚĆ poszczególnych linii, nie
 * całą zwrotkę znak po znaku.
 */
import test from 'ava';
import { buildAgentExportYaml } from './agentExportYaml.js';

test('buildAgentExportYaml: treść agenta z serialize() jest czytelna w eksporcie', t => {
    const agent = {
        serialize: () => ({ name: 'Atlas', access_policy_version: 2, temperature: 0.7 }),
    };
    const out = buildAgentExportYaml(agent);
    t.true(out.includes('Atlas'), `treść agenta ma być czytelna w eksporcie: ${out}`);
});

test('buildAgentExportYaml: eksport zaczyna się YAML-em agenta, niesie wszystkie pola serialize()', t => {
    const agent = { serialize: () => ({ name: 'Atlas', access_policy_version: 2, temperature: 0.7 }) };
    const out = buildAgentExportYaml(agent);
    t.true(out.startsWith('name: Atlas'), out);
    t.true(out.includes('access_policy_version: 2'), out);
    t.true(out.includes('temperature: 0.7'), out);
});
