/**
 * PromptBuilder v2.1 — modularny system budowania system promptu agenta.
 *
 * Struktura dzisiejsza (patrz też modules/prompts/CLAUDE.md, sekcja „Skład promptu"):
 * A: KIM JESTEM (identity, personality — archetype/role skasowane w E2.8 A1/A3)
 * B: GDZIE PRACUJĘ (environment, folders, permissions + agent_rules)
 * C: JAK PRACUJĘ (decision_tree, delegate_guide, rules — ★TRYB PRACY skasowany w E2.3 D21)
 * D: KONTEKST (artifacts, current_date, memory, oczko — dane, nie reguły; projects
 *    skasowany w E2.9 D1 razem z Project Hub)
 *
 * Filozofia:
 * - Opis → Instrukcja (nie mów czym jest, mów co robić)
 * - 1 info = 1 miejsce (zero duplikacji)
 * - JSON tools mówią same za siebie (nie powtarzamy opisów narzędzi)
 * - Wszystko edytowalne: agent override > global override > factory default
 */

import { getTokenCount, expandFocusEntries, fenceUntrusted, getAgentSafeName } from '../../core/index.js';
import { t, getDateLocale } from '../../core/i18n/index.js';
import { buildSkillIndex } from './skillIndex.js';
import { buildArtifactIndex, buildActiveArtifactBlock } from './artifactIndex.js';
import { resolveDecisionTreeInstructions, splitDecisionTreeRules } from './decisionTree.js';
import { log } from '../../core/utils/Logger.js';
import type { PromptSkill } from './skillIndex.js';
import type { DecisionTreeOverrides } from './decisionTree.js';

// TS-any: persisted per-agent overrides are an open-ended user-defined schema.
interface PromptAgent { name: string; personality?: string; focusFolders?: unknown[]; language?: string; permissions?: Record<string, unknown>; agentRules?: string; promptOverrides?: Record<string, any>; }
interface PromptSection { key: string; label: string; content: string; tokens: number; _tokens: number | null; enabled: boolean; required: boolean; category: string; }
// TS-any: delegate descriptors are supplied by the concurrently converted agent kernel.
interface PromptContext {
    vaultName?: string; currentDate?: string; hasResearcher?: boolean; hasStrategist?: boolean; hasDelegates?: boolean;
    // TS-any: prompt defaults are persisted open-ended section overrides.
    promptDefaults?: Record<string, any>; availableToolNames?: string[]; skills?: PromptSkill[]; extendedPromptRules?: boolean;
    vaultGroups?: unknown[]; vaultMapDescriptions?: Record<string, string>; artifactTypes?: unknown[]; artifactList?: unknown[]; activeArtifact?: unknown;
    // TS-any: delegate descriptors cross the dynamic agent/sub-agent composition boundary.
    delegateAssignments?: any[]; delegateList?: any[]; researcherList?: any[]; strategistList?: any[]; agentList?: Array<string | { name: string; description?: string }>;
    inboxPing?: { count: number; senders?: string[] };
}

// ═══════════════════════════════════════════
// FACTORY DEFAULTS — edytowalne przez usera
// ═══════════════════════════════════════════

/** Factory defaults — getter-wrapped for i18n. Resolved at access time via t(). */
export const FACTORY_DEFAULTS = {
    get environment() {
        return `${t('prompt.env_header')}
${t('prompt.env.obsidian')}
${t('prompt.env.vault')}
${t('prompt.env.pkm')}
${t('prompt.env.obsidian_folder')}`;
    },

    // D6e (2026-07-30): forma rolowa aspect:"prep"/"strateg" OUT — `_resolveDelegate` rozwiązuje
    // `aspect` wyłącznie po NAZWIE suba (fallback po roli skasowany w E2.4/D18), więc stara forma
    // z definicji zwracała `aspect_not_found`. Kanon: delegate(task) = domyślny worker (działa
    // zawsze), aspect = konkretny sub z Ekipy po nazwie (lista subów jest w danych dynamicznych).
    get delegate_guide() {
        return `${t('prompt.subagents_header')}
${t('prompt.delegate.dispatcher_intro')}
- ${t('prompt.delegate.generic_desc')}
  delegate(task:"...")
- ${t('prompt.delegate.named_desc')}
  delegate(task:"...", aspect:"<nazwa sub-agenta>", context:"...")
- Multi-task: delegate(tasks:[{task:"A"}, {task:"B"}])
${t('prompt.delegate.never_search')}`;
    },

    get rules() {
        return `${t('prompt.rules_header')}
${t('prompt.rule.language')}
${t('prompt.rule.tool_first')}
${t('prompt.rule.remember')}

${t('prompt.antiloop')}
4. ${t('prompt.rule.one_search')}
5. ${t('prompt.rule.error_retry')}
6. ${t('prompt.rule.no_duplicate')}
7. ${t('prompt.rule.ask_user')}
8. ${t('prompt.rule.max_tools')}

${t('prompt.inline_comment')}
9. ${t('prompt.rule.inline_action')}`;
    },
};

