// Stan wydania na GitHubie dla workflow "Release" (.github/workflows/release.yml).
//
// Opublikowane wydanie jest NIEZMIENNE: użytkownicy i katalog Obsidiana mogli już pobrać jego
// pliki, a atestacja provenance opisuje dokładnie te bajty. Ten skrypt rozstrzyga, co workflow
// wolno zrobić z tagiem, i jest jedynym miejscem tej reguły.
//
// Użycie:
//   node .github/scripts/release-state.mjs <tag> [--porownaj <katalog>]
//     przed publikacją: wypisuje `absent` albo `partial <id wydania> <brakujące pliki>`, kod 0;
//     wydanie kompletne, uszkodzone, z plikiem z innego buildu albo nieczytelne: ::error::, kod 1.
//   node .github/scripts/release-state.mjs <tag> --po-publikacji [--porownaj <katalog>]
//     po publikacji: kod 0 tylko wtedy, gdy opublikowane wydanie ma komplet wgranych plików
//     (a z --porownaj: identycznych z plikami w katalogu, czyli z tym buildem).
// `--porownaj` liczy sha256 plików w katalogu i porównuje z polem `digest` z GitHuba.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_ASSETS = ['main.js', 'manifest.json', 'styles.css'];

/**
 * @typedef {{name: string, state?: string, size?: number, digest?: string | null}} Asset
 * @typedef {{state: 'absent' | 'complete' | 'partial' | 'broken', id: number | null, missing: string[], broken: string[], foreign: string[]}} Verdict
 */

/**
 * @param {null | {id: number, assets: Asset[]}} release
 *   Odpowiedź `GET repos/{repo}/releases/tags/{tag}` albo `null`, gdy GitHub zwrócił 404.
 *   Ten endpoint zwraca wyłącznie wydania OPUBLIKOWANE - wydań roboczych (draft) nie widzi.
 * @param {Record<string, string> | null} [localDigests]
 *   `sha256:<hex>` plików bieżącego buildu. Gdy podane, wgrany plik o innej sumie jest z innego
 *   buildu i blokuje publikację tak samo jak plik uszkodzony.
 * @returns {Verdict}
 *   absent - nie ma opublikowanego wydania: utwórz je;
 *   complete - komplet trzech plików wgrany i niepusty (i zgodny z buildem): odmowa przed
 *     publikacją, sukces po publikacji;
 *   partial - brakuje części plików (przerwana publikacja), obecne są całe: dograj brakujące;
 *   broken - wymagany plik wgrany do połowy, pusty albo z innego buildu: odmowa, decyduje człowiek.
 *   Dodatkowe pliki w wydaniu nie zmieniają oceny trzech wymaganych.
 */
export function classifyRelease(release, localDigests = null) {
    if (release === null) return { state: 'absent', id: null, missing: [...REQUIRED_ASSETS], broken: [], foreign: [] };
    if (!isReleaseShape(release)) throw new Error('Stan wydania nie ma oczekiwanego kształtu (id i lista plików z nazwami).');
    const missing = [];
    const broken = [];
    const foreign = [];
    for (const name of REQUIRED_ASSETS) {
        const asset = release.assets.find(a => a.name === name);
        if (!asset) missing.push(name);
        else if (asset.state !== 'uploaded' || !(typeof asset.size === 'number' && asset.size > 0)) broken.push(name);
        else if (localDigests && asset.digest !== localDigests[name]) foreign.push(name);
    }
    if (broken.length || foreign.length) return { state: 'broken', id: release.id, missing, broken, foreign };
    if (!missing.length) return { state: 'complete', id: release.id, missing, broken, foreign };
    return { state: 'partial', id: release.id, missing, broken, foreign };
}

/** @param {unknown} value */
function isReleaseShape(value) {
    if (typeof value !== 'object' || value === null) return false;
    const { id, assets } = /** @type {{id?: unknown, assets?: unknown}} */ (value);
    return Number.isInteger(id) && Array.isArray(assets)
        && assets.every(a => typeof a === 'object' && a !== null && typeof /** @type {{name?: unknown}} */ (a).name === 'string');
}

/**
 * Pobiera opublikowane wydanie przez `gh api`. 404 znaczy "nie ma"; każdy inny błąd (sieć, 5xx,
 * brak uprawnień) i każda odpowiedź bez `id` i listy plików z nazwami rzuca - bez znajomości
 * stanu niczego nie publikujemy.
 * @param {string} repo `owner/name`
 * @param {string} tag
 * @param {typeof execFileSync} [run]
 */
