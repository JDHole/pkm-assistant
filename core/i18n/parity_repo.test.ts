/**
 * Strażnik zasięgu skanu źródeł i18n.
 *
 * `parity.test.ts` skanuje literały `t('...')`, ale ograniczone do jednego katalogu:
 * `SCANNED_DIRS = ['modules/komunikator']` z dopiskiem „Dokładaj kolejne, gdy przyjdzie ich
 * kolej". Parytet pl↔en tej klasy nie łapie z definicji - klucz nieobecny w OBU słownikach
 * jest dla niego „zgodny".
 *
 * Ten plik nie zmienia zachowania pluginu: charakteryzuje mechanizm (żeby było czarno na
 * białym, DLACZEGO brak klucza wychodzi na ekran) i pinuje stan skanu całego repo.
 */
import test from 'ava';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pl } from './pl.js';
import { en } from './en.js';
import { t as tr } from './index.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Katalogi z kodem produkcyjnym pluginu - ten sam zbiór, który biorą oba linty. */
const REPO_DIRS = ['modules', 'core', 'src', 'utils', 'config'];

/**
 * Wszystkie `t('klucz')` / `t("klucz")` z pliku - regex 1:1 z `parity.test.ts`.
 * Klucze SKŁADANE w locie (`t('tool.' + name)`) zostawiają tu sam prefiks i są odsiewane niżej,
 * bo żaden skan statyczny ich nie rozstrzygnie.
 */
function literalKeysIn(source: string): string[] {
    return [...source.matchAll(/\bt\(\s*(['"])([^'"\n]+)\1/g)].map(match => match[2]);
}

/** Prefiks sklejanego klucza (kończy się kropką) - nie da się go sprawdzić statycznie. */
function isComposedPrefix(key: string): boolean {
    return key.endsWith('.');
}

interface ScanResult {
    files: number;
    keys: number;
    missing: string[];
}

function scanDirs(dirs: string[]): ScanResult {
    const missing: string[] = [];
    let files = 0;
    let keys = 0;

    const walk = (absolute: string): void => {
        for (const entry of readdirSync(absolute)) {
            if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
            const full = join(absolute, entry);
            if (statSync(full).isDirectory()) { walk(full); continue; }
            if (!entry.endsWith('.ts') || entry.endsWith('.test.ts') || entry.endsWith('.d.ts')) continue;
            files++;
            for (const key of literalKeysIn(readFileSync(full, 'utf8'))) {
                if (isComposedPrefix(key)) continue;
                keys++;
                const inPl = key in pl;
                const inEn = key in en;
                if (!inPl || !inEn) {
                    const relative = full.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
                    missing.push(`${relative}: ${key} (pl: ${inPl ? 'jest' : 'BRAK'}, en: ${inEn ? 'jest' : 'BRAK'})`);
                }
            }
        }
    };

    for (const dir of dirs) {
        try { walk(join(REPO_ROOT, dir)); } catch { /* katalog nieobecny w tym drzewie */ }
    }
    return { files, keys, missing: [...new Set(missing)] };
}

// ─── charakteryzacja mechanizmu (zielone) ──────────────────────────────────────

test('i18n: nieznany klucz wraca SAM DO SIEBIE, więc `t(k) || fallback` jest martwym kodem', t => {
    const nieistniejacy = 'noc.2026_08_25.klucza_takiego_nie_ma';
    t.is(tr(nieistniejacy), nieistniejacy);
    // To jest sedno: wołacze piszą `t('x') || 'Polski tekst'`, licząc na podmianę.
    // `t()` oddaje niepusty string, więc `||` NIGDY nie wchodzi i user widzi goły klucz.
    t.is(tr(nieistniejacy) || 'zapasowy tekst', nieistniejacy);
});

test('i18n: skan repo w ogóle działa - widzi pliki i wywołania t()', t => {
    const { files, keys } = scanDirs(REPO_DIRS);
    t.true(files > 100, `skan objął ${files} plików - zła ścieżka?`);
    t.true(keys > 500, `skan znalazł ${keys} wywołań t() - zły regex?`);
});

test('i18n: dotychczasowy zasięg strażnika (modules/komunikator) jest czysty', t => {
    // Kontrola, że pin niżej nie jest regresem w obszarze już pokrytym wcześniej.
    t.deepEqual(scanDirs(['modules/komunikator']).missing, []);
});

// ─── pin: zasięg strażnika domknięty (zielone) ──────────────────

test('i18n: KAŻDY literalny klucz t() w repo istnieje w pl i en', t => {
    // Brakujący klucz pokazuje się userowi jako goły napis (np. `settings.cost_tracking`)
    // zamiast przetłumaczonego tekstu. `SCANNED_DIRS` w `parity.test.ts` obejmuje tu całe
    // repo (`REPO_DIRS`), nie jeden katalog, więc klucz dodany gdziekolwiek zostaje złapany.
    t.deepEqual(scanDirs(REPO_DIRS).missing, []);
});
