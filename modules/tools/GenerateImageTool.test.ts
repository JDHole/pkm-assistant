/**
 * GenerateImageTool.test.js — regresja E3.2 (wywałka ComfyUI/Zoja).
 *
 * ⚠️ Ten plik jest wyjątkiem wśród testów `modules/tools/`: `GenerateImageTool.js`
 * ciągnie przez barrel `modules/multimodal/` moduł `obsidian` (`requestUrl`), a pakiet
 * `obsidian` z npm to SAME TYPY — nie ma runtime'u, więc Node nie potrafi go zaimportować.
 * Dlatego PRZED importem podstawiamy tę samą atrapę, którą wpina preload AVA
 * (`test-support/obsidian.ts`), przez `module.registerHooks` — hook działa tylko w tym
 * procesie testowym (AVA daje plikowi własny worker), więc nie dotyka reszty suite'u.
 * Sam kod narzędzia jest wykonywany PRAWDZIWY, nic nie jest podmieniane.
 */
import test from 'ava';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';


/** Wynik `generate_image` czytany w asercjach. */
type ImageRes = { success?: boolean; error: string };

const OBSIDIAN_MOCK = pathToFileURL(
    path.join(import.meta.dirname, '..', '..', 'test-support', 'obsidian.ts')
).href;

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

test('E3.2: platforma "comfyui" jest odrzucona z listą dostępnych platform', async t => {
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

test('E3.2: IMAGE_GEN_PLATFORMS nie zawiera już comfyui', t => {
    t.false(IMAGE_GEN_PLATFORMS.some(p => p.id === 'comfyui'));
    t.deepEqual(
        IMAGE_GEN_PLATFORMS.map(p => p.id),
        ['openrouter', 'openai', 'stability', 'replicate', 'gemini', 'xai']
    );
});

test('E3.2: ścieżka chmurowa nie została ruszona — walidacja przepuszcza znaną platformę', async t => {
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
    // Od 2026-09-06 etykieta w „brak klucza" to nazwa platformy, nie nazwa pola (`openai_api_key`
    // nie istnieje — klucz żyje w `chat.apiKeys.openai`).
    t.regex(res.error, /OpenAI/, 'poleciało dalej, do adaptera OpenAI');
});

test('E3.2: schemat generate_image nie ma już parametru workflow (ComfyUI)', t => {
    const tool = createGenerateImageTool();
    t.false('workflow' in tool.inputSchema.properties);
    t.notRegex(tool.description, /comfy/i);
});

test('E3.2: schemat generate_image nie ma martwego parametru seed (żaden adapter go nie czytał)', t => {
    const tool = createGenerateImageTool();
    t.false('seed' in tool.inputSchema.properties);
});

// ── K2 (AUD-security-048): bramka dostaje FOLDER ZAPISU, nie prompt ──────────

test('K2: contextExtractor oddaje folder zapisu, prompt idzie osobnym polem', t => {
    const tool = createGenerateImageTool();

    const domyslny = tool.contextExtractor({ prompt: 'Projekty/ a serene cat' }, { plugin: pluginWith({ platform: 'openai' }) });
    t.is(domyslny.targetPath, 'Attachments/generated', 'cel = folder z ustawień, nie tekst modelu');
    t.is(domyslny.approvalContext.imagePrompt, 'Projekty/ a serene cat', 'prompt widoczny w oknie zgody');

    const wlasny = tool.contextExtractor({ prompt: 'x' }, { plugin: pluginWith({ platform: 'openai', saveFolder: 'Grafiki/AI/' }) });
    t.is(wlasny.targetPath, 'Grafiki/AI', 'końcowy ukośnik ucięty tak samo jak w execute');
});

test('K2: niedozwolony saveFolder odbija się PRZED wywołaniem platformy', async t => {
    const tool = createGenerateImageTool();

    for (const folder of ['../poza', '.pkm-assistant/agents/inny/memory', '.pkm-assistant/logs']) {
        const res = await tool.execute(
            { prompt: 'a cat' },
            {} as never,
            pluginWith({ platform: 'openai', saveFolder: folder }),
        ) as ImageRes;
        t.false(res.success, `saveFolder "${folder}" przeszedł`);
        t.regex(res.error, /folder zapisu/i, `saveFolder "${folder}" odbił się o inną warstwę`);
    }
});
