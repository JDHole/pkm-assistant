/**
 * Strażnik dryfu dokumentacji.
 *
 * DLACZEGO ten plik istnieje: publiczny `CLAUDE.md` (po angielsku) stawia regułę
 * "Documentation that lies is treated as a bug" (sekcja "Documentation rule");
 * to samo po polsku niesie `CLAUDE.local.md` (sekcja "Dla agenta"), prywatna kopia
 * dawnej treści tego pliku - ale nic w repo tej reguły nie egzekwuje. Lint pilnuje
 * kodu, typecheck pilnuje typów, a dokumentacja może się rozjechać z package.json
 * i drzewem modułów bez ani jednego czerwonego sygnału. Tu są pierwsze dwa
 * strażniki tej reguły.
 *
 * ZAKRES: wyłącznie dokumenty ŻYWE (root + per-moduł). Świadomie pomijamy
 * `Refaktor/` i `Nauka/` — główny CLAUDE.md nazywa je archiwum ery v2.0 i zakazuje
 * ich poprawiania („nie poprawiamy ich, bo sfałszowałoby to historię"), więc pilnowanie
 * ich aktualności byłoby pilnowaniem historii.
 *
 * Te testy pinują stan, NIE zmieniają zachowania pluginu.
 */
import test from 'ava';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** Dokumenty żywe — te, które opisują DZISIEJSZY plugin i mają nie kłamać. */
function zywieDokumenty(): string[] {
    const stale = [
        'CLAUDE.md',
        'CLAUDE.local.md',
        'README.md',
        'QUICK_START.md',
        'RELEASE_PROCESS.md',
        'SECURITY.md',
        'core/CLAUDE.md',
        'core/SECURITY.md',
    ];
    const modulowe = readdirSync(join(ROOT, 'modules'), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => `modules/${d.name}/CLAUDE.md`);
    return [...stale, ...modulowe].filter((p) => existsSync(join(ROOT, p)));
}

/**
 * `npm run dev` bywał reklamowany w CLAUDE.md („Build z watch mode") i w README.md
 * („Watch mode for development"), zanim taki skrypt istniał w `package.json` — user szedł
 * za README i dostawał błąd npm zamiast build-watcha.
 *
 * `esbuild.js` stoi na `esbuild.context()`: `npm run build` robi `ctx.rebuild()` +
 * `ctx.dispose()` (zachowanie jednorazowego builda), `npm run dev` (`node esbuild.js --watch`)
 * robi `ctx.watch()` i zostaje żywy. Deploy do `DESTINATION_VAULTS` jedzie przez wspólny
 * `onEnd` pluginu (`deploy_plugin`), więc odpala się po KAŻDYM udanym buildzie — jednorazowym
 * i każdym rebuildzie watcha — bez duplikowania logiki kopiowania. `.hotreload` marker już
 * istnieje w deployu (dla community pluginu Hot-Reload w Obsidianie), więc `npm run dev`
 * domyka istniejącą infrastrukturę, a nie dokłada nowej funkcji pluginowi.
 */
/**
 * Dokumentacja wskazuje też komendy CUDZEGO repo — harnessu „Szklane Pudło"
 * (https://github.com/JDHole/pkm-assistant-harness), który żyje poza tym repo, bo walidator
 * katalogu lintuje CAŁE repo pluginu. Te komendy MAJĄ być nieobecne w naszym package.json,
 * więc są tu wypisane z nazwy — lista celowo krótka i zamknięta, żeby literówka w komendzie
 * pluginu dalej wychodziła na czerwono.
 */
const KOMENDY_OBCYCH_REPO = new Set(['selftest', 'scenarios', 'scenarios:live']);

test('kazda komenda `npm run X` z zywej dokumentacji istnieje w package.json', (t) => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
    };
    const skrypty = new Set(Object.keys(pkg.scripts ?? {}));

    const widma: string[] = [];
    for (const dok of zywieDokumenty()) {
        const tresc = readFileSync(join(ROOT, dok), 'utf8');
        for (const dopasowanie of tresc.matchAll(/npm run ([a-z][a-z0-9:_-]*)/g)) {
            const nazwa = dopasowanie[1];
            if (KOMENDY_OBCYCH_REPO.has(nazwa)) continue;
            if (!skrypty.has(nazwa)) widma.push(`${dok}: npm run ${nazwa}`);
        }
    }

    t.deepEqual(
        [...new Set(widma)],
        [],
        'dokumentacja reklamuje komendy, ktorych nie ma w package.json',
    );
});

/**
 * ZŁOTA ZASADA z głównego CLAUDE.md: „Każdy moduł to fizyczny folder w modules/<nazwa>/
 * z index.js (jedyne drzwi publiczne) i CLAUDE.md (dokumentacja modułu)". Ten test
 * egzekwuje ją na drzewie plików — dotąd pilnowała jej wyłącznie dyscyplina autora.
 *
 */
test('kazdy modul ma CLAUDE.md i publiczne drzwi (index)', (t) => {
    const braki: string[] = [];
    for (const wpis of readdirSync(join(ROOT, 'modules'), { withFileTypes: true })) {
        if (!wpis.isDirectory()) continue;
        const modul = wpis.name;
        const sciezka = join(ROOT, 'modules', modul);

        if (!existsSync(join(sciezka, 'CLAUDE.md'))) braki.push(`modules/${modul}/CLAUDE.md`);

        const maDrzwi =
            existsSync(join(sciezka, 'index.ts')) || existsSync(join(sciezka, 'index.js'));
        if (!maDrzwi) braki.push(`modules/${modul}/index.ts`);
    }

    t.deepEqual(braki, [], 'moduly bez dokumentacji albo bez publicznych drzwi');
});
