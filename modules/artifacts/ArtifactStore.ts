/**
 * ArtifactStore — CRUD instancji artefaktów żywych.
 *
 * Instancja artefaktu = widoczna notatka vaulta: frontmatter (klucze bazowe + pola typu) + treść
 * (sekcje, checkboxy z block-idami). Notatka JEST źródłem prawdy; śledzenie po frontmatterze
 * `pkm-artefakt`, NIE po ścieżce - przenosiny notatki nic nie psują.
 *
 * Zależności wstrzykiwane (app, typeLoader, folder, zegar) → node-testowalne z mockiem vaulta.
 * Importy PURE (parser + sanitizePath + stringifyYaml) - bez `obsidian` w module (Vault API dostaje
 * przez `app` w runtime).
 *
 * Bezpieczeństwo ścieżek: `artifact_*` NIE przyjmuje ścieżek od modelu - buduje je silnik z
 * `id/typ/tytul` przez `sanitizePath` + twarde ograniczenie do folderu artefaktów. To zamyka temat
 * traversal (nie ruszamy centralnego vault_path_validator).
 */
import { parseArtifact, applyPatch, validateArtifactBodyText, isArtifactScalar, INVALID_VALUE_MSG, PROTECTED_FIELDS, ARTIFACT_CONTEXT_MAX_CHARS, formatYmd } from './artifactParser.js';
import { sanitizePath, stringifyYaml } from '../../core/index.js';
import type { ArtifactFrontmatter, ArtifactPatchError, ArtifactPatchOp, ArtifactScalar, ThinArtifact } from './types.js';

interface ArtifactStoreType { name: string; statusy?: string[]; sprzatanie?: number; pola?: Record<string, { opis?: string; domyslne?: ArtifactScalar }>; template?: string; }
interface ArtifactStoreDependencies {
    // TS-any: Obsidian's runtime vault surface is injected and has no stable public type in this module.
    app: any;
    typeLoader: { getType(name: string): ArtifactStoreType | null } | null;
    getArtifactsFolder?: () => string;
    now?: () => Date;
    /**
     * Hak sprzątający dla nasłuchów `vault.on`/`metadataCache.on` rejestrowanych przez rejestr
     * artefaktów (patrz `_registerVaultEvents`) - wzór `IndexerPluginLike.registerEvent`
     * z `modules/embedding/VaultIndexer.ts`. Opcjonalny: bez niego nasłuchy i tak działają
     * (testy / hosty bez cyklu życia pluginu), tylko nie mają automatycznego sprzątania
     * przy `onunload`.
     */
    registerEvent?: (ref: unknown) => void;
}
interface ArtifactCreateOptions { tytul: string; pola?: Record<string, ArtifactScalar>; sekcje?: ArtifactPatchOp[]; agent?: string; }
interface ArtifactImportOptions { tytul: string; agent?: string; status?: string; pola?: Record<string, ArtifactScalar>; body?: string; utworzono?: string; zaktualizowano?: string; }
interface ArtifactListFilter { agent?: string; typ?: string; status?: string; }

/** Kształt wpisu w `list()` — TEN SAM kształt trzyma rejestr (patrz gotcha „Rejestr artefaktów"). */
interface ArtifactListEntry {
    id: string;
    path: string;
    tytul: string | null;
    typ: string;
    agent: string;
    status: string;
    utworzono: string;
    zaktualizowano: string;
}

export const DEFAULT_ARTIFACTS_FOLDER = 'PKM Assistant/Artefakty';
export const ARCHIVE_SUBFOLDER = '_archiwum';

export class ArtifactStore {
    // TS-any: Obsidian runtime facade is intentionally structural at the plugin boundary.
    declare app: any;
    declare typeLoader: ArtifactStoreDependencies['typeLoader'] | undefined;
    declare _getFolder: () => string;
    declare _now: () => Date;
    /**
     * Indeks id → ścieżka dla instancji utworzonych/przeniesionych W TEJ SESJI. `metadataCache`
     * Obsidiana bywa zimny przez chwilę po `create`, a bramka uprawnień pyta o ścieżkę
     * SYNCHRONICZNIE (`pathById`) - bez tego indeksu `artifact_update` tuż po `artifact_create`
     * dostawałby odmowę "brak celu". To pamięć podręczna, nie źródło prawdy: każdy wpis i tak
     * przechodzi przez `_isUnderRoot`.
     */
    declare _pathIndex: Map<string, string>;
    /**
     * Rejestr id → wpis `list()`, budowany LENIWIE (jeden pełny przelot po `getMarkdownFiles()`
     * przy pierwszym `list()`/`pathById()`) i odtąd utrzymywany zdarzeniami vaulta/metadataCache -
     * patrz `_ensureRegistry`/`_registerVaultEvents` i gotcha "Rejestr artefaktów" w CLAUDE.md.
     * `null` = jeszcze nie zbudowany.
     */
    declare _registry: Map<string, ArtifactListEntry> | null;
    /** Root, dla którego `_registry` jest aktualny — zmiana ustawienia folderu unieważnia rejestr. */
    declare _registryRoot: string | null;
    /** Nasłuchy `vault.on`/`metadataCache.on` rejestrowane najwyżej raz na instancję store'a. */
    declare _eventsRegistered: boolean;
    declare _registerEventHook: ((ref: unknown) => void) | undefined;
    /**
     * @param {Object} deps
     * @param {Object} deps.app - Obsidian App (vault + fileManager + metadataCache)
     * @param {Object} deps.typeLoader - ArtifactTypeLoader (create/archive potrzebują definicji typu)
     * @param {Function} [deps.getArtifactsFolder] - () => folder bazowy (z ustawień); default stały
     * @param {Function} [deps.now] - () => Date (wstrzykiwalny zegar do testów)
     * @param {Function} [deps.registerEvent] - sprzątanie nasłuchów vaulta (opcjonalne)
     */
    constructor({ app, typeLoader, getArtifactsFolder, now, registerEvent }: Partial<ArtifactStoreDependencies> = {}) {
        this.app = app;
        this.typeLoader = typeLoader;
        this._getFolder = typeof getArtifactsFolder === 'function' ? getArtifactsFolder : () => DEFAULT_ARTIFACTS_FOLDER;
        this._now = typeof now === 'function' ? now : () => new Date();
        this._pathIndex = new Map();
        this._registry = null;
        this._registryRoot = null;
        this._eventsRegistered = false;
        this._registerEventHook = typeof registerEvent === 'function' ? registerEvent : undefined;
    }

