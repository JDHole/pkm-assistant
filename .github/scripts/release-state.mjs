// Stan wydania na GitHubie dla workflow "Release" (.github/workflows/release.yml).
//
// Opublikowane wydanie jest NIEZMIENNE: użytkownicy i katalog Obsidiana mogli już pobrać jego
// pliki, a atestacja provenance opisuje dokładnie te bajty. Ten skrypt rozstrzyga, co workflow
// wolno zrobić z tagiem, i jest jedynym miejscem tej reguły.
//
// Użycie:
//   node .github/scripts/release-state.mjs <tag>
//     przed publikacją: wypisuje `absent` albo `partial <id wydania> <brakujące pliki>`, kod 0;
//     wydanie kompletne, uszkodzone albo nieczytelne: komunikat ::error::, kod 1.
//   node .github/scripts/release-state.mjs <tag> --po-publikacji
//     po publikacji: kod 0 tylko wtedy, gdy opublikowane wydanie ma komplet wgranych plików.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REQUIRED_ASSETS = ['main.js', 'manifest.json', 'styles.css'];

/**
 * @param {null | {id: number, assets: Array<{name?: string, state?: string, size?: number}>}} release
 *   Zwalidowana odpowiedź `GET repos/{repo}/releases/tags/{tag}` albo `null`, gdy GitHub zwrócił
 *   404. Ten endpoint zwraca wyłącznie wydania OPUBLIKOWANE - wydań roboczych (draft) nie widzi.
 * @returns {{state: 'absent' | 'complete' | 'partial' | 'broken', id: number | null, missing: string[], broken: string[]}}
 *   absent - nie ma opublikowanego wydania: utwórz je;
 *   complete - komplet trzech plików wgrany i niepusty: odmowa, poprawka idzie w nowym numerze;
 *   partial - brakuje części plików (przerwana publikacja), obecne są całe: dograj brakujące;
 *   broken - wymagany plik wgrany do połowy albo pusty: odmowa, decyduje człowiek.
 *   Dodatkowe pliki w wydaniu nie zmieniają oceny trzech wymaganych.
 */
export function classifyRelease(release) {
    if (release === null) return { state: 'absent', id: null, missing: [...REQUIRED_ASSETS], broken: [] };
    if (!isReleaseShape(release)) throw new Error('Stan wydania nie ma oczekiwanego kształtu (id i lista plików).');
    const missing = [];
    const broken = [];
    for (const name of REQUIRED_ASSETS) {
        const asset = release.assets.find(a => a && a.name === name);
        if (!asset) missing.push(name);
        else if (asset.state !== 'uploaded' || !(typeof asset.size === 'number' && asset.size > 0)) broken.push(name);
    }
    if (broken.length) return { state: 'broken', id: release.id, missing, broken };
    if (!missing.length) return { state: 'complete', id: release.id, missing, broken };
    return { state: 'partial', id: release.id, missing, broken };
}

/** @param {unknown} value */
function isReleaseShape(value) {
    return typeof value === 'object' && value !== null
        && Number.isInteger(/** @type {{id?: unknown}} */ (value).id)
        && Array.isArray(/** @type {{assets?: unknown}} */ (value).assets);
}

/**
 * Pobiera opublikowane wydanie przez `gh api`. 404 znaczy "nie ma"; każdy inny błąd (sieć, 5xx,
 * brak uprawnień) i każda odpowiedź bez `id` i listy plików rzuca - bez znajomości stanu niczego
 * nie publikujemy.
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
    if (!isReleaseShape(parsed)) throw new Error(`GitHub zwrócił stan wydania ${tag} bez id i listy plików.`);
    return parsed;
}

/**
 * Decyzja przed publikacją: co wypisać i z jakim kodem wyjść.
 * @param {string} tag
 * @param {ReturnType<typeof classifyRelease>} verdict
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
            return { code: 1, line: `::error::Wydanie ${tag} ma uszkodzone pliki (${verdict.broken.join(', ')}: wgrane do połowy albo puste). Workflow niczego nie nadpisuje - usuń je ręcznie na stronie wydania i uruchom bieg ponownie.` };
        default:
            return { code: 1, line: `::error::Nieznany stan wydania ${tag}.` };
    }
}

/**
 * Decyzja po publikacji: sukces tylko przy komplecie wgranych plików w opublikowanym wydaniu.
 * @param {string} tag
 * @param {ReturnType<typeof classifyRelease>} verdict
 * @returns {{code: 0 | 1, line: string}}
 */
export function decideAfterPublish(tag, verdict) {
    if (verdict.state === 'complete') return { code: 0, line: `Wydanie ${tag} opublikowane w komplecie (${REQUIRED_ASSETS.join(', ')}).` };
    const detail = verdict.state === 'absent'
        ? 'GitHub nie widzi opublikowanego wydania'
        : `brakuje: ${verdict.missing.join(', ') || '-'}; uszkodzone: ${verdict.broken.join(', ') || '-'}`;
    return { code: 1, line: `::error::Po publikacji wydanie ${tag} nie jest kompletne (${detail}).` };
}

function main() {
    const tag = process.argv[2];
    const afterPublish = process.argv.includes('--po-publikacji');
    const repo = process.env.GITHUB_REPOSITORY;
    if (!tag || tag.startsWith('--') || !repo) {
        console.log('::error::Użycie: node .github/scripts/release-state.mjs <tag> [--po-publikacji] (z ustawionym GITHUB_REPOSITORY).');
        process.exit(1);
    }
    let decision;
    try {
        const verdict = classifyRelease(fetchRelease(repo, tag));
        decision = afterPublish ? decideAfterPublish(tag, verdict) : decideBeforePublish(tag, verdict);
    } catch (e) {
        decision = { code: 1, line: `::error::${e.message}` };
    }
    console.log(decision.line);
    process.exit(decision.code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
