/**
 * ArtifactTypeLoader — biblioteka TYPÓW artefaktów żywych.
 *
 * Wzór: `modules/skills/SkillLoader.js` (adapter.list + `parseFrontmatter` + cache Map + seed
 * wbudowanych przy pierwszym starcie). Typ = plik `.pkm-assistant/artifacts/types/<nazwa>.md`:
 *   frontmatter meta (`nazwa`, `opis`, `pola{opis[,domyslne]}`, `statusy[]`, `sprzatanie` dni)
 *   + body = szablon ciała instancji (placeholdery `{{pole}}`).
 *
 * Body szablonu jest NIEPRZEZROCZYSTE (bez walidacji zawartości - tu WOLNO userowi mieć
 * dataviewjs). Agent nigdy nie pisze kodu do INSTANCJI (egzekwuje `artifactParser`), ale
 * SZABLON TYPU pisze user i może w nim osadzić dowolny kod.
 *
 * Klucze frontmattera PO POLSKU, raz na zawsze (`nazwa`/`opis`/`pola`/`statusy`/`sprzatanie`) -
 * to jest semantyka silnika, nie proza. Wartości STATUSÓW natomiast (od decyzji właściciela
 * 19.09) idą za językiem interfejsu W CHWILI SEEDOWANIA szablonu fabrycznego: nowy plik typu
 * EN dostaje literały EN (`pending-approval`, `accepted`, ...), nowy plik PL dostaje literały PL
 * (`do-akceptacji`, `zaakceptowany`, ...) - `modules/artifacts/artifactStatuses.ts` jest jedynym
 * rejestrem obu zestawów. Silnik (`artifactButtons.ts`, `ArtifactStore.archive()`,
 * `basesView.ts`) rozpoznaje OBA zestawy jednocześnie, więc typ usera może dalej mieszać
 * dowolne własne literały - one nadal działają jak identyfikatory silnika, po prostu bez
 * automatycznego rozpoznania roli (patrz `statusRole`/`pendingStatusOf`/`closedStatusOf`).
 *
 * TEKST DLA CZŁOWIEKA (opis typu, nagłówki sekcji, podpowiedzi w nawiasach) idzie za językiem
 * interfejsu: `builtinTypeContent(name)` wybiera wariant PL/EN, a nazwy sekcji trzyma
 * `artifactSections.ts` - ten sam rejestr, z którego korzystają alias `plan_review` i drzewo
 * decyzyjne, żeby adres patcha zgadzał się z nagłówkiem na dysku.
 */
import { parseFrontmatter } from '../../core/index.js';
import { getLocale } from '../../core/i18n/index.js';
import { log } from '../../core/utils/Logger.js';
import { statusLiteral } from './artifactStatuses.js';
import type { ArtifactScalar, ArtifactType, ArtifactTypeField } from './types.js';

export const ARTIFACT_TYPES_PATH = '.pkm-assistant/artifacts/types';

/**
 * Domyślny zestaw statusów, gdy typ nie deklaruje własnych - w JĘZYKU INTERFEJSU (domyślnie
 * bieżący). FUNKCJA, nie stała: `setLocale()` leci z `src/main.ts` PO załadowaniu modułów
 * (ten sam powód co `factoryWorkPrompt` w `modules/memory/workPrompts.ts`) - stała policzona
 * przy imporcie zamroziłaby jeden język dla każdego typu bez zadeklarowanych statusów.
 */
export function defaultStatusy(locale: string = getLocale()): string[] {
    const loc = locale === 'pl' ? 'pl' : 'en';
    return [statusLiteral('draft', loc), statusLiteral('closed', loc)];
}

/** Nazwa wbudowanego typu seedowanego przy starcie (sensowny default per agent). */
export const BUILTIN_PLAN_TYPE_NAME = 'plan';

/** Drugi wbudowany typ: goła notatka/treść do akceptacji. */
export const BUILTIN_NOTATKA_TYPE_NAME = 'notatka';

/** Trzeci wbudowany typ: raport z researchu - cel skilli deep-research (web + vault). */
export const BUILTIN_RAPORT_TYPE_NAME = 'raport';

