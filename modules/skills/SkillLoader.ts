/**
 * SkillLoader v2
 * Loads, validates, caches, saves and deletes skills from the central skill library.
 * Skills stored in .pkm-assistant/skills/{skill_name}/SKILL.md (standard agentskills.io)
 * with backward compat for skill.md (lowercase, v1 format).
 *
 * v2 (sesja 48): new format fields, saveSkill/deleteSkill, SKILL.md standard,
 *   pre-questions, icon, tags, model override, auto-invoke control.
 *
 * S27 D6: pole `allowed-tools` WYCIĘTE z całego łańcucha (parser + zapis + cache + startery).
 *   Nigdy nie było egzekwowane — o narzędziach decyduje oś `disabled_tools` agenta
 *   (`ToolRegistry.filterByAgent`). Stare pliki usera z tym polem: parser je ignoruje, zero migracji.
 */
import { slugify } from '../../core/index.js';
import { t } from '../../core/i18n/index.js';
import { log } from '../../core/utils/Logger.js';
// S27 Z1: format pliku SKILL.md jest wspólny z magazynem szablonów (SkillTemplateStore),
// żeby forma odlewnicza i odlew nie mogły się rozjechać.
import { parseSkillMarkdown, serializeSkillFile } from './skillFrontmatter.js';
import type { SkillData, SkillInput, VaultLike } from './types.js';

const SKILLS_PATH = '.pkm-assistant/skills';

/**
 * Get default starter skills created on first run.
 * Wrapped in a function for i18n (t() must be called at runtime after setLocale).
 */
function getStarterSkills() {
    return [
        {
            name: 'welcome-tour',
            folder: 'welcome-tour',
            content: `---
name: welcome-tour
description: "${t('starter.skill.welcome_tour.desc')}"
category: system
version: 3
enabled: true
icon: "\uD83D\uDC4B"
tags: [onboarding, welcome, system]
user-invocable: true
---

${t('starter.skill.welcome_tour.body')}`
        },
        {
            name: 'daily-review',
            folder: 'daily-review',
            content: `---
name: daily-review
description: "${t('starter.skill.daily_review.desc')}"
category: productivity
version: 2
enabled: true
icon: "\uD83D\uDCCB"
tags: [daily, review, productivity]
user-invocable: true
pre-questions:
  - key: dzien
    question: "${t('starter.skill.daily_review.pre_q.dzien')}"
    default: "${t('starter.skill.daily_review.pre_q.dzien_default')}"
---

${t('starter.skill.daily_review.body')}`
        },
        {
            name: 'vault-organization',
            folder: 'vault-organization',
            content: `---
name: vault-organization
description: "${t('starter.skill.vault_organization.desc')}"
category: organization
version: 2
enabled: true
icon: "\uD83D\uDDC2\uFE0F"
tags: [organization, vault, structure]
user-invocable: true
---

${t('starter.skill.vault_organization.body')}`
        },
        {
            name: 'note-from-idea',
            folder: 'note-from-idea',
            content: `---
name: note-from-idea
description: "${t('starter.skill.note_from_idea.desc')}"
category: writing
version: 2
enabled: true
icon: "\uD83D\uDCA1"
tags: [writing, ideas, notes]
user-invocable: true
pre-questions:
  - key: pomysl
    question: "${t('starter.skill.note_from_idea.pre_q.pomysl')}"
    default: ""
  - key: folder
    question: "${t('starter.skill.note_from_idea.pre_q.folder')}"
    default: ""
---

${t('starter.skill.note_from_idea.body')}`
        },
        {
            name: 'weekly-review',
            folder: 'weekly-review',
            content: `---
name: weekly-review
description: "${t('starter.skill.weekly_review.desc')}"
category: productivity
version: 2
enabled: true
icon: "\uD83D\uDCC6"
tags: [weekly, review, planning, productivity]
user-invocable: true
pre-questions:
  - key: okres
    question: "${t('starter.skill.weekly_review.pre_q.okres')}"
    default: "${t('starter.skill.weekly_review.pre_q.okres_default')}"
---

${t('starter.skill.weekly_review.body')}`
        },
        {
            name: 'create-agent',
            folder: 'create-agent',
            content: `---
name: create-agent
description: "${t('starter.skill.create_agent.desc')}"
category: system
version: 3
enabled: true
icon: "\uD83E\uDD16"
tags: [system, agent, setup]
user-invocable: true
disable-model-invocation: true
---

${t('starter.skill.create_agent.body')}`
        },
        {
            name: 'create-skill',
            folder: 'create-skill',
            content: `---
name: create-skill
description: "${t('starter.skill.create_skill.desc')}"
category: system
version: 2
enabled: true
icon: "\u2728"
tags: [system, skill, setup]
user-invocable: true
disable-model-invocation: true
---

${t('starter.skill.create_skill.body')}`
        },
        {
            name: 'system-health-check',
            folder: 'system-health-check',
            content: `---
name: system-health-check
description: "${t('starter.skill.system_health_check.desc')}"
category: system
version: 2
enabled: true
icon: "\uD83E\uDE7A"
tags: [system, diagnostics, health]
user-invocable: true
---

${t('starter.skill.system_health_check.body')}`
        }
    ];
}

