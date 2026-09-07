/**
 * **PLIK KWARANTANNY** — JEDYNE miejsce w repo, w którym wolno wystąpić starym nazwom
 * kluczy ustawień. Pełna mapa stare→nowe: plan wykonawczy klastra `core`, sekcja A.4.
 *
 * Kontrakt:
 *  • CZYSTA, ZERO I/O — jeden argument, mutacja w miejscu, `fn.length === 1`;
 *  • IDEMPOTENTNA — drugi przebieg zwraca `migrated:false` i nie zmienia niczego;
 *  • gdy NOWY klucz już istnieje — nie nadpisuje, stary tylko kasuje;
 *  • `secureStorage`: przepina klucze `refs` I przemianowuje id sekretów (wartości `refs`
 *    ORAZ klucze `encrypted`), bez odszyfrowywania czegokolwiek — ale tylko tam, gdzie
 *    ma powód (patrz `przepnijSejf`);
 *  • KASUJE martwe gałęzie wymienione w mapie jako „kasacja";
 *  • wejście nie-obiektowe → `{migrated:false, …}` bez wyjątku.
 *
 * ⚠️ **KOLEJNOŚĆ JEST CZĘŚCIĄ KONTRAKTU: `migrateNamespace` MUSI pójść PIERWSZY.**
 * Ten migrator zakłada obecność kontenera `pkmAssistant` i sam go tworzy, gdy jest co
 * do niego włożyć. `migrateNamespace` (`core/utils/settingsNamespaceMigration.ts`)
 * przerywa pracę, gdy `pkmAssistant` już istnieje — odpalony PO tym migratorze
 * zostawiłby całą gałąź `obsek` usera osieroconą. Kto pisze pancerz `load_settings`,
 * woła w kolejności: `migrateNamespace(data)` → `migrateLegacySettings(data)`.
 *
 * ⚠️ **Świadome odstępstwo od zamrożenia id sekretów** (katalog zachowań D.4 / G.6):
 * tamto zamrożenie opisuje migrację NAMESPACE'U (M1) i tam obowiązuje bez wyjątku —
 * `migrateNamespace` id nie tyka. Ten migrator id RUSZA, bo każe mu tak decyzja Kuby
 * z 05.09 („zero śladu także w danych", spec §7) — ale wyłącznie w dwóch przypadkach
 * wypisanych przy `przepnijSejf`. Wpisy sejfu spoza tych dwóch przypadków przechodzą
 * przez migrator nietknięte.
 */
import type { LegacySettingsMigrationResult } from './contracts.js';

export type { LegacySettingsMigrationResult } from './contracts.js';

// =============================================================================
// SŁOWNIK KWARANTANNY — nazwy sprzed clean-room. Nigdzie indziej w repo nie mają prawa być.
// =============================================================================

/** Gałąź czatu w starym worku. */
const STARA_GALAZ_CZATU = 'smart_chat_model';
/** Gałąź źródeł (embedding + wykluczenia) w starym worku. */
const STARA_GALAZ_ZRODEL = 'smart_sources';
/** Gałąź powiadomień w starym worku. */
const STARA_GALAZ_POWIADOMIEN = 'smart_notices';
/** Podgałąź modelu embeddingu wewnątrz gałęzi źródeł. */
const STARA_PODGALAZ_EMBEDDINGU = 'embed_model';

/** Gałęzie najwyższego poziomu kasowane w całości (martwe po stronie odczytu). */
const GALEZIE_DO_KASACJI = [
    'smart_chat_threads',
    'smart_blocks',
    'smart_view_filter',
    'is_obsidian_vault',
    're_import_wait_time',
    'embedding_models',
    'language',
] as const;

/** Stare pola pojedyncze w gałęzi czatu. */
const STARE_POLE_PLATFORMY = 'platform';
const STARE_POLE_TEMPERATURY = 'temperature';
const STARE_POLE_LIMITU_TOKENOW = 'max_tokens';

/** Stare sufiksy pól „per dostawca" w gałęzi czatu. */
const SUFIKS_KLUCZA_API = '_api_key';
const SUFIKS_MODELU = '_model';
const SUFIKS_ADRESU = '_host';

/** Stare pola wewnątrz obiektu dostawcy. */
const STARE_POLE_MODELU = 'model_key';
const STARE_POLE_KLUCZA_API = 'api_key';
const STARE_POLE_PORCJI = 'batch_size';
const STARE_POLE_ADRESU = 'host';

