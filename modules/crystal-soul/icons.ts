import { addIcon } from 'obsidian';

export function registerPkmIcon() {
    addIcon("pkm-icon", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="currentColor" stroke="currentColor">
  <circle cx="50" cy="50" r="44" fill="none" stroke-width="5"/>
  <circle cx="50" cy="32" r="6"/>
  <circle cx="30" cy="52" r="6"/>
  <circle cx="70" cy="52" r="6"/>
  <circle cx="40" cy="72" r="6"/>
  <circle cx="60" cy="72" r="6"/>
  <line x1="50" y1="32" x2="30" y2="52" stroke-width="3"/>
  <line x1="50" y1="32" x2="70" y2="52" stroke-width="3"/>
  <line x1="30" y1="52" x2="40" y2="72" stroke-width="3"/>
  <line x1="70" y1="52" x2="60" y2="72" stroke-width="3"/>
  <line x1="30" y1="52" x2="70" y2="52" stroke-width="3"/>
  <line x1="40" y1="72" x2="60" y2="72" stroke-width="3"/>
</svg>
`);
}
