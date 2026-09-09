/**
 * Key Sanitizer - API key security utilities + path sanitization.
 * Protects against key leakage through MCP tools, logs, and memory extraction.
 * Protects against path traversal attacks.
 */

/**
 * Paths that must NEVER be accessible through MCP vault tools.
 *
 * Katalog logów (linie logu wożą nagłówki żądań i pełne ścieżki notatek) oraz katalog sesji
 * pamięci agenta niosą sekrety i treść rozmów, więc są tu chronione. Wpis może zawierać `*`
 * jako JEDEN segment ścieżki (slug agenta) - patrz `_PROTECTED_MATCHERS`.
 */
const PROTECTED_PATHS = [
    '.pkm-assistant/settings.json',
    '.pkm-assistant/settings.last-good.json',
    '.pkm-assistant/backups',
    '.pkm-assistant/logs',
    '.pkm-assistant/agents/*/memory/sessions',
    '.env',
    'data.json',
];

/**
 * Wpisy, które plugin dopisuje do `.gitignore` vaulta przy starcie.
 * Jedna lista zamiast rozsypanych wywołań w `src/main.ts` - dzięki temu da się ją objąć
 * testem bez wstawania Obsidiana. Kolejność = kolejność dopisywania.
 *
 * ⚠️ Katalog sesji pamięci agenta (`.pkm-assistant/agents/<slug>/memory/sessions/`) NIE jest
 * na tej liście, mimo że pliki sesji mogą nieść sekret wpleciony w treść błędu przy padniętym
 * strumieniu - bo pliki sesji to PAMIĘĆ AGENTÓW między urządzeniami (laptop ↔ chmura ↔
 * telefon, przez repo vaulta) i mają podróżować z gitem. Sekrety załatwiamy U ŹRÓDŁA:
 * `AgentMemory` przepuszcza każdy zapis pliku sesji przez `maskSensitiveData` (patrz
 * `modules/memory/AgentMemory.ts`, `_writeSessionFile`). Sesje wracają do gita - zamaskowane.
 *
 * ⚠️ To NIE dotyka `PROTECTED_PATHS`: sesje dalej są poza zasięgiem narzędzi agenta.
 * Osobne osie - „czy narzędzie może to otworzyć" ≠ „czy to wolno wersjonować".
 *
 * ⚠️ Plugin NIGDY nie usuwa wpisu, który już dopisał - kto ma tu wpis w `.gitignore`,
 * musi skasować linię ręcznie.
 */
export const VAULT_GITIGNORE_ENTRIES = [
    '.pkm-assistant/settings.json',
    '.pkm-assistant/settings.last-good.json',
    '.pkm-assistant/backups/',
    // Log pluginu niesie nagłówki żądań i pełne ścieżki notatek — nigdy do repo usera.
    '.pkm-assistant/logs/',
];

/**
 * Skompilowane wzorce ścieżek chronionych. Dopasowanie jest SEGMENTOWE: wpis musi stać
 * w ścieżce jako całe segmenty (`^` albo `/` przed, `/` albo koniec po), więc `logs`
 * w `Projekty/logs/x.md` nie łapie się na `.pkm-assistant/logs`. `*` we wpisie zastępuje
 * dokładnie jeden segment (slug agenta).
 */
