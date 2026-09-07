/**
 * JEDNO źródło wzorca bramki „grep zero" (clean-room).
 *
 * DLACZEGO OSOBNY PLIK: ten sam wzorzec był dotąd przepisany w dwóch miejscach —
 * `core/clean_room_guard.test.ts` i `build_kontrakt.test.ts`. Dwie kopie tej samej listy
 * rozjeżdżają się po pierwszej zmianie, a rozjazd w BRAMCE jest cichy: węższa kopia
 * przepuszcza to, co szersza łapie.
 *
 * DLACZEGO TAK DZIWNIE ZAPISANY: plik z listą zakazanych słów sam by się o nią odbijał —
 * bramka szuka ich WSZĘDZIE, także w sobie. Każda pozycja ma więc jedną literę ujętą
 * w klasę znaków (`[s]mart` ≡ `smart` dla silnika wyrażeń regularnych), przez co
 * w TEKŚCIE pliku zakazany ciąg nie występuje ani razu, a ZNACZENIE wzorca jest
 * identyczne. Dzięki temu ten plik NIE potrzebuje wyjątku w bramce — a każdy wyjątek
 * to dziura, o której trzeba pamiętać.
 *
 * ŹRÓDŁO PRAWDY: `clean_room_grep.sh` (ERE, case-insensitive). Zmieniasz wzorzec tam —
 * zmieniasz go TU, i nigdzie indziej.
 */

/**
 * Alternatywy wzorca, w kolejności z gatunkowego skryptu. Każda jest zapisem
 * równoważnym, nie luźniejszym — nie „upraszczaj" klas znaków z powrotem do gołych liter.
 */
const ALTERNATYWY = [
    '[s]mart[ _-]?(env|chat|sources|blocks|notices|view|fs|utils|model|embed|settings|events|collections|plugin|connections|http|rank|context)',
    '[S]mart[A-Z][A-Za-z]*',
    '[j]sbrains',
    '[b]rianpe[t]ro',
    'pe[t]ro',
    '[j]obsi',
    'sc[_-]extraction',
    'inlined[ ]from',
    'sc[-]notice',
    '[s]mart_env',
    '.[s]mart-env',
    '[S]martStreamer',
    '_sc[-]legacy',
    '[s]mart plugins license',
] as const;

/** Źródło wyrażenia — dokładny odpowiednik `PATTERN` ze skryptu bramki. */
export const CLEAN_ROOM_PATTERN_SOURCE = ALTERNATYWY.join('|');

/** Gotowe wyrażenie, bez flagi `g` (żeby `lastIndex` nie niósł stanu między wywołaniami). */
export function cleanRoomPattern(): RegExp {
    return new RegExp(CLEAN_ROOM_PATTERN_SOURCE, 'i');
}
