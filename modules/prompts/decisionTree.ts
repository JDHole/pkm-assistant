/**
 * decisionTree.js - dane i logika chudego rdzenia drzewa decyzyjnego.
 *
 * Pure module (zależności: i18n + rejestr nazw sekcji z barrela `modules/artifacts`, sam bez
 * `obsidian`) → testowalny node'em. PromptBuilder przez łańcuch importów wciąga `obsidian`, więc
 * filtrowanie/rozstrzyganie instrukcji musi żyć osobno, żeby dało się je pokryć.
 *
 * Chudy rdzeń always-on (CORE_RULES) = reguły cross-tool i sądy modelu. Guidance
 * „kiedy użyć KONKRETNEGO narzędzia" wyprowadzone do opisów narzędzi (i18n mcp.*.desc → API);
 * twarde reguły (approval delete, nudge todo po skillu, anti-loop) żyją w kodzie/hookach.
 * Furtka `extendedPromptRules` dokłada EXTENDED_RULES (verbose, dla słabszych modeli).
 */
import { t } from '../../core/i18n/index.js';
import { ARTIFACT_SECTION_NAMES, artifactSection } from '../artifacts/index.js';
import type { ArtifactSectionKey } from '../artifacts/index.js';

export interface DecisionTreeRule {
    id: string;
    group: string;
    tool: string | null;
    /**
     * Treść reguły W JĘZYKU INTERFEJSU. Dla reguł fabrycznych to GETTER (patrz `liveRule`) -
     * czytaj to pole dopiero w chwili renderu/wyświetlenia, nigdy do stałej modułowej.
     */
    text: string;
    tier?: 'core' | 'extended';
    requiresSkills?: boolean;
}

/**
 * Definicja reguły fabrycznej. TREŚCI tu NIE MA - mieszka w słownikach i18n pod kluczem
 * `prompt.dt.rule.<id>` (pl + en) i wchodzi do reguły leniwie przez `liveRule`.
 */
interface DecisionTreeRuleDef {
    id: string;
    group: string;
    tool: string | null;
    requiresSkills?: boolean;
}
export type DecisionTreeOverride = false | string | { text?: string; group?: string; tool?: string } | undefined;
export type DecisionTreeOverrides = Record<string, DecisionTreeOverride>;

/**
 * Grupy - służą TYLKO do grupowania w UI overridów (profile_prompt: `label` + `order`). Render
 * rdzenia jest płaski i gatuje po dostępności narzędzia (availableToolNames), nie po grupach -
 * pole `requiredGroups` istniało tu jako martwe metadane i zostało skasowane: zero czytelników
 * w całym repo.
 */
export const DECISION_TREE_GROUPS = {
    delegacja:   { get label() { return t('dt.group.delegacja'); },   order: 0 },
    pamiec:      { get label() { return t('dt.group.pamiec'); },      order: 1 },
    pliki:       { get label() { return t('dt.group.pliki'); },       order: 2 },
    artefakty:   { get label() { return t('dt.group.artefakty'); },   order: 3 },
    skille:      { get label() { return t('dt.group.skille'); },      order: 4 },
    komunikacja: { get label() { return t('dt.group.komunikacja'); }, order: 5 },
    komunikator: { get label() { return t('dt.group.komunikator'); }, order: 6 },
};

