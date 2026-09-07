# Migracja do Obsek v2.0

Ten dokument jest dla osób przechodzących z Obsek / PKM Assistant v1.x na v2.0. Wersja v2.0 jest dużym refaktorem: mniej starego frameworka bazowego, więcej własnych modułów, pamięć i retrieval zbudowane pod agentów.

## Co się zmienia

### Memory v3

Memory v3 zastępuje Memory v2 przed stabilnym v2.0. `brain.md` zostaje krótkim indeksem i miejscem na bieżące rzeczy, a trwałe fakty trafiają do osobnych plików `brain/*.md`.

Stary `brain.md` jest migrowany ostrożnie:

- najpierw powstaje kopia `memory.v2.backup/`,
- sekcje `User`, `Preferencje` i `Ustalenia` są proponowane jako notatki w `brain/`,
- sekcja `Bieżące` zostaje w nowym `brain.md`,
- stare zombie-sekcje typu `System`, `Agora`, `vault-builder` są proponowane do usunięcia,
- jeśli parser nie rozumie starego pliku, tworzy awaryjną notatkę `reference_legacy_brain_dump.md`.

Pamięć agenta nadal ma trzy poziomy podsumowań: L1, L2 i L3. Plugin nie wyrzuca surowej historii po pierwszym streszczeniu.

### Orama retrieval zamiast starego frameworka

Stary framework bazowy został usunięty z runtime. Wyszukiwanie semantyczne i tekstowe opiera się na Orama oraz własnym module `modules/embedding/`.

### Komunikator zamiast Agora

Agora została wycofana. Projekty, wątki, briefy i komunikacja między agentami trafiły do Komunikatora.

### Archetypes v2 + role

Stare role `minion` i `master` zostały zastąpione czytelniejszym układem:

- archetype = poziom uprawnień agenta,
- role = zawód / specjalizacja / narzędzia,
- personality = ton i charakter odpowiedzi.

Wbudowane archetypy v2 to: `glowny_asystent`, `orkiestrator`, `specjalista`, `singleton`.

