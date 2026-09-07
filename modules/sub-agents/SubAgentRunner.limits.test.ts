/**
 * SubAgentRunner.limits — KONTRAKT sufitu wyniku narzędzia w pętli SUB-agenta.
 *
 * Kontekst (audyt nocny 2026-08-19, moduł 9): runda 2 z 2026-08-17 uznała wynik suba za
 * DELIVERABLE i dała mu własny sufit `subagent_result_max_chars` (60k) zamiast wspólnego
 * `max_tool_result_length` (15k). Do tego dnia naprawa działała TYLKO na drodze powrotu do
 * agenta GŁÓWNEGO (powiadomienie z tła + okablowanie per-tool w turze czatu, `chat_streaming`).
 * Ten plik pierwotnie SPISYWAŁ stan faktyczny piętro niżej: `SubAgentRunner` budował
 * `loopLimits` BEZ mapy per-tool, więc wynik zagnieżdżonej delegacji (sub deleguje głębiej,
 * `max_delegation_depth` > 1) wracał do suba przycięty wspólnym sufitem 15k.
 *
 * Werdykt właściciela (2026-08-19): „podnosimy ten sam sufit też wewnątrz subagenta" — TAK.
 * Po naprawie ten plik pilnuje NOWEGO kontraktu zamiast starej granicy:
 * (a) `loopLimits` ma mapę per-tool (`maxToolResultLengthPerTool`),
 * (b) `delegate` i `agent_delegate` dostają `subagent_result_max_chars` (60k) — chyba że sub
 *     ma WŁASNY `max_tool_result_length` większy niż to (F1, weryfikacja opus), wtedy wygrywa
 *     większy z dwóch — mapa nie ma prawa NIKOMU obniżyć sufitu,
 * (c) zero po KTÓREJKOLWIEK stronie (`subagent_result_max_chars` globalnie, ALBO
 *     `config.max_tool_result_length` tego suba — SubAgentEditorModal zapisuje 0 za puste
 *     pole) to świadome „bez limitu" i zostaje zerem — nie zamienia się w drugą wartość przez
 *     nieostrożny `Math.max` (F1 + review lidera tego samego dnia),
 * (d) każde inne narzędzie nadal idzie pod wspólny `max_tool_result_length` (15k).
 *
 * Wzorzec identyczny z `chat_streaming.ts` (per-tool override dla tych samych dwóch nazw,
 * z tego samego źródła configu — `getLimits().subagent_result_max_chars`), z JEDNĄ różnicą:
 * czat nie ma per-agent override, sub ma — stąd `_deliverableResultCap` zamiast przelotu wprost.
 */
import test from 'ava';
import { SubAgentRunner as RuntimeSubAgentRunner } from './SubAgentRunner.js';
import { DEFAULT_LIMITS } from '../../config/limits.js';

type TestRunner = { runTask(...args: unknown[]): Promise<{ result: string }> };
const SubAgentRunner = RuntimeSubAgentRunner as unknown as new (options: unknown) => TestRunner;

type Payload = { messages?: Array<{ role: string; content?: unknown }> };
type Handlers = { chunk?: (r: unknown) => void; done: (r: unknown) => void; error?: (e: unknown) => void };

const tekstowa = (tresc: string) => ({ choices: [{ message: { role: 'assistant', content: tresc } }] });
const zWywolaniem = (nazwa: string) => ({
    choices: [{ message: { role: 'assistant', content: '', tool_calls: [
        { id: 'c1', function: { name: nazwa, arguments: '{"task":"zbierz wszystko"}' } },
    ] } }],
});

/** Model odgrywający: 1. tura woła narzędzie `nazwa`, 2. kończy tekstem. Zapisuje payloady. */
function makeModel(nazwa: string) {
    let idx = 0;
    return {
        calls: [] as Payload[],
        stream(payload: Payload, handlers: Handlers) {
            this.calls.push(payload);
            const resp = idx++ === 0 ? zWywolaniem(nazwa) : tekstowa('gotowe');
            Promise.resolve().then(() => handlers.done(resp));
        },
    };
}

/** Rejestr z jednym narzędziem o podanej nazwie, którego wynik jest podanym tekstem. */
function makeRegistry(nazwa: string, wynik: string) {
    const tool = {
        name: nazwa,
        description: 'narzędzie testowe',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => wynik,
    };
    return { getTool: (n: string) => (n === nazwa ? tool : null) };
}

/** Treść wiadomości roli `tool` z payloadu ostatniego wywołania modelu. */
function wynikNarzedziaZTranskryptu(model: { calls: Payload[] }): string {
    const ostatni = model.calls[model.calls.length - 1];
    const toolMsg = (ostatni?.messages || []).filter((m) => m.role === 'tool').pop();
    return typeof toolMsg?.content === 'string' ? toolMsg.content : '';
}

