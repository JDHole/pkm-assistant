import { CrystalGenerator } from '../CrystalGenerator.js';
import { pickColor } from '../ColorPalette.js';
import type { AgentVisual, SkinRenderOptions, SkinSpec } from '../SkinManager.js';

export const crystalSoulSkin: SkinSpec = {
    id: 'crystal-soul',
    name: 'Crystal Soul',
    parent: null,
    colors: {
        agent_default: '#9b8afb',
        accent: 'var(--cs-accent, #9b8afb)',
        text: 'var(--text-normal)',
        text_muted: 'var(--text-muted)',
        background_chat: 'var(--background-primary)',
        background_panel: 'var(--background-secondary)',
        border: 'var(--background-modifier-border)',
        success: 'var(--text-success, #4caf50)',
        warning: 'var(--text-warning, #ffc107)',
        error: 'var(--text-error, #ef5350)',
    },
    animations: {
        enabled: true,
        transition: 'var(--anim-duration-fast)',
        glow: true,
    },
    css: {
        custom: `
.pkm-skin-root[data-pkm-skin="crystal-soul"] {
  --pkm-skin-agent-default: var(--cs-accent, #9b8afb);
  --pkm-skin-transition: var(--anim-duration-fast);
}
`,
    },
    crystals: {
        shape: 'procedural-crystal',
    },
    getCrystal(agent: AgentVisual, options: SkinRenderOptions = {}) {
        const name = typeof agent === 'string' ? agent : (agent?.name || 'Agent');
        const color = options.color || this.getAgentColor!(agent);
        const glow = options.glow ?? this.animations.glow;
        return CrystalGenerator.generate(name, { ...options, color, glow });
    },
    getShapeName(agent: AgentVisual) {
        const name = typeof agent === 'string' ? agent : (agent?.name || 'Agent');
        return CrystalGenerator.getShapeName(name);
    },
    getAgentColor(agent: AgentVisual) {
        if ((agent as Exclude<AgentVisual, string>)?.color || (agent as Exclude<AgentVisual, string>)?.crystalColor) return (agent as Exclude<AgentVisual, string>).color || (agent as Exclude<AgentVisual, string>).crystalColor!;
        const name = typeof agent === 'string' ? agent : (agent?.name || 'default');
        return pickColor(name).hex;
    },
};
