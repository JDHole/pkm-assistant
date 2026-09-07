/**
 * `core/index.ts` musi wstawać w GOŁYM Node — bez Obsidiana.
 *
 * Do clean-room dowodem na to był sam fakt, że AVA odpala testy plików produkcyjnych: gdyby
 * barrel wciągnął `obsidian`, pół zestawu padłoby na starcie. Od chwili, gdy AVA dostała
 * alias `test-support/register-obsidian-for-ava.mjs` (`nodeArguments` w `package.json`),
 * ten dowód PRZESTAŁ ISTNIEĆ: w każdym teście `obsidian` jest rozwiązywalny, więc
 * przypadkowy import obsidianowego pliku do barrela przeszedłby niezauważony i wywalił
 * się dopiero u usera.
 *
 * Dlatego ten test wychodzi z procesu AVA i odpala barrel w OSOBNYM Node BEZ aliasu.
 * Jedyne, co dokłada, to `--import=tsx` (transpilacja TS + kontrakt specifierów `.js`,
 * patrz `Refaktor/Decyzje_Sesji/2026-07-30_ts0_raport.md`).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Środowisko potomka bez niczego, co mogłoby PODŁOŻYĆ mu `obsidian` bocznymi drzwiami.
 * `NODE_OPTIONS` potrafi nieść cudze `--import`, a wtedy test dowodziłby tylko tego,
 * że alias działa.
 */
function czysteSrodowisko(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    return env;
}

test('barrel core wstaje w gołym Node — bez mocka `obsidian`', t => {
    const wynik = spawnSync(
        process.execPath,
        ['--import=tsx', '-e', "import('./core/index.js').then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})"],
        { cwd: REPO_ROOT, env: czysteSrodowisko(), encoding: 'utf8', timeout: 120_000 },
    );

    t.is(
        wynik.status,
        0,
        `core/index.ts nie wstał bez Obsidiana:\n${wynik.stderr || wynik.stdout || wynik.error?.message || '(bez wyjścia)'}`,
    );
});