// ═══════════════════════════════════════════
// DRZEWO DECYZYJNE — chudy rdzeń (D14). Dane + pure logika w decisionTree.js (testowalne node'em).
// Re-eksport dla barrela/profile_prompt (kompatybilność importów). Fabryka dead-code D7
// (AUD-dead-code-243): `CORE_RULES`/`EXTENDED_RULES` zdjęte z tej linii — jedyny ich konsument
// (`decisionTree.test.ts`) importuje je wprost z `./decisionTree.js`, ten hop nie miał czytelnika.
// ═══════════════════════════════════════════
export { DECISION_TREE_GROUPS, DECISION_TREE_DEFAULTS } from './decisionTree.js';

// ═══════════════════════════════════════════
// PROMPT BUILDER v2.1
// ═══════════════════════════════════════════

export class PromptBuilder {
    declare sections: Map<string, PromptSection>;
    constructor() {
        /** @type {Map<string, SectionData>} */
        this.sections = new Map();
    }

    /**
     * Build the full system prompt for an agent.
     * @param {import('../agents/Agent.js').Agent} agent
     * @param {Object} context
     * @param {string} context.vaultName
     * @param {string} context.currentDate
     * @param {string} [context.memoryContext]
     * @param {boolean} [context.hasResearcher]
     * @param {boolean} [context.hasStrategist]
     * @param {Array<{name:string, description:string, category:string}>} [context.skills]
     * @param {string[]} [context.agentList] - other agent names
     * @param {{count:number, senders:string[]}} [context.inboxPing] - S28 D4: ping skrzynki (bez treści)
     * @param {Object} [context.promptDefaults] - global prompt overrides from settings
     * @returns {PromptBuilder} this (for chaining)
     */
    build(agent: PromptAgent, context: PromptContext): PromptBuilder {
        this.sections.clear();

        // E2.8 C1: `permissions.mcp` skasowane — każdy agent ma narzędzia (min. core+vault+memory
        // wg disabled_tools). Drzewo decyzyjne renderuje się zawsze; instrukcje per-tool i tak gatuje
        // `ctx.availableToolNames` (agent, który wyłączył narzędzie, nie dostaje jego instrukcji).
        const hasResearcher = !!(context.hasResearcher);
        const hasStrategist = !!(context.hasStrategist);
        const overrides = agent.promptOverrides || {};
        const globalDefaults = context.promptDefaults || {};

        // ══ BLOK A: KIM JESTEM ══

        this._add('identity', t('prompt.label.identity'), this._buildIdentity(agent, context), {
            category: 'core'
        });

        // E2.8 A1/A3: archetyp i rola skasowane jako byty — nie wstrzykują żadnej sekcji do promptu.

        const personality = agent.personality;
        if (personality) {
            this._add('personality', t('prompt.label.personality'), personality, {
                category: 'core'
            });
        }

        // SECURITY: Defensive instruction against prompt injection from vault content
        this._add('content_security', t('prompt.label.content_security'),
            t('prompt.content_security'),
            { category: 'core' }
        );

        // ══ BLOK B: GDZIE PRACUJĘ ══

        this._add('environment', t('prompt.label.environment'),
            this._resolveSection('environment', overrides, globalDefaults, this._buildEnvironment(agent, context)),
            { category: 'core' }
        );

        this._add('permissions', t('prompt.label.permissions'),
            this._buildPermissions(agent, context), {
                category: 'rules'
            });

        // ══ BLOK C: JAK PRACUJĘ ══
        // E2.3 (D21): sekcja ★TRYB PRACY usunięta — tryby Gadaj/Rób już nie istnieją.

        // D14: chudy rdzeń reguł + indeks skilli + dane dynamiczne (gatowane dostępnością narzędzi).
        // E2.8 C1: zawsze renderowane (dawny guard hasMCP zniknął wraz z permissions.mcp).
        this._add('decision_tree', t('prompt.label.decision_tree'),
            this._buildDecisionTree(agent, context),
            { category: 'behavior' }
        );

        // Tryby v2: unified delegate_guide (replaces minion_guide + master_guide)
        const hasDelegates = !!(context.hasDelegates || hasResearcher || hasStrategist);
        if (hasDelegates) {
            this._add('delegate_guide', t('prompt.label.delegates'),
                this._resolveSection('delegate_guide', overrides, globalDefaults,
                    this._buildDelegateGuide(agent, context)),
                { category: 'behavior' }
            );
        }

        // Delegate behavior_inject sections (sesja 46c)
        const delegates = context.delegateAssignments || [];
        for (const d of delegates) {
            if (d.overrides?.behavior_inject) {
                this._add(
                    `delegate_behavior_${d.name}`,
                    t('prompt.label.behavior', { name: d.name }),
                    d.overrides.behavior_inject,
                    { category: 'behavior' }
                );
            }
        }

        this._add('rules', t('prompt.label.rules'),
            this._resolveSection('rules', overrides, globalDefaults,
                this._buildRules(agent, context)),
            { category: 'rules' }
        );

        // ══ BLOK D: KONTEKST ══
        // K9 (AUD-security-060): indeks artefaktów niesie surowy tekst z frontmattera notatek
        // vaulta — sekcja danych w ogrodzeniu, NIE reguła w „JAK PRACUJĘ".
        this._addArtifactContext(context);

        this._add('current_date', t('prompt.label.current_date'),
            this._buildCurrentDate(context),
            { category: 'context' }
        );

        return this;
    }

