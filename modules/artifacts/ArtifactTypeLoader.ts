/**
 * ArtifactTypeLoader — biblioteka TYPÓW artefaktów żywych (E2.9 FAZA A / A2).
 *
 * Wzór: `modules/skills/SkillLoader.js` (adapter.list + `parseFrontmatter` + cache Map + seed
 * wbudowanych przy pierwszym starcie). Typ = plik `.pkm-assistant/artifacts/types/<nazwa>.md`:
 *   frontmatter meta (`nazwa`, `opis`, `pola{opis[,domyslne]}`, `statusy[]`, `sprzatanie` dni)
 *   + body = szablon ciała instancji (placeholdery `{{pole}}`).
 *
 * Body szablonu jest NIEPRZEZROCZYSTE (bez walidacji zawartości — tu WOLNO userowi mieć dataviewjs;
 * A3 decyzja z sesji). Agent nigdy nie pisze kodu do INSTANCJI (egzekwuje `artifactParser`), ale
 * SZABLON TYPU pisze user i może w nim osadzić dowolny kod.
 *
 * Klucze frontmattera PO POLSKU (decyzja A6, „raz na zawsze"). Wartości statusów to semantyczne
 * identyfikatory (B1 renderuje przyciski wg statusu) — NIE tłumaczone. Seed typu `plan` = makieta
 * z `Nauka/2026-07-23_sesja_projektowa_E2.9.md`, treść PL jako część kontraktu formatu.
 */
import { parseFrontmatter } from '../../core/index.js';
import { log } from '../../core/utils/Logger.js';
import type { ArtifactScalar, ArtifactType, ArtifactTypeField } from './types.js';

export const ARTIFACT_TYPES_PATH = '.pkm-assistant/artifacts/types';

/** Domyślny zestaw statusów, gdy typ nie deklaruje własnych. */
export const DEFAULT_STATUSY = ['szkic', 'zamkniety'];

/** Nazwa wbudowanego typu seedowanego przy starcie (sensowny default per agent). */
export const BUILTIN_PLAN_TYPE_NAME = 'plan';

/** Drugi wbudowany typ (E2.9 FAZA D): goła notatka/treść do akceptacji — pokrywa dawny idea_review. */
export const BUILTIN_NOTATKA_TYPE_NAME = 'notatka';

/** Trzeci wbudowany typ (E3.5): raport z researchu — cel skilli deep-research (web + vault). */
export const BUILTIN_RAPORT_TYPE_NAME = 'raport';

/** Zbiór nazw typów wbudowanych (seedowanych przy starcie). Użycie wyłącznie w tym pliku
 *  (fabryka dead-code D7, AUD-dead-code-077: `export` zdjęty, zero importerów spoza pliku). */
const BUILTIN_TYPE_NAMES = [BUILTIN_PLAN_TYPE_NAME, BUILTIN_NOTATKA_TYPE_NAME, BUILTIN_RAPORT_TYPE_NAME];

/**
 * Treść seedowanego typu `plan` (makieta zatwierdzona w sesji projektowej E2.9).
 * Body BEZ bloku przycisków — silnik store dokleja `pkm-artefakt` przy `create` (B1).
 */
export const PLAN_TYPE_CONTENT = `---
nazwa: plan
opis: Plan działania — agent proponuje, user zatwierdza przed robotą
pola:
  cel:
    opis: Jedno zdanie — po co ten plan istnieje
  termin:
    opis: Do kiedy (opcjonalnie)
statusy: [do-akceptacji, uwagi, zaakceptowany, zamkniety]
sprzatanie: 30
---

## Cel
{{cel}}

## Kroki
(agent wstawia kroki jako checkboxy)

## Ryzyka i założenia

## Uwagi usera
(strefa usera — agent czyta, nigdy nie nadpisuje)
`;

/**
 * Treść seedowanego typu `notatka` (E2.9 FAZA D) — goła treść do akceptacji (dawny idea_review:
 * post, brief, notatka). Sekcje Treść + Uwagi usera; statusy jak plan. Alias idea_review→
 * artifact_create{typ:'notatka'} wypełnia sekcję „Treść".
 */
