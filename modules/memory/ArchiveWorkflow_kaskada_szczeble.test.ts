/**
 * ArchiveWorkflow_kaskada_szczeble.test.ts — noc audytowa 2026-08-29, modul 9.
 *
 * Pytanie tej nocy (brief Niki 2026-08-27, Bug 3): dlaczego rura L1/L2 "mieli w kolko" -
 * u Borysa trzy pliki L2 z IDENTYCZNA lista `l1_files` (piec najstarszych), a nowsze L1
 * nigdy nie awansowaly.
 *
 * Odpowiedz jest w ksztalcie samej rury, nie w danych. Kaskada ma trzy szczeble i kazdy
 * dobiera material tak samo - `slice(0, batchSize)` po posortowanym listingu katalogu.
 * Roznica jest w tym, co dzieje sie PO zapisie:
 *
 *   sesje -> L1 : `_listSessionsForL1()` filtruje po stemplu `covered_by_l1`,
 *                 a `_cleanupAfterL1` ten stempel stawia            -> petla DOMKNIETA
 *   L1 -> L2    : `_listMarkdown(paths.l1)` bez filtru,
 *                 `_writeLevel2` nie stempluje i nie kasuje L1      -> petla OTWARTA
 *   L2 -> L3    : `_listMarkdown(paths.l2)` bez filtru,
 *                 `_cleanupAfterL3` kasuje L1, a L2 zostawia
 *                 ("najwyzszy poziom historii, manualny cleanup")   -> petla OTWARTA
 *
 * Naprawa z 2026-07-29 (komentarz przy `_listSessionsForL1`, wtopa "12 duplikatow L1")
 * zamknela petle na PIERWSZYM szczeblu. Dwa pozostale mialy ksztalt sprzed tamtej naprawy
 * az do 2026-09-04.
 *
 * ── NAPRAWA 2026-09-04 (P1 health checku 29.07: "duplikaty L1") ────────────────────────
 *
 * Petle domkniete jednym gestem, BEZ dokladania czegokolwiek do plikow usera:
 *
 *   L1 -> L2 : `_listUncoveredL1()` = pliki L1, ktorych nie wymienia zadne L2 we
 *              frontmatterze `l1_files:`  (`AgentMemory.listUncoveredL1s`)
 *   L2 -> L3 : `_listUncoveredL2()` = pliki L2, ktorych nie wymienia zadne L3 we
 *              frontmatterze `l2_files:`  (`AgentMemory.listUncoveredL2s`)
 *
 * Znacznikiem pokrycia jest SAM PLIK NADRZEDNY - `l1_files`/`l2_files` pisze `_writeLevel2`
 * i `_writeLevel3` od zawsze, tylko nikt tego nie czytal przy doborze materialu (dokladnie
 * ta sama choroba co stempel `covered_by_l1` przed 29.07: stempel byl, czytacza nie bylo).
 * Dlatego "zapis L2" i "oznaczenie L1" to JEDNA operacja atomowa - stad crash-safety za
 * darmo i zerowa migracja starych dyskow. Uzasadnienie odrzucenia stempla `covered_by_l2`
 * (drugi zapis = okno na duplikat po padzie) siedzi przy `AgentMemory.listUncoveredL1s`.
 *
 * Testy nizej opisuja stan PO naprawie. Cztery charakteryzujace zostaly przepisane
 * (opisywaly wtope), pin zszedl z `test.failing` na `test`, doszly dwa nowe:
 * "crash w polowie" i "stare dane".
 *
 * Strazniki bliźniacze na szczeblu L1:
 *   `ArchiveWorkflowRun.test.ts` - "sesje ze stemplem covered_by_l1 nie wchodza do paczek L1"
 *                                - "drugi przebieg po zaakceptowanym L1 nie proponuje tych samych sesji"
 *
 * Atrapy (vault, model, workflow) sa swiadomie skopiowane z `ArchiveWorkflowRun.test.ts` -
 * tamten plik ich nie eksportuje, a nocka nie przepisuje cudzego pliku testowego.
 */