    // ─── create ──────────────────────────────────────────────────────────────

    /**
     * Utwórz instancję artefaktu jako notatkę vaulta.
     * @param {string} typ - nazwa typu (musi istnieć w bibliotece)
     * @param {Object} opts
     * @param {string} opts.tytul
     * @param {Object} [opts.pola] - wartości pól typu
     * @param {Array} [opts.sekcje] - początkowe opsy (set_section/add_item) przez ten sam walidator
     * @param {string} [opts.agent] - nazwa agenta (podfolder + frontmatter `agent`)
     * @returns {Promise<{id:string, path:string, applied:number, errors:Array, artifact:Object}>}
     */
    async create(typ: string, { tytul, pola = {}, sekcje = [], agent = 'agent' }: ArtifactCreateOptions = {} as ArtifactCreateOptions): Promise<{ created: boolean; id: string; path: string; applied: number; errors: ArtifactPatchError[]; artifact: ThinArtifact | null }> {
        const type = this.typeLoader?.getType?.(typ);
        if (!type) throw new Error(`Nieznany typ artefaktu: "${typ}"`);

        // Wartości pól przez TĘ SAMĄ bramkę co patch - PRZED zapisem. Odmowa jest fail-closed:
        // żaden plik nie powstaje (inaczej w vaultcie zostawałby artefakt z pustym polem,
        // a model i tak musiałby powtórzyć wywołanie).
        const fieldErrors = this.applyFieldsValidated(pola);
        if (fieldErrors.length > 0) return { created: false, id: '', path: '', applied: 0, errors: fieldErrors, artifact: null };

        const id = this._genId();
        const today = this._today();
        const status = (type.statusy && type.statusy[0]) || 'szkic';

        // Frontmatter: baza + pola typu (kolejność jak w makiecie instancji).
        const fm: ArtifactFrontmatter = {
            'pkm-artefakt': id,
            typ: type.name,
            agent,
            status,
        };
        for (const [field, def] of Object.entries(type.pola || {})) {
            const val = pola[field] != null ? pola[field] : (def && def.domyslne != null ? def.domyslne : '');
            fm[field] = val;
        }
        fm.utworzono = today;
        fm.zaktualizowano = today;

        // Body: szablon z podstawionymi {{pole}} + doklejony blok przycisków (nasz jedyny „kod").
        const filled = substitutePlaceholders(type.template || '', { ...fm, ...pola });
        const buttonBlock = `\n\`\`\`pkm-artefakt\nid: ${id}\n\`\`\`\n`;
        let content = buildNote(fm, filled.replace(/\s*$/, '\n') + buttonBlock);

        // Początkowe sekcje przez TEN SAM walidator patchy (code-fence reject działa).
        // Wynik patcha (applied/errors) jedzie do wołacza — inaczej `not_found` na nagłówku
        // spoza szablonu typu ginie po cichu i artefakt wygląda jak pusty szablon.
        let applied = 0;
        const errors: ArtifactPatchError[] = [];
        if (Array.isArray(sekcje) && sekcje.length > 0) {
            const patched = applyPatch(content, sekcje);
            content = patched.markdown;
            applied = patched.applied;
            errors.push(...patched.errors);
        }

        const path = await this._buildInstancePath(agent, tytul);
        await this._ensureFolder(path.slice(0, path.lastIndexOf('/')));
        const file = await this.app.vault.create(path, content);
        this._pathIndex.set(id, path);
        // Rejestr zna WSZYSTKIE pola od razu - nie czeka na metadataCache (bywa zimny tuż
        // po `create`), bo je właśnie sami napisaliśmy do frontmattera.
        this._registry?.set(id, { id, path, tytul: this._basename(file), typ: type.name, agent, status, utworzono: today, zaktualizowano: today });

        return { created: true, id, path, applied, errors, artifact: this._toThin(file, content) };
    }

    /**
     * JEDYNE wejście wartości `pola` (od MODELU) do instancji artefaktu.
     *
     * Wartości pól nie zostają w frontmatterze - szablon typu podstawia je do CIAŁA notatki przez
     * `{{pole}}`, więc są dokładnie taką samą treścią jak tekst z `set_section`. Gdyby leciały do
     * `substitutePlaceholders` surowym `String(v)`, z pominięciem bramki, `artifact_create`
     * z `pola:{cel:"```dataviewjs …```"}` zapisywałby wykonywalny blok do widocznego folderu
     * vaulta i zwracał `errors: []`. Tu stoi jeden predykat wspólny z patchem
     * (`validateArtifactBodyText`).
     *
     * Nie sprawdzamy szablonu typu ani wartości domyślnych pól - to treść USERA, w której kod
     * jest legalny i świadomy. Sprawdzamy wyłącznie to, co przyszło od agenta.
     *
     * @param {Object} pola - mapa pole → wartość (od modelu)
     * @returns {Array} lista odmów w kształcie błędów patcha (pusta = wolno pisać)
     */
    applyFieldsValidated(pola: Record<string, ArtifactScalar> | null | undefined): ArtifactPatchError[] {
        const errors: ArtifactPatchError[] = [];
        if (!pola || typeof pola !== 'object') return errors;
        for (const [key, value] of Object.entries(pola)) {
            if (value == null) continue;
            // NAJPIERW ten sam kontrakt co `set_field` - tylko skalary. `String(value)` na
            // obiekcie dałoby "[object Object]", więc bramka treści oglądałaby co innego, niż
            // `create` wpisuje do frontmattera (surową mapę z blokiem kodu).
            if (!isArtifactScalar(value)) {
                errors.push({ op: { op: 'set_field', key, value }, code: 'invalid_value', message: INVALID_VALUE_MSG });
                continue;
            }
            const bad = validateArtifactBodyText(String(value));
            if (bad) errors.push({ op: { op: 'set_field', key, value }, code: bad.code, message: bad.message });
        }
        return errors;
    }

