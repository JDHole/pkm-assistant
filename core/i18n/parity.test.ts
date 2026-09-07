/**
 * Parity PL ↔ EN (S27 Z9).
 *
 * Reguła repo: każdy string UI idzie przez `t('...')`, a klucz istnieje w OBU plikach.
 * Brak klucza nie wybucha — `t()` zwraca sam klucz, więc user widzi „backstage.foo" zamiast
 * tekstu. Cichy błąd = najgorszy rodzaj; ten test robi z niego głośny.
 */
import test from 'ava';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pl } from './pl.js';
import { en } from './en.js';

test('i18n: PL i EN mają dokładnie ten sam zestaw kluczy', t => {
    const plKeys = new Set(Object.keys(pl));
    const enKeys = new Set(Object.keys(en));

    const missingInEn = [...plKeys].filter(k => !enKeys.has(k));
    const missingInPl = [...enKeys].filter(k => !plKeys.has(k));

    t.deepEqual(missingInEn, [], 'klucze obecne w pl.js, brakujące w en.js');
    t.deepEqual(missingInPl, [], 'klucze obecne w en.js, brakujące w pl.js');
    t.is(plKeys.size, enKeys.size);
});

test('i18n: żadna wartość nie jest pusta ani nie jest własnym kluczem', t => {
    // Asercja tylko po to, żeby TS nie zrobił z pary `[słownik, nazwa]` unii — kształt
    // tablicy jest tu literalny i niezmienny.
    for (const [dict, name] of [[pl, 'pl'], [en, 'en']] as [Record<string, string>, string][]) {
        for (const [key, value] of Object.entries(dict)) {
            t.is(typeof value, 'string', `${name}: ${key} nie jest stringiem`);
            t.not(value.trim(), '', `${name}: ${key} jest puste`);
            t.not(value, key, `${name}: ${key} to placeholder (wartość = klucz)`);
        }
    }
});

test('i18n: placeholdery {{...}} zgadzają się między PL i EN', t => {
    const placeholders = (value: string): Set<string> =>
        new Set([...String(value).matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]));
    const mismatched = [];

    for (const key of Object.keys(pl)) {
        if (!(key in en)) continue;
        const a = placeholders(pl[key]);
        const b = placeholders(en[key]);
        if (a.size !== b.size || [...a].some(p => !b.has(p))) {
            mismatched.push(`${key}: pl={${[...a].join(',')}} en={${[...b].join(',')}}`);
        }
    }

    t.deepEqual(mismatched, [], 'te klucze mają rozjechane placeholdery — interpolacja zgubi dane');
});

// ─── AUD-bledy-041: klucz użyty w kodzie, którego NIE MA w ŻADNYM słowniku ───
//
// Parytet pl↔en przepuszcza literówkę i klucz wymyślony od zera: brak w OBU plikach
// jest „zgodny". `KomunikatorManager` wołał tak czterech kluczy (`komunikator.*`),
// więc user dostawał w `Notice` napis „komunikator.invalid_recipient", a model ten sam
// napis w polu `error` narzędzia `kom_send`/`kom_read`. Ten test skanuje ŹRÓDŁA.

// Noc 24/25.08: zasięg rozszerzony z jednego katalogu (`modules/komunikator`) na całe
// drzewo źródłowe pluginu — wąski skan łapał tylko literówki w Komunikatorze, a 10 kluczy
// `modal.cost_tracking.*` / `settings.cost_tracking*` (Ustawienia → „Koszty LLM" → modal)
// świeciły gołym kluczem od 2026-07-31 (`988ff55`) bez żadnego strażnika, bo mieszkały
// poza jedynym skanowanym katalogiem. Charakteryzacja mechanizmu + pin stanu repo:
// `core/i18n/parity_repo.test.ts` (ten sam regex, ten sam zestaw katalogów).

