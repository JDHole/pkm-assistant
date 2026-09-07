/**
 * AccessGuard — Whitelist-based access control for agents.
 *
 * Filozofia: agent widzi TYLKO foldery/pliki z focusFolders.
 * Reszta vaulta NIE ISTNIEJE. Puste focusFolders = zero dostępu do zwykłego vaulta.
 *
 * .pkm-assistant/ obsługiwany osobno — memory tools (memory_save, memory_delete, memory_sessions, memory_summaries)
 * mają własny dostęp, vault tools NIE sięgają do .pkm-assistant/.
 * Wyjątek: playbook.md i vault_map.md agenta — zawsze widoczne.
 */

import { log } from '../utils/Logger.js';
import { t } from '../i18n/index.js';
import { expandFocusEntries } from './vaultGroups.js';
import { sanitizePath } from './keySanitizer.js';
import { getAgentSafeName } from '../utils/agentSlug.js';
import { globPatternToRegex } from './globPattern.js';
import type { FocusEntry, FocusFolder, VaultGroup } from './vaultGroups.js';

/** Minimalny kształt błędu w `catch` (err jest `unknown`). */

/** Werdykt strażnika: wpuścić czy nie, i dlaczego (`reason` bywa pokazywany modelowi/userowi). */
export interface AccessDecision {
    allowed: boolean;
    reason: string;
}

/**
 * Kształt agenta, jakiego POTRZEBUJE strażnik — świadomie strukturalny wycinek klasy `Agent`
 * (`modules/agents`), żeby core nie zależał od modułu. Typ jest NIE-nullowalny: `agent?.` w ciele
 * to pas bezpieczeństwa dla wołaczy z .js, a nie zaproszenie do podawania `null`.
 */
export interface GuardedAgent {
    name?: string;
    admin_access?: boolean;
    focusFolders?: FocusEntry[] | null;
    permissions?: { guidance_mode?: boolean } | null;
}

/**
 * Foldery `scope.folders` sub-agenta. Stary JSDoc mówił `string[]`, ale `_isInSubScope` czyta
 * też `entry?.path` — czyli realnie przechodzą tędy również wpisy obiektowe.
 */
export type ScopeFolders = Array<string | FocusFolder>;

/** Dodatkowe opcje sprawdzenia dostępu (S33 Z1 / A1 / K13). */
export interface AccessCheckOptions {
    scopeFolders?: ScopeFolders | null;
    /**
     * K13/K14: czy `targetPath` jest ŚCIEŻKĄ VAULTOWĄ (a nie zapytaniem, adresem URL czy
     * adresatem wiadomości). Domyślnie `true` — fail-closed, bo nowy wołacz najczęściej
     * przyjdzie ze ścieżką i ma dostać pełną ocenę bez proszenia się o nią.
     *
     * `false` mówi strażnikowi: „to w ogóle nie jest ścieżka" — i od K14 (2026-08-23)
     * oznacza NATYCHMIASTOWE `{ allowed: true, reason: 'non-vault-target' }`, przed
     * kanonizacją i przed każdą bramką ścieżkową. Podaje je `PermissionSystem` dla akcji
     * nie-vaultowych (`web.*`, `agent.message`, `delegate`, `external.call`).
     *
     * Do K14 flaga wyłączała samą kanonizację, a No-Go i whitelista `focusFolders` dalej
     * mierzyły zapytanie jak ścieżkę — agent „Tylko przypisane" tracił przez to wyszukiwarkę,
     * pocztę i delegację. Uzasadnienie i lista właściwych bramek: komentarz w `checkAccess`.
     */
    targetIsVaultPath?: boolean;
}

/** Element wyniku, z którego domyślny ekstraktor ścieżek wyciąga `path`. */
interface PathBearing {
    path?: string;
}

export class AccessGuard {

    /** No-Go folders — set once at plugin init */
    static _noGoFolders: string[] = [];

    /** Vault folder groups (E2.8 B1) — set at init + on settings change */
    static _vaultGroups: VaultGroup[] = [];