    /**
     * Import instancji z GOTOWEGO ciała (migracja starych JSONów artefaktów). Body wstawiany
     * VERBATIM (bez walidatora patchy / guardu code-fence) - to zachowanie ISTNIEJĄCEJ treści
     * usera, nie pisanie przez agenta. Zwraca {id, path}.
     * @param {string} typ
     * @param {Object} opts - {tytul, agent, status?, pola?, body, utworzono?, zaktualizowano?}
     */
    async importInstance(typ: string, { tytul, agent = 'agent', status, pola = {}, body = '', utworzono, zaktualizowano }: ArtifactImportOptions = {} as ArtifactImportOptions): Promise<{ id: string; path: string }> {
        const type = this.typeLoader?.getType?.(typ);
        const id = this._genId();
        const today = this._today();
        const resolvedStatus = status || (type && type.statusy && type.statusy[0]) || 'szkic';
        const resolvedUtworzono = utworzono || today;
        const resolvedZaktualizowano = zaktualizowano || today;
        const fm: ArtifactFrontmatter = {
            'pkm-artefakt': id,
            typ,
            agent,
            status: resolvedStatus,
        };
        for (const [field, val] of Object.entries(pola || {})) fm[field] = val;
        fm.utworzono = resolvedUtworzono;
        fm.zaktualizowano = resolvedZaktualizowano;

        const buttonBlock = `\n\`\`\`pkm-artefakt\nid: ${id}\n\`\`\`\n`;
        const content = buildNote(fm, String(body || '').replace(/\s*$/, '\n') + buttonBlock);

        const path = await this._buildInstancePath(agent, tytul);
        await this._ensureFolder(path.slice(0, path.lastIndexOf('/')));
        await this.app.vault.create(path, content);
        this._pathIndex.set(id, path);
        this._registry?.set(id, { id, path, tytul: this._basename({ path }), typ, agent, status: resolvedStatus, utworzono: resolvedUtworzono, zaktualizowano: resolvedZaktualizowano });
        return { id, path };
    }

    // ─── read ────────────────────────────────────────────────────────────────

    /** Odczytaj chudy JSON artefaktu po id (teksty sekcji przycięte do limitu). */
    async read(id: string): Promise<ThinArtifact | null> {
        const file = await this._findFileById(id);
        if (!file) return null;
        const content = await this._readFile(file);
        return this._toThin(file, content, { truncate: true });
    }

    // ─── update ──────────────────────────────────────────────────────────────

    /**
     * Nałóż opsy na instancję. Body przez `vault.process` (atomowo, świeży stan), frontmatter
     * `set_field` przez `fileManager.processFrontMatter` (API-first). Kolejność: body → frontmatter.
     * @returns {Promise<{applied:number, errors:Array, artifact:Object|null}>}
     */
    async update(id: string, ops: ArtifactPatchOp[] = []): Promise<{ applied: number; errors: ArtifactPatchError[]; artifact: ThinArtifact | null }> {
        const file = await this._findFileById(id);
        if (!file) return { applied: 0, errors: [{ op: null, code: 'not_found', message: `Artefakt "${id}" nie istnieje` }], artifact: null };

        const list = Array.isArray(ops) ? ops : [];
        const fieldOps: ArtifactPatchOp[] = [];
        const bodyOps: ArtifactPatchOp[] = [];
        const errors: ArtifactPatchError[] = [];
        let applied = 0;

        for (const op of list) {
            if (op && op.op === 'set_field') fieldOps.push(op);
            else bodyOps.push(op);
        }

        // 1) BODY najpierw (process = atomowy read-modify-write na świeżym stanie).
        if (bodyOps.length > 0) {
            let result: { markdown: string | null; applied: number; errors: ArtifactPatchError[] } = { markdown: null, applied: 0, errors: [] };
            await this.app.vault.process(file, (txt: string) => {
                result = applyPatch(txt, bodyOps);
                return result.markdown;
            });
            applied += result.applied;
            errors.push(...result.errors);
        }

        // 2) FRONTMATTER set_field (API-first) - waliduj klucze bazowe + skalary.
        // TEN SAM kontrakt co `applyOne` w artifactParser.ts (string key → klucz chroniony →
        // skalar), przez kanoniczny predykat/komunikat (`isArtifactScalar` + `INVALID_VALUE_MSG`) -
        // nie własna, rozjeżdżająca się kopia reguły. `ops` przychodzi od modelu jako `unknown[]`
        // (patrz `ArtifactUpdateTool`), więc typowanie `key: string` na `ArtifactPatchOp` jest
        // tylko deklaracją kompilacyjną - bez tej bramki `{op:'set_field', value:'x'}` bez `key`
        // pisałby `front['undefined']='x'` do frontmattera i meldował sukces.
        const validFieldOps: Array<Extract<ArtifactPatchOp, { op: 'set_field' }>> = [];
        for (const op of fieldOps as Array<Extract<ArtifactPatchOp, { op: 'set_field' }>>) {
            const key = op.key;
            if (!key || typeof key !== 'string') {
                errors.push({ op, code: 'invalid_op', message: 'set_field requires a string key' });
                continue;
            }
            if (PROTECTED_FIELDS.includes(key)) {
                errors.push({ op, code: 'protected_key', message: `Field "${key}" is immutable` });
                continue;
            }
            const v = op.value;
            if (!isArtifactScalar(v)) {
                errors.push({ op, code: 'invalid_value', message: INVALID_VALUE_MSG });
                continue;
            }
            validFieldOps.push(op);
        }
        applied += validFieldOps.length;

        // 3) Zapis frontmattera + `zaktualizowano` (tylko gdy cokolwiek się udało).
        if (applied > 0) {
            await this.app.fileManager.processFrontMatter(file, (front: ArtifactFrontmatter) => {
                for (const op of validFieldOps) front[op.key] = op.value;
                front.zaktualizowano = this._today();
            });
        }

        const content = await this._readFile(file);
        const artifact = this._toThin(file, content, { truncate: true });
        // `list()` czyta z rejestru, więc pola widoczne tam (status, zaktualizowano) muszą się
        // odświeżyć TU - nie czekamy na `metadataCache`'owy `changed` (patrz też
        // `_onMetadataChanged`, który robi to samo dla mutacji SPOZA store'a).
        if (applied > 0 && artifact?.id) {
            this._registry?.set(artifact.id, {
                id: artifact.id,
                path: file.path,
                tytul: this._basename(file),
                typ: String(artifact.frontmatter.typ ?? ''),
                agent: String(artifact.frontmatter.agent ?? ''),
                status: String(artifact.frontmatter.status ?? ''),
                utworzono: String(artifact.frontmatter.utworzono ?? ''),
                zaktualizowano: String(artifact.frontmatter.zaktualizowano ?? ''),
            });
        }
        return { applied, errors, artifact };
    }