    // ═══════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════

    /**
     * Add a dynamic section (memory, RAG, oczko, inbox — injected per message by chat_view)
     */
    addDynamicSection(key: string, label: string, content: string, category: string = 'context'): void {
        if (!content || !content.trim()) return;
        let sectionContent = content;
        if (key === 'memory' && !sectionContent.includes('Notatki w brain/')) {
            sectionContent += '\n\n**Notatki w brain/ (możesz wczytać przez read(scope:"memory")):**\n- brak notatek';
        }
        // SECURITY (K9 / AUD-security-030): ogrodzenie ESCAPUJE treść, więc nie da się go
        // zamknąć od środka. Jedno źródło prawdy: `core/security/promptFence.js`.
        const wrapped = fenceUntrusted(sectionContent, key);
        if (!wrapped) return;
        this._add(key, label, wrapped, { category, required: false });
    }

    /**
     * Get full assembled prompt text (enabled sections only)
     */
    getPrompt() {
        return [...this.sections.values()]
            .filter(s => s.enabled)
            .map(s => s.content)
            .join('\n\n');
    }

    /**
     * Get section metadata for Prompt Inspector UI
     * @returns {Array<{key, label, tokens, enabled, required, category}>}
     */
    getSections() {
        const EDITABLE_KEYS = new Set([
            'environment', 'decision_tree', 'delegate_guide', 'rules'
        ]);
        return [...this.sections.entries()].map(([key, data]) => ({
            key,
            label: data.label,
            tokens: data.tokens,
            enabled: data.enabled,
            required: data.required,
            category: data.category,
            content: data.content,
            editable: EDITABLE_KEYS.has(key),
        }));
    }

    /**
     * Get token breakdown
     * @returns {{total: number, sections: Array<{key, label, tokens}>}}
     */
    getTokenBreakdown() {
        const sections = this.getSections().filter(s => s.enabled);
        return {
            total: sections.reduce((sum, s) => sum + s.tokens, 0),
            sections: sections.map(s => ({ key: s.key, label: s.label, tokens: s.tokens })),
        };
    }

