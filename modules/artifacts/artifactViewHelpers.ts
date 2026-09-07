/**
 * artifactViewHelpers.js — czyste helpery widoku artefaktów (E2.9 FAZA C / C1+C2).
 *
 * Logika listowania / sortowania / pozycji pickera i podpinania TYPÓW wyniesiona z UI, żeby była
 * node-testowalna (bez importu `obsidian`, bez DOM). UI (zakładka panelu agenta + segment slim bara)
 * używa tych funkcji do zbudowania wierszy; samo rysowanie DOM zostaje w modułach agents/chat.
 *
 * Wszystkie funkcje są PURE: nie mutują wejścia, zwracają nowe struktury.
 */

/**
 * Posortuj artefakty do widoku: najświeżej zaktualizowane na górze, tie-break po tytule.
 * Daty to stringi `YYYY-MM-DD` (leksykalne porównanie = chronologiczne). Brak `zaktualizowano`
 * → fallback `utworzono`; brak obu → na koniec.
 * @param {Array<Object>} list - wpisy z `ArtifactStore.list`
 * @returns {Array<Object>} nowa, posortowana tablica
 */
interface ArtifactListEntry { id: string; tytul?: string; typ?: string | null; status?: string | null; utworzono?: string; zaktualizowano?: string; }

export function sortArtifactsForView(list: unknown): ArtifactListEntry[] {
    const arr: ArtifactListEntry[] = Array.isArray(list) ? [...list as ArtifactListEntry[]] : [];
    return arr.sort((a, b) => {
        const da = (a && (a.zaktualizowano || a.utworzono)) || '';
        const db = (b && (b.zaktualizowano || b.utworzono)) || '';
        if (da !== db) return db < da ? -1 : 1; // desc (świeższe pierwsze; '' na koniec)
        const ta = (a && a.tytul) || '';
        const tb = (b && b.tytul) || '';
        return ta.localeCompare(tb);
    });
}

/**
 * Zbuduj pozycje pickera artefaktów (segment slim bara): posortowane wiersze + flaga aktywnego.
 * @param {Array<Object>} list - wpisy z `ArtifactStore.list`
 * @param {string|null} [currentArtifactId] - id aktywnego artefaktu tej rozmowy
 * @returns {{items: Array<{id,tytul,typ,status,active}>, hasActive: boolean}}
 */
export function buildArtifactPickerItems(list: unknown, currentArtifactId: string | null = null) {
    const sorted = sortArtifactsForView(list);
    const items = sorted.map(a => ({
        id: a.id,
        tytul: a.tytul || a.id,
        typ: a.typ || null,
        status: a.status || null,
        active: !!currentArtifactId && a.id === currentArtifactId,
    }));
    return { items, hasActive: items.some(i => i.active) };
}

/**
 * Przełącz nazwę typu w liście podpiętych (dodaj gdy brak, usuń gdy jest). Dedupe + tylko stringi.
 * @param {Array<string>} names - obecne `artifact_types` agenta
 * @param {string} name - nazwa typu do przełączenia
 * @returns {Array<string>} nowa lista
 */
export function toggleTypeName(names: unknown, name: unknown): string[] {
    const seen = new Set<string>();
    const base: string[] = [];
    for (const n of (Array.isArray(names) ? names : [])) {
        if (typeof n === 'string' && n && !seen.has(n)) { seen.add(n); base.push(n); }
    }
    if (typeof name !== 'string' || !name) return base;
    if (seen.has(name)) return base.filter(n => n !== name);
    return [...base, name];
}

/**
 * Zbuduj wiersze checkboxów TYPÓW (sekcja „podpięte typy" w zakładce): każdy typ z biblioteki
 * + flaga `checked` (czy w `artifact_types` agenta).
 * @param {Array<Object>} allTypes - z `ArtifactTypeLoader.getAllTypes()`
 * @param {Array<string>} assignedNames - `agent.artifact_types`
 * @returns {Array<{name,opis,checked,builtin}>}
 */
export function buildTypeCheckboxRows(allTypes: unknown, assignedNames: unknown) {
    const assigned = new Set(Array.isArray(assignedNames) ? assignedNames.filter(n => typeof n === 'string') : []);
    return (Array.isArray(allTypes) ? allTypes : [])
        .map(tp => ({
            name: tp && tp.name,
            opis: (tp && (tp.opis || tp.description)) || '',
            checked: assigned.has(tp && tp.name),
            builtin: !!(tp && tp.builtin),
        }))
        .filter(r => typeof r.name === 'string' && r.name);
}
