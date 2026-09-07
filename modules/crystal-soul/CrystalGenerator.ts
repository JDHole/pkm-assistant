/**
 * Crystal Soul — Crystal Generator
 * Procedural SVG crystal shapes for agent avatars.
 * Seed-based = deterministic (same agent name = same crystal always).
 *
 * 8 shape families: pryzmat, diament, igła, klaster, heksagon, podwójny, tarcza, odłamek.
 * Seed controls: which shape + proportions within that shape.
 *
 * Usage:
 *   CrystalGenerator.generate('jaskier')                        → full <svg>
 *   CrystalGenerator.generate('jaskier', { size: 64, color: '#7B5EA7', glow: true })
 *   CrystalGenerator.generateInner('jaskier', '#7B5EA7')        → inner SVG only
 */

import { seededStringHash } from './utils/stableHash.js';
// K11 (AUD-security-090): kolor z profilu agenta wchodzi do MARKUPU — przez bramkę ksztaltu.
import { sanitizeSvgColor } from './SvgHelper.js';

export type CrystalOptions = { size?: number; color?: string; glow?: boolean };

// ── Seeded PRNG ─────────────────────────────────────────────
class SeededRNG {
  declare private _state: number;

  constructor(seed: string | number) {
    this._state = typeof seed === 'string' ? seededStringHash(seed) : seed;
  }
  next() {
    let t = (this._state += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number { return Math.floor(this.next() * (max - min + 1)) + min; }
  float(min: number, max: number): number { return this.next() * (max - min) + min; }
  pick<T>(arr: T[]): T { return arr[this.int(0, arr.length - 1)]; }
  bool(chance = 0.5): boolean { return this.next() < chance; }
}

// ── Helpers ─────────────────────────────────────────────────
const pg = (points: string, color: string, fillOp = 0.25): string =>
  `<polygon points="${points}" fill="${color}" fill-opacity="${fillOp}" stroke="${color}" stroke-width="1.8"/>`;

const ln = (x1: number, y1: number, x2: number, y2: number, color: string, op = 0.3): string =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-opacity="${op}" stroke-width="1"/>`;

function pts(arr: number[][]): string {
  return arr.map(p => p.join(',')).join(' ');
}

// ── Crystal Shape Templates ─────────────────────────────────
type CrystalTemplate = (rng: SeededRNG, color: string) => string;

const CRYSTAL_TEMPLATES: CrystalTemplate[] = [
  // 0: pryzmat
  (rng, col) => {
    const topX = 30 + rng.float(-3, 3);
    const topY = rng.float(2, 8);
    const waistY = rng.float(24, 34);
    const botY = rng.float(92, 98);
    const wTop = rng.float(20, 26);
    const wBot = rng.float(14, 20);
    const body = pts([[topX, topY], [30 + wTop, waistY], [30 + wBot, botY], [30 - wBot, botY], [30 - wTop, waistY]]);
    let svg = pg(body, col);
    svg += ln(topX, topY, 30 - wBot, botY, col);
    svg += ln(topX, topY, 30 + wBot, botY, col);
    svg += ln(30 - wTop, waistY, 30 + wTop, waistY, col, 0.25);
    return svg;
  },
  // 1: diament
  (rng, col) => {
    const topY = rng.float(2, 8);
    const midY = rng.float(28, 38);
    const lowY = rng.float(52, 62);
    const botY = rng.float(90, 98);
    const w1 = rng.float(22, 28);
    const w2 = rng.float(16, 22);
    const body = pts([[30, topY], [30 + w1, midY], [30 + w2, lowY], [30, botY], [30 - w2, lowY], [30 - w1, midY]]);
    let svg = pg(body, col);
    svg += ln(30 - w1, midY, 30 + w1, midY, col);
    svg += ln(30, topY, 30 - w2, lowY, col, 0.2);
    svg += ln(30, topY, 30 + w2, lowY, col, 0.2);
    svg += ln(30, botY, 30 - w1, midY, col, 0.15);
    svg += ln(30, botY, 30 + w1, midY, col, 0.15);
    return svg;
  },
  // 2: igła
  (rng, col) => {
    const topW = rng.float(4, 8);
    const midW = rng.float(6, 12);
    const neckY = rng.float(16, 24);
    const waistY = rng.float(72, 84);
    const body = pts([[30 - topW, rng.float(2, 5)], [30 + topW, rng.float(2, 5)], [30 + midW, neckY], [30 + midW - 1, waistY], [30 + topW, rng.float(94, 98)], [30 - topW, rng.float(94, 98)], [30 - midW + 1, waistY], [30 - midW, neckY]]);
    let svg = pg(body, col);
    svg += ln(30, 3, 30, 97, col, 0.25);
    svg += ln(30 - midW, neckY, 30 + midW, neckY, col, 0.2);
    svg += ln(30 - midW + 1, waistY, 30 + midW + 1, waistY, col, 0.2);
    return svg;
  },
  // 3: klaster
  (rng, col) => {
    const n = rng.int(3, 4);
    let svg = '';
    const crystals = [];
    for (let i = 0; i < n; i++) {
      const cx = rng.float(12, 48);
      const topY = rng.float(2, 30);
      const botY = rng.float(65, 98);
      const w = rng.float(6, 14);
      crystals.push({ cx, topY, botY, w });
    }
    crystals.sort((a, b) => (b.botY - b.topY) - (a.botY - a.topY));
    for (const cr of crystals) {
      const body = pts([[cr.cx, cr.topY], [cr.cx + cr.w, cr.topY + cr.w + 5], [cr.cx + cr.w - 2, cr.botY], [cr.cx - cr.w + 2, cr.botY], [cr.cx - cr.w, cr.topY + cr.w + 5]]);
      svg += pg(body, col, rng.float(0.15, 0.3));
    }
    return svg;
  },
  // 4: heksagon
  (rng, col) => {
    const topY = rng.float(2, 8);
    const botY = rng.float(90, 98);
    const topW = rng.float(18, 24);
    const midW = rng.float(20, 26);
    const midY1 = rng.float(14, 22);
    const midY2 = rng.float(68, 80);
    const body = pts([[30, topY], [30 + topW, midY1], [30 + midW, 50], [30 + topW, midY2], [30, botY], [30 - topW, midY2], [30 - midW, 50], [30 - topW, midY1]]);
    let svg = pg(body, col);
    svg += ln(30, topY, 30, botY, col, 0.2);
    if (rng.bool(0.5)) {
      svg += ln(30 - topW, midY1, 30 + topW, midY2, col, 0.15);
      svg += ln(30 + topW, midY1, 30 - topW, midY2, col, 0.15);
    }
    return svg;
  },
  // 5: podwójny
  (rng, col) => {
    const topY = rng.float(2, 6);
    const botY = rng.float(94, 98);
    const midW = rng.float(16, 22);
    const neckW = rng.float(12, 18);
    const neckY1 = rng.float(18, 28);
    const neckY2 = rng.float(72, 82);
    const body = pts([[30, topY], [30 + midW, neckY1], [30 + neckW, 50], [30 + midW, neckY2], [30, botY], [30 - midW, neckY2], [30 - neckW, 50], [30 - midW, neckY1]]);
    let svg = pg(body, col);
    svg += ln(30 - midW, neckY1, 30 + midW, neckY2, col, 0.2);
    svg += ln(30 + midW, neckY1, 30 - midW, neckY2, col, 0.2);
    svg += ln(30 - neckW, 50, 30 + neckW, 50, col, 0.25);
    return svg;
  },
  // 6: tarcza
  (rng, col) => {
    const topY = rng.float(5, 12);
    const botY = rng.float(85, 95);
    const w = rng.float(22, 28);
    const midY1 = rng.float(20, 30);
    const midY2 = rng.float(50, 60);
    const body = pts([[30, topY], [30 + w, midY1], [30 + w, midY2], [30, botY], [30 - w, midY2], [30 - w, midY1]]);
    let svg = pg(body, col);
    const iw = w * rng.float(0.5, 0.7);
    const inner = pts([[30, topY + 12], [30 + iw, midY1 + 5], [30 + iw, midY2 - 3], [30, botY - 15], [30 - iw, midY2 - 3], [30 - iw, midY1 + 5]]);
    svg += pg(inner, col, 0.12);
    if (rng.bool(0.5)) svg += ln(30, topY, 30, botY, col, 0.15);
    return svg;
  },
  // 7: odłamek
  (rng, col) => {
    const n = rng.int(6, 9);
    const points = [];
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const r = rng.float(18, 40);
      points.push([+(30 + Math.cos(angle) * r * rng.float(0.6, 1)).toFixed(1), +(50 + Math.sin(angle) * r * rng.float(0.5, 1)).toFixed(1)]);
    }
    let svg = pg(pts(points), col);
    const facets = rng.int(2, 4);
    for (let i = 0; i < facets; i++) {
      const p = rng.pick(points);
      svg += ln(30, 50, p[0], p[1], col, 0.2);
    }
    return svg;
  },
];

// ── Shape Names ─────────────────────────────────────────────
const SHAPE_NAMES = ['pryzmat', 'diament', 'igła', 'klaster', 'heksagon', 'podwójny', 'tarcza', 'odłamek'];

// ── Main Generator ──────────────────────────────────────────
export class CrystalGenerator {

  /** All available shape names */
  static SHAPES = SHAPE_NAMES;

  /**
   * Generate a full <svg> crystal
   * @param {string} seed - Agent name or unique string
   * @param {{size?: number, color?: string, glow?: boolean}} options
   * @returns {string} Complete SVG markup
   */
  static generate(seed: string, options: CrystalOptions = {}): string {
    const size = options.size || 48;
    const color = sanitizeSvgColor(options.color);
    const glow = options.glow !== false;
    const inner = this.generateInner(seed, color);
    const filterId = `cg-${seededStringHash(String(seed))}`;
    const glowFilter = glow
      ? `<defs><filter id="${filterId}"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`
      : '';
    const filterAttr = glow ? ` filter="url(#${filterId})"` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 100" width="${size}" height="${Math.round(size * 100 / 60)}">${glowFilter}<g${filterAttr}>${inner}</g></svg>`;
  }

  /**
   * Generate inner SVG elements only
   * @param {string} seed
   * @param {string} color
   * @returns {string} SVG elements
   */
  static generateInner(seed: string, color = 'currentColor'): string {
    if (SHAPE_NAMES.length !== CRYSTAL_TEMPLATES.length) {
      throw new Error('CrystalGenerator shape names/templates length mismatch');
    }
    const rng = new SeededRNG(seed);
    const template = rng.pick(CRYSTAL_TEMPLATES);
    // K11: bramka stoi TAKŻE tutaj — `generateInner` bywa wołane wprost, z pominięciem `generate`.
    return template(rng, sanitizeSvgColor(color));
  }

  /**
   * Get the shape name that a seed would produce (for display)
   * @param {string} seed
   * @returns {string}
   */
  static getShapeName(seed: string): string {
    if (SHAPE_NAMES.length !== CRYSTAL_TEMPLATES.length) {
      throw new Error('CrystalGenerator shape names/templates length mismatch');
    }
    const rng = new SeededRNG(seed);
    const idx = rng.int(0, SHAPE_NAMES.length - 1);
    return SHAPE_NAMES[idx];
  }
}
