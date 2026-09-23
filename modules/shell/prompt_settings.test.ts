/**
 * Strażnik pilnuje, żeby `brief_prompt` nie wrócił do listy `WORK_PROMPTS`: jego wartość nie ma
 * ani jednego czytelnika w produkcji, więc renderowanie dla niego pełnoprawnej kontrolki
 * (Wstaw fabryczny / Przywróć domyślny / textarea + badge „nadpisane") obiecywałoby pracę, która
 * nigdy się nie dzieje. Stara wartość `settings.pkmAssistant.promptDefaults.brief_prompt` u usera
 * jest IGNOROWANA bez błędu - `renderPromptSection` iteruje wyłącznie po `WORK_PROMPTS` (lista
 * stała), nie po kluczach obiektu `promptDefaults`.
 *
 * KOREKTA (recenzja niezależna, dogrywka rundy 2, punkt 4c): `prompt_settings.ts` importuje
 * `modules/crystal-soul/index.js` (transytywnie `obsidian`) i `new Setting(container)` z
 * `obsidian` wprost, ale plik MIMO TO WSTAJE w AVA pod harnessem - atrapa `Setting`
 * (`pkm-assistant-harness/test-support/obsidian.ts`) NIGDY nie dotyka `containerEl`, jaki
 * dostała: zapisuje go w polu i buduje SWOJE WŁASNE elementy (`settingEl`/`nameEl`/...) przez
 * własny `createMockEl`, więc `renderPromptSection` realnie się wykonuje niezależnie od tego, co
 * podamy jako `container`. Poprzednia wersja tego pliku twierdziła, że import pada - nieprawda,
 * zweryfikowane bezpośrednio: `renderPromptSection` rysuje realne guziki na fake-DOM-ie poniżej.
 * (`modules/agents/AgentManager.test.ts` NADAL zostaje regexem - tam import pada naprawdę, na
 * `import ... with { type: 'css' }`, loader AVA/tsx nie zna atrybutów importu CSS - inny rodzaj
 * przeszkody, nieusuwalny atrapą `obsidian`.)
 *
 * Guzik "Wstaw fabryczny" (`renderEditor`) jest testowany BEHAWIORALNIE niżej: własny,
 * rekurencyjny DOM-shim (wzór `modules/shell/sidebar/SidebarNav.test.ts`, `makeFakeEl`) zamiast
 * atrapy `obsidian` harnessu - jej `addEventListener()` jest NO-OPEM (nic nie zapamiętuje, patrz
 * `dom-shim.ts`), więc nie dałoby się nim odpalić zarejestrowanego handlera. `new Setting(...)`
 * w środku `renderPromptSection` i tak bierze PRAWDZIWĄ (harnessową) klasę - nietknięta przez
 * nasz shim, jak opisano wyżej.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { renderPromptSection } from './prompt_settings.js';
import { t as i18n, setLocale } from '../../core/i18n/index.js';

setLocale('en');

const readSource = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const source = readSource('./prompt_settings.ts');

/** Wyciąga kluczy `key: 'xxx'` z wnętrza tablicy WORK_PROMPTS. */
function extractWorkPromptKeys(src: string): string[] {
    const arrayMatch = /const WORK_PROMPTS = \[([\s\S]*?)\];/.exec(src);
    if (!arrayMatch) throw new Error('WORK_PROMPTS array not found in prompt_settings.ts');
    const body = arrayMatch[1];
    const keyRe = /key:\s*'([^']+)'/g;
    const keys: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = keyRe.exec(body))) keys.push(m[1]);
    return keys;
}

const workPromptKeys = extractWorkPromptKeys(source);

test('WORK_PROMPTS nie zawiera brief_prompt', t => {
    t.false(workPromptKeys.includes('brief_prompt'));
});

test('WORK_PROMPTS ma pięć żywych slotów (compression/save_session/archive/summary/subagent_frame)', t => {
    t.deepEqual(workPromptKeys, [
        'compression_prompt',
        'save_session_prompt',
        'archive_prompt',
        'summary_prompt',
        'subagent_frame_prompt',
    ]);
});

test('prompt_settings.ts nie importuje już DEFAULT_BRIEF_PROMPT z modules/memory', t => {
    t.false(/DEFAULT_BRIEF_PROMPT/.test(source));
});

// ── Test zachowania: guzik "Wstaw fabryczny" (renderEditor), zamiast regexu po źródle ─────
//
// `new Setting(container)` w `renderPromptSection` NIE dotyka naszego fake-containera (patrz
// nagłówek pliku) - jedyne wywołania na TYM drzewie to `container.classList.add`/`createEl`/
// `createDiv`/`createSpan`, więc minimalny, rekurencyjny shim poniżej wystarcza.
type Listener = () => void;

