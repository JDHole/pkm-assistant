/**
 * agentExportYaml.ts — transformacja agenta na tekst eksportu profilu (guzik „Eksportuj" w
 * Zaawansowanych -> schowek).
 *
 * Plik jest CELOWO czysty (bez `obsidian`, zero łańcucha `profile_helpers.js` ->
 * `HiddenFileEditorModal.js` -> `./HiddenFileEditorModal.css` z `import ... with { type: 'css'
 * }`, którego AVA/tsx nie wstaje) - `profile_advanced.ts` importuje ten plik i zostaje cienkim
 * wołaczem, wzorem `chat/turnOwner.ts` i innych czystych helperów obok mixinów `obsidian` w
 * `modules/chat/` (patrz `modules/chat/CLAUDE.md`, sekcja "Pattern: prototype mixin").
 */

/** Kształt, jakiego potrzebuje `buildAgentExportYaml` — `Agent` ma `serialize()` zawsze, ale
 * funkcja zostaje duck-typowana (bez importu klasy `Agent`), tak jak dawny kod. */
export type SerializableAgent = { serialize?: () => unknown };

/**
 * Zamienia agenta na tekst do eksportu.
 *
 * ⚠️ ZASTANE (bug B3): `serialize()` oddaje OBIEKT, nie string — rzutowanie `as unknown as
 * string` na obiekcie nie SERIALIZUJE go, tylko zdejmuje typ. `navigator.clipboard.writeText`
 * dostawał więc obiekt, a przeglądarka woła na nim `String(...)` -> `"[object Object]"` do
 * schowka, zamiast treści agenta.
 */
export function buildAgentExportYaml(ag: SerializableAgent): string {
    const yaml = typeof ag.serialize === 'function' ? ag.serialize() : JSON.stringify(ag, null, 2);
    return yaml as unknown as string;
}