    /** Compiled regex cache for _matchesEntry patterns */
    static _regexCache: Map<string, RegExp> = new Map();

    /** Hardcoded system No-Go — blocked unless agent has explicit admin_access.
     *  .obsidian/ = cala konfiguracja Obsidiana — domyslnie zablokowana.
     *  .trash = kosz Obsidiana — bez sensu dawac dostep.
     *  User moze dodac konkretne podfoldery .obsidian/ do whitelist agenta jesli potrzebuje. */
    static SYSTEM_NO_GO = ['.obsidian', '.trash'];

    /** Obsidian config folder — user-configurable, not always `.obsidian`. */
    static _configDir = '.obsidian';

    /**
     * Honor Vault#configDir (catalog guideline): the config folder can be renamed
     * by the user, and the renamed folder must stay No-Go. Called from main.js init.
     * @param dir - `unknown`, bo wartość idzie wprost z API Obsidiana / ustawień, a metoda
     *   sama sprawdza `typeof` zanim jej dotknie.
     */
    static setConfigDir(dir: unknown): void {
        if (dir && typeof dir === 'string') {
            AccessGuard._configDir = dir.replace(/\\/g, '/').replace(/\/$/, '');
        }
    }

    /**
     * Set global No-Go folders (called at plugin load and from settings).
     * The config folder and .trash are ALWAYS included — hardcoded, not removable.
     * @param folders
     */
    static setNoGoFolders(folders: string[] | null | undefined): void {
        // K1: wpis No-Go i porównywana ścieżka MUSZĄ przejść tę samą normalizację, inaczej
        // „./Prywatne/" z ustawień nie łapie „Prywatne/x.md" z argumentów modelu.
        // K15: tą normalizacją jest `_normalizeForDenyCompare` — wpisy lądują tu złożone
        // z małych liter, więc „Prywatne/" i „prywatne" to JEDEN wpis, a nie dwa.
        const userFolders = (folders || []).map(f => AccessGuard._normalizeForDenyCompare(f));
        // Merge: hardcoded system No-Go + real config dir + user No-Go (deduplicate)
        const all = [...AccessGuard.SYSTEM_NO_GO, AccessGuard._configDir, ...userFolders]
            .map(f => AccessGuard._normalizeForDenyCompare(f))
            .filter(Boolean);
        AccessGuard._noGoFolders = [...new Set(all)];
    }

    /**
     * K1 — lekka normalizacja KSZTAŁTU ścieżki do porównania (nie mylić z `sanitizePath`).
     *
     * Robi dokładnie tyle, ile trzeba, żeby dwa zapisy tej samej ścieżki dały ten sam ciąg:
     * `\` → `/`, kolaps `//`, ucięcie wiodących/końcowych `/`, wycięcie segmentów `.`.
     * ŚWIADOMIE NIE dekoduje `%XX` — to robi `sanitizePath` warstwę wyżej.
     *
     * WIELKOŚCI LITER NIE RUSZA — i to jest wybór, nie przeoczenie. Ta funkcja jest
     * wspólną podstawą dla obu stron bramki, a strony te celowo różnią się wrażliwością:
     *
     *   • bramka ZAKAZU (No-Go) → `_normalizeForDenyCompare`, czyli TEN kształt
     *     PLUS złożenie liter (`toLowerCase`). Zakaz ma łapać za dużo, nie za mało;
     *   • bramka ZEZWOLENIA (whitelista `focusFolders`, `scope.folders` suba) → własne
     *     dopasowanie w `_matchesEntry`, DOSŁOWNE co do wielkości liter. Zezwolenie ma
     *     wpuszczać za mało, nie za dużo: literówka w ustawieniach kończy się odmową,
     *     a nie cichym poszerzeniem obszaru agenta.
     *
     * Oba kierunki są fail-closed — po prostu „bezpiecznie" znaczy dla nich co innego.
     * @private
     */
    static _normalizeForCompare(p: string | null | undefined): string {
        if (!p || typeof p !== 'string') return '';
        return p.replace(/\\/g, '/').split('/').filter(c => c !== '' && c !== '.').join('/');
    }

