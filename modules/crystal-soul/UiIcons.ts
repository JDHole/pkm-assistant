/**
 * Crystal Soul — UI Icons
 *
 * Named SVG icons for DOM rendering, replacing emoji.
 * All icons return an SVG string at a given size.
 *
 * Categories of icons:
 *   - Navigation & actions (clipboard, chat, edit, search, etc.)
 *   - Status indicators (check, cross, warning, lock, etc.)
 *   - File types (file, folder, image, pdf, attachment)
 *   - Agent/system (robot, brain, crystal, crown, zap, etc.)
 *
 * Usage (E3.4: generatory zwracają markup, ale do DOM wchodzi TYLKO przez setSvg/
 * setSvgLabel z `domUtils.js` — etykieta zawsze jako text node):
 *   import { UiIcons, setSvg, setSvgLabel } from '<sciezka>/modules/crystal-soul/index.js';
 *   setSvgLabel(el, UiIcons.clipboard(16), 'Plan');
 *   setSvgLabel(el, UiIcons.check(14, '#4caf50'), 'Done');
 */

export type UiIcon = (size?: number, color?: string) => string;

const svg = (size: number, inner: string, vb = '0 0 24 24'): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="pkm-icon-base cs-ui-icon">${inner}</svg>`;

export const UiIcons: Record<string, UiIcon> = {
    // ── Navigation & Actions ──

    /** Clipboard / plan (replaces clipboard emoji) */
    clipboard: (s = 16) => svg(s,
        '<path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/>' +
        '<rect x="8" y="2" width="8" height="4" rx="1"/>'),

    /** Chat bubble (replaces chat/comment emoji) */
    chat: (s = 16) => svg(s,
        '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>'),

    /** Edit / pencil (replaces pencil emoji) */
    edit: (s = 16) => svg(s,
        '<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>' +
        '<path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>'),

    /** Send / mail arrow (replaces mail emoji) */
    send: (s = 16) => svg(s,
        '<line x1="22" y1="2" x2="11" y2="13"/>' +
        '<polygon points="22,2 15,22 11,13 2,9"/>'),

    /** Refresh / regenerate (replaces cycle arrows emoji) */
    refresh: (s = 16) => svg(s,
        '<polyline points="23 4 23 10 17 10"/>' +
        '<polyline points="1 20 1 14 7 14"/>' +
        '<path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>'),

    /** Save / disk (replaces floppy emoji) */
    save: (s = 16) => svg(s,
        '<path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>' +
        '<polyline points="17 21 17 13 7 13 7 21"/>' +
        '<polyline points="7 3 7 8 15 8"/>'),

    /** Hourglass / temporary (replaces hourglass emoji) */
    hourglass: (s = 16) => svg(s,
        '<path d="M6 2h12l-5 8 5 8H6l5-8-5-8z"/>'),

    /** Search (replaces magnifying glass) */
    search: (s = 16) => svg(s,
        '<circle cx="11" cy="11" r="8"/>' +
        '<line x1="21" y1="21" x2="16.65" y2="16.65"/>'),

    /** Paperclip / attach (replaces paperclip emoji) */
    paperclip: (s = 16) => svg(s,
        '<path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.49"/>'),

    /** Delete / trash (replaces wastebasket emoji) */
    trash: (s = 16) => svg(s,
        '<polyline points="3 6 5 6 21 6"/>' +
        '<path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>'),

    /** Web / globe (replaces globe emoji) */
    globe: (s = 16) => svg(s,
        '<circle cx="12" cy="12" r="10"/>' +
        '<line x1="2" y1="12" x2="22" y2="12"/>' +
        '<path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>'),

    // ── Status Indicators ──

    /** Check / approve (replaces check emoji) */
    check: (s = 16) => svg(s,
        '<polyline points="20 6 9 17 4 12"/>'),

    /** Cross / deny (replaces cross emoji) */
    cross: (s = 16) => svg(s,
        '<line x1="18" y1="6" x2="6" y2="18"/>' +
        '<line x1="6" y1="6" x2="18" y2="18"/>'),

    /** Warning triangle (replaces warning emoji) */
    warning: (s = 16) => svg(s,
        '<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>' +
        '<line x1="12" y1="9" x2="12" y2="13"/>' +
        '<line x1="12" y1="17" x2="12.01" y2="17"/>'),

    /** Lock / secure (replaces lock emoji) */
    lock: (s = 16) => svg(s,
        '<rect x="3" y="11" width="18" height="11" rx="2"/>' +
        '<path d="M7 11V7a5 5 0 0110 0v4"/>'),

    /** Rocket / full power (replaces rocket emoji) */
    rocket: (s = 16) => svg(s,
        '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z"/>' +
        '<path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z"/>' +
        '<path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/>' +
        '<path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>'),

    /** Balance / standard (replaces scales emoji) */
    scales: (s = 16) => svg(s,
        '<line x1="12" y1="3" x2="12" y2="21"/>' +
        '<path d="M4 8l8-5 8 5"/>' +
        '<path d="M4 8l-2 8h6L4 8z"/>' +
        '<path d="M20 8l-2 8h6l-4-8z"/>',
        '0 0 24 24'),

    /** No-entry / block (replaces no-entry emoji) */
    noEntry: (s = 16) => svg(s,
        '<circle cx="12" cy="12" r="10"/>' +
        '<line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>'),

    /** Eye / visible (replaces eye emoji) */
    eye: (s = 16) => svg(s,
        '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>' +
        '<circle cx="12" cy="12" r="3"/>'),

    /** Eye-off / hidden */
    eyeOff: (s = 16) => svg(s,
        '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/>' +
        '<path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/>' +
        '<line x1="1" y1="1" x2="23" y2="23"/>'),

    /** Sparkle / creative (replaces sparkle emoji) */
    sparkle: (s = 16) => svg(s,
        '<path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"/>'),

    /** Microphone (for audio recording / STT) */
    microphone: (s = 16) => svg(s,
        '<path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>' +
        '<path d="M19 10v2a7 7 0 01-14 0v-2"/>' +
        '<line x1="12" y1="19" x2="12" y2="23"/>' +
        '<line x1="8" y1="23" x2="16" y2="23"/>'),

    // ── Dots / Status dots ──

    /** Green dot (replaces green circle emoji) */
    dotGreen: (s = 10) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="${s}" height="${s}" class="pkm-icon-base cs-ui-icon"><circle cx="5" cy="5" r="4" fill="#4caf50"/></svg>`,

    /** Gray dot (replaces gray circle emoji) */
    dotGray: (s = 10) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="${s}" height="${s}" class="pkm-icon-base cs-ui-icon"><circle cx="5" cy="5" r="4" fill="#999" fill-opacity="0.4"/></svg>`,

    // ── File Types ──

    /** File / note (replaces page emoji) */
    file: (s = 16) => svg(s,
        '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>' +
        '<polyline points="14 2 14 8 20 8"/>'),

    /** Folder (replaces folder emoji) */
    folder: (s = 16) => svg(s,
        '<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>'),

    /** Image (replaces picture emoji) */
    image: (s = 16) => svg(s,
        '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
        '<circle cx="8.5" cy="8.5" r="1.5"/>' +
        '<polyline points="21 15 16 10 5 21"/>'),

    /** PDF / book (replaces red book emoji) */
    pdf: (s = 16) => svg(s,
        '<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/>' +
        '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>'),

    // ── Agent / System ──

    /** Key (replaces key emoji) */
    key: (s = 16) => svg(s,
        '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.78 7.78 5.5 5.5 0 017.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>'),

    /** Robot / AI (replaces robot emoji) */
    robot: (s = 16) => svg(s,
        '<rect x="3" y="8" width="18" height="12" rx="2"/>' +
        '<circle cx="9" cy="14" r="1.5" fill="currentColor" stroke="none"/>' +
        '<circle cx="15" cy="14" r="1.5" fill="currentColor" stroke="none"/>' +
        '<line x1="12" y1="4" x2="12" y2="8"/>' +
        '<circle cx="12" cy="3" r="1"/>'),

    /** Brain / memory (replaces brain emoji) */
    brain: (s = 16) => svg(s,
        '<path d="M12 2C9 2 7 4 7 6.5c0 1.2.5 2.3 1.3 3C7.5 10.3 7 11.4 7 12.5 7 15 9 17 12 17s5-2 5-4.5c0-1.1-.5-2.2-1.3-3 .8-.7 1.3-1.8 1.3-3C17 4 15 2 12 2z"/>' +
        '<line x1="12" y1="17" x2="12" y2="22"/>'),

    /** Lightning / skill (replaces lightning/zap emoji) */
    zap: (s = 16) => svg(s,
        '<polygon points="13,2 3,14 12,14 11,22 21,10 12,10" fill="currentColor" stroke="none"/>'),

    /** Crown / master (replaces crown emoji) */
    crown: (s = 16) => svg(s,
        '<path d="M2 18h20l-3-12-5 6-2-8-2 8-5-6z"/>' +
        '<path d="M2 18v2h20v-2"/>'),

    /** Users / team (replaces people emoji) */
    users: (s = 16) => svg(s,
        '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>' +
        '<circle cx="9" cy="7" r="4"/>' +
        '<path d="M23 21v-2a4 4 0 00-3-3.87"/>' +
        '<path d="M16 3.13a4 4 0 010 7.75"/>'),

    /** User / person (replaces person emoji) */
    user: (s = 16) => svg(s,
        '<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/>' +
        '<circle cx="12" cy="7" r="4"/>'),

    /** Wrench / tool (replaces wrench emoji) */
    wrench: (s = 16) => svg(s,
        '<path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>'),

    /** Diamond / crystal (replaces diamond emoji) */
    diamond: (s = 16) => svg(s,
        '<polygon points="12,2 22,12 12,22 2,12"/>'),

    /** Info circle (replaces info emoji) */
    info: (s = 16) => svg(s,
        '<circle cx="12" cy="12" r="10"/>' +
        '<line x1="12" y1="16" x2="12" y2="12"/>' +
        '<line x1="12" y1="8" x2="12.01" y2="8"/>'),

    /** Question mark (replaces question emoji) */
    question: (s = 16) => svg(s,
        '<circle cx="12" cy="12" r="10"/>' +
        '<path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/>' +
        '<line x1="12" y1="17" x2="12.01" y2="17"/>'),

    /** Compass / navigation target */
    target: (s = 16) => svg(s,
        '<circle cx="12" cy="12" r="10"/>' +
        '<circle cx="12" cy="12" r="6"/>' +
        '<circle cx="12" cy="12" r="2"/>'),

    // ── Additional Icons (Visual Overhaul) ──

    /** Shield / permissions */
    shield: (s = 16) => svg(s,
        '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),

    /** Compass / navigation (direction-style) */
    compass: (s = 16) => svg(s,
        '<circle cx="12" cy="12" r="10"/>' +
        '<polygon points="16.24,7.76 14.12,14.12 7.76,16.24 9.88,9.88" fill="currentColor" stroke="none"/>'),

    /** Layers / compression */
    layers: (s = 16) => svg(s,
        '<polygon points="12,2 22,8.5 12,15 2,8.5"/>' +
        '<polyline points="2 15.5 12 22 22 15.5"/>'),

    /** Settings / gear */
    settings: (s = 16) => svg(s,
        '<circle cx="12" cy="12" r="3"/>' +
        '<path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>'),

    /** Plus / add */
    plus: (s = 16) => svg(s,
        '<line x1="12" y1="5" x2="12" y2="19"/>' +
        '<line x1="5" y1="12" x2="19" y2="12"/>'),

    /** Copy / duplicate */
    copy: (s = 16) => svg(s,
        '<rect x="9" y="9" width="13" height="13" rx="2"/>' +
        '<path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>'),

    /** Tool / wrench-screwdriver */
    tool: (s = 16) => svg(s,
        '<path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>'),

    /** X / close */
    x: (s = 16) => svg(s,
        '<line x1="18" y1="6" x2="6" y2="18"/>' +
        '<line x1="6" y1="6" x2="18" y2="18"/>'),

    /** History / clock */
    history: (s = 16) => svg(s,
        '<circle cx="12" cy="12" r="10"/>' +
        '<polyline points="12 6 12 12 16 14"/>'),

    /** Chevron down */
    chevronDown: (s = 16) => svg(s,
        '<polyline points="6 9 12 15 18 9"/>'),

    /** External link / open in new */
    externalLink: (s = 16) => svg(s,
        '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
        '<polyline points="15 3 21 3 21 9"/>' +
        '<line x1="10" y1="14" x2="21" y2="3"/>'),
};