    // ─── list ────────────────────────────────────────────────────────────────

    /**
     * Lista instancji z filtrem (śledzenie po frontmatterze, NIE po ścieżce).
     *
     * Filtruje REJESTR (`_ensureRegistry`), nie `vault.getMarkdownFiles()` - koszt nie rośnie
     * z rozmiarem vaulta. Rejestr jest budowany leniwie (raz) i odtąd utrzymywany zdarzeniami -
     * patrz CLAUDE.md.
     * @param {Object} [filter] - {agent, typ, status}
     * @returns {Object[]}
     */
    list({ agent, typ, status }: ArtifactListFilter = {}): ArtifactListEntry[] {
        this._ensureRegistry();
        const out: ArtifactListEntry[] = [];
        for (const entry of this._registry!.values()) {
            if (agent && entry.agent !== agent) continue;
            if (typ && entry.typ !== typ) continue;
            if (status && entry.status !== status) continue;
            // KOPIA, nie żywy obiekt rejestru - wołacz nie ma dostać uchwytu, przez który
            // mógłby (przypadkiem) zmutować stan store'a.
            out.push({ ...entry });
        }
        return out;
    }

    // ─── move / remove ─────────────────────────────────────────────────────────

    /** Przenieś instancję do innego folderu (linki się aktualizują). */
    async move(id: string, newFolder: string): Promise<boolean> {
        const file = await this._findFileById(id);
        if (!file) return false;
        const folder = sanitizePath(newFolder);
        if (!folder) return false;
        const target = sanitizePath(`${folder}/${file.name}`);
        if (!target) return false;
        // Przenosiny WYŁĄCZNIE wewnątrz folderu artefaktów. Wyszukiwanie jest ograniczone do
        // tego folderu, więc artefakt wyniesiony na zewnątrz przestałby być widoczny dla silnika
        // (osierocona notatka) - lepiej odmówić od razu, niż zgubić go po cichu. "Przenosiny nic
        // nie psują" obowiązuje dalej WEWNĄTRZ folderu: śledzimy po frontmatterze, nie po
        // dokładnej ścieżce.
        if (!this._isUnderRoot(target)) return false;
        await this._ensureFolder(folder);
        await this.app.fileManager.renameFile(file, target);
        // Indeks idzie za plikiem - inaczej bramka oceniałaby starą ścieżkę. `target` jest TU już
        // zagwarantowany pod rootem (early return kilka linii wyżej), więc "przenosiny poza root"
        // do tego miejsca nie dojdą.
        this._pathIndex.set(id, target);
        const entry = this._registry?.get(id);
        if (entry) this._registry!.set(id, { ...entry, path: target, tytul: this._basename({ path: target }) });
        return true;
    }

    /** Usuń instancję (do kosza — nie kasujemy permanentnie). */
    async remove(id: string): Promise<boolean> {
        const file = await this._findFileById(id);
        if (!file) return false;
        if (this.app.fileManager?.trashFile) await this.app.fileManager.trashFile(file);
        else await this.app.vault.trash(file, false);
        this._pathIndex.delete(id);
        this._registry?.delete(id);
        return true;
    }

    /**
     * Sprzątanie: instancje `status:zamkniety` starsze niż `sprzatanie` dni typu → do `_archiwum/`.
     * Wołane przy starcie pluginu. Bezpieczne (brak typu / brak progu = pomijamy).
     * @returns {Promise<number>} liczba zarchiwizowanych
     */
    async archive() {
        const root = this._artifactsRoot();
        const nowMs = this._now().getTime();
        let count = 0;
        for (const entry of this.list({ status: 'zamkniety' })) {
            const type = this.typeLoader?.getType?.(entry.typ);
            const days = type?.sprzatanie || 0;
            if (!days) continue;
            const closedMs = Date.parse(entry.zaktualizowano || entry.utworzono || '');
            if (!Number.isFinite(closedMs)) continue;
            if ((nowMs - closedMs) < days * 86400000) continue;
            if (await this.move(entry.id, `${root}/${ARCHIVE_SUBFOLDER}`)) count++;
        }
        return count;
    }

    // ─── internals ─────────────────────────────────────────────────────────────

    _artifactsRoot() {
        return sanitizePath(this._getFolder() || DEFAULT_ARTIFACTS_FOLDER) || DEFAULT_ARTIFACTS_FOLDER;
    }

    /** Folder artefaktów jako CEL akcji bez pojedynczego pliku (`artifact_list`) - dla bramki. */
    artifactsRoot(): string {
        return this._artifactsRoot();
    }

    /**
     * Czy ścieżka leży w folderze artefaktów. Jedno miejsce, bo tę samą granicę sprawdza
     * wyszukiwanie po id, listowanie i budowanie ścieżki nowej instancji.
     */
    _isUnderRoot(path: unknown): boolean {
        return this._underRoot(path, this._artifactsRoot());
    }

