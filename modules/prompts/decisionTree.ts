/**
 * decisionTree.js — dane i logika chudego rdzenia drzewa decyzyjnego (D14, E2.4).
 *
 * Pure module (zależność tylko od i18n) → testowalny node'em. PromptBuilder przez łańcuch importów
 * wciąga `obsidian`, więc filtrowanie/rozstrzyganie instrukcji musi żyć osobno, żeby dało się je pokryć.
 *
 * Model D14: chudy rdzeń always-on (CORE_RULES) = reguły cross-tool i sądy modelu. Guidance
 * „kiedy użyć KONKRETNEGO narzędzia" wyprowadzone do opisów narzędzi (i18n mcp.*.desc → API);
 * twarde reguły (approval delete, nudge todo po skillu, anti-loop) żyją w kodzie/hookach.
 * Furtka `extendedPromptRules` dokłada EXTENDED_RULES (verbose, dla słabszych modeli).
 */
import { t } from '../../core/i18n/index.js';

export interface DecisionTreeRule {
    id: string;
    group: string;
    tool: string | null;
    text: string;
    tier?: 'core' | 'extended';
    requiresSkills?: boolean;
}
export type DecisionTreeOverride = false | string | { text?: string; group?: string; tool?: string } | undefined;
export type DecisionTreeOverrides = Record<string, DecisionTreeOverride>;

/**
 * Grupy — służą TYLKO do grupowania w UI overridów (profile_prompt: `label` + `order`). Render
 * rdzenia jest płaski i gatuje po dostępności narzędzia (availableToolNames), nie po grupach —
 * pole `requiredGroups` istniało tu jako martwe metadane po D14 i zostało skasowane w fabryce
 * dead-code D7 (AUD-dead-code-076/139/242): zero czytelników w całym repo.
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
 * CHUDY RDZEŃ (D14) — always-on reguły cross-tool i sądy modelu. Per-rule: id (klucz override),
 * group (UI), tool (renderuj tylko gdy narzędzie dostępne wg availableToolNames), requiresSkills
 * (renderuj gdy agent ma skille), text. Teksty inline PL (drzewo to polski korpus promptu).
 */
export const CORE_RULES: DecisionTreeRule[] = [
    { id: 'deleg_escalation', group: 'delegacja', tool: null,
      text: 'ESKALACJA: wiesz → odpowiadaj; brakuje danych → zbierz (narzędzia albo delegate); brak wyniku → ask_user; user odmówił → STOP.' },
    { id: 'deleg_core', group: 'delegacja', tool: 'delegate',
      text: 'Dużo danych z vaulta/weba do zebrania (przeszukanie wielu plików, analiza zbiorcza, synteza) → delegate. Drobiazgi (jeden read/search) rób sam.' },
    // E2.9 FAZA B (B3): świat artefaktów żywych. `art_todo_default` gate'owany na `todo`, które
    // dochodzi dopiero w fazie D — do tego czasu reguła się NIE renderuje (świadome, spec B).
    { id: 'art_todo_default', group: 'artefakty', tool: 'todo',
      text: 'Zadanie na 3+ kroków → od razu todo (lista kroków) i odhaczaj po kolei — masz je na oczach, nie gubisz wątku.' },
    { id: 'art_hierarchy', group: 'artefakty', tool: 'artifact_create',
      text: 'Proponujesz plan/dokument do zatwierdzenia przez usera → artifact_create(typ:"plan", tytul, sekcje z krokami). Powstaje notatka w vaultcie z guzikami akceptacji — user ją przegląda, poprawia i zatwierdza. NIE pisz artefaktów przez write.' },
    { id: 'art_existing', group: 'artefakty', tool: 'artifact_update',
      text: 'Istniejący artefakt → artifact_update po jego ID (patch na świeżym stanie), nie twórz nowego. Sekcji „Uwagi usera" NIGDY nie nadpisuj — to strefa usera: czytaj ją, zmieniaj tylko własne sekcje.' },
    // E2.7 W1 proaktywny zapis w tle (bramka istotności, decyzja D3) + E2.8 D2 rozszerzenie o ulotne „na teraz".
    { id: 'mem_proactive', group: 'pamiec', tool: 'memory_save', text: 'POD KONIEC TURY sam oceń, czy pojawiło się coś TRWAŁEGO wartego zapamiętania na przyszłość — jeśli tak, wywołaj memory_save bez proszenia usera. ZAPISUJ tylko: trwałe fakty/preferencje usera, reguły współpracy, korekty od usera ("nie tak, rób X"), kontekst projektu wart >1 sesji. NIE zapisuj: jednorazowych detali zadania, rzeczy które już są w brain.md (sprawdź katalog ## sekcji powyżej — nie duplikuj), spekulacji. Lepiej nie zapisać niż zaśmiecić pamięć. Osobno: ULOTNY stan „na teraz" (nad czym user pracuje DZIŚ, bieżący stan projektu/środowiska) to NIE trwały fakt → memory_save({ephemeral:true, section:"user"|"environment", content:"..."}) dopisuje go do sekcji „Na teraz" w brain.md (nie tworzy notatki); gdy coś się zdezaktualizowało, w tym samym wywołaniu dodaj remove:"stary wpis", żeby je wyczyścić.' },
    { id: 'mem_dedup', group: 'pamiec', tool: 'memory_save',
      text: 'Brain.md to indeks pamięci — przed zapisem sprawdź istniejące notatki (katalog ## sekcji wyżej), nie duplikuj tematów.' },
    { id: 'skille', group: 'skille', tool: null, requiresSkills: true,
      text: 'Masz indeks skilli niżej — zadanie pasuje do opisu skilla → read(ścieżka przepisu) i wykonaj kroki, bez pytania. Skille manual-only tylko na wyraźne życzenie usera.' },
    // S28 (D4): reakcja na ping skrzynki to reguła zachowania (rdzeń), a nie opis narzędzia.
    // „Kiedy wysłać pocztę vs zdelegować" siedzi w `mcp.kom_send.desc` (D14) + furtce niżej.
    { id: 'kom_inbox', group: 'komunikator', tool: 'kom_read',
      text: 'Ping o nieprzeczytanych wiadomościach → kom_list() po nagłówki i kom_read(id) tylko dla tych, które wyglądają na istotne. Nie czytaj wszystkiego hurtem i nie kasuj poczty — skrzynkę sprząta user.' },
];