/**
 * Wypełnij placeholdery nazw sekcji artefaktu (`{{user_notes}}`, `{{steps}}`, `{{goal}}`…)
 * wartościami z rejestru `modules/artifacts`, w JĘZYKU INTERFEJSU.
 *
 * DLACZEGO PLACEHOLDER, A NIE GOTOWY NAPIS: reguła leci do promptu dosłownie
 * (`PromptBuilder` wypycha `instr.text` bez zmian), a nagłówek sekcji jest ADRESEM patcha -
 * musi zgadzać się co do znaku z szablonem typu na dysku, który od 2.2.5 jest PL albo EN.
 * Napis wpisany na sztywno rozjechałby się przy pierwszej zmianie w rejestrze; placeholder
 * nie ma jak.
 *
 * Liczone PRZY KAŻDYM wywołaniu, nie przy imporcie: stałe modułowe (`DECISION_TREE_DEFAULTS`)
 * powstają przed `setLocale()` z `src/main.ts`, więc gotowy napis zamroziłby tam angielski.
 *
 * Podmieniane są WYŁĄCZNIE klucze z rejestru - `{{cokolwiek_innego}}` w regule własnej usera
 * przechodzi nietknięte. Zamiennik idzie przez funkcję, więc `$&`/`$'` w nazwie sekcji nie
 * mają szansy zostać zinterpretowane.
 */
function fillSectionNames(text: string): string {
    if (!text.includes('{{')) return text;
    return text.replace(/\{\{([a-z_]+)\}\}/g, (calosc, klucz: string) =>
        klucz in ARTIFACT_SECTION_NAMES.pl ? artifactSection(klucz as ArtifactSectionKey) : calosc);
}

/**
 * Klucz i18n treści reguły fabrycznej. Jedno miejsce wyliczenia, żeby słownik, render i test
 * liczyły ten sam napis. Klucz jest SKŁADANY (`'prompt.dt.rule.' + id`), więc skaner literałów
 * `t('...')` w `core/i18n/parity.test.ts` go pomija - parytetu pilnuje test w tym module.
 */
export function ruleTextKey(id: string): string {
    return `prompt.dt.rule.${id}`;
}

/**
 * Definicja → reguła z LENIWĄ treścią.
 *
 * `text` jest GETTEREM, nie napisem: `DECISION_TREE_DEFAULTS` powstaje na poziomie modułu, a
 * `setLocale()` leci dopiero z `src/main.ts`, więc treść policzona przy imporcie zamroziłaby
 * angielski dla wszystkich. Getter woła `t()` w chwili odczytu, czyli przy renderze promptu
 * (`resolveDecisionTreeInstructions`) albo przy rysowaniu UI overridów (`profile_prompt`).
 * Przechodzi też przez `fillSectionNames`, więc czytelnik dostaje NAPIS GOTOWY - także UI, które
 * nie ma po co znać placeholderów rejestru sekcji.
 *
 * ⚠️ Nie rób `{ ...rule }` na tych obiektach i nie wkładaj `rule.text` do stałej modułowej -
 * spread liczy getter NA MIEJSCU i zamraża język. Kopiowanie jest legalne wyłącznie w funkcji
 * wołanej przy renderze (tak robi `resolveDecisionTreeInstructions`).
 */
function liveRule(def: DecisionTreeRuleDef, tier: 'core' | 'extended'): DecisionTreeRule {
    return {
        id: def.id,
        group: def.group,
        tool: def.tool,
        tier,
        requiresSkills: def.requiresSkills,
        get text() { return fillSectionNames(t(ruleTextKey(def.id))); },
    };
}

/**
 * CHUDY RDZEŃ - always-on reguły cross-tool i sądy modelu. Per-rule: id (klucz override ORAZ
 * klucz i18n treści), group (UI), tool (renderuj tylko gdy narzędzie dostępne wg
 * availableToolNames), requiresSkills (renderuj gdy agent ma skille).
 *
 * Treści mieszkają w słownikach (`prompt.dt.rule.<id>`, pl + en) - drzewo idzie za językiem
 * interfejsu. Dokładasz regułę → dopisz klucz do OBU słowników (pilnuje tego test w module).
 */
