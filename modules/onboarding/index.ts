/**
 * modules/onboarding — Public API barrel
 *
 * 4-step wizard MINIMUM (OnboardingModal) + Playbook Builder (PlaybookManager).
 * Filozofia: szybki onboarding (1-2 min) — reszta przez rozmowę z Jaskierem.
 * Patrz CLAUDE.md tego modułu dla decyzji architektonicznych.
 *
 * S30 Z4 (przycinka powierzchni): `OnboardingModal` OUT z barrela — wizard jest
 * wyłączony od S01 Z7 (`main.js` pokazuje Notice zamiast modala) i nie ma ANI JEDNEGO
 * wołacza. Plik `OnboardingModal.js` ZOSTAJE jako szkielet pod v3; wracasz do wizarda →
 * wracasz z eksportem razem z konsumentem.
 */

export { PlaybookManager } from './PlaybookManager.js';
export type {
    VaultMapAgent,
    VaultMapFocusFolder,
    VaultMapPlugin,
} from './PlaybookManager.js';
