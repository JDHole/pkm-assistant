import { seededStringHash } from '../utils/stableHash.js';
import type { AgentVisual, SkinRenderOptions, SkinSpec } from '../SkinManager.js';

function escapeSvgText(value: string): string {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function getInitials(name: string): string {
    const parts = String(name || 'Agent')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (!parts.length) return 'AI';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function hashToHex(name: string): string {
    const hash = seededStringHash(name || 'Agent');
    const hue = hash % 360;
    // Fixed HSL -> RGB approximation keeps CSS rgba consumers on hex.
    const chroma = 0.52;
    const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = 0.44 - chroma / 2;
    let r = 0, g = 0, b = 0;
    if (hue < 60) [r, g, b] = [chroma, x, 0];
    else if (hue < 120) [r, g, b] = [x, chroma, 0];
    else if (hue < 180) [r, g, b] = [0, chroma, x];
    else if (hue < 240) [r, g, b] = [0, x, chroma];
    else if (hue < 300) [r, g, b] = [x, 0, chroma];
    else [r, g, b] = [chroma, 0, x];
    const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function generateMonogramAvatar(name: string, color = 'var(--interactive-accent)', options: SkinRenderOptions = {}): string {
    const size = options.size || 32;
    const initials = escapeSvgText(getInitials(name));
    const bg = color || hashToHex(name || initials);
    const textColor = options.textColor || 'var(--text-on-accent, #fff)';

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" class="pkm-skin-avatar pkm-skin-avatar--default" role="img" aria-label="${escapeSvgText(name || 'Agent')}">
        <circle cx="16" cy="16" r="15" fill="${bg}" opacity="0.92"/>
        <text x="16" y="20.5" text-anchor="middle" font-family="var(--font-interface)" font-size="11" font-weight="700" fill="${textColor}">${initials}</text>
    </svg>`;
}

export const defaultSkin: SkinSpec = {
    id: 'default',
    name: 'Default',
    parent: null,
    colors: {
        agent_default: 'var(--interactive-accent)',
        accent: 'var(--interactive-accent)',
        text: 'var(--text-normal)',
        text_muted: 'var(--text-muted)',
        background_chat: 'var(--background-primary)',
        background_panel: 'var(--background-secondary)',
        border: 'var(--background-modifier-border)',
        success: 'var(--text-success)',
        warning: 'var(--text-warning)',
        error: 'var(--text-error)',
    },
    animations: {
        enabled: false,
        transition: 'var(--anim-duration-fast)',
        glow: false,
    },
    css: {
        custom: `
.pkm-skin-root[data-pkm-skin="default"] {
  --pkm-skin-agent-default: var(--interactive-accent);
  --pkm-skin-transition: var(--anim-duration-fast);
}
.pkm-skin-root[data-pkm-skin="default"] [class*="cs-"] {
  animation: none !important;
}
`,
    },
    crystals: {
        shape: 'monogram',
    },
    getCrystal(agent: AgentVisual, options: SkinRenderOptions = {}) {
        const name = typeof agent === 'string' ? agent : (agent?.name || 'Agent');
        return generateMonogramAvatar(name, options.color || this.colors.agent_default, options);
    },
    getAgentColor(agent: AgentVisual) {
        if (agent && typeof agent === 'object' && agent.color) return agent.color;
        if (this.id !== 'default' && this.colors?.agent_default) return this.colors.agent_default;
        const name = typeof agent === 'string' ? agent : (agent?.name || 'Agent');
        return hashToHex(name);
    },
};
