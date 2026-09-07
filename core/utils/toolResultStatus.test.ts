import test from 'ava';
import { toolResultStatus, shouldLinkWrittenFile } from './toolResultStatus.js';

// AUD-bledy-027/058/025: jedna reguła „co jest porażką narzędzia" dla całego repo. Trzy kształty,
// które realnie krążą po kodzie: konwencja narzędzi wbudowanych, konwencja MCPClienta/artefaktów
// i wynik udany. Rozjazd między nimi rysował nieudany zapis jako sukces z linkiem do pliku.

test('toolResultStatus: {success:false, error} to porażka (konwencja narzędzi wbudowanych)', t => {
    t.is(toolResultStatus({ success: false, error: 'Plik już istnieje' }), 'error');
});

test('toolResultStatus: {isError:true} to porażka (konwencja MCPClienta i artefaktów)', t => {
    t.is(toolResultStatus({ isError: true, error: 'brak store' }), 'error');
    t.is(toolResultStatus({ isError: true }), 'error');
});

test('toolResultStatus: {success:true} i wynik bez flag to sukces', t => {
    t.is(toolResultStatus({ success: true, path: 'Notatki/a.md' }), 'success');
    t.is(toolResultStatus({ content: 'treść notatki' }), 'success');
});

test('toolResultStatus: PUSTY WYNIK to sukces, nie porażka', t => {
    // web_search/list/search bez trafień oddają `success:true` z pustą tablicą — chip ma
    // wtedy mówić „0 wyników", a nie „awaria".
    t.is(toolResultStatus({ success: true, results: [], count: 0 }), 'success');
    t.is(toolResultStatus({ success: true, files: [] }), 'success');
});

test('toolResultStatus: sam komunikat błędu bez flagi też liczy się jako porażka', t => {
    t.is(toolResultStatus({ error: 'coś padło' }), 'error');
    // …ale jawne `success:true` wygrywa: narzędzie może dołożyć `error` jako ostrzeżenie.
    t.is(toolResultStatus({ success: true, error: 'ostrzeżenie' }), 'success');
    t.is(toolResultStatus({ error: '' }), 'success');
});

test('toolResultStatus: wynik nie-obiektowy nie niesie sygnału porażki', t => {
    // Wrapper external MCP oddaje sklejony tekst, a `_executeTool` suba czasem gołego stringa.
    t.is(toolResultStatus('gotowe'), 'success');
    t.is(toolResultStatus(null), 'success');
    t.is(toolResultStatus(undefined), 'success');
    t.is(toolResultStatus([{ path: 'a.md' }]), 'success');
});

test('shouldLinkWrittenFile: porażka zapisu = BRAK linku do pliku', t => {
    t.false(shouldLinkWrittenFile({ success: false, error: 'Plik już istnieje' }, 'Notatki/a.md'));
    t.false(shouldLinkWrittenFile({ isError: true, error: 'Permission denied' }, 'Notatki/a.md'));
});

test('shouldLinkWrittenFile: udany zapis ze ścieżką = link', t => {
    t.true(shouldLinkWrittenFile({ success: true, path: 'Notatki/a.md' }, 'Notatki/a.md'));
});

test('shouldLinkWrittenFile: bez ścieżki nie ma czego linkować', t => {
    t.false(shouldLinkWrittenFile({ success: true }, ''));
    t.false(shouldLinkWrittenFile({ success: true }, undefined));
});
