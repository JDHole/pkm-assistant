/**
 * Pancerz ustawień — czysta warstwa nad `SettingsIo`.
 *
 * CZYSTA WZGLĘDEM `settings.json`: NIGDY nie pisze do `SETTINGS_PATH` (S-07/S-08) —
 * wolno jej dotknąć tylko odkładki `corrupt-<ts>`, `last-good` i katalogu backupów.
 *
 * S-16: NIGDY nie ufamy `exists()` — każde „czy plik jest?" robimy PRÓBĄ ODCZYTU.
 * (Incydent 2026-07-28: dysk sieciowy skłamał, że pliku nie ma, a load nadpisał userowi
 * klucze API pustką. Dlatego `SettingsIo` w ogóle nie ma metody `exists`.)
 */
import { migrateNamespace } from '../utils/settingsNamespaceMigration.js';
import { cloneConfig, deepMergeMissing } from './configMerge.js';
import { migrateLegacySettings } from './legacySettingsMigration.js';
import {
    DEFAULT_UI_LANGUAGE,
    SETTINGS_BACKUPS_DIR,
    SETTINGS_BACKUP_RETENTION,
    SETTINGS_DIR,
    SETTINGS_LAST_GOOD_PATH,
    SETTINGS_PATH,
} from './contracts.js';
import type {
    LoggerLike,
    SettingsArmorDeps,
    SettingsBag,
    SettingsIo,
    SettingsLoadResult,
    SettingsSource,
    VaultAdapterLike,
} from './contracts.js';

/** Nazwa modułu w logach. */
const SCOPE = 'settingsArmor';

/** Luźny widok worka — dane przyjeżdżają z dysku jako `unknown`. */
type Worek = Record<string, unknown>;

/**
 * Wczytanie ustawień z pełnym pancerzem (migracje biegną W PAMIĘCI).
 *
 * Kolejność: `settings.json` → (gdy nieczytelny) odkładka + `settings.last-good.json`
 * → (gdy i tego nie ma) fabryczne defaulty. Cokolwiek się sparsuje, dostaje migracje
 * w pamięci i domerge'owane defaulty; na dysk nie idzie NIC poza kopiami.
 */
export async function loadSettingsWithArmor(deps: SettingsArmorDeps): Promise<SettingsLoadResult> {
    const { io, defaults, log } = deps;

    const wynik: SettingsLoadResult = {
        settings: cloneConfig(defaults ?? {}),
        source: 'defaults',
        lastGoodRefreshed: false,
        backupWritten: false,
        migrations: { namespace: false, legacyKeys: false },
    };

    const surowyGlowny = await odczytaj(io, SETTINGS_PATH, log);
    let worek = sparsujWorek(surowyGlowny);
    let source: SettingsSource = 'defaults';
    /** Treść, która SIĘ SPARSOWAŁA — tylko taka ma prawo awansować na kopię (S-11/S-12). */
    let trescDoAwansu: string | null = null;

    if (worek) {
        source = 'primary';
        trescDoAwansu = surowyGlowny;
    } else {
        if (surowyGlowny !== null) {
            // Plik JEST, ale się nie parsuje. Odkładamy go 1:1 na bok i idziemy po kopię.
            // Parser odrzuca CAŁOŚĆ — z uszkodzonej treści nie wydłubujemy ani jednego klucza (S-10).
            const odkladka = `${SETTINGS_DIR}/settings.corrupt-${io.now()}.json`;
            if (await zapisz(io, odkladka, surowyGlowny, log)) wynik.quarantinedPath = odkladka;
            log?.warn(SCOPE, `Nieczytelny plik ustawień — kopia 1:1 poszła do ${odkladka}`);
        }
        const surowaKopia = await odczytaj(io, SETTINGS_LAST_GOOD_PATH, log);
        const zKopii = sparsujWorek(surowaKopia);
        if (zKopii) {
            worek = zKopii;
            source = 'last-good';
            log?.warn(SCOPE, 'Ustawienia wczytane z kopii zapasowej — plik główny był nieczytelny');
        }
    }

    if (!worek) {
        log?.warn(SCOPE, 'Brak czytelnych ustawień — start na wartościach fabrycznych');
        return wynik;
    }

    const mialTresc = Object.keys(worek).length > 0;

    wynik.migrations.namespace = przemianujNamespace(worek, log);
    wynik.migrations.legacyKeys = przenienStareKlucze(worek, log);
    wynik.settings = deepMergeMissing(cloneConfig(worek) as SettingsBag, cloneConfig(defaults ?? {}));
    wynik.source = source;

    // Awans na kopię i backup dzienny robimy WYŁĄCZNIE z treści głównego pliku, która się
    // sparsowała. Awans z treści surowej kasował userowi jedyną kopię zapasową (regresja
    // `parsedFromRaw`), a awans z kopii nadpisywałby ją samą sobą.
    if (source === 'primary' && trescDoAwansu !== null && mialTresc) {
        wynik.lastGoodRefreshed = await zapisz(io, SETTINGS_LAST_GOOD_PATH, trescDoAwansu, log);
        wynik.backupWritten = await zrobBackupDzienny(io, trescDoAwansu, log);
    }

    return wynik;
}