    /**
     * K15 (AUD-security-101) — normalizacja do porównania z bramką ZAKAZU (No-Go).
     *
     * `_normalizeForCompare` porównywał ścieżkę ze strefą No-Go bajt w bajt, z komentarzem
     * „vault bywa case-sensitive". Problem: Windows i macOS wielkości liter NIE rozróżniają,
     * więc `Projekty/prywatne/tajne.md` przechodził bramkę na zielono, choć
     * `Projekty/Prywatne/tajne.md` był odrzucany — a to JEDEN I TEN SAM PLIK. To samo
     * dotyczyło `SYSTEM_NO_GO` (`.Obsidian/workspace.json`, `.TRASH/x.md`). No-Go było
     * jedyną bramką ścieżkową fail-OPEN na wielkość liter; `isProtectedPath`
     * (`keySanitizer.ts`) składa litery od zawsze i dlatego luki nie miał.
     *
     * Ta funkcja robi więc DOKŁADNIE to samo co `isProtectedPath`: `\` → `/`, `NFC`,
     * `toLowerCase()` — a na to nakłada kształt z `_normalizeForCompare` (puste segmenty
     * i `.` wypadają).
     *
     * Cena na vaultcie NAPRAWDĘ case-sensitive (Linux): zakaz obejmie też „sąsiada"
     * różniącego się jedną literą — folder `prywatne/` obok `Prywatne/` stanie się
     * niedostępny, choć user zakazał tylko jednego. Świadomie zaakceptowane: lepiej
     * zakazać za dużo niż wypuścić plik, który miał być zakazany.
     * @private
     */
    static _normalizeForDenyCompare(p: string | null | undefined): string {
        if (!p || typeof p !== 'string') return '';
        return AccessGuard._normalizeForCompare(p.replace(/\\/g, '/').normalize('NFC').toLowerCase());
    }

    /**
     * Set the global vault folder groups (E2.8 B1). Called at plugin init and whenever the user
     * edits groups in Settings→Vault, so `{group}` references in agent focus folders resolve live.
     * @param groups
     */
    static setVaultGroups(groups: VaultGroup[] | null | undefined): void {
        AccessGuard._vaultGroups = Array.isArray(groups) ? groups : [];
    }

    /**
     * Check if a path is in the No-Go zone.
     *
     * K15: porównanie idzie BEZ rozróżniania wielkości liter (patrz
     * `_normalizeForDenyCompare`). To jedyne miejsce, w którym pytamy „czy to strefa
     * zakazana" — wołacze poza `PermissionSystem` (m.in. bramka załączników w
     * `modules/chat/chat/chat_model.ts`) dostają tę samą regułę przez tę funkcję.
     */
    static _isNoGo(targetPath: string | null | undefined): boolean {
        if (!targetPath || AccessGuard._noGoFolders.length === 0) return false;
        // K1: cel w tej samej normalizacji co wpisy (patrz `_normalizeForDenyCompare`).
        const norm = AccessGuard._normalizeForDenyCompare(targetPath);
        if (!norm) return false;
        return AccessGuard._noGoFolders.some(ng =>
            norm === ng || norm.startsWith(ng + '/')
        );
    }