export class SkillLoader {
    declare vault: VaultLike;
    declare cache: Map<string, SkillData>;
    /**
     * @param {Object} vault - Obsidian Vault object
     */
    constructor(vault: VaultLike) {
        this.vault = vault;
        /** @type {Map<string, Object>} skill name -> skill data */
        this.cache = new Map();
    }

    /**
     * Load all skills from the central library (.pkm-assistant/skills/)
     * @returns {Promise<void>}
     */
    async loadAllSkills() {
        this.cache.clear();

        try {
            const exists = await this.vault.adapter.exists(SKILLS_PATH);
            if (!exists) return;

            const listed = await this.vault.adapter.list(SKILLS_PATH);
            if (!listed?.folders) return;

            for (const folderPath of listed.folders) {
                try {
                    const skill = await this._loadSkillFromFolder(folderPath);
                    if (skill && skill.enabled !== false) {
                        this.cache.set(skill.slug, skill);
                    }
                } catch (e) {
                    log.warn('SkillLoader', 'Error loading skill from', folderPath, e);
                }
            }

            log.debug('SkillLoader', `Loaded ${this.cache.size} skills`);
        } catch (e) {
            log.error('SkillLoader', 'Error loading skills:', e);
        }
    }

    /**
     * Load a single skill from its folder.
     * Looks for SKILL.md (standard) first, falls back to skill.md (v1 compat).
     * @param {string} folderPath - e.g. ".pkm-assistant/skills/daily-review"
     * @returns {Promise<Object|null>}
     */
    async _loadSkillFromFolder(folderPath: string): Promise<SkillData | null> {
        // Standard: SKILL.md first, fallback: skill.md (v1)
        let skillFilePath = `${folderPath}/SKILL.md`;
        let fileExists = await this.vault.adapter.exists(skillFilePath);

        if (!fileExists) {
            skillFilePath = `${folderPath}/skill.md`;
            fileExists = await this.vault.adapter.exists(skillFilePath);
        }

        if (!fileExists) return null;

        const raw = await this.vault.adapter.read(skillFilePath);
        if (!raw?.trim()) return null;

        // S27 Z1: parsowanie wspólne z magazynem szablonów. Slug bierzemy z nazwy folderu
        // (np. ".pkm-assistant/skills/wera-sesja" → "wera-sesja").
        const parsed = parseSkillMarkdown(raw, {
            slug: folderPath.split('/').pop(),
            path: skillFilePath,
        });

        if (!parsed) {
            log.warn('SkillLoader', 'Skill missing name or description:', skillFilePath);
            return null;
        }

        const skill = {
            ...parsed,
            // Supporting files awareness (checked below)
            hasTemplate: false,
            hasReferences: false,
            hasExamples: false,
            folderPath: folderPath,
        };

        // Check supporting files
        try {
            if (await this.vault.adapter.exists(`${folderPath}/template.md`)) skill.hasTemplate = true;
            if (await this.vault.adapter.exists(`${folderPath}/references`)) skill.hasReferences = true;
            if (await this.vault.adapter.exists(`${folderPath}/examples`)) skill.hasExamples = true;
        } catch { /* ignore errors on optional files */ }

        return skill;
    }

    /**
     * Get a specific skill by name
     * @param {string} skillName
     * @returns {Object|null}
     */
    getSkill(skillName: string): SkillData | null {
        return this.cache.get(skillName)
            || Array.from(this.cache.values()).find(s => s.name === skillName)
            || null;
    }

