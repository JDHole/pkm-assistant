/**
 * Crystal Soul Design System — Public API
 *
 * Usage:
 *   import { IconGenerator, CrystalGenerator, ColorPalette } from '<sciezka>/modules/crystal-soul/index.js';
 *
 *   // Generate icon SVG
 *   const iconSvg = IconGenerator.generate('vault_search', 'search', { size: 24, color: '#4A6FA5' });
 *
 *   // Generate crystal SVG
 *   const crystalSvg = CrystalGenerator.generate('jaskier', { size: 48, color: '#7B5EA7', glow: true });
 *
 *   // Get color palette
 *   const allColors = ColorPalette.ALL_COLORS;
 *   const color = ColorPalette.pickColor('jaskier');  // deterministic color from name
 */

// S30 Z4 (przycinka powierzchni): z barrela wypadły `CrystalGenerator`, `CATEGORY_COLORS`,
// `SkinManagerClass`, `SkinLoader`, `defaultSkin`, `generateMonogramAvatar`, `crystalSoulSkin`
// — zero konsumentów spoza modułu (kryształy i skiny rysuje się dziś przez `SkinManager`,
// a on trzyma je u siebie). Definicje żyją w bebechach; wołaj je przez `SkinManager`.
export { IconGenerator } from './IconGenerator.js';
export type { IconCategory, IconOptions } from './IconGenerator.js';
export { SvgHelper, hexToRgbTriplet } from './SvgHelper.js';
export { setSvg, setSvgLabel } from './domUtils.js';
// AUD-bledy-037: montaż i DEMONTAŻ arkuszy — arkusz wchodzi przez `adoptSheet`, żeby
// `removeAdoptedSheets()` w `onunload` miało co zdjąć z `document.adoptedStyleSheets`.
export { adoptSheet, removeAdoptedSheets } from './styleSheets.js';
export type { AdoptableSheet, SheetHost } from './styleSheets.js';
export { UiIcons } from './UiIcons.js';
export type { UiIcon } from './UiIcons.js';
// NOTE: icons.js (registerPkmIcon) is intentionally NOT
// re-exported here. It statically imports `obsidian` (addIcon), which would taint
// this otherwise obsidian-free barrel and break every AVA test that loads it
// (TriggerPopup, TriggersView, …). Its only consumer is src/main.js (the plugin
// entry / composition root), which imports the file directly.
export { getCategoryColor, deriveDelegateCategory } from './category_colors.js';
export { SkinManager } from './SkinManager.js';
export type { AgentVisual, SkinDefinition, SkinRenderOptions, SkinSpec } from './SkinManager.js';
export {
  COLOR_GROUPS,
  ALL_COLORS,
  getColorByHex,
  pickColor,
} from './ColorPalette.js';
export type { ColorEntry } from './ColorPalette.js';
export { registerSettings } from './SettingsSection.js';