/**
 * Tani odczyt JĘZYKA interfejsu, zanim wstanie runtime (E-21/E-22).
 * Kandydaci W TEJ KOLEJNOŚCI: `SETTINGS_PATH` → `SETTINGS_LAST_GOOD_PATH`.
 * Brak / nieczytelny / padnięty adapter → `DEFAULT_UI_LANGUAGE`.
 *
 * Wołane z `onload()` PRZED rejestracją komend, bo Obsidian zapamiętuje ich nazwy
 * w chwili rejestracji — a to jeden odczyt jednego pola, niezależny od bootu runtime'u.
 */
export async function readUiLanguage(adapter: VaultAdapterLike | null | undefined): Promise<string> {
    const io = createVaultSettingsIo(adapter);
    for (const sciezka of [SETTINGS_PATH, SETTINGS_LAST_GOOD_PATH]) {
        const surowe = await odczytaj(io, sciezka);
        const worek = sparsujWorek(surowe);
        if (!worek) continue;
        // Worek sprzed przemianowania namespace'u też ma prawo mieć język — migrator jest
        // czysty i biegnie tu na KOPII, żeby ten odczyt niczego nie mutował.
        const kopia = cloneConfig(worek);
        przemianujNamespace(kopia);
        const jezyk = (kopia['pkmAssistant'] as Worek | undefined)?.['language'];
        if (typeof jezyk === 'string' && jezyk.trim() !== '') return jezyk;
    }
    return DEFAULT_UI_LANGUAGE;
}

/**
 * Buduje `SettingsIo` na adapterze vaulta Obsidiana.
 *
 * Wszystkie metody są fail-soft: brak pliku i pad adaptera wyglądają tak samo (`null`),
 * bo pancerz i tak reaguje na jedno i drugie identycznie — degradacją, nie wyjątkiem.
 */
export function createVaultSettingsIo(adapter: VaultAdapterLike | null | undefined): SettingsIo {
    const a = adapter ?? null;
    return {
        async read(path: string): Promise<string | null> {
            if (typeof a?.read !== 'function') return null;
            try {
                const dane = await a.read(path);
                return typeof dane === 'string' ? dane : null;
            } catch {
                // Brak pliku albo pad dysku — dla pancerza to ta sama sytuacja.
                return null;
            }
        },
        async write(path: string, data: string): Promise<void> {
            if (typeof a?.write !== 'function') throw new Error('Adapter vaulta nie umie pisać');
            await a.write(path, data);
        },
        async mkdir(path: string): Promise<void> {
            if (typeof a?.mkdir !== 'function') return;
            try {
                await a.mkdir(path);
            } catch {
                // Katalog już jest — jedyny realny powód pada tutaj.
            }
        },
        async list(path: string): Promise<{ files: string[]; folders: string[] }> {
            if (typeof a?.list !== 'function') return { files: [], folders: [] };
            try {
                const wynik = await a.list(path);
                return { files: wynik?.files ?? [], folders: wynik?.folders ?? [] };
            } catch {
                return { files: [], folders: [] };
            }
        },
        async remove(path: string): Promise<void> {
            if (typeof a?.remove !== 'function') return;
            await a.remove(path);
        },
        now: () => Date.now(),
    };
}