    /**
     * S33 Z1 — bariera scope sub-agenta (`scope.folders` z SUB_AGENT.yaml).
     *
     * Do tej pory `scope` był WYŁĄCZNIE tekstem w prompcie suba — model mógł go zignorować
     * i sięgnąć wszędzie tam, gdzie sięgał rodzic. Teraz foldery są realną, KONIUNKCYJNĄ
     * bramką: ścieżka w zwykłym vaulcie musi przejść zarówno reguły rodzica, jak i ten filtr.
     *
     * Świadome granice:
     * - `.pkm-assistant/**` NIE jest objęte — tam rządzi wyłącznie `_checkPkmPath` rodzica
     *   (pamięć/skille/artefakty suba to nie „foldery robocze").
     * - No-Go i pliki chronione zostają nietknięte (są warstwą wyżej / obok).
     * - `admin_access` rodzica NIE zwalnia z tej bariery — dlatego sprawdzenie idzie PRZED
     *   skrótem admina (fail-closed: sub admina nadal siedzi w swoim kącie).
     *
     * @private
     * @param targetPath
     * @param scopeFolders
     * @returns obiekt odmowy albo null (brak zastrzeżeń)
     */
    static _checkSubScope(
        targetPath: string | null | undefined,
        scopeFolders: ScopeFolders | null | undefined,
    ): AccessDecision | null {
        if (AccessGuard._isInSubScope(targetPath, scopeFolders)) return null;

        log.debug('AccessGuard', `SUB-SCOPE BLOCKED: ${targetPath} (poza scope.folders suba)`);
        return {
            allowed: false,
            // Asercja, nie `?.`: dotarcie tutaj oznacza, że `_isInSubScope` zwróciło false,
            // a to jest możliwe WYŁĄCZNIE dla niepustej tablicy (patrz jej pierwsze dwie linie).
            reason: t('security.sub_scope_denied', { path: targetPath, folders: (scopeFolders as ScopeFolders).join(', ') })
        };
    }

    /**
     * S33 A1 — czysty predykat bariery scope suba (bez logu i bez i18n), żeby ta sama
     * reguła mogła obsłużyć POJEDYNCZE sprawdzenie (`checkAccess`) i HURTOWE cięcie wyników
     * (`filterResults`). Bez tego `search`/`list` oddawały subowi nagłówki i excerpty
     * z całego obszaru rodzica, choć otwarcie tych plików było dla niego zablokowane.
     *
     * @private
     * @param targetPath
     * @param scopeFolders
     * @returns true = ścieżka mieści się w scope (albo scope nie obowiązuje)
     */
    static _isInSubScope(
        targetPath: string | null | undefined,
        scopeFolders: ScopeFolders | null | undefined,
    ): boolean {
        if (!Array.isArray(scopeFolders) || scopeFolders.length === 0) return true;
        // Brak ścieżki = akcja bez celu vaultowego (web, delegate, external) — nie nasza sprawa.
        if (!targetPath) return true;

        const norm = String(targetPath).replace(/\\/g, '/');
        // `.pkm-assistant/**` zostaje przy regułach rodzica (`_checkPkmPath`) — pamięć/skille
        // /artefakty suba to nie „foldery robocze".
        if (norm === '.pkm-assistant' || norm.startsWith('.pkm-assistant/')) return true;

        for (const entry of scopeFolders) {
            const pattern = typeof entry === 'string' ? entry : entry?.path;
            if (pattern && AccessGuard._matchesEntry(norm, pattern)) return true;
        }
        return false;
    }