import test from 'ava';
import { AgentMemory } from './AgentMemory.js';
import { ArchiveWorkflow } from './ArchiveWorkflow.js';
import { ConsolidationRun, STEP_STATUS } from './ConsolidationRun.js';
import type { MemoryVaultLike } from './AgentMemory.js';
import type { StreamChatModelLike, StreamHandlers, StreamMessage } from './streamHelper.js';

const BASE = '.pkm-assistant/agents/jaskier/memory';

function makeVault(initialFiles: Record<string, string> = {}) {
    const files: Record<string, string> = { ...initialFiles };
    const folders = new Set<string>();

    const parentFoldersFor = (path: string): string[] => {
        const parts = path.split('/');
        const result: string[] = [];
        for (let i = 1; i < parts.length; i++) result.push(parts.slice(0, i).join('/'));
        return result;
    };
    for (const path of Object.keys(files)) {
        for (const folder of parentFoldersFor(path)) folders.add(folder);
    }

    return {
        files,
        vault: {
            adapter: {
                async exists(path: string) {
                    return Object.prototype.hasOwnProperty.call(files, path) || folders.has(path);
                },
                async mkdir(path: string) { folders.add(path); },
                async read(path: string) {
                    if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error(`missing: ${path}`);
                    return files[path];
                },
                async write(path: string, content: string) {
                    for (const folder of parentFoldersFor(path)) folders.add(folder);
                    files[path] = content;
                },
                async remove(path: string) { delete files[path]; },
                async list(folder: string) {
                    const prefix = `${folder}/`;
                    return {
                        files: Object.keys(files).filter(p => p.startsWith(prefix)),
                        folders: [...folders].filter(p => p.startsWith(prefix) && p !== folder),
                    };
                },
                async stat(path: string) {
                    return Object.prototype.hasOwnProperty.call(files, path) ? { mtime: 1 } : null;
                },
            },
        },
    };
}

function scriptedModel(): StreamChatModelLike {
    return {
        stopStream() { /* atrapa */ },
        stream(_req: { messages: StreamMessage[] }, handlers: StreamHandlers) {
            setTimeout(() => handlers.done({
                choices: [{ message: { content: 'Streszczenie' } }],
                usage: { prompt_tokens: 100, completion_tokens: 20 },
            }), 0);
        },
    };
}

function makeWorkflow(vault: MemoryVaultLike, options: Record<string, unknown> = {}) {
    const memory = new AgentMemory(vault, 'Jaskier');
    const workflow = new ArchiveWorkflow(memory, {
        agent: { name: 'Jaskier', summary_prompt: 'Zrob {{LEVEL}}' },
        model: scriptedModel(),
        ...options,
    });
    return { memory, workflow };
}

function summaryFile(level: string, fields: Record<string, string[]> = {}, body = 'Summary') {
    const lines = ['---', `level: ${level}`];
    for (const [key, values] of Object.entries(fields)) {
        lines.push(`${key}:`);
        for (const value of values) lines.push(`  - ${value}`);
    }
    lines.push('---', '', body);
    return lines.join('\n');
}

/** N plikow L1 o nazwach sortowalnych leksykalnie, kazdy deklarujacy wlasne sesje. */
function l1Files(count: number): Record<string, string> {
    const initial: Record<string, string> = {};
    for (let i = 1; i <= count; i++) {
        const name = `l1_${String(i).padStart(3, '0')}.md`;
        initial[`${BASE}/summaries/L1/${name}`] = summaryFile('L1', {
            sessions: [`session_${String(i).padStart(3, '0')}.md`],
        });
    }
    return initial;
}

/** N plikow L2 o nazwach sortowalnych leksykalnie, kazdy deklarujacy wlasne L1. */
function l2Files(count: number): Record<string, string> {
    const initial: Record<string, string> = {};
    for (let i = 1; i <= count; i++) {
        const name = `l2_${String(i).padStart(3, '0')}.md`;
        initial[`${BASE}/summaries/L2/${name}`] = summaryFile('L2', {
            l1_files: [`l1_${String(i).padStart(3, '0')}.md`],
        });
    }
    return initial;
}

const namesIn = (files: Record<string, string>, folder: string): string[] =>
    Object.keys(files)
        .filter(p => p.includes(`/summaries/${folder}/`) && p.endsWith('.md'))
        .map(p => p.split('/').pop() as string)
        .sort();

