/**
 * SkillLoader v2
 * Loads, validates, caches, saves and deletes skills from the central skill library.
 * Skills stored in .pkm-assistant/skills/{skill_name}/SKILL.md (standard agentskills.io)
 * with backward compat for skill.md (lowercase, v1 format).
 *
 * v2: new format fields, saveSkill/deleteSkill, SKILL.md standard,
 *   pre-questions, icon, tags, model override, auto-invoke control.
 *
 * Pole `allowed-tools` jest WYCIĘTE z całego łańcucha (parser + zapis + cache + startery).
 *   Nigdy nie było egzekwowane — o narzędziach decyduje oś `disabled_tools` agenta
 *   (`ToolRegistry.filterByAgent`). Stare pliki usera z tym polem: parser je ignoruje, zero migracji.
 */
import { slugify } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';
// Format pliku SKILL.md jest wspólny z magazynem szablonów (SkillTemplateStore),
// żeby forma odlewnicza i odlew nie mogły się rozjechać.
import { parseSkillMarkdown, serializeSkillFile } from './skillFrontmatter.js';
import type { SkillData, SkillInput, VaultLike } from './types.js';

const SKILLS_PATH = '.pkm-assistant/skills';

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

        // Parsowanie wspólne z magazynem szablonów. Slug bierzemy z nazwy folderu
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
     * W trybie edycji `skillData.slug` (identyfikator wpisu w cache,
     * ustawiany przez wołacza z `existing.slug`) wygrywa nad `slugify(skillData.name)` —
     * dokładnie ten sam wzorzec co `deleteSkill` niżej. `_loadSkillFromFolder` bierze slug
     * ZAWSZE z nazwy folderu na dysku, więc dla skilla, którego `name:` we frontmatterze user
     * poprawił ręcznie w vaulcie (bez zmiany folderu), `slugify(name)` dawałby INNY folder niż
     * ten, z którego skill naprawdę został wczytany. Bez tego priorytetu edycja takiego skilla
     * zakładałaby DRUGI folder pod nowym slugiem i zostawiała oryginał osieroconym — user nie
     * widziałby swojej zmiany, a w bibliotece stałyby dwie kopie.
     * @param {Object} skillData - skill object from SkillEditorModal
     * @returns {Promise<string>} File path
     */
    async saveSkill(skillData: SkillInput): Promise<string> {
        const identitySlug = skillData.slug ? String(skillData.slug) : null;
        const existing = identitySlug ? this.cache.get(identitySlug) : null;
        const slug = existing?.slug || slugify(skillData.name);
        const folderPath = existing?.folderPath || `${SKILLS_PATH}/${slug}`;
        const filePath = `${folderPath}/SKILL.md`;

        // Serializacja wspólna z magazynem szablonów (skillFrontmatter.js).
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
            // Ślad „z szablonu: X vN" przeżywa zapis (kopia go niesie, edycja nie gubi).
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
     * the display name (lookup by name alone used to silently
     * return false and leave the folder behind).
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
}
