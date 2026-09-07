/**
 * Crystal Soul — Icon Generator
 * Procedural SVG icon generator. Seed-based = deterministic (same seed = same icon).
 *
 * Categories:
 *   memory   → round shapes (circles, spirals, orbits)
 *   search   → triangular shapes (arrows, prisms, chevrons)
 *   write    → square shapes (pages, grids, frames)
 *   connect  → organic/flowing (waves, branches, networks, nodes)
 *   arcane   → mystical sigils (runes, glyphs, pentagrams, marks)
 *
 * Usage:
 *   IconGenerator.generate('vault_search', 'search')        → full <svg> string
 *   IconGenerator.generate('memory_write', 'memory', { size: 32, color: '#7B5EA7' })
 *   IconGenerator.generate('agent_msg', 'connect')          → organic flowing icon
 *   IconGenerator.generate('deep_analysis', 'arcane')       → mystical sigil icon
 *   IconGenerator.generateInner('brain', 'memory')           → inner SVG elements only
 */

import { seededStringHash } from './utils/stableHash.js';
import { log } from '../../core/utils/Logger.js';

export type IconCategory = 'memory' | 'search' | 'write' | 'connect' | 'arcane' | 'mixed';
export type IconOptions = { size?: number; color?: string };

// ── Seeded PRNG (mulberry32-based) ──────────────────────────
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

// ── Main Generator ──────────────────────────────────────────
export class IconGenerator {