    /**
     * Toggle a section on/off. Cannot toggle required sections off.
     */
    toggleSection(key: string, enabled: boolean): boolean {
        const section = this.sections.get(key);
        if (!section) return false;
        if (section.required && !enabled) return false;
        section.enabled = enabled;
        return true;
    }

    /**
     * Apply disabled sections from user settings.
     * @param {string[]} disabledKeys - Section keys to disable
     */
    applyDisabledSections(disabledKeys: string[] = []): void {
        for (const key of disabledKeys) {
            this.toggleSection(key, false);
        }
    }

    // ═══════════════════════════════════════════
    // INTERNAL: Section builders
    // ═══════════════════════════════════════════

    _add(key: string, label: string, content: string, opts: { required?: boolean; category?: string } = {}): void {
        if (!content || !content.trim()) return;
        const trimmed = content.trim();
        this.sections.set(key, {
            key,
            label,
            content: trimmed,
            _tokens: null, // lazy-computed on first access via getSections/getTokenBreakdown
            get tokens() { if (this._tokens === null) this._tokens = getTokenCount(trimmed); return this._tokens; },
            enabled: true,
            required: opts.required || false,
            category: opts.category || 'core',
        });
    }

    /**
     * Resolve section content: agent override > global override > factory default.
     * @param {string} key - Section key (e.g. 'decision_tree')
     * @param {Object} agentOverrides - agent.promptOverrides
     * @param {Object} globalDefaults - pkmAssistant.promptDefaults from settings
     * @param {string} factoryContent - built-in default from code
     * @returns {string}
     */
    // TS-any: persisted section overrides are an open-ended user-defined schema.
    _resolveSection(key: string, agentOverrides: Record<string, any>, globalDefaults: Record<string, any>, factoryContent: string): string {
        if (agentOverrides[key]) return agentOverrides[key];
        if (globalDefaults[key]) return globalDefaults[key];
        return factoryContent;
    }

    // E2.8 C1: _getEnabledGroups usunięty — narzędzia gatuje disabled_tools (ToolRegistry),
    // a prompt filtruje per-tool przez ctx.availableToolNames. Grupy TOOL_GROUPS już nie sterują.

    // ─── A1: identity ───

    _buildIdentity(agent: PromptAgent, ctx: PromptContext): string {
        return t('prompt.identity', {
            name: agent.name,
            vault: ctx.vaultName || 'Obsidian Vault'
        });
    }

    _buildCurrentDate(ctx: PromptContext): string {
        const date = ctx.currentDate || new Date().toLocaleDateString(getDateLocale());
        return t('prompt.current_date', { date });
    }

    // E2.8 A3: _buildRoleBehavior usunięty — rola rozpuszczona (D7).

    // ─── B1: environment (skrócone — bez README ekosystemu) ───

    _buildEnvironment(agent: PromptAgent, ctx: PromptContext): string {
        const lines: string[] = [];
        // Use factory default text (will be resolved by _resolveSection for overrides)
        lines.push(FACTORY_DEFAULTS.environment);

        // Focus folders — WHITELIST or Guidance mode (always auto-generated).
        // E2.8 B1: expand `{group}` references (Settings→Vault) to concrete folders at build time.
        const focusEntries = expandFocusEntries(agent.focusFolders as never, ctx.vaultGroups as never || []);
        if (focusEntries.length > 0) {
            const isGuidance = agent.permissions?.guidance_mode === true;
            lines.push('');

            if (isGuidance) {
                lines.push(t('prompt.env.priority_header'));
                lines.push(t('prompt.env.priority_desc'));
            } else {
                lines.push(t('prompt.env.whitelist_header'));
                lines.push(t('prompt.env.whitelist_desc'));
            }

            lines.push('');
            for (const folder of focusEntries) {
                const path = folder.path;
                const access = folder.access || 'readwrite';
                const icon = access === 'read' ? '👁️' : '📝';
                const label = access === 'read' ? t('prompt.env.access_read') : t('prompt.env.access_readwrite');
                const desc = ctx.vaultMapDescriptions?.[path];
                const descPart = desc ? ` — ${desc}` : '';
                lines.push(`- ${icon} **${path}** [${label}]${descPart}`);
            }
        } else {
            lines.push('');
            lines.push(t('prompt.env.full_access'));
        }

        return lines.join('\n');
    }

