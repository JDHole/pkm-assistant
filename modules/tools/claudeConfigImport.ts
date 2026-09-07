/**
 * claudeConfigImport — S32 Z2.3: przeniesienie serwerów MCP z Claude Desktop do pluginu.
 *
 * Kto ma już poustawiane serwery w Claude Desktop, ten nie musi przeklikiwać ich drugi raz.
 * Format źródłowy (`claude_desktop_config.json`):
 *
 *   { "mcpServers": { "filesystem": { "command": "npx", "args": [...], "env": {...} },
 *                     "remote":     { "url": "https://..." } } }
 *
 * Ten plik jest CZYSTY (zero obsidiana, zero fs, zero i18n) — wczytanie pliku z dysku i modal
 * potwierdzenia żyją u wołających (`modules/tools/SettingsContent.js` + `modules/shell/ClaudeImportModal.js`),
 * a tu zostaje sam parser + logika selekcji, żeby dały się testować w Node.
 *
 * Odporność na śmieci jest celowa: to plik z dysku, który mógł napisać ktokolwiek — nigdy nie rzucamy,
 * niezrozumiały wpis po prostu pomijamy.
 */

// AUD-code-review-050: `validateServerId` to WARTOŚĆ (static method), nie sam typ — ten import
// NIE znika przy transpilacji. `ExternalMcpManager.ts` jest bezpieczny do ciągnięcia (zero
// obsidiana/SDK na poziomie modułu — SDK i `child_process` importowane leniwo DOPIERO wewnątrz
// metod instancji `connect`/`_createClient`), więc plik zostaje testowalny w gołym Node.
import { ExternalMcpManager } from './ExternalMcpManager.js';
import type { ExternalMcpServerConfig } from './ExternalMcpManager.js';

/** Maksymalna długość id serwera (kontrakt `ExternalMcpManager.validateServerId`). */
const MAX_ID_LEN = 32;

/** Pojedynczy wpis `mcpServers` z pliku Claude Desktop — pola są `unknown`, bo to plik z dysku. */
interface ClaudeServerEntry {
    command?: unknown;
    args?: unknown;
    env?: unknown;
    url?: unknown;
    headers?: unknown;
}

/** Wiersz do modala potwierdzenia importu. */
export interface ClaudeImportRow {
    config: ExternalMcpServerConfig;
    /**
     * AUD-code-review-050: dziś znaczy „nie wolno zaznaczyć/zapisać" — nie tylko „już mamy
     * ten id w ustawieniach" (dawne, jedyne znaczenie). Modal (`modules/shell/ClaudeImportModal`)
     * jest celowo GŁUPI i czyta wyłącznie to pole (odznacza + blokuje checkbox), więc każdy
     * powód blokady musi przez nie przejść, inaczej modal by go nie znał. Powód szczegółowy —
     * `blockedReason` niżej.
     */
    exists: boolean;
    selected: boolean;
    /**
     * Powód blokady, gdy NIE jest to zwykłe „już mamy ten id" (wtedy pole nieobecne — patrz
     * `exists`). `'duplicate'` = dwie różne nazwy z Claude Desktop dają ten sam slug WEWNĄTRZ
     * TEJ SAMEJ paczki importu; `'reserved'`/`'format'` = ten sam werdykt, co
     * `ExternalMcpManager.validateServerId` zwraca ręcznemu dodawaniu serwera
     * (`MCPServerEditorModal._handleSave`).
     */
    blockedReason?: 'duplicate' | 'reserved' | 'format';
}

/**
 * Nazwa z configu Claude → nasze `id` (slug `[a-z0-9-]`, max 32 znaki).
 * @returns slug (może być krótszy niż 2 znaki — wtedy wpis odpada)
 */
export function slugifyServerId(name: string): string {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+/, '')
        .slice(0, MAX_ID_LEN)
        .replace(/-+$/, '');
}

/** @private Tylko zwykły obiekt string→string (env / headers); inaczej pusty. */
function plainStringMap(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            out[String(k)] = String(v);
        }
    }
    return out;
}

/** @private Tablica argumentów → same stringi (liczby dopuszczone, resztę odrzucamy). */
function stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return (value as unknown[])
        .filter(v => typeof v === 'string' || typeof v === 'number')
        .map(v => String(v));
}

/**
 * Parsuj tekst `claude_desktop_config.json` na tablicę configów w NASZYM kształcie.
 * NIE rzuca: zły JSON / brak `mcpServers` / wpis bez `command` i bez `url` → pomijane.
 *
 * @returns configi `{id, name, transport, enabled, autostart, ...}`
 */
