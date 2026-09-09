/**
 * Wbudowani agenci (configi literały).
 *
 * Archetyp skasowany jako byt. Zostało TYLKO:
 * - HumanVibe → Jaskier (jedyny built-in agent, hardcoded onboarding).
 *
 * Domyślne prompty robocze żyją w `modules/memory/workPrompts.js` (bliżej konsumentów:
 * SaveSessionWorkflow/ArchiveWorkflow) i są rozwiązywane łańcuchem agent>global>factory.
 */

// ── Built-in agent config: Jaskier ──
// `HUMAN_VIBE_CONFIG` NIE jest re-eksportowana - zero konsumentów w repo poza `createJaskier`
// w tym samym pliku (HumanVibe.ts). Stała nie jest już `export`owana ani tam.
export { createJaskier } from './HumanVibe.js';
