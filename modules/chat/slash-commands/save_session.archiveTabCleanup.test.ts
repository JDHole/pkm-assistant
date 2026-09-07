/**
 * save_session.archiveTabCleanup — strażnik PO ŹRÓDLE dla `applyPostArchiveAction`, gałąź
 * plain `archive` (fabryka napraw W13, follow-up po review W4).
 *
 * DLACZEGO PO ŹRÓDLE, A NIE BEHAWIORALNIE: `save_session.ts` importuje `obsidian` (`Notice`,
 * `App`) na górze modułu, więc AVA nie zaimportuje pliku produkcyjnego — ten sam wzór, co
 * `save_session.skipCache.test.ts` i `save_session.noteFailures.test.ts` obok.
 *
 * BUG (review W4): `/save_session` z akcją `archive` (bez `_new`/`_close` — czyli TAKŻE
 * `result.action` domyślny) archiwizuje plik aktywnej sesji i zeruje
 * `AgentMemory.activeSessionPath` (`SaveSessionWorkflow.applyDecision` → `archiveActiveSession`),
 * ale zostawiał `activeTab.sessionPath` wskazujące na TEN SAM, teraz zarchiwizowany plik.
 * `chat_tabs._switchTab` czyta `targetTab.sessionPath` i przy KAŻDYM powrocie na tę zakładkę
 * wpisywał tę wiszącą ścieżkę z powrotem do `memory.activeSessionPath` — sesja "zmartwychwstawała"
 * jako wskaźnik na nieistniejący plik.
 *
 * CO PILNUJE: gałąź plain `archive` czyści WSZYSTKIE cztery pola tożsamości sesji na zakładce
 * (sessionPath/sessionId/sessionName/sessionLabel) — dokładnie jak `archive_new` robi dla NOWEJ
 * wartości, tylko bez wpisywania nowej ścieżki (leniwe utworzenie przy następnym zdarzeniu).
 */
import test from 'ava';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./save_session.ts', import.meta.url), 'utf8');

function extractFunctionBody(src: string, signature: string): string {
    const start = src.indexOf(signature);
    if (start < 0) throw new Error(`Nie znaleziono funkcji: ${signature}`);
    // Balansowanie klamer od pierwszej '{' po sygnaturze — funkcja może zawierać zagnieżdżone bloki.
    const braceStart = src.indexOf('{', start);
    let depth = 0;
    for (let i = braceStart; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(braceStart, i + 1);
        }
    }
    throw new Error('Nie zbalansowano klamer funkcji.');
}

const fnBody = extractFunctionBody(source, 'async function applyPostArchiveAction(');

test('applyPostArchiveAction istnieje i ma spodziewany kształt (3 gałęzie akcji)', t => {
    t.true(fnBody.includes("action === 'archive_new'"), 'Zmienił się kształt gałęzi archive_new.');
    t.true(fnBody.includes("action === 'archive_close'"), 'Zmienił się kształt gałęzi archive_close.');
});

test('gałąź archive_close kończy się return — nie wpada w sprzątanie plain archive', t => {
    const od = fnBody.indexOf("action === 'archive_close'");
    t.true(od >= 0);
    // Blok if(archive_close) { ... } — bierzemy do najbliższej domykającej klamry na tym poziomie.
    const braceStart = fnBody.indexOf('{', od);
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < fnBody.length; i++) {
        if (fnBody[i] === '{') depth++;
        else if (fnBody[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    t.true(end > braceStart, 'Nie zbalansowano klamer gałęzi archive_close.');
    const block = fnBody.slice(braceStart, end);
    t.true(block.includes('closeArchivedTab(view)'), 'archive_close przestał wołać closeArchivedTab.');
    t.regex(
        block,
        /return;\s*$/,
        'archive_close nie kończy się `return` — bez niego egzekucja spadnie w sprzątanie ' +
        'plain `archive` i wykona je na już USUNIĘTEJ (splice) zakładce.',
    );
});

test('REGRESJA W4: po archive_close zostaje kod czyszczący 4 pola sesji zakładki (gałąź plain archive)', t => {
    const closeIdx = fnBody.indexOf("action === 'archive_close'");
    const tail = fnBody.slice(closeIdx);

    // Wszystkie cztery pola tożsamości sesji muszą zostać wyzerowane — inaczej `_tabKey`
    // (chat_tabs.ts: sessionId || sessionPath || sessionName || agentName) dalej zwróci
    // wiszącą wartość i bug wraca częściowo.
    t.regex(tail, /activeTab\.sessionPath\s*=\s*null/, 'sessionPath nie jest czyszczone dla plain archive.');
    t.regex(tail, /activeTab\.sessionId\s*=\s*undefined/, 'sessionId nie jest czyszczone dla plain archive.');
    t.regex(tail, /activeTab\.sessionName\s*=\s*undefined/, 'sessionName nie jest czyszczone dla plain archive.');
    t.regex(tail, /activeTab\.sessionLabel\s*=\s*undefined/, 'sessionLabel nie jest czyszczone dla plain archive.');
});

test('czyszczenie jest za bramką `if (activeTab)` — nie wybucha, gdy nie ma aktywnej zakładki', t => {
    const closeIdx = fnBody.indexOf("action === 'archive_close'");
    const tail = fnBody.slice(closeIdx);
    const cleanupIdx = tail.search(/activeTab\.sessionPath\s*=\s*null/);
    t.true(cleanupIdx >= 0);
    const before = tail.slice(0, cleanupIdx);
    t.true(
        /if\s*\(\s*activeTab\s*\)\s*\{\s*$/.test(before.trimEnd()),
        'Czyszczenie pól sesji nie jest bezpośrednio pod bramką `if (activeTab)`.',
    );
});

test('sprzątanie plain archive NIE żyje wewnątrz gałęzi archive_new (nie duplikuje jej `return`)', t => {
    const newIdx = fnBody.indexOf("action === 'archive_new'");
    const closeIdx = fnBody.indexOf("action === 'archive_close'");
    const archiveNewBlock = fnBody.slice(newIdx, closeIdx);
    t.false(
        archiveNewBlock.includes('activeTab.sessionId = undefined'),
        'Sprzątanie plain archive wylądowało wewnątrz bloku archive_new — obie gałęzie się zlały.',
    );
});
