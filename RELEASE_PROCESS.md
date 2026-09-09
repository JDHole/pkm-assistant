# Release process

> Ten plik opisuje, co skrypty i workflow repo robią dziś - sprawdzone czytaniem `release.js`, `utils/releaseNotes.ts`, `esbuild.js` i [`.github/workflows/release.yml`](.github/workflows/release.yml) na HEAD, nie z pamięci.
>
> Wydanie publikuje GitHub Actions, nie lokalna maszyna. `release.js` (`npm run release`) jest skryptem PRZYGOTOWANIA: sprawdza spójność wersji, gotuje notatki, robi lokalny rebuild kontrolny. Publikację (build na czystym Linuksie, atestacja provenance, `gh release create` z DOKŁADNIE trzema plikami) robi workflow "Release" po pushu taga.

## Zasada: wersja i tag idą z plików, nigdy ze sztywnego zapisu

Źródło prawdy to `package.json` (`version`), `manifest.json` (`version` + `minAppVersion`), `package-lock.json` (`version`) i `versions.json` (mapa wersja→minAppVersion). `release.js` twardo sprawdza `package.json.version === manifest.json.version` i przerywa (`exit 1`) na niezgodności - nie ma żadnego automatu, który to za ciebie naprawi.

**Tag release'u = `manifest.json.version`, znak w znak, BEZ litery `v`.** To wymóg katalogu społeczności Obsidiana: katalog szuka release'u o tagu równym wersji z manifestu i dopiero z niego bierze `main.js`, `manifest.json` i `styles.css`.

## Wymagania maszyny releasującej

Do `npm run release` (Krok 5, samo PRZYGOTOWANIE) wystarczy Node w wersji z `engines.node` w `package.json`. Skrypt nie łączy się z siecią, nie potrzebuje żadnego tokena ani binarki `curl` - publikacja (build, atestacja, wydanie na GitHubie) dzieje się osobno, w chmurze, na maszynie GitHuba, po pushu taga (Krok 6-7).

Na maszynie releasującej przydaje się jeszcze `gh` CLI (GitHub CLI) - nie do wydania samego w sobie, tylko do wygodnej weryfikacji PO fakcie (Krok 7): `gh run watch`, `gh release view`, `gh attestation verify`. Bez `gh` też się obejdzie - wszystko widać w przeglądarce, na zakładce Actions i na stronie wydania.

---

## Krok 1 - branch od main

```bash
git checkout main
git pull origin main
git checkout -b refactor/v2.2-release-<wersja>
```

## Krok 2 - bump wersji

- `package.json` → pole `version` (to jest właściwe źródło prawdy - czyta je i `esbuild.js`, i `release.js`).
- `package-lock.json` → pole `version` w dwóch miejscach (root + `packages[""]`).
- `versions.json` → dopisz nowy wpis `"<wersja>": "<minAppVersion>"`, gdzie `<minAppVersion>` to aktualna wartość `manifest.json.minAppVersion`.
- `manifest.json` → pole `version` możesz zostawić bez ręcznej edycji: **`npm run build` nadpisuje je wartością z `package.json` automatycznie** (stemplowanie manifestu w `esbuild.js` - dzieje się przy KAŻDYM buildzie). Masz `npm run build` w bramkach kroku 3, więc do tego momentu `manifest.json` i tak się zsynchronizuje.

⚠️ **Pułapka:** ten auto-zapis `manifest.json` przez `npm run build` zostawia zmianę w working tree. Zanim zrobisz commit release prep, sprawdź `git status` - `manifest.json` MUSI wejść do tego samego commita, inaczej `release.js` odbije się o guard niezgodności wersji.

Commituj bump (i przebudowany `manifest.json`) na branchu roboczym.

## Krok 3 - bramki, wszystkie zielone

```bash
npm test
npm run typecheck
npm run lint
npm run lint:obsidian
npm run build
```