    /**
     * TA SAMA reguła co `_isUnderRoot`, ale z rootem PRZEKAZANYM - dla pętli po wielu plikach
     * (rejestr, self-heal skan). Liczenie `_artifactsRoot()` (czyli `sanitizePath`) OD NOWA na
     * każdy plik zamiast raz na przelot mnoży narzut wielokrotnie przy dużym vaultcie (zmierzone:
     * 6,6× przy 5000 plikach).
     */
    _underRoot(path: unknown, root: string): boolean {
        if (!root) return false;
        const norm = String(path ?? '').replace(/\\/g, '/');
        return norm.startsWith(root + '/');
    }

    /**
     * Czy wpis `_pathIndex` jest jeszcze PRAWDĄ.
     *
     * Indeks to pamięć podręczna z TEJ sesji, a notatkę user może przenieść w Obsidianie -
     * plugin się o tym nie dowiaduje. Nieświeży wpis rozjeżdżałby bramkę ze zlewem: `pathById`
     * oddawałby starą ścieżkę (bramka mierzyła whitelistę na niej), a `_findFileById` pisałby pod
     * nową. Weryfikacja jest zachowawcza: brak pliku pod ścieżką albo CUDZE `id` we
     * frontmatterze = wpis do wyrzucenia; zimny `metadataCache` (chwilę po `create`, po to ten
     * indeks w ogóle jest) NIE unieważnia wpisu.
     */
    _pathIndexEntryValid(id: string, path: string): boolean {
        if (!path || !this._isUnderRoot(path)) return false;
        const file = this.app?.vault?.getAbstractFileByPath?.(path);
        if (!file) return false;
        const fm = this.app?.metadataCache?.getFileCache?.(file)?.frontmatter;
        if (!fm) return true;
        return fm['pkm-artefakt'] === id;
    }

    /**
     * Ścieżka artefaktu po id, SYNCHRONICZNIE - tego potrzebuje `contextExtractor` narzędzi
     * `artifact_*`, żeby bramka uprawnień dostała prawdziwy cel, a nie pusty string. Szuka tam,
     * gdzie sięgają szybkie źródła (własny indeks z tej sesji + rejestr artefaktów) i WYŁĄCZNIE
     * w folderze artefaktów. Nie znalazł = `null` → wołacz odmawia fail-closed (i tak
     * `update`/`read` skończyłyby się `not_found`).
     *
     * JEDYNE rozstrzygnięcie "id → ścieżka" w module - woła je i bramka, i zlew (`_findFileById`
     * startuje właśnie stąd), więc oba oglądają jeden ciąg. Wpis indeksu idzie przez weryfikację,
     * a skan odświeża indeks, żeby następne pytanie było już tanie.
     *
     * Dla id, którego rejestr (leniwie zbudowany, event-maintained - patrz `_ensureRegistry`)
     * NIGDY nie znał, wracamy `null` OD RAZU, bez skanu: rejestr jest kompletny (obejmuje CAŁY
     * folder artefaktów), więc jego brak = artefakt naprawdę nie istnieje - nie trzeba tego
     * sprawdzać drugi raz. Pełny (ale WCIĄŻ ograniczony do folderu artefaktów, root liczony RAZ)
     * skan leci WYŁĄCZNIE jako samoleczenie: wpis BYŁ znany (indeks sesji albo rejestr), ale
     * przestał być prawdą (`_pathIndexEntryValid` odmówiła) - np. user przeniósł notatkę
     * w Obsidianie mimo trwającej sesji, zanim zdążył dojść event `rename` (patrz `_rescanForId`).
     *
     * Stary/nieaktualny wpis NIE jest kasowany na wejściu do samoleczenia - tylko gdy rescan
     * (synchroniczny, TYLKO metadataCache) faktycznie ZNAJDZIE nową lokalizację, nadpisujemy go
     * świeżym. Jeśli rescan zawiedzie (np. nowa lokalizacja ma jeszcze zimny `metadataCache`),
     * stary wpis ZOSTAJE - to jest sygnał "to id kiedyś było prawdziwe", który asynchroniczny
     * `_findFileById` czyta przez `_wasEverKnown` i dopuszcza sobie fallback z dysku. Kasowanie
     * wpisu od razu regresowałoby samoleczenie po przenosinach bez eventu dokładnie wtedy, gdy
     * metadataCache pod nową ścieżką jest zimny.
     */
    pathById(id: string): string | null {
        if (!id) return null;
        this._ensureRegistry();
        const registry = this._registry!;

        // 1) Indeks sesji — instancje utworzone/przeniesione TĄ instancją store'a; może
        //    wyprzedzać rejestr (np. świeży `create()` przed pierwszym `_ensureRegistry`).
        const known = this._pathIndex.get(id);
        if (known && this._pathIndexEntryValid(id, known)) return known;

        // 2) Rejestr — event-maintained indeks całego folderu artefaktów.
        const fromRegistry = registry.get(id);
        if (fromRegistry && this._pathIndexEntryValid(id, fromRegistry.path)) {
            this._pathIndex.set(id, fromRegistry.path);
            return fromRegistry.path;
        }

        // 3) Samoleczenie: TYLKO gdy id BYŁO znane (sesji albo rejestrowi), a walidacja
        //    odmówiła. Dla id nigdy nie widzianego rejestr jest wyrocznią — brak wpisu
        //    znaczy „nie istnieje", nie „jeszcze nie sprawdziliśmy". Stare wpisy (`known`/
        //    `fromRegistry`) NIE są tu kasowane — patrz P1b w komentarzu metody.
        if (known != null || fromRegistry != null) {
            return this._rescanForId(id);
        }
        return null;
    }

    /** Czy id MIAŁ KIEDYŚ wpis (sesji albo rejestru) - nawet jeśli od tamtej pory zdezaktualizowany. */
    _wasEverKnown(id: string): boolean {
        return this._pathIndex.has(id) || !!this._registry?.has(id);
    }