    /**
     * Get all loaded skills
     * @returns {Object[]}
     */
    getAllSkills(): SkillData[] {
        return Array.from(this.cache.values());
    }

    /**
     * Get skills assigned to a specific agent
     * @param {string[]} skillNames - list of skill names from agent config
     * @returns {Object[]}
     */
    getSkillsForAgent(skillNames: string[]): SkillData[] {
        if (!skillNames || skillNames.length === 0) return [];
        return skillNames
            .map(identifier => {
                // Try slug first (canonical), then fallback to name match (backward compat)
                const bySlug = this.cache.get(identifier);
                if (bySlug) return bySlug;
                // Fallback: match by display name
                for (const skill of this.cache.values()) {
                    if (skill.name === identifier) return skill;
                }
                return null;
            })
            .filter(Boolean) as SkillData[];
    }

    /**
     * Reload all skills from disk
     * @returns {Promise<void>}
     */
    async reloadSkills() {
        await this.loadAllSkills();
    }

    // ─── CRUD (v2) ──────────────────────────────────────────────

    /**
     * Save skill to disk (create or update).
     * Writes as SKILL.md (standard format).
     *
     * AUD-code-review-049: w trybie edycji `skillData.slug` (identyfikator wpisu w cache,
     * ustawiany przez wołacza z `existing.slug`) wygrywa nad `slugify(skillData.name)` —
     * dokładnie ten sam wzorzec co `deleteSkill` niżej. `_loadSkillFromFolder` bierze slug
     * ZAWSZE z nazwy folderu na dysku, więc dla skilla, którego `name:` we frontmatterze user
     * poprawił ręcznie w vaulcie (bez zmiany folderu), `slugify(name)` daje INNY folder niż
     * ten, z którego skill naprawdę został wczytany. Bez tej naprawy edycja takiego skilla
     * zakładała DRUGI folder pod nowym slugiem i zostawiała oryginał osieroconym — user nie
     * widział swojej zmiany, a w bibliotece stały dwie kopie.
     * @param {Object} skillData - skill object from SkillEditorModal
     * @returns {Promise<string>} File path
     */
    async saveSkill(skillData: SkillInput): Promise<string> {
        const identitySlug = skillData.slug ? String(skillData.slug) : null;
        const existing = identitySlug ? this.cache.get(identitySlug) : null;
        const slug = existing?.slug || slugify(skillData.name);
        const folderPath = existing?.folderPath || `${SKILLS_PATH}/${slug}`;
        const filePath = `${folderPath}/SKILL.md`;

        // S27 Z1: serializacja wspólna z magazynem szablonów (skillFrontmatter.js).
        const content = serializeSkillFile(skillData);

        // Ensure folders exist
        if (!await this.vault.adapter.exists(SKILLS_PATH)) {
            await this.vault.adapter.mkdir(SKILLS_PATH);
        }
        if (!await this.vault.adapter.exists(folderPath)) {
            await this.vault.adapter.mkdir(folderPath);
        }

        // Remove old skill.md (v1) if SKILL.md is being written
        const oldPath = `${folderPath}/skill.md`;
        if (await this.vault.adapter.exists(oldPath)) {
            try { await this.vault.adapter.remove(oldPath); } catch { /* ignore */ }
        }

        await this.vault.adapter.write(filePath, content);

        // Update cache
        this.cache.set(slug, {
            slug,
            name: skillData.name,
            description: skillData.description,
            category: skillData.category || 'general',
            version: skillData.version || 1,
            enabled: skillData.enabled !== false,
            prompt: (skillData.prompt || '').trim(),
            path: filePath,
            icon: skillData.icon || null,
            tags: skillData.tags || null,
            model: skillData.model || null,
            argumentHint: skillData.argumentHint || null,
            disableModelInvocation: skillData.disableModelInvocation === true,
            userInvocable: skillData.userInvocable !== false,
            preQuestions: skillData.preQuestions || null,
            // S27 D3: ślad „z szablonu: X vN" przeżywa zapis (kopia go niesie, edycja nie gubi).
            fromTemplate: skillData.fromTemplate || null,
            hasTemplate: false,
            hasReferences: false,
            hasExamples: false,
            folderPath,
        });

        return filePath;
    }