interface FakeEl {
    tag?: string;
    cls?: string;
    text?: string;
    value: string;
    placeholder: string;
    style: { display: string };
    classList: { add(...names: string[]): void };
    children: FakeEl[];
    listeners: Record<string, Listener[]>;
    addClass(...names: string[]): FakeEl;
    createDiv(opts?: { cls?: string } | string): FakeEl;
    createEl(tag: string, opts?: { cls?: string; text?: string }): FakeEl;
    createSpan(opts?: { cls?: string; text?: string }): FakeEl;
    addEventListener(ev: string, cb: Listener): void;
    empty(): void;
}

function makeFakeEl(): FakeEl {
    const el: FakeEl = {
        value: '',
        placeholder: '',
        style: { display: '' },
        classList: { add() { /* nie musimy pamiętać klas do tego testu */ } },
        children: [],
        listeners: {},
        addClass() { return el; },
        createDiv(opts) {
            const d = makeFakeEl();
            d.cls = typeof opts === 'string' ? opts : opts?.cls;
            el.children.push(d);
            return d;
        },
        createEl(tag, opts) {
            const e = makeFakeEl();
            e.tag = tag;
            e.cls = opts?.cls;
            e.text = opts?.text;
            el.children.push(e);
            return e;
        },
        createSpan(opts) {
            const e = makeFakeEl();
            e.tag = 'span';
            e.cls = opts?.cls;
            e.text = opts?.text;
            el.children.push(e);
            return e;
        },
        addEventListener(ev, cb) {
            (el.listeners[ev] ||= []).push(cb);
        },
        empty() { el.children = []; },
    };
    return el;
}

/** Zbiera węzły w kolejności utworzenia (DFS pre-order) - ta sama kolejność, w jakiej
 *  `renderPromptSection` woła `createEl`/`createDiv`. */
function collectByTag(root: FakeEl, tag: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (node: FakeEl) => {
        if (node.tag === tag) out.push(node);
        for (const child of node.children) walk(child);
    };
    walk(root);
    return out;
}

test('renderPromptSection: guzik "Wstaw fabryczny" rysuje się realnie (co najmniej jeden na każdy z 8 slotów WORK_PROMPTS+SECTION_PROMPTS)', t => {
    const container = makeFakeEl();
    const pkm: { promptDefaults?: Record<string, string> } = {};
    renderPromptSection(container as unknown as HTMLElement, { pkm, save: async () => { /* noop */ } });

    const insertButtons = collectByTag(container, 'button').filter(b => b.text === i18n('settings.prompt_insert_factory'));
    t.is(insertButtons.length, 8, 'WORK_PROMPTS (5) + SECTION_PROMPTS (3) = 8 edytorów, każdy z jednym guzikiem „Wstaw fabryczny"');
});

// Guzik "Wstaw fabryczny" dla save_session_prompt pisze do GLOBALNEGO nadpisania (dzielonego
// przez wszystkich agentów) - MUSI wstawiać tekst SUROWY (`factoryWorkPromptRaw`, placeholdery
// {{sec_*}}/{{na_teraz_*}} nietknięte), nie wcześnie podstawiony `factoryWorkPrompt` nagłówkami
// języka UI z CHWILI KLIKNIĘCIA. Podstawienie nagłówkami WŁAŚCIWEGO agenta należy do miejsca
// użycia (SaveSessionWorkflow) - inaczej agent z brain.md w drugim języku dostawałby cudze
// nagłówki zamrożone na stałe w globalnym override. Recenzja niezależna, punkt 8 (behawioralnie,
// nie regexem po źródle jak w poprzedniej wersji tego pliku - punkt 4c dogrywki rundy 2).
test('renderPromptSection: drugi guzik "Wstaw fabryczny" (save_session_prompt) wpisuje RAW {{sec_current}}, nie podstawiony "## Current"', t => {
    const container = makeFakeEl();
    const pkm: { promptDefaults?: Record<string, string> } = {};
    renderPromptSection(container as unknown as HTMLElement, { pkm, save: async () => { /* noop */ } });

    const insertButtons = collectByTag(container, 'button').filter(b => b.text === i18n('settings.prompt_insert_factory'));
    // Kolejność renderu WORK_PROMPTS: compression_prompt(0), save_session_prompt(1), ... - drugi
    // guzik „Wstaw fabryczny" odpowiada więc save_session_prompt.
    const secondInsertBtn = insertButtons[1];
    t.truthy(secondInsertBtn, 'drugi guzik „Wstaw fabryczny" (save_session_prompt) nie znaleziony');

    const clickHandlers = secondInsertBtn.listeners.click || [];
    t.true(clickHandlers.length > 0, 'guzik musi mieć zarejestrowany handler click');
    clickHandlers[0]();

    const stored = pkm.promptDefaults?.save_session_prompt;
    t.truthy(stored, 'kliknięcie musi zapisać tekst do promptDefaults.save_session_prompt');
    t.true(stored!.includes('{{sec_current}}'), 'RAW placeholder musi zostać nietknięty - globalny override dzielą wszyscy agenci, podstawienie należy do miejsca użycia per-agent');
    t.false(stored!.includes('## Current'), 'stary bug: podstawiony tekst zamrażał nagłówek EN z chwili kliknięcia na stałe w globalnym override');
});
