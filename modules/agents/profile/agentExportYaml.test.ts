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
 * obiekcie zamiast serializować go - rzutowanie zdejmuje TYP, nie zamienia obiektu w string,
 * więc `clipboard.writeText` dostawał obiekt, a jego zamiana na string w przeglądarce dawała
 * dosłownie `"[object Object]"`.
 */
import test from 'ava';
import { buildAgentExportYaml } from './agentExportYaml.js';

test('buildAgentExportYaml: NIE wynosi surowego "[object Object]" do schowka', t => {
    const agent = {
        serialize: () => ({ name: 'Atlas', access_policy_version: 2, temperature: 0.7 }),
    };
    const out = buildAgentExportYaml(agent);
    t.not(out, '[object Object]', 'dokładnie ten napis lądował w schowku przed naprawą');
    t.true(out.includes('Atlas'), `treść agenta ma być czytelna w eksporcie: ${out}`);
});

test('buildAgentExportYaml: wynik jest STRINGIEM (nie obiektem z rzutu na typie)', t => {
    const agent = { serialize: () => ({ name: 'Atlas' }) };
    const out = buildAgentExportYaml(agent);
    t.is(typeof out, 'string');
});

test('buildAgentExportYaml: eksport zaczyna się YAML-em agenta (dosłowna treść)', t => {
    const agent = { serialize: () => ({ name: 'Atlas', access_policy_version: 2, temperature: 0.7 }) };
    const out = buildAgentExportYaml(agent);
    t.true(out.startsWith('name: Atlas'), out);
    t.is(out, 'name: Atlas\naccess_policy_version: 2\ntemperature: 0.7\n');
});

test('buildAgentExportYaml: bez serialize() (duck-typing zastany) - stringifyYaml na całym obiekcie', t => {
    const agent = { name: 'Bezimienny' };
    const out = buildAgentExportYaml(agent);
    t.is(out, 'name: Bezimienny\n');
});