const CORE_RULE_DEFS: DecisionTreeRuleDef[] = [
    { id: 'deleg_escalation', group: 'delegacja', tool: null },
    { id: 'deleg_core', group: 'delegacja', tool: 'delegate' },
    // Świat artefaktów żywych. `art_todo_default` gate'owany na `todo`, które
    // dochodzi dopiero w fazie D - do tego czasu reguła się NIE renderuje (świadome).
    { id: 'art_todo_default', group: 'artefakty', tool: 'todo' },
    { id: 'art_hierarchy', group: 'artefakty', tool: 'artifact_create' },
    // Treść `art_existing` niesie `{{user_notes}}` - patrz `fillSectionNames` wyżej. Nazwa sekcji
    // NIE może stać w słowniku na sztywno: w angielskim vaultcie szablon typu ma „## User notes",
    // więc reguła chroniłaby sekcję, której w notatce nie ma.
    { id: 'art_existing', group: 'artefakty', tool: 'artifact_update' },
    // Proaktywny zapis w tle (bramka istotności) + rozszerzenie o ulotne „na teraz".
    { id: 'mem_proactive', group: 'pamiec', tool: 'memory_save' },
    { id: 'mem_dedup', group: 'pamiec', tool: 'memory_save' },
    { id: 'skille', group: 'skille', tool: null, requiresSkills: true },
    // Reakcja na ping skrzynki to reguła zachowania (rdzeń), a nie opis narzędzia.
    // „Kiedy wysłać pocztę vs zdelegować" siedzi w `mcp.kom_send.desc` + furtce niżej.
    { id: 'kom_inbox', group: 'komunikator', tool: 'kom_read' },
];

export const CORE_RULES: DecisionTreeRule[] = CORE_RULE_DEFS.map(def => liveRule(def, 'core'));

/**
 * FURTKA - ROZSZERZONE REGUŁY dla słabszych modeli (np. małe lokalne, słabo czytające opisy
 * narzędzi). Domyślnie OFF (settings.pkmAssistant.extendedPromptRules). ON → dokładane po rdzeniu jako
 * osobna sekcja. Zachowane pełne treści starych instrukcji (guidance „kiedy użyć narzędzia"),
 * przefiltrowane po dostępności narzędzia jak rdzeń. BEZ skill_use/skill_known, file_write/
 * file_delete (approval/desc w kodzie), deleg_mandatory/strateg/multi/no_overkill (w delegate.desc),
 * comms_ask_user/art_skill_todo (dup/nudge).
 */
const EXTENDED_RULE_DEFS: DecisionTreeRuleDef[] = [
    { id: 'mem_save',   group: 'pamiec', tool: 'memory_save' },
    { id: 'mem_read',   group: 'pamiec', tool: 'read' },
    { id: 'mem_sum',    group: 'pamiec', tool: 'read' },
    { id: 'mem_delete', group: 'pamiec', tool: 'memory_delete' },
    { id: 'file_mkdir', group: 'pliki', tool: 'create_folder' },
    { id: 'comms_delegate', group: 'komunikacja', tool: 'agent_delegate' },
    { id: 'art_plan_todo', group: 'artefakty', tool: 'artifact_create' },
    { id: 'kom_send', group: 'komunikator', tool: 'kom_send' },
];

export const EXTENDED_RULES: DecisionTreeRule[] = EXTENDED_RULE_DEFS.map(def => liveRule(def, 'extended'));

/**
 * Wszystkie instrukcje (rdzeń + rozszerzone) - źródło dla UI overridów (profile_prompt) i resolvera.
 * Każda niesie `tier` ('core'|'extended'). Override `promptOverrides.decisionTreeInstructions[id]`
 * działa dla obu. Stare id (deleg_mandatory, skill_use, file_write, ...) już tu nie występują -
 * overridy na nie przestają matchować (świadome).
 *
 * ⚠️ Spread leci po TABLICACH, nie po obiektach reguł: `{ ...rule }` policzyłby getter `text`
 * przy imporcie (czyli PRZED `setLocale()`) i zamroził angielski. `tier` jest już nadany przez
 * `liveRule`, więc nie ma po co przepisywać obiektów.
 */
export const DECISION_TREE_DEFAULTS: DecisionTreeRule[] = [...CORE_RULES, ...EXTENDED_RULES];

