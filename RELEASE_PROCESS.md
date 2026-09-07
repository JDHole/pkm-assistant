# Release process (v2.2+)

> Zastępuje runbook epoki v2.0 — przeniesiony do archiwum: [`releases/RELEASE_PROCESS_v2.0_ARCHIWUM.md`](releases/RELEASE_PROCESS_v2.0_ARCHIWUM.md) (publikował RC przez martwy branch `refactor/v2.0`, pomijał 5 z 7 bramek). Ten plik opisuje, co skrypty i workflow repo REALNIE robią dziś — sprawdzone czytaniem `release.js`, `utils/releaseNotes.ts`, `esbuild.js` i [`.github/workflows/release.yml`](.github/workflows/release.yml) na HEAD, nie z pamięci.
>
> **Od 2026-09-07 wydanie publikuje GitHub Actions, nie lokalna maszyna.** `release.js` (`npm run release`) zostaje skryptem PRZYGOTOWANIA: sprawdza spójność wersji, gotuje notatki, robi lokalny rebuild kontrolny. Publikację (build na czystym Linuksie, atestacja provenance, `gh release create` z DOKŁADNIE trzema plikami) robi workflow „Release" po pushu taga. Powód zmiany: raport walidatora katalogu Obsidiana (2026-09-06) chciał weryfikowalnej proweniencji assetów i release'u bez zbędnych plików (dawny zip i `THIRD-PARTY-LICENSES.md` katalog ignorował i wytykał).

## Zasada: wersja i tag idą z plików, nigdy ze sztywnego zapisu

Źródło prawdy to `package.json` (`version`), `manifest.json` (`version` + `minAppVersion`), `package-lock.json` (`version`) i `versions.json` (mapa wersja→minAppVersion). `release.js` twardo sprawdza `package.json.version === manifest.json.version` i przerywa (`exit 1`) na niezgodności — nie ma żadnego automatu, który to za ciebie naprawi.

**Tag release'u = `manifest.json.version`, znak w znak, BEZ litery `v`.** To wymóg katalogu
społeczności Obsidiana, nie nasza preferencja: katalog szuka release'u o tagu równym wersji
z manifestu i dopiero z niego bierze `main.js`, `manifest.json` i `styles.css`. Tagi
`v1.2.1`, `v2.0.0`, `v2.1.0` zostają w historii jako świadectwo epoki sprzed katalogu —
**od `2.2.0` tagujemy bez prefiksu** (szczegóły przy Kroku 5.2).

## Wymagania maszyny releasującej

Do `npm run release` (Krok 5, sama PRZYGOTOWANIE) wystarczy Node w wersji z `engines.node`
w `package.json`. Skrypt nie łączy się z siecią, nie potrzebuje żadnego tokena ani
binarki `curl` — publikacja (build, atestacja, wydanie na GitHubie) dzieje się osobno,
w chmurze, na maszynie GitHuba, po pushu taga (Krok 6–7).

Na Twojej maszynie przydaje się jeszcze `gh` CLI (GitHub CLI) — nie do wydania samego
w sobie, tylko do wygodnej weryfikacji PO fakcie (Krok 7): `gh run watch`, `gh release view`,
`gh attestation verify`. Bez `gh` też się obejdzie — wszystko widać w przeglądarce, na
zakładce Actions i na stronie wydania.

---

## Krok 1 — branch od main

```bash
git checkout main
git pull origin main
git checkout -b refactor/v2.2-release-<wersja>
```

## Krok 2 — bump wersji

- `package.json` → pole `version` (to jest właściwe źródło prawdy — czyta je i `esbuild.js`, i `release.js`).
- `package-lock.json` → pole `version` w dwóch miejscach (root + `packages[""]`).
- `versions.json` → dopisz nowy wpis `"<wersja>": "<minAppVersion>"`, gdzie `<minAppVersion>` to aktualna wartość `manifest.json.minAppVersion` (na HEAD to `1.2.3` — zweryfikuj, bo mogła się zmienić).
- `manifest.json` → pole `version` możesz zostawić bez ręcznej edycji: **`npm run build` nadpisuje je wartością z `package.json` automatycznie** (stemplowanie manifestu w `esbuild.js` — dzieje się przy KAŻDYM buildzie). Masz `npm run build` w bramkach kroku 3, więc do tego momentu `manifest.json` i tak się zsynchronizuje.

