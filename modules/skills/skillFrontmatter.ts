/**
 * Wspólny kształt pliku SKILL.md.
 *
 * Używany przez `SkillLoader` (żywe skille w `.pkm-assistant/skills/`) ORAZ przez
 * `SkillTemplateStore` (szablony w `.pkm-assistant/templates/skills/`). Jedno miejsce
 * parsowania i serializacji = format szablonu nie może się rozjechać z formatem żywego bytu
 * (szablon → instancja to KOPIA, więc oba pliki muszą być tym samym formatem).
 *
 * Pure — zero importów z `obsidian`, testowalne w AVA.
 */
import { parseFrontmatter, stringifyYaml } from '../../core/index.js';
import type { SkillData, SkillInput, SkillQuestion } from './types.js';

/** Jedna pozycja `pre-questions:` w surowym frontmatterze — wszystko opcjonalne, user pisze
 * YAML ręcznie. Walidacja obecności `key`/`question` dzieje się niżej (`parseSkillMarkdown`). */
interface RawSkillQuestion {
    key?: string;
    question?: string;
    default?: string;
    type?: string;
    options?: unknown;
    depends_on?: unknown;
    placeholder?: unknown;
    rows?: unknown;
}

/** Kształt frontmattera SKILL.md jak wraca z `parseFrontmatter`, PRZED walidacją
 * `name`/`description` (sprawdzaną niżej) — wszystko opcjonalne, user edytuje plik ręcznie. */
interface FrontmatterData {
    name?: string;
    description?: string;
    slug?: string;
    category?: string;
    version?: number;
    enabled?: boolean;
    'pre-questions'?: RawSkillQuestion[];
    tags?: string[] | string;
    icon?: string;
    model?: string;
    'argument-hint'?: string;
    'disable-model-invocation'?: boolean;
    'user-invocable'?: boolean;
    from_template?: string;
}

/**
 * Parse a SKILL.md file into the canonical skill object.
 * Zwraca `null` gdy brak frontmatteru albo brak wymaganych pól (name + description).
 *
 * @param {string} raw - surowa treść pliku
 * @param {Object} [opts]
 * @param {string} [opts.slug] - slug domyślny (zwykle nazwa folderu); `slug:` z frontmatteru wygrywa
 * @param {string} [opts.path] - ścieżka pliku (do UI/MarkdownRenderer)
 * @returns {Object|null}
 */
export function parseSkillMarkdown(raw: string, { slug = null, path = '' }: { slug?: string | null; path?: string } = {}): SkillData | null {
    if (!raw?.trim()) return null;

    // TS-boundary: SKILL.md jest plikiem edytowalnym przez usera — kształt sprawdzamy
    // niżej (name/description), reszta pól ma defaulty poniżej.
    const { frontmatter, content } = parseFrontmatter(raw) as { frontmatter: FrontmatterData; content: string };
    if (!frontmatter?.name || !frontmatter?.description) return null;

    // pre-questions (array of {key, question, default, options?})
    let preQuestions: SkillQuestion[] | null = null;
    if (Array.isArray(frontmatter['pre-questions'])) {
        // `as ...`: `.filter` bez predykatu typu nie zwęża `key`/`question` do `string` (brak
        // wsparcia w tej wersji TS) — cast na WYNIKU filtra, warunek i kolejność bez zmian.
        preQuestions = (frontmatter['pre-questions']
            .filter(q => q && q.key && q.question) as Array<RawSkillQuestion & { key: string; question: string }>)
            .map(q => ({
                key: q.key,
                question: q.question,
                default: q.default || '',
                type: q.type || 'text',
                ...(q.options ? { options: q.options } : {}),
                ...(q.depends_on ? { depends_on: q.depends_on } : {}),
                ...(q.placeholder ? { placeholder: q.placeholder } : {}),
                ...(q.rows ? { rows: q.rows } : {}),
            }));
        if (preQuestions.length === 0) preQuestions = null;
    }

    // Pole `allowed-tools` jest WYCIĘTE (nic go nigdy nie egzekwowało — fasada).
    // Stare skille z tym polem we frontmatterze: parser ignoruje nieznane pola, zero migracji.

    // tags (array of strings or comma/space separated string)
    let tags = null;
    if (Array.isArray(frontmatter.tags)) {
        tags = frontmatter.tags.filter(item => typeof item === 'string');
    } else if (typeof frontmatter.tags === 'string') {
        tags = frontmatter.tags.split(/[\s,]+/).filter(Boolean);
    }

    return {
        name: frontmatter.name,
        slug: frontmatter.slug || slug || '',
        description: frontmatter.description,
        category: frontmatter.category || 'general',
        version: frontmatter.version || 1,
        enabled: frontmatter.enabled !== false,
        // Musi trafić do returna: liczone wyżej, ale bez tego pola w wyniku każdy load
        // z dysku traciłby pre-questions (modal pytań przed skillem byłby martwy).
        preQuestions,
        prompt: content.trim(),
        path,
        icon: frontmatter.icon || null,
        tags,
        model: frontmatter.model || null,
        argumentHint: frontmatter['argument-hint'] || null,
        disableModelInvocation: frontmatter['disable-model-invocation'] === true,
        userInvocable: frontmatter['user-invocable'] !== false, // default true
        // Ślad pochodzenia kopii („z szablonu: X vN"). Szablony go nie mają.
        fromTemplate: typeof frontmatter.from_template === 'string' ? frontmatter.from_template : null,
    };
}

/**
 * Build the frontmatter object written to SKILL.md.
 * @param {Object} skillData
 * @returns {Object}
 */
function buildSkillFrontmatter(skillData: SkillInput): Record<string, unknown> {
    const frontmatter: Record<string, unknown> = {
        name: skillData.name,
        description: skillData.description,
    };

    // Standard fields
    if (skillData.argumentHint) frontmatter['argument-hint'] = skillData.argumentHint;
    if (skillData.disableModelInvocation) frontmatter['disable-model-invocation'] = true;
    if (skillData.userInvocable === false) frontmatter['user-invocable'] = false;

    // Our extensions
    if (skillData.category && skillData.category !== 'general') frontmatter.category = skillData.category;
    if ((skillData.tags?.length as number) > 0) frontmatter.tags = skillData.tags;
    frontmatter.version = skillData.version || 1;
    frontmatter.enabled = skillData.enabled !== false;
    if (skillData.icon) frontmatter.icon = skillData.icon;
    if (skillData.model) frontmatter.model = skillData.model;
    if (skillData.fromTemplate) frontmatter.from_template = skillData.fromTemplate;
    if ((skillData.preQuestions?.length as number) > 0) frontmatter['pre-questions'] = skillData.preQuestions;

    return frontmatter;
}

/**
 * Serialize a skill object into the full SKILL.md file contents.
 * @param {Object} skillData
 * @returns {string}
 */
export function serializeSkillFile(skillData: SkillInput): string {
    const yamlStr = stringifyYaml(buildSkillFrontmatter(skillData));
    return `---\n${yamlStr}---\n\n${skillData.prompt || ''}`;
}