    /**
     * Leniwie budowany (raz) rejestr artefaktów - `id → wpis list()`, ograniczony do folderu
     * artefaktów, root liczony RAZ na przelot. Po zbudowaniu jest utrzymywany zdarzeniami
     * vaulta/metadataCache (`_registerVaultEvents`) i bezpośrednio przez
     * `create`/`move`/`remove`/`update` - patrz CLAUDE.md "Rejestr artefaktów".
     *
     * Pierwsze wywołanie może wypaść ZANIM Obsidian rozgrzał `metadataCache` dla całego vaulta
     * (np. `archive()` z `initialize()` na `onLayoutReady`). Plik pod rootem z ZUPEŁNIE zimnym
     * cache'em (`getFileCache` = `null`/`undefined` - nie: cache istnieje, ale bez
     * `pkm-artefakt`) NIE wchodzi do rejestru w tym przelocie - ale w takim przypadku
     * `_registryRoot` NIE jest stemplowany (`allWarm=false`), więc kolejne pytanie przebuduje
     * rejestr od zera, aż cache się rozgrzeje. Bez tego artefakt zimny w MOMENCIE budowy
     * zostawałby niewidoczny do końca sesji (rejestr jest inaczej wyrocznią - patrz `pathById`).
     * Drugie zabezpieczenie: `metadataCache.on('resolved')` (`_registerVaultEvents`) wymusza
     * przebudowę bezwarunkowo, gdy Obsidian skończy PIERWSZE pełne rozwiązanie metadanych. Koszt
     * jest jednorazowy (okno startowe) - po rozgrzaniu `allWarm` jest zawsze `true` i rejestr
     * wraca do O(1) na wywołanie.
     */
    _ensureRegistry(): void {
        const root = this._artifactsRoot();
        if (this._registry && this._registryRoot === root) return;
        const registry = new Map<string, ArtifactListEntry>();
        const files = this.app?.vault?.getMarkdownFiles?.() || [];
        let allWarm = true;
        for (const f of files) {
            if (!this._underRoot(f?.path, root)) continue;
            const cache = this.app.metadataCache?.getFileCache?.(f);
            if (!cache) { allWarm = false; continue; } // metadataCache jeszcze nie poznał pliku
            const fm = cache.frontmatter;
            const id = fm && fm['pkm-artefakt'];
            if (!id) continue;
            registry.set(id, this._entryFrom(id, f, fm));
        }
        this._registry = registry;
        this._registryRoot = allWarm ? root : null; // prowizoryczny — następne pytanie przebuduje
        this._registerVaultEvents();
    }

    /** Zbuduj wpis rejestru/`list()` z pliku + jego frontmattera. */
    // TS-any: Obsidian file objects come from the dynamically injected vault facade.
    _entryFrom(id: string, file: any, fm: ArtifactFrontmatter): ArtifactListEntry {
        return {
            id,
            path: String(file.path),
            tytul: this._basename(file),
            typ: String(fm.typ ?? ''),
            agent: String(fm.agent ?? ''),
            status: String(fm.status ?? ''),
            utworzono: String(fm.utworzono ?? ''),
            zaktualizowano: String(fm.zaktualizowano ?? ''),
        };
    }

    /**
     * Samoleczenie ograniczone do folderu artefaktów (root liczony RAZ) - jedyna droga, którą
     * `pathById` wciąż może kosztować więcej niż O(1): wpis BYŁ znany i przestał być prawdą
     * (np. user przeniósł notatkę w Obsidianie zanim doszedł event `rename`). SYNCHRONICZNA jak
     * `pathById` sama - `contextExtractor` woła ją bez `await`, więc bez dysku: metadataCache
     * albo nic. Odczyt z dysku dla zimnego cache'u mieszka osobno, w `_indexSingleFile`
     * (asynchroniczne hooki `create`/`changed`).
     */
    _rescanForId(id: string): string | null {
        const root = this._artifactsRoot();
        const files = (this.app?.vault?.getMarkdownFiles?.() || []).filter((f: any) => this._underRoot(f?.path, root));
        for (const f of files) {
            const fm = this.app.metadataCache?.getFileCache?.(f)?.frontmatter;
            if (fm && fm['pkm-artefakt'] === id) {
                const path = String(f.path);
                this._pathIndex.set(id, path);
                this._registry?.set(id, this._entryFrom(id, f, fm));
                return path;
            }
        }
        return null;
    }

    /**
     * Ścieżka, pod którą POWSTANIE nowa instancja - synchronicznie, dla `contextExtractor`
     * narzędzia `artifact_create`. Sufiks kolizyjny (" 2", " 3") może się do czasu wykonania
     * przesunąć o jeden, ale folder - czyli to, co ocenia AccessGuard - jest ten sam. Ścieżka nie
     * do zbudowania = `null` (wołacz odmawia), NIE wyjątek: bramka nie ma prawa rzucać.
     */
    instancePathFor(agent: string, tytul: string): string | null {
        try {
            return this._buildInstancePathSync(agent, tytul);
        } catch {
            return null;
        }
    }

    /** Zbuduj (i zwaliduj) ścieżkę instancji — WYŁĄCZNIE po stronie silnika. */
    async _buildInstancePath(agent: string, tytul: string): Promise<string> {
        return this._buildInstancePathSync(agent, tytul);
    }

    /** Ta sama logika co `_buildInstancePath`, bez `async` — woła ją też bramka (sync). */
    _buildInstancePathSync(agent: string, tytul: string): string {
        const root = this._artifactsRoot();
        const agentSeg = safeSegment(agent) || 'agent';
        const base = `${this._today()} ${safeSegment(tytul) || 'artefakt'}`;
        let path = sanitizePath(`${root}/${agentSeg}/${base}.md`);
        if (!path || !path.startsWith(root + '/')) {
            throw new Error('Nie udało się zbudować bezpiecznej ścieżki artefaktu');
        }
        // Kolizja nazwy → sufiks " 2", " 3", …
        let n = 2;
        while (this.app.vault.getAbstractFileByPath?.(path)) {
            path = sanitizePath(`${root}/${agentSeg}/${base} ${n}.md`);
            n++;
            if (n > 999) break;
        }
        return path as string;
    }

