# Release process — ARCHIWUM (era v2.0, do v2.0.0 stable 2026-05-17)

> **Ten runbook jest historyczny i NIE obowiązuje od modelu branchy v2.1+.** Publikował RC przez branch `refactor/v2.0` (dziś kotwica historyczna — merge do niego zabroniony) i uruchamiał tylko `test`+`build` z siedmiu bramek wymaganych dzisiaj. Bieżący runbook: [`../RELEASE_PROCESS.md`](../RELEASE_PROCESS.md).

Ten plik jest runbookiem dla S13c i kolejnych wydan.

## RC v2.0

1. Pracuj na branchu sprintu, nie na `main`.
2. Ustaw wersje w `manifest.json`, `package.json`, `package-lock.json` i `versions.json`.
3. Uruchom:

```bash
npm.cmd test
npm.cmd run build
```

4. Commituj release prep na branchu sprintu.
5. Push branch sprintu.
6. Merge `--no-ff` do `refactor/v2.0`.
7. Utworz PR `refactor/v2.0` -> `main`.

## Po merge PR do main

Kuba merguje PR recznie. Dopiero wtedy:

```bash
git checkout main
git pull origin main
git tag v2.0.0-rc.1
git push origin v2.0.0-rc.1
```

Potem GitHub release jako prerelease:

```bash
gh release create v2.0.0-rc.1 --prerelease --notes-file releases/v2.0/release_notes.md --title "Obsek v2.0.0-rc.1"
gh release upload v2.0.0-rc.1 dist/main.js dist/manifest.json dist/styles.css
```

## Stable v2.0.0

Po tygodniu testow RC, jesli smoke jest zielony:

1. bump `2.0.0-rc.1` -> `2.0.0`,
2. test + build,
3. merge do `main`,
4. tag `v2.0.0`,
5. GitHub release bez `--prerelease`.