/**
 * FURTKA (D14) — ROZSZERZONE REGUŁY dla słabszych modeli (np. małe lokalne, słabo czytające opisy
 * narzędzi). Domyślnie OFF (settings.pkmAssistant.extendedPromptRules). ON → dokładane po rdzeniu jako
 * osobna sekcja. Zachowane pełne treści starych instrukcji (guidance „kiedy użyć narzędzia"),
 * przefiltrowane po dostępności narzędzia jak rdzeń. BEZ skill_use/skill_known (D17), file_write/
 * file_delete (approval/desc w kodzie), deleg_mandatory/strateg/multi/no_overkill (w delegate.desc),
 * comms_ask_user/art_skill_todo (dup/nudge).
 */
export const EXTENDED_RULES: DecisionTreeRule[] = [
    { id: 'mem_save',   group: 'pamiec', tool: 'memory_save',   text: '"zapamiętaj że..." → memory_save({name, description, type, content, why, how_to_apply}) — tworzy NOWĄ notatkę w brain/ i odświeża brain.md jako indeks; nie nadpisuje istniejących notatek.' },
    { id: 'mem_read',   group: 'pamiec', tool: 'read',          text: 'Gdy lista brain/ pokazuje konkretną notatkę → read(path:"nazwa.md", scope:"memory"). Czyta tylko pamięć aktualnego agenta.' },
    { id: 'mem_sum',    group: 'pamiec', tool: 'read',          text: 'Podsumowania sesji → read(path:"summaries/L1/plik.md", scope:"memory"). Czyta tylko aktualnego agenta.' },
    { id: 'mem_delete', group: 'pamiec', tool: 'memory_delete', text: '"zapomnij o..." → memory_delete(fact:"konkretny tekst/filename/opis") usuwa dokładnie jedną notatkę z brain/ i odświeża indeks; project_context wymaga archiwizacji z lekcjami.' },
    { id: 'file_mkdir', group: 'pliki', tool: 'create_folder',  text: 'create_folder(path) — tworzy folder + nadrzędne. UŻYWAJ przed write jeśli folder nie istnieje.' },
    { id: 'comms_delegate', group: 'komunikacja', tool: 'agent_delegate', text: 'Temat poza kompetencjami → agent_delegate (ZAWSZE podaj context_summary!).' },
    { id: 'art_plan_todo', group: 'artefakty', tool: 'artifact_create', text: 'Złożone zadanie do uzgodnienia → artifact_create(typ:"plan"); user komentuje/zatwierdza w notatce, wracasz i realizujesz. Bieżący postęp pracy dla siebie prowadź w todo.' },
    { id: 'kom_send', group: 'komunikator', tool: 'kom_send', text: 'Chcesz coś przekazać innemu agentowi „na później" → kom_send(to, subject, content). To poczta, nie rozmowa — adresat przeczyta przy swojej następnej sesji. Pilne przekazanie rozmowy TERAZ → agent_delegate.' },
];

/**
 * Wszystkie instrukcje (rdzeń + rozszerzone) — źródło dla UI overridów (profile_prompt) i resolvera.
 * Każda niesie `tier` ('core'|'extended'). Override `promptOverrides.decisionTreeInstructions[id]`
 * działa dla obu. Stare id (deleg_mandatory, skill_use, file_write, ...) już tu nie występują —
 * overridy na nie przestają matchować (świadome, D14).
 */
export const DECISION_TREE_DEFAULTS: DecisionTreeRule[] = [
    ...CORE_RULES.map(r => ({ ...r, tier: 'core' as const })),
    ...EXTENDED_RULES.map(r => ({ ...r, tier: 'extended' as const })),
];

/**
 * Rozstrzygnij instrukcje: factory + global override + agent override + custom (custom_*).
 * false = wyłącz (na dowolnym poziomie); string = podmień tekst. Zachowuje tier/requiresSkills.
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

        result.push({ id: def.id, group: def.group, tool: def.tool, text, tier: def.tier, requiresSkills: def.requiresSkills });
    }

    // Custom (custom_*) — traktowane jak rdzeń (always-on).
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
            result.push({ id: key, group: source.group || 'delegacja', tool: source.tool || null, text: source.text!, tier: 'core' });
        }
    }

    return result;
}

/**
 * Podziel rozstrzygnięte instrukcje na rdzeń (always-on) i rozszerzone (furtka), gatując po
 * dostępności narzędzia/skilli. Pure — zwraca obiekty instrukcji (render tekstu robi PromptBuilder).
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