export const NOTATKA_TYPE_CONTENT = `---
nazwa: notatka
opis: Notatka/treść do akceptacji — agent pisze, user przegląda i zatwierdza
statusy: [do-akceptacji, uwagi, zaakceptowany, zamkniety]
sprzatanie: 30
---

## Treść
(agent wpisuje treść)

## Uwagi usera
(strefa usera — agent czyta, nigdy nie nadpisuje)
`;

/**
 * Treść seedowanego typu `raport` (E3.5 Deep Research) — cel skilli deep-research-web/vault.
 * Statusy bez approval flow (raport się CZYTA, nie zatwierdza do wykonania): `w-trakcie` i `gotowy`
 * dostają generyczny guzik „Przywołaj agenta" (computeArtifactButtons), `zamkniety` domyka.
 * `sprzatanie: 0` — raporty się nie przedawniają (to wiedza, nie plan roboczy).
 *
 * ⚠️ Sekcja `## Białe plamy` dołożona po biegu live Poligonu (F2): przepis deep-research kazał
 * `artifact_update` tej sekcji, a typ jej NIE MIAŁ → `set_section` zawsze wracał `not_found`
 * i raport wychodził bez najcenniejszej wg przepisu części. `ensureBuiltinTypes` seeduje plik
 * TYLKO gdy nie istnieje (user authority), więc ISTNIEJĄCE vaulty tej sekcji nie dostaną —
 * dlatego przepisy mają jawny fallback na podsekcję `### Białe plamy` w „Ustaleniach".
 */
export const RAPORT_TYPE_CONTENT = `---
nazwa: raport
opis: Raport z researchu — agent bada temat i składa ustalenia z cytatami
pola:
  pytanie:
    opis: Badane pytanie / temat researchu
  tryb:
    opis: Źródło researchu — web albo vault
statusy: [w-trakcie, gotowy, zamkniety]
sprzatanie: 0
---

## TL;DR
(3-5 zdań esencji — agent wypełnia na końcu)

## Ustalenia
(sekcje tematyczne; każde twierdzenie z cytatem i źródłem)

## Białe plamy
(czego NIE udało się ustalić — luki w źródłach; to wynik, nie porażka)

## Źródła
(web: lista URL z tytułami · vault: wikilinki do notatek)

## Uwagi usera
(strefa usera — agent czyta, nigdy nie nadpisuje)
`;

interface ArtifactAdapter {
    exists(path: string): Promise<boolean>;
    list(path: string): Promise<{ files?: string[] } | null | undefined>;
    read(path: string): Promise<string>;
    mkdir(path: string): Promise<void>;
    write(path: string, content: string): Promise<void>;
}
interface ArtifactVault { adapter: ArtifactAdapter; }

export class ArtifactTypeLoader {
    declare vault: ArtifactVault;
    declare cache: Map<string, ArtifactType>;

    /**
     * @param {Object} vault - Obsidian Vault (używamy vault.adapter dla ukrytego `.pkm-assistant/`)
     */
    constructor(vault: ArtifactVault) {
        this.vault = vault;
        /** @type {Map<string, Object>} nazwa typu -> obiekt typu */
        this.cache = new Map();
    }

    /** Wczytaj wszystkie typy z biblioteki. */
    async loadAllTypes() {
        this.cache.clear();
        try {
            const exists = await this.vault.adapter.exists(ARTIFACT_TYPES_PATH);
            if (!exists) return;

            const listed = await this.vault.adapter.list(ARTIFACT_TYPES_PATH);
            const files = (listed?.files || []).filter((f: string) => /\.md$/i.test(f));
            for (const filePath of files) {
                try {
                    const raw = await this.vault.adapter.read(filePath);
                    const type = this._parseTypeFile(raw, filePath);
                    if (type) this.cache.set(type.name, type);
                } catch (e) {
                    log.warn('ArtifactTypeLoader', 'Nie udało się wczytać typu:', filePath, e);
                }
            }
            log.debug('ArtifactTypeLoader', `Wczytano ${this.cache.size} typów`);
        } catch (e) {
            log.error('ArtifactTypeLoader', 'Błąd ładowania typów:', e);
        }
    }

