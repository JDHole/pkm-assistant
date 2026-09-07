/**
 * AUD-code-review-053: guzik 🗜️ „Sumaryzuj chat" (`chat_ui.ts`) i komenda `/compress`
 * (`SlashCommandsRegistry.ts`) miały osobno wklejoną tę samą gałąź decyzyjną kompresji ręcznej —
 * i gałąź „nic się nie zmieniło" zdążyła się rozjechać na dwa różne teksty i18n
 * (`chat.nothing_to_summarize` vs `chat.streaming.below_threshold`) dla TEGO SAMEGO stanu.
 *
 * Oba pliki importują `obsidian` (Notice), więc AVA nie może ich zaimportować wprost — strażnik
 * czyta ŹRÓDŁO (wzór `turnOwner.test.ts`) + testuje wyciągnięte ciało `runManualCompression`
 * jako prawdziwy JS (funkcja nie ma zależności od `this`/obsidian poza wstrzykniętym `Notice`/`t`).
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const uiSource = readSource('./chat_ui.ts');
const slashSource = readSource('./SlashCommandsRegistry.ts');

test('chat.streaming.below_threshold zniknął jako WOŁANIE t() (duplikat i18n skasowany, AUD-code-review-053)', t => {
    for (const src of [uiSource, slashSource]) {
        t.false(src.includes("t('chat.streaming.below_threshold')"), 'klucz nie ma prawa być już wołany przez t() — może zostać wyłącznie jako historyczna wzmianka w komentarzu');
    }
    const en = readSource('../../../core/i18n/en.ts');
    const pl = readSource('../../../core/i18n/pl.ts');
    t.false(en.includes("'chat.streaming.below_threshold'"), 'en.ts nadal ma skasowany klucz');
    t.false(pl.includes("'chat.streaming.below_threshold'"), 'pl.ts nadal ma skasowany klucz');
    t.true(en.includes("'chat.nothing_to_summarize'"), 'kanoniczny klucz musi zostać w en.ts');
    t.true(pl.includes("'chat.nothing_to_summarize'"), 'kanoniczny klucz musi zostać w pl.ts');
});

test('guzik 🗜️ i komenda /compress wołają WSPÓLNY runManualCompression, nie powielają gałęzi decyzyjnej', t => {
    t.regex(uiSource, /export async function runManualCompression\(view: ChatViewMixinContext\): Promise<boolean> \{/);
    t.regex(uiSource, /await runManualCompression\(this\)/, 'guzik w _renderSlimBar ma wołać wspólny helper');
    t.regex(slashSource, /import \{ runManualCompression \} from '\.\/chat_ui\.js';/);
    t.regex(slashSource, /await runManualCompression\(view\)/, "handler /compress ma wołać wspólny helper");

    // Gałąź decyzyjna (performTwoPhaseCompression + if/else summarize/trim/nothing) ma istnieć
    // TYLKO RAZ w całym module — w runManualCompression.
    const decisionPattern = /performTwoPhaseCompression\(false\)/g;
    const uiMatches = uiSource.match(decisionPattern) || [];
    const slashMatches = slashSource.match(decisionPattern) || [];
    t.is(uiMatches.length, 1, 'chat_ui.ts ma wołać performTwoPhaseCompression tylko przez runManualCompression');
    t.is(slashMatches.length, 0, 'SlashCommandsRegistry.ts nie powinien już wołać performTwoPhaseCompression bezpośrednio');
});

test('runManualCompression: zachowanie — za mało wiadomości / summarized / trimmed / nic (test bezpośredni ciała funkcji)', async t => {
    const start = uiSource.indexOf('export async function runManualCompression(');
    t.true(start > 0, 'nie znalazłem definicji runManualCompression');
    const braceStart = uiSource.indexOf('{', uiSource.indexOf(')', start));
    let depth = 1;
    let i = braceStart + 1;
    while (depth > 0 && i < uiSource.length) {
        if (uiSource[i] === '{') depth++;
        else if (uiSource[i] === '}') depth--;
        i++;
    }
    const body = uiSource.slice(braceStart + 1, i - 1);

    const notices: Array<{ key: string }> = [];
    const NoticeStub = function (this: unknown, msg: string) { notices.push({ key: msg }); } as unknown;
    const tStub = (key: string, params?: unknown) => params ? `${key}:${JSON.stringify(params)}` : key;
    const factory = new Function('Notice', 't', `return async function(view) {${body}};`);
    const bound = factory(NoticeStub, tStub) as
        (view: { rollingWindow: { messages: unknown[]; summarizationCount: number; performTwoPhaseCompression: (b: boolean) => Promise<{ summarized: boolean; trimmed: number }> }; updateTokenCounter: () => void; _updateTokenPanel: () => void }) => Promise<boolean>;

    // Case 1: za mało wiadomości.
    notices.length = 0;
    let called = { compressed: false };
    const viewFew = {
        rollingWindow: {
            messages: [1, 2],
            summarizationCount: 0,
            performTwoPhaseCompression: async () => { called.compressed = true; return { summarized: false, trimmed: 0 }; },
        },
        updateTokenCounter: () => {},
        _updateTokenPanel: () => {},
    };
    const ranFew = await bound(viewFew);
    t.false(ranFew, 'za mało wiadomości → funkcja nie startuje kompresji');
    t.false(called.compressed);
    t.deepEqual(notices.map(n => n.key), ['chat.too_few_messages']);

    // Case 2: summarized.
    notices.length = 0;
    const viewSummarized = {
        rollingWindow: {
            messages: [1, 2, 3, 4, 5],
            summarizationCount: 3,
            performTwoPhaseCompression: async () => ({ summarized: true, trimmed: 2 }),
        },
        updateTokenCounter: () => {},
        _updateTokenPanel: () => {},
    };
    const ranSummarized = await bound(viewSummarized);
    t.true(ranSummarized);
    t.is(notices.length, 1);
    t.true(notices[0].key.startsWith('chat.summarize_result:'));

    // Case 3: trimmed only.
    notices.length = 0;
    const viewTrimmed = {
        rollingWindow: {
            messages: [1, 2, 3, 4, 5],
            summarizationCount: 0,
            performTwoPhaseCompression: async () => ({ summarized: false, trimmed: 3 }),
        },
        updateTokenCounter: () => {},
        _updateTokenPanel: () => {},
    };
    await bound(viewTrimmed);
    t.is(notices.length, 1);
    t.true(notices[0].key.startsWith('chat.trim_result:'));

    // Case 4: nic się nie zmieniło — KANONICZNY klucz, ten sam niezależnie od wołacza.
    notices.length = 0;
    const viewNothing = {
        rollingWindow: {
            messages: [1, 2, 3, 4, 5],
            summarizationCount: 0,
            performTwoPhaseCompression: async () => ({ summarized: false, trimmed: 0 }),
        },
        updateTokenCounter: () => {},
        _updateTokenPanel: () => {},
    };
    await bound(viewNothing);
    t.deepEqual(notices.map(n => n.key), ['chat.nothing_to_summarize']);
});