> **Aktualizacja (E2.8, 2026-07-23):** ten model już nie obowiązuje. `archetype` i `role` na
> agencie przestały być bytami sterującymi (decyzja D7/S17) — `modules/agents/Agent.ts` czyta
> te pola ze starych YAML-i, ale **je ignoruje** (w kodzie oznaczone wprost jako „DEPRECATED:
> czytane, ignorowane"). Stare YAML-e z tymi polami nadal wczytują się bez błędu, po prostu nic
> już z nich nie wynika — nie sterują uprawnieniami ani doborem narzędzi. Agent v3 to dziś:
> Persona (`personality`), Umiejętności (skille + konektory), Uprawnienia (jedna oś
> `disabled_tools`), Ekipa (`sub_agents`) i Pamięć. Szczegóły: [`modules/agents/CLAUDE.md`](modules/agents/CLAUDE.md)
> sekcja „Model osobowości agenta v3".

### Sub-agenty v2

Delegacja ma cztery role rdzeniowe: researcher, strategist, archivist i critic. Inline triggers (`@` i `/`) pozwalają wywołać skille, sub-agentów i MCP z poziomu chatu.

### Settings v2 + Backstage v2

Ustawienia są teraz rejestrowane przez moduły. Zamiast jednego wielkiego panelu, każdy moduł ma swoją sekcję. Backstage dostał podobny rejestr zakładek.

### Skiny i Token Context Viewer

v2.0 dodaje SkinManager z trzema typami skinów oraz Token Context Viewer, czyli podgląd ile kontekstu zużywają wiadomości, pamięć, skille i narzędzia.

## Auto-migracje

Migracje uruchamiają się z kodu pluginu lub przez istniejące defensywne loadery. Przed dużą zmianą zrób backup vaulta.

| Obszar | Co robi v2.0 | Zakres |
|---|---|---|
| Memory v2 -> Memory v3 | robi backup `memory.v2.backup/`, rozbija `brain.md` na notatki `brain/*.md`, zostawia krótki indeks i aktywne sesje v3 | Sprint M3, pre-release blocker po Smoke Test 01 |
| ↳ modal migracji (3 przyciski) | **Zapisz** = plan wchodzi; **Awaryjny dump** = jedna surowa notatka z PEŁNĄ treścią starego brain (od 2026-08-27 — wcześniej dump wychodził pusty, treść ratował tylko backup); **Anuluj / X / Esc** = migracja NIE rusza niczego i wraca przy następnym starcie (od 2026-08-27 — wcześniej Cancel po cichu odpalał migrację automatyczną) | D7, werdykt Kuby po AUD-docs-051 |
| `plan_action` -> `artifact_create` / `todo` | rozdziela artefakty na jasne typy zamiast jednego duplikującego mechanizmu | Sprint 09, około 960 LOC starego `plan_action` usunięte. Nazwy pośrednie `plan_review`/`idea_review`/`chat_todo` z tego sprintu zostały same zastąpione w E2.9 (2026-07-23) — dziś żyją tylko jako aliasy kompatybilności, patrz „Breaking changes" |
| `minion` / `master` -> `researcher` / `strategist` | stare YAML-e są czytane z ostrzeżeniem i mapowane na nowe role modeli | Sprint 07, około 487 linii legacy balastu usunięte |
| Connections panel | panel został wycofany razem ze starym frameworkiem bazowym; komenda pokazuje Notice | Sprint 02 + decyzja S13b, restore możliwy w v3.0 z Orama scoring |

**Dwie pozycje celowo NIE są w tej tabeli, bo nie są automatyczne:**
- **Stary indeks embeddingów → Orama** — migracji NIE MA (kod usunięty): nowy indeks budujesz od zera. Patrz „Kroki ręczne" krok 3.
- **Agora → Komunikator** — migratora nie ma (zero kodu, usunięty razem z Project Hubem w Sprincie 08/S28). Patrz „Kroki ręczne" krok 5.

## Kroki ręczne

1. Zrób backup vaulta przed włączeniem v2.0.
2. Jeśli w v1 miałeś hardcoded klucz ComfyUI, odwołaj stary klucz i wpisz nowy w Settings.
3. Jeśli w v1 używałeś starego silnika embeddingu: automatycznej migracji danych NIE MA — stary cache embeddingów przepada, a nowy indeks Orama budujesz od zera w kroku 4. Stare foldery indeksu z v1 (`.pkm-assistant/multi`, `.pkm-assistant/embeddings` i podobne) możesz skasować ręcznie po upgradzie.
4. Wybierz provider embeddingów po starcie v2.0. Lokalna ścieżka rekomendowana: Ollama + `snowflake-arctic-embed2`.
5. Jeśli w v1 używałeś Agory (projekty/wątki/briefy): zrób ręczny backup folderu `.pkm-assistant/agora/` PRZED upgrade'em. Migrator Agora → Komunikator **nie istnieje** (usunięty razem z Project Hubem w Sprincie 08/S28) — nowy kod tego folderu nie czyta i nic z niego nie przenosi.
6. Włącz storage sekretów na master password, jeśli chcesz przenieść klucze API z prostego `data.json`.
7. Zrób szybki smoke test: chat z Jaskierem, agent swap, vault search, memory consolidation, Token Context Viewer, Settings.

## Breaking changes

- Stary framework bazowy nie jest już częścią pluginu.
- Connections panel jest niedostępny w v2.0.
- AgoraView jest wycofany; używaj Komunikatora. Dane starych projektów Agory **nie są migrowane automatycznie** — migratora nie ma (patrz „Kroki ręczne" krok 5).
- `plan_action` jest wycofany. Aktualne narzędzia to `artifact_create` (typ `plan` albo `notatka`) i `todo`; nazwy `plan_review`/`idea_review`/`chat_todo` z Sprintu 09 to dziś tylko aliasy kompatybilności (`modules/tools/toolAliases.ts`), nie osobne narzędzia.
- `minion` i `master` są legacy nazwami; nowe nazwy to `researcher` i `strategist`.
- AgentCreatorModal stub został usunięty.
- Onboarding wizard pozostaje odsunięty do v3; start odbywa się przez Jaskiera i Settings.
- Archetype i rola (v2, sekcja „Archetypes v2 + role" wyżej) **przestały istnieć jako byty sterujące** (E2.8, D7/S17) — pola `archetype`/`role` na agencie są dziś czytane ze starych YAML-i, ale ignorowane.

Release notes: notatki wydania v2.0.0 (archiwum repozytorium, poza publicznym drzewem)