// ── bebechy ──────────────────────────────────────────────────────────────────

async function odczytaj(io: SettingsIo, path: string, log?: LoggerLike): Promise<string | null> {
    try {
        return await io.read(path);
    } catch (e) {
        log?.warn(SCOPE, `Odczyt ${path} padł:`, e);
        return null;
    }
}

/** Zapis kopii/odkładki. Zwraca `true`, gdy naprawdę poszło na dysk. */
async function zapisz(io: SettingsIo, path: string, data: string, log?: LoggerLike): Promise<boolean> {
    try {
        await io.mkdir(katalog(path));
        await io.write(path, data);
        return true;
    } catch (e) {
        // Dysk tylko-do-odczytu albo brak miejsca. Brak kopii to mniejsza szkoda niż
        // zatrzymanie startu, więc degradujemy i logujemy.
        log?.warn(SCOPE, `Zapis ${path} padł:`, e);
        return false;
    }
}

function katalog(path: string): string {
    const i = path.lastIndexOf('/');
    return i > 0 ? path.slice(0, i) : SETTINGS_DIR;
}

/** JSON → worek. Wszystko inne (urwana treść, tablica, liczba) = `null`, czyli „nie ma". */
function sparsujWorek(surowe: string | null): Worek | null {
    if (surowe === null || surowe.trim() === '') return null;
    try {
        const dane: unknown = JSON.parse(surowe);
        if (!dane || typeof dane !== 'object' || Array.isArray(dane)) return null;
        return dane as Worek;
    } catch {
        return null;
    }
}

function przemianujNamespace(worek: Worek, log?: LoggerLike): boolean {
    try {
        return migrateNamespace(worek).migrated;
    } catch (e) {
        log?.warn(SCOPE, 'Przemianowanie namespace ustawień padło:', e);
        return false;
    }
}

function przenienStareKlucze(worek: Worek, log?: LoggerLike): boolean {
    try {
        return migrateLegacySettings(worek).migrated;
    } catch (e) {
        // Migrator jest czysty i nie ma prawa rzucać; gdy jednak rzuci, user dostaje
        // ustawienia w starym kształcie zamiast wywrotki startu.
        log?.warn(SCOPE, 'Przeniesienie starych kluczy ustawień padło:', e);
        return false;
    }
}

/**
 * Jeden backup na dobę + rotacja do {@link SETTINGS_BACKUP_RETENTION} sztuk.
 * Świeżo zapisanej kopii rotacja nigdy nie kasuje.
 */
async function zrobBackupDzienny(io: SettingsIo, tresc: string, log?: LoggerLike): Promise<boolean> {
    const sciezka = `${SETTINGS_BACKUPS_DIR}/settings.${stempelDnia(io.now())}.json`;
    const juzJest = await odczytaj(io, sciezka, log);
    if (juzJest !== null) return false;

    if (!await zapisz(io, sciezka, tresc, log)) return false;
    await obetnijBackupy(io, sciezka, log);
    return true;
}

function stempelDnia(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

async function obetnijBackupy(io: SettingsIo, swiezy: string, log?: LoggerLike): Promise<void> {
    try {
        const { files } = await io.list(SETTINGS_BACKUPS_DIR);
        // Nazwa niesie datę ISO, więc porządek alfabetyczny = porządek chronologiczny.
        const starsze = files.filter(p => p !== swiezy && p.endsWith('.json')).sort();
        const doKasacji = starsze.slice(0, Math.max(0, starsze.length - (SETTINGS_BACKUP_RETENTION - 1)));
        for (const p of doKasacji) await io.remove(p);
    } catch (e) {
        log?.warn(SCOPE, 'Rotacja backupów ustawień padła:', e);
    }
}