    /** Utwórz folder + wszystkie nadrzędne (API-first, mkdir -p). */
    async _ensureFolder(folderPath: string): Promise<void> {
        if (!folderPath) return;
        const parts = folderPath.split('/');
        let acc = '';
        for (const part of parts) {
            acc = acc ? `${acc}/${part}` : part;
            if (this.app.vault.getAbstractFileByPath?.(acc)) continue;
            try { await this.app.vault.createFolder(acc); } catch { /* wyścig / już istnieje */ }
        }
    }

    /**
     * Trzyma się folderu artefaktów - `pathById` (którą tu wołamy) nie wychodzi poza root.
     * Artefakt wyniesiony poza folder przestaje być artefaktem - to świadoma cena za granicę.
     *
     * Bramka i zlew mają iść do JEDNEGO rozstrzygnięcia - `pathById` - żeby rozjazd (stara
     * ścieżka dla bramki, nowa dla zapisu) nie był możliwy. Deleguje więc do `pathById` (rejestr
     * + samoleczenie po metadataCache, patrz `_rescanForId`) i NIE robi własnego skanu dla id,
     * którego rejestr NIGDY nie znał - to zostaje O(1).
     *
     * `pathById`'s samoleczenie jest SYNCHRONICZNE i patrzy TYLKO w `metadataCache` (bramka nie
     * ma prawa czekać na dysk). Jeśli artefakt przeniesiono poza zasięgiem store'a (bez eventu
     * `rename`) DO lokalizacji, której cache jeszcze nie rozgrzał, samo `pathById` nie znajdzie
     * go. Tu, ASYNCHRONICZNIE (`_findFileById` nie jest ścieżką bramki - koszt jednorazowego
     * odczytu z dysku po plikach folderu artefaktów jest OK), dopuszczamy jednorazowy fallback
     * z dysku - ale WYŁĄCZNIE gdy `_wasEverKnown(id)` (id BYŁO kiedyś w indeksie sesji albo
     * rejestrze). Dla id nigdy niewidzianego fallback się NIE odpala - inaczej każde nieznane id
     * kosztowałoby pełny skan + odczyt z dysku, zamiast O(1).
     */
    // TS-any: Obsidian file objects come from the dynamically injected vault facade.
    async _findFileById(id: string): Promise<any> {
        if (!id) return null;
        const resolved = this.pathById(id);
        if (resolved) {
            const file = this.app.vault.getAbstractFileByPath?.(resolved);
            if (file) return file;
        }
        if (!this._wasEverKnown(id)) return null;
        return this._diskFallbackForId(id);
    }

    /**
     * Jednorazowy odczyt z dysku po plikach folderu artefaktów - TYLKO wołane z `_findFileById`
     * dla id, które `_wasEverKnown` (nigdy dla nowego/nieznanego id). Root liczony RAZ.
     */
    async _diskFallbackForId(id: string): Promise<any> {
        const root = this._artifactsRoot();
        const files = (this.app?.vault?.getMarkdownFiles?.() || []).filter((f: any) => this._underRoot(f?.path, root));
        for (const f of files) {
            try {
                const content = await this._readFile(f);
                const parsed = parseArtifact(content);
                if (parsed.frontmatter['pkm-artefakt'] === id) {
                    const path = String(f.path);
                    this._pathIndex.set(id, path);
                    this._registry?.set(id, this._entryFrom(id, f, parsed.frontmatter));
                    return f;
                }
            } catch { /* nieczytelny/zniknął w międzyczasie — pomiń */ }
        }
        return null;
    }

    // ─── rejestr: utrzymanie zdarzeniami ──────────────────────────────────────────────────

    /**
     * Nasłuchy `vault.on('create'|'delete'|'rename')` + `metadataCache.on('changed')`,
     * OGRANICZONE do folderu artefaktów w handlerze (nasłuch sam jest globalny — Obsidian nie
     * ma innego API). Rejestrowane raz na instancję store'a, dopiero przy pierwszym
     * `_ensureRegistry` (leniwie — zero kosztu, dopóki nikt nie zapytał o `list()`/`pathById`).
     * Host bez `vault.on` (testy z prostą atrapą, `artifactTools.test.ts`) — no-op: `create`/
     * `move`/`remove`/`update` utrzymują rejestr BEZPOŚREDNIO, więc działają bez zdarzeń.
     */
    _registerVaultEvents(): void {
        if (this._eventsRegistered) return;
        this._eventsRegistered = true;
        const vault = this.app?.vault;
        if (typeof vault?.on !== 'function') return;

        const reg = (ref: unknown) => { if (ref != null) this._registerEventHook?.(ref); };
        reg(vault.on('create', (file: any) => { void this._onVaultCreate(file); }));
        reg(vault.on('delete', (file: any) => { this._onVaultDelete(file); }));
        reg(vault.on('rename', (file: any, oldPath: string) => { void this._onVaultRename(file, oldPath); }));
        const mc = this.app?.metadataCache;
        if (typeof mc?.on === 'function') {
            reg(mc.on('changed', (file: any) => { void this._onMetadataChanged(file); }));
            // `resolved` = Obsidian skończył PIERWSZE pełne rozwiązanie metadanych całego
            // vaulta - zdarzenie JEDNORAZOWE. Jeśli rejestr zbudował się wcześniej (np.
            // `archive()` w `initialize()` na `onLayoutReady`) z częścią plików pod rootem
            // jeszcze zimnych, `_ensureRegistry` już samo się nie zastemplowało jako kompletne
            // (`allWarm`) - ale `resolved` daje dodatkową, bezwarunkową gwarancję: unieważnia
            // rejestr, żeby leniwa przebudowa złapała WSZYSTKO od razu, bez czekania na kolejne
            // przypadkowe `list()`/`pathById()`.
            reg(mc.on('resolved', () => { this._registry = null; this._registryRoot = null; }));
        }
    }

