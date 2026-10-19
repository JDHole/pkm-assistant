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
git checkout -b release/<wersja>
```

Gałąź wydania jest krótka: zbiera tylko bump wersji, przypięcie harnessu i notatki. `main` nie dostaje numeru przyszłej wersji na początku pracy - bump trafia tuż przed tagiem.

## Krok 2 - bump wersji

- `package.json` → pole `version` (to jest właściwe źródło prawdy - czyta je i `esbuild.js`, i `release.js`).
- `package-lock.json` → pole `version` w dwóch miejscach (root + `packages[""]`).
- `versions.json` → dopisz nowy wpis `"<wersja>": "<minAppVersion>"`, gdzie `<minAppVersion>` to aktualna wartość `manifest.json.minAppVersion`.
- `manifest.json` → pole `version` podbij ręcznie razem z `package.json`. `npm run build` i tak nadpisuje je wartością z `package.json` (stemplowanie manifestu w `esbuild.js` - dzieje się przy KAŻDYM buildzie), ale build jest OSTATNIĄ bramką kroku 3, a `npm test` pierwszą: strażnik w `build_kontrakt.test.ts` (`package.json.version === manifest.json.version`) obleje testy, jeśli manifest czeka na stempel z builda (tak było przy 2.2.7).
- `releases/<wersja>.md` → napisz notatkę wydania JUŻ TERAZ (kształt: Krok 5.3). Ten sam plik testów wymaga notatki dla każdego wpisu w `versions.json`, więc bez niej `npm test` z kroku 3 też jest czerwony.

⚠️ **Pułapka:** ten auto-zapis `manifest.json` przez `npm run build` zostawia zmianę w working tree. Zanim zrobisz commit release prep, sprawdź `git status` - `manifest.json` MUSI wejść do tego samego commita, inaczej `release.js` odbije się o guard niezgodności wersji.

Commituj bump (i przebudowany `manifest.json`) na branchu roboczym.

## Krok 2b - przypnij harness

Workflow wydania bierze harness z commita zapisanego w `.github/harness-sha` (jedna linia, pełny 40-znakowy SHA), nie z ruchomego `main` repo harnessu. Dzięki temu ten sam tag zawsze przechodzi te same scenariusze, a podsumowanie biegu "Release" mówi, które. Zwykłe CI (`ci.yml`) zostaje na `main` harnessu.

Wpisz tam SHA harnessu, na którym przeszły bramki z Kroku 3 (klon obok, zsynchronizowany z GitHubem - commit musi być wypchnięty, bo Actions pobiera go z GitHuba):

```bash
git -C ../pkm-assistant-harness rev-parse HEAD > .github/harness-sha
```

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

> Jeśli masz `DESTINATION_VAULTS` ustawione w swoim `.env` (auto-deploy pluginu do vaulta po buildzie, patrz `esbuild.js`), `npm run build` w tym kroku (i drugi raz wewnątrz `release.js` w kroku 5) wdroży bieżący build do tych vaultów jak przy zwykłej pracy deweloperskiej - to nie jest coś specjalnego dla release'u, ale warto wiedzieć, że się dzieje. Deploy wymaga też `DESTINATION_CONFIG_DIR` (nazwa folderu konfiguracji Obsidiana w tych vaultach) - bez niej build wypisuje jedno ostrzeżenie i pomija deploy, sam build przechodzi.

## Krok 3b - kandydat wydania i smoke

Kandydat to konkretny commit gałęzi `release/<wersja>` po zielonych bramkach - zapisz jego SHA. Kandydat musi już zawierać wygenerowany `releases/latest_release.md`: ten plik jest wbudowywany w bundle (widok "Co nowego", `modules/shell/ReleaseNotesView.ts`), więc build bez niego nie byłby tym, co dostaną użytkownicy. Dlatego przed buildem kandydata odpal `npm run release` (Krok 5) NA GAŁĘZI wydania i zacommituj oba pliki notatek; po merge do `main` Krok 5 odtwarza je bajt w bajt i `git status` zostaje czysty. Zbudowany z kandydata `dist/` instaluje się w vaulcie testowym (przez `DESTINATION_VAULTS` albo ręcznie trzy pliki do folderu pluginu). Smoke na kandydacie, zanim cokolwiek dostanie tag:

- aktualizacja z poprzedniej wersji zachowuje dane: agenci, pamięć, ustawienia i sesje są na miejscu;
- plugin startuje bez błędu, a zmienione w tym wydaniu ścieżki przechodzą ręcznie w Obsidianie.

Poprawka po smoke to nowy commit na tej samej gałęzi i ponowne bramki - kandydatem staje się nowy SHA. Między kandydatem a tagiem `main` nie może się ruszyć: scalenie gałęzi wydania ma wnieść dokładnie przetestowane drzewo. Jeśli na `main` w tym czasie coś weszło, przenieś gałąź wydania na aktualny `main` i zrób nowego kandydata.

## Krok 4 - merge do main

```bash
git push origin release/<wersja>
git checkout main
git merge --no-ff release/<wersja>
git push origin main
```

## Krok 5 - `npm run release` (na czystym `main`) - TYLKO przygotowanie

Co skrypt (`release.js`, helpery w `utils/releaseNotes.ts`, `utils/releasePrep.ts`) robi krok po kroku - i tylko tyle, ŻADNEGO kontaktu z GitHubem:

1. **Walidacja wersji.** Czyta `version` z `package.json` i `manifest.json` - różnica = `exit 1`. Skrypt SAM niczego nie bumpuje, to musiało się stać w kroku 2.
2. **Potwierdzenie wersji - wciśnij ENTER.** Skrypt pyta na konsoli `Confirm release version (X.Y.Z): `. **Enter bierze GOŁĄ wartość z `package.json`, BEZ prefiksu `v` - i to jest zachowanie POPRAWNE.** To, co wpiszesz (albo zatwierdzisz Enterem), leci do nazwy pliku notatek `releases/<wersja>.md` i - dopiero w Kroku 6, ręcznie - do `git tag`.

   ⚠️ **Katalog społeczności Obsidiana wymaga, żeby tag release'u był DOKŁADNIE równy `manifest.json.version` - bez litery `v`.** Katalog pobiera `main.js`, `manifest.json` i `styles.css` z release'u o tagu równym wersji z manifestu; tag `v2.2.0` przy `"version": "2.2.0"` = plugin nie do zainstalowania z katalogu. Workflow `release.yml` sprawdza to jeszcze raz po pushu taga i obala bramkę na niezgodności, zanim cokolwiek zbuduje.

3. **Notatki wydania.** Jeśli `releases/<wersja>.md` już istnieje, bierze go 1:1. Jeśli nie - łączy najnowszy istniejący numerowany plik z `releases/` (jeśli jest) z opisem, o który zapyta na konsoli, i zapisuje wynik do `releases/<wersja>.md`. Ten plik jest też bramką w CI: `release.yml` sprawdza `releases/<tag>.md` po pushu taga i przerywa workflow (`exit 1`), jeśli go nie ma - zrób ten krok PRZED tagiem, nie po.
   **Kształt notatki (zasada właściciela, 2026-09-17, obowiązuje od wydania po 2.2.6):** notatka ZACZYNA SIĘ od wytłumaczenia po ludzku - co się działo i co się już nie dzieje - zrozumiałego dla osoby nietechnicznej (bez nazw plików, pól, formatów i żargonu). Dokładna specyfikacja techniczna może iść NIŻEJ, pod tym wstępem, nigdy zamiast niego. Notatka bez ludzkiego wstępu nie jest gotowa do taga.
4. **`releases/latest_release.md`.** Generuje sformatowaną wersję not (nagłówek + zwinięte starsze patch'e) pod widok w samym pluginie (`ReleaseNotesView` - ekran "co nowego" po starcie).
5. **Rebuild kontrolny.** Odpala build jeszcze raz - `node esbuild.js` wprost przez bieżącego Node'a (to samo, co `npm run build`) - świeży lokalny `dist/` dokładnie pod potwierdzoną wersję. Błąd builda przerywa skrypt PRZED commitem i tagiem - to jedyny cel tego kroku dzisiaj, bo `dist/` z tego przebiegu nigdy nie trafia na wydanie (asset builduje osobno, na czystym Linuksie, workflow z kroku 6).

Na końcu skrypt wypisuje na konsoli krótką listę dalszych kroków: commit notatek na gałęzi wydania (kandydat, Krok 3b), a na `main` sprawdzenie czystego `git status`, `git tag`, push i gdzie patrzeć (Kroki 6-7).

## Krok 6 - tag i push (ręcznie, na `main`; notatki są już zacommitowane na gałęzi wydania)

`release.js` NIE tworzy taga i NIE dotyka GitHuba - to w całości ręczne. Notatki są zwykle zacommitowane już na gałęzi wydania (Krok 3b), więc po Kroku 5 `git status` jest czysty i commit notatek odpada. Gdy jednak Krok 5 coś zmienił, kandydat nie był tym, co idzie pod tag - wróć do Kroku 3b z nowym SHA zamiast commitować na `main`. Przy czystym `git status`:

```bash
git status --short releases/
git tag <wersja>
git push origin main && git push origin <wersja>
```

`<wersja>` to gołe semver **BEZ litery `v`** (np. `2.2.0`) - patrz Krok 5.2. Push taga jest momentem, który uruchamia publikację: `.github/workflows/release.yml` reaguje na wzorzec tagów `[0-9]+.[0-9]+.[0-9]+` (bez `v`) i od tego momentu wszystko dzieje się w Actions, nie na lokalnej maszynie.

**Wypchniętego taga nie przesuwamy, a opublikowanego wydania nie podmieniamy.** Regułę trzyma jeden skrypt, `.github/scripts/release-state.mjs` (testy: `release_state.test.ts`), wołany na starcie workflow (zanim ruszą bramki) i tuż przed publikacją. Porównanie sum sha256 z buildem (`--porownaj dist`) działa dopiero przed publikacją i po niej, bo na starcie `dist/` jeszcze nie istnieje:

- opublikowane wydanie z kompletem `main.js`, `manifest.json`, `styles.css` (dodatkowe pliki nie zmieniają oceny) - odmowa: użytkownicy i katalog mogli je pobrać, a atestacja opisuje dokładnie te bajty; poprawka idzie w kolejnym numerze patch;
- wymagany plik wgrany do połowy, pusty albo z innego buildu (suma sha256 inna niż w `dist/` tego biegu) - odmowa; nic nie jest nadpisywane, taki plik usuwa człowiek na stronie wydania i uruchamia bieg ponownie;
- przerwana publikacja (brakuje części plików, obecne są całe i z tego buildu) - ponowny bieg dogrywa tylko brakujące, pod id tego wydania;
- błąd odczytu stanu z GitHuba inny niż "nie ma takiego wydania" - odmowa, bo bez znajomości stanu niczego nie publikujemy.

Wydań roboczych (draft) skrypt nie widzi i ich nie dotyka - GitHub zwraca po tagu tylko wydania opublikowane. Po publikacji ten sam skrypt (`--po-publikacji --porownaj dist`) sprawdza, że opublikowane wydanie ma komplet trzech plików identycznych z tym buildem, czyli z tym, co opisuje atestacja; inaczej bieg jest czerwony.

## Krok 7 - zweryfikuj wydanie

1. **Zakładka Actions → workflow "Release".** Bieg startuje w kilka sekund po pushu taga. Robi PONOWNIE wszystkie bramki z Kroku 3 (na czystym `checkout`, nie na working tree), potem build, potem atestację, potem wydanie. Czerwony krok = wydanie NIE powstało (albo powstało bez atestacji) - czytaj log kroku, który obleciał.
2. **Atestacja provenance.** Krok `actions/attest-build-provenance` podpisuje `dist/main.js`, `dist/manifest.json`, `dist/styles.css` - widoczne jako "Attestations" na stronie wydania. Zweryfikuj z linii poleceń (wymaga `gh` CLI i pobranego assetu):
   ```bash
   gh attestation verify dist/main.js --repo JDHole/pkm-assistant
   ```
3. **Strona wydania.** Tag jest **BEZ prefiksu `v`, znak w znak równy `manifest.json.version`** (czyli `2.2.0`, nie `v2.2.0`), `body` to treść `releases/<wersja>.md`, a assety to **DOKŁADNIE trzy pliki**: `main.js`, `manifest.json`, `styles.css`. Żadnego zipa, żadnego `THIRD-PARTY-LICENSES.md` - katalog społeczności pobiera właśnie te trzy pliki osobno i wytyka wszystko ponadto.
4. **Harness biegu.** Podsumowanie biegu "Release" ma linię `Harness: JDHole/pkm-assistant-harness@<sha>` - to ma być SHA z `.github/harness-sha` (Krok 2b).
5. **Katalog widzi nową wersję.** Katalog liczy pobrania osobno dla każdej wersji w `community-plugin-stats.json` repo `obsidianmd/obsidian-releases`. Gdy pod `pkm-assistant` pojawi się klucz nowej wersji, katalog ją wykrył i użytkownicy dostają aktualizację:
   ```bash
   curl -s https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d)['pkm-assistant']))"
   ```
   Plik odświeża się raz na dobę (commit "Update plugin stats" ok. 00:25 UTC), więc klucz nowej wersji pojawia się najpóźniej następnego dnia; pole `updated` pokazuje czas publikacji ostatniej wykrytej wersji. Brak klucza zaraz po publikacji nie jest jeszcze błędem, brak po dwóch dobach już tak.

## Krok 8 - zgłoszenie do katalogu społeczności

Tylko przy pierwszym wejściu do katalogu; kolejne wersje katalog podbiera sam z nowych release'ów, bez ponownego zgłaszania.

Instrukcja źródłowa: <https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin> (opisuje portal <https://community.obsidian.md> - logowanie kontem Obsidian, podpięcie konta GitHub, wskazanie repozytorium i automatyczna weryfikacja). **Sprawdź tę stronę w dniu zgłoszenia** - proces po stronie Obsidiana bywa aktualizowany.

Zanim klikniesz "zgłoś", w repo musi być:

- **`README.md`** - opis pluginu; to jest strona pluginu w katalogu.
- **`LICENSE`** - pełny tekst licencji (GPL-3.0).
- **`manifest.json` na HEAD domyślnego brancha** (`main`) - katalog czyta manifest właśnie stamtąd, nie z release'u. `id` = `pkm-assistant` (bez słowa "obsidian" w id i w nazwie - wymóg), `version` w formacie semver bez `v`, `minAppVersion` zgodne z rzeczywiście używanym API.
- **Release o tagu równym `manifest.version`** z assetami `main.js`, `manifest.json` i `styles.css` (Krok 7).

To jest krok właściciela repo, nie sesji roboczej: wymaga zalogowania się na konto Obsidian i konto GitHub. Sesja robocza przygotowuje repo do tego kroku i nic więcej.