    /**
     * Delete skill from disk and cache.
     * Accepts display name OR slug — cache is keyed by slug, but UI passes
     * the display name (smoke-04 finding 01: lookup by name alone silently
     * returned false and the folder survived).
     * @param {string} skillName - display name or slug
     * @returns {Promise<boolean>} true only when the skill is actually gone
     */
    async deleteSkill(skillName: string): Promise<boolean> {
        const identifier = String(skillName || '').trim();
        if (!identifier) return false;

        const slug = slugify(identifier);
        const config = this.cache.get(identifier)
            || this.cache.get(slug)
            || Array.from(this.cache.values()).find(s => s.name === identifier || s.slug === identifier)
            || null;

        // Real folder from cache wins — slugify(displayName) may differ from
        // the on-disk folder name for legacy/renamed skills.
        const folderPath = config?.folderPath
            || (config?.path ? config.path.replace(/\/(?:SKILL|skill)\.md$/, '') : null)
            || `${SKILLS_PATH}/${config?.slug || slug}`;

        try {
            const folderExists = await this.vault.adapter.exists(folderPath);
            if (!folderExists && !config) return false;

            if (folderExists) {
                // Recursive — skills with references/ or examples/ must not
                // leave an orphaned folder behind.
                await this.vault.adapter.rmdir(folderPath, true);
            }

            this.cache.delete(identifier);
            this.cache.delete(slug);
            if (config?.slug) this.cache.delete(config.slug);
            return true;
        } catch (e) {
            log.warn('SkillLoader', 'Cannot delete skill:', e);
            return false;
        }
    }

    /**
     * Create starter skills if the skills folder is empty or doesn't exist
     * @returns {Promise<void>}
     */
    async ensureStarterSkills() {
        try {
            const exists = await this.vault.adapter.exists(SKILLS_PATH);

            if (exists) {
                const listed = await this.vault.adapter.list(SKILLS_PATH);
                if ((listed?.folders?.length as number) > 0) {
                    // A4: jednorazowo podmień WYŁĄCZNIE rozpoznaną fabryczną wersję v2.
                    // Własny/przerobiony skill usera zostaje nietknięty.
                    await this._migrateLegacyCreateAgentStarter(getStarterSkills());
                    return; // skills already exist
                }
            }

            // Create skills folder
            if (!exists) {
                await this.vault.adapter.mkdir(SKILLS_PATH);
            }

            // Write each starter skill as SKILL.md (v2 standard)
            const starterSkills = getStarterSkills();
            for (const skill of starterSkills) {
                const folderPath = `${SKILLS_PATH}/${skill.folder}`;
                const filePath = `${folderPath}/SKILL.md`;

                await this.vault.adapter.mkdir(folderPath);
                await this.vault.adapter.write(filePath, skill.content);
            }

            log.debug('SkillLoader', `Created ${starterSkills.length} starter skills`);
        } catch (e) {
            log.error('SkillLoader', 'Error creating starter skills:', e);
        }
    }

    /**
     * Fabryczny create-agent v2 używał nieistniejących dziś archetypów, starych nazw
     * vault_* i złej ścieżki `{agent}/agent.yaml`. Rozpoznaj go po trzech mocnych
     * sygnaturach, zachowaj backup i wstaw v3 oparty wyłącznie o prymitywy.
     */
    async _migrateLegacyCreateAgentStarter(starterSkills = getStarterSkills()): Promise<boolean> {
        const folderPath = `${SKILLS_PATH}/create-agent`;
        const filePath = `${folderPath}/SKILL.md`;
        if (!(await this.vault.adapter.exists(filePath))) return false;

        const oldContent = await this.vault.adapter.read(filePath);
        const isStockV2 = /(?:^|\n)version:\s*2\s*(?:\n|$)/.test(oldContent)
            && oldContent.includes('vault_write(".pkm-assistant/agents/')
            && oldContent.includes('minion: null');
        if (!isStockV2) return false;

        const replacement = starterSkills.find(s => s.name === 'create-agent');
        if (!replacement?.content) return false;

        const backupPath = `${folderPath}/SKILL.v2-backup.md`;
        if (!(await this.vault.adapter.exists(backupPath))) {
            await this.vault.adapter.write(backupPath, oldContent);
        }
        await this.vault.adapter.write(filePath, replacement.content);
        log.debug('SkillLoader', 'Migrated factory create-agent skill v2 → v3 (backup kept)');
        return true;
    }
}
