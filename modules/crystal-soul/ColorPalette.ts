/**
 * Crystal Soul — Color Palette
 * 64 luxury gemstone-inspired colors for agent theming.
 * Each agent picks one color. User also gets a color (set in Agora).
 */
import { seededStringHash } from './utils/stableHash.js';

export type ColorEntry = { name: string; hex: string };

export const COLOR_GROUPS = {
  fiolety: [
    { name: 'Królewski Ametyst', hex: '#7B5EA7' },
    { name: 'Dymna Lawenda', hex: '#8E7BAE' },
    { name: 'Śliwka', hex: '#6D4E7A' },
    { name: 'Ciemna Orchidea', hex: '#7A5B95' },
    { name: 'Mglisty Fiolet', hex: '#9484A8' },
    { name: 'Głęboki Purpurowy', hex: '#5E3D7A' },
    { name: 'Żywy Ametyst', hex: '#9668C8' },
    { name: 'Szlachetna Purpura', hex: '#8B50B0' },
  ],
  blekity: [
    { name: 'Głęboki Szafir', hex: '#4A6FA5' },
    { name: 'Stalowy Błękit', hex: '#5D7F9E' },
    { name: 'Północny Atrament', hex: '#3B5F8A' },
    { name: 'Lodowy Lazur', hex: '#6E94B5' },
    { name: 'Elektryczny Szafir', hex: '#4878C8' },
    { name: 'Królewski Błękit', hex: '#5585C5' },
    { name: 'Czysty Niebieski', hex: '#3B6BE0' },
    { name: 'Północna Gwiazda', hex: '#4070D8' },
  ],
  turkusy: [
    { name: 'Głęboki Turkus', hex: '#3D8B8A' },
    { name: 'Patyna', hex: '#5E9E9B' },
    { name: 'Morski Agat', hex: '#4A8580' },
    { name: 'Ciemna Akwamaryna', hex: '#3B8EA0' },
    { name: 'Szlachetny Teal', hex: '#4E8F8D' },
    { name: 'Mgła Oceanu', hex: '#6A9EA0' },
    { name: 'Jasny Turkus', hex: '#45A8A5' },
    { name: 'Żywy Cyjan', hex: '#3CAAB8' },
  ],
  zielenie: [
    { name: 'Głęboki Szmaragd', hex: '#3A8B6E' },
    { name: 'Szałwia', hex: '#6B937A' },
    { name: 'Leśny Mech', hex: '#4E8565' },
    { name: 'Jadeitowa Zieleń', hex: '#3F8A75' },
    { name: 'Antyczny Szmaragd', hex: '#4D8A6B' },
    { name: 'Szronowa Mięta', hex: '#6EA08A' },
    { name: 'Żywy Szmaragd', hex: '#3AAE7A' },
    { name: 'Jasny Jadeit', hex: '#48B088' },
  ],
  czerwienie: [
    { name: 'Wino', hex: '#9E5565' },
    { name: 'Burgundowy', hex: '#8A4A5A' },
    { name: 'Antyczny Róż', hex: '#B38085' },
    { name: 'Mauve', hex: '#9E708A' },
    { name: 'Pudrowy', hex: '#B08B95' },
    { name: 'Głęboki Granat', hex: '#8B4055' },
    { name: 'Żywy Rubin', hex: '#C04A5E' },
    { name: 'Szlachetny Karmin', hex: '#B84058' },
  ],
  pomarancze: [
    { name: 'Ciemna Miedź', hex: '#A87450' },
    { name: 'Terakota', hex: '#B07058' },
    { name: 'Glina', hex: '#9E7A5E' },
    { name: 'Spalony Bursztyn', hex: '#A07040' },
    { name: 'Cynamonowy', hex: '#A0784E' },
    { name: 'Stary Brąz', hex: '#8E7050' },
    { name: 'Żywy Koral', hex: '#C86A50' },
    { name: 'Szlachetna Miedź', hex: '#C58048' },
  ],
  zlota: [
    { name: 'Antyczne Złoto', hex: '#B09548' },
    { name: 'Ciemny Miód', hex: '#A08540' },
    { name: 'Starożłoty', hex: '#9A8A4E' },
    { name: 'Piaskowy Topaz', hex: '#B0994E' },
    { name: 'Szampan', hex: '#B5A068' },
    { name: 'Ciepła Ambra', hex: '#A89050' },
    { name: 'Jasne Złoto', hex: '#C8A845' },
    { name: 'Żywy Miód', hex: '#C0A038' },
  ],
  neutralne: [
    { name: 'Kwarc Dymny', hex: '#8A7E72' },
    { name: 'Łupek', hex: '#6B7B8A' },
    { name: 'Obsydian', hex: '#5A6575' },
    { name: 'Kamień Księżycowy', hex: '#8E9BAB' },
    { name: 'Bazalt', hex: '#5E6B72' },
    { name: 'Ciepła Szarość', hex: '#8A8078' },
    { name: 'Jasny Łupek', hex: '#7E90A5' },
    { name: 'Srebrna Stal', hex: '#8B98A8' },
  ],
};

/** Flat array of all colors */
export const ALL_COLORS = Object.values(COLOR_GROUPS).flat();

/** Get color entry by hex */
export function getColorByHex(hex: string): ColorEntry | undefined {
  return ALL_COLORS.find(c => c.hex.toLowerCase() === hex.toLowerCase());
}

/** Pick a color deterministically from a seed string (e.g. agent name) */
export function pickColor(seed: string): ColorEntry {
  return ALL_COLORS[seededStringHash(seed) % ALL_COLORS.length];
}