export function parseClaudeDesktopConfig(jsonText: string | null | undefined): ExternalMcpServerConfig[] {
    let parsed: unknown = null;
    try {
        parsed = JSON.parse(String(jsonText ?? ''));
    } catch {
        return [];
    }
    const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];

    const out: ExternalMcpServerConfig[] = [];
    for (const [name, raw] of Object.entries(servers as Record<string, ClaudeServerEntry | null>)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const id = slugifyServerId(name);
        if (id.length < 2) continue; // nie przejdzie validateServerId — nie ma sensu proponować

        const base = { id, name: String(name), enabled: true, autostart: false };

        if (typeof raw.url === 'string' && raw.url.trim()) {
            // Claude opisuje zdalne serwery kluczem `url` — u nas to transport 'http'.
            out.push({ ...base, transport: 'http', url: raw.url.trim(), headers: plainStringMap(raw.headers) });
            continue;
        }
        if (typeof raw.command === 'string' && raw.command.trim()) {
            out.push({
                ...base,
                transport: 'stdio',
                command: raw.command.trim(),
                args: stringArray(raw.args),
                env: plainStringMap(raw.env),
            });
        }
        // ani url, ani command → nie wiemy jak to uruchomić, pomijamy
    }
    return out;
}

/**
 * Wiersze do modala potwierdzenia: co zaznaczyć, a co zablokować.
 *
 * AUD-code-review-050: import przechodzi przez TĘ SAMĄ walidację unikalności/rezerwacji id,
 * którą wymusza ręczne dodawanie serwera (`MCPServerEditorModal._handleSave`) — dwie kontrole,
 * nie jedna:
 *   1. kolizja z id już zapisanym w ustawieniach (dawne, jedyne zachowanie — `exists:true`),
 *   2. `ExternalMcpManager.validateServerId` (R3): format sluga ORAZ brak kolizji z nazwą
 *      serwera WBUDOWANEGO (`vault`/`memory`/`core`/...) — bez tego import serwera nazwanego
 *      dosłownie `"memory"` zapisywał do `data.json` id, które `connect()` i tak by odrzucił,
 *      ale checkbox w modalu tego nie wiedział i user dostawał zaznaczalny wiersz, który
 *      po dodaniu wisiał wiecznie na statusie „error" bez wytłumaczenia.
 * Dodatkowo: dwie RÓŻNE nazwy z Claude Desktop, które `slugifyServerId` sprowadza do TEGO
 * SAMEGO id (np. `"Filesystem"` i `"filesystem"`), są kolizją WEWNĄTRZ TEJ SAMEJ paczki —
 * bez tej kontroli oba wiersze wychodziły `exists:false, selected:true` i oba configi z tym
 * samym id lądowały w `externalMcpServers[]` (drugi po cichu przesłaniał status/kasowanie
 * pierwszego — `_connections`/`_status` w `ExternalMcpManager` są `Map` keyed po id).
 *
 * Serwer o id, które już jest w ustawieniach, dostaje `exists:true` → modal go pokazuje,
 * ale odznaczonego i zablokowanego (nie nadpisujemy cudzej konfiguracji po cichu). Modal
 * (`modules/shell/ClaudeImportModal`) jest celowo GŁUPI i czyta wyłącznie pole `exists` —
 * dlatego KAŻDY powód blokady musi się przez nie przełożyć, `blockedReason` niesie tylko
 * szczegół dla wołacza (np. Notice po imporcie).
 *
 * @param parsed - wynik `parseClaudeDesktopConfig`
 * @param existing - `settings.pkmAssistant.externalMcpServers`
 * @param builtinNames - nazwy serwerów wbudowanych (defense in depth z `connect()`/edytorem)
 */
export function buildImportRows(
    parsed: ExternalMcpServerConfig[] | null | undefined,
    existing: Array<ExternalMcpServerConfig | null> | null | undefined = [],
    builtinNames: Set<string> | string[] = [],
): ClaudeImportRow[] {
    const taken = new Set(
        (Array.isArray(existing) ? existing : [])
            .map(s => s?.id)
            .filter((id): id is string => typeof id === 'string')
    );
    const seenInBatch = new Set<string>();
    return (Array.isArray(parsed) ? parsed : []).map(config => {
        const alreadyExists = taken.has(config.id);
        const duplicateInBatch = !alreadyExists && seenInBatch.has(config.id);
        seenInBatch.add(config.id);

        if (alreadyExists) return { config, exists: true, selected: false };
        if (duplicateInBatch) return { config, exists: true, selected: false, blockedReason: 'duplicate' as const };

        const idCheck = ExternalMcpManager.validateServerId(config.id, builtinNames);
        if (!idCheck.ok) {
            return { config, exists: true, selected: false, blockedReason: idCheck.reason || 'format' };
        }
        return { config, exists: false, selected: true };
    });
}