    /**
     * K11 (AUD-security-008) — PRZECIĘCIE dwóch zakresów folderów.
     *
     * Delegacja piętro niżej liczyła zakres wyłącznie z configu dziecka, więc wnuk odpalony
     * przez wąskiego suba (`scope.folders: ['Publiczne']`) startował z zakresem `null`,
     * czyli z pełnymi uprawnieniami agenta-rodzica. Zakres dziecka NIGDY nie może być
     * szerszy niż zakres tego, kto je zleca — stąd ta funkcja.
     *
     * Reguła na parę wpisów: zostaje ten WĘŻSZY (ten, który mieści się w drugim, liczone
     * tą samą metodą co bramka ścieżek — `_matchesEntry`). Wpisy rozłączne wypadają.
     *
     * @param caller foldery zlecającego (`null`/pusta = nie zawęża)
     * @param child foldery zlecanego (`null`/pusta = nie zawęża)
     * @returns `null` = żadna strona nie zawęża (zero nowych ograniczeń);
     *   niepusta lista = przecięcie; **pusta lista = zakresy ROZŁĄCZNE** — wołacz ma
     *   odmówić fail-closed (nie ma ani jednego folderu wspólnego dla obu stron).
     */
    static intersectScopeFolders(
        caller: ScopeFolders | null | undefined,
        child: ScopeFolders | null | undefined,
    ): ScopeFolders | null {
        const clean = (list: ScopeFolders | null | undefined): string[] => (Array.isArray(list) ? list : [])
            .map(entry => (typeof entry === 'string' ? entry : entry?.path))
            .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
            .map(p => p.replace(/\\/g, '/').replace(/\/$/, ''));

        const c = clean(caller);
        const s = clean(child);
        if (c.length === 0) return s.length > 0 ? s : null;
        if (s.length === 0) return c;

        const out = new Set<string>();
        for (const a of c) {
            for (const b of s) {
                // `b` mieści się w `a` → węższy jest `b`; i symetrycznie. Równe wpisy trafią
                // oboma gałęziami do Setu jako jedna wartość.
                if (AccessGuard._matchesEntry(b, a)) out.add(b);
                else if (AccessGuard._matchesEntry(a, b)) out.add(a);
            }
        }
        return [...out];
    }