/**
 * Rozstrzygnij instrukcje: factory + global override + agent override + custom (custom_*).
 * false = wyłącz (na dowolnym poziomie); string = podmień tekst. Zachowuje tier/requiresSkills.
 * Nazwy sekcji artefaktu wchodzą tu przez `fillSectionNames` - tekst fabryczny ma je wypełnione
 * już z gettera (`liveRule`), a ten przebieg obsługuje teksty NADPISANE przez usera, żeby własna
 * reguła z `{{user_notes}}` działała tak samo jak fabryczna (wypełnianie jest idempotentne).
 * @returns {Array<{id, group, tool, text, tier?, requiresSkills?}>}
 */
export function resolveDecisionTreeInstructions(agentOverrides: DecisionTreeOverrides = {}, globalOverrides: DecisionTreeOverrides = {}): DecisionTreeRule[] {
    const result: DecisionTreeRule[] = [];

    for (const def of DECISION_TREE_DEFAULTS) {
        const agentVal = agentOverrides[def.id];
        const globalVal = globalOverrides[def.id];
        if (agentVal === false || (agentVal === undefined && globalVal === false)) continue;

        const text = (typeof agentVal === 'string') ? agentVal
                   : (typeof globalVal === 'string') ? globalVal
                   : def.text;

        result.push({ id: def.id, group: def.group, tool: def.tool, text: fillSectionNames(text), tier: def.tier, requiresSkills: def.requiresSkills });
    }

    // Custom (custom_*) - traktowane jak rdzeń (always-on).
    const allCustomKeys = new Set([
        ...Object.keys(globalOverrides).filter(k => k.startsWith('custom_')),
        ...Object.keys(agentOverrides).filter(k => k.startsWith('custom_')),
    ]);
    for (const key of allCustomKeys) {
        const agentVal = agentOverrides[key];
        const globalVal = globalOverrides[key];
        if (agentVal === false || (agentVal === undefined && globalVal === false)) continue;

        const source = (typeof agentVal === 'object' && agentVal?.text) ? agentVal
                     : (typeof globalVal === 'object' && globalVal?.text) ? globalVal
                     : null;
        if (source) {
            result.push({ id: key, group: source.group || 'delegacja', tool: source.tool || null, text: fillSectionNames(source.text!), tier: 'core' });
        }
    }

    return result;
}

/**
 * Podziel rozstrzygnięte instrukcje na rdzeń (always-on) i rozszerzone (furtka), gatując po
 * dostępności narzędzia/skilli. Pure - zwraca obiekty instrukcji (render tekstu robi PromptBuilder).
 *
 * @param {Array} resolved - wynik resolveDecisionTreeInstructions
 * @param {Object} opts
 * @param {Set<string>|null} [opts.available] - nazwy dostępnych narzędzi; null = nie filtruj (preview/test)
 * @param {boolean} [opts.hasSkills=false] - czy agent ma skille (gatuje reguły requiresSkills)
 * @param {boolean} [opts.extended=false] - czy furtka ON (zwróć też extended)
 * @returns {{ core: Array, extended: Array }}
 */
export function splitDecisionTreeRules(resolved: DecisionTreeRule[], { available = null, hasSkills = false, extended = false }: { available?: Set<string> | null; hasSkills?: boolean; extended?: boolean } = {}): { core: DecisionTreeRule[]; extended: DecisionTreeRule[] } {
    const toolOn = (name: string) => !available || available.has(name);
    const isAvailable = (instr: DecisionTreeRule) => {
        if (instr.requiresSkills) return hasSkills;
        if (!instr.tool) return true;
        return toolOn(instr.tool);
    };
    const core: DecisionTreeRule[] = [];
    const ext: DecisionTreeRule[] = [];
    for (const instr of resolved) {
        if (!isAvailable(instr)) continue;
        if (instr.tier === 'extended') {
            if (extended) ext.push(instr);
        } else {
            core.push(instr);
        }
    }
    return { core, extended: ext };
}