    // ─── B3: permissions + agent_rules ───

    _buildPermissions(agent: PromptAgent, _ctx: PromptContext): string {
        // E2.8 C1: sekcja NIE wylicza już pól-widm (read_notes/edit_notes/create_files/
        // delete_files/mcp/web_search skasowane). O „co wolno" mówią same definicje narzędzi
        // (model widzi TYLKO włączone — disabled_tools/filterByAgent), a o granicach przestrzeni —
        // sekcja środowiska (przypisane foldery). Zostaje ogólna reguła odmowy + reguły domenowe.
        const lines = [`## ${t('prompt.perm.header')}`];
        lines.push(t('prompt.perm.refusal'));

        // Agent-specific domain rules (B3)
        if (agent.agentRules) {
            lines.push('');
            lines.push(`### ${t('prompt.perm.agent_rules')}`);
            lines.push(agent.agentRules);
        }

        return lines.join('\n');
    }

    // ─── C1: decision_tree — CHUDY RDZEŃ (D14) ───

    /**
     * Zbuduj sekcję „JAK PRACUJĘ": chudy rdzeń reguł cross-tool (CORE_RULES) + indeks skilli +
     * dane dynamiczne (sub-agenty, artefakty w toku, agenci, skrzynka). Instrukcja per-tool
     * renderuje się TYLKO gdy narzędzie realnie dostępne (`ctx.availableToolNames`; undefined =
     * brak filtrowania, np. preview/test). Furtka `extendedPromptRules` dokłada ROZSZERZONE REGUŁY.
     * Override per-agent (`decisionTreeInstructions[id]`: false=wyłącz, string=podmień tekst) działa.
     */
    _buildDecisionTree(agent: PromptAgent, ctx: PromptContext): string {
        const lines = [t('prompt.dt.header'), ''];

        const agentDT = agent.promptOverrides?.decisionTreeInstructions as DecisionTreeOverrides || {};
        const globalDT = ctx.promptDefaults?.decisionTreeOverrides as DecisionTreeOverrides || {};

        // Warn about legacy string overrides
        if (typeof agent.promptOverrides?.decision_tree === 'string' && agent.promptOverrides.decision_tree) {
            log.warn('PromptBuilder', 'Agent ma stary format decision_tree (string) — ignorowany. Użyj decisionTreeInstructions.');
        }
        if (typeof ctx.promptDefaults?.decision_tree === 'string' && ctx.promptDefaults.decision_tree) {
            log.warn('PromptBuilder', 'Globalny decision_tree (string) — ignorowany. Użyj decisionTreeOverrides.');
        }

        const resolved = resolveDecisionTreeInstructions(agentDT, globalDT);

        // Dostępność narzędzi: undefined w ctx → nie filtruj (pełny podgląd/testy); tablica → filtruj.
        const available = Array.isArray(ctx.availableToolNames) ? new Set(ctx.availableToolNames) : null;
        const hasSkills = (ctx.skills?.length || 0) > 0;
        const toolOn = (name: string) => !available || available.has(name);

        // Podział na rdzeń + rozszerzone (furtka), z gatowaniem po dostępności — pure (decisionTree.js).
        const { core, extended } = splitDecisionTreeRules(resolved, {
            available, hasSkills, extended: ctx.extendedPromptRules === true,
        });

        // Rdzeń (always-on).
        for (const instr of core) {
            lines.push(`- ${instr.text}`);
        }

        // Furtka: ROZSZERZONE REGUŁY (dla słabszych modeli) — osobna sekcja.
        if (extended.length > 0) {
            lines.push('', `${t('prompt.dt.extended_header')}:`, ...extended.map(i => `- ${i.text}`));
        }

        lines.push('');

        // Dane dynamiczne (NIE reguły) — gatowane realną dostępnością narzędzia.
        if (toolOn('delegate')) this._injectGroupDynamics('delegacja', lines, ctx, agent);
        // E2.9 FAZA B: świat artefaktów żywych zastąpił stare todo/plany w prompcie.
        // K9 (AUD-security-060): indeks artefaktów NIE wchodzi już tutaj — niesie surowy
        // frontmatter notatek vaulta (`status`/`typ`/`id`), a to DANE, nie reguły. Renderuje
        // się jako osobna sekcja bloku D w ogrodzeniu (patrz `_addArtifactContext`).

        // Indeks skilli (D17) — nazwa + opis + ścieżka read(), manual-only osobno, budżet 8000 zn.
        const skillIndex = this._buildSkillIndex(ctx);
        if (skillIndex) lines.push(skillIndex, '');

        // Agenci + skrzynka: gdy agent umie komunikować → pełny blok; inaczej sama skrzynka.
        if (toolOn('kom_send') || toolOn('agent_delegate')) {
            this._injectGroupDynamics('komunikacja', lines, ctx, agent);
        } else {
            this._injectInboxNotification(lines, ctx, agent);
        }

        // Sprzątanie: bez 3+ pustych linii pod rząd, bez trailing whitespace.
        return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
    }