/**
 * Odpala suba z JEDNYM narzędziem `nazwa`, którego wynik jest `dorobek`; zwraca model (do
 * asercji na `calls`) i to, co dotarło do transkryptu.
 *
 * `opts.configExtra` — F1: dokłada pola do configu suba (np. WŁASNY `max_tool_result_length`,
 * per-sub override z SubAgentEditorModal). `opts.pluginExtra` — F1: nadpisuje `plugin`, żeby
 * dowieźć `settings.pkmAssistant.limits.*` (np. `subagent_result_max_chars: 0`) przez ten sam
 * `getLimits(this.plugin?.env?.settings)`, którego używa runner.
 */
async function uruchomZNarzedziem(
    nazwa: string,
    dorobek: string,
    opts: { configExtra?: Record<string, unknown>; pluginExtra?: Record<string, unknown> } = {},
) {
    const model = makeModel(nazwa);
    const runner = new SubAgentRunner({
        toolRegistry: makeRegistry(nazwa, dorobek),
        app: {},
        plugin: opts.pluginExtra ?? {},
    });
    await runner.runTask(
        'Zleć głębiej i oddaj wynik.',
        { name: 'Jaskier' },
        { name: 'worker', role: 'worker', tools: [nazwa], max_iterations: 3, ...opts.configExtra },
        model,
        { modelTimeout: 5000 },
    );
    return { model, wTranskrypcie: wynikNarzedziaZTranskryptu(model) };
}

for (const nazwa of ['delegate', 'agent_delegate']) {
    test(`kontrakt: wynik \`${nazwa}\` w pętli suba PRZEŻYWA rozmiar, który wspólny sufit by uciął`, async t => {
        const wspolnySufit = DEFAULT_LIMITS.max_tool_result_length;
        const deliverableSufit = DEFAULT_LIMITS.subagent_result_max_chars;
        // Dłuższy niż wspólny sufit (15k), krótszy niż sufit deliverable (60k) — rozróżnia,
        // który z dwóch zadziałał.
        const dorobek = 'D'.repeat(wspolnySufit + 5000);
        t.true(dorobek.length < deliverableSufit, 'Fixture zły: dorobek ma się mieścić pod sufitem deliverable.');

        const { model, wTranskrypcie } = await uruchomZNarzedziem(nazwa, dorobek);

        t.is(model.calls.length, 2, 'Model miał zostać zawołany dwa razy: wywołanie narzędzia i domknięcie.');
        t.is(
            wTranskrypcie,
            dorobek,
            `Wynik \`${nazwa}\` został przycięty mimo że mieści się pod sufitem deliverable (${deliverableSufit}) — mapa maxToolResultLengthPerTool nie działa dla tego narzędzia.`,
        );
    });

    test(`kontrakt: sufit \`${nazwa}\` w pętli suba to DOKŁADNIE subagent_result_max_chars, nie coś inne`, async t => {
        const deliverableSufit = DEFAULT_LIMITS.subagent_result_max_chars;
        // Dłuższy niż sam sufit deliverable — MUSI zostać przycięty; inaczej test nie odróżnia
        // „sufit = subagent_result_max_chars" od „brak sufitu".
        const dorobek = 'D'.repeat(deliverableSufit + 5000);

        const { wTranskrypcie } = await uruchomZNarzedziem(nazwa, dorobek);

        t.true(
            wTranskrypcie.startsWith('D'.repeat(deliverableSufit)),
            `Początek dorobku do sufitu deliverable (${deliverableSufit} znaków) powinien przetrwać w całości.`,
        );
        t.false(
            wTranskrypcie.includes('D'.repeat(deliverableSufit + 1)),
            `Wynik \`${nazwa}\` przekracza sufit deliverable (${deliverableSufit}) — mapa per-tool wskazuje zły klucz configu albo w ogóle nie przycina.`,
        );
    });
}

