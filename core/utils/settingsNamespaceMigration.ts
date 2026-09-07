/**
 * S35 „Wielki Rename" — migrator namespace ustawień: `obsek` → `pkmAssistant`.
 *
 * Czysta funkcja, ZERO I/O i zero importów Obsidiana. To jest gwarancja żelaznej
 * zasady z incydentu 2026-07-28: **load niczego nie zapisuje**. Migrator przestawia
 * kształt obiektu wyłącznie W PAMIĘCI; na dysk nowy kształt trafia dopiero przy
 * pierwszym NORMALNYM zapisie ustawień (SettingsManager.save → PKMEnv.save_settings).
 *
 * Idempotentny: gdy `pkmAssistant` już jest (albo gdy `obsek` w ogóle nie ma), nie
 * rusza niczego. Gdy — z jakiegoś powodu — są OBA klucze, wygrywa nowy, a stary
 * zostaje nietknięty (nie kasujemy i nie mergujemy: to materiał na ręczną decyzję,
 * a nie na ciche zlepianie dwóch źródeł prawdy).
 */

const OLD_KEY = 'obsek';
const NEW_KEY = 'pkmAssistant';
const OLD_PATH_PREFIX = 'obsek.';
const NEW_PATH_PREFIX = 'pkmAssistant.';

/**
 * Luźna mapa string→cokolwiek. Dane wchodzą tu prosto z dysku (`unknown`), więc każdy
 * dostęp idzie przez asercję — kod wykonywalny zostaje bajt w bajt ten sam.
 */
type LooseObject = Record<string, unknown>;

/** Gałąź, w którą migrator zagląda głębiej: mapa `fieldPath → id sekretu` w sejfie. */
type NamespaceBranch = { secureStorage?: { refs?: unknown } };

/**
 * @param data - surowy obiekt ustawień (mutowany w miejscu)
 */
export function migrateNamespace(data: unknown): { migrated: boolean; refsMigrated?: number } {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { migrated: false };
    if (Object.prototype.hasOwnProperty.call(data, NEW_KEY)) return { migrated: false };
    if (!Object.prototype.hasOwnProperty.call(data, OLD_KEY)) return { migrated: false };

    (data as LooseObject)[NEW_KEY] = (data as LooseObject)[OLD_KEY];
    delete (data as LooseObject)[OLD_KEY];

    // Sejf sekretów: mapa refs to fieldPath → id sekretu. Ścieżki muszą pójść za
    // namespace'em, inaczej hydrateSettings wstrzyknie klucze API pod martwy adres
    // i user zostaje bez kluczy. IDENTYFIKATORÓW (wartości) ani blobów `encrypted`
    // NIE ruszamy — są opaque i działają dalej.
    let refsMigrated = 0;
    const refs = ((data as LooseObject)[NEW_KEY] as NamespaceBranch | undefined)?.secureStorage?.refs;
    if (refs && typeof refs === 'object' && !Array.isArray(refs)) {
        for (const oldPath of Object.keys(refs)) {
            if (!oldPath.startsWith(OLD_PATH_PREFIX)) continue;
            const newPath = NEW_PATH_PREFIX + oldPath.slice(OLD_PATH_PREFIX.length);
            if (!Object.prototype.hasOwnProperty.call(refs, newPath)) {
                (refs as LooseObject)[newPath] = (refs as LooseObject)[oldPath];
                refsMigrated += 1;
            }
            delete (refs as LooseObject)[oldPath];
        }
    }

    return { migrated: true, refsMigrated };
}
