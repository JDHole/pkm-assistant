/**
 * GenerateImageTool.test.js — regresja usunięcia ComfyUI/Zoja z listy platform.
 *
 * ⚠️ Ten plik jest wyjątkiem wśród testów `modules/tools/`: `GenerateImageTool.js`
 * ciągnie przez barrel `modules/multimodal/` moduł `obsidian` (`requestUrl`), a pakiet
 * `obsidian` z npm to SAME TYPY — nie ma runtime'u, więc Node nie potrafi go zaimportować.
 * Dlatego PRZED importem podstawiamy tę samą atrapę, którą wpina preload AVA (od 2026-09-11
 * `obsidian.ts` mieszka w repo harnessu — ścieżkę do niej ustawia lokator
 * `test-support/register-obsidian-for-ava.mjs` w zmiennej `PKM_TEST_SUPPORT_DIR`, PRZED
 * jakimkolwiek testem), przez `module.registerHooks` — hook działa tylko w tym procesie
 * testowym (AVA daje plikowi własny worker), więc nie dotyka reszty suite'u. Sam kod
 * narzędzia jest wykonywany PRAWDZIWY, nic nie jest podmieniane.
 */
import test from 'ava';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { setLocale } from '../../core/i18n/index.js';


/** Wynik `generate_image` czytany w asercjach. */
type ImageRes = { success?: boolean; error: string };

// Preload AVA (`test-support/register-obsidian-for-ava.mjs`, patrz `ava.nodeArguments` w
// `package.json`) ustawia tę zmienną na fizyczną ścieżkę `test-support/` w repo harnessu,
// zanim jakikolwiek plik testowy zacznie działać.
const TEST_SUPPORT_DIR = process.env.PKM_TEST_SUPPORT_DIR;
if (!TEST_SUPPORT_DIR) {
    throw new Error(
        '[GenerateImageTool.test] Brak PKM_TEST_SUPPORT_DIR — ten test oczekuje preloadu '
        + 'test-support/register-obsidian-for-ava.mjs (ava.nodeArguments w package.json).',
    );
}

const OBSIDIAN_MOCK = pathToFileURL(path.join(TEST_SUPPORT_DIR, 'obsidian.ts')).href;

registerHooks({
    resolve(specifier, context, next) {
        if (specifier === 'obsidian') return { url: OBSIDIAN_MOCK, shortCircuit: true };
        return next(specifier, context);
    },
});

const { createGenerateImageTool } = await import('./GenerateImageTool.js');
const { IMAGE_GEN_PLATFORMS } = await import('../multimodal/index.js');

/** Minimalny plugin z ustawieniami image gen (jak w runtime: plugin.env.settings.pkmAssistant.imageGen). */
function pluginWith(imageGen: Record<string, unknown>) {
    return { env: { settings: { pkmAssistant: { imageGen } } } };
}

test('platforma "comfyui" jest odrzucona z listą dostępnych platform', async t => {
    const tool = createGenerateImageTool();
    const res = await tool.execute(
        { prompt: 'a cat' },
        {} as never,
        pluginWith({ platform: 'comfyui' })
    ) as ImageRes;

    t.false(res.success);
    t.regex(res.error, /comfyui/, 'komunikat mówi którą platformę odrzucił');
    for (const p of IMAGE_GEN_PLATFORMS) {
        t.regex(res.error, new RegExp(p.id), `lista dostępnych zawiera ${p.id}`);
    }
});

test('IMAGE_GEN_PLATFORMS nie zawiera już comfyui', t => {
    t.false(IMAGE_GEN_PLATFORMS.some(p => p.id === 'comfyui'));
    t.deepEqual(
        IMAGE_GEN_PLATFORMS.map(p => p.id),
        ['openrouter', 'openai', 'stability', 'replicate', 'gemini', 'xai']
    );
});

test('ścieżka chmurowa nie została ruszona — walidacja przepuszcza znaną platformę', async t => {
    const tool = createGenerateImageTool();
    // Bez klucza API: request nigdy nie leci, adapter rzuca "brak klucza".
    // Ważne jest CO odrzuciło — walidacja platformy czy już adapter.
    const res = await tool.execute(
        { prompt: 'a cat' },
        {} as never,
        pluginWith({ platform: 'openai' })
    ) as ImageRes;

    t.false(res.success);
    t.notRegex(res.error, /Available|Dostępne/, 'to nie jest odbicie na walidacji platformy');
    // Etykieta w „brak klucza" to nazwa platformy, nie nazwa pola (`openai_api_key`
    // nie istnieje — klucz żyje w `chat.apiKeys.openai`).
    t.regex(res.error, /OpenAI/, 'poleciało dalej, do adaptera OpenAI');
});