/**
 * Przebieg z otwarta bramka L1: zero sesji w archiwum = zero krokow L1 do rozstrzygniecia,
 * wiec `generateGatedSteps` od razu bierze sie za L2. Krok L2 powstaje w planie dopiero przy
 * `l1Count >= batchSize`, a krok L3 przy `l2Count + 1 >= batchSize` - stad jawne liczniki.
 */
function runWithOpenL1Gate(l1Count = 8, l2Count = 0): ConsolidationRun {
    return new ConsolidationRun({ counts: { archiveCount: 0, batchSize: 5, l1Count, l2Count } });
}


// ── szczebel L1 -> L2: znacznikiem pokrycia jest sam plik L2 ──────────────────────

test('_writeLevel2 nie dopisuje NIC do plikow L1 - znacznikiem jest jego wlasny `l1_files`', async t => {
    const { vault, files } = makeVault(l1Files(5));
    const { workflow } = makeWorkflow(vault);

    const before = { ...files };
    await workflow._writeLevel2({
        name: 'l2_nowy.md',
        l1_files: namesIn(files, 'L1'),
        sessions: [],
        body: 'Streszczenie L2',
    });

    // Piec plikow L1 nadal na dysku - to jest kontrakt kaskady ("L1 zostaja") i jest dotrzymany.
    t.is(namesIn(files, 'L1').length, 5, 'pliki L1 zostaja, zgodnie z kontraktem kaskady');
    // Ich TRESC tez sie nie zmienila - naprawa 2026-09-04 celowo NIE stempluje plikow usera
    // (`covered_by_l2` bylby DRUGIM zapisem po zapisie L2 = okno na duplikat przy padzie miedzy nimi).
    for (const name of namesIn(files, 'L1')) {
        const path = `${BASE}/summaries/L1/${name}`;
        t.is(files[path], before[path], `plik ${name} nietkniety - naprawa nie pisze po plikach usera`);
    }
    // A mimo to pula kandydatow jest juz pusta: pokrycie czytamy z `l1_files` swiezego L2.
    t.deepEqual(await workflow._listUncoveredL1(), [], 'zaden L1 nie wraca do puli po wejsciu do L2');
});

test('drugi przebieg L2 bierze KOLEJNE piec plikow L1, nie te same', async t => {
    // Objaw z briefu Niki (u Borysa trzy L2 z ta sama piatka najstarszych L1) - dzis niemozliwy.
    const { vault, files } = makeVault(l1Files(10));
    const { workflow } = makeWorkflow(vault);

    const first = runWithOpenL1Gate(10);
    await workflow.generateGatedSteps(first);
    const firstBatch = first.getStep('l2')!.result!.l1_files;
    await workflow.applyStepDecision(first, 'l2', { accepted: true });

    const second = runWithOpenL1Gate(10);
    await workflow.generateGatedSteps(second);
    const secondBatch = second.getStep('l2')!.result!.l1_files;
    await workflow.applyStepDecision(second, 'l2', { accepted: true });

    t.deepEqual(firstBatch, ['l1_001.md', 'l1_002.md', 'l1_003.md', 'l1_004.md', 'l1_005.md']);
    t.deepEqual(secondBatch, ['l1_006.md', 'l1_007.md', 'l1_008.md', 'l1_009.md', 'l1_010.md'],
        'drugie L2 streszcza KOLEJNA piatke, nie powtorke pierwszej');
    t.is(namesIn(files, 'L1').length, 10, 'zaden L1 nie ubyl - kaskada kasuje je dopiero na szczeblu L3');
    t.is(namesIn(files, 'L2').length, 2, 'dwa L2, kazde o innym materiale');

    // Trzeci przebieg nie ma juz z czego robic paczki - krok odpada, zamiast mielic w kolko.
    const third = runWithOpenL1Gate(10);
    await workflow.generateGatedSteps(third);
    const step = third.getStep('l2')!;
    t.is(step.status, STEP_STATUS.SKIPPED);
    t.is(step.meta.skipReason, 'not_enough_l1');
});