    /** Nowy plik pod rootem (spoza `store.create()`, np. sync/user) — pojedynczy indeks. */
    async _onVaultCreate(file: any): Promise<void> {
        if (!this._registry) return;
        if (!this._underRoot(file?.path, this._artifactsRoot())) return;
        await this._indexSingleFile(file);
    }

    /** Plik skasowany spod rootem — wypisz z rejestru (i indeksu sesji, jeśli tam też był). */
    _onVaultDelete(file: any): void {
        if (!this._registry) return;
        const path = String(file?.path ?? '').replace(/\\/g, '/');
        this._forgetPath(path);
    }

    /** Rename/move — stara ścieżka znika, nowa (jeśli pod rootem) wchodzi. */
    async _onVaultRename(file: any, oldPath: string): Promise<void> {
        if (!this._registry) return;
        this._forgetPath(String(oldPath ?? '').replace(/\\/g, '/'));
        if (this._underRoot(file?.path, this._artifactsRoot())) await this._indexSingleFile(file);
    }

    /** Frontmatter zmieniony (edycja usera, patch narzędzia, cache dogonił zimny `create`). */
    async _onMetadataChanged(file: any): Promise<void> {
        if (!this._registry) return;
        if (!this._underRoot(file?.path, this._artifactsRoot())) return;
        await this._indexSingleFile(file);
    }

    /**
     * Usuń wszystkie wpisy rejestru/indeksu sesji wskazujące na TĘ ścieżkę.
     * Normalnie ścieżka→id jest 1:1, ale nie zakładamy tego na siłę (duch po nadpisaniu/race) -
     * zbieramy WSZYSTKIE trafienia, nie przerywamy po pierwszym.
     */
    _forgetPath(path: string): void {
        if (!path || !this._registry) return;
        const toForget: string[] = [];
        for (const [id, entry] of this._registry) {
            if (entry.path === path) toForget.push(id);
        }
        for (const id of toForget) {
            this._registry.delete(id);
            if (this._pathIndex.get(id) === path) this._pathIndex.delete(id);
        }
    }

    /**
     * Indeksuj JEDEN plik (pod rootem) do rejestru. `metadataCache` bywa zimne tuż po `create` -
     * dlatego fallback jest "do dotychczasowej ścieżki dla pojedynczego pliku", nie skanu całego
     * vaulta: czytamy TEN plik z dysku, nic więcej.
     */
    async _indexSingleFile(file: any): Promise<void> {
        if (!this._registry) return;
        const path = String(file?.path ?? '');
        if (!path) return;
        let fm = this.app.metadataCache?.getFileCache?.(file)?.frontmatter;
        if (!fm) {
            try {
                const content = await this._readFile(file);
                fm = parseArtifact(content).frontmatter;
            } catch { return; } // nieczytelny/zniknął w międzyczasie — pomiń.
        }
        // Inny artefakt mieszkał wcześniej pod tą ścieżką (np. nadpisanie) — zdejmij go.
        this._forgetPath(path);
        const id = fm && fm['pkm-artefakt'];
        if (!id) return; // to nie (już) jest artefakt.
        this._registry.set(String(id), this._entryFrom(String(id), file, fm));
    }

    // TS-any: File instance belongs to Obsidian's dynamically injected vault API.
    async _readFile(file: any): Promise<string> {
        if (this.app.vault.cachedRead) return this.app.vault.cachedRead(file);
        return this.app.vault.read(file);
    }

    /** Zbuduj chudy JSON dla agenta. */
    // TS-any: File instance belongs to Obsidian's dynamically injected vault API.
    _toThin(file: any, content: string, { truncate = false }: { truncate?: boolean } = {}): ThinArtifact {
        const parsed = parseArtifact(content);
        const sections = parsed.sections.map(s => ({
            ...s,
            text: truncate ? clip(s.text, ARTIFACT_CONTEXT_MAX_CHARS) : s.text,
        }));
        return {
            id: (parsed.frontmatter['pkm-artefakt'] || null) as ThinArtifact['id'],
            path: file?.path || null,
            tytul: this._basename(file),
            typ: (parsed.frontmatter.typ || null) as ThinArtifact['typ'],
            agent: (parsed.frontmatter.agent || null) as ThinArtifact['agent'],
            status: (parsed.frontmatter.status || null) as ThinArtifact['status'],
            frontmatter: parsed.frontmatter,
            sections,
            buttons: parsed.buttons,
        };
    }

    // TS-any: File instance belongs to Obsidian's dynamically injected vault API.
    _basename(file: any): string | null {
        if (!file) return null;
        if (file.basename) return file.basename;
        return String(file.path || '').split('/').pop()!.replace(/\.md$/i, '');
    }

    _today() {
        return formatYmd(this._now());
    }

    _genId() {
        // JEDEN helper daty (`formatYmd`) - sam stempel bez myślników.
        const stamp = formatYmd(this._now()).replace(/-/g, '');
        const hex = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
        return `art-${stamp}-${hex}`;
    }
}

/** Podstaw `{{pole}}` w szablonie; niezmapowane placeholdery zostają jak są. */
function substitutePlaceholders(template: string, values: ArtifactFrontmatter): string {
    return String(template || '').replace(/\{\{(\w+)\}\}/g, (m, key) => {
        const v = values[key];
        return v != null ? String(v) : m;
    });
}

/** Zbuduj plik z frontmattera (obiekt) + ciała. Silnik YAML zachowuje kolejność kluczy (bez sortowania). */
function buildNote(fm: ArtifactFrontmatter, body: string): string {
    const yaml = stringifyYaml(fm);
    return `---\n${yaml}---\n\n${String(body || '').replace(/^\n+/, '')}`;
}

/** Oczyść segment ścieżki (nazwa pliku/folderu) ze znaków niedozwolonych w systemie plików. */
function safeSegment(s: unknown): string {
    return String(s || '')
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Przytnij tekst do limitu znaków z wielokropkiem. */
function clip(text: unknown, max: number): string {
    const s = String(text || '');
    return s.length > max ? s.slice(0, max) + '…' : s;
}