    /**
     * Sekcja „Artefakty" (blok D) — indeks podpiętych TYPÓW + lista artefaktów agenta w toku
     * (pure `artifactIndex.js`, budżet 2000 zn) + AKTYWNY artefakt jako chudy JSON (4000 zn).
     *
     * K9 (AUD-security-060): treść pochodzi z frontmattera zwykłych notatek vaulta (`status`,
     * `typ`, `id`, `tytul`), czyli od kogokolwiek, kto potrafi zapisać plik. Dlatego idzie przez
     * `addDynamicSection` → `fenceUntrusted`, a nie do sekcji reguł. Gate bez zmian: narzędzie
     * `artifact_create` musi być dostępne (`availableToolNames === undefined` = brak filtrowania).
     */
    _addArtifactContext(ctx: PromptContext): void {
        const available = Array.isArray(ctx.availableToolNames) ? new Set(ctx.availableToolNames) : null;
        if (available && !available.has('artifact_create')) return;

        const parts: string[] = [];
        const index = buildArtifactIndex(ctx.artifactTypes || [], ctx.artifactList || []);
        if (index) parts.push(index);
        const activeBlock = buildActiveArtifactBlock(ctx.activeArtifact);
        if (activeBlock) parts.push(activeBlock);
        if (parts.length === 0) return;

        this.addDynamicSection('artifacts', t('prompt.label.artifacts'), parts.join('\n\n'));
    }

    /**
     * Cienki indeks skilli (D17) — deleguje do pure helpera `buildSkillIndex` (testowalny node'em).
     * @param {Object} ctx
     * @returns {string} pusty string gdy agent nie ma skilli
     */
    _buildSkillIndex(ctx: PromptContext): string {
        return buildSkillIndex(ctx.skills || []);
    }

