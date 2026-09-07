/**
 * visibility.js — JEDNO ŹRÓDŁO PRAWDY „kto uczestniczy w komunikatorze" (S28 D6).
 *
 * Model: zamiast szlabanu „kto może pisać do kogo" (dawne `can_message`, skasowane w E2.8 F7)
 * agent ma jeden przełącznik `komunikator_visible` (default `true`). Wyłączony agent jest
 * DUCHEM: nie ma go na liście adresatów w UI ani w opisie narzędzia `kom_send`, jego skrzynka
 * znika z paneli, ping o nim milczy, a wysyłka do niego zwraca ten sam błąd co literówka
 * w nazwie („nieznany adresat") — zero przecieku, że w ogóle istnieje.
 *
 * Moduł jest PURE (zero importów obsidian) — dzięki temu jest node-testowalny i mogą go
 * deep-importować narzędzia z `modules/tools/`, omijając obsidian-owy barrel komunikatora
 * (ten sam wzór co `artifactParser` w `TodoTool`).
 */

/**
 * Czy agent uczestniczy w komunikatorze.
 * Brak pola = uczestniczy (nowe pole nie może wyłączyć starych agentów).
 * @param {Object} agent
 * @returns {boolean}
 */
export type KomunikatorAgentLike = { name?: string; komunikator_visible?: unknown };
export type KomunikatorAgentManagerLike = { getAllAgents?: () => KomunikatorAgentLike[] };

export function isKomunikatorVisible(agent: KomunikatorAgentLike | null | undefined): boolean {
    return agent?.komunikator_visible !== false;
}

/**
 * Lista agentów widocznych w komunikatorze.
 * @param {Object} agentManager
 * @returns {Array<Object>}
 */
export function listKomunikatorAgents(agentManager: KomunikatorAgentManagerLike | null | undefined): KomunikatorAgentLike[] {
    const agents = agentManager?.getAllAgents?.() || [];
    return agents.filter(isKomunikatorVisible);
}

/**
 * Nazwy agentów widocznych w komunikatorze (schema/opis narzędzia, listy w UI).
 * @param {Object} agentManager
 * @returns {string[]}
 */
export function listKomunikatorAgentNames(agentManager: KomunikatorAgentManagerLike | null | undefined): string[] {
    return listKomunikatorAgents(agentManager).map(a => a.name).filter(Boolean) as string[];
}

/**
 * Znajdź WIDOCZNEGO adresata po nazwie. Dopasowanie dokładne, a gdy nie ma — bez
 * uwzględniania wielkości liter (modele nagminnie mylą case). Niewidzialny agent nigdy
 * się tu nie pojawi, więc caller nie musi wiedzieć, czy nazwa jest zła, czy agent jest duchem.
 * @param {Object} agentManager
 * @param {string} name
 * @returns {Object|null}
 */
export function findKomunikatorAgent(agentManager: KomunikatorAgentManagerLike | null | undefined, name: string): KomunikatorAgentLike | null {
    const wanted = String(name || '').trim();
    if (!wanted) return null;
    const visible = listKomunikatorAgents(agentManager);
    return visible.find(a => a.name === wanted)
        || visible.find(a => String(a.name).toLowerCase() === wanted.toLowerCase())
        || null;
}