// ── szczebel L2 -> L3: ta sama mechanika, jedno pietro wyzej ──────────────────────

test('_writeLevel3 kasuje pokryte L1, a L2 zostawia nietkniete - znacznikiem jest `l2_files`', async t => {
    const { vault, files } = makeVault({ ...l1Files(3), ...l2Files(3) });
    const { workflow } = makeWorkflow(vault);

    const l2Before = { ...files };
    await workflow._writeLevel3({
        name: 'l3_nowy.md',
        l2_files: namesIn(files, 'L2'),
        l1_files: namesIn(files, 'L1'),
        body: 'Streszczenie L3',
    });

    // L1 wymienione w tych L2 zniknely - to jest zadanie kaskady i jest wykonane.
    t.is(namesIn(files, 'L1').length, 0, 'L1 pokryte przez wchlaniane L2 skasowane');
    // L2 zostaja ("najwyzszy poziom historii, manualny cleanup tylko") i zostaja BEZ ZMIANY.
    for (const name of namesIn(files, 'L2')) {
        const path = `${BASE}/summaries/L2/${name}`;
        t.is(files[path], l2Before[path], `plik ${name} nietkniety - zero zapisow po plikach usera`);
    }
    // Pokrycie widac po `l2_files` swiezego L3, wiec do puli kandydatow juz nie wracaja.
    t.deepEqual(await workflow._listUncoveredL2(), [], 'zadne L2 nie wraca do puli po wejsciu do L3');
});

test('drugi przebieg L3 bierze KOLEJNE piec plikow L2, nie te same', async t => {
    // Plan bez kroku L2 (zero L1), zeby bramka L3 otwarla sie od razu - mierzymy sam dobor materialu.
    const { vault, files } = makeVault(l2Files(10));
    const { workflow } = makeWorkflow(vault);
    const planL3Only = () => new ConsolidationRun({
        counts: { archiveCount: 0, batchSize: 5, l1Count: 0, l2Count: 10 },
    });

    const first = planL3Only();
    await workflow.generateGatedSteps(first);
    const firstBatch = first.getStep('l3')!.result!.l2_files;
    await workflow.applyStepDecision(first, 'l3', { accepted: true });

    const second = planL3Only();
    await workflow.generateGatedSteps(second);
    const secondBatch = second.getStep('l3')!.result!.l2_files;

    t.deepEqual(firstBatch, ['l2_001.md', 'l2_002.md', 'l2_003.md', 'l2_004.md', 'l2_005.md']);
    t.deepEqual(secondBatch, ['l2_006.md', 'l2_007.md', 'l2_008.md', 'l2_009.md', 'l2_010.md'],
        'drugie L3 streszcza KOLEJNA piatke L2');
    t.is(namesIn(files, 'L2').length, 10, 'L2 nie ubywaja nigdy - tym bardziej musi je odsiewac filtr');
});

// ── kontrast: szczebel z domknieta petla od 2026-07-29 ────────────────────────────

test('kontrast - szczebel sesje -> L1 domyka petle stemplem, dwa wyzsze backlinkiem', async t => {
    // Ten sam ksztalt danych co wyzej, ale o pietro nizej: sesje w archiwum, z ktorych
    // czesc nosi juz stempel. `_listSessionsForL1` je odsiewa. Roznica w mechanice jest
    // swiadoma: sesja NIE jest wymieniona we frontmatterze niczego, co powstaje w tym samym
    // kroku, wiec tam stempel jest jedyna droga; L1/L2 sa wymienione w pliku nadrzednym,
    // wiec tam wystarczy backlink (i jest crash-safe za darmo).
    const initial: Record<string, string> = {};
    for (let i = 1; i <= 8; i++) {
        const name = `session_${String(i).padStart(3, '0')}.md`;
        const stamp = i <= 5 ? 'covered_by_l1: stary_l1.md\n' : '';
        initial[`${BASE}/sessions/archive/${name}`] =
            `---\ntype: archived_session\n${stamp}---\n\n## User\nSesja ${i}\n`;
    }
    const { vault } = makeVault(initial);
    const { memory } = makeWorkflow(vault);

    const uncovered = await memory.listUncoveredArchiveSessions();

    t.deepEqual(
        uncovered.map(item => item.name),
        ['session_006.md', 'session_007.md', 'session_008.md'],
        'ostemplowane sesje nie wracaja do puli'
    );
});

