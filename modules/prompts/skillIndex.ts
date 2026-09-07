/**
 * skillIndex.js — cienki indeks skilli do system promptu (D17, E2.4).
 *
 * Model NIE ma już narzędzi skill_list/skill_execute. Odkrywalność skilli = ten indeks
 * (nazwa + opis + ścieżka SKILL.md) wstrzykiwany do system promptu od startu; pełny przepis
 * model wciąga narzędziem `read(ścieżka)`. Skille manual-only (`disable-model-invocation`)
 * lądują na osobnej, krótkiej liście „tylko na wyraźne życzenie usera".
 *
 * BUDŻET: cała sekcja capowana (domyślnie ~8000 znaków — wzór Codex 2%/8k, bierzemy flat 8k).
 * Nadmiarowe skille wypadają, a zamykająca linia kieruje do list(".pkm-assistant/skills").
 *
 * Pure module (zależność tylko od i18n) → testowalny node'em (PromptBuilder przez łańcuch
 * importów wciąga `obsidian`, więc logika indeksu musi żyć osobno, żeby dało się ją pokryć).
 */
import { t } from '../../core/i18n/index.js';

export const SKILL_INDEX_MAX_CHARS = 8000;

export interface PromptSkill {
    name: string;
    description?: string;
    path?: string;
    icon?: string;
    disableModelInvocation?: boolean;
}

/**
 * Zbuduj tekst indeksu skilli.
 * @param {Array<{name:string, description?:string, path?:string, icon?:string, disableModelInvocation?:boolean}>} skills
 * @param {number} [maxChars=SKILL_INDEX_MAX_CHARS] - budżet znaków sekcji (nadmiar → linia „…i N kolejnych")
 * @returns {string} pusty string gdy brak skilli
 */
export function buildSkillIndex(skills: unknown = [], maxChars: number = SKILL_INDEX_MAX_CHARS): string {
    if (!Array.isArray(skills) || skills.length === 0) return '';

    const visible = (skills as PromptSkill[]).filter(s => !s.disableModelInvocation);
    const hidden = (skills as PromptSkill[]).filter(s => s.disableModelInvocation);

    const header = `${t('prompt.dt.your_skills')}:`;
    const lines = [header];
    let used = header.length + 1;
    let shown = 0;

    for (const s of visible) {
        const icon = s.icon || '⚡';
        const desc = s.description || t('prompt.dt.no_description');
        const recipe = s.path ? ` → ${t('prompt.dt.skill_recipe', { path: s.path })}` : '';
        const line = `  ${icon} ${s.name}: ${desc}${recipe}`;
        // Zostaw miejsce na linię „…i N kolejnych" — dlatego cap sprawdzamy PRZED dopisaniem
        // (i zawsze pokazujemy co najmniej jeden skill, żeby indeks nie był pusty).
        if (shown > 0 && used + line.length + 1 > maxChars) break;
        lines.push(line);
        used += line.length + 1;
        shown++;
    }

    const remaining = visible.length - shown;
    if (remaining > 0) {
        lines.push(`  ${t('prompt.dt.skill_index_more', { count: remaining })}`);
    }
    if (hidden.length > 0) {
        lines.push(`${t('prompt.dt.manual_skills')}: ${hidden.map(s => s.name).join(', ')}`);
    }

    return lines.join('\n');
}