const _PROTECTED_MATCHERS = PROTECTED_PATHS.map(entry => {
    const body = entry
        .toLowerCase()
        .split('/')
        .map(seg => (seg === '*' ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('/');
    return new RegExp(`(?:^|/)${body}(?:/|$)`);
});

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MAX_PATH_LENGTH = 4096;
const MAX_SEGMENT_LENGTH = 255;

/**
 * Znaki, których sama OBECNOŚĆ w ścieżce ją unieważnia: null byte oraz cztery niewidoczne
 * formatujące punkty kodowe (ZERO WIDTH SPACE `\u200B`, ZERO WIDTH NON-JOINER `\u200C`,
 * ZERO WIDTH JOINER `\u200D`, BOM/ZERO WIDTH NO-BREAK SPACE `\uFEFF`) — bywają wklejane,
 * żeby oszukać porównania stringów albo ukryć znak w nazwie pliku.
 *
 * ⚠️ Zapisane jako ALTERNATYWA (`a|b|c|d|e`), NIE jako klasa znaków (`[abcde]`). ESLint
 * (`no-misleading-character-class`) słusznie ostrzegał przy dawnym zapisie
 * `/[\0\u200B\u200C\u200D\uFEFF]/`: `\u200C`/`\u200D` mają właściwość Unicode
 * Grapheme_Cluster_Break Extend/ZWJ, więc stojąc OBOK SIEBIE w klasie wyglądają jak zapis
 * jednej złożonej sekwencji — a klasa znaków zawsze dopasowuje POJEDYNCZY punkt kodowy, nigdy
 * sekwencję. Intencja tu i tak była „dowolny z tych pięciu, niezależnie", więc alternacja ma
 * DOKŁADNIE tę samą semantykę dla `.test()` (sprawdzone fuzz-testem 50k losowych ciągów,
 * w tym emoji ZWJ/regional-indicator i znaków składających — zero rozbieżności), tylko bez
 * dwuznaczności klasy znaków.
 */
const DANGEROUS_INVISIBLE_CHARS = /\0|\u200B|\u200C|\u200D|\uFEFF/;

function hasHomoglyphMix(segment: string): boolean {
    const scriptPart = segment.replace(/\.[a-z0-9]+$/i, '');
    const hasLatin = /[a-zA-Z]/.test(scriptPart);
    const hasCyrillic = /[\u0400-\u04ff]/.test(scriptPart);
    const hasGreek = /[\u0370-\u03ff]/.test(scriptPart);
    return (hasLatin && hasCyrillic) || (hasLatin && hasGreek);
}

/**
 * Check if a path points to a protected system file.
 * @param filePath - Path to check (relative to vault root). Typ `unknown` jest UCZCIWY:
 *   ścieżki przychodzą wprost z argumentów narzędzi modelu, a strażnik odsiewa nie-stringi
 *   własnym `typeof` (testy jawnie karmią go `null`/liczbą/obiektem).
 * @returns true if path is protected
 */
export function isProtectedPath(filePath: unknown): boolean {
    if (!filePath || typeof filePath !== 'string') return false;
    const normalized = filePath.replace(/\\/g, '/').normalize('NFC').toLowerCase();
    return _PROTECTED_MATCHERS.some(re => re.test(normalized));
}

/**
 * Ile razy wolno przepuścić ścieżkę przez `sanitizeOnce`, zanim uznamy, że się nie ustabilizuje.
 *
 * Jeden przebieg zdejmuje JEDNĄ warstwę `%XX` (`decodeURIComponent` nie schodzi głębiej), więc
 * pięć przebiegów obsługuje cztery warstwy kodowania i przebieg potwierdzający. Realne ścieżki
 * stabilizują się po jednym-dwóch. Wyczerpanie limitu = `null` (fail-closed) — nie zgadujemy,
 * co model chciał napisać, opakowując `%25` dziesięć razy.
 */
const MAX_SANITIZE_PASSES = 5;

/**
 * JEDEN przebieg normalizacji ścieżki. Prywatny — publiczna jest `sanitizePath`, która woła
 * to w pętli aż do punktu stałego.
 *
 * Blocks traversal, absolute paths, null bytes, zero-width unicode, mixed-script homoglyph
 * risk, Windows reserved filenames, and excessive path lengths.
 *
 * ⚠️ Sam w sobie NIE jest idempotentny — i to jest w porządku, bo nikt go tak nie używa:
 * `trim()` działa raz na CAŁYM ciągu (nie na segmentach), a `decodeURIComponent` robi jeden
 * przebieg. Dlatego `'./ A/B.md'` wychodzi stąd jako `' A/B.md'`, a `'a%252e%252e/x'` jako
 * `'a%2e%2e/x'`. Domknięciem zajmuje się pętla w `sanitizePath`.
 */
function sanitizeOnce(path: string): string | null {
    if (DANGEROUS_INVISIBLE_CHARS.test(path)) return null;

    const trimmed = path.trim().normalize('NFC');
    let decoded = trimmed;
    try {
        decoded = decodeURIComponent(trimmed).normalize('NFC');
    } catch {
        decoded = trimmed;
    }

    if (DANGEROUS_INVISIBLE_CHARS.test(decoded)) return null;
    if (decoded.length > MAX_PATH_LENGTH) return null;

    const forwardSlashed = decoded.replace(/\\/g, '/');
    if (/^[a-zA-Z]:/.test(forwardSlashed) || forwardSlashed.startsWith('//')) return null;

    let normalized = forwardSlashed.replace(/\/+/g, '/');
    normalized = normalized.replace(/^\/+/, '').replace(/\/+$/, '');

    if (!normalized) return null;

    // `.` i puste segmenty NIC nie znaczą - wycinamy je, żeby `./Sekrety/./x.md`
    // i `Sekrety/x.md` były jednym i tym samym ciągiem dla każdej bramki niżej.
    // `..` nadal ODRZUCAMY (nie rozwiązujemy go - wyjście w górę ma być błędem, nie skrótem).
    const components = normalized.split('/').filter(c => c !== '' && c !== '.');
    if (components.length === 0) return null;
    if (components.some(c => c === '..')) return null;
    if (components.some(c => c.length > MAX_SEGMENT_LENGTH)) return null;
    if (components.some(hasHomoglyphMix)) return null;
    if (components.some(c => WINDOWS_RESERVED_NAMES.test(c))) return null;
    // Gwiazdka NIE jest nazwą pliku - jest w tym kodzie znakiem STERUJĄCYM.
    // `AccessGuard._matchesEntry` czyta ją jako globa whitelisty, a klucz reguły
    // „Zawsze zezwalaj" jako „dowolny cel". Cel przychodzący od modelu ma znaczyć JEDEN plik,
    // więc `delete {path:"*"}` odpada tu, zanim ktokolwiek zobaczy okno zgody z bezsensownym
    // celem. Windows i tak zabrania `*` w nazwach, a Obsidian nie pozwala jej wpisać.
    // ⚠️ Świadomie WYŁĄCZNIE `*`: `?`, `[`, `]` czy `%` żadnego znaczenia sterującego tu nie
    // mają, a w tytułach notatek („Czy to działa?.md") są pospolite na macOS i Linuksie -
    // odrzucanie ich byłoby regresją, nie obroną. Prawdziwa naprawa siedzi w `ApprovalManager`;
    // to jest druga warstwa, bo cele nie-vaultowe (`web.*`, `agent.message`) tędy nie idą.
    if (components.some(c => c.includes('*'))) return null;

    return components.join('/');
}

/**
 * Sanitize and normalize a vault-relative path - do PUNKTU STAŁEGO.
 *
 * Wynik jest FORMĄ KANONICZNĄ ścieżki - bez segmentów `./`, bez `..`, bez wiodącego
 * i końcowego `/`, bez `\` i bez `%XX`. Ta sama ścieżka zapisana na kilkanaście sposobów
 * daje ten sam ciąg, więc bramka (No-Go, pliki chronione, whitelista) i narzędzie oglądają
 * DOKŁADNIE to samo.
 *
 * DLACZEGO PĘTLA: pojedynczy przebieg (`sanitizeOnce`) nie jest idempotentny - `trim()`
 * działa raz na całym ciągu, a `decodeURIComponent` schodzi o jedną warstwę kodowania.
 * Kontrprzykłady:
 *   `'./ A/B.md'` → `' A/B.md'` → `'A/B.md'`,   `'x.md%20'` → `'x.md '` → `'x.md'`,
 *   `'a%252e%252e/x'` → `'a%2e%2e/x'` → `'a../x'`,   `'%252e%252e/x'` → `'%2e%2e/x'` → null.
 * Bez pętli bramka i zlew mogłyby oglądać DWA różne ciągi dla tej samej ścieżki: wołacz
 * (`MCPClient._canonicalizeToolContext`) kanonizuje RAZ i tę wartość podmienia w argumentach
 * narzędzia, a bramka (`PermissionSystem.checkPermission`) kanonizuje NIEZALEŻNIE - gdyby
 * przebiegi dawały różne wyniki, user widziałby w oknie zgody ścieżkę w folderze „ A"
 * (ze spacją - SĄSIAD folderu `A`), a bramka przepuszczałaby `'A/B.md'` na whiteliście `A/`.
 *
 * Dlatego pętla: wynik jest liczony aż się nie ustabilizuje, więc
 * `sanitizePath(sanitizePath(x)) === sanitizePath(x)` Z KONSTRUKCJI i każda warstwa może
 * kanonizować bez ryzyka, że odda inny ciąg niż poprzednia.
 *
 * ⚠️ Podwójnie zakodowane wejście dekoduje się DO KOŃCA albo odpada: `'%252e%252e/x'` → `null`,
 * a `'a%252e%252e/x'` → `'a../x'` - segment `a..` to legalna nazwa pliku, nie wyjście w górę.
 * Białe znaki z brzegów całego ciągu giną na dobre: `' A/B.md'` i `'./ A/B.md'` to `'A/B.md'`,
 * nie folder ze spacją z przodu (spacja WEWNĄTRZ segmentu, `'A/ B.md'`, zostaje - to legalna
 * nazwa).
 *
 * @param path - Raw path from tool args (`unknown` - patrz uwaga przy `isProtectedPath`)
 * @returns Normalized safe path (punkt stały), or null if invalid
 */
export function sanitizePath(path: unknown): string | null {
    if (!path || typeof path !== 'string') return null;

    let cur = path;
    for (let i = 0; i < MAX_SANITIZE_PASSES; i++) {
        const next = sanitizeOnce(cur);
        if (next === null) return null;
        if (next === cur) return cur;
        cur = next;
    }
    // Ciąg nie ustabilizował się w limicie przebiegów (np. zawinięty w wiele warstw `%25`).
    // Fail-closed: nie ma formy kanonicznej, więc nie ma zgody.
    return null;
}

/**
 * Mask an API key for safe display/logging.
 * @param key - Full API key (`unknown` — patrz uwaga przy `isProtectedPath`)
 * @returns Masked key like "sk-Tq...xR4m"
 */
export function maskKey(key: unknown): string {
    if (!key || typeof key !== 'string') return '';
    if (key.length <= 8) return '********';
    return key.slice(0, 4) + '...' + key.slice(-4);
}