    /**
     * Check if agent can access a given path.
     * @param agent - Agent object with focusFolders
     * @param targetPath - path being accessed
     * @param accessLevel - required access level
     * @param opts - Extra options
     * @param opts.scopeFolders - S33 Z1: foldery scope sub-agenta (koniunkcja z
     *   regułami rodzica). Brak/pusta lista = zero nowych ograniczeń.
     * @param opts.targetIsVaultPath - K13/K14: `false` = cel NIE jest ścieżką (zapytanie, URL,
     *   adresat) → strażnik wraca od razu z `non-vault-target`, bez kanonizacji i bez bramek
     *   ścieżkowych. Domyślnie `true`.
     */
    static checkAccess(
        agent: GuardedAgent,
        targetPath: string | null | undefined,
        accessLevel: 'read' | 'write' = 'read',
        opts: AccessCheckOptions = {},
    ): AccessDecision {
        // K14 (2026-08-23): cel, który NIE JEST ŚCIEŻKĄ, nie ma czego szukać w bramce ścieżek.
        //
        // K13 wprowadziło `targetIsVaultPath`, ale używało go WYŁĄCZNIE do pominięcia
        // kanonizacji — No-Go, pliki chronione, whitelista `focusFolders` i bariera
        // `scope.folders` suba dalej mierzyły zapytanie/adres/adresata jak ścieżkę. Skutkiem
        // było to, że agent w trybie „Tylko przypisane" z whitelistą `['A/']` dostawał na
        // `web_search "jak dziala X"` odmowę „poza obszarem roboczym" i tracił wyszukiwarkę,
        // pobieranie stron, pocztę i delegację w całości. Whitelista folderów pilnuje ŚCIEŻEK
        // i tylko ścieżek — porównywanie z nią frazy wyszukiwania jest kategorią błędu, nie
        // ostrożnością.
        //
        // Te akcje mają WŁASNE, właściwe im bramki i to one zostają jedynymi:
        //   • `web.search` / `web.read` — rejestr znanych adresów (`modules/web/urlRegistry`)
        //     + zgoda usera (`web_search` / `web_read` w APPROVAL_DEFAULTS, osobne od K11);
        //   • `agent.message` — widoczność adresata + limity skrzynki (`modules/komunikator`);
        //   • `delegate` — przecięcie zakresów rodzic∩dziecko (`intersectScopeFolders`)
        //     i głębokość delegacji liczona w runtime;
        //   • `external.call` — ryzyko RED (obowiązkowa zgoda w `edge`) + whitelista serwerów.
        //
        // `PermissionSystem` NIE zmienia przez to przepływu: klasyfikacja ryzyka, zgody
        // i `disabled_tools` działają dokładnie jak dotąd — wypada wyłącznie pomiar ścieżkowy.
        // Domyślka `targetIsVaultPath === true` zostaje (fail-closed dla nowych wołaczy).
        if (opts?.targetIsVaultPath === false) {
            return { allowed: true, reason: 'non-vault-target' };
        }

        // K13 (2026-08-23): strażnik kanonizuje cel SAM, na wejściu. Do K12 było to
        // niemożliwe — `sanitizePath` nie była w pełni idempotentna, więc trzecia warstwa
        // „poprawek" oddawała inny ciąg niż wołacz i bramka, czyli otwierała z powrotem
        // dokładnie ten rozjazd, który zamknął K1. Od K13 kanonizacja jest liczona do PUNKTU
        // STAŁEGO, więc dodatkowa warstwa nie ma prawa niczego zmienić — a strażnik przestaje
        // wisieć na dyscyplinie wołaczy (granica `.pkm-assistant/` niżej stoi na `startsWith`,
        // więc jedno wiodące `./` wystarczyło, żeby ją ominąć).
        //
        // Kanonizacja idzie PRZED `_checkSubScope`, żeby także bariera suba oglądała formę
        // kanoniczną. Pusty cel i umowny root listingu (`/`) zostają bez zmian.
        // (Warunek `targetIsVaultPath !== false` stał tu do K14 — dziś jest zbędny, bo cel
        // nie-vaultowy wraca wyżej i nigdy tu nie dochodzi.)
        if (typeof targetPath === 'string' && targetPath !== '' && targetPath !== '/') {
            const canonical = sanitizePath(targetPath);
            // Ten sam komunikat co w `PermissionSystem.checkPermission` — jedna nazwa dla
            // jednego zdarzenia („tej ścieżki nie da się sprowadzić do formy kanonicznej").
            if (!canonical) return { allowed: false, reason: 'Invalid path' };
            targetPath = canonical;
        }

        // S33 Z1: bariera suba PRZED wszystkim innym — także przed admin_access rodzica.
        const subScopeDenial = AccessGuard._checkSubScope(targetPath, opts?.scopeFolders);
        if (subScopeDenial) return subScopeDenial;

        // A1: jawny, per-agent escape hatch. Nadal operujemy wyłącznie na ścieżkach
        // relatywnych do vaulta — sanitizePath jest wcześniejszą, niezależną warstwą.
        if (agent?.admin_access === true) {
            return { allowed: true, reason: 'admin-access' };
        }

        // No-Go check — blokuje zwykłych agentów.
        if (AccessGuard._isNoGo(targetPath)) {
            return { allowed: false, reason: t('security.no_go', { path: targetPath }) };
        }

        const folders = agent?.focusFolders;

        // Brak ścieżki = akcja bez celu vaultowego; własną bramkę ma jej narzędzie.
        if (!targetPath) {
            return { allowed: true, reason: 'no-path' };
        }

        // Bebechny pluginu sprawdzamy PRZED guidance_mode. "Cały vault" nie oznacza
        // `.pkm-assistant`; pełną granicę podnosi wyłącznie admin_access.
        if (targetPath === '.pkm-assistant' || targetPath.startsWith('.pkm-assistant/') || targetPath.startsWith('.pkm-assistant\\')) {
            return AccessGuard._checkPkmPath(agent, targetPath);
        }

        // Guidance mode = cały zwykły vault (focus folders są tylko wskazówkami).
        if (agent?.permissions?.guidance_mode === true) {
            return { allowed: true, reason: 'guidance-mode' };
        }

        // A2: tryb "Tylko przypisane" + pusta lista = zero zwykłego vaulta.
        if (!folders || folders.length === 0) {
            return {
                allowed: false,
                reason: t('security.outside_workspace', { path: targetPath })
            };
        }

        // Normalize entries
        const entries = AccessGuard._normalizeEntries(folders);

        // Check if path matches any whitelist entry
        for (const entry of entries) {
            if (AccessGuard._matchesEntry(targetPath, entry.path)) {
                // Check access level
                if (accessLevel === 'write' && entry.access === 'read') {
                    return {
                        allowed: false,
                        reason: t('security.read_only', { path: entry.path })
                    };
                }
                return { allowed: true, reason: `whitelist: ${entry.path}` };
            }
        }

        // Path not in whitelist = invisible
        log.debug('AccessGuard', `BLOCKED: ${agent.name} → ${targetPath} (poza whitelistą)`);
        return {
            allowed: false,
            reason: t('security.outside_workspace', { path: targetPath })
        };
    }