/** Katalogi ze źródłami pluginu skanowane pod kątem literałów `t('...')`. */
const SCANNED_DIRS = ['modules', 'core', 'src', 'utils', 'config'];

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Wszystkie `t('klucz')` / `t("klucz")` z pliku. Klucze składane w locie (szablony, zmienne) są poza zasięgiem. */
function literalKeysIn(source: string): string[] {
    return [...source.matchAll(/\bt\(\s*(['"])([^'"\n]+)\1/g)].map(match => match[2]);
}

/** Prefiks sklejanego klucza w locie (np. `t('tool.' + name)`, kończy się kropką) — nie da się go rozstrzygnąć statycznie. */
function isComposedPrefix(key: string): boolean {
    return key.endsWith('.');
}

/** Rekurencyjnie zbiera pliki `.ts` z katalogu — pomija testy, deklaracje typów i śmieci builda/zależności. */
function collectSourceFiles(absolute: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(absolute)) {
        if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
        const full = join(absolute, entry);
        if (statSync(full).isDirectory()) { files.push(...collectSourceFiles(full)); continue; }
        if (!entry.endsWith('.ts') || entry.endsWith('.test.ts') || entry.endsWith('.d.ts')) continue;
        files.push(full);
    }
    return files;
}

test('i18n: każdy klucz t(\'...\') użyty w kodzie modułów istnieje w pl i en', t => {
    const missing: string[] = [];
    let scannedFiles = 0;
    let scannedKeys = 0;

    for (const dir of SCANNED_DIRS) {
        let files: string[];
        try {
            files = collectSourceFiles(join(REPO_ROOT, dir));
        } catch {
            continue; // katalog nieobecny w tym drzewie — nie wybuchaj, po prostu pomiń
        }
        for (const file of files) {
            scannedFiles++;
            const source = readFileSync(file, 'utf8');
            for (const key of literalKeysIn(source)) {
                if (isComposedPrefix(key)) continue;
                scannedKeys++;
                const inPl = key in pl;
                const inEn = key in en;
                if (!inPl || !inEn) {
                    const relative = file.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
                    missing.push(`${relative}: ${key} (pl: ${inPl ? 'jest' : 'BRAK'}, en: ${inEn ? 'jest' : 'BRAK'})`);
                }
            }
        }
    }

    t.true(scannedFiles > 0, 'skan nie znalazł ani jednego pliku źródłowego — zła ścieżka?');
    t.true(scannedKeys > 0, 'skan nie znalazł ani jednego wywołania t() — zły regex?');
    t.deepEqual([...new Set(missing)], [], 'te klucze wyjdą do usera i do modelu jako GOŁY KLUCZ');
});

// ── M (AUD-security-105): etykieta przełącznika mówi to, co przełącznik robi ────
// Wiersz popovera Uprawnień gasi WYŁĄCZNIE `create_folder` (`PERMISSION_SWITCH_TOOLS`
// w `modules/agents/toolAxis.ts`). Pliki agent zakłada przez `write {mode:'create'}`,
// czyli wierszem „Edycja notatek" — napis „Tworzenie plików" obiecywał blokadę, której
// ten przełącznik nie daje. Decyzja K12: popover bez nowych funkcji, prawdę mówi napis.
test('i18n: `chat.popover.create_files` opisuje FOLDERY, nie pliki', t => {
    t.regex(pl['chat.popover.create_files'], /folder/i, 'pl: etykieta ma mówić o folderach');
    t.notRegex(pl['chat.popover.create_files'], /plik/i, 'pl: etykieta nie może obiecywać plików');
    t.regex(en['chat.popover.create_files'], /folder/i, 'en: etykieta ma mówić o folderach');
    t.notRegex(en['chat.popover.create_files'], /file/i, 'en: etykieta nie może obiecywać plików');

    // Kontrola: `perm.create_files` (PermissionSystem) obejmuje vault.create + create_folder
    // + artifact.create — tam „pliki" są PRAWDĄ i etykieta zostaje bez zmian.
    t.regex(pl['perm.create_files'], /plik/i);
});