    /**
     * Inject dynamic content per group (artifacts, skills, agents).
     */
    _injectGroupDynamics(groupId: string, lines: string[], ctx: PromptContext, agent: PromptAgent): void {
        // K9 (AUD-security-060): gałąź 'artefakty' wyjechała stąd do `_addArtifactContext` —
        // indeks artefaktów jest DANYMI z vaulta i musi stać w ogrodzeniu, nie w sekcji reguł.

        // D17: indeks skilli renderuje _buildSkillIndex (poza grupami drzewa) — patrz _buildDecisionTree.

        if (groupId === 'delegacja') {
            // Tryby v2: unified delegate list from context
            if ((ctx.delegateList?.length as number) > 0) {
                const delegates = ctx.delegateAssignments || [];
                const desc = (ctx.delegateList as NonNullable<PromptContext['delegateList']>).map(d => {
                    const da = delegates.find(da2 => da2.name === d.name);
                    const groups = da?.overrides?.dt_covered_groups;
                    const tag = groups?.length > 0 ? ` [→ ${groups.join(', ')}]` : '';
                    const typeTag = d.type === 'strategist' ? ` [${t('prompt.dt.expert')}]` : '';
                    return `${d.name}${typeTag} (${d.description || ''})${tag}`;
                }).join(', ');
                lines.push(`- ${t('prompt.dt.your_subagents')}: ${desc}`);
            } else {
                // researcherList + strategistList fallback (brak delegateAssignments)
                if ((ctx.researcherList?.length as number) > 0) {
                    const researchers = ctx.researcherList as NonNullable<PromptContext['researcherList']>;
                    const delegates = ctx.delegateAssignments || [];
                    const desc = researchers.map(m => {
                        const da = delegates.find(d => d.name === m.name && d.delegateType === 'researcher');
                        const groups = da?.overrides?.dt_covered_groups;
                        const tag = groups?.length > 0 ? ` [→ ${groups.join(', ')}]` : '';
                        return `${m.name} (${m.description})${tag}`;
                    }).join(', ');
                    lines.push(`- ${t('prompt.dt.your_subagents')}: ${desc}`);
                }
                if ((ctx.strategistList?.length as number) > 0) {
                    const strategists = ctx.strategistList as NonNullable<PromptContext['strategistList']>;
                    const delegates = ctx.delegateAssignments || [];
                    const desc = strategists.map(m => {
                        const da = delegates.find(d => d.name === m.name && d.delegateType === 'strategist');
                        const groups = da?.overrides?.dt_covered_groups;
                        const tag = groups?.length > 0 ? ` [→ ${groups.join(', ')}]` : '';
                        return `${m.name} [${t('prompt.dt.expert')}] (${m.description})${tag}`;
                    }).join(', ');
                    lines.push(`- ${t('prompt.dt.expert_subagents')}: ${desc}`);
                }
            }
        }

        if (groupId === 'komunikacja') {
            if (ctx.agentList) {
                // Support both old format (string[]) and new format ({name, description}[])
                const others = ctx.agentList
                    .filter(a => (typeof a === 'string' ? a : a.name) !== agent.name);
                if (others.length > 0) {
                    const desc = others.map(a => {
                        if (typeof a === 'string') return a;
                        return a.description ? `${a.name} (${a.description})` : a.name;
                    }).join(', ');
                    lines.push(`- ${t('prompt.dt.agents')}: ${desc}`);
                }
            }
            this._injectInboxNotification(lines, ctx, agent);
        }
    }

    /**
     * Ping skrzynki — JEDNA linijka na dole drzewa decyzyjnego (S28 D4).
     *
     * Mówi TYLKO ile i od kogo. Zero treści, zero ścieżek do plików, zero instrukcji
     * „przeczytaj to teraz" — agent sam decyduje, kiedy (i czy) zajrzeć. Brak
     * nieprzeczytanych = brak linijki (nie zaśmiecamy promptu ani cache prefiksu).
     */
    _injectInboxNotification(lines: string[], ctx: PromptContext, _agent: PromptAgent): void {
        const ping = ctx.inboxPing;
        if (!ping || !(ping.count > 0)) return;
        const senders = (ping.senders || []).join(', ');
        lines.push(senders
            ? t('prompt.dt.inbox_ping', { count: ping.count, senders })
            : t('prompt.dt.inbox_ping_nosender', { count: ping.count }));
    }

    // ─── C2: delegate_guide (unified sub-agenty — replaces minion_guide + master_guide) ───

    _buildDelegateGuide(agent: PromptAgent, _ctx: PromptContext): string {
        const safeName = getAgentSafeName(agent.name);
        return FACTORY_DEFAULTS.delegate_guide
            .replace(/\{agent_safe_name\}/g, safeName);
    }

    // ─── C4: rules ───

    _buildRules(agent: PromptAgent, _ctx: PromptContext): string {
        const base = FACTORY_DEFAULTS.rules;
        // E2.8 A6 (S9): język odpowiedzi per agent. 'pl'/'en' wymusza treść reguły językowej
        // (pierwsza w rules) niezależnie od globalnego locale; 'auto' → jak dziś (bez zmian).
        const lang = agent?.language;
        if (lang === 'pl' || lang === 'en') {
            const globalRule = t('prompt.rule.language');
            const forcedRule = t('prompt.rule.language', undefined, lang);
            if (forcedRule && forcedRule !== globalRule) {
                return base.replace(globalRule, forcedRule);
            }
        }
        return base;
    }
}
