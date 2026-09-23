/**
 * migrate_json_to_notes.js — jednorazowy migrator starego świata artefaktów.
 *
 * Stary świat: `ArtifactManager` trzymał artefakty jako JSON w `.pkm-assistant/artifacts/*.json`
 * (+ zakopany podfolder `plan_review/*.json` z bugowatej migracji plan_action). Nowy świat: artefakty
 * to widoczne notatki vaulta (`ArtifactStore`). Ten migrator przenosi stare JSONy na notatki typu
 * `plan` / `notatka`, a `context-session` i nierozpoznane → do `.pkm-assistant/artifacts-backup-<data>/`.
 *
 * IDEMPOTENTNY: marker `.pkm-assistant/artifacts/.migrated-v2` albo brak plików źródłowych = no-op.
 * "Nie zostawiamy nic z tyłu": po sukcesie źródłowe JSONy skasowane.
 *
 * DI (adapter + store) → node-testowalny na fixture. Body notatki wstawiany VERBATIM przez
 * `store.importInstance` (zachowanie treści usera, nie pisanie przez agenta).
 */
import { formatYmd } from './artifactParser.js';
import { pendingStatusOf, acceptedStatusOf } from './artifactStatuses.js';

const ARTIFACTS_BASE = '.pkm-assistant/artifacts';
const MIGRATED_MARKER = `${ARTIFACTS_BASE}/.migrated-v2`;
const PLAN_REVIEW_SUBFOLDER = `${ARTIFACTS_BASE}/plan_review`;

/** Kształt starego JSON-a artefaktu — kilka historycznych, nieudokumentowanych wariantów
 *  (`ArtifactManager` sprzed `ArtifactStore`), stąd same pola opcjonalne. */
interface LegacyArtifactRecord {
    data?: {
        artifactType?: string;
        title?: string;
        createdBy?: string;
        approved?: boolean;
        status?: string;
        markdown?: string;
        steps?: unknown;
    };
    type?: string;
    status?: string;
    title?: string;
    createdBy?: string;
    agentName?: string;
    createdAt?: string;
    updatedAt?: string;
    markdown?: string;
    steps?: unknown;
}

/** Jeden krok starego `plan_review` — sam string albo obiekt; string ma te pola `undefined`
 *  w JS (nie rzuca), więc jeden kształt z samymi opcjonalnymi polami pokrywa oba warianty. */
interface LegacyStepRecord {
    action?: string;
    text?: string;
    label?: string;
    status?: string;
    done?: boolean;
}

/** Powierzchnia `vault.adapter`, jakiej potrzebuje migrator (dotfolder: exists/read/write/
 *  remove/mkdir/list) — ten sam duck-type co realny Obsidian `DataAdapter`, wstrzykiwany dla
 *  testowalności na fixture (komentarz modułu: „node-testowalny na fixture"). */
