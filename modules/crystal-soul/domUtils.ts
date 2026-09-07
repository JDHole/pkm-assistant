/**
 * domUtils — safe DOM insertion for Crystal Soul markup.
 *
 * WHY: icon generators (IconGenerator / UiIcons / CrystalGenerator) return SVG
 * markup strings, and UI code used to glue them to dynamic data by assigning raw
 * HTML to an element. That is an XSS vector whenever the label comes from the
 * vault, a skill/sub-agent file or an external MCP server.
 *
 * RULE: only plugin-shaped `<svg>` markup is ever parsed (inertly, via DOMParser
 * in SvgHelper). Everything else — labels, emoji icons from user YAML, paths,
 * tool names — is appended as a text node. Raw HTML is never assigned anywhere.
 *
 * NOTE: deliberately free of `obsidian` imports. This file is re-exported from
 * the crystal-soul barrel, and the barrel must stay importable outside Obsidian
 * (AVA tests load it transitively — see the note in index.js).
 */
import { SvgHelper } from './SvgHelper.js';

/** Plugin generators always emit a complete <svg> root; nothing else is parsed. */
const SVG_ROOT = /^\s*<svg[\s>]/i;

type ObsidianElement = HTMLElement & {
  empty(): void;
  appendText(text: string): void;
};

/**
 * Append markup to an element: `<svg>` markup as a parsed element, anything
 * else (emoji, arbitrary user string) as text.
 * @param {HTMLElement} el
 * @param {string} markup
 */
function appendMarkup(el: ObsidianElement, markup: string): void {
  if (markup == null || markup === '') return;
  const str = String(markup);
  if (SVG_ROOT.test(str) && typeof DOMParser !== 'undefined') {
    el.appendChild(SvgHelper.toElement(str));
  } else {
    el.appendText(str);
  }
}

/**
 * Replace an element's content with a plugin-generated SVG/icon.
 * @param {HTMLElement} el - Target element (emptied first)
 * @param {string} svgMarkup - Icon markup, or a plain string (e.g. emoji)
 */
export function setSvg(el: ObsidianElement, svgMarkup: string): void {
  el.empty();
  appendMarkup(el, svgMarkup);
}

/**
 * Icon + plain-text label. The label is ALWAYS a text node — never markup.
 * @param {HTMLElement} el - Target element (emptied first)
 * @param {string} svgMarkup - Icon markup
 * @param {string} labelText - Untrusted label, inserted as text
 */
export function setSvgLabel(el: ObsidianElement, svgMarkup: string, labelText: string): void {
  setSvg(el, svgMarkup);
  if (labelText != null && labelText !== '') el.appendText(` ${labelText}`);
}