/** Stare pola wewnątrz podgałęzi embeddingu. */
const STARE_POLE_DOSTAWCY = 'adapter';
const STARE_POLE_LIMITU_CZASU = 'embed_timeout_ms';

/** Stare pole wyciszeń w gałęzi powiadomień. */
const STARE_POLE_WYCISZEN = 'muted';

// =============================================================================
// NOWY SŁOWNIK
// =============================================================================

const NAMESPACE = 'pkmAssistant';
const PREFIKS_SCIEZKI = `${NAMESPACE}.`;
/** Prefiks id sekretu — odpowiednik nazwy pluginu w sejfie (`SecretsStorage`). */
const PREFIKS_ID_SEKRETU = 'pkm-assistant';

/**
 * Platformy czatu, których nowy plugin NIE obsługuje. Wybór usera na którejkolwiek
 * z nich zamienia się w `''` („nie wybrano"), żeby UI nie próbowało wstać na martwym
 * dostawcy.
 */
const PLATFORMY_NIEOBSLUGIWANE = new Set(['google', 'azure', 'custom']);

/**
 * Klucze, których migrator NIE zapisze pod żadnym pozorem. Dane wchodzą tu prosto
 * z dysku, a część kluczy docelowych powstaje z TREŚCI pliku (nazwa dostawcy, ścieżka
 * w sejfie) — spreparowany `settings.json` mógłby przez nie ruszyć prototyp obiektu.
 */
const KLUCZE_ZAKAZANE = new Set(['__proto__', 'constructor', 'prototype']);

// =============================================================================
// NARZĘDZIA
// =============================================================================

/** Luźna mapa: dane wchodzą tu prosto z dysku, więc każdy dostęp idzie przez asercję. */
type Slownik = Record<string, unknown>;

const jestZwyklymObiektem = (wartosc: unknown): wartosc is Slownik =>
    typeof wartosc === 'object' && wartosc !== null && !Array.isArray(wartosc);

const maWlasne = (obiekt: Slownik, klucz: string): boolean =>
    Object.prototype.hasOwnProperty.call(obiekt, klucz);

const bezpiecznyKlucz = (klucz: string): boolean => !KLUCZE_ZAKAZANE.has(klucz);

/**
 * Licznik pracy migratora. Trzymany w jednym obiekcie, żeby każdy krok mógł go
 * podbijać bez przekazywania trzech liczb w tę i we w tę.
 */
interface Licznik {
    przeniesione: number;
    skasowane: number;
    sekrety: number;
}

/**
 * Zapisuje wartość pod nowym adresem — ale TYLKO gdy nikt jej tam jeszcze nie
 * wpisał. Świadomy wybór usera w nowym kształcie zawsze wygrywa ze starymi danymi.
 *
 * @returns `true`, gdy wartość faktycznie wylądowała pod nowym adresem
 */
function ustawGdyPusto(cel: Slownik, klucz: string, wartosc: unknown): boolean {
    if (!bezpiecznyKlucz(klucz) || maWlasne(cel, klucz)) return false;
    cel[klucz] = wartosc;
    return true;
}

/**
 * Zwraca (tworząc w razie potrzeby) zagnieżdżony kontener. Tworzy go LENIWIE — pusty
 * kontener bez zawartości psułby idempotencję (drugi przebieg zmieniałby worek).
 */
function kontener(rodzic: Slownik, klucz: string): Slownik {
    const istniejacy = rodzic[klucz];
    if (jestZwyklymObiektem(istniejacy)) return istniejacy;
    const nowy: Slownik = {};
    rodzic[klucz] = nowy;
    return nowy;
}

/**
 * Kanoniczne id sekretu wyprowadzone ze ŚCIEŻKI ustawienia. Deterministyczne, więc
 * drugi przebieg migratora niczego już nie zmienia.
 *
 * `pkmAssistant.chat.apiKeys.anthropic` → `pkm-assistant-chat-apikeys-anthropic`.
 */
