/**
 * factoryTemplates.js — fabryczne szablony Warsztatu/Zaplecza (E3.5 Deep Research).
 *
 * Seed 3 szablonów przy starcie: sub `researcher` + skille `deep-research-web` /
 * `deep-research-vault`. Wykonywany RAZ — marker `.pkm-assistant/templates/.factory-seeded-v1`
 * (wzór migratora `.migrated-v2` z E2.9). Kasacja usera jest SZANOWANA: szablon nie wraca
 * przy restarcie (inaczej niż builtin typy artefaktów — typ to infrastruktura silnika,
 * szablon to oferta w Zapleczu). Podbicie treści fabrycznych w przyszłości = nowy sufiks
 * markera (`.factory-seeded-v2`) — świadoma decyzja, nie automat.
 *
 * Treści przez `t()` (i18n pl/en, wzór starter skills — wołane w runtime po setLocale).
 * Slugi i `name` STAŁE (nie tłumaczone): przepisy skilli delegują po `aspect:"researcher"`
 * (fuzzy match `endsWith('-researcher')` w DelegateTool), więc nazwa jest częścią kontraktu.
 *
 * Zależności przez DI (vault + oba store'y) — zero importów Obsidiana, testowalne w AVA.
 */
import { t } from '../../core/i18n/index.js';
import { log } from '../../core/utils/Logger.js';
import { DEFAULT_LIMITS } from '../../config/limits.js';

interface FactoryAdapter {
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    write(path: string, content: string): Promise<void>;
}

interface FactoryStore {
    get?(name: string): unknown;
    createFromData(data: Record<string, unknown>): Promise<{ success?: boolean }>;
}

interface FactoryDependencies {
    vault?: { adapter?: FactoryAdapter };
    skillTemplateStore?: FactoryStore;
    subAgentTemplateStore?: FactoryStore;
}

export const FACTORY_TEMPLATES_MARKER = '.pkm-assistant/templates/.factory-seeded-v1';

/**
 * Fabryczne szablony SUB-AGENTÓW (kształt danych jak `SubAgentTemplateStore.createFromData`).
 * `max_iterations: 12` — deep research potrzebuje więcej niż default workera (8).
 */
export function getFactorySubAgentTemplates() {
    return [
        {
            name: 'researcher',
            description: t('factory.template.researcher.desc'),
            role: 'researcher',
            tools: ['search', 'list', 'read', 'web_search', 'web_read'],
            max_iterations: 12,
            max_tool_result_length: DEFAULT_LIMITS.max_tool_result_length,
            prompt: t('factory.template.researcher.knowledge'),
        },
    ];
}

/**
 * Fabryczne szablony SKILLI (kształt danych jak `SkillTemplateStore.createFromData`).
 * Głębokość = pre-question select (D4) — user decyduje przy każdym odpaleniu.
 */
export function getFactorySkillTemplates() {
    const glebokosc = {
        key: 'glebokosc',
        question: t('factory.template.pre_q.glebokosc'),
        type: 'select',
        options: [t('factory.template.pre_q.glebokosc_fast'), t('factory.template.pre_q.glebokosc_deep')],
        default: t('factory.template.pre_q.glebokosc_fast'),
    };
    return [
        {
            name: 'deep-research-web',
            description: t('factory.template.research_web.desc'),
            category: 'research',
            icon: '🔎',
            preQuestions: [
                { key: 'temat', question: t('factory.template.research_web.pre_q.temat'), default: '', type: 'text' },
                glebokosc,
            ],
            prompt: t('factory.template.research_web.body'),
        },
        {
            name: 'deep-research-vault',
            description: t('factory.template.research_vault.desc'),
            category: 'research',
            icon: '🧠',
            preQuestions: [
                { key: 'temat', question: t('factory.template.research_vault.pre_q.temat'), default: '', type: 'text' },
                glebokosc,
            ],
            prompt: t('factory.template.research_vault.body'),
        },
    ];
}

/**
 * Zaseeduj fabryczne szablony (idempotentne przez marker).
 *
 * Wołane z `AgentManager.initialize()` PO `loadAll()` obu store'ów — sprawdzanie kolizji
 * idzie po cache (`store.get` szuka po slugu i nazwie), a `createFromData` wpisuje nowe
 * szablony do cache, więc po seedzie nie trzeba przeładowywać.
 *
 * @param {Object} deps
 * @param {Object} deps.vault - Obsidian Vault (tylko `vault.adapter`)
 * @param {Object} deps.skillTemplateStore - `SkillTemplateStore` (po loadAll)
 * @param {Object} deps.subAgentTemplateStore - `SubAgentTemplateStore` (po loadAll)
 * @returns {Promise<boolean>} true gdy seed się wykonał, false gdy marker już był
 */
export async function ensureFactoryTemplates({ vault, skillTemplateStore, subAgentTemplateStore }: FactoryDependencies = {}) {
    try {
        if (!vault?.adapter) return false;
        if (await vault.adapter.exists(FACTORY_TEMPLATES_MARKER)) return false;

        let seeded = 0;
        for (const data of getFactorySubAgentTemplates()) {
            // Userowy szablon pod tą nazwą wygrywa — fabryczny nie nadpisuje i nie sufiksuje.
            if (subAgentTemplateStore?.get?.(data.name)) continue;
            const res = await subAgentTemplateStore!.createFromData(data);
            if (res?.success) seeded += 1;
        }
        for (const data of getFactorySkillTemplates()) {
            if (skillTemplateStore?.get?.(data.name)) continue;
            const res = await skillTemplateStore!.createFromData(data);
            if (res?.success) seeded += 1;
        }

        for (const dir of ['.pkm-assistant', '.pkm-assistant/templates']) {
            if (!await vault.adapter.exists(dir)) await vault.adapter.mkdir(dir);
        }
        await vault.adapter.write(
            FACTORY_TEMPLATES_MARKER,
            `E3.5 Deep Research — fabryczne szablony zaseedowane. Skasowanie tego pliku wywoła seed ponownie przy starcie.\n`
        );
        log.debug('factoryTemplates', `Zaseedowano ${seeded} fabrycznych szablonów (marker utworzony)`);
        return true;
    } catch (e: unknown) {
        log.error('factoryTemplates', 'Błąd seedowania fabrycznych szablonów:', e);
        return false;
    }
}