test('schemat generate_image nie ma już parametru workflow (ComfyUI)', t => {
    const tool = createGenerateImageTool();
    t.false('workflow' in tool.inputSchema.properties);
    t.notRegex(tool.description, /comfy/i);
});

test('schemat generate_image nie ma martwego parametru seed (żaden adapter go nie czytał)', t => {
    const tool = createGenerateImageTool();
    t.false('seed' in tool.inputSchema.properties);
});

// ── bramka dostaje FOLDER ZAPISU, nie prompt ──────────

test('contextExtractor oddaje folder zapisu, prompt idzie osobnym polem', t => {
    const tool = createGenerateImageTool();

    const domyslny = tool.contextExtractor({ prompt: 'Projekty/ a serene cat' }, { plugin: pluginWith({ platform: 'openai' }) });
    t.is(domyslny.targetPath, 'Attachments/generated', 'cel = folder z ustawień, nie tekst modelu');
    t.is(domyslny.approvalContext.imagePrompt, 'Projekty/ a serene cat', 'prompt widoczny w oknie zgody');

    const wlasny = tool.contextExtractor({ prompt: 'x' }, { plugin: pluginWith({ platform: 'openai', saveFolder: 'Grafiki/AI/' }) });
    t.is(wlasny.targetPath, 'Grafiki/AI', 'końcowy ukośnik ucięty tak samo jak w execute');
});

// ── BUG (fix/mcp-descriptions-i18n): opis i parametry były na sztywno po polsku, więc
// user z angielskim UI widział polski tekst narzędzia wysyłanego do modelu. ──

test.serial('opis generate_image i parametru "prompt" mówią po angielsku pod setLocale("en")', t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    const tool = createGenerateImageTool();
    t.true(tool.description.startsWith('Generate an image from a text description.'));
    t.false(/[ąćęłńóśźż]/i.test(tool.description), 'opis pod EN nie może nieść polskich znaków diakrytycznych');
    t.false(/\bWygeneruj\b|\bobrazow\b|\bszczegolowy\b/.test(tool.description), 'opis pod EN nie może nieść starych polskich słów bez ogonków');
    t.is(
        (tool.inputSchema.properties as Record<string, { description: string }>).prompt.description,
        'Description of the image to generate. Preferably in English, detailed.'
    );
});

test.serial('opis generate_image mówi po polsku pod setLocale("pl")', t => {
    t.teardown(() => setLocale('en'));
    setLocale('pl');
    const tool = createGenerateImageTool();
    t.true(tool.description.startsWith('Wygeneruj obraz na podstawie opisu tekstowego.'));
    t.is(
        (tool.inputSchema.properties as Record<string, { description: string }>).prompt.description,
        'Opis obrazu do wygenerowania. Najlepiej po angielsku, szczegółowy.'
    );
});

test.serial('niedozwolony saveFolder odbija się PRZED wywołaniem platformy - en', async t => {
    t.teardown(() => setLocale('en'));
    setLocale('en');
    const tool = createGenerateImageTool();

    for (const folder of ['../poza', '.pkm-assistant/agents/inny/memory', '.pkm-assistant/logs']) {
        const res = await tool.execute(
            { prompt: 'a cat' },
            {} as never,
            pluginWith({ platform: 'openai', saveFolder: folder }),
        ) as ImageRes;
        t.false(res.success, `saveFolder "${folder}" przeszedł`);
        t.regex(res.error, /Save folder ".*" is not allowed/, `saveFolder "${folder}" pod EN musi dostać angielski komunikat, nie polski wpisany na sztywno`);
    }
});

test.serial('niedozwolony saveFolder odbija się PRZED wywołaniem platformy - pl', async t => {
    t.teardown(() => setLocale('en'));
    setLocale('pl');
    const tool = createGenerateImageTool();

    for (const folder of ['../poza', '.pkm-assistant/agents/inny/memory', '.pkm-assistant/logs']) {
        const res = await tool.execute(
            { prompt: 'a cat' },
            {} as never,
            pluginWith({ platform: 'openai', saveFolder: folder }),
        ) as ImageRes;
        t.false(res.success, `saveFolder "${folder}" przeszedł`);
        t.regex(res.error, /Niedozwolony folder zapisu ".*"/, `saveFolder "${folder}" odbił się o inną warstwę`);
    }
});