test('kontrakt: narzędzie SPOZA mapy per-tool (np. `search`) nadal idzie pod wspólny sufit max_tool_result_length', async t => {
    const wspolnySufit = DEFAULT_LIMITS.max_tool_result_length;
    const deliverableSufit = DEFAULT_LIMITS.subagent_result_max_chars;
    // Dłuższy niż wspólny sufit, ale krótszy niż sufit deliverable — gdyby mapa per-tool
    // objęła to narzędzie przez pomyłkę (np. zbyt szeroki klucz), wynik przeszedłby CAŁY.
    const dorobek = 'D'.repeat(wspolnySufit + 5000);
    t.true(dorobek.length < deliverableSufit, 'Fixture zły: dorobek ma być krótszy niż sufit deliverable, inaczej test niczego nie odróżnia.');

    const { model, wTranskrypcie } = await uruchomZNarzedziem('search', dorobek);

    t.is(model.calls.length, 2, 'Model miał zostać zawołany dwa razy: wywołanie narzędzia i domknięcie.');
    t.true(
        wTranskrypcie.startsWith('D'.repeat(wspolnySufit)),
        'Początek dorobku do wspólnego sufitu powinien przetrwać w całości.',
    );
    t.false(
        wTranskrypcie.includes('D'.repeat(wspolnySufit + 1)),
        `Wynik narzędzia spoza mapy per-tool przekracza wspólny sufit (${wspolnySufit}) — mapa per-tool zeszła piętro niżej i objęła narzędzia, których nie powinna.`,
    );
});

test('kontrakt (F1, weryfikacja opus): sub z WŁASNYM max_tool_result_length większym niż deliverable — delegate NIE cięty do 60k', async t => {
    const deliverableDefault = DEFAULT_LIMITS.subagent_result_max_chars;
    const subCommonCap = deliverableDefault + 40000; // override w SUB_AGENT.yaml, > deliverable default
    t.true(subCommonCap > deliverableDefault, 'Fixture zły: cały sens testu to override suba WIĘKSZY niż deliverable default.');

    // Między deliverable default (60k) a override suba (100k) — gdyby mapa nadal hardcodowała
    // subagent_result_max_chars zamiast Math.max z sufitem suba, ten payload zostałby ucięty
    // na 60k MIMO że sub ma jawnie ustawiony większy sufit ogólny.
    const dorobek = 'D'.repeat(subCommonCap - 5000);

    const { wTranskrypcie } = await uruchomZNarzedziem('delegate', dorobek, {
        configExtra: { max_tool_result_length: subCommonCap },
    });

    t.is(
        wTranskrypcie,
        dorobek,
        `Wynik \`delegate\` został przycięty mimo że mieści się pod WŁASNYM sufitem suba (${subCommonCap}) — naprawa 19.08 obniżyła sufit configu suba zamiast go tylko podnosić do deliverable.`,
    );
});

test('kontrakt (F1, weryfikacja opus): subagent_result_max_chars=0 („bez limitu") — delegate bez cięcia, nie 60k', async t => {
    // Payload wyraźnie większy niż jakikolwiek default w tym pliku — ma przetrwać W CAŁOŚCI,
    // bo administrator globalnie wyłączył sufit deliverable (0 = bez limitu, config/limits.ts).
    const dorobek = 'D'.repeat(DEFAULT_LIMITS.subagent_result_max_chars * 3);

    const { wTranskrypcie } = await uruchomZNarzedziem('delegate', dorobek, {
        pluginExtra: { env: { settings: { pkmAssistant: { limits: { subagent_result_max_chars: 0 } } } } },
    });

    t.is(
        wTranskrypcie,
        dorobek,
        'subagent_result_max_chars=0 to świadome „bez limitu" — zwykły Math.max(commonCap, 0) by je zepsuł (0 przegrywa z każdą dodatnią liczbą i zamieniłby się w commonCap); delegate nie powinien być cięty wcale.',
    );
});

test('kontrakt (F1, review lidera): sub z WŁASNYM max_tool_result_length=0 („bez limitu") — delegate bez cięcia, nie 60k', async t => {
    // SubAgentEditorModal zapisuje 0 za puste pole, a `config.max_tool_result_length ?? ...`
    // NIE łapie 0 (tylko null/undefined) — więc sufit ogólny TEGO suba realnie wynosi 0
    // („bez limitu" dla wszystkich jego narzędzi). Payload wyraźnie większy niż deliverable
    // default ma przetrwać W CAŁOŚCI — inaczej delegate dostałby sufit 60k mimo że reszta
    // narzędzi suba jest jawnie bez limitu (dokładnie ta sama klasa błędu co test (b) wyżej,
    // tylko po DRUGIEJ stronie Math.max).
    const dorobek = 'D'.repeat(DEFAULT_LIMITS.subagent_result_max_chars * 3);

    const { wTranskrypcie } = await uruchomZNarzedziem('delegate', dorobek, {
        configExtra: { max_tool_result_length: 0 },
    });

    t.is(
        wTranskrypcie,
        dorobek,
        'max_tool_result_length=0 w configu suba to świadome „bez limitu" — Math.max(0, 60000) by je zepsuł (0 przegrywa z deliverable default), więc delegate dostałby sufit 60k mimo że sub go jawnie wyłączył.',
    );
});
