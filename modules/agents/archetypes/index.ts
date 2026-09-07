/**
 * Wbudowani agenci (configi literały).
 *
 * E2.8 A1 — archetyp skasowany jako byt. Zostało TYLKO:
 * - HumanVibe → Jaskier (jedyny built-in agent, hardcoded onboarding).
 *
 * E2.8 B3 — domyślne prompty robocze przeniesione do `modules/memory/workPrompts.js` (bliżej
 * konsumentów: SaveSessionWorkflow/ArchiveWorkflow) i rozwiązywane łańcuchem agent>global>factory.
 *
 * (Dawne archetypy v2 + template'y Nika/Borys usunięte — patrz spec E2.8 sekcja A1.)
 */

// ── Built-in agent config: Jaskier ──
// AUD-dead-code-069/191/239 (2026-09-02): `HUMAN_VIBE_CONFIG` NIE jest już re-eksportowana —
// zero konsumentów w repo poza `createJaskier` w tym samym pliku (HumanVibe.ts). Stała nie
// jest już `export`owana ani tam.
export { createJaskier } from './HumanVibe.js';