  /**
   * Generate a full <svg> string
   * @param {string|number} seed
   * @param {'memory'|'search'|'write'|'connect'|'arcane'|'mixed'} category
   * @param {{size?: number, color?: string}} options
   * @returns {string} Complete SVG markup
   */
  static generate(seed: string | number, category: string = 'mixed', options: IconOptions = {}): string {
    const size = options.size || 24;
    const color = options.color || 'currentColor';
    const inner = this.generateInner(seed, category, color);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="${size}" height="${size}">${inner}</svg>`;
  }

  /**
   * Generate inner SVG elements only (for embedding in existing <svg>)
   * @param {string|number} seed
   * @param {'memory'|'search'|'write'|'connect'|'arcane'|'mixed'} category
   * @param {string} color
   * @returns {string} SVG elements markup
   */
  static generateInner(seed: string | number, category: string = 'mixed', color = 'currentColor'): string {
    const rng = new SeededRNG(seed);
    const known: Exclude<IconCategory, 'mixed'>[] = ['memory', 'search', 'write', 'connect', 'arcane'];
    let cat: Exclude<IconCategory, 'mixed'>;
    if (category === 'mixed') {
      cat = rng.pick(known);
    } else if (known.includes(category as Exclude<IconCategory, 'mixed'>)) {
      cat = category as Exclude<IconCategory, 'mixed'>;
    } else {
      log.warn('IconGenerator', `IconGenerator: unknown category "${category}" — falling back to "mixed"`);
      cat = rng.pick(known);
    }
    const templates = TEMPLATES[cat];
    const template = rng.pick(templates);
    const base = template(rng, color);
    // Optional rotation transform
    const rotate = rng.bool(0.25) ? rng.pick([0, 45, 90, 180]) : 0;
    if (rotate === 0) return base;
    return `<g transform="rotate(${rotate} 14 14)">${base}</g>`;
  }
}

// ── Helper: SVG element shorthand ───────────────────────────
const c = (cx: number | string, cy: number | string, r: number, color: string, fill = false): string =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill ? color : 'none'}" ${fill ? '' : `stroke="${color}" stroke-width="1.8"`}/>`;

const l = (x1: number | string, y1: number | string, x2: number | string, y2: number | string, color: string, op = 1): string =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5" stroke-opacity="${op}" stroke-linecap="round"/>`;

const poly = (points: string, color: string, fillOp = 0): string =>
  `<polygon points="${points}" fill="${color}" fill-opacity="${fillOp}" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>`;

const rect = (x: number, y: number, w: number, h: number, color: string, rx = 2, fillOp = 0): string =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${color}" fill-opacity="${fillOp}" stroke="${color}" stroke-width="1.8"/>`;

const path = (d: string, color: string, fillOp = 0): string =>
  `<path d="${d}" fill="${color}" fill-opacity="${fillOp}" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;

// ── MEMORY templates (round) ────────────────────────────────
type IconTemplate = (rng: SeededRNG, color: string) => string;

const memoryTemplates: IconTemplate[] = [
  // 1. Center dot + ring
  (rng, col) => {
    const r = rng.float(9, 12);
    const dotR = rng.float(2, 4);
    let svg = c(14, 14, r, col) + c(14, 14, dotR, col, true);
    if (rng.bool(0.5)) svg += l(14, 14 - r, 14, 14 - r + 4, col, 0.6);
    if (rng.bool(0.4)) svg += l(14, 14 + r, 14, 14 + r - 4, col, 0.6);
    return svg;
  },
  // 2. Concentric rings
  (rng, col) => {
    const rings = rng.int(2, 3);
    let svg = '';
    for (let i = 0; i < rings; i++) {
      svg += c(14, 14, 12 - i * 4, col);
    }
    svg += c(14, 14, rng.float(1.5, 2.5), col, true);
    return svg;
  },
  // 3. Spiral
  (rng, col) => {
    const dir = rng.bool() ? 1 : -1;
    const turns = rng.float(1.2, 2.0);
    let d = 'M14,14';
    for (let a = 0; a < turns * Math.PI * 2; a += 0.3) {
      const r = 2 + a * 1.5;
      const x = 14 + Math.cos(a * dir) * r;
      const y = 14 + Math.sin(a * dir) * r;
      d += ` L${x.toFixed(1)},${y.toFixed(1)}`;
    }
    return path(d, col);
  },
  // 4. Orbit (ring + satellite dots)
  (rng, col) => {
    const r = rng.float(9, 11);
    const dots = rng.int(2, 4);
    let svg = c(14, 14, r, col);
    const offset = rng.float(0, Math.PI);
    for (let i = 0; i < dots; i++) {
      const a = offset + (i * Math.PI * 2) / dots;
      const x = 14 + Math.cos(a) * r;
      const y = 14 + Math.sin(a) * r;
      svg += c(x.toFixed(1), y.toFixed(1), rng.float(1.5, 2.5), col, true);
    }
    return svg;
  },
  // 5. Eye shape
  (rng, col) => {
    const w = rng.float(10, 13);
    const h = rng.float(5, 7);
    const d = `M${14 - w},14 Q14,${14 - h} ${14 + w},14 Q14,${14 + h} ${14 - w},14`;
    let svg = path(d, col);
    svg += c(14, 14, rng.float(2.5, 4), col, true);
    return svg;
  },
  // 6. Crescent
  (rng, col) => {
    const r1 = rng.float(10, 12);
    const shift = rng.float(4, 7);
    const d = `M14,${14 - r1} A${r1},${r1} 0 1,1 14,${14 + r1} A${r1 - shift},${r1 - shift} 0 1,0 14,${14 - r1}`;
    let svg = path(d, col, 0.15);
    if (rng.bool(0.5)) svg += c(14, 14, 2, col, true);
    return svg;
  },
  // 7. Ring with crosshairs
  (rng, col) => {
    const r = rng.float(9, 11);
    let svg = c(14, 14, r, col);
    const len = rng.float(3, 5);
    svg += l(14, 14 - r + 1, 14, 14 - r + len, col, 0.5);
    svg += l(14, 14 + r - 1, 14, 14 + r - len, col, 0.5);
    svg += l(14 - r + 1, 14, 14 - r + len, 14, col, 0.5);
    svg += l(14 + r - 1, 14, 14 + r - len, 14, col, 0.5);
    svg += c(14, 14, 2, col, true);
    return svg;
  },
  // 8. Double ring with gap
  (rng, col) => {
    const r1 = rng.float(10, 12);
    const r2 = rng.float(5, 7);
    let svg = c(14, 14, r1, col) + c(14, 14, r2, col);
    if (rng.bool(0.6)) svg += c(14, 14, rng.float(1.5, 2), col, true);
    if (rng.bool(0.4)) {
      const a = rng.float(0, Math.PI * 2);
      svg += l(
        (14 + Math.cos(a) * r2).toFixed(1), (14 + Math.sin(a) * r2).toFixed(1),
        (14 + Math.cos(a) * r1).toFixed(1), (14 + Math.sin(a) * r1).toFixed(1),
        col, 0.4
      );
    }
    return svg;
  },
];

// ── SEARCH templates (triangular) ───────────────────────────
const searchTemplates: IconTemplate[] = [
  // 1. Triangle
  (rng, col) => {
    const s = rng.float(10, 13);
    const pts = [
      [14, 14 - s],
      [14 + s * 0.87, 14 + s * 0.5],
      [14 - s * 0.87, 14 + s * 0.5],
    ].map(p => p.map(v => v.toFixed(1)).join(',')).join(' ');
    let svg = poly(pts, col, rng.float(0, 0.15));
    if (rng.bool(0.5)) svg += c(14, 14 + 1, 2, col, true);
    return svg;
  },
  // 2. Arrow up
  (rng, col) => {
    const w = rng.float(5, 7);
    const h = rng.float(10, 13);
    const shaft = rng.float(2, 3.5);
    const pts = `14,${14 - h} ${14 + w},${14 - h + w + 2} ${14 + shaft},${14 - h + w + 2} ${14 + shaft},${14 + h - 2} ${14 - shaft},${14 + h - 2} ${14 - shaft},${14 - h + w + 2} ${14 - w},${14 - h + w + 2}`;
    return poly(pts, col, rng.float(0, 0.1));
  },
  // 3. Prism / 3D diamond
  (rng, col) => {
    const w = rng.float(10, 13);
    const h = rng.float(8, 12);
    const pts = `14,${14 - h} ${14 + w},14 14,${14 + h} ${14 - w},14`;
    let svg = poly(pts, col, rng.float(0, 0.15));
    if (rng.bool(0.7)) svg += l(14, 14 - h, 14, 14 + h, col, 0.3);
    if (rng.bool(0.5)) svg += l(14 - w, 14, 14 + w, 14, col, 0.2);
    return svg;
  },
  // 4. Chevron
  (rng, col) => {
    const w = rng.float(8, 12);
    const h = rng.float(4, 6);
    const gap = rng.float(3, 5);
    let svg = path(`M${14 - w},${14 - gap} L14,${14 - gap - h} L${14 + w},${14 - gap}`, col);
    svg += path(`M${14 - w},${14 + gap} L14,${14 + gap - h} L${14 + w},${14 + gap}`, col);
    return svg;
  },
  // 5. Compass star
  (rng, col) => {
    const r1 = rng.float(10, 13);
    const r2 = rng.float(3, 5);
    const points = rng.pick([4, 6]);
    let pts = '';
    for (let i = 0; i < points * 2; i++) {
      const a = (i * Math.PI) / points - Math.PI / 2;
      const r = i % 2 === 0 ? r1 : r2;
      pts += `${(14 + Math.cos(a) * r).toFixed(1)},${(14 + Math.sin(a) * r).toFixed(1)} `;
    }
    return poly(pts.trim(), col, rng.float(0.05, 0.2));
  },
  // 6. Stacked triangles
  (rng, col) => {
    const s1 = rng.float(7, 9);
    const s2 = rng.float(4, 6);
    const off = rng.float(2, 4);
    let svg = poly(`14,${14 - s1 - off} ${14 + s1 * 0.87},${14 - off + s1 * 0.5} ${14 - s1 * 0.87},${14 - off + s1 * 0.5}`, col);
    svg += poly(`14,${14 + off - s2} ${14 + s2 * 0.87},${14 + off + s2 * 0.5} ${14 - s2 * 0.87},${14 + off + s2 * 0.5}`, col, 0.15);
    return svg;
  },
  // 7. Lightning bolt
  (rng, col) => {
    const w = rng.float(3, 5);
    const pts = `${14 - w},3 ${14 + 1},12 ${14 - 1},12 ${14 + w},25 ${14 - 2},16 ${14 + 0},16`;
    return poly(pts, col, rng.float(0.05, 0.2));
  },
  // 8. Pointed shield
  (rng, col) => {
    const w = rng.float(8, 11);
    const h = rng.float(10, 13);
    const pts = `14,${14 - h} ${14 + w},${14 - h * 0.3} ${14 + w * 0.8},${14 + h * 0.5} 14,${14 + h} ${14 - w * 0.8},${14 + h * 0.5} ${14 - w},${14 - h * 0.3}`;
    let svg = poly(pts, col, rng.float(0, 0.15));
    if (rng.bool(0.5)) svg += l(14, 14 - h, 14, 14 + h, col, 0.25);
    return svg;
  },
];

// ── WRITE templates (square) ────────────────────────────────
const writeTemplates: IconTemplate[] = [
  // 1. Simple frame
  (rng, col) => {
    const s = rng.float(8, 11);
    let svg = rect(14 - s, 14 - s, s * 2, s * 2, col, rng.float(1, 3));
    if (rng.bool(0.5)) svg += c(14, 14, 2, col, true);
    return svg;
  },
  // 2. Grid
  (rng, col) => {
    const s = rng.float(9, 11);
    let svg = rect(14 - s, 14 - s, s * 2, s * 2, col, 2);
    const divs = rng.pick([1, 2]);
    for (let i = 1; i <= divs; i++) {
      const pos = (s * 2 / (divs + 1)) * i;
      svg += l(14 - s, 14 - s + pos, 14 + s, 14 - s + pos, col, 0.3);
      svg += l(14 - s + pos, 14 - s, 14 - s + pos, 14 + s, col, 0.3);
    }
    return svg;
  },
  // 3. Page / document
  (rng, col) => {
    const w = rng.float(7, 9);
    const h = rng.float(10, 13);
    const fold = rng.float(3, 5);
    let svg = path(`M${14 - w},${14 - h} L${14 + w - fold},${14 - h} L${14 + w},${14 - h + fold} L${14 + w},${14 + h} L${14 - w},${14 + h} Z`, col);
    svg += l(14 + w - fold, 14 - h, 14 + w - fold, 14 - h + fold, col, 0.5);
    svg += l(14 + w - fold, 14 - h + fold, 14 + w, 14 - h + fold, col, 0.5);
    const lines = rng.int(2, 4);
    for (let i = 0; i < lines; i++) {
      const y = 14 - h + fold + 3 + i * 3.5;
      if (y < 14 + h - 2) svg += l(14 - w + 3, y, 14 + w - 3, y, col, 0.2);
    }
    return svg;
  },
  // 4. Stack of layers
  (rng, col) => {
    const layers = rng.int(2, 3);
    let svg = '';
    for (let i = layers - 1; i >= 0; i--) {
      const off = i * 3;
      svg += rect(5 + off, 5 + off, 16, 16, col, 2, i === 0 ? 0 : 0.05);
    }
    return svg;
  },
  // 5. Brackets / code
  (rng, col) => {
    const h = rng.float(9, 12);
    const w = rng.float(3, 5);
    let svg = path(`M${14 - w},${14 - h} L${14 - w - 3},${14 - h} L${14 - w - 3},${14 + h} L${14 - w},${14 + h}`, col);
    svg += path(`M${14 + w},${14 - h} L${14 + w + 3},${14 - h} L${14 + w + 3},${14 + h} L${14 + w},${14 + h}`, col);
    if (rng.bool(0.6)) {
      const lines = rng.int(2, 3);
      for (let i = 0; i < lines; i++) {
        const y = 14 - h + 4 + i * ((h * 2 - 8) / (lines - 1 || 1));
        const lw = rng.float(3, 6);
        svg += l(14 - lw, y, 14 + lw, y, col, 0.35);
      }
    }
    return svg;
  },
  // 6. Clipboard
  (rng, col) => {
    const w = rng.float(8, 10);
    const h = rng.float(10, 12);
    let svg = rect(14 - w, 14 - h + 2, w * 2, h * 2 - 2, col, 2);
    svg += rect(14 - 3, 14 - h - 0.5, 6, 4, col, 1.5, 0.15);
    if (rng.bool(0.5)) {
      for (let i = 0; i < 3; i++) {
        const y = 14 - h + 9 + i * 4;
        if (y < 14 + h - 2) svg += l(14 - w + 3, y, 14 + w - 3, y, col, 0.2);
      }
    }
    return svg;
  },
  // 7. Nested squares
  (rng, col) => {
    const s1 = rng.float(10, 12);
    const s2 = rng.float(5, 7);
    let svg = rect(14 - s1, 14 - s1, s1 * 2, s1 * 2, col, 2);
    svg += rect(14 - s2, 14 - s2, s2 * 2, s2 * 2, col, 1.5, 0.1);
    if (rng.bool(0.5)) svg += c(14, 14, 1.5, col, true);
    return svg;
  },
  // 8. Blocks / bricks
  (rng, col) => {
    const s = rng.float(4, 5);
    const gap = rng.float(1, 2);
    let svg = '';
    for (let row = 0; row < 2; row++) {
      for (let colI = 0; colI < 2; colI++) {
        const x = 14 - s - gap / 2 + colI * (s * 2 + gap);
        const y = 14 - s - gap / 2 + row * (s * 2 + gap);
        svg += rect(x - s + s, y - s + s, s * 2 - gap, s * 2 - gap, col, 1.5, rng.float(0, 0.1));
      }
    }
    return svg;
  },
];

// ── CONNECT templates (organic / flowing) ───────────────────
const connectTemplates: IconTemplate[] = [
  // 1. Wave / sine
  (rng, col) => {
    const amp = rng.float(4, 7);
    const freq = rng.float(1.5, 2.5);
    let d = `M2,14`;
    for (let x = 2; x <= 26; x += 0.8) {
      const y = 14 + Math.sin((x - 2) / 24 * Math.PI * 2 * freq) * amp;
      d += ` L${x.toFixed(1)},${y.toFixed(1)}`;
    }
    let svg = path(d, col);
    if (rng.bool(0.4)) svg += c(14, 14, 2, col, true);
    return svg;
  },
  // 2. Network nodes
  (rng, col) => {
    const nodes = rng.int(3, 5);
    const pts = [];
    let svg = '';
    for (let i = 0; i < nodes; i++) {
      const a = (i / nodes) * Math.PI * 2 + rng.float(-0.3, 0.3);
      const r = rng.float(6, 11);
      const x = +(14 + Math.cos(a) * r).toFixed(1);
      const y = +(14 + Math.sin(a) * r).toFixed(1);
      pts.push([x, y]);
    }
    // Connect with lines
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        if (rng.bool(0.6)) svg += l(pts[i][0], pts[i][1], pts[j][0], pts[j][1], col, 0.25);
      }
    }
    // Draw nodes
    for (const p of pts) svg += c(p[0], p[1], rng.float(2, 3.5), col, true);
    return svg;
  },
  // 3. Branch / tree
  (rng, col) => {
    let svg = l(14, 26, 14, 10, col, 0.7);
    const branches = rng.int(2, 4);
    for (let i = 0; i < branches; i++) {
      const y = 10 + i * rng.float(3, 5);
      if (y > 24) continue;
      const dir = rng.bool() ? 1 : -1;
      const len = rng.float(4, 8);
      const endX = 14 + dir * len;
      const endY = y - rng.float(1, 4);
      svg += l(14, y, endX, endY, col, 0.5);
      if (rng.bool(0.6)) svg += c(endX, endY, rng.float(1.5, 2.5), col, true);
    }
    svg += c(14, 8, rng.float(2, 3), col, true);
    return svg;
  },
  // 4. Flow / stream (curved lines)
  (rng, col) => {
    const streams = rng.int(2, 3);
    let svg = '';
    for (let i = 0; i < streams; i++) {
      const yOff = (i - (streams - 1) / 2) * rng.float(4, 6);
      const bend = rng.float(3, 8) * (rng.bool() ? 1 : -1);
      svg += path(`M3,${(14 + yOff).toFixed(1)} Q14,${(14 + yOff + bend).toFixed(1)} 25,${(14 + yOff).toFixed(1)}`, col);
    }
    if (rng.bool(0.5)) svg += c(3, 14, 1.5, col, true);
    if (rng.bool(0.5)) svg += c(25, 14, 1.5, col, true);
    return svg;
  },
  // 5. Chain links
  (rng, col) => {
    const r = rng.float(4, 5.5);
    const gap = rng.float(1, 2.5);
    let svg = '';
    svg += `<ellipse cx="${14 - gap - r * 0.3}" cy="14" rx="${r}" ry="${r * 0.65}" fill="none" stroke="${col}" stroke-width="1.8"/>`;
    svg += `<ellipse cx="${14 + gap + r * 0.3}" cy="14" rx="${r}" ry="${r * 0.65}" fill="none" stroke="${col}" stroke-width="1.8"/>`;
    if (rng.bool(0.5)) {
      svg += `<ellipse cx="14" cy="14" rx="${r * 0.6}" ry="${r * 0.4}" fill="none" stroke="${col}" stroke-width="1.2" stroke-opacity="0.4"/>`;
    }
    return svg;
  },
  // 6. Pulse / heartbeat
  (rng, col) => {
    const spike = rng.float(6, 10);
    const w = rng.float(2, 4);
    let svg = path(`M2,14 L${8 - w},14 L${9},${14 - spike} L${11},${14 + spike * 0.5} L${13},${14 - spike * 0.7} L${14 + w},14 L26,14`, col);
    if (rng.bool(0.5)) svg += c(rng.pick([5, 23]), 14, 1.5, col, true);
    return svg;
  },
  // 7. Blob / amoeba (organic closed shape)
  (rng, col) => {
    const pts = rng.int(5, 8);
    let d = '';
    const points = [];
    for (let i = 0; i < pts; i++) {
      const a = (i / pts) * Math.PI * 2;
      const r = rng.float(6, 12);
      points.push([
        +(14 + Math.cos(a) * r).toFixed(1),
        +(14 + Math.sin(a) * r).toFixed(1),
      ]);
    }
    d = `M${points[0][0]},${points[0][1]}`;
    for (let i = 1; i <= points.length; i++) {
      const curr = points[i % points.length];
      const prev = points[(i - 1) % points.length];
      const cpx = (prev[0] + curr[0]) / 2 + rng.float(-3, 3);
      const cpy = (prev[1] + curr[1]) / 2 + rng.float(-3, 3);
      d += ` Q${cpx},${cpy} ${curr[0]},${curr[1]}`;
    }
    return path(d, col, rng.float(0.05, 0.15));
  },
  // 8. Hub and spokes (central node radiating)
  (rng, col) => {
    const spokes = rng.int(4, 7);
    let svg = '';
    const offset = rng.float(0, Math.PI);
    for (let i = 0; i < spokes; i++) {
      const a = offset + (i / spokes) * Math.PI * 2;
      const r = rng.float(8, 12);
      const ex = +(14 + Math.cos(a) * r).toFixed(1);
      const ey = +(14 + Math.sin(a) * r).toFixed(1);
      svg += l(14, 14, ex, ey, col, 0.35);
      svg += c(ex, ey, rng.float(1.2, 2), col, true);
    }
    svg += c(14, 14, rng.float(2.5, 4), col, true);
    return svg;
  },
];

// ── ARCANE templates (mystical / sigils) ────────────────────
const arcaneTemplates: IconTemplate[] = [
  // 1. Pentagram / pentacle
  (rng, col) => {
    const r = rng.float(10, 13);
    const pts = rng.pick([5, 6]);
    const starPts = [];
    const offset = -Math.PI / 2;
    for (let i = 0; i < pts; i++) {
      const a = offset + (i / pts) * Math.PI * 2;
      starPts.push([+(14 + Math.cos(a) * r).toFixed(1), +(14 + Math.sin(a) * r).toFixed(1)]);
    }
    // Draw star lines (skip-connect)
    const skip = pts === 5 ? 2 : 2;
    let svg = '';
    for (let i = 0; i < pts; i++) {
      const j = (i + skip) % pts;
      svg += l(starPts[i][0], starPts[i][1], starPts[j][0], starPts[j][1], col, 0.6);
    }
    svg += c(14, 14, r, col);
    if (rng.bool(0.5)) svg += c(14, 14, 2, col, true);
    return svg;
  },
  // 2. Rune — angular sigil
  (rng, col) => {
    const h = rng.float(10, 13);
    let svg = l(14, 14 - h, 14, 14 + h, col, 0.8); // spine
    const branches = rng.int(2, 4);
    for (let i = 0; i < branches; i++) {
      const y = 14 - h + (i + 1) * (h * 2 / (branches + 1));
      const dir = rng.bool() ? 1 : -1;
      const endX = 14 + dir * rng.float(5, 10);
      const endY = y + rng.float(-4, 4);
      svg += l(14, y, endX, endY, col, 0.6);
    }
    if (rng.bool(0.5)) svg += l(14, 14 - h, 14 + rng.float(-3, 3), 14 - h - 3, col, 0.4);
    return svg;
  },
  // 3. Triple moon (wiccan-inspired)
  (rng, col) => {
    const r = rng.float(6, 8);
    let svg = c(14, 14, r, col); // center full circle
    // Left crescent
    const shift = rng.float(3, 5);
    svg += `<path d="M${14 - r - 3},${14 - r} A${r},${r} 0 0,1 ${14 - r - 3},${14 + r} A${r - shift},${r - shift} 0 0,0 ${14 - r - 3},${14 - r}" fill="${col}" fill-opacity="0.15" stroke="${col}" stroke-width="1.5"/>`;
    // Right crescent (mirrored)
    svg += `<path d="M${14 + r + 3},${14 - r} A${r},${r} 0 0,0 ${14 + r + 3},${14 + r} A${r - shift},${r - shift} 0 0,1 ${14 + r + 3},${14 - r}" fill="${col}" fill-opacity="0.15" stroke="${col}" stroke-width="1.5"/>`;
    return svg;
  },
  // 4. Eye of providence / all-seeing eye
  (rng, col) => {
    const w = rng.float(11, 13);
    const h = rng.float(5, 7);
    const eyeD = `M${14 - w},14 Q14,${14 - h * 2} ${14 + w},14 Q14,${14 + h * 2} ${14 - w},14`;
    let svg = path(eyeD, col, 0.08);
    svg += c(14, 14, rng.float(3, 4.5), col);
    svg += c(14, 14, rng.float(1.5, 2.5), col, true);
    // Rays above
    if (rng.bool(0.7)) {
      const rays = rng.int(3, 5);
      for (let i = 0; i < rays; i++) {
        const a = -Math.PI * 0.15 - (i / (rays - 1)) * Math.PI * 0.7;
        svg += l(14, 14, +(14 + Math.cos(a) * 13).toFixed(1), +(14 + Math.sin(a) * 13).toFixed(1), col, 0.2);
      }
    }
    return svg;
  },
  // 5. Alchemical circle (circle + inscribed geometry)
  (rng, col) => {
    const r = rng.float(10, 12);
    let svg = c(14, 14, r, col);
    // Inscribed shape
    const sides = rng.pick([3, 4, 6]);
    let pts = '';
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 - Math.PI / 2;
      pts += `${(14 + Math.cos(a) * r * 0.85).toFixed(1)},${(14 + Math.sin(a) * r * 0.85).toFixed(1)} `;
    }
    svg += poly(pts.trim(), col, 0.08);
    if (rng.bool(0.5)) svg += c(14, 14, r * 0.4, col);
    svg += c(14, 14, 1.5, col, true);
    return svg;
  },
  // 6. Cross / mark variations
  (rng, col) => {
    const style = rng.int(0, 2);
    const r = rng.float(9, 12);
    let svg = '';
    if (style === 0) {
      // X mark
      svg += l(14 - r, 14 - r, 14 + r, 14 + r, col, 0.7);
      svg += l(14 + r, 14 - r, 14 - r, 14 + r, col, 0.7);
      svg += c(14, 14, rng.float(2, 4), col);
    } else if (style === 1) {
      // Cross with circles at ends
      svg += l(14, 14 - r, 14, 14 + r, col, 0.7);
      svg += l(14 - r, 14, 14 + r, 14, col, 0.7);
      svg += c(14, 14 - r, 2, col, true);
      svg += c(14, 14 + r, 2, col, true);
      svg += c(14 - r, 14, 2, col, true);
      svg += c(14 + r, 14, 2, col, true);
    } else {
      // Ankh-like
      svg += c(14, 14 - r * 0.4, r * 0.4, col);
      svg += l(14, 14 - r * 0.4 + r * 0.4, 14, 14 + r, col, 0.7);
      svg += l(14 - r * 0.5, 14 + r * 0.2, 14 + r * 0.5, 14 + r * 0.2, col, 0.6);
    }
    return svg;
  },
  // 7. Vortex / portal (concentric arcs, not closed)
  (rng, col) => {
    const arcs = rng.int(3, 5);
    let svg = '';
    const dir = rng.bool() ? 1 : 0;
    for (let i = 0; i < arcs; i++) {
      const r = 3 + i * rng.float(2.5, 3.5);
      const startA = rng.float(0, Math.PI * 0.5) + i * 0.4;
      const endA = startA + rng.float(Math.PI * 0.8, Math.PI * 1.5);
      const x1 = 14 + Math.cos(startA) * r;
      const y1 = 14 + Math.sin(startA) * r;
      const x2 = 14 + Math.cos(endA) * r;
      const y2 = 14 + Math.sin(endA) * r;
      const large = (endA - startA) > Math.PI ? 1 : 0;
      svg += `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large},${dir} ${x2.toFixed(1)},${y2.toFixed(1)}" fill="none" stroke="${col}" stroke-width="1.5" stroke-opacity="${0.3 + i * 0.15}" stroke-linecap="round"/>`;
    }
    svg += c(14, 14, rng.float(1.5, 2.5), col, true);
    return svg;
  },
  // 8. Glyph / seal (layered shapes)
  (rng, col) => {
    const r1 = rng.float(10, 12);
    const r2 = rng.float(5, 7);
    let svg = c(14, 14, r1, col);
    // Inner rotating square
    const angle = rng.float(30, 60) * Math.PI / 180;
    let pts = '';
    for (let i = 0; i < 4; i++) {
      const a = angle + (i / 4) * Math.PI * 2;
      pts += `${(14 + Math.cos(a) * r2 * 1.3).toFixed(1)},${(14 + Math.sin(a) * r2 * 1.3).toFixed(1)} `;
    }
    svg += poly(pts.trim(), col, 0.1);
    svg += c(14, 14, r2 * 0.5, col);
    // Accent dots at cardinal points
    if (rng.bool(0.6)) {
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 - Math.PI / 2;
        svg += c(+(14 + Math.cos(a) * r1).toFixed(1), +(14 + Math.sin(a) * r1).toFixed(1), 1.5, col, true);
      }
    }
    return svg;
  },
];

// ── Template registry ───────────────────────────────────────
const TEMPLATES: Record<Exclude<IconCategory, 'mixed'>, IconTemplate[]> = {
  memory: memoryTemplates,
  search: searchTemplates,
  write: writeTemplates,
  connect: connectTemplates,
  arcane: arcaneTemplates,
};
