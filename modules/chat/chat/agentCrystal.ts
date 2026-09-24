/**
 * @module agentCrystal
 * Krysztal agenta jako wartosc CSS `--cs-agent-crystal` (2.3.0, kolumna dymkow) - JEDEN
 * producent dla TRZECH miejsc, ktore go ustawiaja inline na kontenerze `.cs-message--agent`:
 * `append_message` i `render_messages` (`chat_messages.ts`) oraz `_ensureAgentMessageContainer`
 * (`chat_streaming.ts`). Bez tego pliku kazde z trzech miejsc sklejaloby ten sam data URL od
 * zera (dublowanie, ktore ta jednostka ma wyciac).
 *
 * TRZECI plik w module, ten sam wzorzec co `machineTile.ts` (patrz jego komentarz naglowka) -
 * `chat_messages.ts` juz importuje `buildBackgroundReceiptText` Z `chat_streaming.ts`, wiec
 * odwrotny import (chat_streaming.ts <- chat_messages.ts) zamknalby cykl. Ten plik nie
 * importuje ANI JEDNEGO z dwoch mixinow, wiec zaden cykl nie powstaje.
 *
 * Krysztal renderuje sie CSS pseudo-elementem `::after` przy KAZDYM elemencie agenta (kafelek
 * `.cs-tile--agent`/`.cs-tile--agent-muted`, dymek tekstu `.cs-message--agent > .cs-message__text`)
 * - patrz `chat_view.css`. Naglowek serii (dawne `.cs-message__agent-head`/
 * `.cs-message__agent-crystal`, jeden krysztal na cala serie) znikl w tej samej zmianie.
 */
import { SkinManager } from '../../crystal-soul/index.js';
import type { AgentVisual } from '../../crystal-soul/index.js';

/** Rozmiar krysztalu w pikselach - MUSI zgadzac sie z `width`/`height: 18px` w `chat_view.css`'s `::after`. */
const AGENT_CRYSTAL_SIZE = 18;

/**
 * `url("data:image/svg+xml,<zakodowany SVG>")` - gotowa wartosc do
 * `el.style.setProperty('--cs-agent-crystal', agentCrystalCssVar(agent, color))`.
 */
export function agentCrystalCssVar(agent: AgentVisual, color: string): string {
    const svg = SkinManager.getCrystal(agent, { size: AGENT_CRYSTAL_SIZE, color, glow: false });
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