export function fetchRelease(repo, tag, run = execFileSync) {
    let out;
    try {
        out = run('gh', ['api', `repos/${repo}/releases/tags/${tag}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        const stderr = String((e && e.stderr) || '');
        if (/\(HTTP 404\)/.test(stderr)) return null;
        throw new Error(`Nie da się odczytać stanu wydania ${tag} z GitHuba: ${stderr.trim() || (e && e.message) || e}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(String(out));
    } catch {
        throw new Error(`GitHub zwrócił nieczytelny stan wydania ${tag}.`);
    }
    if (!isReleaseShape(parsed)) throw new Error(`GitHub zwrócił stan wydania ${tag} bez id i listy plików z nazwami.`);
    return parsed;
}

/**
 * `sha256:<hex>` trzech wymaganych plików w katalogu (ten sam format co pole `digest` GitHuba).
 * @param {string} dir
 * @param {(path: string) => Buffer} [read]
 */
export function localDigestsOf(dir, read = readFileSync) {
    return Object.fromEntries(REQUIRED_ASSETS.map(name => [name, 'sha256:' + createHash('sha256').update(read(join(dir, name))).digest('hex')]));
}

/** @param {Verdict} verdict */
function brokenDetail(verdict) {
    const parts = [];
    if (verdict.broken.length) parts.push(`${verdict.broken.join(', ')}: wgrane do połowy albo puste`);
    if (verdict.foreign.length) parts.push(`${verdict.foreign.join(', ')}: z innego buildu niż ten bieg`);
    return parts.join('; ');
}

/**
 * Decyzja przed publikacją: co wypisać i z jakim kodem wyjść.
 * @param {string} tag
 * @param {Verdict} verdict
 * @returns {{code: 0 | 1, line: string}}
 */
export function decideBeforePublish(tag, verdict) {
    switch (verdict.state) {
        case 'absent':
            return { code: 0, line: 'absent' };
        case 'partial':
            return { code: 0, line: `partial ${verdict.id} ${verdict.missing.join(' ')}` };
        case 'complete':
            return { code: 1, line: `::error::Wydanie ${tag} jest już opublikowane w komplecie i jest niezmienne. Poprawka idzie w nowym numerze patch; nie przesuwaj taga.` };
        case 'broken':
            return { code: 1, line: `::error::Wydanie ${tag} ma pliki, których nie wolno uzupełnić (${brokenDetail(verdict)}). Workflow niczego nie nadpisuje - usuń je ręcznie na stronie wydania i uruchom bieg ponownie.` };
        default:
            return { code: 1, line: `::error::Nieznany stan wydania ${tag}.` };
    }
}

/**
 * Decyzja po publikacji: sukces tylko przy komplecie wgranych plików w opublikowanym wydaniu.
 * @param {string} tag
 * @param {Verdict} verdict
 * @returns {{code: 0 | 1, line: string}}
 */
export function decideAfterPublish(tag, verdict) {
    if (verdict.state === 'complete') return { code: 0, line: `Wydanie ${tag} opublikowane w komplecie (${REQUIRED_ASSETS.join(', ')}).` };
    let detail;
    if (verdict.state === 'absent') detail = 'GitHub nie widzi opublikowanego wydania';
    else if (verdict.state === 'broken') detail = brokenDetail(verdict);
    else detail = `brakuje: ${verdict.missing.join(', ')}`;
    return { code: 1, line: `::error::Po publikacji wydanie ${tag} nie jest kompletne (${detail}).` };
}

function main() {
    const args = process.argv.slice(2);
    const tag = args[0];
    const afterPublish = args.includes('--po-publikacji');
    const cmpIndex = args.indexOf('--porownaj');
    const cmpDir = cmpIndex >= 0 ? args[cmpIndex + 1] : null;
    const repo = process.env.GITHUB_REPOSITORY;
    if (!tag || tag.startsWith('--') || !repo || (cmpIndex >= 0 && !cmpDir)) {
        console.log('::error::Użycie: node .github/scripts/release-state.mjs <tag> [--po-publikacji] [--porownaj <katalog>] (z ustawionym GITHUB_REPOSITORY).');
        process.exit(1);
    }
    let decision;
    try {
        const verdict = classifyRelease(fetchRelease(repo, tag), cmpDir ? localDigestsOf(cmpDir) : null);
        decision = afterPublish ? decideAfterPublish(tag, verdict) : decideBeforePublish(tag, verdict);
    } catch (e) {
        decision = { code: 1, line: `::error::${e.message}` };
    }
    console.log(decision.line);
    process.exit(decision.code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
