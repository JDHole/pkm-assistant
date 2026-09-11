/**
 * SkillTemplateStore — magazyn SZABLONÓW skilli.
 *
 * Szablon to forma odlewnicza: `.pkm-assistant/templates/skills/<slug>/SKILL.md`
 * w formacie IDENTYCZNYM z żywym skillem + pole `version: N` (int, start 1).
 *
 * Zasady:
 *  - „kopia, nie link": `instantiate()` tworzy NIEZALEŻNĄ kopię w `.pkm-assistant/skills/`.
 *    Edycja szablonu NIE zmienia istniejących kopii. Kopia niesie ślad `from_template: "<nazwa> vN"`.
 *  - „same szablony": Zaplecze pokazuje wyłącznie ten magazyn; żywe skille żyją u agentów.
 *  - Wersja szablonu rośnie przy KAŻDYM zapisie edycji (`save`). Kopia startuje od `version: 1` —
 *    wersja szablonu nie nadpisuje wersji żywego bytu.
 *
 * Pure względem `obsidian` (tylko `vault.adapter`) — dzięki temu testowalny w AVA.
 * UI (Notice o kolizji slugu) obsługuje wołający: `instantiate()` zwraca `renamed: true`.
 */
import { slugify } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';
import { parseSkillMarkdown, serializeSkillFile } from './skillFrontmatter.js';
import type { SkillData, SkillInput, VaultLike } from './types.js';
// `SkillData & {...}`, nie `SkillInput & {...}`: obie konstrukcje niżej (`_loadFromFolder`
// przez `parseSkillMarkdown`, `_write` przez formData `SkillEditorModal` — patrz jego
// `formData`, każde pole ma fallback `||`/`??`) ZAWSZE dają konkretną wartość każdemu polu,
// nigdy `undefined`; kształt jest więc zgodny z `SkillData` (ten sam moduł), co pozwala
// jednemu UI (SkillEditorModal/DetailView) czytać żywy skill i szablon bez rozgałęziania typu.
export type SkillTemplateRecord = SkillData & { folderPath: string; isTemplate: true };

export const SKILL_TEMPLATES_PATH = '.pkm-assistant/templates/skills';
const LIVE_SKILLS_PATH = '.pkm-assistant/skills';

export class SkillTemplateStore {
    declare vault: VaultLike;
    declare cache: Map<string, SkillTemplateRecord>;
    /**
     * @param {Object} vault - Obsidian Vault object (używany jest wyłącznie `vault.adapter`)
     */
    constructor(vault: VaultLike) {
        this.vault = vault;
        /** @type {Map<string, Object>} slug → szablon */
        this.cache = new Map();
    }

    // ─── odczyt ─────────────────────────────────────────────────

    /**
     * Wczytaj wszystkie szablony z dysku do cache.
     * @returns {Promise<Object[]>}
     */
    async loadAll() {
        this.cache.clear();
        try {
            if (!await this.vault.adapter.exists(SKILL_TEMPLATES_PATH)) return [];
            const listed = await this.vault.adapter.list(SKILL_TEMPLATES_PATH);
            for (const folderPath of listed?.folders || []) {
                try {
                    const tpl = await this._loadFromFolder(folderPath);
                    if (tpl) this.cache.set(tpl.slug, tpl);
                } catch (e) {
                    log.warn('SkillTemplateStore', 'Nie udało się wczytać szablonu z', folderPath, e);
                }
            }
        } catch (e) {
            log.error('SkillTemplateStore', 'Błąd wczytywania szablonów skilli:', e);
        }
        return this.list();
    }

