/**
 * Strażnik i18n dla opisów serwerów wbudowanych i narzędzi multimodalnych.
 *
 * BUG (fix/mcp-descriptions-i18n): część opisów w `modules/tools/` była na sztywno w jednym
 * języku i nigdy nie przechodziła przez `t()` — user z angielskim UI widział polskie opisy
 * (`artifacts`, `delegation`, `komunikator`, `multimodal`, `AddTextToImageTool`), a user z
 * polskim UI widział angielskie (`core`, `vault`, `memory`). Testy niżej czytają opis TĄ SAMĄ
 * drogą, którą bierze go UI (Ustawienia → Serwery MCP = `ServerLoader.getServerCatalog()`),
 * nie polem manifestu wprost — manifest sam w sobie nie ma już `description`, tylko `name`,
 * który `resolveServerDescription` zamienia na tekst w aktualnym locale PRZY WYWOŁANIU.
 */
import test from 'ava';
import { setLocale, t as tr } from '../../core/i18n/index.js';
import { ServerLoader } from './ServerLoader.js';
import { MCP_SERVER_PRESETS, getMcpServerPreset, PRESET_PATH_PLACEHOLDER } from './mcpServerPresets.js';
import { createAddTextToImageTool } from './AddTextToImageTool.js';

const emptyVault = () => ({ adapter: { exists: async () => false, list: async () => ({ folders: [] }) } });

/** Polskie znaki diakrytyczne — obecność w tekście oznaczonym jako EN jest bugiem. */
const POLISH_CHARS = /[ąćęłńóśźż]/i;

async function catalogDescription(name: string): Promise<string | undefined> {
    const loader = new ServerLoader(emptyVault(), { pluginVersion: '2.0.0' });
    await loader.loadAllServers();
    return loader.getServerCatalog().find(s => s.name === name)?.description;
}

test.serial('katalog serwerów: "komunikator" (dziś PL na sztywno) mówi po angielsku pod setLocale("en")', async t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    const desc = await catalogDescription('komunikator');
    t.is(desc, 'Komunikator: simple mail between agents (send / list / read).');
});

test.serial('katalog serwerów: "komunikator" mówi po polsku pod setLocale("pl")', async t => {
    t.teardown(() => setLocale('en'));
    setLocale('pl');
    const desc = await catalogDescription('komunikator');
    t.is(desc, 'Komunikator: prosta poczta między agentami (wyślij / lista / przeczytaj).');
});

test.serial('katalog serwerów: "vault" (dziś EN na sztywno) mówi po polsku pod setLocale("pl")', async t => {
    t.teardown(() => setLocale('en'));
    setLocale('pl');
    const desc = await catalogDescription('vault');
    t.is(desc, 'Operacje na plikach vaulta + zunifikowane wyszukiwanie (hybryda keyword/semantic przez RRF, filtry where).');
});

test.serial('katalog serwerów: "vault" zostaje po angielsku pod setLocale("en")', async t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    const desc = await catalogDescription('vault');
    t.is(desc, 'Vault file operations + unified search (keyword/semantic hybrid via RRF, where filters).');
});

test.serial('createAddTextToImageTool: opis narzędzia i parametru "text" mówią po angielsku pod setLocale("en")', t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    const tool = createAddTextToImageTool();
    t.true(tool.description.startsWith('Overlay text (a caption) onto an existing image in the vault.'));
    t.false(POLISH_CHARS.test(tool.description), 'opis pod EN nie może nieść polskich znaków diakrytycznych');
    t.is((tool.inputSchema.properties as Record<string, { description: string }>).text.description, 'Text to overlay on the image');
});

test.serial('createAddTextToImageTool: opis narzędzia zostaje po polsku pod setLocale("pl") (treść niezmieniona)', t => {
    t.teardown(() => setLocale('en'));
    setLocale('pl');
    const tool = createAddTextToImageTool();
    t.true(tool.description.startsWith('Nałóż tekst (napis) na istniejący obraz w vaultcie.'));
    t.is((tool.inputSchema.properties as Record<string, { description: string }>).text.description, 'Tekst do nałożenia na obraz');
});

test('preset Filesystem niesie neutralny placeholder ścieżki <PATH> (nie polskie słowo)', t => {
    const fsPreset = getMcpServerPreset('filesystem');
    t.truthy(fsPreset);
    t.is(PRESET_PATH_PLACEHOLDER, '<PATH>');
    t.true(fsPreset!.args.includes('<PATH>'));
    // Kontrola redundantna z importem MCP_SERVER_PRESETS - lista NIE jest pusta (żywy import).
    t.true(MCP_SERVER_PRESETS.length > 0);
});

test.serial('hint filesystem po angielsku wskazuje na <PATH>, nie na <ŚCIEŻKA>', t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    const hintText = tr('settings.mcp_preset_hint_filesystem');
    t.regex(hintText, /<PATH>/);
    t.notRegex(hintText, /<ŚCIEŻKA>/);
});
