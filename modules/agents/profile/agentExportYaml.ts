/**
 * agentExportYaml.ts — transformacja agenta na tekst eksportu profilu (guzik „Eksportuj" w
 * Zaawansowanych -> schowek).
 *
 * Plik jest CELOWO czysty (bez `obsidian`, zero łańcucha `profile_helpers.js` ->
 * `HiddenFileEditorModal.js` -> `./HiddenFileEditorModal.css` z `import ... with { type: 'css'
 * }`, którego AVA/tsx nie wstaje) - `profile_advanced.ts` importuje ten plik i zostaje cienkim
 * wołaczem, wzorem `chat/turnOwner.ts` i innych czystych helperów obok mixinów `obsidian` w
 * `modules/chat/` (patrz `modules/chat/CLAUDE.md`, sekcja "Pattern: prototype mixin").
 *
 * Bug B3: `Agent.serialize()` oddaje OBIEKT — ten sam kontrakt, którym `AgentLoader` zapisuje
 * pliki YAML agentów (`stringifyYaml(agent.serialize())`, `AgentLoader.ts`) — nie string.
 * Stary kod robił `yaml as unknown as string` na tym obiekcie: rzutowanie zdejmuje TYP, nie
 * serializuje wartość, więc `navigator.clipboard.writeText` dostawał obiekt zamiast tekstu
 * (`out.includes is not a function` w teście - `typeof out === 'object'`, nie `'string'`).
 */
import { stringifyYaml } from '../../../core/index.js';

/** Kształt, jakiego potrzebuje `buildAgentExportYaml` — `Agent` ma `serialize()` zawsze, ale
 * funkcja zostaje duck-typowana (bez importu klasy `Agent`), tak jak dawny kod. Indeks otwarty,
 * bo gałąź bez `serialize()` serializuje CAŁY obiekt (np. `{name: ...}` bez metody). */
export type SerializableAgent = { serialize?: () => unknown; [key: string]: unknown };

/**
 * Zamienia agenta na tekst YAML do eksportu - TEN SAM silnik, którym pliki agentów są pisane
 * na dysk (`stringifyYaml`, `core/index.js`), więc eksport wygląda dokładnie jak plik YAML.
 * @param ag - agent (albo dowolny obiekt z opcjonalnym `serialize()`, dla zgodności z dawnym
 *   duck-typingiem); wołacz (`profile_advanced.ts`) odmawia WCZEŚNIEJ (notice „zapisz
 *   najpierw"), gdy agenta jeszcze nie ma - ta funkcja zawsze dostaje coś, na czym ma pracować.
 */
export function buildAgentExportYaml(ag: SerializableAgent): string {
    const data = typeof ag.serialize === 'function' ? ag.serialize() : ag;
    return stringifyYaml(data);
}