// ── pin z 2026-08-29, dzis zielony ────────────────────────────────────────────────
//
// Odpowiednik testu "drugi przebieg po zaakceptowanym L1 nie proponuje tych samych sesji"
// (ArchiveWorkflowRun.test.ts), tyle ze o szczebel wyzej. Do 2026-09-04 czerwony (`test.failing`).

test('drugi przebieg L2 nie proponuje tych samych plikow L1 (koniec duplikatow L2)', async t => {
    const { vault } = makeVault(l1Files(10));
    const { workflow } = makeWorkflow(vault);

    const first = runWithOpenL1Gate();
    await workflow.generateGatedSteps(first);
    const firstBatch = first.getStep('l2')!.result!.l1_files as string[];
    await workflow.applyStepDecision(first, 'l2', { accepted: true });

    const second = runWithOpenL1Gate();
    await workflow.generateGatedSteps(second);
    const step = second.getStep('l2')!;

    // Dopuszczalne sa dwa poprawne zachowania: albo drugi L2 bierze KOLEJNE piec plikow L1,
    // albo krok idzie jako `skipped` z braku nieprzerobionego materialu. Zabronione jest
    // wylacznie powtorzenie tej samej piatki.
    if (step.status === STEP_STATUS.SKIPPED) {
        t.pass();
        return;
    }
    const secondBatch = step.result!.l1_files as string[];
    const powtorzone = secondBatch.filter(name => firstBatch.includes(name));
    t.deepEqual(powtorzone, [], 'zaden plik L1 nie moze wejsc do drugiego L2');
});

// ── crash w polowie: zapis L2 JEST oznaczeniem L1, wiec nie ma "polowy" do zgubienia ──

test('crash TUZ PO zapisie L2 (bajty na dysku, krok failed) - L1 nie gina i nie wracaja do puli', async t => {
    const { vault, files } = makeVault(l1Files(10));
    // Symulacja padu procesu w najgorszym momencie: bajty L2 juz na dysku, ale operacja
    // konczy sie wyjatkiem (krok `failed`, zero dalszego sprzatania). Gdyby pokrycie stalo
    // na stemplu w plikach L1, ten pad zostawilby L2 na dysku i NIEOSTEMPLOWANE L1 - czyli
    // dokladnie duplikat, ktory ta naprawa likwiduje.
    const origWrite = vault.adapter.write;
    let boom = false;
    vault.adapter.write = async (path: string, content: string) => {
        await origWrite(path, content);
        if (!boom && path.includes('/summaries/L2/')) {
            boom = true;
            throw new Error('BOOM: pad zaraz po zapisie L2');
        }
    };
    const { workflow } = makeWorkflow(vault);

    const first = runWithOpenL1Gate(10);
    await workflow.generateGatedSteps(first);
    const firstBatch = first.getStep('l2')!.result!.l1_files as string[];
    const applied = await workflow.applyStepDecision(first, 'l2', { accepted: true });

    t.false(applied.applied, 'krok zaraportowal porazke - user widzi "Ponow"');
    t.is(first.getStep('l2')!.status, STEP_STATUS.FAILED);
    // Nic nie zginelo: komplet L1 na dysku, plik L2 tez (zapis sie udal, padlo po nim).
    t.is(namesIn(files, 'L1').length, 10, 'zaden L1 nie zniknal przez pad');
    t.is(namesIn(files, 'L2').length, 1, 'bajty L2 zostaly na dysku');

    // I nie ma duplikatu: pokrycie widac po `l1_files` tego wlasnie pliku, bez zadnego
    // drugiego kroku, ktory pad mogl przerwac.
    const second = runWithOpenL1Gate(10);
    await workflow.generateGatedSteps(second);
    const secondBatch = second.getStep('l2')!.result!.l1_files as string[];
    t.deepEqual(secondBatch.filter(name => firstBatch.includes(name)), [],
        'po padzie zaden L1 z pierwszej piatki nie wraca do puli');
});