/** Zbiór nazw typów wbudowanych (seedowanych przy starcie). Użycie wyłącznie w tym pliku,
 *  bez importerów spoza niego - `export` świadomie zdjęty. */
const BUILTIN_TYPE_NAMES = [BUILTIN_PLAN_TYPE_NAME, BUILTIN_NOTATKA_TYPE_NAME, BUILTIN_RAPORT_TYPE_NAME];

/**
 * Treść seedowanego typu `plan`.
 * Body BEZ bloku przycisków - silnik store dokleja `pkm-artefakt` przy `create`.
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
 * Treść seedowanego typu `notatka` - goła treść do akceptacji (post, brief, notatka).
 * Sekcje Treść + Uwagi usera; statusy jak plan. Alias idea_review→artifact_create{typ:'notatka'}
 * wypełnia sekcję „Treść".
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
 * Treść seedowanego typu `raport` - cel skilli deep-research-web/vault.
 * Statusy bez approval flow (raport się CZYTA, nie zatwierdza do wykonania): `w-trakcie` i `gotowy`
 * dostają generyczny guzik „Przywołaj agenta" (computeArtifactButtons), `zamkniety` domyka.
 * `sprzatanie: 0` - raporty się nie przedawniają (to wiedza, nie plan roboczy).
 *
 * Sekcja `## Białe plamy` musi tu być: przepis deep-research woła `artifact_update` na tej
 * sekcji, a bez niej w typie `set_section` zawsze wraca `not_found` i raport wychodzi bez
 * najcenniejszej wg przepisu części. `ensureBuiltinTypes` seeduje plik TYLKO gdy nie istnieje
 * (user authority), więc ISTNIEJĄCE vaulty tej sekcji nie dostaną automatycznie - dlatego przepisy
 * mają jawny fallback na podsekcję `### Białe plamy` w „Ustaleniach".
 *
 * (Od 2.2.5 `ensureBuiltinTypes` podmienia plik też wtedy, gdy jest CO DO ZNAKU tekstem
 * fabrycznym drugiego języka - ale tylko wtedy. Vault z RĘCZNIE zmienionym szablonem nadal
 * nie dostaje niczego automatycznie, więc fallback zostaje.)
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

/**
 * Angielskie bliźniaki trzech tekstów wyżej. Klucze frontmattera (`nazwa`/`opis`/`pola`/
 * `statusy`/`sprzatanie`) i identyfikatory typów (`plan`/`notatka`/`raport`) zostają te same w
 * obu językach - to semantyka silnika, nie tłumaczenie. Wartości STATUSÓW natomiast (od
 * 19.09) SĄ tłumaczone - `modules/artifacts/artifactStatuses.ts` (`pending-approval`/`remarks`/
 * `accepted`/`closed`/`in-progress`/`ready` zamiast `do-akceptacji`/`uwagi`/`zaakceptowany`/
 * `zamkniety`/`w-trakcie`/`gotowy`) - silnik rozpoznaje oba zestawy jednocześnie.
 */
export const PLAN_TYPE_CONTENT_EN = `---
nazwa: plan
opis: Action plan — the agent proposes, you approve before any work starts
pola:
  cel:
    opis: One sentence — why this plan exists
  termin:
    opis: Due date (optional)
statusy: [pending-approval, remarks, accepted, closed]
sprzatanie: 30
---

## Goal
{{cel}}

## Steps
(the agent adds the steps as checkboxes)

## Risks and assumptions

## User notes
(your space — the agent reads it, never overwrites it)
`;

export const NOTATKA_TYPE_CONTENT_EN = `---
nazwa: notatka
opis: A note or piece of text for approval — the agent writes, you review and approve
statusy: [pending-approval, remarks, accepted, closed]
sprzatanie: 30
---

## Content
(the agent writes the content here)

## User notes
(your space — the agent reads it, never overwrites it)
`;