    /**
     * Filter a list of results to only include whitelisted paths.
     * Used by vault_list and vault_search to make non-whitelisted files invisible.
     * @param agent
     * @param results
     * @param pathExtractor - function to get path from result item
     * @param opts - Extra options
     * @param opts.scopeFolders - S33 A1: foldery scope sub-agenta. Wyniki spoza
     *   scope wypadają tak samo jak wyniki spoza whitelisty rodzica (koniunkcja).
     * @returns filtered results
     */
    static filterResults<T>(
        agent: GuardedAgent,
        results: T[],
        // Domyślny ekstraktor obsługuje dwa kształty wyniku (obiekt z `path` ALBO goła ścieżka) —
        // asercje odtwarzają to, co robił nieotypowany JS; runtime bez zmian.
        pathExtractor: (item: T) => string = (r) => (r as PathBearing).path || (r as unknown as string),
        opts: AccessCheckOptions = {},
    ): T[] {
        if (!results || !Array.isArray(results)) return results;

        // S33 A1: bariera scope suba PRZED wszystkim innym — także przed skrótem admina,
        // dokładnie jak w `checkAccess`. Inaczej `search`/`list` byłyby furtką: sub nie
        // otworzy pliku spoza swojego kąta, ale dostałby jego tytuł i fragment treści.
        const scopeFolders = opts?.scopeFolders;
        if (Array.isArray(scopeFolders) && scopeFolders.length > 0) {
            results = results.filter(item => AccessGuard._isInSubScope(pathExtractor(item), scopeFolders));
        }

        if (agent?.admin_access === true) return results;

        // Zwykli agenci nigdy nie widzą No-Go w wynikach.
        if (AccessGuard._noGoFolders.length > 0) {
            results = results.filter(item => !AccessGuard._isNoGo(pathExtractor(item)));
        }

        const folders = agent?.focusFolders;
        // Guidance mode = tylko filtr No-Go; bebechy pluginu bramkuje validator.
        if (agent?.permissions?.guidance_mode === true) {
            return results;
        }

        // A2: puste przypisania = zero zwykłego vaulta. Zachowaj wyłącznie jawnie
        // dozwolone ścieżki systemowe (obecnie przepisy skilli do odczytu).
        if (!folders || folders.length === 0) {
            return results.filter(item => {
                const p = pathExtractor(item);
                return typeof p === 'string'
                    && (p === '.pkm-assistant' || p.startsWith('.pkm-assistant/'))
                    && AccessGuard._checkPkmPath(agent, p).allowed;
            });
        }

        const entries = AccessGuard._normalizeEntries(folders);

        return results.filter(item => {
            const p = pathExtractor(item);
            if (!p) return true;

            // .pkm-assistant/ handled by _checkPkmPath
            if (p.startsWith('.pkm-assistant/')) {
                return AccessGuard._checkPkmPath(agent, p).allowed;
            }

            return entries.some(e => AccessGuard._matchesEntry(p, e.path));
        });
    }

    // ─── Private helpers ───────────────────────────────────