function idSekretu(sciezka: string): string {
    const bezNamespace = sciezka.startsWith(PREFIKS_SCIEZKI)
        ? sciezka.slice(PREFIKS_SCIEZKI.length)
        : sciezka;
    return `${PREFIKS_ID_SEKRETU}-${bezNamespace}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// =============================================================================
// KROK 1 — GAŁĄŹ CZATU
// =============================================================================

/** Przenosi starą gałąź czatu pod `pkmAssistant.chat`; resztę gałęzi kasuje. */
function przeniesCzat(worek: Slownik, pkm: Slownik, licznik: Licznik): void {
    if (!maWlasne(worek, STARA_GALAZ_CZATU)) return;

    const zrodlo = worek[STARA_GALAZ_CZATU];
    if (!jestZwyklymObiektem(zrodlo)) {
        delete worek[STARA_GALAZ_CZATU];
        licznik.skasowane += 1;
        return;
    }

    // Modele mają dwa źródła: pole płaskie `<p>_model` i `<p>.model_key`. Płaskie wygrywa,
    // więc najpierw zbieram oba w osobnych mapach, a scalam dopiero na końcu.
    const modelePlaskie = new Map<string, unknown>();
    const modeleZagniezdzone = new Map<string, unknown>();

    for (const [klucz, wartosc] of Object.entries(zrodlo)) {
        if (klucz === STARE_POLE_PLATFORMY) {
            const nazwa = typeof wartosc === 'string' ? wartosc : '';
            const platforma = PLATFORMY_NIEOBSLUGIWANE.has(nazwa) ? '' : nazwa;
            if (ustawGdyPusto(kontener(pkm, 'chat'), 'platform', platforma)) licznik.przeniesione += 1;
            else licznik.skasowane += 1;
            continue;
        }
        if (klucz === STARE_POLE_TEMPERATURY) {
            if (ustawGdyPusto(kontener(pkm, 'chat'), 'temperature', wartosc)) licznik.przeniesione += 1;
            else licznik.skasowane += 1;
            continue;
        }
        if (klucz === STARE_POLE_LIMITU_TOKENOW) {
            if (ustawGdyPusto(kontener(pkm, 'chat'), 'maxTokens', wartosc)) licznik.przeniesione += 1;
            else licznik.skasowane += 1;
            continue;
        }
        if (klucz.endsWith(SUFIKS_KLUCZA_API)) {
            const dostawca = klucz.slice(0, -SUFIKS_KLUCZA_API.length);
            const klucze = kontener(kontener(pkm, 'chat'), 'apiKeys');
            if (ustawGdyPusto(klucze, dostawca, wartosc)) licznik.przeniesione += 1;
            else licznik.skasowane += 1;
            continue;
        }
        if (klucz.endsWith(SUFIKS_ADRESU)) {
            const dostawca = klucz.slice(0, -SUFIKS_ADRESU.length);
            if (ustawGdyPusto(kontener(kontener(pkm, 'chat'), 'hosts'), dostawca, wartosc)) {
                licznik.przeniesione += 1;
            } else licznik.skasowane += 1;
            continue;
        }
        if (klucz.endsWith(SUFIKS_MODELU)) {
            modelePlaskie.set(klucz.slice(0, -SUFIKS_MODELU.length), wartosc);
            continue;
        }
        if (jestZwyklymObiektem(wartosc) && typeof wartosc[STARE_POLE_MODELU] === 'string') {
            modeleZagniezdzone.set(klucz, wartosc[STARE_POLE_MODELU]);
            continue;
        }
        // Wszystko inne (m.in. duplikat platformy) ginie razem z gałęzią.
        licznik.skasowane += 1;
    }

    // Pole płaskie wygrywa nad zagnieżdżonym, gdy user ma oba (mapa scalona w tej
    // kolejności), ale żadne z nich nie rusza wartości już zapisanej w nowym kształcie.
    const modele = new Map([...modeleZagniezdzone, ...modelePlaskie]);
    if (modele.size > 0) {
        const cel = kontener(kontener(pkm, 'chat'), 'models');
        for (const [dostawca, model] of modele) {
            if (ustawGdyPusto(cel, dostawca, model)) licznik.przeniesione += 1;
            else licznik.skasowane += 1;
        }
    }

    delete worek[STARA_GALAZ_CZATU];
}

// =============================================================================
// KROK 2 — GAŁĄŹ ŹRÓDEŁ (EMBEDDING)
// =============================================================================

/** Przenosi ustawienia embeddingu pod `pkmAssistant.embedding`; resztę gałęzi kasuje. */
function przeniesEmbedding(worek: Slownik, pkm: Slownik, licznik: Licznik): void {
    if (!maWlasne(worek, STARA_GALAZ_ZRODEL)) return;

    const zrodlo = worek[STARA_GALAZ_ZRODEL];
    if (!jestZwyklymObiektem(zrodlo)) {
        delete worek[STARA_GALAZ_ZRODEL];
        licznik.skasowane += 1;
        return;
    }

    const model = zrodlo[STARA_PODGALAZ_EMBEDDINGU];
    if (jestZwyklymObiektem(model)) {
        for (const [klucz, wartosc] of Object.entries(model)) {
            if (klucz === STARE_POLE_DOSTAWCY) {
                const dostawca = typeof wartosc === 'string' ? wartosc : '';
                if (ustawGdyPusto(kontener(pkm, 'embedding'), 'provider', dostawca)) {
                    licznik.przeniesione += 1;
                } else licznik.skasowane += 1;
                continue;
            }
            if (klucz === STARE_POLE_LIMITU_CZASU) {
                if (ustawGdyPusto(kontener(pkm, 'embedding'), 'timeoutMs', wartosc)) {
                    licznik.przeniesione += 1;
                } else licznik.skasowane += 1;
                continue;
            }
            if (!jestZwyklymObiektem(wartosc)) {
                licznik.skasowane += 1;
                continue;
            }
            przeniesDostawceEmbeddingu(klucz, wartosc, pkm, licznik);
        }
    } else if (maWlasne(zrodlo, STARA_PODGALAZ_EMBEDDINGU)) {
        licznik.skasowane += 1;
    }

    // Wykluczenia (foldery / pliki / nagłówki) i cała reszta gałęzi są martwe po stronie
    // odczytu — jedynym źródłem wykluczeń jest dziś `pkmAssistant.no_go_folders`.
    for (const klucz of Object.keys(zrodlo)) {
        if (klucz !== STARA_PODGALAZ_EMBEDDINGU) licznik.skasowane += 1;
    }

    delete worek[STARA_GALAZ_ZRODEL];
}

/** Rozkłada jeden obiekt dostawcy embeddingu na cztery nowe gałęzie. */
function przeniesDostawceEmbeddingu(
    dostawca: string,
    wpis: Slownik,
    pkm: Slownik,
    licznik: Licznik,
): void {
    const embedding = kontener(pkm, 'embedding');
    const rozloz = (stare: string, nowe: string): void => {
        if (!maWlasne(wpis, stare)) return;
        if (ustawGdyPusto(kontener(embedding, nowe), dostawca, wpis[stare])) licznik.przeniesione += 1;
        else licznik.skasowane += 1;
    };

    if (typeof wpis[STARE_POLE_MODELU] === 'string') rozloz(STARE_POLE_MODELU, 'models');
    rozloz(STARE_POLE_KLUCZA_API, 'apiKeys');
    rozloz(STARE_POLE_PORCJI, 'batchSize');
    rozloz(STARE_POLE_ADRESU, 'hosts');
}

// =============================================================================
// KROK 3 — POWIADOMIENIA I MARTWE GAŁĘZIE
// =============================================================================

/** Przenosi wyciszenia powiadomień pod `pkmAssistant.notices.muted`. */
function przeniesPowiadomienia(worek: Slownik, pkm: Slownik, licznik: Licznik): void {
    if (!maWlasne(worek, STARA_GALAZ_POWIADOMIEN)) return;

    const zrodlo = worek[STARA_GALAZ_POWIADOMIEN];
    if (jestZwyklymObiektem(zrodlo)) {
        for (const [klucz, wartosc] of Object.entries(zrodlo)) {
            if (klucz === STARE_POLE_WYCISZEN && jestZwyklymObiektem(wartosc)) {
                if (ustawGdyPusto(kontener(pkm, 'notices'), 'muted', wartosc)) licznik.przeniesione += 1;
                else licznik.skasowane += 1;
                continue;
            }
            licznik.skasowane += 1;
        }
    } else {
        licznik.skasowane += 1;
    }

    delete worek[STARA_GALAZ_POWIADOMIEN];
}

/** Kasuje gałęzie, których nowy plugin nie czyta ani nie zapisuje. */
function skasujMartweGalezie(worek: Slownik, licznik: Licznik): void {
    for (const klucz of GALEZIE_DO_KASACJI) {
        if (!maWlasne(worek, klucz)) continue;
        delete worek[klucz];
        licznik.skasowane += 1;
    }
}

// =============================================================================
// KROK 4 — SEJF SEKRETÓW
// =============================================================================

/**
 * Stare adresy pól sekretnych. Sejf trzeba umieć naprawić Z SAMEJ ŚCIEŻKI, bo u usera
 * z WŁĄCZONYM sejfem klucza API w ogóle NIE MA w ustawieniach — zostaje po nim wyłącznie
 * wpis w `refs` i zaszyfrowany blob. Gdyby nowy adres brał się z kroków 1-2 (czyli z pól,
 * które fizycznie leżą w pliku), taki user wyszedłby z migracji z `refs` celującym
 * w martwy adres, czyli BEZ KLUCZY — a stare nazwy zostałyby w danych na zawsze.
 */
const WZOR_SEKRETU_CZATU = new RegExp(`^${STARA_GALAZ_CZATU}\\.([^.]+)${SUFIKS_KLUCZA_API}$`);
const WZOR_SEKRETU_EMBEDDINGU = new RegExp(
    `^${STARA_GALAZ_ZRODEL}\\.${STARA_PODGALAZ_EMBEDDINGU}\\.([^.]+)\\.${STARE_POLE_KLUCZA_API}$`,
);

/** Tłumaczy stary adres pola sekretnego na nowy; `undefined` = adres nie jest stary. */
function nowaSciezkaSekretu(stara: string): string | undefined {
    const czat = WZOR_SEKRETU_CZATU.exec(stara);
    if (czat) return `${PREFIKS_SCIEZKI}chat.apiKeys.${czat[1]}`;
    const embedding = WZOR_SEKRETU_EMBEDDINGU.exec(stara);
    if (embedding) return `${PREFIKS_SCIEZKI}embedding.apiKeys.${embedding[1]}`;
    return undefined;
}

/**
 * Wykrywa id sekretu niosące słownictwo sprzed clean-room. Lista ścieżek sekretnych jest
 * zamknięta i systemowa (żaden segment nie pochodzi od usera), więc te dwa słowa nie
 * mają prawa trafić do id inaczej niż z poprzedniej epoki.
 */
const SLOWNICTWO_SPRZED_CLEAN_ROOM = /obsek|smart/i;

/**
 * Przepina sejf sekretów. Rusza wpis TYLKO wtedy, gdy ma po temu powód:
 *
 *  1. **ścieżka się przeprowadza** — pole sekretne ma nowy adres (`nowaSciezkaSekretu`),
 *     więc klucz w `refs` musi pójść za nim; inaczej wstrzykiwanie kluczy API celuje
 *     w martwy adres i user zostaje bez kluczy;
 *  2. **id niesie stare słownictwo** — `obsek-…` / `…-smart-chat-model-…`; decyzja Kuby
 *     z 05.09 („zero śladu także w danych", spec §7) każe je przemianować.
 *
 * Wpisy, które nie spełniają żadnego z tych dwóch warunków — np. czysty już
 * `pkmAssistant.imageGen.stability_api_key` — zostają NIETKNIĘTE. To celowe zawężenie
 * względem wersji, która kanonizowała cały sejf hurtem: migrator nie ma prawa
 * przemianowywać id, które nikogo nie obchodzą (zamrożenie id z katalogu D.4/G.6 jest
 * tu uchylone dokładnie na szerokość powodów 1 i 2, ani o krok dalej).
 *
 * ⚠️ To JEDYNE miejsce w repo, które wolno mianować id sekretów — i robi to bez
 * odszyfrowywania czegokolwiek: zaszyfrowane bloby są tylko PRZEKLUCZANE.
 */
function przepnijSejf(pkm: Slownik, licznik: Licznik): void {
    const sejf = pkm.secureStorage;
    if (!jestZwyklymObiektem(sejf)) return;

    const refs = sejf.refs;
    if (!jestZwyklymObiektem(refs)) return;
    const zaszyfrowane = jestZwyklymObiektem(sejf.encrypted) ? sejf.encrypted : null;

    for (const staraSciezka of Object.keys(refs)) {
        if (!bezpiecznyKlucz(staraSciezka)) continue;

        const wpis = refs[staraSciezka];
        const stareId = typeof wpis === 'string' ? wpis : null;
        const nowaSciezka = nowaSciezkaSekretu(staraSciezka);
        const przeprowadzka = nowaSciezka !== undefined && nowaSciezka !== staraSciezka;
        const stareSlownictwo = stareId !== null && SLOWNICTWO_SPRZED_CLEAN_ROOM.test(stareId);
        if (!przeprowadzka && !stareSlownictwo) continue;

        const docelowaSciezka = nowaSciezka ?? staraSciezka;

        // Kolizja: pod nowym adresem user ma już wpis → stary tylko kasujemy, bo
        // świadomy wpis w nowym kształcie zawsze wygrywa ze starym.
        if (przeprowadzka && maWlasne(refs, docelowaSciezka)) {
            delete refs[staraSciezka];
            licznik.skasowane += 1;
            continue;
        }

        // Wpis o nietekstowej wartości też idzie za ścieżką — inaczej stara nazwa klucza
        // zostałaby w danych usera na zawsze. Samej wartości wtedy nie ruszamy.
        const noweId = stareId === null ? null : idSekretu(docelowaSciezka);
        if (!przeprowadzka && noweId === stareId) continue;

        if (przeprowadzka) delete refs[staraSciezka];
        refs[docelowaSciezka] = noweId ?? wpis;

        if (
            zaszyfrowane !== null &&
            stareId !== null &&
            noweId !== null &&
            noweId !== stareId &&
            bezpiecznyKlucz(noweId) &&
            maWlasne(zaszyfrowane, stareId) &&
            !maWlasne(zaszyfrowane, noweId)
        ) {
            zaszyfrowane[noweId] = zaszyfrowane[stareId];
            delete zaszyfrowane[stareId];
        }
        licznik.sekrety += 1;
    }
}

// =============================================================================
// WEJŚCIE PUBLICZNE
// =============================================================================

/**
 * Przenosi stary worek ustawień na nowy kształt — w PAMIĘCI, mutując przekazany obiekt.
 * Na dysk nowy kształt trafia dopiero przy pierwszym normalnym zapisie ustawień
 * (żelazna zasada: `load` niczego nie zapisuje).
 *
 * Nie dotyka `data.json` pluginu ani gałęzi, których nie zna — cudze klucze pod
 * `pkmAssistant.*` przechodzą przez migrator bez śladu.
 *
 * @param data - surowy worek ustawień (mutowany w miejscu); wejście nie-obiektowe
 *               kończy się spokojnym `{ migrated: false }`
 */
export function migrateLegacySettings(data: unknown): LegacySettingsMigrationResult {
    const pusty: LegacySettingsMigrationResult = {
        migrated: false,
        movedKeys: 0,
        removedKeys: 0,
        secretRefsMigrated: 0,
    };
    if (!jestZwyklymObiektem(data)) return pusty;

    const licznik: Licznik = { przeniesione: 0, skasowane: 0, sekrety: 0 };
    const dotykaStarychGalezi =
        maWlasne(data, STARA_GALAZ_CZATU) ||
        maWlasne(data, STARA_GALAZ_ZRODEL) ||
        maWlasne(data, STARA_GALAZ_POWIADOMIEN) ||
        GALEZIE_DO_KASACJI.some(klucz => maWlasne(data, klucz));

    // Kontener namespace'u powstaje TYLKO wtedy, gdy jest co do niego włożyć — inaczej
    // drugi przebieg dopisywałby pusty obiekt i idempotencja byłaby fikcją.
    const pkm = dotykaStarychGalezi || jestZwyklymObiektem(data[NAMESPACE])
        ? kontener(data, NAMESPACE)
        : null;

    if (pkm) {
        przeniesCzat(data, pkm, licznik);
        przeniesEmbedding(data, pkm, licznik);
        przeniesPowiadomienia(data, pkm, licznik);
        skasujMartweGalezie(data, licznik);
        przepnijSejf(pkm, licznik);
    }

    return {
        migrated: licznik.przeniesione > 0 || licznik.skasowane > 0 || licznik.sekrety > 0,
        movedKeys: licznik.przeniesione,
        removedKeys: licznik.skasowane,
        secretRefsMigrated: licznik.sekrety,
    };
}