export const RAPORT_TYPE_CONTENT_EN = `---
nazwa: raport
opis: Research report — the agent investigates a topic and assembles findings with quotes
pola:
  pytanie:
    opis: The question / topic under research
  tryb:
    opis: Research source — web or vault
statusy: [in-progress, ready, closed]
sprzatanie: 0
---

## TL;DR
(3-5 sentences of essence — the agent fills this in at the end)

## Findings
(thematic sections; every claim with a quote and its source)

## Blind spots
(what could NOT be established — gaps in the sources; this is a result, not a failure)

## Sources
(web: list of URLs with titles · vault: wikilinks to notes)

## User notes
(your space — the agent reads it, never overwrites it)
`;

/** Nazwa typu wbudowanego - zawężenie, żeby `builtinTypeContent` nie brało dowolnego stringa. */
export type BuiltinTypeName = 'plan' | 'notatka' | 'raport';

/** Teksty fabryczne per język. Jedyny czytelnik: `builtinTypeContent` niżej. */
const BUILTIN_TYPE_CONTENT = {
    pl: { plan: PLAN_TYPE_CONTENT, notatka: NOTATKA_TYPE_CONTENT, raport: RAPORT_TYPE_CONTENT },
    en: { plan: PLAN_TYPE_CONTENT_EN, notatka: NOTATKA_TYPE_CONTENT_EN, raport: RAPORT_TYPE_CONTENT_EN },
} as const;

/**
 * Tekst fabryczny typu wbudowanego w podanym języku (domyślnie: bieżący język interfejsu).
 * Locale czytany PRZY WYWOŁANIU - `setLocale()` leci w `src/main.ts` po imporcie modułów.
 */
export function builtinTypeContent(name: BuiltinTypeName, locale: string = getLocale()): string {
    return BUILTIN_TYPE_CONTENT[locale === 'pl' ? 'pl' : 'en'][name];
}

/**
 * Porównanie „czy to nadal goły tekst fabryczny": końce linii z dysku bywają CRLF (Windows,
 * sync), a edytory lubią doklejać/zjadać biały znak na końcu pliku. Sama TREŚĆ sekcji musi się
 * zgadzać co do znaku - inaczej plik jest już dziełem usera i nikt go nie rusza.
 */
function normalizeSeed(text: string): string {
    return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd();
}

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
            : defaultStatusy();

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

    /**
     * Seed wbudowanych typów `plan` + `notatka` + `raport` w JĘZYKU INTERFEJSU (idempotentne).
     *
     * Trzy przypadki, w tej kolejności:
     *  1. plik nie istnieje → zapis tekstu fabrycznego w bieżącym języku;
     *  2. plik istnieje i jest CO DO ZNAKU tekstem fabrycznym DRUGIEGO języka (user go nigdy
     *     nie tknął, a język interfejsu się zmienił) → podmiana na bieżący język;
     *  3. cokolwiek innego → plik zostaje nietknięty. Szablon typu to dokument usera
     *     (wolno mu tam mieć nawet dataviewjs) i nikt go nie nadpisuje.
     */
    async ensureBuiltinTypes() {
        try {
            if (!await this.vault.adapter.exists(ARTIFACT_TYPES_PATH)) {
                await this.vault.adapter.mkdir(ARTIFACT_TYPES_PATH);
            }
            const locale = getLocale();
            const otherLocale = locale === 'pl' ? 'en' : 'pl';
            const names: BuiltinTypeName[] = [
                BUILTIN_PLAN_TYPE_NAME,
                BUILTIN_NOTATKA_TYPE_NAME,
                BUILTIN_RAPORT_TYPE_NAME,
            ];
            for (const name of names) {
                const path = `${ARTIFACT_TYPES_PATH}/${name}.md`;
                const content = builtinTypeContent(name, locale);
                if (!await this.vault.adapter.exists(path)) {
                    await this.vault.adapter.write(path, content);
                    log.debug('ArtifactTypeLoader', `Zaseedowano wbudowany typ „${name}"`);
                    continue;
                }
                const current = await this.vault.adapter.read(path);
                if (normalizeSeed(current) !== normalizeSeed(builtinTypeContent(name, otherLocale))) continue;
                await this.vault.adapter.write(path, content);
                log.debug('ArtifactTypeLoader', `Nietknięty typ „${name}" przełożony na język interfejsu`);
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