    /**
     * Handle .pkm-assistant/ paths.
     * Agent always sees own folder + shared system areas.
     */
    static _checkPkmPath(agent: GuardedAgent, path: string): AccessDecision {
        // Agent's own folder: always allowed
        const safeName = getAgentSafeName(agent.name);
        const ownFolder = `.pkm-assistant/agents/${safeName}`;
        if (path === ownFolder || path.startsWith(ownFolder + '/')) {
            return { allowed: true, reason: 'own-agent-folder' };
        }

        // Shared areas: always allowed (match folder itself AND contents)
        const sharedAreas = [
            '.pkm-assistant/komunikator',
            '.pkm-assistant/skills',
            '.pkm-assistant/artifacts',
            '.pkm-assistant/sub-agents',
            // E2.8: `.pkm-assistant/roles` usunięte — role rozpuszczone w A3 (D7), obszar martwy.
            // Health check 2026-07-29: `.pkm-assistant/agora` usunięte — moduł skasowany w S08, furtka była martwa.
        ];
        for (const area of sharedAreas) {
            if (path === area || path.startsWith(area + '/')) {
                return { allowed: true, reason: 'shared-pkm-area' };
            }
        }

        // .pkm-assistant root itself — allow read (listing)
        if (path === '.pkm-assistant') {
            return { allowed: true, reason: 'pkm-root-listing' };
        }

        // Config files at root level
        if (path === '.pkm-assistant/config.yaml') {
            return { allowed: true, reason: 'pkm-config' };
        }

        // Other .pkm-assistant paths (other agents' folders etc.) — block
        return {
            allowed: false,
            reason: t('security.no_access', { path })
        };
    }

    /**
     * Normalize focusFolders entries to {path, access} format.
     * Handles old string[], new {path, access}[], AND {group} references (E2.8 B1) — a group
     * reference expands to the folders defined for it in Settings→Vault (missing group = skipped).
     */
    static _normalizeEntries(folders: FocusEntry[] | null | undefined) {
        return expandFocusEntries(folders, AccessGuard._vaultGroups);
    }

    /**
     * Check if a file path matches a whitelist entry pattern.
     * Supports:
     * - Exact folder: "Projects" matches "Projects/file.md" and "Projects/sub/file.md"
     * - Glob with **: "Projects/**" matches any depth inside
     * - Glob with *: "Projects/*" matches one level only
     * - Exact file: "Notes/todo.md" matches exactly
     *
     * Glob→regex conversion via `globPatternToRegex` (AUD-code-review-033) — the
     * plain-folder branch below and `_escapeRegex` stay local. (Formerly also shared
     * with `VaultZones.matchesPattern()`; that dead subsystem was removed 2026-09-03,
     * AUD-dead-code-031/115/172/216.)
     */
    static _matchesEntry(filePath: string | null | undefined, pattern: string | null | undefined): boolean {
        if (!pattern || !filePath) return false;

        const normalizedPath = filePath.replace(/\\/g, '/');
        let normalizedPattern = pattern.replace(/\\/g, '/').replace(/\/$/, '');

        // Plain folder without glob and without dot in last segment
        if (!normalizedPattern.includes('*')) {
            // `.pop()` na wyniku `split` jest zawsze zdefiniowane (split zwraca ≥1 element) —
            // TS tego nie wie, więc dochodzi sama asercja.
            const lastSegment = normalizedPattern.split('/').pop() as string;
            if (!lastSegment.includes('.')) {
                return AccessGuard._getCachedRegex(
                    `folder:${normalizedPattern}`,
                    () => new RegExp(`^${AccessGuard._escapeRegex(normalizedPattern)}(\\/.*)?$`)
                ).test(normalizedPath);
            }
            return normalizedPath === normalizedPattern;
        }

        // Glob pattern → cached regex
        return AccessGuard._getCachedRegex(
            `glob:${normalizedPattern}`,
            () => globPatternToRegex(normalizedPattern)
        ).test(normalizedPath);
    }

    /** Get or create cached regex */
    static _getCachedRegex(key: string, factory: () => RegExp): RegExp {
        let regex = AccessGuard._regexCache.get(key);
        if (!regex) {
            regex = factory();
            AccessGuard._regexCache.set(key, regex);
        }
        return regex;
    }

    /**
     * Escape special regex characters in a string.
     */
    static _escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
