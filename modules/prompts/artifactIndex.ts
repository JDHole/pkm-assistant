/**
 * artifactIndex.js — sekcja „artefakty żywe" do system promptu (E2.9 FAZA B / B3).
 *
 * Pure module (i18n + node-safe silnik artefaktów) → node-testowalny. Wzór:
 * `modules/prompts/skillIndex.js` (PromptBuilder przez łańcuch importów wciąga `obsidian`, więc
 * logika sekcji żyje osobno, żeby dało się ją pokryć testem).
 *
 * Dwie funkcje:
 *  - `buildArtifactIndex(types, artifacts)` — indeks podpiętych TYPÓW (`📄 typ: opis` + nagłówki
 *    sekcji szablonu) + lista artefaktów agenta w toku (status ≠ zamkniety; filtruje wołający).
 *    Budżet 2000 zn.
 *  - `buildActiveArtifactBlock(thin)` — AKTYWNY artefakt jako pełny chudy JSON (limit 4000 zn).
 */
import { t } from '../../core/i18n/index.js';
// Nagłówki sekcji szablonu liczymy TYM SAMYM parserem, którym patcher szuka sekcji
// (`findSection`) — własny regex tutaj rozjechałby się z silnikiem i indeks kłamałby modelowi.
import { parseArtifact } from '../artifacts/index.js';

/** Budżet znaków indeksu typów + listy artefaktów (nadmiar → „…i N kolejnych"). */
export const ARTIFACT_INDEX_MAX_CHARS = 2000;

/** Limit aktywnego artefaktu wstrzykiwanego do kontekstu (spec B3 = ARTIFACT_CONTEXT_MAX_CHARS). */
export const ACTIVE_ARTIFACT_MAX_CHARS = 4000;

interface ArtifactIndexType { name: string; opis?: string; description?: string; template?: string; }
interface ArtifactIndexEntry { id: string; tytul?: string; typ?: string; status?: string; }
interface ActiveArtifactItem { blockId?: string | null; text?: string; checked?: boolean; }
interface ActiveArtifactSection { heading?: string; text?: string; items?: ActiveArtifactItem[]; }
interface ActiveArtifact { id?: string | null; typ?: string | null; status?: string | null; frontmatter?: Record<string, unknown>; sections?: ActiveArtifactSection[]; }

/**
 * Zbuduj indeks typów + listę artefaktów agenta.
 * @param {Array<{name:string, opis?:string, description?:string}>} types - podpięte typy agenta
 * @param {Array<{id:string, tytul?:string, typ?:string, status?:string}>} artifacts - artefakty w toku
 * @param {number} [maxChars=ARTIFACT_INDEX_MAX_CHARS]
 * @returns {string} pusty string gdy brak typów i artefaktów
 */
export function buildArtifactIndex(types: unknown = [], artifacts: unknown = [], maxChars: number = ARTIFACT_INDEX_MAX_CHARS): string {
    const typeList: ArtifactIndexType[] = Array.isArray(types) ? types as ArtifactIndexType[] : [];
    const artList: ArtifactIndexEntry[] = Array.isArray(artifacts) ? artifacts as ArtifactIndexEntry[] : [];
    if (typeList.length === 0 && artList.length === 0) return '';

    const out: string[] = [];
    let used = 0;
    const push = (line: string) => { out.push(line); used += line.length + 1; };
    const fits = (line: string) => used + line.length + 1 <= maxChars;

    if (typeList.length > 0) {
        push(`${t('prompt.dt.your_artifact_types')}:`);
        for (const ty of typeList) {
            const opis = ty.opis || ty.description || t('prompt.dt.no_description');
            const line = `  📄 ${ty.name}: ${opis}`;
            if (!fits(line)) break;
            push(line);
            // Nagłówki szablonu — `heading` w `sekcje`/`artifact_update` musi trafić DOKŁADNIE
            // w jeden z nich, inaczej patch wraca `not_found`. Szablon bez nagłówków = brak linii.
            const headings = extractTemplateHeadings(ty.template);
            if (headings.length === 0) continue;
            const sub = `     ${t('prompt.dt.artifact_type_sections')}: ${headings.join(' · ')}`;
            if (fits(sub)) push(sub);
        }
    }

    if (artList.length > 0) {
        const header = `${t('prompt.dt.artifacts_in_progress')}:`;
        if (fits(header)) {
            push(header);
            let shown = 0;
            for (const a of artList) {
                const statusPart = a.status ? `, ${a.status}` : '';
                const line = `  • ${a.tytul || a.id} (${a.id}) — ${a.typ || '?'}${statusPart}`;
                // Zawsze pokaż co najmniej jeden (żeby lista nie była samym nagłówkiem).
                if (shown > 0 && !fits(line)) break;
                push(line);
                shown++;
            }
            const remaining = artList.length - shown;
            if (remaining > 0) push(`  ${t('prompt.dt.artifacts_more', { count: remaining })}`);
        }
    }

    return out.join('\n');
}

/**
 * Wyciągnij nazwy sekcji z szablonu typu (to, co `findSection` uzna za sekcję: nagłówki `#`/`##`).
 * @param {string} [template] - body pliku typu
 * @returns {string[]} puste, gdy szablon nie ma nagłówków
 */
function extractTemplateHeadings(template: unknown): string[] {
    if (typeof template !== 'string' || !template.trim()) return [];
    try {
        return parseArtifact(template).sections.map(s => s.heading).filter(Boolean);
    } catch {
        return []; // szablon usera bywa dowolny — indeks nie ma prawa wybuchnąć
    }
}

/**
 * Zbuduj blok aktywnego artefaktu (pełny chudy JSON).
 * @param {Object} thin - sparsowany stan artefaktu (z `ArtifactStore.read`)
 * @param {number} [maxChars=ACTIVE_ARTIFACT_MAX_CHARS]
 * @returns {string} pusty string gdy brak artefaktu
 */
export function buildActiveArtifactBlock(thin: unknown, maxChars: number = ACTIVE_ARTIFACT_MAX_CHARS): string {
    if (!thin || typeof thin !== 'object') return '';
    const slim = {
        id: (thin as ActiveArtifact).id || null,
        typ: (thin as ActiveArtifact).typ || null,
        status: (thin as ActiveArtifact).status || null,
        frontmatter: (thin as ActiveArtifact).frontmatter || {},
        sections: (Array.isArray((thin as ActiveArtifact).sections)
            ? (thin as ActiveArtifact).sections!
            : []).map(s => ({
            heading: s.heading,
            ...(s.text ? { text: s.text } : {}),
            items: (Array.isArray(s.items) ? s.items : []).map(i => ({
                blockId: i.blockId || null,
                text: i.text,
                checked: !!i.checked,
            })),
        })),
    };
    let json = JSON.stringify(slim, null, 2);
    if (json.length > maxChars) json = json.slice(0, maxChars) + `\n… ${t('prompt.dt.artifact_truncated')}`;
    return `${t('prompt.dt.active_artifact')}:\n\`\`\`json\n${json}\n\`\`\``;
}