interface MigrationAdapter {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    remove(path: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    list(path: string): Promise<{ files?: string[]; folders?: string[] } | null | undefined>;
}

interface MigrationDependencies {
    adapter: MigrationAdapter;
    store: {
        importInstance(typ: string, opts: Record<string, unknown>): Promise<unknown>;
        /**
         * Opcjonalny - `ArtifactStore` prawdziwy (`src/main.ts`) go ma, atrapy testowe mogą go
         * pominąć. Woła się WYŁĄCZNIE po `statusy` docelowego typu, żeby `mapStatus` zmapowała
         * stary rekord na literał w JĘZYKU, w którym typ DZIŚ deklaruje swoje statusy (mogły
         * zmienić się od czasu powstania starego JSON-a - `ensureBuiltinTypes` podmienia
         * nietknięty plik typu na język UI przy każdym starcie).
         */
        typeLoader?: { getType(name: string): { statusy?: string[] } | null } | null;
    };
    now?: () => Date;
}

/** Data w formacie YYYY-MM-DD (do nazwy folderu backupu) - JEDEN helper. */
function today(now?: () => Date): string {
    return formatYmd(now ? now() : new Date());
}

/** Rozpoznaj docelowy typ nowego artefaktu na podstawie starego rekordu. */
function classify(record: LegacyArtifactRecord): string | null {
    const t = record?.data?.artifactType || record?.type || '';
    if (t === 'plan_review') return 'plan';
    if (t === 'idea_review' || t === 'plan') return 'notatka';
    // context-session / todo / nieznane → backup (nie migrujemy).
    return null;
}

/**
 * Zmapuj stary status na status DZISIEJSZEGO typu docelowego (plan/notatka). `typeStatusy` to
 * `statusy` typu TAKI, JAKI JEST TERAZ w bibliotece - `pendingStatusOf`/`acceptedStatusOf`
 * (`artifactStatuses.ts`) rozpoznają rolę w KTÓRYMKOLWIEK języku, więc typ zaseedowany dziś po
 * angielsku (`ensureBuiltinTypes` podmienia nietknięty plik na język UI przy każdym starcie)
 * dostaje notatkę z literałem EN, nie polskim `'do-akceptacji'` na sztywno wewnątrz EN typu.
 * Fallback na historyczny literał PL, gdy typ nie deklaruje rozpoznanej roli wcale (nie powinno
 * się zdarzyć dla `plan`/`notatka` - `classify()` migruje tylko w te dwa typy).
 */
function mapStatus(record: LegacyArtifactRecord, typeStatusy: readonly string[] = []): string {
    const approved = record?.data?.approved === true
        || record?.data?.status === 'approved'
        || record?.status === 'approved';
    return approved
        ? (acceptedStatusOf(typeStatusy) ?? 'zaakceptowany')
        : (pendingStatusOf(typeStatusy) ?? 'do-akceptacji');
}

/** Kroki starego plan_review → linie checkboxów `- [ ] text ^kN`. */
function stepsToCheckboxes(steps: unknown): string {
    if (!Array.isArray(steps)) return '';
    const lines: string[] = [];
    let n = 1;
    // Array.isArray() zawęża `unknown` do `any[]` (sygnatura lib.es5.d.ts) - rzutujemy inline
    // z powrotem na `unknown[]`, żeby dalsze odczyty szły przez jawne asercje niżej, nie przez `any`.
    for (const step of steps as unknown[]) {
        // TS-boundary: krok starego JSON-a plan_review - string albo obiekt, bez walidacji
        // schematem (dane historyczne, migrator jednorazowy, patrz LegacyStepRecord wyżej).
        const rec = step && typeof step === 'object' ? (step as LegacyStepRecord) : null;
        const text = typeof step === 'string' ? step : (rec?.action || rec?.text || rec?.label || '');
        if (!text) continue;
        const checked = rec?.status === 'done' || rec?.done === true;
        lines.push(`- [${checked ? 'x' : ' '}] ${text.replace(/\s*\r?\n\s*/g, ' ').trim()} ^k${n}`);
        n++;
    }
    return lines.join('\n');
}

/**
 * Zbuduj body notatki nowego typu z rekordu (VERBATIM markdown usera + ew. kroki).
 *
 * ⚠️ Nagłówki sekcji zostają POLSKIE na sztywno - świadomie, NIE przez `artifactSection()`.
 * To migrator jednorazowy stanu sprzed 2.2.5: stare JSONy artefaktów istnieją wyłącznie
 * w vaultach, które chodziły na polskich szablonach typów, więc angielski nagłówek rozjechałby
 * zmigrowaną notatkę z jej własnym typem na dysku.
 */
function buildBody(typ: string, record: LegacyArtifactRecord): string {
    const markdown = String(record?.data?.markdown || record?.markdown || '').trim();
    if (typ === 'plan') {
        const steps = stepsToCheckboxes(record?.data?.steps || record?.steps);
        return [
            '## Cel',
            markdown || '(zmigrowano ze starego planu)',
            '',
            '## Kroki',
            steps || '(brak kroków)',
            '',
            '## Ryzyka i założenia',
            '',
            '## Uwagi usera',
        ].join('\n');
    }
    // notatka
    return [
        '## Treść',
        markdown || '(zmigrowano ze starej treści)',
        '',
        '## Uwagi usera',
    ].join('\n');
}

/**
 * Wykonaj migrację.
 * @param {Object} deps
 * @param {Object} deps.adapter - vault.adapter (dotfolder: exists/read/write/remove/mkdir/list)
 * @param {Object} deps.store - ArtifactStore (importInstance)
 * @param {Function} [deps.now] - () => Date
 * @returns {Promise<{migrated:number, backedUp:number, skipped:boolean, reason?:string}>}
 */
export async function migrateJsonArtifactsToNotes({ adapter, store, now }: Partial<MigrationDependencies> = {}): Promise<{ migrated: number; backedUp: number; skipped: boolean; reason?: string }> {
    if (!adapter || !store) return { migrated: 0, backedUp: 0, skipped: true, reason: 'no_deps' };

    try {
        if (!(await adapter.exists(ARTIFACTS_BASE))) return { migrated: 0, backedUp: 0, skipped: true, reason: 'no_source' };
        if (await adapter.exists(MIGRATED_MARKER)) return { migrated: 0, backedUp: 0, skipped: true, reason: 'already_migrated' };

        // Zbierz źródłowe JSONy: top-level + zakopany plan_review/.
        const sources: string[] = [];
        const top = await adapter.list(ARTIFACTS_BASE);
        for (const f of (top?.files || [])) if (f.endsWith('.json')) sources.push(f);
        if (await adapter.exists(PLAN_REVIEW_SUBFOLDER)) {
            const sub = await adapter.list(PLAN_REVIEW_SUBFOLDER);
            for (const f of (sub?.files || [])) if (f.endsWith('.json')) sources.push(f);
        }

        if (sources.length === 0) {
            await adapter.write(MIGRATED_MARKER, `migrated-v2 ${today(now)} (brak plików źródłowych)\n`);
            return { migrated: 0, backedUp: 0, skipped: true, reason: 'no_files' };
        }

        const backupDir = `.pkm-assistant/artifacts-backup-${today(now)}`;
        let migrated = 0;
        let backedUp = 0;

        for (const path of sources) {
            let record: LegacyArtifactRecord;
            let raw: string | undefined;
            try {
                raw = await adapter.read(path);
                // TS-boundary: stary JSON artefaktu z dysku - kilka historycznych, nieudokumentowanych
                // wariantów (patrz LegacyArtifactRecord wyżej), bez walidacji schematem (migrator
                // jednorazowy, nieczytelny/niepasujący wpis i tak ląduje w backupie niżej).
                record = JSON.parse(raw) as LegacyArtifactRecord;
            } catch {
                // Nieczytelny JSON → backup, nie kasujemy na ślepo.
                await moveToBackup(adapter, path, raw, backupDir);
                backedUp++;
                continue;
            }

            const typ = classify(record);
            if (!typ) {
                await moveToBackup(adapter, path, raw, backupDir);
                backedUp++;
                continue;
            }

            try {
                const typeStatusy = store.typeLoader?.getType?.(typ)?.statusy || [];
                await store.importInstance(typ, {
                    tytul: record.title || record.data?.title || 'Artefakt',
                    agent: record.createdBy || record.data?.createdBy || record.agentName || 'agent',
                    status: mapStatus(record, typeStatusy),
                    body: buildBody(typ, record),
                    utworzono: dateOnly(record.createdAt),
                    zaktualizowano: dateOnly(record.updatedAt),
                });
                await adapter.remove(path); // sukces → nie zostawiamy nic z tyłu
                migrated++;
            } catch {
                // Import się nie udał (np. brak typu w bibliotece) → backup, nie gubimy danych.
                await moveToBackup(adapter, path, raw, backupDir);
                backedUp++;
            }
        }

        // Sprzątanie pustego podfolderu plan_review (best-effort) + marker.
        await adapter.write(MIGRATED_MARKER, `migrated-v2 ${today(now)} (migrated=${migrated}, backup=${backedUp})\n`);
        return { migrated, backedUp, skipped: false };
    } catch (e) {
        return { migrated: 0, backedUp: 0, skipped: true, reason: `error: ${(e as { message?: string }).message}` };
    }
}

/** Przenieś plik źródłowy do folderu backupu (zachowuje surową treść) i usuń oryginał. */
async function moveToBackup(adapter: MigrationAdapter, path: string, raw: string | undefined, backupDir: string): Promise<void> {
    try {
        if (!(await adapter.exists(backupDir))) await adapter.mkdir(backupDir);
        const name = path.split('/').pop();
        const content = raw != null ? raw : (await safeRead(adapter, path));
        await adapter.write(`${backupDir}/${name}`, content ?? '');
        await adapter.remove(path);
    } catch { /* best-effort — nie wywalaj migracji przez jeden plik */ }
}

async function safeRead(adapter: MigrationAdapter, path: string): Promise<string> {
    try { return await adapter.read(path); } catch { return ''; }
}

/** Wytnij samą datę YYYY-MM-DD z ISO/timestampu (albo undefined). */
function dateOnly(iso: unknown): string | undefined {
    if (!iso || typeof iso !== 'string') return undefined;
    const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : undefined;
}