test('crash PRZED zapisem L2 (nic na dysku) - te same L1 wracaja do puli, bo nic nie powstalo', async t => {
    const { vault, files } = makeVault(l1Files(10));
    const origWrite = vault.adapter.write;
    let boom = false;
    vault.adapter.write = async (path: string, content: string) => {
        if (!boom && path.includes('/summaries/L2/')) {
            boom = true;
            throw new Error('BOOM: dysk padl przed zapisem L2');
        }
        await origWrite(path, content);
    };
    const { workflow } = makeWorkflow(vault);

    const first = runWithOpenL1Gate(10);
    await workflow.generateGatedSteps(first);
    const firstBatch = first.getStep('l2')!.result!.l1_files as string[];
    await workflow.applyStepDecision(first, 'l2', { accepted: true });

    t.is(namesIn(files, 'L2').length, 0, 'zadnego L2 na dysku');
    t.is(namesIn(files, 'L1').length, 10, 'komplet L1 nietkniety');

    const second = runWithOpenL1Gate(10);
    await workflow.generateGatedSteps(second);
    const secondBatch = second.getStep('l2')!.result!.l1_files as string[];
    // To NIE jest duplikat - poprzednia proba nie zostawila zadnego streszczenia.
    t.deepEqual(secondBatch, firstBatch, 'nieudana proba nie zjada materialu');
});

// ── stare dane: dysk sprzed naprawy leczy sie sam, bez migracji ───────────────────

test('stary dysk z duplikatami (trzy L2 o tej samej piatce) - nowy przebieg bierze material NIEPOKRYTY', async t => {
    // Odtworzenie dysku Borysa: 10 plikow L1 i trzy L2, kazde o tej samej piatce najstarszych.
    // Zaden plik L1 nie ma zadnego markera - i nie musi, bo markerem sa te wlasnie L2.
    const stara = ['l1_001.md', 'l1_002.md', 'l1_003.md', 'l1_004.md', 'l1_005.md'];
    const duplikaty: Record<string, string> = {};
    for (let i = 1; i <= 3; i++) {
        duplikaty[`${BASE}/summaries/L2/l2_dup_${i}.md`] = summaryFile('L2', { l1_files: stara });
    }
    const { vault } = makeVault({ ...l1Files(10), ...duplikaty });
    const { workflow } = makeWorkflow(vault);

    const run = runWithOpenL1Gate(10, 3);
    await workflow.generateGatedSteps(run);

    t.deepEqual(
        run.getStep('l2')!.result!.l1_files,
        ['l1_006.md', 'l1_007.md', 'l1_008.md', 'l1_009.md', 'l1_010.md'],
        'stare duplikaty licza sie jako pokrycie - bez migracji i bez przeliczania'
    );
});

test('L2 bez `l1_files` nie pokrywa niczego - jedno przeliczenie, potem cisza', async t => {
    // Granica swiadoma: plik L2 zrobiony recznie albo przez bardzo stara wersje nie mowi,
    // z czego powstal. Jego material wroci do puli RAZ (drugie streszczenie tych samych L1),
    // ale swieze L2 juz wypisuje `l1_files`, wiec trzeciego razu nie bedzie.
    const { vault } = makeVault({
        ...l1Files(5),
        [`${BASE}/summaries/L2/l2_reczne.md`]: '---\nlevel: L2\n---\n\nRecznie napisane, bez l1_files.\n',
    });
    const { workflow } = makeWorkflow(vault);

    t.is((await workflow._listUncoveredL1()).length, 5, 'L2 bez backlinku nie pokrywa niczego');

    const first = runWithOpenL1Gate(5, 1);
    await workflow.generateGatedSteps(first);
    await workflow.applyStepDecision(first, 'l2', { accepted: true });

    t.deepEqual(await workflow._listUncoveredL1(), [], 'po jednym przeliczeniu pula jest pusta');
    const second = runWithOpenL1Gate(5, 2);
    await workflow.generateGatedSteps(second);
    t.is(second.getStep('l2')!.status, STEP_STATUS.SKIPPED, 'drugiego przeliczenia juz nie ma');
});
