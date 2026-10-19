// Stan wydania na GitHubie dla workflow "Release" (.github/workflows/release.yml).
//
// Opublikowane wydanie jest NIEZMIENNE: użytkownicy i katalog Obsidiana mogli już pobrać jego
// pliki, a atestacja provenance opisuje dokładnie te bajty. Ten skrypt rozstrzyga, co workflow
// wolno zrobić z tagiem, i jest jedynym miejscem tej reguły (woła go krok startowy i krok
// publikacji).
//
// Użycie: node .github/scripts/release-state.mjs <tag>
// Wypisuje jedną linię: `absent` albo `partial <brakujące pliki>` i kończy się kodem 0.
// Wydanie kompletne, uszkodzone albo nieczytelne kończy skrypt kodem 1 z komunikatem ::error::.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REQUIRED_ASSETS = ['main.js', 'manifest.json', 'styles.css'];

/**
 * @param {null | {assets?: Array<{name?: string, state?: string, size?: number}>}} release
 *   Odpowiedź `GET repos/{repo}/releases/tags/{tag}` albo `null`, gdy GitHub zwrócił 404.
 *   Ten endpoint zwraca wyłącznie wydania OPUBLIKOWANE - wydań roboczych (draft) nie widzi.
 * @returns {{state: 'absent' | 'complete' | 'partial' | 'broken', missing: string[], broken: string[]}}
 *   absent - nie ma opublikowanego wydania: utwórz je;
 *   complete - komplet trzech plików wgrany i niepusty: odmowa, poprawka idzie w nowym numerze;
 *   partial - brakuje części plików (przerwana publikacja), obecne są całe: dograj brakujące;
 *   broken - wymagany plik wgrany do połowy albo pusty: odmowa, decyduje człowiek.
 *   Dodatkowe pliki w wydaniu nie zmieniają oceny trzech wymaganych.
 */
export function classifyRelease(release) {
    if (release === null) return { state: 'absent', missing: [...REQUIRED_ASSETS], broken: [] };
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const missing = [];
    const broken = [];
    for (const name of REQUIRED_ASSETS) {
        const asset = assets.find(a => a && a.name === name);
        if (!asset) missing.push(name);
        else if (asset.state !== 'uploaded' || !(typeof asset.size === 'number' && asset.size > 0)) broken.push(name);
    }
    if (broken.length) return { state: 'broken', missing, broken };
    if (!missing.length) return { state: 'complete', missing, broken };
    return { state: 'partial', missing, broken };
}

/**
 * Pobiera opublikowane wydanie przez `gh api`. 404 znaczy "nie ma"; każdy inny błąd (sieć, 5xx,
 * brak uprawnień, nieczytelna odpowiedź) rzuca - bez znajomości stanu niczego nie publikujemy.
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
    try {
        return JSON.parse(String(out));
    } catch {
        throw new Error(`GitHub zwrócił nieczytelny stan wydania ${tag}.`);
    }
}

function main() {
    const tag = process.argv[2];
    const repo = process.env.GITHUB_REPOSITORY;
    if (!tag || !repo) {
        console.log('::error::Użycie: node .github/scripts/release-state.mjs <tag> (z ustawionym GITHUB_REPOSITORY).');
        process.exit(1);
    }
    let verdict;
    try {
        verdict = classifyRelease(fetchRelease(repo, tag));
    } catch (e) {
        console.log(`::error::${e.message}`);
        process.exit(1);
    }
    if (verdict.state === 'complete') {
        console.log(`::error::Wydanie ${tag} jest już opublikowane w komplecie i jest niezmienne. Poprawka idzie w nowym numerze patch; nie przesuwaj taga.`);
        process.exit(1);
    }
    if (verdict.state === 'broken') {
        console.log(`::error::Wydanie ${tag} ma uszkodzone pliki (${verdict.broken.join(', ')}: wgrane do połowy albo puste). Workflow niczego nie nadpisuje - usuń je ręcznie na stronie wydania i uruchom bieg ponownie.`);
        process.exit(1);
    }
    console.log(verdict.state === 'absent' ? 'absent' : `partial ${verdict.missing.join(' ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