⚠️ **Pułapka:** ten auto-zapis `manifest.json` przez `npm run build` zostawia zmianę w working tree. Zanim zrobisz commit release prep, sprawdź `git status` — `manifest.json` MUSI wejść do tego samego commita, inaczej `release.js` odbije się o guard niezgodności wersji.

Commituj bump (i przebudowany `manifest.json`) na branchu roboczym.

## Krok 3 — bramki, wszystkie zielone

```bash
npm test
npm run typecheck
npm run lint
npm run lint:obsidian
npm run build
```

Plus bramka harnessu „Szklane Pudło" — od 2026-09-07 mieszka w OSOBNYM repo
(https://github.com/JDHole/pkm-assistant-harness), bo walidator katalogu lintuje CAŁE repo
pluginu, a narzędzie testowe nie jest jego częścią. Sklonuj je OBOK katalogu pluginu
(`Desktop/pkm-assistant-harness`), raz zainstaluj zależności (`npm install`) i puść:

```bash
cd ../pkm-assistant-harness
npm run selftest
npm run scenarios
```

To te same bramki co w root `CLAUDE.md` (sekcja „Git flow"). `lint:obsidian` nie ma żadnego wyjątku ani porównania z baseline — ma wyjść zielony (`exit 0`), tak jak reszta. Czerwone cokolwiek → STOP, napraw, dopiero potem dalej.

> Jeśli masz `DESTINATION_VAULTS` ustawione w swoim `.env` (auto-deploy pluginu do vaulta po buildzie, patrz `esbuild.js`), `npm run build` w tym kroku (i drugi raz wewnątrz `release.js` w kroku 5) wdroży bieżący build do tych vaultów jak przy zwykłej pracy deweloperskiej — to nie jest coś specjalnego dla release'u, ale warto wiedzieć, że się dzieje.

## Krok 4 — merge do main

```bash
git push origin refactor/v2.2-release-<wersja>
git checkout main
git merge --no-ff refactor/v2.2-release-<wersja>
git push origin main
```

## Krok 5 — `npm run release` (na czystym `main`) — TYLKO przygotowanie

Co skrypt (`release.js`, helpery w `utils/releaseNotes.ts`, `utils/releasePrep.ts`) robi krok po kroku — i tylko tyle, ŻADNEGO kontaktu z GitHubem:

1. **Walidacja wersji.** Czyta `version` z `package.json` i `manifest.json` — różnica = `exit 1`. Skrypt SAM niczego nie bumpuje, to musiało się stać w kroku 2.
2. **Potwierdzenie wersji — wciśnij ENTER.** Skrypt pyta na konsoli `Confirm release version (X.Y.Z): `. **Enter bierze GOŁĄ wartość z `package.json`, BEZ prefiksu `v` — i to jest zachowanie POPRAWNE.** To, co wpiszesz (albo zatwierdzisz Enterem), leci do nazwy pliku notatek `releases/<wersja>.md` i — dopiero w Kroku 6, ręcznie — do `git tag`.

   ⚠️ **Katalog społeczności Obsidiana wymaga, żeby tag release'u był DOKŁADNIE równy `manifest.json.version` — bez litery `v`.** Katalog pobiera `main.js`, `manifest.json` i `styles.css` z release'u o tagu równym wersji z manifestu; tag `v2.2.0` przy `"version": "2.2.0"` = plugin nie do zainstalowania z katalogu. Workflow `release.yml` sprawdza to jeszcze raz po pushu taga i obala bramkę na niezgodności, zanim cokolwiek zbuduje.

   **Tagi historyczne `v1.2.1`, `v2.0.0`, `v2.1.0` zostają jak są** — to historia sprzed drogi do katalogu, nie ruszamy jej. **Od `2.2.0` w górę tagi są bez `v`.** Rozjazd w liście tagów jest świadomy i zamierzony.
3. **Notatki wydania.** Jeśli `releases/<wersja>.md` już istnieje, bierze go 1:1. Jeśli nie — łączy najnowszy istniejący numerowany plik z `releases/` (jeśli jest) z opisem, o który zapyta na konsoli, i zapisuje wynik do `releases/<wersja>.md`.
   ⚠️ Ten punkt opisuje docelowe zachowanie po naprawie z równoległej sesji 2026-08-27 (AUD-docs-009): bez niej pusty `releases/` — czyli ANI jednego pliku `X.Y.Z.md` — wywalał skrypt na zapisie do `null` (`fs.writeFileSync(null, …)` na ścieżce liczonej WYŁĄCZNIE do odczytu). Naprawa: ścieżka zapisu (`resolveNotesTarget`) jest dziś zawsze-nie-null i nie dotyka dysku — helper do odczytu poprzednich notatek (`latestReleaseFile`) służy odtąd tylko do tego.
   ⚠️ Ten plik jest też bramką w CI: `release.yml` sprawdza `releases/<tag>.md` po pushu taga i przerywa workflow (`exit 1`), jeśli go nie ma — zrób ten krok PRZED tagiem, nie po.
4. **`releases/latest_release.md`.** Generuje sformatowaną wersję not (nagłówek + zwinięte starsze patch'e) pod widok w samym pluginie (`ReleaseNotesView` — ekran „co nowego" po starcie).
5. **Rebuild kontrolny.** Odpala build jeszcze raz — `node esbuild.js` wprost przez bieżącego Node'a (to samo, co `npm run build`; `spawnSync('npm.cmd')` bez powłoki pada na Windows z `EINVAL` od Node ≥ 20.12) — świeży lokalny `dist/` dokładnie pod potwierdzoną wersję. Błąd builda przerywa skrypt PRZED commitem i tagiem — to jedyny cel tego kroku dzisiaj, bo `dist/` z tego przebiegu nigdy nie trafia na wydanie (asset builduje osobno, na czystym Linuksie, workflow z kroku 6).

Na końcu skrypt wypisuje na konsoli krótką listę kroków 6–7 (commit notatek, `git tag`, push, gdzie patrzeć) — to jest ten sam tekst, co niżej.

## Krok 6 — commit, tag, push (ręcznie, na `main`)

`release.js` NIE tworzy taga i NIE dotyka GitHuba — to teraz w całości ręczne, dokładnie te cztery komendy:

```bash
git add releases/<wersja>.md releases/latest_release.md
git commit -m "docs(release): notatki <wersja>"
git tag <wersja>
git push origin main && git push origin <wersja>
```

`<wersja>` to gołe semver **BEZ litery `v`** (np. `2.2.0`) — patrz Krok 5.2. Push taga jest
momentem, który uruchamia publikację: `.github/workflows/release.yml` reaguje na wzorzec
tagów `[0-9]+.[0-9]+.[0-9]+` (bez `v`) i od tego momentu wszystko dzieje się w Actions, nie
na Twojej maszynie.

## Krok 7 — zweryfikuj wydanie

1. **Zakładka Actions → workflow „Release".** Bieg startuje w kilka sekund po pushu taga.
   Robi PONOWNIE wszystkie siedem bramek z Kroku 3 (na czystym `checkout`, nie na Twoim
   working tree), potem build, potem atestację, potem wydanie. Czerwony krok = wydanie
   NIE powstało (albo powstało bez atestacji) — czytaj log kroku, który obleciał.
2. **Atestacja provenance.** Krok `actions/attest-build-provenance` podpisuje
   `dist/main.js`, `dist/manifest.json`, `dist/styles.css` — widoczne jako „Attestations”
   na stronie wydania. Zweryfikuj z linii poleceń (wymaga `gh` CLI i pobranego assetu):
   ```bash
   gh attestation verify dist/main.js --repo JDHole/pkm-assistant
   ```
3. **Strona wydania.** Tag jest **BEZ prefiksu `v`, znak w znak równy `manifest.json.version`**
   (czyli `2.2.0`, nie `v2.2.0`), `body` to treść `releases/<wersja>.md`, a assety to
   **DOKŁADNIE trzy pliki**: `main.js`, `manifest.json`, `styles.css`. Żadnego zipa,
   żadnego `THIRD-PARTY-LICENSES.md` — katalog społeczności pobiera właśnie te trzy pliki
   osobno i wytykał wszystko ponadto.

## Krok 8 — zgłoszenie do katalogu społeczności (robi Kuba)

Tylko przy pierwszym wejściu do katalogu; kolejne wersje katalog podbiera sam z nowych
release'ów, bez ponownego zgłaszania.

Instrukcja źródłowa: <https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin>.
Na dziś (wrzesień 2026) opisuje ona portal <https://community.obsidian.md> — logowanie
kontem Obsidian, podpięcie konta GitHub, wskazanie repozytorium i automatyczna
weryfikacja. **Sprawdź tę stronę w dniu zgłoszenia** — nasze notatki z lipca opisywały
jeszcze starszą ścieżkę (ręczny PR do repo `obsidianmd/obsidian-releases`) i mogą być
nieaktualne w drugą stronę.

Zanim klikniesz „zgłoś", w repo musi być:

- **`README.md`** — opis pluginu; to jest strona pluginu w katalogu.
- **`LICENSE`** — pełny tekst licencji (u nas GPL-3.0).
- **`manifest.json` na HEAD domyślnego brancha** (`main`) — katalog czyta manifest
  właśnie stamtąd, nie z release'u. `id` = `pkm-assistant` (bez słowa „obsidian" w id
  i w nazwie — wymóg), `version` w formacie semver bez `v`, `minAppVersion` zgodne
  z rzeczywiście używanym API.
- **Release o tagu równym `manifest.version`** z assetami `main.js`, `manifest.json`
  i `styles.css` (Krok 7).

To jest **krok Kuby (baza)**, nie sesji roboczej: wymaga zalogowania się na konto
Obsidian i konto GitHub. Sesja robocza przygotowuje repo do tego kroku i nic więcej.

---

## Czym się różni od runbooku v2.0 (archiwum)

- **Branch:** `refactor/v2.2-<nazwa>` → `main` bezpośrednio. Nie ma już pośredniego `refactor/v2.0` — ten branch jest dziś kotwicą historyczną, merge do niego zabroniony (patrz root `CLAUDE.md`).
- **Bramki:** pięć komend pluginu (test, typecheck, lint, lint:obsidian, build) plus dwie z osobnego repo harnessu (`selftest`, `scenarios` w https://github.com/JDHole/pkm-assistant-harness — CI klonuje je sam), nie dwie (test+build) — i od 2026-09-07 jadą DWA RAZY: raz lokalnie (Krok 3), raz w `release.yml` na czystym `checkout` po pushu taga (Krok 7), więc wydanie nie może być mniej sprawdzone niż zwykły push do `main`.
- **Publikacja:** od 2026-09-07 robi ją `.github/workflows/release.yml` po pushu taga, nie laptop. `release.js` (`npm run release`) dziś TYLKO przygotowuje: waliduje wersję, gotuje notatki, robi lokalny rebuild kontrolny — i kończy, wypisując listę ręcznych kroków (commit, tag, push). Build assetów, `gh release create` i atestacja dzieją się w chmurze, na commicie wskazanym tagiem, nie na Twojej maszynie. Do 2026-09-07 `release.js` sam tworzył tag i release przez REST API GitHuba (`GH_TOKEN`/`GH_REPO` w `.env`, zip + `THIRD-PARTY-LICENSES.md` jako dodatkowe assety, upload przez `curl`) — to wszystko wycięte razem z `utils/releaseGithub.ts` (dziś `utils/releasePrep.ts`, bez logiki GitHuba).
- **Atestacja provenance:** nowość, niedostępna w żadnym poprzednim modelu — `actions/attest-build-provenance` podpisuje trzy assety wydania, więc użytkownik katalogu może zweryfikować (`gh attestation verify`), że powstały z tego repo i commita, a nie z czyjegoś laptopa.
- **Brak trybu RC/prerelease i brak draftu:** stary runbook (v2.0) publikował `vX.Y.0-rc.1` jako prerelease, czekał tydzień na smoke, dopiero potem promował do stable. Ani dzisiejszy `release.js`, ani `release.yml` nie znają `--prerelease` czy `--draft` — push taga zawsze publikuje pełny, gotowy release od razu (flaga `--draft`, która kiedyś na to pozwalała, zniknęła razem z resztą logiki publikacji).
