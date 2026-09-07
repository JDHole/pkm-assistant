/**
 * N43 (luka L-21, decyzja R13): `get_chat_model` NIE MA własnej drabinki — deleguje do
 * `createModelForRole`.
 *
 * Do clean-room ten mixin trzymał DRUGĄ KOPIĘ pięciostopniowej drabinki: własne defaulty modeli
 * (`ollama: 'llama3.2'`), brak `lm_studio` i `xai`, ręczna budowa instancji z mapy DI. Kopia
 * rozjeżdżała się z `modelResolver` przy każdej zmianie tam i była martwa bez starego DI.
 *
 * Strażnik chodzi PO ŹRÓDLE, bo `chat_model.ts` importuje `obsidian` — AVA go nie zaimportuje
 * (ten sam wzór co `chatModelSkipCache.test.ts` i `oczkoAccessGate.test.ts`).
 */
import test from 'ava';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'chat_model.ts');

test('L-21: get_chat_model deleguje do createModelForRole i nie ma własnej drabinki', async t => {
    const src = await readFile(SRC, 'utf8');

    t.true(
        src.includes("createModelForRole(this.plugin, 'main', activeAgent, null, skipCache)"),
        'jedyna droga do modelu to fabryka per rola, z pełną piątką argumentów',
    );

    // Druga kopia drabinki zostawiała po sobie DOKŁADNIE te ślady:
    t.false(/['"`]llama3\.2['"`]/.test(src), 'własny default modelu Ollamy = druga drabinka wróciła');
    t.false(src.includes('get_default_model'), 'lokalna tablica defaultów modeli nie może wrócić');
    t.false(
        /settings\[`\$\{p\}_api_key`\]|settings\.\w+_api_key/.test(src),
        'własne wykrywanie platformy czatu po kluczach należy do resolvera (klucze STT/obrazów to inny slice)',
    );
    t.false(src.includes('config?.modules'), 'ręczna budowa instancji z mapy DI zniknęła razem z mapą');

    // Slot runtime'u zostaje — na nim stoją Stop (chat_streaming) i fallback delegacji.
    t.true(src.includes('this.env.chatModel = model'), 'wynik nadal ląduje we wspólnym slocie runtime');
});

/**
 * Bug 2026-09-06: mikrofon (STT) czytał klucze z płaskich pól `chat.groq_api_key` /
 * `openai_api_key` / `gemini_api_key` — kształtu sprzed migracji ustawień. Migrator przenosi
 * je do puli `chat.apiKeys.<platforma>`, więc płaskie pole było zawsze puste i Groq Whisper
 * meldował „brak klucza API" mimo wpisanego klucza. STT ma czytać z TEJ SAMEJ puli co
 * modelResolver i GenerateImageTool.
 */
test('STT: klucze czatu z puli chat.apiKeys, nie z płaskich pól sprzed migracji', async t => {
    const src = await readFile(SRC, 'utf8');

    t.true(src.includes('pkmAssistant?.chat?.apiKeys'), 'klucze STT biorą się z puli chat.apiKeys');
    for (const platform of ['openai', 'groq', 'gemini']) {
        t.true(src.includes(`${platform}: chatKeys.${platform}`), `${platform}: klucz z puli apiKeys`);
        t.false(new RegExp('[.]' + platform + '_api_key').test(src), `.${platform}_api_key = odczyt martwego kształtu sprzed migracji`);
    }
    // Klucze STT-only (Deepgram, AssemblyAI) mają własny slice `pkmAssistant.stt` — bez zmian.
    t.true(src.includes('sttSettings.deepgram_api_key'));
    t.true(src.includes('sttSettings.assemblyai_api_key'));
});