    /**
     * Sparsuj + zwaliduj plik typu.
     * @returns {Object|null} null gdy meta niepoprawna (brak `nazwa`/`opis`)
     */
    _parseTypeFile(raw: string, filePath: string): ArtifactType | null {
        if (!raw?.trim()) return null;
        const { frontmatter, content } = parseFrontmatter(raw) as {
            frontmatter: (Record<string, unknown> & { sprzatanie: number }) | null;
            content: string;
        };
        if (!frontmatter?.nazwa || !frontmatter?.opis) {
            log.warn('ArtifactTypeLoader', 'Typ bez wymaganych pól nazwa/opis:', filePath);
            return null;
        }

        const statusy = Array.isArray(frontmatter.statusy) && frontmatter.statusy.length > 0
            ? frontmatter.statusy.map(String)
            : [...DEFAULT_STATUSY];

        const sprzatanie = Number.isFinite(frontmatter.sprzatanie) ? Number(frontmatter.sprzatanie) : 0;

        return {
            name: String(frontmatter.nazwa),
            slug: filePath.split('/').pop()!.replace(/\.md$/i, ''),
            opis: String(frontmatter.opis),
            description: String(frontmatter.opis),
            pola: normalizeFields(frontmatter.pola),
            statusy,
            sprzatanie,
            template: content || '',
            path: filePath,
            builtin: BUILTIN_TYPE_NAMES.includes(String(frontmatter.nazwa)),
        };
    }

    /** @returns {Object|null} typ po nazwie */
    getType(name: string): ArtifactType | null {
        return this.cache.get(name) || null;
    }

    /** @returns {Object[]} wszystkie typy */
    getAllTypes(): ArtifactType[] {
        return Array.from(this.cache.values());
    }

    /**
     * Typy widoczne dla agenta. Brak/puste `artifact_types` → domyślnie tylko `plan` (A2).
     * @param {string[]|undefined} typeNames
     * @returns {Object[]}
     */
    getTypesForAgent(typeNames?: string[]): ArtifactType[] {
        if (!Array.isArray(typeNames) || typeNames.length === 0) {
            const plan = this.getType(BUILTIN_PLAN_TYPE_NAME);
            return plan ? [plan] : [];
        }
        return typeNames.map(n => this.getType(n)).filter(Boolean) as ArtifactType[];
    }

    /** Seed wbudowanych typów `plan` + `notatka` + `raport`, jeśli plik jeszcze nie istnieje (idempotentne). */
    async ensureBuiltinTypes() {
        try {
            if (!await this.vault.adapter.exists(ARTIFACT_TYPES_PATH)) {
                await this.vault.adapter.mkdir(ARTIFACT_TYPES_PATH);
            }
            const seeds = [
                [BUILTIN_PLAN_TYPE_NAME, PLAN_TYPE_CONTENT],
                [BUILTIN_NOTATKA_TYPE_NAME, NOTATKA_TYPE_CONTENT],
                [BUILTIN_RAPORT_TYPE_NAME, RAPORT_TYPE_CONTENT],
            ];
            for (const [name, content] of seeds) {
                const path = `${ARTIFACT_TYPES_PATH}/${name}.md`;
                if (await this.vault.adapter.exists(path)) continue;
                await this.vault.adapter.write(path, content);
                log.debug('ArtifactTypeLoader', `Zaseedowano wbudowany typ „${name}"`);
            }
        } catch (e) {
            log.error('ArtifactTypeLoader', 'Błąd seedowania typów wbudowanych:', e);
        }
    }

    async reloadTypes() {
        await this.loadAllTypes();
    }
}

/**
 * Znormalizuj deklarację pól typu do `{ <nazwa>: {opis, domyslne?} }`.
 * Opisy pól idą do agenta jak opisy narzędzi (A5).
 */
function normalizeFields(pola: unknown): Record<string, ArtifactTypeField> {
    const out: Record<string, ArtifactTypeField> = {};
    if (!pola || typeof pola !== 'object') return out;
    for (const [key, def] of Object.entries(pola)) {
        if (!key) continue;
        if (def && typeof def === 'object') {
            out[key] = {
                opis: (def as Record<string, unknown>).opis != null ? String((def as Record<string, unknown>).opis) : '',
                ...((def as Record<string, unknown>).domyslne != null
                    ? { domyslne: (def as Record<string, unknown>).domyslne as ArtifactScalar }
                    : {}),
            };
        } else {
            out[key] = { opis: def != null ? String(def) : '' };
        }
    }
    return out;
}