Plus bramka harnessu - żyje w osobnym repo (https://github.com/JDHole/pkm-assistant-harness), bo walidator katalogu lintuje CAŁE repo pluginu, a narzędzie testowe nie jest jego częścią. Sklonuj je obok katalogu pluginu, raz zainstaluj zależności (`npm install`) i puść:

```bash
cd ../pkm-assistant-harness
npm run selftest
npm run scenarios
```

`lint:obsidian` nie ma żadnego wyjątku ani porównania z baseline - ma wyjść zielony (`exit 0`), tak jak reszta. Czerwone cokolwiek → STOP, napraw, dopiero potem dalej.

> Jeśli masz `DESTINATION_VAULTS` ustawione w swoim `.env` (auto-deploy pluginu do vaulta po buildzie, patrz `esbuild.js`), `npm run build` w tym kroku (i drugi raz wewnątrz `release.js` w kroku 5) wdroży bieżący build do tych vaultów jak przy zwykłej pracy deweloperskiej - to nie jest coś specjalnego dla release'u, ale warto wiedzieć, że się dzieje.

## Krok 4 - merge do main

```bash
git push origin refactor/v2.2-release-<wersja>
git checkout main
git merge --no-ff refactor/v2.2-release-<wersja>
git push origin main
```

## Krok 5 - `npm run release` (na czystym `main`) - TYLKO przygotowanie

Co skrypt (`release.js`, helpery w `utils/releaseNotes.ts`, `utils/releasePrep.ts`) robi krok po kroku - i tylko tyle, ŻADNEGO kontaktu z GitHubem:

1. **Walidacja wersji.** Czyta `version` z `package.json` i `manifest.json` - różnica = `exit 1`. Skrypt SAM niczego nie bumpuje, to musiało się stać w kroku 2.
2. **Potwierdzenie wersji - wciśnij ENTER.** Skrypt pyta na konsoli `Confirm release version (X.Y.Z): `. **Enter bierze GOŁĄ wartość z `package.json`, BEZ prefiksu `v` - i to jest zachowanie POPRAWNE.** To, co wpiszesz (albo zatwierdzisz Enterem), leci do nazwy pliku notatek `releases/<wersja>.md` i - dopiero w Kroku 6, ręcznie - do `git tag`.

   ⚠️ **Katalog społeczności Obsidiana wymaga, żeby tag release'u był DOKŁADNIE równy `manifest.json.version` - bez litery `v`.** Katalog pobiera `main.js`, `manifest.json` i `styles.css` z release'u o tagu równym wersji z manifestu; tag `v2.2.0` przy `"version": "2.2.0"` = plugin nie do zainstalowania z katalogu. Workflow `release.yml` sprawdza to jeszcze raz po pushu taga i obala bramkę na niezgodności, zanim cokolwiek zbuduje.

3. **Notatki wydania.** Jeśli `releases/<wersja>.md` już istnieje, bierze go 1:1. Jeśli nie - łączy najnowszy istniejący numerowany plik z `releases/` (jeśli jest) z opisem, o który zapyta na konsoli, i zapisuje wynik do `releases/<wersja>.md`. Ten plik jest też bramką w CI: `release.yml` sprawdza `releases/<tag>.md` po pushu taga i przerywa workflow (`exit 1`), jeśli go nie ma - zrób ten krok PRZED tagiem, nie po.
4. **`releases/latest_release.md`.** Generuje sformatowaną wersję not (nagłówek + zwinięte starsze patch'e) pod widok w samym pluginie (`ReleaseNotesView` - ekran "co nowego" po starcie).
5. **Rebuild kontrolny.** Odpala build jeszcze raz - `node esbuild.js` wprost przez bieżącego Node'a (to samo, co `npm run build`) - świeży lokalny `dist/` dokładnie pod potwierdzoną wersję. Błąd builda przerywa skrypt PRZED commitem i tagiem - to jedyny cel tego kroku dzisiaj, bo `dist/` z tego przebiegu nigdy nie trafia na wydanie (asset builduje osobno, na czystym Linuksie, workflow z kroku 6).

Na końcu skrypt wypisuje na konsoli krótką listę kroków 6-7 (commit notatek, `git tag`, push, gdzie patrzeć) - to jest ten sam tekst, co niżej.

## Krok 6 - commit, tag, push (ręcznie, na `main`)

`release.js` NIE tworzy taga i NIE dotyka GitHuba - to w całości ręczne, dokładnie te cztery komendy:

```bash
git add releases/<wersja>.md releases/latest_release.md
git commit -m "docs(release): notatki <wersja>"
git tag <wersja>
git push origin main && git push origin <wersja>
```

`<wersja>` to gołe semver **BEZ litery `v`** (np. `2.2.0`) - patrz Krok 5.2. Push taga jest momentem, który uruchamia publikację: `.github/workflows/release.yml` reaguje na wzorzec tagów `[0-9]+.[0-9]+.[0-9]+` (bez `v`) i od tego momentu wszystko dzieje się w Actions, nie na lokalnej maszynie.

## Krok 7 - zweryfikuj wydanie

1. **Zakładka Actions → workflow "Release".** Bieg startuje w kilka sekund po pushu taga. Robi PONOWNIE wszystkie bramki z Kroku 3 (na czystym `checkout`, nie na working tree), potem build, potem atestację, potem wydanie. Czerwony krok = wydanie NIE powstało (albo powstało bez atestacji) - czytaj log kroku, który obleciał.
2. **Atestacja provenance.** Krok `actions/attest-build-provenance` podpisuje `dist/main.js`, `dist/manifest.json`, `dist/styles.css` - widoczne jako "Attestations" na stronie wydania. Zweryfikuj z linii poleceń (wymaga `gh` CLI i pobranego assetu):
   ```bash
   gh attestation verify dist/main.js --repo JDHole/pkm-assistant
   ```
3. **Strona wydania.** Tag jest **BEZ prefiksu `v`, znak w znak równy `manifest.json.version`** (czyli `2.2.0`, nie `v2.2.0`), `body` to treść `releases/<wersja>.md`, a assety to **DOKŁADNIE trzy pliki**: `main.js`, `manifest.json`, `styles.css`. Żadnego zipa, żadnego `THIRD-PARTY-LICENSES.md` - katalog społeczności pobiera właśnie te trzy pliki osobno i wytyka wszystko ponadto.

## Krok 8 - zgłoszenie do katalogu społeczności

Tylko przy pierwszym wejściu do katalogu; kolejne wersje katalog podbiera sam z nowych release'ów, bez ponownego zgłaszania.

Instrukcja źródłowa: <https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin> (opisuje portal <https://community.obsidian.md> - logowanie kontem Obsidian, podpięcie konta GitHub, wskazanie repozytorium i automatyczna weryfikacja). **Sprawdź tę stronę w dniu zgłoszenia** - proces po stronie Obsidiana bywa aktualizowany.

Zanim klikniesz "zgłoś", w repo musi być:

- **`README.md`** - opis pluginu; to jest strona pluginu w katalogu.
- **`LICENSE`** - pełny tekst licencji (GPL-3.0).
- **`manifest.json` na HEAD domyślnego brancha** (`main`) - katalog czyta manifest właśnie stamtąd, nie z release'u. `id` = `pkm-assistant` (bez słowa "obsidian" w id i w nazwie - wymóg), `version` w formacie semver bez `v`, `minAppVersion` zgodne z rzeczywiście używanym API.
- **Release o tagu równym `manifest.version`** z assetami `main.js`, `manifest.json` i `styles.css` (Krok 7).

To jest krok właściciela repo, nie sesji roboczej: wymaga zalogowania się na konto Obsidian i konto GitHub. Sesja robocza przygotowuje repo do tego kroku i nic więcej.