    /** @returns {Object[]} szablony z cache (posortowane po nazwie) */
    list(): SkillTemplateRecord[] {
        return [...this.cache.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    /** @param {string} slug @returns {Object|null} */
    get(slug: string): SkillTemplateRecord | null {
        if (!slug) return null;
        return this.cache.get(slug)
            || [...this.cache.values()].find(tpl => tpl.name === slug)
            || null;
    }

    /** @returns {number} liczba szablonów (licznik dla Home/Zaplecza) */
    count() {
        return this.cache.size;
    }

    /** @private */
    async _loadFromFolder(folderPath: string): Promise<SkillTemplateRecord | null> {
        const filePath = `${folderPath}/SKILL.md`;
        if (!await this.vault.adapter.exists(filePath)) return null;
        const raw = await this.vault.adapter.read(filePath);
        const slug = folderPath.split('/').pop();
        const tpl = parseSkillMarkdown(raw, { slug, path: filePath });
        if (!tpl) {
            log.warn('SkillTemplateStore', 'Szablon bez name/description:', filePath);
            return null;
        }
        tpl.isTemplate = true;
        tpl.folderPath = folderPath;
        return tpl as SkillTemplateRecord;
    }

    // ─── zapis ──────────────────────────────────────────────────

    /**
     * Utwórz NOWY szablon (version = 1). Kolizja slugu → sufiks `-2`, `-3`…
     * @param {Object} data - dane skilla (kształt jak z `SkillEditorModal`)
     * @returns {Promise<{success: boolean, slug?: string, name?: string, renamed?: boolean, error?: string}>}
     */
    async createFromData(data: SkillInput): Promise<{ success: boolean; slug?: string; name?: string; renamed?: boolean; error?: string }> {
        if (!data?.name?.trim() || !data?.description?.trim()) {
            return { success: false, error: 'missing_fields' };
        }
        const resolved = await this._freeName(data.name);
        const payload = { ...data, name: resolved.name, version: 1, fromTemplate: null };
        await this._write(resolved.slug, payload);
        return { success: true, slug: resolved.slug, name: resolved.name, renamed: resolved.renamed };
    }

    /**
     * Zapisz EDYCJĘ istniejącego szablonu — podbija `version` o 1.
     * Gdy szablonu nie ma na dysku, zachowuje się jak `createFromData`.
     * @param {string} slug
     * @param {Object} data
     * @returns {Promise<{success: boolean, slug?: string, version?: number, error?: string}>}
     */
    async save(slug: string, data: SkillInput): Promise<{ success: boolean; slug?: string; version?: number; error?: string }> {
        if (!data?.name?.trim() || !data?.description?.trim()) {
            return { success: false, error: 'missing_fields' };
        }
        const existing = this.get(slug);
        if (!existing) return this.createFromData(data);

        const version = (Number(existing.version) || 1) + 1;
        // Nazwa szablonu jest tożsamością (slug pochodzi z folderu) — edycja jej nie przenosi.
        const payload = { ...data, name: existing.name, version, fromTemplate: null };
        await this._write(existing.slug, payload);
        return { success: true, slug: existing.slug, version };
    }

    /**
     * Skasuj szablon (plik + folder). Kopie u agentów zostają nietknięte (kopia, nie link).
     * @param {string} slug
     * @returns {Promise<boolean>}
     */
    async delete(slug: string): Promise<boolean> {
        const tpl = this.get(slug);
        if (!tpl) return false;
        const folderPath = `${SKILL_TEMPLATES_PATH}/${tpl.slug}`;
        try {
            const filePath = `${folderPath}/SKILL.md`;
            if (await this.vault.adapter.exists(filePath)) await this.vault.adapter.remove(filePath);
            try { await this.vault.adapter.rmdir(folderPath, false); } catch { /* folder może mieć dodatki */ }
            this.cache.delete(tpl.slug);
            return true;
        } catch (e) {
            log.warn('SkillTemplateStore', 'Nie udało się skasować szablonu:', e);
            return false;
        }
    }

    /**
     * Odlej KOPIĘ szablonu jako żywy skill w `.pkm-assistant/skills/` (kopia, nie link).
     * Kolizja slugu → sufiks `-2`, `-3`… (wołający pokazuje Notice na `renamed: true`).
     *
     * @param {string} slug - slug szablonu
     * @param {Object} deps
     * @param {Object} deps.skillLoader - `SkillLoader` (owner żywych skilli; robi zapis + cache)
     * @returns {Promise<{success: boolean, name?: string, slug?: string, renamed?: boolean,
     *                    fromTemplate?: string, error?: string}>}
     */
    async instantiate(slug: string, { skillLoader }: { skillLoader?: { saveSkill: (data: SkillInput) => Promise<string> } } = {}): Promise<{ success: boolean; name?: string; slug?: string; renamed?: boolean; fromTemplate?: string; error?: string }> {
        const tpl = this.get(slug);
        if (!tpl) return { success: false, error: 'template_not_found' };
        if (!skillLoader?.saveSkill) return { success: false, error: 'skill_loader_unavailable' };

        const resolved = await this._freeName(tpl.name, LIVE_SKILLS_PATH);
        const fromTemplate = `${tpl.name} v${tpl.version || 1}`;
        const copy: SkillInput = {
            ...tpl,
            name: resolved.name,
            slug: resolved.slug,
            // Wersja szablonu NIE nadpisuje wersji żywego bytu — kopia startuje od 1.
            version: 1,
            fromTemplate,
        };
        delete copy.isTemplate;
        delete copy.folderPath;
        delete copy.path;

        await skillLoader.saveSkill(copy);
        return {
            success: true,
            name: resolved.name,
            slug: resolved.slug,
            renamed: resolved.renamed,
            fromTemplate,
        };
    }

    // ─── prywatne ───────────────────────────────────────────────

    /** @private zapis pliku szablonu (tworzy foldery po drodze) */
    async _write(slug: string, payload: SkillInput): Promise<void> {
        const folderPath = `${SKILL_TEMPLATES_PATH}/${slug}`;
        const filePath = `${folderPath}/SKILL.md`;
        for (const dir of ['.pkm-assistant/templates', SKILL_TEMPLATES_PATH, folderPath]) {
            if (!await this.vault.adapter.exists(dir)) await this.vault.adapter.mkdir(dir);
        }
        await this.vault.adapter.write(filePath, serializeSkillFile(payload));
        // `payload as SkillData`: `SkillInput` deklaruje większość pól opcjonalnie (kształt
        // zapisu, gdzie wołacz mógłby coś pominąć), ale JEDYNY realny wołacz (`SkillEditorModal`
        // formData) ZAWSZE ustawia je konkretnie (fallbacki `||`/`??` przy każdym polu) — cast
        // na źródle rozlania, nie nowe klucze niżej.
        this.cache.set(slug, {
            ...(payload as SkillData),
            slug,
            prompt: (payload.prompt || '').trim(),
            path: filePath,
            folderPath,
            isTemplate: true,
        });
    }

    /**
     * @private Znajdź wolną nazwę/slug w danej bazie. Sufiks dokładany do NAZWY, żeby
     * `slugify(name)` zgadzał się z nazwą folderu (kontrakt SkillLoader.saveSkill).
     * @returns {Promise<{name: string, slug: string, renamed: boolean}>}
     */
    async _freeName(baseName: string, basePath = SKILL_TEMPLATES_PATH): Promise<{ name: string; slug: string; renamed: boolean }> {
        let name = baseName;
        let slug = slugify(name);
        let n = 1;
        while (await this.vault.adapter.exists(`${basePath}/${slug}`)) {
            n += 1;
            name = `${baseName} ${n}`;
            slug = slugify(name);
            if (n > 99) break; // bezpiecznik — nie kręcimy się w nieskończoność
        }
        return { name, slug, renamed: n > 1 };
    }
}
